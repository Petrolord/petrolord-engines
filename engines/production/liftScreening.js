/**
 * Artificial lift screening: the rules matrix (Production, extracted
 * from the Suite's Artificial Lift Advisor P9 layer).
 *
 * WHAT THIS IS. Operating guidance, not physics. Every deduction below
 * is a rule of thumb an experienced production engineer would recognise
 * and could argue with, and the reasons are spelled out precisely so
 * they CAN be argued with rather than hidden inside a score. NOTHING
 * HERE IS DERIVED FROM ANYTHING. A course teaching from this module
 * must teach it as a checklist with a number attached, never as a
 * calculation.
 *
 * WHY A SCREENING MATRIX STILL EARNS ITS PLACE NEXT TO REAL ENGINES.
 * Two of the six methods, progressing cavity and jet pumps, have no
 * validated engine anywhere in this package, so screening is all there
 * is for them and saying so plainly is better than leaving them out.
 * For the other four, screening is a fast first pass that the ACTUAL
 * DESIGN (./liftAdvisor.js) then either confirms or overturns, and when
 * the two disagree THE DESIGN WINS, because it solved the well and the
 * matrix only applied a rule.
 *
 * Every method carries `hasEngine`, so a consumer can never present a
 * screened opinion as though it were a design.
 *
 * THE SCORE IS A RANKING DEVICE, NOT A PROBABILITY. Each evaluator
 * starts at 100 and deducts with a stated reason; the result is clamped
 * to 0..100. `recommended` marks a BAND rather than a winner, anything
 * within fifteen points of the leader that also clears fifty, because a
 * screening score is not precise enough to separate close candidates
 * and pretending otherwise would be the whole problem with scoring.
 *
 * UNITS. Field units throughout, as everywhere else in
 * engines/production:
 *
 *   targetLiquidRateBpd  bbl/d of LIQUID, oil plus water at stock tank
 *   depthFt              ft (true vertical)
 *   gor                  scf/stb
 *   wctPct               PER CENT, 0 to 100 (not a fraction: this is
 *                        the one place in the domain that takes a
 *                        percentage, because the rules are stated in
 *                        per cent)
 *   api                  degrees API
 *   bhtF                 degF
 *
 * TWO OWNER DECISIONS, 4 SEPTEMBER 2026, REPLACING THE TWO SEAMS THIS
 * HEADER USED TO RECORD AS OPEN QUESTIONS.
 *
 *  1. ITEM 19. WHAT PHASE IS THE TARGET RATE? IT IS LIQUID. The
 *     parameter is now named `targetLiquidRateBpd` and the contract is
 *     stated at the door: it is oil plus water, in bbl/d. Every rate
 *     rule in this file, the ESP 500 bbl/d band, the plunger 200 bbl/d
 *     ceiling, the rod pump duty index, is a rule about the liquid a
 *     method has to move, so this module reads the number exactly as it
 *     is given and derives nothing. NO SCORE MOVED WITH THE RENAME.
 *
 *     The design pass (./liftAdvisor.js) is the half that has to
 *     change: it consumes the same number as OIL stb/d, so under this
 *     decision it must derive oil as liquid x (1 - water cut) before it
 *     hands the rate to a chain. That derivation moves published
 *     numbers and is therefore a Wave 2 change, tracked in that file's
 *     header. Until it lands, a rate that reaches BOTH modules is
 *     screened as liquid here and designed as oil there.
 *
 *  2. ITEM 20. A MISSING INPUT IS NOT A ZERO. `screenLift` used to
 *     coerce every input with `Number(x) || 0`, so an absent API became
 *     0, which `heavy()` read as heavier than any real crude: the ESP
 *     lost 20 points and the progressing cavity pump gained a "best in
 *     the world at" reason, on no information at all. That is gone.
 *
 *       - The target liquid rate and the depth are REQUIRED. They are
 *         the duty, and every method is scored against it. Absent, the
 *         screening refuses with `{ ok: false, code: 'missingInputs' }`.
 *         Screening `{}` therefore refuses.
 *       - The gas to oil ratio, the water cut, the API gravity and the
 *         bottomhole temperature are OPTIONAL. Absent, the rules that
 *         read them are SKIPPED, no points move either way, and a
 *         neutral reason on every affected method says which rule was
 *         not applied.
 *       - An input that is PRESENT but not a finite number (a string, a
 *         NaN, a boolean) is refused at the door with
 *         `{ ok: false, code: 'nonNumericInput' }`. It is never coerced.
 *         Absent means not known; unreadable means broken, and the two
 *         are not the same.
 *
 * VALIDATION NOTE. Gated against
 * tools/validation/production/oracle_liftscreening.py through
 * test-data/production/goldens/lift_screening_cases.json. A rules
 * matrix cannot be gated the way a correlation can, and the oracle says
 * so: it re-expresses every rule as a DECLARATIVE PENALTY LEDGER
 * (predicate, delta, reason kind) evaluated by a single generic
 * scorer, so a mis-signed or misplaced deduction shows up as a ledger
 * mismatch rather than being copied along with the branch. On top of
 * that it gates STRUCTURAL PROPERTIES the transcription cannot fake:
 * that no adverse condition ever raises a score, that the clamp holds,
 * that the recommendation band is exactly the stated set, and that each
 * archetype well ranks the way an engineer would argue it should. The
 * golden's input records were written before item 19 and still name the
 * rate `targetRate`; the suite maps that key onto `targetLiquidRateBpd`
 * at the call, so no golden number was touched by the rename.
 */

