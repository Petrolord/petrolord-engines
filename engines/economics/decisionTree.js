// Canonical decision-analysis engine (Economics D3), extracted VERBATIM
// from the Suite's src/lib/decisionTree.js in the EC0 extraction wave,
// 2026-09-08. The file has no imports, so nothing was repointed and no
// line below this header block was changed. Gated by
// __tests__/economics.decision.test.js against the independent oracle
// tools/validation/economics/oracle_decision.py and its committed golden
// test-data/economics/goldens/decision_cases.json. Money in the goldens is
// USD millions ($MM), matching the Suite's Decision Tree Builder and VOI
// Analyzer.
//
// Canonical decision-analysis engine for the Suite (D3,
// docs/scope/Economics-ROADMAP.md). Any app needing decision trees, EMV
// rollback, EVPI, or EVII imports THIS module; do not re-implement.
//
// Tree shape (plain JSON, persistable):
//   decision: { id?, type: 'decision', label, branches: [{ label, cost?, node }] }
//   chance:   { id?, type: 'chance',   label, branches: [{ label, probability, cost?, node }] }
//   terminal: { id?, type: 'terminal', label, payoff }
//
// `cost` on a branch is a cash outflow incurred when that branch is taken
// (e.g. the drilling cost on a "Drill" decision branch, or a data-acquisition
// cost on an "Acquire seismic" branch). `payoff` on a terminal is a number,
// or an object carrying a distribution summary whose EMV basis is `.mean`
// (e.g. a linked EPE Monte Carlo run: { mean, p90, p50, p10, ref }): EMV
// rollback is linear, so the expectation of the payoff distribution is the
// only statistic the rollback needs.
//
// Conventions:
// - EMV rollback: terminals evaluate to their payoff; chance nodes to the
//   probability-weighted sum of branch values minus branch costs; decision
//   nodes to the MAX over branch values minus branch costs (rational
//   risk-neutral actor). Probabilities at a chance node must sum to 1.
// - Ties at a decision are reported (EC4-1) at two precisions: the exact
//   value band, which the optimal-path marking uses, and the card precision
//   a reader sees. A screen shows every tied branch instead of recommending
//   whichever was listed first, and its words come from the card set.
// - Costs and payoffs are read strictly (EC4-4): omitted is 0, and anything
//   present that is not a finite number, or a negative cost, is refused by
//   node label.
// - EVPI / EVII follow the standard prior/posterior construction
//   (Newendorp & Schuyler; Mian): EVII derives the signal marginals and
//   posteriors from priors and likelihoods via Bayes, so its inputs CANNOT
//   be probabilistically inconsistent. 0 <= EVII <= EVPI always holds.

const PROB_TOL = 1e-6;
// EC4-8 (2026-09-15, owner decision): every comparison against PROB_TOL adds
// this binary representation allowance, the same 1e-12 impliedPriors uses
// (D1, EC4-0). Three branches typed 0.333333 sum to 0.999999, exactly 1e-6
// short in the typed decimals but 1.0000000000287557e-6 short in binary
// floating point, so without it the engine refused a sum on its own edge.
// A sum genuinely off by more than 1e-6 is still refused.
const REPRESENTATION_ALLOWANCE = 1e-12;
const offOne = (sum) => Math.abs(sum - 1) > PROB_TOL + REPRESENTATION_ALLOWANCE;

// EC4-1 (2026-09-15, owner decision): exact ties are reported, never hidden.
// Two values tie when |a - b| <= TIE_RELATIVE * max(1, |best|), where best is
// the largest value being compared: relative to the best for values above 1
// in magnitude, absolute (1e-9) below that. Float residue inside that band is
// a tie. Every decision node result, and every best-action result, carries
// `tiedIndices` (every index within the band of the best, in listed order)
// and `indifferent` (tiedIndices.length > 1). The single index the optimal
// path marking needs (`bestBranchIndex`, `actionIndex`) is the FIRST listed
// of the tied indices; the value (`emv`) is the largest. Before, the first
// strictly greater value won, so a tie silently recommended the first
// listed branch, and float residue could recommend a later one.
export const TIE_RELATIVE = 1e-9;
const tieBand = (best) => TIE_RELATIVE * Math.max(1, Math.abs(best));

