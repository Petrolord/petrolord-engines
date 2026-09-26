// Economics EC9 joint venture gates. Every case in
// test-data/economics/goldens/jointventure_cases.json is run THROUGH THE ENGINE
// and compared with the value the independent stdlib oracle
// (tools/validation/economics/oracle_jointventure.py) computed from the stated
// clause arithmetic by a different road (exact Fractions; cash calls on a
// cumulative ledger; overhead by the band that holds the base; payout years on
// cumulative availability; the PSC order straight from the World Bank and IMF
// texts with the gross limit applied to gross). The published figures (World
// Bank Briefing Note 8, IMF FARI Figure 5 and Tables 12 and 13, the Norwegian
// Accounting Agreement scale and 0.65 %, the Norwegian JOA 1000 % entry and
// budget tolerances, PIA 2021 s.85(4)) are checked against their printed
// values too. Property tests compare engine outputs with each other, never
// with a restated formula; tools/validation/economics/negcontrol_jointventure.sh
// proves the gates go red when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as J from '../engines/economics/jointVenture';
import { applyPSC, npv } from '../engines/economics/cashflow';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'economics', 'goldens', 'jointventure_cases.json');
const FX = read('test-data', 'economics', 'ekene-jv', 'ekene-jv.json');
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
  if (!c) throw new Error(`golden case ${id} is missing from jointventure_cases.json`);
  return c;
};
const memo = new Map();
const run = (id) => { if (!memo.has(id)) { const c = byId(id); memo.set(id, J[c.fn](clone(c.args))); } return memo.get(id); };
const FNS = ['backIn', 'budgetControl', 'carryRecovery', 'cashCalls', 'defaultCover', 'nonConsent', 'overhead', 'participatingInterests', 'pscCostRecovery'];

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('jointVenture');
    expect(G.generatedBy).toBe('tools/validation/economics/oracle_jointventure.py');
    expect(G.cases.length).toBeGreaterThanOrEqual(140);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by a golden, and refused at least once', () => {
    const fns = Object.keys(J).filter((k) => typeof J[k] === 'function').sort();
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
    expect(diff(r, e, c.tol, c.fn)).toEqual([]);
  });
});

