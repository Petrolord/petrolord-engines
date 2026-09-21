
/** Own-property preset lookup. `TABLE[key]` walks the prototype chain, so
 *  'constructor', 'toString', 'valueOf', 'hasOwnProperty' and '__proto__'
 *  are "found" in every object literal and walk through a falsy guard. */
const ownPreset = (table, key) => (typeof key === 'string' || typeof key === 'number') && Object.prototype.hasOwnProperty.call(table, key);

/**
 * Occupational hygiene exposure arithmetic (HSE H2): noise, chemical
 * and heat.
 *
 * Pure functions. Every input carries its unit in its name (levelDbA,
 * durationH, durationMin, metabolicRateW, wbgtC). Every function returns
 * either a finite result or an object carrying `error` and `field`, the
 * name of the input that was refused, so a caller's `if (r.error)` guard
 * sees every refusal. Every result names the criterion it was computed
 * against and the source of that criterion.
 *
 * SOURCES, and what each one fixes. FINDINGS-exposure.md in
 * tools/validation/hse/ carries the verbatim passages and every
 * judgement call.
 *
 *   noise dose, TWA   29 CFR 1910.95 Appendix A (mandatory): D = 100 x
 *                     sum(C/T), TWA = 16.61 log10(D/100) + 90, and the
 *                     reference duration of Table G-16a,
 *                     T = 8 / 2^((L - 90)/5) hours.
 *   OSHA PEL setup    OSHA Technical Manual Sec. III Ch. 5: PEL measured
 *                     with a 90 dBA threshold ("any noise below 90 dBA is
 *                     not integrated").
 *   OSHA action level 1910.95(c)(1)-(2): TWA 85 dB "or, equivalently, a
 *                     dose of fifty percent", computed per Appendix A and
 *                     Table G-16a, so the criterion stays 90 dB and the
 *                     LIMIT is 50 percent; 1910.95(d)(2)(i): all levels
 *                     from 80 dB integrated.
 *   NIOSH REL         NIOSH 98-126 section 1.1: T = 480 / 2^((L-85)/3)
 *                     minutes, TWA = 10.0 log(D/100) + 85, ceiling 115 dBA.
 *   hearing protector 1910.95 Appendix B (NRR - 7 for A-weighted, NRR for
 *                     C-weighted); OSHA Technical Manual Appendix E (the
 *                     50 percent field derating used for the engineering
 *                     controls decision, and dual protection); NIOSH
 *                     98-126 Appendix (type derating 75/50/30 percent).
 *   LEX,8h            Directive 2003/10/EC via the UK Control of Noise at
 *                     Work Regulations 2005, Schedule 1 (HSE L108), which
 *                     cites ISO 1999:1990 clause 3.6; HSE exposure points
 *                     (L108 Appendix 3).
 *   chemical          29 CFR 1910.1000(d)(1) and (d)(2); Brief and Scala
 *                     (1975) reduction factor.
 *   heat              NIOSH 2016-106: WBGT indoor and outdoor (section
 *                     9.3.2), RAL = 59.9 - 14.1 log10 M and REL =
 *                     56.7 - 11.5 log10 M (section 8.1), 1-hour TWAs.
 *
 * No licensed limit table (ACGIH TLVs) is embedded. Exposure limits are
 * INPUTS.
 */

const SOURCES = Object.freeze({
  OSHA_APPENDIX_A: '29 CFR 1910.95 Appendix A',
  OSHA_APPENDIX_B: '29 CFR 1910.95 Appendix B',
  OSHA_OTM_NOISE: 'OSHA Technical Manual Section III Chapter 5',
  NIOSH_NOISE: 'NIOSH 98-126 Criteria for a Recommended Standard: Occupational Noise Exposure (1998), section 1.1 and Appendix',
  EU_NOISE: 'Directive 2003/10/EC; UK Control of Noise at Work Regulations 2005 Schedule 1 (HSE L108), ISO 1999:1990 clause 3.6',
  HSE_POINTS: 'HSE L108 Appendix 3, noise exposure points',
  OSHA_1000_D1: '29 CFR 1910.1000(d)(1)',
  OSHA_1000_D2: '29 CFR 1910.1000(d)(2)',
  BRIEF_SCALA: 'Brief and Scala (1975), Am Ind Hyg Assoc J 36:467',
  NIOSH_HEAT: 'NIOSH 2016-106 Criteria for a Recommended Standard: Occupational Exposure to Heat and Hot Environments',
});

export const EXPOSURE_SOURCES = SOURCES;

const refuse = (field, message) => ({ error: message, field });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* ------------------------------------------------------------------ */
/* Noise criteria                                                      */
/* ------------------------------------------------------------------ */