/**
 * Money at card precision: 2 decimal places, half away from zero on the
 * magnitude (with the representation allowance, so a value that is an exact
 * half cent in decimals rounds the way the decimals do), and negative zero
 * normalised so nothing ever reads "-0.00". This is the EC4-2 rounding the
 * VOI Analyzer's cards and verdict already share; the Analyzer imports it
 * from here so one rounding serves the numbers and the words.
 */
export function cardValue(v) {
  const magnitude = Number((Math.abs(v) + REPRESENTATION_ALLOWANCE).toFixed(2));
  return magnitude === 0 ? 0 : (v < 0 ? -magnitude : magnitude);
}

// EC4-1, second precision (2026-09-15, owner decision via the lead): a
// sentence a reader sees must agree with the numbers beside it. So every
// result reports TWO tie sets, side by side:
//
//   tiedIndices / indifferent
//       the exact value band above. This is the engine's internal truth and
//       what the optimal-path marking and `bestBranchIndex` use.
//   tiedIndicesAtCardPrecision / indifferentAtCardPrecision
//       every index whose value ROUNDS to the same card as the best does.
//       Guidance wording uses this set, so a gap of 0.0001 that both cards
//       print as 0.00 reads as indifferent, while a gap the cards show still
//       names one action.
//
// The two sets are measured independently and neither contains the other in
// every case: values a ten-billionth apart that straddle a rounding boundary
// (0.005 against 0.0049999999) are an exact tie printed on two different
// cards, and the result says exactly that.
function bestWithTies(values) {
  let best = -Infinity;
  for (const v of values) if (v > best) best = v;
  const band = tieBand(best);
  const bestCard = cardValue(best);
  const tiedIndices = [];
  const tiedIndicesAtCardPrecision = [];
  values.forEach((v, i) => {
    if (Math.abs(best - v) <= band) tiedIndices.push(i);
    if (cardValue(v) === bestCard) tiedIndicesAtCardPrecision.push(i);
  });
  return {
    best,
    index: tiedIndices[0],
    tiedIndices,
    indifferent: tiedIndices.length > 1,
    tiedIndicesAtCardPrecision,
    indifferentAtCardPrecision: tiedIndicesAtCardPrecision.length > 1,
  };
}

// EC4-4 (2026-09-15, owner decision): no silent defaults for money. A cost
// or payoff that is OMITTED (undefined) is 0. One that is PRESENT must be a
// finite number, or a string holding one; a blank string, null, a
// non-numeric value, NaN or an infinity is REFUSED naming the node (or the
// action) and the field. A negative cost is refused: a receipt is a payoff.
// Before, a cost read as `Number(cost) || 0` (blank, null, "abc" and NaN all
// became 0, and -5 became a receipt of 5) and a null or blank payoff was 0.
const shown = (v) => (typeof v === 'string' ? `"${v}"` : String(v));

function readAmount(raw) {
  if (raw === undefined) return { kind: 'omitted', value: 0 };
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return { kind: 'blank' };
  if (typeof raw !== 'number' && typeof raw !== 'string') return { kind: 'notNumber' };
  const v = Number(raw);
  return Number.isFinite(v) ? { kind: 'number', value: v } : { kind: 'notNumber' };
}

/**
 * A cost as a number of 0 or more (omitted is 0). `subject` names what
 * carries it (`Branch "Drill"`, `Action "Drill"`); `nodeLabel` is appended
 * by DecisionTreeError as (at node "...").
 */
export function costValue(cost, subject, nodeLabel = null) {
  const r = readAmount(cost);
  if (r.kind === 'blank') {
    throw new DecisionTreeError(`${subject} has a blank cost; a cost must be a number of 0 or more`, nodeLabel);
  }
  if (r.kind === 'notNumber') {
    throw new DecisionTreeError(
      `${subject} has a cost that is not a finite number (${shown(cost)}); a cost must be a number of 0 or more`, nodeLabel);
  }
  if (r.value < 0) {
    throw new DecisionTreeError(
      `${subject} has a negative cost (${r.value}); a cost cannot be negative: enter a receipt as a payoff`, nodeLabel);
  }
  return r.value;
}

