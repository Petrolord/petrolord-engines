/**
 * Tender evaluation and contracting (Supply Chain SC2): two-envelope
 * evaluation, weighted technical and commercial scoring, lowest evaluated
 * cost, contract type under duration uncertainty, should-cost, and Nigerian
 * content scoring under the Nigerian Oil and Gas Industry Content
 * Development Act 2010. All deterministic.
 *
 * Pure functions, no I/O. Every function returns either a result object
 * carrying a `basis` (the rules applied and where they come from, so a course
 * can print the working) or `{ error, field }`, where `field` names the input
 * refused and the message starts with that name and states the exact
 * condition that failed.
 *
 * Sources (FINDINGS-tender.md has URLs, editions and the dates read):
 *   WB Reg     World Bank Procurement Regulations for IPF Borrowers, Seventh
 *              Edition, September 2025: para 5.50 (Rated Criteria weighting
 *              matrix and the US$10 million high-value line), 5.69 and 5.70
 *              (Most Advantageous Bid: highest ranked with Rated Criteria,
 *              lowest evaluated cost without), 6.29 (two envelopes opened and
 *              evaluated sequentially), Annex X 3.5 to 3.9 (adjusted bid
 *              price, life-cycle cost on a net present cost basis, financial
 *              score inversely proportional to price).
 *   WB SPD     World Bank SPD Request for Bids, Works, two-envelope,
 *              September 2025: ITB 34.1 (a missing or non-conforming item is
 *              priced at the AVERAGE price quoted by the substantially
 *              responsive bidders, else the Employer's best estimate), ITB
 *              35.1 (arithmetic correction: the unit price prevails over the
 *              line total unless the decimal point in the unit price is
 *              obviously misplaced; subtotals prevail over the total), and
 *              Section III (evaluated bid score B = Clow / C x X x 100 +
 *              T / Thigh x (1 - X) x 100; completion beyond the minimum period
 *              adjusted at a stated rate a week, no credit for earlier
 *              completion, beyond the maximum rejected).
 *   WB Guid    World Bank Procurement Guidance, Evaluating Bids and
 *              Proposals, February 2025: the comparative scoring worked
 *              examples (Figures IX to XII, Annexes 2 and 3).
 *   PPA 2007   Nigeria Public Procurement Act 2007 (Act No. 14): s.31(7) major
 *              deviations reject a bid, s.31(14) minor deviations are
 *              quantified in money, s.32(3) omissions quantified, s.51(2)
 *              prices compared only for proposals rated at or above the
 *              threshold.
 *   NOGICD     Nigerian Oil and Gas Industry Content Development Act 2010
 *              (Act No. 2): s.11 and the Schedule (minimum Nigerian content by
 *              item and its measured unit), s.14 (bids within 1% at the
 *              commercial stage: the bid with the highest Nigerian content is
 *              selected provided its content is at least 5% higher than its
 *              closest competitor), s.16 (a Nigerian indigenous company with
 *              capacity is not disqualified solely for not being the lowest
 *              bidder, provided its price does not exceed the lowest by 10
 *              percent).
 *
 * Conventions, stated once:
 *   money       one currency throughout, whatever unit the caller uses.
 *   ties        two figures TIE when they agree to 12 significant digits
 *               (Number(x.toPrecision(12))). The stated tie-break for a
 *               ranking is the lower evaluated cost, then the earlier
 *               receipt time, then the bidder id ascending (JavaScript <
 *               on strings). receivedAt is 'YYYY-MM-DDTHH:MM:SSZ', so the
 *               string order is the time order.
 *   percent     technical scores, Nigerian content and pass marks are
 *               percentages 0 to 100; weights for the technical/commercial
 *               split are fractions 0 to 1.
 *   boundaries  per rule, in the boundary table of FINDINGS-tender.md.
 *   Monte Carlo lib/stats mulberry32(seed), one stream; per iteration the
 *               duration draw comes first, then the daily cost draw when it
 *               varies; each value is the triangular inverse CDF of its
 *               uniform (lib/stats triInvCDF). Summaries by lib/stats
 *               basicStats: P90 is the 10th percentile of the sorted values
 *               (index floor(0.1 n)), P50 floor(0.5 n), P10 floor(0.9 n),
 *               the exceedance labels of lib/conventions/percentile.js.
 *   NPV         life-cycle cost is discounted by the canonical
 *               engines/economics/cashflow.ts npv, year-end, years 1..N.
 *   reasons     figures in messages print as the shortest round-trip decimal.
 *
 * Validation: tools/validation/supplychain/oracle_tender.py (stdlib python)
 * writes test-data/supplychain/goldens/tender_cases.json;
 * FINDINGS-tender.md, negcontrol_tender.sh, timing_tender.mjs. Fixtures
 * (synthetic Ekene tenders): test-data/supplychain/ekene-tender/.
 */

import { mulberry32, triInvCDF, basicStats } from '../../lib/stats/stats.js';
import { EXCEEDANCE_DEFINITION } from '../../lib/conventions/percentile.js';
import { npv } from '../economics/cashflow.ts';
import { evaluateProgram, afeCosts } from '../drilling/wellCost.js';
import { calculatePartnerCosts } from '../economics/afe.js';

export const DEFAULTS = Object.freeze({
  TIE_DIGITS: 12,
  ARITHMETIC_TOLERANCE: 0.005,
  WEIGHT_SUM: 100,
  WEIGHT_SUM_TOLERANCE: 1e-9,
  MAX_BIDS: 100,
  MAX_CRITERIA: 50,
  MAX_LINES: 5000,
  MAX_ITEMS: 200,
  MAX_YEARS: 100,
  MAX_ITERATIONS: 200000,
  HIGH_VALUE_USD: 10000000,
  NC_PRICE_MARGIN_PCT: 1,
  NC_LEAD_PCT: 5,
  INDIGENOUS_MARGIN_PCT: 10,
});

/**
 * NOGICD Act 2010, Schedule (Sections 3(2), 11(1)-(4), 34 and 70(d)): the
 * minimum Nigerian content by item, as printed, for the sections a
 * well-services or materials tender draws on. `measures` are the Act's
 * measured units; two lines print two units and accept either.
 */
const S = (section, description, ncPct, ...measures) => Object.freeze({ section, description, ncPct, measures: Object.freeze(measures) });
const MAT = 'MATERIALS AND PROCUREMENT';
const WDS = 'WELL AND DRILLING SERVICES/PETROLEUM TECHNOLOGY';
const EXP = 'EXPLORATION, SUBSURFACE, PETROLEUM ENGINEERING AND SEISMIC';
export const NC_SCHEDULE = Object.freeze({
  'steel-plates-flat-sheets-sections': S(MAT, 'Steel plates, Flat Sheets, Sections', 100, 'tonnage'),
  'steel-pipes': S(MAT, 'Steel Pipes', 100, 'tonnage'),
  'low-voltage-cables': S(MAT, 'Low Voltage Cables', 90, 'length'),
  'high-voltage-cables': S(MAT, 'High Voltage Cables', 45, 'length'),
  valves: S(MAT, 'Valves', 60, 'number'),
  'drilling-mud-baryte-bentonite': S(MAT, 'Drilling mud-Baryte, Bentonite', 60, 'tonnage'),
  'cement-portland': S(MAT, 'Cement (Portland)', 80, 'tonnage'),
  'cement-hydraulic': S(MAT, 'Cement (Hydraulic)', 60, 'tonnage'),
  'heat-exchangers': S(MAT, 'Heat exchangers', 50, 'number'),
  'steel-ropes': S(MAT, 'Steel Ropes', 60, 'tonnage'),
  'protective-paints': S(MAT, 'Protective paints', 60, 'litres'),
  'gre-pipes': S(MAT, 'Glass Reinforced Epoxy (GRE) pipes', 60, 'tonnage'),
  'reservoir-services': S(WDS, 'Reservoir Services', 75, 'spend'),
  'well-completion-services': S(WDS, 'Well completion services (permanent gauges and intelligent wells)', 80, 'spend'),
  'wireline-services': S(WDS, 'Wire line services (electric open holes, electric cased hole, slick line)', 45, 'spend'),
  'lwd-services': S(WDS, 'Logging While Drilling (LWD) services', 75, 'man-hours'),
  'mwd-services': S(WDS, 'Measurement While Drilling (MWD) (direction and inclination/Gamma ray)', 90, 'man-hours'),
  'production-drilling-service': S(WDS, 'Production drilling service', 85, 'man-hours'),
  'performance-services-t-and-p': S(WDS, 'Performance services (T and P)', 90, 'man-hours'),
  'well-overhauling-stimulation-services': S(WDS, 'Well Overhauling/Stimulation Services', 85, 'man-hours'),
  'wellhead-services': S(WDS, 'Wellhead Services', 85, 'man-hours'),
  'directional-surveying-services': S(WDS, 'Directional Surveying Services', 100, 'man-hours'),
  'cutting-injection-disposal-services': S(WDS, 'Cutting Injections/Cutting Disposal Services', 100, 'man-hours'),
  'cased-hole-logging-services': S(WDS, 'Cased Hole Logging Services (Gyro, Perforation, Gauges, PLT)', 90, 'man-hours'),
  'well-watch-services': S(WDS, 'Well Watch Services', 70, 'man-hours'),
  'cement-service': S(WDS, 'Cement service', 75, 'man-hours'),
  'coiled-tubing-services': S(WDS, 'Coiled Tubing Services', 75, 'man-hours'),
  'pumping-services': S(WDS, 'Pumping Services', 95, 'man-hours'),
  'fluid-bottom-hole-sampling-services': S(WDS, 'Fluid/Bottom Hole Sampling Services', 80, 'man-hours'),
  'octg-services': S(WDS, 'OCTS Services (Cleaning, hard banding, recutting, rethreading, storage)', 95, 'man-hours'),
  'well-crisis-management-services': S(WDS, 'Well Crisis Management Services', 90, 'man-hours'),
  'directional-drilling-services': S(WDS, 'Directional Drilling Services', 90, 'man-hours'),
  'other-drilling-services': S(WDS, 'Other Drilling Services', 80, 'man-hours'),
  'rental-of-drill-pipe': S(WDS, 'Rental of Drill Pipe', 75, 'spend'),
  'well-head-safety-panels': S(WDS, 'Well head Safety panels', 100, 'spend'),
  'chemicals-drilling-process-maintenance': S(WDS, 'CHEMICAL: Drilling, process, Maintenance', 90, 'spend'),
  'mud-logging-services': S(EXP, 'Mud logging services', 90, 'spend'),
  'coring-services': S(EXP, 'Coring services', 90, 'spend'),
  'well-testing-service': S(EXP, 'Well Testing Service', 55, 'spend'),
  'drilling-rigs-swamp': S(EXP, 'Drilling rigs (Swamp)', 60, 'man-hours'),
  'drilling-rigs-offshore': S(EXP, 'Drilling Rigs (Semi submersibles/Jack ups/Others)', 55, 'man-hours'),
  'drilling-rigs-land': S(EXP, 'Drilling Rigs (Land)', 70, 'man-hours'),
  'work-over-rigs-swamp': S(EXP, 'Work-over Rigs (Swamp)', 70, 'spend'),
  'snubbing-services': S(EXP, 'Snubbing Services', 80, 'spend'),
  'liner-float-hangers-running-equipment': S(EXP, 'Liner Float, Hangers and Running Equipment Services', 55, 'spend'),
});
export const NC_MEASURES = Object.freeze(['man-hours', 'tonnage', 'spend', 'length', 'number', 'volume', 'litres']);

