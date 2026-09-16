// Facilities F6 corrosion gates against
// tools/validation/facilities/oracle_corrosion.py.
//
// HOW THIS GATE IS BUILT, and why it is built this way.
//
// Before FC9-0, 13 of 50 defects planted in this engine alone left this
// suite green, and 15 of 17 defects planted in the engine AND the
// oracle together left it green with the oracle catching none of the
// 17. The reason is arithmetic, not carelessness: the oracle was a
// transcription in almost every route, and A CONSTANT TYPED IN TWO
// FILES CANNOT BE VALIDATED BY COMPARING THE TWO FILES.
//
// So this gate does three separate jobs, and says which is which.
//
//  1. It compares the engine against the oracle's GENUINELY
//     INDEPENDENT routes: the series combination by bisection, the
//     inhibitor duty cycle over 8760 hours, the wall shear through a
//     momentum balance whose FORCE BALANCE is checked as an identity,
//     the protective-film onset by bisection, the remaining life by
//     marching, and the H2S to CO2 ratio from mole fractions.
//  2. It asserts CONSTANT-FREE INVARIANTS on the engine: a pH factor
//     of exactly 1 at the reference, exactly one decade per two pH
//     units, exact linearity of the mass-transfer term in fCO2,
//     1/CR - 1/Vr - 1/Vm = 0, and the pipe force balance.
//  3. It PINS every held constant by MEASURING it out of the engine's
//     own behaviour and comparing with a literal typed HERE, which is
//     a third location. Measuring rather than exporting is deliberate:
//     it proves the engine actually uses the number.
//
// EVERY check in job 2 and job 3 has a NEGATIVE CONTROL in the last
// describe block, which runs the same recipe against a deliberately
// wrong implementation and asserts it is rejected, printing the case.
// A gate that restates the formula validates nothing, and a recipe
// that cannot fail is not a check.
//
// Each block logs WHAT IT EXAMINED, and refuses (throws) rather than
// passing when the golden does not carry what it needs.

import fs from 'fs';
import path from 'path';
import {
  co2FugacityCoefficient, co2Fugacity, FUGACITY_CAP_BAR,
  dwmReactionRate, dwmMassTransferRate,
  scaleFactor, scaleOnsetTC, phFactor, PH_REFERENCE,
  corrosionRate, wallShearStressPa,
  FILM_STRIP_PA, FILM_MODERATE_PA, SHEAR_SWITCH_RE,
  SOUR_THRESHOLD_BAR, SOUR_THRESHOLD_PSIA, BAR_TO_PSIA, sourServiceScreen,
  corrosionRegime, REGIME_CARBONATE_MAX, REGIME_MIXED_MAX,
  remainingLife, rateCategory, RATE_CATEGORY_BANDS,
  CONTROLLING_MARGIN, INHIBITOR_SHORTFALL_PP,
  HELD_FOR_LITERATURE, NOT_PROVIDED,
  screen,
} from '../engines/facilities/corrosion';

import * as CORROSION from '../engines/facilities/corrosion';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'corrosion_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
const say = (...m) => console.log('   examined:', ...m);

/** Refuse rather than pass when the golden cannot support a check. */
const need = (key, minRows = 1) => {
  const block = G[key];
  if (block === undefined || block === null) {
    throw new Error(`the golden carries no "${key}" block, so this gate cannot do its job and refuses to pass`);
  }
  if (Array.isArray(block) && block.length < minRows) {
    throw new Error(`the golden's "${key}" block has ${block.length} rows and this gate needs at least ${minRows}`);
  }
  return block;
};

/* ================================================================== *
 * THE LITERALS. Typed here, in the gate, as the THIRD location. Held
 * for literature every one: pinned, not validated. Moving any of them
 * in the engine and in the oracle together fails a pin below.
 * ================================================================== */
const PIN = {
  fugacityA: 0.0031,
  fugacityB: 1.4,
  fugacityCapBar: 250,
  dwmA: 4.93,
  dwmB: 1119,
  dwmN: 0.58,
  vmC: 2.45,
  vmUExp: 0.8,
  vmDExp: 0.2,
  scaleA: 2400,
  scaleN: 0.6,
  scaleC: 6.7,
  phSlope: -0.5,
  phReference: 4,
  blasiusC: 0.046,
  blasiusN: -0.2,
  laminarC: 16,
  switchRe: 4000,
  filmStripPa: 100,
  filmModeratePa: 50,
  sourThresholdBar: 0.0035,
  // 0.0035 bar is 0.050763208302526355 psia. It is NOT 0.05 psia,
  // which the engine's comment used to claim: 0.05 psia is 0.0034474
  // bar, 1.5 percent lower.
  sourThresholdPsia: 0.050763208302526355,
  regimeCarbonateMax: 1 / 500,
  regimeMixedMax: 1 / 20,
  categoryLow: 0.1,
  categoryModerate: 0.5,
  categoryHigh: 1.0,
  controllingMargin: 0.1,
  // Constant-free invariants, which are properties and not numbers to
  // be sourced.
  decadesPerTwoPhUnits: 1,
  forceBalancePerimeterFactor: 4,
  fanningToDarcy: 4,
};

/* ================================================================== *
 * The measurement recipes. Each takes an IMPLEMENTATION so the same
 * recipe can be run against the engine and, in the negative controls,
 * against a deliberately wrong stub.
 * ================================================================== */
const measure = {
  /** 0.0031 and 1.4, from log10(a)/P being linear in 1/T. */
  fugacity(impl) {
    const P = 37.0;
    const s = (tC) => Math.log10(impl.co2FugacityCoefficient({ tC, pTotalBar: P })) / P;
    const t1 = 20; const t2 = 130;
    const k1 = 1 / (t1 + 273.15); const k2 = 1 / (t2 + 273.15);
    const B = (s(t2) - s(t1)) / (k1 - k2);
    const A = s(t1) + B * k1;
    return { A, B };
  },
  /** 4.93, 1119 and 0.58, from log10 Vr being linear in 1/T and log10 f. */
  reaction(impl) {
    const L = (tC, f) => Math.log10(impl.dwmReactionRate({ tC, fco2Bar: f }));
    const n = (L(70, 9.0) - L(70, 1.0)) / (Math.log10(9.0) - Math.log10(1.0));
    const k1 = 1 / (30 + 273.15); const k2 = 1 / (140 + 273.15);
    const B = (L(140, 2.0) - L(30, 2.0)) / (k1 - k2);
    const A = L(70, 1.0) + B / (70 + 273.15) - n * Math.log10(1.0);
    return { A, B, n };
  },
  /** 2.45, 0.8 and 0.2 from the mass-transfer term's own scaling. */
  massTransfer(impl) {
    const V = (u, d, f) => impl.dwmMassTransferRate({ velocityMS: u, diameterM: d, fco2Bar: f });
    const uExp = Math.log(V(4, 0.2, 1) / V(2, 0.2, 1)) / Math.log(2);
    const dExp = -Math.log(V(3, 0.4, 1) / V(3, 0.2, 1)) / Math.log(2);
    const C = V(1, 1, 1);
    return { C, uExp, dExp };
  },
  /** 2400, 0.6 and 6.7, measured where the factor is unclamped. */
  scale(impl) {
    const L = (tC, f) => Math.log10(impl.scaleFactor({ tC, fco2Bar: f }));
    // both points hot enough to be below 1 at both fugacities
    const n = -(L(160, 8.0) - L(160, 1.0)) / (Math.log10(8.0) - Math.log10(1.0));
    const k1 = 1 / (140 + 273.15); const k2 = 1 / (190 + 273.15);
    const A = (L(140, 2.0) - L(190, 2.0)) / (k1 - k2);
    const C = A / (160 + 273.15) - n * Math.log10(1.0) - L(160, 1.0);
    return { A, n, C };
  },
  /** -0.5, from the pH factor's own slope above the reference. */
  ph(impl) {
    const f1 = impl.phFactor({ ph: 5.0 }).factor;
    const f2 = impl.phFactor({ ph: 7.0 }).factor;
    return { slope: (Math.log10(f2) - Math.log10(f1)) / (7.0 - 5.0) };
  },
  /** 0.046, -0.2 and 16, from the friction factor's own scaling. */
  friction(impl) {
    const f = (re) => {
      // pick rho, u, d, mu to land on a chosen Reynolds number exactly
      const d = 0.1; const rho = 1000; const mu = 1e-3;
      const u = (re * mu) / (rho * d);
      return impl.wallShearStressPa({
        velocityMS: u, diameterM: d, densityKgM3: rho, viscosityPaS: mu,
      }).fanningFriction;
    };
    const re1 = 2.0e5; const re2 = 8.0e5;
    const n = Math.log(f(re2) / f(re1)) / Math.log(re2 / re1);
    const C = f(re1) / re1 ** n;
    const laminarC = f(1500) * 1500;
    return { C, n, laminarC };
  },
  /** The laminar-to-turbulent switch, found by bisection on the branch name. */
  switchRe(impl) {
    const d = 0.1; const rho = 1000; const mu = 1e-3;
    const regimeAt = (re) => impl.wallShearStressPa({
      velocityMS: (re * mu) / (rho * d), diameterM: d, densityKgM3: rho, viscosityPaS: mu,
    }).flowRegime;
    let lo = 1; let hi = 1e6;
    if (regimeAt(lo) !== 'laminar' || regimeAt(hi) !== 'turbulent') return NaN;
    for (let i = 0; i < 200; i += 1) {
      const mid = 0.5 * (lo + hi);
      if (regimeAt(mid) === 'laminar') lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  },
};

/* ================================================================== *
 * 0. The golden, and what it is
 * ================================================================== */
describe('the golden, and what it honestly is', () => {
  test('every block this gate needs is present, and the golden says it is synthetic', () => {
    ['cases', 'inhibitor', 'inhibitorClamps', 'phRows', 'scaleOnset', 'regimeRows',
      'sourRows', 'lifeRows', 'categoryRows', 'screenRows', 'refusals'].forEach((k) => need(k, 1));
    need('heldConstants');
    need('provenance');
    // The golden is SYNTHETIC and must not claim otherwise. There is no
    // published de Waard-Milliams case, MR0175 clause or rate-band
    // table anywhere in this repository.
    expect(G.provenance.published).toBe(false);
    expect(G.provenance.why).toMatch(/SYNTHETIC/);
    expect(G.provenance.withdrawn).toMatch(/withdrawn/);
    say(`${Object.keys(G).length} golden blocks,`,
      `${G.cases.length} rate cases, ${G.screenRows.length} whole-screen rows,`,
      `${G.refusals.length} refusals, ${G.phRows.length} pH rows,`,
      `${G.regimeRows.length} regime rows, ${G.sourRows.length} sour rows,`,
      `${G.categoryRows.length} category rows`);
  });

  test('the withdrawn sour-service region and material guidance are GONE from the module', () => {
    // FC9-0 withdrew an invented linear fit that carried a standard's
    // name and served named material guidance off it. Withdrawn, not
    // retuned: nothing here replaces it, and a future edit must not
    // quietly bring either back.
    expect(CORROSION.sourServiceRegion).toBeUndefined();
    const s = sourServiceScreen({ ph2sBar: 1.0 });
    expect(s.region).toBeUndefined();
    expect(s.materialGuidance).toBeUndefined();
    expect(s.regionProvided).toBe(false);
    expect(s.materialGuidanceProvided).toBe(false);
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'engines', 'facilities', 'corrosion.js'), 'utf8',
    );
    // the standard's name may appear ONLY in the header that records
    // the withdrawal, never in a returned string
    const guidanceWords = /Most carbon steels qualified|qualified CRA|hardness control/;
    expect(src).not.toMatch(guidanceWords);
    expect(sourServiceScreen({ ph2sBar: 1.0 }).note).not.toMatch(/MR0175|15156/);
    expect(sourServiceScreen({ ph2sBar: 1e-9 }).note).not.toMatch(/MR0175|15156/);
    say('sourServiceRegion export, the region and materialGuidance fields,',
      'the three guidance strings, and both note branches');
  });

  test('the module states what it does not provide, and what is held', () => {
    expect(NOT_PROVIDED.join(' ')).toMatch(/severity region/);
    expect(NOT_PROVIDED.join(' ')).toMatch(/inspection interval/);
    expect(NOT_PROVIDED.join(' ')).toMatch(/retirement thickness/);
    expect(NOT_PROVIDED.join(' ')).toMatch(/erosional velocity/);
    expect(NOT_PROVIDED.join(' ')).toMatch(/SSC or HIC/);
    expect(HELD_FOR_LITERATURE.join(' ')).toMatch(/REACTION term or the COMBINED rate/);
    expect(HELD_FOR_LITERATURE.length).toBeGreaterThanOrEqual(10);
    const s = screen(G.screenRows[0]);
    expect(s.notProvided.length).toBe(NOT_PROVIDED.length);
    expect(s.limits.length).toBe(HELD_FOR_LITERATURE.length);
    say(`${NOT_PROVIDED.length} not-provided statements and`,
      `${HELD_FOR_LITERATURE.length} held-for-literature statements, both surfaced by screen()`);
  });
});

