/**
 * Quantitative risk assessment (HSE H5): event trees, location-specific
 * individual risk, individual risk per annum, potential loss of life, FAR,
 * F-N curves against criterion lines, ALARP banding, cost-benefit with the
 * gross disproportion test, and the link from H4 consequence results to a
 * probability of death along a transect.
 *
 * Pure functions. Every input carries its unit in its name (frequencyPerYr,
 * exposedHoursPerYr, distancesM, heatFluxesWM2). Every function returns
 * either a finite result carrying `basis` (the model and its source) or an
 * object carrying `error` and `field`, the name of the input refused.
 * FINDINGS-qra.md in tools/validation/hse/ carries the verbatim passages,
 * the errata and every judgement call.
 *
 * SOURCES, and what each one fixes.
 *
 *   PB    TNO "Purple Book", Guidelines for quantitative risk assessment,
 *         CPR 18E (1999). IR contribution dIR = fS PM Pphi Pi Pd (6.1),
 *         IR = sum of the contributions (6.2); societal risk N = sum Fd
 *         Ncell (6.3, 6.4), f = fS PM Pphi Pi (6.5), FN = sum of f with
 *         N >= N (6.6); toxic Pd = Pcl Pci with ECW = PI / Pcl (6.9) and
 *         Pci = nws ECW / (2 pi R) (6.10); the worked IR of Appendix 6.B;
 *         Fd = FE,in fpop,in + FE,out fpop,out (6.7, 6.13) with Figures
 *         5.2 to 5.5 and Table 5.3; direct ignition Table 4.5; the flash
 *         fire / explosion split of section 4.8 (0.6 / 0.4); the FN limit
 *         line of Figure 6.8 (F < 1e-3 N^-2 for N >= 10); IR contours
 *         1e-4 to 1e-8 (section 6.3).
 *   R2P2  UK HSE, Reducing risks, protecting people (2001). Individual risk
 *         1 in 1000 per annum for workers and 1 in 10 000 for the public
 *         (para 132), 1 in a million for both as the broadly acceptable
 *         boundary (para 130); the societal POINT, 50 or more deaths more
 *         often than 1 in 5000 per annum is intolerable (para 136); VPF about
 *         GBP 1 000 000 (2001) and CPF = cost / fatalities prevented
 *         (Appendix 3 paras 13, 15).
 *   CBA   UK HSE, Cost Benefit Analysis (CBA) checklist (hse.gov.uk, read
 *         via its archived copy): gross disproportion when costs / benefits
 *         > DF; DFs "from upwards of 1"; VPF GBP 1,336,800 (2003 Q3); the
 *         worked explosion example (benefit GBP 9,283 over 25 years).
 *   BEVI  Besluit externe veiligheid inrichtingen (2004; repealed
 *         1 January 2024): article 13(1)(b), 1e-5 per year for 10 or more
 *         deaths, 1e-7 for 100, 1e-9 for 1000 ("ten hoogste", at most).
 *
 * REUSED, NOT RESTATED. Probits and their probabilities come from
 * ./consequence.js (thermalProbit, toxicProbit, probabilityToProbit,
 * gaussianPlume, poolFireSolidFlame), whose P = Phi(Y - 5) is lib/stats
 * normalCDF. The FAR base is ./safetyStats.js RATE_BASES.FAR_100M, hours in
 * a year ./lopa.js HOURS_PER_YEAR. Discounting is the canonical year-end
 * `npv` of engines/economics/cashflow.ts (the EPE cash flow engine); no
 * discounting is restated here.
 *
 * WHAT IS NOT HERE, AND WHY. An aversion-weighted risk integral (sum f
 * N^alpha): no source read defines one. A slope for the R2P2 societal
 * criterion: R2P2 gives one point and defers extrapolation to its reference
 * 32, so a criterion line through that point needs the caller's exponent.
 * Grid and wind-rose bookkeeping of a full QRA: the caller supplies
 * scenario frequencies (fS PM Pphi Pi) and probabilities of death.
 */

import {
  thermalProbit, toxicProbit, probabilityToProbit, gaussianPlume, poolFireSolidFlame,
} from './consequence.js';
import { RATE_BASES } from './safetyStats.js';
import { HOURS_PER_YEAR } from './lopa.js';
import { npv } from '../economics/cashflow.ts';

const SRC = Object.freeze({
  PB: 'TNO Purple Book CPR 18E (1999)',
  R2P2: 'UK HSE, Reducing risks, protecting people (2001)',
  CBA: 'UK HSE, Cost Benefit Analysis (CBA) checklist (2003 values)',
  BEVI: 'Besluit externe veiligheid inrichtingen (2004, repealed 1 January 2024) art. 13(1)(b)',
  NPV: 'engines/economics/cashflow.ts npv (year-end discounting)',
});

export const QRA_SOURCES = SRC;

/** Branch probabilities of one node must sum to 1 within this, absolute. */
export const BRANCH_SUM_TOLERANCE = 1e-9;

/**
 * A computed value within this relative distance of a threshold is taken
 * AS the threshold (reported atBoundary), so that 1e-4 * 10 compares equal
 * to 1e-3 although binary floating point does not make it so.
 */
export const BOUNDARY_SNAP = 1e-9;

const refuse = (field, message) => ({ error: `${field}: ${message}`, field });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => isNum(v) && v > 0;
const nonNegative = (v) => isNum(v) && v >= 0;
const probability = (v) => isNum(v) && v >= 0 && v <= 1;
const given = (v) => v !== undefined && v !== null;

/**
 * Is `key` a preset this table actually defines? A plain `table[key]` walks
 * the prototype chain, so 'constructor', 'toString' and '__proto__' would
 * all return a truthy function and pass a `if (!row)` guard, after which the
 * engine reads undefined coefficients and reports a risk as acceptable. Every
 * preset lookup here goes through this instead. See FINDINGS-qra.md section 9.
 */
const ownPreset = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

/** -1 below, 0 at (within BOUNDARY_SNAP relative), +1 above. */
const compare = (value, threshold) => {
  if (Math.abs(value - threshold) <= BOUNDARY_SNAP * Math.abs(threshold)) return 0;
  return value > threshold ? 1 : -1;
};

/* ------------------------------------------------------------------ */
/* 1. Event trees                                                      */
/* ------------------------------------------------------------------ */

/**
 * Outcome frequencies of an event tree.
 *
 *   tree = { branches: [{ name, probability, outcome?, next?: tree }] }
 *
 * A branch with `next` continues; a branch without it is a leaf, whose
 * outcome is `outcome` (to pool several leaves into one outcome) or its
 * name. Every set of branches must sum to 1 within BRANCH_SUM_TOLERANCE, or
 * the node is refused by its path (tree.branches[1].next.branches). The
 * leaf frequency is f0 times the product of the probabilities on its path.
 */