const CITE = Object.freeze({
  matrix: 'World Bank Procurement Regulations for IPF Borrowers (7th ed., Sep 2025) para 5.50 and Annex X para 3.3, Figure 1',
  twoEnvelope: 'World Bank Procurement Regulations (7th ed.) para 6.29; Nigeria Public Procurement Act 2007 s.51(2)',
  arithmetic: 'World Bank SPD Request for Bids, Works, two-envelope (Sep 2025) ITB 35.1(a) and (b)',
  omission: 'World Bank SPD Request for Bids, Works, two-envelope (Sep 2025) ITB 34.1',
  schedule: 'World Bank SPD Request for Bids, Works, two-envelope (Sep 2025) Section III, time for completion',
  lifeCycle: 'World Bank Procurement Regulations (7th ed.) Annex X paras 3.7 and 3.8',
  adjusted: 'World Bank Procurement Regulations (7th ed.) Annex X para 3.6; Nigeria Public Procurement Act 2007 s.31(14) and s.32(3)',
  combined: 'World Bank SPD Request for Bids, Works, two-envelope (Sep 2025) Section III, combined evaluation: B = Clow / C x X x 100 + T / Thigh x (1 - X) x 100',
  lowestCost: 'World Bank Procurement Regulations (7th ed.) para 5.70; Nigeria Public Procurement Act 2007 s.24(3) and s.33(1)',
  s14: 'Nigerian Oil and Gas Industry Content Development Act 2010 s.14',
  s16: 'Nigerian Oil and Gas Industry Content Development Act 2010 s.16',
  schedule2010: 'Nigerian Oil and Gas Industry Content Development Act 2010 s.11 and the Schedule',
});

// ---- helpers ---------------------------------------------------------------

const refuse = (field, message) => ({ error: `${field} ${message}`, field });
const fmt = (x) => String(x);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const key12 = (x) => Number(x.toPrecision(DEFAULTS.TIE_DIGITS));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RECEIVED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const sum = (xs) => xs.reduce((s, v) => s + v, 0);

const checkIds = (list, field) => {
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const x = list[i];
    if (!isObj(x)) return refuse(`${field}[${i}]`, 'must be an object');
    if (typeof x.id !== 'string' || x.id === '') return refuse(`${field}[${i}].id`, 'must be a non-empty string');
    if (seen.has(x.id)) return refuse(`${field}[${i}].id`, `repeats the id '${x.id}'`);
    seen.add(x.id);
  }
  return null;
};

const checkList = (list, field, max, min = 1) => {
  if (!Array.isArray(list) || list.length < min) return refuse(field, `must be an array of at least ${plural(min, 'entry', 'entries')}`);
  if (list.length > max) return refuse(field, `has ${list.length} entries; the cap is ${max}`);
  return checkIds(list, field);
};

/**
 * Rank ids by a primary key. `better(a, b)` < 0 when a ranks above b on the
 * primary key (ties at 12 significant digits are handled here). The tie-break
 * is the stated one: lower evaluated cost, earlier receipt, bidder id.
 * Returns rows in rank order with the rule that ordered each row against the
 * row above it (null when the primary key alone did).
 */
const rankRows = (rows, primary, descending) => {
  const keyOf = (r) => key12(primary(r));
  const chain = (a, b) => {
    const ka = keyOf(a); const kb = keyOf(b);
    if (ka !== kb) return { c: descending ? kb - ka : ka - kb, by: null };
    const ca = key12(a.evaluatedCost); const cb = key12(b.evaluatedCost);
    if (ca !== cb) return { c: ca - cb, by: 'lower evaluated cost' };
    if (a.receivedAt !== b.receivedAt) return { c: cmpStr(a.receivedAt, b.receivedAt), by: 'earlier receipt' };
    return { c: cmpStr(a.id, b.id), by: 'bidder id' };
  };
  const sorted = rows.slice().sort((a, b) => chain(a, b).c);
  return sorted.map((r, i) => ({ row: r, rank: i + 1, tieBrokenBy: i === 0 ? null : chain(sorted[i - 1], r).by }));
};

// ---- Rated Criteria weighting band -----------------------------------------

/**
 * The Rated Criteria weighting range for a contract (WB Reg para 5.50):
 * risk 'high' (High/Substantial) or 'low' (Moderate/Low); high value when the
 * estimated cost is at or above US$10 million. With technicalWeight (a
 * fraction) it also says whether that weight is inside the range (both ends
 * inclusive).
 */
export const weightingBand = ({ risk, estimatedCostUsd, technicalWeight } = {}) => {
  if (risk !== 'high' && risk !== 'low') return refuse('risk', "must be 'high' (High/Substantial) or 'low' (Moderate/Low)");
  if (!fin(estimatedCostUsd) || estimatedCostUsd < 0) return refuse('estimatedCostUsd', 'must be a finite number at or above 0');
  if (technicalWeight !== undefined && (!fin(technicalWeight) || technicalWeight < 0 || technicalWeight > 1)) return refuse('technicalWeight', 'must be a number from 0 to 1');
  const highValue = estimatedCostUsd >= DEFAULTS.HIGH_VALUE_USD;
  const cells = {
    'high-true': ['a', 0.5, 0.8], 'high-false': ['b', 0.6, 1], 'low-true': ['c', 0.1, 0.4], 'low-false': ['d', 0.2, 0.3],
  };
  const [cell, min, max] = cells[`${risk}-${highValue}`];
  const out = {
    cell, highValue, min, max,
    basis: {
      rule: `para 5.50 (${cell}): ${risk === 'high' ? 'High/Substantial' : 'Moderate/Low'} Procurement Risk and ${highValue ? 'High' : 'Low'} Value, Rated Criteria weighting between ${fmt(min * 100)}% and ${fmt(max * 100)}%; high value means an estimated cost at or above US$10 million`,
      source: CITE.matrix,
    },
  };
  if (technicalWeight !== undefined) {
    out.technicalWeight = technicalWeight;
    out.withinBand = technicalWeight >= min && technicalWeight <= max;
    out.reason = out.withinBand
      ? `technical weight ${fmt(technicalWeight)} is inside the range ${fmt(min)} to ${fmt(max)}`
      : `technical weight ${fmt(technicalWeight)} is outside the range ${fmt(min)} to ${fmt(max)}; misapplication of the matrix may lead to misprocurement (Annex X para 3.4)`;
  }
  return out;
};

// ---- arithmetic correction -------------------------------------------------

const checkLines = (lines, field) => {
  const e = checkList(lines, field, DEFAULTS.MAX_LINES);
  if (e) return e;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    for (const k of ['quantity', 'unitRate', 'quotedAmount']) {
      if (!fin(l[k]) || l[k] < 0) return refuse(`${field}[${i}].${k}`, 'must be a finite number at or above 0');
    }
    if (l.decimalMisplaced !== undefined && typeof l.decimalMisplaced !== 'boolean') return refuse(`${field}[${i}].decimalMisplaced`, 'must be true or false when given');
    if (l.decimalMisplaced === true && !(l.quantity > 0)) return refuse(`${field}[${i}].quantity`, 'must be above 0 when decimalMisplaced is true (the unit rate is corrected as quoted amount / quantity)');
  }
  return null;
};

