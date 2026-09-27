// Economics EC10 farm-in, farm-out and asset valuation gates. Every case in
// test-data/economics/goldens/farmout_cases.json is run THROUGH THE ENGINE and
// compared with the value the independent stdlib oracle
// (tools/validation/economics/oracle_farmout.py) computed from the stated deal
// arithmetic by a different road (exact Fractions; a dollar ledger for the
// cost split; EMV straight from the payoffs with no tree; the break-even
// promote by exact bisection; the chance of a loss by enumerating every
// success/failure combination; the EC9 oracle as the witness for the
// jointVenture.js carry and back-in). The published figures (Penn State EME
// 801 Table 6.1, the AOI Regulations 2024 reg. 19 rates and days, PIA 2021
// s.95) are checked against their printed values too. Property tests compare
// engine outputs with each other, never with a restated formula;
// tools/validation/economics/negcontrol_farmout.sh proves the gates go red when
// the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as X from '../engines/economics/farmout';
import { carryRecovery, backIn } from '../engines/economics/jointVenture';
import { portfolioRiskMetrics } from '../engines/economics/portfolio';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'economics', 'goldens', 'farmout_cases.json');
const FX = read('test-data', 'economics', 'ekene-farmout', 'ekene-farmout.json');
const FLOOR = G.tolerance.absoluteFloor;
const MC_FIELDS = ['probLoss', 'p90', 'p10'];

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
  if (!c) throw new Error(`golden case ${id} is missing from farmout_cases.json`);
  return c;
};
const memo = new Map();
const run = (id) => { if (!memo.has(id)) { const c = byId(id); memo.set(id, X[c.fn](clone(c.args))); } return memo.get(id); };
const FNS = ['backInRight', 'consentFee', 'dealValue', 'developmentCarry', 'earningObligation', 'informationValue', 'interestValue', 'riskSharing'];
const deterministic = (fn, r) => (fn !== 'riskSharing' ? r : { ...r, reasons: undefined, positions: r.positions.map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !MC_FIELDS.includes(k)))) });
const strip = (o) => JSON.parse(JSON.stringify(o));

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('farmout');
    expect(G.generatedBy).toBe('tools/validation/economics/oracle_farmout.py');
    expect(G.cases.length).toBeGreaterThanOrEqual(120);
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
    const exp = c.fn === 'riskSharing' ? strip(deterministic(c.fn, { ...e, reasons: [] })) : e;
    expect(diff(strip(deterministic(c.fn, r)), exp, c.tol, c.fn)).toEqual([]);
  });

  test('riskSharing: the seeded Monte Carlo agrees with the exact chance of a loss and the exact quantiles', () => {
    G.cases.filter((c) => c.fn === 'riskSharing' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      c.mc.forEach((m, i) => {
        const p = r.positions[i];
        expect(p.name).toBe(m.name);
        expect(p.p90).toBeLessThanOrEqual(p.p10);
        if (m.probLoss !== null) expect(Math.abs(p.probLoss - m.probLoss)).toBeLessThanOrEqual(m.band);
        Object.entries(m.quantiles).forEach(([k, q]) => { if (q.safe) expect(Math.abs(p[k] - q.value)).toBeLessThanOrEqual(1e-6); });
      });
    });
  });
});