export const eventTree = ({ initiatingFrequencyPerYr, tree } = {}) => {
  if (!positive(initiatingFrequencyPerYr)) return refuse('initiatingFrequencyPerYr', 'must be a frequency above 0 per year');
  const outcomes = [];
  const walk = (node, fieldPath, pathNames, p) => {
    if (!node || !Array.isArray(node.branches) || node.branches.length === 0) {
      return refuse(`${fieldPath}.branches`, 'must be a non-empty list of { name, probability, next? }');
    }
    const seen = new Set();
    let sum = 0;
    for (let i = 0; i < node.branches.length; i += 1) {
      const b = node.branches[i] || {};
      const f = `${fieldPath}.branches[${i}]`;
      if (typeof b.name !== 'string' || !b.name.trim()) return refuse(`${f}.name`, 'every branch needs a name');
      if (seen.has(b.name)) return refuse(`${f}.name`, `'${b.name}' appears twice in one branch set`);
      seen.add(b.name);
      if (!probability(b.probability)) return refuse(`${f}.probability`, `'${b.name}' must be a probability in [0, 1]`);
      sum += b.probability;
    }
    if (Math.abs(sum - 1) > BRANCH_SUM_TOLERANCE) {
      return refuse(`${fieldPath}.branches`, `the branch probabilities sum to ${sum}, not 1 (tolerance ${BRANCH_SUM_TOLERANCE}): every branch set must be exhaustive and exclusive`);
    }
    for (let i = 0; i < node.branches.length; i += 1) {
      const b = node.branches[i];
      const names = [...pathNames, b.name];
      const pp = p * b.probability;
      if (given(b.next)) {
        const r = walk(b.next, `${fieldPath}.branches[${i}].next`, names, pp);
        if (r) return r;
      } else {
        const outcome = typeof b.outcome === 'string' && b.outcome.trim() ? b.outcome : b.name;
        outcomes.push({ path: names, outcome, probability: pp, frequencyPerYr: initiatingFrequencyPerYr * pp });
      }
    }
    return null;
  };
  const bad = walk(tree, 'tree', [], 1);
  if (bad) return bad;
  // a Map, not an object literal: an outcome named 'constructor' or
  // '__proto__' would otherwise concatenate onto an inherited value or be
  // swallowed by the prototype setter. Object.fromEntries defines own keys.
  const totals = new Map();
  outcomes.forEach((o) => { totals.set(o.outcome, (totals.get(o.outcome) || 0) + o.frequencyPerYr); });
  const outcomeTotals = Object.fromEntries(totals);
  return {
    outcomes,
    outcomeTotalsPerYr: outcomeTotals,
    totalFrequencyPerYr: outcomes.reduce((s, o) => s + o.frequencyPerYr, 0),
    basis: {
      model: 'event tree: leaf frequency = f0 x product of the branch probabilities on its path; each branch set sums to 1',
      source: `${SRC.PB} eq. 6.5 (f = fS PM Pphi Pi) and Figure 6.3`,
      units: 'per year; probabilities',
    },
  };
};

/** PB section 4.8: an ignited unconfined vapour cloud is split into a pure flash fire and a pure explosion. */
export const PB_VAPOUR_CLOUD_SPLIT = Object.freeze({ flashFire: 0.6, explosion: 0.4, source: `${SRC.PB} section 4.8` });

/**
 * A continuous flammable release: immediate ignition (a jet or pool fire),
 * else delayed ignition splitting into flash fire and explosion, else no
 * ignition. The ignition probabilities are the caller's (for direct
 * ignition see pbDirectIgnitionProbability); the split defaults to the PB
 * 0.6 / 0.4 and may be given as { flashFire, explosion }.
 */
export const flammableReleaseEventTree = ({
  initiatingFrequencyPerYr, immediateIgnitionProbability, delayedIgnitionProbability,
  vapourCloudSplit = 'purple-book', immediateOutcome = 'jet or pool fire',
} = {}) => {
  if (!probability(immediateIgnitionProbability)) return refuse('immediateIgnitionProbability', 'must be a probability in [0, 1]');
  if (!probability(delayedIgnitionProbability)) return refuse('delayedIgnitionProbability', 'must be the probability of delayed ignition GIVEN no immediate ignition, in [0, 1]');
  let split;
  if (vapourCloudSplit === 'purple-book') split = PB_VAPOUR_CLOUD_SPLIT;
  else if (vapourCloudSplit && typeof vapourCloudSplit === 'object') split = vapourCloudSplit;
  else return refuse('vapourCloudSplit', "must be 'purple-book' or { flashFire, explosion }");
  const r = eventTree({
    initiatingFrequencyPerYr,
    tree: {
      branches: [
        { name: 'immediate ignition', probability: immediateIgnitionProbability, outcome: immediateOutcome },
        {
          name: 'no immediate ignition',
          probability: 1 - immediateIgnitionProbability,
          next: {
            branches: [
              {
                name: 'delayed ignition',
                probability: delayedIgnitionProbability,
                next: {
                  branches: [
                    { name: 'flash fire', probability: split.flashFire },
                    { name: 'explosion', probability: split.explosion },
                  ],
                },
              },
              { name: 'no ignition', probability: 1 - delayedIgnitionProbability },
            ],
          },
        },
      ],
    },
  });
  if (r.error) {
    return r.field.includes('.next.branches[0].next') ? refuse('vapourCloudSplit', r.error) : r;
  }
  return {
    ...r,
    basis: {
      ...r.basis,
      vapourCloudSplit: vapourCloudSplit === 'purple-book' ? `flash fire 0.6, explosion 0.4 (${SRC.PB} section 4.8)` : 'as given',
    },
  };
};

/** PB Table 4.5: probability of direct ignition, stationary installations. */
export const PB_DIRECT_IGNITION_STATIONARY = Object.freeze({
  'k1-liquid': Object.freeze([0.065, 0.065, 0.065]),
  'gas-low-reactivity': Object.freeze([0.02, 0.04, 0.09]),
  'gas-average-high-reactivity': Object.freeze([0.2, 0.5, 0.7]),
});

/**
 * Direct ignition probability from PB Table 4.5. Bands: continuous < 10,
 * 10 - 100, > 100 kg/s; instantaneous < 1000, 1000 - 10,000, > 10,000 kg.
 * The printed middle band is closed ("10 - 100"), so exactly 10 and exactly
 * 100 kg/s (1000 and 10,000 kg) fall in it.
 */
export const pbDirectIgnitionProbability = ({ releaseType, massRateKgS, massKg, substance } = {}) => {
  if (!ownPreset(PB_DIRECT_IGNITION_STATIONARY, substance)) return refuse('substance', `must be one of ${Object.keys(PB_DIRECT_IGNITION_STATIONARY).join(', ')} (PB Table 4.7 classifies reactivity)`);
  const row = PB_DIRECT_IGNITION_STATIONARY[substance];
  let x;
  let lo;
  let hi;
  if (releaseType === 'continuous') {
    if (!positive(massRateKgS)) return refuse('massRateKgS', 'a continuous release needs a rate above 0 kg/s');
    x = massRateKgS; lo = 10; hi = 100;
  } else if (releaseType === 'instantaneous') {
    if (!positive(massKg)) return refuse('massKg', 'an instantaneous release needs a mass above 0 kg');
    x = massKg; lo = 1000; hi = 10000;
  } else {
    return refuse('releaseType', "must be 'continuous' or 'instantaneous'");
  }
  const band = x < lo ? 0 : (x <= hi ? 1 : 2);
  return {
    probability: row[band],
    band: ['small', 'medium', 'large'][band],
    basis: {
      model: 'table lookup; the middle band is closed at both ends',
      source: `${SRC.PB} Table 4.5 (stationary installations)`,
      units: 'probability; kg/s or kg',
    },
  };
};

/* ------------------------------------------------------------------ */
/* 2. Individual risk, PLL, FAR                                        */
/* ------------------------------------------------------------------ */

const scenarioList = (scenarios, field, check) => {
  if (!Array.isArray(scenarios) || scenarios.length === 0) return refuse(field, 'must be a non-empty list of scenarios');
  const out = [];
  for (let i = 0; i < scenarios.length; i += 1) {
    const s = scenarios[i] || {};
    const f = `${field}[${i}]`;
    if (typeof s.name !== 'string' || !s.name.trim()) return refuse(`${f}.name`, 'every scenario needs a name');
    if (!nonNegative(s.frequencyPerYr)) return refuse(`${f}.frequencyPerYr`, `'${s.name}' must have a frequency of 0 or more per year`);
    const bad = check(s, f);
    if (bad) return bad;
    out.push(s);
  }
  return { items: out };
};

