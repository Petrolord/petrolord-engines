// HSE H3 gates: LOPA scenario frequency and SIL determination, and SIF
// PFDavg verification by the IEC 61508-6:2010 Annex B simplified
// equations, against the independent stdlib oracle
// (tools/validation/hse/oracle_lopa.py) and a published worked SIF.
//
// Every golden below is CALLED THROUGH THE ENGINE. What the routes check:
//
//  - route A (exact rationals, Annex B by the koon group-failure
//    construction): every coefficient, gated at 1e-12 relative, and every
//    SIL boundary decision exactly (no floating-point snap in the oracle);
//  - PUBLISHED: the 61508 Association worked SIF (Dolan 2024): ten
//    subsystem rows and the SIF total must round to the printed three
//    significant figures, and the RRF to the printed 777;
//  - route B (time-dependent unavailability averaged by quadrature,
//    nothing linearised): Annex B must never fall below it (it is the
//    conservative first-order form), and for DU-only rows with MRT = 0 and
//    perfect proof testing it must sit within 1.5 lambda T of it. A dropped
//    /2 in 1oo1 is a factor of two against route B.
//
// Negative controls: tools/validation/hse/negcontrol_lopa.sh.

import fs from 'fs';
import path from 'path';
import {
  ARCHITECTURES, BAND_CONVENTION, DECADE_SNAP, LOPA_OUTCOME, PFD_STATE, SIL_BANDS_LOW_DEMAND,
  decadeOf, lopaScenario, maxProofTestInterval, outcomeFromRequiredRrf,
  pfdAvgSif, pfdAvgSubsystem, proofTestSensitivity, silFromPfdAvg,
} from '../engines/hse/lopa';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'hse', 'goldens', 'lopa_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const RTOL = 1e-12;

describe('golden file', () => {
  test('is the oracle output and carries every section', () => {
    expect(G.module).toBe('lopa');
    expect(G.generatedBy).toBe('tools/validation/hse/oracle_lopa.py');
    expect(G.pfdPublished.length).toBeGreaterThanOrEqual(10);
    expect(G.pfdDerived.length).toBeGreaterThanOrEqual(15);
    expect(G.lopa.length).toBeGreaterThanOrEqual(12);
    // every case says where it came from
    [...G.pfdPublished, ...G.pfdDerived, ...G.lopa, G.sifPublished, G.sensitivity, ...G.maxInterval]
      .forEach((c) => expect(c.source).toMatch(/^(PUBLISHED|ORACLE-DERIVED)/));
    // illustrative failure rates are labelled as such
    G.pfdDerived.forEach((c) => expect(c.source).toMatch(/illustrative/));
  });
});

describe('SIL bands, low demand', () => {
  test('the band table is the IEC 61508-1 Table 2 decades', () => {
    expect(SIL_BANDS_LOW_DEMAND.map((b) => [b.sil, b.pfdMin, b.pfdMax])).toEqual([
      [4, 1e-5, 1e-4], [3, 1e-4, 1e-3], [2, 1e-3, 1e-2], [1, 1e-2, 1e-1],
    ]);
  });

  test.each(G.bands.map((b) => [b.pfdAvg, b.sil, b.state]))('PFDavg %p is SIL %p (%p)', (p, sil, state) => {
    const r = silFromPfdAvg(p);
    expect(r.sil).toBe(sil);
    expect(r.state).toBe(state);
  });

  test.each(G.rrfOutcomes.map((o) => [o.rrf, o]))('required RRF %p', (rrf, o) => {
    const r = outcomeFromRequiredRrf(rrf);
    expect(r.outcome).toBe(o.outcome);
    expect(r.requiredSil).toBe(o.requiredSil);
    if (o.requiredSifPfdAvg === null) expect(r.requiredSifPfdAvg).toBeNull();
    else expect(rel(r.requiredSifPfdAvg, o.requiredSifPfdAvg)).toBeLessThan(RTOL);
    if ('pfdInSil4Band' in o) expect(r.pfdInSil4Band).toBe(o.pfdInSil4Band);
  });

  test('the decade snap: a computed ratio a hair off a decade IS the decade', () => {
    expect(DECADE_SNAP).toBe(1e-9);
    expect(decadeOf(1e-2 * (1 + 5e-10))).toBe(-2);
    expect(decadeOf(1e-2 * (1 + 5e-9))).toBeNull();
    expect(silFromPfdAvg(0.1 * 0.1 * (1 - 1e-12)).sil).toBe(1);
    expect(silFromPfdAvg(1e-2 * (1 - 1e-6)).sil).toBe(2);
  });

  test('refuses a PFD that is not a probability', () => {
    [0, -1, 1.5, NaN, Infinity, '0.01'].forEach((p) => {
      expect(silFromPfdAvg(p).field).toBe('pfdAvg');
    });
    expect(outcomeFromRequiredRrf(0).field).toBe('rrf');
  });
});

