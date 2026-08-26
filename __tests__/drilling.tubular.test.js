// Tubular design (casing & tubing): closed-form exactness, API 5C3 regime
// behaviour, monotonicity, and oracle golden agreement.
import fs from 'fs';
import path from 'path';
import {
  barlowBurstPa, api5c3CollapsePa, adjustedYieldPa, pipeBodyYieldN,
  jointStrengthN, triaxialSF, loadCaseProfiles, evaluateString, tubingLoads,
  erosionalVelocityMs, LOAD_CASE_KINDS, STEEL_ALPHA_PER_C,
} from '../engines/drilling/tubularDesign.js';
import { stringProperties, STEEL_E_PA } from '../engines/drilling/torqueDrag.js';
import {
  CASING_CATALOG, TUBING_CATALOG, CASING_GRADES, casingGradeYieldPa,
  CONNECTION_EFFICIENCIES,
} from '../engines/drilling/data/tubulars.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

const IN = 0.0254;
const KSI = 6.894757e6;
const PSI = 6894.757293168;

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const golden = G('tubular_cases.json');

describe('closed forms', () => {
  test('Barlow burst reproduces the hand algebra (9-5/8 47 L-80)', () => {
    const p = barlowBurstPa({ odM: 9.625 * IN, wallM: 0.472 * IN, yieldPa: 80 * KSI });
    const handPsi = (0.875 * 2 * 80000 * 0.472) / 9.625; // 6,865 psi
    // 1e-7: the catalog KSI constant is the customary 7-digit 6.894757e6,
    // the exact PSI divisor is 6894.757293168.
    expectClose(p / PSI, handPsi, 1e-7);
  });

  test('body yield and joint strength algebra', () => {
    const odM = 9.625 * IN;
    const idM = 8.681 * IN;
    const a = (Math.PI / 4) * (odM * odM - idM * idM);
    expectClose(pipeBodyYieldN({ odM, idM, yieldPa: 80 * KSI }), 80 * KSI * a, 1e-12);
    expectClose(
      jointStrengthN({ odM, idM, yieldPa: 80 * KSI, connectionEfficiency: 0.85 }),
      0.85 * 80 * KSI * a, 1e-12,
    );
  });

  test('5C3 regime boundaries are continuous (adjacent formulas agree)', () => {
    for (const g of CASING_GRADES) {
      const { boundaries } = api5c3CollapsePa({
        odM: 9.625 * IN, wallM: 0.472 * IN, yieldPa: g.yieldPa,
      });
      const { dtYp, dtPt, dtTe } = boundaries;
      expect(dtYp).toBeLessThan(dtPt);
      expect(dtPt).toBeLessThan(dtTe);
      // Probe just inside each side of every boundary: the collapse value
      // must be continuous across the regime switch.
      for (const dt of [dtYp, dtPt, dtTe]) {
        const wall = 0.5 * IN;
        const od = dt * wall;
        const eps = 1e-7;
        const lo = api5c3CollapsePa({ odM: od * (1 - eps), wallM: wall, yieldPa: g.yieldPa });
        const hi = api5c3CollapsePa({ odM: od * (1 + eps), wallM: wall, yieldPa: g.yieldPa });
        expect(lo.regime).not.toBe(hi.regime);
        expectClose(lo.collapsePa, hi.collapsePa, 1e-4, 100);
      }
    }
  });

  test('regime map: thick wall collapses in yield, thin wall elastic', () => {
    const thick = api5c3CollapsePa({ odM: 5 * IN, wallM: 0.5 * IN, yieldPa: 55 * KSI });
    expect(thick.regime).toBe('yield');
    const thin = api5c3CollapsePa({ odM: 20 * IN, wallM: 0.438 * IN, yieldPa: 55 * KSI });
    expect(thin.regime).toBe('elastic');
  });

  test('combined loading: Ypa monotone and tension reduces collapse', () => {
    const yp = 80 * KSI;
    let prev = adjustedYieldPa(yp, 0);
    expectClose(prev, yp, 1e-12);
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const cur = adjustedYieldPa(yp, f * yp);
      expect(cur).toBeLessThan(prev);
      prev = cur;
    }
    const base = api5c3CollapsePa({ odM: 9.625 * IN, wallM: 0.472 * IN, yieldPa: yp });
    const derated = api5c3CollapsePa({
      odM: 9.625 * IN, wallM: 0.472 * IN, yieldPa: yp, axialStressPa: 0.4 * yp,
    });
    expect(derated.collapsePa).toBeLessThan(base.collapsePa);
  });

  test('monotonicity: heavier wall raises burst and collapse', () => {
    const light = { odM: 9.625 * IN, wallM: 0.352 * IN, yieldPa: 80 * KSI };
    const heavy = { odM: 9.625 * IN, wallM: 0.545 * IN, yieldPa: 80 * KSI };
    expect(barlowBurstPa(heavy)).toBeGreaterThan(barlowBurstPa(light));
    expect(api5c3CollapsePa(heavy).collapsePa)
      .toBeGreaterThan(api5c3CollapsePa(light).collapsePa);
  });

  test('VME identity: pure axial tension gives vme = sigma_a', () => {
    const odM = 9.625 * IN;
    const idM = 8.681 * IN;
    const { areaM2 } = stringProperties({ odM, idM });
    const fa = 1e6;
    const { vmePa, sf } = triaxialSF({
      odM, idM, yieldPa: 80 * KSI, piPa: 0, poPa: 0, axialN: fa,
    });
    expectClose(vmePa, fa / areaM2, 1e-9);
    expectClose(sf, (80 * KSI) / (fa / areaM2), 1e-9);
  });

  test('thermal force is exactly -E*A*alpha*dT', () => {
    const odM = 3.5 * IN;
    const idM = 2.992 * IN;
    const { areaM2 } = stringProperties({ odM, idM });
    const r = tubingLoads({
      tubing: { odM, idM, lengthM: 2000, weightKgM: 13.84 },
      packer: { sealBoreM: 4 * IN },
      loadCase: { dPiPa: 0, dPoPa: 0 },
      tempProfile: { deltaOpC: 40 },
      casingIdM: 6.184 * IN,
    });
    expectClose(r.forces.thermalN, -STEEL_E_PA * areaM2 * STEEL_ALPHA_PER_C * 40, 1e-9);
    expectClose(r.lengthChanges.thermalM, STEEL_ALPHA_PER_C * 2000 * 40, 1e-12);
  });

  test('erosional velocity: API RP 14E C-factor form', () => {
    const ve = erosionalVelocityMs({ mixtureKgM3: 700, cFactor: 100 });
    expectClose(ve, (100 / Math.sqrt(700 / 16.018463)) * 0.3048, 1e-12);
  });

  test('catalog integrity: wall + ID reconstruct OD, positive dims', () => {
    for (const row of [...CASING_CATALOG, ...TUBING_CATALOG]) {
      expectClose(row.idM + 2 * row.wallM, row.odM, 5e-3); // API rounding
      expect(row.weightKgM).toBeGreaterThan(0);
    }
    expect(casingGradeYieldPa('L-80')).toBe(80 * KSI);
    expect(casingGradeYieldPa('nope')).toBeNull();
    for (const c of CONNECTION_EFFICIENCIES) {
      expect(c.efficiency).toBeGreaterThan(0.5);
      expect(c.efficiency).toBeLessThanOrEqual(1.0);
    }
  });
});

