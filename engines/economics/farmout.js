/**
 * Farm-ins, farm-outs and asset valuation (Economics EC10): the earning
 * obligation of a farm-in (the farminee pays a stated share of a stated work
 * programme, event by event, to earn a stated interest, with a stated cap and
 * overrun rule, a cash bonus and a past-cost reimbursement), the promote and
 * its ratio, the value of the deal to each side on a stated risked prospect
 * (EMV before and after, through the canonical decision tree), the
 * break-even promote and the break-even chance of success, the value of
 * information to either side, the risk each side carries (the canonical
 * portfolio Monte Carlo), a price for an interest (value per percent of
 * working interest, transaction ratios of stated inputs), the Nigerian
 * assignment consent fee, and a development carry or a back-in after the
 * farm-in (engines/economics/jointVenture.js). All deterministic except the
 * seeded Monte Carlo of riskSharing.
 *
 * Pure functions, no I/O. Every function returns either a result object
 * carrying a `basis` (the rules applied and where they come from, so a course
 * can print the working) or `{ error, field }`, where `field` names the input
 * refused and the message starts with that name. Every refusal reads
 * "<field> must <condition>; got <value>" (or, for an unknown key,
 * "<field> is not an accepted key; ...").
 *
 * Sources (FINDINGS-farmout.md has URLs, editions and the dates read):
 *   PIA       Petroleum Industry Act 2021 (Act No. 6): s.94(8)(b) (farm-out
 *             defined), s.95(1) to (15) (assignment needs the prior written
 *             consent of the Minister; a change of control, over 50%, is an
 *             assignment; a fee based on a percentage of the value of the
 *             transaction, not tax deductible, s.95(12); a petroleum
 *             exploration licence needs the consent of the Commission,
 *             s.95(15)), s.264(f) and s.302(12)(c) (fees paid for assigning
 *             rights to another party are not deductible).
 *   AOI 2024  Nigerian Upstream Petroleum (Assignment of Interests)
 *             Regulations, 2024 (S.I. No. 67 of 2024, Gazette No. 61 Vol.
 *             111): reg. 19(2) (seven per cent of the value of the
 *             transaction: a two per cent processing fee and a five per cent
 *             premium; an intra group transfer two per cent), 19(3) (the
 *             value of the transaction), 19(5) (not tax deductible), 19(7) to
 *             (9) (90 days, 30 more days, then 0.01% a day straight line for
 *             90 days, then the consent is deemed withdrawn), reg. 16 (a PEL
 *             assignment needs the consent of the Commission).
 *   HMRC OT   HM Revenue and Customs, Oil Taxation Manual (Open Government
 *             Licence v3.0): OT30021 (farm in: the work programme is the
 *             consideration, assignment before the work; earn in: the work
 *             first; cash reimbursement of sunk costs), OT30022 and OT18360
 *             (a development carry recovered from the carried party's
 *             production, usually with an addition for interest), OT18320.
 *   PSU 801   Penn State EME 801, Lesson 6, "Expected Monetary Value and
 *             Value at Risk" (CC BY-NC-SA 4.0): drill yourself or farm out,
 *             Table 6.1, EMV 12,500 and 17,500.
 *   engines   rollback, evpi and evii from ./decisionTree.js (every EMV and
 *             value of information); applyJV and npv from ./cashflow.ts
 *             (working-interest scaling and NPV); portfolioRiskMetrics from
 *             ./portfolio.js (the seeded Monte Carlo); calculatePartnerCosts
 *             from ./afe.js (the other parties' cost shares); carryRecovery
 *             and backIn from ./jointVenture.js. None is re-implemented.
 *
 * Conventions, stated once:
 *   money       one currency throughout a call.
 *   percentages 0 to 100 on input (farmineePaysPct 40 is 40% of the gross
 *               cost); interests are points of the whole licence.
 *   promote     share of the gross cost the farminee pays minus the interest
 *               it holds after the event (points); the promote ratio is the
 *               share paid over the interest held.
 *   valuation   the success-case value is the 100% NPV of the development
 *               after a discovery, excluding the earning well; well costs,
 *               bonus, reimbursement and fees fall at the valuation date,
 *               undiscounted.
 *   reasons     money prints rounded to the cent (half away from zero,
 *               trailing zeros dropped); other figures print as the shortest
 *               round-trip decimal; numeric fields keep full precision.
 *
 * Validation: tools/validation/economics/oracle_farmout.py (stdlib python)
 * writes test-data/economics/goldens/farmout_cases.json;
 * FINDINGS-farmout.md, negcontrol_farmout.sh, timing_farmout.js. Fixtures
 * (synthetic Ekene exploration prospect): test-data/economics/ekene-farmout/.
 */

import { applyJV, npv } from './cashflow.ts';
import { rollback, evpi, evii } from './decisionTree.js';
import { portfolioRiskMetrics } from './portfolio.js';
import { calculatePartnerCosts } from './afe.js';
import { carryRecovery as jvCarryRecovery, backIn as jvBackIn } from './jointVenture.js';

export const DEFAULTS = Object.freeze({
  MAX_PARTIES: 20,
  MAX_EVENTS: 20,
  MAX_YEARS: 100,
  MAX_SIGNALS: 10,
  MAX_POSITIONS: 10,
  MAX_HOLDINGS: 50,
  MAX_ITERATIONS: 200000,
  MAX_DRAW_WORK: 500000, // iterations x holdings over all positions (about 2.5 s at 5 microseconds a holding draw)
  MAX_RESERVES: 10,
  SUM_TOLERANCE: 1e-9,
});

/** Figures read from the gazetted Nigerian texts. */
export const NIGERIA_ASSIGNMENT = Object.freeze({
  processingFeePct: 2, // AOI 2024 reg. 19(2)
  premiumPct: 5, // AOI 2024 reg. 19(2)
  intraGroupProcessingFeePct: 2, // AOI 2024 reg. 19(2), proviso
  payWithinDays: 90, // reg. 19(7)
  graceDays: 30, // reg. 19(8)
  surchargePctPerDay: 0.01, // reg. 19(9), straight line
  surchargeDays: 90, // reg. 19(9), then the consent is deemed withdrawn
  changeOfControlAbovePct: 50, // PIA s.95(14)
});

const CITE = Object.freeze({
  pia: 'Petroleum Industry Act 2021 (Act No. 6), Official Gazette No. 142, Vol. 108, 27 August 2021',
  aoi: 'Nigerian Upstream Petroleum (Assignment of Interests) Regulations, 2024 (S.I. No. 67 of 2024, Official Gazette No. 61, Vol. 111, 9 April 2024)',
  hmrc: 'HM Revenue and Customs, Oil Taxation Manual (Open Government Licence v3.0)',
  psu: 'Penn State EME 801, Lesson 6, Expected Monetary Value and Value at Risk (CC BY-NC-SA 4.0)',
});

// ---- helpers ---------------------------------------------------------------