const correctLines = (lines, tolerance) => lines.map((l) => {
  const computed = l.quantity * l.unitRate;
  const gap = Math.abs(computed - l.quotedAmount);
  const discrepancy = gap > tolerance;
  if (!discrepancy) {
    return { id: l.id, quantity: l.quantity, unitRate: l.unitRate, quotedAmount: l.quotedAmount, correctedUnitRate: l.unitRate, correctedAmount: l.quotedAmount, rule: null, reason: null };
  }
  if (l.decimalMisplaced === true) {
    const rate = l.quotedAmount / l.quantity;
    return {
      id: l.id, quantity: l.quantity, unitRate: l.unitRate, quotedAmount: l.quotedAmount, correctedUnitRate: rate, correctedAmount: l.quotedAmount, rule: 'total-governs',
      reason: `line ${l.id}: quantity x unit rate = ${fmt(computed)} differs from the quoted ${fmt(l.quotedAmount)} and the decimal point in the unit rate is obviously misplaced, so the quoted amount governs and the unit rate is corrected to ${fmt(rate)}`,
    };
  }
  return {
    id: l.id, quantity: l.quantity, unitRate: l.unitRate, quotedAmount: l.quotedAmount, correctedUnitRate: l.unitRate, correctedAmount: computed, rule: 'unit-rate-prevails',
    reason: `line ${l.id}: quantity x unit rate = ${fmt(computed)} differs from the quoted ${fmt(l.quotedAmount)} by more than ${fmt(tolerance)}, so the unit rate prevails and the amount is corrected to ${fmt(computed)}`,
  };
});

/**
 * Correct a priced bill of quantities (WB SPD ITB 35.1(a) and (b)). A line is
 * in discrepancy when |quantity x unit rate - quoted amount| > tolerance
 * (default 0.005, half a cent). Then the unit rate prevails and the amount is
 * corrected, unless decimalMisplaced is true, when the quoted amount governs
 * and the unit rate is corrected. The corrected total is the sum of the
 * corrected lines (subtotals prevail over the total).
 */
export const correctArithmetic = ({ lines, quotedTotal, tolerance = DEFAULTS.ARITHMETIC_TOLERANCE } = {}) => {
  if (!fin(tolerance) || tolerance < 0) return refuse('tolerance', 'must be a finite number at or above 0');
  const e = checkLines(lines, 'lines');
  if (e) return e;
  if (quotedTotal !== undefined && (!fin(quotedTotal) || quotedTotal < 0)) return refuse('quotedTotal', 'must be a finite number at or above 0 when given');
  const out = correctLines(lines, tolerance);
  const linesTotal = sum(lines.map((l) => l.quotedAmount));
  const qt = quotedTotal === undefined ? linesTotal : quotedTotal;
  const correctedTotal = sum(out.map((l) => l.correctedAmount));
  const reasons = out.filter((l) => l.reason).map((l) => l.reason);
  if (quotedTotal !== undefined && Math.abs(quotedTotal - linesTotal) > tolerance) {
    reasons.push(`the quoted total ${fmt(quotedTotal)} differs from the sum of the quoted lines ${fmt(linesTotal)} by more than ${fmt(tolerance)}; the subtotals prevail`);
  }
  return {
    lines: out,
    quotedTotal: qt,
    correctedTotal,
    correction: correctedTotal - qt,
    linesCorrected: out.filter((l) => l.rule !== null).length,
    reasons,
    basis: {
      rule: `a line is in discrepancy when |quantity x unit rate - quoted amount| > ${fmt(tolerance)}; the unit rate prevails unless the decimal point in it is obviously misplaced, when the quoted amount governs; the corrected total is the sum of the corrected lines`,
      source: CITE.arithmetic,
    },
  };
};

// ---- two-envelope technical evaluation ------------------------------------

const checkCriteria = (criteria) => {
  const e = checkList(criteria, 'criteria', DEFAULTS.MAX_CRITERIA);
  if (e) return e;
  for (let i = 0; i < criteria.length; i += 1) {
    const c = criteria[i];
    if (!fin(c.weight) || c.weight <= 0) return refuse(`criteria[${i}].weight`, 'must be a finite number above 0');
    if (!fin(c.maxScore) || c.maxScore <= 0) return refuse(`criteria[${i}].maxScore`, 'must be a finite number above 0');
  }
  const w = sum(criteria.map((c) => c.weight));
  if (Math.abs(w - DEFAULTS.WEIGHT_SUM) > DEFAULTS.WEIGHT_SUM_TOLERANCE) return refuse('criteria', `weights must sum to 100; they sum to ${fmt(w)}`);
  return null;
};

/**
 * The technical envelope (WB Reg 6.29, Annex X 3.2; WB SPD scoring
 * methodology; PPA 2007 s.31 and s.51). A bid that fails a mandatory
 * requirement is excluded before scoring. Every other bid is scored:
 * technicalPercent = sum over criteria of weight x score / maxScore (the
 * weights sum to 100, so this is a percentage of the maximum), and
 * weightedPoints = sum of weight x score (the Guidance's Figure IX total).
 * A bid passes when technicalPercent >= passMark (at the pass mark passes).
 */
export const technicalEvaluation = ({ criteria, bids, passMark } = {}) => {
  let e = checkCriteria(criteria);
  if (e) return e;
  if (!fin(passMark) || passMark < 0 || passMark > 100) return refuse('passMark', 'must be a number from 0 to 100 (a percentage of the maximum technical score); there is no default');
  e = checkList(bids, 'bids', DEFAULTS.MAX_BIDS);
  if (e) return e;
  for (let i = 0; i < bids.length; i += 1) {
    const b = bids[i];
    if (b.mandatory !== undefined) {
      if (!Array.isArray(b.mandatory)) return refuse(`bids[${i}].mandatory`, 'must be an array of { id, met } when given');
      for (let j = 0; j < b.mandatory.length; j += 1) {
        const m = b.mandatory[j];
        if (!isObj(m) || typeof m.id !== 'string' || m.id === '' || typeof m.met !== 'boolean') return refuse(`bids[${i}].mandatory[${j}]`, 'must be { id: a non-empty string, met: true or false }');
      }
    }
    if (!isObj(b.scores)) return refuse(`bids[${i}].scores`, 'must be an object with one score per criterion id');
    for (const c of criteria) {
      const s = own(b.scores, c.id) ? b.scores[c.id] : undefined;
      if (!fin(s) || s < 0 || s > c.maxScore) return refuse(`bids[${i}].scores.${c.id}`, `must be a number from 0 to ${fmt(c.maxScore)} (the criterion's maxScore)`);
    }
  }
  const rows = bids.map((b) => {
    const failed = (b.mandatory || []).filter((m) => !m.met).map((m) => m.id);
    if (failed.length) {
      return { id: b.id, status: 'fail-mandatory', technicalPercent: null, weightedPoints: null, reason: `failed the mandatory requirement${failed.length > 1 ? 's' : ''} ${failed.join(', ')}; the bid is not scored and its commercial envelope is not opened` };
    }
    const technicalPercent = sum(criteria.map((c) => (c.weight * b.scores[c.id]) / c.maxScore));
    const weightedPoints = sum(criteria.map((c) => c.weight * b.scores[c.id]));
    if (technicalPercent >= passMark) return { id: b.id, status: 'pass', technicalPercent, weightedPoints, reason: null };
    return { id: b.id, status: 'fail-pass-mark', technicalPercent, weightedPoints, reason: `technical score ${fmt(technicalPercent)} is below the pass mark ${fmt(passMark)}; the commercial envelope is not opened` };
  });
  return {
    bids: rows,
    passed: rows.filter((r) => r.status === 'pass').map((r) => r.id),
    excluded: rows.filter((r) => r.status !== 'pass').map((r) => ({ id: r.id, stage: 'technical', reason: r.reason })),
    basis: {
      score: 'technicalPercent = sum of weight x score / maxScore over the criteria (weights sum to 100); weightedPoints = sum of weight x score',
      passMark: `a bid passes when technicalPercent >= ${fmt(passMark)}; only passing bids have their commercial envelope opened`,
      source: CITE.twoEnvelope,
    },
  };
};

// ---- lowest evaluated cost -------------------------------------------------

const lifeCycleCost = (annualCosts, residualValue, rate) => {
  const flows = annualCosts.slice();
  flows[flows.length - 1] -= residualValue;
  return npv(flows, rate, 0, 1);
};

/**
 * Evaluated cost of each bid (WB Reg Annex X 3.5 to 3.8; WB SPD ITB 34.1 and
 * 35.1; PPA 2007 s.31(14), s.32(3)):
 *   evaluatedCost = corrected price - discount + priced deviations
 *                   + omissions + schedule adjustment + life-cycle cost.
 * corrected price  correctArithmetic on the bid's lines (tolerance as there).
 * omissions        an item a bid leaves out is priced at the AVERAGE (WB SPD
 *                  ITB 34.1) or the HIGHEST (a stated alternative rule)
 *                  corrected amount for that item among the other responsive
 *                  bids that priced it; when none did, bestEstimates[item]
 *                  (the Employer's best estimate) is required.
 * schedule         with schedule { minWeeks, maxWeeks, ratePerWeek }: a bid
 *                  offering more than maxWeeks is nonresponsive and excluded;
 *                  otherwise ratePerWeek x max(0, weeks - minWeeks) x
 *                  (corrected price - discount) is added. No credit for
 *                  completion earlier than minWeeks.
 * life-cycle       with lifeCycle { years, discountRate }: each bid's
 *                  annualCosts (years 1..N, end of year) less its residual
 *                  value in year N, discounted by the canonical npv.
 * Ranking: evaluated cost ascending; ties at 12 significant digits go to the
 * earlier receipt, then the bidder id.
 */