/**
 * Criterion presets. `twaCoefficientDb` is the constant the source
 * PRINTS: 16.61 for OSHA (1910.95 App. A) and 10.0 for NIOSH (98-126
 * section 1.1.3). Both are roundings of exchangeRate / log10(2)
 * (16.6096 and 9.9658). Using the printed constant is what reproduces
 * each source's own dose-to-TWA table: NIOSH Table 1-2 disagrees with
 * 9.9658 in 50 of its 84 rows and with 10.0 in one, a typo.
 * A custom criterion without a stated coefficient gets the exact
 * exchangeRate / log10(2), under which a constant level held for
 * 8 hours has a TWA equal to that level.
 */
export const NOISE_CRITERIA = Object.freeze({
  OSHA_PEL: Object.freeze({
    id: 'OSHA_PEL',
    label: 'OSHA permissible exposure limit',
    criterionLevelDbA: 90,
    exchangeRateDb: 5,
    thresholdDbA: 90,
    twaCoefficientDb: 16.61,
    limitDosePct: 100,
    source: `${SOURCES.OSHA_APPENDIX_A}; threshold per ${SOURCES.OSHA_OTM_NOISE}`,
  }),
  OSHA_ACTION_LEVEL: Object.freeze({
    id: 'OSHA_ACTION_LEVEL',
    label: 'OSHA hearing conservation action level',
    criterionLevelDbA: 90,
    exchangeRateDb: 5,
    thresholdDbA: 80,
    twaCoefficientDb: 16.61,
    limitDosePct: 50,
    source: `29 CFR 1910.95(c)(1)-(2) and (d)(2)(i); ${SOURCES.OSHA_APPENDIX_A}`,
  }),
  NIOSH_REL: Object.freeze({
    id: 'NIOSH_REL',
    label: 'NIOSH recommended exposure limit',
    criterionLevelDbA: 85,
    exchangeRateDb: 3,
    thresholdDbA: 80,
    twaCoefficientDb: 10.0,
    limitDosePct: 100,
    ceilingDbA: 115,
    source: SOURCES.NIOSH_NOISE,
  }),
});

/** The highest level Table G-16a tabulates. */
export const OSHA_TABLE_G16A_MAX_DBA = 130;
/** Table G-16's shortest permitted exposure is at 115 dBA. */
export const OSHA_TABLE_G16_MAX_DBA = 115;

/**
 * Resolve a preset name or a criterion object. Returns the criterion or
 * an error naming the bad field.
 */
export const resolveNoiseCriterion = (criterion = 'OSHA_PEL') => {
  if (typeof criterion === 'string') {
    const preset = ownPreset(NOISE_CRITERIA, criterion) ? NOISE_CRITERIA[criterion] : undefined;
    if (!preset) {
      return refuse('criterion', `criterion '${criterion}' is unknown: use one of ${Object.keys(NOISE_CRITERIA).join(', ')} or pass the parameters`);
    }
    return preset;
  }
  if (!criterion || typeof criterion !== 'object') {
    return refuse('criterion', 'criterion must be a preset name or an object with criterionLevelDbA, exchangeRateDb and thresholdDbA');
  }
  const { criterionLevelDbA, exchangeRateDb } = criterion;
  if (!isNum(criterionLevelDbA)) return refuse('criterionLevelDbA', 'criterionLevelDbA must be a finite number of dBA');
  if (!isNum(exchangeRateDb) || !(exchangeRateDb > 0)) {
    return refuse('exchangeRateDb', 'exchangeRateDb must be a finite number of dB above zero');
  }
  const thresholdDbA = criterion.thresholdDbA ?? -Infinity;
  if (typeof thresholdDbA !== 'number' || Number.isNaN(thresholdDbA) || thresholdDbA === Infinity) {
    return refuse('thresholdDbA', 'thresholdDbA must be a number of dBA, or omitted for no threshold');
  }
  const exact = exchangeRateDb / Math.log10(2);
  const twaCoefficientDb = criterion.twaCoefficientDb ?? exact;
  if (!isNum(twaCoefficientDb) || !(twaCoefficientDb > 0)) {
    return refuse('twaCoefficientDb', 'twaCoefficientDb must be a finite number above zero');
  }
  const limitDosePct = criterion.limitDosePct ?? 100;
  if (!isNum(limitDosePct) || !(limitDosePct > 0)) {
    return refuse('limitDosePct', 'limitDosePct must be a finite percentage above zero');
  }
  return {
    id: criterion.id ?? 'CUSTOM',
    label: criterion.label ?? 'custom criterion',
    criterionLevelDbA,
    exchangeRateDb,
    thresholdDbA,
    twaCoefficientDb,
    limitDosePct,
    ...(isNum(criterion.ceilingDbA) ? { ceilingDbA: criterion.ceilingDbA } : {}),
    source: criterion.source ?? 'caller supplied',
  };
};

const withCriterion = (criterion, fn) => {
  const c = resolveNoiseCriterion(criterion);
  if (c.error) return c;
  return fn(c);
};