/**
 * Location-specific individual risk: IR = sum over scenarios of f x Pd,
 * f the scenario frequency (fS PM Pphi Pi, PB 6.5) and Pd the probability
 * of death of an unprotected person present outdoors at the location all
 * the time (PB 5.1; Bevi's "onafgebroken en onbeschermd").
 */
export const locationIndividualRisk = ({ scenarios } = {}) => {
  const L = scenarioList(scenarios, 'scenarios', (s, f) => (
    probability(s.fatalityProbability) ? null : refuse(`${f}.fatalityProbability`, `'${s.name}' must be a probability of death in [0, 1]`)
  ));
  if (L.error) return L;
  const contributions = L.items.map((s) => ({ name: s.name, contributionPerYr: s.frequencyPerYr * s.fatalityProbability }));
  const lsir = contributions.reduce((a, c) => a + c.contributionPerYr, 0);
  contributions.forEach((c) => { c.fraction = lsir > 0 ? c.contributionPerYr / lsir : 0; });
  return {
    lsirPerYr: lsir,
    contributions,
    basis: {
      model: 'LSIR = sum f_i x Pd_i, a person present at the location all the time, outdoors and unprotected',
      source: `${SRC.PB} eqs. 6.1, 6.2 and section 5.1`,
      units: 'per year',
    },
  };
};

/**
 * Individual risk per annum of one person over the locations they occupy:
 * IRPA = sum LSIR_j x occupancy_j x v_j. Occupancy is a fraction of the
 * year (or hoursPerYr / 8760); it may not exceed 1 at a location, nor in
 * total, since a person is in one place at a time. v_j is the caller's
 * vulnerability factor in [0, 1] (default 1: no protection credited); no
 * source read gives one for individual risk.
 */
export const individualRiskPerAnnum = ({ locations } = {}) => {
  if (!Array.isArray(locations) || locations.length === 0) return refuse('locations', 'must be a non-empty list of { name, lsirPerYr, occupancyFraction | hoursPerYr }');
  let total = 0;
  let occ = 0;
  const parts = [];
  for (let i = 0; i < locations.length; i += 1) {
    const l = locations[i] || {};
    const f = `locations[${i}]`;
    if (typeof l.name !== 'string' || !l.name.trim()) return refuse(`${f}.name`, 'every location needs a name');
    if (!nonNegative(l.lsirPerYr)) return refuse(`${f}.lsirPerYr`, `'${l.name}' must have an LSIR of 0 or more per year`);
    const hasFrac = given(l.occupancyFraction);
    const hasHours = given(l.hoursPerYr);
    if (hasFrac === hasHours) return refuse(`${f}.occupancyFraction`, `'${l.name}': give exactly one of occupancyFraction and hoursPerYr`);
    let o;
    if (hasFrac) {
      if (!probability(l.occupancyFraction)) return refuse(`${f}.occupancyFraction`, `'${l.name}' must be a fraction of the year in [0, 1]`);
      o = l.occupancyFraction;
    } else {
      if (!nonNegative(l.hoursPerYr) || l.hoursPerYr > HOURS_PER_YEAR) return refuse(`${f}.hoursPerYr`, `'${l.name}' must lie in [0, ${HOURS_PER_YEAR}] hours`);
      o = l.hoursPerYr / HOURS_PER_YEAR;
    }
    const v = given(l.vulnerabilityFactor) ? l.vulnerabilityFactor : 1;
    if (!probability(v)) return refuse(`${f}.vulnerabilityFactor`, `'${l.name}' must be a factor in [0, 1]`);
    occ += o;
    const c = l.lsirPerYr * o * v;
    total += c;
    parts.push({ name: l.name, occupancyFraction: o, vulnerabilityFactor: v, contributionPerYr: c });
  }
  if (occ > 1 + 1e-12) return refuse('locations', `the occupancy fractions sum to ${occ}: one person cannot spend more than the whole year across locations`);
  return {
    irpaPerYr: total,
    totalOccupancyFraction: occ,
    contributions: parts,
    basis: {
      model: 'IRPA = sum LSIR_j x occupancy_j x v_j (v as supplied, default 1)',
      source: `${SRC.PB} section 5.1 (IR assumes presence all the time); occupancy from hours uses ${HOURS_PER_YEAR} h per year (engines/hse/lopa.js)`,
      units: 'per year',
    },
  };
};

const fatalitiesCheck = (s, f) => (
  nonNegative(s.fatalities) ? null : refuse(`${f}.fatalities`, `'${s.name}' must have 0 or more fatalities (an expected number need not be whole)`)
);

/** Potential loss of life, PLL = sum f_i N_i, expected fatalities per year. */
export const potentialLossOfLife = ({ scenarios } = {}) => {
  const L = scenarioList(scenarios, 'scenarios', fatalitiesCheck);
  if (L.error) return L;
  const contributions = L.items.map((s) => ({ name: s.name, pllPerYr: s.frequencyPerYr * s.fatalities }));
  return {
    pllPerYr: contributions.reduce((a, c) => a + c.pllPerYr, 0),
    contributions,
    basis: {
      model: 'PLL = sum f_i x N_i; N the expected number of deaths of the scenario (PB 6.3, 6.4: not necessarily whole)',
      source: `${SRC.PB} eqs. 6.3 to 6.5`,
      units: 'fatalities per year',
    },
  };
};

/**
 * Fatal accident rate from PLL: FAR = PLL x 1e8 / exposed hours per year,
 * the base being safetyStats RATE_BASES.FAR_100M (fatalities per 1e8
 * exposed hours), so that a PLL equal to a whole count of fatalities gives
 * exactly safetyStats.fatalAccidentRate.
 */
export const fatalAccidentRateFromPll = ({ pllPerYr, exposedHoursPerYr } = {}) => {
  if (!nonNegative(pllPerYr)) return refuse('pllPerYr', 'must be 0 or more fatalities per year');
  if (!positive(exposedHoursPerYr)) return refuse('exposedHoursPerYr', 'must be above 0 hours: a rate over no exposure is undefined');
  const base = RATE_BASES.FAR_100M;
  return {
    far: (pllPerYr * base) / exposedHoursPerYr,
    basis: {
      model: 'FAR = PLL x 100,000,000 / exposed hours per year',
      source: 'engines/hse/safetyStats.js RATE_BASES.FAR_100M (IOGP: fatalities per 100,000,000 hours)',
      units: 'fatalities per 1e8 exposed hours',
    },
  };
};

/* ------------------------------------------------------------------ */
/* 3. F-N curves                                                       */
/* ------------------------------------------------------------------ */

/**
 * F-N curve: F(N) = sum of f_i over scenarios with N_i >= N (PB 6.6), at
 * each distinct N_i > 0. F is a left-continuous step function: on (N_(k-1),
 * N_k] it equals F(N_k). Scenarios with N = 0 are kept out of the curve and
 * their frequency reported. The expected number of deaths per year, sum f
 * N, equals the area under the curve.
 */
export const fnCurve = ({ scenarios } = {}) => {
  const L = scenarioList(scenarios, 'scenarios', fatalitiesCheck);
  if (L.error) return L;
  const positiveN = L.items.filter((s) => s.fatalities > 0).sort((a, b) => b.fatalities - a.fatalities);
  const zeroFrequency = L.items.filter((s) => s.fatalities === 0).reduce((a, s) => a + s.frequencyPerYr, 0);
  const desc = [];
  let cum = 0;
  for (let i = 0; i < positiveN.length; i += 1) {
    cum += positiveN[i].frequencyPerYr;
    const n = positiveN[i].fatalities;
    if (i + 1 < positiveN.length && positiveN[i + 1].fatalities === n) continue;
    desc.push({ fatalities: n, cumulativeFrequencyPerYr: cum });
  }
  const points = desc.reverse();
  return {
    points,
    expectedFatalitiesPerYr: L.items.reduce((a, s) => a + s.frequencyPerYr * s.fatalities, 0),
    zeroFatalityFrequencyPerYr: zeroFrequency,
    basis: {
      model: 'F(N) = sum of f_i with N_i >= N, at each distinct N_i > 0 (left-continuous step function)',
      source: `${SRC.PB} eq. 6.6 and section 6.3 ("N or more")`,
      units: 'per year; fatalities',
    },
  };
};