describe('LOPA scenarios', () => {
  test.each(G.lopa.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = lopaScenario(c.args);
    const e = c.expected;
    expect(r.error).toBeUndefined();
    ['unmitigatedFrequencyPerYr', 'iplProduct', 'mitigatedFrequencyWithoutSifPerYr', 'requiredRrf',
      'mitigatedFrequencyPerYr'].forEach((k) => expect(rel(r[k], e[k])).toBeLessThan(RTOL));
    expect(r.outcome).toBe(e.outcome);
    expect(r.requiredSil).toBe(e.requiredSil);
    if (e.requiredSifPfdAvg === null) expect(r.requiredSifPfdAvg).toBeNull();
    else expect(rel(r.requiredSifPfdAvg, e.requiredSifPfdAvg)).toBeLessThan(RTOL);
    if ('pfdInSil4Band' in e) expect(r.pfdInSil4Band).toBe(e.pfdInSil4Band);
    expect(r.credited.map((x) => x.name)).toEqual(e.credited);
    expect(r.notCredited.map((x) => x.name)).toEqual(e.notCredited);
    expect(r.meetsTmel).toBe(e.meetsTmel);
    expect(r.basis.method).toMatch(/CCPS/);
  });

  test('the exact-decade cases really are a hair above the decade in floating point', () => {
    // If this ever stops being true the boundary goldens stop discriminating.
    const byId = Object.fromEntries(G.lopa.map((c) => [c.id, c]));
    ['rrf-exactly-100', 'rrf-exactly-1000', 'rrf-exactly-10000', 'rrf-exactly-10'].forEach((id) => {
      const r = lopaScenario(byId[id].args);
      expect(decadeOf(r.requiredRrf)).not.toBeNull();
      expect(r.requiredRrf).toBeGreaterThan(10 ** decadeOf(r.requiredRrf));
    });
  });

  test('beyond SIL 3 is a state with the number intact, never clipped', () => {
    const r = lopaScenario({ initiatingEventFrequencyPerYr: 0.2, tmelPerYr: 1e-5 });
    expect(r.outcome).toBe(LOPA_OUTCOME.BEYOND_SIL3);
    expect(r.requiredSil).toBeNull();
    expect(r.requiredSifPfdAvg).toBeCloseTo(5e-5, 18);
    expect(r.note).toMatch(/redesign/);
  });

  test('a SIF in the right band that misses the required PFD does not meet the TMEL', () => {
    const c = G.lopa.find((x) => x.id === 'sif-just-short');
    const r = lopaScenario(c.args);
    expect(r.requiredSil).toBe(2);
    expect(r.sifBand.sil).toBe(2);
    expect(r.meetsTmel).toBe(false);
  });

  test('refusals by name', () => {
    const ok = { initiatingEventFrequencyPerYr: 0.1, tmelPerYr: 1e-5 };
    expect(lopaScenario({ ...ok, initiatingEventFrequencyPerYr: 0 }).field).toBe('initiatingEventFrequencyPerYr');
    expect(lopaScenario({ ...ok, tmelPerYr: undefined }).field).toBe('tmelPerYr');
    expect(lopaScenario({ ...ok, conditionalModifiers: [{ name: 'ignition', probability: 0 }] }).field)
      .toBe('conditionalModifiers[0].probability');
    expect(lopaScenario({ ...ok, enablingConditions: [{ name: 'mode', probability: 1.2 }] }).field)
      .toBe('enablingConditions[0].probability');
    expect(lopaScenario({ ...ok, conditionalModifiers: [{ probability: 0.5 }] }).field)
      .toBe('conditionalModifiers[0].name');
    expect(lopaScenario({ ...ok, ipls: [{ name: 'PSV', pfd: 0, independent: true }] }).field).toBe('ipls[0].pfd');
    const dup = lopaScenario({
      ...ok,
      ipls: [{ name: 'PSV-101', pfd: 0.01, independent: true }, { name: 'psv-101 ', pfd: 0.01, independent: true }],
    });
    expect(dup.field).toBe('ipls[1].name');
    expect(dup.error).toMatch(/one credit per IPL/);
    expect(lopaScenario({ ...ok, sifPfdAvg: 0 }).field).toBe('sifPfdAvg');
  });

  test('an IPL without an explicit independent: true is listed, not credited', () => {
    const r = lopaScenario({
      initiatingEventFrequencyPerYr: 0.1, tmelPerYr: 1e-5,
      ipls: [{ name: 'operator', pfd: 0.1 }, { name: 'PSV', pfd: 0.01, independent: 'yes' }],
    });
    expect(r.credited).toEqual([]);
    expect(r.notCredited.map((x) => x.name)).toEqual(['operator', 'PSV']);
    expect(r.iplProduct).toBe(1);
  });
});