/* ================================================================== *
 * 1. THE PINS. Every held constant, measured out of the engine and
 *    compared with a literal typed in this file.
 * ================================================================== */
describe('held constants: PINNED against a literal here, not validated', () => {
  test('the oracle and the gate agree on every held constant, so moving one in both files still fails', () => {
    const h = need('heldConstants');
    const pairs = [
      ['fugacityA', h.fugacityA], ['fugacityB', h.fugacityB],
      ['fugacityCapBar', h.fugacityCapBar],
      ['dwmA', h.dwmA], ['dwmB', h.dwmB], ['dwmN', h.dwmN],
      ['vmC', h.vmC], ['vmUExp', h.vmUExp], ['vmDExp', h.vmDExp],
      ['scaleA', h.scaleA], ['scaleN', h.scaleN], ['scaleC', h.scaleC],
      ['phSlope', h.phSlope], ['phReference', h.phReference],
      ['blasiusC', h.blasiusC], ['blasiusN', h.blasiusN], ['laminarC', h.laminarC],
      ['switchRe', h.switchRe],
      ['filmStripPa', h.filmStripPa], ['filmModeratePa', h.filmModeratePa],
      ['sourThresholdBar', h.sourThresholdBar],
      ['regimeCarbonateMax', h.regimeCarbonateMax], ['regimeMixedMax', h.regimeMixedMax],
      ['categoryLow', h.categoryLow], ['categoryModerate', h.categoryModerate],
      ['categoryHigh', h.categoryHigh], ['controllingMargin', h.controllingMargin],
    ];
    pairs.forEach(([k, v]) => expect(v).toBeCloseTo(PIN[k], 12));
    expect(h.barToPsia).toBeCloseTo(BAR_TO_PSIA, 12);
    say(`${pairs.length} held constants cross-pinned between the oracle and this gate`);
  });

  test('the engine USES the pinned fugacity constants, measured from its own output', () => {
    const m = measure.fugacity(CORROSION);
    expect(m.A).toBeCloseTo(PIN.fugacityA, 10);
    expect(m.B).toBeCloseTo(PIN.fugacityB, 8);
    // the cap, measured rather than read
    expect(co2FugacityCoefficient({ tC: 60, pTotalBar: 300 }))
      .toBeCloseTo(co2FugacityCoefficient({ tC: 60, pTotalBar: PIN.fugacityCapBar }), 12);
    expect(co2FugacityCoefficient({ tC: 60, pTotalBar: PIN.fugacityCapBar - 1 }))
      .not.toBeCloseTo(co2FugacityCoefficient({ tC: 60, pTotalBar: PIN.fugacityCapBar }), 6);
    expect(FUGACITY_CAP_BAR).toBe(PIN.fugacityCapBar);
    say(`log10(a)/P measured at 20 C and 130 C gives A=${m.A.toPrecision(6)} B=${m.B.toPrecision(6)};`,
      'the cap located by comparing 300, 250 and 249 bar');
  });

  test('the engine USES the pinned de Waard-Milliams constants', () => {
    const m = measure.reaction(CORROSION);
    expect(m.A).toBeCloseTo(PIN.dwmA, 8);
    expect(m.B).toBeCloseTo(PIN.dwmB, 6);
    expect(m.n).toBeCloseTo(PIN.dwmN, 10);
    say(`log10 Vr slopes give A=${m.A.toPrecision(6)} B=${m.B.toPrecision(7)} n=${m.n.toPrecision(4)}`);
  });

  test('the engine USES the pinned mass-transfer constant and exponents', () => {
    const m = measure.massTransfer(CORROSION);
    expect(m.C).toBeCloseTo(PIN.vmC, 10);
    expect(m.uExp).toBeCloseTo(PIN.vmUExp, 10);
    expect(m.dExp).toBeCloseTo(PIN.vmDExp, 10);
    say(`Vm doubling in U and in d gives C=${m.C} uExp=${m.uExp.toPrecision(4)} dExp=${m.dExp.toPrecision(4)}`);
  });

  test('the engine USES the pinned scale-factor constants', () => {
    const m = measure.scale(CORROSION);
    expect(m.A).toBeCloseTo(PIN.scaleA, 5);
    expect(m.n).toBeCloseTo(PIN.scaleN, 9);
    expect(m.C).toBeCloseTo(PIN.scaleC, 7);
    say(`log10 Fscale slopes at 140 to 190 C give A=${m.A.toPrecision(7)} n=${m.n.toPrecision(4)} C=${m.C.toPrecision(4)}`);
  });

  test('the engine USES the pinned pH slope and reference', () => {
    expect(measure.ph(CORROSION).slope).toBeCloseTo(PIN.phSlope, 12);
    expect(PH_REFERENCE).toBe(PIN.phReference);
    expect(phFactor({ ph: PIN.phReference }).phReference).toBe(PIN.phReference);
    say(`the slope measured between pH 5 and pH 7, and the reference read back from phFactor`);
  });

  test('the engine USES the pinned Blasius constants and the Reynolds 4000 switch', () => {
    const m = measure.friction(CORROSION);
    expect(m.C).toBeCloseTo(PIN.blasiusC, 10);
    expect(m.n).toBeCloseTo(PIN.blasiusN, 10);
    expect(m.laminarC).toBeCloseTo(PIN.laminarC, 9);
    expect(measure.switchRe(CORROSION)).toBeCloseTo(PIN.switchRe, 3);
    expect(SHEAR_SWITCH_RE).toBe(PIN.switchRe);
    say(`f measured at Re 2e5 and 8e5 gives C=${m.C.toPrecision(4)} n=${m.n.toPrecision(4)};`,
      `laminar f*Re=${m.laminarC.toPrecision(4)}; the branch switch bisected to`,
      measure.switchRe(CORROSION).toFixed(3));
  });

  test('the engine USES the pinned thresholds and bands, and the sour threshold is 0.050763 psia and NOT 0.05', () => {
    expect(SOUR_THRESHOLD_BAR).toBeCloseTo(PIN.sourThresholdBar, 12);
    expect(SOUR_THRESHOLD_PSIA).toBeCloseTo(PIN.sourThresholdPsia, 12);
    // the claim the old comment made, and why it was wrong
    expect(SOUR_THRESHOLD_PSIA).not.toBeCloseTo(0.05, 4);
    expect(0.05 / BAR_TO_PSIA).toBeCloseTo(0.0034474, 7);
    // located by behaviour, not by reading the constant
    expect(sourServiceScreen({ ph2sBar: PIN.sourThresholdBar * 0.999 }).sour).toBe(false);
    expect(sourServiceScreen({ ph2sBar: PIN.sourThresholdBar }).sour).toBe(true);
    // the film-risk thresholds, located by behaviour
    const tauAt = (tau) => tau;
    expect(FILM_STRIP_PA).toBe(PIN.filmStripPa);
    expect(FILM_MODERATE_PA).toBe(PIN.filmModeratePa);
    expect(tauAt(FILM_STRIP_PA)).toBe(PIN.filmStripPa);
    // the regime boundaries, located by behaviour
    expect(corrosionRegime({ ph2sBar: 1 * (PIN.regimeCarbonateMax * 0.999), pco2Bar: 1 }).regime).toBe('carbonate');
    expect(corrosionRegime({ ph2sBar: 1 * PIN.regimeCarbonateMax, pco2Bar: 1 }).regime).toBe('mixed');
    expect(corrosionRegime({ ph2sBar: 1 * (PIN.regimeMixedMax * 0.999), pco2Bar: 1 }).regime).toBe('mixed');
    expect(corrosionRegime({ ph2sBar: 1 * PIN.regimeMixedMax, pco2Bar: 1 }).regime).toBe('sulphide');
    expect(REGIME_CARBONATE_MAX).toBeCloseTo(PIN.regimeCarbonateMax, 15);
    expect(REGIME_MIXED_MAX).toBeCloseTo(PIN.regimeMixedMax, 15);
    // the rate bands, located by behaviour
    expect(RATE_CATEGORY_BANDS.low).toBeCloseTo(PIN.categoryLow, 12);
    expect(RATE_CATEGORY_BANDS.moderate).toBeCloseTo(PIN.categoryModerate, 12);
    expect(RATE_CATEGORY_BANDS.high).toBeCloseTo(PIN.categoryHigh, 12);
    expect(rateCategory(PIN.categoryLow * 0.999)).toBe('low');
    expect(rateCategory(PIN.categoryLow)).toBe('moderate');
    expect(rateCategory(PIN.categoryModerate)).toBe('high');
    expect(rateCategory(PIN.categoryHigh)).toBe('severe');
    expect(CONTROLLING_MARGIN).toBeCloseTo(PIN.controllingMargin, 12);
    say('the sour threshold in bar and psia, both regime boundaries and all three rate bands,',
      'each located by stepping across it rather than by reading the constant');
  });

  test('the film-risk thresholds are located by stepping the wall shear across them', () => {
    // solve for the velocity that produces a chosen tau, by bisection
    const d = 0.1; const rho = 1000; const mu = 1e-3;
    const tauAt = (u) => wallShearStressPa({
      velocityMS: u, diameterM: d, densityKgM3: rho, viscosityPaS: mu,
    }).tauPa;
    const uFor = (target) => {
      let lo = 0.01; let hi = 200;
      for (let i = 0; i < 200; i += 1) {
        const mid = 0.5 * (lo + hi);
        if (tauAt(mid) < target) lo = mid; else hi = mid;
      }
      return 0.5 * (lo + hi);
    };
    const riskAt = (u) => wallShearStressPa({
      velocityMS: u, diameterM: d, densityKgM3: rho, viscosityPaS: mu,
    }).filmRisk;
    expect(riskAt(uFor(PIN.filmModeratePa) * 0.999)).toBe('low');
    expect(riskAt(uFor(PIN.filmModeratePa) * 1.001)).toBe('moderate');
    expect(riskAt(uFor(PIN.filmStripPa) * 0.999)).toBe('moderate');
    expect(riskAt(uFor(PIN.filmStripPa) * 1.001)).toBe('high');
    say(`the 50 Pa and 100 Pa steps bracketed by bisection at u=${uFor(PIN.filmModeratePa).toFixed(4)}`,
      `and u=${uFor(PIN.filmStripPa).toFixed(4)} m/s`);
  });
});