export const evaluatedCosts = ({ bids, omissionRule, bestEstimates = {}, schedule, lifeCycle, tolerance = DEFAULTS.ARITHMETIC_TOLERANCE } = {}) => {
  if (omissionRule !== 'average' && omissionRule !== 'highest') return refuse('omissionRule', "must be 'average' (World Bank SPD ITB 34.1: the average price quoted by the substantially responsive bidders) or 'highest' (the highest price quoted by them, a stated alternative); there is no default");
  if (!fin(tolerance) || tolerance < 0) return refuse('tolerance', 'must be a finite number at or above 0');
  if (!isObj(bestEstimates)) return refuse('bestEstimates', 'must be an object of item id to amount when given');
  for (const k of Object.keys(bestEstimates)) if (!fin(bestEstimates[k]) || bestEstimates[k] < 0) return refuse(`bestEstimates.${k}`, 'must be a finite number at or above 0');
  if (schedule !== undefined) {
    if (!isObj(schedule)) return refuse('schedule', 'must be { minWeeks, maxWeeks, ratePerWeek } when given');
    if (!fin(schedule.minWeeks) || schedule.minWeeks < 0) return refuse('schedule.minWeeks', 'must be a finite number at or above 0');
    if (!fin(schedule.maxWeeks) || schedule.maxWeeks < schedule.minWeeks) return refuse('schedule.maxWeeks', 'must be a finite number at or above minWeeks');
    if (!fin(schedule.ratePerWeek) || schedule.ratePerWeek < 0 || schedule.ratePerWeek > 1) return refuse('schedule.ratePerWeek', 'must be a fraction from 0 to 1 of the price for each week beyond minWeeks');
  }
  if (lifeCycle !== undefined) {
    if (!isObj(lifeCycle)) return refuse('lifeCycle', 'must be { years, discountRate } when given');
    if (!Number.isInteger(lifeCycle.years) || lifeCycle.years < 1 || lifeCycle.years > DEFAULTS.MAX_YEARS) return refuse('lifeCycle.years', `must be a whole number from 1 to ${DEFAULTS.MAX_YEARS}`);
    if (!fin(lifeCycle.discountRate) || lifeCycle.discountRate <= -1 || lifeCycle.discountRate > 1) return refuse('lifeCycle.discountRate', 'must be a fraction above -1 and at most 1 (0.1 is 10 percent a year)');
  }
  let e = checkList(bids, 'bids', DEFAULTS.MAX_BIDS);
  if (e) return e;
  for (let i = 0; i < bids.length; i += 1) {
    const b = bids[i];
    if (typeof b.receivedAt !== 'string' || !RECEIVED_RE.test(b.receivedAt)) return refuse(`bids[${i}].receivedAt`, "must be a UTC time 'YYYY-MM-DDTHH:MM:SSZ'");
    e = checkLines(b.lines, `bids[${i}].lines`);
    if (e) return e;
    if (b.discount !== undefined && (!fin(b.discount) || b.discount < 0)) return refuse(`bids[${i}].discount`, 'must be a finite number at or above 0 when given');
    if (b.deviations !== undefined) {
      if (!Array.isArray(b.deviations)) return refuse(`bids[${i}].deviations`, 'must be an array of { id, amount, reason } when given');
      for (let j = 0; j < b.deviations.length; j += 1) {
        const d = b.deviations[j];
        if (!isObj(d) || typeof d.id !== 'string' || !fin(d.amount) || typeof d.reason !== 'string') return refuse(`bids[${i}].deviations[${j}]`, 'must be { id: a string, amount: a finite number, reason: a string }');
      }
    }
    if (b.omitted !== undefined) {
      if (!Array.isArray(b.omitted) || b.omitted.some((x) => typeof x !== 'string' || x === '')) return refuse(`bids[${i}].omitted`, 'must be an array of item ids when given');
      const priced = new Set(b.lines.map((l) => l.id));
      const both = b.omitted.find((x) => priced.has(x));
      if (both !== undefined) return refuse(`bids[${i}].omitted`, `lists '${both}', which the bid also prices`);
      if (new Set(b.omitted).size !== b.omitted.length) return refuse(`bids[${i}].omitted`, 'repeats an item id');
    }
    if (b.rejected !== undefined && (typeof b.rejected !== 'string' || b.rejected === '')) return refuse(`bids[${i}].rejected`, 'must be a non-empty reason string when given');
    if (schedule !== undefined && (!fin(b.completionWeeks) || b.completionWeeks < 0)) return refuse(`bids[${i}].completionWeeks`, 'must be a finite number at or above 0 when a schedule is given');
    if (lifeCycle !== undefined) {
      if (!Array.isArray(b.annualCosts) || b.annualCosts.length !== lifeCycle.years || b.annualCosts.some((x) => !fin(x))) return refuse(`bids[${i}].annualCosts`, `must be an array of ${plural(lifeCycle.years, 'finite number')}, one per life-cycle year`);
      if (b.residualValue !== undefined && !fin(b.residualValue)) return refuse(`bids[${i}].residualValue`, 'must be a finite number when given');
    }
  }
  // responsiveness first: rejected bids and schedule overruns do not price anyone's omissions
  const corrected = bids.map((b) => ({ b, c: correctArithmetic({ lines: b.lines, tolerance }) }));
  const excluded = [];
  const live = [];
  corrected.forEach(({ b, c }) => {
    if (b.rejected) { excluded.push({ id: b.id, stage: 'commercial', reason: b.rejected }); return; }
    if (schedule !== undefined && b.completionWeeks > schedule.maxWeeks) {
      excluded.push({ id: b.id, stage: 'commercial', reason: `offers completion in ${fmt(b.completionWeeks)} weeks, beyond the maximum ${fmt(schedule.maxWeeks)}; the bid is nonresponsive` });
      return;
    }
    live.push({ b, c });
  });
  const pricedBy = (item, self) => live.filter((x) => x.b.id !== self).map((x) => x.c.lines.find((l) => l.id === item)).filter(Boolean).map((l) => l.correctedAmount);
  const rows = [];
  for (const { b, c } of live) {
    const omissions = [];
    for (const item of b.omitted || []) {
      const prices = pricedBy(item, b.id);
      if (prices.length === 0) {
        if (!own(bestEstimates, item)) return refuse(`bestEstimates.${item}`, `is required: bid ${b.id} omits item ${item} and no other responsive bid prices it`);
        omissions.push({ item, amount: bestEstimates[item], rule: 'best-estimate', reason: `item ${item} omitted; no other responsive bid prices it, so the Employer's best estimate ${fmt(bestEstimates[item])} is added` });
      } else if (omissionRule === 'average') {
        const a = sum(prices) / prices.length;
        omissions.push({ item, amount: a, rule: 'average', reason: `item ${item} omitted; the average of the ${plural(prices.length, 'price')} quoted by the other responsive bids, ${fmt(a)}, is added` });
      } else {
        const h = Math.max(...prices);
        omissions.push({ item, amount: h, rule: 'highest', reason: `item ${item} omitted; the highest of the ${plural(prices.length, 'price')} quoted by the other responsive bids, ${fmt(h)}, is added` });
      }
    }
    const discount = b.discount || 0;
    const net = c.correctedTotal - discount;
    const deviations = (b.deviations || []).map((d) => ({ id: d.id, amount: d.amount, reason: d.reason }));
    let scheduleAdjustment = 0;
    let scheduleReason = null;
    if (schedule !== undefined) {
      const late = Math.max(0, b.completionWeeks - schedule.minWeeks);
      scheduleAdjustment = schedule.ratePerWeek * late * net;
      scheduleReason = late > 0
        ? `completion in ${fmt(b.completionWeeks)} weeks is ${fmt(late)} weeks beyond the minimum ${fmt(schedule.minWeeks)}; ${fmt(schedule.ratePerWeek)} x ${fmt(late)} x ${fmt(net)} = ${fmt(scheduleAdjustment)} is added`
        : `completion in ${fmt(b.completionWeeks)} weeks is not beyond the minimum ${fmt(schedule.minWeeks)}; no adjustment and no credit for earlier completion`;
    }
    const residual = b.residualValue || 0;
    const lifeCycleNpc = lifeCycle === undefined ? 0 : lifeCycleCost(b.annualCosts, residual, lifeCycle.discountRate);
    const omissionTotal = sum(omissions.map((o) => o.amount));
    const deviationTotal = sum(deviations.map((d) => d.amount));
    const evaluatedCost = net + deviationTotal + omissionTotal + scheduleAdjustment + lifeCycleNpc;
    rows.push({
      id: b.id, receivedAt: b.receivedAt, quotedTotal: c.quotedTotal, correctedPrice: c.correctedTotal, arithmeticCorrection: c.correction, discount,
      deviations, deviationTotal, omissions, omissionTotal, scheduleAdjustment, scheduleReason, lifeCycleCost: lifeCycleNpc, evaluatedCost,
      reasons: c.reasons.concat(omissions.map((o) => o.reason), deviations.map((d) => `deviation ${d.id}: ${d.reason} (${fmt(d.amount)})`), scheduleReason ? [scheduleReason] : []),
    });
  }
  const ranked = rankRows(rows, (r) => r.evaluatedCost, false);
  return {
    bids: ranked.map(({ row, rank, tieBrokenBy }) => ({ ...row, rank, tieBrokenBy })),
    lowestEvaluatedCost: ranked.length ? ranked[0].row.id : null,
    excluded,
    basis: {
      evaluatedCost: 'corrected price - discount + priced deviations + omissions + schedule adjustment + life-cycle cost',
      omission: omissionRule === 'average'
        ? `an omitted item is priced at the average of the corrected amounts quoted for it by the other responsive bids, else the Employer's best estimate (${CITE.omission})`
        : "an omitted item is priced at the highest corrected amount quoted for it by the other responsive bids, else the Employer's best estimate (a stated alternative to the average rule of World Bank SPD ITB 34.1)",
      schedule: schedule === undefined ? null : `ratePerWeek ${fmt(schedule.ratePerWeek)} of (corrected price - discount) for each week beyond ${fmt(schedule.minWeeks)}; beyond ${fmt(schedule.maxWeeks)} weeks the bid is rejected (${CITE.schedule})`,
      lifeCycle: lifeCycle === undefined ? null : `net present cost of ${plural(lifeCycle.years, 'year')} of annual costs at ${fmt(lifeCycle.discountRate)} a year, end-of-year discounting, residual value credited in the last year, through engines/economics/cashflow.ts npv (${CITE.lifeCycle})`,
      ranking: 'evaluated cost ascending; ties at 12 significant digits go to the earlier receipt, then the bidder id',
      source: `${CITE.adjusted}; ${CITE.lowestCost}`,
    },
  };
};

