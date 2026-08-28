/**
 * Well intervention diagnostics and candidate screening
 * (Production Operations P12).
 *
 * THE IDEA THE WHOLE MODULE TURNS ON: the diagnosis decides the
 * treatment, and the two most common water problems need OPPOSITE
 * treatments.
 *
 * Water CHANNELLING -- behind pipe, through a thief zone, along a
 * fracture -- is a plumbing problem, and plumbing is fixable. A
 * shutoff squeeze or a gel has somewhere to go and something to seal.
 *
 * Water CONING is not a plumbing problem. The water is coming through
 * the same rock as the oil, pulled up by the drawdown, and there is
 * nothing to squeeze. Shut off the bottom perforations and the cone
 * simply re-forms above them; the treatment buys weeks and costs
 * whatever it costs. The answer to coning is less drawdown, or a
 * different completion, or living with it.
 *
 * So a planner that recommends a shutoff squeeze without looking at the
 * diagnostic is recommending money down a hole roughly half the time.
 * Every screening rule in here is therefore GATED BY THE DIAGNOSIS, and
 * a candidate the diagnostic argues against is returned as a refusal
 * with the reason rather than quietly scored lower.
 *
 * WHAT IS AND IS NOT REPRODUCED HERE. Chan (SPE 30775) distinguishes
 * these mechanisms by the shape of the water-oil ratio and its
 * derivative on a log-log plot. The SHAPES are the published content
 * and they are not transcribed from memory. What this module does is
 * read the same two things Chan reads -- the trend of WOR and the SIGN
 * AND SLOPE of its derivative -- and say which of the three pictures
 * the data is closest to, with every threshold an explicit named input
 * rather than a constant buried in a branch. The published type curves
 * are ARMED as a literature gate. This is a screening that says which
 * question to ask next, not a substitute for the plots.
 *
 * THE DERIVATIVE IS NOT COMPUTED HERE. It is passed in, because the
 * Suite already carries a validated Bourdet derivative built for
 * exactly this problem -- a noisy log-time series that a naive
 * difference turns into confetti -- and a second implementation of it
 * would be a second thing to be wrong.
 */

// ---------------------------------------------------------------------------
// Log-log slope
// ---------------------------------------------------------------------------

/**
 * Least-squares slope of ln y against ln x over a window.
 *
 * The whole Chan reading is a statement about slopes on a log-log
 * plot, so this is the measurement underneath all of it, and it is
 * exact on a power law: y = a x^m returns m and an r-squared of 1 to
 * machine precision, which is the gate.
 *
 * r-squared is returned and USED rather than decoration. A slope
 * measured through a scatter that has no trend at all is not a slope,
 * and the classifier refuses to read one below a stated fit quality
 * instead of reporting whatever the regression happened to produce.
 *
 * returns { ok, slope, intercept, r2, n, error }
 */