describe('published figures: the engine against the printed values', () => {
  test('Penn State EME 801 Table 6.1: drill yourself -250,000 / 500,000, EMV 12,500; farm out 0 / 50,000, EMV 17,500; farm out is chosen', () => {
    const r = run('deal-psu-eme801');
    expect([r.farmor.alone.dry, r.farmor.alone.success]).toEqual([-250000, 500000]);
    expect(r.farmor.alone.emv).toBeCloseTo(12500, 6);
    expect(r.farmor.farmOut.dry).toBe(0);
    expect(r.farmor.farmOut.success).toBeCloseTo(50000, 6);
    expect(r.farmor.farmOut.emv).toBeCloseTo(17500, 6);
    expect(r.farmor.bestAction).toBe('farm out');
    // the driller's side, which the text leaves out: the deal moves value, it creates none
    expect(r.farmineeSide.farmIn.emv).toBeCloseTo(-5000, 6);
    expect(Math.abs(r.transfer.difference)).toBeLessThan(1e-6);
  });
  test('Penn State EME 801 value at risk: drilling loses 250,000 with a 65% chance; farming out loses nothing', () => {
    const r = run('risk-psu');
    expect(Math.abs(r.positions[0].probLoss - 0.65)).toBeLessThan(0.01);
    expect(r.positions[0].p90).toBe(-250000);
    expect(r.positions[1].probLoss).toBe(0);
  });
  test('AOI Regulations 2024 reg. 19(2): 7% (2% processing, 5% premium), 2% intra group; reg. 19(7) to (9): 90 days, 30 more, 0.01% a day for 90 days', () => {
    expect(X.NIGERIA_ASSIGNMENT).toEqual({ processingFeePct: 2, premiumPct: 5, intraGroupProcessingFeePct: 2, payWithinDays: 90, graceDays: 30, surchargePctPerDay: 0.01, surchargeDays: 90, changeOfControlAbovePct: 50 });
    const f = run('fee-ekene');
    expect([f.processingFee, f.premium, f.fee, f.taxDeductible, f.payer]).toEqual([112000, 280000, 392000, false, 'assignor']);
    expect(run('fee-intra-group').fee).toBe(112000);
    expect(run('fee-refuse-pel-r19').field).toBe('licence');
    expect(run('fee-ekene').basis.tax).toBe('not tax deductible (reg. 19(5); PIA s.95(12)); fees paid for assigning rights to another party are not deductible (PIA s.264(f) and s.302(12)(c))');
  });
});

describe('fixtures: synthetic and wired to the engine', () => {
  test('the file says it is synthetic, names its generator and its parties as synthetic, and carries no em or en dash', () => {
    expect(FX.synthetic).toMatch(/^SYNTHETIC teaching data for the Ekene field/);
    expect(FX.generatedBy).toBe('tools/validation/economics/make_farmout_fixtures.py');
    FX.parties.forEach((p) => expect(p.name).toMatch(/\(synthetic\)$/));
    expect(FX.farminee.name).toMatch(/\(synthetic\)$/);
    ['ekene-farmout.json', 'README.md'].forEach((f) => {
      const s = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'economics', 'ekene-farmout', f), 'utf8');
      expect(/[–—]/.test(s)).toBe(false);
    });
  });
  test('the fixture goldens are built from the fixture file', () => {
    expect(byId('deal-ekene').args.project).toEqual(FX.project);
    expect(byId('deal-ekene').args.deal).toEqual(FX.deal);
    expect(byId('earn-ekene-drill-to-earn').args.events).toEqual(FX.earning.drillToEarn.events);
    expect(byId('fee-ekene').args).toEqual(FX.consent);
    expect(byId('devcarry-ekene').args.years).toEqual(FX.developmentCarry.years);
    expect(byId('info-ekene-farminee').args.information).toEqual(FX.information);
    // the assignor fees of the deal are the consent fee of the fixture
    expect(FX.deal.assignorFees).toBe(run('fee-ekene').fee);
    // the risk positions are the engine's own deal payoffs
    const d = run('deal-ekene');
    const h = byId('risk-ekene').args.positions;
    expect(h[0].holdings[0].successValue).toBeCloseTo(d.farmor.alone.success, 6);
    expect(h[0].holdings[0].failCost).toBeCloseTo(-d.farmor.alone.dry, 6);
    const cash = d.terms.cashBonus + d.terms.pastCostReimbursement - d.terms.assignorFees;
    expect(h[1].holdings[1].successValue).toBeCloseTo(cash, 6);
    expect(h[1].holdings[0].successValue + cash).toBeCloseTo(d.farmor.farmOut.success, 6);
    expect(h[1].holdings[0].failCost).toBeCloseTo(d.wellCostSplit.dry.farmorPays, 6);
  });
  test('the planted situations hold (the fixture README describes these)', () => {
    const d = run('deal-ekene');
    expect(d.farmor.bestAction).toBe('farm out');
    expect(d.farmineeSide.bestAction).toBe('decline');
    expect(d.breakEvenPromote.status).toBe('solved');
    expect(d.breakEvenPromote.farmineePaysPct).toBeGreaterThan(35);
    expect(d.breakEvenPromote.farmineePaysPct).toBeLessThan(36);
    expect(d.wellCostSplit.success.capState).toBe('exceeded');
    expect(d.wellCostSplit.dry.capState).toBe('below');
    const e = run('earn-ekene-drill-to-earn');
    expect(e.events[1].capState).toBe('exactly');
    expect([e.vestedPct, e.interestsAfter.find((p) => p.id === 'FIN').participatingPct]).toEqual([0, 0]);
    expect(run('earn-ekene-drill-to-earn-done').vestedPct).toBe(35);
    expect(run('earn-ekene-drill-to-earn-per-event').vestedPct).toBe(20);
    expect(run('fee-ekene').payment.status).toBe('on-time');
    const i = run('info-ekene-farminee');
    expect(i.perSignal.map((s) => s.bestAction)).toEqual(['farm in', 'decline']);
    expect(i.netEvii).toBeGreaterThan(0);
    expect(run('info-ekene-too-dear').netEvii).toBeLessThan(0);
    const r = run('risk-ekene').positions;
    expect(r[1].stdDev).toBeLessThan(r[0].stdDev);
    expect(r[1].p90).toBeGreaterThan(r[0].p90);
    expect(run('devcarry-ekene').recoveredInYear).toBe(2036);
    expect(run('interest-ekene-risked').transaction.priceToValue).toBeGreaterThan(1);
  });
});