/**
 * Reference duration T, hours: the time at level L that gives a dose of
 * 100 percent. T = 8 / 2^((L - Lc)/q). A level below the threshold is
 * not integrated: `belowThreshold` is true and `referenceDurationH` is
 * null (it contributes nothing).
 */
export const noiseReferenceDurationH = (levelDbA, criterion = 'OSHA_PEL') => withCriterion(criterion, (c) => {
  if (!isNum(levelDbA)) return refuse('levelDbA', 'levelDbA must be a finite number');
  if (levelDbA < c.thresholdDbA) {
    return { referenceDurationH: null, belowThreshold: true, criterion: c };
  }
  return {
    referenceDurationH: 8 / 2 ** ((levelDbA - c.criterionLevelDbA) / c.exchangeRateDb),
    belowThreshold: false,
    criterion: c,
  };
});

/** Inverse of the reference duration: the level at which T hours gives 100 percent. */
export const noiseLevelForReferenceDurationDbA = (referenceDurationH, criterion = 'OSHA_PEL') => withCriterion(criterion, (c) => {
  if (!isNum(referenceDurationH) || !(referenceDurationH > 0)) {
    return refuse('referenceDurationH', 'referenceDurationH must be a finite number of hours above zero');
  }
  return {
    levelDbA: c.criterionLevelDbA + c.exchangeRateDb * Math.log2(8 / referenceDurationH),
    criterion: c,
  };
});

/** TWA = K log10(D/100) + Lc, with K the criterion's printed coefficient. */
export const noiseTwaFromDoseDbA = (dosePct, criterion = 'OSHA_PEL') => withCriterion(criterion, (c) => {
  if (!isNum(dosePct) || !(dosePct > 0)) {
    return refuse('dosePct', 'dosePct must be a finite percentage above zero: a zero dose has no TWA');
  }
  return { twaDbA: c.twaCoefficientDb * Math.log10(dosePct / 100) + c.criterionLevelDbA, criterion: c };
});

/** The inverse: D = 100 x 10^((TWA - Lc)/K). */
export const noiseDoseFromTwaPct = (twaDbA, criterion = 'OSHA_PEL') => withCriterion(criterion, (c) => {
  if (!isNum(twaDbA)) return refuse('twaDbA', 'twaDbA must be a finite number');
  return { dosePct: 100 * 10 ** ((twaDbA - c.criterionLevelDbA) / c.twaCoefficientDb), criterion: c };
});

const checkPeriods = (periods, fields) => {
  if (!Array.isArray(periods) || periods.length === 0) {
    return refuse('periods', 'periods must be a non-empty array');
  }
  for (let i = 0; i < periods.length; i += 1) {
    const p = periods[i];
    if (!p || typeof p !== 'object') return refuse(`periods[${i}]`, `periods[${i}] must be an object`);
    for (let k = 0; k < fields.length; k += 1) {
      const [name, rule] = fields[k];
      const v = p[name];
      if (!isNum(v)) return refuse(`periods[${i}].${name}`, `periods[${i}].${name} must be a finite number`);
      if (rule === 'nonneg' && v < 0) return refuse(`periods[${i}].${name}`, `periods[${i}].${name} cannot be negative`);
    }
  }
  return null;
};

/**
 * Daily noise dose from periods [{ levelDbA, durationH }].
 * D = 100 x sum(C_i / T_i) over the periods at or above the threshold.
 * Returns the dose, the TWA (null when the dose is zero), each period's
 * contribution, the criterion and whether the criterion's limit dose is
 * exceeded.
 */
export const noiseDose = (periods, criterion = 'OSHA_PEL') => withCriterion(criterion, (c) => {
  const bad = checkPeriods(periods, [['levelDbA', 'finite'], ['durationH', 'nonneg']]);
  if (bad) return bad;
  const totalDurationH = periods.reduce((s, p) => s + p.durationH, 0);
  if (totalDurationH > 24) {
    return refuse('periods', `the periods total ${totalDurationH} h: a daily dose covers at most 24 hours`);
  }
  const warnings = [];
  let fraction = 0;
  const contributions = periods.map((p) => {
    if (p.levelDbA < c.thresholdDbA) {
      return { levelDbA: p.levelDbA, durationH: p.durationH, referenceDurationH: null, dosePct: 0, integrated: false };
    }
    const t = 8 / 2 ** ((p.levelDbA - c.criterionLevelDbA) / c.exchangeRateDb);
    fraction += p.durationH / t;
    return { levelDbA: p.levelDbA, durationH: p.durationH, referenceDurationH: t, dosePct: (100 * p.durationH) / t, integrated: true };
  });
  const dosePct = 100 * fraction;
  const loudest = Math.max(...periods.filter((p) => p.durationH > 0).map((p) => p.levelDbA));
  if (loudest > OSHA_TABLE_G16A_MAX_DBA) {
    warnings.push(`a level of ${loudest} dBA is above 130 dBA, the top of Table G-16a: the formula is extrapolated there`);
  }
  if (isNum(c.ceilingDbA) && loudest > c.ceilingDbA) {
    warnings.push(`a level of ${loudest} dBA exceeds the ${c.ceilingDbA} dBA ceiling of this criterion, whatever the dose`);
  } else if ((c.id === 'OSHA_PEL' || c.id === 'OSHA_ACTION_LEVEL') && loudest > OSHA_TABLE_G16_MAX_DBA) {
    warnings.push(`a level of ${loudest} dBA is above 115 dBA, the highest level Table G-16 permits`);
  }
  return {
    dosePct,
    twaDbA: dosePct > 0 ? c.twaCoefficientDb * Math.log10(dosePct / 100) + c.criterionLevelDbA : null,
    totalDurationH,
    contributions,
    limitDosePct: c.limitDosePct,
    exceedsLimit: dosePct > c.limitDosePct,
    criterion: c,
    warnings,
  };
});

