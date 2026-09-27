/**
 * Reserves and resources under SPE-PRMS 2018 (Economics EC11): the class of a
 * project (Reserves, Contingent Resources, Prospective Resources or
 * Unrecoverable) from its stated discovery status, recovery project,
 * commerciality criteria and project status, with the PRMS sub-class checked
 * against those facts; the categories of its estimates (1P/2P/3P, 1C/2C/3C,
 * 1U/2U/3U) in the cumulative and the incremental form and the P90/P50/P10
 * exceedance meaning; the economic limit and entitlement of a low, best and
 * high technical forecast (the canonical cashflow.ts economic limit and
 * working-interest scaling); the aggregation of several projects by
 * arithmetic summation and by the canonical seeded Monte Carlo with a stated
 * correlation; and the year-to-year reconciliation of a category set with a
 * closing check.
 *
 * Pure functions, no I/O. Every function returns either a result object
 * carrying `reasons` (the working, in order) and a `basis` (the rules applied
 * and where they come from) or `{ error, field }`, where `field` names the
 * input refused and the message starts with that name. Every refusal reads
 * "<field> must <condition>; got <value>" (or, for an unknown key,
 * "<field> is not an accepted key; ...").
 *
 * Sources (FINDINGS-prms.md has URLs, editions, dates read and licences):
 *   PRMS      SPE-PRMS 2018, Petroleum Resources Management System (SPE, WPC,
 *             AAPG, SPEE, SEG, SPWLA, EAGE; June 2018, v1.03 with the 2022
 *             errata). Licensed CC BY-NC-ND 4.0: the engine and the course
 *             cite sections and teach by concept; they do not quote it.
 *             1.1.0.7, 2.1.1 (discovery), 2.1.2 (commerciality), 2.1.3
 *             (chance of commerciality, sub-classes, reserves status,
 *             economic status), Table 1 and Table 2, 2.2 (categories),
 *             3.1.2 and 3.1.3 (economic criteria and economic limit), 3.2.9
 *             (BOE), 3.3.1 (royalty), 4.2.5 and 4.2.6 (aggregation).
 *   PRMS FAQ  SPE OGRC, PRMS Frequently Asked Questions (Oct/Nov 2022): 3.3
 *             (1P = 0 when the low case fails, 2P kept), 4.3 and 4.4
 *             (economic limit and contract term), 6.9 (classes kept apart,
 *             risked quantities).
 *   AG 2011   Guidelines for Application of the PRMS (November 2011), 6.3 and
 *             6.4 (arithmetic and statistical addition; risked volumes).
 *   SEC       17 CFR 229.1202(a)(3) (Regulation S-K Item 1202: arithmetic
 *             summation beyond the field or property level) and 17 CFR
 *             210.4-10(a) (Regulation S-X Rule 4-10 definitions). US federal
 *             text, public domain.
 *   SI 37     Significant Crude Oil and Gas Discovery Regulations, 2023
 *             (S.I. No. 37 of 2023, Gazette No. 111 Vol. 110, 20 June 2023):
 *             reg. 6(3) (retention approved for at least 5 years onshore and
 *             in shallow water, 8 in deep water).
 *   PIA       Petroleum Industry Act 2021 (Act No. 6): s.78(8), (9), (13),
 *             (15) (commercial, significant and no-interest declarations,
 *             retention at most 10 years), s.79(1) (field development
 *             plan within two years), s.318 (significant crude oil and gas
 *             discovery: potentially commercial but cannot be declared
 *             commercial).
 *   engines   computeCashFlow, applyJV from ./cashflow.ts (the economic limit
 *             test, the cash flow, NPV and working-interest scaling);
 *             mulberry32, createCorrelatedSampler, cholesky,
 *             fitTriangularToPercentiles, triInvCDF, quantile, mean from
 *             ../../lib/stats/stats.js (the canonical Monte Carlo); the
 *             outcome labels and the exceedance sentence from
 *             ../../lib/conventions/percentile.js. None is re-implemented.
 *
 * Conventions, stated once:
 *   quantities  one stated unit per call (the economic limit takes oil in bbl
 *               and gas in Mscf; BOE uses a stated Mscf per BOE and is
 *               supplementary, PRMS 3.2.9.3).
 *   P-labels    outcome labels only: P90 is the low estimate, P10 the high
 *               (lib/conventions/percentile.js). The Monte Carlo reads P90 as
 *               the simple-statistics quantile at 0.1 of the totals.
 *   percentages 0 to 100 on input.
 *   reasons     money prints rounded to the cent and a computed quantity or
 *               percentage to 6 decimal places (half away from zero, trailing
 *               zeros dropped); stated inputs print as given; numeric fields
 *               keep full precision.
 *
 * Validation: tools/validation/economics/oracle_prms.py (stdlib python)
 * writes test-data/economics/goldens/prms_cases.json; FINDINGS-prms.md,
 * negcontrol_prms.sh, timing_prms.js. Fixtures (synthetic Ekene field):
 * test-data/economics/ekene-prms/.
 */

import { computeCashFlow, applyJV } from './cashflow.ts';
import {
  mulberry32, createCorrelatedSampler, cholesky, fitTriangularToPercentiles, triInvCDF, normalCDF, quantile, mean as statsMean,
} from '../../lib/stats/stats.js';
import { OUTCOME_LABELS, EXCEEDANCE_DEFINITION, outcomeOrderViolation } from '../../lib/conventions/percentile.js';

export const DEFAULTS = Object.freeze({
  MAX_YEARS: 100,
  MAX_PROJECTS: 50,
  MAX_ITERATIONS: 200000,
  MAX_DRAW_WORK: 500000, // iterations x projects (about 3 s at 50 projects, the Cholesky draw is quadratic in projects)
  MAX_MOVEMENTS: 50,
  PSD_TOLERANCE: 1e-9,
});

/** Figures read from the published texts. */
export const PRMS_FIGURES = Object.freeze({
  reasonableTimeFrameYears: 5, // PRMS 2.1.2.3 and 2.1.3.6.4: five years recommended as a benchmark
  significantDiscoveryRetentionMaxYears: 10, // PIA 2021 s.78(9)
  retentionMinOnshoreShallowYears: 5, // S.I. No. 37 of 2023, reg. 6(3)
  retentionMinDeepWaterYears: 8, // S.I. No. 37 of 2023, reg. 6(3)
  fieldDevelopmentPlanYears: 2, // PIA 2021 s.79(1)
});

/** Standard normal quantile at 0.9 (the 90th percentile), for a lognormal's P90 and P10. */
const Z90 = 1.2815515655446004;

const CITE = Object.freeze({
  prms: 'SPE-PRMS 2018 (June 2018, v1.03 with the 2022 errata; CC BY-NC-ND 4.0, cited by section)',
  faq: 'SPE OGRC, PRMS Frequently Asked Questions (October 2022)',
  ag: 'Guidelines for Application of the PRMS (November 2011)',
  sec: '17 CFR 229.1202(a)(3) (Regulation S-K Item 1202)',
  pia: 'Petroleum Industry Act 2021 (Act No. 6), Official Gazette No. 142, Vol. 108, 27 August 2021',
});

// ---- helpers ---------------------------------------------------------------