describe('the canonical engines are called, never re-implemented', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'economics', 'farmout.js'), 'utf8');
  test('imports: cashflow.ts (applyJV, npv), decisionTree.js (rollback, evpi, evii), portfolio.js, afe.js, jointVenture.js; no own NPV, discounting or random draw', () => {
    expect(src).toMatch(/import \{ applyJV, npv \} from '\.\/cashflow\.ts';/);
    expect(src).toMatch(/import \{ rollback, evpi, evii \} from '\.\/decisionTree\.js';/);
    expect(src).toMatch(/import \{ portfolioRiskMetrics \} from '\.\/portfolio\.js';/);
    expect(src).toMatch(/import \{ calculatePartnerCosts \} from '\.\/afe\.js';/);
    expect(src).toMatch(/import \{ carryRecovery as jvCarryRecovery, backIn as jvBackIn \} from '\.\/jointVenture\.js';/);
    expect(src).not.toMatch(/Math\.random|Math\.pow|[\w)\]] ?\*\* ?[\w(]/);
  });
  test('developmentCarry is carryRecovery of jointVenture.js on the post-deal interests; backInRight is its backIn', () => {
    const c = byId('devcarry-ekene').args;
    const r = run('devcarry-ekene');
    const j = carryRecovery({ parties: r.interestsAfter, carries: [{ carried: 'EKO', carriedPct: c.carriedPct, carriers: { FIN: 100 } }], carried: 'EKO', years: c.years, uplift: c.uplift, recoverFromPct: c.recoverFromPct, basis: 'contract', discountRate: c.discountRate, baseYear: c.baseYear });
    expect(r.ledger).toEqual(j.ledger);
    expect(r.npv).toEqual(j.npv);
    const b = run('backin-ekene');
    const { party, ...rest } = byId('backin-ekene').args.backIn;
    expect(b.parties).toEqual(backIn({ parties: b.interestsAfterFarmIn, backInParty: party, ...rest }).parties);
  });
  test('riskSharing is portfolioRiskMetrics of portfolio.js, seed and iterations as stated', () => {
    const a = byId('risk-spread-four').args;
    const r = run('risk-spread-four');
    a.positions.forEach((ps, i) => {
      const m = portfolioRiskMetrics(ps.holdings.map((h) => ({ name: h.id, pos: h.chanceOfSuccessPct / 100, npv_p50: h.successValue, fail_cost: h.failCost, npv_stddev: h.successStdDev })), a.correlation, { seed: a.seed, iterations: a.iterations });
      expect([r.positions[i].emv, r.positions[i].probLoss, r.positions[i].p90, r.positions[i].p10]).toEqual([m.emv, m.probLoss, m.p90, m.p10]);
    });
  });
});