/**
 * OSHA action level for an extended shift, dBA (OSHA Technical Manual
 * Sec. III Ch. 5, Standard Interpretation 1982):
 * AL = 16.61 log10(50 / (12.5 x hours)) + 90. The PEL is not reduced.
 */
export const oshaActionLevelForShiftDbA = (shiftHours) => {
  if (!isNum(shiftHours) || !(shiftHours > 0) || shiftHours > 24) {
    return refuse('shiftHours', 'shiftHours must be a number of hours above zero and at most 24');
  }
  return {
    actionLevelDbA: 16.61 * Math.log10(50 / (12.5 * shiftHours)) + 90,
    shiftHours,
    criterion: NOISE_CRITERIA.OSHA_ACTION_LEVEL,
    source: `${SOURCES.OSHA_OTM_NOISE}, extended workshifts`,
  };
};

/* ------------------------------------------------------------------ */
/* Hearing protectors                                                  */
/* ------------------------------------------------------------------ */

/** NIOSH 98-126 Appendix: the fraction of the labelled NRR credited, by type. */
export const NIOSH_NRR_DERATING = Object.freeze({
  earmuff: 0.75,
  formableEarplug: 0.5,
  otherEarplug: 0.3,
});

export const HEARING_PROTECTOR_METHODS = Object.freeze({
  OSHA_APPENDIX_B: 'OSHA_APPENDIX_B',
  OSHA_FIELD_50: 'OSHA_FIELD_50',
  OSHA_DUAL: 'OSHA_DUAL',
  NIOSH_TYPE: 'NIOSH_TYPE',
});

/**
 * Estimated A-weighted exposure under a hearing protector.
 *
 * { exposureDb, weighting: 'A' | 'C', nrrDb, method, protectorType }
 *
 *   OSHA_APPENDIX_B  A: exposure - (NRR - 7); C: exposure - NRR.
 *                    The adequacy test of 1910.95 Appendix B.
 *   OSHA_FIELD_50    A only: exposure - (NRR - 7) x 50%. OSHA Technical
 *                    Manual Appendix E, "used when considering whether
 *                    engineering controls are to be implemented".
 *   OSHA_DUAL        exposure - ((NRRh - 7) + 5) for A, - (NRRh + 5) for
 *                    C, with nrrDb the HIGHER of the two protectors' NRRs
 *                    (OSHA Technical Manual Appendix E).
 *   NIOSH_TYPE       NRR' = factor x NRR by protectorType (earmuff 0.75,
 *                    formableEarplug 0.5, otherEarplug 0.3), then A:
 *                    exposure - (NRR' - 7), C: exposure - NRR'.
 *
 * An attenuation below zero (an NRR under 7 on A-weighted data) would
 * RAISE the estimate; a protector does not add noise, so the credit is
 * floored at zero and a warning says so.
 */
