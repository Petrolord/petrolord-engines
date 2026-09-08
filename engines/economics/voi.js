// VOI Analyzer computation layer, extracted VERBATIM from the Suite's
// src/utils/voiCalculations.js in the EC0 extraction wave, 2026-09-08. The
// ONLY edit is the import: the Suite file took the canonical engine from
// '@/lib/decisionTree'; this copy takes it from './decisionTree.js' (the
// same file, vendored beside it). Percent inputs are what the Suite's form
// types (0 to 100); money is $MM. Gated by __tests__/economics.decision.test.js
// (the VOI parity cases in test-data/economics/goldens/decision_cases.json).
//
// VOI Analyzer computation layer. Since D3 the math delegates to the
// canonical decision-analysis engine (src/lib/decisionTree.js): EMV / EVPI
// come from the engine, per-indicator EMVs use bestActionEmv over the
// user-entered posteriors, and impliedPriors flags inputs whose indicator
// marginals and posteriors contradict the stated outcome priors (the user
// types those independently in this legacy input shape, so nothing forces
// them to be Bayes-consistent).
//
// Economics E2 replaced the node/link "plot data" this used to return with a
// real decision tree. Nothing rendered those nodes (the panel was a "Chart
// removed" placeholder), and their link values were not a quantity: each was
// the running EMV total multiplied by an indicator probability. The tree
// below is built by the canonical builder and rolled back by the canonical
// engine, so the picture and the KPIs cannot disagree.

import {
  bestActionEmv, evpi as engineEvpi, impliedPriors, buildInformationTree, rollback,
} from './decisionTree.js';

/**
 * Turn the legacy VOI input shape into the signal likelihoods the canonical
 * tree builder wants.
 *
 * Users type P(indicator) and P(outcome | indicator); the builder wants
 * P(indicator | outcome). Bayes inverts one into the other:
 *
 *   P(s | o) = P(o | s) * P(s) / P(o)
 *
 * This is exact and it round-trips: rolling back the built tree reproduces
 * the indicator chances and posteriors the user actually entered, whether or
 * not those are Bayes-consistent with the stated priors. The consistency
 * check stays a separate warning rather than something this quietly repairs.
 * An outcome with a zero prior cannot be conditioned on, so its column is
 * left at zero.
 */
const likelihoodsFromPosteriors = (priors, pIndicator, posteriors) =>
  priors.map((prior, i) => (prior > 0 ? (posteriors[i] * pIndicator) / prior : 0));

export const generateVoiData = (inputs) => {
    const { decisionCost, outcomes, infoScenario } = inputs;

    const engineOutcomes = outcomes.map((o) => ({ label: o.name, probability: o.probability / 100 }));
    const engineActions = [
        { label: inputs.decisionName, cost: decisionCost, payoffs: outcomes.map((o) => o.payoff) },
        { label: `Do Not ${inputs.decisionName}`, cost: 0, payoffs: outcomes.map(() => 0) },
    ];

    // --- Base Case (Without Information) ---
    const prior = bestActionEmv(engineOutcomes, engineActions);
    const emvWithoutInfo = prior.emv;
    const optimalActionWithoutInfo = engineActions[prior.actionIndex].label;

    // --- With Information (legacy shape: user-entered indicator marginals
    // and posteriors, evaluated indicator by indicator) ---
    let emvWithInfoPreCost = 0;

    infoScenario.indicators.forEach(indicator => {
        const pIndicator = indicator.probability / 100;

        const posterior = outcomes.map((o) => {
            const cp = indicator.conditionalProbabilities.find((c) => c.outcomeId === o.id);
            return (cp?.probability ?? 0) / 100;
        });
        const conditional = bestActionEmv(engineOutcomes, engineActions, posterior);

        emvWithInfoPreCost += pIndicator * conditional.emv;
    });

    const emvWithInfo = emvWithInfoPreCost - infoScenario.cost;
    const voi = emvWithInfoPreCost - emvWithoutInfo;
    const netVoi = voi - infoScenario.cost;

    // --- EVPI (canonical engine) ---
    const { evpi } = engineEvpi(engineOutcomes, engineActions);

    // --- Bayes-consistency check on the user-entered indicator set ---
    const consistency = impliedPriors(
        engineOutcomes,
        infoScenario.indicators.map((ind) => ({
            label: ind.name,
            probability: ind.probability / 100,
            posteriors: outcomes.map((o) => {
                const cp = ind.conditionalProbabilities.find((c) => c.outcomeId === o.id);
                return (cp?.probability ?? 0) / 100;
            }),
        })),
    );

    const kpis = {
        emvWithInfo: emvWithInfo.toFixed(2),
        emvWithoutInfo: emvWithoutInfo.toFixed(2),
        voi: voi.toFixed(2),
        netVoi: netVoi.toFixed(2),
        evpi: evpi.toFixed(2),
    };

    const recommendation = netVoi > 0
        ? `Since this is positive, acquiring the information is financially advantageous.`
        : netVoi < 0
            ? `Since this is negative, the information costs more than the value it adds, so acquiring it is not justified on EMV grounds.`
            : `The information exactly pays for itself, so the decision is value-neutral on EMV grounds.`;
    let insights = `The Expected Monetary Value (EMV) without new information is $${emvWithoutInfo.toFixed(2)}M, with the optimal decision being to '${optimalActionWithoutInfo}'. Acquiring the '${infoScenario.name}' for $${infoScenario.cost}M results in a final EMV of $${emvWithInfo.toFixed(2)}M. The gross Value of Information (VOI) is $${voi.toFixed(2)}M. After accounting for the cost, the Net VOI is $${netVoi.toFixed(2)}M. ${recommendation} The EVPI of $${evpi.toFixed(2)}M sets the theoretical maximum value of any information-gathering activity.`;

    if (!consistency.consistent) {
        const impliedTxt = outcomes
            .map((o, i) => `${o.name} ${(consistency.implied[i] * 100).toFixed(1)}% vs stated ${o.probability}%`)
            .join('; ');
        insights += ` Consistency warning: the indicator probabilities you entered imply different outcome chances than your stated ones (${impliedTxt}). The VOI figure is only as reliable as these inputs; consider adjusting them until they agree, or use the Decision Tree Builder, which derives them from reliabilities so they cannot disagree.`;
    }

    // Economics E2: a real decision tree, drawn by the same component the
    // Decision Tree Builder uses. This panel used to be a "Chart removed"
    // placeholder, so the app computed a tree and then showed the user an
    // empty box.
    let tree = null;
    try {
        const priors = engineOutcomes.map((o) => o.probability);
        tree = rollback(buildInformationTree({
            outcomes: engineOutcomes,
            actions: engineActions,
            signals: infoScenario.indicators.map((ind) => ({
                label: ind.name,
                likelihoods: likelihoodsFromPosteriors(
                    priors,
                    ind.probability / 100,
                    outcomes.map((o) => {
                        const cp = ind.conditionalProbabilities.find((c) => c.outcomeId === o.id);
                        return (cp?.probability ?? 0) / 100;
                    }),
                ),
            })),
            infoCost: infoScenario.cost,
            infoLabel: `Acquire ${infoScenario.name}`,
        }));
    } catch (err) {
        // A tree that cannot be built is reported as a missing diagram rather
        // than taking the whole analysis down with it; the KPIs above do not
        // depend on it.
        tree = null;
    }

    return {
        kpis,
        tree,
        insights,
        consistency,
    };
};
