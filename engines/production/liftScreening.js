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
 * Two of the six methods -- progressing cavity and jet pumps -- have no
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
 * to 0..100. `recommended` marks a BAND rather than a winner --
 * anything within fifteen points of the leader that also clears fifty
 * -- because a screening score is not precise enough to separate close
 * candidates and pretending otherwise would be the whole problem with
 * scoring.
 *
 * UNITS. Field units throughout, as everywhere else in
 * engines/production:
 *
 *   targetRate    bbl/d          SEE THE OPEN QUESTION BELOW
 *   depthFt       ft (true vertical)
 *   gor           scf/stb
 *   wctPct        PER CENT, 0 to 100 (not a fraction -- this is the one
 *                 place in the domain that takes a percentage, because
 *                 the rules are stated in per cent)
 *   api           degrees API
 *   bhtF          degF
 *
 * TWO SEAMS FOUND ON EXTRACTION, RECORDED AND NOT CHANGED.
 *
 *  1. WHAT PHASE IS `targetRate`? This module's original contract said
 *     "bbl/d LIQUID". The design pass it feeds (./liftAdvisor.js)
 *     treats the same number as OIL stb/d: it compares it against the
 *     inflow's oil absolute open flow and hands it to each design chain
 *     as the oil design rate with the water cut supplied separately.
 *     The shipped studio passes ONE number to both. So on a well at 70
 *     per cent water cut, every rate rule below -- the ESP 500 bbl/d
 *     band, the plunger 200 bbl/d ceiling, the rod-pump duty index --
 *     is being applied to roughly a THIRD of the liquid the method
 *     would actually have to move. The rules read as liquid rules.
 *     Behaviour is preserved exactly as shipped; the resolution is an
 *     owner decision because either reading moves displayed scores.
 *
 *  2. A MISSING INPUT BECOMES ZERO, AND ZERO IS NOT NEUTRAL. `screenLift`
 *     coerces with `Number(x) || 0`, so an absent API becomes 0, which
 *     `heavy()` reads as heavier than any real crude: the ESP loses 20
 *     points and the progressing cavity pump gains a "best in the world
 *     at" reason, on no information at all. Absent depth and rate
 *     likewise read as the most FAVOURABLE possible case for rod
 *     pumping (a duty index of zero). The shipped studio happens to
 *     supply an API default at the call site, so no displayed number
 *     moves today, but `screeningInputsFromModel` can hand back an
 *     undefined API from a model with no fluid description and any
 *     other consumer would walk straight into it. Behaviour preserved;
 *     a defaults-versus-refusal decision belongs to the owner.
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
 * archetype well ranks the way an engineer would argue it should.
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

/** Oil viscosity is what really drives some of these, and API stands in for it. */
const heavy = (api) => api < 20;
const medium = (api) => api >= 20 && api < 30;