// ---- combined technical and commercial score -------------------------------

const PRICE_METHODS = ['lowest-ratio', 'linear', 'mean-deviation'];
const TECH_METHODS = ['relative', 'absolute'];

/**
 * Rank the bids that passed the technical envelope on a combined score
 * B = technicalWeight x St + (1 - technicalWeight) x Sc, both scores out of 100.
 * Sc, the commercial score of evaluated cost C:
 *   lowest-ratio    100 x Cmin / C (WB SPD combined evaluation; WB Reg
 *                   Annex X 3.9 "inversely proportional").
 *   linear          100 x (Cmax - C) / (Cmax - Cmin); every bid 100 when
 *                   Cmax = Cmin.
 *   mean-deviation  max(0, 100 x (1 - |C - Cmean| / Cmean)); the highest score
 *                   goes to the price nearest the mean.
 * St: 'relative' 100 x T / Thigh (WB SPD); 'absolute' T (the technicalPercent).
 * Ties at 12 significant digits: lower evaluated cost, earlier receipt, id.
 */
export const rankTender = ({ bids, technicalWeight, priceMethod, technicalMethod } = {}) => {
  if (!fin(technicalWeight) || technicalWeight < 0 || technicalWeight > 1) return refuse('technicalWeight', 'must be a number from 0 to 1 (the technical share of the combined score); there is no default');
  if (!PRICE_METHODS.includes(priceMethod)) return refuse('priceMethod', "must be 'lowest-ratio', 'linear' or 'mean-deviation'; there is no default");
  if (!TECH_METHODS.includes(technicalMethod)) return refuse('technicalMethod', "must be 'relative' (100 x T / Thigh) or 'absolute' (T as scored); there is no default");
  const e = checkList(bids, 'bids', DEFAULTS.MAX_BIDS);
  if (e) return e;
  for (let i = 0; i < bids.length; i += 1) {
    const b = bids[i];
    if (!fin(b.technicalPercent) || b.technicalPercent < 0 || b.technicalPercent > 100) return refuse(`bids[${i}].technicalPercent`, 'must be a number from 0 to 100');
    if (!fin(b.evaluatedCost) || b.evaluatedCost <= 0) return refuse(`bids[${i}].evaluatedCost`, 'must be a finite number above 0');
    if (typeof b.receivedAt !== 'string' || !RECEIVED_RE.test(b.receivedAt)) return refuse(`bids[${i}].receivedAt`, "must be a UTC time 'YYYY-MM-DDTHH:MM:SSZ'");
    if (b.rejected !== undefined && (typeof b.rejected !== 'string' || b.rejected === '')) return refuse(`bids[${i}].rejected`, 'must be a non-empty reason string when given');
  }
  const excluded = bids.filter((b) => b.rejected).map((b) => ({ id: b.id, stage: 'commercial', reason: b.rejected }));
  const live = bids.filter((b) => !b.rejected);
  if (live.length === 0) return refuse('bids', 'has no bid left to score: every bid is rejected');
  if (technicalMethod === 'relative' && Math.max(...live.map((b) => b.technicalPercent)) === 0) return refuse('bids', "all score 0 technically, so Thigh is 0 and the 'relative' technical score is undefined");
  const costs = live.map((b) => b.evaluatedCost);
  const cMin = Math.min(...costs);
  const cMax = Math.max(...costs);
  const cMean = sum(costs) / costs.length;
  const tHigh = Math.max(...live.map((b) => b.technicalPercent));
  const priceScore = (c) => {
    if (priceMethod === 'lowest-ratio') return (100 * cMin) / c;
    if (priceMethod === 'linear') return cMax === cMin ? 100 : (100 * (cMax - c)) / (cMax - cMin);
    return Math.max(0, 100 * (1 - Math.abs(c - cMean) / cMean));
  };
  const rows = live.map((b) => {
    const technicalScore = technicalMethod === 'relative' ? (100 * b.technicalPercent) / tHigh : b.technicalPercent;
    const commercialScore = priceScore(b.evaluatedCost);
    const combinedScore = technicalWeight * technicalScore + (1 - technicalWeight) * commercialScore;
    return { id: b.id, receivedAt: b.receivedAt, technicalPercent: b.technicalPercent, evaluatedCost: b.evaluatedCost, technicalScore, commercialScore, combinedScore };
  });
  const ranked = rankRows(rows, (r) => r.combinedScore, true);
  const priceRule = {
    'lowest-ratio': `Sc = 100 x Cmin / C with Cmin = ${fmt(cMin)}`,
    linear: cMax === cMin ? `Sc = 100 for every bid (Cmax = Cmin = ${fmt(cMin)})` : `Sc = 100 x (Cmax - C) / (Cmax - Cmin) with Cmin = ${fmt(cMin)}, Cmax = ${fmt(cMax)}`,
    'mean-deviation': `Sc = max(0, 100 x (1 - |C - Cmean| / Cmean)) with Cmean = ${fmt(cMean)}`,
  }[priceMethod];
  return {
    bids: ranked.map(({ row, rank, tieBrokenBy }) => ({ ...row, rank, tieBrokenBy })),
    mostAdvantageous: ranked[0].row.id,
    excluded,
    cMin, cMax, cMean, tHigh,
    basis: {
      combined: `B = ${fmt(technicalWeight)} x St + ${fmt(1 - technicalWeight)} x Sc`,
      technical: technicalMethod === 'relative' ? `St = 100 x T / Thigh with Thigh = ${fmt(tHigh)}` : 'St = T, the technical percentage as scored',
      commercial: priceRule,
      ranking: 'combined score descending; ties at 12 significant digits go to the lower evaluated cost, then the earlier receipt, then the bidder id',
      source: priceMethod === 'lowest-ratio' && technicalMethod === 'relative' ? CITE.combined : `${CITE.combined} (this call varies the method: FINDINGS-tender.md records the source of each)`,
    },
  };
};

// ---- Nigerian content ------------------------------------------------------

/**
 * Each bid's Nigerian content against the minimum for each item (NOGICD Act
 * 2010 s.11 and the Schedule). An item names a Schedule line (scheduleLine,
 * a key of NC_SCHEDULE) or states its own target { targetPct, measure,
 * source } where the Schedule has no line (s.11(2): the Board sets it). A
 * bid reports, per item, { measure, nigerian, total } in the item's measured
 * unit; content = 100 x nigerian / total and the item meets its minimum when
 * content >= target. A bid's overall content is 100 x sum nigerian / sum total
 * when every item has one measure, else the weighted mean of the item
 * contents with the bid's stated weights (the Act has no rule for adding
 * man-hours to tonnes).
 */
