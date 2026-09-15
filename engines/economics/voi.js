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
// EC4-0 (2026-09-14, owner decision): the Analyzer no longer reports a value
// of information built on numbers that contradict each other. Percent inputs
// that are not distributions are REFUSED with a DecisionTreeError naming the
// sum in percent: outcome chances, indicator chances, and each indicator's
// outcome chances. Inputs that are distributions but imply outcome chances
// other than the stated ones (impliedPriors inconsistent) keep the two cards
// that depend only on the stated priors (EMV without information and EVPI)
// and WITHHOLD the rest: emvWithInfo, voi and netVoi are null, the tree is
// null, `withheld` is true and the insight says why. Before this, such inputs
// produced full cards, including a gross VOI below zero or above EVPI, and an
// indicator whose outcome chances did not sum to 100 made the cards and the
// diagram disagree while the consistency check passed.
//
// EC4-8 and EC4-2 (2026-09-15, owner decisions): the percent tolerance
// comparison adds the engine's 1e-12 binary representation allowance, so
// three outcome chances typed 33.3333 (99.9999, exactly 1e-4 short in the
// typed decimals) are accepted while a sum off by more is still refused. Net
// VOI is rounded ONCE to card precision (2 decimal places, half away from
// zero) and that single rounded value feeds both the card and the verdict: a
// net VOI that rounds to 0.00 (|net| < 0.005) gets its own neutral sentence,
// and no card or insight ever prints "-0.00". Before, the verdict read the
// unrounded value, so a survey cost of 32.996 showed a 0.00 card under "Since
// this is positive" and 33.004 showed "-0.00" under "not justified".
//
// EC4-9 (2026-09-15, owner decision): once every typed percent input has
// passed validation, the indicator chances and each indicator's outcome
// chances are divided by their own sums before anything is computed from
// them. Validation admits sums within the tolerance of 100, and the Bayes
// inversion below multiplies two such sums into the diagram's "Signal
// received" branch: every chance typed 33.3333 made that node sum to
// 0.999998, and the strict chance node check refused a node the user never
// typed. The renormalised set feeds the cards AND the diagram, so the two
// stay one analysis. Nothing else is renormalised: the stated outcome chances
// are used as typed, the consistency check reads the typed entries, and a
// chance node typed directly in the Decision Tree Builder keeps the strict
// refusal.
//
// EC4-1 and EC4-4 (2026-09-15, owner decisions): when two or more actions
// tie on EMV without information, the Analyzer says the decision is
// indifferent between them and names them all, instead of reporting the
// first listed as the optimal decision; `bestActionWithoutInfo` carries the
// tied indices and labels. And the survey cost, the decision cost and every
// outcome payoff are read strictly by the engine: an entry that is present
// but blank, null, non-numeric or non-finite is refused naming the field,
// and a negative cost is refused. Before, a blank or non-numeric cost read
// as 0 and a negative cost read as a receipt.
//
// Economics E2 replaced the node/link "plot data" this used to return with a
// real decision tree. Nothing rendered those nodes (the panel was a "Chart
// removed" placeholder), and their link values were not a quantity: each was
// the running EMV total multiplied by an indicator probability. The tree
// below is built by the canonical builder and rolled back by the canonical
// engine, so the picture and the KPIs cannot disagree.

import {
  bestActionEmv, evpi as engineEvpi, impliedPriors, buildInformationTree, rollback,
  costValue, DecisionTreeError,
} from './decisionTree.js';

// Percent-point tolerance on every sum of percent inputs: the engine's 1e-6
// probability tolerance, on the 0 to 100 scale the form types.
const PCT_TOL = 1e-4;
const REPRESENTATION_ALLOWANCE = 1e-12;
const pctText = (v) => `${Number(v.toFixed(4))}`;

// Card precision, $MM to 2 decimal places, rounded half away from zero on
// the magnitude (with the representation allowance, so a value that is a
// half cent in exact decimals rounds the way the decimals do). Negative zero
// is normalised, so nothing ever prints "-0.00".
const toCard = (v) => {
    const magnitude = Number((Math.abs(v) + REPRESENTATION_ALLOWANCE).toFixed(2));
    return magnitude === 0 ? 0 : (v < 0 ? -magnitude : magnitude);
};
const cardText = (v) => toCard(v).toFixed(2);