const pro = (text) => ({ type: 'pro', text });
const con = (text) => ({ type: 'con', text });
const neutral = (text) => ({ type: 'neutral', text });

/** The six methods, and which of them this package can actually design. */
export const LIFT_METHODS = [
  { id: 'gasLift', label: 'Gas lift', hasEngine: true, studio: 'gas-lift-design-studio' },
  { id: 'esp', label: 'ESP', hasEngine: true, studio: 'esp-design-studio' },
  { id: 'rodPump', label: 'Rod pump', hasEngine: true, studio: 'rod-pump-design-studio' },
  { id: 'plunger', label: 'Plunger lift', hasEngine: true, studio: 'gas-well-performance-studio' },
  { id: 'pcp', label: 'Progressing cavity pump', hasEngine: false, studio: null },
  { id: 'jetPump', label: 'Jet pump', hasEngine: false, studio: null },
];

export const liftMethod = (id) => LIFT_METHODS.find((m) => m.id === id) || null;

/**
 * The inputs, and which of them the screening cannot proceed without.
 * The duty is the rate and the depth: every method is scored against
 * what it would have to move and how far it would have to lift it, so
 * neither can be guessed. Everything else refines the answer, and an
 * input that was not supplied skips its rule rather than scoring zero.
 */
export const REQUIRED_INPUTS = [
  { key: 'targetLiquidRateBpd', label: 'a target liquid rate in bbl/d' },
  { key: 'depthFt', label: 'a true vertical depth in ft' },
];

export const OPTIONAL_INPUTS = [
  { key: 'gor', label: 'the gas to oil ratio in scf/stb' },
  { key: 'wctPct', label: 'the water cut in per cent' },
  { key: 'api', label: 'the oil gravity in degrees API' },
  { key: 'bhtF', label: 'the bottomhole temperature in degF' },
];

/**
 * What a method says when a rule could not be applied. One wording per
 * input, so a skipped rule reads the same wherever it is skipped and a
 * consumer can match on it.
 */
const SKIPPED = {
  gor: 'No gas to oil ratio was supplied, so every rule that reads it was skipped for this method. A missing ratio is not a zero one.',
  wctPct: 'No water cut was supplied, so every rule that reads it was skipped for this method. A missing cut is not a dry well.',
  api: 'No API gravity was supplied, so every rule that reads it was skipped for this method. A missing gravity is not a heavy crude.',
  bhtF: 'No bottomhole temperature was supplied, so every rule that reads it was skipped for this method. A missing temperature is not a cold well.',
};

/** True when the value came through the door as a real number. */
const given = (v) => v !== null;

/** Oil viscosity is what really drives some of these, and API stands in for it. */
const heavy = (api) => api < 20;
const medium = (api) => api >= 20 && api < 30;

/**
 * Each evaluator returns { score, reasons }, starting from 100 and
 * deducting with a stated reason. A score is a ranking device, not a
 * probability: the reasons are the output that matters. An input that
 * was not supplied arrives here as null, and every rule that reads one
 * says so instead of deducting.
 */