describe('oracle golden agreement (tubular_cases.json)', () => {
  test('ratings for every catalog row x grade, with and without tension', () => {
    for (const r of golden.ratings) {
      const odM = r.odIn * IN;
      const row = [...CASING_CATALOG, ...TUBING_CATALOG].find(
        (x) => Math.abs(x.odM - odM) < 1e-12 && Math.abs(x.weightLbFt - r.weightLbFt) < 1e-9,
      );
      expect(row).toBeTruthy();
      const yp = casingGradeYieldPa(r.grade);
      expectClose(barlowBurstPa({ odM: row.odM, wallM: row.wallM, yieldPa: yp }),
        r.burstPa, 1e-6, 1);
      const col = api5c3CollapsePa({ odM: row.odM, wallM: row.wallM, yieldPa: yp });
      expect(col.regime).toBe(r.regime);
      expectClose(col.collapsePa, r.collapsePa, 1e-6, 1);
      const colT = api5c3CollapsePa({
        odM: row.odM, wallM: row.wallM, yieldPa: yp, axialStressPa: 0.4 * yp,
      });
      expect(colT.regime).toBe(r.regimeAt40pctTension);
      expectClose(colT.collapsePa, r.collapseAt40pctTensionPa, 1e-6, 1);
      expectClose(pipeBodyYieldN({ odM: row.odM, idM: row.odM - 2 * row.wallM, yieldPa: yp }),
        r.bodyYieldN, 1e-6, 1);
    }
    expect(golden.ratings.length).toBe(84); // 28 rows x 3 grades
  });

  for (const c of golden.cases) {
    test(`${c.kind}: profile checkpoints + string evaluation`, () => {
      const profile = loadCaseProfiles({
        kind: c.kind, shoeTvdM: golden.shoeTvdM, env: golden.env, string: golden.string,
      });
      for (const cp of c.profileCheckpoints) {
        const i = profile.tvdM.findIndex((z) => Math.abs(z - cp.tvdM) < 1e-6);
        expect(i).toBeGreaterThanOrEqual(0);
        expectClose(profile.piPa[i], cp.piPa, 1e-6, 1);
        expectClose(profile.poPa[i], cp.poPa, 1e-6, 1);
        expectClose(profile.faN[i], cp.faN, 1e-6, 1);
      }
      const res = evaluateString({
        sections: golden.sections, profile,
        safetyFactors: golden.designFactors, bendingDlsDegPer30m: 2.0,
      });
      expect(res.sections.length).toBe(c.sections.length);
      for (let s = 0; s < res.sections.length; s += 1) {
        const got = res.sections[s];
        const exp = c.sections[s];
        expect(got.status).toBe(exp.status);
        for (const k of ['burstSF', 'collapseSF', 'tensionSF', 'triaxSF']) {
          if (exp[k] === null || exp[k] === undefined || exp[k] === Infinity) continue;
          expectClose(got[k], exp[k], 1e-6, 1e-9);
        }
        expect(got.collapseRegime).toBe(exp.collapseRegime);
        if (exp.burstAtTvdM != null) expectClose(got.burstAtTvdM, exp.burstAtTvdM, 1e-9, 1e-6);
        if (exp.collapseAtTvdM != null) {
          expectClose(got.collapseAtTvdM, exp.collapseAtTvdM, 1e-9, 1e-6);
        }
        expectClose(got.burstRatingPa, exp.burstRatingPa, 1e-6, 1);
        expectClose(got.bodyYieldN, exp.bodyYieldN, 1e-6, 1);
      }
    });
  }

  for (const t of golden.tubing) {
    test(`tubing scenario ${t.name}: Lubinski force set`, () => {
      const r = tubingLoads({
        tubing: { odM: 3.5 * IN, idM: 2.992 * IN, lengthM: 2500, weightKgM: 9.3 * 1.4881639 },
        packer: { sealBoreM: 4 * IN, ratingN: 6.7e5, strokeM: 1.5 },
        loadCase: t.case,
        tempProfile: t.temp,
        casingIdM: 6.184 * IN,
      });
      for (const k of ['pistonN', 'ballooningN', 'thermalN', 'totalN']) {
        expectClose(r.forces[k], t.result.forces[k], 1e-6, 1e-6);
      }
      for (const k of ['pistonM', 'ballooningM', 'thermalM', 'totalM']) {
        expectClose(r.lengthChanges[k], t.result.lengthChanges[k], 1e-6, 1e-12);
      }
      expect(r.buckling.state).toBe(t.result.buckling.state);
      expectClose(r.buckling.sinusoidalN, t.result.buckling.sinusoidalN, 1e-6, 1e-6);
      expectClose(r.buckling.helicalN, t.result.buckling.helicalN, 1e-6, 1e-6);
      expectClose(r.packer.sf, t.result.packer.sf, 1e-6, 1e-9);
      expect(r.packer.strokeOk).toBe(t.result.packer.strokeOk);
      expectClose(r.meta.dTC, t.result.meta.dTC, 1e-9, 1e-12);
    });
  }

  test('erosional velocity golden', () => {
    expectClose(
      erosionalVelocityMs({
        mixtureKgM3: golden.erosional.mixtureKgM3, cFactor: golden.erosional.cFactor,
      }),
      golden.erosional.veMs, 1e-9,
    );
  });

  test('guards', () => {
    expect(() => barlowBurstPa({ odM: 0.1, wallM: 0.06, yieldPa: 1e8 })).toThrow();
    expect(() => api5c3CollapsePa({ odM: 0.1, wallM: 0, yieldPa: 1e8 })).toThrow();
    expect(() => loadCaseProfiles({ kind: 'nope', shoeTvdM: 1000 })).toThrow(/Unknown/);
    expect(() => tubingLoads({ tubing: { odM: 0, idM: 0, lengthM: 0 } })).toThrow();
    expect(() => erosionalVelocityMs({ mixtureKgM3: 0 })).toThrow();
    expect(LOAD_CASE_KINDS.length).toBe(7);
    const dead = api5c3CollapsePa({
      odM: 9.625 * IN, wallM: 0.472 * IN, yieldPa: 80 * KSI, axialStressPa: 81 * KSI,
    });
    expect(dead.collapsePa).toBe(0);
    expect(dead.regime).toBe('yield-exhausted');
  });
});