const requireChance = (value, what) => {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
        throw new DecisionTreeError(`${what} needs a chance between 0 and 100 percent`);
    }
    return v;
};

const requireHundred = (sum, what) => {
    if (Math.abs(sum - 100) > PCT_TOL + REPRESENTATION_ALLOWANCE) {
        throw new DecisionTreeError(`${what} sum to ${pctText(sum)} percent, expected 100`);
    }
};

/**
 * Refuse percent inputs that are not distributions, before anything is
 * computed from them. Returns each indicator's outcome chances as fractions,
 * in outcome order (a missing entry counts as 0 and so fails its sum).
 */
const validatePercentInputs = (outcomes, indicators) => {
    if (!outcomes?.length) throw new DecisionTreeError('No outcomes given');
    requireHundred(
        outcomes.reduce((s, o) => s + requireChance(o.probability, `Outcome "${o.name ?? ''}"`), 0),
        'Outcome chances',
    );
    if (!indicators?.length) throw new DecisionTreeError('No indicators given');
    requireHundred(
        indicators.reduce((s, ind) => s + requireChance(ind.probability, `Indicator "${ind.name ?? ''}"`), 0),
        'Indicator chances',
    );
    return indicators.map((ind) => {
        const chances = outcomes.map((o) => {
            const cp = (ind.conditionalProbabilities || []).find((c) => c.outcomeId === o.id);
            return requireChance(cp?.probability ?? 0, `P(${o.name ?? ''} | ${ind.name ?? ''})`);
        });
        requireHundred(chances.reduce((s, v) => s + v, 0), `Outcome chances given "${ind.name ?? ''}"`);
        return chances.map((v) => v / 100);
    });
};

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
 * the indicator chances and posteriors the user actually entered. An outcome
 * with a zero prior cannot be conditioned on, so its column is left at zero.
 */
/** Divide a validated set of chances by its sum (EC4-9). */
const unitSum = (xs) => {
    const total = xs.reduce((s, x) => s + x, 0);
    return xs.map((x) => x / total);
};

const likelihoodsFromPosteriors = (priors, pIndicator, posteriors) =>
  priors.map((prior, i) => (prior > 0 ? (posteriors[i] * pIndicator) / prior : 0));