describe('properties', () => {
  test('earning: the parties pay the whole gross cost; the carry is what the farminee pays above its held share; interests sum to 100', () => {
    G.cases.filter((c) => c.fn === 'earningObligation' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      r.events.forEach((e) => {
        expect(e.farmineePays + e.farmorPays + e.others.reduce((s, o) => s + o.pays, 0)).toBeCloseTo(e.grossCost, 4);
        expect(e.carry).toBeCloseTo(e.farmineePays - (e.heldAfterPct * e.grossCost) / 100, 4);
      });
      expect(r.interestsAfter.reduce((s, p) => s + p.participatingPct, 0)).toBeCloseTo(100, 9);
    });
  });
  test('deal: farmor alone = farmor after + farminee + assignor fees; the farminee\'s EMV is 0 at the break-even promote and at the break-even chance', () => {
    G.cases.filter((c) => c.fn === 'dealValue' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      expect(Math.abs(r.transfer.difference)).toBeLessThan(1e-4);
      if (r.breakEvenPromote.status === 'solved') {
        const again = X.dealValue({ ...clone(c.args), deal: { ...clone(c.args.deal), farmineePaysPct: r.breakEvenPromote.farmineePaysPct } });
        expect(Math.abs(again.farmineeSide.farmIn.emv)).toBeLessThan(1e-4);
      }
      if (r.breakEvenChance.farminee.status === 'solved') {
        const again = X.dealValue({ ...clone(c.args), project: { ...clone(c.args.project), chanceOfSuccessPct: r.breakEvenChance.farminee.chanceOfSuccessPct } });
        expect(Math.abs(again.farmineeSide.farmIn.emv)).toBeLessThan(1e-4);
      }
    });
  });
  test('information: 0 <= EVII <= EVPI; the signal chances sum to 1', () => {
    G.cases.filter((c) => c.fn === 'informationValue' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      expect(r.evii).toBeGreaterThanOrEqual(-1e-6);
      expect(r.evii).toBeLessThanOrEqual(r.evpi + 1e-6);
      expect(r.perSignal.reduce((s, x) => s + x.probability, 0)).toBeCloseTo(1, 12);
    });
    expect(Math.abs(run('info-uninformative').evii)).toBeLessThan(1e-6);
  });
  test('risk: the same seed gives the same draws; another seed moves only the Monte Carlo figures', () => {
    const a = byId('risk-ekene').args;
    expect(X.riskSharing(clone(a))).toEqual(X.riskSharing(clone(a)));
    const b = X.riskSharing({ ...clone(a), seed: a.seed + 1 });
    expect(b.positions.map((p) => p.emv)).toEqual(run('risk-ekene').positions.map((p) => p.emv));
  });
  test('interest: the value of the interest is the interest times the 100% figure on the stated basis', () => {
    const r = run('interest-ekene-risked');
    expect(r.interestValue).toBeCloseTo((r.position100.emv * 30) / 100, 4);
    expect(run('interest-ekene-success-case').interestValue).toBeCloseTo((r.position100.success * 30) / 100, 4);
  });
});