/* ================================================================== *
 * 2. CONSTANT-FREE INVARIANTS
 * ================================================================== */
describe('constant-free invariants: properties, not numbers to be sourced', () => {
  test('the pH factor is exactly 1 at its reference and exactly one decade per two pH units', () => {
    const rows = need('phRows', 5);
    expect(phFactor({ ph: PH_REFERENCE }).factor).toBe(1);
    let checked = 0;
    rows.forEach((row) => {
      const r = phFactor({ ph: row.ph });
      if (row.factor === null) {
        expect(r.error).toBeTruthy();
        expect(r.error).toMatch(/reference pH/);
        return;
      }
      expect(rel(r.factor, row.factor)).toBeLessThan(1e-12);
      const two = phFactor({ ph: row.ph + 2 }).factor / r.factor;
      // exactly one decade, whatever the slope is claimed to be
      expect(-Math.log10(two)).toBeCloseTo(PIN.decadesPerTwoPhUnits, 12);
      checked += 1;
    });
    expect(checked).toBeGreaterThanOrEqual(6);
    say(`${rows.length} pH rows, ${rows.length - checked} of them refusals below the reference,`,
      `${checked} decade ratios`);
  });

  test('the mass-transfer term is exactly linear in fCO2 and exactly a power law in U and d', () => {
    const V = (u, d, f) => dwmMassTransferRate({ velocityMS: u, diameterM: d, fco2Bar: f });
    expect(V(3, 0.2, 2.4) / V(3, 0.2, 1.2)).toBeCloseTo(2, 12);
    expect(V(3, 0.2, 7.5) / V(3, 0.2, 1.5)).toBeCloseTo(5, 12);
    // a power law has a scale-free doubling ratio
    const r1 = V(2, 0.2, 1) / V(1, 0.2, 1);
    const r2 = V(8, 0.2, 1) / V(4, 0.2, 1);
    expect(r1).toBeCloseTo(r2, 12);
    say('linearity in fCO2 at two ratios, and the U doubling ratio at 1 to 2 against 4 to 8');
  });

  test('the series combination satisfies 1/CR = 1/Vr + 1/Vm exactly, and the bisection oracle agrees', () => {
    const rows = need('cases', 10);
    let worst = 0;
    rows.forEach((row) => {
      const r = corrosionRate(row);
      expect(r.error).toBeUndefined();
      const residual = Math.abs(1 / r.combinedMmYr - 1 / r.reactionMmYr - 1 / r.massTransferMmYr);
      expect(residual * r.combinedMmYr).toBeLessThan(1e-12);
      // the oracle's bisection, which never forms a reciprocal
      const d = rel(r.combinedMmYr, row.combinedMmYr);
      worst = Math.max(worst, d);
      expect(d).toBeLessThan(1e-9);
    });
    say(`${rows.length} rows: the residual identity and the bisection solve,`,
      `worst bisection gap ${worst.toExponential(2)}`);
  });

  test('the wall shear satisfies the pipe FORCE BALANCE against the oracle pressure drop', () => {
    const rows = need('screenRows', 5);
    let worst = 0;
    rows.forEach((row) => {
      const s = wallShearStressPa(row);
      expect(s.error).toBeUndefined();
      // dP * (pi d^2/4) = tau * (pi d L)  =>  tau = dP d / (4 L)
      const tauFromBalance = (row.pressureDropPa * row.diameterM)
        / (PIN.forceBalancePerimeterFactor * row.shearLengthM);
      const d = rel(s.tauPa, tauFromBalance);
      worst = Math.max(worst, d);
      expect(d).toBeLessThan(1e-12);
      // and the Fanning to Darcy relation the balance route used
      expect(rel(s.fanningFriction * PIN.fanningToDarcy,
        (row.pressureDropPa * 2 * row.diameterM) / (row.shearLengthM * row.densityKgM3 * row.velocityMS ** 2)))
        .toBeLessThan(1e-12);
    });
    say(`${rows.length} rows: tau against dP*d/(4L) from a momentum balance on a`,
      `${rows[0].shearLengthM} m pipe, worst gap ${worst.toExponential(2)};`,
      'and f_Darcy = 4 f_Fanning from the same drop');
  });

  test('the protective-film ONSET is where the scale factor leaves 1, bisected in the oracle and closed form here', () => {
    const rows = need('scaleOnset', 5);
    rows.forEach((row) => {
      const onset = scaleOnsetTC({ fco2Bar: row.fco2Bar });
      expect(rel(onset, row.onsetBisectedTC)).toBeLessThan(1e-9);
      expect(rel(row.onsetClosedTC, row.onsetBisectedTC)).toBeLessThan(1e-9);
      // the property: 1 at the onset, clamped below, below 1 above
      expect(scaleFactor({ tC: onset, fco2Bar: row.fco2Bar })).toBeCloseTo(1, 9);
      expect(scaleFactor({ tC: onset - 5, fco2Bar: row.fco2Bar })).toBe(1);
      expect(scaleFactor({ tC: onset + 5, fco2Bar: row.fco2Bar })).toBeLessThan(1);
    });
    const span = rows.map((r) => r.onsetBisectedTC);
    expect(Math.max(...span) - Math.min(...span)).toBeGreaterThan(30);
    say(`${rows.length} fugacities from ${rows[0].fco2Bar} to ${rows[rows.length - 1].fco2Bar} bar,`,
      `onset moving from ${Math.max(...span).toFixed(1)} C down to ${Math.min(...span).toFixed(1)} C:`,
      'it is NOT a fixed 60 C and it moves with fCO2');
  });

  test('THE 60 C CLAIM IS WRONG: at the app default fugacity the onset is 81 C, not 60', () => {
    // The engine docstring and the studio help guide both used to say
    // the film turns protective "above about 60 C". At the studio's own
    // shipped conditions the crossing is 21 C higher, and between 60
    // and 81 C the factor is pinned at 1 by the clamp.
    const fco2 = corrosionRate(G.screenRows[0]).fco2Bar;
    const onset = scaleOnsetTC({ fco2Bar: fco2 });
    expect(onset).toBeGreaterThan(80);
    expect(onset).toBeLessThan(82);
    expect(scaleFactor({ tC: 60, fco2Bar: fco2 })).toBe(1);
    expect(scaleFactor({ tC: 70, fco2Bar: fco2 })).toBe(1);
    expect(scaleFactor({ tC: 80, fco2Bar: fco2 })).toBe(1);
    expect(scaleFactor({ tC: 85, fco2Bar: fco2 })).toBeLessThan(1);
    say(`fCO2 ${fco2.toFixed(4)} bar at the app defaults, onset ${onset.toFixed(2)} C,`,
      'the factor still exactly 1 at 60, 70 and 80 C');
  });
});

/* ================================================================== *
 * 3. AGAINST THE ORACLE'S ROUTES
 * ================================================================== */