export const hearingProtectorEstimate = ({
  exposureDb, weighting = 'A', nrrDb, method = 'OSHA_APPENDIX_B', protectorType,
} = {}) => {
  if (!isNum(exposureDb)) return refuse('exposureDb', 'exposureDb must be a finite number');
  if (weighting !== 'A' && weighting !== 'C') return refuse('weighting', "weighting must be 'A' or 'C'");
  if (!isNum(nrrDb) || nrrDb < 0) return refuse('nrrDb', 'nrrDb must be a finite number of dB, zero or more');
  if (!ownPreset(HEARING_PROTECTOR_METHODS, method)) {
    return refuse('method', `method must be one of ${Object.keys(HEARING_PROTECTOR_METHODS).join(', ')}`);
  }
  let rawAttenuationDb;
  let source;
  let creditedNrrDb = nrrDb;
  if (method === 'OSHA_APPENDIX_B') {
    rawAttenuationDb = weighting === 'A' ? nrrDb - 7 : nrrDb;
    source = SOURCES.OSHA_APPENDIX_B;
  } else if (method === 'OSHA_FIELD_50') {
    if (weighting !== 'A') {
      return refuse('weighting', 'the OSHA 50 percent field derating is published for A-weighted exposures only');
    }
    rawAttenuationDb = (nrrDb - 7) * 0.5;
    source = `${SOURCES.OSHA_OTM_NOISE}, Appendix E`;
  } else if (method === 'OSHA_DUAL') {
    rawAttenuationDb = (weighting === 'A' ? nrrDb - 7 : nrrDb) + 5;
    source = `${SOURCES.OSHA_OTM_NOISE}, Appendix E (dual protection)`;
  } else {
    const factor = ownPreset(NIOSH_NRR_DERATING, protectorType) ? NIOSH_NRR_DERATING[protectorType] : undefined;
    if (factor === undefined) {
      return refuse('protectorType', `protectorType must be one of ${Object.keys(NIOSH_NRR_DERATING).join(', ')} for the NIOSH method`);
    }
    creditedNrrDb = factor * nrrDb;
    rawAttenuationDb = weighting === 'A' ? creditedNrrDb - 7 : creditedNrrDb;
    source = `${SOURCES.NIOSH_NOISE}, Appendix`;
  }
  const warnings = [];
  const attenuationDb = Math.max(0, rawAttenuationDb);
  if (rawAttenuationDb < 0) {
    warnings.push(`the method gives ${rawAttenuationDb} dB of attenuation; a protector cannot raise the exposure, so the credit is zero`);
  }
  return {
    protectedDbA: exposureDb - attenuationDb,
    attenuationDb,
    creditedNrrDb,
    method,
    weighting,
    source,
    warnings,
  };
};

/* ------------------------------------------------------------------ */
/* LEX,8h (EU / UK / ISO 1999)                                         */
/* ------------------------------------------------------------------ */

/** Directive 2003/10/EC Article 3, as transposed in the UK 2005 Regulations. */
export const EU_NOISE_VALUES = Object.freeze({
  lowerActionLexDbA: 80,
  upperActionLexDbA: 85,
  limitLexDbA: 87,
  source: SOURCES.EU_NOISE,
});

/**
 * LEX,8h = 10 log10( sum( t_i / 8 x 10^(L_i/10) ) ) from periods
 * [{ laeqDbA, durationH }]. Also reports each task's own contribution in
 * dB (null for a zero-length task) and the HSE exposure points.
 * All periods count: there is no threshold in this metric.
 */
export const lexEightHourDbA = (periods) => {
  const bad = checkPeriods(periods, [['laeqDbA', 'finite'], ['durationH', 'nonneg']]);
  if (bad) return bad;
  const totalDurationH = periods.reduce((s, p) => s + p.durationH, 0);
  if (totalDurationH > 24) {
    return refuse('periods', `the periods total ${totalDurationH} h: a daily exposure covers at most 24 hours`);
  }
  if (!(totalDurationH > 0)) return refuse('periods', 'the periods total zero hours: there is no exposure to express');
  const energy = periods.map((p) => (p.durationH / 8) * 10 ** (p.laeqDbA / 10));
  const sum = energy.reduce((s, e) => s + e, 0);
  const lexDbA = 10 * Math.log10(sum);
  return {
    lexDbA,
    totalDurationH,
    contributions: periods.map((p, i) => ({
      laeqDbA: p.laeqDbA,
      durationH: p.durationH,
      lexDbA: energy[i] > 0 ? 10 * Math.log10(energy[i]) : null,
      exposurePoints: 100 * (p.durationH / 8) * 10 ** ((p.laeqDbA - 85) / 10),
    })),
    exposurePoints: 100 * 10 ** ((lexDbA - 85) / 10),
    exceedsLowerAction: lexDbA >= EU_NOISE_VALUES.lowerActionLexDbA,
    exceedsUpperAction: lexDbA >= EU_NOISE_VALUES.upperActionLexDbA,
    criterion: EU_NOISE_VALUES,
  };
};

/** Weekly LEX: 10 log10( (1/5) sum 10^(0.1 LEX,8h,i) ), up to 7 days. */
export const lexWeeklyDbA = (dailyLexDbA) => {
  if (!Array.isArray(dailyLexDbA) || dailyLexDbA.length === 0) {
    return refuse('dailyLexDbA', 'dailyLexDbA must be a non-empty array of daily exposures');
  }
  if (dailyLexDbA.length > 7) return refuse('dailyLexDbA', 'dailyLexDbA holds more than 7 days: a week has 7');
  for (let i = 0; i < dailyLexDbA.length; i += 1) {
    if (!isNum(dailyLexDbA[i])) return refuse(`dailyLexDbA[${i}]`, `dailyLexDbA[${i}] must be a finite number`);
  }
  const sum = dailyLexDbA.reduce((s, l) => s + 10 ** (0.1 * l), 0);
  return { lexWeeklyDbA: 10 * Math.log10(sum / 5), days: dailyLexDbA.length, criterion: EU_NOISE_VALUES };
};

