// Facilities F3 gas-conditioning gates, against
// tools/validation/facilities/oracle_gasprocessing.py.
//
// WHAT THIS FILE IS FOR, AFTER FC4-0.
//
// Before this wave the suite passed 12 of 12 while the Joule-Thomson
// coefficient was wrong by a factor of 1/z on four screens at the app's
// own shipped defaults, and it went on passing 12 of 12 when the CORRECT
// formula was substituted. It also went on passing when the contactor
// liquid density was moved from 69.9 to 62.4 lb/ft3, when the TEG water
// overhead was moved from 1100 to 1400 Btu/lb, when the amine water
// density was moved from 8.34 to 9.00 lb/gal, and when `acidMolesDay`
// was multiplied by 1.5. Five planted defects, no failures, because
// three of the five oracle routes were transcriptions of the engine and
// the Joule-Thomson chain had no route at all.
//
// So every comparison below carries, beside it, a NEGATIVE CONTROL that
// perturbs the quantity being compared and asserts the comparison would
// have broken. A gate going green and a gate examining anything are two
// separate claims, and this file now makes both of them out loud.
//
// Doctrine gate of this module: the predecessor app hid design choices
// inside constants (4 gal/lb, 750 Btu/gal, 15 percent BTEX), and this
// module then hid three of its own (1100 Btu/lb, 69.9 lb/ft3, 8.34
// lb/gal). Two are inputs now; the rest are in DECLARED_CONSTANTS and
// are pinned by value here, which is a pin and not a validation.

import fs from 'fs';
import path from 'path';
import {
  waterSatPsia, saturatedWaterContent,
  WATER_FIT_MIN_C, WATER_FIT_MAX_C, WATER_FIT_MIN_F, WATER_FIT_MAX_F,
  kremserFractionRemoved, kremserStagesFor,
  tegPackage, AMINES, amineOf, aminePackage,
  contactorDiameter, zAtState, jouleThomsonFPerPsi, jtDrop,
  LBMOL_SCF, STD_PRESSURE_PSIA, STD_TEMPERATURE_R,
  GAL_PER_FT3, TEG_LB_PER_GAL, TEG_LB_PER_FT3, WATER_LB_PER_GAL,
  WATER_OVERHEAD_BTU_PER_LB, BTEX_MW_DEFAULT,
  DECLARED_CONSTANTS, solutionLbPerFt3, amineSolutionLbPerFt3,
} from '../engines/facilities/gasProcessing';
import { R_UNIVERSAL, AIR_MW } from '../engines/production/gasProperties';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'gasprocessing_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

/* ------------------------------------------------------------------ *
 * The one residual this package's gas routes all carry.
 *
 * `R_UNIVERSAL = 10.7316` psia.ft3/(lbmol.degR) is the package's gas
 * constant and it is a ROUNDING: derived from the 2019 SI value it is
 * 10.731577088819062. Every route below that carries a molar quantity
 * or a real-gas density inherits exactly that ratio and nothing else,
 * because the oracle derives its molar volume from SI rather than
 * taking the engine's. The FC3-0 wave decided to keep the package's
 * value over the closer one, because a second opinion held privately by
 * one module is the defect whatever its sign; moving R is a
 * package-wide decision that would move every gas course.
 * ------------------------------------------------------------------ */
const R_SI = 8.314462618;            // J/(mol K), exact by the SI redefinition
const LB_KG = 0.45359237;            // exact
const FT_M = 0.3048;                 // exact
const PA_PER_PSI = 6894.757293168;   // from the exact lb, ft and g_n
const J_PER_BTU = 1055.05585262;     // international-table Btu, exact
const R_FIELD_SI = (R_SI * (LB_KG * 1000) * (5 / 9)) / (PA_PER_PSI * FT_M ** 3);
const R_ROUNDING = R_UNIVERSAL / R_FIELD_SI - 1;   // 2.1349314e-6
// Loose enough for the residual above, 4 times tighter than the smallest
// real defect this module can carry: the 14.65 psia base its comment used
// to name is 3.12e-3 away, 1460 times this.
const MOLAR_TOL = 1e-5;

