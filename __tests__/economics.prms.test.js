// Economics EC11 reserves and resources gates (SPE-PRMS 2018). Every case in
// test-data/economics/goldens/prms_cases.json is run THROUGH THE ENGINE and
// compared with the value the independent stdlib oracle
// (tools/validation/economics/oracle_prms.py) computed from the published
// rules by a different road (the PRMS 2.1 decision list as data; exact
// Fractions for categories and reconciliations; an annual cash-flow ledger on
// Fractions for the economic limit and the PRMS 3.1.3.1 peak; a replay of the
// stated sampler recipe for the Monte Carlo, with the exact mean and, for a
// normal total, the exact quantiles as a second witness). The published
// figures (AG 2011 Table 6.2 and its 72 and 77, the PRMS FAQ 3.3 low 5 and
// best 7, the NUPRC 2026 gas total, SEC S-K Item 1202(a)(3)) are checked
// against their printed values. Property tests compare engine outputs with
// each other, never with a restated formula; negcontrol_prms.sh proves the
// gates go red when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as X from '../engines/economics/prms';
import { computeCashFlow } from '../engines/economics/cashflow';
import { OUTCOME_LABELS, EXCEEDANCE_DEFINITION } from '../lib/conventions/percentile';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'economics', 'goldens', 'prms_cases.json');
const FX = read('test-data', 'economics', 'ekene-prms', 'ekene-prms.json');
const FLOOR = G.tolerance.absoluteFloor;