/** HSE exposure points: EP = 100 x (t/8) x 10^((L - 85)/10). */
export const hseExposurePoints = ({ laeqDbA, durationH } = {}) => {
  if (!isNum(laeqDbA)) return refuse('laeqDbA', 'laeqDbA must be a finite number');
  if (!isNum(durationH) || durationH < 0) return refuse('durationH', 'durationH must be a finite number of hours, zero or more');
  return { exposurePoints: 100 * (durationH / 8) * 10 ** ((laeqDbA - 85) / 10), source: SOURCES.HSE_POINTS };
};

/** LEX from points: 85 + 10 log10(EP/100). */
export const lexFromExposurePointsDbA = (exposurePoints) => {
  if (!isNum(exposurePoints) || !(exposurePoints > 0)) {
    return refuse('exposurePoints', 'exposurePoints must be a finite number above zero');
  }
  return { lexDbA: 85 + 10 * Math.log10(exposurePoints / 100), source: SOURCES.HSE_POINTS };
};

/** Time at laeqDbA that alone reaches targetLexDbA: 8 x 10^((target - L)/10) hours. */
export const lexAllowedDurationH = ({ laeqDbA, targetLexDbA } = {}) => {
  if (!isNum(laeqDbA)) return refuse('laeqDbA', 'laeqDbA must be a finite number');
  if (!isNum(targetLexDbA)) return refuse('targetLexDbA', 'targetLexDbA must be a finite number');
  return { durationH: 8 * 10 ** ((targetLexDbA - laeqDbA) / 10), source: SOURCES.EU_NOISE };
};

/* ------------------------------------------------------------------ */
/* Chemical                                                            */
/* ------------------------------------------------------------------ */

/**
 * 8-hour TWA, 1910.1000(d)(1): E = sum(C_i T_i) / 8, in the caller's
 * concentration unit. The divisor is 8 whatever the periods total, as the
 * regulation writes it: unsampled time counts as zero and a longer shift
 * is summed whole. Both cases are flagged.
 */
export const chemicalTwa8h = (periods) => {
  const bad = checkPeriods(periods, [['concentration', 'nonneg'], ['durationH', 'nonneg']]);
  if (bad) return bad;
  const totalDurationH = periods.reduce((s, p) => s + p.durationH, 0);
  if (totalDurationH > 24) {
    return refuse('periods', `the periods total ${totalDurationH} h: a shift covers at most 24 hours`);
  }
  const warnings = [];
  if (totalDurationH < 8) {
    warnings.push(`the periods cover ${totalDurationH} h of 8: the remainder counts as zero exposure`);
  } else if (totalDurationH > 8) {
    warnings.push(`the periods cover ${totalDurationH} h: the whole shift is divided by 8 as the regulation writes it, consider an unusual shift adjustment of the limit`);
  }
  return {
    twa8h: periods.reduce((s, p) => s + p.concentration * p.durationH, 0) / 8,
    totalDurationH,
    warnings,
    source: SOURCES.OSHA_1000_D1,
  };
};

/**
 * STEL as a 15-minute TWA: sum(C_i t_i) / 15 with t in minutes. The
 * periods may total at most 15 minutes; a shorter record counts the
 * remainder as zero and says so.
 */
export const chemicalStel15Min = (periods) => {
  const bad = checkPeriods(periods, [['concentration', 'nonneg'], ['durationMin', 'nonneg']]);
  if (bad) return bad;
  const totalDurationMin = periods.reduce((s, p) => s + p.durationMin, 0);
  if (totalDurationMin > 15) {
    return refuse('periods', `the periods total ${totalDurationMin} min: a short-term exposure is a 15-minute window`);
  }
  const warnings = [];
  if (totalDurationMin < 15) {
    warnings.push(`the periods cover ${totalDurationMin} min of 15: the remainder counts as zero exposure`);
  }
  return {
    stel15Min: periods.reduce((s, p) => s + p.concentration * p.durationMin, 0) / 15,
    totalDurationMin,
    warnings,
    source: '15-minute time-weighted average, 29 CFR 1910.1000 Table Z-1 STEL convention',
  };
};

/**
 * Mixture exposure index, 1910.1000(d)(2)(i): Em = sum(C_i / L_i), with
 * each C and L in the same unit. Em above 1 exceeds.
 */