export const generateVoiData = (inputs) => {
    const { decisionCost, outcomes, infoScenario } = inputs;
    const indicators = infoScenario?.indicators;

    // EC4-0: refuse what is not a distribution, in percent, before computing.
    const posteriors = validatePercentInputs(outcomes, indicators);
    // EC4-4: the survey cost is money, read strictly before anything uses it.
    const infoCost = costValue(infoScenario.cost, `Information scenario "${infoScenario?.name ?? ''}"`);

    const engineOutcomes = outcomes.map((o) => ({ label: o.name, probability: o.probability / 100 }));
    const engineActions = [
        { label: inputs.decisionName, cost: decisionCost, payoffs: outcomes.map((o) => o.payoff) },
        { label: `Do Not ${inputs.decisionName}`, cost: 0, payoffs: outcomes.map(() => 0) },
    ];

    // --- Base Case (Without Information) ---
    const prior = bestActionEmv(engineOutcomes, engineActions);
    const emvWithoutInfo = prior.emv;
    const optimalActionWithoutInfo = engineActions[prior.actionIndex].label;
    // EC4-1: every action within the tie band of the best, in listed order.
    const tiedLabels = prior.tiedIndices.map((i) => engineActions[i].label);
    const bestActionWithoutInfo = {
        actionIndex: prior.actionIndex,
        label: optimalActionWithoutInfo,
        tiedIndices: prior.tiedIndices,
        tiedLabels,
        indifferent: prior.indifferent,
    };
    const quotedList = (labels) => labels.map((l) => `'${l}'`)
        .reduce((text, l, i) => (i === 0 ? l : `${text}${i === labels.length - 1 ? ' and ' : ', '}${l}`), '');

    // --- EVPI (canonical engine) ---
    const { evpi } = engineEvpi(engineOutcomes, engineActions);

    // --- Bayes-consistency check on the user-entered indicator set ---
    const consistency = impliedPriors(
        engineOutcomes,
        indicators.map((ind, k) => ({ label: ind.name, probability: ind.probability / 100, posteriors: posteriors[k] })),
    );

    const baseInsight = prior.indifferent
        ? `The Expected Monetary Value (EMV) without new information is $${cardText(emvWithoutInfo)}M, and ${quotedList(tiedLabels)} carry the same EMV, so the decision without new information is indifferent between them.`
        : `The Expected Monetary Value (EMV) without new information is $${cardText(emvWithoutInfo)}M, with the optimal decision being to '${optimalActionWithoutInfo}'.`;
    const evpiInsight = `The EVPI of $${cardText(evpi)}M sets the theoretical maximum value of any information-gathering activity.`;

    if (!consistency.consistent) {
        const impliedTxt = outcomes
            .map((o, i) => `${o.name} ${(consistency.implied[i] * 100).toFixed(1)}% vs stated ${o.probability}%`)
            .join('; ');
        return {
            kpis: {
                emvWithInfo: null,
                emvWithoutInfo: cardText(emvWithoutInfo),
                voi: null,
                netVoi: null,
                evpi: cardText(evpi),
            },
            tree: null,
            withheld: true,
            bestActionWithoutInfo,
            insights: `${baseInsight} ${evpiInsight} Consistency warning: the indicator probabilities you entered imply different outcome chances than your stated ones (${impliedTxt}), so the value of the '${infoScenario.name}' is withheld rather than computed from numbers that contradict each other. Adjust the indicator chances or their outcome chances until they agree, or use the Decision Tree Builder, which derives them from reliabilities so they cannot disagree.`,
            consistency,
        };
    }

    // --- With Information (legacy shape: user-entered indicator marginals
    // and posteriors, evaluated indicator by indicator) ---
    // EC4-9: every typed input passed validation above, so the derived
    // branch probabilities are renormalised to sum to exactly 1.
    const indicatorChances = unitSum(indicators.map((ind) => ind.probability / 100));
    const outcomeChancesGiven = posteriors.map(unitSum);
    let emvWithInfoPreCost = 0;
    indicators.forEach((indicator, k) => {
        const conditional = bestActionEmv(engineOutcomes, engineActions, outcomeChancesGiven[k]);
        emvWithInfoPreCost += indicatorChances[k] * conditional.emv;
    });

    const emvWithInfo = emvWithInfoPreCost - infoCost;
    const voi = emvWithInfoPreCost - emvWithoutInfo;
    const netVoi = voi - infoCost;

    // EC4-2: net VOI is rounded once; the card and the verdict read the same
    // rounded value.
    const netVoiCard = toCard(netVoi);

    const kpis = {
        emvWithInfo: cardText(emvWithInfo),
        emvWithoutInfo: cardText(emvWithoutInfo),
        voi: cardText(voi),
        netVoi: netVoiCard.toFixed(2),
        evpi: cardText(evpi),
    };

    const recommendation = netVoiCard > 0
        ? `Since this is positive, acquiring the information is financially advantageous.`
        : netVoiCard < 0
            ? `Since this is negative, the information costs more than the value it adds, so acquiring it is not justified on EMV grounds.`
            : `Since this rounds to zero, the information costs what it is worth, so acquiring it or not is indifferent on EMV grounds.`;
    const insights = `${baseInsight} Acquiring the '${infoScenario.name}' for $${infoScenario.cost}M results in a final EMV of $${kpis.emvWithInfo}M. The gross Value of Information (VOI) is $${kpis.voi}M. After accounting for the cost, the Net VOI is $${kpis.netVoi}M. ${recommendation} ${evpiInsight}`;

    // Economics E2: a real decision tree, drawn by the same component the
    // Decision Tree Builder uses. With every percent input a distribution
    // (checked above) the inverted likelihoods reproduce the entered chances
    // exactly, so the picture and the KPIs are one analysis.
    const priors = engineOutcomes.map((o) => o.probability);
    const tree = rollback(buildInformationTree({
        outcomes: engineOutcomes,
        actions: engineActions,
        signals: indicators.map((ind, k) => ({
            label: ind.name,
            likelihoods: likelihoodsFromPosteriors(priors, indicatorChances[k], outcomeChancesGiven[k]),
        })),
        infoCost,
        infoLabel: `Acquire ${infoScenario.name}`,
    }));

    return {
        kpis,
        tree,
        withheld: false,
        insights,
        consistency,
        bestActionWithoutInfo,
    };
};
