// Economics EC8 gas sales agreement gates. Every case in
// test-data/economics/goldens/gascontract_cases.json is run THROUGH THE ENGINE
// and compared with the value the independent stdlib oracle
// (tools/validation/economics/oracle_gascontract.py) computed from the stated
// clause arithmetic by a different road (exact Fractions, a dated ledger for
// make-up and carry-forward, Decimal digits for the 4-decimal rule, the gas
// royalty rate re-derived from the PIA text). The published figures (HMRC
// OT05402, ECS 2007 Figure 51 and the 0.172 slope, OIES NG 175, the PIA
// s.167 and Fourth Schedule arithmetic, the reported 2025 and 2026 domestic
// prices) are checked against their printed values too. Property tests compare
// engine outputs with each other, never with a restated formula;
// tools/validation/economics/negcontrol_gascontract.sh proves the gates go red
// when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as T from '../engines/economics/gasContract';
import { npv, deriveGasRoyaltyRate } from '../engines/economics/cashflow';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'economics', 'goldens', 'gascontract_cases.json');
const PW = read('test-data', 'economics', 'ekene-gsa', 'domestic-power.json');
const EX = read('test-data', 'economics', 'ekene-gsa', 'export-feed.json');
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
  if (!c) throw new Error(`golden case ${id} is missing from gascontract_cases.json`);
  return c;
};
const memo = new Map();
const run = (id) => { if (!memo.has(id)) { const c = byId(id); memo.set(id, T[c.fn](clone(c.args))); } return memo.get(id); };
const FNS = ['contractQuantities', 'dailyBalance', 'domesticGasObligation', 'domesticPrice', 'energyParitySlope', 'gsaCashFlows', 'priceSeries', 'takeOrPay', 'toEnergy'];

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('gasContract');
    expect(G.generatedBy).toBe('tools/validation/economics/oracle_gascontract.py');
    expect(G.cases.length).toBeGreaterThanOrEqual(180);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by a golden, and refused at least once', () => {
    const fns = Object.keys(T).filter((k) => typeof T[k] === 'function').sort();
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
  test('HMRC OT05402: effective swing 150 / 90, printed 1.66 (truncated; the exact figure is 1.666...)', () => {
    const r = run('cq-hmrc-ot05402-effective-swing');
    expect(r.effectiveSwing).not.toBe(1.66);
    expect(Math.floor(r.effectiveSwing * 100) / 100).toBe(1.66);
    expect(Math.floor((r.effectiveSwing - 1) * 10 * 10) / 10).toBe(6.6);
  });
  test('ECS Figure 51: LNG = 0.1485 x JCC + 0.80, flat below 15 and above 30 $/bbl, inside the printed axis 2.50 to 5.50', () => {
    const p = run('price-ecs-figure-51').months.map((m) => m.price);
    expect(p[0]).toBe(p[1]);
    expect(p[1]).toBeCloseTo(0.1485 * 15 + 0.8, 12);
    expect(p[2]).toBeCloseTo(0.1485 * 22.5 + 0.8, 12);
    expect(p[3]).toBeCloseTo(0.1485 * 30 + 0.8, 12);
    expect(p[4]).toBe(p[3]);
    p.forEach((x) => { expect(x).toBeGreaterThanOrEqual(2.5); expect(x).toBeLessThanOrEqual(5.5); });
    expect(run('price-ecs-figure-51').months.map((m) => m.segment)).toEqual(['low', 'mid', 'mid', 'mid', 'high']);
    const plain = run('price-ecs-plain-linear').months.map((m) => m.price);
    expect(plain[0]).toBeLessThan(p[0]);
    expect(plain[4]).toBeGreaterThan(p[4]);
  });
  test('ECS: the heat-parity slope 1 / 5.8 prints as 0.172', () => {
    const r = run('parity-ecs-0172');
    expect(r.slope.toFixed(3)).toBe('0.172');
    expect(r.slope).not.toBe(0.172);
  });
  test('OIES NG 175: CSP = 1.15 x HH + Xy rises 1.15 per unit of Henry Hub', () => {
    const m = run('price-oies-hub-csp').months;
    for (let i = 1; i < m.length; i += 1) expect(m[i].price - m[i - 1].price).toBeCloseTo(1.15 * 0.5, 12);
  });
  test('PIA s.167: the reported 2026 and 2025 prices are the domestic base price and that price + US$0.50 per MMBtu', () => {
    expect(run('dp-power-2026').price).toBe(2.18);
    expect(run('dp-commercial-2026').price).toBe(2.68);
    expect(run('dp-power-2025').price).toBe(2.13);
    expect(run('dp-commercial-2025').price).toBe(2.63);
  });
  test('PIA Fourth Schedule and s.168: NRP 1, PRP 250 or 325, floor 0.90, ceiling the domestic base price', () => {
    expect(T.PIA_GAS.gbiProducts.urea).toEqual({ label: 'Urea', nrp: 1, prp: 250 });
    expect(T.PIA_GAS.gbiProducts['low-sulphur-diesel-gtl'].prp).toBe(325);
    expect(T.PIA_GAS.gbiFloorUsdPerMmbtu).toBe(0.9);
    expect(T.PIA_GAS.dgdoPenaltyUsdPerMmbtu).toBe(3.5);
    expect(T.PIA_GAS.commercialAdderUsdPerMmbtu).toBe(0.5);
    expect([run('dp-gbi-urea-inside').heldAt, run('dp-gbi-urea-floor').heldAt, run('dp-gbi-urea-ceiling').heldAt]).toEqual([null, 'floor', 'ceiling']);
    expect(run('dp-gbi-urea-at-prp').price).toBe(1);
  });
  test('units: the International Table Btu and the cubic foot are the exact defined values', () => {
    expect(T.UNITS.BTU_IT_J).toBe(1055.05585262);
    expect(T.UNITS.M3_PER_FT3).toBe(0.028316846592);
    expect(Math.abs(T.UNITS.M3_PER_FT3 - 0.3048 ** 3)).toBeLessThan(1e-17);
  });
});

