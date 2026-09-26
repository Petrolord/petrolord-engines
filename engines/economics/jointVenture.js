/**
 * Joint ventures, operating agreements and cost recovery (Economics EC9):
 * participating (beneficial) and paying interests with carries, monthly cash
 * calls with the over/under-call carried to a later call, budget control
 * against stated tolerances, operator overhead on a stated sliding scale, a
 * party's default on a cash call (pro rata cover, default interest, the
 * stated consequences), the recovery of a carry from the carried party's
 * production share, a back-in (state participation under PIA 2021 s.85(4)),
 * sole risk / non-consent premium recovery or buy-in, and the PSC cost pool
 * of engines/economics/cashflow.ts run year by year and split between
 * partners. All deterministic.
 *
 * Pure functions, no I/O. Every function returns either a result object
 * carrying a `basis` (the rules applied and where they come from, so a course
 * can print the working) or `{ error, field }`, where `field` names the input
 * refused and the message starts with that name. Every refusal reads
 * "<field> must <condition>; got <value>" (or, for an unknown key,
 * "<field> is not an accepted key; ...").
 *
 * Sources (FINDINGS-jointVenture.md has URLs, editions and the dates read):
 *   NO JOA    Norway, Ministry of Petroleum and Energy, Agreement concerning
 *             petroleum activities, Attachment A Joint Operating Agreement
 *             (unofficial English translation, the 2007 text): Art. 8.1
 *             (contribution by Participating interest), Art. 9 (default: the
 *             non-defaulting Parties advance the unpaid amounts in accordance
 *             with their Participating interest; penal interest; loss of vote
 *             and data after five working days; assignment after three months;
 *             pro rata apportionment, 9.4), Art. 12.5 (a budget item may be
 *             exceeded by up to 10%; a budget by no more than the lower of 5%
 *             or NOK 75 million), Art. 18 (sole risk; 18.6 participation in
 *             proportion to Participating interest; 18.12 entry at one
 *             thousand (1000) % of the proportionate share of the costs,
 *             apportioned to the initial participants).
 *   NO AA     the same Agreement, Attachment B Accounting Agreement: Art.
 *             1.2.1 (monthly advances; the difference between advances and
 *             actual payments adjusts the next request; refund or transfer of
 *             an excess; no cash call below a stated monthly amount), 1.2.2
 *             (interest on late payment from and including the due date to,
 *             but excluding, the value date; distributed to the Parties
 *             financing the default), 2.2.2 (a per cent scale on annual
 *             exploration, operating and development cost in bands) and 2.2.3
 *             (0.65 % for corporate management and staff).
 *   PIA       Petroleum Industry Act 2021 (Act No. 6) s.85(4) (the carried
 *             interest provision: participation up to 60%; refund of the
 *             proportionate share of unrecovered proven costs relating to
 *             development and production, excluding bonuses and penalties,
 *             interest, premium or markups on cost; in cash or in kind from
 *             future production) and s.311(2)(a)(iii) (renegotiated PSCs: a
 *             cost oil limit of not more than 60% of total oil production).
 *   cashflow  applyPSC and npv imported from engines/economics/cashflow.ts;
 *             never re-implemented.
 *   afe       calculatePartnerCosts imported from engines/economics/afe.js for
 *             every split of a joint account amount between parties.
 *
 * Conventions, stated once:
 *   money       one currency throughout a call.
 *   percentages 0 to 100 on input (participatingPct 40 is 40%).
 *   parties     participatingPct is the beneficial interest (the share of
 *               production and of the licence); payingPct is the share of
 *               cost the party pays, which differs only under a carry.
 *   dates       'YYYY-MM-DD'; months 'YYYY-MM'; years consecutive integers.
 *   reasons     figures print as the shortest round-trip decimal.
 *   NPV         the canonical engines/economics/cashflow.ts npv, year-end.
 *
 * Validation: tools/validation/economics/oracle_jointventure.py (stdlib
 * python) writes test-data/economics/goldens/jointventure_cases.json;
 * FINDINGS-jointVenture.md, negcontrol_jointventure.sh,
 * timing_jointventure.js. Fixtures (synthetic Ekene joint venture):
 * test-data/economics/ekene-jv/.
 */

import { applyPSC, npv } from './cashflow.ts';
import { calculatePartnerCosts } from './afe.js';

export const DEFAULTS = Object.freeze({
  MAX_PARTIES: 20,
  MAX_YEARS: 100,
  MAX_MONTHS: 600,
  MAX_ITEMS: 200,
  MAX_BANDS: 20,
  SUM_TOLERANCE: 1e-9,
});

/** Petroleum Industry Act 2021 figures read from the gazetted text. */
export const PIA_JV = Object.freeze({
  maxGovernmentParticipationPct: 60, // s.85(4)(a)
  refundableKinds: Object.freeze(['development', 'production']), // s.85(4)(c)
  renegotiatedPscCostOilLimitPct: 60, // s.311(2)(a)(iii), a ceiling on the contract figure
});

const CITE = Object.freeze({
  pia: 'Petroleum Industry Act 2021 (Act No. 6), Official Gazette No. 142, Vol. 108, 27 August 2021',
  joa: 'Norway, Agreement concerning petroleum activities, Attachment A Joint Operating Agreement (unofficial English translation, 2007 text)',
  aa: 'Norway, Agreement concerning petroleum activities, Attachment B Accounting Agreement (unofficial English translation, 2007 text)',
});

// ---- helpers ---------------------------------------------------------------