const evaluateGasLift = (w) => {
  let score = 100;
  const reasons = [];
  if (!w.gasAvailable) {
    score -= 60;
    reasons.push(con('No injection gas or compression available. Everything else about gas lift is irrelevant without it.'));
  } else {
    reasons.push(pro('Injection gas and compression are available.'));
  }
  if (!given(w.gor)) {
    reasons.push(neutral(SKIPPED.gor));
  } else if (w.gor > 500) {
    reasons.push(pro('The well already makes gas, which gas lift uses rather than fights.'));
  }
  if (w.targetLiquidRateBpd > 200) {
    reasons.push(pro('Comfortable rate range: gas lift spans a few hundred to tens of thousands of barrels a day.'));
  } else {
    score -= 10;
    reasons.push(neutral('At low rates the injected gas cost per barrel gets hard to justify.'));
  }
  if (w.hasSand) reasons.push(pro('Nothing downhole to abrade: sand is a non-issue.'));
  if (w.isDeviated || w.isHorizontal) reasons.push(pro('No rods or shafts, so deviation and horizontals are no obstacle.'));
  if (w.isOffshore) reasons.push(pro('The offshore default, because there is nothing downhole to pull.'));
  if (!given(w.bhtF)) {
    reasons.push(neutral(SKIPPED.bhtF));
  } else if (w.bhtF > 300) {
    reasons.push(pro('No downhole electronics or elastomers to cook.'));
  }
  if (w.reservoirPressureLow) {
    score -= 25;
    reasons.push(con('A depleted well may not have the bottomhole pressure to lift even a fully gassed column; the deeper the injection point has to be, the worse this gets.'));
  }
  if (w.depthFt > 12000) {
    score -= 10;
    reasons.push(neutral('At this depth the injection pressure needed to reach a useful point of injection gets high.'));
  }
  return { score, reasons };
};

const evaluateEsp = (w) => {
  let score = 100;
  const reasons = [];
  if (!w.powerAvailable) {
    score -= 60;
    reasons.push(con('No electrical supply at the wellsite. An ESP is not an option without one.'));
  } else {
    reasons.push(pro('Electrical supply is available.'));
  }
  if (w.targetLiquidRateBpd >= 500) {
    reasons.push(pro('Squarely in the rate range ESPs are built for.'));
  } else if (w.targetLiquidRateBpd >= 150) {
    score -= 15;
    reasons.push(neutral('Below about 500 bbl/d the stages run inefficiently and motor cooling gets marginal.'));
  } else {
    score -= 35;
    reasons.push(con('Too little flow past the motor to cool it. Low-rate ESPs are short-lived.'));
  }
  if (!given(w.gor)) {
    reasons.push(neutral(SKIPPED.gor));
  } else if (w.gor > 2000) {
    score -= 35;
    reasons.push(con('Free gas at this ratio will gas-lock a centrifugal pump. It needs a separator, and above this gas lift is usually the better method.'));
  } else if (w.gor > 800) {
    score -= 15;
    reasons.push(neutral('Enough free gas to need a gas handler or an intake separator.'));
  } else {
    reasons.push(pro('Low enough gas to run a standard stage.'));
  }
  if (w.hasSand) {
    score -= 25;
    reasons.push(con('Abrasives cut stage run life badly. Expect frequent, expensive pulls.'));
  }
  if (!given(w.bhtF)) {
    reasons.push(neutral(SKIPPED.bhtF));
  } else if (w.bhtF > 275) {
    score -= 20;
    reasons.push(con('Above the temperature ordinary motors and cable insulation are rated for. High-temperature equipment exists and costs.'));
  }
  if (w.isHorizontal) {
    score -= 10;
    reasons.push(neutral('Runs in horizontals, but the pump wants setting in the vertical or the build, not the lateral.'));
  }
  if (!given(w.api)) {
    reasons.push(neutral(SKIPPED.api));
  } else if (heavy(w.api)) {
    score -= 20;
    reasons.push(con('Viscous crude cuts centrifugal head and efficiency sharply, and the correction is not small.'));
  }
  if (w.isOffshore) reasons.push(pro('Compact and high rate, which suits limited platform space.'));
  return { score, reasons };
};