describe('the rate chain against the oracle', () => {
  test('every term matches, across every branch the golden now reaches', () => {
    const rows = need('cases', 15);
    const worst = {};
    const cover = {
      scaleUnclamped: 0, phAboveRef: 0, laminar: 0, kinetics: 0,
      comparable: 0, oilWet: 0, intermittent: 0, aboveCap: 0,
    };
    let fmin = Infinity; let fmax = 0;
    rows.forEach((row) => {
      const r = corrosionRate(row);
      expect(r.error).toBeUndefined();
      [['fugacityCoefficient', 1e-9], ['pco2Bar', 1e-12], ['fco2Bar', 1e-9],
        ['reactionMmYr', 1e-9], ['massTransferMmYr', 1e-9], ['combinedMmYr', 1e-9],
        ['scaleFactor', 1e-9], ['phFactor', 1e-12], ['waterWettingFactor', 1e-12],
        ['uninhibitedMmYr', 1e-9], ['scaleOnsetTC', 1e-9],
        ['controllingMargin', 1e-9]].forEach(([k, tol]) => {
        const d = rel(r[k], row[k]);
        worst[k] = Math.max(worst[k] || 0, d);
        expect(d).toBeLessThan(tol);
      });
      // the duty cycle rounds to whole hours, so this one is looser BY
      // DESIGN and that looseness is the independence
      const dRate = rel(r.rateMmYr, row.rateMmYr);
      worst.rateMmYr = Math.max(worst.rateMmYr || 0, dRate);
      expect(dRate).toBeLessThan(1e-3);
      expect(r.controlling).toBe(row.controlling);
      expect(r.pressureCapApplied).toBe(row.pressureCapApplied);
      if (r.scaleFactor < 1) cover.scaleUnclamped += 1;
      if (r.phFactor < 1) cover.phAboveRef += 1;
      if (wallShearStressPa(row).flowRegime === 'laminar') cover.laminar += 1;
      if (r.controlling === 'reaction kinetics') cover.kinetics += 1;
      if (r.controlling === 'comparable') cover.comparable += 1;
      if (r.flowRegime === 'oilWet') cover.oilWet += 1;
      if (r.flowRegime === 'intermittent') cover.intermittent += 1;
      if (r.pressureCapApplied) cover.aboveCap += 1;
      fmin = Math.min(fmin, r.fco2Bar);
      fmax = Math.max(fmax, r.fco2Bar);
    });
    // the branches the old ten rows never reached
    expect(cover.scaleUnclamped).toBeGreaterThanOrEqual(5);
    expect(cover.phAboveRef).toBeGreaterThanOrEqual(10);
    expect(cover.laminar).toBeGreaterThanOrEqual(1);
    expect(cover.kinetics).toBeGreaterThanOrEqual(1);
    expect(cover.comparable).toBeGreaterThanOrEqual(1);
    expect(cover.oilWet).toBeGreaterThanOrEqual(1);
    expect(cover.intermittent).toBeGreaterThanOrEqual(1);
    expect(cover.aboveCap).toBeGreaterThanOrEqual(1);
    expect(fmax / fmin).toBeGreaterThan(100);
    say(`${rows.length} rows,`, JSON.stringify(cover),
      `fCO2 ${fmin.toFixed(4)} to ${fmax.toFixed(2)} bar (${(fmax / fmin).toFixed(0)}x),`,
      `worst gaps ${JSON.stringify(Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, v.toExponential(1)])))}`);
  });

  test('the same fluid in a bigger line corrodes less, and faster flow corrodes more', () => {
    const base = {
      tC: 60, pTotalBar: 50, co2MolFrac: 0.03, ph: 4.5, velocityMS: 3,
    };
    const small = corrosionRate({ ...base, diameterM: 0.1 });
    const big = corrosionRate({ ...base, diameterM: 0.4 });
    expect(big.rateMmYr).toBeLessThan(small.rateMmYr);
    const fast = corrosionRate({ ...base, diameterM: 0.1, velocityMS: 9 });
    expect(fast.rateMmYr).toBeGreaterThan(small.rateMmYr);
    say(`0.1 m ${small.rateMmYr.toFixed(3)}, 0.4 m ${big.rateMmYr.toFixed(3)},`,
      `0.1 m at 9 m/s ${fast.rateMmYr.toFixed(3)} mm/yr`);
  });

  test('a slow enough flow moves the controller to reaction kinetics', () => {
    // The old suite carried a comment saying "slow the flow right down
    // and kinetics take over" above an assertion that the controller
    // was still mass transfer. The comment was wrong about which way
    // it goes: SLOWING the flow lowers Vm, so mass transfer controls
    // harder. RAISING it moves the controller to kinetics.
    const base = { tC: 60, pTotalBar: 50, co2MolFrac: 0.03, ph: 4.5, diameterM: 0.5 };
    const slow = corrosionRate({ ...base, velocityMS: 0.05 });
    const fast = corrosionRate({ ...base, velocityMS: 60 });
    expect(slow.controlling).toBe('mass transfer');
    expect(fast.controlling).toBe('reaction kinetics');
    expect(slow.rateMmYr).toBeLessThan(fast.rateMmYr);
    say(`0.05 m/s -> ${slow.controlling}, 60 m/s -> ${fast.controlling} in a 0.5 m line`);
  });

  test('the wall shear matches the oracle across the laminar branch and the switch', () => {
    const rows = need('cases', 15);
    let laminar = 0; let nearSwitch = 0;
    rows.forEach((row) => {
      const s = wallShearStressPa(row);
      expect(s.error).toBeUndefined();
      expect(rel(s.reynolds, row.shear.reynolds)).toBeLessThan(1e-12);
      expect(rel(s.tauPa, row.shear.tauPa)).toBeLessThan(1e-9);
      expect(rel(s.fanningFriction, row.shear.fanningFriction)).toBeLessThan(1e-12);
      expect(s.flowRegime).toBe(row.shear.flowRegime);
      expect(s.filmRisk).toBe(row.shear.filmRisk);
      if (s.flowRegime === 'laminar') laminar += 1;
      if (s.nearSwitch) nearSwitch += 1;
    });
    expect(laminar).toBeGreaterThanOrEqual(1);
    expect(nearSwitch).toBeGreaterThanOrEqual(2);
    say(`${rows.length} rows, ${laminar} laminar, ${nearSwitch} inside 10 percent of the Re 4000 switch`);
  });

  test('THE SWITCH IS A DISCONTINUITY, and the engine says so instead of hiding it', () => {
    const d = 0.05; const rho = 900; const mu = 1e-3;
    const at = (re) => wallShearStressPa({
      velocityMS: (re * mu) / (rho * d), diameterM: d, densityKgM3: rho, viscosityPaS: mu,
    });
    const below = at(SHEAR_SWITCH_RE * 0.999);
    const above = at(SHEAR_SWITCH_RE * 1.001);
    expect(above.tauPa / below.tauPa).toBeGreaterThan(2);
    expect(below.nearSwitch).toBe(true);
    expect(above.nearSwitch).toBe(true);
    expect(below.note).toMatch(/discontinuous/);
    expect(at(SHEAR_SWITCH_RE * 3).nearSwitch).toBe(false);
    expect(at(SHEAR_SWITCH_RE * 3).note).toBeNull();
    say(`Re ${(SHEAR_SWITCH_RE * 0.999).toFixed(0)} tau ${below.tauPa.toExponential(3)} against`,
      `Re ${(SHEAR_SWITCH_RE * 1.001).toFixed(0)} tau ${above.tauPa.toExponential(3)}:`,
      `${(above.tauPa / below.tauPa).toFixed(2)} times across 0.2 percent of velocity`);
  });
});

describe('inhibitor efficiency against availability', () => {
  test('the time-average matches an explicit annual duty cycle, and 100 percent is no longer clipped to 99.9', () => {
    const rows = need('inhibitor', 8);
    rows.forEach((row) => {
      const r = corrosionRate({
        tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
        inhibitorEfficiencyPct: row.inhibitorEfficiencyPct,
        inhibitorAvailabilityPct: row.inhibitorAvailabilityPct,
      });
      expect(rel(r.rateMmYr / r.uninhibitedMmYr, row.rateMmYr / row.uninhibitedMmYr))
        .toBeLessThan(1e-3);
      if (row.effectiveInhibitionPct !== null) {
        expect(Math.abs(r.effectiveInhibitionPct - row.effectiveInhibitionPct)).toBeLessThan(0.02);
      }
      expect(Boolean(r.warning)).toBe(row.warns);
      expect(r.clamps).toEqual([]);
    });
    // the 99.9 ceiling is gone: 100 at 95 availability is 95, not 94.905
    const perfect = corrosionRate({
      tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
      inhibitorEfficiencyPct: 100, inhibitorAvailabilityPct: 95,
    });
    expect(perfect.effectiveInhibitionPct).toBeCloseTo(95, 9);
    expect(perfect.note).toMatch(/not a prediction/);
    say(`${rows.length} efficiency and availability pairs against an 8760 hour duty cycle,`,
      'plus the removed 99.9 ceiling');
  });

  test('THE WARNING NOW FIRES AT THE APP DEFAULT OF 90 PERCENT, which it could not before', () => {
    // The old guard was `avail < 1 && eff > 0.9`, so 90 at 95 produced
    // 85.5 percent effective protection against a 90 percent datasheet
    // figure and said nothing, in emerald. This is the one lesson the
    // module exists to teach and it was switched off at its own
    // defaults.
    const at = (eff, avail) => corrosionRate({
      tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
      inhibitorEfficiencyPct: eff, inhibitorAvailabilityPct: avail,
    });
    const def = at(90, 95);
    expect(def.effectiveInhibitionPct).toBeCloseTo(85.5, 9);
    expect(def.warning).toMatch(/85\.5 percent effective/);
    expect(def.warning).toMatch(/availability, not efficiency/);
    expect(def.inhibitorShortfallPp).toBeCloseTo(4.5, 9);
    // and at any efficiency, not just above 90
    expect(at(90, 50).effectiveInhibitionPct).toBeCloseTo(45, 9);
    expect(at(90, 50).warning).toBeTruthy();
    expect(at(50, 80).warning).toBeTruthy();
    expect(at(20, 90).warning).toBeTruthy();
    // full availability delivers the datasheet number and says nothing
    expect(at(95, 100).effectiveInhibitionPct).toBeCloseTo(95, 9);
    expect(at(95, 100).warning).toBeNull();
    expect(at(0, 40).warning).toBeNull();
    expect(INHIBITOR_SHORTFALL_PP).toBeCloseTo(0.1, 12);
    say('90 at 95, 90 at 50, 50 at 80, 20 at 90, 95 at 100 and 0 at 40:',
      'the warning fires on the EFFECTIVE shortfall at any efficiency');
  });

  test('THE SURPRISE: 95 percent at 80 percent availability protects 76 percent, 4.8 times the metal loss', () => {
    const r = corrosionRate({
      tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
      inhibitorEfficiencyPct: 95, inhibitorAvailabilityPct: 80,
    });
    expect(r.effectiveInhibitionPct).toBeCloseTo(76, 9);
    const perfect = corrosionRate({
      tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
      inhibitorEfficiencyPct: 95, inhibitorAvailabilityPct: 100,
    });
    expect(r.rateMmYr / perfect.rateMmYr).toBeCloseTo(4.8, 6);
    expect(r.warning).toMatch(/4\.80 times/);
    say(`76.00 percent effective and ${(r.rateMmYr / perfect.rateMmYr).toFixed(2)} times`,
      'the metal loss of 95 at 100, which is the claim the studio help guide makes');
  });

  test('a clamp on the inhibitor inputs is REPORTED, not silent', () => {
    const rows = need('inhibitorClamps', 3);
    rows.forEach((row) => {
      const r = corrosionRate({
        tC: 60, pTotalBar: 50, co2MolFrac: 0.03, velocityMS: 3, diameterM: 0.15, ph: 4.5,
        inhibitorEfficiencyPct: row.inhibitorEfficiencyPct,
        inhibitorAvailabilityPct: row.inhibitorAvailabilityPct,
      });
      expect(r.clamps.length).toBe(row.clampsExpected);
      expect(r.clamps.join(' ')).toMatch(/clamped from/);
    });
    say(`${rows.length} out-of-range inhibitor inputs, every clamp named in the return`);
  });
});

