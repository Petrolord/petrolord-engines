/**
 * Layer of Protection Analysis and SIL determination / verification (HSE H3).
 *
 * Two halves, one vocabulary.
 *
 * 1. DETERMINATION (LOPA, CCPS 2001). A scenario's mitigated event
 *    frequency is the initiating event frequency times every conditional
 *    modifier and enabling condition the analyst supplies, times the PFD
 *    of every CREDITED independent protection layer:
 *
 *        f_mitigated = IEF x prod(P_modifier) x prod(PFD_IPL)       [/yr]
 *
 *    Compared against a tolerable / target mitigated event likelihood
 *    (TMEL) the analyst supplies, the risk reduction still missing is
 *
 *        RRF_required = f_mitigated_without_SIF / TMEL
 *        PFDavg_required = 1 / RRF_required = TMEL / f
 *
 *    and the SIL is the low-demand band that contains PFDavg_required.
 *    Nothing here invents a number: the IEF, every probability, every PFD
 *    and the TMEL are inputs. The credit rules (independence, one credit
 *    per IPL) are FLAGS on the inputs, applied, never assumed.
 *
 * 2. VERIFICATION (IEC 61508-6:2010 Annex B.3.2.2, reliability block
 *    diagram simplified equations, low demand). The full Annex B form is
 *    implemented, with the channel and group equivalent mean down times
 *
 *        tCE  = lDU/lD (T1/2 + MRT) + lDD/lD MTTR
 *        tGE  = lDU/lD (T1/3 + MRT) + lDD/lD MTTR     (1oo2, 2oo3)
 *        tG2E = lDU/lD (T1/3 + MRT) + lDD/lD MTTR     (1oo3, second failure)
 *        tGE  = lDU/lD (T1/4 + MRT) + lDD/lD MTTR     (1oo3, group)
 *
 *        1oo1  PFD = lD tCE
 *        2oo2  PFD = 2 lD tCE
 *        1oo2  PFD = 2 ((1-bD) lDD + (1-b) lDU)^2 tCE tGE + bD lDD MTTR + b lDU (T1/2 + MRT)
 *        2oo3  PFD = 6 ((1-bD) lDD + (1-b) lDU)^2 tCE tGE + bD lDD MTTR + b lDU (T1/2 + MRT)
 *        1oo3  PFD = 6 ((1-bD) lDD + (1-b) lDU)^3 tCE tG2E tGE + bD lDD MTTR + b lDU (T1/2 + MRT)
 *
 *    WHY THE FULL FORM AND NOT THE TR84 SIMPLIFIED ONE: the simplified
 *    forms (1oo1 = lDU T/2, 1oo2 = ((1-b) lDU)^2 T^2/3 + b lDU T/2,
 *    2oo3 = ((1-b) lDU)^2 T^2 + b lDU T/2, 2oo2 = lDU T) are EXACTLY the
 *    Annex B form with lDD = 0 and MRT = 0, so implementing Annex B gives
 *    both and the goldens gate both. Sources checked for this module:
 *    M.A. Lundteigen and M. Rausand, "Chapter 8. PFD formulas in IEC
 *    61508" (NTNU RAMS Group slides for Reliability of Safety-Critical
 *    Systems, Wiley 2014, DOI 10.1002/9781118776353), and the 61508
 *    Association workshop "SIL Calculations: Practical Guidance in the
 *    use of IEC 61508-6:2010" (I. Dolan, 2024), whose worked SIF this
 *    module reproduces to every printed digit (goldens).
 *
 *    Optional imperfect proof testing (Annex B.3.2.5 as the 61508
 *    Association states it): a proof test coverage PTC below 1 splits
 *    lDU into a part revealed every T1 and a part revealed only when the
 *    item is restored as new at T2, in tCE, tGE, tG2E and the CCF term.
 *
 * WHAT IS NOT HERE, AND WHY. No failure-rate data (users supply every
 * lambda; the golden rates are labelled illustrative or cited). No
 * architectural-constraint (minimum hardware fault tolerance) check: the
 * HFT requirements are a normative table of IEC 61511-1:2016 / IEC
 * 61508-2 Route 2H, and this module does not restate a licensed table
 * it could not check against a public primary source. No high-demand /
 * continuous mode (PFH): every band here is LOW DEMAND.
 *
 * BAND CONVENTION (IEC 61508-1 Table 2 / IEC 61511-1, as the 61508
 * Association slide prints it): SIL n holds 10^-(n+1) <= PFDavg <
 * 10^-n, equivalently 10^n < RRF <= 10^(n+1). An EXACT DECADE therefore
 * belongs to the band BELOW it in PFD: PFDavg = 1e-2 is SIL 1, 1e-3 is
 * SIL 2, 1e-1 is not SIL rated. Because a computed ratio such as
 * 1e-5 / 1e-3 is not exactly 1e-2 in binary floating point, a value
 * within DECADE_SNAP (1e-9 relative) of a decade is treated AS the
 * decade. The same snap decides f_mitigated <= TMEL.
 *
 * Units: frequencies per year; failure rates per hour; times in hours;
 * probabilities and PFDs dimensionless. Every function returns either a
 * finite result carrying `basis`, or an object carrying `error` and
 * `field` naming the input it refused.
 */