describe('constants: what is derived, and what can only be pinned', () => {
  test('the standard base is derived, not quoted', () => {
    expect(STD_PRESSURE_PSIA).toBe(14.696);
    expect(STD_TEMPERATURE_R).toBe(519.67);
    expect(LBMOL_SCF).toBe((R_UNIVERSAL * STD_TEMPERATURE_R) / STD_PRESSURE_PSIA);
    // 379.49, which this module used to type with a comment naming a
    // 14.65 psia base it does not belong to, is a rounding of it.
    expect(rel(379.49, LBMOL_SCF)).toBeGreaterThan(1.6e-5);
    // and it agrees with the oracle's SI derivation to the R rounding
    // and to nothing else.
    expect(LBMOL_SCF / G.derived.lbmolScfSi - 1).toBeCloseTo(R_ROUNDING, 12);
    expect(R_UNIVERSAL / G.derived.rFieldSi - 1).toBeCloseTo(R_ROUNDING, 12);
  });

  test('the volumetric packagings are exact by definition', () => {
    expect(GAL_PER_FT3).toBe(1728 / 231);
    expect(rel(GAL_PER_FT3, G.derived.galPerFt3)).toBeLessThan(1e-15);
    // ONE glycol density in the file: the contactor's old typed 69.9
    // lb/ft3 was 1.0047603 times the 9.3 lb/gal the balance uses.
    expect(TEG_LB_PER_FT3).toBe(TEG_LB_PER_GAL * GAL_PER_FT3);
    expect(rel(TEG_LB_PER_FT3, G.derived.tegLbPerFt3)).toBeLessThan(1e-15);
    expect(rel(69.9, TEG_LB_PER_FT3)).toBeGreaterThan(4e-3);
  });

  test('the declared constants are PINNED, which is not the same as validated', () => {
    // Nothing in this repository can check any of these. Pinning them
    // makes a change to one a reviewed act instead of a silent one, and
    // that is the whole of what this test claims.
    expect(DECLARED_CONSTANTS).toEqual({
      TEG_LB_PER_GAL: 9.3,
      WATER_LB_PER_GAL: 8.34,
      WATER_OVERHEAD_BTU_PER_LB: 1100,
      BTEX_MW_DEFAULT: 92,
      MW_WATER: 18.01528,
      AMINE_SG_SOLUTION: [['MEA', 1.01], ['DEA', 1.02], ['MDEA', 1.04]],
      AMINE_MW: [['MEA', 61.08], ['DEA', 105.14], ['MDEA', 119.16]],
      AMINE_MAX_LOADING: [['MEA', 0.35], ['DEA', 0.4], ['MDEA', 0.5]],
      AMINE_HEAT_BTU_PER_GAL: [['MEA', 1100], ['DEA', 950], ['MDEA', 800]],
      AMINE_WT_PCT_TYPICAL: [['MEA', 18], ['DEA', 28], ['MDEA', 45]],
      MAGNUS_A: 0.61094,
      MAGNUS_B: 17.625,
      MAGNUS_C: 243.04,
      CUSTOMARY_CIRCULATION_LO: 2,
      CUSTOMARY_CIRCULATION_HI: 5,
      CHART_WARNING_PSIA: 1000,
    });
    // The customary 8.34 lb/gal is 1.000338 times the density of water
    // at 60 degF, and that gap is recorded rather than silently closed.
    expect(rel(WATER_LB_PER_GAL, G.derived.waterLbPerGalAt60F)).toBeGreaterThan(3e-4);
    expect(rel(WATER_LB_PER_GAL, G.derived.waterLbPerGalAt60F)).toBeLessThan(4e-4);
  });

  test('the Btu packaging inside the JT coefficient is exact, not the typed 5.40395', () => {
    const exact = J_PER_BTU / (PA_PER_PSI * FT_M ** 3);
    expect(rel(exact, G.derived.psiaFt3PerBtu)).toBeLessThan(1e-15);
    expect(rel(5.40395, exact)).toBeGreaterThan(5e-7);
  });
});

describe('water content', () => {
  test('Magnus meets Antoine inside their shared band', () => {
    G.water.forEach((row) => {
      const r = saturatedWaterContent(row);
      expect(r.error).toBeUndefined();
      // Two different published vapour-pressure fits (Magnus here,
      // Antoine in the oracle). The worst of the four cases is 0.638
      // percent, and it is the 65 psia, 40 degF case, which is 4.4 degC
      // and near the LOW end of Antoine's 1 to 100 degC band. The gate
      // comment used to say "Antoine's 1 C band edge", which is a
      // different place from where the gap actually is.
      expect(rel(r.lbPerMMscf, row.lbPerMMscf)).toBeLessThan(1e-2);
      expect(rel(r.yWater, row.yWater)).toBeLessThan(1e-2);
      expect(rel(r.psatPsia, row.psatPsia)).toBeLessThan(1e-2);
    });
  });

  test('NEGATIVE CONTROL: the two fits really are two fits', () => {
    // If someone ever "tidies" the oracle onto Magnus, these gaps
    // collapse to machine epsilon and the comparison above stops being
    // a comparison. It must stay a real disagreement inside tolerance.
    const worst = Math.max(...G.water.map((row) => rel(
      saturatedWaterContent(row).lbPerMMscf, row.lbPerMMscf,
    )));
    expect(worst).toBeGreaterThan(1e-4);
    expect(worst).toBeLessThan(1e-2);
    // and a 0.9 percent inflation of the engine's answer breaks it
    G.water.forEach((row) => {
      const r = saturatedWaterContent(row);
      expect(rel(r.lbPerMMscf * 1.009, row.lbPerMMscf)).toBeGreaterThan(1e-2);
    });
  });

  test('drier at higher pressure, wetter when hot, honest about high pressure', () => {
    const lo = saturatedWaterContent({ pPsia: 200, tF: 100 });
    const hi = saturatedWaterContent({ pPsia: 1000, tF: 100 });
    const hot = saturatedWaterContent({ pPsia: 200, tF: 140 });
    expect(hi.lbPerMMscf).toBeLessThan(lo.lbPerMMscf);
    expect(hot.lbPerMMscf).toBeGreaterThan(lo.lbPerMMscf);
    expect(saturatedWaterContent({ pPsia: 1500, tF: 100 }).warning).toMatch(/McKetta/);
  });

  test('the chart warning boundary is read from BOTH sides', () => {
    // 1000 psia exactly does not fire it; the next pressure up does.
    // Only the below side was ever tested, and a strict comparison is
    // exactly the kind of thing that is wrong by one.
    expect(saturatedWaterContent({ pPsia: 1000, tF: 100 }).warning).toBeNull();
    const just = saturatedWaterContent({ pPsia: 1000.0000001, tF: 100 });
    expect(just.warning).toMatch(/McKetta/);
  });

  test('the fit band is the one the docstring claims, and the old 100 C guard is gone', () => {
    // At 100 degC the fit reads 15.095051 psia where the DEFINITION of
    // the normal boiling point fixes 14.695949, a factor of 1.027157,
    // and it used to return that number without a word.
    expect(WATER_FIT_MIN_C).toBe(-45);
    expect(WATER_FIT_MAX_C).toBe(60);
    // the degF spelling of the same band, stated rather than rounded
    expect(WATER_FIT_MIN_F).toBe(WATER_FIT_MIN_C * 9 / 5 + 32);
    expect(WATER_FIT_MAX_F).toBe(WATER_FIT_MAX_C * 9 / 5 + 32);
    expect(Number.isNaN(waterSatPsia(WATER_FIT_MAX_F + 0.001))).toBe(true);
    expect(waterSatPsia(WATER_FIT_MAX_F)).toBeGreaterThan(0);
    expect(waterSatPsia(WATER_FIT_MIN_F)).toBeGreaterThan(0);
    expect(Number.isNaN(waterSatPsia(WATER_FIT_MIN_F - 0.001))).toBe(true);
    expect(waterSatPsia(212)).toBeNaN();
    expect(waterSatPsia(200)).toBeNaN();
    expect(Number.isNaN(waterSatPsia(300))).toBe(true);
    expect(saturatedWaterContent({ pPsia: 800, tF: 200 }).error).toMatch(/-45 to 60 degC/);
    // 140 degF is 60 degC exactly and is a real contactor inlet: kept.
    expect(saturatedWaterContent({ pPsia: 200, tF: 140 }).error).toBeUndefined();
    // and beyond the coefficients' own published 50 degC it says so
    expect(saturatedWaterContent({ pPsia: 200, tF: 140 }).warning).toMatch(/published over/);
    expect(saturatedWaterContent({ pPsia: 200, tF: 100 }).warning).toBeNull();
  });

  test('refusals name the input and its value', () => {
    expect(saturatedWaterContent({ pPsia: 0.1, tF: 100 }).error).toMatch(/vapour pressure/);
    expect(saturatedWaterContent({ pPsia: -5, tF: 100 }).error).toMatch(/total pressure/);
    expect(saturatedWaterContent({ pPsia: 500 }).error).toMatch(/absolute zero/);
    expect(saturatedWaterContent({ pPsia: 500, tF: NaN }).error).toMatch(/absolute zero/);
    expect(saturatedWaterContent({ pPsia: 500, tF: -600 }).error).toMatch(/absolute zero/);
    expect(waterSatPsia(undefined)).toBeNaN();
  });
});