describe('published figures: the engine against the printed values', () => {
  test('World Bank Briefing Note 8 (2007): royalty first, cost oil 25 under a limit of 60% of gross, profit oil 65 split 26 / 39, tax 7.8; contractor 43, government 57', () => {
    const y = run('psc-wb-bn8-2007').years[0];
    expect([y.royalty, y.costOilLimit, y.costRecovered, y.profitOil, y.contractorProfitOil, y.governmentProfitOil]).toEqual([10, 60, 25, 65, 26, 39]);
    expect(y.tax).toBeCloseTo(7.8, 12);
    expect(y.contractorEntitlement).toBeCloseTo(43.2, 12);
    expect(y.governmentTake).toBeCloseTo(56.8, 12);
    expect([Math.round(y.contractorEntitlement), Math.round(y.governmentTake)]).toEqual([43, 57]);
    // the taxable income printed as 100 - 10 - 25 - 39 = 26 is the contractor's profit oil here (cost oil = costs)
    expect(100 - 10 - 25 - 39).toBe(y.contractorProfitOil);
  });
  test('IMF FARI (TNM/16/01) Figure 5: one USD100 barrel, cost oil 50, profit oil 30 / 20, income tax 6, government 36', () => {
    const y = run('psc-fari-figure-5').years[0];
    expect([y.costRecovered, y.governmentProfitOil, y.contractorProfitOil, y.tax, y.governmentTake, y.contractorEntitlement]).toEqual([50, 30, 20, 6, 36, 64]);
  });
  test('IMF FARI Table 12 (cost petroleum) and Table 13 (DROP sharing): every printed figure within its printed precision', () => {
    const f = run('psc-fari-table-12');
    const printed = {
      ceiling: [0, 0, 170, 434, 1327, 1083, 884, 721, 589, 480, 392],
      costPetroleum: [0, 0, 170, 434, 1264, 840, 778, 552, 451, 368, 303],
      closing: [250, 250, 299, 264, 0, 0, 0, 0, 0, 0, 0],
      profit: [0, 0, 43, 108, 395, 514, 326, 349, 285, 232, 187],
      jvProfit: [0, 0, 26, 61, 166, 238, 160, 181, 156, 130, 108],
      govProfit: [0, 0, 17, 48, 229, 276, 166, 169, 129, 102, 79],
      costToContractor: [0, 0, 153, 390, 1138, 756, 701, 497, 406, 332, 273],
      costToSoc: [0, 0, 17, 43, 126, 84, 78, 55, 45, 37, 30],
    };
    // Inputs are the printed whole numbers of an unrounded model: each cost line
    // is a sum of at most three rounded figures (at most 1.5 away); the profit
    // split also carries the printed whole-number government share (0.5% of the
    // profit petroleum).
    f.years.forEach((y, i) => {
      expect(Math.abs(y.costOilLimit - printed.ceiling[i])).toBeLessThanOrEqual(1.5);
      expect(Math.abs(y.costRecovered - printed.costPetroleum[i])).toBeLessThanOrEqual(1.5);
      expect(Math.abs(y.poolOut - printed.closing[i])).toBeLessThanOrEqual(1.5);
      expect(Math.abs(y.profitOil - printed.profit[i])).toBeLessThanOrEqual(1.5);
      const band = 1.5 + 0.005 * y.profitOil;
      expect(Math.abs(y.contractorProfitOil - printed.jvProfit[i])).toBeLessThanOrEqual(band);
      expect(Math.abs(y.governmentProfitOil - printed.govProfit[i])).toBeLessThanOrEqual(band);
      expect(Math.abs(0.9 * y.costRecovered - printed.costToContractor[i])).toBeLessThanOrEqual(1.5);
      expect(Math.abs(0.1 * y.costRecovered - printed.costToSoc[i])).toBeLessThanOrEqual(1.5);
      expect(f.parties[i].parties[1].entitlement).toBeCloseTo(0.1 * y.contractorEntitlement, 9);
    });
    expect(Math.abs(f.totals.costRecovered - 5162)).toBeLessThanOrEqual(3);
    expect(Math.abs(f.totals.profitOil - 2439)).toBeLessThanOrEqual(3);
    expect(Math.abs(f.totals.governmentProfitOil - 1215)).toBeLessThanOrEqual(6);
  });
  test('the PSC path is the canonical applyPSC of cashflow.ts, year by year with the pool threaded', () => {
    ['psc-ekene', 'psc-ekene-after-royalty', 'psc-fari-table-12', 'psc-wb-bn8-2007'].forEach((id) => {
      const a = byId(id).args;
      const r = run(id);
      let pool = a.openingCostPool;
      a.years.forEach((y, i) => {
        const frac = a.costOilLimitBase === 'gross' ? a.costOilLimitPct / (100 - a.royaltyPct) : a.costOilLimitPct / 100;
        const o = applyPSC({ gross_revenue: y.grossRevenue, capex: y.capex, opex: y.opex, depreciation: 0, cumulative_unrecovered_cost: pool }, a.royaltyPct / 100, frac, (y.contractorProfitSharePct ?? a.contractorProfitSharePct) / 100, a.taxRatePct / 100, 0);
        expect(r.years[i].poolOut).toBe(o.cumulative_unrecovered_cost_after);
        expect(r.years[i].tax).toBe(o.tax);
        expect(r.years[i].contractorNet).toBe(o.net_cash_flow);
        pool = o.cumulative_unrecovered_cost_after;
      });
    });
  });
  test('Norway Accounting Agreement Art. 2.2.2 and 2.2.3: the printed scale gives 35, 40, 42.5 and 6.25; 0.65 % of 3,400 is 22.1', () => {
    expect(run('overhead-norway-operating-1800').total).toBe(35);
    expect(run('overhead-norway-development-3000').total).toBe(40);
    expect(run('overhead-norway-development-4000').total).toBe(42.5);
    expect(run('overhead-norway-exploration-250').total).toBe(6.25);
    expect(run('overhead-norway-corporate-065').total).toBeCloseTo(22.1, 12);
    const x = run('overhead-norway-all-with-exclusion');
    expect(x.categories.find((c) => c.category === 'operating').base).toBe(850);
  });
  test('Norway JOA Art. 12.5: a budget may be exceeded by the lower of 5% and NOK 75 million; an item by up to 10%', () => {
    const a = run('budget-norway-lower-of').total;
    expect([a.allowedOverrun, a.heldBy, a.withinBudgetTolerance]).toEqual([75, 'amount', false]);
    const b = run('budget-norway-pct-holds').total;
    expect([b.allowedOverrun, b.heldBy, b.withinBudgetTolerance]).toEqual([50, 'pct', true]);
  });
  test('Norway JOA Art. 18.12: entry at one thousand (1000) % of the proportionate share, apportioned by interest in the project', () => {
    const r = run('nc-ekene-buy-in-norway-1000');
    const pb = r.buyIn[0];
    expect(pb.payment).toBe(10 * r.nonConsenting[0].costShare);
    expect(pb.toParties.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(pb.payment, 6);
    expect(pb.toParties.map((x) => x.id)).toEqual(['EKO', 'PA', 'NOC']);
  });
  test('PIA 2021 s.85(4): participation up to 60%; development and production costs only; no uplift and no upfront payment', () => {
    expect(J.PIA_JV.maxGovernmentParticipationPct).toBe(60);
    expect(J.PIA_JV.refundableKinds).toEqual(['development', 'production']);
    expect(run('backin-pia-at-60').targetPct).toBe(60);
    expect(run('backin-refuse-pia-61').field).toBe('targetPct');
    expect(run('backin-ekene-pia').refundable).toBe(490000000);
    expect(run('carry-refuse-pia-uplift').error).toBe('uplift.type must be "none" under basis "pia-s85-4": the refund excludes interest, premium or markups on cost (PIA s.85(4)(c)); got "compound"');
    expect(run('backin-refuse-pia-upfront').field).toBe('refundForm');
  });
});

describe('fixtures: synthetic and wired to the engine', () => {
  test('the file says it is synthetic, names its generator and its partners as synthetic, and carries no em or en dash', () => {
    expect(FX.synthetic).toMatch(/^SYNTHETIC teaching data for the Ekene field/);
    expect(FX.generatedBy).toBe('tools/validation/economics/make_jv_fixtures.py');
    FX.parties.forEach((p) => expect(p.name).toMatch(/\(synthetic\)$/));
    ['ekene-jv.json', 'README.md'].forEach((f) => {
      const s = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'economics', 'ekene-jv', f), 'utf8');
      expect(/[–—]/.test(s)).toBe(false);
    });
  });
  test('the fixture goldens are built from the fixture file', () => {
    expect(byId('cc-ekene-2027').args.months).toEqual(FX.cashCalls.months);
    expect(byId('budget-ekene-2027').args.items).toEqual(FX.budget.items);
    expect(byId('carry-ekene-compound').args.years).toEqual(FX.carry.years);
    expect(byId('psc-ekene').args.years).toEqual(FX.psc.years);
    expect(byId('nc-ekene-sidetrack').args.years).toEqual(FX.nonConsent.years);
  });
  test('the planted situations hold (the fixture README describes these)', () => {
    const i = run('int-ekene').parties;
    expect(i.map((p) => [p.id, p.beneficialPct, p.payingPct])).toEqual([['EKO', 40, 50], ['PA', 25, 31.25], ['PB', 15, 18.75], ['NOC', 20, 0]]);
    const c = run('cc-ekene-2027').months;
    const m = (k) => c.find((x) => x.month === k);
    expect([m('2027-04').called, m('2027-05').called, m('2027-06').called]).toEqual([false, false, true]);
    expect(m('2027-06').totals.arrearsBilling).toBe(448000);
    expect(m('2027-09').totals.call).toBe(0);
    expect(m('2027-09').parties.find((p) => p.id === 'EKO').carried).toBe(100000);
    expect(m('2027-03').totals.call).toBe(11600000);
    const b = run('budget-ekene-2027');
    expect(b.itemsOutsideTolerance).toEqual(['exploration drilling']);
    expect(b.items[0].withinItemTolerance).toBe(true);
    expect([b.total.allowedOverrun, b.total.heldBy, b.total.withinBudgetTolerance]).toEqual([3000000, 'amount', false]);
    const d = run('default-ekene-march');
    expect([d.unpaidTotal, d.interestTotal, d.defaulters[0].days]).toEqual([2000000, 20625, 45]);
    expect([d.defaulters[0].suspension.applies, d.defaulters[0].forfeiture.applies]).toEqual([true, false]);
    expect(run('carry-ekene-compound').recoveredInYear).toBe(2033);
    expect(run('carry-ekene-pia').recoveredInYear).toBe(2031);
    expect(run('carry-ekene-capped').totals.writtenOff).toBeGreaterThan(0);
    expect(run('backin-ekene-pia').recovery.recoveredInYear).toBe(2034);
    expect(run('nc-ekene-sidetrack').recovery[0].revertsInYear).toBe(2035);
    expect(run('psc-ekene').unrecoveredAtEnd).toBe(0);
    expect(run('psc-ekene').npv.every((x) => x.npv > 0)).toBe(true);
  });
});