export const DECADE_SNAP = 1e-9;

/**
 * The one statement of the band convention. silFromPfdAvg, lopaScenario and
 * pfdAvgSubsystem all print it, so a reader who meets the band in any of the
 * three meets the same words (HSE H3 follow-up: lopaScenario said it in RRF
 * terms, silFromPfdAvg in PFD terms, and the two read as different rules).
 */
export const BAND_CONVENTION = 'IEC 61508-1 Table 2 / IEC 61511-1 low demand: SIL n holds 10^-(n+1) <= PFDavg < 10^-n, equivalently 10^n < RRF <= 10^(n+1); a value within 1e-9 relative of a decade is that decade, and an exact decade belongs to the higher-PFD (lower-SIL) band';

export const HOURS_PER_YEAR = 8760;

/** Low-demand SIL bands, PFDavg, lower bound inclusive, upper exclusive. */
export const SIL_BANDS_LOW_DEMAND = Object.freeze([
  Object.freeze({ sil: 4, pfdMin: 1e-5, pfdMax: 1e-4, rrfMin: 1e4, rrfMax: 1e5 }),
  Object.freeze({ sil: 3, pfdMin: 1e-4, pfdMax: 1e-3, rrfMin: 1e3, rrfMax: 1e4 }),
  Object.freeze({ sil: 2, pfdMin: 1e-3, pfdMax: 1e-2, rrfMin: 1e2, rrfMax: 1e3 }),
  Object.freeze({ sil: 1, pfdMin: 1e-2, pfdMax: 1e-1, rrfMin: 1e1, rrfMax: 1e2 }),
]);

/** Outcome states of a LOPA scenario. Never a clipped number. */
export const LOPA_OUTCOME = Object.freeze({
  NO_SIF_REQUIRED: 'NO_SIF_REQUIRED',
  BELOW_SIL1: 'RISK_REDUCTION_BELOW_SIL1',
  SIL1: 'SIL1',
  SIL2: 'SIL2',
  SIL3: 'SIL3',
  BEYOND_SIL3: 'BEYOND_SIL3_REDESIGN',
});

/** States of an achieved PFDavg. */
export const PFD_STATE = Object.freeze({
  NOT_SIL_RATED: 'NOT_SIL_RATED',
  SIL: 'SIL',
  BELOW_SIL4_FLOOR: 'BELOW_SIL4_TABLE_FLOOR',
});

export const ARCHITECTURES = Object.freeze(['1oo1', '1oo2', '2oo2', '2oo3', '1oo3']);
const REDUNDANT = new Set(['1oo2', '2oo3', '1oo3']);

const refuse = (field, message) => ({ error: `${field}: ${message}`, field });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * If x is within DECADE_SNAP (relative) of 10^r for an integer r, return
 * r; otherwise null.
 */
export const decadeOf = (x) => {
  if (!isNum(x) || !(x > 0)) return null;
  const r = Math.round(Math.log10(x));
  return Math.abs(x / 10 ** r - 1) <= DECADE_SNAP ? r : null;
};