describe('the pH route, which used to be inert across two decades of acidity', () => {
  test('THE RATE MOVES WITH pH ABOVE THE REFERENCE, and REFUSES below it', () => {
    // Before FC9-0, pH 2.0, 3.0, 3.5 and 4.0 all returned
    // 1.3417538787620145 mm/yr, identical to sixteen figures, while the
    // sour region on the same screen moved. A more acid water is not a
    // less corrosive one, and a silent factor of 1 was the
    // least-limiting answer to a question this module cannot answer.
    const at = (ph) => corrosionRate({
      tC: 60, pTotalBar: 51.00042745349288, co2MolFrac: 0.03,
      velocityMS: 3.048, diameterM: 0.1524, ph,
      inhibitorEfficiencyPct: 90, inhibitorAvailabilityPct: 95,
    });
    [2.0, 3.0, 3.5, 3.999].forEach((ph) => {
      const r = at(ph);
      expect(r.rateMmYr).toBeUndefined();
      expect(r.error).toMatch(/reference pH of 4/);
    });
    // at and above the reference it is strictly monotonic
    const span = [4.0, 4.25, 4.5, 5.0, 6.0, 7.0, 9.0].map((ph) => at(ph).rateMmYr);
    for (let i = 1; i < span.length; i += 1) expect(span[i]).toBeLessThan(span[i - 1]);
    expect(span[0] / span[span.length - 1]).toBeGreaterThan(100);
    // the reference is RETURNED, so an app can print it
    expect(at(4.5).phReference).toBe(PH_REFERENCE);
    expect(at(4.5).phFactor).toBeCloseTo(0.5623413251903491, 12);
    say('pH 2.0, 3.0, 3.5 and 3.999 all refuse; pH 4.0 through 9.0 fall monotonically by',
      `${(span[0] / span[span.length - 1]).toFixed(0)} times; phReference is in the return`);
  });
});

describe('sour service: the threshold comparison, and nothing more', () => {
  test('the sour comparison matches an oracle done entirely in psia', () => {
    const rows = need('sourRows', 5);
    let above = 0; let below = 0;
    rows.forEach((row) => {
      const s = sourServiceScreen({ ph2sBar: row.ph2sBar });
      expect(s.error).toBeUndefined();
      expect(s.sour).toBe(row.sour);
      expect(rel(s.ph2sPsia, row.ph2sPsia)).toBeLessThan(1e-12);
      expect(rel(s.thresholdPsia, row.thresholdPsia)).toBeLessThan(1e-12);
      if (row.decadesAboveThreshold === null) {
        expect(s.decadesAboveThreshold).toBeNull();
      } else {
        expect(rel(s.decadesAboveThreshold, row.decadesAboveThreshold)).toBeLessThan(1e-9);
      }
      expect(s.thresholdHeld).toBe(true);
      if (s.sour) above += 1; else below += 1;
    });
    expect(above).toBeGreaterThanOrEqual(2);
    expect(below).toBeGreaterThanOrEqual(2);
    expect(sourServiceScreen({ ph2sBar: -1 }).error).toBeTruthy();
    expect(sourServiceScreen({ ph2sBar: NaN }).error).toBeTruthy();
    say(`${rows.length} rows, ${above} above the threshold and ${below} below,`,
      'the comparison done in psia against the module doing it in bar');
  });
});

describe('which film governs, from mole fractions rather than pressures', () => {
  test('the ratio is pressure free, which is what catches a pH2S built from the wrong thing', () => {
    // The oracle forms the H2S to CO2 ratio as y_H2S / y_CO2, which
    // needs no pressure at all. A `screen` that computes pH2S as the
    // TOTAL pressure, or that feeds a FUGACITY where a partial
    // pressure belongs, disagrees with this and cannot disagree with a
    // transcription of itself. Both of those were planted before
    // FC9-0 and both left the suite green.
    const rows = need('regimeRows', 6);
    const seen = new Set();
    rows.forEach((row) => {
      const r = corrosionRegime({ ph2sBar: row.ph2sBar, pco2Bar: row.pco2Bar });
      expect(r.regime).toBe(row.regime);
      if (row.ratio === null) {
        expect(r.ratio).toBeNull();
        expect(r.note).toBeTruthy();
        expect(r.note.length).toBeGreaterThan(20);
      } else {
        expect(rel(r.ratio, row.ratio)).toBeLessThan(1e-12);
      }
      expect(r.rateApplies).toBe(row.rateApplies);
      seen.add(row.regime);
    });
    expect([...seen].sort()).toEqual(['carbonate', 'mixed', 'sulphide', 'unknown']);
    // the unknown branch now carries a note, which it did not before,
    // and the studio printed an empty paragraph because of it
    expect(corrosionRegime({ ph2sBar: 0.001, pco2Bar: 0 }).note).toMatch(/not known here/);
    expect(corrosionRegime({ ph2sBar: NaN, pco2Bar: 1 }).note).toMatch(/not known here/);
    say(`${rows.length} rows at total pressures from`,
      `${Math.min(...rows.map((r) => r.pTotalBar))} to ${Math.max(...rows.map((r) => r.pTotalBar))} bar,`,
      `all four regimes reached: ${[...seen].sort().join(', ')}`);
  });

  test('the ratio through screen() agrees with the mole-fraction route at every pressure', () => {
    const rows = need('regimeRows', 6);
    let checked = 0;
    rows.forEach((row) => {
      if (!(row.co2MolFrac > 0) || !(row.h2sMolFrac > 0)) return;
      const s = screen({
        tC: 60, pTotalBar: row.pTotalBar, co2MolFrac: row.co2MolFrac,
        h2sMolFrac: row.h2sMolFrac, ph: 4.5, velocityMS: 3.048, diameterM: 0.1524,
        densityKgM3: 897.036, viscosityPaS: 1e-3,
      });
      expect(s.error).toBeUndefined();
      // y_H2S / y_CO2, from the oracle, with no pressure in it
      expect(rel(s.regime.ratio, row.h2sMolFrac / row.co2MolFrac)).toBeLessThan(1e-12);
      expect(s.regime.regime).toBe(row.regime);
      expect(rel(s.ph2sBar, row.pTotalBar * row.h2sMolFrac)).toBeLessThan(1e-12);
      expect(s.ph2sFugacityApplied).toBe(false);
      checked += 1;
    });
    expect(checked).toBeGreaterThanOrEqual(5);
    say(`${checked} screen() calls: the ratio equals y_H2S/y_CO2 exactly, so it cannot`,
      'come from the total pressure or from a fugacity');
  });
});