export const mixtureExposureIndex = (components) => {
  if (!Array.isArray(components) || components.length === 0) {
    return refuse('components', 'components must be a non-empty array');
  }
  for (let i = 0; i < components.length; i += 1) {
    const c = components[i];
    if (!c || !isNum(c.concentration) || c.concentration < 0) {
      return refuse(`components[${i}].concentration`, `components[${i}].concentration must be a finite number, zero or more`);
    }
    if (!isNum(c.limit) || !(c.limit > 0)) {
      return refuse(`components[${i}].limit`, `components[${i}].limit must be a finite number above zero`);
    }
  }
  const terms = components.map((c) => c.concentration / c.limit);
  const index = terms.reduce((s, t) => s + t, 0);
  return { index, terms, exceeds: index > 1, source: SOURCES.OSHA_1000_D2 };
};

/**
 * Brief and Scala daily reduction factor: RF = (8/h) x (24 - h)/16.
 * The factor only lowers a limit: `rf` is capped at 1 for shifts of
 * 8 hours or less, and `rawRf` keeps the formula's own value.
 */
export const briefScalaDailyRf = (shiftHours) => {
  if (!isNum(shiftHours) || !(shiftHours > 0) || shiftHours > 24) {
    return refuse('shiftHours', 'shiftHours must be a number of hours above zero and at most 24');
  }
  const rawRf = (8 / shiftHours) * ((24 - shiftHours) / 16);
  return { rf: Math.min(1, rawRf), rawRf, basis: 'daily', source: SOURCES.BRIEF_SCALA };
};

/** Brief and Scala weekly reduction factor: RF = (40/h) x (168 - h)/128. */
export const briefScalaWeeklyRf = (weeklyHours) => {
  if (!isNum(weeklyHours) || !(weeklyHours > 0) || weeklyHours > 168) {
    return refuse('weeklyHours', 'weeklyHours must be a number of hours above zero and at most 168');
  }
  const rawRf = (40 / weeklyHours) * ((168 - weeklyHours) / 128);
  return { rf: Math.min(1, rawRf), rawRf, basis: 'weekly', source: SOURCES.BRIEF_SCALA };
};

/**
 * Adjusted limit = limit x RF, using the SMALLER of the daily and weekly
 * factors when both schedules are given (the more protective).
 */
export const briefScalaAdjustedLimit = ({ limit, shiftHours, weeklyHours } = {}) => {
  if (!isNum(limit) || !(limit > 0)) return refuse('limit', 'limit must be a finite number above zero');
  if (shiftHours === undefined && weeklyHours === undefined) {
    return refuse('shiftHours', 'give shiftHours, weeklyHours or both');
  }
  const factors = [];
  if (shiftHours !== undefined) {
    const d = briefScalaDailyRf(shiftHours);
    if (d.error) return d;
    factors.push(d);
  }
  if (weeklyHours !== undefined) {
    const w = briefScalaWeeklyRf(weeklyHours);
    if (w.error) return w;
    factors.push(w);
  }
  const governing = factors.reduce((a, b) => (b.rf < a.rf ? b : a));
  return {
    adjustedLimit: limit * governing.rf,
    rf: governing.rf,
    governingBasis: governing.basis,
    factors,
    source: SOURCES.BRIEF_SCALA,
  };
};

/* ------------------------------------------------------------------ */
/* Heat                                                                */
/* ------------------------------------------------------------------ */

const checkTemps = (pairs) => {
  for (let i = 0; i < pairs.length; i += 1) {
    const [name, v] = pairs[i];
    if (!isNum(v)) return refuse(name, `${name} must be a finite temperature in degrees C`);
    if (v < -273.15) return refuse(name, `${name} is below absolute zero`);
  }
  return null;
};

/** WBGT outdoors with solar load: 0.7 Tnwb + 0.2 Tg + 0.1 Ta (degrees C). */
export const wbgtOutdoorC = ({ naturalWetBulbC, globeC, dryBulbC } = {}) => {
  const bad = checkTemps([['naturalWetBulbC', naturalWetBulbC], ['globeC', globeC], ['dryBulbC', dryBulbC]]);
  if (bad) return bad;
  return { wbgtC: 0.7 * naturalWetBulbC + 0.2 * globeC + 0.1 * dryBulbC, form: 'outdoor', source: `${SOURCES.NIOSH_HEAT}, section 9.3.2; ISO 7243` };
};

/** WBGT indoors or without solar load: 0.7 Tnwb + 0.3 Tg (degrees C). */
export const wbgtIndoorC = ({ naturalWetBulbC, globeC } = {}) => {
  const bad = checkTemps([['naturalWetBulbC', naturalWetBulbC], ['globeC', globeC]]);
  if (bad) return bad;
  return { wbgtC: 0.7 * naturalWetBulbC + 0.3 * globeC, form: 'indoor', source: `${SOURCES.NIOSH_HEAT}, section 9.3.2; ISO 7243` };
};

const twa = (periods, key) => {
  const bad = checkPeriods(periods, [[key, 'finite'], ['durationMin', 'nonneg']]);
  if (bad) return bad;
  const totalDurationMin = periods.reduce((s, p) => s + p.durationMin, 0);
  if (!(totalDurationMin > 0)) return refuse('periods', 'the periods total zero minutes: there is nothing to average');
  return { value: periods.reduce((s, p) => s + p[key] * p.durationMin, 0) / totalDurationMin, totalDurationMin };
};