const evaluateRodPump = (w) => {
  let score = 100;
  const reasons = [];
  // The real limit is depth times rate: the rods have to carry the load.
  const dutyIndex = (w.targetLiquidRateBpd * w.depthFt) / 1e6;
  if (dutyIndex > 6) {
    score -= 40;
    reasons.push(con(`Rate and depth together are past what a rod string comfortably carries (${Math.round(w.targetLiquidRateBpd).toLocaleString()} bbl/d at ${Math.round(w.depthFt).toLocaleString()} ft). This is the limit that actually binds rod pumping, not either number alone.`));
  } else if (dutyIndex > 3) {
    score -= 15;
    reasons.push(neutral('Rate and depth together will need a large unit and a heavy taper.'));
  } else {
    reasons.push(pro('Well inside what a rod string and a beam unit handle.'));
  }
  // Said unconditionally, because it is true of the method rather than
  // of a particular well, and a screening that goes quiet on the
  // commonest lift method in the world is not much of a screening.
  reasons.push(pro('The most common lift method there is, and the cheapest to run and to fix. Every field hand knows one.'));
  if (w.targetLiquidRateBpd < 400) reasons.push(pro('Squarely in the rate range beam pumping is most economic at.'));
  if (!given(w.wctPct)) {
    reasons.push(neutral(SKIPPED.wctPct));
  } else if (w.wctPct >= 70) {
    reasons.push(pro('High water cut suits it: a positive displacement pump does not care what it is moving.'));
  }
  if (!given(w.gor)) {
    reasons.push(neutral(SKIPPED.gor));
  } else if (w.gor > 500) {
    score -= 20;
    reasons.push(con('Free gas at the pump keeps the barrel from filling. It needs a gas anchor and a deeper setting, and it still costs fillage.'));
  }
  if (w.hasSand) {
    score -= 15;
    reasons.push(con('Sand scores the barrel and sticks the plunger, though it is survivable with the right pump.'));
  }
  if (w.isHorizontal) {
    score -= 30;
    reasons.push(con('Rods in a lateral wear against the tubing. It is done, with rotators and guides, but it is a maintenance commitment.'));
  } else if (w.isDeviated) {
    score -= 15;
    reasons.push(con('Rod-on-tubing wear in the build section is the usual failure. Guides help and cost.'));
  }
  if (w.isOffshore) {
    score -= 25;
    reasons.push(con('A beam unit needs deck space and constant attention, which is why offshore rarely uses one.'));
  }
  if (!given(w.api)) {
    reasons.push(neutral(SKIPPED.api));
  } else if (heavy(w.api) || medium(w.api)) {
    reasons.push(pro('Positive displacement, so viscosity does not cost head the way it does a centrifugal pump.'));
  }
  if (!given(w.bhtF)) {
    reasons.push(neutral(SKIPPED.bhtF));
  } else if (w.bhtF > 300) {
    reasons.push(pro('Nothing downhole that temperature bothers.'));
  }
  return { score, reasons };
};

const evaluatePlunger = (w) => {
  let score = 100;
  const reasons = [];
  if (w.targetLiquidRateBpd > 200) {
    score -= 45;
    reasons.push(con('A plunger lifts a slug at a time. Past a couple of hundred barrels a day there is not enough cycle time in the day.'));
  } else {
    reasons.push(pro('Low liquid rate, which is exactly what a plunger is for.'));
  }
  if (!given(w.gor)) {
    reasons.push(neutral(SKIPPED.gor));
  } else if (w.gor >= 5000) {
    reasons.push(pro('Plenty of gas per barrel to drive the plunger, which is the whole energy source.'));
  } else if (w.gor >= 1500) {
    score -= 20;
    reasons.push(neutral('Marginal gas-liquid ratio. Whether it works depends on the depth, and the Gas Well Performance Studio computes it rather than guessing.'));
  } else {
    score -= 55;
    reasons.push(con('Not enough gas per barrel to lift the plunger and its slug. There is no external energy source in plunger lift.'));
  }
  if (w.depthFt > 12000) {
    score -= 15;
    reasons.push(neutral('Deep wells need more gas per barrel, and the cycle gets long.'));
  }
  reasons.push(pro('No external power, nothing to pull, and the cheapest lift there is by a wide margin.'));
  if (w.hasSand) {
    score -= 10;
    reasons.push(neutral('Sand can stick a plunger, though there are designs that tolerate it.'));
  }
  if (w.isHorizontal) {
    score -= 10;
    reasons.push(neutral('The plunger works in the vertical; liquid loading in the lateral is a separate problem it does not solve.'));
  }
  return { score, reasons };
};