describe('Kremser', () => {
  test('the closed form reproduces the brute-force stage cascade', () => {
    G.kremser.forEach((row) => {
      const f = kremserFractionRemoved(row);
      expect(f.error).toBeUndefined();
      expect(rel(f.fractionRemoved, row.fractionRemoved)).toBeLessThan(1e-9);
    });
  });

  test('NEGATIVE CONTROL: a half-percent perturbation breaks the cascade comparison', () => {
    G.kremser.forEach((row) => {
      const f = kremserFractionRemoved(row).fractionRemoved;
      expect(rel(f * 1.005, row.fractionRemoved)).toBeGreaterThan(1e-9);
    });
  });

  test('the stage count inverts the CASCADE, not the engine s own forward function', () => {
    // This used to be checked by feeding the engine's own
    // `kremserFractionRemoved` into `kremserStagesFor`, which is an
    // algebraic identity and validates neither half. The fraction fed
    // in here comes from the oracle's linear-system cascade.
    G.kremser.forEach((row) => {
      const n = kremserStagesFor({
        absorptionFactor: row.absorptionFactor,
        fractionRemoved: row.fractionRemoved,
      });
      expect(n.error).toBeUndefined();
      expect(n.stages).toBeCloseTo(row.stages, 8);
    });
  });

  test('NEGATIVE CONTROL: the inversion notices a perturbed cascade fraction', () => {
    const row = G.kremser[0];
    const n = kremserStagesFor({
      absorptionFactor: row.absorptionFactor,
      fractionRemoved: row.fractionRemoved * 1.001,
    });
    expect(Math.abs(n.stages - row.stages)).toBeGreaterThan(1e-3);
  });

  test('impossible specs refuse with the ceiling that makes them impossible', () => {
    const r = kremserStagesFor({ absorptionFactor: 0.8, fractionRemoved: 0.9 });
    expect(r.error).toMatch(/caps the removal/);
    expect(r.ceiling).toBe(0.8);
    expect(kremserStagesFor({ absorptionFactor: 1.4, fractionRemoved: 0 }).error).toMatch(/between 0 and 1/);
    expect(kremserStagesFor({ absorptionFactor: 1.4, fractionRemoved: 1 }).error).toMatch(/between 0 and 1/);
    expect(kremserStagesFor({ absorptionFactor: -1, fractionRemoved: 0.5 }).error).toMatch(/absorption factor/);
  });

  test('kremserFractionRemoved carries the module s error contract', () => {
    // It was the ONE export outside it: a bare number, so a zero stage
    // count came back as NaN, every `if (r.error)` guard downstream
    // passed, and the studio rendered a dash where a fault belonged.
    expect(kremserFractionRemoved({ absorptionFactor: 2, stages: 0 }).error)
      .toMatch(/theoretical stages/);
    expect(kremserFractionRemoved({ absorptionFactor: 0, stages: 3 }).error)
      .toMatch(/absorption factor/);
    expect(kremserFractionRemoved({ absorptionFactor: 2, stages: -3 }).error).toBeTruthy();
    expect(kremserFractionRemoved({ absorptionFactor: 2 }).error).toBeTruthy();
    expect(kremserFractionRemoved({ absorptionFactor: 2, stages: 4 }).fractionRemoved)
      .toBeGreaterThan(0);
    // and nothing it returns is ever a bare NaN
    [{ absorptionFactor: 0, stages: 0 }, { absorptionFactor: NaN, stages: 3 }]
      .forEach((c) => expect(Number.isNaN(kremserFractionRemoved(c).fractionRemoved)).toBe(false));
  });
});