const refuse = (field, message) => ({ error: `${field} ${message}`, field });
const fmt = (x) => String(x);
const show = (v) => (v === undefined ? 'nothing' : typeof v === 'number' ? fmt(v) : typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
const must = (field, cond, v) => refuse(field, `must be ${cond}; got ${show(v)}`);
const unit = (x, one, many = `${one}s`) => `${fmt(x)} ${x === 1 ? one : many}`;
const money = (x) => fmt(Number(x.toFixed(2)));
const dec = (x) => fmt(Number(x.toFixed(6)));
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const first = (...checks) => checks.find((c) => c) || null;
const quote = (xs) => xs.map((o) => `"${o}"`).join(', ');

const nonNeg = (field, v) => (fin(v) && v >= 0 ? null : must(field, 'a finite number at or above 0', v));
const positive = (field, v) => (fin(v) && v > 0 ? null : must(field, 'a finite number above 0', v));
const pct = (field, v) => (fin(v) && v >= 0 && v <= 100 ? null : must(field, 'a number from 0 to 100', v));
const pctPos = (field, v) => (fin(v) && v > 0 && v <= 100 ? null : must(field, 'a number above 0 and at most 100', v));
const intIn = (field, v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? null : must(field, `an integer from ${lo} to ${hi}`, v));
const oneOf = (field, v, opts) => (opts.includes(v) ? null : must(field, `one of ${quote(opts)}`, v));
const text = (field, v) => (typeof v === 'string' && v.trim() !== '' ? null : must(field, 'a non-empty string', v));
const bool = (field, v) => (typeof v === 'boolean' ? null : must(field, 'true or false (stated; no default)', v));
const absent = (field, v, why) => (v === undefined ? null : must(field, `left out ${why}`, v));
const listOf = (field, v, max, min = 1) => {
  if (!Array.isArray(v) || v.length < min) return must(field, `an array of at least ${unit(min, 'entry', 'entries')}`, v);
  if (v.length > max) return refuse(field, `must have at most ${max} entries; got ${v.length}`);
  for (let i = 0; i < v.length; i += 1) if (!isObj(v[i])) return must(`${field}[${i}]`, 'an object', v[i]);
  return null;
};
const objOf = (field, v, what) => (isObj(v) ? null : must(field, `an object ${what}`, v));

// ---- accepted keys ---------------------------------------------------------
//
// Every public function refuses an input key it does not read, at every
// level, so a misspelt optional key is never dropped silently. Keys whose
// value is undefined count as absent.
const O = (keys, children = {}) => ({ t: 'obj', keys, children });
const L = (of) => ({ t: 'list', of });
const CUM = O(['low', 'best', 'high']);
const INC = O(['first', 'second', 'third']);
const YEAR_ROW = O(['year', 'oil', 'gas']);
const DIST = O(['type', 'min', 'mode', 'max', 'mean', 'stdDev']);
export const ACCEPTED_KEYS = Object.freeze({
  classify: O(['name', 'discovery', 'recoveryProject', 'subClass', 'commerciality', 'economicStatus', 'projectStatus', 'reservesStatus', 'chances', 'nigeria'], {
    commerciality: O(['developmentPlan', 'financialAppropriations', 'timeFrame', 'market', 'facilities', 'approvals', 'firmIntention'], { timeFrame: O(['startWithinYears', 'longerJustified']) }),
    projectStatus: O(['finalInvestmentDecision', 'onProduction']),
    chances: O(['geologicDiscoveryPct', 'developmentPct']),
    nigeria: O(['declaration', 'yearsSinceDeclaration']),
  }),
  categorize: O(['resourceClass', 'method', 'estimates', 'unit'], { estimates: O(['low', 'best', 'high', 'first', 'second', 'third']) }),
  economicLimit: O(['effectiveYear', 'forecasts', 'prices', 'costs', 'royalty', 'tax', 'workingInterestPct', 'licence', 'reportingBasis', 'discountRatePct', 'mscfPerBoe'], {
    forecasts: O(['low', 'best', 'high'], { low: L(YEAR_ROW), best: L(YEAR_ROW), high: L(YEAR_ROW) }),
    prices: L(YEAR_ROW),
    costs: O(['opex', 'capex', 'abandonment'], { opex: L(O(['year', 'amount'])), capex: L(O(['year', 'amount'])) }),
    royalty: O(['ratePct', 'form']),
    tax: O(['ratePct', 'depreciationYears', 'lossCarryforward']),
    licence: O(['expiryYear', 'renewalExpected']),
  }),
  aggregate: O(['resourceClass', 'level', 'unit', 'projects', 'correlation', 'seed', 'iterations'], {
    projects: L(O(['id', 'name', 'distribution', 'estimates', 'chanceOfCommercialityPct'], { distribution: DIST, estimates: CUM })),
    correlation: O(['type', 'rho', 'pairs'], { pairs: L(O(['a', 'b', 'rho'])) }),
  }),
  reconcile: O(['resourceClass', 'unit', 'periodYears', 'opening', 'movements', 'closing', 'tolerance'], {
    opening: CUM, closing: CUM, movements: L(O(['type', 'low', 'best', 'high', 'quantity', 'note'])),
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

// ---- classes, categories and labels ---------------------------------------------

const CLASSES = Object.freeze({
  reserves: {
    name: 'Reserves',
    cumulative: { low: '1P', best: '2P', high: '3P' },
    incremental: { first: 'Proved (P1)', second: 'Probable (P2)', third: 'Possible (P3)' },
    section: 'PRMS 2.2.2.2',
  },
  contingent: {
    name: 'Contingent Resources',
    cumulative: { low: '1C', best: '2C', high: '3C' },
    incremental: { first: 'C1', second: 'C2', third: 'C3' },
    section: 'PRMS 2.2.2.3',
  },
  prospective: {
    name: 'Prospective Resources',
    cumulative: { low: '1U', best: '2U', high: '3U' },
    incremental: null,
    section: 'PRMS 2.2.2.4',
  },
});
const CLASS_KEYS = Object.keys(CLASSES);
const CASE_KEYS = ['low', 'best', 'high'];
const INC_KEYS = ['first', 'second', 'third'];
const CASE_OUTCOME = { low: 'p90', best: 'p50', high: 'p10' };

const SUB_CLASSES = Object.freeze({
  reserves: ['on-production', 'approved-for-development', 'justified-for-development'],
  contingent: ['development-pending', 'development-on-hold', 'development-unclarified', 'development-not-viable'],
  prospective: ['prospect', 'lead', 'play'],
});

const checkCum = (field, v) => {
  const e = first(objOf(field, v, '{ low, best, high }'));
  if (e) return e;
  for (const k of CASE_KEYS) { const e2 = nonNeg(`${field}.${k}`, v[k]); if (e2) return e2; }
  const viol = outcomeOrderViolation({ p90: v.low, p50: v.best, p10: v.high }, field);
  if (viol) return must(field, `ordered low <= best <= high (the P90 low estimate, the P50 best, the P10 high: ${EXCEEDANCE_DEFINITION})`, v);
  return null;
};

// ---- classify ---------------------------------------------------------------------

const CRITERIA = [
  ['developmentPlan', '(1) a technically mature, feasible development plan', 'PRMS 2.1.2.1(1)'],
  ['financialAppropriations', '(2) financial appropriations in place or highly likely to be secured', 'PRMS 2.1.2.1(2), 2.1.2.4'],
  ['timeFrame', '(3) a reasonable time-frame for development', 'PRMS 2.1.2.1(3), 2.1.2.3'],
  ['economicStatus', '(4) positive economics (economic status "viable")', 'PRMS 2.1.2.1(4), 2.1.3.7.1'],
  ['market', '(5) a reasonable expectation of a market for the sales quantities', 'PRMS 2.1.2.1(5)'],
  ['facilities', '(6) production and transportation facilities available or can be made available', 'PRMS 2.1.2.1(6)'],
  ['approvals', '(7) legal, contractual, environmental, regulatory and government approvals in place or forthcoming', 'PRMS 2.1.2.1(7)'],
  ['firmIntention', "commitment: the entity's firm intention to proceed with development", 'PRMS 2.1.2.1, 2.1.2.3'],
];

const DECLARATIONS = ['commercial-discovery', 'significant-crude-oil-discovery', 'significant-gas-discovery', 'no-interest'];

const classifyImpl = (a) => {
  let e = first(a.name !== undefined ? text('name', a.name) : null,
    oneOf('discovery', a.discovery, ['discovered', 'undiscovered']),
    oneOf('recoveryProject', a.recoveryProject, ['established-technology', 'technology-under-development', 'none']));
  if (e) return e;
  const discovered = a.discovery === 'discovered';
  const reasons = [];
  const decisions = [];
  const decide = (rule, section, outcome) => { decisions.push({ rule, section, outcome }); reasons.push(`${rule}: ${outcome} (${section})`); };
  decide('discovery', 'PRMS 2.1.1.1', discovered ? 'discovered: a known accumulation' : 'undiscovered: a potential accumulation');

  // Nigeria (stated, optional; only for a discovery)
  let nigeria = null;
  if (a.nigeria !== undefined) {
    if (!discovered) return must('nigeria', 'left out for an undiscovered accumulation (PIA 2021 s.78(8) declarations follow a discovery)', a.nigeria);
    e = first(objOf('nigeria', a.nigeria, '{ declaration, yearsSinceDeclaration }'));
    if (e) return e;
    e = first(oneOf('nigeria.declaration', a.nigeria.declaration, DECLARATIONS), nonNeg('nigeria.yearsSinceDeclaration', a.nigeria.yearsSinceDeclaration));
    if (e) return e;
  }

  const labelsFor = (key) => (key ? { cumulative: { ...CLASSES[key].cumulative }, incremental: CLASSES[key].incremental ? { ...CLASSES[key].incremental } : null } : null);
  const out = (cls, key, extra) => {
    const r = {
      class: cls,
      subClass: null,
      economicStatus: null,
      reservesStatus: null,
      chances: null,
      chanceOfCommercialityPct: null,
      criteria: [],
      unmet: [],
      labels: labelsFor(key),
      nigeria: null,
      decisions,
      ...extra,
    };
    if (a.nigeria !== undefined) {
      const n = a.nigeria;
      const yrs = n.yearsSinceDeclaration;
      const notes = [];
      if (n.declaration === 'commercial-discovery') {
        notes.push(`commercial discovery declared (PIA 2021 s.78(8)(a)); a field development plan is due within ${PRMS_FIGURES.fieldDevelopmentPlanYears} years of the declaration (s.79(1)); ${unit(yrs, 'year')} since the declaration${yrs > PRMS_FIGURES.fieldDevelopmentPlanYears ? ': the two-year period has passed' : ''}`);
      } else if (n.declaration === 'no-interest') {
        notes.push('discovery declared of no interest (PIA 2021 s.78(8)(c)); the Commission may require relinquishment of the parcels over the structure (s.78(15))');
      } else {
        const what = n.declaration === 'significant-gas-discovery' ? 'significant gas discovery' : 'significant crude oil discovery';
        notes.push(`${what} declared (PIA 2021 s.78(8)(b)): substantial and potentially commercial but not declarable as commercial (s.318); the licensee may retain the area for a period the Commission determines, at most ${PRMS_FIGURES.significantDiscoveryRetentionMaxYears} years from the declaration (s.78(9)), an approval being for at least ${PRMS_FIGURES.retentionMinOnshoreShallowYears} years onshore and in shallow water and ${PRMS_FIGURES.retentionMinDeepWaterYears} in deep water (Significant Crude Oil and Gas Discovery Regulations, 2023, reg. 6(3)); ${unit(yrs, 'year')} since the declaration${yrs > PRMS_FIGURES.significantDiscoveryRetentionMaxYears ? ': the retention period has ended, so the area is relinquished unless a commercial discovery was declared (s.78(13))' : ''}`);
      }
      r.nigeria = { declaration: n.declaration, yearsSinceDeclaration: yrs, notes };
      notes.forEach((x) => reasons.push(`Nigeria: ${x}`));
    }
    r.reasons = reasons;
    r.basis = { classification: `${CITE.prms}: 2.1 and Table 1`, categories: key ? CLASSES[key].section : 'none: unrecoverable quantities are not categorized', nigeria: a.nigeria !== undefined ? CITE.pia : null };
    return r;
  };

  // Unrecoverable: no project can be applied
  if (a.recoveryProject === 'none') {
    const why = 'for unrecoverable quantities (no recovery project applies)';
    e = first(absent('subClass', a.subClass, why), absent('commerciality', a.commerciality, why), absent('economicStatus', a.economicStatus, why),
      absent('projectStatus', a.projectStatus, why), absent('reservesStatus', a.reservesStatus, why), absent('chances', a.chances, why));
    if (e) return e;
    const cls = discovered ? 'Discovered Unrecoverable' : 'Undiscovered Unrecoverable';
    decide('recovery project', 'PRMS 2.1.0.1, 2.1.1.2', `none applies with established technology or technology under development: ${cls}`);
    return out(cls, null, {});
  }
  decide('recovery project', 'PRMS 2.1.0.1', a.recoveryProject === 'established-technology' ? 'a project with established technology applies' : 'a project applies with technology under development');

  // Prospective
  if (!discovered) {
    const why = 'for an undiscovered accumulation';
    e = first(absent('commerciality', a.commerciality, `${why} (PRMS 2.1.2 tests discovered quantities)`), absent('economicStatus', a.economicStatus, `${why} (PRMS 2.1.3.7 applies to discovered projects)`),
      absent('projectStatus', a.projectStatus, why), absent('reservesStatus', a.reservesStatus, why),
      oneOf('subClass', a.subClass, SUB_CLASSES.prospective));
    if (e) return e;
    e = first(objOf('chances', a.chances, '{ geologicDiscoveryPct, developmentPct } for Prospective Resources (PRMS 2.1.3.2, 2.1.3.3)'));
    if (e) return e;
    e = first(pct('chances.geologicDiscoveryPct', a.chances.geologicDiscoveryPct), pct('chances.developmentPct', a.chances.developmentPct));
    if (e) return e;
    const pc = (a.chances.geologicDiscoveryPct * a.chances.developmentPct) / 100;
    decide('class', 'PRMS 2.1.0.1, Table 1', 'Prospective Resources');
    decide('sub-class', 'PRMS 2.1.3.5.9, Table 1', `${a.subClass} (stated)`);
    decide('chance of commerciality', 'PRMS 2.1.3.3', `Pc = Pg x Pd = ${fmt(a.chances.geologicDiscoveryPct)}% x ${fmt(a.chances.developmentPct)}% = ${dec(pc)}%`);
    return out('Prospective Resources', 'prospective', {
      subClass: a.subClass,
      chances: { geologicDiscoveryPct: a.chances.geologicDiscoveryPct, developmentPct: a.chances.developmentPct },
      chanceOfCommercialityPct: pc,
    });
  }

  // Discovered with a project: the commerciality test
  const c = a.commerciality;
  e = first(objOf('commerciality', c, '{ developmentPlan, financialAppropriations, timeFrame, market, facilities, approvals, firmIntention } for a discovered accumulation (PRMS 2.1.2.1; no default)'));
  if (e) return e;
  for (const k of ['developmentPlan', 'financialAppropriations']) { e = bool(`commerciality.${k}`, c[k]); if (e) return e; }
  e = first(objOf('commerciality.timeFrame', c.timeFrame, '{ startWithinYears, longerJustified } (PRMS 2.1.2.3)'));
  if (e) return e;
  e = first(nonNeg('commerciality.timeFrame.startWithinYears', c.timeFrame.startWithinYears), bool('commerciality.timeFrame.longerJustified', c.timeFrame.longerJustified));
  if (e) return e;
  for (const k of ['market', 'facilities', 'approvals', 'firmIntention']) { e = bool(`commerciality.${k}`, c[k]); if (e) return e; }
  e = oneOf('economicStatus', a.economicStatus, ['viable', 'not-viable', 'undetermined']);
  if (e) return e;

  const T = PRMS_FIGURES.reasonableTimeFrameYears;
  const tf = c.timeFrame;
  const tfMet = tf.startWithinYears <= T || tf.longerJustified;
  const met = {
    developmentPlan: c.developmentPlan,
    financialAppropriations: c.financialAppropriations,
    timeFrame: tfMet,
    economicStatus: a.economicStatus === 'viable',
    market: c.market,
    facilities: c.facilities,
    approvals: c.approvals,
    firmIntention: c.firmIntention,
  };
  const criteria = CRITERIA.map(([k, what, section]) => ({ criterion: k, what, section, met: met[k] }));
  const unmet = criteria.filter((x) => !x.met).map((x) => x.criterion);
  const technologyReady = a.recoveryProject === 'established-technology';
  reasons.push(`time-frame: development starts within ${unit(tf.startWithinYears, 'year')} against the ${T}-year benchmark${tf.startWithinYears > T ? (tf.longerJustified ? ', a longer time-frame stated as justified' : ', no longer time-frame justified') : ''}: ${tfMet ? 'met' : 'not met'} (PRMS 2.1.2.3)`);
  criteria.forEach((x) => reasons.push(`${x.what}: ${x.met ? 'met' : 'not met'} (${x.section})`));
  const commercial = unmet.length === 0 && technologyReady;

  if (commercial) {
    if (a.nigeria !== undefined && a.nigeria.declaration !== 'commercial-discovery') {
      return must('nigeria.declaration', `"commercial-discovery" for a project that meets every commerciality criterion: a significant discovery cannot be declared commercial (PIA 2021 s.318) and a discovery of no interest is not being developed (s.78(8)(c))`, a.nigeria.declaration);
    }
    const ps = a.projectStatus;
    e = first(objOf('projectStatus', ps, '{ finalInvestmentDecision, onProduction } for Reserves (PRMS 2.1.3.5, Table 1)'));
    if (e) return e;
    e = first(bool('projectStatus.finalInvestmentDecision', ps.finalInvestmentDecision), bool('projectStatus.onProduction', ps.onProduction));
    if (e) return e;
    if (ps.onProduction && !ps.finalInvestmentDecision) return must('projectStatus.finalInvestmentDecision', 'true for a project on production (a producing project has passed its investment decision)', ps.finalInvestmentDecision);
    const derived = ps.onProduction ? 'on-production' : ps.finalInvestmentDecision ? 'approved-for-development' : 'justified-for-development';
    const derivedWhy = ps.onProduction ? 'on production, selling petroleum to market'
      : ps.finalInvestmentDecision ? 'final investment decision taken; production yet to start'
        : 'no final investment decision yet';
    const derivedSection = ps.onProduction ? 'PRMS 2.1.3.5, Table 1' : ps.finalInvestmentDecision ? 'PRMS 2.1.3.5.5, Table 1' : 'PRMS 2.1.3.5.4, Table 1';
    if (a.subClass !== derived) return must('subClass', `"${derived}" for this project (${derivedWhy}: ${derivedSection})`, a.subClass);
    e = first(oneOf('reservesStatus', a.reservesStatus, ['developed-producing', 'developed-non-producing', 'undeveloped']),
      absent('chances', a.chances, 'for Reserves (PRMS 2.1.3.3 requires a high degree of certainty in the chance of commerciality; no chance figure is carried)'));
    if (e) return e;
    if (a.reservesStatus === 'developed-producing' && derived !== 'on-production') return must('reservesStatus', '"developed-non-producing" or "undeveloped" for a project that is not on production (developed producing reserves come from completion intervals open and producing, Table 2)', a.reservesStatus);
    decide('class', 'PRMS 2.1.2.1, Table 1', 'Reserves: every commerciality criterion is met with established technology');
    decide('sub-class', derivedSection, `${derived}: ${derivedWhy}`);
    decide('reserves status', 'PRMS 2.1.3.6, Table 2', `${a.reservesStatus} (stated)`);
    return out('Reserves', 'reserves', { subClass: derived, economicStatus: a.economicStatus, reservesStatus: a.reservesStatus, criteria, unmet });
  }

  // Contingent Resources
  const why = 'for Contingent Resources';
  e = first(absent('projectStatus', a.projectStatus, `${why} (the project status that sets a Reserves sub-class, PRMS 2.1.3.5)`),
    absent('reservesStatus', a.reservesStatus, `${why} (PRMS 2.1.3.6 applies to Reserves)`));
  if (e) return e;
  const blockers = [...(technologyReady ? [] : ['technology under development']), ...unmet];
  if (!SUB_CLASSES.contingent.includes(a.subClass)) {
    return must('subClass', `one of ${quote(SUB_CLASSES.contingent)} for Contingent Resources (not commercial: ${blockers.join(', ')})`, a.subClass);
  }
  e = first(objOf('chances', a.chances, '{ developmentPct } for Contingent Resources (PRMS 2.1.3.3: Pc = Pd)'));
  if (e) return e;
  e = first(absent('chances.geologicDiscoveryPct', a.chances.geologicDiscoveryPct, 'for a discovered accumulation (the chance of geologic discovery applies to Prospective Resources, PRMS 2.1.3.2)'),
    pct('chances.developmentPct', a.chances.developmentPct));
  if (e) return e;
  decide('class', technologyReady ? 'PRMS 2.1.2.1, Table 1' : 'PRMS Table 1 (Contingent Resources guidelines)', `Contingent Resources: not commercial (${blockers.join(', ')})`);
  decide('sub-class', 'PRMS 2.1.3.5.6, Table 1', `${a.subClass} (stated)`);
  decide('economic status', 'PRMS 2.1.3.7', a.economicStatus === 'viable' ? 'economically viable' : a.economicStatus === 'not-viable' ? 'economically not viable' : 'undetermined');
  decide('chance of commerciality', 'PRMS 2.1.3.3', `Pc = Pd = ${fmt(a.chances.developmentPct)}%`);
  return out('Contingent Resources', 'contingent', {
    subClass: a.subClass,
    economicStatus: a.economicStatus,
    chances: { geologicDiscoveryPct: null, developmentPct: a.chances.developmentPct },
    chanceOfCommercialityPct: a.chances.developmentPct,
    criteria,
    unmet: blockers,
  });
};

// ---- categorize -------------------------------------------------------------------

const categorizeImpl = (a) => {
  let e = first(oneOf('resourceClass', a.resourceClass, CLASS_KEYS), oneOf('method', a.method, ['cumulative', 'incremental']), text('unit', a.unit));
  if (e) return e;
  const C = CLASSES[a.resourceClass];
  const est = a.estimates;
  if (a.method === 'incremental' && !C.incremental) return must('method', '"cumulative" for Prospective Resources (PRMS 2.2.2.4 defines no incremental terms for them)', a.method);
  let cum;
  if (a.method === 'cumulative') {
    e = first(objOf('estimates', est, '{ low, best, high } for the cumulative method'));
    if (e) return e;
    for (const k of INC_KEYS) { e = absent(`estimates.${k}`, est[k], 'for the cumulative method (state low, best and high)'); if (e) return e; }
    e = checkCum('estimates', est);
    if (e) return e;
    cum = { low: est.low, best: est.best, high: est.high };
  } else {
    e = first(objOf('estimates', est, '{ first, second, third } for the incremental method'));
    if (e) return e;
    for (const k of CASE_KEYS) { e = absent(`estimates.${k}`, est[k], 'for the incremental method (state first, second and third)'); if (e) return e; }
    for (const k of INC_KEYS) { e = nonNeg(`estimates.${k}`, est[k]); if (e) return e; }
    cum = { low: est.first, best: est.first + est.second, high: est.first + est.second + est.third };
  }
  const inc = C.incremental ? { first: cum.low, second: a.method === 'incremental' ? est.second : cum.best - cum.low, third: a.method === 'incremental' ? est.third : cum.high - cum.best } : null;
  const cumulative = CASE_KEYS.map((k) => ({ case: k, label: C.cumulative[k], probability: OUTCOME_LABELS[CASE_OUTCOME[k]], value: cum[k] }));
  const incremental = inc ? INC_KEYS.map((k) => ({ label: C.incremental[k], value: inc[k] })) : null;
  const reasons = [
    `${C.name}, ${a.method} method (${C.section}; PRMS 2.2.1.4, 2.2.2.1)`,
    ...cumulative.map((x) => `${x.label} (${x.case} estimate, ${x.probability}: at least ${x.probability.slice(1)}% probability of being met or exceeded when probabilistic, PRMS 2.2.1.2): ${dec(x.value)} ${a.unit}`),
  ];
  if (incremental) {
    const [s1, s2, s3] = a.resourceClass === 'reserves' ? ['P1', 'P2', 'P3'] : ['C1', 'C2', 'C3'];
    reasons.push(`incremental: ${incremental.map((x) => `${x.label} ${dec(x.value)}`).join(', ')} ${a.unit}; ${C.cumulative.low} = ${s1}, ${C.cumulative.best} = ${s1} + ${s2}, ${C.cumulative.high} = ${s1} + ${s2} + ${s3}`);
  } else {
    reasons.push('incremental: no terms are defined for Prospective Resources (PRMS 2.2.2.4)');
  }
  const single = cum.low === cum.high;
  if (single) reasons.push('the low, best and high estimates are equal: a single value may describe the expected result (PRMS 2.2.1.3)');
  return {
    resourceClass: C.name,
    method: a.method,
    unit: a.unit,
    cumulative,
    incremental,
    exceedance: EXCEEDANCE_DEFINITION,
    singleValue: single,
    reasons,
    basis: { categories: `${CITE.prms}: ${C.section}, 2.2.1.2, 2.2.2.8`, labels: 'lib/conventions/percentile.js (P90 = low estimate)' },
  };
};

// ---- economic limit and entitlement -------------------------------------------------

/**
 * A volume (or a value) at 100% through the canonical applyJV of
 * engines/economics/cashflow.ts: in as gross revenue with no cost, tax or
 * loss relief, so the result is the quantity x the interest x (1 - the
 * royalty rate). Royalty 0 gives the working-interest share.
 */
const scale = (q, wiPct, royaltyPct) => applyJV({ gross_revenue: q, opex: 0, capex: 0, depreciation: 0, cumulative_unrecovered_cost: 0 }, wiPct / 100, royaltyPct / 100, 0, 0, false).net_cash_flow;

const checkYearRows = (field, rows, y0, n, keys) => {
  let e = listOf(field, rows, DEFAULTS.MAX_YEARS);
  if (e) return e;
  if (n !== null && rows.length !== n) return refuse(field, `must have ${unit(n, 'row')}, one a year from ${y0} to ${y0 + n - 1}; got ${rows.length}`);
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].year !== y0 + i) return must(`${field}[${i}].year`, `${y0 + i} (one row a year from ${y0}, in order)`, rows[i].year);
    for (const k of keys) { e = nonNeg(`${field}[${i}].${k}`, rows[i][k]); if (e) return e; }
  }
  return null;
};

const sumRows = (rows, k) => rows.reduce((s, r) => s + r[k], 0);

const economicLimitImpl = (a) => {
  let e = intIn('effectiveYear', a.effectiveYear, 1900, 2200);
  if (e) return e;
  const Y0 = a.effectiveYear;
  e = objOf('forecasts', a.forecasts, '{ low, best, high }, each a technical production forecast (PRMS 2.2.2.8)');
  if (e) return e;
  for (const k of CASE_KEYS) { e = checkYearRows(`forecasts.${k}`, a.forecasts[k], Y0, null, ['oil', 'gas']); if (e) return e; }
  const lens = CASE_KEYS.map((k) => a.forecasts[k].length);
  const N = Math.max(...lens);
  const Nmin = Math.min(...lens);
  e = first(checkYearRows('prices', a.prices, Y0, N, ['oil', 'gas']), objOf('costs', a.costs, '{ opex, capex, abandonment }'));
  if (e) return e;
  const costs = a.costs;
  e = listOf('costs.opex', costs.opex, DEFAULTS.MAX_YEARS);
  if (e) return e;
  if (costs.opex.length !== N) return refuse('costs.opex', `must have ${unit(N, 'row')}, one a year from ${Y0} to ${Y0 + N - 1}; got ${costs.opex.length}`);
  for (let i = 0; i < N; i += 1) {
    if (costs.opex[i].year !== Y0 + i) return must(`costs.opex[${i}].year`, `${Y0 + i} (one row a year from ${Y0}, in order)`, costs.opex[i].year);
    e = nonNeg(`costs.opex[${i}].amount`, costs.opex[i].amount);
    if (e) return e;
  }
  e = listOf('costs.capex', costs.capex, DEFAULTS.MAX_YEARS, 0);
  if (e) return e;
  const capexYears = new Set();
  for (let i = 0; i < costs.capex.length; i += 1) {
    const r = costs.capex[i];
    e = first(intIn(`costs.capex[${i}].year`, r.year, Y0, Y0 + Nmin - 1), nonNeg(`costs.capex[${i}].amount`, r.amount));
    if (e) return e;
    if (capexYears.has(r.year)) return must(`costs.capex[${i}].year`, 'a year no other capex row has', r.year);
    capexYears.add(r.year);
  }
  e = nonNeg('costs.abandonment', costs.abandonment);
  if (e) return e;
  e = first(objOf('royalty', a.royalty, '{ ratePct, form }'));
  if (e) return e;
  e = first(fin(a.royalty.ratePct) && a.royalty.ratePct >= 0 && a.royalty.ratePct < 100 ? null : must('royalty.ratePct', 'a number from 0 to below 100', a.royalty.ratePct),
    oneOf('royalty.form', a.royalty.form, ['royalty-interest', 'production-tax']));
  if (e) return e;
  e = first(objOf('tax', a.tax, '{ ratePct, depreciationYears, lossCarryforward }'));
  if (e) return e;
  e = first(pct('tax.ratePct', a.tax.ratePct), intIn('tax.depreciationYears', a.tax.depreciationYears, 1, 50), bool('tax.lossCarryforward', a.tax.lossCarryforward),
    pctPos('workingInterestPct', a.workingInterestPct), objOf('licence', a.licence, '{ expiryYear, renewalExpected }'));
  if (e) return e;
  e = first(intIn('licence.expiryYear', a.licence.expiryYear, Y0, 2300), bool('licence.renewalExpected', a.licence.renewalExpected),
    oneOf('reportingBasis', a.reportingBasis, ['gross', 'working-interest', 'net-entitlement']),
    fin(a.discountRatePct) && a.discountRatePct >= 0 && a.discountRatePct <= 100 ? null : must('discountRatePct', 'a number from 0 to 100', a.discountRatePct),
    positive('mscfPerBoe', a.mscfPerBoe));
  if (e) return e;
  const lic = a.licence;
  const licenceCut = lic.renewalExpected ? null : lic.expiryYear;
  if (licenceCut !== null) {
    for (let i = 0; i < costs.capex.length; i += 1) {
      if (costs.capex[i].year > licenceCut) return must(`costs.capex[${i}].year`, `at most ${licenceCut}, the licence expiry, when no renewal is expected`, costs.capex[i].year);
    }
  }
  const wi = a.workingInterestPct;
  const roy = a.royalty.ratePct;
  const volRoy = a.royalty.form === 'royalty-interest' ? roy : 0;
  const boe = (q) => q.oil + q.gas / a.mscfPerBoe;
  const qty = (oil, gas) => { const q = { oil, gas }; q.boe = boe(q); return q; };
  const onBasis = (q) => {
    if (a.reportingBasis === 'gross') return q;
    const r = a.reportingBasis === 'working-interest' ? 0 : volRoy;
    return qty(scale(q.oil, wi, r), scale(q.gas, wi, r));
  };

  const cfgFor = (limit) => ({
    fiscal_regime: 'JV',
    base_year: Y0,
    valuation_year: Y0,
    discounting_convention: 'end_year',
    present_value_basis: 'nominal',
    discount_rate_pct: a.discountRatePct,
    inflation_rate_pct: 0,
    oil_price_escalator_pct: 0,
    gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0,
    opex_escalator_pct: 0,
    capex_escalator_pct: 0,
    oil_price_usd_bbl: a.prices[0].oil,
    gas_price_usd_mscf: a.prices[0].gas,
    condensate_price_usd_bbl: 0,
    price_deck: a.prices.map((p) => ({ year: p.year, oil: p.oil, gas: p.gas })),
    jv_working_interest_pct: 100,
    jv_royalty_pct: roy,
    jv_tax_rate_pct: a.tax.ratePct,
    jv_psc_depr_years: a.tax.depreciationYears,
    apply_loss_carryforward: a.tax.lossCarryforward,
    apply_economic_limit: limit,
    abandonment_cost_usd: costs.abandonment,
  });

  const runCase = (k) => {
    const all = a.forecasts[k];
    const rows = licenceCut === null ? all : all.filter((r) => r.year <= licenceCut);
    const input = (limit) => ({
      cfg: cfgFor(limit),
      prodRows: rows.map((r) => ({ year: r.year, oil_bbl: r.oil, gas_mscf: r.gas })),
      capexRows: costs.capex.map((r) => ({ year: r.year, amount_usd: r.amount })),
      opexRows: costs.opex.filter((r) => r.year <= rows[rows.length - 1].year).map((r) => ({ year: r.year, total_opex_usd: r.amount })),
    });
    let on;
    let off;
    try {
      on = computeCashFlow(input(true));
      off = computeCashFlow(input(false));
    } catch (err) {
      return { e: must(`forecasts.${k}`, `a forecast the canonical cash flow (cashflow.ts) accepts; it said "${err.message}"`, `a ${k} forecast`) };
    }
    const limitYear = on.kpis.economic_limit_year;
    // PRMS 3.1.3.1: the economic limit is where the cumulative net cash flow
    // (before income tax, depreciation and ADR, 3.1.3.2 and 3.1.3.3) peaks.
    // Read off the canonical rows as a cross-check of the canonical limit.
    let cum = 0;
    let peak = -Infinity;
    let peakYear = null;
    for (const r of off.cashFlowData) {
      cum += r.gross_revenue - r.royalty - r.opex - r.capex;
      if (cum >= peak) { peak = cum; peakYear = r.year; }
    }
    if (!(peak > 0)) peakYear = null;
    const undiscounted = on.kpis.total_net_cash_flow_nominal;
    const economic = undiscounted > 0;
    const kept = rows.filter((r) => r.year <= limitYear);
    return {
      k,
      forecastYears: [all[0].year, all[all.length - 1].year],
      licenceCutYear: licenceCut !== null && all[all.length - 1].year > licenceCut ? licenceCut : null,
      economicLimitYear: limitYear,
      prmsPeakYear: peakYear,
      yearsTrimmed: on.kpis.years_trimmed_by_economic_limit,
      undiscountedNetCashFlow: undiscounted,
      npv: on.kpis.npv,
      economic,
      technical: qty(sumRows(all, 'oil'), sumRows(all, 'gas')),
      withinLicence: qty(sumRows(rows, 'oil'), sumRows(rows, 'gas')),
      economicGross: qty(sumRows(kept, 'oil'), sumRows(kept, 'gas')),
    };
  };
  const cases = {};
  for (const k of CASE_KEYS) {
    const r = runCase(k);
    if (r.e) return r.e;
    if (r.economic && r.prmsPeakYear !== r.economicLimitYear) {
      return must(`forecasts.${k}`, `a forecast on which the canonical economic limit (cashflow.ts: trailing years whose revenue less royalty less opex is negative are cut, years with capital kept) and the PRMS 3.1.3.1 limit (the year the cumulative net cash flow before tax and ADR peaks) agree; they give ${r.economicLimitYear} and ${r.prmsPeakYear === null ? 'no positive peak' : r.prmsPeakYear}`, `a ${k} forecast from ${r.forecastYears[0]} to ${r.forecastYears[1]}`);
    }
    cases[k] = r;
  }
  if (cases.best.economic && !cases.high.economic) {
    return must('forecasts.high', 'a forecast that is economic when the best case is (tested on the same costs and prices, PRMS 2.2.0.3: an undiscounted net cash flow above 0)', cases.high.undiscountedNetCashFlow);
  }

  const reasons = [];
  const perCase = {};
  for (const k of CASE_KEYS) {
    const r = cases[k];
    const reported = onBasis(r.economicGross);
    perCase[k] = {
      forecastYears: r.forecastYears,
      licenceCutYear: r.licenceCutYear,
      economicLimitYear: r.economicLimitYear,
      yearsTrimmed: r.yearsTrimmed,
      undiscountedNetCashFlow: r.undiscountedNetCashFlow,
      undiscountedNetCashFlowShare: scale(r.undiscountedNetCashFlow, wi, 0),
      npv: r.npv,
      npvShare: scale(r.npv, wi, 0),
      economic: r.economic,
      technical: r.technical,
      beyondLicence: qty(r.technical.oil - r.withinLicence.oil, r.technical.gas - r.withinLicence.gas),
      beyondEconomicLimit: qty(r.withinLicence.oil - r.economicGross.oil, r.withinLicence.gas - r.economicGross.gas),
      economicGross: r.economicGross,
      reported,
    };
    reasons.push(`${k} case: forecast ${r.forecastYears[0]} to ${r.forecastYears[1]}${r.licenceCutYear !== null ? `, cut at the licence expiry ${r.licenceCutYear} (no renewal expected)` : ''}; economic limit ${r.economicLimitYear} (${unit(r.yearsTrimmed, 'trailing year')} cut); undiscounted net cash flow ${money(r.undiscountedNetCashFlow)} at 100%: ${r.economic ? 'economic' : 'not economic'} (PRMS 3.1.2.1: above 0); within the limit ${dec(r.economicGross.oil)} bbl oil and ${dec(r.economicGross.gas)} Mscf gas gross`);
  }
  const zero = qty(0, 0);
  let reserves = null;
  let status;
  if (cases.best.economic) {
    const low = cases.low.economic ? perCase.low.reported : zero;
    const best = perCase.best.reported;
    const high = perCase.high.reported;
    if (low.boe > best.boe || best.boe > high.boe) {
      return must('forecasts', `forecasts whose truncated quantities are ordered low <= best <= high in BOE (here ${dec(low.boe)}, ${dec(best.boe)} and ${dec(high.boe)})`, 'the stated forecasts');
    }
    const inc = (x, y) => qty(x.oil - y.oil, x.gas - y.gas);
    reserves = {
      cumulative: { '1P': low, '2P': best, '3P': high },
      incremental: { P1: low, P2: inc(best, low), P3: inc(high, best) },
      provedZero: !cases.low.economic,
    };
    status = 'Reserves: the best case is economic (PRMS 2.1.2.2, 3.1.2.1)';
    reasons.push(status);
    if (!cases.low.economic) reasons.push('the low case is not economic: 1P = 0 and the 2P and 3P estimates stand (PRMS 3.1.2.8; FAQ 3.3); the low case quantities sit inside 2P, never in 1C (FAQ 3.4, no split classification)');
    reasons.push(`on the ${a.reportingBasis} basis: 1P ${dec(low.boe)}, 2P ${dec(best.boe)}, 3P ${dec(high.boe)} BOE at ${fmt(a.mscfPerBoe)} Mscf per BOE (supplementary, PRMS 3.2.9.3); P2 ${dec(reserves.incremental.P2.boe)}, P3 ${dec(reserves.incremental.P3.boe)}`);
  } else {
    status = 'not commercial: the best case fails the economic test (PRMS 2.1.2.2, 3.1.2.1); the project stays in Contingent Resources, economically not viable (PRMS 2.1.3.7.1)';
    reasons.push(status);
  }
  if (a.reportingBasis === 'net-entitlement') {
    reasons.push(a.royalty.form === 'royalty-interest'
      ? `net entitlement: ${fmt(wi)}% working interest less the ${fmt(roy)}% royalty interest (PRMS 3.3.1.1)`
      : `net entitlement: ${fmt(wi)}% working interest; the ${fmt(roy)}% payment is a production tax, so no volume is deducted (PRMS 3.3.1.2)`);
  }
  return {
    effectiveYear: Y0,
    reportingBasis: a.reportingBasis,
    cases: perCase,
    reserves,
    status,
    reasons,
    basis: {
      economicLimit: 'computeCashFlow of engines/economics/cashflow.ts with apply_economic_limit (JV regime at 100%, the stated royalty and tax), checked against PRMS 3.1.3.1',
      economicTest: `${CITE.prms}: 3.1.2.1 (undiscounted cumulative net cash flow above 0, ADR included), 3.1.2.8`,
      entitlement: 'applyJV of engines/economics/cashflow.ts (working interest and royalty scaling); PRMS 3.3.1',
      licence: 'PRMS 3.1.1.1(5), 3.1.3.1; FAQ 4.4',
    },
  };
};

// ---- aggregation --------------------------------------------------------------------

const DIST_TYPES = ['triangular-fit', 'triangular', 'lognormal', 'normal'];

const checkProject = (p, i, needChance) => {
  const pre = `projects[${i}]`;
  let e = first(text(`${pre}.id`, p.id), p.name !== undefined ? text(`${pre}.name`, p.name) : null,
    objOf(`${pre}.distribution`, p.distribution, `{ type } with type one of ${quote(DIST_TYPES)} (no default)`));
  if (e) return { e };
  const d = p.distribution;
  const dp = `${pre}.distribution`;
  e = oneOf(`${dp}.type`, d.type, DIST_TYPES);
  if (e) return { e };
  const no = (k, why) => absent(`${dp}.${k}`, d[k], why);
  let dist;
  let cases;
  let meanExact;
  let belowZero = 0;
  if (d.type === 'triangular-fit') {
    const w = 'for "triangular-fit" (the fit reads the stated estimates)';
    e = first(no('min', w), no('mode', w), no('max', w), no('mean', w), no('stdDev', w), checkCum(`${pre}.estimates`, p.estimates));
    if (e) return { e };
    const est = p.estimates;
    const f = fitTriangularToPercentiles(est.low, est.best, est.high);
    if (!f.exact) {
      return { e: must(`${pre}.estimates`, `low, best and high that a triangular distribution passes through exactly (lib/stats fitTriangularToPercentiles): the best estimate sits too near the ${/10th percentile/.test(f.note) ? 'low' : 'high'} estimate for any triangular`, est) };
    }
    dist = est.low === est.high ? { type: 'constant', value: est.low } : { type: 'triangular', min: f.min, mode: f.mode, max: f.max };
    cases = { low: est.low, best: est.best, high: est.high };
    meanExact = est.low === est.high ? est.low : (f.min + f.mode + f.max) / 3;
    if (f.min < 0) return { e: must(`${pre}.estimates`, `low, best and high whose fitted triangular stays at or above 0 (its minimum would be ${dec(f.min)})`, est) };
  } else if (d.type === 'triangular') {
    const w = 'for "triangular" (min, mode and max are stated)';
    e = first(absent(`${pre}.estimates`, p.estimates, 'when the distribution is stated (the engine reads the estimates off it)'), no('mean', w), no('stdDev', w),
      nonNeg(`${dp}.min`, d.min), nonNeg(`${dp}.mode`, d.mode), nonNeg(`${dp}.max`, d.max));
    if (e) return { e };
    if (!(d.min <= d.mode && d.mode <= d.max && d.min < d.max)) return { e: must(dp, 'a triangular with min <= mode <= max and min < max', d) };
    dist = { type: 'triangular', min: d.min, mode: d.mode, max: d.max };
    cases = { low: triInvCDF(0.1, d.min, d.mode, d.max), best: triInvCDF(0.5, d.min, d.mode, d.max), high: triInvCDF(0.9, d.min, d.mode, d.max) };
    meanExact = (d.min + d.mode + d.max) / 3;
  } else if (d.type === 'normal') {
    const w = 'for "normal" (mean and stdDev are stated)';
    e = first(absent(`${pre}.estimates`, p.estimates, 'when the distribution is stated (the engine reads the estimates off it)'), no('min', w), no('mode', w), no('max', w),
      positive(`${dp}.mean`, d.mean), positive(`${dp}.stdDev`, d.stdDev));
    if (e) return { e };
    dist = { type: 'normal', mean: d.mean, stdDev: d.stdDev };
    cases = { low: d.mean - Z90 * d.stdDev, best: d.mean, high: d.mean + Z90 * d.stdDev };
    meanExact = d.mean;
    if (cases.low < 0) return { e: must(dp, `a normal whose low estimate (the mean less ${Z90} standard deviations, here ${dec(cases.low)}) stays at or above 0`, d) };
    belowZero = normalCDF(-d.mean / d.stdDev);
  } else {
    const w = 'for "lognormal" (mean and stdDev are stated)';
    e = first(absent(`${pre}.estimates`, p.estimates, 'when the distribution is stated (the engine reads the estimates off it)'), no('min', w), no('mode', w), no('max', w),
      positive(`${dp}.mean`, d.mean), positive(`${dp}.stdDev`, d.stdDev));
    if (e) return { e };
    dist = { type: 'lognormal', mean: d.mean, stdDev: d.stdDev };
    const s2 = Math.log(1 + (d.stdDev * d.stdDev) / (d.mean * d.mean));
    const mu = Math.log(d.mean) - s2 / 2;
    const s = Math.sqrt(s2);
    cases = { low: Math.exp(mu - Z90 * s), best: Math.exp(mu), high: Math.exp(mu + Z90 * s) };
    meanExact = d.mean;
  }
  if (needChance) {
    e = pct(`${pre}.chanceOfCommercialityPct`, p.chanceOfCommercialityPct);
    if (e) return { e };
  } else {
    e = absent(`${pre}.chanceOfCommercialityPct`, p.chanceOfCommercialityPct, 'for Reserves (their chance of commerciality is not a stated figure, PRMS 2.1.3.3)');
    if (e) return { e };
  }
  return { dist, cases, meanExact, belowZero };
};

const aggregateImpl = (a) => {
  let e = first(oneOf('resourceClass', a.resourceClass, CLASS_KEYS), oneOf('level', a.level, ['field', 'above-field']), text('unit', a.unit),
    listOf('projects', a.projects, DEFAULTS.MAX_PROJECTS));
  if (e) return e;
  const C = CLASSES[a.resourceClass];
  const risked = a.resourceClass !== 'reserves';
  const P = [];
  const ids = new Set();
  for (let i = 0; i < a.projects.length; i += 1) {
    const p = a.projects[i];
    const r = checkProject(p, i, risked);
    if (r.e) return r.e;
    if (ids.has(p.id)) return must(`projects[${i}].id`, 'an id no other project has', p.id);
    ids.add(p.id);
    P.push({ id: p.id, chance: risked ? p.chanceOfCommercialityPct : null, ...r });
  }
  e = first(Number.isInteger(a.seed) && a.seed >= 0 && a.seed <= 4294967295 ? null : must('seed', 'an integer from 0 to 4294967295 (the mulberry32 seed; no default)', a.seed),
    intIn('iterations', a.iterations, 100, DEFAULTS.MAX_ITERATIONS));
  if (e) return e;
  if (a.iterations * P.length > DEFAULTS.MAX_DRAW_WORK) {
    return must('iterations', `at most ${Math.floor(DEFAULTS.MAX_DRAW_WORK / P.length)} for ${unit(P.length, 'project')} (iterations x projects at most ${DEFAULTS.MAX_DRAW_WORK})`, a.iterations);
  }
  // correlation: stated, never a hidden zero
  const varying = P.filter((p) => p.dist.type !== 'constant').map((p) => p.id);
  const cr = a.correlation;
  e = first(objOf('correlation', cr, '{ type: "uniform", rho } or { type: "pairs", pairs } (stated; no default)'));
  if (e) return e;
  e = oneOf('correlation.type', cr.type, ['uniform', 'pairs']);
  if (e) return e;
  const rhoOk = (field, v) => (fin(v) && v > -1 && v < 1 ? null : must(field, 'a number above -1 and below 1 (the canonical sampler takes a correlation strictly between -1 and 1)', v));
  const pairs = [];
  if (cr.type === 'uniform') {
    e = first(absent('correlation.pairs', cr.pairs, 'for a uniform correlation'), rhoOk('correlation.rho', cr.rho));
    if (e) return e;
    for (let i = 0; i < varying.length; i += 1) for (let j = i + 1; j < varying.length; j += 1) pairs.push({ a: varying[i], b: varying[j], rho: cr.rho });
  } else {
    e = first(absent('correlation.rho', cr.rho, 'for stated pairs'), listOf('correlation.pairs', cr.pairs, (DEFAULTS.MAX_PROJECTS * (DEFAULTS.MAX_PROJECTS - 1)) / 2, 0));
    if (e) return e;
    const seen = new Set();
    for (let i = 0; i < cr.pairs.length; i += 1) {
      const q = cr.pairs[i];
      const f = `correlation.pairs[${i}]`;
      e = first(oneOf(`${f}.a`, q.a, varying), oneOf(`${f}.b`, q.b, varying), rhoOk(`${f}.rho`, q.rho));
      if (e) return e;
      if (q.a === q.b) return must(`${f}.b`, 'a project other than a', q.b);
      const key = [q.a, q.b].sort().join('\u0000');
      if (seen.has(key)) return must(f, 'a pair stated once', q);
      seen.add(key);
      pairs.push({ a: q.a, b: q.b, rho: q.rho });
    }
    const need = (varying.length * (varying.length - 1)) / 2;
    if (seen.size !== need) {
      const missing = [];
      for (let i = 0; i < varying.length && !missing.length; i += 1) for (let j = i + 1; j < varying.length; j += 1) if (!seen.has([varying[i], varying[j]].sort().join('\u0000'))) { missing.push(`${varying[i]} and ${varying[j]}`); break; }
      return must('correlation.pairs', `one pair for each of the ${need} pairs of varying projects (0 is stated, never assumed); the first missing pair is ${missing[0]}`, `${unit(seen.size, 'pair')}`);
    }
  }
  const n = varying.length;
  const Cm = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (const q of pairs) { const i = varying.indexOf(q.a); const j = varying.indexOf(q.b); Cm[i][j] = q.rho; Cm[j][i] = q.rho; }
  const Lc = cholesky(Cm);
  let worst = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let s = 0;
      for (let k = 0; k < n; k += 1) s += Lc[i][k] * Lc[j][k];
      worst = Math.max(worst, Math.abs(s - Cm[i][j]));
    }
  }
  if (worst > DEFAULTS.PSD_TOLERANCE) return must('correlation', `a positive semidefinite correlation matrix (the Cholesky factor misses the stated matrix by ${dec(worst)})`, cr);

  // arithmetic summation by category
  const arith = {};
  for (const k of CASE_KEYS) arith[k] = P.reduce((s, p) => s + p.cases[k], 0);
  const sumOfMeans = P.reduce((s, p) => s + p.meanExact, 0);
  // the canonical Monte Carlo
  const inputs = {};
  P.forEach((p) => { inputs[p.id] = p.dist; });
  const sampler = createCorrelatedSampler({ inputs, paramOrder: P.map((p) => p.id), correlations: pairs, rng: mulberry32(a.seed) });
  const constants = P.filter((p) => p.dist.type === 'constant').reduce((s, p) => s + p.dist.value, 0);
  const totals = new Array(a.iterations);
  for (let it = 0; it < a.iterations; it += 1) {
    const { values } = sampler.sample();
    let t = constants;
    for (const id of sampler.varKeys) t += values[id];
    totals[it] = t;
  }
  const stat = { low: quantile(totals, 0.1), best: quantile(totals, 0.5), high: quantile(totals, 0.9), mean: statsMean(totals) };
  const riskedMean = risked ? P.reduce((s, p) => s + (p.chance * p.meanExact) / 100, 0) : null;
  const lab = C.cumulative;
  const reportable = a.level === 'above-field' ? 'arithmetic' : 'arithmetic-or-statistical';
  const reasons = [
    `${C.name}, ${unit(P.length, 'project')} at the ${a.level === 'field' ? 'field, property or project' : 'above-field'} level; correlation ${cr.type === 'uniform' ? `${fmt(cr.rho)} for every pair of varying projects` : `stated for ${unit(pairs.length, 'pair')}`} (PRMS 4.2.5.3)`,
    `arithmetic summation by category: ${lab.low} ${dec(arith.low)}, ${lab.best} ${dec(arith.best)}, ${lab.high} ${dec(arith.high)} ${a.unit} (PRMS 4.2.5.2)`,
    `statistical aggregation (canonical Monte Carlo, seed ${a.seed}, ${unit(a.iterations, 'iteration')}): ${OUTCOME_LABELS.p90} ${dec(stat.low)}, ${OUTCOME_LABELS.p50} ${dec(stat.best)}, ${OUTCOME_LABELS.p10} ${dec(stat.high)}, mean ${dec(stat.mean)} ${a.unit}`,
    `the arithmetic sum of the low estimates is not the ${OUTCOME_LABELS.p90} of the total: it is the ${OUTCOME_LABELS.p90} only when every project is totally dependent (PRMS 4.2.5.2); here the statistical low exceeds it by ${dec(stat.low - arith.low)} and the arithmetic high exceeds the statistical high by ${dec(arith.high - stat.high)}`,
    `the mean of the total is the sum of the means (no portfolio effect in means, PRMS 4.2.5.2): ${dec(sumOfMeans)} exact, ${dec(stat.mean)} sampled`,
    a.level === 'above-field'
      ? `above the field level report the arithmetic sums, with the caution that the aggregate ${lab.low} may be very conservative and the aggregate ${lab.high} very optimistic (PRMS 4.2.5.4; ${CITE.sec}); the statistical figures serve portfolio analysis (PRMS 4.2.5.5)`
      : 'at the field, property or project level statistical aggregation may be reported (PRMS 4.2.5.4)',
  ];
  P.filter((p) => dec(p.belowZero) !== '0').forEach((p) => reasons.push(`${p.id}: a normal distribution draws below 0 with chance ${dec(p.belowZero)} (lib/stats normalCDF); those draws stay in the total`));
  if (risked) reasons.push(`risked mean: the sum of chance of commerciality x mean, ${dec(riskedMean)} ${a.unit}; state the classes separately and whether each figure is risked (PRMS 4.2.6; FAQ 6.9; AG 2011 6.4)`);
  return {
    resourceClass: C.name,
    level: a.level,
    unit: a.unit,
    labels: { ...lab },
    projects: P.map((p) => ({ id: p.id, low: p.cases.low, best: p.cases.best, high: p.cases.high, mean: p.meanExact, chanceBelowZero: p.belowZero, chanceOfCommercialityPct: p.chance, distribution: { ...p.dist } })),
    arithmetic: arith,
    statistical: stat,
    sumOfMeans,
    portfolioEffect: { low: stat.low - arith.low, high: arith.high - stat.high },
    riskedMean,
    reportable,
    correlation: { type: cr.type, pairs: pairs.map((q) => ({ ...q })) },
    seed: a.seed,
    iterations: a.iterations,
    reasons,
    basis: {
      aggregation: `${CITE.prms}: 4.2.5, 4.2.6; ${CITE.sec}; ${CITE.ag}: 6.3`,
      monteCarlo: 'lib/stats/stats.js: createCorrelatedSampler (Gaussian copula, Cholesky), mulberry32, fitTriangularToPercentiles, quantile',
      labels: 'lib/conventions/percentile.js (P90 = the 0.1 quantile of the totals, the low estimate)',
    },
  };
};