export const nigerianContent = ({ items, bids } = {}) => {
  let e = checkList(items, 'items', DEFAULTS.MAX_ITEMS);
  if (e) return e;
  const spec = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it.scheduleLine !== undefined) {
      if (!own(NC_SCHEDULE, it.scheduleLine)) return refuse(`items[${i}].scheduleLine`, `'${it.scheduleLine}' is not a line of NC_SCHEDULE; state targetPct, measure and source instead`);
      const s = NC_SCHEDULE[it.scheduleLine];
      spec.push({ id: it.id, targetPct: s.ncPct, measures: s.measures, source: `${CITE.schedule2010}, ${s.section}: ${s.description} ${s.ncPct}% by ${s.measures.join(' or ')}` });
    } else {
      if (!fin(it.targetPct) || it.targetPct < 0 || it.targetPct > 100) return refuse(`items[${i}].targetPct`, 'must be a number from 0 to 100 when no scheduleLine is given');
      if (!NC_MEASURES.includes(it.measure)) return refuse(`items[${i}].measure`, `must be one of ${NC_MEASURES.join(', ')}`);
      if (typeof it.source !== 'string' || it.source === '') return refuse(`items[${i}].source`, 'must state where the target comes from (a user-stated target is never a hidden default)');
      spec.push({ id: it.id, targetPct: it.targetPct, measures: [it.measure], source: `stated by the user: ${it.source}` });
    }
  }
  e = checkList(bids, 'bids', DEFAULTS.MAX_BIDS);
  if (e) return e;
  const oneMeasure = new Set(spec.map((s) => s.measures.length === 1 ? s.measures[0] : `*${s.id}`)).size === 1;
  for (let i = 0; i < bids.length; i += 1) {
    const b = bids[i];
    if (!isObj(b.items)) return refuse(`bids[${i}].items`, 'must be an object with one { measure, nigerian, total } per item id');
    for (const s of spec) {
      const r = own(b.items, s.id) ? b.items[s.id] : undefined;
      const f = `bids[${i}].items.${s.id}`;
      if (!isObj(r)) return refuse(f, 'is missing: every bid reports every item');
      if (!s.measures.includes(r.measure)) return refuse(`${f}.measure`, `must be ${s.measures.map((m) => `'${m}'`).join(' or ')}, the unit the minimum is measured in; got '${r.measure}'`);
      if (!fin(r.total) || r.total <= 0) return refuse(`${f}.total`, 'must be a finite number above 0');
      if (!fin(r.nigerian) || r.nigerian < 0 || r.nigerian > r.total) return refuse(`${f}.nigerian`, 'must be a number from 0 to total');
    }
    if (!oneMeasure) {
      if (!isObj(b.weights)) return refuse(`bids[${i}].weights`, 'are required: the items are measured in different units, so the overall content is the weighted mean of the item contents with stated weights (for example the priced amount of each item)');
      for (const s of spec) {
        const w = own(b.weights, s.id) ? b.weights[s.id] : undefined;
        if (!fin(w) || w < 0) return refuse(`bids[${i}].weights.${s.id}`, 'must be a finite number at or above 0');
      }
      if (!(sum(spec.map((s) => b.weights[s.id])) > 0)) return refuse(`bids[${i}].weights`, 'must not all be 0');
    }
  }
  const rows = bids.map((b) => {
    const its = spec.map((s) => {
      const r = b.items[s.id];
      const ncPct = (100 * r.nigerian) / r.total;
      const meets = ncPct >= s.targetPct;
      return { id: s.id, measure: r.measure, nigerian: r.nigerian, total: r.total, ncPct, targetPct: s.targetPct, meets, shortfallPct: meets ? 0 : s.targetPct - ncPct };
    });
    let ncPct;
    if (oneMeasure) ncPct = (100 * sum(its.map((x) => x.nigerian))) / sum(its.map((x) => x.total));
    else ncPct = sum(spec.map((s, j) => b.weights[s.id] * its[j].ncPct)) / sum(spec.map((s) => b.weights[s.id]));
    const short = its.filter((x) => !x.meets);
    return {
      id: b.id, items: its, ncPct, itemsMet: its.length - short.length, allMet: short.length === 0,
      reasons: short.map((x) => `item ${x.id}: Nigerian content ${fmt(x.ncPct)}% by ${x.measure} is below the minimum ${fmt(x.targetPct)}%`),
    };
  });
  return {
    bids: rows,
    aggregate: oneMeasure ? 'one-measure' : 'weighted',
    targets: spec.map((s) => ({ id: s.id, targetPct: s.targetPct, measures: s.measures.slice(), source: s.source })),
    basis: {
      item: 'content = 100 x nigerian / total in the measured unit of the Schedule line; the item meets its minimum when content >= the minimum',
      overall: oneMeasure ? 'overall = 100 x sum of Nigerian quantities / sum of total quantities (one measured unit for every item)' : "overall = weighted mean of the item contents with each bid's stated weights (the items are measured in different units)",
      source: CITE.schedule2010,
    },
  };
};

/**
 * The Act's two evaluation rules on evaluated costs.
 * s.14: the bids whose evaluated cost is within 1% of the lowest,
 *   100 x (C - Cmin) <= Cmin, form the group; with 2 or more in it, the bid
 *   with the highest Nigerian content is selected provided its content is at
 *   least 5% higher than its closest competitor, read as the next-highest
 *   content in the group. ncLeadBasis states how "5% higher" is read:
 *   'points' (lead >= 5 percentage points) or 'relative' (100 x (top -
 *   runner-up) >= 5 x runner-up). There is no default: the Act does not say.
 *   Otherwise the lowest evaluated cost stands.
 * s.16: a Nigerian indigenous company with capacity to execute the job is not
 *   disqualified solely because it is not the lowest bidder when its price
 *   does not exceed the lowest by 10 percent, 10 x (C - Cmin) <= Cmin. This
 *   rule protects a bid from exclusion; it does not select it.
 */
export const contentPreference = ({ bids, ncLeadBasis } = {}) => {
  if (ncLeadBasis !== 'points' && ncLeadBasis !== 'relative') return refuse('ncLeadBasis', "must be 'points' (at least 5 percentage points more) or 'relative' (at least 5 percent more than the runner-up's content); s.14 does not say which, so there is no default");
  const e = checkList(bids, 'bids', DEFAULTS.MAX_BIDS);
  if (e) return e;
  for (let i = 0; i < bids.length; i += 1) {
    const b = bids[i];
    if (!fin(b.evaluatedCost) || b.evaluatedCost <= 0) return refuse(`bids[${i}].evaluatedCost`, 'must be a finite number above 0');
    if (!fin(b.ncPct) || b.ncPct < 0 || b.ncPct > 100) return refuse(`bids[${i}].ncPct`, 'must be a number from 0 to 100');
    if (typeof b.receivedAt !== 'string' || !RECEIVED_RE.test(b.receivedAt)) return refuse(`bids[${i}].receivedAt`, "must be a UTC time 'YYYY-MM-DDTHH:MM:SSZ'");
    for (const k of ['indigenous', 'capacity']) if (b[k] !== undefined && typeof b[k] !== 'boolean') return refuse(`bids[${i}].${k}`, 'must be true or false when given');
  }
  const ranked = rankRows(bids.map((b) => ({ ...b })), (r) => r.evaluatedCost, false).map((x) => x.row);
  const lowest = ranked[0];
  const cMin = lowest.evaluatedCost;
  const group = ranked.filter((b) => 100 * (b.evaluatedCost - cMin) <= cMin);
  const s14 = { engaged: false, group: group.map((b) => b.id), leader: null, runnerUp: null, lead: null, leadBasis: ncLeadBasis, applied: false, reason: null };
  let selected = lowest.id;
  if (group.length < 2) {
    s14.reason = `only ${lowest.id} is within 1% of the lowest evaluated cost ${fmt(cMin)}; s.14 is not engaged`;
  } else {
    s14.engaged = true;
    const byNc = group.slice().sort((a, b) => (b.ncPct - a.ncPct) || 0);
    const [top, second] = byNc;
    // equal highest content: no single bid "contains the highest level"
    const tiedTop = byNc.filter((b) => b.ncPct === top.ncPct);
    if (tiedTop.length > 1) {
      s14.reason = `${tiedTop.map((b) => b.id).join(' and ')} share the highest Nigerian content ${fmt(top.ncPct)}%, so no single bid leads; the lowest evaluated cost ${lowest.id} stands`;
    } else {
      s14.leader = top.id;
      s14.runnerUp = second.id;
      const lead = ncLeadBasis === 'points' ? top.ncPct - second.ncPct : (100 * (top.ncPct - second.ncPct)) / second.ncPct;
      s14.lead = second.ncPct === 0 && ncLeadBasis === 'relative' ? null : lead;
      const ok = ncLeadBasis === 'points' ? top.ncPct - second.ncPct >= DEFAULTS.NC_LEAD_PCT : 100 * (top.ncPct - second.ncPct) >= DEFAULTS.NC_LEAD_PCT * second.ncPct;
      const leadText = ncLeadBasis === 'points'
        ? `${fmt(top.ncPct)}% against ${fmt(second.ncPct)}% (${second.id}), a lead of ${fmt(top.ncPct - second.ncPct)} percentage points`
        : second.ncPct === 0 ? `${fmt(top.ncPct)}% against 0% (${second.id}), more than 5% higher by any reading` : `${fmt(top.ncPct)}% against ${fmt(second.ncPct)}% (${second.id}), ${fmt(lead)}% higher`;
      if (ok) {
        s14.applied = true;
        selected = top.id;
        s14.reason = top.id === lowest.id
          ? `${top.id} is the lowest evaluated cost and also leads on Nigerian content, ${leadText}; s.14 confirms it`
          : `${plural(group.length, 'bid')} within 1% of the lowest evaluated cost; ${top.id} has the highest Nigerian content, ${leadText}, at least 5% higher, so s.14 selects ${top.id} over the lowest evaluated cost ${lowest.id}`;
      } else {
        s14.reason = `${plural(group.length, 'bid')} within 1% of the lowest evaluated cost; ${top.id} has the highest Nigerian content, ${leadText}, less than 5% higher, so the lowest evaluated cost ${lowest.id} stands`;
      }
    }
  }
  const s16 = ranked.filter((b) => b.indigenous === true && b.capacity === true).map((b) => {
    const within = 10 * (b.evaluatedCost - cMin) <= cMin;
    const abovePct = (100 * (b.evaluatedCost - cMin)) / cMin;
    return {
      id: b.id, abovePct, withinMargin: within,
      reason: within
        ? `${b.id} is a Nigerian indigenous company with capacity, ${fmt(abovePct)}% above the lowest evaluated cost, within 10 percent: it is not disqualified solely because it is not the lowest (s.16)`
        : `${b.id} is a Nigerian indigenous company with capacity, ${fmt(abovePct)}% above the lowest evaluated cost, more than 10 percent above: s.16 does not protect it`,
    };
  });
  return {
    lowestEvaluatedCost: lowest.id,
    section14: s14,
    section16: s16,
    selected,
    basis: {
      section14: `group: 100 x (C - Cmin) <= Cmin; lead read as ${ncLeadBasis === 'points' ? 'top - runner-up >= 5 percentage points' : '100 x (top - runner-up) >= 5 x runner-up'}; the runner-up is the next-highest Nigerian content in the group (${CITE.s14})`,
      section16: `10 x (C - Cmin) <= Cmin for a Nigerian indigenous company with capacity (${CITE.s16})`,
    },
  };
};