describe('TEG package', () => {
  const tegInputs = (row) => row;

  test('every published field matches the SI power re-derivation', () => {
    G.teg.forEach((row) => {
      const r = tegPackage(tegInputs(row));
      expect(r.error).toBeUndefined();
      ['waterLbDay', 'circGpm', 'circGpd', 'dutyBtuPerGal',
        'sensiblePerGal', 'vaporPerGal', 'reboilerMMBtuHr',
        'leanWaterLbPerGal', 'richTegWtPct'].forEach((k) => {
        expect(rel(r[k], row[k])).toBeLessThan(1e-9);
      });
      // the molar ones carry the R rounding and nothing else
      ['btexLbDay', 'btexTonsYear'].forEach((k) => {
        expect(rel(r[k], row[k])).toBeLessThan(MOLAR_TOL);
      });
      expect(r.sensiblePerGal + r.vaporPerGal).toBeCloseTo(r.dutyBtuPerGal, 9);
    });
  });

  test('the DEFAULTS are exercised by a published case of their own', () => {
    // Every earlier TEG case stated the glycol density, the overhead and
    // the BTEX molecular weight, so moving any of those DEFAULTS changed
    // no published number. This case states none of them.
    const row = G.tegDefaults[0];
    const { tegLbPerGal, waterOverheadBtuPerLb, btexMw, ...stated } = row;
    expect(tegLbPerGal).toBe(TEG_LB_PER_GAL);
    expect(waterOverheadBtuPerLb).toBe(WATER_OVERHEAD_BTU_PER_LB);
    expect(btexMw).toBe(BTEX_MW_DEFAULT);
    const r = tegPackage(stated);
    expect(r.error).toBeUndefined();
    ['sensiblePerGal', 'vaporPerGal', 'dutyBtuPerGal', 'reboilerMMBtuHr'].forEach((k) => {
      expect(rel(r[k], row[k])).toBeLessThan(1e-9);
    });
    expect(rel(r.btexLbDay, row.btexLbDay)).toBeLessThan(MOLAR_TOL);
    expect(r.waterOverheadBtuPerLb).toBe(WATER_OVERHEAD_BTU_PER_LB);
  });

  test('NEGATIVE CONTROL: the overhead and the glycol density are now visible', () => {
    // 1100 -> 1400 Btu/lb and 9.3 -> 8.66 lb/gal (the lb/gal form of
    // the contactor's old 62.4) both used to leave the suite green.
    const row = G.tegDefaults[0];
    const { tegLbPerGal, waterOverheadBtuPerLb, btexMw, ...stated } = row;
    const hotter = tegPackage({ ...stated, waterOverheadBtuPerLb: 1400 });
    expect(rel(hotter.dutyBtuPerGal, row.dutyBtuPerGal)).toBeGreaterThan(1e-9);
    const lighter = tegPackage({ ...stated, tegLbPerGal: 62.4 / GAL_PER_FT3 });
    expect(rel(lighter.sensiblePerGal, row.sensiblePerGal)).toBeGreaterThan(1e-9);
  });

  test('the lean strength now moves something, by a balance and not a chart', () => {
    // It used to be range-checked, refused outside 90 to 100, and then
    // never read: 99.0 and 90.001 returned every field bit-identical.
    const base = { gasMMscfd: 50, inletLbMMscf: 60, outletLbMMscf: 7 };
    const rich = tegPackage({ ...base, leanTegWtPct: 99.0 });
    const poor = tegPackage({ ...base, leanTegWtPct: 90.001 });
    expect(poor.leanWaterLbPerGal).toBeGreaterThan(rich.leanWaterLbPerGal * 5);
    expect(poor.richTegWtPct).toBeLessThan(rich.richTegWtPct);
    // it is a mass balance, so it is exact
    expect(rich.leanWaterLbPerGal).toBeCloseTo(TEG_LB_PER_GAL * 0.01, 12);
    // and the loop that carries too much water says so
    expect(poor.warning).toMatch(/rich glycol returns at/);
    expect(rich.warning).toBeNull();
    // what it does NOT do is pretend to set the outlet spec
    expect(rich.outletSpecBasis).toMatch(/chart this module does not carry/);
  });

  test('design choices are inputs, and out-of-custom choices warn', () => {
    const base = { gasMMscfd: 50, inletLbMMscf: 60, outletLbMMscf: 7 };
    expect(tegPackage({ ...base, circulationGalPerLb: 8 }).warning).toMatch(/2 to 5/);
    expect(tegPackage({ ...base, circulationGalPerLb: 3 }).warning).toBeNull();
  });

  test('every fails-open input the studio can type is now a named refusal', () => {
    const base = { gasMMscfd: 50, inletLbMMscf: 60, outletLbMMscf: 7 };
    const cases = [
      // a still colder than the absorber: -0.32 MMBtu/hr on screen, no warning
      [{ absorberTF: 380, reboilerTF: 100 }, /reboiler must be hotter/],
      [{ reboilerTF: 100, absorberTF: 100 }, /reboiler must be hotter/],
      // negative circulation: -5.52 gpm of glycol
      [{ circulationGalPerLb: -3 }, /circulation ratio/],
      [{ circulationGalPerLb: 0 }, /circulation ratio/],
      // a reflux that SUBTRACTS from the overhead the still must boil
      [{ refluxRatio: -2 }, /reflux ratio/],
      // a BTEX fraction of 5
      [{ btexInletPpmv: 100, btexAbsorbedFrac: 5 }, /BTEX absorbed fraction/],
      [{ btexInletPpmv: 100, btexAbsorbedFrac: -0.1 }, /BTEX absorbed fraction/],
      [{ btexInletPpmv: -10 }, /BTEX at inlet/],
      // a negative outlet spec removing more water than the gas carries
      [{ outletLbMMscf: -20 }, /outlet water spec/],
      [{ inletLbMMscf: -1 }, /inlet water content/],
      // a glycol that weighs nothing: the sensible half silently vanished
      [{ tegLbPerGal: 0 }, /glycol density/],
      [{ cpTegBtuLbF: 0 }, /glycol heat capacity/],
      [{ waterOverheadBtuPerLb: 0 }, /water overhead/],
      [{ absorberTF: -600 }, /absorber temperature/],
      [{ reboilerTF: -600 }, /reboiler temperature/],
      [{ leanTegWtPct: 89 }, /90 and 100 weight percent/],
      [{ leanTegWtPct: 100 }, /90 and 100 weight percent/],
      [{ gasMMscfd: 0 }, /gas rate/],
      [{ outletLbMMscf: 70 }, /must exceed the outlet spec/],
      [{ btexMw: 0 }, /BTEX molecular weight/],
    ];
    cases.forEach(([patch, pattern]) => {
      const r = tegPackage({ ...base, ...patch });
      expect(r.error).toMatch(pattern);
      // and nothing else leaks out beside the refusal
      expect(r.reboilerMMBtuHr).toBeUndefined();
    });
  });

  test('no input produces a non-finite number without an error key', () => {
    const base = { gasMMscfd: 50, inletLbMMscf: 60, outletLbMMscf: 7 };
    [{ circulationGalPerLb: 0 }, { tegLbPerGal: 0 }, { gasMMscfd: Infinity },
      { refluxRatio: NaN }, { absorberTF: null }].forEach((patch) => {
      const r = tegPackage({ ...base, ...patch });
      if (!r.error) {
        Object.values(r).filter((v) => typeof v === 'number')
          .forEach((v) => expect(Number.isFinite(v)).toBe(true));
      }
      expect(r.error).toBeTruthy();
    });
  });
});