/**
 * Societal risk criteria. A line F = C / N^alpha for N in [nMin, nMax], or
 * points { fatalities, frequencyPerYr }. Only what a source read states:
 *
 *   'vrom-establishments'  C = 1e-3, alpha = 2, N >= 10: PB Figure 6.8
 *                          ("F < 10^-3 x N^-2 y^-1 for N >= 10") and Bevi
 *                          art. 13(1)(b) (1e-5 at 10, 1e-7 at 100, 1e-9 at
 *                          1000); an orientation value, not a legal limit.
 *   'r2p2-para-136'        the single R2P2 point: 50 or more deaths more
 *                          often than 1 in 5000 per year is intolerable.
 *                          R2P2 gives no slope.
 */
export const FN_CRITERIA = Object.freeze({
  'vrom-establishments': Object.freeze({
    constantC: 1e-3, exponentAlpha: 2, minFatalities: 10, maxFatalities: Infinity,
    source: `${SRC.PB} Figure 6.8; ${SRC.BEVI}`,
  }),
  'r2p2-para-136': Object.freeze({
    points: Object.freeze([Object.freeze({ fatalities: 50, frequencyPerYr: 1 / 5000 })]),
    source: `${SRC.R2P2} para 136`,
  }),
});

const criterionSpec = (criterion) => {
  if (typeof criterion === 'string') {
    if (!ownPreset(FN_CRITERIA, criterion)) return refuse('criterion', `unknown preset '${criterion}'; one of ${Object.keys(FN_CRITERIA).join(', ')}, or give { constantC, exponentAlpha } or { points }`);
    return { ...FN_CRITERIA[criterion], preset: criterion };
  }
  if (!criterion || typeof criterion !== 'object') return refuse('criterion', 'a preset name, { constantC, exponentAlpha, minFatalities?, maxFatalities? } or { points } is required');
  if (given(criterion.points)) {
    if (!Array.isArray(criterion.points) || criterion.points.length === 0) return refuse('criterion.points', 'must be a non-empty list of { fatalities, frequencyPerYr }');
    for (let i = 0; i < criterion.points.length; i += 1) {
      const p = criterion.points[i] || {};
      if (!positive(p.fatalities)) return refuse(`criterion.points[${i}].fatalities`, 'must be above 0');
      if (!positive(p.frequencyPerYr)) return refuse(`criterion.points[${i}].frequencyPerYr`, 'must be above 0 per year');
    }
    return { points: criterion.points, preset: null, source: 'as given' };
  }
  if (!positive(criterion.constantC)) return refuse('criterion.constantC', 'must be above 0 (the line F = C / N^alpha at N = 1)');
  if (!positive(criterion.exponentAlpha)) return refuse('criterion.exponentAlpha', 'must be above 0 (1 is risk neutral, 2 risk averse)');
  const nMin = given(criterion.minFatalities) ? criterion.minFatalities : 1;
  const nMax = given(criterion.maxFatalities) ? criterion.maxFatalities : Infinity;
  if (!positive(nMin)) return refuse('criterion.minFatalities', 'must be above 0');
  if (!(nMax === Infinity || (isNum(nMax) && nMax >= nMin))) return refuse('criterion.maxFatalities', 'must be at least minFatalities, or Infinity');
  return {
    constantC: criterion.constantC, exponentAlpha: criterion.exponentAlpha, minFatalities: nMin, maxFatalities: nMax, preset: null, source: 'as given',
  };
};

const STATE_OF = { 1: 'EXCEEDS', 0: 'AT_LINE', '-1': 'BELOW' };

/**
 * An F-N curve against a criterion. Because F is constant on each step
 * (N_(k-1), N_k] and a line C / N^alpha falls with N, the largest ratio
 * F / line on a step is at its right corner N_k, which the curve attains;
 * the corners inside [nMin, nMax] and nMax itself (when finite) are
 * therefore the whole comparison. "Exceeds" is strictly above the line
 * (R2P2: "more than"; Bevi: "ten hoogste", at most); a corner within
 * BOUNDARY_SNAP of the line is AT_LINE, and an otherwise compliant curve
 * that touches the line is reported TOUCHES. For each exceeding step the
 * N range over which F lies above the line is reported.
 */
export const fnCriterionComparison = ({ scenarios, criterion } = {}) => {
  const curve = fnCurve({ scenarios });
  if (curve.error) return curve;
  const c = criterionSpec(criterion);
  if (c.error) return c;
  const pts = curve.points;
  const F = (n) => {
    let v = 0;
    for (let i = pts.length - 1; i >= 0 && pts[i].fatalities >= n; i -= 1) v = pts[i].cumulativeFrequencyPerYr;
    return v;
  };
  const checks = [];
  if (c.points) {
    c.points.forEach((p) => {
      const f = F(p.fatalities);
      const cmp = compare(f, p.frequencyPerYr);
      checks.push({
        fatalities: p.fatalities, curveFrequencyPerYr: f, criterionFrequencyPerYr: p.frequencyPerYr,
        ratio: f / p.frequencyPerYr, state: STATE_OF[cmp],
      });
    });
  } else {
    const line = (n) => c.constantC / n ** c.exponentAlpha;
    const corners = pts.map((p, k) => ({ ...p, previous: k === 0 ? 0 : pts[k - 1].fatalities }))
      .filter((p) => p.fatalities >= c.minFatalities && p.fatalities <= c.maxFatalities);
    if (c.maxFatalities !== Infinity) {
      const f = F(c.maxFatalities);
      const k = pts.findIndex((p) => p.fatalities > c.maxFatalities);
      if (f > 0 && k >= 0 && (k === 0 ? 0 : pts[k - 1].fatalities) < c.maxFatalities) {
        corners.push({ fatalities: c.maxFatalities, cumulativeFrequencyPerYr: f, previous: k === 0 ? 0 : pts[k - 1].fatalities });
      }
    }
    corners.forEach((p) => {
      const L = line(p.fatalities);
      const f = p.cumulativeFrequencyPerYr;
      const cmp = compare(f, L);
      const row = {
        fatalities: p.fatalities, curveFrequencyPerYr: f, criterionFrequencyPerYr: L, ratio: f / L, state: STATE_OF[cmp],
      };
      if (cmp === 1) {
        const crossing = (c.constantC / f) ** (1 / c.exponentAlpha);
        row.exceedsOverFatalities = { from: Math.max(p.previous, crossing, c.minFatalities), to: p.fatalities };
      }
      checks.push(row);
    });
  }
  const worst = checks.reduce((w, r) => (w === null || r.ratio > w.ratio ? r : w), null);
  let state = 'BELOW';
  if (checks.some((r) => r.state === 'EXCEEDS')) state = 'EXCEEDS';
  else if (checks.some((r) => r.state === 'AT_LINE')) state = 'TOUCHES';
  return {
    state,
    maxRatio: worst ? worst.ratio : 0,
    worstAtFatalities: worst ? worst.fatalities : null,
    checks,
    exceedances: checks.filter((r) => r.state === 'EXCEEDS'),
    curve: curve.points,
    basis: {
      model: c.points
        ? 'curve F(N) at each criterion point; exceeds when strictly above'
        : 'curve corners against F = C / N^alpha on [nMin, nMax]; exceeds when strictly above; ratio = F / line',
      source: c.preset ? c.source : 'criterion as given',
      criterion: c.points ? { points: c.points } : {
        constantC: c.constantC, exponentAlpha: c.exponentAlpha, minFatalities: c.minFatalities, maxFatalities: c.maxFatalities,
      },
      boundary: `within ${BOUNDARY_SNAP} relative of the criterion counts as on it (AT_LINE / TOUCHES), not above it`,
      units: 'per year; fatalities',
    },
  };
};