const refuse = (field, message) => ({ error: `${field} ${message}`, field });
const fmt = (x) => String(x);
const show = (v) => (v === undefined ? 'nothing' : typeof v === 'number' ? fmt(v) : typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
const must = (field, cond, v) => refuse(field, `must be ${cond}; got ${show(v)}`);
const unit = (x, one, many = `${one}s`) => `${fmt(x)} ${x === 1 ? one : many}`;
// money in reasons prints rounded to the cent (half away from zero), trailing
// zeros dropped; numeric fields keep full precision.
const money = (x) => fmt(Number(x.toFixed(2)));
// a computed percentage, probability or ratio in a reason prints to 6 decimal
// places (half away from zero, trailing zeros dropped); stated inputs print
// as given.
const dec = (x) => fmt(Number(x.toFixed(6)));
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const sum = (xs) => xs.reduce((s, v) => s + v, 0);
const first = (...checks) => checks.find((c) => c) || null;
const DAY_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const finite = (field, v) => (fin(v) ? null : must(field, 'a finite number', v));
const nonNeg = (field, v) => (fin(v) && v >= 0 ? null : must(field, 'a finite number at or above 0', v));
const positive = (field, v) => (fin(v) && v > 0 ? null : must(field, 'a finite number above 0', v));
const pct = (field, v) => (fin(v) && v >= 0 && v <= 100 ? null : must(field, 'a number from 0 to 100', v));
const pctPos = (field, v) => (fin(v) && v > 0 && v <= 100 ? null : must(field, 'a number above 0 and at most 100', v));
const intAtLeast = (field, v, lo) => (Number.isInteger(v) && v >= lo ? null : must(field, `an integer at or above ${lo}`, v));
const oneOf = (field, v, opts) => (opts.includes(v) ? null : must(field, `one of ${opts.map((o) => `"${o}"`).join(', ')}`, v));
const text = (field, v) => (typeof v === 'string' && v.trim() !== '' ? null : must(field, 'a non-empty string', v));
const bool = (field, v) => (typeof v === 'boolean' ? null : must(field, 'true or false (stated; no default)', v));
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

// ---- accepted keys ---------------------------------------------------------
//
// Every public function refuses an input key it does not read, at every
// level, so a misspelt optional key is never dropped silently. Keys whose
// value is undefined count as absent.
const O = (keys, children = {}) => ({ t: 'obj', keys, children });
const L = (of) => ({ t: 'list', of });
const PARTY = O(['id', 'name', 'participatingPct']);
const FARMINEE = O(['id', 'name']);
const CAP = O(['on', 'amount', 'overrunRule']);
const PAST = O(['amount', 'reimbursedPct']);
const SUCCESS = O(['npv', 'cashFlows', 'discountRate', 'baseYear'], { cashFlows: L(O(['year', 'net'])) });
const PROJECT = O(['chanceOfSuccessPct', 'wellCost', 'successValue'], { wellCost: O(['success', 'dry']), successValue: SUCCESS });
const DEAL = O(['farmineePaysPct', 'earnedPct', 'cap', 'cashBonus', 'pastCosts', 'assignorFees'], { cap: CAP, pastCosts: PAST });
const UPLIFT = O(['type', 'ratePctPerYear', 'multiplePct']);
export const ACCEPTED_KEYS = Object.freeze({
  earningObligation: O(['parties', 'farmor', 'farminee', 'events', 'vesting', 'eventsCompleted', 'cashBonus', 'pastCosts'], {
    parties: L(PARTY), farminee: FARMINEE, events: L(O(['name', 'grossCost', 'farmineePaysPct', 'earnedPct', 'cap'], { cap: CAP })), pastCosts: PAST,
  }),
  dealValue: O(['parties', 'farmor', 'farminee', 'project', 'deal'], { parties: L(PARTY), farminee: FARMINEE, project: PROJECT, deal: DEAL }),
  informationValue: O(['parties', 'farmor', 'farminee', 'project', 'deal', 'side', 'information'], {
    parties: L(PARTY), farminee: FARMINEE, project: PROJECT, deal: DEAL,
    information: O(['cost', 'signals'], { signals: L(O(['label', 'likelihoodsPct'])) }),
  }),
  interestValue: O(['project', 'interestPct', 'valueBasis', 'transaction'], {
    project: PROJECT, transaction: O(['price', 'volumeUnit', 'reserves', 'production'], { reserves: L(O(['category', 'grossVolume'])), production: O(['grossRate', 'rateUnit']) }),
  }),
  riskSharing: O(['positions', 'correlation', 'seed', 'iterations'], {
    positions: L(O(['name', 'holdings'], { holdings: L(O(['id', 'chanceOfSuccessPct', 'successValue', 'failCost', 'successStdDev'])) })),
  }),
  consentFee: O(['licence', 'transactionValue', 'valueSource', 'intraGroup', 'basis', 'ratesPct', 'payment'], {
    ratesPct: O(['processingPct', 'premiumPct']), payment: O(['notifiedOn', 'paidOn']),
  }),
  developmentCarry: O(['parties', 'farmor', 'farminee', 'earnedPct', 'carriedPct', 'years', 'uplift', 'recoverFromPct', 'cap', 'discountRate', 'baseYear'], {
    parties: L(PARTY), farminee: FARMINEE, years: L(O(['year', 'cost', 'entitlement'])), uplift: UPLIFT,
  }),
  backInRight: O(['parties', 'farmor', 'farminee', 'earnedPct', 'backIn'], {
    parties: L(PARTY), farminee: FARMINEE,
    backIn: O(['party', 'targetPct', 'costs', 'basis', 'refundableKinds', 'refundForm', 'recoverFromPct', 'years'], {
      costs: L(O(['item', 'amount', 'kind'])), years: L(O(['year', 'entitlement'])),
    }),
  }),
});

const unknownKey = (path, key, keys) => refuse(path ? `${path}.${key}` : key, `is not an accepted key; the accepted keys ${path ? `of ${path}` : 'at the top level'} are ${keys.join(', ')}`);
const walkKeys = (v, spec, path) => {
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

// ---- the canonical engines, wrapped once -------------------------------------

/**
 * Working-interest scaling through the canonical applyJV of
 * engines/economics/cashflow.ts: a value (or a year's net flow) at 100% goes
 * in as gross revenue with no royalty, tax, cost or loss relief, so the net
 * cash flow is the value times the interest.
 */
const scaleWI = (value, wiPct) => applyJV({ gross_revenue: value, opex: 0, capex: 0, depreciation: 0, cumulative_unrecovered_cost: 0 }, wiPct / 100, 0, 0, 0, false).net_cash_flow;

const chance = (label, p, success, dry) => ({
  type: 'chance',
  label,
  branches: [
    { label: 'success', probability: p, node: { type: 'terminal', label: `${label}: success`, payoff: success } },
    { label: 'dry hole', probability: 1 - p, node: { type: 'terminal', label: `${label}: dry hole`, payoff: dry } },
  ],
});

/** Roll a decision among stated actions back through decisionTree.js. */
const decide = (label, p, actions) => {
  const tree = rollback({
    type: 'decision',
    label,
    branches: actions.map((a) => ({ label: a.label, node: a.certain !== undefined ? { type: 'terminal', label: a.label, payoff: a.certain } : chance(a.label, p, a.success, a.dry) })),
  });
  return {
    emvs: tree.branches.map((b) => b.branchValue),
    best: tree.branches[tree.bestBranchIndex].label,
    tied: tree.tiedIndices.map((i) => tree.branches[i].label),
    indifferent: tree.indifferent,
  };
};

/** EMV of one stated position through a chance node of decisionTree.js. */
const emvOf = (p, success, dry) => rollback(chance('position', p, success, dry)).emv;

/** Other parties' cost shares through calculatePartnerCosts of afe.js. */
const othersPay = (amount, others) => calculatePartnerCosts(amount, others.map((o) => ({ id: o.id, working_interest: o.participatingPct })))
  .partnerAllocations.map((a) => ({ id: a.id, pays: a.shareAmount }));

// ---- parties -------------------------------------------------------------------

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

/** The parties, the farmor and the farminee; returns an error or { F, others }. */
const checkDealParties = (parties, farmor, farminee) => {
  let e = checkParties(parties);
  if (e) return { e };
  const pid = parties.map((p) => p.id);
  e = oneOf('farmor', farmor, pid);
  if (e) return { e };
  if (!isObj(farminee)) return { e: must('farminee', 'an object { id, name } for the incoming party', farminee) };
  e = first(text('farminee.id', farminee.id), farminee.name !== undefined ? text('farminee.name', farminee.name) : null);
  if (e) return { e };
  if (pid.includes(farminee.id)) return { e: must('farminee.id', `an id no licence party has (${pid.join(', ')})`, farminee.id) };
  return { F: parties.find((p) => p.id === farmor).participatingPct, others: parties.filter((p) => p.id !== farmor) };
};

const interestsAfter = (parties, farmor, farminee, vestedPct) => [
  ...parties.map((p) => ({ id: p.id, participatingPct: p.id === farmor ? p.participatingPct - vestedPct : p.participatingPct })),
  { id: farminee.id, participatingPct: vestedPct },
];

// ---- the cost split of one earning event ------------------------------------------

const CAP_ON = ['none', 'gross-cost', 'carry-amount'];
const OVERRUN = ['post-deal-interests', 'farmor-side'];
const checkCap = (cap, pre) => {
  if (!isObj(cap)) return must(pre, 'an object { on } with on "none", "gross-cost" or "carry-amount" (no default)', cap);
  let e = oneOf(`${pre}.on`, cap.on, CAP_ON);
  if (e) return e;
  if (cap.on === 'none') {
    return first(cap.amount !== undefined ? must(`${pre}.amount`, 'left out when on is "none"', cap.amount) : null,
      cap.overrunRule !== undefined ? must(`${pre}.overrunRule`, 'left out when on is "none"', cap.overrunRule) : null);
  }
  if (cap.on === 'gross-cost') {
    e = first(positive(`${pre}.amount`, cap.amount), oneOf(`${pre}.overrunRule`, cap.overrunRule, OVERRUN));
    return e;
  }
  return first(nonNeg(`${pre}.amount`, cap.amount), cap.overrunRule !== undefined ? must(`${pre}.overrunRule`, 'left out when on is "carry-amount" (the farmor pays the rest of its own share)', cap.overrunRule) : null);
};

const checkPaysEarned = (pre, X, Yinc, Yprev, F) => {
  let e = pctPos(`${pre}.earnedPct`, Yinc);
  if (e) return e;
  const Y = Yprev + Yinc;
  if (Y > F + DEFAULTS.SUM_TOLERANCE) return must(`${pre}.earnedPct`, `at most ${dec(F - Yprev)}, the farmor's interest ${fmt(F)} less ${dec(Yprev)} already earned`, Yinc);
  e = pct(`${pre}.farmineePaysPct`, X);
  if (e) return e;
  if (X < Y) return must(`${pre}.farmineePaysPct`, `at or above ${dec(Y)}, the interest the farminee holds after the event (a promote of 0 or more)`, X);
  if (X > F) return must(`${pre}.farmineePaysPct`, `at most ${fmt(F)}, the farmor's interest before the deal (the farminee pays no other party's share)`, X);
  return null;
};

/**
 * One earning event of gross cost C: the farminee pays X% to hold Y% after it
 * (Y cumulative), out of the farmor's pre-deal interest F.
 *   cap none          farminee X C / 100; farmor (F - X) C / 100
 *   cap gross-cost K  the promote applies to base = min(C, K); the excess
 *                     C - base is paid by the post-deal interests (farminee
 *                     Y, farmor F - Y) or by the farmor side alone (the
 *                     farmor its whole F)
 *   cap carry-amount M  the carry (X - Y) C / 100 is held at M; the farminee
 *                     pays Y C / 100 + carry, the farmor (F - Y) C / 100 - carry
 * carry = farminee pays - Y C / 100 (the part of the farmor's post-deal share
 * the farminee pays). Every other party pays its own interest of C.
 */
const splitEvent = (C, X, Y, F, cap) => {
  let fin_;
  let farmorPays;
  let capState = 'none';
  let base = C;
  let excess = 0;
  let carryUncapped = null;
  if (cap.on === 'gross-cost') {
    base = Math.min(C, cap.amount);
    excess = C - base;
    capState = C < cap.amount ? 'below' : C === cap.amount ? 'exactly' : 'exceeded';
    const post = cap.overrunRule === 'post-deal-interests';
    fin_ = (X * base) / 100 + (post ? (Y * excess) / 100 : 0);
    farmorPays = ((F - X) * base) / 100 + (post ? ((F - Y) * excess) / 100 : (F * excess) / 100);
  } else if (cap.on === 'carry-amount') {
    carryUncapped = ((X - Y) * C) / 100;
    const carry = Math.min(carryUncapped, cap.amount);
    capState = carryUncapped < cap.amount ? 'below' : carryUncapped === cap.amount ? 'exactly' : 'exceeded';
    fin_ = (Y * C) / 100 + carry;
    farmorPays = ((F - Y) * C) / 100 - carry;
  } else {
    fin_ = (X * C) / 100;
    farmorPays = ((F - X) * C) / 100;
  }
  return { farmineePays: fin_, farmorPays, carry: fin_ - (Y * C) / 100, capState, base, excess, carryUncapped };
};

const capReason = (s, cap, C, Y, F, who) => {
  if (cap.on === 'none') return 'no cap: the promote applies to the whole gross cost';
  if (cap.on === 'gross-cost') {
    if (s.capState === 'below') return `the gross cost ${money(C)} is below the cap ${money(cap.amount)}: the promote applies to all of it`;
    if (s.capState === 'exactly') return `the gross cost reaches the cap ${money(cap.amount)} exactly: the promote applies to all of it, with no excess`;
    return `the gross cost exceeds the cap ${money(cap.amount)} by ${money(s.excess)}: the promote applies to ${money(s.base)}; the excess is paid ${cap.overrunRule === 'post-deal-interests' ? `by the post-deal interests (${who.farminee} ${dec(Y)}%, ${who.farmor} ${dec(F - Y)}%)` : `by the farmor side alone (${who.farmor} pays its whole ${fmt(F)}% share of it)`}`;
  }
  if (s.capState === 'below') return `the carry ${money(s.carryUncapped)} is below the cap ${money(cap.amount)}`;
  if (s.capState === 'exactly') return `the carry reaches the cap ${money(cap.amount)} exactly`;
  return `the carry ${money(s.carryUncapped)} is held at the cap ${money(cap.amount)}; ${who.farmor} pays the rest of its ${dec(F - Y)}% share`;
};

const checkPast = (pastCosts, pre = 'pastCosts') => {
  if (!isObj(pastCosts)) return must(pre, 'an object { amount, reimbursedPct } (both 0 when the deal has no reimbursement; no default)', pastCosts);
  return first(nonNeg(`${pre}.amount`, pastCosts.amount), pct(`${pre}.reimbursedPct`, pastCosts.reimbursedPct));
};

// ---- earning obligation -------------------------------------------------------------

/**
 * The earning obligation, event by event (a single work programme is one
 * event; drill-to-earn has several). Each event states its gross cost, the
 * share the farminee pays, the interest it earns (points of the licence, on
 * top of what earlier events earned) and its cap. vesting "per-event": each
 * completed event vests its interest (a farm in, assigned as the work is
 * done); "all-events": nothing vests until every event is completed (an earn
 * in, HMRC OT30021). Payments are counted for completed events only; every
 * event's split is reported as the obligation.
 */
const earningImpl = ({ parties, farmor, farminee, events, vesting, eventsCompleted, cashBonus, pastCosts }) => {
  const dp = checkDealParties(parties, farmor, farminee);
  if (dp.e) return dp.e;
  const { F, others } = dp;
  let e = listOf('events', events, DEFAULTS.MAX_EVENTS);
  if (e) return e;
  let Yprev = 0;
  const seen = new Set();
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    const pre = `events[${i}]`;
    e = first(text(`${pre}.name`, ev.name), positive(`${pre}.grossCost`, ev.grossCost), checkPaysEarned(pre, ev.farmineePaysPct, ev.earnedPct, Yprev, F), checkCap(ev.cap, `${pre}.cap`));
    if (e) return e;
    if (seen.has(ev.name)) return must(`${pre}.name`, 'a name no other event has', ev.name);
    seen.add(ev.name);
    Yprev += ev.earnedPct;
  }
  e = first(oneOf('vesting', vesting, ['per-event', 'all-events']), intAtLeast('eventsCompleted', eventsCompleted, 0), nonNeg('cashBonus', cashBonus), checkPast(pastCosts));
  if (e) return e;
  if (eventsCompleted > events.length) return must('eventsCompleted', `at most ${events.length}, the number of events`, eventsCompleted);
  const who = { farmor, farminee: farminee.id };
  const reasons = [];
  let Y = 0;
  const rows = events.map((ev, k) => {
    const Yb = Y;
    Y += ev.earnedPct;
    const s = splitEvent(ev.grossCost, ev.farmineePaysPct, Y, F, ev.cap);
    const completed = k < eventsCompleted;
    const eff = (s.farmineePays * 100) / ev.grossCost;
    reasons.push(`${ev.name}: gross cost ${money(ev.grossCost)}; ${farminee.id} pays ${fmt(ev.farmineePaysPct)}% to earn ${fmt(ev.earnedPct)}% (${dec(Y)}% held after it): a promote of ${dec(ev.farmineePaysPct - Y)} points, ratio ${fmt(ev.farmineePaysPct)} / ${dec(Y)}; ${capReason(s, ev.cap, ev.grossCost, Y, F, who)}; ${farminee.id} pays ${money(s.farmineePays)} (${dec(eff)}% of the gross cost), ${farmor} pays ${money(s.farmorPays)}, a carry of ${money(s.carry)}${completed ? '' : ' (not completed: the obligation only)'}`);
    return {
      name: ev.name, completed, grossCost: ev.grossCost, farmineePaysPct: ev.farmineePaysPct, earnedPct: ev.earnedPct, heldBeforePct: Yb, heldAfterPct: Y,
      promotePoints: ev.farmineePaysPct - Y, promoteRatio: ev.farmineePaysPct / Y,
      capState: s.capState, promotedCost: s.base, excess: s.excess, carryUncapped: s.carryUncapped,
      farmineePays: s.farmineePays, farmorPays: s.farmorPays, carry: s.carry, effectivePayingPct: eff,
      others: othersPay(ev.grossCost, others),
    };
  });
  const done = rows.filter((r) => r.completed);
  const allDone = eventsCompleted === events.length;
  const vested = vesting === 'per-event' ? sum(done.map((r) => r.earnedPct)) : allDone ? Y : 0;
  if (vesting === 'all-events' && !allDone) reasons.push(`vesting "all-events": ${eventsCompleted} of ${unit(events.length, 'event')} completed; nothing vests`);
  else if (vesting === 'per-event' && !allDone) reasons.push(`vesting "per-event": ${eventsCompleted} of ${unit(events.length, 'event')} completed; ${dec(vested)}% vests`);
  const reimbursement = (pastCosts.amount * pastCosts.reimbursedPct) / 100;
  const gross = sum(done.map((r) => r.grossCost));
  const paid = sum(done.map((r) => r.farmineePays));
  const carry = sum(done.map((r) => r.carry));
  const outlay = paid + cashBonus + reimbursement;
  const eqWI = gross > 0 ? (outlay * 100) / gross : null;
  if (cashBonus === 0) reasons.push('cash bonus: none (stated as 0)');
  reasons.push(`consideration to ${farmor}: carry ${money(carry)} + cash bonus ${money(cashBonus)} + past-cost reimbursement ${money(reimbursement)} (${fmt(pastCosts.reimbursedPct)}% of ${money(pastCosts.amount)}) = ${money(carry + cashBonus + reimbursement)}`);
  return {
    farmor, farminee: farminee.id, farmorInterestBeforePct: F,
    events: rows,
    vesting, eventsCompleted, vestedPct: vested,
    interestsAfter: interestsAfter(parties, farmor, farminee, vested),
    totals: {
      grossCost: gross, farmineePays: paid, farmorPays: sum(done.map((r) => r.farmorPays)), carry,
      cashBonus, pastCostReimbursement: reimbursement, consideration: carry + cashBonus + reimbursement,
      farmineeOutlay: outlay, effectivePayingPct: gross > 0 ? (paid * 100) / gross : null,
      equivalentWorkingInterestPct: eqWI, promoteAdjustedRatio: eqWI !== null && vested > 0 ? eqWI / vested : null,
    },
    reasons,
    basis: {
      promote: 'promote = the share of the gross cost the farminee pays minus the interest it holds after the event (points); promote ratio = share paid / interest held',
      carry: 'carry = what the farminee pays minus its own held interest of the gross cost: the part of the farmor\'s post-deal share the farminee pays',
      cap: 'gross-cost: the promote applies to the gross cost up to the cap, the excess by the stated overrun rule; carry-amount: the carry is held at the cap and the farmor pays the rest of its own share; none: no cap. Every cap, share and interest is a stated input with no default',
      vesting: vesting === 'per-event' ? 'each completed event vests its stated interest (a farm in: assignment with the work, HMRC OT30021)' : 'nothing vests until every event is completed (an earn in: the work before the assignment, HMRC OT30021)',
      equivalent: 'equivalent working interest = (farminee pays + cash bonus + past-cost reimbursement) / gross cost of the completed events x 100: the heads-up interest that would cost the farminee the same; promote-adjusted ratio = that / the vested interest',
      split: 'the other parties pay their own interests of each gross cost (calculatePartnerCosts from engines/economics/afe.js)',
      source: `${CITE.hmrc} OT30021 (the work programme as consideration; a cash reimbursement of sunk costs); ${CITE.pia} s.94(8)(b) (farm-out defined) and s.95 (every assignment needs consent)`,
    },
  };
};

// ---- the risked project --------------------------------------------------------------

const checkProject = (project) => {
  if (!isObj(project)) return { e: must('project', 'an object { chanceOfSuccessPct, wellCost, successValue }', project) };
  let e = pct('project.chanceOfSuccessPct', project.chanceOfSuccessPct);
  if (e) return { e };
  const w = project.wellCost;
  if (!isObj(w)) return { e: must('project.wellCost', 'an object { success, dry } of gross well costs (no default)', w) };
  e = first(nonNeg('project.wellCost.success', w.success), nonNeg('project.wellCost.dry', w.dry));
  if (e) return { e };
  const s = project.successValue;
  if (!isObj(s)) return { e: must('project.successValue', 'an object { npv } or { cashFlows, discountRate, baseYear }', s) };
  if (s.npv !== undefined) {
    e = first(finite('project.successValue.npv', s.npv), s.cashFlows !== undefined ? must('project.successValue.cashFlows', 'left out when npv is stated', s.cashFlows) : null,
      s.discountRate !== undefined ? must('project.successValue.discountRate', 'left out when npv is stated', s.discountRate) : null,
      s.baseYear !== undefined ? must('project.successValue.baseYear', 'left out when npv is stated', s.baseYear) : null);
    if (e) return { e };
    return { p: project.chanceOfSuccessPct / 100, S: s.npv, flows: null };
  }
  e = listOf('project.successValue.cashFlows', s.cashFlows, DEFAULTS.MAX_YEARS);
  if (e) return { e: e.field === 'project.successValue.cashFlows' && s.cashFlows === undefined ? must('project.successValue', 'an object { npv } or { cashFlows, discountRate, baseYear }', s) : e };
  for (let i = 0; i < s.cashFlows.length; i += 1) {
    const y = s.cashFlows[i];
    const f = `project.successValue.cashFlows[${i}]`;
    e = first(intAtLeast(`${f}.year`, y.year, 1), finite(`${f}.net`, y.net));
    if (e) return { e };
    if (i > 0 && y.year !== s.cashFlows[i - 1].year + 1) return { e: must(`${f}.year`, `${s.cashFlows[i - 1].year + 1}, the year after ${s.cashFlows[i - 1].year} (years are consecutive)`, y.year) };
  }
  e = first(fin(s.discountRate) && s.discountRate > -1 ? null : must('project.successValue.discountRate', 'a finite number above -1 (a fraction: 0.1 is 10%)', s.discountRate),
    intAtLeast('project.successValue.baseYear', s.baseYear, 1));
  if (e) return { e };
  const nets = s.cashFlows.map((y) => y.net);
  return { p: project.chanceOfSuccessPct / 100, S: npv(nets, s.discountRate, s.baseYear, s.cashFlows[0].year), flows: s };
};

/** The success-case value of a party's interest: the canonical scaling, year by year when flows are stated, then the canonical npv. */
const partyValue = (pr, wiPct) => (pr.flows
  ? npv(pr.flows.cashFlows.map((y) => scaleWI(y.net, wiPct)), pr.flows.discountRate, pr.flows.baseYear, pr.flows.cashFlows[0].year)
  : scaleWI(pr.S, wiPct));

const checkDeal = (deal, F) => {
  if (!isObj(deal)) return must('deal', 'an object { farmineePaysPct, earnedPct, cap, cashBonus, pastCosts, assignorFees }', deal);
  return first(checkPaysEarned('deal', deal.farmineePaysPct, deal.earnedPct, 0, F), checkCap(deal.cap, 'deal.cap'), nonNeg('deal.cashBonus', deal.cashBonus),
    checkPast(deal.pastCosts, 'deal.pastCosts'), nonNeg('deal.assignorFees', deal.assignorFees));
};

/**
 * Every side's payoff in each outcome for a deal paying X% (the rest of the
 * deal as stated). Success: the side's interest of the success-case value
 * less its share of the success well cost; dry hole: less its share of the
 * dry-hole cost. The farmor receives the bonus and the reimbursement and pays
 * the assignor fees in both outcomes; the farminee pays the bonus and the
 * reimbursement.
 */
const payoffs = (pr, project, deal, F, X) => {
  const Y = deal.earnedPct;
  const ws = splitEvent(project.wellCost.success, X, Y, F, deal.cap);
  const wd = splitEvent(project.wellCost.dry, X, Y, F, deal.cap);
  const reimb = (deal.pastCosts.amount * deal.pastCosts.reimbursedPct) / 100;
  const cash = deal.cashBonus + reimb;
  return {
    ws, wd, reimb,
    farmorAlone: { success: partyValue(pr, F) - (F * project.wellCost.success) / 100, dry: -(F * project.wellCost.dry) / 100 },
    farmorFarmOut: { success: partyValue(pr, F - Y) - ws.farmorPays + cash - deal.assignorFees, dry: -wd.farmorPays + cash - deal.assignorFees },
    farminee: { success: partyValue(pr, Y) - ws.farmineePays - cash, dry: -wd.farmineePays - cash },
  };
};

/**
 * Break-even chance of one position: EMV(p) = p a + (1 - p) b is linear in
 * p, so p* = -b / (a - b) when it lies in [0, 1]. a and b are the EMVs at
 * certain success and certain failure, rolled back by decisionTree.js.
 */
const breakEvenChance = (success, dry) => {
  const a = emvOf(1, success, dry);
  const b = emvOf(0, success, dry);
  if (a >= 0 && b >= 0) return { status: 'never-negative', chanceOfSuccessPct: null };
  if (a <= 0 && b <= 0) return { status: 'never-positive', chanceOfSuccessPct: null };
  return { status: 'solved', chanceOfSuccessPct: (-b * 100) / (a - b) };
};

const bcReason = (who, r) => (r.status === 'solved'
  ? `${who}: EMV is 0 at a chance of success of ${dec(r.chanceOfSuccessPct)}%`
  : r.status === 'never-negative' ? `${who}: EMV is at or above 0 at every chance of success (the dry hole is not a loss)` : `${who}: EMV is below 0 at every chance of success`);

/**
 * The break-even promote: the largest share of the well cost the farminee
 * can pay (from its earned interest Y up to the farmor's interest F) with
 * its EMV at or above 0. EMV is piecewise linear and non-increasing in the
 * share paid; its breakpoints are Y, F and, under a carry-amount cap, the
 * share at which each outcome's carry reaches the cap. EMV is rolled back at
 * every breakpoint and interpolated exactly on the segment where it crosses 0.
 */
const breakEvenPromote = (pr, project, deal, F, p) => {
  const Y = deal.earnedPct;
  const pts = [Y, F];
  if (deal.cap.on === 'carry-amount') {
    [project.wellCost.success, project.wellCost.dry].forEach((c) => { if (c > 0) { const k = Y + (100 * deal.cap.amount) / c; if (k > Y && k < F) pts.push(k); } });
  }
  const xs = [...new Set(pts)].sort((a, b) => a - b);
  const at = xs.map((x) => { const q = payoffs(pr, project, deal, F, x).farminee; return { farmineePaysPct: x, emv: emvOf(p, q.success, q.dry) }; });
  const out = (status, x) => ({ status, farmineePaysPct: x, promotePoints: x === null ? null : x - Y, promoteRatio: x === null ? null : x / Y, breakpoints: at });
  if (at[0].emv < 0) return out('negative-without-promote', null);
  if (at[at.length - 1].emv > 0) return out('positive-at-farmor-share', null);
  let j = at.length - 1;
  while (at[j].emv < 0) j -= 1;
  if (j === at.length - 1) return out('solved', at[j].farmineePaysPct);
  const a = at[j];
  const b = at[j + 1];
  return out('solved', a.farmineePaysPct + (a.emv * (b.farmineePaysPct - a.farmineePaysPct)) / (a.emv - b.emv));
};

const dealCore = ({ parties, farmor, farminee, project, deal }) => {
  const dp = checkDealParties(parties, farmor, farminee);
  if (dp.e) return { e: dp.e };
  const pr = checkProject(project);
  if (pr.e) return { e: pr.e };
  const e = checkDeal(deal, dp.F);
  if (e) return { e };
  return { F: dp.F, pr, po: payoffs(pr, project, deal, dp.F, deal.farmineePaysPct) };
};

/**
 * The value of the deal to each side on a stated risked prospect: the
 * farmor's choice among drilling alone, farming out and walking away, and
 * the farminee's choice between farming in and declining, each rolled back
 * by decisionTree.js; the transfer identity (farmor after + farminee +
 * assignor fees = farmor alone); the break-even promote; the break-even
 * chance of success for each position; the consideration the farmor receives.
 */
const dealImpl = (args) => {
  const c = dealCore(args);
  if (c.e) return c.e;
  const { farmor, farminee, project, deal } = args;
  const { F, pr, po } = c;
  const p = pr.p;
  const Y = deal.earnedPct;
  const X = deal.farmineePaysPct;
  const fd = decide('Farmor', p, [
    { label: 'drill alone', ...po.farmorAlone },
    { label: 'farm out', ...po.farmorFarmOut },
    { label: 'walk away', certain: 0 },
  ]);
  const nd = decide('Farminee', p, [{ label: 'farm in', ...po.farminee }, { label: 'decline', certain: 0 }]);
  const pos = (q, emv) => ({ success: q.success, dry: q.dry, emv });
  const alone = pos(po.farmorAlone, fd.emvs[0]);
  const out = pos(po.farmorFarmOut, fd.emvs[1]);
  const inn = pos(po.farminee, nd.emvs[0]);
  const bep = breakEvenPromote(pr, project, deal, F, p);
  const bc = { farmorAlone: breakEvenChance(po.farmorAlone.success, po.farmorAlone.dry), farmorFarmOut: breakEvenChance(po.farmorFarmOut.success, po.farmorFarmOut.dry), farminee: breakEvenChance(po.farminee.success, po.farminee.dry) };
  const expCarry = p * po.ws.carry + (1 - p) * po.wd.carry;
  const reasons = [
    `success-case value at 100%: ${money(pr.S)}${pr.flows ? ` (the canonical npv of the stated cash flows at ${fmt(pr.flows.discountRate)} to ${pr.flows.baseYear})` : ''}; chance of success ${fmt(project.chanceOfSuccessPct)}%`,
    `${farmor} alone (${fmt(F)}%): success ${money(alone.success)}, dry hole ${money(alone.dry)}, EMV ${money(alone.emv)}`,
    `${farmor} after the farm-out (${dec(F - Y)}%, paying ${money(po.ws.farmorPays)} of the success well and ${money(po.wd.farmorPays)} of the dry hole): success ${money(out.success)}, dry hole ${money(out.dry)}, EMV ${money(out.emv)}`,
    `${farminee.id} (${fmt(Y)}% for ${fmt(X)}% of the well): success ${money(inn.success)}, dry hole ${money(inn.dry)}, EMV ${money(inn.emv)}`,
    `${farmor}: the best action is ${fd.tied.length > 1 ? `a tie between ${fd.tied.join(', ')}` : fd.best}; ${farminee.id}: ${nd.tied.length > 1 ? `a tie between ${nd.tied.join(', ')}` : nd.best}`,
  ];
  if (bep.status === 'solved') reasons.push(`break-even promote: ${farminee.id}'s EMV is 0 when it pays ${dec(bep.farmineePaysPct)}% of the well for ${fmt(Y)}% (a promote of ${dec(bep.promotePoints)} points)`);
  else if (bep.status === 'negative-without-promote') reasons.push(`break-even promote: none; paying only its ${fmt(Y)}% share (no promote) ${farminee.id}'s EMV is ${money(bep.breakpoints[0].emv)}, below 0`);
  else reasons.push(`break-even promote: none up to the farmor's whole ${fmt(F)}% share; paying it, ${farminee.id}'s EMV is ${money(bep.breakpoints[bep.breakpoints.length - 1].emv)}, above 0`);
  reasons.push(bcReason(`${farmor} alone`, bc.farmorAlone), bcReason(`${farmor} after the farm-out`, bc.farmorFarmOut), bcReason(farminee.id, bc.farminee));
  if (deal.cashBonus === 0) reasons.push('cash bonus: none (stated as 0)');
  return {
    farmor, farminee: farminee.id, farmorInterestBeforePct: F, chanceOfSuccessPct: project.chanceOfSuccessPct, successValue100: pr.S,
    terms: { farmineePaysPct: X, earnedPct: Y, promotePoints: X - Y, promoteRatio: X / Y, cashBonus: deal.cashBonus, pastCostReimbursement: po.reimb, assignorFees: deal.assignorFees },
    wellCostSplit: {
      success: { grossCost: project.wellCost.success, farmineePays: po.ws.farmineePays, farmorPays: po.ws.farmorPays, carry: po.ws.carry, capState: po.ws.capState },
      dry: { grossCost: project.wellCost.dry, farmineePays: po.wd.farmineePays, farmorPays: po.wd.farmorPays, carry: po.wd.carry, capState: po.wd.capState },
    },
    farmor: { alone, farmOut: out, walkAway: 0, bestAction: fd.best, tiedActions: fd.tied },
    farmineeSide: { farmIn: inn, decline: 0, bestAction: nd.best, tiedActions: nd.tied },
    transfer: { farmorAloneEmv: alone.emv, farmorFarmOutEmv: out.emv, farmineeEmv: inn.emv, assignorFees: deal.assignorFees, difference: alone.emv - (out.emv + inn.emv + deal.assignorFees) },
    breakEvenPromote: bep,
    breakEvenChance: bc,
    consideration: { cashBonus: deal.cashBonus, pastCostReimbursement: po.reimb, carrySuccess: po.ws.carry, carryDry: po.wd.carry, expectedCarry: expCarry, expectedTotal: expCarry + deal.cashBonus + po.reimb, perPercentEarned: (expCarry + deal.cashBonus + po.reimb) / Y },
    reasons,
    basis: {
      emv: 'EMV = p x success + (1 - p) x dry hole for each position, rolled back by rollback from engines/economics/decisionTree.js; walking away and declining are worth 0; ties are reported',
      positions: 'success = the interest of the success-case value less the share of the success well cost; dry hole = less the share of the dry-hole cost; the farmor receives the cash bonus and the reimbursement and pays the assignor fees in both outcomes',
      scaling: 'every interest of the success-case value is the canonical applyJV of engines/economics/cashflow.ts on the 100% value (or on each year\'s net flow before the canonical npv), with no royalty, tax or cost',
      timing: 'the success-case value is at the valuation date; well costs, bonus, reimbursement and fees fall at the valuation date, undiscounted',
      transfer: 'farmor alone = farmor after the farm-out + farminee + assignor fees: the deal moves value between the two sides and the fees leave both',
      breakEvenPromote: 'the largest share of the well cost the farminee can pay with its EMV at or above 0: exact, EMV being linear in the share between the breakpoints (the earned interest, the farmor\'s interest, and each outcome\'s carry reaching a carry-amount cap)',
      breakEvenChance: 'EMV is linear in the chance of success: p* = -dry / (success - dry) when success and dry hole have opposite signs; with both at or above 0 the EMV is never negative, with both at or below 0 never positive',
      source: `${CITE.psu} (drill yourself against farm out, EMV); ${CITE.hmrc} OT30021; every chance, value, cost, share and amount is a stated input with no default`,
    },
  };
};

// ---- value of information ----------------------------------------------------------------

/**
 * The value of information to one side under the deal: EVPI and EVII (with
 * the stated signal likelihoods and cost) from engines/economics/decisionTree.js
 * over the outcomes success and dry hole, with that side's actions and
 * payoffs from dealValue.
 */
const infoImpl = (args) => {
  const { side, information } = args;
  const c = dealCore(args);
  if (c.e) return c.e;
  let e = oneOf('side', side, ['farmor', 'farminee']);
  if (e) return e;
  if (!isObj(information)) return must('information', 'an object { cost, signals }', information);
  e = first(nonNeg('information.cost', information.cost), listOf('information.signals', information.signals, DEFAULTS.MAX_SIGNALS));
  if (e) return e;
  const sig = information.signals;
  if (sig.length < 2) return must('information.signals', 'an array of at least 2 signals', sig);
  for (let i = 0; i < sig.length; i += 1) {
    const f = `information.signals[${i}]`;
    e = text(`${f}.label`, sig[i].label);
    if (e) return e;
    const l = sig[i].likelihoodsPct;
    if (!Array.isArray(l) || l.length !== 2) return must(`${f}.likelihoodsPct`, 'an array [P(signal | success), P(signal | dry hole)] in per cent', l);
    e = first(pct(`${f}.likelihoodsPct[0]`, l[0]), pct(`${f}.likelihoodsPct[1]`, l[1]));
    if (e) return e;
  }
  for (const k of [0, 1]) {
    const t = sum(sig.map((s) => s.likelihoodsPct[k]));
    if (Math.abs(t - 100) > 1e-9) return refuse('information.signals', `must have likelihoodsPct[${k}] summing to 100 over the signals (P(signal | ${k === 0 ? 'success' : 'dry hole'})); got a sum of ${fmt(t)}`);
  }
  const { pr, po } = c;
  const p = pr.p;
  const outcomes = [{ label: 'success', probability: p }, { label: 'dry hole', probability: 1 - p }];
  const actions = side === 'farminee'
    ? [{ label: 'farm in', payoffs: [po.farminee.success, po.farminee.dry] }, { label: 'decline', payoffs: [0, 0] }]
    : [{ label: 'drill alone', payoffs: [po.farmorAlone.success, po.farmorAlone.dry] }, { label: 'farm out', payoffs: [po.farmorFarmOut.success, po.farmorFarmOut.dry] }, { label: 'walk away', payoffs: [0, 0] }];
  const signals = sig.map((s) => ({ label: s.label, likelihoods: [s.likelihoodsPct[0] / 100, s.likelihoodsPct[1] / 100] }));
  const pi = evpi(outcomes, actions);
  const ii = evii(outcomes, actions, signals, information.cost);
  const perSignal = ii.perSignal.map((s) => ({ label: s.label, probability: s.pSignal, posteriorSuccessPct: s.posterior[0] * 100, emv: s.emv, bestAction: actions[s.bestActionIndex].label, tiedActions: s.tiedActionIndices.map((i) => actions[i].label) }));
  const reasons = [
    `${side}: EMV without information ${money(pi.emvPrior)}; with perfect information ${money(pi.evWithPerfect)}; EVPI ${money(pi.evpi)}`,
    ...perSignal.map((s) => `signal "${s.label}" (probability ${dec(s.probability)}): chance of success ${dec(s.posteriorSuccessPct)}%, best action ${s.tiedActions.length > 1 ? `a tie between ${s.tiedActions.join(', ')}` : s.bestAction}, EMV ${money(s.emv)}`),
    `EVII ${money(ii.evii)}; less the information cost ${money(information.cost)}: ${money(ii.netEvii)}; ${ii.netEvii > 0 ? 'the information is worth buying' : ii.netEvii === 0 ? 'the information is worth exactly its cost' : 'the information costs more than it is worth'}`,
  ];
  return {
    side, actions: actions.map((a) => ({ label: a.label, success: a.payoffs[0], dry: a.payoffs[1] })),
    emvPrior: pi.emvPrior, evWithPerfectInformation: pi.evWithPerfect, evpi: pi.evpi,
    evWithInformation: ii.evWithInfo, evii: ii.evii, informationCost: information.cost, netEvii: ii.netEvii, perSignal,
    reasons,
    basis: {
      engine: 'evpi and evii from engines/economics/decisionTree.js (Bayes from the stated likelihoods, so the signal chances and posteriors are consistent by construction); the payoffs are the side\'s positions under the deal',
      source: 'decisionTree.js (Newendorp and Schuyler; Mian); every likelihood and the cost are stated inputs',
    },
  };
};

// ---- price for an interest ------------------------------------------------------------------

/**
 * Value per percent of working interest at the success-case value's own
 * discount rate: the 100% position (success = success-case value - success
 * well cost; dry hole = - dry-hole cost) is rolled back by decisionTree.js
 * for the risked EMV; valueBasis states which figure prices the interest.
 * The interest's value is the canonical applyJV scaling of that figure.
 * Transaction metrics are ratios of stated inputs, reported only.
 */
const interestImpl = ({ project, interestPct, valueBasis, transaction }) => {
  const pr = checkProject(project);
  if (pr.e) return pr.e;
  let e = first(pctPos('interestPct', interestPct), oneOf('valueBasis', valueBasis, ['risked', 'success-case']));
  if (e) return e;
  if (transaction !== undefined) {
    if (!isObj(transaction)) return must('transaction', 'an object { price, volumeUnit, reserves, production } when given', transaction);
    e = nonNeg('transaction.price', transaction.price);
    if (e) return e;
    if (transaction.reserves !== undefined) {
      e = first(text('transaction.volumeUnit', transaction.volumeUnit), listOf('transaction.reserves', transaction.reserves, DEFAULTS.MAX_RESERVES));
      if (e) return e;
      const seen = new Set();
      for (let i = 0; i < transaction.reserves.length; i += 1) {
        const r = transaction.reserves[i];
        e = first(text(`transaction.reserves[${i}].category`, r.category), positive(`transaction.reserves[${i}].grossVolume`, r.grossVolume));
        if (e) return e;
        if (seen.has(r.category)) return must(`transaction.reserves[${i}].category`, 'a category no other entry names', r.category);
        seen.add(r.category);
      }
    } else if (transaction.volumeUnit !== undefined) return must('transaction.volumeUnit', 'left out when no reserves are stated', transaction.volumeUnit);
    if (transaction.production !== undefined) {
      const q = transaction.production;
      if (!isObj(q)) return must('transaction.production', 'an object { grossRate, rateUnit } when given', q);
      e = first(positive('transaction.production.grossRate', q.grossRate), text('transaction.production.rateUnit', q.rateUnit));
      if (e) return e;
    }
  }
  const success100 = pr.S - project.wellCost.success;
  const dry100 = -project.wellCost.dry;
  const risked100 = emvOf(pr.p, success100, dry100);
  const perPct = { risked: risked100 / 100, successCase: success100 / 100 };
  const baseValue = valueBasis === 'risked' ? risked100 : success100;
  const interestValue = scaleWI(baseValue, interestPct);
  const reasons = [
    `100% position: success ${money(success100)} (success-case value ${money(pr.S)} less the success well cost ${money(project.wellCost.success)}), dry hole ${money(dry100)}; risked EMV at ${fmt(project.chanceOfSuccessPct)}% ${money(risked100)}`,
    `per percent of working interest: risked ${money(perPct.risked)}, success case ${money(perPct.successCase)}; ${fmt(interestPct)}% on the ${valueBasis === 'risked' ? 'risked' : 'success-case'} basis is worth ${money(interestValue)}`,
  ];
  let tx = null;
  if (transaction !== undefined) {
    const impliedPerPct = transaction.price / interestPct;
    const basisPerPct = baseValue / 100;
    const reserves = (transaction.reserves ?? []).map((r) => { const net = (r.grossVolume * interestPct) / 100; return { category: r.category, grossVolume: r.grossVolume, netVolume: net, pricePerUnit: transaction.price / net }; });
    const prod = transaction.production ? { grossRate: transaction.production.grossRate, rateUnit: transaction.production.rateUnit, netRate: (transaction.production.grossRate * interestPct) / 100 } : null;
    if (prod) prod.pricePerFlowingUnit = transaction.price / prod.netRate;
    tx = {
      price: transaction.price, impliedPerPct, implied100: impliedPerPct * 100,
      priceToValue: basisPerPct > 0 ? impliedPerPct / basisPerPct : null,
      volumeUnit: transaction.volumeUnit ?? null, reserves, production: prod,
    };
    reasons.push(`stated price ${money(transaction.price)} for ${fmt(interestPct)}%: ${money(impliedPerPct)} a percent, ${money(tx.implied100)} for 100%${tx.priceToValue === null ? `; no price-to-value ratio, the ${valueBasis} value per percent being ${money(basisPerPct)}, at or below 0` : `; ${dec(tx.priceToValue)} times the ${valueBasis} value per percent`}`);
    reserves.forEach((r) => reasons.push(`${r.category}: ${dec(r.netVolume)} ${transaction.volumeUnit} net to the interest; ${money(r.pricePerUnit)} per ${transaction.volumeUnit}`));
    if (prod) reasons.push(`production: ${dec(prod.netRate)} ${prod.rateUnit} net to the interest; ${money(prod.pricePerFlowingUnit)} per ${prod.rateUnit}`);
  }
  return {
    interestPct, valueBasis, chanceOfSuccessPct: project.chanceOfSuccessPct, successValue100: pr.S,
    position100: { success: success100, dry: dry100, emv: risked100 },
    perPct, interestValue, transaction: tx,
    reasons,
    basis: {
      rule: 'value per percent = the 100% figure / 100; the risked figure is the EMV of the 100% position (rollback from engines/economics/decisionTree.js); the success-case figure is the success-case value less the success well cost',
      scaling: 'the interest\'s value is the canonical applyJV scaling of engines/economics/cashflow.ts',
      metrics: 'transaction metrics are ratios of stated inputs (price, volumes, rates), reported only: no market value is asserted',
      source: 'NPV per percent of working interest at the stated discount rate; the reserve category and its volume are stated as the user classifies them',
    },
  };
};

// ---- risk sharing ------------------------------------------------------------------------------

/**
 * Each stated position (a set of holdings: an interest in a prospect, or a
 * certain amount stated as chanceOfSuccessPct 100) through the canonical
 * portfolioRiskMetrics of engines/economics/portfolio.js: closed-form EMV
 * and spread, and a seeded Monte Carlo (lib/stats mulberry32) for the chance
 * of a loss and the low and high cases. seed, iterations and correlation are
 * stated inputs.
 */
const riskImpl = ({ positions, correlation, seed, iterations }) => {
  let e = first(listOf('positions', positions, DEFAULTS.MAX_POSITIONS),
    fin(correlation) && correlation >= 0 && correlation <= 1 ? null : must('correlation', 'a number from 0 to 1 (the correlation of the latent drivers; stated, no default)', correlation),
    Number.isInteger(seed) && seed >= 0 && seed <= 4294967295 ? null : must('seed', 'an integer from 0 to 4294967295 (stated; no default)', seed),
    Number.isInteger(iterations) && iterations >= 1 && iterations <= DEFAULTS.MAX_ITERATIONS ? null : must('iterations', `an integer from 1 to ${DEFAULTS.MAX_ITERATIONS} (stated; no default)`, iterations));
  if (e) return e;
  const seenP = new Set();
  for (let i = 0; i < positions.length; i += 1) {
    const ps = positions[i];
    const f = `positions[${i}]`;
    e = first(text(`${f}.name`, ps.name), listOf(`${f}.holdings`, ps.holdings, DEFAULTS.MAX_HOLDINGS));
    if (e) return e;
    if (seenP.has(ps.name)) return must(`${f}.name`, 'a name no other position has', ps.name);
    seenP.add(ps.name);
    const seen = new Set();
    for (let k = 0; k < ps.holdings.length; k += 1) {
      const h = ps.holdings[k];
      const g = `${f}.holdings[${k}]`;
      e = first(text(`${g}.id`, h.id), pct(`${g}.chanceOfSuccessPct`, h.chanceOfSuccessPct), finite(`${g}.successValue`, h.successValue), nonNeg(`${g}.failCost`, h.failCost), nonNeg(`${g}.successStdDev`, h.successStdDev));
      if (e) return e;
      if (seen.has(h.id)) return must(`${g}.id`, 'an id no other holding in the position has', h.id);
      seen.add(h.id);
    }
  }
  const holdings = sum(positions.map((ps) => ps.holdings.length));
  if (iterations * holdings > DEFAULTS.MAX_DRAW_WORK) return must('iterations', `at most ${Math.floor(DEFAULTS.MAX_DRAW_WORK / holdings)} for ${unit(holdings, 'holding')} in all (iterations x holdings at most ${DEFAULTS.MAX_DRAW_WORK})`, iterations);
  const reasons = [];
  const rows = positions.map((ps) => {
    const r = portfolioRiskMetrics(ps.holdings.map((h) => ({ name: h.id, pos: h.chanceOfSuccessPct / 100, npv_p50: h.successValue, fail_cost: h.failCost, npv_stddev: h.successStdDev })), correlation, { seed, iterations });
    reasons.push(`${ps.name}: EMV ${money(r.emv)}, standard deviation ${money(r.stdDev)}; chance of a loss ${dec(r.probLoss)} (${unit(iterations, 'draw')}, seed ${seed}); low case ${money(r.p90)}, high case ${money(r.p10)}`);
    return { name: ps.name, emv: r.emv, stdDev: r.stdDev, independentStdDev: r.independentStdDev, probLoss: r.probLoss, p90: r.p90, p10: r.p10 };
  });
  return {
    correlation, seed, iterations, positions: rows,
    reasons,
    basis: {
      engine: 'portfolioRiskMetrics from engines/economics/portfolio.js: EMV and standard deviation closed form (success/failure mixtures, equal pairwise correlation); the chance of a loss and the low and high cases from its seeded Monte Carlo (lib/stats mulberry32, a one-factor Gaussian copula)',
      labels: 'p90 is the low case and p10 the high case (probability of exceedance, lib/conventions/percentile.js)',
      holding: 'a holding succeeds with its stated chance, worth its success value (with its stated standard deviation) or loses its fail cost; a certain amount is a holding with chanceOfSuccessPct 100 and standard deviation 0',
      source: 'engines/economics/portfolio.js; every chance, value, spread, the correlation, the seed and the iterations are stated inputs',
    },
  };
};

// ---- the Nigerian assignment consent fee ---------------------------------------------------------

/**
 * The fee on an assignment of an interest. basis "nuprc-2024-r19": the
 * consent of the Minister (a PPL or PML) costs seven per cent of the value of
 * the transaction, two per cent processing and five per cent premium; an
 * intra group transfer the two per cent alone (reg. 19(2)). A PEL assignment
 * needs the consent of the Commission (reg. 16), whose fee reg. 19(2) does
 * not set: it is refused under this basis. basis "stated": the rates are
 * stated inputs. Payment timing (reg. 19(7) to (9)): within 90 days of the
 * notification of the consent; a further 30 days; then a surcharge of 0.01%
 * of the fee a day, straight line, for up to 90 days; unpaid after that, the
 * consent is deemed withdrawn. Days count from the notification date to the
 * payment date.
 */
const consentImpl = ({ licence, transactionValue, valueSource, intraGroup, basis, ratesPct, payment }) => {
  let e = first(oneOf('basis', basis, ['nuprc-2024-r19', 'stated']), oneOf('licence', licence, ['PPL', 'PML', 'PEL']), nonNeg('transactionValue', transactionValue),
    oneOf('valueSource', valueSource, ['contract-amount', 'commission-determined']));
  if (e) return e;
  let proc;
  let prem;
  if (basis === 'nuprc-2024-r19') {
    if (licence === 'PEL') return must('licence', '"PPL" or "PML" under basis "nuprc-2024-r19": reg. 19(2) sets the fee for the consent of the Minister, and a PEL assignment needs the consent of the Commission (reg. 16); state its rates under basis "stated"', licence);
    e = first(bool('intraGroup', intraGroup), ratesPct !== undefined ? must('ratesPct', 'left out under basis "nuprc-2024-r19" (2% processing and 5% premium, reg. 19(2))', ratesPct) : null);
    if (e) return e;
    proc = NIGERIA_ASSIGNMENT.processingFeePct;
    prem = intraGroup ? 0 : NIGERIA_ASSIGNMENT.premiumPct;
  } else {
    if (intraGroup !== undefined) return must('intraGroup', 'left out under basis "stated" (the stated rates apply)', intraGroup);
    if (payment !== undefined) return must('payment', 'left out under basis "stated" (the payment timing is reg. 19(7) to (9))', payment);
    if (!isObj(ratesPct)) return must('ratesPct', 'an object { processingPct, premiumPct } under basis "stated" (no default)', ratesPct);
    e = first(pct('ratesPct.processingPct', ratesPct.processingPct), pct('ratesPct.premiumPct', ratesPct.premiumPct));
    if (e) return e;
    proc = ratesPct.processingPct;
    prem = ratesPct.premiumPct;
  }
  let pay = null;
  if (payment !== undefined) {
    if (!isObj(payment)) return must('payment', 'an object { notifiedOn, paidOn } when given', payment);
    e = first(realDate('payment.notifiedOn', payment.notifiedOn), realDate('payment.paidOn', payment.paidOn));
    if (e) return e;
    if (payment.paidOn < payment.notifiedOn) return must('payment.paidOn', `on or after the notification ${payment.notifiedOn}`, payment.paidOn);
  }
  const processing = (transactionValue * proc) / 100;
  const premium = (transactionValue * prem) / 100;
  const fee = processing + premium;
  const reasons = [`${licence}: ${fmt(proc)}% processing${prem > 0 ? ` + ${fmt(prem)}% premium` : ''} on the value of the transaction ${money(transactionValue)} (${valueSource === 'contract-amount' ? 'the amount payable to the Assignor stated in the contract' : 'an amount the Commission determines'}, reg. 19(3)) = ${money(fee)}${basis === 'nuprc-2024-r19' && intraGroup ? ' (an intra group transfer: the processing fee alone)' : ''}; paid by the Assignor and not tax deductible`];
  if (payment !== undefined) {
    const N = NIGERIA_ASSIGNMENT;
    const days = dayNo(payment.paidOn) - dayNo(payment.notifiedOn);
    const late = days - (N.payWithinDays + N.graceDays);
    let status;
    let surchargeDays = 0;
    if (days <= N.payWithinDays) status = 'on-time';
    else if (late <= 0) status = 'within-grace';
    else if (late <= N.surchargeDays) { status = 'surcharge'; surchargeDays = late; } else status = 'consent-deemed-withdrawn';
    const surcharge = status === 'surcharge' ? (fee * N.surchargePctPerDay * surchargeDays) / 100 : 0;
    pay = { days, status, surchargeDays, surcharge, totalPaid: status === 'consent-deemed-withdrawn' ? null : fee + surcharge };
    reasons.push(status === 'on-time' ? `paid ${unit(days, 'day')} after the notification: within the ${N.payWithinDays} days of reg. 19(7)`
      : status === 'within-grace' ? `paid ${unit(days, 'day')} after the notification: inside the further ${N.graceDays} days of reg. 19(8); no surcharge`
        : status === 'surcharge' ? `paid ${unit(days, 'day')} after the notification: ${unit(surchargeDays, 'day')} after the ${N.payWithinDays} + ${N.graceDays} days; surcharge ${fmt(N.surchargePctPerDay)}% of ${money(fee)} x ${unit(surchargeDays, 'day')} = ${money(surcharge)} (reg. 19(9), straight line)`
          : `paid ${unit(days, 'day')} after the notification: more than ${N.surchargeDays} surcharge days after the ${N.payWithinDays} + ${N.graceDays} days; the consent is deemed withdrawn (reg. 19(9))`);
  }
  return {
    licence, feeBasis: basis, transactionValue, valueSource, intraGroup: intraGroup ?? null,
    processingPct: proc, premiumPct: prem, processingFee: processing, premium, fee, taxDeductible: false, payer: 'assignor',
    payment: pay,
    reasons,
    basis: {
      rule: basis === 'nuprc-2024-r19' ? 'seven per cent of the value of the transaction: two per cent processing fee and five per cent premium; an intra group transfer two per cent (reg. 19(2))' : 'the stated processing and premium rates on the value of the transaction',
      value: 'the value of the transaction is a stated input: the sum payable to the Assignor stated in the application or contract, or an amount the Commission determines (reg. 19(3)); the engine does not decide which consideration of a farm-out counts',
      tax: 'not tax deductible (reg. 19(5); PIA s.95(12)); fees paid for assigning rights to another party are not deductible (PIA s.264(f) and s.302(12)(c))',
      timing: 'days from the notification of the consent to the payment: within 90 on time, 30 more of grace, then 0.01% of the fee a day straight line for up to 90 days, after which the consent is deemed withdrawn (reg. 19(7) to (9))',
      consent: 'a PPL or PML assignment needs the prior written consent of the Minister on the Commission\'s recommendation (PIA s.95(1) and (2)); a change of control above 50% is an assignment (s.95(3) and (14)); a PEL assignment needs the consent of the Commission (s.95(15); reg. 16)',
      source: `${CITE.aoi} reg. 16 and 19; ${CITE.pia} s.95, s.264(f), s.302(12)(c)`,
    },
  };
};

// ---- after the farm-in: a development carry or a back-in (jointVenture.js) ---------------------

const postDeal = (parties, farmor, farminee, earnedPct, F, keepFarmor) => {
  const e = pctPos('earnedPct', earnedPct);
  if (e) return { e };
  if (keepFarmor ? !(earnedPct < F) : earnedPct > F) return { e: must('earnedPct', keepFarmor ? `below the farmor's interest ${fmt(F)} (the farmor keeps a carried interest)` : `at most the farmor's interest ${fmt(F)}`, earnedPct) };
  const rows = interestsAfter(parties, farmor, farminee, earnedPct).filter((r) => r.participatingPct > 0);
  return { rows: rows.map((r) => ({ id: r.id, participatingPct: r.participatingPct })) };
};

/**
 * A development carry after the farm-in (HMRC OT30022, OT18360): the
 * farminee pays carriedPct % of the farmor's post-deal cost share and
 * recovers it, with the stated uplift, from the farmor's share of each year's
 * entitlement, through carryRecovery of engines/economics/jointVenture.js on
 * the post-deal interests.
 */
const devCarryImpl = ({ parties, farmor, farminee, earnedPct, carriedPct, years, uplift, recoverFromPct, cap, discountRate, baseYear }) => {
  const dp = checkDealParties(parties, farmor, farminee);
  if (dp.e) return dp.e;
  const pd = postDeal(parties, farmor, farminee, earnedPct, dp.F, true);
  if (pd.e) return pd.e;
  const r = jvCarryRecovery({ parties: pd.rows, carries: [{ carried: farmor, carriedPct, carriers: { [farminee.id]: 100 } }], carried: farmor, years, uplift, recoverFromPct, cap, basis: 'contract', discountRate, baseYear });
  if (r.error) return r.field.startsWith('carries[0].') ? refuse(r.field.replace('carries[0].', ''), r.error.slice(r.field.length + 1)) : r;
  const { basis: jb, ...rest } = r;
  return {
    interestsAfter: pd.rows,
    ...rest,
    reasons: [`after the farm-in: ${pd.rows.map((x) => `${x.id} ${dec(x.participatingPct)}%`).join(', ')}; ${farminee.id} carries ${fmt(carriedPct)}% of ${farmor}'s ${dec(dp.F - earnedPct)}% cost share`, ...r.reasons],
    basis: {
      engine: 'carryRecovery from engines/economics/jointVenture.js on the post-deal interests (the farmor carried by the farminee alone), basis "contract"',
      carry: jb.rule, uplift: jb.uplift,
      note: 'HMRC OT18360 describes the recovery as usually including an addition representing simple interest; carryRecovery states the uplift as none, compound or a multiple, and the contract\'s form is chosen from these',
      source: `${CITE.hmrc} OT30022 and OT18360; every share, uplift and cap is a stated input`,
    },
  };
};

/**
 * A back-in after the farm-in (a reversionary interest raised at a stated
 * trigger, or state participation under PIA s.85(4)) through backIn of
 * engines/economics/jointVenture.js on the post-deal interests. The trigger
 * itself is a contract event reported by the caller.
 */
const backInImpl = ({ parties, farmor, farminee, earnedPct, backIn }) => {
  const dp = checkDealParties(parties, farmor, farminee);
  if (dp.e) return dp.e;
  const pd = postDeal(parties, farmor, farminee, earnedPct, dp.F, false);
  if (pd.e) return pd.e;
  if (!isObj(backIn)) return must('backIn', 'an object { party, targetPct, costs, basis, refundForm, ... }', backIn);
  const { party, ...b } = backIn;
  const pid = pd.rows.map((x) => x.id);
  const e = oneOf('backIn.party', party, pid);
  if (e) return e;
  const r = jvBackIn({ parties: pd.rows, backInParty: party, ...b });
  if (r.error) return refuse(`backIn.${r.field}`, r.error.slice(r.field.length + 1));
  const { basis: jb, ...rest } = r;
  return {
    interestsAfterFarmIn: pd.rows,
    ...rest,
    reasons: [`after the farm-in: ${pd.rows.map((x) => `${x.id} ${dec(x.participatingPct)}%`).join(', ')}`, ...r.reasons],
    basis: { engine: 'backIn from engines/economics/jointVenture.js on the post-deal interests', rule: jb.rule, refundable: jb.refundable, source: jb.source },
  };
};

// ---- public entry points: every one checks its accepted keys first ------------

export const earningObligation = guard('earningObligation', earningImpl);
export const dealValue = guard('dealValue', dealImpl);
export const informationValue = guard('informationValue', infoImpl);
export const interestValue = guard('interestValue', interestImpl);
export const riskSharing = guard('riskSharing', riskImpl);
export const consentFee = guard('consentFee', consentImpl);
export const developmentCarry = guard('developmentCarry', devCarryImpl);
export const backInRight = guard('backInRight', backInImpl);