describe('boundaries (per rule)', () => {
  test('promote exactly at break-even: the farminee\'s EMV is 0 and the tie with declining is reported; a half point more and it declines', () => {
    const r = run('deal-promote-exactly-break-even');
    expect(r.farmineeSide.farmIn.emv).toBe(0);
    expect([r.farmineeSide.bestAction, r.farmineeSide.tiedActions]).toEqual(['farm in', ['farm in', 'decline']]);
    expect(r.breakEvenPromote.farmineePaysPct).toBe(50);
    expect(r.reasons[4]).toBe('F: the best action is a tie between drill alone, farm out; N: a tie between farm in, decline');
    expect(run('deal-promote-just-above-break-even').farmineeSide.bestAction).toBe('decline');
    expect(run('deal-negative-without-promote').breakEvenPromote.status).toBe('negative-without-promote');
    expect(run('deal-positive-at-farmor-share').breakEvenPromote.status).toBe('positive-at-farmor-share');
    expect(run('deal-break-even-at-farmor-share').breakEvenPromote).toMatchObject({ status: 'solved', farmineePaysPct: 100 });
    expect(run('deal-carry-cap-flat-positive').breakEvenPromote.status).toBe('positive-at-farmor-share');
  });
  test('carry cap hit exactly: capState "exactly" for both cap forms, and the whole promote is paid', () => {
    const g = run('earn-cap-gross-exactly').events[0];
    expect([g.capState, g.excess, g.carry]).toEqual(['exactly', 0, 4000000]);
    const c = run('earn-cap-carry-exactly').events[0];
    expect([c.capState, c.carry]).toEqual(['exactly', 4000000]);
    expect(run('earn-cap-carry-exceeded').events[0].carry).toBe(2500000);
    expect(run('earn-cap-carry-zero').events[0].farmineePays).toBe(12000000);
  });
  test('dry hole (chance 0): every EMV is its dry-hole position; certain success: its success position', () => {
    const d = run('deal-ekene-dry-hole');
    expect([d.farmor.alone.emv, d.farmineeSide.farmIn.emv]).toEqual([d.farmor.alone.dry, d.farmineeSide.farmIn.dry]);
    expect(d.farmor.bestAction).toBe('walk away');
    expect(d.farmineeSide.bestAction).toBe('decline');
    const s = run('deal-ekene-certain');
    expect(s.farmineeSide.farmIn.emv).toBe(s.farmineeSide.farmIn.success);
  });
  test('cash bonus zero: stated and said', () => {
    expect(run('deal-ekene-bonus-zero').reasons).toContain('cash bonus: none (stated as 0)');
    expect(run('deal-ekene-bonus-zero').consideration.cashBonus).toBe(0);
    expect(run('earn-ekene-drill-to-earn').reasons).toContain('cash bonus: none (stated as 0)');
  });
  test('the consent fee days: 90 on time, 91 and 120 in the grace, 121 the first surcharge day, 210 the last, 211 withdrawn', () => {
    expect(['fee-day-90', 'fee-day-91', 'fee-day-120', 'fee-day-121', 'fee-day-210', 'fee-day-211'].map((id) => [run(id).payment.days, run(id).payment.status, run(id).payment.surchargeDays]))
      .toEqual([[90, 'on-time', 0], [91, 'within-grace', 0], [120, 'within-grace', 0], [121, 'surcharge', 1], [210, 'surcharge', 90], [211, 'consent-deemed-withdrawn', 0]]);
    expect(run('fee-day-121').payment.surcharge).toBeCloseTo(39.2, 9);
    expect(run('fee-day-210').payment.surcharge).toBeCloseTo(3528, 9);
    expect(run('fee-day-211').payment.totalPaid).toBe(null);
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
    expect(X.dealValue([]).error).toBe('options must be an object of named inputs; got []');
  });
  test('one refusal wording: "<field> must <condition>; got <value>", or a key that is not accepted', () => {
    G.cases.filter((c) => c.expected.error === true).forEach((c) => {
      expect(c.expected.message).toMatch(/^[A-Za-z][\w.[\]]* (must (be|sum|have) .+; got .+|is not an accepted key; .+)$/);
    });
  });
  test('reason strings: counts agree with their units, no "X, not Y" wording, no em or en dash, no P-label', () => {
    G.cases.forEach((c) => {
      const r = run(c.id);
      const t = JSON.stringify(r.error ? r : { reasons: r.reasons, basis: r.basis });
      expect(t).not.toMatch(/(^|[^0-9.])1 (years|months|days|events|draws|entries)\b/);
      expect(t).not.toMatch(/, not /);
      expect(/[–—]/.test(t)).toBe(false);
      expect(t).not.toMatch(/\bP(10|50|90)\b/);
    });
  });
  test('course content: exact reason strings the lessons quote', () => {
    expect(run('deal-ekene').reasons.slice(1, 6)).toEqual([
      'EKO alone (70%): success 157675235.93, dry hole -28000000, EMV 18418808.98',
      'EKO after the farm-out (40%, paying 14000000 of the success well and 12000000 of the dry hole): success 99708134.82, dry hole -6792000, EMV 19833033.7',
      'FIN (30% for 40% of the well): success 57575101.11, dry hole -21600000, EMV -1806224.72',
      'EKO: the best action is farm out; FIN: decline',
      "break-even promote: FIN's EMV is 0 when it pays 35.594574% of the well for 30% (a promote of 5.594574 points)",
    ]);
    expect(run('earn-ekene-drill-to-earn').reasons[1]).toBe('Ekene Deep-2 appraisal well: gross cost 30000000; FIN pays 45% to earn 15% (35% held after it): a promote of 10 points, ratio 45 / 35; the carry reaches the cap 3000000 exactly; FIN pays 13500000 (45% of the gross cost), EKO pays 7500000, a carry of 3000000 (not completed: the obligation only)');
    expect(run('earn-ekene-drill-to-earn').reasons[2]).toBe('vesting "all-events": 1 of 2 events completed; nothing vests');
    expect(run('fee-ekene').reasons[0]).toBe('PPL: 2% processing + 5% premium on the value of the transaction 5600000 (the amount payable to the Assignor stated in the contract, reg. 19(3)) = 392000; paid by the Assignor and not tax deductible');
    expect(run('fee-day-121').reasons[1]).toBe('paid 121 days after the notification: 1 day after the 90 + 30 days; surcharge 0.01% of 392000 x 1 day = 39.2 (reg. 19(9), straight line)');
    expect(run('info-ekene-farminee').reasons[1]).toBe('signal "bright amplitude" (probability 0.375): chance of success 50%, best action farm in, EMV 17987550.56');
  });
  test('money prints to the cent and computed figures to 6 places in reasons; the fields keep full precision', () => {
    const r = run('deal-ekene');
    expect(r.breakEvenPromote.farmineePaysPct).not.toBe(Number(r.breakEvenPromote.farmineePaysPct.toFixed(6)));
    expect(r.reasons.join(' ')).not.toMatch(/\d\.\d{7,}/);
  });
});