/* ------------------------------------------------------------------ */
/* 4. ALARP banding                                                    */
/* ------------------------------------------------------------------ */

/**
 * R2P2 individual risk criteria, per year: unacceptable above 1e-3
 * (workers) or 1e-4 (the public), broadly acceptable at or below 1e-6 for
 * both (paras 130, 132). R2P2 calls them "guidelines ... not intended to be
 * rigid benchmarks" (para 129).
 */
export const TOLERABILITY_PRESETS = Object.freeze({
  'r2p2-workers': Object.freeze({ unacceptableAbovePerYr: 1e-3, broadlyAcceptableAtOrBelowPerYr: 1e-6, source: `${SRC.R2P2} paras 130, 132` }),
  'r2p2-public': Object.freeze({ unacceptableAbovePerYr: 1e-4, broadlyAcceptableAtOrBelowPerYr: 1e-6, source: `${SRC.R2P2} paras 130, 132` }),
});

/**
 * The tolerability of risk region of an individual risk. Boundary
 * convention, stated and gated: UNACCEPTABLE only when strictly above the
 * upper limit, BROADLY_ACCEPTABLE at or below the lower one, TOLERABLE
 * between (the ALARP region). A value within BOUNDARY_SNAP of a threshold
 * is taken as equal to it and flagged atBoundary.
 */
export const alarpBand = ({ individualRiskPerYr, thresholds } = {}) => {
  if (!nonNegative(individualRiskPerYr)) return refuse('individualRiskPerYr', 'must be 0 or more per year');
  let t;
  if (typeof thresholds === 'string') {
    if (!ownPreset(TOLERABILITY_PRESETS, thresholds)) return refuse('thresholds', `unknown preset '${thresholds}'; one of ${Object.keys(TOLERABILITY_PRESETS).join(', ')}, or give { unacceptableAbovePerYr, broadlyAcceptableAtOrBelowPerYr }`);
    t = TOLERABILITY_PRESETS[thresholds];
  } else if (thresholds && typeof thresholds === 'object') {
    t = thresholds;
    if (!positive(t.unacceptableAbovePerYr)) return refuse('thresholds.unacceptableAbovePerYr', 'must be above 0 per year');
    if (!positive(t.broadlyAcceptableAtOrBelowPerYr)) return refuse('thresholds.broadlyAcceptableAtOrBelowPerYr', 'must be above 0 per year');
    if (!(t.broadlyAcceptableAtOrBelowPerYr < t.unacceptableAbovePerYr)) return refuse('thresholds.broadlyAcceptableAtOrBelowPerYr', 'must lie below unacceptableAbovePerYr');
  } else {
    return refuse('thresholds', 'a preset name or { unacceptableAbovePerYr, broadlyAcceptableAtOrBelowPerYr } is required');
  }
  const ir = individualRiskPerYr;
  const up = compare(ir, t.unacceptableAbovePerYr);
  const low = compare(ir, t.broadlyAcceptableAtOrBelowPerYr);
  let band;
  if (up === 1) band = 'UNACCEPTABLE';
  else if (low <= 0) band = 'BROADLY_ACCEPTABLE';
  else band = 'TOLERABLE';
  let atBoundary = null;
  if (up === 0) atBoundary = 'unacceptable';
  else if (low === 0) atBoundary = 'broadly-acceptable';
  return {
    band,
    atBoundary,
    alarpDemonstrationRequired: band === 'TOLERABLE',
    ratioToUnacceptable: ir / t.unacceptableAbovePerYr,
    ratioToBroadlyAcceptable: ir / t.broadlyAcceptableAtOrBelowPerYr,
    basis: {
      model: 'UNACCEPTABLE if IR > upper; BROADLY_ACCEPTABLE if IR <= lower; TOLERABLE (reduce ALARP) between',
      source: typeof thresholds === 'string' ? t.source : 'thresholds as given',
      thresholds: { unacceptableAbovePerYr: t.unacceptableAbovePerYr, broadlyAcceptableAtOrBelowPerYr: t.broadlyAcceptableAtOrBelowPerYr },
      boundary: `a threshold value belongs to the LOWER band (R2P2 para 136 "more than"; CBA "costs/benefits > DF"); within ${BOUNDARY_SNAP} relative counts as equal`,
      units: 'per year',
    },
  };
};

/* ------------------------------------------------------------------ */
/* 5. Cost-benefit and gross disproportion                             */
/* ------------------------------------------------------------------ */

/**
 * Published figures, for ILLUSTRATION ONLY: VPF and DF are always inputs.
 * Currency GBP at the stated price year.
 */
export const HSE_ILLUSTRATIVE_VALUES = Object.freeze({
  vpfGbp2001: Object.freeze({ value: 1000000, source: `${SRC.R2P2} Appendix 3 para 13 ("about GBP 1 000 000 (2001 prices)")` }),
  vpfGbp2003Q3: Object.freeze({ value: 1336800, source: `${SRC.CBA}: fatality GBP 1,336,800 (times 2 for cancer)` }),
  disproportionFactor: Object.freeze({ note: 'DFs "vary from upwards of 1"; in the checklist example "a DF of more than 10 is unlikely"', source: SRC.CBA }),
});

/**
 * Cost-benefit of a risk reduction measure, and the gross disproportion
 * test of the HSE CBA checklist: the measure is not reasonably practicable
 * when costs / benefits > DF, i.e. cost > DF x benefit. At equality it is
 * NOT grossly disproportionate.
 *
 *   benefit per year  B = deltaPllPerYr x VPF + sum(expectedCasesPerYr x valuePerCase)
 *   benefit           PV of B (1 + g)^t for t = 1..n, at benefitDiscountRate
 *   cost              capitalCost at t = 0 plus PV of annualCost for t = 1..n
 *                     at costDiscountRate
 *   CPF (ICAF)        cost / (deltaPllPerYr x n), R2P2 App. 3 para 15
 *
 * Every present value goes through the canonical year-end npv of
 * engines/economics/cashflow.ts; rates default to 0 (undiscounted, as in
 * the CBA checklist example). g is the real uprating of the benefit (R2P2
 * App. 3 para 17 cites 4 percent a year with a 6 percent discount rate;
 * the 2003 checklist says benefits at no more than 1.5 percent and costs at
 * no less than 3.5 percent). All of these are the caller's.
 */