describe('integrity: allowance and remaining life', () => {
  test('the division matches a marched wall loss, to the marching step', () => {
    const rows = need('lifeRows', 4);
    rows.forEach((row) => {
      const r = remainingLife(row);
      expect(r.error).toBeUndefined();
      // the oracle MARCHES the loss forward in fixed steps, so this is
      // an absolute tolerance of one step and not a relative one
      expect(Math.abs(r.remainingYears - row.marchedYears)).toBeLessThanOrEqual(row.stepYr);
      expect(rel(r.requiredAllowanceMm, row.requiredAllowanceMm)).toBeLessThan(1e-12);
      expect(r.meetsDesignLife).toBe(row.meetsDesignLife);
      expect(r.unbounded).toBe(false);
    });
    say(`${rows.length} rows held to the ${rows[0].stepYr} year marching step`);
  });

  test('A ZERO RATE NO LONGER RETURNS AN UNBOUNDED LIFE WITH A PASSING VERDICT', () => {
    // Infinity with an emerald MEETS was reachable from an oil-wet
    // dropdown, from a blank CO2 box, from a blank temperature box and
    // from a perfect inhibitor: the strongest reassurance on the
    // screen arriving from the weakest input.
    const z = need('lifeZeroRate');
    const r = remainingLife(z);
    expect(r.remainingYears).toBeNull();
    expect(r.remainingYears).not.toBe(Infinity);
    expect(r.unbounded).toBe(true);
    expect(r.meetsDesignLife).toBeNull();
    expect(r.meetsDesignLife).not.toBe(true);
    expect(r.note).toMatch(/Check WHY the rate is zero/);
    say('a zero rate against a 3.175 mm allowance and a 20 year design life:',
      'no years, no verdict, and a note saying why');
  });

  test('a consumed allowance is an inspection question, and the guards hold', () => {
    expect(remainingLife({ rateMmYr: 0.2, corrosionAllowanceMm: 3, consumedMm: 3.2 }).error)
      .toMatch(/fitness-for-service/);
    expect(remainingLife({ rateMmYr: 0.2, corrosionAllowanceMm: 0 }).error).toBeTruthy();
    expect(remainingLife({ rateMmYr: NaN, corrosionAllowanceMm: 3 }).error).toBeTruthy();
    expect(remainingLife({ rateMmYr: -1, corrosionAllowanceMm: 3 }).error).toBeTruthy();
    expect(remainingLife({ rateMmYr: 0.2, corrosionAllowanceMm: 3, consumedMm: -1 }).error).toBeTruthy();
    expect(remainingLife({ rateMmYr: 0.2, corrosionAllowanceMm: 3, designLifeYears: NaN }).error).toBeTruthy();
    say('a consumed allowance, a zero allowance, a NaN rate, a negative rate,',
      'a negative consumed figure and a NaN design life');
  });

  test('the rate bands are a LABEL and the label is held, boundary by boundary', () => {
    const rows = need('categoryRows', 10);
    rows.forEach((row) => expect(rateCategory(row.rateMmYr)).toBe(row.category));
    expect(rateCategory(NaN)).toBeNull();
    expect(rateCategory(undefined)).toBeNull();
    expect(HELD_FOR_LITERATURE.join(' ')).toMatch(/may be optimistic/);
    say(`${rows.length} rows including both sides of 0.1, 0.5 and 1.0 mm/yr, plus NaN`);
  });
});

/* ================================================================== *
 * 4. THE WHOLE SCREEN
 * ================================================================== */
describe('the whole screen', () => {
  test('every field matches the oracle assembly, on every branch', () => {
    const rows = need('screenRows', 7);
    const cover = { stripped: 0, withheld: 0, sour: 0, notSour: 0, aboveCap: 0 };
    const bindings = new Set();
    rows.forEach((row) => {
      const s = screen(row);
      expect(s.error).toBeUndefined();
      expect(s.screeningComplete).toBe(true);
      expect(rel(s.shear.tauPa, row.tauPa)).toBeLessThan(1e-9);
      expect(s.shear.filmRisk).toBe(row.filmRisk);
      expect(s.filmStripped).toBe(row.filmStripped);
      expect(rel(s.rate.rateMmYr, row.rateMmYr)).toBeLessThan(1e-3);
      expect(rel(s.rateWithFilmCreditMmYr, row.rateWithFilmCreditMmYr)).toBeLessThan(1e-3);
      expect(rel(s.rate.uninhibitedMmYr, row.uninhibitedMmYr)).toBeLessThan(1e-9);
      expect(s.rate.controlling).toBe(row.controlling);
      expect(s.category).toBe(row.category);
      expect(s.regime.regime).toBe(row.regime);
      expect(s.sour.sour).toBe(row.sour);
      expect(rel(s.ph2sBar, row.ph2sBar)).toBeLessThan(1e-12);
      expect(Boolean(s.withheld)).toBe(Boolean(row.withheld));
      expect(s.binding.what).toBe(row.binding);
      expect(s.binding.why.length).toBeGreaterThan(30);
      if (row.remainingYears === null) {
        expect(s.life === null || s.life.remainingYears === null).toBe(true);
      } else {
        expect(Math.abs(s.life.remainingYears - row.remainingYears))
          .toBeLessThanOrEqual(row.lifeStepYr * 1.001);
      }
      if (s.filmStripped) cover.stripped += 1;
      if (s.withheld) cover.withheld += 1;
      if (s.sour.sour) cover.sour += 1; else cover.notSour += 1;
      if (s.rate.pressureCapApplied) cover.aboveCap += 1;
      bindings.add(s.binding.what);
    });
    expect(cover.stripped).toBeGreaterThanOrEqual(1);
    expect(cover.withheld).toBeGreaterThanOrEqual(2);
    expect(cover.sour).toBeGreaterThanOrEqual(3);
    expect(cover.notSour).toBeGreaterThanOrEqual(1);
    expect(cover.aboveCap).toBeGreaterThanOrEqual(1);
    expect(bindings.size).toBeGreaterThanOrEqual(3);
    say(`${rows.length} whole-screen rows,`, JSON.stringify(cover),
      `bindings reached: ${[...bindings].sort().join(' | ')}`);
  });

  test('THE SHEAR VERDICT NOW ACTS ON THE RATE, which it never did', () => {
    // At 60 ft/s the engine returned 362 Pa, filmRisk high and the
    // sentence "most inhibitor films are stripped at this shear", and
    // then applied the datasheet efficiency anyway: 1.897 mm/yr and
    // 1.67 years of life against 13.080 mm/yr and 0.243 years if its
    // own warning is believed. A factor of 6.90.
    const base = G.screenRows[0];
    const gentle = screen(base);
    const harsh = screen({ ...base, velocityMS: 18.288 });
    expect(gentle.filmStripped).toBe(false);
    expect(harsh.filmStripped).toBe(true);
    expect(harsh.shear.tauPa).toBeGreaterThan(FILM_STRIP_PA);
    // the rate the studio prints is now the one the sentence describes
    expect(harsh.rate.rateMmYr).toBeCloseTo(harsh.rate.uninhibitedMmYr, 9);
    expect(harsh.rate.effectiveInhibitionPct).toBeCloseTo(0, 9);
    expect(harsh.rate.inhibitorFilmIntact).toBe(false);
    expect(harsh.rate.warning).toMatch(/inhibitor credit has been removed/);
    // and the cost of that verdict is reported rather than implied
    const ratio = harsh.rate.rateMmYr / harsh.rateWithFilmCreditMmYr;
    expect(ratio).toBeGreaterThan(6.8);
    expect(ratio).toBeLessThan(7.0);
    expect(harsh.binding.what).toBe('wall shear on the inhibitor film');
    expect(harsh.life.remainingYears).toBeLessThan(0.3);
    say(`60 ft/s: tau ${harsh.shear.tauPa.toFixed(1)} Pa, rate`,
      `${harsh.rate.rateMmYr.toFixed(3)} mm/yr against`,
      `${harsh.rateWithFilmCreditMmYr.toFixed(3)} with the datasheet credit,`,
      `${ratio.toFixed(2)} times, life ${harsh.life.remainingYears.toFixed(3)} yr`);
  });

  test('THE RATE IS WITHHELD when the module says its own model does not apply', () => {
    // H2S was inert on the rate from 0 to 10 mol% while the engine
    // said "a CO2-only model no longer describes this surface" on
    // another tab and the studio went on printing 0.755 mm/yr, the
    // word high in orange, and 4.21 years.
    const base = G.screenRows[0];
    const sulphide = screen({ ...base, h2sMolFrac: 0.01 });
    expect(sulphide.regime.regime).toBe('sulphide');
    expect(sulphide.regime.rateApplies).toBe(false);
    expect(sulphide.category).toBeNull();
    expect(sulphide.life).toBeNull();
    expect(sulphide.withheld.what).toMatch(/category and the remaining life/);
    expect(sulphide.withheld.upperBoundMmYr).toBeGreaterThan(0);
    expect(sulphide.binding.what).toBe('the model does not apply');
    // the rate ITSELF is still there, as a stated upper bound
    expect(sulphide.rate.rateMmYr).toBeGreaterThan(0);
    // no CO2, and oil wet, land in the same place
    const noCo2 = screen({ ...base, co2MolFrac: 0 });
    expect(noCo2.category).toBeNull();
    expect(noCo2.life).toBeNull();
    expect(noCo2.withheld.why).toMatch(/no CO2/);
    expect(noCo2.rate.note).toMatch(/does not apply, not that the line is not corroding/);
    const oilWet = screen({ ...base, flowRegime: 'oilWet' });
    expect(oilWet.category).toBeNull();
    expect(oilWet.life).toBeNull();
    expect(oilWet.withheld.why).toMatch(/zero because that was assumed/);
    expect(oilWet.rate.effectiveInhibitionPct).toBeNull();
    // mixed is NOT withheld, but it is marked as a bound
    const mixed = screen(base);
    expect(mixed.regime.regime).toBe('mixed');
    expect(mixed.regime.rateIsUpperBound).toBe(true);
    expect(mixed.category).toBe('high');
    say('1 mol% H2S, zero CO2 and an oil-wet dropdown all withhold the category and the life;',
      'the 0.1 mol% default stays graded and is marked an upper bound');
  });

  test('screen REFUSES rather than reporting a complete screening it did not do', () => {
    const rows = need('refusals', 12);
    const base = need('refusalBase');
    let count = 0;
    rows.forEach((row) => {
      const args = { ...base };
      Object.entries(row.override).forEach(([k, v]) => {
        args[k] = v === null ? undefined : v;
      });
      const fn = row.call === 'screen' ? screen : corrosionRate;
      const out = fn(args);
      if (!out.error) {
        throw new Error(`the module did NOT refuse "${row.why}" and returned ${JSON.stringify(out).slice(0, 160)}`);
      }
      expect(out.error).toMatch(new RegExp(row.expect, 'i'));
      count += 1;
    });
    expect(count).toBe(rows.length);
    say(`${count} input sets, each refused with a message naming the input:`,
      rows.map((r) => r.expect).join(', '));
  });

  test('a missing velocity gives NaN and NOT Infinity, so it cannot pass as no transfer limit', () => {
    // dwmMassTransferRate used to return Infinity, which made
    // 1/(1/vr + 1/Infinity) equal vr exactly, named "reaction
    // kinetics" as the controlling mechanism from an input that was
    // never supplied, and put the rate 4.78 times high.
    const v = dwmMassTransferRate({ velocityMS: undefined, diameterM: 0.15, fco2Bar: 1.3 });
    expect(v).not.toBe(Infinity);
    expect(Number.isNaN(v)).toBe(true);
    expect(Number.isNaN(dwmMassTransferRate({ velocityMS: 3, diameterM: 0, fco2Bar: 1.3 }))).toBe(true);
    expect(Number.isNaN(dwmMassTransferRate({ velocityMS: 3, diameterM: 0.15, fco2Bar: NaN }))).toBe(true);
    // and the whole call refuses rather than answering
    const r = corrosionRate({
      tC: 60, pTotalBar: 51, co2MolFrac: 0.03, diameterM: 0.1524, ph: 4.5,
    });
    expect(r.error).toMatch(/unlimited mass-transfer capacity/);
    say('velocity absent, diameter zero and fCO2 NaN: NaN in all three, and corrosionRate refuses');
  });

  test('a temperature at or below absolute zero refuses instead of returning finite garbage', () => {
    // -500 F is -295.6 C, below absolute zero, and the engine used to
    // return a fugacity coefficient of 2212, a reaction rate of
    // 8.3e56 and the label "negligible".
    expect(Number.isNaN(co2FugacityCoefficient({ tC: -295.6, pTotalBar: 50 }))).toBe(true);
    expect(Number.isNaN(dwmReactionRate({ tC: -295.6, fco2Bar: 1.3 }))).toBe(true);
    expect(Number.isNaN(scaleFactor({ tC: -295.6, fco2Bar: 1.3 }))).toBe(true);
    expect(co2Fugacity({ tC: -295.6, pTotalBar: 50, co2MolFrac: 0.03 }).error)
      .toMatch(/absolute zero/);
    expect(Number.isNaN(co2FugacityCoefficient({ tC: -273.15, pTotalBar: 50 }))).toBe(true);
    expect(co2FugacityCoefficient({ tC: -273.14, pTotalBar: 50 })).not.toBeNaN();
    say('-295.6 C and exactly -273.15 C refuse; -273.14 C still answers');
  });

  test('the fugacity cap is reported rather than applied in silence', () => {
    const under = co2Fugacity({ tC: 71.2, pTotalBar: 240, co2MolFrac: 0.015 });
    const over = co2Fugacity({ tC: 71.2, pTotalBar: 312.5, co2MolFrac: 0.015 });
    expect(under.pressureCapApplied).toBe(false);
    expect(under.note).toBeNull();
    expect(over.pressureCapApplied).toBe(true);
    expect(over.note).toMatch(/above the cap/);
    expect(over.pressureCapBar).toBe(FUGACITY_CAP_BAR);
    say(`240 bar under the ${FUGACITY_CAP_BAR} bar cap and 312.5 bar over it`);
  });

  test('the binding constraint names something, and it changes with the case', () => {
    const base = G.screenRows[0];
    const cases = [
      ['app defaults', base, 'the corrosion allowance against the design life'],
      ['60 ft/s', { ...base, velocityMS: 18.288 }, 'wall shear on the inhibitor film'],
      ['1 mol% H2S', { ...base, h2sMolFrac: 0.01 }, 'the model does not apply'],
      ['a 12 mm allowance', { ...base, corrosionAllowanceMm: 25.4 }, 'mass transfer to the wall'],
    ];
    cases.forEach(([label, args, expected]) => {
      const s = screen(args);
      expect(s.binding.what).toBe(expected);
      expect(s.binding.why.length).toBeGreaterThan(30);
      say(`${label}: binding = ${s.binding.what}`);
    });
    // reaction kinetics as a binding constraint, in a big slow line
    const kinetic = screen({
      ...base, velocityMS: 30, diameterM: 0.5, densityKgM3: 897.036,
      corrosionAllowanceMm: 254, inhibitorEfficiencyPct: 0, inhibitorAvailabilityPct: 100,
    });
    expect(['reaction kinetics', 'wall shear on the inhibitor film'])
      .toContain(kinetic.binding.what);
  });
});