function readPayoff(payoff, subject, nodeLabel) {
  if (payoff !== null && typeof payoff === 'object') {
    const m = readAmount(payoff.mean);
    if (m.kind !== 'number') {
      throw new DecisionTreeError(subject === 'Terminal payoff'
        ? 'Distribution payoff has no finite mean'
        : `${subject} is a distribution with no finite mean`, nodeLabel);
    }
    return m.value;
  }
  const r = readAmount(payoff);
  if (r.kind === 'blank') {
    throw new DecisionTreeError(`${subject} is blank; a payoff must be a finite number`, nodeLabel);
  }
  if (r.kind === 'notNumber') {
    throw new DecisionTreeError(
      `${subject} is not a finite number (${shown(payoff)}); a payoff must be a finite number`, nodeLabel);
  }
  return r.value;
}

export class DecisionTreeError extends Error {
  constructor(message, nodeLabel = null) {
    super(nodeLabel ? `${message} (at node "${nodeLabel}")` : message);
    this.name = 'DecisionTreeError';
    this.nodeLabel = nodeLabel;
  }
}

// EMV basis of a terminal payoff: a plain number (or a string holding one),
// or `.mean` of a distribution summary object. An omitted payoff is 0; a
// present one that is blank, null or not a finite number is refused (EC4-4),
// naming `nodeLabel` when given.
export function payoffValue(payoff, nodeLabel = null) {
  return readPayoff(payoff, 'Terminal payoff', nodeLabel);
}

/**
 * EMV rollback. Returns an annotated deep copy of the tree:
 *   every node gains `emv`;
 *   decision nodes gain `bestBranchIndex` (the first listed of the tied
 *   best branches), `tiedIndices` and `indifferent`, plus
 *   `tiedIndicesAtCardPrecision` and `indifferentAtCardPrecision` (EC4-1);
 *   decision/chance branches gain `branchValue` (child EMV minus branch cost)
 *   and `onOptimalPath` (true for every branch reachable by always taking
 *   the best decision at each decision node).
 */
export function rollback(node) {
  const annotated = evaluate(node);
  markOptimalPath(annotated, true);
  return annotated;
}

function evaluate(node) {
  if (!node || typeof node !== 'object') {
    throw new DecisionTreeError('Missing node');
  }
  if (node.type === 'terminal') {
    return { ...node, emv: payoffValue(node.payoff, node.label) };
  }
  const branches = node.branches || [];
  if (branches.length === 0) {
    throw new DecisionTreeError('Decision and chance nodes need at least one branch', node.label);
  }

  if (node.type === 'chance') {
    let pSum = 0;
    const annBranches = branches.map((b) => {
      const p = Number(b.probability);
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new DecisionTreeError(`Branch "${b.label ?? ''}" needs a probability between 0 and 1`, node.label);
      }
      pSum += p;
      const child = evaluate(b.node);
      const branchValue = child.emv - costValue(b.cost, `Branch "${b.label ?? ''}"`, node.label);
      return { ...b, node: child, branchValue };
    });
    if (offOne(pSum)) {
      throw new DecisionTreeError(`Chance branch probabilities sum to ${pSum.toFixed(6)}, expected 1`, node.label);
    }
    const emv = annBranches.reduce((s, b) => s + Number(b.probability) * b.branchValue, 0);
    return { ...node, branches: annBranches, emv };
  }

  if (node.type === 'decision') {
    const annBranches = branches.map((b) => {
      const child = evaluate(b.node);
      const branchValue = child.emv - costValue(b.cost, `Branch "${b.label ?? ''}"`, node.label);
      return { ...b, node: child, branchValue };
    });
    const t = bestWithTies(annBranches.map((b) => b.branchValue));
    return {
      ...node,
      branches: annBranches,
      emv: t.best,
      bestBranchIndex: t.index,
      tiedIndices: t.tiedIndices,
      indifferent: t.indifferent,
      tiedIndicesAtCardPrecision: t.tiedIndicesAtCardPrecision,
      indifferentAtCardPrecision: t.indifferentAtCardPrecision,
    };
  }

  throw new DecisionTreeError(`Unknown node type "${node.type}"`, node.label);
}

function markOptimalPath(node, onPath) {
  if (node.type === 'terminal') return;
  node.branches.forEach((b, i) => {
    const branchOnPath = onPath && (node.type === 'chance' || i === node.bestBranchIndex);
    b.onOptimalPath = branchOnPath;
    markOptimalPath(b.node, branchOnPath);
  });
}