describe('properties', () => {
  test('interests: paying interests sum to 100, beneficial interests are the participating interests', () => {
    G.cases.filter((c) => c.fn === 'participatingInterests' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      expect(r.totals.payingPct).toBeCloseTo(100, 9);
      r.parties.forEach((p, i) => expect(p.beneficialPct).toBe(c.args.parties[i].participatingPct));
    });
  });
  test('cash calls: paid in the year = actual shares + the closing balance, and the closing balance = unadjusted + carried - arrears due', () => {
    G.cases.filter((c) => c.fn === 'cashCalls' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      r.closing.forEach((cl) => {
        const paid = r.months.reduce((s, mo) => s + mo.parties.find((p) => p.id === cl.id).paid, 0);
        const act = r.months.reduce((s, mo) => s + mo.parties.find((p) => p.id === cl.id).actualShare, 0);
        expect(paid - act).toBeCloseTo(cl.balance, 6);
        expect(cl.balance).toBeCloseTo(cl.unadjustedDifferences + cl.carried - cl.arrearsDue, 6);
      });
    });
  });
  test('default: the cover sums to the unpaid amount and the interest received to the interest charged', () => {
    G.cases.filter((c) => c.fn === 'defaultCover' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      expect(r.cover.reduce((s, x) => s + x.cover, 0)).toBeCloseTo(r.unpaidTotal, 6);
      expect(r.cover.reduce((s, x) => s + x.interestReceived, 0)).toBeCloseTo(r.interestTotal, 6);
    });
  });
  test('recovery ledgers conserve money: recovered + written off + outstanding = cost + uplift', () => {
    G.cases.filter((c) => c.fn === 'carryRecovery' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      expect(r.totals.recovered + r.totals.writtenOff + r.totals.outstanding).toBeCloseTo(r.totals.carriedCost + r.totals.uplift, 6);
      r.parties.forEach((y) => {
        expect(y.parties.reduce((s, p) => s + p.recovery, 0)).toBeCloseTo(0, 6);
        expect(y.parties.reduce((s, p) => s + p.net, 0)).toBeCloseTo(y.entitlement - y.cost, 6);
      });
      if (r.npv) r.npv.forEach((n) => expect(n.npv).toBe(npv(r.parties.map((y) => y.parties.find((p) => p.id === n.id).net), c.args.discountRate, c.args.baseYear, c.args.years[0].year)));
    });
    G.cases.filter((c) => c.fn === 'nonConsent' && !c.expected.error && c.expected.recovery).forEach((c) => {
      run(c.id).recovery.forEach((r) => {
        expect(r.recovered + r.outstanding).toBeCloseTo(r.premium, 6);
        r.ledger.forEach((y, i) => {
          expect(y.recovered + y.nonConsentingReceives).toBeCloseTo(y.share, 6);
          expect(r.toParties[i].parties.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(y.recovered, 6);
        });
      });
    });
  });
  test('back-in: interests still sum to 100 and the refund received equals the refund paid', () => {
    G.cases.filter((c) => c.fn === 'backIn' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      expect(r.parties.reduce((s, p) => s + p.after, 0)).toBeCloseTo(100, 9);
      expect(r.parties.reduce((s, p) => s + p.refundReceived, 0)).toBeCloseTo(r.refund, 6);
    });
  });
  test('PSC: cost oil + profit oil = revenue after royalty; contractor entitlement + government take = gross; the pool rolls', () => {
    G.cases.filter((c) => c.fn === 'pscCostRecovery' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      r.years.forEach((y) => {
        expect(y.costRecovered + y.profitOil).toBeCloseTo(y.revenueAfterRoyalty, 6);
        expect(y.contractorEntitlement + y.governmentTake).toBeCloseTo(y.grossRevenue, 6);
        expect(y.poolIn + y.capex + y.opex - y.costRecovered).toBeCloseTo(y.poolOut, 6);
        expect(y.costRecovered).toBeLessThanOrEqual(y.costOilLimit + 1e-6);
      });
    });
  });
});