/**
 * ceil(-log10(p)) with an exact decade snapped first, so that p = 1e-2
 * (or a float within DECADE_SNAP of it) gives 2 and not 3.
 */
const negLog10Ceil = (p) => {
  const r = decadeOf(p);
  if (r !== null) return -r;
  return Math.ceil(-Math.log10(p));
};

/**
 * The low-demand band a PFDavg falls in. `sil` is 1..4 or null.
 * PFDavg >= 0.1 is NOT_SIL_RATED; below 1e-5 the table has no row, and
 * the claim is limited to SIL 4 with the state saying so.
 */
export const silFromPfdAvg = (pfdAvg) => {
  if (!isNum(pfdAvg) || !(pfdAvg > 0) || pfdAvg > 1) {
    return refuse('pfdAvg', 'must be a probability above 0 and no more than 1');
  }
  const n = negLog10Ceil(pfdAvg) - 1; // p in [10^-(n+1), 10^-n) is SIL n
  const basis = BAND_CONVENTION;
  if (n < 1) return { pfdAvg, rrf: 1 / pfdAvg, sil: null, state: PFD_STATE.NOT_SIL_RATED, basis };
  if (n > 4) {
    return {
      pfdAvg, rrf: 1 / pfdAvg, sil: 4, state: PFD_STATE.BELOW_SIL4_FLOOR, basis,
      note: 'PFDavg below 1e-5 is off the table: no claim beyond SIL 4 exists',
    };
  }
  return { pfdAvg, rrf: 1 / pfdAvg, sil: n, state: PFD_STATE.SIL, basis };
};

/**
 * The outcome a required risk reduction factor demands. RRF <= 1 needs
 * nothing; 1 < RRF <= 10 needs risk reduction but less than a SIL 1 SIF
 * provides by definition; above 1e4 is beyond SIL 3, which the process
 * sector treats as a redesign, and it is reported as such with the
 * number intact, never clipped to SIL 3.
 */
export const outcomeFromRequiredRrf = (rrf) => {
  if (!isNum(rrf) || !(rrf > 0)) return refuse('rrf', 'must be a finite number above 0');
  const one = decadeOf(rrf) === 0;
  if (rrf < 1 || one) {
    return { outcome: LOPA_OUTCOME.NO_SIF_REQUIRED, requiredSil: null, requiredSifPfdAvg: null };
  }
  const pfd = 1 / rrf;
  const n = negLog10Ceil(pfd) - 1;
  if (n < 1) return { outcome: LOPA_OUTCOME.BELOW_SIL1, requiredSil: null, requiredSifPfdAvg: pfd };
  if (n > 3) {
    return {
      outcome: LOPA_OUTCOME.BEYOND_SIL3,
      requiredSil: null,
      requiredSifPfdAvg: pfd,
      pfdInSil4Band: n === 4,
      note: n === 4
        ? 'the required PFDavg lies in the SIL 4 band: redesign the process or add non-SIS layers rather than rely on a SIL 4 SIF'
        : 'the required PFDavg is below the SIL 4 band: no SIF can supply it, redesign',
    };
  }
  return { outcome: LOPA_OUTCOME[`SIL${n}`], requiredSil: n, requiredSifPfdAvg: pfd };
};

const probabilityList = (list, field) => {
  if (list === undefined || list === null) return { items: [] };
  if (!Array.isArray(list)) return refuse(field, 'must be a list of { name, probability }');
  const items = [];
  for (let i = 0; i < list.length; i += 1) {
    const it = list[i] || {};
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (!name) return refuse(`${field}[${i}].name`, 'every entry needs a name');
    const p = it.probability;
    if (!isNum(p) || !(p > 0) || p > 1) {
      return refuse(`${field}[${i}].probability`, `'${name}' must be a probability above 0 and no more than 1 (a probability of 0 means the scenario cannot happen, which is not a LOPA scenario)`);
    }
    items.push({ name, probability: p });
  }
  return { items };
};