describe('fixtures: synthetic and wired to the engine', () => {
  test('both files say they are synthetic, name their generator, name Ekene, and carry no em or en dash', () => {
    [PW, EX].forEach((f) => {
      expect(f.synthetic).toMatch(/^SYNTHETIC teaching data for the Ekene field/);
      expect(f.generatedBy).toBe('tools/validation/economics/make_gsa_fixtures.py');
      expect(f.buyer.name).toMatch(/\(synthetic\)$/);
      expect(f.title).toMatch(/^Ekene gas/);
    });
    ['domestic-power.json', 'export-feed.json', 'README.md'].forEach((f) => {
      const s = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'economics', 'ekene-gsa', f), 'utf8');
      expect(/[–—]/.test(s)).toBe(false);
    });
  });
  test('the DCQ in energy is the stated volume at the stated heating value', () => {
    expect(run('energy-power-dcq').mmbtu).toBe(PW.dcq);
    expect(run('energy-export-dcq').mmbtu).toBe(EX.dcq);
  });
  test('the ACQ of every fixture year is DCQ x the calendar days of that year', () => {
    [PW, EX].forEach((f) => f.years.forEach((y) => expect(y.acq).toBe(T.contractQuantities({ dcq: f.dcq, year: y.year }).acq)));
  });
  test('the export contract prices are the annual averages of the engine\'s own monthly price series', () => {
    const series = T.priceSeries(clone(byId('price-export').args));
    const args = byId('top-export').args;
    series.annual.forEach((a, i) => {
      expect(args.years[i].year).toBe(a.year);
      expect(Math.abs(args.years[i].contractPrice - a.averagePrice)).toBeLessThanOrEqual(1e-12 * a.averagePrice);
      expect(args.years[i].topPrice).toBe(args.years[i].contractPrice);
    });
  });
  test('the planted situations hold (the fixture README describes these)', () => {
    const p = run('top-power').years;
    const at = (rows, y) => rows.find((r) => r.year === y);
    expect(at(p, 2028).deficiency).toBe(688800);
    expect(at(p, 2030).taken).toBe(at(p, 2030).adjustedAcq);
    expect(at(p, 2030).makeUpTaken).toBe(0);
    expect(at(p, 2031).makeUpExpired).toEqual([{ fromYear: 2028, quantity: 210000 }]);
    expect(at(p, 2032).taken).toBe(at(p, 2032).topQuantity);
    expect(at(p, 2032).deficiency).toBe(0);
    expect(at(p, 2034).endOfTerm).toEqual({ rule: 'forfeit', quantity: 252000, entries: [{ fromYear: 2033, quantity: 252000 }], refund: 0 });
    const x = run('top-export').years;
    expect(at(x, 2029).carryForwardDrawn).toEqual([{ fromYear: 2027, quantity: 2299500 }, { fromYear: 2028, quantity: 919750 }]);
    expect(at(x, 2030).forceMajeure).toBe(1260000);
    expect(at(x, 2036).endOfTerm.rule).toBe('refund');
    expect(at(x, 2036).endOfTerm.quantity).toBe(457950);
    const d = run('daily-power-january-2027');
    expect(d.days.find((r) => r.date === '2027-01-20').sellerShortfall).toBe(6300);
    expect(d.days.find((r) => r.date === '2027-01-25').properlyNominated).toBe(23100);
    expect(d.days.find((r) => r.date === '2027-01-30').sellerShortfall).toBe(0);
    expect(d.days.find((r) => r.date === '2027-01-12').adjustedDcq).toBe(0);
    const o = run('dgdo-power-2028');
    expect([o.undelivered, o.excusedApplied, o.penalised, o.penalty]).toEqual([1365000, 688800, 676200, 2366700]);
  });
});