describe('amine package', () => {
  const ids = ['MDEA', 'DEA', 'MEA'];

  test('the balance matches the SI mole route on every published case', () => {
    G.amine.forEach((row, i) => {
      const r = aminePackage({ ...row, amineId: ids[i] });
      expect(r.error).toBeUndefined();
      // acidMolesDay was IN the golden and asserted by NOTHING.
      ['acidMolesDay', 'circGpm', 'solutionGpd', 'reboilerMMBtuHr'].forEach((k) => {
        expect(rel(r[k], row[k])).toBeLessThan(MOLAR_TOL);
      });
      expect(rel(r.solutionLbPerFt3, row.solutionLbPerFt3)).toBeLessThan(1e-12);
      expect(r.richLoadingUsed).toBe(row.richLoading);
      expect(r.leanLoadingUsed).toBe(row.leanLoading);
      expect(r.amineWtPctUsed).toBe(row.amineWtPct);
      expect(r.dutyBtuPerGalUsed).toBe(row.dutyBtuPerGal);
    });
  });

  test('NEGATIVE CONTROL: acidMolesDay x 1.5 and the water density both break it now', () => {
    const row = G.amine[0];
    const r = aminePackage({ ...row, amineId: 'MDEA' });
    expect(rel(r.acidMolesDay * 1.5, row.acidMolesDay)).toBeGreaterThan(MOLAR_TOL);
    // 8.34 -> 9.00 lb/gal is a 7.9 percent move in the circulation
    const asIfHeavier = r.circGpm * (WATER_LB_PER_GAL / 9.0);
    expect(rel(asIfHeavier, row.circGpm)).toBeGreaterThan(MOLAR_TOL);
    // and the 14.65 psia base the module's comment used to name
    expect(rel(r.acidMolesDay * (LBMOL_SCF / 380.9168600682594), row.acidMolesDay))
      .toBeGreaterThan(MOLAR_TOL);
  });

  test('the amine table is complete, and its own solution density is reachable', () => {
    expect(AMINES.map((a) => a.id)).toEqual(['MEA', 'DEA', 'MDEA']);
    expect(amineOf('MEA').maxLoading).toBeLessThan(amineOf('MDEA').maxLoading);
    // The Suite sized the AMINE contactor against GLYCOL. This is the
    // number it should have had.
    expect(amineSolutionLbPerFt3('MDEA')).toBe(solutionLbPerFt3(1.04));
    expect(amineSolutionLbPerFt3('MDEA')).toBeCloseTo(1.04 * WATER_LB_PER_GAL * GAL_PER_FT3, 12);
    expect(amineSolutionLbPerFt3('nope')).toBeNull();
    // 1.94 percent on a diameter, which is what the two densities cost
    const common = { gasMMscfd: 60, pPsia: 900, tF: 110, gasSg: 0.7, ksFtS: 0.25 };
    const asGlycol = contactorDiameter(common);
    const asAmine = contactorDiameter({ ...common, rhoLLbFt3: amineSolutionLbPerFt3('MDEA') });
    expect(asAmine.diameterFt).toBeGreaterThan(asGlycol.diameterFt);
    expect(rel(asAmine.diameterFt, asGlycol.diameterFt)).toBeGreaterThan(0.015);
  });

  test('overloading warns', () => {
    const hot = aminePackage({
      gasMMscfd: 50, co2MolPct: 3, amineId: 'MEA', richLoading: 0.45,
    });
    expect(hot.warning).toMatch(/corrosion/);
  });

  test('the specific refusal fires before the general one', () => {
    // A CO2 spec above the CO2 inlet with no H2S used to report "no acid
    // gas to remove at these specs", which sent a user off to check the
    // gas rather than the spec they had just typed.
    const r = aminePackage({ gasMMscfd: 50, co2MolPct: 1, co2SpecMolPct: 2 });
    expect(r.error).toMatch(/spec above the inlet is already met/);
    expect(r.co2SpecMolPct).toBe(2);
    expect(aminePackage({ gasMMscfd: 50, co2MolPct: 2, co2SpecMolPct: 2 }).error)
      .toMatch(/no acid gas to remove/);
  });

  test('every fails-open input the studio can type is now a named refusal', () => {
    const base = { gasMMscfd: 100, co2MolPct: 4, h2sMolPct: 1, amineId: 'MDEA' };
    const cases = [
      [{ amineWtPct: 150 }, /amine strength/],     // 111.7 gpm on screen
      [{ amineWtPct: -45 }, /amine strength/],     // -372 gpm and -17.9 MMBtu/hr
      [{ amineWtPct: 0 }, /amine strength/],       // circulation Infinity
      [{ leanLoading: -1 }, /lean loading/],
      [{ dutyBtuPerGal: -800 }, /regenerator duty/],  // a regenerator making heat
      [{ dutyBtuPerGal: 0 }, /regenerator duty/],
      [{ richLoading: -0.1 }, /rich loading/],
      [{ richLoading: 0.05, leanLoading: 0.05 }, /must exceed lean loading/],
      [{ gasMMscfd: 0 }, /gas rate/],
      [{ co2MolPct: -4 }, /CO2 at inlet/],
      [{ h2sMolPct: -1 }, /H2S at inlet/],
      [{ co2SpecMolPct: -1 }, /CO2 spec/],
      [{ amineId: 'TEA' }, /unknown amine/],
    ];
    cases.forEach(([patch, pattern]) => {
      const r = aminePackage({ ...base, ...patch });
      expect(r.error).toMatch(pattern);
      expect(r.circGpm).toBeUndefined();
    });
  });
});