const checkPfd = (c) => {
  const r = pfdAvgSubsystem(c.params);
  expect(r.error).toBeUndefined();
  expect(rel(r.pfdAvg, c.expected.pfdAvg)).toBeLessThan(RTOL);
  expect(rel(r.rrf, c.expected.rrf)).toBeLessThan(RTOL);
  expect(r.sil).toBe(c.expected.sil);
  expect(r.state).toBe(c.expected.state);
  expect(rel(r.terms.independent, c.expected.independent)).toBeLessThan(1e-11);
  if (c.expected.ccf === 0) expect(r.terms.ccfDU + r.terms.ccfDD).toBe(0);
  else expect(rel(r.terms.ccfDU + r.terms.ccfDD, c.expected.ccf)).toBeLessThan(1e-11);
  expect(r.dominant).toBe(c.expected.dominant);
  // route B: Annex B is conservative against the exact time-dependent model
  expect(r.pfdAvg).toBeGreaterThanOrEqual(c.routeB.pfdAvg * (1 - 1e-9));
  if (c.routeB.tolerance !== undefined) {
    expect(Math.abs(r.pfdAvg / c.routeB.pfdAvg - 1)).toBeLessThanOrEqual(c.routeB.tolerance);
  }
  return r;
};

describe('PFDavg, published worked SIF (61508 Association, Dolan 2024)', () => {
  test.each(G.pfdPublished.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = checkPfd(c);
    expect(Number(r.pfdAvg.toPrecision(3))).toBe(Number(c.printed));
  });

  test('the SIF total and its RRF', () => {
    const c = G.sifPublished;
    const r = pfdAvgSif(c.subsystems);
    expect(rel(r.pfdAvg, c.expected.pfdAvg)).toBeLessThan(RTOL);
    expect(Number(r.pfdAvg.toPrecision(3))).toBe(Number(c.printed.pfdAvg));
    expect(Math.round(r.rrf)).toBe(Number(c.printed.rrf));
    expect(r.sil).toBe(2);
    expect(r.parts.map((p) => p.name)).toEqual(['initiators', 'A I/P', 'CPU', 'D O/P', 'final elements']);
  });
});

