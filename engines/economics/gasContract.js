/**
 * Gas sales agreements (Economics EC8): contract quantities and swing, the
 * daily balance of nominations against deliveries, the annual take-or-pay
 * reconciliation with make-up and carry-forward ledgers, the seller-side
 * shortfall mirror, contract price formulas computed from a monthly index
 * series with stated averaging, lag and reset, volume to energy, the Nigerian
 * domestic gas prices and the Domestic Gas Delivery Obligation penalty under
 * the Petroleum Industry Act 2021, and the cash flows and NPV of a GSA stream.
 * All deterministic.
 *
 * Pure functions, no I/O. Every function returns either a result object
 * carrying a `basis` (the rules applied and where they come from, so a course
 * can print the working) or `{ error, field }`, where `field` names the input
 * refused and the message starts with that name. Every refusal reads
 * "<field> must be <condition>; got <value>" (or, for an unknown key,
 * "<field> is not an accepted key; ...").
 *
 * Sources (FINDINGS-gasContract.md has URLs, editions and the dates read):
 *   CW GSA    Commonwealth Secretariat, Gas Sales Agreement, Contract 2 in the
 *             Commonwealth Model Contract Series (2025, CC BY 4.0):
 *             definitions of ACQ, Adjusted ACQ, Take or Pay Quantity, Buyer's
 *             Annual Deficiency Quantity, Make-Up Aggregate, Buyer's Annual
 *             Surplus Quantity, Carry Forward Aggregate, Shortfall Quantity,
 *             Maximum Daily Contract Quantity; Articles 12.5 (shortfall), 12.6
 *             (take or pay), 12.7 (make-up, FIFO, expiry, end of term), 12.8
 *             (carry forward, FIFO, cap), 15.1 (Contract Price by indices
 *             averaged over months ending one month before the review month),
 *             15.2.6 (take-or-pay price), 15.4 (rounding) and 15.8 (index
 *             floor and ceiling).
 *   ESMAP     ESMAP Report 152/93, Long-term Gas Contracts: Principles and
 *             Applications (January 1993), paras 6.52 (daily availability as a
 *             multiple of the daily quantity), 6.55 to 6.59 (minimum pay,
 *             make-up after the minimum-pay quantity, 3 to 5 year expiry),
 *             6.61 and 6.62 (carry-forward above the minimum pay, capped).
 *   HMRC      HMRC Oil Taxation Manual OT05435 (make-up taken in priority or
 *             only after the period minimum; a time limit) and OT05402
 *             (effective swing = swing factor / take-or-pay level).
 *   ECS       Energy Charter Secretariat, Putting a Price on Energy (2007):
 *             P = A x JCC + B, the S-curve (Figure 51: A 0.1485, B 0.80, floor
 *             at 15 and cap at 30 $/bbl) and the heat-parity slope 0.172.
 *   OIES      OIES Paper NG 175, International Gas Contracts (2022): the
 *             hub-indexed CSP = 1.15 x HH + Xy and the 70 to 95 per cent
 *             take-or-pay range.
 *   PIA       Petroleum Industry Act 2021 (Act No. 6): s.110 (Domestic Gas
 *             Delivery Obligation; US$3.50 per MMBtu not delivered, s.110(8);
 *             the excuses of s.110(10); deemed fulfilment by voluntary
 *             contracts, s.110(2); export consequences, s.110(14) and (15)),
 *             s.167 (domestic base price; power at the base price, commercial
 *             at the base price plus US$0.50 per MMBtu, gas distributors not
 *             above the commercial price), s.168 and the Fourth Schedule (gas
 *             based industries: CP = NRP x (1 + EPF) <= EPP, floor US$0.90 per
 *             MMBtu, NRP US$1 per MMBtu, PRP 250 or 325 US$ per tonne).
 *   DGDO Regs Domestic Gas Delivery Obligation Regulations 2022 (S.I. No. 74
 *             of 2022) r.6(1) (US$3.50 per MMBtu) and r.6(2) (the penalty
 *             under a signed agreement is not less than that amount).
 *   royalty   deriveGasRoyaltyRate imported from engines/economics/cashflow.ts
 *             (PIA Seventh Schedule para 10(6)); never re-implemented.
 *
 * Conventions, stated once:
 *   quantity    one energy or volume unit throughout a call (MMBtu in the
 *               Nigerian functions, which state US$ per MMBtu).
 *   money       one currency throughout a call.
 *   years       contract years are consecutive integers; a make-up period of
 *               N years after year y runs to the end of year y + N inclusive.
 *   months      'YYYY-MM'; days 'YYYY-MM-DD'.
 *   averaging   the index value for delivery month t is the arithmetic mean
 *               of the monthly values for the averagingMonths months ending
 *               lagMonths months before t (lag 0 ends the window at t itself).
 *   reasons     figures print as the shortest round-trip decimal.
 *   NPV         the canonical engines/economics/cashflow.ts npv, year-end.
 *
 * Validation: tools/validation/economics/oracle_gascontract.py (stdlib
 * python) writes test-data/economics/goldens/gascontract_cases.json;
 * FINDINGS-gasContract.md, negcontrol_gascontract.sh, timing_gascontract.js.
 * Fixtures (synthetic Ekene gas sales): test-data/economics/ekene-gsa/.
 */

import { npv, deriveGasRoyaltyRate, calendarDays } from './cashflow.ts';

export const DEFAULTS = Object.freeze({
  MAX_YEARS: 100,
  MAX_DAYS: 400,
  MAX_MONTHS: 1200,
  MAX_INDICES: 10,
  WEIGHT_SUM_TOLERANCE: 1e-9,
  PRICE_DIGITS: 12,
});

/** Unit constants. Both are exact by definition. */
export const UNITS = Object.freeze({
  // International Table British thermal unit, joules (NIST SP 811 (2008) Appendix B: 1.055 056 E+03)
  BTU_IT_J: 1055.05585262,
  // cubic metres in one cubic foot, (0.3048 m)^3
  M3_PER_FT3: 0.028316846592,
});

/** Petroleum Industry Act 2021 figures read from the gazetted text. */
export const PIA_GAS = Object.freeze({
  dgdoPenaltyUsdPerMmbtu: 3.5, // s.110(8); DGDO Regulations 2022 r.6(1)
  commercialAdderUsdPerMmbtu: 0.5, // s.167(6)
  gbiFloorUsdPerMmbtu: 0.9, // s.168(2)
  // Fourth Schedule: NRP US$1/MMBtu for every listed end product; PRP US$/MT
  gbiProducts: Object.freeze({
    ammonia: Object.freeze({ label: 'Ammonia', nrp: 1, prp: 250 }),
    urea: Object.freeze({ label: 'Urea', nrp: 1, prp: 250 }),
    methanol: Object.freeze({ label: 'Methanol', nrp: 1, prp: 250 }),
    polypropylene: Object.freeze({ label: 'Polypropylene (LDPPE/HDPPE)', nrp: 1, prp: 250 }),
    'low-sulphur-diesel-gtl': Object.freeze({ label: 'Low Sulphur Diesel (GTL)', nrp: 1, prp: 325 }),
  }),
});

const CITE = Object.freeze({
  pia: 'Petroleum Industry Act 2021 (Act No. 6), Official Gazette No. 142, Vol. 108, 27 August 2021',
  dgdoRegs: 'Domestic Gas Delivery Obligation Regulations 2022 (S.I. No. 74), Official Gazette No. 206, Vol. 109, 23 November 2022, commenced 18 November 2022',
  cw: 'Commonwealth Secretariat, Gas Sales Agreement, Contract 2 in the Commonwealth Model Contract Series (2025, CC BY 4.0)',
  esmap: 'ESMAP Report 152/93, Long-term Gas Contracts: Principles and Applications (January 1993)',
  hmrcMakeUp: 'HMRC Oil Taxation Manual OT05435',
  hmrcSwing: 'HMRC Oil Taxation Manual OT05402',
  ecs: 'Energy Charter Secretariat, Putting a Price on Energy: International Pricing Mechanisms for Oil and Gas (2007), section 4.5.3.3 and Figure 51',
  oies: 'OIES Paper NG 175, International Gas Contracts (2022), section 2.2',
  nist: 'NIST Special Publication 811 (2008 edition), Appendix B',
});

// ---- helpers ---------------------------------------------------------------