describe('boundaries (per rule)', () => {
  test('carry recovered exactly: the balance takes the whole available share and the payout year is that year', () => {
    const r = run('carry-recovered-exactly');
    expect(r.recoveredInYear).toBe(2028);
    expect(r.ledger[1].closing).toBe(0);
    expect(r.ledger[2].recovered).toBe(0);
    expect(r.ledger[2].debtorReceives).toBe(200);
    expect(run('carry-one-short').recoveredInYear).toBe(2029);
  });
  test('premium recovered on the last barrel: reversion from the next period; recovered mid-period: the rest of that period is the non-consenting party\'s', () => {
    const a = run('nc-premium-last-barrel').recovery[0];
    expect([a.revertsInYear, a.ledger[1].nonConsentingReceives, a.ledger[2].nonConsentingReceives]).toEqual([2031, 0, 200]);
    const b = run('nc-premium-reverts-mid-year').recovery[0];
    expect([b.revertsInYear, b.ledger[1].nonConsentingReceives]).toEqual([2031, 200]);
  });
  test('zero-call month and the threshold: a forecast at the threshold is called, one below is not', () => {
    const z = run('cc-zero-call-month').months[1];
    expect([z.called, z.totals.call]).toEqual([true, 0]);
    expect(z.reasons).toContain('2027-02: a forecast of 0: the cash call is the adjustment alone');
    const t = run('cc-threshold-exactly').months;
    expect([t[0].called, t[1].called]).toEqual([true, false]);
  });
  test('default on the last day: cured on the trigger date is not triggered; a day later is', () => {
    expect(run('default-cured-on-trigger-day').defaulters[0].suspension).toEqual({ triggerDate: '2027-03-08', applies: false });
    expect(run('default-cured-day-after-trigger').defaulters[0].suspension).toEqual({ triggerDate: '2027-03-08', applies: true });
    expect(run('default-forfeiture-last-day').defaulters[0].forfeiture.applies).toBe(false);
    expect(run('default-forfeiture-day-after').defaulters[0].forfeiture.applies).toBe(true);
    expect(run('default-forfeiture-day-after').interestsAfterForfeiture.map((p) => p.id)).toEqual(['EKO', 'PA', 'NOC']);
    const due = run('default-cured-on-due-date').defaulters[0];
    expect([due.days, due.interest]).toEqual([0, 0]);
    expect(run('default-working-days-holiday').defaulters[0].suspension.triggerDate).toBe('2028-01-03');
    expect(run('default-months-end-of-month').defaulters[0].forfeiture.triggerDate).toBe('2027-04-30');
  });
  test('an item overrun of exactly the tolerance is inside; any more is beyond; a band edge charges the lower band only', () => {
    expect(run('budget-item-at-tolerance').items[0].withinItemTolerance).toBe(true);
    expect(run('budget-item-one-over').items[0].withinItemTolerance).toBe(false);
    const e = run('overhead-band-edge-exact').categories[0];
    expect([e.bands[0].amount, e.bands[1].amount, e.above.amount]).toEqual([1000, 0, 0]);
  });
});