export const costBenefit = ({
  deltaPllPerYr, vpf, otherHarms = [], lifetimeYears, capitalCost, annualCost = 0,
  disproportionFactor, benefitDiscountRate = 0, costDiscountRate = 0, benefitGrowthRate = 0,
} = {}) => {
  if (!nonNegative(deltaPllPerYr)) return refuse('deltaPllPerYr', 'must be the reduction in PLL, 0 or more fatalities per year (a measure that raises risk has no benefit to weigh)');
  if (!positive(vpf)) return refuse('vpf', 'the value of preventing a fatality is required, above 0; HSE figures are illustrative only (HSE_ILLUSTRATIVE_VALUES)');
  if (!Array.isArray(otherHarms)) return refuse('otherHarms', 'must be a list of { name, expectedCasesPerYr, valuePerCase }');
  let harmsPerYr = 0;
  const harms = [];
  for (let i = 0; i < otherHarms.length; i += 1) {
    const h = otherHarms[i] || {};
    if (typeof h.name !== 'string' || !h.name.trim()) return refuse(`otherHarms[${i}].name`, 'every harm needs a name');
    if (!nonNegative(h.expectedCasesPerYr)) return refuse(`otherHarms[${i}].expectedCasesPerYr`, 'must be 0 or more cases prevented per year');
    if (!nonNegative(h.valuePerCase)) return refuse(`otherHarms[${i}].valuePerCase`, 'must be 0 or more');
    const v = h.expectedCasesPerYr * h.valuePerCase;
    harmsPerYr += v;
    harms.push({ name: h.name, benefitPerYr: v });
  }
  if (!Number.isInteger(lifetimeYears) || lifetimeYears < 1) return refuse('lifetimeYears', 'must be a whole number of years, 1 or more (flows are year-end)');
  if (!nonNegative(capitalCost)) return refuse('capitalCost', 'must be 0 or more, spent at year 0');
  if (!nonNegative(annualCost)) return refuse('annualCost', 'must be 0 or more per year, net of any cost savings');
  if (!isNum(disproportionFactor) || disproportionFactor < 1) return refuse('disproportionFactor', 'must be 1 or more: HSE, "DFs that may be considered gross vary from upwards of 1"');
  for (const [k, v] of [['benefitDiscountRate', benefitDiscountRate], ['costDiscountRate', costDiscountRate], ['benefitGrowthRate', benefitGrowthRate]]) {
    if (!isNum(v) || !(v > -1)) return refuse(k, 'must be a rate per year above -1 (0.035 for 3.5 percent)');
  }
  const fatalityBenefitPerYr = deltaPllPerYr * vpf;
  const benefitPerYr = fatalityBenefitPerYr + harmsPerYr;
  if (!(benefitPerYr > 0)) return refuse('deltaPllPerYr', 'the measure prevents nothing (no PLL reduction and no other harm): there is no benefit to weigh the cost against');
  const years = Array.from({ length: lifetimeYears }, (_, i) => i + 1);
  const benefitFlows = years.map((t) => benefitPerYr * (1 + benefitGrowthRate) ** t);
  const pvBenefit = npv(benefitFlows, benefitDiscountRate, 0, 1);
  const pvCost = npv([capitalCost, ...years.map(() => annualCost)], costDiscountRate, 0, 0);
  const threshold = disproportionFactor * pvBenefit;
  const cmp = compare(pvCost, threshold);
  const fatalitiesPrevented = deltaPllPerYr * lifetimeYears;
  return {
    benefitPerYr,
    fatalityBenefitPerYr,
    otherHarms: harms,
    presentValueBenefit: pvBenefit,
    presentValueCost: pvCost,
    fatalitiesPrevented,
    costPerFatalityPrevented: fatalitiesPrevented > 0 ? pvCost / fatalitiesPrevented : null,
    costToBenefitRatio: pvCost / pvBenefit,
    maximumReasonablyPracticableCost: threshold,
    verdict: cmp === 1 ? 'GROSSLY_DISPROPORTIONATE' : 'NOT_GROSSLY_DISPROPORTIONATE',
    atBoundary: cmp === 0,
    basis: {
      model: 'grossly disproportionate when cost / benefit > DF; benefit = (dPLL x VPF + other harms) per year over the life; CPF = cost / (dPLL x years)',
      source: `${SRC.CBA} (test, harm values, worked example); ${SRC.R2P2} Appendix 3 paras 13 to 17 (VPF, CPF, discounting)`,
      discounting: `${SRC.NPV}; benefits at ${benefitDiscountRate} growing at ${benefitGrowthRate}, costs at ${costDiscountRate}; ${benefitDiscountRate === 0 && costDiscountRate === 0 && benefitGrowthRate === 0 ? 'undiscounted' : 'discounted'}`,
      units: 'currency of the inputs; fatalities per year; years',
    },
  };
};

/* ------------------------------------------------------------------ */
/* 6. Consequence linkage                                              */
/* ------------------------------------------------------------------ */

/** PB Table 5.3, fraction of the population indoors. */
export const PB_FRACTION_INDOORS = Object.freeze({ day: 0.93, night: 0.99 });

/** PB Figure 5.4 and note 4: buildings and clothing ignite at 35 kW/m2 (Q >= 35 kW/m2 in the figure). */
export const PB_IGNITION_FLUX_WM2 = 35000;

/** PB Figure 5.5: peak overpressure thresholds of a vapour cloud explosion, Pa gauge. */
export const PB_VCE_OVERPRESSURE_PA = Object.freeze({ lethal: 30000, indoorOnly: 10000 });

/** PB section 5.2.3 note 3: the exposure time to a fire is limited to 20 s. */
export const PB_MAX_FIRE_EXPOSURE_S = 20;

/**
 * Probability of death PE (for IR) and the fractions dying indoors and
 * outdoors FE,in and FE,out (for societal risk), PB Figures 5.2 to 5.5, and
 * Fd = FE,in fpop,in + FE,out fpop,out (PB 6.7, 6.13).
 *
 *   'toxic'       PE given (a toxic probit); FE,in = 0.1 PE; FE,out = PE
 *   'fire'        BLEVE, pool or jet fire: in the flame envelope, or
 *                 Q >= 35 kW/m2, all 1; otherwise PE from the PB heat
 *                 probit (consequence.js 'purple-book') at min(t, 20 s),
 *                 FE,in = 0, FE,out = 0.14 PE
 *   'flash-fire'  inside the flame envelope 1, 1, 1; outside 0, 0, 0
 *   'explosion'   > 0.3 barg: 1, 1, 1; > 0.1 barg: PE 0, FE,in 0.025,
 *                 FE,out 0; else 0
 *
 * fpop,in from period 'day' | 'night' (Table 5.3) or fractionIndoors.
 */