describe('the z-factor door', () => {
  test('it refuses outside the window the package declares, carrying the coordinates', () => {
    const cold = zAtState({ pPsia: 1000, tF: -150, gasSg: 0.65 });
    expect(cold.error).toMatch(/Tpr .* below the DAK validity range/);
    expect(cold.tpr).toBeLessThan(1);
    const huge = zAtState({ pPsia: 24000, tF: 100, gasSg: 0.65 });
    expect(huge.error).toMatch(/Ppr .* above the DAK validity limit/);
    expect(huge.ppr).toBeGreaterThan(30);
    const good = zAtState({ pPsia: 1000, tF: 100, gasSg: 0.65 });
    expect(good.error).toBeUndefined();
    expect(good.converged).toBe(true);
    expect(good.z).toBeCloseTo(0.871, 3);
    // low Ppr is a note, not a refusal, exactly as separatorSizing has it
    expect(zAtState({ pPsia: 20, tF: 100, gasSg: 0.65 }).note).toMatch(/fit data start/);
  });

  test('a gas gravity Sutton cannot describe is refused BEFORE the correlation sees it', () => {
    // Above 5.08 Sutton's pseudo-critical PRESSURE goes negative, dakZ
    // takes its non-positive-Ppr branch and hands back z = 1 reporting
    // converged: true, so no flag could have caught either of these.
    const over = zAtState({ pPsia: 1000, tF: 100, gasSg: 5.08 });
    expect(over.error).toMatch(/Sutton pseudo-criticals are not physical/);
    expect(over.ppcPsia).toBeLessThan(0);
    const under = zAtState({ pPsia: 1000, tF: 100, gasSg: 5.07 });
    // 5.07 still has a positive Ppc but lands far outside the window
    expect(under.error).toBeTruthy();
  });
});

describe('contactor sizing', () => {
  test('Souders-Brown matches the SI molar oracle where z is supplied', () => {
    const withZ = [
      { ...G.contactor[0], rhoLLbFt3: 69.9 },
      { ...G.contactor[1], rhoLLbFt3: 69.9 },
      // an AMINE solution density, which is the input the sweetening
      // column needed and never got
      { ...G.contactor[2], rhoLLbFt3: amineSolutionLbPerFt3('MDEA') },
    ];
    withZ.forEach((row, i) => {
      const r = contactorDiameter(row);
      expect(r.error).toBeUndefined();
      expect(r.zSource).toMatch(/supplied/);
      expect(rel(r.diameterFt, G.contactor[i].diameterFt)).toBeLessThan(MOLAR_TOL);
      expect(rel(r.vAllowFtS, G.contactor[i].vAllowFtS)).toBeLessThan(MOLAR_TOL);
      expect(rel(r.rhoG, G.contactor[i].rhoG)).toBeLessThan(MOLAR_TOL);
      expect(rel(r.qActFt3S, G.contactor[i].qActFt3S)).toBeLessThan(1e-12);
    });
  });

  test('the branch the live app actually runs has published cases at last', () => {
    // Every published case used to pass z IN, so the default correlation
    // branch -- the only branch the Suite ever takes, because it never
    // passes a z -- was exercised by nothing.
    [3, 4].forEach((i) => {
      const row = G.contactor[i];
      expect(row.z).toBeGreaterThan(0);
      const r = contactorDiameter({
        gasMMscfd: row.gasMMscfd, pPsia: row.pPsia, tF: row.tF,
        gasSg: row.gasSg, ksFtS: row.ksFtS,
      });
      expect(r.error).toBeUndefined();
      expect(r.zSource).toMatch(/DAK correlation/);
      expect(rel(r.z, row.z)).toBeLessThan(1e-12);
      expect(rel(r.diameterFt, row.diameterFt)).toBeLessThan(MOLAR_TOL);
      expect(rel(r.rhoG, row.rhoG)).toBeLessThan(MOLAR_TOL);
      // and it took the module's one glycol density as its default
      expect(r.rhoLLbFt3).toBe(TEG_LB_PER_FT3);
    });
  });

  test('NEGATIVE CONTROL: the liquid density and the standard base both break it now', () => {
    const row = G.contactor[3];
    const asIf624 = contactorDiameter({
      gasMMscfd: row.gasMMscfd, pPsia: row.pPsia, tF: row.tF,
      gasSg: row.gasSg, ksFtS: row.ksFtS, rhoLLbFt3: 62.4,
    });
    expect(rel(asIf624.diameterFt, row.diameterFt)).toBeGreaterThan(MOLAR_TOL);
    // the 14.65/520 base the contactor used to convert at, 0.187 pct on D
    const asIfOldBase = row.diameterFt
      * Math.sqrt((14.65 / 520) / (STD_PRESSURE_PSIA / STD_TEMPERATURE_R));
    expect(rel(asIfOldBase, row.diameterFt)).toBeGreaterThan(1e-3);
  });

  test('every fails-open and fails-silent input is now a named refusal', () => {
    const base = { gasMMscfd: 50, pPsia: 1000, tF: 100, gasSg: 0.65 };
    // a missing temperature used to give z, density, velocity and
    // diameter all NaN with no error, and the hint read "z = --"
    expect(contactorDiameter({ ...base, tF: undefined }).error).toMatch(/absolute zero/);
    expect(contactorDiameter({ ...base, tF: 'warm' }).error).toMatch(/absolute zero/);
    expect(contactorDiameter({ ...base, tF: -600 }).error).toMatch(/absolute zero/);
    expect(contactorDiameter({ ...base, z: 0 }).error).toMatch(/supplied z-factor/);
    expect(contactorDiameter({ ...base, z: -0.8 }).error).toMatch(/supplied z-factor/);
    expect(contactorDiameter({ ...base, rhoLLbFt3: 0 }).error).toMatch(/liquid density/);
    expect(contactorDiameter({ ...base, ksFtS: 0 }).error).toMatch(/Souders-Brown K/);
    expect(contactorDiameter({ ...base, gasSg: 0 }).error).toMatch(/gas gravity/);
    // z = 11.00 at 60000 psia with a finite diameter and no note,
    // because dakZ's converged flag was discarded. RECORDED AGAINST THE
    // RECON: its other example, z = 2.48 at 20000 psia, is INSIDE the
    // window this package declares. Ppr there is 29.85 against the
    // DAK_PPR_MAX of 30, so the refusal starts at 20104 psia on this
    // gas, and z = 2.48 at 20000 psia is the correlation being used
    // where it was fitted rather than a fails-open. The finding is real
    // at 60000 and not real at 20000, and the difference is worth a
    // sentence because the fix is the window and not the flag: dakZ
    // reports converged: true at BOTH.
    expect(contactorDiameter({ ...base, pPsia: 20000 }).error).toBeUndefined();
    expect(contactorDiameter({ ...base, pPsia: 20000 }).z).toBeGreaterThan(2);
    expect(contactorDiameter({ ...base, pPsia: 20200 }).error).toMatch(/DAK validity/);
    expect(contactorDiameter({ ...base, pPsia: 60000 }).error).toMatch(/DAK validity/);
    // and a liquid lighter than the gas is a refusal, not a NaN root
    expect(contactorDiameter({ ...base, rhoLLbFt3: 0.5 }).error).toMatch(/denser than the gas/);
  });
});