// ---- contract type under uncertainty ---------------------------------------

const checkTri = (d, field, { min = 0 } = {}) => {
  if (fin(d)) return d >= min ? null : refuse(field, `must be at or above ${fmt(min)}`);
  if (!isObj(d) || !fin(d.min) || !fin(d.mode) || !fin(d.max)) return refuse(field, 'must be a number or { min, mode, max } (triangular)');
  if (d.min < min) return refuse(`${field}.min`, `must be at or above ${fmt(min)}`);
  if (!(d.min <= d.mode && d.mode <= d.max)) return refuse(field, 'must have min <= mode <= max');
  return null;
};
const triOf = (d) => (fin(d) ? { min: d, mode: d, max: d } : d);
const varies = (d) => d.max > d.min;
const draw = (d, rng) => (varies(d) ? triInvCDF(rng(), d.min, d.mode, d.max) : d.mode);

/**
 * The same scope under three contract types, the duration and the
 * contractor's daily cost sampled through lib/stats (mulberry32 +
 * triangular inverse CDF). Per iteration the contractor's cost is
 * fixedCost + days x dailyCost, and the company pays:
 *   lump sum      lumpSum.price, whatever happens;
 *   day rate      dayRate.mobilisationFee + dayRate.rate x days;
 *   reimbursable  cost x (1 + feeFraction), or cost + fixedFee.
 * duration is { min, mode, max } days, or { program, nptFrac } where program
 * is a wellCost activity list and nptFrac a triangular fraction of productive
 * time (engines/drilling/wellCost.js evaluateProgram gives the days).
 * The plan is the modes (or `plan` { days, dailyCost }); an overrun is a
 * contractor cost above the plan cost. Per type: company cost mean and
 * P90/P50/P10 (basicStats), contractor margin mean and probability of loss,
 * and who carries the overrun: over the iterations with an overrun,
 * companyPays = mean of (pay - planned pay) x [overrun] and
 * contractorAbsorbs = mean of (planned margin - margin) x [overrun], which add
 * to expectedOverrun = mean of (cost - planned cost) x [overrun] exactly.
 */
export const contractTypes = ({ duration, dailyCost, fixedCost = 0, lumpSum, dayRate, reimbursable, plan, iterations, seed } = {}) => {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > DEFAULTS.MAX_ITERATIONS) return refuse('iterations', `must be a whole number from 1 to ${DEFAULTS.MAX_ITERATIONS}`);
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) return refuse('seed', 'must be a whole number from 0 to 4294967295; there is no default, so every run can be reproduced');
  let program = null;
  let durTri = null;
  if (isObj(duration) && duration.program !== undefined) {
    const e = checkTri(duration.nptFrac, 'duration.nptFrac');
    if (e) return e;
    try {
      program = { activities: duration.program, npt: triOf(duration.nptFrac) };
      evaluateProgram({ activities: program.activities, nptFrac: program.npt.mode });
    } catch (err) {
      return refuse('duration.program', `is refused by engines/drilling/wellCost.js: ${err.message}`);
    }
  } else {
    const e = checkTri(duration, 'duration');
    if (e) return e;
    durTri = triOf(duration);
  }
  let e = checkTri(dailyCost, 'dailyCost');
  if (e) return e;
  const costTri = triOf(dailyCost);
  if (!fin(fixedCost) || fixedCost < 0) return refuse('fixedCost', 'must be a finite number at or above 0');
  if (!isObj(lumpSum) || !fin(lumpSum.price) || lumpSum.price < 0) return refuse('lumpSum', 'must be { price } with price at or above 0');
  if (!isObj(dayRate) || !fin(dayRate.rate) || dayRate.rate < 0 || !fin(dayRate.mobilisationFee) || dayRate.mobilisationFee < 0) return refuse('dayRate', 'must be { rate, mobilisationFee }, both at or above 0');
  if (!isObj(reimbursable) || (reimbursable.feeFraction === undefined) === (reimbursable.fixedFee === undefined)) return refuse('reimbursable', 'must state exactly one of feeFraction (cost plus a percentage) or fixedFee (cost plus a fixed fee)');
  if (reimbursable.feeFraction !== undefined && (!fin(reimbursable.feeFraction) || reimbursable.feeFraction < 0 || reimbursable.feeFraction > 1)) return refuse('reimbursable.feeFraction', 'must be a fraction from 0 to 1');
  if (reimbursable.fixedFee !== undefined && (!fin(reimbursable.fixedFee) || reimbursable.fixedFee < 0)) return refuse('reimbursable.fixedFee', 'must be a finite number at or above 0');
  const daysOf = (u) => {
    if (!program) return u;
    return evaluateProgram({ activities: program.activities, nptFrac: u }).totals.totalDays;
  };
  const planDaysDefault = daysOf(program ? program.npt.mode : durTri.mode);
  if (plan !== undefined) {
    if (!isObj(plan) || !fin(plan.days) || plan.days < 0 || !fin(plan.dailyCost) || plan.dailyCost < 0) return refuse('plan', 'must be { days, dailyCost }, both at or above 0, when given');
  }
  const d0 = plan ? plan.days : planDaysDefault;
  const r0 = plan ? plan.dailyCost : costTri.mode;
  const cost0 = fixedCost + d0 * r0;
  const pays = {
    lumpSum: () => lumpSum.price,
    dayRate: (days) => dayRate.mobilisationFee + dayRate.rate * days,
    reimbursable: (days, cost) => (reimbursable.feeFraction !== undefined ? cost * (1 + reimbursable.feeFraction) : cost + reimbursable.fixedFee),
  };
  const types = Object.keys(pays);
  const pay0 = Object.fromEntries(types.map((t) => [t, pays[t](d0, cost0)]));
  const rng = mulberry32(seed);
  const dur = program ? program.npt : durTri;
  const company = Object.fromEntries(types.map((t) => [t, new Array(iterations)]));
  const margins = Object.fromEntries(types.map((t) => [t, new Array(iterations)]));
  const acc = Object.fromEntries(types.map((t) => [t, { companyPays: 0, contractorAbsorbs: 0, losses: 0 }]));
  const daysAll = new Array(iterations);
  const costAll = new Array(iterations);
  let overrunSum = 0;
  let overruns = 0;
  for (let i = 0; i < iterations; i += 1) {
    const days = daysOf(draw(dur, rng));
    const rate = draw(costTri, rng);
    const cost = fixedCost + days * rate;
    daysAll[i] = days;
    costAll[i] = cost;
    const over = cost > cost0;
    if (over) { overruns += 1; overrunSum += cost - cost0; }
    for (const t of types) {
      const p = pays[t](days, cost);
      const m = p - cost;
      company[t][i] = p;
      margins[t][i] = m;
      if (m < 0) acc[t].losses += 1;
      if (over) {
        acc[t].companyPays += p - pay0[t];
        acc[t].contractorAbsorbs += (pay0[t] - cost0) - m;
      }
    }
  }
  const pick = (s) => ({ mean: s.mean, p90: s.p90, p50: s.p50, p10: s.p10, min: s.min, max: s.max });
  const expectedOverrun = overrunSum / iterations;
  const out = {};
  for (const t of types) {
    const cs = basicStats(company[t]);
    const ms = basicStats(margins[t]);
    const companyPays = acc[t].companyPays / iterations;
    out[t] = {
      plannedPayment: pay0[t],
      companyCost: pick(cs),
      contractorMargin: { mean: ms.mean, planned: pay0[t] - cost0, probabilityOfLoss: acc[t].losses / iterations },
      overrun: { companyPays, contractorAbsorbs: acc[t].contractorAbsorbs / iterations, companyShare: expectedOverrun > 0 ? companyPays / expectedOverrun : null },
    };
  }
  const ds = basicStats(daysAll);
  const cs = basicStats(costAll);
  return {
    plan: { days: d0, dailyCost: r0, contractorCost: cost0 },
    duration: pick(ds),
    contractorCost: pick(cs),
    overrun: { probability: overruns / iterations, expectedOverrun },
    types: out,
    percentileDefinition: EXCEEDANCE_DEFINITION,
    basis: {
      sampling: `${plural(iterations, 'iteration')}, one mulberry32(${seed}) stream; per iteration a uniform for the ${program ? 'NPT fraction (days from engines/drilling/wellCost.js evaluateProgram)' : 'duration'}${varies(dur) ? '' : ' (constant: no draw)'} then one for the daily cost${varies(costTri) ? '' : ' (constant: no draw)'}; triangular inverse CDF (lib/stats triInvCDF)`,
      percentiles: 'lib/stats basicStats on the sorted values: P90 = index floor(0.1 n), P50 = floor(0.5 n), P10 = floor(0.9 n); for a cost, P90 is the low value and P10 the high value',
      overrun: 'an iteration overruns when its contractor cost exceeds the planned cost; companyPays + contractorAbsorbs = expectedOverrun, each a mean over all iterations with 0 where there is no overrun',
      payments: `lump sum ${fmt(lumpSum.price)}; day rate ${fmt(dayRate.mobilisationFee)} + ${fmt(dayRate.rate)} x days; reimbursable ${reimbursable.feeFraction !== undefined ? `cost x ${fmt(1 + reimbursable.feeFraction)}` : `cost + ${fmt(reimbursable.fixedFee)}`}`,
    },
  };
};

