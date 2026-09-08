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
// - EVPI / EVII follow the standard prior/posterior construction
//   (Newendorp & Schuyler; Mian): EVII derives the signal marginals and
//   posteriors from priors and likelihoods via Bayes, so its inputs CANNOT
//   be probabilistically inconsistent. 0 <= EVII <= EVPI always holds.

const PROB_TOL = 1e-6;

export class DecisionTreeError extends Error {
  constructor(message, nodeLabel = null) {
    super(nodeLabel ? `${message} (at node "${nodeLabel}")` : message);
    this.name = 'DecisionTreeError';
    this.nodeLabel = nodeLabel;
  }
}

// EMV basis of a terminal payoff: a plain number, or `.mean` of a
// distribution summary object.
export function payoffValue(payoff) {
  if (payoff == null) return 0;
  if (typeof payoff === 'object') {
    const m = Number(payoff.mean);
    if (!Number.isFinite(m)) {
      throw new DecisionTreeError('Distribution payoff has no finite mean');
    }
    return m;
  }
  const v = Number(payoff);
  if (!Number.isFinite(v)) throw new DecisionTreeError('Terminal payoff is not a number');
  return v;
}

/**
 * EMV rollback. Returns an annotated deep copy of the tree:
 *   every node gains `emv`;
 *   decision nodes gain `bestBranchIndex`;
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
    return { ...node, emv: payoffValue(node.payoff) };
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
      const branchValue = child.emv - (Number(b.cost) || 0);
      return { ...b, node: child, branchValue };
    });
    if (Math.abs(pSum - 1) > PROB_TOL) {
      throw new DecisionTreeError(`Chance branch probabilities sum to ${pSum.toFixed(6)}, expected 1`, node.label);
    }
    const emv = annBranches.reduce((s, b) => s + Number(b.probability) * b.branchValue, 0);
    return { ...node, branches: annBranches, emv };
  }

  if (node.type === 'decision') {
    const annBranches = branches.map((b) => {
      const child = evaluate(b.node);
      const branchValue = child.emv - (Number(b.cost) || 0);
      return { ...b, node: child, branchValue };
    });
    let best = 0;
    for (let i = 1; i < annBranches.length; i++) {
      if (annBranches[i].branchValue > annBranches[best].branchValue) best = i;
    }
    return { ...node, branches: annBranches, emv: annBranches[best].branchValue, bestBranchIndex: best };
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
  if (Math.abs(pSum - 1) > PROB_TOL) {
    throw new DecisionTreeError(`Outcome probabilities sum to ${pSum.toFixed(6)}, expected 1`);
  }
  for (const a of actions) {
    if ((a.payoffs?.length ?? 0) !== outcomes.length) {
      throw new DecisionTreeError(`Action "${a.label ?? ''}" needs one payoff per outcome`);
    }
  }
}

const actionValue = (a, probs) =>
  probs.reduce((s, p, i) => s + p * payoffValue(a.payoffs[i]), 0) - (Number(a.cost) || 0);

/** EMV of the best action under the given outcome probabilities. */
export function bestActionEmv(outcomes, actions, probs = null) {
  validateLottery(outcomes, actions);
  const p = probs ?? outcomes.map((o) => Number(o.probability));
  let best = -Infinity;
  let bestIndex = 0;
  actions.forEach((a, i) => {
    const v = actionValue(a, p);
    if (v > best) { best = v; bestIndex = i; }
  });
  return { emv: best, actionIndex: bestIndex };
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
    const bestHere = Math.max(...actions.map((a) => payoffValue(a.payoffs[i]) - (Number(a.cost) || 0)));
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
  if (!signals?.length) throw new DecisionTreeError('No signals given');
  const priors = outcomes.map((o) => Number(o.probability));

  for (let i = 0; i < outcomes.length; i++) {
    const colSum = signals.reduce((s, sig) => s + Number(sig.likelihoods?.[i] ?? NaN), 0);
    if (!Number.isFinite(colSum) || Math.abs(colSum - 1) > PROB_TOL) {
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
    const { emv, actionIndex } = bestActionEmv(outcomes, actions, posterior);
    evWithInfo += pSignal * emv;
    return { label: sig.label, pSignal, posterior, emv, bestActionIndex: actionIndex };
  });

  const eviiGross = evWithInfo - emvPrior;
  return {
    evii: eviiGross,
    netEvii: eviiGross - (Number(infoCost) || 0),
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
  const consistent = deltas.every((d) => Math.abs(d) <= 0.005);
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
      cost: Number(a.cost) || 0,
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
      { label: infoLabel, cost: Number(infoCost) || 0, node: withInfo },
      { label: 'No further information', cost: 0, node: withoutInfo },
    ],
  };
}