describe('Joule-Thomson from the z-factor itself', () => {
  test('it matches an INDEPENDENT numerical T dV/dT - V route', () => {
    // THIS IS THE GATE THAT DID NOT EXIST. The engine rearranges the
    // definition analytically into (R T^2/(Cp P)) (dz/dT); the oracle
    // forms the molar volume from an independently solved z and
    // differentiates it numerically with a five-point stencil, in SI.
    // Nothing but the published DAK correlation is shared.
    G.jt.forEach((row) => {
      const r = jouleThomsonFPerPsi(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.muFPerPsi, row.muFPerPsi)).toBeLessThan(MOLAR_TOL);
      expect(rel(r.z, row.z)).toBeLessThan(1e-12);
      // dz/dT carries the engine's central two-point truncation at a
      // relative step of 1e-4 against the oracle's five-point at 1e-3.
      expect(rel(r.dzdT, row.dzdT)).toBeLessThan(1e-6);
    });
  });

  test('the residual against the oracle IS the gas constant s rounding', () => {
    // A named cause, not a tolerance. mu is linear in R, so the whole
    // gap is R_UNIVERSAL = 10.7316 against the SI 10.731577088819062,
    // plus the derivative stencils, which are two orders smaller.
    G.jt.forEach((row) => {
      const r = jouleThomsonFPerPsi(row);
      const gap = r.muFPerPsi / row.muFPerPsi - 1;
      expect(gap - R_ROUNDING).toBeLessThan(1e-7);
      expect(gap - R_ROUNDING).toBeGreaterThan(-1e-7);
    });
  });

  test('NEGATIVE CONTROL: the /z this gate exists to catch cannot come back', () => {
    // The engine divided by z until FC4-0, and its docstring stated the
    // same wrong relation, so it read as settled rather than as a typo.
    // The whole error is a factor of 1/z: zero in the ideal-gas limit
    // and growing with pressure, which is why no sanity check found it.
    G.jt.forEach((row) => {
      const r = jouleThomsonFPerPsi(row);
      const asItWas = r.muFPerPsi / r.z;
      expect(rel(asItWas, row.muFPerPsi)).toBeGreaterThan(MOLAR_TOL);
    });
    // at 1000 psia it is 14.8 percent, at 2500 psia 26.6 percent
    const field = jouleThomsonFPerPsi({ pPsia: 1000, tF: 100, gasSg: 0.65 });
    expect(1 / field.z - 1).toBeGreaterThan(0.14);
    const deep = jouleThomsonFPerPsi({ pPsia: 2500, tF: 100, gasSg: 0.65 });
    expect(1 / deep.z - 1).toBeGreaterThan(0.26);
  });

  test('the 5 to 9 band could not have caught it, and is kept only as a band', () => {
    // Recorded on purpose. BOTH the right answer and the wrong one sit
    // inside the classic field rule of thumb, so this assertion is a
    // sanity range and never was a check. It is labelled as one now.
    const field = jouleThomsonFPerPsi({ pPsia: 1000, tF: 100, gasSg: 0.65 });
    const wrong = field.muFPerPsi / field.z;
    [field.muFPerPsi, wrong].forEach((mu) => {
      expect(mu * 100).toBeGreaterThan(5);
      expect(mu * 100).toBeLessThan(9);
    });
  });

  test('finite at low pressure: a virial effect, not an ideal one', () => {
    // JT does NOT vanish as P -> 0: z -> 1 but (dz/dT)/P tends to the
    // second-virial limit, so mu goes to a finite value.
    const lowP = jouleThomsonFPerPsi({ pPsia: 20, tF: 100, gasSg: 0.65 });
    const field = jouleThomsonFPerPsi({ pPsia: 1000, tF: 100, gasSg: 0.65 });
    [lowP, field].forEach((r) => {
      expect(r.muFPerPsi).toBeGreaterThan(0);
      expect(r.muFPerPsi * 100).toBeGreaterThan(2);
      expect(r.muFPerPsi * 100).toBeLessThan(15);
    });
  });

  test('every fails-open and fails-silent input is now a named refusal', () => {
    const base = { pPsia: 1000, tF: 100, gasSg: 0.65 };
    // a missing temperature gave mu and z both NaN with no error
    expect(jouleThomsonFPerPsi({ ...base, tF: undefined }).error).toMatch(/absolute zero/);
    // -600 degF gave mu = -1.4e-10 and z = 1.000000001, no error
    expect(jouleThomsonFPerPsi({ ...base, tF: -600 }).error).toMatch(/absolute zero/);
    // sg 5.08: mu came back EXACTLY ZERO, "this gas does not cool"
    const zero = jouleThomsonFPerPsi({ ...base, gasSg: 5.08 });
    expect(zero.error).toMatch(/Sutton pseudo-criticals/);
    expect(zero.muFPerPsi).toBeUndefined();
    // sg 5.07: mu came back NEGATIVE, "this gas HEATS on expansion"
    expect(jouleThomsonFPerPsi({ ...base, gasSg: 5.07 }).error).toBeTruthy();
    expect(jouleThomsonFPerPsi({ ...base, cpBtuLbmolF: 0 }).error).toMatch(/heat capacity/);
    expect(jouleThomsonFPerPsi({ ...base, pPsia: 0 }).error).toMatch(/pressure/);
    expect(jouleThomsonFPerPsi({ ...base, pPsia: 60000 }).error).toMatch(/DAK validity/);
  });
});