/**
 * One LOPA scenario.
 *
 *   initiatingEventFrequencyPerYr   IEF, /yr, > 0
 *   enablingConditions              [{ name, probability }] (optional)
 *   conditionalModifiers            [{ name, probability }] (optional):
 *                                   probability of ignition, of presence,
 *                                   of fatal injury ... as the analyst has them
 *   ipls                            [{ name, pfd, independent, auditable? }]:
 *                                   an IPL is credited only when `independent`
 *                                   is exactly true (and `auditable` is not
 *                                   false); every other one is listed in
 *                                   notCredited with the reason. Two IPLs with
 *                                   the same name are refused: one credit per IPL.
 *   tmelPerYr                       tolerable mitigated event likelihood, /yr, > 0
 *   sifPfdAvg                       optional: a proposed / verified SIF's PFDavg,
 *                                   to close the loop against the TMEL
 */
export const lopaScenario = ({
  initiatingEventFrequencyPerYr,
  enablingConditions,
  conditionalModifiers,
  ipls,
  tmelPerYr,
  sifPfdAvg,
} = {}) => {
  const ief = initiatingEventFrequencyPerYr;
  if (!isNum(ief) || !(ief > 0)) return refuse('initiatingEventFrequencyPerYr', 'must be a frequency above 0 per year');
  if (!isNum(tmelPerYr) || !(tmelPerYr > 0)) return refuse('tmelPerYr', 'the tolerable mitigated event likelihood must be a frequency above 0 per year');

  const en = probabilityList(enablingConditions, 'enablingConditions');
  if (en.error) return en;
  const cm = probabilityList(conditionalModifiers, 'conditionalModifiers');
  if (cm.error) return cm;

  if (ipls !== undefined && ipls !== null && !Array.isArray(ipls)) return refuse('ipls', 'must be a list of { name, pfd, independent }');
  const credited = [];
  const notCredited = [];
  const seen = new Set();
  for (let i = 0; i < (ipls || []).length; i += 1) {
    const ipl = ipls[i] || {};
    const name = typeof ipl.name === 'string' ? ipl.name.trim() : '';
    if (!name) return refuse(`ipls[${i}].name`, 'every IPL needs a name');
    const key = name.toLowerCase();
    if (seen.has(key)) return refuse(`ipls[${i}].name`, `'${name}' appears twice: one credit per IPL`);
    seen.add(key);
    if (!isNum(ipl.pfd) || !(ipl.pfd > 0) || ipl.pfd > 1) {
      return refuse(`ipls[${i}].pfd`, `'${name}' must have a PFD above 0 and no more than 1 (a PFD of 0 is a perfect layer, which none is)`);
    }
    if (ipl.independent !== true) {
      notCredited.push({ name, pfd: ipl.pfd, reason: 'not flagged independent (independent must be true to take credit)' });
    } else if (ipl.auditable === false) {
      notCredited.push({ name, pfd: ipl.pfd, reason: 'flagged not auditable' });
    } else {
      credited.push({ name, pfd: ipl.pfd });
    }
  }

  const prod = (xs, k) => xs.reduce((acc, x) => acc * x[k], 1);
  const enablingProduct = prod(en.items, 'probability');
  const modifierProduct = prod(cm.items, 'probability');
  const iplProduct = prod(credited, 'pfd');
  const unmitigatedFrequencyPerYr = ief * enablingProduct * modifierProduct;
  const mitigatedWithoutSif = unmitigatedFrequencyPerYr * iplProduct;
  const requiredRrf = mitigatedWithoutSif / tmelPerYr;
  const decided = outcomeFromRequiredRrf(requiredRrf);

  const out = {
    unmitigatedFrequencyPerYr,
    enablingProduct,
    modifierProduct,
    iplProduct,
    credited,
    notCredited,
    mitigatedFrequencyWithoutSifPerYr: mitigatedWithoutSif,
    tmelPerYr,
    requiredRrf,
    ...decided,
    basis: {
      method: 'CCPS (2001) Layer of Protection Analysis: f = IEF x prod(enabling) x prod(conditional modifiers) x prod(PFD of credited IPLs); RRF = f / TMEL; required PFDavg = TMEL / f; SIL band low demand per IEC 61511-1',
      units: 'frequencies per year; probabilities and PFDs dimensionless',
      creditRule: 'an IPL is credited once, and only when flagged independent === true and not flagged auditable === false',
      bandConvention: BAND_CONVENTION,
      bindingTarget: 'the SIF must achieve requiredSifPfdAvg itself; the SIL band alone does not guarantee it',
    },
  };

  if (sifPfdAvg !== undefined && sifPfdAvg !== null) {
    if (!isNum(sifPfdAvg) || !(sifPfdAvg > 0) || sifPfdAvg > 1) {
      return refuse('sifPfdAvg', 'must be a PFDavg above 0 and no more than 1');
    }
    const withSif = mitigatedWithoutSif * sifPfdAvg;
    const ratio = withSif / tmelPerYr;
    out.sifPfdAvg = sifPfdAvg;
    out.mitigatedFrequencyPerYr = withSif;
    out.meetsTmel = ratio < 1 || decadeOf(ratio) === 0;
    out.sifBand = silFromPfdAvg(sifPfdAvg);
  } else {
    out.mitigatedFrequencyPerYr = mitigatedWithoutSif;
    out.meetsTmel = decided.outcome === LOPA_OUTCOME.NO_SIF_REQUIRED;
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* Verification: IEC 61508-6 Annex B simplified equations              */
/* ------------------------------------------------------------------ */

const validateSubsystem = (p = {}) => {
  const {
    architecture, lambdaDuPerHour, lambdaDdPerHour = 0, proofTestIntervalHours,
    mttrHours, mrtHours = 0, beta, betaD, proofTestCoverage = 1, lifetimeHours,
  } = p;
  if (!ARCHITECTURES.includes(architecture)) {
    return refuse('architecture', `must be one of ${ARCHITECTURES.join(', ')}`);
  }
  if (!isNum(lambdaDuPerHour) || lambdaDuPerHour < 0) return refuse('lambdaDuPerHour', 'must be a failure rate per hour, zero or more');
  if (!isNum(lambdaDdPerHour) || lambdaDdPerHour < 0) return refuse('lambdaDdPerHour', 'must be a failure rate per hour, zero or more');
  if (!(lambdaDuPerHour + lambdaDdPerHour > 0)) return refuse('lambdaDuPerHour', 'lambdaDU and lambdaDD are both zero: there is no dangerous failure to average');
  if (!isNum(proofTestIntervalHours) || !(proofTestIntervalHours > 0)) return refuse('proofTestIntervalHours', 'must be a time above 0 hours');
  if (!isNum(mrtHours) || mrtHours < 0) return refuse('mrtHours', 'must be a time in hours, zero or more');
  let mttr = mttrHours;
  if (mttr === undefined || mttr === null) {
    if (lambdaDdPerHour > 0) return refuse('mttrHours', 'is required when lambdaDD is above zero: detected failures are down for the restoration time');
    mttr = 0;
  }
  if (!isNum(mttr) || mttr < 0) return refuse('mttrHours', 'must be a time in hours, zero or more');
  let b = 0;
  let bD = 0;
  if (REDUNDANT.has(architecture)) {
    if (!isNum(beta) || beta < 0 || beta > 1) {
      return refuse('beta', `is required for a redundant ${architecture} and must lie in [0, 1]: beta = 0 is a claim of no common cause and has to be typed`);
    }
    b = beta;
    if (lambdaDdPerHour > 0) {
      if (!isNum(betaD) || betaD < 0 || betaD > 1) {
        return refuse('betaD', 'is required when lambdaDD is above zero in a redundant architecture and must lie in [0, 1]');
      }
      bD = betaD;
    } else if (betaD !== undefined && betaD !== null) {
      if (!isNum(betaD) || betaD < 0 || betaD > 1) return refuse('betaD', 'must lie in [0, 1]');
      bD = betaD;
    }
  }
  if (!isNum(proofTestCoverage) || !(proofTestCoverage > 0) || proofTestCoverage > 1) {
    return refuse('proofTestCoverage', 'must lie in (0, 1]');
  }
  let t2 = null;
  if (proofTestCoverage < 1) {
    if (!isNum(lifetimeHours) || !(lifetimeHours > 0)) {
      return refuse('lifetimeHours', 'is required when proofTestCoverage is below 1: the uncovered failures stay until the item is restored as new');
    }
    if (lifetimeHours < proofTestIntervalHours) {
      return refuse('lifetimeHours', 'must be at least the proof test interval');
    }
    t2 = lifetimeHours;
  }
  return {
    arch: architecture, lDU: lambdaDuPerHour, lDD: lambdaDdPerHour, t1: proofTestIntervalHours,
    mttr, mrt: mrtHours, b, bD, ptc: proofTestCoverage, t2,
    betaIgnored: !REDUNDANT.has(architecture) && (isNum(beta) || isNum(betaD)),
  };
};

/**
 * DU down time for the j-th failure of a group, (T/(j+1) + MRT) split by
 * proof test coverage: PTC (T1/(j+1) + MRT) + (1 - PTC)(T2/(j+1) + MRT).
 */
const duDown = (v, j) => {
  const covered = v.t1 / (j + 1) + v.mrt;
  if (v.ptc === 1) return covered;
  return v.ptc * covered + (1 - v.ptc) * (v.t2 / (j + 1) + v.mrt);
};

const equivalentDownTime = (v, j) => {
  const lD = v.lDU + v.lDD;
  return (v.lDU / lD) * duDown(v, j) + (v.lDD / lD) * v.mttr;
};

const pfdCore = (v) => {
  const lD = v.lDU + v.lDD;
  const tCE = equivalentDownTime(v, 1);
  const ccfDU = v.b * v.lDU * duDown(v, 1);
  const ccfDD = v.bD * v.lDD * v.mttr;
  const lInd = (1 - v.bD) * v.lDD + (1 - v.b) * v.lDU;
  let independent;
  let tGE = null;
  let tG2E = null;
  switch (v.arch) {
    case '1oo1':
      independent = lD * tCE;
      break;
    case '2oo2':
      independent = 2 * lD * tCE;
      break;
    case '1oo2':
      tGE = equivalentDownTime(v, 2);
      independent = 2 * lInd ** 2 * tCE * tGE;
      break;
    case '2oo3':
      tGE = equivalentDownTime(v, 2);
      independent = 6 * lInd ** 2 * tCE * tGE;
      break;
    case '1oo3':
      tG2E = equivalentDownTime(v, 2);
      tGE = equivalentDownTime(v, 3);
      independent = 6 * lInd ** 3 * tCE * tG2E * tGE;
      break;
    default:
      independent = NaN;
  }
  const redundant = REDUNDANT.has(v.arch);
  const pfdAvg = independent + (redundant ? ccfDU + ccfDD : 0);
  return { pfdAvg, tCE, tGE, tG2E, independent, ccfDU: redundant ? ccfDU : 0, ccfDD: redundant ? ccfDD : 0 };
};

const FORMULAS = Object.freeze({
  '1oo1': 'PFD = lD tCE',
  '2oo2': 'PFD = 2 lD tCE (Annex B carries no beta term for 2oo2)',
  '1oo2': 'PFD = 2((1-bD) lDD + (1-b) lDU)^2 tCE tGE + bD lDD MTTR + b lDU (T1/2 + MRT)',
  '2oo3': 'PFD = 6((1-bD) lDD + (1-b) lDU)^2 tCE tGE + bD lDD MTTR + b lDU (T1/2 + MRT)',
  '1oo3': 'PFD = 6((1-bD) lDD + (1-b) lDU)^3 tCE tG2E tGE + bD lDD MTTR + b lDU (T1/2 + MRT)',
});

/**
 * PFDavg of one subsystem (sensors, logic solver or final elements) in
 * low demand mode, IEC 61508-6:2010 Annex B.3.2.2.
 *
 *   architecture             '1oo1' | '1oo2' | '2oo2' | '2oo3' | '1oo3'
 *   lambdaDuPerHour          dangerous undetected failure rate, /h (per channel)
 *   lambdaDdPerHour          dangerous detected failure rate, /h (default 0)
 *   proofTestIntervalHours   T1, h
 *   mttrHours                MTTR for detected failures, h (required if lDD > 0)
 *   mrtHours                 MRT after a proof test reveals a DU failure, h (default 0)
 *   beta, betaD              common cause fractions for DU and DD; beta is
 *                            REQUIRED for 1oo2 / 2oo3 / 1oo3, betaD when lDD > 0
 *   proofTestCoverage        PTC (default 1)
 *   lifetimeHours            T2, required when PTC < 1
 */
export const pfdAvgSubsystem = (params = {}) => {
  const v = validateSubsystem(params);
  if (v.error) return v;
  const c = pfdCore(v);
  if (!isNum(c.pfdAvg) || c.pfdAvg >= 1) {
    return refuse('proofTestIntervalHours', `the simplified equations give ${Number(c.pfdAvg.toPrecision(6))} here, which is not a probability: lambda x T is far outside the rare-event range they assume; use an exact (Markov) model`);
  }
  const lambdaT = v.lDU * (v.ptc === 1 ? v.t1 : v.t2);
  const warnings = [];
  if (lambdaT > 0.1) {
    warnings.push(`lambdaDU x T = ${Number(lambdaT.toPrecision(4))} exceeds 0.1: the linearised (rare-event) equations overstate PFDavg noticeably here`);
  }
  if (v.betaIgnored) warnings.push(`beta does not apply to ${v.arch} and was ignored`);
  const band = silFromPfdAvg(c.pfdAvg);
  return {
    architecture: v.arch,
    pfdAvg: c.pfdAvg,
    rrf: 1 / c.pfdAvg,
    sil: band.sil,
    state: band.state,
    terms: { independent: c.independent, ccfDU: c.ccfDU, ccfDD: c.ccfDD },
    dominant: c.ccfDU + c.ccfDD > c.independent ? 'common cause' : 'independent',
    tCE: c.tCE,
    tGE: c.tGE,
    tG2E: c.tG2E,
    warnings,
    basis: {
      method: 'IEC 61508-6:2010 Annex B.3.2.2 reliability block diagram simplified equations, low demand; reduces to the ISA-TR84.00.02 simplified forms when lambdaDD = 0 and MRT = 0',
      formula: FORMULAS[v.arch],
      tCE: 'lDU/lD (T1/2 + MRT) + lDD/lD MTTR',
      proofTestCoverage: v.ptc === 1 ? 'perfect proof test (PTC = 1)' : 'imperfect proof test: lDU down time PTC (T1/(j+1) + MRT) + (1 - PTC)(T2/(j+1) + MRT)',
      units: 'failure rates per hour, times in hours',
      inputs: {
        lambdaDuPerHour: v.lDU, lambdaDdPerHour: v.lDD, proofTestIntervalHours: v.t1,
        mttrHours: v.mttr, mrtHours: v.mrt, beta: v.b, betaD: v.bD,
        proofTestCoverage: v.ptc, lifetimeHours: v.t2,
      },
      bandConvention: BAND_CONVENTION,
    },
  };
};

/**
 * A SIF's PFDavg as the sum of its subsystems' (sensor + logic solver +
 * final element), the series approximation Annex B uses.
 */
export const pfdAvgSif = (subsystems) => {
  if (!Array.isArray(subsystems) || subsystems.length === 0) return refuse('subsystems', 'must be a non-empty list of subsystem parameter sets');
  const parts = [];
  for (let i = 0; i < subsystems.length; i += 1) {
    const r = pfdAvgSubsystem(subsystems[i]);
    if (r.error) return { ...r, error: `subsystems[${i}].${r.error}`, field: `subsystems[${i}].${r.field}` };
    parts.push({ name: subsystems[i].name ?? `subsystem ${i + 1}`, pfdAvg: r.pfdAvg, architecture: r.architecture });
  }
  const pfdAvg = parts.reduce((a, p) => a + p.pfdAvg, 0);
  if (!(pfdAvg < 1)) return refuse('subsystems', 'the summed PFDavg reaches 1: not a probability');
  const band = silFromPfdAvg(pfdAvg);
  return {
    pfdAvg, rrf: 1 / pfdAvg, sil: band.sil, state: band.state, parts,
    basis: { method: 'series sum of subsystem PFDavg (IEC 61508-6 Annex B.3.2.1: PFD_SYS = PFD_S + PFD_L + PFD_FE)' },
  };
};

/** PFDavg at each proof test interval in `intervalsHours`, all else fixed. */
export const proofTestSensitivity = (params = {}, intervalsHours = []) => {
  if (!Array.isArray(intervalsHours) || intervalsHours.length === 0) return refuse('intervalsHours', 'must be a non-empty list of proof test intervals in hours');
  const rows = [];
  for (let i = 0; i < intervalsHours.length; i += 1) {
    const r = pfdAvgSubsystem({ ...params, proofTestIntervalHours: intervalsHours[i] });
    if (r.error) return { ...r, error: `intervalsHours[${i}]: ${r.error}` };
    rows.push({ proofTestIntervalHours: intervalsHours[i], pfdAvg: r.pfdAvg, rrf: r.rrf, sil: r.sil, state: r.state });
  }
  return { rows, basis: { method: 'pfdAvgSubsystem evaluated at each interval; every other input held' } };
};

/**
 * The longest proof test interval T1 at which the subsystem still meets
 * `targetPfdAvg`. PFDavg rises monotonically with T1 (every T1
 * coefficient is non-negative), so the answer is found by bisection to
 * 1e-12 relative. Explicit states when there is no finite answer:
 *   UNACHIEVABLE          the T1-independent floor (DD, MTTR, MRT, and the
 *                         uncovered part under PTC) already reaches the target
 *   INTERVAL_INDEPENDENT  lambdaDU is zero: T1 does not enter
 * and a refusal (error + field), the one pfdAvgSubsystem gives, when the
 * floor itself reaches a PFDavg of 1.
 * With PTC < 1 the interval is capped by the lifetime T2 (state CAPPED_AT_LIFETIME).
 */
export const maxProofTestInterval = (params = {}, targetPfdAvg) => {
  if (!isNum(targetPfdAvg) || !(targetPfdAvg > 0) || !(targetPfdAvg < 1)) return refuse('targetPfdAvg', 'must lie in (0, 1)');
  const probe = validateSubsystem({ ...params, proofTestIntervalHours: Math.min(1, params.lifetimeHours ?? 1) });
  if (probe.error) return probe;
  const at = (t1) => pfdCore({ ...probe, t1 }).pfdAvg;
  const basis = { method: 'bisection on T1 of the Annex B PFDavg, which is non-decreasing in T1', target: targetPfdAvg };
  // The T1-independent floor (DD with MTTR, MRT, the uncovered part under
  // PTC). pfdAvgSubsystem refuses a PFDavg of 1 or more because the
  // simplified equations have left their rare-event range; the search used
  // to skip that refusal and report such a floor as UNACHIEVABLE (or, with
  // lambdaDU = 0, as an INTERVAL_INDEPENDENT PFDavg above 1). It refuses the
  // same way now. A refusal path only: every finite answer is unchanged.
  const floor = at(0);
  if (!isNum(floor) || floor >= 1) {
    const field = probe.lDD > 0 ? 'lambdaDdPerHour' : (probe.ptc < 1 ? 'lifetimeHours' : 'mrtHours');
    return refuse(field, `the simplified equations give a floor of ${Number(floor.toPrecision(6))} here, before any proof test interval is added. A PFDavg of 1 or more lies outside the rare-event range they assume; use an exact (Markov) model`);
  }
  if (probe.lDU === 0) return { state: 'INTERVAL_INDEPENDENT', proofTestIntervalHours: null, pfdAvg: at(1), basis };
  if (floor >= targetPfdAvg) return { state: 'UNACHIEVABLE', proofTestIntervalHours: null, floorPfdAvg: floor, basis };
  const cap = probe.t2 ?? Infinity;
  if (Number.isFinite(cap) && at(cap) <= targetPfdAvg) {
    return { state: 'CAPPED_AT_LIFETIME', proofTestIntervalHours: cap, pfdAvg: at(cap), basis };
  }
  let lo = 0;
  let hi = Number.isFinite(cap) ? cap : 1;
  while (at(hi) <= targetPfdAvg) hi *= 2;
  for (let k = 0; k < 400 && (hi - lo) > 1e-12 * hi; k += 1) {
    const mid = (lo + hi) / 2;
    if (at(mid) <= targetPfdAvg) lo = mid; else hi = mid;
  }
  return { state: 'FOUND', proofTestIntervalHours: lo, proofTestIntervalYears: lo / HOURS_PER_YEAR, pfdAvg: at(lo), basis };
};