const diff = (actual, expected, tol, where = '') => {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return [`${where}: ${actual} is not a finite number (expected ${expected})`];
    const d = Math.abs(actual - expected);
    return d <= FLOOR || d <= tol * Math.abs(expected) ? [] : [`${where}: ${actual} vs ${expected} (abs ${d})`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${where}: array length ${actual && actual.length} vs ${expected.length}`];
    return expected.flatMap((e, i) => diff(actual[i], e, tol, `${where}[${i}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return [`${where}: ${actual} is not an object`];
    const extra = Object.keys(actual).filter((k) => !(k in expected) && k !== 'basis');
    const missing = Object.keys(expected).filter((k) => !(k in actual));
    const keyErr = extra.length || missing.length ? [`${where}: keys differ (engine only: ${extra.join(', ')}; oracle only: ${missing.join(', ')})`] : [];
    return keyErr.concat(Object.keys(expected).flatMap((k) => diff(actual[k], expected[k], tol, `${where}.${k}`)));
  }
  return actual === expected ? [] : [`${where}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`];
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const byId = (id) => {
  const c = G.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} is missing from prms_cases.json`);
  return c;
};
const memo = new Map();
const run = (id) => { if (!memo.has(id)) { const c = byId(id); memo.set(id, X[c.fn](clone(c.args))); } return memo.get(id); };
const FNS = ['aggregate', 'categorize', 'classify', 'economicLimit', 'reconcile'];
const strip = (o) => JSON.parse(JSON.stringify(o));
const ok = (fn) => G.cases.filter((c) => c.fn === fn && !c.expected.error);
const PHI90 = Math.exp(-(1.2815515655446004 ** 2) / 2) / Math.sqrt(2 * Math.PI);

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('prms');
    expect(G.generatedBy).toBe('tools/validation/economics/oracle_prms.py');
    expect(G.cases.length).toBeGreaterThanOrEqual(130);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by a golden, and refused at least once', () => {
    const fns = Object.keys(X).filter((k) => typeof X[k] === 'function').sort();
    expect(fns).toEqual(FNS);
    const used = new Set(G.cases.map((c) => c.fn));
    expect(fns.filter((f) => !used.has(f))).toEqual([]);
    const refused = new Set(G.cases.filter((c) => c.expected.error === true).map((c) => c.fn));
    expect(fns.filter((f) => !refused.has(f))).toEqual([]);
  });

  test.each(G.cases.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = run(id);
    const e = c.expected;
    if (e && e.error === true) {
      expect([typeof r.error, r.field]).toEqual(['string', e.field]);
      expect(r.error.startsWith(e.field)).toBe(true);
      expect(r.error).toBe(e.message);
      return;
    }
    expect(r && r.error).toBeFalsy();
    expect(diff(strip(r), e, c.tol, c.fn)).toEqual([]);
  });

  test('aggregate: the seeded Monte Carlo agrees with the exact mean, and a normal total with its exact quantiles', () => {
    const n = ok('aggregate');
    expect(n.length).toBeGreaterThanOrEqual(10);
    n.forEach((c) => {
      const r = run(c.id);
      const w = c.witness;
      expect([c.id, Math.abs(r.statistical.mean - w.mean) <= w.meanBand + 1e-9]).toEqual([c.id, true]);
      expect(r.sumOfMeans).toBeCloseTo(w.mean, 9);
      if (w.quantiles) {
        const band = (5 * Math.sqrt(0.09 / c.args.iterations) * w.quantiles.sd) / PHI90 + 1e-9;
        const bandMid = (5 * Math.sqrt(0.25 / c.args.iterations) * w.quantiles.sd) / 0.3989422804014327 + 1e-9;
        expect([c.id, Math.abs(r.statistical.low - w.quantiles.low) <= band]).toEqual([c.id, true]);
        expect([c.id, Math.abs(r.statistical.best - w.quantiles.best) <= bandMid]).toEqual([c.id, true]);
        expect([c.id, Math.abs(r.statistical.high - w.quantiles.high) <= band]).toEqual([c.id, true]);
      }
    });
  });
});

describe('published figures: the engine against the printed values', () => {
  test('AG 2011 Table 6.2: arithmetic Proved 43.3 + 28.5 = 71.8 (72 on Fig. 6.5); independent probabilistic Proved 77; near total dependence returns to the arithmetic sum', () => {
    const r = run('agg-ag2011-table62-independent');
    expect(r.arithmetic.low).toBeCloseTo(71.8, 9);
    expect(Math.round(r.arithmetic.low)).toBe(72);
    expect(r.sumOfMeans).toBeCloseTo(89, 9);
    expect(Math.round(r.statistical.low)).toBe(77);
    // the AG's own error-propagation figure: 89 - sqrt(10.1^2 + 7.1^2) = 76.654
    expect(Math.abs(r.statistical.low - (89 - Math.hypot(10.1, 7.1)))).toBeLessThan(0.05);
    const d = run('agg-ag2011-table62-dependent');
    expect(Math.abs(d.statistical.low - 71.8)).toBeLessThan(0.3);
    expect(d.statistical.low).toBeLessThan(r.statistical.low);
  });
  test('PRMS FAQ 3.3: technical low 5 and best 7 (5 + 2); the low case fails the economics, so 1P = 0, 2P = 7 and P2 = 7', () => {
    const c = run('cat-faq33-incremental');
    expect(c.cumulative.map((x) => [x.label, x.value])).toEqual([['1P', 5], ['2P', 7], ['3P', 10]]);
    const r = run('econ-faq33-low-fails');
    expect([r.cases.low.economic, r.cases.best.economic, r.reserves.provedZero]).toEqual([false, true, true]);
    expect([r.reserves.cumulative['1P'].oil, r.reserves.cumulative['2P'].oil, r.reserves.incremental.P2.oil]).toEqual([0, 7000000, 7000000]);
  });
  test('NUPRC, reserves as at 1 January 2026: 2P gas 100.21 + 114.98 = 215.19 Tcf by arithmetic summation', () => {
    const r = run('agg-nuprc-2026-gas-2p');
    expect(r.arithmetic.best).toBeCloseTo(215.19, 9);
    expect(r.statistical.best).toBeCloseTo(215.19, 9);
    expect(r.reportable).toBe('arithmetic');
  });
  test('SEC Regulation S-K Item 1202(a)(3) and PRMS 4.2.5.4: above the field level the arithmetic sums are the reportable figures', () => {
    expect(run('agg-ekene-reserves-above-field').reportable).toBe('arithmetic');
    expect(run('agg-ekene-reserves').reportable).toBe('arithmetic-or-statistical');
    expect(run('agg-ekene-reserves-above-field').reasons[5]).toMatch(/17 CFR 229\.1202\(a\)\(3\)/);
  });
  test('PRMS 4.2.5.2: statistical low above the arithmetic low and statistical high below the arithmetic high whenever projects are not totally dependent; the mean has no portfolio effect', () => {
    // all but the no-spread NUPRC total and the correlation 0.999 case, where the effect is below the sampling noise (the dependent limit)
    ok('aggregate').filter((c) => !['agg-nuprc-2026-gas-2p', 'agg-ag2011-table62-dependent'].includes(c.id)).forEach((c) => {
      const r = run(c.id);
      expect([c.id, r.portfolioEffect.low > 0, r.portfolioEffect.high > 0]).toEqual([c.id, true, true]);
    });
    const strong = run('agg-ekene-reserves-strong');
    const indep = run('agg-ekene-reserves-independent');
    expect(strong.portfolioEffect.low).toBeLessThan(indep.portfolioEffect.low);
  });
});

describe('fixtures: synthetic and wired to the engine', () => {
  test('the file says it is synthetic, names its generator, labels every project synthetic, and carries no em or en dash', () => {
    expect(FX.synthetic).toMatch(/^SYNTHETIC teaching data for the Ekene field/);
    expect(FX.generatedBy).toBe('tools/validation/economics/make_prms_fixtures.py');
    FX.projects.forEach((p) => expect(p.args.name).toMatch(/\(synthetic\)$/));
    FX.aggregation.reserves.projects.concat(FX.aggregation.contingent.projects).forEach((p) => expect(p.name).toMatch(/\(synthetic\)$/));
    ['ekene-prms.json', 'README.md'].forEach((f) => {
      const s = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'economics', 'ekene-prms', f), 'utf8');
      expect(/[–—]/.test(s)).toBe(false);
    });
  });
  test('the fixture goldens are built from the fixture file', () => {
    FX.projects.forEach((p) => expect(byId(`class-${p.id.toLowerCase()}`).args).toEqual(p.args));
    expect(byId('econ-ekene').args).toEqual(FX.economicLimit);
    expect(byId('agg-ekene-reserves').args).toEqual(FX.aggregation.reserves);
    expect(byId('agg-ekene-contingent').args).toEqual(FX.aggregation.contingent);
    expect(byId('rec-ekene').args).toEqual(FX.reconciliation);
  });
  test('EKN-1 in the field aggregation is its own economic-limit gross oil (MMbbl, 0.01)', () => {
    const e = run('econ-ekene');
    const est = FX.aggregation.reserves.projects.find((p) => p.id === 'EKN-1').estimates;
    expect([est.low, est.best, est.high]).toEqual(['low', 'best', 'high'].map((k) => Number((e.cases[k].economicGross.oil / 1e6).toFixed(2))));
  });
  test('the planted situations hold (the fixture README describes these)', () => {
    const cls = Object.fromEntries(FX.projects.map((p) => [p.id, run(`class-${p.id.toLowerCase()}`)]));
    expect(Object.values(cls).map((c) => [c.class, c.subClass])).toEqual([
      ['Reserves', 'on-production'], ['Reserves', 'approved-for-development'], ['Contingent Resources', 'development-on-hold'],
      ['Contingent Resources', 'development-pending'], ['Contingent Resources', 'development-unclarified'], ['Prospective Resources', 'prospect'],
      ['Prospective Resources', 'lead'], ['Discovered Unrecoverable', null],
    ]);
    expect(cls['EKN-6'].chanceOfCommercialityPct).toBe(20);
    expect(cls['EKN-7'].chanceOfCommercialityPct).toBeCloseTo(10.5, 12);
    expect(cls['EKN-3'].unmet).toEqual(['financialAppropriations', 'timeFrame', 'economicStatus', 'market', 'facilities', 'firmIntention']);
    expect(cls['EKN-5'].unmet[0]).toBe('technology under development');
    const e = run('econ-ekene');
    expect(['low', 'best', 'high'].map((k) => e.cases[k].economicLimitYear)).toEqual([2033, 2037, 2040]);
    expect(e.cases.high.licenceCutYear).toBe(2040);
    expect(e.cases.high.beyondLicence.oil).toBeGreaterThan(0);
    expect(e.cases.high.beyondEconomicLimit.oil).toBe(0);
    expect(e.cases.low.beyondEconomicLimit.oil).toBeGreaterThan(0);
    expect(e.reserves.provedZero).toBe(false);
    const q = run('rec-ekene');
    expect(q.closes).toBe(true);
    expect(q.byType.transfers.best).toBe(5.1);
  });
});

describe('the canonical engines are called, never re-implemented', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'economics', 'prms.js'), 'utf8');
  test('imports: cashflow.ts (computeCashFlow, applyJV), lib/stats (the Monte Carlo), lib/conventions/percentile.js; no own random draw, NPV or discounting', () => {
    expect(src).toMatch(/import \{ computeCashFlow, applyJV \} from '\.\/cashflow\.ts';/);
    expect(src).toMatch(/mulberry32, createCorrelatedSampler, cholesky, fitTriangularToPercentiles, triInvCDF, normalCDF, quantile, mean as statsMean,\n\} from '\.\.\/\.\.\/lib\/stats\/stats\.js';/);
    expect(src).toMatch(/import \{ OUTCOME_LABELS, EXCEEDANCE_DEFINITION, outcomeOrderViolation \} from '\.\.\/\.\.\/lib\/conventions\/percentile\.js';/);
    expect(src).not.toMatch(/Math\.random|Math\.pow|[\w)\]] ?\*\* ?[\w(]|randomNormal/);
  });
  test('the economic limit year and the cash figures are those of computeCashFlow on the same stated case', () => {
    const a = FX.economicLimit;
    const rows = a.forecasts.best.filter((r) => r.year <= a.licence.expiryYear);
    const r = computeCashFlow({
      cfg: {
        fiscal_regime: 'JV', base_year: a.effectiveYear, valuation_year: a.effectiveYear, present_value_basis: 'nominal', discount_rate_pct: a.discountRatePct,
        inflation_rate_pct: 0, oil_price_escalator_pct: 0, gas_price_escalator_pct: 0, condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
        oil_price_usd_bbl: 65, gas_price_usd_mscf: 2.5, condensate_price_usd_bbl: 0, price_deck: a.prices, jv_working_interest_pct: 100, jv_royalty_pct: 15,
        jv_tax_rate_pct: 30, jv_psc_depr_years: 5, apply_loss_carryforward: true, apply_economic_limit: true, abandonment_cost_usd: 40000000,
      },
      prodRows: rows.map((x) => ({ year: x.year, oil_bbl: x.oil, gas_mscf: x.gas })),
      capexRows: [{ year: 2027, amount_usd: 15000000 }],
      opexRows: a.costs.opex.filter((x) => x.year <= 2040).map((x) => ({ year: x.year, total_opex_usd: x.amount })),
    });
    const e = run('econ-ekene').cases.best;
    expect([e.economicLimitYear, e.undiscountedNetCashFlow, e.npv]).toEqual([r.kpis.economic_limit_year, r.kpis.total_net_cash_flow_nominal, r.kpis.npv]);
  });
  test('the outcome labels are the percentile convention (P90 = low)', () => {
    const c = run('cat-reserves-cumulative');
    expect(c.cumulative.map((x) => x.probability)).toEqual([OUTCOME_LABELS.p90, OUTCOME_LABELS.p50, OUTCOME_LABELS.p10]);
    expect(c.exceedance).toBe(EXCEEDANCE_DEFINITION);
  });
});

describe('properties', () => {
  test('categorize: the incremental and cumulative forms rebuild each other', () => {
    ok('categorize').filter((c) => c.expected.incremental).forEach((c) => {
      const r = run(c.id);
      const cum = r.cumulative.map((x) => x.value);
      const inc = r.incremental.map((x) => x.value);
      expect(inc[0]).toBeCloseTo(cum[0], 12);
      expect(inc[0] + inc[1]).toBeCloseTo(cum[1], 12);
      expect(inc[0] + inc[1] + inc[2]).toBeCloseTo(cum[2], 12);
    });
  });
  test('economicLimit: technical = within the licence + beyond it; within = kept + beyond the limit; 1P + P2 = 2P; 2P + P3 = 3P', () => {
    ok('economicLimit').forEach((c) => {
      const r = run(c.id);
      Object.values(r.cases).forEach((k) => {
        expect(k.technical.boe).toBeCloseTo(k.economicGross.boe + k.beyondEconomicLimit.boe + k.beyondLicence.boe, 6);
      });
      if (r.reserves) {
        expect(r.reserves.cumulative['1P'].boe + r.reserves.incremental.P2.boe).toBeCloseTo(r.reserves.cumulative['2P'].boe, 6);
        expect(r.reserves.cumulative['2P'].boe + r.reserves.incremental.P3.boe).toBeCloseTo(r.reserves.cumulative['3P'].boe, 6);
      }
    });
  });
  test('economicLimit: gross, working-interest and net-entitlement bases differ by the interest and the royalty interest; a production tax deducts no volume', () => {
    const g = run('econ-ekene-gross').reserves.cumulative['2P'].oil;
    expect(run('econ-ekene-working-interest').reserves.cumulative['2P'].oil).toBeCloseTo(g * 0.7, 6);
    expect(run('econ-ekene').reserves.cumulative['2P'].oil).toBeCloseTo(g * 0.7 * 0.85, 6);
    expect(run('econ-ekene-production-tax').reserves.cumulative['2P'].oil).toBeCloseTo(g * 0.7, 6);
    expect(run('econ-ekene-renewal-expected').cases.high.beyondLicence.oil).toBe(0);
  });
  test('reconcile: opening + every movement = computed closing, category by category; production comes out of every category alike', () => {
    ok('reconcile').forEach((c) => {
      const r = run(c.id);
      ['low', 'best', 'high'].forEach((k) => expect(r.movements.reduce((s, m) => s + m[k], r.opening[k])).toBeCloseTo(r.computedClosing[k], 9));
      r.movements.filter((m) => m.type === 'production').forEach((m) => expect(m.low === m.best && m.best === m.high).toBe(true));
    });
  });
  test('aggregate: the same seed gives the same draws; another seed moves only the Monte Carlo figures', () => {
    const a = byId('agg-ekene-reserves').args;
    expect(X.aggregate(clone(a))).toEqual(X.aggregate(clone(a)));
    const b = X.aggregate({ ...clone(a), seed: a.seed + 1 });
    const r = run('agg-ekene-reserves');
    expect([b.arithmetic, b.sumOfMeans]).toEqual([r.arithmetic, r.sumOfMeans]);
    expect(b.statistical.low).not.toBe(r.statistical.low);
  });
});

describe('boundaries (per rule)', () => {
  test('time-frame: 5 years meets the benchmark, 6 does not unless a longer time-frame is stated as justified', () => {
    expect(run('class-time-frame-5-met').class).toBe('Reserves');
    expect(run('class-time-frame-6-contingent').class).toBe('Contingent Resources');
    expect(run('class-time-frame-6-contingent').unmet).toEqual(['timeFrame']);
    expect(run('class-time-frame-8-justified').class).toBe('Reserves');
  });
  test('Nigeria: retention at 10 years is still inside s.78(9); 11 is past it; the FDP period at 2 years is inside s.79(1)', () => {
    expect(run('class-nigeria-retention-10').nigeria.notes[0]).not.toMatch(/has ended/);
    expect(run('class-nigeria-retention-11').nigeria.notes[0]).toMatch(/the retention period has ended/);
    expect(run('class-nigeria-fdp-2').nigeria.notes[0]).not.toMatch(/has passed/);
    expect(run('class-ekn-1').nigeria.notes[0]).toMatch(/the two-year period has passed/);
  });
  test('economic test: an undiscounted net cash flow of exactly 0 is not economic (PRMS 3.1.2.1: positive)', () => {
    const r = run('econ-exactly-zero-not-economic');
    expect(r.cases.best.undiscountedNetCashFlow).toBe(0);
    expect(r.cases.best.economic).toBe(false);
    expect(r.reserves).toBe(null);
    expect(run('econ-best-fails').status).toMatch(/^not commercial/);
  });
  test('economic limit: a tail year at exactly 0 net operating income is kept; one barrel less and it is cut', () => {
    expect(run('econ-tail-exactly-zero-kept').cases.best.economicLimitYear).toBe(2029);
    expect(run('econ-tail-one-below-cut').cases.best.economicLimitYear).toBe(2028);
    expect(run('econ-refuse-limit-disagrees').error).toMatch(/they give 2030 and 2027; got "a low forecast from 2027 to 2030"$/);
  });
  test('reconciliation: a difference equal to the tolerance closes; above it does not', () => {
    expect(run('rec-difference-exactly-tolerance').closes).toBe(true);
    expect(run('rec-difference-above-tolerance').closes).toBe(false);
    expect(run('rec-ekene-not-closing').reasons).toContain('the reconciliation does not close: 2P differs by 0.2 (tolerance 0.001)');
  });
  test('categories: equal estimates are a single value; Pg 0 gives Pc 0; a triangular fit with equal estimates is a constant', () => {
    expect(run('cat-single-value').singleValue).toBe(true);
    expect(run('class-pg-zero').chanceOfCommercialityPct).toBe(0);
    expect(run('agg-constant-project').projects[3].distribution).toEqual({ type: 'constant', value: 1.2 });
  });
});

describe('wording and keys', () => {
  test('unknown keys: every function refuses one at the top level', () => {
    expect(Object.keys(X.ACCEPTED_KEYS).sort()).toEqual(FNS);
    FNS.forEach((f) => {
      const r = X[f]({ notAKey: 1 });
      expect(r.field).toBe('notAKey');
      expect(r.error).toMatch(/^notAKey is not an accepted key; the accepted keys at the top level are /);
    });
    expect(X.classify([]).error).toBe('options must be an object of named inputs; got []');
  });
  test('one refusal wording: "<field> must <condition>; got <value>", or a key that is not accepted', () => {
    G.cases.filter((c) => c.expected.error === true).forEach((c) => {
      expect([c.id, /^[A-Za-z][\w.[\]]* (must (be|have) .+; got .+|is not an accepted key; .+)$/.test(c.expected.message)]).toEqual([c.id, true]);
      expect([c.id, (c.expected.message.match(/; got /g) || []).length]).toEqual([c.id, c.expected.message.includes('is not an accepted key') ? 0 : 1]);
    });
  });
  test('reason strings: counts agree with their units, no "X, not Y" wording, no em or en dash', () => {
    G.cases.forEach((c) => {
      const r = run(c.id);
      const t = JSON.stringify(r.error ? r : { reasons: r.reasons, basis: r.basis });
      expect(t).not.toMatch(/(^|[^0-9.])1 (years|rows|projects|pairs|iterations|entries|trailing years)\b/);
      expect(t).not.toMatch(/, not /);
      expect(/[–—]/.test(t)).toBe(false);
    });
  });
  test('course content: exact reason strings the lessons quote', () => {
    expect(run('class-ekn-3').reasons.slice(-4)).toEqual([
      'sub-class: development-on-hold (stated) (PRMS 2.1.3.5.6, Table 1)',
      'economic status: undetermined (PRMS 2.1.3.7)',
      'chance of commerciality: Pc = Pd = 50% (PRMS 2.1.3.3)',
      'Nigeria: significant gas discovery declared (PIA 2021 s.78(8)(b)): substantial and potentially commercial but not declarable as commercial (s.318); the licensee may retain the area for a period the Commission determines, at most 10 years from the declaration (s.78(9)), an approval being for at least 5 years onshore and in shallow water and 8 in deep water (Significant Crude Oil and Gas Discovery Regulations, 2023, reg. 6(3)); 3 years since the declaration',
    ]);
    expect(run('class-ekn-6').reasons[4]).toBe('chance of commerciality: Pc = Pg x Pd = 25% x 80% = 20% (PRMS 2.1.3.3)');
    expect(run('econ-faq33-low-fails').reasons).toContain('the low case is not economic: 1P = 0 and the 2P and 3P estimates stand (PRMS 3.1.2.8; FAQ 3.3); the low case quantities sit inside 2P, never in 1C (FAQ 3.4, no split classification)');
    expect(run('agg-ekene-reserves').reasons[3]).toMatch(/^the arithmetic sum of the low estimates is not the P90 of the total: it is the P90 only when every project is totally dependent \(PRMS 4\.2\.5\.2\)/);
    expect(run('cat-faq33-incremental').reasons[4]).toBe('incremental: Proved (P1) 5, Probable (P2) 2, Possible (P3) 3 MMbbl; 1P = P1, 2P = P1 + P2, 3P = P1 + P2 + P3');
    expect(run('cat-refuse-prospective-incremental').error).toBe('method must be "cumulative" for Prospective Resources (PRMS 2.2.2.4 defines no incremental terms for them); got "incremental"');
    expect(run('agg-refuse-rho-one').error).toBe('correlation.rho must be a number above -1 and below 1 (the canonical sampler takes a correlation strictly between -1 and 1); got 1');
  });
  test('money prints to the cent and computed quantities to 6 places in reasons; the fields keep full precision', () => {
    const r = run('econ-ekene');
    expect(r.reasons.join(' ')).not.toMatch(/\d\.\d{7,}/);
    expect(run('agg-ekene-reserves').reasons.join(' ')).not.toMatch(/\d\.\d{7,}/);
  });
});

describe('caps', () => {
  test('projects, years and iterations above the caps are refused with the cap in the message', () => {
    const p = { id: 'x', distribution: { type: 'lognormal', mean: 1, stdDev: 0.1 } };
    const many = Array.from({ length: X.DEFAULTS.MAX_PROJECTS + 1 }, (_, i) => ({ ...p, id: `p${i}` }));
    expect(X.aggregate({ ...clone(FX.aggregation.reserves), projects: many }).error).toBe(`projects must have at most ${X.DEFAULTS.MAX_PROJECTS} entries; got ${X.DEFAULTS.MAX_PROJECTS + 1}`);
    expect(run('agg-refuse-work').error).toBe('iterations must be at most 45454 for 11 projects (iterations x projects at most 500000); got 200000');
    const long = Array.from({ length: X.DEFAULTS.MAX_YEARS + 1 }, (_, i) => ({ year: 2027 + i, oil: 1, gas: 0 }));
    expect(X.economicLimit({ ...clone(FX.economicLimit), forecasts: { ...clone(FX.economicLimit.forecasts), low: long } }).field).toBe('forecasts.low');
  });
});