describe('lead decision: default interest method and grace are stated inputs', () => {
  test('the grace boundary: cured at exactly the grace carries no interest; one day later interest runs from the due date', () => {
    const a = run('default-grace-last-hour').defaulters[0];
    expect([a.days, a.withinGrace, a.interest]).toEqual([3, true, 0]);
    const b = run('default-grace-exceeded').defaulters[0];
    expect([b.days, b.withinGrace]).toEqual([4, false]);
    expect(b.interest).toBe(run('default-grace-exceeded').unpaidTotal * 8.25 * 4 / 36000);
    expect(run('default-grace-fractional-hours').defaulters[0].withinGrace).toBe(false);
    expect(run('default-grace-last-hour').reasons[1]).toBe('PB: share of the call 2250000, paid 250000, unpaid 2000000; no interest: 3 days (72 hours, from 2027-03-01 to the cure on 2027-03-04, the last date excluded) are within the stated grace of 72 hours');
  });
  test('monthly compounding: whole months from the due date compound, the rest is simple', () => {
    const k = run('default-ekene-monthly-compound-kenya').defaulters[0];
    expect([k.wholeMonths, k.remainingDays]).toEqual([1, 14]);
    const w = run('default-monthly-compound-whole-months').defaulters[0];
    expect([w.wholeMonths, w.remainingDays]).toEqual([2, 0]);
    const e = run('default-monthly-compound-month-end').defaulters[0];
    expect([e.wholeMonths, e.remainingDays]).toEqual([2, 15]);
    expect(run('default-ekene-march').defaulters[0].wholeMonths).toBe(null);
  });
  test('method and grace are required, with exact refusals', () => {
    expect(run('default-refuse-no-method').error).toBe('interest.interestMethod must be one of "simple", "monthly-compound"; got nothing');
    expect(run('default-refuse-no-grace').error).toBe('interest.graceHours must be a finite number of hours at or above 0, stated (0 when the contract gives no grace; the engine holds no default); got nothing');
    expect(run('default-refuse-negative-grace').error).toBe('interest.graceHours must be a finite number of hours at or above 0, stated (0 when the contract gives no grace; the engine holds no default); got -1');
  });
  test('the PSC basis states the tax reading', () => {
    expect(run('psc-ekene').basis.tax).toBe("income tax is charged on the contractor's profit oil share, as FARI TNM/16/01 and World Bank Note 8 assume (applyPSC in engines/economics/cashflow.ts)");
  });
});