export const pbFatalityFractions = ({
  effect, probabilityOfDeath, heatFluxWM2, fireDurationS, insideFlameEnvelope = false,
  peakOverpressurePa, period, fractionIndoors,
} = {}) => {
  let fin;
  if (given(fractionIndoors)) {
    if (given(period)) return refuse('fractionIndoors', "give a period ('day' or 'night') or fractionIndoors, not both");
    if (!probability(fractionIndoors)) return refuse('fractionIndoors', 'must be a fraction in [0, 1]');
    fin = fractionIndoors;
  } else {
    if (!ownPreset(PB_FRACTION_INDOORS, period)) return refuse('period', "must be 'day' or 'night' (PB Table 5.3), or give fractionIndoors");
    fin = PB_FRACTION_INDOORS[period];
  }
  let PE;
  let FEin;
  let FEout;
  let rule;
  let exposureTimeUsedS = null;
  if (effect === 'toxic') {
    if (!probability(probabilityOfDeath)) return refuse('probabilityOfDeath', 'the toxic probit probability, in [0, 1], is required');
    PE = probabilityOfDeath; FEin = 0.1 * PE; FEout = PE; rule = 'Figure 5.2: FE,in = 0.1 PE, FE,out = PE';
  } else if (effect === 'fire') {
    if (typeof insideFlameEnvelope !== 'boolean') return refuse('insideFlameEnvelope', 'must be true or false');
    if (insideFlameEnvelope) {
      PE = 1; FEin = 1; FEout = 1; rule = 'Figure 5.4: in the flame envelope';
    } else {
      if (!nonNegative(heatFluxWM2)) return refuse('heatFluxWM2', 'must be 0 or more W/m2');
      if (heatFluxWM2 >= PB_IGNITION_FLUX_WM2) {
        PE = 1; FEin = 1; FEout = 1; rule = 'Figure 5.4: Q >= 35 kW/m2';
      } else {
        if (!positive(fireDurationS)) return refuse('fireDurationS', 'must be the fire duration above 0 s (the PB limits the exposure to 20 s)');
        exposureTimeUsedS = Math.min(fireDurationS, PB_MAX_FIRE_EXPOSURE_S);
        if (heatFluxWM2 === 0) PE = 0;
        else {
          const p = thermalProbit({ coefficients: 'purple-book', heatFluxWM2, exposureTimeS: exposureTimeUsedS });
          if (p.error) return p;
          PE = p.probability;
        }
        FEin = 0; FEout = 0.14 * PE; rule = 'Figure 5.4: PE from the heat probit (5.4), FE,in = 0, FE,out = 0.14 PE';
      }
    }
  } else if (effect === 'flash-fire') {
    if (typeof insideFlameEnvelope !== 'boolean') return refuse('insideFlameEnvelope', 'must be true or false');
    PE = insideFlameEnvelope ? 1 : 0; FEin = PE; FEout = PE; rule = 'Figure 5.3: 1 inside the flame envelope (the LFL contour at ignition), 0 outside';
  } else if (effect === 'explosion') {
    if (!nonNegative(peakOverpressurePa)) return refuse('peakOverpressurePa', 'must be a peak side-on overpressure of 0 or more Pa gauge');
    if (peakOverpressurePa > PB_VCE_OVERPRESSURE_PA.lethal) { PE = 1; FEin = 1; FEout = 1; }
    else if (peakOverpressurePa > PB_VCE_OVERPRESSURE_PA.indoorOnly) { PE = 0; FEin = 0.025; FEout = 0; }
    else { PE = 0; FEin = 0; FEout = 0; }
    rule = 'Figure 5.5: > 0.3 barg 1, 1, 1; > 0.1 barg 0, 0.025, 0 (vapour cloud explosions only)';
  } else {
    return refuse('effect', "must be 'toxic', 'fire', 'flash-fire' or 'explosion'");
  }
  return {
    probabilityOfDeath: PE,
    fractionDyingIndoors: FEin,
    fractionDyingOutdoors: FEout,
    fractionIndoors: fin,
    fractionOfDeaths: FEin * fin + FEout * (1 - fin),
    exposureTimeUsedS,
    basis: {
      model: `${rule}; Fd = FE,in fpop,in + FE,out fpop,out`,
      source: `${SRC.PB} Figures 5.2 to 5.5, section 5.2.3 notes 3 to 5, Table 5.3, eqs. 6.7 and 6.13`,
      units: 'probabilities and fractions; W/m2; Pa gauge; s',
    },
  };
};

/**
 * Toxic plume, probability of death at a grid point (PB 6.2.5, Appendix
 * 6.B): the centreline probability Pcl from the H4 plume and toxic probit;
 * the probability integral PI = integral of P(y) dy across the plume,
 * bounded where P falls to cutoffProbability (PB: 1 percent), by composite
 * Simpson on 4000 intervals of the ENGINE'S OWN plume and probit; ECW =
 * PI / Pcl (6.9); Pci = nws ECW / (2 pi R) (6.10); Pd = Pcl Pci (6.11).
 * With frequencyPerYr and weatherDirectionProbability (PM x Pphi) given,
 * the contribution dIR = f PM Pphi Pd (6.1) is returned too. The exposure
 * is limited to 30 minutes (PB 5.2.2 note 3). Pci above 1 (a cloud wider
 * than the sector) is kept, as PB Appendix 6.A argues, with a warning.
 */
export const toxicPlumeGridPointRisk = ({
  massRateKgS, windSpeedMS, distanceM, stabilityClass, sigmaYM, sigmaZM, releaseHeightM = 0, receptorHeightM = 1,
  coefficients, exposureMinutes, windSectors = 12, cutoffProbability = 0.01, frequencyPerYr, weatherDirectionProbability,
} = {}) => {
  if (!positive(exposureMinutes)) return refuse('exposureMinutes', 'must be an exposure time above 0 min');
  if (!Number.isInteger(windSectors) || windSectors < 1) return refuse('windSectors', 'must be a whole number of wind sectors (the PB example uses 12)');
  if (!isNum(cutoffProbability) || !(cutoffProbability > 0) || !(cutoffProbability < 1)) return refuse('cutoffProbability', 'must lie strictly between 0 and 1 (PB: 0.01)');
  const tMin = Math.min(exposureMinutes, 30);
  const plumeArgs = {
    massRateKgS, windSpeedMS, downwindDistanceM: distanceM, stabilityClass, sigmaYM, sigmaZM, releaseHeightM, receptorHeightM,
  };
  const at = (y) => {
    const c = gaussianPlume({ ...plumeArgs, crosswindDistanceM: y });
    if (c.error) return c;
    if (!(c.concentrationMgM3 > 0)) return { probit: -Infinity, probability: 0, concentrationMgM3: 0 };
    const p = toxicProbit({ coefficients, concentrationMgM3: c.concentrationMgM3, exposureMinutes: tMin });
    if (p.error) return p;
    return { probit: p.probit, probability: p.probability, concentrationMgM3: c.concentrationMgM3, sigmaYM: c.sigmaYM };
  };
  const cl = at(0);
  if (cl.error) return cl;
  const yCut = probabilityToProbit(cutoffProbability).probit;
  const basis = {
    model: 'Pd = Pcl x Pci; ECW = PI / Pcl; Pci = nws ECW / (2 pi R); PI by Simpson across the plume to the cutoff probability',
    source: `${SRC.PB} section 6.2.5, eqs. 6.8 to 6.11, Appendix 6.B; plume and probit from engines/hse/consequence.js`,
    units: 'probabilities; m; per year',
  };
  if (!(cl.probit > yCut)) {
    return {
      state: 'BELOW_CUTOFF', centrelineProbability: cl.probability, probabilityIntegralM: 0, effectiveCloudWidthM: 0,
      coverageProbability: 0, probabilityOfDeath: 0, contributionPerYr: 0, exposureMinutesUsed: tMin, basis,
    };
  }
  // the half width where the probit reaches the cutoff: bracket, then bisect
  let hi = cl.sigmaYM;
  for (let i = 0; i < 200 && at(hi).probit > yCut; i += 1) hi *= 2;
  let lo = 0;
  for (let i = 0; i < 200; i += 1) {
    const m = 0.5 * (lo + hi);
    if (at(m).probit > yCut) lo = m; else hi = m;
    if (hi - lo <= 1e-12 * hi) break;
  }
  const yHalf = 0.5 * (lo + hi);
  const n = 4000;
  const h = yHalf / n;
  let s = cl.probability + at(yHalf).probability;
  for (let i = 1; i < n; i += 1) s += (i % 2 ? 4 : 2) * at(i * h).probability;
  const PI = 2 * (h / 3) * s;
  const ecw = PI / cl.probability;
  const pci = (windSectors * ecw) / (2 * Math.PI * distanceM);
  const pd = cl.probability * pci;
  const out = {
    state: 'COMPUTED',
    centrelineConcentrationMgM3: cl.concentrationMgM3,
    centrelineProbit: cl.probit,
    centrelineProbability: cl.probability,
    cutoffHalfWidthM: yHalf,
    probabilityIntegralM: PI,
    effectiveCloudWidthM: ecw,
    coverageProbability: pci,
    probabilityOfDeath: pd,
    exposureMinutesUsed: tMin,
    basis,
  };
  if (pci > 1) out.warning = 'the effective cloud is wider than the wind sector (Pci > 1): valid only if the wind direction probability varies little between adjacent sectors (PB Appendix 6.A)';
  if (given(frequencyPerYr) || given(weatherDirectionProbability)) {
    if (!nonNegative(frequencyPerYr)) return refuse('frequencyPerYr', 'must be the LOC frequency, 0 or more per year');
    if (!probability(weatherDirectionProbability)) return refuse('weatherDirectionProbability', 'must be PM x Pphi, a probability in [0, 1]');
    out.contributionPerYr = frequencyPerYr * weatherDirectionProbability * pd;
  }
  return out;
};