// ----------------------------------------------------------------------------
// Single-stage information-value analysis
// ----------------------------------------------------------------------------
//
// Problem shape shared by EVPI and EVII:
//   outcomes: [{ label, probability }]           — priors, must sum to 1
//   actions:  [{ label, cost?, payoffs: [] }]    — payoffs[i] pairs with
//              outcomes[i]; `cost` is charged whenever the action is taken.

function validateLottery(outcomes, actions) {
  if (!outcomes?.length) throw new DecisionTreeError('No outcomes given');
  if (!actions?.length) throw new DecisionTreeError('No actions given');
  const pSum = outcomes.reduce((s, o) => s + Number(o.probability), 0);
  if (offOne(pSum)) {
    throw new DecisionTreeError(`Outcome probabilities sum to ${pSum.toFixed(6)}, expected 1`);
  }
  for (const a of actions) {
    if ((a.payoffs?.length ?? 0) !== outcomes.length) {
      throw new DecisionTreeError(`Action "${a.label ?? ''}" needs one payoff per outcome`);
    }
  }
  // EC4-4: every cost and payoff is read before anything is computed.
  for (const a of actions) {
    actionCost(a);
    outcomes.forEach((_, i) => actionPayoff(a, outcomes, i));
  }
}

const actionCost = (a) => costValue(a.cost, `Action "${a.label ?? ''}"`);
const actionPayoff = (a, outcomes, i) =>
  readPayoff(a.payoffs[i], `Payoff of action "${a.label ?? ''}" for outcome "${outcomes[i].label ?? i}"`, null);

const actionValue = (a, outcomes, probs) =>
  probs.reduce((s, p, i) => s + p * actionPayoff(a, outcomes, i), 0) - actionCost(a);

/**
 * EMV of the best action under the given outcome probabilities.
 * `actionIndex` is the first listed of `tiedIndices`; `indifferent` is true
 * when more than one action ties for the best on value, and
 * `indifferentAtCardPrecision` when more than one rounds to the best card
 * (EC4-1). Guidance wording reads the card-precision pair.
 */
export function bestActionEmv(outcomes, actions, probs = null) {
  validateLottery(outcomes, actions);
  const p = probs ?? outcomes.map((o) => Number(o.probability));
  const t = bestWithTies(actions.map((a) => actionValue(a, outcomes, p)));
  return {
    emv: t.best,
    actionIndex: t.index,
    tiedIndices: t.tiedIndices,
    indifferent: t.indifferent,
    tiedIndicesAtCardPrecision: t.tiedIndicesAtCardPrecision,
    indifferentAtCardPrecision: t.indifferentAtCardPrecision,
  };
}

/**
 * Expected Value of Perfect Information:
 *   EVPI = E_o[ max_a (payoff - cost) ] - max_a E_o[ payoff - cost ]
 */
export function evpi(outcomes, actions) {
  validateLottery(outcomes, actions);
  const priors = outcomes.map((o) => Number(o.probability));
  const emvPrior = bestActionEmv(outcomes, actions).emv;
  const evWithPerfect = priors.reduce((s, p, i) => {
    const bestHere = Math.max(...actions.map((a) => actionPayoff(a, outcomes, i) - actionCost(a)));
    return s + p * bestHere;
  }, 0);
  return { evpi: evWithPerfect - emvPrior, emvPrior, evWithPerfect };
}

/**
 * Expected Value of Imperfect Information from signal LIKELIHOODS.
 *
 *   signals: [{ label, likelihoods: [] }] — likelihoods[i] = P(signal | outcome i).
 *   For each outcome i, sum over signals of P(signal | outcome i) must be 1.
 *
 * Bayes derives the signal marginals P(s) and posteriors P(o|s), so the
 * analysis is consistent BY CONSTRUCTION (unlike asking users to type
 * marginals and posteriors independently). `infoCost` is subtracted at the
 * end (net EVII).
 */