// ---- should-cost -----------------------------------------------------------

/**
 * An independent estimate built by engines/drilling/wellCost.js
 * (evaluateProgram then afeCosts, contingency included) and, with partners,
 * split by engines/economics/afe.js calculatePartnerCosts (the operator
 * carries what the partners do not). Each bid's evaluated cost is compared
 * with the estimate: ratio = cost / estimate, flagged 'below' when ratio <
 * band.low and 'above' when ratio > band.high (inside the band, both ends
 * included, no flag). The band is stated by the user: there is no published
 * threshold for an abnormally low or high bid.
 */
export const shouldCost = ({ program, nptFrac = 0, items, contingencyFrac = 0, partners, bids, band } = {}) => {
  if (!isObj(band) || !fin(band.low) || !fin(band.high) || band.low <= 0 || band.high < band.low) return refuse('band', 'must be { low, high } with 0 < low <= high (ratios of bid to estimate); there is no default');
  let est;
  try {
    const p = evaluateProgram({ activities: program, nptFrac });
    const c = afeCosts({ items, totalDays: p.totals.totalDays, drilledM: p.totals.drilledM, contingencyFrac });
    est = { totalDays: p.totals.totalDays, drilledM: p.totals.drilledM, baseUsd: c.baseUsd, contingencyUsd: c.contingencyUsd, estimate: c.totalUsd };
  } catch (err) {
    return refuse('program', `or its cost items are refused by engines/drilling/wellCost.js: ${err.message}`);
  }
  if (!(est.estimate > 0)) return refuse('items', 'give an estimate of 0; the bid-to-estimate ratio is undefined');
  let split = null;
  if (partners !== undefined) {
    if (!Array.isArray(partners)) return refuse('partners', 'must be an array of { name, working_interest } when given');
    const s = calculatePartnerCosts(est.estimate, partners);
    split = { operatorShare: s.operatorShare, operatorAmount: s.operatorAmount, partners: s.partnerAllocations.map((x) => ({ name: x.name, working_interest: x.working_interest, shareAmount: x.shareAmount })), valid: s.valid, note: s.note };
  }
  const e = checkList(bids, 'bids', DEFAULTS.MAX_BIDS);
  if (e) return e;
  for (let i = 0; i < bids.length; i += 1) if (!fin(bids[i].evaluatedCost) || bids[i].evaluatedCost < 0) return refuse(`bids[${i}].evaluatedCost`, 'must be a finite number at or above 0');
  const rows = bids.map((b) => {
    const ratio = b.evaluatedCost / est.estimate;
    const flag = ratio < band.low ? 'below' : ratio > band.high ? 'above' : null;
    return {
      id: b.id, evaluatedCost: b.evaluatedCost, ratio, flag,
      reason: flag === 'below' ? `bid-to-estimate ratio ${fmt(ratio)} is below the band's lower limit ${fmt(band.low)}: examine it as a possibly abnormally low bid`
        : flag === 'above' ? `bid-to-estimate ratio ${fmt(ratio)} is above the band's upper limit ${fmt(band.high)}` : null,
    };
  });
  return {
    ...est,
    split,
    bids: rows,
    basis: {
      estimate: 'engines/drilling/wellCost.js evaluateProgram then afeCosts: per-day items x total days, per-meter items x drilled metres, lump items as valued, contingency as a fraction of the base',
      split: split ? 'engines/economics/afe.js calculatePartnerCosts: each partner pays its working interest; the operator carries 100 less the partner total' : null,
      band: `flag when ratio < ${fmt(band.low)} or ratio > ${fmt(band.high)}; both limits are inside the band`,
    },
  };
};

// ---- the whole two-envelope tender -----------------------------------------

/**
 * One tender end to end: technical envelope, then the commercial envelope of
 * the bids that passed only (evaluatedCosts), then the award:
 *   award 'lowest-cost'  the lowest evaluated cost (WB Reg 5.70, PPA 2007
 *                        s.24(3)); with nigerianContent { ncLeadBasis } and
 *                        each bid's ncPct / indigenous / capacity, the Act's
 *                        s.14 and s.16 are applied at this commercial stage.
 *   award 'combined'     rankTender on the combined score (WB Reg 5.69).
 * Every exclusion carries its stage and reason.
 */
export const evaluateTender = ({ criteria, passMark, bids, omissionRule, bestEstimates, schedule, lifeCycle, award, technicalWeight, priceMethod, technicalMethod, nigerianContent: nc } = {}) => {
  if (award !== 'lowest-cost' && award !== 'combined') return refuse('award', "must be 'lowest-cost' or 'combined'; there is no default");
  if (nc !== undefined && award === 'combined') return refuse('nigerianContent', "applies s.14 at the commercial stage of a lowest-cost award; with award 'combined' state Nigerian content as a rated criterion with its weight instead");
  let e = checkList(bids, 'bids', DEFAULTS.MAX_BIDS);
  if (e) return e;
  const tech = technicalEvaluation({ criteria, passMark, bids: bids.map((b) => ({ id: b.id, mandatory: b.mandatory, scores: b.scores })) });
  if (tech.error) return tech;
  const passed = new Set(tech.passed);
  const open = bids.filter((b) => passed.has(b.id));
  const excluded = tech.excluded.slice();
  if (open.length === 0) {
    return { technical: tech, commercial: null, ranking: null, contentPreference: null, award: null, excluded, reason: 'no bid passed the technical envelope; no commercial envelope is opened', basis: { source: CITE.twoEnvelope } };
  }
  const commercial = evaluatedCosts({ bids: open.map((b) => { const { scores, mandatory, ncPct, indigenous, capacity, ...rest } = b; return rest; }), omissionRule, bestEstimates, schedule, lifeCycle });
  if (commercial.error) return commercial;
  excluded.push(...commercial.excluded);
  if (commercial.bids.length === 0) {
    return { technical: tech, commercial, ranking: null, contentPreference: null, award: null, excluded, reason: 'every opened bid was rejected at the commercial stage', basis: { source: CITE.twoEnvelope } };
  }
  const techById = new Map(tech.bids.map((r) => [r.id, r]));
  let ranking = null;
  let pref = null;
  let winner;
  if (award === 'combined') {
    ranking = rankTender({ technicalWeight, priceMethod, technicalMethod, bids: commercial.bids.map((r) => ({ id: r.id, technicalPercent: techById.get(r.id).technicalPercent, evaluatedCost: r.evaluatedCost, receivedAt: r.receivedAt })) });
    if (ranking.error) return ranking;
    winner = ranking.mostAdvantageous;
  } else {
    winner = commercial.lowestEvaluatedCost;
    if (nc !== undefined) {
      if (!isObj(nc)) return refuse('nigerianContent', 'must be { ncLeadBasis } when given');
      const byId = new Map(bids.map((b) => [b.id, b]));
      for (const r of commercial.bids) {
        const b = byId.get(r.id);
        if (!fin(b.ncPct)) return refuse(`bids[${bids.indexOf(b)}].ncPct`, 'is required for every bid that reaches the commercial stage when nigerianContent is given');
      }
      pref = contentPreference({ ncLeadBasis: nc.ncLeadBasis, bids: commercial.bids.map((r) => { const b = byId.get(r.id); return { id: r.id, evaluatedCost: r.evaluatedCost, receivedAt: r.receivedAt, ncPct: b.ncPct, indigenous: b.indigenous, capacity: b.capacity }; }) });
      if (pref.error) return pref;
      winner = pref.selected;
    }
  }
  return {
    technical: tech,
    commercial,
    ranking,
    contentPreference: pref,
    award: winner,
    excluded,
    reason: award === 'combined' ? `${winner} has the highest combined score` : pref && pref.section14.applied && winner !== commercial.lowestEvaluatedCost ? pref.section14.reason : `${winner} has the lowest evaluated cost`,
    basis: {
      stages: 'technical envelope (mandatory requirements, then the pass mark), then the commercial envelope of the passing bids only, then the award',
      award: award === 'combined' ? CITE.combined : CITE.lowestCost,
      source: CITE.twoEnvelope,
    },
  };
};