/**
 * Probability of death along a transect from heat fluxes, by the H4
 * thermal probit (consequence.js thermalProbit; preset or { a, b,
 * intensityUnit }). A flux of 0 gives 0 (the probit has no value there).
 */
export const thermalFatalityTransect = ({ heatFluxesWM2, exposureTimeS, coefficients = 'eisenberg' } = {}) => {
  if (!Array.isArray(heatFluxesWM2) || heatFluxesWM2.length === 0) return refuse('heatFluxesWM2', 'must be a non-empty list of heat fluxes in W/m2');
  if (!positive(exposureTimeS)) return refuse('exposureTimeS', 'must be an exposure time above 0 s');
  const probabilities = [];
  let basisProbit = null;
  for (let i = 0; i < heatFluxesWM2.length; i += 1) {
    const q = heatFluxesWM2[i];
    if (!nonNegative(q)) return refuse(`heatFluxesWM2[${i}]`, 'must be 0 or more W/m2');
    if (q === 0) { probabilities.push(0); continue; }
    const p = thermalProbit({ coefficients, heatFluxWM2: q, exposureTimeS });
    if (p.error) return p;
    basisProbit = p.basis;
    probabilities.push(p.probability);
  }
  return {
    probabilities,
    basis: {
      model: 'P = Phi(Y - 5), Y = a + b ln(t I^(4/3)) at each point; 0 where the flux is 0',
      source: `engines/hse/consequence.js thermalProbit${basisProbit ? ` (${basisProbit.source})` : ''}`,
      units: 'probability of death',
    },
  };
};

/**
 * A pool fire's probability of death along a transect from the pool
 * centre: the solid flame heat flux of consequence.js poolFireSolidFlame
 * (fixed transmissivity required), then the thermal probit. A point at or
 * inside the base radius, or under the overhang of a tilted flame, is in
 * the flame envelope: probability 1 (PB Figure 5.4).
 */
export const poolFireFatalityTransect = ({ distancesFromCentreM, exposureTimeS, coefficients = 'eisenberg', ...poolFire } = {}) => {
  if (!Array.isArray(distancesFromCentreM) || distancesFromCentreM.length === 0) return refuse('distancesFromCentreM', 'must be a non-empty list of distances in m');
  if (!positive(exposureTimeS)) return refuse('exposureTimeS', 'must be an exposure time above 0 s');
  if (!positive(poolFire.transmissivity) || poolFire.transmissivity > 1) return refuse('transmissivity', 'a fixed transmissivity in (0, 1] is required along a transect (Bagster is only valid over a band of path lengths)');
  if (!positive(poolFire.poolDiameterM)) return refuse('poolDiameterM', 'must be a pool diameter above 0 m');
  const R = poolFire.poolDiameterM / 2;
  const points = [];
  for (let i = 0; i < distancesFromCentreM.length; i += 1) {
    const x = distancesFromCentreM[i];
    if (!nonNegative(x)) return refuse(`distancesFromCentreM[${i}]`, 'must be 0 or more m');
    if (x <= R) { points.push({ distanceFromCentreM: x, state: 'IN_FLAME_ENVELOPE', heatFluxWM2: null, probability: 1 }); continue; }
    const q = poolFireSolidFlame({ ...poolFire, distanceFromCentreM: x });
    if (q.error) {
      if (q.field === 'tiltDeg') { points.push({ distanceFromCentreM: x, state: 'IN_FLAME_ENVELOPE', heatFluxWM2: null, probability: 1 }); continue; }
      return q;
    }
    const p = thermalProbit({ coefficients, heatFluxWM2: q.heatFluxWM2, exposureTimeS });
    if (p.error) return p;
    points.push({ distanceFromCentreM: x, state: 'RADIATION', heatFluxWM2: q.heatFluxWM2, probability: p.probability });
  }
  return {
    points,
    probabilities: points.map((p) => p.probability),
    basis: {
      model: 'solid flame heat flux (Fmax) then the thermal probit; in the flame envelope P = 1',
      source: `engines/hse/consequence.js poolFireSolidFlame and thermalProbit; ${SRC.PB} Figure 5.4 (flame envelope)`,
      units: 'm; W/m2; probability of death',
    },
  };
};

/** PB section 6.3: the IR contours a QRA must display, per year. */
export const PB_IR_CONTOURS_PER_YR = Object.freeze([1e-4, 1e-5, 1e-6, 1e-7, 1e-8]);

/**
 * LSIR along a transect: at each distance, sum of f_i x P_i(distance) over
 * the scenarios, and where it crosses each contour level. A crossing lies
 * between two consecutive points on opposite sides of the level (one at or
 * above, the other below); its distance is interpolated linearly in
 * log10(IR) when both values are above 0, else linearly in IR. Distances
 * must increase strictly.
 */
export const lsirTransect = ({ distancesM, scenarios, contourLevelsPerYr = PB_IR_CONTOURS_PER_YR } = {}) => {
  if (!Array.isArray(distancesM) || distancesM.length === 0) return refuse('distancesM', 'must be a non-empty list of distances in m');
  for (let j = 0; j < distancesM.length; j += 1) {
    if (!nonNegative(distancesM[j])) return refuse(`distancesM[${j}]`, 'must be 0 or more m');
    if (j > 0 && !(distancesM[j] > distancesM[j - 1])) return refuse(`distancesM[${j}]`, 'distances must increase strictly');
  }
  const n = distancesM.length;
  const L = scenarioList(scenarios, 'scenarios', (s, f) => {
    if (!Array.isArray(s.fatalityProbabilities) || s.fatalityProbabilities.length !== n) {
      return refuse(`${f}.fatalityProbabilities`, `'${s.name}' needs one probability of death per distance (${n})`);
    }
    for (let j = 0; j < n; j += 1) {
      if (!probability(s.fatalityProbabilities[j])) return refuse(`${f}.fatalityProbabilities[${j}]`, 'must be a probability in [0, 1]');
    }
    return null;
  });
  if (L.error) return L;
  if (!Array.isArray(contourLevelsPerYr)) return refuse('contourLevelsPerYr', 'must be a list of IR levels per year');
  for (let k = 0; k < contourLevelsPerYr.length; k += 1) {
    if (!positive(contourLevelsPerYr[k])) return refuse(`contourLevelsPerYr[${k}]`, 'must be above 0 per year');
  }
  const lsir = distancesM.map((_, j) => L.items.reduce((a, s) => a + s.frequencyPerYr * s.fatalityProbabilities[j], 0));
  const contours = contourLevelsPerYr.map((level) => {
    const crossingsM = [];
    for (let j = 0; j + 1 < n; j += 1) {
      const a = lsir[j];
      const b = lsir[j + 1];
      if ((a >= level) === (b >= level)) continue;
      let t;
      if (a > 0 && b > 0) t = (Math.log10(level) - Math.log10(a)) / (Math.log10(b) - Math.log10(a));
      else t = (level - a) / (b - a);
      crossingsM.push(distancesM[j] + t * (distancesM[j + 1] - distancesM[j]));
    }
    return { levelPerYr: level, crossingsM };
  });
  return {
    lsirPerYr: lsir,
    contours,
    basis: {
      model: 'LSIR(x) = sum f_i P_i(x); contour crossings interpolated in log10(IR) between bracketing points (linear in IR when one side is 0)',
      source: `${SRC.PB} eqs. 6.1, 6.2 and section 6.3 (contours 1e-4 to 1e-8 per year)`,
      units: 'per year; m',
    },
  };
};