const refuse = (field, message) => ({ error: `${field} ${message}`, field });
const fmt = (x) => String(x);
const show = (v) => (v === undefined ? 'nothing' : typeof v === 'number' ? fmt(v) : typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
const must = (field, cond, v) => refuse(field, `must be ${cond}; got ${show(v)}`);
const unit = (x, one, many = `${one}s`) => `${fmt(x)} ${x === 1 ? one : many}`;
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const sum = (xs) => xs.reduce((s, v) => s + v, 0);
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const monthIndex = (m) => { const r = MONTH_RE.exec(m); return Number(r[1]) * 12 + Number(r[2]) - 1; };
const monthName = (i) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;

const nonNeg = (field, v) => (fin(v) && v >= 0 ? null : must(field, 'a finite number at or above 0', v));
const positive = (field, v) => (fin(v) && v > 0 ? null : must(field, 'a finite number above 0', v));
const pct = (field, v) => (fin(v) && v >= 0 && v <= 100 ? null : must(field, 'a number from 0 to 100', v));
const intAtLeast = (field, v, lo) => (Number.isInteger(v) && v >= lo ? null : must(field, `an integer at or above ${lo}`, v));
const oneOf = (field, v, opts) => (opts.includes(v) ? null : must(field, `one of ${opts.map((o) => `"${o}"`).join(', ')}`, v));
const text = (field, v) => (typeof v === 'string' && v.trim() !== '' ? null : must(field, 'a non-empty string', v));
const listOf = (field, v, max) => {
  if (!Array.isArray(v) || v.length < 1) return must(field, 'an array of at least 1 entry', v);
  if (v.length > max) return refuse(field, `must have at most ${max} entries; got ${v.length}`);
  for (let i = 0; i < v.length; i += 1) if (!isObj(v[i])) return must(`${field}[${i}]`, 'an object', v[i]);
  return null;
};
const first = (...checks) => checks.find((c) => c) || null;

// ---- accepted keys ---------------------------------------------------------
//
// Every public function refuses an input key it does not read, at every
// level, so a misspelt optional key (carryfoward for carryForward) is never
// dropped silently. Keys whose value is undefined count as absent. Keys that
// are index names (formula weights, baseValues, index floors and ceilings, a
// month's values) are checked by the function that reads them.
const O = (keys, children = {}) => ({ t: 'obj', keys, children });
const L = (of) => ({ t: 'list', of });
const FORMULA = { t: 'formula' };
const FORMULA_KEYS = {
  fixed: O(['type', 'price']),
  escalated: O(['type', 'basePrice', 'baseMonth', 'ratePctPerYear']),
  'oil-indexed': O(['type', 'index', 'slope', 'constant', 'sCurve', 'floor', 'ceiling'], { sCurve: O(['lowKink', 'highKink', 'lowSlope', 'highSlope']) }),
  'hub-indexed': O(['type', 'index', 'multiplier', 'adder', 'floor', 'ceiling']),
  basket: O(['type', 'basePrice', 'weights', 'baseValues', 'indexFloors', 'indexCeilings']),
};
const YEAR_KEYS = ['year', 'acq', 'maintenance', 'forceMajeure', 'sellerShortfall', 'permittedReduction', 'taken', 'contractPrice', 'topPrice', 'makeUpPrice', 'shortfallPrice'];
const TOP_ARGS = O(['years', 'topPct', 'makeUp', 'carryForward'], {
  years: L(O(YEAR_KEYS)), makeUp: O(['periodYears', 'order', 'endOfTerm']), carryForward: O(['periodYears', 'base', 'capPct']),
});
export const ACCEPTED_KEYS = Object.freeze({
  toEnergy: O(['quantity', 'quantityUnit', 'heatingValue', 'heatingValueUnit', 'heatingValueBasis', 'referenceConditions']),
  contractQuantities: O(['dcq', 'days', 'year', 'period', 'maxDcqPct', 'topPct'], { period: O(['start', 'end']) }),
  dailyBalance: O(['dcq', 'maxDcqPct', 'deliveryTolerance', 'days'], { days: L(O(['date', 'nominated', 'available', 'taken', 'forceMajeure', 'maintenance', 'buyerCaused'])) }),
  takeOrPay: TOP_ARGS,
  priceSeries: O(['months', 'formula', 'from', 'to', 'averagingMonths', 'lagMonths', 'resetMonths', 'rounding', 'reopeners'], { months: L(O(['month', 'values'])), formula: FORMULA }),
  energyParitySlope: O(['mmbtuPerBarrel']),
  domesticPrice: O(['sector', 'domesticBasePrice', 'negotiatedPrice', 'product', 'cmpp', 'transportTariff', 'schedule'], { schedule: O(['nrp', 'prp', 'source']) }),
  domesticGasObligation: O(['obligation', 'delivered', 'voluntaryContracts', 'excused', 'agreementPenaltyRate', 'penaltyRate'], {
    excused: O(['forceMajeure', 'purchaserCannotAccept', 'transportUnavailable', 'purchaserNonPayment']), penaltyRate: O(['value', 'source']),
  }),
  gsaCashFlows: O(['contract', 'royalty', 'discountRate', 'baseYear'], { contract: TOP_ARGS, royalty: O(['terrain', 'inCountrySharePct']) }),
});

const unknownKey = (path, key, keys) => refuse(path ? `${path}.${key}` : key, `is not an accepted key; the accepted keys ${path ? `of ${path}` : 'at the top level'} are ${keys.join(', ')}`);
const walkKeys = (v, spec, path) => {
  if (spec.t === 'formula') {
    if (!isObj(v) || !own(FORMULA_KEYS, v.type)) return null; // the function refuses the type itself
    return walkKeys(v, FORMULA_KEYS[v.type], path);
  }
  if (spec.t === 'list') {
    if (!Array.isArray(v)) return null;
    for (let i = 0; i < v.length; i += 1) { const e = walkKeys(v[i], spec.of, `${path}[${i}]`); if (e) return e; }
    return null;
  }
  if (!isObj(v)) return null;
  for (const k of Object.keys(v)) if (v[k] !== undefined && !spec.keys.includes(k)) return unknownKey(path, k, spec.keys);
  for (const k of spec.keys) {
    if (own(spec.children, k) && v[k] !== undefined) { const e = walkKeys(v[k], spec.children[k], path ? `${path}.${k}` : k); if (e) return e; }
  }
  return null;
};
const guard = (name, impl) => (args = {}) => {
  if (!isObj(args)) return must('options', 'an object of named inputs', args);
  const e = walkKeys(args, ACCEPTED_KEYS[name], '');
  return e || impl(args);
};

// ---- volume to energy -------------------------------------------------------

const VOLUME_UNITS = Object.freeze({ scf: { ft3: 1 }, Mscf: { ft3: 1e3 }, MMscf: { ft3: 1e6 }, Sm3: { m3: 1 }, MSm3: { m3: 1e3 }, MMSm3: { m3: 1e6 } });

/**
 * Volume to energy through a stated heating value. The heating value is
 * gross (GHV) or net (NHV) as the contract states; the arithmetic is the same,
 * the basis is carried through so a course can print it. Imperial pairs
 * (scf with Btu/scf) and metric pairs (Sm3 with MJ/Sm3) convert directly;
 * a mixed pair converts the volume by the geometric factor (0.3048 m)^3 per
 * ft3, which assumes the volume and the heating value are stated at the same
 * reference conditions (the caller's referenceConditions, echoed back).
 */
const toEnergyImpl = ({ quantity, quantityUnit, heatingValue, heatingValueUnit, heatingValueBasis, referenceConditions }) => {
  const e = first(
    nonNeg('quantity', quantity),
    oneOf('quantityUnit', quantityUnit, Object.keys(VOLUME_UNITS)),
    positive('heatingValue', heatingValue),
    oneOf('heatingValueUnit', heatingValueUnit, ['Btu/scf', 'MJ/Sm3']),
    oneOf('heatingValueBasis', heatingValueBasis, ['gross', 'net']),
    text('referenceConditions', referenceConditions),
  );
  if (e) return e;
  const u = VOLUME_UNITS[quantityUnit];
  let mmbtu;
  let route;
  if (heatingValueUnit === 'Btu/scf' && u.ft3) {
    mmbtu = (quantity * u.ft3 * heatingValue) / 1e6;
    route = 'MMBtu = volume in scf x heating value in Btu/scf / 1,000,000';
  } else if (heatingValueUnit === 'MJ/Sm3' && u.m3) {
    mmbtu = (quantity * u.m3 * heatingValue) / (UNITS.BTU_IT_J);
    route = 'MMBtu = volume in Sm3 x heating value in MJ/Sm3 / 1055.05585262 (MJ per MMBtu)';
  } else if (heatingValueUnit === 'Btu/scf') {
    mmbtu = ((quantity * u.m3) / UNITS.M3_PER_FT3) * heatingValue / 1e6;
    route = 'MMBtu = (volume in Sm3 / 0.028316846592 ft3 per Sm3) x heating value in Btu/scf / 1,000,000';
  } else {
    mmbtu = (quantity * u.ft3 * UNITS.M3_PER_FT3 * heatingValue) / UNITS.BTU_IT_J;
    route = 'MMBtu = volume in scf x 0.028316846592 Sm3 per scf x heating value in MJ/Sm3 / 1055.05585262';
  }
  return {
    quantity, quantityUnit, heatingValue, heatingValueUnit, heatingValueBasis, referenceConditions,
    mmbtu,
    gj: (mmbtu * UNITS.BTU_IT_J) / 1000,
    basis: {
      rule: route,
      heatingValue: heatingValueBasis === 'gross' ? 'gross (higher) heating value, as the contract states' : 'net (lower) heating value, as the contract states',
      units: `1 MMBtu = 1055.05585262 MJ (International Table Btu, ${CITE.nist}); 1 ft3 = 0.028316846592 m3 exactly; a mixed pair assumes one set of reference conditions`,
    },
  };
};

// ---- contract quantities ----------------------------------------------------

const dayCount = ({ days, year, period }) => {
  const given = [days, year, period].filter((x) => x !== undefined).length;
  if (given === 0) return { error: refuse('days', 'must be stated, or replaced by year or by period; got nothing') };
  if (given > 1) return { error: refuse('days', `must be the only day count stated; got ${['days', 'year', 'period'].filter((k, i) => [days, year, period][i] !== undefined).join(' and ')}`) };
  if (days !== undefined) {
    const e = intAtLeast('days', days, 1);
    return e ? { error: e } : { n: days, rule: `${unit(days, 'day')} as stated` };
  }
  if (year !== undefined) {
    const e = intAtLeast('year', year, 1);
    if (e) return { error: e };
    const n = calendarDays(year);
    return { n, rule: `calendar year ${year}: ${n} days (${n === 366 ? 'a leap year' : 'not a leap year'})` };
  }
  if (!isObj(period)) return { error: must('period', 'an object { start, end }', period) };
  for (const k of ['start', 'end']) if (typeof period[k] !== 'string' || !DAY_RE.test(period[k]) || Number.isNaN(Date.parse(`${period[k]}T00:00:00Z`)) || new Date(`${period[k]}T00:00:00Z`).toISOString().slice(0, 10) !== period[k]) return { error: must(`period.${k}`, "a real date 'YYYY-MM-DD'", period[k]) };
  const n = Math.round((Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / 86400000);
  if (n < 1) return { error: must('period.end', `a date after period.start ${period.start}`, period.end) };
  return { n, rule: `${period.start} up to ${period.end} (end date excluded, as a contract year that finishes on the following 1 January): ${unit(n, 'day')}` };
};

/**
 * ACQ = DCQ x days in the contract year (CW GSA: ACQ is the sum of the daily
 * contract quantities), with the day count stated: `days`, a calendar `year`
 * (365 or 366), or a `period` whose end date is excluded. MaxDCQ = maxDcqPct %
 * of DCQ; swing factor = MaxDCQ / DCQ. With topPct, the take-or-pay quantity
 * at the full ACQ and the effective swing = swing factor / (topPct / 100)
 * (HMRC OT05402: 150 / 90 = 1.66 as printed).
 */
const contractQuantitiesImpl = ({ dcq, days, year, period, maxDcqPct, topPct }) => {
  let e = positive('dcq', dcq);
  if (e) return e;
  const dc = dayCount({ days, year, period });
  if (dc.error) return dc.error;
  e = first(
    maxDcqPct !== undefined && !(fin(maxDcqPct) && maxDcqPct >= 100) ? must('maxDcqPct', 'a number at or above 100 when given', maxDcqPct) : null,
    topPct !== undefined ? pct('topPct', topPct) : null,
    topPct === 0 && maxDcqPct !== undefined ? must('topPct', 'above 0 when maxDcqPct is stated (the effective swing divides by it)', topPct) : null,
  );
  if (e) return e;
  const out = { dcq, days: dc.n, acq: dcq * dc.n, maxDcq: null, swingFactor: null, topQuantity: null, effectiveSwing: null };
  if (maxDcqPct !== undefined) {
    out.maxDcq = (dcq * maxDcqPct) / 100;
    out.swingFactor = maxDcqPct / 100;
  }
  if (topPct !== undefined) out.topQuantity = (out.acq * topPct) / 100;
  if (topPct !== undefined && maxDcqPct !== undefined) out.effectiveSwing = maxDcqPct / topPct;
  out.basis = {
    dayCount: dc.rule,
    rule: 'ACQ = DCQ x days in the contract year; MaxDCQ = maxDcqPct % of DCQ; swing factor = MaxDCQ / DCQ; take-or-pay quantity = topPct % of ACQ (before any adjustment); effective swing = swing factor / take-or-pay fraction',
    source: `${CITE.cw} definitions of ACQ and MaxDCQ; ${CITE.esmap} para 6.52; ${CITE.hmrcSwing}`,
  };
  return out;
};

// ---- daily balance ----------------------------------------------------------

/**
 * One contract year day by day. For each day:
 *   PNQ = min(nominated, MaxDCQ) (the part above MaxDCQ is not properly
 *         nominated; without maxDcqPct there is no cap).
 *   gap = (PNQ - deliveryTolerance) - available, when above 0: the seller did
 *         not make the nominated quantity available. The force majeure and
 *         maintenance quantities stated for the day excuse the gap first; a
 *         day marked buyerCaused excuses all of it. The rest is the seller's
 *         Shortfall Quantity SFQ (CW GSA definition, read with the quantity
 *         made available: gas made available and not taken is never the
 *         seller's shortfall).
 *   adjusted DCQ = DCQ - forceMajeure - maintenance - SFQ (below 0 on a
 *         day the seller fails a nomination above the DCQ: the Adjusted ACQ
 *         subtracts the whole Shortfall Quantity, as the model formula does).
 *   buyer shortfall = max(0, adjusted DCQ - taken); over-take = max(0, taken
 *         - adjusted DCQ).
 * The year: ACQ = DCQ x days; Adjusted ACQ = ACQ - maintenance - force
 * majeure - SFQ; and sum(buyer shortfall) - sum(over-take) = Adjusted ACQ -
 * taken exactly (the reconciliation identity).
 */
const dailyBalanceImpl = ({ dcq, maxDcqPct, deliveryTolerance = 0, days }) => {
  let e = first(
    positive('dcq', dcq),
    maxDcqPct !== undefined && !(fin(maxDcqPct) && maxDcqPct >= 100) ? must('maxDcqPct', 'a number at or above 100 when given', maxDcqPct) : null,
    nonNeg('deliveryTolerance', deliveryTolerance),
    listOf('days', days, DEFAULTS.MAX_DAYS),
  );
  if (e) return e;
  const maxDcq = maxDcqPct === undefined ? null : (dcq * maxDcqPct) / 100;
  let prev = null;
  for (let i = 0; i < days.length; i += 1) {
    const d = days[i];
    const f = `days[${i}]`;
    if (typeof d.date !== 'string' || !DAY_RE.test(d.date)) return must(`${f}.date`, "a date 'YYYY-MM-DD'", d.date);
    if (prev !== null && !(d.date > prev)) return must(`${f}.date`, `after the previous day ${prev}`, d.date);
    prev = d.date;
    e = first(nonNeg(`${f}.nominated`, d.nominated), nonNeg(`${f}.available`, d.available), nonNeg(`${f}.taken`, d.taken),
      d.forceMajeure !== undefined ? nonNeg(`${f}.forceMajeure`, d.forceMajeure) : null,
      d.maintenance !== undefined ? nonNeg(`${f}.maintenance`, d.maintenance) : null,
      d.buyerCaused !== undefined && typeof d.buyerCaused !== 'boolean' ? must(`${f}.buyerCaused`, 'true or false when given', d.buyerCaused) : null);
    if (e) return e;
    if (d.taken > d.available) return must(`${f}.taken`, `at or below the quantity made available ${fmt(d.available)}`, d.taken);
    const fm = d.forceMajeure ?? 0;
    const sm = d.maintenance ?? 0;
    if (fm + sm > dcq) return must(`${f}.forceMajeure`, `a quantity that with maintenance ${fmt(sm)} is at or below the DCQ ${fmt(dcq)}`, fm);
  }
  const rows = days.map((d) => {
    const fm = d.forceMajeure ?? 0;
    const sm = d.maintenance ?? 0;
    const reasons = [];
    const pnq = maxDcq !== null && d.nominated > maxDcq ? maxDcq : d.nominated;
    if (pnq < d.nominated) reasons.push(`${d.date}: nominated ${fmt(d.nominated)} is above the MaxDCQ ${fmt(maxDcq)}; ${fmt(d.nominated - maxDcq)} is not properly nominated`);
    const gap = pnq - deliveryTolerance - d.available;
    let sfq = 0;
    if (gap > 0) {
      if (d.buyerCaused === true) {
        reasons.push(`${d.date}: ${fmt(gap)} of the properly nominated quantity was not made available for a cause on the buyer's side, so it is not a seller shortfall`);
      } else {
        const excused = Math.min(gap, fm + sm);
        sfq = gap - excused;
        if (excused > 0) reasons.push(`${d.date}: ${fmt(excused)} not made available is excused by the force majeure and maintenance quantities stated for the day`);
        if (sfq > 0) reasons.push(`${d.date}: the seller made ${fmt(d.available)} available against a properly nominated ${fmt(pnq)}${deliveryTolerance > 0 ? ` less the tolerance ${fmt(deliveryTolerance)}` : ''}: seller shortfall ${fmt(sfq)}`);
      }
    }
    const adjustedDcq = dcq - fm - sm - sfq;
    const buyerShortfall = Math.max(0, adjustedDcq - d.taken);
    const overTake = Math.max(0, d.taken - adjustedDcq);
    if (d.nominated === 0 && adjustedDcq > 0) reasons.push(`${d.date}: zero nomination; the whole adjusted DCQ ${fmt(adjustedDcq)} is a buyer shortfall for the day`);
    else if (buyerShortfall > 0) reasons.push(`${d.date}: taken ${fmt(d.taken)} is below the adjusted DCQ ${fmt(adjustedDcq)}: buyer shortfall ${fmt(buyerShortfall)}`);
    if (fm + sm >= dcq) reasons.push(`${d.date}: force majeure and maintenance cover the whole DCQ; no quantity is owed either way for the day`);
    return { date: d.date, nominated: d.nominated, properlyNominated: pnq, available: d.available, taken: d.taken, forceMajeure: fm, maintenance: sm, sellerShortfall: sfq, adjustedDcq, buyerShortfall, overTake, reasons };
  });
  const tot = (k) => sum(rows.map((r) => r[k]));
  const acq = dcq * rows.length;
  const annual = {
    days: rows.length, acq,
    maintenance: tot('maintenance'), forceMajeure: tot('forceMajeure'), sellerShortfall: tot('sellerShortfall'),
    taken: tot('taken'), buyerShortfall: tot('buyerShortfall'), overTake: tot('overTake'),
  };
  annual.adjustedAcq = acq - annual.maintenance - annual.forceMajeure - annual.sellerShortfall;
  return {
    dcq, maxDcq, deliveryTolerance, days: rows, annual,
    basis: {
      rule: 'PNQ = min(nominated, MaxDCQ); seller shortfall = (PNQ - tolerance) - available, less the force majeure and maintenance stated for the day, none on a buyer-caused day; adjusted DCQ = DCQ - force majeure - maintenance - seller shortfall; buyer shortfall = adjusted DCQ - taken when positive',
      identity: 'sum of buyer shortfall - sum of over-take = Adjusted ACQ - taken',
      reading: 'the Shortfall Quantity is measured against the quantity the seller made available; the model formula subtracts the Daily Actual Quantity, which would count gas made available and not taken against the seller',
      source: `${CITE.cw} definitions of Shortfall Quantity, Adjusted ACQ and MaxDCQ, Article 12.5`,
    },
  };
};

// ---- take or pay ------------------------------------------------------------

const ORDERS = Object.freeze({
  'after-adjusted-acq': { text: 'make-up only after the Adjusted ACQ of the year is taken', source: `${CITE.cw} Article 12.7.1 (Alternative 1&2A)` },
  'after-top-quantity': { text: 'make-up only after the take-or-pay quantity of the year is taken', source: `${CITE.esmap} para 6.59; ${CITE.hmrcMakeUp}` },
  first: { text: 'make-up taken in priority, before the year\'s own quantity', source: CITE.hmrcMakeUp },
});

const checkTopArgs = ({ years, topPct, makeUp, carryForward }, pre = '') => {
  let e = first(listOf(`${pre}years`, years, DEFAULTS.MAX_YEARS), pct(`${pre}topPct`, topPct));
  if (e) return e;
  if (!isObj(makeUp)) return must(`${pre}makeUp`, 'an object { periodYears, order, endOfTerm } (no default)', makeUp);
  e = first(
    intAtLeast(`${pre}makeUp.periodYears`, makeUp.periodYears, 0),
    oneOf(`${pre}makeUp.order`, makeUp.order, Object.keys(ORDERS)),
    oneOf(`${pre}makeUp.endOfTerm`, makeUp.endOfTerm, ['forfeit', 'refund']),
  );
  if (e) return e;
  if (carryForward !== undefined) {
    if (!isObj(carryForward)) return must(`${pre}carryForward`, 'an object { periodYears, base, capPct } when given', carryForward);
    e = first(
      intAtLeast(`${pre}carryForward.periodYears`, carryForward.periodYears, 1),
      oneOf(`${pre}carryForward.base`, carryForward.base, ['adjusted-acq', 'top-quantity']),
      pct(`${pre}carryForward.capPct`, carryForward.capPct),
    );
    if (e) return e;
  }
  for (let i = 0; i < years.length; i += 1) {
    const y = years[i];
    const f = `${pre}years[${i}]`;
    e = intAtLeast(`${f}.year`, y.year, 1);
    if (e) return e;
    if (i > 0 && y.year !== years[i - 1].year + 1) return must(`${f}.year`, `${years[i - 1].year + 1}, the year after ${years[i - 1].year} (contract years are consecutive)`, y.year);
    e = first(
      nonNeg(`${f}.acq`, y.acq), nonNeg(`${f}.taken`, y.taken),
      ...['maintenance', 'forceMajeure', 'sellerShortfall', 'permittedReduction'].map((k) => (y[k] !== undefined ? nonNeg(`${f}.${k}`, y[k]) : null)),
      nonNeg(`${f}.contractPrice`, y.contractPrice), nonNeg(`${f}.topPrice`, y.topPrice), nonNeg(`${f}.makeUpPrice`, y.makeUpPrice),
      y.shortfallPrice !== undefined ? nonNeg(`${f}.shortfallPrice`, y.shortfallPrice) : null,
    );
    if (e) return e;
    if ((y.sellerShortfall ?? 0) > 0 && y.shortfallPrice === undefined) return must(`${f}.shortfallPrice`, `stated when sellerShortfall is above 0 (${fmt(y.sellerShortfall)}); the engine holds no default rate`, undefined);
    const red = (y.maintenance ?? 0) + (y.forceMajeure ?? 0) + (y.sellerShortfall ?? 0) + (y.permittedReduction ?? 0);
    if (red > y.acq) return must(`${f}.acq`, `at or above the reductions it carries (maintenance + force majeure + seller shortfall + permitted reduction = ${fmt(red)})`, y.acq);
  }
  return null;
};

const listText = (xs) => xs.map((x) => `${fmt(x.quantity)} from ${x.fromYear}`).join(', ');
const drawFifo = (ledger, want) => {
  const taken = [];
  let left = want;
  for (const entry of ledger) {
    if (left <= 0) break;
    if (entry.left <= 0) continue;
    const q = Math.min(entry.left, left);
    entry.left -= q;
    left -= q;
    taken.push({ fromYear: entry.fromYear, quantity: q });
  }
  return taken;
};

/**
 * The annual take-or-pay reconciliation over consecutive contract years.
 * For year y, in this order:
 *   1 Adjusted ACQ = ACQ - maintenance - force majeure - seller shortfall -
 *     permitted reduction; TOPQ = topPct % of Adjusted ACQ.
 *   2 make-up available = the unexpired make-up entries of earlier years;
 *     make-up taken = min(available, max(0, taken - threshold)), threshold
 *     the Adjusted ACQ ('after-adjusted-acq'), TOPQ ('after-top-quantity') or
 *     0 ('first'); drawn first in first out.
 *   3 counted = taken - make-up taken; deficiency = max(0, TOPQ - counted).
 *   4 carry-forward (when stated): credit = min(available surplus, capPct %
 *     of the deficiency), drawn first in first out; the deficiency paid is
 *     the deficiency less the credit, at the year's topPrice.
 *   5 the deficiency paid becomes a make-up entry recoverable in years y+1
 *     to y+periodYears (none when periodYears is 0, none in the last year).
 *   6 surplus (carry-forward only) = max(0, counted - base), base the
 *     Adjusted ACQ or TOPQ; recoverable in years y+1 to y+periodYears.
 *   7 entries whose last year is y expire at its end.
 *   8 in the last year, unexpired make-up is forfeited or refunded at that
 *     year's topPrice (endOfTerm).
 * Money: counted x contractPrice + make-up taken x makeUpPrice + deficiency
 * payment - seller shortfall x shortfallPrice - refund = net to the seller.
 */
const takeOrPayCore = ({ years, topPct, makeUp, carryForward }) => {
  const mu = [];
  const cf = [];
  const rows = [];
  const cfOn = carryForward !== undefined;
  const last = years[years.length - 1].year;
  for (const y of years) {
    const reasons = [];
    const maint = y.maintenance ?? 0;
    const fm = y.forceMajeure ?? 0;
    const sfq = y.sellerShortfall ?? 0;
    const perm = y.permittedReduction ?? 0;
    const adjustedAcq = y.acq - maint - fm - sfq - perm;
    const topQuantity = (topPct * adjustedAcq) / 100;
    const muAvail = sum(mu.map((m) => m.left));
    const threshold = makeUp.order === 'after-adjusted-acq' ? adjustedAcq : makeUp.order === 'after-top-quantity' ? topQuantity : 0;
    const want = Math.min(muAvail, Math.max(0, y.taken - threshold));
    const makeUpDrawn = want > 0 ? drawFifo(mu, want) : [];
    const makeUpTaken = want;
    if (makeUpTaken > 0) {
      reasons.push(`${y.year}: make-up of ${fmt(makeUpTaken)} taken from the make-up aggregate ${fmt(muAvail)} (${ORDERS[makeUp.order].text}), first in first out: ${listText(makeUpDrawn)}`);
    } else if (muAvail > 0) {
      reasons.push(`${y.year}: make-up aggregate ${fmt(muAvail)} available and none taken, because taken ${fmt(y.taken)} does not exceed ${makeUp.order === 'after-adjusted-acq' ? `the Adjusted ACQ ${fmt(adjustedAcq)}` : makeUp.order === 'after-top-quantity' ? `the take-or-pay quantity ${fmt(topQuantity)}` : '0'}`);
    }
    const counted = y.taken - makeUpTaken;
    const deficiency = Math.max(0, topQuantity - counted);
    const cfAvail = cfOn ? sum(cf.map((c) => c.left)) : 0;
    let cfApplied = 0;
    let cfDrawn = [];
    if (cfOn && deficiency > 0 && cfAvail > 0) {
      cfApplied = Math.min(cfAvail, (carryForward.capPct * deficiency) / 100);
      if (cfApplied > 0) cfDrawn = drawFifo(cf, cfApplied);
    }
    const deficiencyPaid = deficiency - cfApplied;
    const deficiencyPayment = deficiencyPaid * y.topPrice;
    if (deficiency > 0) {
      let r = `${y.year}: ${fmt(counted)} counted against the take-or-pay quantity ${fmt(topQuantity)} leaves a deficiency of ${fmt(deficiency)}`;
      if (cfApplied > 0) r += `; a carry-forward credit of ${fmt(cfApplied)} (at most ${fmt(carryForward.capPct)}% of the deficiency, first in first out: ${listText(cfDrawn)}) leaves ${fmt(deficiencyPaid)}`;
      r += `; the deficiency payment is ${fmt(deficiencyPaid)} x ${fmt(y.topPrice)} = ${fmt(deficiencyPayment)}`;
      if (deficiencyPaid > 0 && y.year === last) r += '; the delivery period ends with this year, so no make-up right arises';
      else if (deficiencyPaid > 0) r += makeUp.periodYears > 0 ? `; the buyer may make up ${fmt(deficiencyPaid)} in the ${unit(makeUp.periodYears, 'contract year')} after ${y.year}, to the end of ${y.year + makeUp.periodYears}` : '; the make-up period is 0 years, so no make-up right arises';
      reasons.push(r);
    }
    if (deficiencyPaid > 0 && makeUp.periodYears > 0 && y.year !== last) mu.push({ fromYear: y.year, lastYear: y.year + makeUp.periodYears, left: deficiencyPaid });
    let surplus = 0;
    if (cfOn) {
      const base = carryForward.base === 'adjusted-acq' ? adjustedAcq : topQuantity;
      surplus = Math.max(0, counted - base);
      if (surplus > 0) {
        cf.push({ fromYear: y.year, lastYear: y.year + carryForward.periodYears, left: surplus });
        reasons.push(`${y.year}: ${fmt(counted)} counted exceeds the ${carryForward.base === 'adjusted-acq' ? 'Adjusted ACQ' : 'take-or-pay quantity'} ${fmt(base)} by ${fmt(surplus)}, carried forward to the end of ${y.year + carryForward.periodYears}`);
      }
    }
    const makeUpExpired = [];
    for (const m of mu) if (m.lastYear === y.year && m.left > 0) { makeUpExpired.push({ fromYear: m.fromYear, quantity: m.left }); m.left = 0; }
    makeUpExpired.forEach((x) => reasons.push(`${y.year}: make-up of ${fmt(x.quantity)} from ${x.fromYear} expired unrecovered at the end of ${y.year}, the last year of its make-up period`));
    const cfExpired = [];
    for (const c of cf) if (c.lastYear === y.year && c.left > 0) { cfExpired.push({ fromYear: c.fromYear, quantity: c.left }); c.left = 0; }
    cfExpired.forEach((x) => reasons.push(`${y.year}: carry-forward of ${fmt(x.quantity)} from ${x.fromYear} expired unused at the end of ${y.year}`));
    let endOfTerm = null;
    let refund = 0;
    if (y.year === last) {
      const remaining = mu.filter((m) => m.left > 0).map((m) => ({ fromYear: m.fromYear, quantity: m.left }));
      const q = sum(remaining.map((m) => m.quantity));
      if (makeUp.endOfTerm === 'refund') refund = q * y.topPrice;
      endOfTerm = { rule: makeUp.endOfTerm, quantity: q, entries: remaining, refund };
      if (q > 0) reasons.push(makeUp.endOfTerm === 'refund'
        ? `${y.year}: the delivery period ends with make-up of ${fmt(q)} unrecovered; the seller refunds ${fmt(q)} x ${fmt(y.topPrice)} = ${fmt(refund)}`
        : `${y.year}: the delivery period ends with make-up of ${fmt(q)} unrecovered; the buyer forfeits it`);
      remaining.forEach((m) => { mu.find((x) => x.fromYear === m.fromYear).left = 0; });
    }
    const shortfallPayment = sfq > 0 ? sfq * y.shortfallPrice : 0;
    if (sfq > 0) reasons.push(`${y.year}: seller shortfall ${fmt(sfq)} reduces the Adjusted ACQ and is paid to the buyer at ${fmt(y.shortfallPrice)}: ${fmt(shortfallPayment)}`);
    const regularRevenue = counted * y.contractPrice;
    const makeUpRevenue = makeUpTaken * y.makeUpPrice;
    rows.push({
      year: y.year, acq: y.acq, maintenance: maint, forceMajeure: fm, sellerShortfall: sfq, permittedReduction: perm,
      adjustedAcq, topQuantity, taken: y.taken,
      makeUpAvailable: muAvail, makeUpTaken, makeUpDrawn, counted, deficiency,
      carryForwardAvailable: cfAvail, carryForwardApplied: cfApplied, carryForwardDrawn: cfDrawn,
      deficiencyPaid, deficiencyPayment, surplus,
      makeUpExpired, carryForwardExpired: cfExpired,
      makeUpOutstanding: sum(mu.map((m) => m.left)), carryForwardOutstanding: sum(cf.map((c) => c.left)),
      endOfTerm,
      regularRevenue, makeUpRevenue, shortfallPayment, refund,
      netToSeller: regularRevenue + makeUpRevenue + deficiencyPayment - shortfallPayment - refund,
      reasons,
    });
  }
  const tot = (k) => sum(rows.map((r) => r[k]));
  return {
    years: rows,
    totals: {
      taken: tot('taken'), makeUpTaken: tot('makeUpTaken'), deficiencyPaid: tot('deficiencyPaid'), deficiencyPayment: tot('deficiencyPayment'),
      makeUpExpired: sum(rows.map((r) => sum(r.makeUpExpired.map((x) => x.quantity)))),
      endOfTermQuantity: rows[rows.length - 1].endOfTerm.quantity,
      regularRevenue: tot('regularRevenue'), makeUpRevenue: tot('makeUpRevenue'), shortfallPayment: tot('shortfallPayment'), refund: tot('refund'), netToSeller: tot('netToSeller'),
    },
    basis: {
      order: `${makeUp.order}: ${ORDERS[makeUp.order].text} (${ORDERS[makeUp.order].source})`,
      rule: 'Adjusted ACQ = ACQ - maintenance - force majeure - seller shortfall - permitted reduction; TOPQ = topPct % of Adjusted ACQ; deficiency = TOPQ - (taken - make-up taken) when positive; deficiency payment = (deficiency - carry-forward credit) x topPrice',
      makeUp: `make-up entries are the deficiency quantities paid, recoverable in the ${unit(makeUp.periodYears, 'contract year')} after the deficiency year, drawn first in first out, expiring at the end of their last year; at the end of the delivery period the rest is ${makeUp.endOfTerm === 'refund' ? 'refunded at the last year\'s topPrice' : 'forfeited'}`,
      carryForward: cfOn ? `surplus above the ${carryForward.base === 'adjusted-acq' ? 'Adjusted ACQ' : 'take-or-pay quantity'} is credited against later deficiencies, at most ${fmt(carryForward.capPct)}% of a year's deficiency, first in first out, for ${unit(carryForward.periodYears, 'contract year')}` : 'off (no carry-forward right stated)',
      reading: 'the make-up entitlement is the deficiency quantity actually paid for (the deficiency less any carry-forward credit); a deficiency of the last contract year gives no make-up right, and the end-of-term rule applies to the make-up aggregate of earlier years (the Make-Up Aggregate sums prior contract years only)',
      source: `${CITE.cw} definitions and Articles 12.5 to 12.8; ${CITE.esmap} paras 6.55 to 6.62; ${CITE.hmrcMakeUp}`,
    },
  };
};
const takeOrPayImpl = (args) => checkTopArgs(args) || takeOrPayCore(args);

// ---- price formulas ---------------------------------------------------------

const roundModel = (x) => {
  // CW GSA Article 15.4: computed to five decimals without rounding, then
  // rounded to four, half up on the fifth decimal. The double is first
  // normalised to 12 significant digits so float noise cannot flip the digit.
  const s = Number(x.toPrecision(DEFAULTS.PRICE_DIGITS)).toFixed(DEFAULTS.PRICE_DIGITS);
  const [ip, fp] = s.split('.');
  const four = Number(`${ip}.${fp.slice(0, 4)}`);
  return Number(fp[4]) >= 5 ? Number((four + 0.0001).toFixed(4)) : four;
};

const checkFormula = (f, indices) => {
  if (!isObj(f)) return must('formula', 'an object with a type', f);
  const e = oneOf('formula.type', f.type, Object.keys(FORMULA_KEYS));
  if (e) return e;
  const idx = (k) => (typeof f[k] === 'string' && indices.includes(f[k]) ? null : must(`formula.${k}`, `the name of an index in months[].values (${indices.join(', ') || 'none given'})`, f[k]));
  const band = () => {
    for (const k of ['floor', 'ceiling']) if (f[k] !== undefined) { const x = nonNeg(`formula.${k}`, f[k]); if (x) return x; }
    if (f.floor !== undefined && f.ceiling !== undefined && f.floor > f.ceiling) return must('formula.ceiling', `at or above formula.floor ${fmt(f.floor)}`, f.ceiling);
    return null;
  };
  if (f.type === 'fixed') return nonNeg('formula.price', f.price);
  if (f.type === 'escalated') {
    return first(nonNeg('formula.basePrice', f.basePrice), typeof f.baseMonth === 'string' && MONTH_RE.test(f.baseMonth) ? null : must('formula.baseMonth', "a month 'YYYY-MM'", f.baseMonth),
      fin(f.ratePctPerYear) && f.ratePctPerYear > -100 ? null : must('formula.ratePctPerYear', 'a finite number above -100', f.ratePctPerYear));
  }
  if (f.type === 'oil-indexed') {
    let x = first(idx('index'), fin(f.slope) ? null : must('formula.slope', 'a finite number', f.slope), fin(f.constant) ? null : must('formula.constant', 'a finite number', f.constant), band());
    if (x) return x;
    if (f.sCurve !== undefined) {
      const s = f.sCurve;
      if (!isObj(s)) return must('formula.sCurve', 'an object { lowKink, highKink, lowSlope, highSlope } when given', s);
      x = first(nonNeg('formula.sCurve.lowKink', s.lowKink), nonNeg('formula.sCurve.highKink', s.highKink),
        fin(s.lowSlope) ? null : must('formula.sCurve.lowSlope', 'a finite number', s.lowSlope), fin(s.highSlope) ? null : must('formula.sCurve.highSlope', 'a finite number', s.highSlope));
      if (x) return x;
      if (!(s.highKink > s.lowKink)) return must('formula.sCurve.highKink', `above formula.sCurve.lowKink ${fmt(s.lowKink)}`, s.highKink);
    }
    return null;
  }
  if (f.type === 'hub-indexed') return first(idx('index'), fin(f.multiplier) ? null : must('formula.multiplier', 'a finite number', f.multiplier), fin(f.adder) ? null : must('formula.adder', 'a finite number', f.adder), band());
  // basket
  let x = nonNeg('formula.basePrice', f.basePrice);
  if (x) return x;
  if (!isObj(f.weights) || Object.keys(f.weights).length === 0) return must('formula.weights', 'an object of index weights, at least one', f.weights);
  const names = Object.keys(f.weights);
  if (names.length > DEFAULTS.MAX_INDICES) return refuse('formula.weights', `must have at most ${DEFAULTS.MAX_INDICES} indices; got ${names.length}`);
  for (const k of names) {
    if (!indices.includes(k)) return refuse(`formula.weights.${k}`, `is not an index in months[].values; the indices are ${indices.join(', ') || 'none'}`);
    x = nonNeg(`formula.weights.${k}`, f.weights[k]);
    if (x) return x;
  }
  const wsum = sum(names.map((k) => f.weights[k]));
  if (Math.abs(wsum - 1) > DEFAULTS.WEIGHT_SUM_TOLERANCE) return refuse('formula.weights', `must sum to 1 (weights stated as decimals, CW GSA Article 15.1); got a sum of ${fmt(wsum)}`);
  if (!isObj(f.baseValues)) return must('formula.baseValues', 'an object with a base value for each weighted index', f.baseValues);
  for (const k of Object.keys(f.baseValues)) if (!names.includes(k)) return refuse(`formula.baseValues.${k}`, `is not a weighted index; the accepted keys of formula.baseValues are ${names.join(', ')}`);
  for (const k of names) { x = positive(`formula.baseValues.${k}`, f.baseValues[k]); if (x) return x; }
  for (const side of ['indexFloors', 'indexCeilings']) {
    if (f[side] === undefined) continue;
    if (!isObj(f[side])) return must(`formula.${side}`, 'an object keyed by weighted index when given', f[side]);
    for (const k of Object.keys(f[side])) {
      if (!names.includes(k)) return refuse(`formula.${side}.${k}`, `is not a weighted index; the accepted keys of formula.${side} are ${names.join(', ')}`);
      x = nonNeg(`formula.${side}.${k}`, f[side][k]);
      if (x) return x;
    }
  }
  for (const k of names) {
    const lo = f.indexFloors?.[k];
    const hi = f.indexCeilings?.[k];
    if (lo !== undefined && hi !== undefined && lo > hi) return must(`formula.indexCeilings.${k}`, `at or above formula.indexFloors.${k} ${fmt(lo)}`, hi);
  }
  return null;
};

const sCurveValue = (x, f) => {
  const s = f.sCurve;
  if (!s) return { raw: f.constant + f.slope * x, segment: null };
  if (x < s.lowKink) return { raw: f.constant + f.slope * s.lowKink + s.lowSlope * (x - s.lowKink), segment: 'low' };
  if (x > s.highKink) return { raw: f.constant + f.slope * s.highKink + s.highSlope * (x - s.highKink), segment: 'high' };
  return { raw: f.constant + f.slope * x, segment: 'mid' };
};

const clampBand = (raw, f) => {
  if (f.floor !== undefined && raw < f.floor) return { price: f.floor, clamped: 'floor' };
  if (f.ceiling !== undefined && raw > f.ceiling) return { price: f.ceiling, clamped: 'ceiling' };
  return { price: raw, clamped: null };
};

/**
 * Monthly contract prices from a monthly index series.
 *   fixed        P = price
 *   escalated    P = basePrice x (1 + ratePctPerYear/100)^k, k the whole
 *                years from baseMonth to the pricing month (steps on each
 *                anniversary; months before baseMonth are refused)
 *   oil-indexed  P = constant + slope x X, X the averaged index; with an
 *                S-curve, below lowKink P = constant + slope x lowKink +
 *                lowSlope x (X - lowKink), above highKink likewise with
 *                highSlope (continuous at both kinks); then floor/ceiling
 *   hub-indexed  P = multiplier x X + adder; then floor/ceiling
 *   basket       P = basePrice x sum(w_k x X_k / base_k), each X_k first held
 *                inside its stated index floor and ceiling (CW GSA 15.1, 15.8)
 * X for delivery month t is the arithmetic mean of the index over the
 * averagingMonths months ending lagMonths months before t. Prices are reset
 * every resetMonths months counted from `from`: every month of a reset block
 * carries the price computed for the block's first month. Rounding
 * 'model-gsa-4dp' rounds each price to 4 decimals, half up on the fifth.
 * Reopener months are reported, never modelled.
 */
const priceSeriesImpl = ({ months, formula, from, to, averagingMonths = 1, lagMonths = 0, resetMonths = 1, rounding = 'none', reopeners = [] }) => {
  let e = listOf('months', months, DEFAULTS.MAX_MONTHS);
  if (e) return e;
  const series = new Map();
  let indices = null;
  for (let i = 0; i < months.length; i += 1) {
    const m = months[i];
    if (typeof m.month !== 'string' || !MONTH_RE.test(m.month)) return must(`months[${i}].month`, "a month 'YYYY-MM'", m.month);
    if (i > 0 && monthIndex(m.month) !== monthIndex(months[i - 1].month) + 1) return must(`months[${i}].month`, `${monthName(monthIndex(months[i - 1].month) + 1)}, the month after ${months[i - 1].month} (the series is consecutive)`, m.month);
    if (!isObj(m.values)) return must(`months[${i}].values`, 'an object of index values', m.values);
    const names = Object.keys(m.values).sort();
    if (indices === null) indices = names;
    else if (names.join(',') !== indices.join(',')) return refuse(`months[${i}].values`, `must carry the same indices as months[0] (${indices.join(', ')}); got ${names.join(', ') || 'none'}`);
    for (const k of names) { e = nonNeg(`months[${i}].values.${k}`, m.values[k]); if (e) return e; }
    series.set(monthIndex(m.month), m.values);
  }
  e = first(
    checkFormula(formula, indices),
    typeof from === 'string' && MONTH_RE.test(from) ? null : must('from', "a month 'YYYY-MM'", from),
    typeof to === 'string' && MONTH_RE.test(to) ? null : must('to', "a month 'YYYY-MM'", to),
    intAtLeast('averagingMonths', averagingMonths, 1), intAtLeast('lagMonths', lagMonths, 0), intAtLeast('resetMonths', resetMonths, 1),
    oneOf('rounding', rounding, ['none', 'model-gsa-4dp']),
    Array.isArray(reopeners) ? null : must('reopeners', "an array of months 'YYYY-MM'", reopeners),
  );
  if (e) return e;
  for (let i = 0; i < reopeners.length; i += 1) if (typeof reopeners[i] !== 'string' || !MONTH_RE.test(reopeners[i])) return must(`reopeners[${i}]`, "a month 'YYYY-MM'", reopeners[i]);
  const t0 = monthIndex(from);
  const t1 = monthIndex(to);
  if (t1 < t0) return must('to', `a month at or after from ${from}`, to);
  if (t1 - t0 + 1 > DEFAULTS.MAX_MONTHS) return refuse('to', `must give at most ${DEFAULTS.MAX_MONTHS} priced months; got ${t1 - t0 + 1}`);
  if (formula.type === 'escalated' && t0 < monthIndex(formula.baseMonth)) return must('from', `a month at or after formula.baseMonth ${formula.baseMonth}`, from);
  const needsIndex = formula.type !== 'fixed' && formula.type !== 'escalated';
  const names = formula.type === 'basket' ? Object.keys(formula.weights) : needsIndex ? [formula.index] : [];
  const rows = [];
  let block = null;
  for (let t = t0; t <= t1; t += 1) {
    const blockStart = t0 + Math.floor((t - t0) / resetMonths) * resetMonths;
    if (!block || block.start !== blockStart) {
      const wEnd = blockStart - lagMonths;
      const wStart = wEnd - averagingMonths + 1;
      let averages = null;
      let window = null;
      if (needsIndex) {
        const missing = [];
        for (let k = wStart; k <= wEnd; k += 1) if (!series.has(k)) missing.push(monthName(k));
        if (missing.length) return refuse('months', `must cover the averaging window ${monthName(wStart)} to ${monthName(wEnd)} for the price of ${monthName(blockStart)}; got no value for ${missing.join(', ')}`);
        averages = {};
        for (const nm of names) {
          let s = 0;
          for (let k = wStart; k <= wEnd; k += 1) s += series.get(k)[nm];
          averages[nm] = s / averagingMonths;
        }
        window = [monthName(wStart), monthName(wEnd)];
      }
      let raw;
      let segment = null;
      let clamped = null;
      let price;
      let heldIndices = null;
      if (formula.type === 'fixed') {
        price = formula.price;
      } else if (formula.type === 'escalated') {
        const k = Math.floor((blockStart - monthIndex(formula.baseMonth)) / 12);
        price = formula.basePrice * (1 + formula.ratePctPerYear / 100) ** k;
      } else if (formula.type === 'oil-indexed') {
        const v = sCurveValue(averages[formula.index], formula);
        raw = v.raw;
        segment = v.segment;
        ({ price, clamped } = clampBand(raw, formula));
      } else if (formula.type === 'hub-indexed') {
        raw = formula.multiplier * averages[formula.index] + formula.adder;
        ({ price, clamped } = clampBand(raw, formula));
      } else {
        heldIndices = {};
        let s = 0;
        for (const nm of names) {
          let x = averages[nm];
          const lo = formula.indexFloors?.[nm];
          const hi = formula.indexCeilings?.[nm];
          if (lo !== undefined && x < lo) x = lo;
          if (hi !== undefined && x > hi) x = hi;
          heldIndices[nm] = x;
          s += (formula.weights[nm] * x) / formula.baseValues[nm];
        }
        price = formula.basePrice * s;
      }
      if (price < 0) return refuse('formula', `must give a price at or above 0 in every month; got ${fmt(price)} for ${monthName(blockStart)}`);
      const unrounded = price;
      if (rounding === 'model-gsa-4dp') price = roundModel(price);
      block = { start: blockStart, window, averages, heldIndices, raw: raw ?? null, segment, clamped, unrounded, price };
    }
    rows.push({
      month: monthName(t), priceMonth: monthName(block.start), window: block.window, indexAverages: block.averages, heldIndices: block.heldIndices,
      segment: block.segment, clamped: block.clamped, unroundedPrice: block.unrounded, price: block.price, reopener: reopeners.includes(monthName(t)),
    });
  }
  const byYear = new Map();
  rows.forEach((r) => { const y = Number(r.month.slice(0, 4)); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(r.price); });
  const annual = [...byYear.entries()].map(([year, ps]) => ({ year, months: ps.length, averagePrice: sum(ps) / ps.length, lastMonthPrice: ps[ps.length - 1] }));
  return {
    months: rows,
    annual,
    reopeners: reopeners.map((m) => ({ month: m, note: `price reopener ${m}: reported only; the engine does not model the outcome of a price review` })),
    basis: {
      averaging: `index averaged over ${unit(averagingMonths, 'month')} ending ${lagMonths === 0 ? 'with the delivery month itself' : `${unit(lagMonths, 'month')} before the delivery month`}; price reset every ${unit(resetMonths, 'month')} from ${from}`,
      formula: formula.type,
      rounding: rounding === 'model-gsa-4dp' ? 'each price rounded to 4 decimals, half up on the fifth decimal (CW GSA Article 15.4), after normalising the double to 12 significant digits' : 'none',
      annual: 'annual average price = arithmetic mean of the monthly prices of the calendar year (CW GSA Article 15.2.6 Alternative 1); lastMonthPrice is Alternative 2',
      source: `${CITE.cw} Articles 15.1, 15.2.6, 15.4, 15.8; ${CITE.ecs}; ${CITE.oies}`,
    },
  };
};

/**
 * The oil-parity slope: the gas price per MMBtu that matches one dollar per
 * barrel of oil on heat content, 1 / (MMBtu per barrel). ECS prints 0.172 as
 * the theoretical heat-equivalence slope.
 */
const energyParitySlopeImpl = ({ mmbtuPerBarrel }) => {
  const e = positive('mmbtuPerBarrel', mmbtuPerBarrel);
  if (e) return e;
  return {
    mmbtuPerBarrel, slope: 1 / mmbtuPerBarrel,
    basis: { rule: 'slope = 1 / (MMBtu per barrel); gas in US$/MMBtu = slope x oil in US$/bbl on equal heat content', source: CITE.ecs },
  };
};

// ---- Nigeria: domestic prices and the delivery obligation --------------------

const SECTORS = ['power', 'commercial', 'gas-distributor', 'gas-based-industry'];

/**
 * Domestic gas prices at the marketable gas delivery point under the PIA:
 *   power              the domestic base price (s.167(5))
 *   commercial         the domestic base price + US$0.50 per MMBtu (s.167(6))
 *   gas-distributor    the negotiated price, reported against its ceiling,
 *                      the commercial price (s.167(7))
 *   gas-based-industry CP = NRP x (1 + EPF), EPF = (CMPP - PRP) / PRP, held
 *                      at or below the domestic base price (Fourth Schedule;
 *                      s.168(3)) and at or above US$0.90 per MMBtu (s.168(2))
 * The domestic base price is a REQUIRED input: the Authority determines it
 * each year (s.167(1), Third Schedule); the engine holds no default. The
 * transport tariff (s.167(8), s.168(4)) is added when stated.
 */
const domesticPriceImpl = ({ sector, domesticBasePrice, negotiatedPrice, product, cmpp, transportTariff, schedule }) => {
  let e = first(
    oneOf('sector', sector, SECTORS),
    domesticBasePrice === undefined ? must('domesticBasePrice', 'stated in US$ per MMBtu: the Authority determines it each year (PIA s.167(1)) and the engine holds no default', undefined) : positive('domesticBasePrice', domesticBasePrice),
    transportTariff !== undefined ? nonNeg('transportTariff', transportTariff) : null,
  );
  if (e) return e;
  const dbp = domesticBasePrice;
  const out = { sector, domesticBasePrice: dbp };
  let rule;
  let source;
  if (sector !== 'gas-distributor' && negotiatedPrice !== undefined) return must('negotiatedPrice', "given only for sector 'gas-distributor'", negotiatedPrice);
  if (sector !== 'gas-based-industry') {
    for (const k of ['product', 'cmpp', 'schedule']) {
      const v = { product, cmpp, schedule }[k];
      if (v !== undefined) return must(k, "given only for sector 'gas-based-industry'", v);
    }
  }
  if (sector === 'power') {
    out.price = dbp;
    rule = 'power sector price = domestic base price';
    source = 's.167(5)';
  } else if (sector === 'commercial') {
    out.price = dbp + PIA_GAS.commercialAdderUsdPerMmbtu;
    rule = 'commercial sector price = domestic base price + US$0.50 per MMBtu';
    source = 's.167(6)';
  } else if (sector === 'gas-distributor') {
    e = negotiatedPrice === undefined ? must('negotiatedPrice', 'stated for a gas distributor, which negotiates its price (PIA s.167(7))', undefined) : nonNeg('negotiatedPrice', negotiatedPrice);
    if (e) return e;
    out.ceiling = dbp + PIA_GAS.commercialAdderUsdPerMmbtu;
    out.price = negotiatedPrice;
    out.withinCeiling = negotiatedPrice <= out.ceiling;
    out.reason = out.withinCeiling
      ? `negotiated price ${fmt(negotiatedPrice)} is at or below the commercial sector price ${fmt(out.ceiling)}`
      : `negotiated price ${fmt(negotiatedPrice)} exceeds the commercial sector price ${fmt(out.ceiling)}, which s.167(7) sets as the ceiling for gas distributors`;
    rule = 'gas distributors negotiate; the price shall not exceed the commercial sector price';
    source = 's.167(7)';
  } else {
    e = oneOf('product', product, Object.keys(PIA_GAS.gbiProducts));
    if (e) return e;
    e = cmpp === undefined ? must('cmpp', 'stated: the average current month end product price in US$ per tonne (Fourth Schedule)', undefined) : nonNeg('cmpp', cmpp);
    if (e) return e;
    let nrp = PIA_GAS.gbiProducts[product].nrp;
    let prp = PIA_GAS.gbiProducts[product].prp;
    let valuesFrom = 'Fourth Schedule table';
    if (schedule !== undefined) {
      if (!isObj(schedule)) return must('schedule', 'an object { nrp, prp, source } when given', schedule);
      e = first(positive('schedule.nrp', schedule.nrp), positive('schedule.prp', schedule.prp), text('schedule.source', schedule.source));
      if (e) return e;
      nrp = schedule.nrp;
      prp = schedule.prp;
      valuesFrom = `stated by the caller: ${schedule.source} (the Authority may change NRP and PRP by regulation, Fourth Schedule)`;
    }
    if (dbp < PIA_GAS.gbiFloorUsdPerMmbtu) return must('domesticBasePrice', `at or above the gas based industries floor US$0.90 per MMBtu (s.168(2)) for a gas based industry price, which is capped at the domestic base price (s.168(3))`, dbp);
    const epf = (cmpp - prp) / prp;
    const formulaPrice = nrp * (1 + epf);
    let price = formulaPrice;
    let held = null;
    if (price > dbp) { price = dbp; held = 'ceiling'; }
    if (price < PIA_GAS.gbiFloorUsdPerMmbtu) { price = PIA_GAS.gbiFloorUsdPerMmbtu; held = 'floor'; }
    Object.assign(out, { product, cmpp, nrp, prp, epf, formulaPrice, price, heldAt: held });
    out.reason = held === 'ceiling'
      ? `the formula gives ${fmt(formulaPrice)}, above the domestic base price ${fmt(dbp)}, so the price is held at ${fmt(dbp)} (s.168(3))`
      : held === 'floor'
        ? `the formula gives ${fmt(formulaPrice)}, below the floor US$0.90 per MMBtu, so the price is held at 0.9 (s.168(2))`
        : `the formula gives ${fmt(formulaPrice)}, inside the floor 0.9 and the domestic base price ${fmt(dbp)}`;
    rule = `CP = NRP x (1 + EPF), EPF = (CMPP - PRP) / PRP, CP <= domestic base price, floor US$0.90 per MMBtu; NRP ${fmt(nrp)} and PRP ${fmt(prp)} from the ${valuesFrom}`;
    source = 's.168 and the Fourth Schedule';
  }
  if (transportTariff !== undefined) out.deliveredPrice = out.price + transportTariff;
  out.basis = {
    rule,
    point: `prices at the marketable natural gas delivery point${transportTariff !== undefined ? '; the stated transport tariff is added for the delivered price (s.167(8), s.168(4))' : ''}`,
    domesticBasePrice: 'a required input: the Authority determines it each year under the Third Schedule (s.167(1)); the engine holds no value',
    source: `${CITE.pia} ${source}`,
  };
  return out;
};

const EXCUSES = Object.freeze({
  forceMajeure: 'force majeure (s.110(10)(a))',
  purchaserCannotAccept: 'the purchaser could not accept the allocated volumes (s.110(10)(b))',
  transportUnavailable: 'the allocated gas could not be transported for reasons beyond the lessee\'s control (s.110(10)(c))',
  purchaserNonPayment: 'the purchaser failed to pay for the allocated volumes (s.110(10)(d))',
});

/**
 * The Domestic Gas Delivery Obligation of a lessee for one year (MMBtu).
 *   deemed fulfilled when voluntaryContracts >= obligation (s.110(2)(a))
 *   undelivered = max(0, obligation - delivered); the excused quantities of
 *   s.110(10) (a) to (d) are taken off, in that order, up to the undelivered
 *   quantity; the rest is penalised.
 *   rate: US$3.50 per MMBtu not delivered (s.110(8); DGDO Regulations r.6(1));
 *   with a signed agreement's rate, that rate applies but not below US$3.50
 *   (s.110(8) proviso read with r.6(2)); a Commission adjustment under
 *   s.110(9) is a stated penaltyRate { value, source }.
 * A penalised quantity above 0 also bars new export supply (s.110(14)(a),
 * s.110(15)); reported only; it carries no price.
 */
const domesticGasObligationImpl = ({ obligation, delivered, voluntaryContracts = 0, excused = {}, agreementPenaltyRate, penaltyRate }) => {
  let e = first(nonNeg('obligation', obligation), nonNeg('delivered', delivered), nonNeg('voluntaryContracts', voluntaryContracts),
    isObj(excused) ? null : must('excused', 'an object of excused quantities when given', excused));
  if (e) return e;
  for (const k of Object.keys(EXCUSES)) if (excused[k] !== undefined) { e = nonNeg(`excused.${k}`, excused[k]); if (e) return e; }
  if (agreementPenaltyRate !== undefined && penaltyRate !== undefined) return must('penaltyRate', 'left out when agreementPenaltyRate is stated (state one rate basis)', penaltyRate);
  if (agreementPenaltyRate !== undefined) { e = nonNeg('agreementPenaltyRate', agreementPenaltyRate); if (e) return e; }
  if (penaltyRate !== undefined) {
    if (!isObj(penaltyRate)) return must('penaltyRate', 'an object { value, source } when given', penaltyRate);
    e = first(nonNeg('penaltyRate.value', penaltyRate.value), text('penaltyRate.source', penaltyRate.source));
    if (e) return e;
  }
  const reasons = [];
  let rate = PIA_GAS.dgdoPenaltyUsdPerMmbtu;
  let rateRule = 'US$3.50 per MMBtu not delivered (s.110(8); DGDO Regulations 2022 r.6(1))';
  if (penaltyRate !== undefined) {
    rate = penaltyRate.value;
    rateRule = `${fmt(rate)} per MMBtu as adjusted by the Commission under s.110(9): ${penaltyRate.source}`;
  } else if (agreementPenaltyRate !== undefined) {
    rate = Math.max(agreementPenaltyRate, PIA_GAS.dgdoPenaltyUsdPerMmbtu);
    rateRule = agreementPenaltyRate >= PIA_GAS.dgdoPenaltyUsdPerMmbtu
      ? `the agreement's rate ${fmt(agreementPenaltyRate)} per MMBtu (s.110(8) proviso), at or above the US$3.50 minimum of r.6(2)`
      : `the agreement's rate ${fmt(agreementPenaltyRate)} per MMBtu is below the US$3.50 minimum of r.6(2), so 3.5 applies`;
  }
  const deemedFulfilled = voluntaryContracts >= obligation;
  const undelivered = Math.max(0, obligation - delivered);
  const excusedRows = [];
  let left = deemedFulfilled ? 0 : undelivered;
  for (const k of Object.keys(EXCUSES)) {
    const q = excused[k] ?? 0;
    if (q > 0) {
      const used = Math.min(q, left);
      left -= used;
      excusedRows.push({ ground: k, stated: q, applied: used });
    }
  }
  const excusedApplied = sum(excusedRows.map((r) => r.applied));
  const penalised = deemedFulfilled ? 0 : undelivered - excusedApplied;
  const penalty = penalised * rate;
  if (deemedFulfilled) {
    reasons.push(`voluntary contracts of ${fmt(voluntaryContracts)} are at or above the obligation ${fmt(obligation)}: the lessee is deemed to have fulfilled its obligation (s.110(2)(a))`);
  } else if (undelivered === 0) {
    reasons.push(`delivered ${fmt(delivered)} meets the obligation ${fmt(obligation)}`);
  } else {
    reasons.push(`delivered ${fmt(delivered)} against the obligation ${fmt(obligation)} leaves ${fmt(undelivered)} undelivered`);
    excusedRows.filter((r) => r.applied > 0).forEach((r) => reasons.push(`${fmt(r.applied)} is excused: ${EXCUSES[r.ground]}`));
    if (penalised > 0) reasons.push(`${fmt(penalised)} is penalised at ${fmt(rate)} per MMBtu: ${fmt(penalty)}; the lessee may not supply new midstream gas export operations (s.110(14)(a)) and export supply approvals require prior compliance (s.110(15))`);
    else reasons.push('the whole undelivered quantity is excused; no penalty');
  }
  return {
    obligation, delivered, voluntaryContracts, deemedFulfilled, undelivered, excused: excusedRows, excusedApplied, penalised, rate, penalty,
    exportRestriction: penalised > 0,
    reasons,
    basis: {
      rule: 'undelivered = obligation - delivered when positive; the s.110(10) excuses apply in the order (a) to (d) up to the undelivered quantity; penalty = penalised quantity x rate',
      rate: rateRule,
      notReported: 'the 90-day investigation rule of r.6(3) and the compensation to customer-clients of s.110(13) are not computed',
      source: `${CITE.pia} s.110; ${CITE.dgdoRegs} r.6`,
    },
  };
};

// ---- cash flows and NPV ------------------------------------------------------

/**
 * The GSA revenue stream of the take-or-pay reconciliation, the PIA gas
 * royalty on the value of gas delivered (taken x contract price; a deficiency
 * payment is money for gas not produced and carries no royalty here, the gas
 * pays royalty when it is made up), and the NPV of the seller's net cash
 * through the canonical npv (year-end, discounted to baseYear).
 */
const gsaCashFlowsImpl = ({ contract, royalty, discountRate, baseYear }) => {
  if (!isObj(contract)) return must('contract', 'an object of takeOrPay inputs', contract);
  let e = checkTopArgs(contract, 'contract.');
  if (e) return e;
  if (!isObj(royalty)) return must('royalty', 'an object { terrain, inCountrySharePct } (no default terrain)', royalty);
  e = first(oneOf('royalty.terrain', royalty.terrain, ['onshore', 'shallow_water', 'deep_offshore', 'frontier']),
    royalty.inCountrySharePct !== undefined ? pct('royalty.inCountrySharePct', royalty.inCountrySharePct) : null,
    fin(discountRate) && discountRate > -1 ? null : must('discountRate', 'a finite number above -1', discountRate),
    intAtLeast('baseYear', baseYear, 1));
  if (e) return e;
  const share = royalty.inCountrySharePct ?? 0;
  const rate = deriveGasRoyaltyRate(royalty.terrain, share);
  const top = takeOrPayCore(contract);
  const rows = top.years.map((r, i) => {
    const deliveredValue = r.taken * contract.years[i].contractPrice;
    const royaltyAmount = rate * deliveredValue;
    return {
      year: r.year, sellerRevenue: r.netToSeller, deliveredValue, royaltyRate: rate, royalty: royaltyAmount, netAfterRoyalty: r.netToSeller - royaltyAmount,
      lines: { regular: r.regularRevenue, makeUp: r.makeUpRevenue, deficiencyPayment: r.deficiencyPayment, shortfallPayment: -r.shortfallPayment, refund: -r.refund },
    };
  });
  const firstYear = rows[0].year;
  const net = rows.map((r) => r.netAfterRoyalty);
  const gross = rows.map((r) => r.sellerRevenue);
  return {
    years: rows,
    royaltyRate: rate,
    npvSellerRevenue: npv(gross, discountRate, baseYear, firstYear),
    npvNetAfterRoyalty: npv(net, discountRate, baseYear, firstYear),
    takeOrPay: top,
    basis: {
      royalty: `gas royalty rate ${fmt(rate)} from engines/economics/cashflow.ts deriveGasRoyaltyRate (${royalty.terrain}, ${fmt(share)}% utilised in-country: 5%, 2.5% in-country, PIA Seventh Schedule para 10(6)) on the value of gas delivered (taken x contract price); deficiency payments carry no royalty here`,
      npv: `canonical npv from engines/economics/cashflow.ts, year-end flows discounted to ${baseYear} at ${fmt(discountRate)}`,
      source: `${CITE.pia} Seventh Schedule para 10(6); ${CITE.cw} Articles 12.5 to 12.8`,
    },
  };
};

// ---- public entry points: every one checks its accepted keys first ------------

export const toEnergy = guard('toEnergy', toEnergyImpl);
export const contractQuantities = guard('contractQuantities', contractQuantitiesImpl);
export const dailyBalance = guard('dailyBalance', dailyBalanceImpl);
export const takeOrPay = guard('takeOrPay', takeOrPayImpl);
export const priceSeries = guard('priceSeries', priceSeriesImpl);
export const energyParitySlope = guard('energyParitySlope', energyParitySlopeImpl);
export const domesticPrice = guard('domesticPrice', domesticPriceImpl);
export const domesticGasObligation = guard('domesticGasObligation', domesticGasObligationImpl);
export const gsaCashFlows = guard('gsaCashFlows', gsaCashFlowsImpl);