describe('PFDavg, simplified forms, limits and the full Annex B form', () => {
  test.each(G.pfdDerived.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = checkPfd(c);
    if (c.routeB2oo2WithBeta) {
      // Annex B carries no beta for 2oo2; with common cause the exact model
      // is lower still, (2 - beta)/2 of it to first order
      expect(r.pfdAvg).toBeGreaterThan(c.routeB2oo2WithBeta.pfdAvg);
    }
  });

  test('the simplified TR84 forms are the Annex B form at lambdaDD = 0, MRT = 0', () => {
    const l = 2e-6; const T = 8760; const b = 0.05;
    const p = (architecture, extra = {}) => pfdAvgSubsystem({
      architecture, lambdaDuPerHour: l, proofTestIntervalHours: T, ...extra,
    }).pfdAvg;
    expect(rel(p('1oo1'), l * T / 2)).toBeLessThan(RTOL);
    expect(rel(p('2oo2'), l * T)).toBeLessThan(RTOL);
    expect(rel(p('1oo2', { beta: b }), ((1 - b) * l) ** 2 * T ** 2 / 3 + b * l * T / 2)).toBeLessThan(RTOL);
    expect(rel(p('2oo3', { beta: b }), ((1 - b) * l) ** 2 * T ** 2 + b * l * T / 2)).toBeLessThan(RTOL);
    expect(rel(p('1oo3', { beta: b }), ((1 - b) * l) ** 3 * T ** 3 / 4 + b * l * T / 2)).toBeLessThan(RTOL);
    // beta = 1: every redundant architecture collapses to 1oo1
    ['1oo2', '2oo3', '1oo3'].forEach((a) => expect(rel(p(a, { beta: 1 }), p('1oo1'))).toBeLessThan(RTOL));
  });

  test('the common-cause-dominated 1oo2 says so', () => {
    const c = G.pfdDerived.find((x) => x.id === '1oo2-ccf-dominated');
    const r = pfdAvgSubsystem(c.params);
    expect(r.dominant).toBe('common cause');
    expect(r.terms.ccfDU / r.pfdAvg).toBeGreaterThan(0.97);
  });

  test('warnings: large lambda T, and beta on an architecture it does not apply to', () => {
    const c = G.pfdDerived.find((x) => x.id === '1oo1-long-interval');
    expect(pfdAvgSubsystem(c.params).warnings.join(' ')).toMatch(/exceeds 0\.1/);
    const w = pfdAvgSubsystem({ architecture: '1oo1', lambdaDuPerHour: 1e-6, proofTestIntervalHours: 8760, beta: 0.1 });
    expect(w.warnings.join(' ')).toMatch(/beta does not apply to 1oo1/);
  });

  test('refusals by name', () => {
    const base = { architecture: '1oo2', lambdaDuPerHour: 1e-6, proofTestIntervalHours: 8760, beta: 0.05 };
    expect(ARCHITECTURES).toEqual(['1oo1', '1oo2', '2oo2', '2oo3', '1oo3']);
    expect(pfdAvgSubsystem({ ...base, architecture: '2oo4' }).field).toBe('architecture');
    expect(pfdAvgSubsystem({ ...base, beta: undefined }).field).toBe('beta');
    expect(pfdAvgSubsystem({ ...base, beta: 1.2 }).field).toBe('beta');
    expect(pfdAvgSubsystem({ ...base, lambdaDdPerHour: 1e-6, mttrHours: 8 }).field).toBe('betaD');
    expect(pfdAvgSubsystem({ ...base, lambdaDdPerHour: 1e-6, betaD: 0.02 }).field).toBe('mttrHours');
    expect(pfdAvgSubsystem({ ...base, lambdaDuPerHour: -1 }).field).toBe('lambdaDuPerHour');
    expect(pfdAvgSubsystem({ ...base, lambdaDuPerHour: 0 }).field).toBe('lambdaDuPerHour');
    expect(pfdAvgSubsystem({ ...base, proofTestIntervalHours: 0 }).field).toBe('proofTestIntervalHours');
    expect(pfdAvgSubsystem({ ...base, mrtHours: -8 }).field).toBe('mrtHours');
    expect(pfdAvgSubsystem({ ...base, proofTestCoverage: 0.9 }).field).toBe('lifetimeHours');
    expect(pfdAvgSubsystem({ ...base, proofTestCoverage: 0.9, lifetimeHours: 100 }).field).toBe('lifetimeHours');
    expect(pfdAvgSubsystem({ ...base, proofTestCoverage: 0 }).field).toBe('proofTestCoverage');
    // the linearised form past 1 is not a probability: refused, not clipped
    const big = pfdAvgSubsystem({ architecture: '1oo1', lambdaDuPerHour: 1e-4, proofTestIntervalHours: 87600 });
    expect(big.field).toBe('proofTestIntervalHours');
    expect(big.error).toMatch(/not a probability/);
    expect(pfdAvgSif([]).field).toBe('subsystems');
    expect(pfdAvgSif([{ ...base, beta: undefined }]).field).toBe('subsystems[0].beta');
  });

  test('the basis names the method and the band convention', () => {
    const r = pfdAvgSubsystem({ architecture: '1oo1', lambdaDuPerHour: 1e-6, proofTestIntervalHours: 8760 });
    expect(r.basis.method).toMatch(/IEC 61508-6:2010 Annex B/);
    expect(r.basis.method).toMatch(/TR84/);
    expect(r.basis.bandConvention).toMatch(/10\^-\(n\+1\) <= PFDavg < 10\^-n/);
    expect(r.state).toBe(PFD_STATE.SIL);
  });
});