// ---- reconciliation -----------------------------------------------------------------

const MOVES = Object.freeze({
  revisions: { sign: 0, what: 'revisions of previous estimates (signed)' },
  'improved-recovery': { sign: 1, what: 'improved recovery (additions)' },
  'extensions-and-discoveries': { sign: 1, what: 'extensions and discoveries (additions)' },
  acquisitions: { sign: 1, what: 'acquisitions (additions)' },
  divestments: { sign: -1, what: 'divestments (entered as positive, subtracted)' },
  transfers: { sign: 0, what: 'transfers between classes (signed; in positive, out negative)' },
  production: { sign: -1, what: 'production (one quantity, subtracted from every category)' },
});
const MOVE_TYPES = Object.keys(MOVES);

const reconcileImpl = (a) => {
  let e = first(oneOf('resourceClass', a.resourceClass, ['reserves', 'contingent']), text('unit', a.unit), positive('periodYears', a.periodYears),
    checkCum('opening', a.opening), listOf('movements', a.movements, DEFAULTS.MAX_MOVEMENTS, 0));
  if (e) return e;
  const C = CLASSES[a.resourceClass];
  const lab = C.cumulative;
  const moves = [];
  let production = 0;
  for (let i = 0; i < a.movements.length; i += 1) {
    const m = a.movements[i];
    const f = `movements[${i}]`;
    e = first(oneOf(`${f}.type`, m.type, MOVE_TYPES), m.note !== undefined ? text(`${f}.note`, m.note) : null);
    if (e) return e;
    const spec = MOVES[m.type];
    if (m.type === 'production') {
      if (a.resourceClass !== 'reserves') return must(`${f}.type`, `one of ${quote(MOVE_TYPES.filter((t) => t !== 'production'))} for Contingent Resources (produced quantities come out of Reserves; sub-economic production moves from Contingent Resources to production and is shown as a revision, PRMS 3.1.3.5)`, m.type);
      const w = 'for production (one quantity applies to every category)';
      e = first(absent(`${f}.low`, m.low, w), absent(`${f}.best`, m.best, w), absent(`${f}.high`, m.high, w), nonNeg(`${f}.quantity`, m.quantity));
      if (e) return e;
      production += m.quantity;
      moves.push({ type: m.type, low: -m.quantity, best: -m.quantity, high: -m.quantity });
      continue;
    }
    e = absent(`${f}.quantity`, m.quantity, `for ${m.type} (state low, best and high)`);
    if (e) return e;
    for (const k of CASE_KEYS) {
      e = spec.sign === 0 ? (fin(m[k]) ? null : must(`${f}.${k}`, 'a finite number (signed)', m[k])) : nonNeg(`${f}.${k}`, m[k]);
      if (e) return e;
    }
    const s = spec.sign === -1 ? -1 : 1;
    moves.push({ type: m.type, low: s * m.low, best: s * m.best, high: s * m.high });
  }
  e = first(checkCum('closing', a.closing), nonNeg('tolerance', a.tolerance));
  if (e) return e;
  const computed = {};
  for (const k of CASE_KEYS) computed[k] = moves.reduce((acc, m) => acc + m[k], a.opening[k]);
  const difference = {};
  for (const k of CASE_KEYS) difference[k] = a.closing[k] - computed[k];
  const closes = CASE_KEYS.every((k) => Math.abs(difference[k]) <= a.tolerance);
  const order = outcomeOrderViolation({ p90: computed.low, p50: computed.best, p10: computed.high }, 'computed closing');
  const negative = CASE_KEYS.filter((k) => computed[k] < 0);
  const incOf = (x) => ({ first: x.low, second: x.best - x.low, third: x.high - x.best });
  const additions = moves.filter((m) => m.type !== 'production').reduce((s, m) => s + m.best, 0);
  const replacementRatio = production > 0 ? additions / production : null;
  const lifeIndexYears = production > 0 ? a.closing.best / (production / a.periodYears) : null;
  const byType = {};
  for (const t of MOVE_TYPES) {
    const ms = moves.filter((m) => m.type === t);
    if (ms.length) byType[t] = { low: ms.reduce((s, m) => s + m.low, 0), best: ms.reduce((s, m) => s + m.best, 0), high: ms.reduce((s, m) => s + m.high, 0) };
  }
  const reasons = [
    `${C.name} reconciliation in ${a.unit}: opening ${lab.low} ${dec(a.opening.low)}, ${lab.best} ${dec(a.opening.best)}, ${lab.high} ${dec(a.opening.high)}`,
    ...Object.entries(byType).map(([t, v]) => `${MOVES[t].what}: ${lab.low} ${dec(v.low)}, ${lab.best} ${dec(v.best)}, ${lab.high} ${dec(v.high)}`),
    `computed closing: ${lab.low} ${dec(computed.low)}, ${lab.best} ${dec(computed.best)}, ${lab.high} ${dec(computed.high)}; stated closing ${lab.low} ${dec(a.closing.low)}, ${lab.best} ${dec(a.closing.best)}, ${lab.high} ${dec(a.closing.high)}`,
    closes
      ? `the reconciliation closes: every category within the stated tolerance ${fmt(a.tolerance)}`
      : `the reconciliation does not close: ${CASE_KEYS.filter((k) => Math.abs(difference[k]) > a.tolerance).map((k) => `${lab[k]} differs by ${dec(difference[k])}`).join(', ')} (tolerance ${fmt(a.tolerance)})`,
  ];
  if (order) reasons.push(`the computed closing is out of order (${lab.low} <= ${lab.best} <= ${lab.high} fails)`);
  if (negative.length) reasons.push(`the computed closing is below 0 for ${negative.map((k) => lab[k]).join(', ')}`);
  if (replacementRatio !== null) reasons.push(`${lab.best} replacement ratio: every movement other than production (additions, revisions and transfers) ${dec(additions)} over production ${dec(production)} = ${dec(replacementRatio)}; ${lab.best} life index ${dec(lifeIndexYears)} years at the period's production rate`);
  return {
    resourceClass: C.name,
    unit: a.unit,
    labels: { ...lab },
    opening: { ...a.opening },
    movements: moves,
    byType,
    computedClosing: computed,
    statedClosing: { ...a.closing },
    difference,
    closes,
    orderViolation: order !== null,
    negativeCategories: negative.map((k) => lab[k]),
    incremental: C.incremental ? { opening: incOf(a.opening), closing: incOf(computed), labels: { ...C.incremental } } : null,
    production,
    replacementRatio,
    lifeIndexYears,
    reasons,
    basis: {
      reconciliation: 'opening + movements = closing, category by category; production comes out of every Reserves category alike (the movement headings are the engine\'s stated convention)',
      sections: `${CITE.prms}: 3.1.3.5 (reconciliation, technical revision), 2.2.2.6 (reclassification without new information leaves the distribution unchanged)`,
    },
  };
};

// ---- public ---------------------------------------------------------------------------

export const classify = guard('classify', classifyImpl);
export const categorize = guard('categorize', categorizeImpl);
export const economicLimit = guard('economicLimit', economicLimitImpl);
export const aggregate = guard('aggregate', aggregateImpl);
export const reconcile = guard('reconcile', reconcileImpl);