/** Time-weighted WBGT over work and rest periods [{ wbgtC, durationMin }]. */
export const wbgtTwaC = (periods) => {
  const r = twa(periods, 'wbgtC');
  if (r.error) return r;
  return { wbgtTwaC: r.value, totalDurationMin: r.totalDurationMin, source: SOURCES.NIOSH_HEAT };
};

/** Time-weighted metabolic rate over [{ metabolicRateW, durationMin }]. */
export const metabolicRateTwaW = (periods) => {
  const r = twa(periods, 'metabolicRateW');
  if (r.error) return r;
  for (let i = 0; i < periods.length; i += 1) {
    if (!(periods[i].metabolicRateW > 0)) {
      return refuse(`periods[${i}].metabolicRateW`, `periods[${i}].metabolicRateW must be above zero watts`);
    }
  }
  return { metabolicRateTwaW: r.value, totalDurationMin: r.totalDurationMin, source: SOURCES.NIOSH_HEAT };
};

/** The metabolic range NIOSH 2016-106 Figures 8-1 and 8-2 span, W. */
export const NIOSH_HEAT_FIGURE_RANGE_W = Object.freeze([116, 580]);

const heatLimit = (metabolicRateW, a, b, name) => {
  if (!isNum(metabolicRateW) || !(metabolicRateW > 0)) {
    return refuse('metabolicRateW', 'metabolicRateW must be a finite number of watts above zero');
  }
  const warnings = [];
  const [lo, hi] = NIOSH_HEAT_FIGURE_RANGE_W;
  if (metabolicRateW < lo || metabolicRateW > hi) {
    warnings.push(`${metabolicRateW} W lies outside the ${lo} to ${hi} W range the NIOSH figures plot: the equation is extrapolated`);
  }
  return {
    limitWbgtC: a - b * Math.log10(metabolicRateW),
    criterion: name,
    source: `${SOURCES.NIOSH_HEAT}, section 8.1`,
    warnings,
  };
};

/** NIOSH RAL (unacclimatized), degrees C WBGT: 59.9 - 14.1 log10 M[W]. */
export const nioshRecommendedAlertLimitC = (metabolicRateW) => heatLimit(metabolicRateW, 59.9, 14.1, 'NIOSH_RAL');

/** NIOSH REL (acclimatized), degrees C WBGT: 56.7 - 11.5 log10 M[W]. */
export const nioshRecommendedExposureLimitC = (metabolicRateW) => heatLimit(metabolicRateW, 56.7, 11.5, 'NIOSH_REL');

/**
 * One-hour assessment against the NIOSH RAL or REL. Both the WBGT and
 * the metabolic periods are 1-hour TWAs (NIOSH 2016-106 section 1.1.1
 * and 1.1.3), so each set of periods must total 60 minutes.
 */
export const nioshHeatAssessment = ({ wbgtPeriods, metabolicPeriods, acclimatized } = {}) => {
  if (typeof acclimatized !== 'boolean') {
    return refuse('acclimatized', 'acclimatized must be true (REL) or false (RAL)');
  }
  const w = wbgtTwaC(wbgtPeriods);
  // The field AND the message are renamed together, so a caller that prints the
  // message names the same input the `field` names.
  if (w.error) return { ...w, field: w.field.replace(/^periods/, 'wbgtPeriods'), error: w.error.replace(/^periods/, 'wbgtPeriods') };
  const m = metabolicRateTwaW(metabolicPeriods);
  if (m.error) return { ...m, field: m.field.replace(/^periods/, 'metabolicPeriods'), error: m.error.replace(/^periods/, 'metabolicPeriods') };
  if (Math.abs(w.totalDurationMin - 60) > 1e-9) {
    return refuse('wbgtPeriods', `wbgtPeriods total ${w.totalDurationMin} min: the NIOSH limits apply to a 1-hour TWA`);
  }
  if (Math.abs(m.totalDurationMin - 60) > 1e-9) {
    return refuse('metabolicPeriods', `metabolicPeriods total ${m.totalDurationMin} min: the NIOSH limits apply to a 1-hour TWA`);
  }
  const lim = acclimatized
    ? nioshRecommendedExposureLimitC(m.metabolicRateTwaW)
    : nioshRecommendedAlertLimitC(m.metabolicRateTwaW);
  return {
    wbgtTwaC: w.wbgtTwaC,
    metabolicRateTwaW: m.metabolicRateTwaW,
    limitWbgtC: lim.limitWbgtC,
    marginC: lim.limitWbgtC - w.wbgtTwaC,
    exceeds: w.wbgtTwaC > lim.limitWbgtC,
    criterion: lim.criterion,
    source: lim.source,
    warnings: lim.warnings,
  };
};