describe('caps', () => {
  test('parties, events and iterations above the caps are refused with the cap in the message', () => {
    const parties = Array.from({ length: X.DEFAULTS.MAX_PARTIES + 1 }, (_, i) => ({ id: `P${i}`, participatingPct: 100 / (X.DEFAULTS.MAX_PARTIES + 1) }));
    expect(X.earningObligation({ parties, farmor: 'P0', farminee: { id: 'N' } }).error).toBe(`parties must have at most ${X.DEFAULTS.MAX_PARTIES} entries; got ${X.DEFAULTS.MAX_PARTIES + 1}`);
    const events = Array.from({ length: X.DEFAULTS.MAX_EVENTS + 1 }, (_, i) => ({ name: `e${i}`, grossCost: 1, farmineePaysPct: 1, earnedPct: 1, cap: { on: 'none' } }));
    expect(X.earningObligation({ parties: FX.parties, farmor: 'EKO', farminee: FX.farminee, events }).error).toBe(`events must have at most ${X.DEFAULTS.MAX_EVENTS} entries; got ${X.DEFAULTS.MAX_EVENTS + 1}`);
    expect(run('risk-refuse-work').error).toBe('iterations must be at most 166666 for 3 holdings in all (iterations x holdings at most 500000); got 200000');
    expect(run('risk-refuse-iterations').error).toBe(`iterations must be an integer from 1 to ${X.DEFAULTS.MAX_ITERATIONS} (stated; no default); got ${X.DEFAULTS.MAX_ITERATIONS + 1}`);
  });
});