describe('proof test interval', () => {
  test('sensitivity rows', () => {
    const c = G.sensitivity;
    const r = proofTestSensitivity(c.params, c.intervalsHours);
    expect(r.rows).toHaveLength(c.rows.length);
    r.rows.forEach((row, i) => {
      expect(row.proofTestIntervalHours).toBe(c.rows[i].proofTestIntervalHours);
      expect(rel(row.pfdAvg, c.rows[i].pfdAvg)).toBeLessThan(RTOL);
      expect(row.sil).toBe(c.rows[i].sil);
      expect(row.state).toBe(c.rows[i].state);
    });
    // monotone in T1
    for (let i = 1; i < r.rows.length; i += 1) expect(r.rows[i].pfdAvg).toBeGreaterThan(r.rows[i - 1].pfdAvg);
    expect(proofTestSensitivity(c.params, []).field).toBe('intervalsHours');
  });

  test.each(G.maxInterval.map((c) => [c.id, c]))('longest interval: %s', (id, c) => {
    const r = maxProofTestInterval(c.params, c.targetPfdAvg);
    if (c.expected.state === 'REFUSED') {
      // The search refuses the way pfdAvgSubsystem does: an error naming the
      // field, and no state or interval that could be read as an answer.
      expect(r.error).toMatch(/outside the rare-event range/);
      expect(r.field).toBe(c.expected.field);
      expect(r.state).toBeUndefined();
      expect(r.proofTestIntervalHours).toBeUndefined();
      expect(r.error).toContain(`floor of ${c.expected.floorPfdAvg}`);
      return;
    }
    expect(r.state).toBe(c.expected.state);
    if (c.expected.proofTestIntervalHours !== undefined) {
      expect(rel(r.proofTestIntervalHours, c.expected.proofTestIntervalHours)).toBeLessThan(1e-9);
    }
    if (c.expected.floorPfdAvg !== undefined) expect(rel(r.floorPfdAvg, c.expected.floorPfdAvg)).toBeLessThan(RTOL);
  });

  test('refuses a target that is not a probability, and an interval-free subsystem says so', () => {
    expect(maxProofTestInterval({ architecture: '1oo1', lambdaDuPerHour: 1e-6 }, 0).field).toBe('targetPfdAvg');
    const r = maxProofTestInterval({ architecture: '1oo1', lambdaDuPerHour: 0, lambdaDdPerHour: 1e-6, mttrHours: 8 }, 1e-2);
    expect(r.state).toBe('INTERVAL_INDEPENDENT');
  });

  test('refuses a floor of PFDavg 1 or more on every path, as pfdAvgSubsystem does', () => {
    // pfdAvgSubsystem refuses these parameters at any interval.
    const dd = { architecture: '1oo1', lambdaDuPerHour: 1e-6, lambdaDdPerHour: 1e-3, mttrHours: 2000 };
    expect(pfdAvgSubsystem({ ...dd, proofTestIntervalHours: 1 }).error).toMatch(/not a probability/);
    expect(maxProofTestInterval(dd, 1e-2).field).toBe('lambdaDdPerHour');
    // lambdaDU = 0 used to return INTERVAL_INDEPENDENT with a PFDavg of 2.
    const r = maxProofTestInterval({ ...dd, lambdaDuPerHour: 0 }, 1e-2);
    expect(r.field).toBe('lambdaDdPerHour');
    expect(r.pfdAvg).toBeUndefined();
    // DU only, with an MRT so long that lambdaDU x MRT alone reaches 1.
    expect(maxProofTestInterval({ architecture: '1oo1', lambdaDuPerHour: 1e-3, mrtHours: 2000 }, 1e-2).field).toBe('mrtHours');
    // The uncovered part under PTC < 1 over a long lifetime.
    expect(maxProofTestInterval({
      architecture: '1oo1', lambdaDuPerHour: 1e-4, proofTestCoverage: 0.5, lifetimeHours: 1e5,
    }, 1e-2).field).toBe('lifetimeHours');
    // Just below 1 is still an answer: UNACHIEVABLE with the floor reported.
    const near = maxProofTestInterval({ ...dd, mttrHours: 900 }, 1e-2);
    expect(near.state).toBe('UNACHIEVABLE');
    expect(near.floorPfdAvg).toBeCloseTo(0.9, 12);
  });

  test('the rare-event warning fires on exactly the goldens FINDINGS-lopa section 4 lists', () => {
    // FINDINGS-lopa.md section 4 names these three. With PTC < 1 the product
    // is lambdaDU x T2 (the uncovered part runs the whole lifetime), which is
    // why two PTC rows warn at a one-year proof test interval.
    const warned = [...G.pfdPublished, ...G.pfdDerived]
      .filter((c) => pfdAvgSubsystem(c.params).warnings.some((w) => /rare-event/.test(w)))
      .map((c) => c.id)
      .sort();
    expect(warned).toEqual(['1oo1-long-interval', '1oo3-full-ptc', 'dolan-valve-1oo2-ptc85']);
  });

  test('every band statement is the one BAND_CONVENTION', () => {
    const sc = lopaScenario({ initiatingEventFrequencyPerYr: 0.1, tmelPerYr: 1e-5 });
    const sub = pfdAvgSubsystem({ architecture: '1oo1', lambdaDuPerHour: 1e-6, proofTestIntervalHours: 8760 });
    expect(silFromPfdAvg(5e-3).basis).toBe(BAND_CONVENTION);
    expect(sc.basis.bandConvention).toBe(BAND_CONVENTION);
    expect(sub.basis.bandConvention).toBe(BAND_CONVENTION);
    // It states both forms and the exact-decade rule.
    expect(BAND_CONVENTION).toMatch(/10\^-\(n\+1\) <= PFDavg < 10\^-n/);
    expect(BAND_CONVENTION).toMatch(/10\^n < RRF <= 10\^\(n\+1\)/);
    expect(BAND_CONVENTION).toMatch(/higher-PFD \(lower-SIL\) band/);
  });
});