const refuse = (field, message) => ({ error: `${field} ${message}`, field });
const fmt = (x) => String(x);
const show = (v) => (v === undefined ? 'nothing' : typeof v === 'number' ? fmt(v) : typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
const must = (field, cond, v) => refuse(field, `must be ${cond}; got ${show(v)}`);
const unit = (x, one, many = `${one}s`) => `${fmt(x)} ${x === 1 ? one : many}`;
// money in reasons prints rounded to the cent (half away from zero), trailing zeros dropped;
// numeric fields keep full precision.
const money = (x) => fmt(Number(x.toFixed(2)));
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const sum = (xs) => xs.reduce((s, v) => s + v, 0);
const first = (...checks) => checks.find((c) => c) || null;
const DAY_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const nonNeg = (field, v) => (fin(v) && v >= 0 ? null : must(field, 'a finite number at or above 0', v));
const positive = (field, v) => (fin(v) && v > 0 ? null : must(field, 'a finite number above 0', v));
const pct = (field, v) => (fin(v) && v >= 0 && v <= 100 ? null : must(field, 'a number from 0 to 100', v));
const pctPos = (field, v) => (fin(v) && v > 0 && v <= 100 ? null : must(field, 'a number above 0 and at most 100', v));
const intAtLeast = (field, v, lo) => (Number.isInteger(v) && v >= lo ? null : must(field, `an integer at or above ${lo}`, v));
const oneOf = (field, v, opts) => (opts.includes(v) ? null : must(field, `one of ${opts.map((o) => `"${o}"`).join(', ')}`, v));
const text = (field, v) => (typeof v === 'string' && v.trim() !== '' ? null : must(field, 'a non-empty string', v));
const listOf = (field, v, max) => {
  if (!Array.isArray(v) || v.length < 1) return must(field, 'an array of at least 1 entry', v);
  if (v.length > max) return refuse(field, `must have at most ${max} entries; got ${v.length}`);
  for (let i = 0; i < v.length; i += 1) if (!isObj(v[i])) return must(`${field}[${i}]`, 'an object', v[i]);
  return null;
};
const realDate = (field, v) => {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return must(field, "a real date 'YYYY-MM-DD'", v);
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return must(field, "a real date 'YYYY-MM-DD'", v);
  return null;
};
const dayNo = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
const dayName = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

// ---- accepted keys ---------------------------------------------------------
//
// Every public function refuses an input key it does not read, at every
// level, so a misspelt optional key is never dropped silently. Keys whose
// value is undefined count as absent. Keys that are party ids or category
// names (carriers shares, overhead costs and scales) are checked by the
// function that reads them.
const O = (keys, children = {}) => ({ t: 'obj', keys, children });
const L = (of) => ({ t: 'list', of });
const FREE = { t: 'free' };
const PARTY = O(['id', 'name', 'participatingPct']);
const CARRY = O(['carried', 'carriedPct', 'carriers']);
const UPLIFT = O(['type', 'ratePctPerYear', 'multiplePct']);
const CONSEQ = O(['after', 'unit', 'from']);
export const ACCEPTED_KEYS = Object.freeze({
  participatingInterests: O(['parties', 'carries'], { parties: L(PARTY), carries: L(CARRY) }),
  cashCalls: O(['parties', 'carries', 'months', 'reconciliationLagMonths', 'negativeCall', 'noCallBelow'], {
    parties: L(PARTY), carries: L(CARRY), months: L(O(['month', 'forecast', 'actual'])),
  }),
  budgetControl: O(['items', 'itemTolerancePct', 'budgetTolerance', 'unbudgetedAllowance'], {
    items: L(O(['item', 'approved', 'actual'])), budgetTolerance: O(['pct', 'amount']),
  }),
  overhead: O(['costs', 'excluded', 'scale'], { costs: FREE, excluded: FREE, scale: FREE }),
  defaultCover: O(['parties', 'carries', 'callTotal', 'dueDate', 'asOf', 'defaulters', 'interest', 'suspension', 'forfeiture', 'holidays'], {
    parties: L(PARTY), carries: L(CARRY), defaulters: L(O(['id', 'paid', 'curedOn'])), interest: O(['annualRatePct', 'dayBasis', 'interestMethod', 'graceHours']),
    suspension: CONSEQ, forfeiture: CONSEQ,
  }),
  carryRecovery: O(['parties', 'carries', 'carried', 'years', 'uplift', 'recoverFromPct', 'cap', 'basis', 'discountRate', 'baseYear'], {
    parties: L(PARTY), carries: L(CARRY), years: L(O(['year', 'cost', 'entitlement'])), uplift: UPLIFT,
  }),
  backIn: O(['parties', 'backInParty', 'targetPct', 'costs', 'basis', 'refundableKinds', 'refundForm', 'recoverFromPct', 'years'], {
    parties: L(PARTY), costs: L(O(['item', 'amount', 'kind'])), years: L(O(['year', 'entitlement'])),
  }),
  nonConsent: O(['parties', 'consenting', 'operation', 'premiumMultiplePct', 'mode', 'years'], {
    parties: L(PARTY), operation: O(['name', 'cost']), years: L(O(['year', 'grossValue', 'deductions'])),
  }),
  pscCostRecovery: O(['years', 'royaltyPct', 'costOilLimitPct', 'costOilLimitBase', 'contractorProfitSharePct', 'taxRatePct', 'openingCostPool', 'parties', 'discountRate', 'baseYear'], {
    years: L(O(['year', 'grossRevenue', 'capex', 'opex', 'contractorProfitSharePct'])), parties: L(PARTY),
  }),
});

const unknownKey = (path, key, keys) => refuse(path ? `${path}.${key}` : key, `is not an accepted key; the accepted keys ${path ? `of ${path}` : 'at the top level'} are ${keys.join(', ')}`);
const walkKeys = (v, spec, path) => {
  if (spec.t === 'free') return null;
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

// ---- parties and interests ---------------------------------------------------

const checkParties = (parties, pre = 'parties') => {
  let e = listOf(pre, parties, DEFAULTS.MAX_PARTIES);
  if (e) return e;
  const seen = new Set();
  for (let i = 0; i < parties.length; i += 1) {
    const p = parties[i];
    e = first(text(`${pre}[${i}].id`, p.id), p.name !== undefined ? text(`${pre}[${i}].name`, p.name) : null, pctPos(`${pre}[${i}].participatingPct`, p.participatingPct));
    if (e) return e;
    if (seen.has(p.id)) return must(`${pre}[${i}].id`, 'an id no other party has', p.id);
    seen.add(p.id);
  }
  const total = sum(parties.map((p) => p.participatingPct));
  if (Math.abs(total - 100) > DEFAULTS.SUM_TOLERANCE) return refuse(pre, `must have participatingPct summing to 100; got a sum of ${fmt(total)}`);
  return null;
};

const ids = (parties) => parties.map((p) => p.id);

const checkCarries = (carries, parties) => {
  if (carries === undefined || !Array.isArray(parties)) return null;
  if (!Array.isArray(carries)) return must('carries', 'an array of carries when given', carries);
  if (carries.length > DEFAULTS.MAX_PARTIES) return refuse('carries', `must have at most ${DEFAULTS.MAX_PARTIES} entries; got ${carries.length}`);
  const pid = ids(parties);
  const carried = new Set();
  for (let i = 0; i < carries.length; i += 1) {
    const c = carries[i];
    const f = `carries[${i}]`;
    if (!isObj(c)) return must(f, 'an object', c);
    if (!pid.includes(c.carried)) return must(`${f}.carried`, `the id of a party (${pid.join(', ')})`, c.carried);
    if (carried.has(c.carried)) return must(`${f}.carried`, 'a party no other carry names', c.carried);
    carried.add(c.carried);
    const e = pctPos(`${f}.carriedPct`, c.carriedPct);
    if (e) return e;
  }
  for (let i = 0; i < carries.length; i += 1) {
    const c = carries[i];
    const f = `carries[${i}].carriers`;
    if (c.carriers === 'pro-rata') continue;
    if (!isObj(c.carriers)) return must(f, '"pro-rata" or an object of carrier shares in per cent (no default)', c.carriers);
    const names = Object.keys(c.carriers).filter((k) => c.carriers[k] !== undefined);
    if (names.length === 0) return must(f, '"pro-rata" or an object of carrier shares in per cent (no default)', c.carriers);
    for (const k of names) {
      if (!pid.includes(k)) return refuse(`${f}.${k}`, `is not a party; the parties are ${pid.join(', ')}`);
      if (carried.has(k)) return refuse(`${f}.${k}`, 'is a carried party and cannot carry another');
      const e = pctPos(`${f}.${k}`, c.carriers[k]);
      if (e) return e;
    }
    const tot = sum(names.map((k) => c.carriers[k]));
    if (Math.abs(tot - 100) > DEFAULTS.SUM_TOLERANCE) return refuse(f, `must sum to 100; got a sum of ${fmt(tot)}`);
  }
  if (carried.size === parties.length) return must('carries', 'leaving at least one party that is not carried', carries.map((c) => c.carried));
  return null;
};

/**
 * Paying interests. A carry takes carriedPct % of the carried party's cost
 * share off it and puts that amount on its carriers: in the stated shares, or
 * 'pro-rata' to the carriers' participating interests, the carriers being
 * every party no carry names as carried. The beneficial interest (the share
 * of production) is the participating interest throughout.
 */
const interestsCore = (parties, carries = []) => {
  const carriedIds = new Set(carries.map((c) => c.carried));
  const payers = parties.filter((p) => !carriedIds.has(p.id));
  const payerTotal = sum(payers.map((p) => p.participatingPct));
  const extra = Object.fromEntries(parties.map((p) => [p.id, 0]));
  const rows = parties.map((p) => ({ id: p.id, name: p.name ?? null, beneficialPct: p.participatingPct, payingPct: p.participatingPct, carriedPct: 0, carryShares: [] }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const carryRows = [];
  for (const c of carries) {
    const cp = byId[c.carried].beneficialPct;
    const amount = (cp * c.carriedPct) / 100;
    byId[c.carried].payingPct -= amount;
    byId[c.carried].carriedPct = c.carriedPct;
    const alloc = c.carriers === 'pro-rata'
      ? payers.map((p) => ({ id: p.id, sharePct: (p.participatingPct * 100) / payerTotal, pct: (amount * p.participatingPct) / payerTotal, num: p.participatingPct, den: payerTotal }))
      : Object.keys(c.carriers).filter((k) => c.carriers[k] !== undefined).map((k) => ({ id: k, sharePct: c.carriers[k], pct: (amount * c.carriers[k]) / 100, num: c.carriers[k], den: 100 }));
    alloc.forEach((a) => { extra[a.id] += a.pct; byId[a.id].carryShares.push({ carried: c.carried, sharePct: a.sharePct, pct: a.pct }); });
    carryRows.push({ carried: c.carried, carriedPct: c.carriedPct, carriedInterestPct: amount, rule: c.carriers === 'pro-rata' ? 'pro-rata' : 'stated', carriers: alloc.map(({ num: _n, den: _d, ...a }) => a), weights: alloc });
  }
  rows.forEach((r) => { r.payingPct += extra[r.id]; });
  return { rows, carries: carryRows };
};

const interestsImpl = ({ parties, carries }) => {
  const e = first(checkParties(parties), checkCarries(carries, parties));
  if (e) return e;
  const { rows, carries: raw } = interestsCore(parties, carries);
  const cr = raw.map(({ weights: _w, ...c }) => c);
  const reasons = cr.map((c) => `${c.carried}: ${fmt(c.carriedPct)}% of its ${fmt(rows.find((r) => r.id === c.carried).beneficialPct)}% cost share is carried (${fmt(c.carriedInterestPct)} points), paid by ${c.carriers.map((a) => `${a.id} ${fmt(a.pct)}`).join(', ')} (${c.rule === 'pro-rata' ? 'pro rata to their participating interests' : 'in the stated shares'}); its share of production stays ${fmt(rows.find((r) => r.id === c.carried).beneficialPct)}%`);
  return {
    parties: rows,
    carries: cr,
    totals: { beneficialPct: sum(rows.map((r) => r.beneficialPct)), payingPct: sum(rows.map((r) => r.payingPct)) },
    reasons,
    basis: {
      rule: 'beneficial interest = participating interest (the share of production); paying interest = participating interest - the carried part of a carried party\'s share + the carriers\' shares of every carry',
      carriers: "carriers 'pro-rata' share a carry in proportion to their participating interests among the parties no carry names as carried; stated shares must sum to 100",
      source: `${CITE.joa} Art. 8.1 (contribution in accordance with the Participating interest); ${CITE.pia} s.85(4) (the carried interest provision)`,
    },
  };
};

/** Split an amount by the paying interests through the canonical afe split. */
const splitBy = (amount, rows, key) => {
  const r = calculatePartnerCosts(amount, rows.map((x) => ({ id: x.id, working_interest: x[key] })));
  return Object.fromEntries(r.partnerAllocations.map((a) => [a.id, a.shareAmount]));
};

// ---- cash calls ---------------------------------------------------------------

/**
 * Monthly cash calls on a joint account. For month t and each party i:
 *   forecast share = forecast_t x payingPct_i / 100 (the afe split)
 *   difference d_t = forecast share - actual share (over-call above 0), for a
 *     month with a call; a month without a call has d_t = 0 and its actual
 *     share is billed in arrears in month t+1.
 *   pending_t = d_(t - lag) + the amount carried from month t-1
 *   call_t = forecast share - pending_t, when a call is made. A negative
 *     call is paid back ('refund') or held to the next call ('carry'), as
 *     stated. Without a call, pending_t carries whole.
 * The cash balance of a party with the operator (advances + arrears paid -
 * actual shares) equals the differences not yet adjusted plus the amount
 * carried, less arrears billed and not yet paid.
 */
const cashCallsImpl = ({ parties, carries, months, reconciliationLagMonths, negativeCall, noCallBelow }) => {
  let e = first(checkParties(parties), checkCarries(carries, parties), listOf('months', months, DEFAULTS.MAX_MONTHS),
    intAtLeast('reconciliationLagMonths', reconciliationLagMonths, 1), oneOf('negativeCall', negativeCall, ['refund', 'carry']),
    noCallBelow !== undefined ? nonNeg('noCallBelow', noCallBelow) : null);
  if (e) return e;
  for (let i = 0; i < months.length; i += 1) {
    const m = months[i];
    const f = `months[${i}]`;
    if (typeof m.month !== 'string' || !MONTH_RE.test(m.month)) return must(`${f}.month`, "a month 'YYYY-MM'", m.month);
    if (i > 0) {
      const [y, mo] = months[i - 1].month.split('-').map(Number);
      const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
      if (m.month !== next) return must(`${f}.month`, `${next}, the month after ${months[i - 1].month} (the months are consecutive)`, m.month);
    }
    e = first(nonNeg(`${f}.forecast`, m.forecast), nonNeg(`${f}.actual`, m.actual));
    if (e) return e;
  }
  const { rows } = interestsCore(parties, carries);
  const pid = ids(parties);
  const lag = reconciliationLagMonths;
  const diffs = [];
  const carried = Object.fromEntries(pid.map((id) => [id, 0]));
  const balance = Object.fromEntries(pid.map((id) => [id, 0]));
  let arrears = null;
  let arrearsFrom = null;
  const out = [];
  months.forEach((m, t) => {
    const reasons = [];
    const called = noCallBelow === undefined || m.forecast >= noCallBelow;
    const fs = splitBy(m.forecast, rows, 'payingPct');
    const as = splitBy(m.actual, rows, 'payingPct');
    const due = t - lag >= 0 ? diffs[t - lag] : null;
    const dueTotal = t - lag >= 0 ? months[t - lag] : null;
    const carriedIn = sum(pid.map((id) => carried[id]));
    const partyRows = pid.map((id) => {
      const pending = (due ? due[id] : 0) + carried[id];
      let call = 0;
      let carryOut = 0;
      if (called) {
        const raw = fs[id] - pending;
        if (raw >= 0 || negativeCall === 'refund') call = raw; else carryOut = -raw;
      } else {
        carryOut = pending;
      }
      const arrearsBilling = arrears ? arrears[id] : 0;
      const d = called ? fs[id] - as[id] : 0;
      balance[id] += call + arrearsBilling - as[id];
      carried[id] = carryOut;
      const row = rows.find((r) => r.id === id);
      return { id, payingPct: row.payingPct, forecastShare: fs[id], adjustment: pending, call, arrearsBilling, paid: call + arrearsBilling, actualShare: as[id], difference: d, carried: carryOut, balance: balance[id] };
    });
    if (arrears) reasons.push(`${m.month}: the actual of ${arrearsFrom.month}, ${money(arrearsFrom.actual)}, made without a cash call, is billed in arrears`);
    if (!called) reasons.push(`${m.month}: no cash call: the forecast ${money(m.forecast)} is below the stated threshold ${money(noCallBelow)}; the actual is billed in arrears in the next month`);
    const where = called ? 'this cash call' : 'the next cash call (none is made this month)';
    if (due && dueTotal && (noCallBelow === undefined || dueTotal.forecast >= noCallBelow)) {
      const net = dueTotal.forecast - dueTotal.actual;
      if (net > 0) reasons.push(`${m.month}: the over-call of ${money(net)} in ${dueTotal.month} (forecast ${money(dueTotal.forecast)}, actual ${money(dueTotal.actual)}) is credited against ${where}, ${unit(lag, 'month')} later`);
      else if (net < 0) reasons.push(`${m.month}: the under-call of ${money(-net)} in ${dueTotal.month} (forecast ${money(dueTotal.forecast)}, actual ${money(dueTotal.actual)}) is added to ${where}, ${unit(lag, 'month')} later`);
      else reasons.push(`${m.month}: ${dueTotal.month} was called exactly (forecast = actual = ${money(dueTotal.actual)}); no adjustment`);
    }
    if (carriedIn > 0) reasons.push(`${m.month}: a credit of ${money(carriedIn)} held from ${months[t - 1].month} is applied to ${where}`);
    else if (carriedIn < 0) reasons.push(`${m.month}: ${money(-carriedIn)} owed from ${months[t - 1].month} is added to ${where}`);
    if (called && m.forecast === 0) reasons.push(`${m.month}: a forecast of 0: the cash call is the adjustment alone`);
    const neg = partyRows.filter((r) => r.call < 0);
    if (neg.length) reasons.push(`${m.month}: the adjustment exceeds the forecast share of ${neg.map((r) => r.id).join(', ')}: the excess is refunded (a negative call)`);
    const held = partyRows.filter((r) => called && r.carried > 0);
    if (held.length) reasons.push(`${m.month}: the adjustment exceeds the forecast share of ${held.map((r) => r.id).join(', ')}: the call is 0 and the rest of the credit is carried to the next cash call`);
    diffs.push(Object.fromEntries(partyRows.map((r) => [r.id, r.difference])));
    arrears = called ? null : as;
    arrearsFrom = called ? null : m;
    const tot = (k) => sum(partyRows.map((r) => r[k]));
    out.push({
      month: m.month, forecast: m.forecast, actual: m.actual, called,
      parties: partyRows,
      totals: { call: tot('call'), arrearsBilling: tot('arrearsBilling'), paid: tot('paid'), actualShare: tot('actualShare'), difference: tot('difference') },
      reasons,
    });
  });
  const unadjusted = Object.fromEntries(pid.map((id) => [id, 0]));
  for (let t = Math.max(0, months.length - lag); t < months.length; t += 1) pid.forEach((id) => { unadjusted[id] += diffs[t][id]; });
  const closing = pid.map((id) => ({
    id, balance: balance[id], unadjustedDifferences: unadjusted[id], carried: carried[id], arrearsDue: arrears ? arrears[id] : 0,
  }));
  return {
    months: out,
    closing,
    totals: { called: sum(out.map((r) => r.totals.call)), arrearsBilled: sum(out.map((r) => r.totals.arrearsBilling)), actual: sum(months.map((m) => m.actual)) },
    basis: {
      rule: 'forecast share = forecast x paying interest; difference = forecast share - actual share for a month with a call; call = forecast share - (the difference of the month reconciliationLagMonths earlier + any amount carried)',
      lag: `the difference of a month adjusts the cash call ${unit(lag, 'month')} later (a stated input, no default)`,
      negativeCall: negativeCall === 'refund' ? 'an adjustment above the forecast share is refunded as a negative call' : 'an adjustment above the forecast share makes the call 0 and the rest is carried to the next call',
      threshold: noCallBelow === undefined ? 'every month is called' : `no cash call in a month whose forecast is below ${fmt(noCallBelow)}; its actual share is billed in arrears the next month`,
      identity: 'balance with the operator = differences not yet adjusted + carried - arrears billed and not yet paid',
      split: 'every split of a joint account amount is calculatePartnerCosts from engines/economics/afe.js on the paying interests',
      source: `${CITE.aa} Art. 1.2.1; ${CITE.joa} Art. 8.1`,
    },
  };
};

// ---- budget control ------------------------------------------------------------

/**
 * Actual spend against an approved budget, item by item and in total. An
 * item is inside its tolerance when actual <= approved x (100 +
 * itemTolerancePct) / 100 (so an overrun of exactly the tolerance is inside);
 * the budget is inside its tolerance when the overrun of the total is at or
 * below the lower of pct % of the approved total and the stated amount. An
 * unbudgeted item (approved 0) is counted against unbudgetedAllowance when
 * one is stated and is outside the budget otherwise.
 */
const budgetImpl = ({ items, itemTolerancePct, budgetTolerance, unbudgetedAllowance }) => {
  let e = first(listOf('items', items, DEFAULTS.MAX_ITEMS), nonNeg('itemTolerancePct', itemTolerancePct));
  if (e) return e;
  if (!isObj(budgetTolerance)) return must('budgetTolerance', 'an object { pct, amount } (amount optional; no default)', budgetTolerance);
  e = first(nonNeg('budgetTolerance.pct', budgetTolerance.pct), budgetTolerance.amount !== undefined ? nonNeg('budgetTolerance.amount', budgetTolerance.amount) : null,
    unbudgetedAllowance !== undefined ? nonNeg('unbudgetedAllowance', unbudgetedAllowance) : null);
  if (e) return e;
  const seen = new Set();
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    e = first(text(`items[${i}].item`, it.item), nonNeg(`items[${i}].approved`, it.approved), nonNeg(`items[${i}].actual`, it.actual));
    if (e) return e;
    if (seen.has(it.item)) return must(`items[${i}].item`, 'a name no other item has', it.item);
    seen.add(it.item);
  }
  const reasons = [];
  const unbudgeted = items.filter((it) => it.approved === 0 && it.actual > 0);
  const unbudgetedTotal = sum(unbudgeted.map((it) => it.actual));
  const unbudgetedInside = unbudgetedAllowance !== undefined && unbudgetedTotal <= unbudgetedAllowance;
  const rows = items.map((it) => {
    const limit = (it.approved * (100 + itemTolerancePct)) / 100;
    const overrun = it.actual - it.approved;
    let within;
    if (it.approved === 0) {
      within = it.actual === 0 || unbudgetedInside;
      if (it.actual > 0) reasons.push(`${it.item}: ${money(it.actual)} spent with no approved budget${unbudgetedAllowance === undefined ? ': outside the approved budget' : unbudgetedInside ? `, inside the unbudgeted allowance ${money(unbudgetedAllowance)} with the other unbudgeted items (${money(unbudgetedTotal)} in all)` : `: the unbudgeted items total ${money(unbudgetedTotal)}, above the allowance ${money(unbudgetedAllowance)}`}`);
    } else {
      within = it.actual <= limit;
      if (overrun > 0) reasons.push(`${it.item}: ${money(it.actual)} against ${money(it.approved)} approved is an overrun of ${money(overrun)}, ${within ? 'inside' : 'beyond'} the item tolerance of ${fmt(itemTolerancePct)}% (limit ${money(limit)})`);
    }
    return { item: it.item, approved: it.approved, actual: it.actual, overrun, overrunPct: it.approved > 0 ? (overrun * 100) / it.approved : null, limit: it.approved > 0 ? limit : null, withinItemTolerance: within };
  });
  const approved = sum(items.map((it) => it.approved));
  const actual = sum(items.map((it) => it.actual));
  const byPct = (approved * budgetTolerance.pct) / 100;
  const allowed = budgetTolerance.amount === undefined ? byPct : Math.min(byPct, budgetTolerance.amount);
  const overrun = actual - approved;
  const withinBudget = overrun <= allowed;
  const heldBy = budgetTolerance.amount === undefined ? 'pct' : byPct <= budgetTolerance.amount ? 'pct' : 'amount';
  reasons.push(`the budget: ${money(actual)} against ${money(approved)} approved, ${overrun > 0 ? `an overrun of ${money(overrun)}` : overrun < 0 ? `an underrun of ${money(-overrun)}` : 'on budget'}; the allowed overrun is ${budgetTolerance.amount === undefined ? `${fmt(budgetTolerance.pct)}% of the approved total, ${money(allowed)}` : `the lower of ${fmt(budgetTolerance.pct)}% of the approved total (${money(byPct)}) and ${money(budgetTolerance.amount)}: ${money(allowed)}`}; ${withinBudget ? 'inside' : 'beyond'} the budget tolerance`);
  return {
    items: rows,
    total: { approved, actual, overrun, allowedOverrun: allowed, heldBy, withinBudgetTolerance: withinBudget },
    unbudgeted: { total: unbudgetedTotal, allowance: unbudgetedAllowance ?? null, withinAllowance: unbudgetedAllowance === undefined ? null : unbudgetedInside },
    itemsOutsideTolerance: rows.filter((r) => !r.withinItemTolerance).map((r) => r.item),
    reasons,
    basis: {
      rule: 'an item is inside its tolerance when actual <= approved x (100 + itemTolerancePct) / 100; the budget is inside when the total overrun <= the lower of pct % of the approved total and the stated amount',
      boundary: 'an overrun of exactly the tolerance is inside ("may exceed ... by up to")',
      source: `${CITE.joa} Art. 12.5 (a budget item or an AFE by up to 10%; a budget by no more than the lower of 5% or NOK 75 million; NOK 3 million for work outside the budgets); every percentage and amount is a stated input with no default`,
    },
  };
};

// ---- operator overhead ------------------------------------------------------------

/**
 * Operator overhead by category on a stated scale. The base of a category is
 * its annual cost less the stated exclusions; the scale is marginal: each
 * band's per cent applies to the part of the base inside the band (from the
 * previous band's upTo to this band's upTo), and abovePct to the part above
 * the last band. A flat percentage is a scale with no bands. Overhead itself
 * is never part of the base.
 */
const overheadImpl = ({ costs, excluded = {}, scale }) => {
  if (!isObj(costs) || Object.keys(costs).length === 0) return must('costs', 'an object of annual costs by category, at least one', costs);
  const cats = Object.keys(costs).filter((k) => costs[k] !== undefined);
  if (cats.length > DEFAULTS.MAX_ITEMS) return refuse('costs', `must have at most ${DEFAULTS.MAX_ITEMS} categories; got ${cats.length}`);
  for (const k of cats) { const e = nonNeg(`costs.${k}`, costs[k]); if (e) return e; }
  if (!isObj(excluded)) return must('excluded', 'an object of excluded amounts by category when given', excluded);
  for (const k of Object.keys(excluded)) {
    if (excluded[k] === undefined) continue;
    if (!cats.includes(k)) return refuse(`excluded.${k}`, `is not a cost category; the categories are ${cats.join(', ')}`);
    const e = nonNeg(`excluded.${k}`, excluded[k]);
    if (e) return e;
    if (excluded[k] > costs[k]) return must(`excluded.${k}`, `at or below the cost of the category ${fmt(costs[k])}`, excluded[k]);
  }
  if (!isObj(scale)) return must('scale', 'an object with a scale { bands, abovePct } for every cost category (no default rate)', scale);
  for (const k of Object.keys(scale)) if (scale[k] !== undefined && !cats.includes(k)) return refuse(`scale.${k}`, `is not a cost category; the categories are ${cats.join(', ')}`);
  for (const k of cats) {
    const s = scale[k];
    const f = `scale.${k}`;
    if (!isObj(s)) return must(f, 'an object { bands, abovePct } (no default rate)', s);
    for (const key of Object.keys(s)) if (s[key] !== undefined && !['bands', 'abovePct'].includes(key)) return unknownKey(f, key, ['bands', 'abovePct']);
    if (!Array.isArray(s.bands)) return must(`${f}.bands`, 'an array of { upTo, pct } (empty for a flat percentage)', s.bands);
    if (s.bands.length > DEFAULTS.MAX_BANDS) return refuse(`${f}.bands`, `must have at most ${DEFAULTS.MAX_BANDS} entries; got ${s.bands.length}`);
    let prev = 0;
    for (let i = 0; i < s.bands.length; i += 1) {
      const b = s.bands[i];
      const bf = `${f}.bands[${i}]`;
      if (!isObj(b)) return must(bf, 'an object', b);
      for (const key of Object.keys(b)) if (b[key] !== undefined && !['upTo', 'pct'].includes(key)) return unknownKey(bf, key, ['upTo', 'pct']);
      const e = first(positive(`${bf}.upTo`, b.upTo), pct(`${bf}.pct`, b.pct));
      if (e) return e;
      if (!(b.upTo > prev)) return must(`${bf}.upTo`, `above the previous band's upTo ${fmt(prev)}`, b.upTo);
      prev = b.upTo;
    }
    const e = pct(`${f}.abovePct`, s.abovePct);
    if (e) return e;
  }
  const reasons = [];
  const rows = cats.map((k) => {
    const ex = excluded[k] ?? 0;
    const base = costs[k] - ex;
    let lo = 0;
    const bands = scale[k].bands.map((b) => {
      const amount = Math.max(0, Math.min(base, b.upTo) - lo);
      const r = { from: lo, upTo: b.upTo, pct: b.pct, amount, charge: (amount * b.pct) / 100 };
      lo = b.upTo;
      return r;
    });
    const aboveAmount = Math.max(0, base - lo);
    const above = { from: lo, amount: aboveAmount, pct: scale[k].abovePct, charge: (aboveAmount * scale[k].abovePct) / 100 };
    const charge = sum(bands.map((b) => b.charge)) + above.charge;
    const parts = bands.filter((b) => b.amount > 0).map((b) => `${fmt(b.pct)}% of ${money(b.amount)}`);
    if (above.amount > 0) parts.push(`${fmt(above.pct)}% of ${money(above.amount)}${bands.length ? ` above ${money(lo)}` : ''}`);
    reasons.push(`${k}: base ${money(base)}${ex > 0 ? ` (cost ${money(costs[k])} less exclusions ${money(ex)})` : ''}; ${parts.length ? parts.join(' + ') : 'nothing to charge'} = ${money(charge)}`);
    return { category: k, cost: costs[k], excluded: ex, base, bands, above, charge };
  });
  return {
    categories: rows,
    total: sum(rows.map((r) => r.charge)),
    reasons,
    basis: {
      rule: 'base = annual cost - stated exclusions; the scale is marginal: each band\'s per cent on the part of the base inside the band, abovePct on the part above the last band; a flat percentage is a scale with no bands',
      base: 'overhead charged under the scale is never part of its own base',
      source: `${CITE.aa} Art. 2.2.2 (per cent rates and limits on annual exploration, operating and development cost, with stated exclusions) and Art. 2.2.3 (0.65 % of the annual costs); every band and rate is a stated input with no default`,
    },
  };
};

// ---- default ---------------------------------------------------------------------

const addMonths = (d, n) => {
  const [y, m, dd] = d.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`;
};
const addWorkingDays = (d, n, holidays) => {
  let k = dayNo(d);
  let left = n;
  while (left > 0) {
    k += 1;
    const wd = new Date(k * 86400000).getUTCDay();
    if (wd !== 0 && wd !== 6 && !holidays.has(dayName(k))) left -= 1;
  }
  return dayName(k);
};
const triggerDate = (c, holidays) => (c.unit === 'calendar-days' ? dayName(dayNo(c.from) + c.after) : c.unit === 'working-days' ? addWorkingDays(c.from, c.after, holidays) : addMonths(c.from, c.after));
const UNIT_WORD = { 'calendar-days': 'calendar day', 'working-days': 'working day', months: 'month' };

/**
 * A default on one cash call. Each defaulter's unpaid amount (its paying
 * share of the call less what it paid) is advanced by the non-defaulting
 * parties in proportion to their paying interests among themselves. Interest
 * on the unpaid amount runs from and including the due date to, but
 * excluding, the date the default is cured (or asOf when it is not):
 * unpaid x annualRatePct / 100 x days / dayBasis, simple; it is distributed
 * to the parties financing the default in proportion to their cover. The
 * stated consequences (suspension, forfeiture) count `after` units from their
 * stated `from` date; a consequence applies when the default is still open
 * after the whole trigger date (cured later than it, or not cured by asOf and
 * asOf later than it). Forfeiture is reported as available with the
 * interests the non-defaulting parties would hold, pro rata to their
 * participating interests.
 */
const defaultImpl = ({ parties, carries, callTotal, dueDate, asOf, defaulters, interest, suspension, forfeiture, holidays = [] }) => {
  let e = first(checkParties(parties), checkCarries(carries, parties), positive('callTotal', callTotal), realDate('dueDate', dueDate), realDate('asOf', asOf),
    listOf('defaulters', defaulters, DEFAULTS.MAX_PARTIES));
  if (e) return e;
  if (!(asOf >= dueDate)) return must('asOf', `on or after the due date ${dueDate}`, asOf);
  if (!isObj(interest)) return must('interest', 'an object { annualRatePct, dayBasis, interestMethod, graceHours } (no default rate or method)', interest);
  e = first(nonNeg('interest.annualRatePct', interest.annualRatePct), [365, 360].includes(interest.dayBasis) ? null : must('interest.dayBasis', '365 or 360', interest.dayBasis),
    oneOf('interest.interestMethod', interest.interestMethod, ['simple', 'monthly-compound']),
    fin(interest.graceHours) && interest.graceHours >= 0 ? null : must('interest.graceHours', 'a finite number of hours at or above 0, stated (0 when the contract gives no grace; the engine holds no default)', interest.graceHours));
  if (e) return e;
  if (!Array.isArray(holidays)) return must('holidays', "an array of dates 'YYYY-MM-DD' when given", holidays);
  for (let i = 0; i < holidays.length; i += 1) { e = realDate(`holidays[${i}]`, holidays[i]); if (e) return e; }
  for (const [name, c] of [['suspension', suspension], ['forfeiture', forfeiture]]) {
    if (c === undefined) continue;
    if (!isObj(c)) return must(name, 'an object { after, unit, from } when given', c);
    e = first(intAtLeast(`${name}.after`, c.after, 1), oneOf(`${name}.unit`, c.unit, ['calendar-days', 'working-days', 'months']), realDate(`${name}.from`, c.from));
    if (e) return e;
  }
  const { rows } = interestsCore(parties, carries);
  const pid = ids(parties);
  const shares = splitBy(callTotal, rows, 'payingPct');
  const seen = new Set();
  for (let i = 0; i < defaulters.length; i += 1) {
    const d = defaulters[i];
    const f = `defaulters[${i}]`;
    if (!pid.includes(d.id)) return must(`${f}.id`, `the id of a party (${pid.join(', ')})`, d.id);
    if (seen.has(d.id)) return must(`${f}.id`, 'a party no other defaulter entry names', d.id);
    seen.add(d.id);
    e = nonNeg(`${f}.paid`, d.paid);
    if (e) return e;
    if (!(d.paid < shares[d.id])) return must(`${f}.paid`, `below the party's share of the call ${fmt(shares[d.id])} (a party that paid its share is not in default)`, d.paid);
    if (d.curedOn !== undefined) {
      e = realDate(`${f}.curedOn`, d.curedOn);
      if (e) return e;
      if (!(d.curedOn >= dueDate && d.curedOn <= asOf)) return must(`${f}.curedOn`, `a date from the due date ${dueDate} to asOf ${asOf}`, d.curedOn);
    }
  }
  const coverers = rows.filter((r) => !seen.has(r.id) && r.payingPct > 0);
  const coverPayTotal = sum(coverers.map((r) => r.payingPct));
  if (coverers.length === 0 || coverPayTotal === 0) return must('defaulters', 'leaving at least one non-defaulting party with a paying interest above 0', defaulters.map((d) => d.id));
  const hol = new Set(holidays);
  const reasons = [];
  const defRows = defaulters.map((d) => {
    const unpaid = shares[d.id] - d.paid;
    const end = d.curedOn ?? asOf;
    const days = dayNo(end) - dayNo(dueDate);
    const withinGrace = days * 24 <= interest.graceHours;
    let wholeMonths = null;
    let remainingDays = null;
    let amount;
    if (interest.interestMethod === 'simple') {
      amount = withinGrace ? 0 : (unpaid * interest.annualRatePct * days) / (100 * interest.dayBasis);
    } else {
      wholeMonths = 0;
      while (addMonths(dueDate, wholeMonths + 1) <= end) wholeMonths += 1;
      remainingDays = dayNo(end) - dayNo(addMonths(dueDate, wholeMonths));
      const growth = (1 + interest.annualRatePct / 1200) ** wholeMonths * (1 + (interest.annualRatePct * remainingDays) / (100 * interest.dayBasis));
      amount = withinGrace ? 0 : unpaid * (growth - 1);
    }
    const conseq = {};
    for (const [name, c] of [['suspension', suspension], ['forfeiture', forfeiture]]) {
      if (c === undefined) { conseq[name] = null; continue; }
      const on = triggerDate(c, hol);
      const applies = d.curedOn !== undefined ? d.curedOn > on : asOf > on;
      conseq[name] = { triggerDate: on, applies };
    }
    const span = `from ${dueDate} to ${d.curedOn !== undefined ? `the cure on ${d.curedOn}` : `asOf ${asOf}, the default still open`}, the last date excluded`;
    const head = `${d.id}: share of the call ${money(shares[d.id])}, paid ${money(d.paid)}, unpaid ${money(unpaid)}; `;
    if (withinGrace && interest.graceHours > 0) {
      reasons.push(`${head}no interest: ${unit(days, 'day')} (${fmt(days * 24)} hours, ${span}) are within the stated grace of ${fmt(interest.graceHours)} hours`);
    } else {
      const graceNote = interest.graceHours > 0 ? `; the stated grace of ${fmt(interest.graceHours)} hours is exceeded, so interest runs from the due date` : '';
      const calc = interest.interestMethod === 'simple'
        ? `${money(unpaid)} x ${fmt(interest.annualRatePct)}% x ${unit(days, 'day')} / ${interest.dayBasis}`
        : `${money(unpaid)} x ((1 + ${fmt(interest.annualRatePct)}% / 12)^${wholeMonths} x (1 + ${fmt(interest.annualRatePct)}% x ${unit(remainingDays, 'day')} / ${interest.dayBasis}) - 1), ${unit(wholeMonths, 'whole month')} and ${unit(remainingDays, 'day')}`;
      reasons.push(`${head}interest ${calc} = ${money(amount)} (${span})${graceNote}`);
    }
    for (const [name, c] of [['suspension', suspension], ['forfeiture', forfeiture]]) {
      if (!conseq[name]) continue;
      const q = conseq[name];
      const what = name === 'suspension' ? 'the suspension of its rights (as the contract states) starts' : 'the right to demand the assignment of its interest (forfeiture, as the contract states) arises';
      reasons.push(`${d.id}: ${what} after ${unit(c.after, UNIT_WORD[c.unit])} from ${c.from}, that is after ${q.triggerDate}: ${q.applies ? `triggered, the default being open after ${q.triggerDate}` : `not triggered, the default ${d.curedOn !== undefined ? `being cured on ${d.curedOn}` : `being open only to asOf ${asOf}`}`}`);
    }
    return { id: d.id, share: shares[d.id], paid: d.paid, unpaid, curedOn: d.curedOn ?? null, days, withinGrace, wholeMonths, remainingDays, interest: amount, suspension: conseq.suspension, forfeiture: conseq.forfeiture };
  });
  const unpaidTotal = sum(defRows.map((d) => d.unpaid));
  const interestTotal = sum(defRows.map((d) => d.interest));
  const coverRows = coverers.map((r) => ({ id: r.id, payingPct: r.payingPct, coverPct: (r.payingPct * 100) / coverPayTotal }));
  coverRows.forEach((c) => { c.cover = (unpaidTotal * c.payingPct) / coverPayTotal; c.interestReceived = (interestTotal * c.payingPct) / coverPayTotal; });
  reasons.unshift(`the unpaid ${money(unpaidTotal)} is advanced by ${coverRows.map((c) => `${c.id} ${money(c.cover)}`).join(', ')}, in proportion to their paying interests among the non-defaulting parties`);
  let interestsAfterForfeiture = null;
  const forfeiting = defRows.filter((d) => d.forfeiture && d.forfeiture.applies).map((d) => d.id);
  if (forfeiting.length) {
    const keep = parties.filter((p) => !forfeiting.includes(p.id));
    const keepTotal = sum(keep.map((p) => p.participatingPct));
    interestsAfterForfeiture = keep.map((p) => ({ id: p.id, participatingPct: (p.participatingPct * 100) / keepTotal }));
    reasons.push(`if the assignment of ${forfeiting.join(', ')} is demanded, the interest is apportioned pro rata: ${interestsAfterForfeiture.map((p) => `${p.id} ${fmt(p.participatingPct)}%`).join(', ')}; the compensation (at most the book value less unpaid contributions) is not computed`);
  }
  return {
    callTotal, dueDate, asOf,
    shares: pid.map((id) => ({ id, share: shares[id] })),
    defaulters: defRows,
    cover: coverRows,
    unpaidTotal, interestTotal,
    interestsAfterForfeiture,
    reasons,
    basis: {
      cover: 'the non-defaulting parties advance the unpaid amounts in proportion to their paying interests among themselves (the parties that pay cost; a carried party pays none)',
      interest: `${interest.interestMethod === 'simple' ? 'simple interest' : 'interest compounded monthly (rate / 12 for each whole month from the due date, the month end kept as for the triggers, then simple interest on the compounded amount for the remaining days)'} at the stated ${fmt(interest.annualRatePct)}% a year on a ${interest.dayBasis}-day year, from and including the due date to, but excluding, the cure date (or asOf); distributed to the parties financing the default in proportion to their cover`,
      grace: `a stated grace of ${fmt(interest.graceHours)} hours (days x 24 from the due date): a default cured within it carries no interest; one cured later carries interest from the due date, as the Kenya Model PSC 2015 Participation Agreement Art. 6.7 prints (72 hours)`,
      consequences: 'reported only as stated: each applies when the default is open after the whole trigger date; working days are Monday to Friday less the stated holidays; months keep the day of the month (the last day when the month is shorter)',
      notComputed: 'the cover by acquiring the defaulting party\'s share of petroleum, and the compensation on an assignment, are reported only',
      source: `${CITE.joa} Art. 9.1 to 9.4; ${CITE.aa} Art. 1.2.2 (the reference rate plus three percentage points in that text; the rate is a stated input here)`,
    },
  };
};

// ---- carry recovery -----------------------------------------------------------------

const UPLIFTS = ['none', 'compound', 'multiple'];
const checkUplift = (u, pre = 'uplift') => {
  if (!isObj(u)) return must(pre, 'an object { type } with type "none", "compound" or "multiple" (no default)', u);
  let e = oneOf(`${pre}.type`, u.type, UPLIFTS);
  if (e) return e;
  if (u.type === 'compound') e = first(nonNeg(`${pre}.ratePctPerYear`, u.ratePctPerYear), u.multiplePct !== undefined ? must(`${pre}.multiplePct`, 'left out when type is "compound"', u.multiplePct) : null);
  else if (u.type === 'multiple') e = first(fin(u.multiplePct) && u.multiplePct >= 100 ? null : must(`${pre}.multiplePct`, 'a number at or above 100 (100 recovers the cost alone)', u.multiplePct), u.ratePctPerYear !== undefined ? must(`${pre}.ratePctPerYear`, 'left out when type is "multiple"', u.ratePctPerYear) : null);
  else e = first(u.ratePctPerYear !== undefined ? must(`${pre}.ratePctPerYear`, 'left out when type is "none"', u.ratePctPerYear) : null, u.multiplePct !== undefined ? must(`${pre}.multiplePct`, 'left out when type is "none"', u.multiplePct) : null);
  return e;
};

const checkYears = (years, keys, pre = 'years') => {
  let e = listOf(pre, years, DEFAULTS.MAX_YEARS);
  if (e) return e;
  for (let i = 0; i < years.length; i += 1) {
    const y = years[i];
    const f = `${pre}[${i}]`;
    e = intAtLeast(`${f}.year`, y.year, 1);
    if (e) return e;
    if (i > 0 && y.year !== years[i - 1].year + 1) return must(`${f}.year`, `${years[i - 1].year + 1}, the year after ${years[i - 1].year} (years are consecutive)`, y.year);
    for (const k of keys) { e = nonNeg(`${f}.${k}`, y[k]); if (e) return e; }
  }
  return null;
};

/**
 * The recovery ledger of one balance owed to recovering parties, paid out of
 * a debtor's share of each year's entitlement. For year t:
 *   uplift  compound: opening x ratePctPerYear / 100 (the year's new cost
 *           earns none in its own year); multiple: the year's cost x
 *           (multiplePct - 100) / 100 added with it; none: 0
 *   due     opening + uplift + added cost (x multiplePct / 100 for multiple)
 *   available  entitlement x debtor share / 100 x recoverFromPct / 100
 *   recovered  min(available, due, cap left); closing = due - recovered
 * When the stated cap is reached the rest is written off.
 */
const recoveryLedger = ({ years, added, sharePct, recoverFromPct, uplift, cap, label, debtor }) => {
  let bal = 0;
  let recoveredToDate = 0;
  const rows = years.map((y, i) => {
    const reasons = [];
    const opening = bal;
    const upliftAmt = uplift.type === 'compound' ? (opening * uplift.ratePctPerYear) / 100 : uplift.type === 'multiple' ? (added[i] * (uplift.multiplePct - 100)) / 100 : 0;
    const due = opening + upliftAmt + added[i];
    const share = (y.entitlement * sharePct) / 100;
    const available = (share * recoverFromPct) / 100;
    const capLeft = cap === undefined ? Infinity : cap - recoveredToDate;
    const recovered = Math.min(available, due, capLeft);
    recoveredToDate += recovered;
    let closing = due - recovered;
    let writtenOff = 0;
    if (upliftAmt > 0) reasons.push(uplift.type === 'compound' ? `${y.year}: ${fmt(uplift.ratePctPerYear)}% a year on the opening balance ${money(opening)} adds ${money(upliftAmt)}` : `${y.year}: the ${fmt(uplift.multiplePct)}% multiple on the ${label} of ${money(added[i])} adds ${money(upliftAmt)}`);
    if (cap !== undefined && recoveredToDate >= cap && closing > 0) {
      writtenOff = closing;
      closing = 0;
      reasons.push(`${y.year}: the stated cap ${money(cap)} is reached with ${money(recovered)} recovered this year; the rest, ${money(writtenOff)}, is written off`);
    } else if (due > 0 && closing === 0) {
      reasons.push(`${y.year}: the balance ${money(due)} is recovered${recovered === available ? ' exactly by' : ` with ${money(recovered)} of`} the ${money(available)} available; the ${debtor} receives ${money(share - recovered)} of its share ${money(share)}`);
    } else if (due > 0) {
      reasons.push(`${y.year}: ${money(recovered)} recovered of ${money(due)} due; ${money(closing)} carried to ${y.year + 1}`);
    }
    bal = closing;
    return { year: y.year, opening, uplift: upliftAmt, added: added[i], due, share, available, recovered, closing, writtenOff, debtorReceives: share - recovered, reasons };
  });
  const owed = rows.filter((r) => r.due > 0);
  const lastOwed = owed.length ? owed[owed.length - 1] : null;
  const recoveredInYear = lastOwed && lastOwed.closing === 0 && rows.every((r) => r.writtenOff === 0) ? lastOwed.year : null;
  return { rows, recoveredToDate, outstanding: bal, recoveredInYear };
};

const checkNpvArgs = (discountRate, baseYear) => {
  if (discountRate === undefined && baseYear === undefined) return null;
  return first(fin(discountRate) && discountRate > -1 ? null : must('discountRate', 'a finite number above -1 (stated with baseYear)', discountRate),
    intAtLeast('baseYear', baseYear, 1));
};

/**
 * A carry and its recovery. Each year the carriers pay the carried part of
 * the carried party's cost share (cost x its participating interest x
 * carriedPct / 10,000), in their carry shares; the balance, with the stated
 * uplift, is recovered from the carried party's share of the year's
 * entitlement (entitlement x its beneficial interest), at most
 * recoverFromPct % of that share, capped where a cap is stated. The
 * recovered amounts go to the carriers in their carry shares. Under basis
 * 'pia-s85-4' the uplift must be none (s.85(4)(c)). Party cash flows: the
 * entitlement share, adjusted by the recovery, less the paid cost share; NPV
 * through the canonical npv when discountRate and baseYear are stated.
 */
const carryImpl = ({ parties, carries, carried, years, uplift, recoverFromPct, cap, basis, discountRate, baseYear }) => {
  let e = first(checkParties(parties), checkCarries(carries, parties));
  if (e) return e;
  if (!Array.isArray(carries) || carries.length === 0) return must('carries', 'an array with the carry to recover', carries);
  const c = carries.find((x) => x.carried === carried);
  if (!c) return must('carried', `the carried party of one of the carries (${carries.map((x) => x.carried).join(', ')})`, carried);
  e = first(checkYears(years, ['cost', 'entitlement']), checkUplift(uplift), pctPos('recoverFromPct', recoverFromPct),
    cap !== undefined ? positive('cap', cap) : null, oneOf('basis', basis, ['pia-s85-4', 'contract']), checkNpvArgs(discountRate, baseYear));
  if (e) return e;
  if (basis === 'pia-s85-4' && uplift.type !== 'none') return must('uplift.type', '"none" under basis "pia-s85-4": the refund excludes interest, premium or markups on cost (PIA s.85(4)(c))', uplift.type);
  const { rows: irows, carries: cr } = interestsCore(parties, carries);
  const carryRow = cr.find((x) => x.carried === carried);
  const cRow = irows.find((r) => r.id === carried);
  const added = years.map((y) => (y.cost * cRow.beneficialPct * c.carriedPct) / 10000);
  const led = recoveryLedger({ years, added, sharePct: cRow.beneficialPct, recoverFromPct, uplift, cap, label: 'carried cost', debtor: 'carried party' });
  const pid = ids(parties);
  const flows = Object.fromEntries(pid.map((id) => [id, []]));
  const partyYears = years.map((y, i) => {
    const costSplit = splitBy(y.cost, irows, 'payingPct');
    const entSplit = splitBy(y.entitlement, irows, 'beneficialPct');
    const r = led.rows[i];
    const out = pid.map((id) => {
      let recovery = 0;
      if (id === carried) recovery = -r.recovered;
      const w = carryRow.weights.find((a) => a.id === id);
      if (w) recovery += (r.recovered * w.num) / w.den;
      const net = entSplit[id] + recovery - costSplit[id];
      flows[id].push(net);
      return { id, costPaid: costSplit[id], entitlementShare: entSplit[id], recovery, net };
    });
    return { year: y.year, cost: y.cost, entitlement: y.entitlement, carriedCost: added[i], parties: out };
  });
  const reasons = [...led.rows.flatMap((r) => r.reasons)];
  if (led.outstanding > 0) reasons.push(`${years[years.length - 1].year}: ${money(led.outstanding)} of the carry is not recovered by the last year`);
  const npvs = discountRate === undefined ? null : pid.map((id) => ({ id, npv: npv(flows[id], discountRate, baseYear, years[0].year) }));
  return {
    carried, carriedPct: c.carriedPct, carriedInterestPct: carryRow.carriedInterestPct, carriers: carryRow.carriers.map((a) => ({ id: a.id, sharePct: a.sharePct })),
    ledger: led.rows.map(({ reasons: _r, ...rest }) => rest),
    parties: partyYears,
    totals: { carriedCost: sum(added), uplift: sum(led.rows.map((r) => r.uplift)), recovered: led.recoveredToDate, writtenOff: sum(led.rows.map((r) => r.writtenOff)), outstanding: led.outstanding },
    recoveredInYear: led.recoveredInYear,
    npv: npvs,
    reasons,
    basis: {
      rule: 'carried cost = cost x participating interest x carriedPct / 10,000, paid by the carriers in their carry shares; due = opening + uplift + carried cost; recovered = min(carried party\'s entitlement share x recoverFromPct / 100, due, cap left)',
      uplift: uplift.type === 'none' ? 'no uplift: the cost alone is recovered' : uplift.type === 'compound' ? `${fmt(uplift.ratePctPerYear)}% a year on the opening balance, compounded yearly; a year's new cost earns none in its own year` : `a multiple of ${fmt(uplift.multiplePct)}% of each year's carried cost`,
      timing: 'the uplift accrues on the opening balance; the year\'s carried cost is added; recovery comes from the same year\'s entitlement at the year end',
      basis: basis === 'pia-s85-4' ? 'PIA s.85(4): the Government refunds its proportionate share of the unrecovered proven costs, with no bonuses, penalties, interest, premium or markups (s.85(4)(c)), in cash or in kind from future production (s.85(4)(f))' : 'the contract\'s stated terms',
      npv: discountRate === undefined ? 'not requested' : `canonical npv from engines/economics/cashflow.ts, year-end flows discounted to ${baseYear} at ${fmt(discountRate)}`,
      source: `${CITE.pia} s.85(4); ${CITE.joa} Art. 8.1; the carry, uplift, recovery share and cap are stated inputs with no default`,
    },
  };
};

// ---- back-in -----------------------------------------------------------------------

const COST_KINDS = ['exploration', 'development', 'production', 'bonus', 'penalty', 'interest', 'premium', 'markup'];

/**
 * A back-in: one party raises its participating interest to targetPct; every
 * other party gives up interest in proportion to its own (new = old x (100 -
 * target) / (100 - current)). The refund owed = (target - current) / 100 x
 * the refundable unrecovered costs, paid to the other parties in proportion
 * to the interest each gives up. Under basis 'pia-s85-4' the target is at
 * most 60% (s.85(4)(a)) and only development and production costs are
 * refundable (s.85(4)(c)); under 'contract' the refundable kinds are stated.
 * refundForm 'upfront' pays it at once (refused under 'pia-s85-4', which
 * allows no upfront payment by the Government, s.85(4)(d));
 * 'from-future-entitlement' recovers it with no uplift from recoverFromPct %
 * of the back-in party's new share of each year's entitlement, in cash or in
 * kind (s.85(4)(f)).
 */
const backInImpl = ({ parties, backInParty, targetPct, costs, basis, refundableKinds, refundForm, recoverFromPct, years }) => {
  let e = first(checkParties(parties), oneOf('backInParty', backInParty, ids(parties)), oneOf('basis', basis, ['pia-s85-4', 'contract']), listOf('costs', costs, DEFAULTS.MAX_ITEMS));
  if (e) return e;
  const current = parties.find((p) => p.id === backInParty).participatingPct;
  e = pctPos('targetPct', targetPct);
  if (e) return e;
  if (!(targetPct > current)) return must('targetPct', `above the back-in party's current interest ${fmt(current)}`, targetPct);
  if (!(targetPct < 100)) return must('targetPct', 'below 100 (the other parties keep an interest)', targetPct);
  if (basis === 'pia-s85-4' && targetPct > PIA_JV.maxGovernmentParticipationPct) return must('targetPct', 'at most 60 under basis "pia-s85-4" (the right to participate up to 60%, PIA s.85(4)(a))', targetPct);
  let kinds;
  if (basis === 'pia-s85-4') {
    if (refundableKinds !== undefined) return must('refundableKinds', 'left out under basis "pia-s85-4" (development and production, s.85(4)(c))', refundableKinds);
    kinds = PIA_JV.refundableKinds;
  } else {
    if (!Array.isArray(refundableKinds) || refundableKinds.length === 0) return must('refundableKinds', `an array of cost kinds stated under basis "contract" (${COST_KINDS.join(', ')}; no default)`, refundableKinds);
    for (let i = 0; i < refundableKinds.length; i += 1) { e = oneOf(`refundableKinds[${i}]`, refundableKinds[i], COST_KINDS); if (e) return e; }
    kinds = refundableKinds;
  }
  for (let i = 0; i < costs.length; i += 1) {
    e = first(text(`costs[${i}].item`, costs[i].item), nonNeg(`costs[${i}].amount`, costs[i].amount), oneOf(`costs[${i}].kind`, costs[i].kind, COST_KINDS));
    if (e) return e;
  }
  e = oneOf('refundForm', refundForm, ['upfront', 'from-future-entitlement']);
  if (e) return e;
  if (basis === 'pia-s85-4' && refundForm === 'upfront') return must('refundForm', '"from-future-entitlement" under basis "pia-s85-4": no upfront payment by the Government (s.85(4)(d)); the refund is in cash or in kind from future production or entitlements (s.85(4)(f))', refundForm);
  if (refundForm === 'from-future-entitlement') {
    e = first(pctPos('recoverFromPct', recoverFromPct), checkYears(years, ['entitlement']));
    if (e) return e;
  } else {
    e = first(recoverFromPct !== undefined ? must('recoverFromPct', 'left out when refundForm is "upfront"', recoverFromPct) : null, years !== undefined ? must('years', 'left out when refundForm is "upfront"', years) : null);
    if (e) return e;
  }
  const reasons = [];
  const lines = costs.map((c) => ({ item: c.item, amount: c.amount, kind: c.kind, refundable: kinds.includes(c.kind) }));
  const refundable = sum(lines.filter((l) => l.refundable).map((l) => l.amount));
  const excludedAmt = sum(lines.filter((l) => !l.refundable).map((l) => l.amount));
  lines.filter((l) => !l.refundable && l.amount > 0).forEach((l) => reasons.push(`${l.item}: ${money(l.amount)} (${l.kind}) is not refundable${basis === 'pia-s85-4' ? ' (PIA s.85(4)(c): development and production costs only, no bonuses, penalties, interest, premium or markups)' : ' (not a stated refundable kind)'}`));
  const step = targetPct - current;
  const rest = 100 - current;
  const refund = (step * refundable) / 100;
  const rows = parties.map((p) => {
    const me = p.id === backInParty;
    return {
      id: p.id, before: p.participatingPct,
      after: me ? targetPct : (p.participatingPct * (100 - targetPct)) / rest,
      ceded: me ? 0 : (p.participatingPct * step) / rest,
      refundReceived: me ? 0 : (refund * p.participatingPct) / rest,
      refundPaid: me ? refund : 0,
    };
  });
  reasons.unshift(`${backInParty} backs in from ${fmt(current)}% to ${fmt(targetPct)}%: the others keep ${fmt(100 - targetPct)} / ${fmt(100 - current)} of their interests; refund ${fmt(step)}% x refundable costs ${money(refundable)} = ${money(refund)}${excludedAmt > 0 ? ` (${money(excludedAmt)} excluded)` : ''}`);
  let recovery = null;
  if (refundForm === 'from-future-entitlement') {
    const added = years.map((_, i) => (i === 0 ? refund : 0));
    const led = recoveryLedger({ years, added, sharePct: targetPct, recoverFromPct, uplift: { type: 'none' }, cap: undefined, label: 'refund', debtor: 'back-in party' });
    recovery = {
      ledger: led.rows.map(({ reasons: _r, ...rest }) => rest),
      recovered: led.recoveredToDate, outstanding: led.outstanding, recoveredInYear: led.recoveredInYear,
      toParties: led.rows.map((r) => ({ year: r.year, parties: rows.filter((x) => x.id !== backInParty).map((x) => ({ id: x.id, amount: (r.recovered * x.before) / rest })) })),
    };
    reasons.push(...led.rows.flatMap((r) => r.reasons));
    if (led.outstanding > 0) reasons.push(`${years[years.length - 1].year}: ${money(led.outstanding)} of the refund is not recovered by the last year`);
  }
  return {
    backInParty, currentPct: current, targetPct, parties: rows, costs: lines, refundable, excluded: excludedAmt, refund, refundForm, recovery,
    reasons,
    basis: {
      rule: 'new interest of another party = old x (100 - target) / (100 - current); refund = (target - current) / 100 x refundable costs, received in proportion to the interest given up',
      refundable: basis === 'pia-s85-4' ? 'development and production costs only; bonuses, penalties, interest, premium and markups excluded (PIA s.85(4)(c)); exploration is not development or production' : `the stated kinds: ${kinds.join(', ')}`,
      form: refundForm === 'upfront' ? 'paid at once under the contract\'s stated terms (not available under PIA s.85(4), which requires no upfront payment by the Government, s.85(4)(d))' : 'recovered with no uplift from recoverFromPct % of the back-in party\'s share of future entitlement, in cash or in kind (s.85(4)(f)), the whole refund owed from the first year',
      notComputed: 'the expert determination of the unrecovered costs (s.85(4)(e)); the unrecovered cost figures are stated inputs',
      source: `${CITE.pia} s.85(4)`,
    },
  };
};

// ---- sole risk and non-consent ---------------------------------------------------------

/**
 * A sole risk operation that some parties declined. The consenting parties
 * share its cost in proportion to their participating interests among
 * themselves. mode 'recover-from-production': each non-consenting party's
 * share of the cost (cost x its participating interest) times
 * premiumMultiplePct / 100 is recovered by the consenting parties, in their
 * shares, out of that party's share of each year's net production value
 * (max(0, grossValue - deductions) x its participating interest); in the
 * year the premium is recovered the rest of its share is its own again
 * (reversion inside the period). mode 'buy-in': a non-consenting party that
 * enters pays premiumMultiplePct % of its proportionate share of the cost,
 * apportioned to the consenting parties in their shares (the Norwegian JOA
 * prints one thousand (1000) %).
 */
const nonConsentImpl = ({ parties, consenting, operation, premiumMultiplePct, mode, years }) => {
  let e = checkParties(parties);
  if (e) return e;
  const pid = ids(parties);
  if (!Array.isArray(consenting) || consenting.length === 0) return must('consenting', 'an array of the ids of the consenting parties, at least one', consenting);
  for (let i = 0; i < consenting.length; i += 1) {
    if (!pid.includes(consenting[i])) return must(`consenting[${i}]`, `the id of a party (${pid.join(', ')})`, consenting[i]);
    if (consenting.indexOf(consenting[i]) !== i) return must(`consenting[${i}]`, 'an id not already listed', consenting[i]);
  }
  if (consenting.length === pid.length) return must('consenting', 'leaving at least one non-consenting party (every party consents: a joint operation)', consenting);
  if (!isObj(operation)) return must('operation', 'an object { name, cost }', operation);
  e = first(text('operation.name', operation.name), positive('operation.cost', operation.cost),
    fin(premiumMultiplePct) && premiumMultiplePct >= 100 ? null : must('premiumMultiplePct', 'a number at or above 100 (a stated contract figure; 100 recovers the cost alone)', premiumMultiplePct),
    oneOf('mode', mode, ['recover-from-production', 'buy-in']));
  if (e) return e;
  if (mode === 'recover-from-production') {
    e = checkYears(years, ['grossValue', 'deductions']);
    if (e) return e;
  } else if (years !== undefined) return must('years', 'left out when mode is "buy-in"', years);
  const cons = parties.filter((p) => consenting.includes(p.id));
  const nc = parties.filter((p) => !consenting.includes(p.id));
  const consTotal = sum(cons.map((p) => p.participatingPct));
  const shares = cons.map((p) => ({ id: p.id, participatingPct: p.participatingPct, projectPct: (p.participatingPct * 100) / consTotal }));
  const costSplit = splitBy(operation.cost, shares, 'projectPct');
  shares.forEach((s) => { s.cost = costSplit[s.id]; });
  const reasons = [`${operation.name}: cost ${money(operation.cost)} paid by the consenting parties ${shares.map((s) => `${s.id} ${fmt(s.projectPct)}%`).join(', ')} (in proportion to their participating interests)`];
  const ncRows = nc.map((p) => ({ id: p.id, participatingPct: p.participatingPct, costShare: (operation.cost * p.participatingPct) / 100, premium: (operation.cost * p.participatingPct * premiumMultiplePct) / 10000 }));
  const basis = {
    rule: 'the consenting parties pay the cost in proportion to their participating interests among themselves; the premium of a non-consenting party = its proportionate share of the cost x premiumMultiplePct / 100',
    multiple: `${fmt(premiumMultiplePct)}% of the non-consenting party's proportionate share of the cost (a stated contract figure with no default; 100% is the cost alone)`,
    source: `${CITE.joa} Art. 18.6 and 18.12 (entry at one thousand (1000) % of the proportionate share of the costs, apportioned to the initial participants); premium recovery from production is a contract term taught by concept and stated here as inputs`,
  };
  if (mode === 'buy-in') {
    const pay = ncRows.map((r) => ({ id: r.id, payment: r.premium, toParties: shares.map((s) => ({ id: s.id, amount: (r.premium * s.participatingPct) / consTotal })) }));
    pay.forEach((p) => reasons.push(`${p.id}: to enter it pays ${fmt(premiumMultiplePct)}% of its share ${money(ncRows.find((r) => r.id === p.id).costShare)} = ${money(p.payment)}, apportioned to the consenting parties in their shares`));
    return { operation: { name: operation.name, cost: operation.cost }, mode, premiumMultiplePct, consenting: shares, nonConsenting: ncRows, buyIn: pay, recovery: null, reasons, basis };
  }
  const recovery = ncRows.map((r) => {
    const added = years.map((_, i) => (i === 0 ? r.premium : 0));
    const net = years.map((y) => ({ year: y.year, entitlement: Math.max(0, y.grossValue - y.deductions) }));
    const led = recoveryLedger({ years: net, added, sharePct: r.participatingPct, recoverFromPct: 100, uplift: { type: 'none' }, cap: undefined, label: 'premium', debtor: 'non-consenting party' });
    led.rows.forEach((row) => row.reasons.forEach((t) => reasons.push(`${r.id} ${t}`)));
    if (led.outstanding > 0) reasons.push(`${r.id} ${years[years.length - 1].year}: ${money(led.outstanding)} of the premium is not recovered by the last year`);
    return {
      id: r.id, premium: r.premium,
      ledger: led.rows.map(({ reasons: _x, due, opening, closing, share, recovered, debtorReceives, year }) => ({ year, opening, due, share, recovered, closing, nonConsentingReceives: debtorReceives })),
      recovered: led.recoveredToDate, outstanding: led.outstanding, revertsInYear: led.recoveredInYear,
      toParties: led.rows.map((row) => ({ year: row.year, parties: shares.map((s) => ({ id: s.id, amount: (row.recovered * s.participatingPct) / consTotal })) })),
    };
  });
  years.forEach((y) => { if (y.grossValue < y.deductions) reasons.push(`${y.year}: deductions ${money(y.deductions)} exceed the gross value ${money(y.grossValue)}: no net value, nothing recovered`); });
  basis.recovery = 'recovered each year from the non-consenting party\'s share of max(0, grossValue - deductions); in the year the premium is recovered the rest of that year\'s share is the non-consenting party\'s (reversion inside the period)';
  return { operation: { name: operation.name, cost: operation.cost }, mode, premiumMultiplePct, consenting: shares, nonConsenting: ncRows, buyIn: null, recovery, reasons, basis };
};

// ---- PSC cost recovery through cashflow.ts ------------------------------------------------

/**
 * The PSC cost pool year by year through the canonical applyPSC of
 * engines/economics/cashflow.ts (royalty on gross; cost oil limited to a
 * percentage of revenue after royalty; unrecovered cost carried; profit oil
 * split; tax on the contractor's profit oil), threading the unrecovered pool.
 * costOilLimitBase 'gross' states the limit as a percentage of gross revenue:
 * it is passed to applyPSC as the fraction costOilLimitPct / (100 - royaltyPct) of
 * revenue after royalty, the same amount. Cost recovered = pool in + capex +
 * opex - pool out; profit oil = revenue after royalty - cost recovered. The
 * contractor's entitlement (cost oil + its profit oil - tax) and the costs
 * are split between the parties by participating interest (the afe split).
 */
const pscImpl = ({ years, royaltyPct, costOilLimitPct, costOilLimitBase, contractorProfitSharePct, taxRatePct, openingCostPool, parties, discountRate, baseYear }) => {
  let e = first(checkYears(years, ['grossRevenue', 'capex', 'opex']),
    fin(royaltyPct) && royaltyPct >= 0 && royaltyPct < 100 ? null : must('royaltyPct', 'a number from 0 up to, but excluding, 100', royaltyPct),
    pct('costOilLimitPct', costOilLimitPct), oneOf('costOilLimitBase', costOilLimitBase, ['after-royalty', 'gross']),
    pct('contractorProfitSharePct', contractorProfitSharePct), pct('taxRatePct', taxRatePct), nonNeg('openingCostPool', openingCostPool),
    parties !== undefined ? checkParties(parties) : null, checkNpvArgs(discountRate, baseYear));
  if (e) return e;
  for (let i = 0; i < years.length; i += 1) if (years[i].contractorProfitSharePct !== undefined) { e = pct(`years[${i}].contractorProfitSharePct`, years[i].contractorProfitSharePct); if (e) return e; }
  if (costOilLimitBase === 'gross' && costOilLimitPct > 100 - royaltyPct) return must('costOilLimitPct', `at or below the revenue left after royalty, ${fmt(100 - royaltyPct)}% of gross, when costOilLimitBase is "gross"`, costOilLimitPct);
  const capFraction = costOilLimitBase === 'gross' ? costOilLimitPct / (100 - royaltyPct) : costOilLimitPct / 100;
  let pool = openingCostPool;
  const reasons = [];
  const rows = years.map((y) => {
    const poolIn = pool;
    const share = y.contractorProfitSharePct ?? contractorProfitSharePct;
    const o = applyPSC({ gross_revenue: y.grossRevenue, capex: y.capex, opex: y.opex, depreciation: 0, cumulative_unrecovered_cost: poolIn }, royaltyPct / 100, capFraction, share / 100, taxRatePct / 100, 0);
    const revenueAfterRoyalty = y.grossRevenue - o.royalty;
    const costRecovered = poolIn + y.capex + y.opex - o.cumulative_unrecovered_cost_after;
    const profitOil = revenueAfterRoyalty - costRecovered;
    const contractorProfitOil = o.taxable_income;
    const entitlement = costRecovered + contractorProfitOil - o.tax;
    pool = o.cumulative_unrecovered_cost_after;
    const limit = costOilLimitBase === 'gross' ? (y.grossRevenue * costOilLimitPct) / 100 : (revenueAfterRoyalty * costOilLimitPct) / 100;
    if (poolIn + y.capex + y.opex > limit) reasons.push(`${y.year}: recoverable ${money(poolIn + y.capex + y.opex)} is above the cost oil limit ${money(limit)}; ${money(pool)} carried to ${y.year + 1}`);
    return {
      year: y.year, contractorProfitSharePct: share, grossRevenue: y.grossRevenue, royalty: o.royalty, revenueAfterRoyalty, poolIn, capex: y.capex, opex: y.opex,
      costOilLimit: limit, costRecovered, poolOut: pool, profitOil, contractorProfitOil, governmentProfitOil: profitOil - contractorProfitOil,
      tax: o.tax, contractorEntitlement: entitlement, contractorNet: o.net_cash_flow, governmentTake: o.royalty + (profitOil - contractorProfitOil) + o.tax,
    };
  });
  let partyRows = null;
  let npvs = null;
  if (parties !== undefined) {
    const irows = parties.map((p) => ({ id: p.id, pct: p.participatingPct }));
    const flows = Object.fromEntries(parties.map((p) => [p.id, []]));
    partyRows = rows.map((r) => {
      const ent = splitBy(r.contractorEntitlement, irows, 'pct');
      const cost = splitBy(r.capex + r.opex, irows, 'pct');
      return { year: r.year, parties: parties.map((p) => { const net = ent[p.id] - cost[p.id]; flows[p.id].push(net); return { id: p.id, entitlement: ent[p.id], cost: cost[p.id], net }; }) };
    });
    if (discountRate !== undefined) npvs = parties.map((p) => ({ id: p.id, npv: npv(flows[p.id], discountRate, baseYear, years[0].year) }));
  }
  const tot = (k) => sum(rows.map((r) => r[k]));
  return {
    years: rows,
    totals: { grossRevenue: tot('grossRevenue'), royalty: tot('royalty'), costRecovered: tot('costRecovered'), profitOil: tot('profitOil'), contractorProfitOil: tot('contractorProfitOil'), governmentProfitOil: tot('governmentProfitOil'), tax: tot('tax'), contractorEntitlement: tot('contractorEntitlement'), contractorNet: tot('contractorNet'), governmentTake: tot('governmentTake') },
    unrecoveredAtEnd: pool,
    parties: partyRows,
    npv: npvs,
    reasons,
    basis: {
      engine: 'applyPSC imported from engines/economics/cashflow.ts, called once a year with the unrecovered pool threaded; nothing here re-computes the cost pool',
      share: 'contractorProfitSharePct applies to every year that does not state its own (a year\'s own figure carries a sliding scale, e.g. by daily rate or R-factor, computed outside)',
      order: 'royalty = royaltyPct % of gross; cost oil limit = costOilLimitPct % of revenue after royalty (or of gross, as stated); cost recovered = min(pool + capex + opex, limit); profit oil = revenue after royalty - cost recovered; contractor profit oil = its share; tax = taxRatePct % of the contractor\'s profit oil',
      limitBase: costOilLimitBase === 'gross' ? `the limit is stated on gross revenue and passed to applyPSC as the fraction ${fmt(costOilLimitPct)} / (100 - ${fmt(royaltyPct)}) of revenue after royalty` : 'the limit is stated on revenue after royalty',
      pia: 'PIA s.311(2)(a)(iii): a renegotiated production sharing contract features a cost oil limit of not more than 60% of the total oil production; the limit here is the contract\'s stated figure',
      tax: 'income tax is charged on the contractor\'s profit oil share, as FARI TNM/16/01 and World Bank Note 8 assume (applyPSC in engines/economics/cashflow.ts)',
      split: 'the contractor entitlement and the costs are split by participating interest with calculatePartnerCosts from engines/economics/afe.js',
      source: `${CITE.pia} s.85(2)(a), s.311(2)(a)(iii); engines/economics/cashflow.ts applyPSC`,
    },
  };
};

// ---- public entry points: every one checks its accepted keys first ------------

export const participatingInterests = guard('participatingInterests', interestsImpl);
export const cashCalls = guard('cashCalls', cashCallsImpl);
export const budgetControl = guard('budgetControl', budgetImpl);
export const overhead = guard('overhead', overheadImpl);
export const defaultCover = guard('defaultCover', defaultImpl);
export const carryRecovery = guard('carryRecovery', carryImpl);
export const backIn = guard('backIn', backInImpl);
export const nonConsent = guard('nonConsent', nonConsentImpl);
export const pscCostRecovery = guard('pscCostRecovery', pscImpl);