describe('the Joule-Thomson march', () => {
  test('it matches the oracle march coefficient for coefficient', () => {
    G.jtDrop.forEach((row) => {
      const r = jtDrop(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.dropF, row.dropF)).toBeLessThan(MOLAR_TOL);
      expect(rel(r.t2F, row.t2F)).toBeLessThan(MOLAR_TOL);
      expect(r.steps).toBe(20);
    });
  });

  test('the 20-step default is CONVERGED, and that is measured not assumed', () => {
    // The march used to be midpoint in P and plain Euler in T, so it was
    // first order and understated the cooling by 3119 ppm on the first of
    // these cases, 4816 on the second and 6775 on the third, always in
    // the same direction. Taking the half-step temperature as well makes
    // it second order. This gate would have FAILED on the old march.
    G.jtDrop.forEach((row) => {
      const r = jtDrop(row);
      expect(rel(r.dropF, row.dropFConverged)).toBeLessThan(1e-4);
      const fine = jtDrop({ ...row, steps: 2000 });
      expect(rel(r.dropF, fine.dropF)).toBeLessThan(1e-4);
    });
  });

  test('NEGATIVE CONTROL: a first-order march would fail the convergence gate', () => {
    // The old scheme, reconstructed: mu at the midpoint PRESSURE but at
    // the temperature the interval started with.
    const row = G.jtDrop[2];
    const euler = (steps) => {
      let t = row.tF;
      const dp = (row.p1Psia - row.p2Psia) / steps;
      for (let i = 0; i < steps; i += 1) {
        const p = row.p1Psia - dp * (i + 0.5);
        t -= jouleThomsonFPerPsi({
          pPsia: p, tF: t, gasSg: row.gasSg, cpBtuLbmolF: row.cpBtuLbmolF,
        }).muFPerPsi * dp;
      }
      return row.tF - t;
    };
    expect(rel(euler(20), row.dropFConverged)).toBeGreaterThan(1e-4);
    expect(euler(20)).toBeLessThan(row.dropFConverged); // always understated
  });

  test('it reports the coefficient the answer actually used', () => {
    // The Suite prints the INLET coefficient beside a temperature that
    // twenty other coefficients produced.
    const r = jtDrop({ p1Psia: 1000, p2Psia: 600, tF: 100, gasSg: 0.65 });
    const inlet = jouleThomsonFPerPsi({ pPsia: 1000, tF: 100, gasSg: 0.65 });
    expect(r.muInletFPerPsi).toBeCloseTo(inlet.muFPerPsi, 12);
    expect(r.muMeanFPerPsi).toBeCloseTo(r.dropF / 400, 12);
    expect(r.muMeanFPerPsi).toBeGreaterThan(r.muInletFPerPsi);
  });

  test('a drop cools, more drop cools more, and bad inputs refuse by name', () => {
    const small = jtDrop({ p1Psia: 1000, p2Psia: 800, tF: 100, gasSg: 0.65 });
    const large = jtDrop({ p1Psia: 1000, p2Psia: 400, tF: 100, gasSg: 0.65 });
    expect(small.dropF).toBeGreaterThan(0);
    expect(large.dropF).toBeGreaterThan(small.dropF);
    expect(jtDrop({ p1Psia: 500, p2Psia: 600, tF: 100, gasSg: 0.65 }).error)
      .toMatch(/inlet above the outlet/);
    // steps at or below zero returned dropF: 0, "no cooling", no error
    expect(jtDrop({ p1Psia: 1000, p2Psia: 400, tF: 100, gasSg: 0.65, steps: 0 }).error)
      .toMatch(/whole number of steps/);
    // a non-integer step count marched PAST the outlet pressure: 0.4 on
    // a 1000 to 400 drop reached 250 psia and reported 83.4 degF
    expect(jtDrop({ p1Psia: 1000, p2Psia: 400, tF: 100, gasSg: 0.65, steps: 0.4 }).error)
      .toMatch(/whole number of steps/);
    expect(jtDrop({ p1Psia: 1000, p2Psia: -400, tF: 100, gasSg: 0.65 }).error)
      .toMatch(/outlet pressure/);
  });

  test('a march that dies says WHERE it died', () => {
    // A refusal that loses the diagnosis is half a refusal.
    const r = jtDrop({ p1Psia: 1000, p2Psia: 400, tF: -459, gasSg: 0.65 });
    expect(r.error).toMatch(/died at/);
    expect(r.diedAtStep).toBe(1);
    expect(r.diedAtPsia).toBeGreaterThan(400);
    expect(r.steps).toBe(20);
  });
});