describe('properties', () => {
  test('daily balance: sum of buyer shortfall - sum of over-take = Adjusted ACQ - taken, on every daily golden', () => {
    G.cases.filter((c) => c.fn === 'dailyBalance' && !c.expected.error).forEach((c) => {
      const a = run(c.id).annual;
      expect(a.buyerShortfall - a.overTake).toBeCloseTo(a.adjustedAcq - a.taken, 9);
    });
  });
  test('take or pay: every deficiency paid is made up, expires, or ends the term (the ledger conserves quantity)', () => {
    G.cases.filter((c) => c.fn === 'takeOrPay' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      const lastPaid = r.years[r.years.length - 1].deficiencyPaid;
      const ledgerIn = r.totals.deficiencyPaid - (c.args.makeUp.periodYears > 0 ? lastPaid : r.totals.deficiencyPaid);
      expect(r.totals.makeUpTaken + r.totals.makeUpExpired + r.totals.endOfTermQuantity).toBeCloseTo(ledgerIn, 6);
      r.years.forEach((y) => {
        expect(y.netToSeller).toBeCloseTo(y.regularRevenue + y.makeUpRevenue + y.deficiencyPayment - y.shortfallPayment - y.refund, 6);
        expect(y.counted + y.makeUpTaken).toBe(y.taken);
      });
    });
  });
  test('take or pay: a make-up entry taken in the last year of its period counts; one year later it has expired', () => {
    const onTime = run('top-makeup-on-last-day-of-period').years;
    expect(onTime[2].makeUpTaken).toBe(100);
    expect(onTime[2].makeUpExpired).toEqual([{ fromYear: 2027, quantity: 100 }]);
    const late = run('top-makeup-one-year-late').years;
    expect(late[3].makeUpAvailable).toBe(0);
    expect(late[2].makeUpExpired).toEqual([{ fromYear: 2027, quantity: 200 }]);
  });
  test('take or pay: the recovery order changes when make-up is taken, never the deficiency of a year that meets its TOPQ', () => {
    const a = run('top-order-after-adjusted-acq').years;
    const b = run('top-order-after-top-quantity').years;
    const f = run('top-order-first').years;
    expect([a[1].makeUpTaken, b[1].makeUpTaken, f[1].makeUpTaken]).toEqual([100, 200, 200]);
    expect(a[2].makeUpTaken).toBe(0);
    expect(b[2].makeUpTaken).toBe(0);
    const f2 = run('top-order-first-creates-deficiency').years;
    expect(f2[1].makeUpTaken).toBe(200);
    expect(f2[1].deficiency).toBe(200);
  });
  test('take or pay: force majeure, maintenance, seller shortfall and permitted reductions all lower the take-or-pay quantity', () => {
    const y = run('top-force-majeure-and-shortfall').years[0];
    expect(y.adjustedAcq).toBe(800);
    expect(y.topQuantity).toBe(640);
    expect(y.deficiency).toBe(40);
    expect(y.shortfallPayment).toBe(75);
    expect(run('top-fm-whole-year').years[0].deficiency).toBe(0);
  });
  test('take or pay: TOP exactly met leaves no deficiency; one unit short leaves one', () => {
    expect(run('top-exactly-met').years[0].deficiency).toBe(0);
    expect(run('top-one-unit-short').years[0].deficiency).toBe(1);
  });
  test('take or pay: a deficiency in the last contract year gives no make-up right', () => {
    const r = run('top-single-year').years[0];
    expect(r.deficiencyPaid).toBe(400);
    expect(r.endOfTerm.quantity).toBe(0);
    expect(r.reasons[0]).toMatch(/the delivery period ends with this year, so no make-up right arises$/);
  });
  test('carry forward: the credit never exceeds its cap, and off is the default', () => {
    const c = run('top-carry-forward-capped').years;
    c.forEach((y) => expect(y.carryForwardApplied).toBeLessThanOrEqual(0.5 * y.deficiency + 1e-9));
    expect(run('top-carry-forward-off-by-default').years.every((y) => y.surplus === 0 && y.carryForwardApplied === 0)).toBe(true);
    expect(run('top-carry-forward-top-quantity').years[0].surplus).toBeGreaterThan(run('top-carry-forward-adjusted-acq').years[0].surplus);
  });
  test('price series: the S-curve is continuous at both kinks and takes the stated slopes', () => {
    const m = run('price-s-curve-kinks').months.map((x) => x.price);
    expect(m[1] - m[0]).toBeCloseTo(0.06 * 0.01, 12);
    expect(m[2] - m[1]).toBeCloseTo(0.12 * 0.01, 12);
    expect(m[4] - m[3]).toBeCloseTo(0.12 * 0.01, 12);
    expect(m[5] - m[4]).toBeCloseTo(0.03 * 0.01, 12);
  });
  test('price series: the averaging window ends lagMonths before the priced month and the price is held for resetMonths', () => {
    const r = run('price-avg6-lag1-reset3');
    expect(r.months[0].window).toEqual(['2025-02', '2025-07']);
    expect(r.months[1].priceMonth).toBe('2025-08');
    expect(r.months[3].window).toEqual(['2025-05', '2025-10']);
    expect(r.months[0].price).toBe(r.months[2].price);
    expect(run('price-avg3-lag0-reset1').months[0].window).toEqual(['2025-01', '2025-03']);
  });
  test('price series: the 4-decimal rule rounds half up on the fifth decimal, with no rounding before it (11.234346 gives 11.2343)', () => {
    expect(run('price-round-model-4dp').months.map((m) => m.price)).toEqual([11.2345, 11.2344, 11.2346, 11.2345, 100.0001, 0.0001, 11.2343]);
  });
  test('the NPV is the canonical cashflow.ts npv of the rows, and the royalty rate is the canonical gas rate', () => {
    ['cf-power', 'cf-export'].forEach((id) => {
      const r = run(id);
      const a = byId(id).args;
      expect(r.npvNetAfterRoyalty).toBe(npv(r.years.map((y) => y.netAfterRoyalty), a.discountRate, a.baseYear, r.years[0].year));
      expect(r.royaltyRate).toBe(deriveGasRoyaltyRate(a.royalty.terrain, a.royalty.inCountrySharePct));
    });
    expect(run('cf-power').royaltyRate).toBe(0.025);
    expect(run('cf-export').royaltyRate).toBe(0.05);
  });
  test('DGDO: the agreement rate never goes below US$3.50, and voluntary contracts at the obligation are deemed fulfilment', () => {
    expect(run('dgdo-agreement-below').rate).toBe(3.5);
    expect(run('dgdo-agreement-above').rate).toBe(5);
    expect(run('dgdo-deemed-by-contracts').penalty).toBe(0);
    expect(run('dgdo-contracts-one-short').penalty).toBe(2800);
    expect(run('dgdo-excuses-in-order').excused.map((x) => x.ground)).toEqual(['forceMajeure', 'purchaserCannotAccept', 'transportUnavailable', 'purchaserNonPayment']);
  });
  test('unknown keys: every function refuses one at the top level; the fixtures pass whole', () => {
    expect(Object.keys(T.ACCEPTED_KEYS).sort()).toEqual(FNS);
    FNS.forEach((f) => {
      const r = T[f]({ notAKey: 1 });
      expect(r.field).toBe('notAKey');
      expect(r.error).toMatch(/^notAKey is not an accepted key; the accepted keys at the top level are /);
    });
    expect(run('top-refuse-unknown-key-makeup').error).toBe('makeup is not an accepted key; the accepted keys at the top level are years, topPct, makeUp, carryForward');
  });
  test('one refusal wording: "<field> must be <condition>; got <value>" or an unknown key', () => {
    G.cases.filter((c) => c.expected.error === true).forEach((c) => {
      expect(c.expected.message).toMatch(/^[A-Za-z][\w.[\]]* (must (be|sum|have|give|cover|carry) .+; got .+|is not (an accepted key|an index|a weighted index); .+)$/);
    });
  });
  test('reason strings: counts agree with their units, no "X, not Y" wording, no em or en dash, no P-label', () => {
    G.cases.forEach((c) => {
      const t = JSON.stringify(run(c.id));
      expect(t).not.toMatch(/(^|[^0-9.])1 (years|contract years|months|days|entries)\b/);
      expect(t).not.toMatch(/, not /);
      expect(/[–—]/.test(t)).toBe(false);
      expect(t).not.toMatch(/\bP(10|50|90)\b/);
    });
  });
  test('course content: exact reason strings the lessons quote', () => {
    const p = run('top-power').years;
    expect(p[1].reasons[0]).toBe('2028: 5460000 counted against the take-or-pay quantity 6148800 leaves a deficiency of 688800; the deficiency payment is 688800 x 2.18 = 1501584; the buyer may make up 688800 in the 3 contract years after 2028, to the end of 2031');
    expect(p[3].reasons[0]).toBe('2030: make-up aggregate 478800 available and none taken, because taken 7665000 does not exceed the Adjusted ACQ 7665000');
    expect(p[4].reasons[1]).toBe('2031: make-up of 210000 from 2028 expired unrecovered at the end of 2031, the last year of its make-up period');
    expect(run('dgdo-power-2028').reasons[2]).toBe('676200 is penalised at 3.5 per MMBtu: 2366700; the lessee may not supply new midstream gas export operations (s.110(14)(a)) and export supply approvals require prior compliance (s.110(15))');
    expect(run('dp-refuse-no-dbp').error).toBe('domesticBasePrice must be stated in US$ per MMBtu: the Authority determines it each year (PIA s.167(1)) and the engine holds no default; got nothing');
  });
  test('stated readings are in the basis', () => {
    expect(run('top-power').basis.reading).toMatch(/^the make-up entitlement is the deficiency quantity actually paid for/);
    expect(run('daily-power-january-2027').basis.reading).toMatch(/measured against the quantity the seller made available/);
    expect(run('dgdo-agreement-below').basis.rate).toBe("the agreement's rate 2 per MMBtu is below the US$3.50 minimum of r.6(2), so 3.5 applies");
    expect(run('price-export').reopeners[0].note).toBe('price reopener 2031-01: reported only; the engine does not model the outcome of a price review');
  });
});

describe('caps', () => {
  test('years above the cap are refused with the cap in the message', () => {
    const years = Array.from({ length: T.DEFAULTS.MAX_YEARS + 1 }, (_, i) => ({ year: 2000 + i, acq: 1, taken: 1, contractPrice: 1, topPrice: 1, makeUpPrice: 0 }));
    const r = T.takeOrPay({ years, topPct: 80, makeUp: { periodYears: 1, order: 'first', endOfTerm: 'forfeit' } });
    expect(r.error).toBe(`years must have at most ${T.DEFAULTS.MAX_YEARS} entries; got ${T.DEFAULTS.MAX_YEARS + 1}`);
  });
  test('priced months above the cap are refused', () => {
    const r = T.priceSeries({ months: [{ month: '2000-01', values: {} }], formula: { type: 'fixed', price: 1 }, from: '2000-01', to: '2100-12' });
    expect(r.field).toBe('to');
  });
});