export function evii(outcomes, actions, signals, infoCost = 0) {
  validateLottery(outcomes, actions);
  const netCost = costValue(infoCost, 'The information');
  if (!signals?.length) throw new DecisionTreeError('No signals given');
  const priors = outcomes.map((o) => Number(o.probability));

  for (let i = 0; i < outcomes.length; i++) {
    const colSum = signals.reduce((s, sig) => s + Number(sig.likelihoods?.[i] ?? NaN), 0);
    if (!Number.isFinite(colSum) || offOne(colSum)) {
      throw new DecisionTreeError(
        `Likelihoods P(signal | "${outcomes[i].label ?? i}") sum to ${colSum.toFixed(6)}, expected 1`);
    }
  }

  const emvPrior = bestActionEmv(outcomes, actions).emv;

  let evWithInfo = 0;
  const perSignal = signals.map((sig) => {
    const joint = priors.map((p, i) => p * Number(sig.likelihoods[i]));
    const pSignal = joint.reduce((s, j) => s + j, 0);
    const posterior = pSignal > 0 ? joint.map((j) => j / pSignal) : priors;
    const best = bestActionEmv(outcomes, actions, posterior);
    evWithInfo += pSignal * best.emv;
    return {
      label: sig.label, pSignal, posterior, emv: best.emv, bestActionIndex: best.actionIndex,
      tiedActionIndices: best.tiedIndices, indifferent: best.indifferent,
      tiedActionIndicesAtCardPrecision: best.tiedIndicesAtCardPrecision,
      indifferentAtCardPrecision: best.indifferentAtCardPrecision,
    };
  });

  const eviiGross = evWithInfo - emvPrior;
  return {
    evii: eviiGross,
    netEvii: eviiGross - netCost,
    emvPrior,
    evWithInfo,
    perSignal,
  };
}

/**
 * Bayes-consistency check for the legacy VOI input shape, where users type
 * P(indicator) and P(outcome | indicator) independently of the stated
 * priors. Returns the priors IMPLIED by those entries
 * (P_implied(o) = sum_i P(i) * P(o|i)) and the deltas against the stated
 * priors, so the UI can warn when the numbers contradict each other.
 *
 *   indicators: [{ label, probability, posteriors: [] }] — posteriors[i]
 *               = P(outcome i | indicator).
 */
export function impliedPriors(outcomes, indicators) {
  const stated = outcomes.map((o) => Number(o.probability));
  const implied = outcomes.map((_, i) =>
    indicators.reduce((s, ind) => s + Number(ind.probability) * Number(ind.posteriors?.[i] ?? 0), 0));
  const deltas = implied.map((v, i) => v - stated[i]);
  // The 1e-12 absorbs binary representation error, so a delta that is
  // exactly half a percent in the typed decimals (0.305 against 0.3) is
  // consistent as the method states; EC4-0 resolved finding D1 this way.
  const consistent = deltas.every((d) => Math.abs(d) <= 0.005 + 1e-12);
  return { stated, implied, deltas, consistent };
}

// ----------------------------------------------------------------------------
// Tree construction helpers
// ----------------------------------------------------------------------------

/**
 * Build the classic single-stage information tree (the VOI Analyzer's shape)
 * as an explicit decision tree, from the same lottery + signals inputs used
 * by evii(). Rolling this tree back reproduces evii()/evpi() numbers, which
 * the tests assert.
 */
export function buildInformationTree({ outcomes, actions, signals, infoCost = 0, infoLabel = 'Acquire information' }) {
  const priors = outcomes.map((o) => Number(o.probability));

  const actNode = (probs) => ({
    type: 'decision',
    label: 'Choose action',
    branches: actions.map((a) => ({
      label: a.label,
      cost: costValue(a.cost, `Action "${a.label ?? ''}"`),
      node: {
        type: 'chance',
        label: `${a.label} outcome`,
        branches: outcomes.map((o, i) => ({
          label: o.label,
          probability: probs[i],
          node: { type: 'terminal', label: o.label, payoff: a.payoffs[i] },
        })),
      },
    })),
  });

  const withoutInfo = actNode(priors);

  let withInfo = null;
  if (signals?.length) {
    const marginals = signals.map((sig) =>
      priors.reduce((s, p, i) => s + p * Number(sig.likelihoods[i]), 0));
    withInfo = {
      type: 'chance',
      label: 'Signal received',
      branches: signals.map((sig, s) => {
        const pSignal = marginals[s];
        const posterior = pSignal > 0
          ? priors.map((p, i) => p * Number(sig.likelihoods[i]) / pSignal)
          : priors;
        return { label: sig.label, probability: pSignal, node: actNode(posterior) };
      }),
    };
  }

  if (!withInfo) return withoutInfo;

  return {
    type: 'decision',
    label: 'Information decision',
    branches: [
      { label: infoLabel, cost: costValue(infoCost, 'The information'), node: withInfo },
      { label: 'No further information', cost: 0, node: withoutInfo },
    ],
  };
}