/**
 * Each evaluator returns { score, reasons }, starting from 100 and
 * deducting with a stated reason. A score is a ranking device, not a
 * probability: the reasons are the output that matters.
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
  if (w.gor > 500) reasons.push(pro('The well already makes gas, which gas lift uses rather than fights.'));
  if (w.targetRate > 200) {
    reasons.push(pro('Comfortable rate range: gas lift spans a few hundred to tens of thousands of barrels a day.'));
  } else {
    score -= 10;
    reasons.push(neutral('At low rates the injected gas cost per barrel gets hard to justify.'));
  }
  if (w.hasSand) reasons.push(pro('Nothing downhole to abrade: sand is a non-issue.'));
  if (w.isDeviated || w.isHorizontal) reasons.push(pro('No rods or shafts, so deviation and horizontals are no obstacle.'));
  if (w.isOffshore) reasons.push(pro('The offshore default, because there is nothing downhole to pull.'));
  if (w.bhtF > 300) reasons.push(pro('No downhole electronics or elastomers to cook.'));
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
  if (w.targetRate >= 500) {
    reasons.push(pro('Squarely in the rate range ESPs are built for.'));
  } else if (w.targetRate >= 150) {
    score -= 15;
    reasons.push(neutral('Below about 500 bbl/d the stages run inefficiently and motor cooling gets marginal.'));
  } else {
    score -= 35;
    reasons.push(con('Too little flow past the motor to cool it. Low-rate ESPs are short-lived.'));
  }
  if (w.gor > 2000) {
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
  if (w.bhtF > 275) {
    score -= 20;
    reasons.push(con('Above the temperature ordinary motors and cable insulation are rated for. High-temperature equipment exists and costs.'));
  }
  if (w.isHorizontal) {
    score -= 10;
    reasons.push(neutral('Runs in horizontals, but the pump wants setting in the vertical or the build, not the lateral.'));
  }
  if (heavy(w.api)) {
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
  const dutyIndex = (w.targetRate * w.depthFt) / 1e6;
  if (dutyIndex > 6) {
    score -= 40;
    reasons.push(con(`Rate and depth together are past what a rod string comfortably carries (${Math.round(w.targetRate).toLocaleString()} bbl/d at ${Math.round(w.depthFt).toLocaleString()} ft). This is the limit that actually binds rod pumping, not either number alone.`));
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
  if (w.targetRate < 400) reasons.push(pro('Squarely in the rate range beam pumping is most economic at.'));
  if (w.wctPct >= 70) {
    reasons.push(pro('High water cut suits it: a positive displacement pump does not care what it is moving.'));
  }
  if (w.gor > 500) {
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
  if (heavy(w.api) || medium(w.api)) {
    reasons.push(pro('Positive displacement, so viscosity does not cost head the way it does a centrifugal pump.'));
  }
  if (w.bhtF > 300) reasons.push(pro('Nothing downhole that temperature bothers.'));
  return { score, reasons };
};

const evaluatePlunger = (w) => {
  let score = 100;
  const reasons = [];
  if (w.targetRate > 200) {
    score -= 45;
    reasons.push(con('A plunger lifts a slug at a time. Past a couple of hundred barrels a day there is not enough cycle time in the day.'));
  } else {
    reasons.push(pro('Low liquid rate, which is exactly what a plunger is for.'));
  }
  if (w.gor >= 5000) {
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
  if (heavy(w.api)) {
    reasons.push(pro('Heavy, viscous crude is what a progressing cavity pump is best in the world at.'));
  } else if (medium(w.api)) {
    reasons.push(pro('Handles medium crude well.'));
  } else {
    score -= 25;
    reasons.push(con('Light crude and aromatics swell and degrade the stator elastomer. This is the commonest reason a PCP fails early.'));
  }
  if (w.hasSand) reasons.push(pro('Sand tolerant, which is a large part of why it is used in heavy oil.'));
  if (w.targetRate > 2000) {
    score -= 30;
    reasons.push(con('Past the rate a progressing cavity pump comfortably delivers.'));
  } else if (w.targetRate < 50) {
    score -= 10;
    reasons.push(neutral('Low rates work but the economics get thin.'));
  } else {
    reasons.push(pro('Comfortable rate range.'));
  }
  if (w.bhtF > 250) {
    score -= 35;
    reasons.push(con('Above what conventional elastomers survive. High-temperature stators exist and narrow the choices.'));
  }
  if (w.depthFt > 6000) {
    score -= 20;
    reasons.push(con('Rod torque and the risk of a rod-string backspin incident grow with depth.'));
  }
  if (w.gor > 500) {
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
  if (w.bhtF > 300) reasons.push(pro('Tolerates hot wells that would cook an ESP or a PCP.'));
  score -= 20;
  reasons.push(con('Efficiency is poor -- typically 20 to 30 percent -- so power cost per barrel is high, and that is the reason it is not chosen more often.'));
  if (!w.powerAvailable) {
    score -= 25;
    reasons.push(con('A surface power-fluid system needs pumps and treatment, which is a facility commitment in itself.'));
  }
  if (w.targetRate < 100) {
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

/**
 * Screen every method against the well and the facility.
 *
 * `inputs`: {
 *   targetRate (bbl/d -- see seam 1 in the module header), depthFt,
 *   gor (scf/stb), wctPct (per cent), api, bhtF, isOffshore, hasSand,
 *   isDeviated, isHorizontal, powerAvailable, gasAvailable,
 *   reservoirPressureLow
 * }
 *
 * returns [{ id, label, hasEngine, studio, score, reasons, recommended }]
 * sorted best first. `recommended` marks the methods worth designing:
 * anything within fifteen points of the leader that also clears fifty.
 */
export const screenLift = (inputs) => {
  const w = {
    targetRate: Number(inputs?.targetRate) || 0,
    depthFt: Number(inputs?.depthFt) || 0,
    gor: Number(inputs?.gor) || 0,
    wctPct: Number(inputs?.wctPct) || 0,
    api: Number(inputs?.api) || 0,
    bhtF: Number(inputs?.bhtF) || 0,
    isOffshore: !!inputs?.isOffshore,
    hasSand: !!inputs?.hasSand,
    isDeviated: !!inputs?.isDeviated,
    isHorizontal: !!inputs?.isHorizontal,
    powerAvailable: inputs?.powerAvailable !== false,
    gasAvailable: inputs?.gasAvailable !== false,
    reservoirPressureLow: !!inputs?.reservoirPressureLow,
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
 * itself in. NOTE seam 2 in the module header: this can legitimately
 * return an undefined `api` or `gor`, which `screenLift` will coerce to
 * zero and read as ultra-heavy, dead crude. A consumer that cannot
 * guarantee a fluid description must supply its own defaults.
 */
export const screeningInputsFromModel = (model, { targetRate, wctPct } = {}) => {
  if (!model) return {};
  return {
    depthFt: model.tvdMax,
    bhtF: model.tAt(model.tvdMax),
    api: model.fluidModel?.api,
    gor: model.fluidModel?.gor,
    targetRate,
    wctPct,
    isDeviated: (model.trajectory?.mdMax || 0) > (model.tvdMax || 0) * 1.02,
  };
};