export const logLogSlope = ({ points, xKey = 'x', yKey = 'y', fromX, toX }) => {
  const pts = (points || [])
    .map((p) => ({ x: Number(p[xKey]), y: Number(p[yKey]) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0 && p.y > 0)
    .filter((p) => (fromX == null || p.x >= fromX) && (toX == null || p.x <= toX));
  const n = pts.length;
  if (n < 3) {
    return { ok: false, n, error: 'A slope needs at least three points that are both positive; a log-log plot has nothing to say about zero or negative values.' };
  }
  const lx = pts.map((p) => Math.log(p.x));
  const ly = pts.map((p) => Math.log(p.y));
  const mx = lx.reduce((a, v) => a + v, 0) / n;
  const my = ly.reduce((a, v) => a + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = lx[i] - mx;
    const dy = ly[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0)) {
    return { ok: false, n, error: 'Every point is at the same time, so there is no slope to measure.' };
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
  return { ok: true, slope, intercept, r2, n, spanDecades: (Math.max(...lx) - Math.min(...lx)) / Math.LN10 };
};

// ---------------------------------------------------------------------------
// The Chan reading
// ---------------------------------------------------------------------------

/**
 * The thresholds the reading turns on, all named and all overridable.
 *
 * They are round because they are boundaries between pictures, not
 * measurements. Quoting them to three decimals would suggest a
 * precision that the underlying diagnostic does not have.
 */
export const CHAN_DEFAULTS = {
  /**
   * At or below this derivative slope the derivative is FALLING, which
   * is the coning signature: the ratio has stopped climbing because the
   * cone has reached the perforations and stopped growing.
   *
   * This is the sharp end of the reading. A falling derivative is
   * qualitatively different from a rising one and the sign carries the
   * distinction, so the threshold barely matters.
   */
  coningSlope: -0.1,
  /**
   * At or above this the derivative is climbing DISTINCTLY FASTER than
   * proportionally, which is the channelling signature.
   *
   * This is the soft end of the reading, and it is worth being blunt
   * about why. For ANY power-law history the ratio and its derivative
   * have the SAME log-log slope, because d(a t^m)/d(ln t) = m a t^m.
   * So the two cannot be separated by comparing their slopes to each
   * other; the only thing that separates ordinary displacement from
   * channelling is HOW STEEP the climb is, and steady arrival sits
   * around a slope of one. A boundary a little above one is the honest
   * place to put it, and anything close to the boundary is reported as
   * close to it rather than resolved.
   */
  channellingSlope: 1.3,
  /**
   * Within this much of the channelling boundary, the reading says so
   * instead of picking a side.
   */
  ambiguousBand: 0.25,
  /** Below this fit quality the slope is not read at all. */
  minR2: 0.5,
  /** A reading needs at least this much log-time to sit on. */
  minSpanDecades: 0.4,
  /** Below this water-oil ratio there is no water problem to diagnose. */
  minWor: 0.1,
};

export const CHAN_MECHANISMS = [
  {
    id: 'channelling',
    label: 'Channelling',
    treatable: true,
    note: 'Water is arriving through a path of its own -- behind pipe, a thief zone, a fracture or a high-permeability streak. That is plumbing, and plumbing can be sealed.',
  },
  {
    id: 'coning',
    label: 'Coning',
    treatable: false,
    note: 'Water is being pulled up through the same rock as the oil by the drawdown. There is nothing to squeeze: shut off the bottom perforations and the cone re-forms above them. The answers are less drawdown, a different completion, or living with it.',
  },
  {
    id: 'displacement',
    label: 'Normal displacement',
    treatable: false,
    note: 'The water is simply arriving, as it does in a swept reservoir. This is not a well problem and no intervention on this well will change it.',
  },
  {
    id: 'indeterminate',
    label: 'Not determined',
    treatable: false,
    note: 'The history does not settle the question. That is an answer: it says do not spend money on a treatment chosen by guesswork.',
  },
];

export const mechanism = (id) => CHAN_MECHANISMS.find((m) => m.id === id) || null;

/**
 * Read a water-oil (or gas-oil) ratio history the way Chan reads one.
 *
 * `series` is [{ t, ratio, derivative }] where t is producing time,
 * ratio is WOR or GOR, and derivative is d(ratio)/d(ln t) -- the
 * Bourdet derivative of the ratio against log time, computed by the
 * caller with its own validated implementation.
 *
 * The reading is made on the LATE part of the history, because that is
 * where the mechanisms separate; early data is dominated by cleanup and
 * by whatever the well was doing before it settled. How much of the
 * history counts as late is an input.
 *
 * returns { ok, mechanism, confidence, worSlope, derivativeSlope,
 *   worR2, derivativeR2, points, notes, error }
 */
export const chanDiagnosis = ({ series, lateFraction = 0.5, settings = {} }) => {
  const s = { ...CHAN_DEFAULTS, ...settings };
  const clean = (series || [])
    .map((p) => ({
      t: Number(p.t),
      ratio: Number(p.ratio),
      derivative: Number(p.derivative),
    }))
    .filter((p) => Number.isFinite(p.t) && p.t > 0 && Number.isFinite(p.ratio))
    .sort((a, b) => a.t - b.t);

  if (clean.length < 6) {
    return {
      ok: false,
      mechanism: mechanism('indeterminate'),
      error: 'A Chan reading needs a history, not a handful of points. Six producing samples is the bare minimum and a useful reading wants far more.',
    };
  }

  const last = clean[clean.length - 1];
  if (!(last.ratio >= s.minWor)) {
    return {
      ok: true,
      mechanism: mechanism('displacement'),
      confidence: 'n/a',
      notes: [`The ratio is still only ${last.ratio.toFixed(3)}. There is no water problem here to diagnose, and nothing to treat.`],
      points: clean,
    };
  }

  const cut = clean[Math.floor(clean.length * (1 - Math.min(Math.max(lateFraction, 0.1), 1)))];
  const lateFrom = cut ? cut.t : clean[0].t;
  const worFit = logLogSlope({ points: clean, xKey: 't', yKey: 'ratio', fromX: lateFrom });
  const derFit = logLogSlope({
    points: clean.filter((p) => Number.isFinite(p.derivative) && p.derivative > 0),
    xKey: 't',
    yKey: 'derivative',
    fromX: lateFrom,
  });

  const notes = [];
  // A rising derivative means the water is accelerating away from the
  // oil: more of it arrives for every log cycle that passes. That is
  // the channelling picture. A falling one means the ratio is levelling
  // off, which is what a cone that has reached the perforations does.
  // A STRICTLY negative derivative and a derivative of zero are
  // different findings and must not be lumped together. Negative means
  // the ratio has turned back down, which is the coning signature.
  // Zero means the ratio is not moving at all, which is not a mechanism
  // -- it is the absence of one, and there is nothing here to treat.
  const late = clean.filter((p) => p.t >= lateFrom);
  const negativeDerivatives = late.filter(
    (p) => Number.isFinite(p.derivative) && p.derivative < 0,
  ).length;
  const flatDerivatives = late.filter(
    (p) => Number.isFinite(p.derivative) && Math.abs(p.derivative) < 1e-12,
  ).length;

  if (!derFit.ok && flatDerivatives === late.length && negativeDerivatives === 0) {
    return {
      ok: true,
      mechanism: mechanism('displacement'),
      confidence: 'n/a',
      worSlope: worFit.ok ? worFit.slope : null,
      worR2: worFit.ok ? worFit.r2 : null,
      derivativeSlope: null,
      derivativeR2: null,
      notes: [`The ratio is sitting flat at ${last.ratio.toFixed(2)} and its derivative is zero throughout. Nothing is changing, so there is no mechanism to diagnose and nothing on this well for an intervention to fix. That is a finding, not a failure to reach one.`],
      points: clean,
      lateFromT: lateFrom,
    };
  }

  if (!derFit.ok) {
    notes.push(negativeDerivatives > 0
      ? `The derivative turns negative over ${negativeDerivatives} of the late samples, so its slope cannot be read on a log-log plot. A ratio that has turned back down is itself the coning signature, but confirm it against the plot rather than on this alone.`
      : derFit.error);
    return {
      ok: true,
      mechanism: mechanism(negativeDerivatives > 0 ? 'coning' : 'indeterminate'),
      confidence: 'low',
      worSlope: worFit.ok ? worFit.slope : null,
      worR2: worFit.ok ? worFit.r2 : null,
      derivativeSlope: null,
      derivativeR2: null,
      notes,
      points: clean,
      lateFromT: lateFrom,
    };
  }

  if (derFit.spanDecades < s.minSpanDecades) {
    notes.push(`The late history spans only ${derFit.spanDecades.toFixed(2)} of a log cycle. Chan's separation between the mechanisms happens over log time, so a window this short cannot show it.`);
    return {
      ok: true,
      mechanism: mechanism('indeterminate'),
      confidence: 'low',
      worSlope: worFit.ok ? worFit.slope : null,
      worR2: worFit.ok ? worFit.r2 : null,
      derivativeSlope: derFit.slope,
      derivativeR2: derFit.r2,
      notes,
      points: clean,
      lateFromT: lateFrom,
    };
  }

  if (derFit.r2 < s.minR2) {
    notes.push(`The derivative scatters too much to carry a slope: the fit explains only ${(derFit.r2 * 100).toFixed(0)} percent of it. Reading a mechanism off this would be reading noise.`);
    return {
      ok: true,
      mechanism: mechanism('indeterminate'),
      confidence: 'low',
      worSlope: worFit.ok ? worFit.slope : null,
      worR2: worFit.ok ? worFit.r2 : null,
      derivativeSlope: derFit.slope,
      derivativeR2: derFit.r2,
      notes,
      points: clean,
      lateFromT: lateFrom,
    };
  }

  let id;
  let ambiguous = false;
  if (derFit.slope <= s.coningSlope) {
    id = 'coning';
    notes.push(`The derivative is falling, at a slope of ${derFit.slope.toFixed(2)}. The ratio has stopped climbing, which is what a cone does once it has reached the perforations and stopped growing. A falling derivative is qualitatively different from a rising one, so this is the firm end of the reading.`);
  } else if (derFit.slope >= s.channellingSlope) {
    id = 'channelling';
    notes.push(`The derivative is climbing at a slope of ${derFit.slope.toFixed(2)}, which is distinctly steeper than the roughly proportional climb of ordinary displacement. Water is accelerating away from the oil, which is water finding a path of its own.`);
  } else {
    id = 'displacement';
    notes.push(`The derivative is climbing at a slope of ${derFit.slope.toFixed(2)}, which is about proportional. Water is arriving steadily rather than accelerating, which is the ordinary displacement picture.`);
  }

  // Say when the answer is close to the line rather than presenting a
  // coin-flip as a finding.
  if (id !== 'coning' && Math.abs(derFit.slope - s.channellingSlope) <= s.ambiguousBand) {
    ambiguous = true;
    notes.push(`This sits within ${s.ambiguousBand} of the boundary between displacement and channelling, and that boundary is the weak part of the reading: for any power-law history the ratio and its derivative have the SAME log-log slope, so nothing separates the two pictures except how steep the climb is. Take this one to the plot, or to a production log, before spending on it.`);
  }

  const confidence = ambiguous ? 'low'
    : derFit.r2 > 0.85 && derFit.spanDecades > 0.8 ? 'high'
      : derFit.r2 > 0.7 ? 'moderate' : 'low';

  return {
    ok: true,
    mechanism: mechanism(id),
    confidence,
    worSlope: worFit.ok ? worFit.slope : null,
    worR2: worFit.ok ? worFit.r2 : null,
    derivativeSlope: derFit.slope,
    derivativeR2: derFit.r2,
    spanDecades: derFit.spanDecades,
    lateFromT: lateFrom,
    ambiguous,
    notes,
    points: clean,
  };
};

// ---------------------------------------------------------------------------
// Skin and what removing it is worth
// ---------------------------------------------------------------------------

/**
 * The pseudo-steady-state denominator: ln(re/rw) - 3/4 + S.
 *
 * Everything about stimulation value comes out of this one group,
 * because the productivity index is inversely proportional to it. That
 * is also why a stimulation is worth so much less on a well that was
 * never damaged: taking S from 1 to 0 on a well whose ln(re/rw) is 8
 * changes the denominator by an eighth.
 */
export const pssDenominator = ({ reFt, rwFt, skin }) => {
  if (!(reFt > 0) || !(rwFt > 0) || !(reFt > rwFt)) return NaN;
  return Math.log(reFt / rwFt) - 0.75 + Number(skin);
};

/**
 * The most negative skin that is physically meaningful for a geometry.
 *
 * At S = -(ln(re/rw) - 3/4) the denominator is zero and the
 * productivity index is INFINITE. That is not an aggressive design, it
 * is a broken equation, and a screening tool that quietly returned a
 * huge uplift there would be worse than useless. Real treatments reach
 * about -3 to -5 for an acid job and -5 to -6 for a decent fracture;
 * anything approaching this bound is the arithmetic running out rather
 * than the well getting better.
 */
export const minimumSkin = ({ reFt, rwFt }) => {
  if (!(reFt > rwFt) || !(rwFt > 0)) return NaN;
  return -(Math.log(reFt / rwFt) - 0.75);
};

/**
 * What removing skin multiplies the productivity index by.
 *
 * A ratio of the two denominators and nothing more. No correlation, no
 * type curve, no rule of thumb: it falls straight out of radial Darcy
 * flow, and it is exactly 1 when the skin does not change, which is the
 * first gate on it.
 *
 * returns { ok, multiplier, before, after, error }
 */
export const skinPiMultiplier = ({ reFt, rwFt, skinBefore, skinAfter }) => {
  const floor = minimumSkin({ reFt, rwFt });
  if (!Number.isFinite(floor)) {
    return { ok: false, error: 'The drainage and wellbore radii are needed, and the drainage radius has to be the larger one.' };
  }
  const before = pssDenominator({ reFt, rwFt, skin: skinBefore });
  const after = pssDenominator({ reFt, rwFt, skin: skinAfter });
  if (!(before > 0)) {
    return { ok: false, error: `A skin of ${Number(skinBefore).toFixed(1)} is below the ${floor.toFixed(1)} this geometry allows, where the productivity index goes infinite. That is the equation running out, not a well.` };
  }
  if (!(after > 0)) {
    return { ok: false, error: `Taking the skin to ${Number(skinAfter).toFixed(1)} would put it below the ${floor.toFixed(1)} this geometry allows, where the productivity index goes infinite. Real treatments reach about -3 to -5 on acid and -5 to -6 on a fracture; ask for less.` };
  }
  return {
    ok: true,
    multiplier: before / after,
    before,
    after,
    minimumSkin: floor,
    // Flow efficiency in the usual sense: what the well makes against
    // what an undamaged one would.
    flowEfficiencyBefore: pssDenominator({ reFt, rwFt, skin: 0 }) / before,
    flowEfficiencyAfter: pssDenominator({ reFt, rwFt, skin: 0 }) / after,
  };
};

/** The skin implied by a measured productivity ratio. The inverse. */
export const skinFromPiRatio = ({ reFt, rwFt, ratio, skinReference = 0 }) => {
  const ref = pssDenominator({ reFt, rwFt, skin: skinReference });
  if (!Number.isFinite(ref) || !(ratio > 0)) return NaN;
  return ref / ratio - Math.log(reFt / rwFt) + 0.75;
};

// ---------------------------------------------------------------------------
// Candidate screening, gated by the diagnosis
// ---------------------------------------------------------------------------

export const TREATMENTS = [
  { id: 'matrixAcid', label: 'Matrix acid stimulation', addressesSkin: true },
  { id: 'hydraulicFracture', label: 'Hydraulic fracture', addressesSkin: true },
  { id: 'waterShutoff', label: 'Water shutoff squeeze', addressesWater: true },
  { id: 'gasShutoff', label: 'Gas shutoff squeeze', addressesGas: true },
  { id: 'recompletion', label: 'Recompletion or reperforation', addressesSkin: true },
  { id: 'rateReduction', label: 'Reduce drawdown', addressesWater: true },
  { id: 'artificialLift', label: 'Add or upgrade artificial lift', addressesLift: true },
];

export const treatment = (id) => TREATMENTS.find((t) => t.id === id) || null;

/**
 * Screen the treatments against a well, with the diagnosis in charge.
 *
 * `well`: { skin, reFt, rwFt, wctPct, gorScfStb, expectedGorScfStb,
 *   flowing, watercutTrend }
 * `diagnosis`: the chanDiagnosis output, or null when there is no
 *   history to read.
 *
 * Every verdict carries its REASONS in full. A score with the reasoning
 * folded into it is a number nobody can argue with, and the arguing is
 * the point: an intervention is somebody's money.
 *
 * returns [{ id, label, verdict, reasons, blocked, blockReason }]
 */
export const screenTreatments = ({ well, diagnosis }) => {
  const skin = Number(well?.skin);
  const wct = Number(well?.wctPct);
  const mech = diagnosis?.mechanism?.id || null;
  const out = [];

  const push = (id, verdict, reasons, block) => {
    const t = treatment(id);
    out.push({
      id,
      label: t.label,
      verdict,
      reasons,
      blocked: !!block,
      blockReason: block || null,
    });
  };

  // --- stimulation ---
  const stimReasons = [];
  if (Number.isFinite(skin)) {
    if (skin > 5) stimReasons.push(`A skin of ${skin.toFixed(1)} is heavy damage. Most of what this well could make is being lost in the last few feet.`);
    else if (skin > 2) stimReasons.push(`A skin of ${skin.toFixed(1)} is real damage and worth removing.`);
    else if (skin > 0) stimReasons.push(`A skin of ${skin.toFixed(1)} is mild. There is something to gain but not much of it.`);
    else stimReasons.push(`A skin of ${skin.toFixed(1)} means the well is already stimulated. Acid will not improve on a negative skin and a fracture is a different decision from a damage-removal one.`);
  } else {
    stimReasons.push('No skin has been entered, so there is nothing to say about damage. A pressure transient test is what gives you one.');
  }
  const stimVerdict = !Number.isFinite(skin) ? 'unknown'
    : skin > 2 ? 'candidate' : skin > 0 ? 'marginal' : 'no';
  push('matrixAcid', stimVerdict, stimReasons);

  const fracReasons = [...stimReasons];
  fracReasons.push('A fracture is not a damage treatment: it adds conductive area, so it pays on tight rock whether or not there is damage, and it is the wrong tool on a well whose problem is a skin of a few units in good permeability.');
  if (Number.isFinite(wct) && wct > 60) {
    fracReasons.push(`At ${wct.toFixed(0)} percent water, a fracture that grows out of zone will make the water worse, not the oil better.`);
  }
  push('hydraulicFracture', Number.isFinite(skin) && skin > 0 ? 'consider' : 'consider', fracReasons);

  // --- water shutoff: THE DIAGNOSIS DECIDES ---
  const waterReasons = [];
  let waterBlock = null;
  if (!Number.isFinite(wct) || wct < 30) {
    waterReasons.push(`At ${Number.isFinite(wct) ? `${wct.toFixed(0)} percent` : 'an unknown'} water cut there is no water problem worth an intervention.`);
    push('waterShutoff', 'no', waterReasons);
  } else if (!diagnosis || !diagnosis.ok || mech === 'indeterminate') {
    waterBlock = 'The mechanism has not been established. A shutoff squeeze on a coning well is money down a hole, and this history does not say which it is. Get more production history, or a production log, before spending anything.';
    waterReasons.push(`The water cut is ${wct.toFixed(0)} percent, which is worth acting on, but not until it is known what is bringing the water.`);
    push('waterShutoff', 'blocked', waterReasons, waterBlock);
  } else if (mech === 'coning') {
    waterBlock = 'The diagnostic says coning. There is nothing to squeeze: the water is coming through the same rock as the oil, and a cone shut off at the bottom perforations re-forms above them. This is one of the two most expensive mistakes in intervention planning.';
    waterReasons.push(`Water cut is ${wct.toFixed(0)} percent and the derivative is falling, which is the coning signature.`);
    waterReasons.push('What does work: less drawdown, a different completion interval, or accepting the water and sizing the lift and the facilities for it.');
    push('waterShutoff', 'blocked', waterReasons, waterBlock);
  } else if (mech === 'displacement') {
    waterBlock = 'The diagnostic says ordinary displacement. The water is arriving because the reservoir is swept, which is not a well problem and no treatment on this well will change it.';
    waterReasons.push(`Water cut is ${wct.toFixed(0)} percent and the derivative is flat.`);
    push('waterShutoff', 'blocked', waterReasons, waterBlock);
  } else {
    waterReasons.push(`Water cut is ${wct.toFixed(0)} percent and the derivative is climbing, which says the water has a path of its own.`);
    waterReasons.push('That is plumbing, and a squeeze or a gel has somewhere to go and something to seal. This is the case where a shutoff earns its money.');
    if (diagnosis.confidence === 'low') {
      waterReasons.push('The reading is low confidence, so confirm it with a production log before committing to a squeeze.');
    }
    push('waterShutoff', 'candidate', waterReasons);
  }

  // --- gas shutoff ---
  const gor = Number(well?.gorScfStb);
  const expected = Number(well?.expectedGorScfStb);
  const gasReasons = [];
  if (!Number.isFinite(gor) || !Number.isFinite(expected)) {
    gasReasons.push('A gas problem is a gas-oil ratio well above what the fluid should be producing. Both numbers are needed to say whether there is one.');
    push('gasShutoff', 'unknown', gasReasons);
  } else if (gor < expected * 2) {
    gasReasons.push(`The gas-oil ratio is ${Math.round(gor)} against an expected ${Math.round(expected)}. That is the solution gas the oil carries, not a gas problem.`);
    push('gasShutoff', 'no', gasReasons);
  } else {
    gasReasons.push(`The gas-oil ratio is ${Math.round(gor)} against an expected ${Math.round(expected)}, so most of the gas is not coming out of the oil.`);
    gasReasons.push('Gas coning and gas channelling separate the same way water does, and the same rule applies: only the channelling case is worth squeezing. Run the diagnostic on the gas-oil ratio before deciding.');
    push('gasShutoff', 'consider', gasReasons);
  }

  // --- recompletion ---
  const recompReasons = [];
  if (mech === 'channelling') {
    recompReasons.push('A channelling diagnosis is often a completion problem: a poor cement bond or perforations into the wrong interval. Recompleting addresses the cause rather than sealing the symptom.');
  }
  if (Number.isFinite(skin) && skin > 8) {
    recompReasons.push(`A skin of ${skin.toFixed(1)} is often beyond what acid recovers. Reperforating may be cheaper than treating it.`);
  }
  if (!recompReasons.length) {
    recompReasons.push('Nothing in the data points at the completion specifically. Worth considering alongside anything else that needs a rig.');
  }
  push('recompletion', mech === 'channelling' || (Number.isFinite(skin) && skin > 8) ? 'candidate' : 'consider', recompReasons);

  // --- less drawdown ---
  const rateReasons = [];
  if (mech === 'coning') {
    rateReasons.push('The one thing that genuinely works on a cone. The cone height goes with the drawdown, so producing slower produces less water, and it costs nothing but the rate.');
    rateReasons.push('It is unpopular for exactly that reason, and it is still the right answer when the alternative is a squeeze that does not hold.');
  } else {
    rateReasons.push('Only worth it for coning, and the diagnostic does not say coning. Choking a channelling well back gives away rate without touching the water path.');
  }
  push('rateReduction', mech === 'coning' ? 'candidate' : 'no', rateReasons);

  // --- lift ---
  const liftReasons = [];
  if (well?.flowing === false) {
    liftReasons.push('The well is not flowing. Whatever else is done, it needs lift to produce at all, and that decision belongs in the Artificial Lift Advisor rather than here.');
    push('artificialLift', 'candidate', liftReasons);
  } else if (Number.isFinite(wct) && wct > 70) {
    liftReasons.push(`At ${wct.toFixed(0)} percent water the column is heavy, and a well that flows today may not flow much longer. Size the lift before it stops rather than after.`);
    push('artificialLift', 'consider', liftReasons);
  } else {
    liftReasons.push('The well flows and the column is not especially heavy. Lift is not the pressing question.');
    push('artificialLift', 'no', liftReasons);
  }

  return out;
};

/** Rank the screening the way a planner reads it: what to do first. */
export const VERDICT_ORDER = ['candidate', 'consider', 'marginal', 'blocked', 'unknown', 'no'];

export const rankTreatments = (rows) => [...rows].sort(
  (a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict),
);