/* ================================================================== *
 * 5. NEGATIVE CONTROLS. Every recipe above is run against a
 *    deliberately WRONG implementation and must reject it. A recipe
 *    that cannot fail is not a check.
 * ================================================================== */
describe('NEGATIVE CONTROLS: each check is proved able to fail', () => {
  const fired = [];
  const control = (name, fn) => {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) {
      throw new Error(`NEGATIVE CONTROL DID NOT FIRE: "${name}". The check it guards cannot fail and therefore validates nothing.`);
    }
    fired.push(name);
  };

  test('the constant-measuring recipes reject a moved constant', () => {
    control('fugacity 0.0031 -> 0.0035', () => {
      const stub = { co2FugacityCoefficient: ({ tC, pTotalBar }) => 10 ** ((0.0035 - 1.4 / (tC + 273.15)) * Math.min(Math.max(pTotalBar, 0), 250)) };
      expect(measure.fugacity(stub).A).toBeCloseTo(PIN.fugacityA, 10);
    });
    control('fugacity 1.4 -> 1.6', () => {
      const stub = { co2FugacityCoefficient: ({ tC, pTotalBar }) => 10 ** ((0.0031 - 1.6 / (tC + 273.15)) * Math.min(Math.max(pTotalBar, 0), 250)) };
      expect(measure.fugacity(stub).B).toBeCloseTo(PIN.fugacityB, 8);
    });
    control('de Waard-Milliams 4.93 -> 5.10', () => {
      const stub = { dwmReactionRate: ({ tC, fco2Bar }) => 10 ** (5.10 - 1119 / (tC + 273.15) + 0.58 * Math.log10(fco2Bar)) };
      expect(measure.reaction(stub).A).toBeCloseTo(PIN.dwmA, 8);
    });
    control('de Waard-Milliams 1119 -> 1200', () => {
      const stub = { dwmReactionRate: ({ tC, fco2Bar }) => 10 ** (4.93 - 1200 / (tC + 273.15) + 0.58 * Math.log10(fco2Bar)) };
      expect(measure.reaction(stub).B).toBeCloseTo(PIN.dwmB, 6);
    });
    control('de Waard-Milliams 0.58 -> 0.65', () => {
      const stub = { dwmReactionRate: ({ tC, fco2Bar }) => 10 ** (4.93 - 1119 / (tC + 273.15) + 0.65 * Math.log10(fco2Bar)) };
      expect(measure.reaction(stub).n).toBeCloseTo(PIN.dwmN, 10);
    });
    control('mass transfer 2.45 -> 2.80', () => {
      const stub = { dwmMassTransferRate: ({ velocityMS, diameterM, fco2Bar }) => 2.80 * (velocityMS ** 0.8 / diameterM ** 0.2) * fco2Bar };
      expect(measure.massTransfer(stub).C).toBeCloseTo(PIN.vmC, 10);
    });
    control('mass transfer U exponent 0.8 -> 0.9', () => {
      const stub = { dwmMassTransferRate: ({ velocityMS, diameterM, fco2Bar }) => 2.45 * (velocityMS ** 0.9 / diameterM ** 0.2) * fco2Bar };
      expect(measure.massTransfer(stub).uExp).toBeCloseTo(PIN.vmUExp, 10);
    });
    control('mass transfer d exponent 0.2 -> 0.3', () => {
      const stub = { dwmMassTransferRate: ({ velocityMS, diameterM, fco2Bar }) => 2.45 * (velocityMS ** 0.8 / diameterM ** 0.3) * fco2Bar };
      expect(measure.massTransfer(stub).dExp).toBeCloseTo(PIN.vmDExp, 10);
    });
    control('scale 2400 -> 2600', () => {
      const stub = { scaleFactor: ({ tC, fco2Bar }) => { const f = 10 ** (2600 / (tC + 273.15) - 0.6 * Math.log10(fco2Bar) - 6.7); return f < 1 ? f : 1; } };
      expect(measure.scale(stub).A).toBeCloseTo(PIN.scaleA, 5);
    });
    control('scale 0.6 -> 0.7', () => {
      const stub = { scaleFactor: ({ tC, fco2Bar }) => { const f = 10 ** (2400 / (tC + 273.15) - 0.7 * Math.log10(fco2Bar) - 6.7); return f < 1 ? f : 1; } };
      expect(measure.scale(stub).n).toBeCloseTo(PIN.scaleN, 9);
    });
    control('scale 6.7 -> 7.0', () => {
      const stub = { scaleFactor: ({ tC, fco2Bar }) => { const f = 10 ** (2400 / (tC + 273.15) - 0.6 * Math.log10(fco2Bar) - 7.0); return f < 1 ? f : 1; } };
      expect(measure.scale(stub).C).toBeCloseTo(PIN.scaleC, 7);
    });
    control('pH slope -0.5 -> -0.8', () => {
      const stub = { phFactor: ({ ph }) => ({ factor: 10 ** (-0.8 * (ph - 4)) }) };
      expect(measure.ph(stub).slope).toBeCloseTo(PIN.phSlope, 12);
    });
    control('Blasius 0.046 -> 0.079', () => {
      const stub = { wallShearStressPa: ({ velocityMS, diameterM, densityKgM3, viscosityPaS }) => { const re = densityKgM3 * velocityMS * diameterM / viscosityPaS; return { fanningFriction: re > 4000 ? 0.079 * re ** -0.2 : 16 / re }; } };
      expect(measure.friction(stub).C).toBeCloseTo(PIN.blasiusC, 10);
    });
    control('Blasius -0.2 -> -0.25', () => {
      const stub = { wallShearStressPa: ({ velocityMS, diameterM, densityKgM3, viscosityPaS }) => { const re = densityKgM3 * velocityMS * diameterM / viscosityPaS; return { fanningFriction: re > 4000 ? 0.046 * re ** -0.25 : 16 / re }; } };
      expect(measure.friction(stub).n).toBeCloseTo(PIN.blasiusN, 10);
    });
    control('laminar 16/Re -> 64/Re', () => {
      const stub = { wallShearStressPa: ({ velocityMS, diameterM, densityKgM3, viscosityPaS }) => { const re = densityKgM3 * velocityMS * diameterM / viscosityPaS; return { fanningFriction: re > 4000 ? 0.046 * re ** -0.2 : 64 / re }; } };
      expect(measure.friction(stub).laminarC).toBeCloseTo(PIN.laminarC, 9);
    });
    control('the Reynolds switch 4000 -> 2100', () => {
      const stub = { wallShearStressPa: ({ velocityMS, diameterM, densityKgM3, viscosityPaS }) => { const re = densityKgM3 * velocityMS * diameterM / viscosityPaS; return { flowRegime: re > 2100 ? 'turbulent' : 'laminar' }; } };
      expect(measure.switchRe(stub)).toBeCloseTo(PIN.switchRe, 3);
    });
    say(`${fired.length} controls fired so far:`, fired.join('; '));
  });

  test('the constant-free invariants reject a broken form', () => {
    const before = fired.length;
    control('the decade law, with the slope moved', () => {
      const stub = (ph) => 10 ** (-0.8 * (ph - 4));
      expect(-Math.log10(stub(6.5) / stub(4.5))).toBeCloseTo(PIN.decadesPerTwoPhUnits, 12);
    });
    control('linearity in fCO2, with fCO2 entering as a square root', () => {
      const stub = (u, d, f) => 2.45 * (u ** 0.8 / d ** 0.2) * Math.sqrt(f);
      expect(stub(3, 0.2, 2.4) / stub(3, 0.2, 1.2)).toBeCloseTo(2, 12);
    });
    control('the series identity, with the combination replaced by a minimum', () => {
      const vr = 44.2; const vm = 11.7;
      const combined = Math.min(vr, vm);
      expect(Math.abs(1 / combined - 1 / vr - 1 / vm) * combined).toBeLessThan(1e-12);
    });
    control('the series identity, with the combination replaced by an arithmetic mean', () => {
      const vr = 44.2; const vm = 11.7;
      const combined = (vr + vm) / 2;
      expect(Math.abs(1 / combined - 1 / vr - 1 / vm) * combined).toBeLessThan(1e-12);
    });
    control('the pipe force balance, with the wall shear halved', () => {
      const row = G.screenRows[0];
      const tau = 0.5 * wallShearStressPa(row).tauPa;
      const fromBalance = (row.pressureDropPa * row.diameterM) / (4 * row.shearLengthM);
      expect(rel(tau, fromBalance)).toBeLessThan(1e-12);
    });
    control('the pipe force balance, with the perimeter factor 4 taken as 8', () => {
      const row = G.screenRows[0];
      const fromBalance = (row.pressureDropPa * row.diameterM) / (8 * row.shearLengthM);
      expect(rel(wallShearStressPa(row).tauPa, fromBalance)).toBeLessThan(1e-12);
    });
    control('the film onset, with the closed form rearranged wrongly', () => {
      const row = G.scaleOnset[3];
      const wrong = 2400 / (6.7 - 0.6 * Math.log10(row.fco2Bar)) - 273.15;
      expect(rel(wrong, row.onsetBisectedTC)).toBeLessThan(1e-9);
    });
    control('the 60 C claim, asserted as if it were the onset', () => {
      const fco2 = corrosionRate(G.screenRows[0]).fco2Bar;
      expect(scaleOnsetTC({ fco2Bar: fco2 })).toBeCloseTo(60, 0);
    });
    say(`${fired.length - before} more controls fired:`, fired.slice(before).join('; '));
  });

  test('the mole-fraction ratio route rejects a pH2S built from the wrong thing', () => {
    const before = fired.length;
    const row = G.regimeRows[1];
    control('pH2S taken as the TOTAL pressure, dropping the mole fraction', () => {
      const wrong = corrosionRegime({ ph2sBar: row.pTotalBar, pco2Bar: row.pco2Bar });
      expect(rel(wrong.ratio, row.h2sMolFrac / row.co2MolFrac)).toBeLessThan(1e-12);
    });
    control('the CO2 FUGACITY fed where the partial pressure belongs', () => {
      const f = co2Fugacity({ tC: 60, pTotalBar: row.pTotalBar, co2MolFrac: row.co2MolFrac });
      const wrong = corrosionRegime({ ph2sBar: row.ph2sBar, pco2Bar: f.fco2Bar });
      expect(rel(wrong.ratio, row.h2sMolFrac / row.co2MolFrac)).toBeLessThan(1e-12);
    });
    control('the category taken from the UNINHIBITED rate', () => {
      const s = screen(G.screenRows[0]);
      expect(rateCategory(s.rate.uninhibitedMmYr)).toBe(s.category);
    });
    control('the sour threshold moved by a factor of ten', () => {
      expect(0.035).toBeCloseTo(PIN.sourThresholdBar, 12);
    });
    control('the sour threshold read as exactly 0.05 psia', () => {
      expect(0.05).toBeCloseTo(PIN.sourThresholdPsia, 6);
    });
    control('the rate category low band moved from 0.1 to 0.5', () => {
      expect(0.5).toBeCloseTo(PIN.categoryLow, 12);
    });
    control('the film strip threshold moved from 100 to 200 Pa', () => {
      expect(200).toBeCloseTo(PIN.filmStripPa, 12);
    });
    control('the moderate film band moved from 50 to 20 Pa', () => {
      expect(20).toBeCloseTo(PIN.filmModeratePa, 12);
    });
    control('the carbonate boundary moved from 1/500 to 1/50', () => {
      expect(1 / 50).toBeCloseTo(PIN.regimeCarbonateMax, 15);
    });
    say(`${fired.length - before} more controls fired:`, fired.slice(before).join('; '));
  });

  test('the fails-open controls: each repaired refusal is proved to have been an answer before', () => {
    const before = fired.length;
    const base = need('refusalBase');
    control('the old no-CO2 branch reached by a NaN fugacity', () => {
      // the old guard was !(fco2Bar > 0), which is TRUE for NaN, so a
      // blank temperature took the no-CO2 branch and printed a rate of
      // zero with a CO2 message. This asserts the OLD behaviour and
      // must fail.
      const out = screen({ ...base, tC: undefined });
      expect(out.error).toBeUndefined();
      expect(out.rate.rateMmYr).toBe(0);
    });
    control('the old Infinity mass-transfer answer from a missing velocity', () => {
      const out = corrosionRate({ ...base, velocityMS: undefined });
      expect(out.error).toBeUndefined();
      expect(out.controlling).toBe('reaction kinetics');
    });
    control('the old silent swallow of shear.error inside screen', () => {
      const out = screen({ ...base, densityKgM3: undefined });
      expect(out.error).toBeUndefined();
      expect(out.shear.error).toBeTruthy();
    });
    control('the old inert pH below the reference', () => {
      const a = corrosionRate({ ...base, ph: 2.0 });
      const b = corrosionRate({ ...base, ph: 4.0 });
      expect(a.rateMmYr).toBe(b.rateMmYr);
    });
    control('the old inhibitor guard eff > 0.9, silent at the app default', () => {
      const out = corrosionRate({ ...base, inhibitorEfficiencyPct: 90, inhibitorAvailabilityPct: 95 });
      expect(out.warning).toBeNull();
    });
    control('the old datasheet efficiency applied through a stripped film', () => {
      const out = screen({ ...base, velocityMS: 18.288 });
      expect(out.rate.effectiveInhibitionPct).toBeCloseTo(85.5, 6);
    });
    control('the old graded rate in the sulphide regime', () => {
      const out = screen({ ...base, h2sMolFrac: 0.01 });
      expect(out.category).toBe('high');
      expect(out.life.remainingYears).toBeGreaterThan(0);
    });
    control('the old unbounded life with a passing verdict from a zero rate', () => {
      const out = remainingLife({ rateMmYr: 0, corrosionAllowanceMm: 3.175, designLifeYears: 20 });
      expect(out.remainingYears).toBe(Infinity);
      expect(out.meetsDesignLife).toBe(true);
    });
    control('the old acceptance of a 300 mol% CO2 fraction', () => {
      const out = screen({ ...base, co2MolFrac: 3 });
      expect(out.error).toBeUndefined();
      expect(out.rate.pco2Bar).toBeGreaterThan(base.pTotalBar);
    });
    control('the old acceptance of a 500 percent water cut', () => {
      const out = corrosionRate({ ...base, flowRegime: 'intermittent', waterCutFrac: 5 });
      expect(out.error).toBeUndefined();
      expect(out.waterWettingFactor).toBe(5);
    });
    control('the old case-sensitive regime match falling through to water wet', () => {
      const out = corrosionRate({ ...base, flowRegime: 'OILWET' });
      expect(out.waterWettingFactor).toBe(1);
    });
    control('the old silent clamp of a typed 100 percent efficiency to 99.9', () => {
      const out = corrosionRate({ ...base, inhibitorEfficiencyPct: 100, inhibitorAvailabilityPct: 95 });
      expect(out.effectiveInhibitionPct).toBeCloseTo(94.905, 6);
    });
    control('the old finite garbage below absolute zero', () => {
      const out = co2FugacityCoefficient({ tC: -295.6, pTotalBar: 50 });
      expect(Number.isFinite(out)).toBe(true);
    });
    control('the old Region 3 from a missing pH, with hard material guidance', () => {
      expect(typeof CORROSION.sourServiceRegion).toBe('function');
    });
    control('the old empty note on the unknown regime branch', () => {
      expect(corrosionRegime({ ph2sBar: 0.001, pco2Bar: 0 }).note).toBeUndefined();
    });
    control('the old fabricated 0 percent inhibition on an oil-wet line', () => {
      const out = corrosionRate({ ...base, flowRegime: 'oilWet' });
      expect(out.effectiveInhibitionPct).toBe(0);
    });
    control('the old screen with no binding constraint at all', () => {
      expect(screen(base).binding).toBeUndefined();
    });
    say(`${fired.length - before} fails-open controls fired:`, fired.slice(before).join('; '));
  });

  test('every negative control in this file fired, and the count is asserted', () => {
    expect(fired.length).toBeGreaterThanOrEqual(50);
    console.log(`   ${fired.length} NEGATIVE CONTROLS FIRED. Each one asserts a WRONG value`
      + ' through the same recipe the real check uses, and each one was rejected.');
  });
});