const evaluatePcp = (w) => {
  let score = 100;
  const reasons = [];
  if (!given(w.api)) {
    reasons.push(neutral(SKIPPED.api));
  } else if (heavy(w.api)) {
    reasons.push(pro('Heavy, viscous crude is what a progressing cavity pump is best in the world at.'));
  } else if (medium(w.api)) {
    reasons.push(pro('Handles medium crude well.'));
  } else {
    score -= 25;
    reasons.push(con('Light crude and aromatics swell and degrade the stator elastomer. This is the commonest reason a PCP fails early.'));
  }
  if (w.hasSand) reasons.push(pro('Sand tolerant, which is a large part of why it is used in heavy oil.'));
  if (w.targetLiquidRateBpd > 2000) {
    score -= 30;
    reasons.push(con('Past the rate a progressing cavity pump comfortably delivers.'));
  } else if (w.targetLiquidRateBpd < 50) {
    score -= 10;
    reasons.push(neutral('Low rates work but the economics get thin.'));
  } else {
    reasons.push(pro('Comfortable rate range.'));
  }
  if (!given(w.bhtF)) {
    reasons.push(neutral(SKIPPED.bhtF));
  } else if (w.bhtF > 250) {
    score -= 35;
    reasons.push(con('Above what conventional elastomers survive. High-temperature stators exist and narrow the choices.'));
  }
  if (w.depthFt > 6000) {
    score -= 20;
    reasons.push(con('Rod torque and the risk of a rod-string backspin incident grow with depth.'));
  }
  if (!given(w.gor)) {
    reasons.push(neutral(SKIPPED.gor));
  } else if (w.gor > 500) {
    score -= 20;
    reasons.push(con('Free gas causes the pump to run dry in places, and a dry stator burns quickly.'));
  }
  if (w.isHorizontal) {
    score -= 20;
    reasons.push(con('Driven by rods, so the lateral brings the same wear problem rod pumping has.'));
  }
  return { score, reasons };
};

const evaluateJetPump = (w) => {
  let score = 100;
  const reasons = [];
  reasons.push(pro('No moving parts downhole, and the pump can be circulated out without a rig.'));
  if (w.hasSand) reasons.push(pro('Nothing downhole for sand to wear against, which makes it a genuine option in abrasive wells.'));
  if (w.isDeviated || w.isHorizontal) reasons.push(pro('Deviation and horizontals are no obstacle: it is a free pump, not a rod string.'));
  if (!given(w.bhtF)) {
    reasons.push(neutral(SKIPPED.bhtF));
  } else if (w.bhtF > 300) {
    reasons.push(pro('Tolerates hot wells that would cook an ESP or a PCP.'));
  }
  score -= 20;
  reasons.push(con('Efficiency is poor, typically 20 to 30 percent, so power cost per barrel is high, and that is the reason it is not chosen more often.'));
  if (!w.powerAvailable) {
    score -= 25;
    reasons.push(con('A surface power-fluid system needs pumps and treatment, which is a facility commitment in itself.'));
  }
  if (w.targetLiquidRateBpd < 100) {
    score -= 15;
    reasons.push(neutral('Low rates make the surface power fluid system hard to justify.'));
  }
  if (w.reservoirPressureLow) {
    score -= 25;
    reasons.push(con('Needs enough intake pressure to avoid cavitating in the throat, and a depleted well may not have it.'));
  }
  return { score, reasons };
};

const EVALUATORS = {
  gasLift: evaluateGasLift,
  esp: evaluateEsp,
  rodPump: evaluateRodPump,
  plunger: evaluatePlunger,
  pcp: evaluatePcp,
  jetPump: evaluateJetPump,
};

/** Absent means not supplied. Present and unreadable means broken. */
const absent = (v) => v === undefined || v === null || v === '';