describe('wording and keys', () => {
  test('unknown keys: every function refuses one at the top level', () => {
    expect(Object.keys(J.ACCEPTED_KEYS).sort()).toEqual(FNS);
    FNS.forEach((f) => {
      const r = J[f]({ notAKey: 1 });
      expect(r.field).toBe('notAKey');
      expect(r.error).toMatch(/^notAKey is not an accepted key; the accepted keys at the top level are /);
    });
    expect(J.cashCalls([]).error).toBe('options must be an object of named inputs; got []');
  });
  test('one refusal wording: "<field> must <condition>; got <value>", or a key or party that is not accepted', () => {
    G.cases.filter((c) => c.expected.error === true).forEach((c) => {
      expect(c.expected.message).toMatch(/^[A-Za-z][\w.[\]]* (must (be|sum|have) .+; got .+|is not (an accepted key|a party|a cost category); .+|is a carried party and cannot carry another)$/);
    });
  });
  test('reason strings: counts agree with their units, no "X, not Y" wording, no em or en dash, no P-label', () => {
    G.cases.forEach((c) => {
      const t = JSON.stringify(run(c.id));
      expect(t).not.toMatch(/(^|[^0-9.])1 (years|months|days|working days|calendar days|entries)\b/);
      expect(t).not.toMatch(/, not /);
      expect(/[–—]/.test(t)).toBe(false);
      expect(t).not.toMatch(/\bP(10|50|90)\b/);
    });
  });
  test('course content: exact reason strings the lessons quote', () => {
    expect(run('int-ekene').reasons[0]).toBe('NOC: 100% of its 20% cost share is carried (20 points), paid by EKO 10, PA 6.25, PB 3.75 (pro rata to their participating interests); its share of production stays 20%');
    expect(run('cc-ekene-2027').months[8].reasons).toEqual([
      '2027-09: the over-call of 1200000 in 2027-07 (forecast 15000000, actual 13800000) is credited against this cash call, 2 months later',
      '2027-09: the adjustment exceeds the forecast share of EKO, PA, PB: the call is 0 and the rest of the credit is carried to the next cash call',
    ]);
    expect(run('default-ekene-march').reasons[1]).toBe('PB: share of the call 2250000, paid 250000, unpaid 2000000; interest 2000000 x 8.25% x 45 days / 360 = 20625 (from 2027-03-01 to the cure on 2027-04-15, the last date excluded)');
    expect(run('carry-ekene-compound').reasons.slice(-1)[0]).toBe('2033: the balance 7267760.62 is recovered with 7267760.62 of the 9400000 available; the carried party receives 11532239.38 of its share 18800000');
    expect(run('backin-ekene-pia').reasons[0]).toBe('NOC backs in from 20% to 40%: the others keep 60 / 80 of their interests; refund 20% x refundable costs 490000000 = 98000000 (156000000 excluded)');
    expect(run('overhead-norway-development-4000').reasons[0]).toBe('development: base 4000; 2.5% of 1000 + 1% of 1000 + 0.5% of 1500 + 0% of 500 above 3500 = 42.5');
  });
  test('money prints to the cent in reasons; the fields keep full precision', () => {
    const r = run('carry-ekene-compound');
    expect(r.ledger.some((l) => l.uplift !== Number(l.uplift.toFixed(2)))).toBe(true);
    expect(r.reasons.join(' ')).not.toMatch(/\d\.\d{3,}/);
  });
});

describe('caps', () => {
  test('parties and years above the caps are refused with the cap in the message', () => {
    const parties = Array.from({ length: J.DEFAULTS.MAX_PARTIES + 1 }, (_, i) => ({ id: `P${i}`, participatingPct: 100 / (J.DEFAULTS.MAX_PARTIES + 1) }));
    expect(J.participatingInterests({ parties }).error).toBe(`parties must have at most ${J.DEFAULTS.MAX_PARTIES} entries; got ${J.DEFAULTS.MAX_PARTIES + 1}`);
    const years = Array.from({ length: J.DEFAULTS.MAX_YEARS + 1 }, (_, i) => ({ year: 2000 + i, grossRevenue: 1, capex: 0, opex: 0 }));
    expect(J.pscCostRecovery({ years, royaltyPct: 0, costOilLimitPct: 50, costOilLimitBase: 'gross', contractorProfitSharePct: 50, taxRatePct: 0, openingCostPool: 0 }).error)
      .toBe(`years must have at most ${J.DEFAULTS.MAX_YEARS} entries; got ${J.DEFAULTS.MAX_YEARS + 1}`);
  });
});