/**
 * Screen every method against the well and the facility.
 *
 * `inputs`: {
 *   targetLiquidRateBpd (bbl/d of LIQUID, oil plus water: REQUIRED),
 *   depthFt (ft true vertical: REQUIRED), gor (scf/stb), wctPct (per
 *   cent), api, bhtF, isOffshore, hasSand, isDeviated, isHorizontal,
 *   powerAvailable, gasAvailable, reservoirPressureLow
 * }
 *
 * returns, on success, [{ id, label, hasEngine, studio, score, reasons,
 * recommended }] sorted best first. `recommended` marks the methods
 * worth designing: anything within fifteen points of the leader that
 * also clears fifty.
 *
 * returns, on a refusal, { ok: false, code, error }. See decision 2 in
 * the module header: a required input that is missing refuses with
 * `missingInputs`, and any input that is present but not a finite
 * number refuses with `nonNumericInput`. An optional input that is
 * simply absent is not a refusal: its rules are skipped and every
 * affected method says so.
 */
export const screenLift = (inputs) => {
  const src = inputs || {};
  const all = [...REQUIRED_INPUTS, ...OPTIONAL_INPUTS];

  const unreadable = all.filter((f) => !absent(src[f.key]) && !Number.isFinite(src[f.key]));
  if (unreadable.length) {
    return {
      ok: false,
      code: 'nonNumericInput',
      error: `Screening reads numbers and never coerces them. ${unreadable
        .map((f) => `${f.key} was given as ${JSON.stringify(src[f.key])}`)
        .join(', ')}. Supply ${unreadable.map((f) => f.label).join(', ')}, or leave the input out entirely.`,
    };
  }

  const missing = REQUIRED_INPUTS.filter((f) => absent(src[f.key]));
  if (missing.length) {
    return {
      ok: false,
      code: 'missingInputs',
      error: `Screening cannot rank a well without its duty. ${missing
        .map((f) => f.key)
        .join(' and ')} was not supplied, and a missing input is not a zero one. Supply ${missing
        .map((f) => f.label)
        .join(' and ')}.`,
    };
  }

  const optional = (key) => (absent(src[key]) ? null : src[key]);
  const w = {
    targetLiquidRateBpd: src.targetLiquidRateBpd,
    depthFt: src.depthFt,
    gor: optional('gor'),
    wctPct: optional('wctPct'),
    api: optional('api'),
    bhtF: optional('bhtF'),
    isOffshore: !!src.isOffshore,
    hasSand: !!src.hasSand,
    isDeviated: !!src.isDeviated,
    isHorizontal: !!src.isHorizontal,
    powerAvailable: src.powerAvailable !== false,
    gasAvailable: src.gasAvailable !== false,
    reservoirPressureLow: !!src.reservoirPressureLow,
  };

  const results = LIFT_METHODS.map((method) => {
    const { score, reasons } = EVALUATORS[method.id](w);
    return {
      ...method,
      score: Math.max(0, Math.min(100, score)),
      reasons,
    };
  }).sort((a, b) => b.score - a.score);

  const top = results.length ? results[0].score : 0;
  results.forEach((r) => {
    r.recommended = r.score >= top - 15 && r.score > 50;
  });
  return results;
};

/**
 * The well-model half of the screening inputs, so a linked well fills
 * itself in.
 *
 * It can legitimately hand back an undefined `api` or `gor` from a
 * model with no fluid description, and since item 20 that is safe:
 * `screenLift` skips the rules that read them and says so, rather than
 * reading a missing gravity as ultra-heavy crude. `isDeviated` is
 * undefined when the survey cannot answer the question, because a
 * trajectory that was not supplied is not a vertical well.
 */
export const screeningInputsFromModel = (model, { targetLiquidRateBpd, wctPct } = {}) => {
  if (!model) return {};
  const mdMax = model.trajectory?.mdMax;
  const tvdMax = model.tvdMax;
  const surveyed = Number.isFinite(mdMax) && Number.isFinite(tvdMax);
  return {
    depthFt: tvdMax,
    bhtF: model.tAt(tvdMax),
    api: model.fluidModel?.api,
    gor: model.fluidModel?.gor,
    targetLiquidRateBpd,
    wctPct,
    isDeviated: surveyed ? mdMax > tvdMax * 1.02 : undefined,
  };
};
