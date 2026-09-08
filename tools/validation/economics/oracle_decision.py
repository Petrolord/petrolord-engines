#!/usr/bin/env python3
"""Independent oracle for the Economics decision-analysis engine
(engines/economics/decisionTree.js) and the VOI Analyzer computation layer
built on it (engines/economics/voi.js). Emits committed goldens to
test-data/economics/goldens/decision_cases.json.

INDEPENDENCE DISCIPLINE. This file is written from the METHOD STATEMENTS the
engine documents (Newendorp and Schuyler; Mian) and NOT by transcribing the
JavaScript:

  EMV rollback      a terminal is worth its payoff (the mean of a
                    distribution summary); a chance node is worth the
                    probability weighted sum of (child value minus branch
                    cost); a decision node is worth the MAX of (child value
                    minus branch cost) over its branches, the rational
                    risk-neutral actor. Ties at a decision resolve to the
                    first branch listed. Every branch reachable by taking
                    the best decision at every decision node is on the
                    optimal path. Probabilities at a chance node must be a
                    distribution: each in [0, 1], summing to 1. Anything else
                    is REFUSED, not repaired.

  EVPI              E over outcomes of the best (payoff minus cost) given
                    the outcome, minus the best expected (payoff minus cost)
                    under the priors. Written directly in that closed form.

  EVII              signal marginals P(s) = sum_o P(o) P(s|o) and posteriors
                    P(o|s) = P(o) P(s|o) / P(s) through Bayes; the value with
                    information is sum_s P(s) max_a E[payoff minus cost | s];
                    EVII is that minus the prior best. Likelihood columns
                    (over signals, for a fixed outcome) must sum to 1 or the
                    case is refused. A signal that cannot occur (P(s) = 0)
                    contributes nothing; its posterior is reported as the
                    prior, the engine's documented fallback.
                    Identities the oracle asserts on every case:
                    0 <= EVII <= EVPI; a signal with identical likelihood
                    rows for every outcome is worth 0; a perfect signal is
                    worth exactly EVPI.

  implied priors    P_implied(o) = sum_i P(i) P(o|i) from independently
                    typed indicator marginals and posteriors; consistent when
                    every delta against the stated prior is within half a
                    percent (0.005), the engine's documented threshold.

  information tree  the classic single-stage tree, BUILT HERE from the
                    method statement (decision: acquire or not; acquire leads
                    to a chance node over signals at their marginals, each to
                    a decision over actions, each to a chance node over
                    outcomes at the posterior, each to a terminal at the
                    payoff) and rolled back by the oracle's own rollback. The
                    golden carries every node and branch value, and the
                    closed-form identities root = max(evWithInfo minus cost,
                    emvPrior) are asserted before anything is emitted.

  VOI Analyzer      the legacy input shape: percent priors, percent
                    indicator marginals, percent posteriors typed
                    independently. EMV without information is the better of
                    acting (sum prior payoff minus decision cost) and not
                    acting (0). Per indicator, the best action under the
                    ENTERED posteriors, whether or not those sum to 1 (the
                    method statement is explicit that nothing repairs them);
                    EMV with information before cost is the marginal
                    weighted sum; VOI is the difference; net VOI subtracts
                    the information cost; EVPI from the closed form. The
                    verdict is 'acquire' for net VOI > 0, 'reject' for < 0,
                    'neutral' at exactly 0. The diagram is the information
                    tree above with the ENTERED marginals and posteriors
                    (the Bayes inversion the engine performs round-trips
                    exactly, which is a theorem, not an implementation
                    detail), and it is drawable only when those entries form
                    distributions; otherwise the analysis reports no tree.

  arithmetic        every probability and payoff is a fractions.Fraction, so
                    each golden number is EXACT before it is emitted as a
                    float. The engine works in binary floating point on the
                    float images of the same inputs; the jest gate allows
                    1e-9 absolute on unrounded quantities and half a cent on
                    the VOI Analyzer's two-decimal KPI strings.

Money is USD millions ($MM) throughout, the unit of the Suite's Decision
Tree Builder and VOI Analyzer. Percent inputs to the VOI Analyzer are 0 to
100, exactly what its form types.

stdlib only. Regenerate (deterministic, byte identical):
    python3 tools/validation/economics/oracle_decision.py
"""
import json
import os
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'test-data', 'economics',
                                    'goldens', 'decision_cases.json'))

CONSISTENCY_TOL = F(5, 1000)


class Refused(Exception):
    """The oracle refuses an input the method statement does not admit."""


# ---------------------------------------------------------------------
# Serialisation: Fractions to floats, recursively.
# ---------------------------------------------------------------------

def out(x):
    if isinstance(x, bool) or x is None or isinstance(x, str):
        return x
    if isinstance(x, F):
        return float(x)
    if isinstance(x, int):
        return x
    if isinstance(x, float):
        return x
    if isinstance(x, dict):
        return {k: out(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [out(v) for v in x]
    raise TypeError(type(x))


# ---------------------------------------------------------------------
# EMV rollback.
# ---------------------------------------------------------------------

def payoff_value(p):
    if p is None:
        return F(0)
    if isinstance(p, dict):
        return F(p['mean'])
    return F(p)


def is_distribution(probs):
    return all(F(0) <= p <= F(1) for p in probs) and sum(probs, F(0)) == 1


def evaluate(node):
    """Return an annotated copy: emv on every node, bestBranchIndex on
    decisions, branchValue on every branch."""
    if node is None or not isinstance(node, dict):
        raise Refused('missing node')
    t = node.get('type')
    if t == 'terminal':
        return {'type': t, 'emv': payoff_value(node.get('payoff'))}
    branches = node.get('branches') or []
    if not branches:
        raise Refused('node without branches')
    if t == 'chance':
        probs = [F(b['probability']) for b in branches]
        if not is_distribution(probs):
            raise Refused('chance probabilities are not a distribution')
        ann = []
        emv = F(0)
        for b, p in zip(branches, probs):
            child = evaluate(b.get('node'))
            bv = child['emv'] - F(b.get('cost', 0) or 0)
            ann.append({'branchValue': bv, 'node': child, 'probability': p})
            emv += p * bv
        return {'type': t, 'emv': emv, 'branches': ann}
    if t == 'decision':
        ann = []
        for b in branches:
            child = evaluate(b.get('node'))
            bv = child['emv'] - F(b.get('cost', 0) or 0)
            ann.append({'branchValue': bv, 'node': child})
        best = max(range(len(ann)), key=lambda i: (ann[i]['branchValue'], -i))
        return {'type': t, 'emv': ann[best]['branchValue'], 'branches': ann,
                'bestBranchIndex': best}
    raise Refused('unknown node type %r' % t)


def mark(node, on_path):
    if node['type'] == 'terminal':
        return
    for i, b in enumerate(node['branches']):
        here = on_path and (node['type'] == 'chance' or i == node['bestBranchIndex'])
        b['onOptimalPath'] = here
        mark(b['node'], here)


def rollback(tree):
    ann = evaluate(tree)
    mark(ann, True)
    return ann


def flatten(ann):
    """Every node and every branch, addressed by its path of branch indices
    from the root, so a gate can walk the engine's annotated tree."""
    nodes, branches = [], []

    def walk(node, path):
        rec = {'path': list(path), 'type': node['type'], 'emv': node['emv']}
        if node['type'] == 'decision':
            rec['bestBranchIndex'] = node['bestBranchIndex']
        nodes.append(rec)
        if node['type'] == 'terminal':
            return
        for i, b in enumerate(node['branches']):
            branches.append({'path': list(path) + [i], 'branchValue': b['branchValue'],
                             'onOptimalPath': b['onOptimalPath']})
            walk(b['node'], list(path) + [i])

    walk(ann, [])
    return nodes, branches


def rollback_expected(ann):
    nodes, branches = flatten(ann)
    exp = {'emv': ann['emv'], 'nodes': nodes, 'branches': branches}
    if ann['type'] == 'decision':
        exp['bestBranchIndex'] = ann['bestBranchIndex']
    return exp


# ---------------------------------------------------------------------
# Single-stage information value: EVPI, EVII, implied priors.
# ---------------------------------------------------------------------

def check_lottery(outcomes, actions):
    if not outcomes or not actions:
        raise Refused('empty lottery')
    if not is_distribution([F(o['probability']) for o in outcomes]):
        raise Refused('priors are not a distribution')
    for a in actions:
        if len(a['payoffs']) != len(outcomes):
            raise Refused('payoff count')


def action_value(a, probs):
    return sum((p * payoff_value(v) for p, v in zip(probs, a['payoffs'])), F(0)) - F(a.get('cost', 0) or 0)


def best_action(outcomes, actions, probs=None):
    """(emv, index) of the best action; ties to the first listed."""
    check_lottery(outcomes, actions)
    p = probs if probs is not None else [F(o['probability']) for o in outcomes]
    vals = [action_value(a, p) for a in actions]
    best = max(range(len(vals)), key=lambda i: (vals[i], -i))
    return vals[best], best


def evpi(outcomes, actions):
    check_lottery(outcomes, actions)
    priors = [F(o['probability']) for o in outcomes]
    emv_prior, best_prior = best_action(outcomes, actions)
    ev_perfect = F(0)
    per_outcome = []
    for i, p in enumerate(priors):
        vals = [payoff_value(a['payoffs'][i]) - F(a.get('cost', 0) or 0) for a in actions]
        b = max(range(len(vals)), key=lambda k: (vals[k], -k))
        per_outcome.append(b)
        ev_perfect += p * vals[b]
    return {'emvPrior': emv_prior, 'bestActionIndex': best_prior,
            'evWithPerfect': ev_perfect, 'evpi': ev_perfect - emv_prior,
            'perfectBestActionIndex': per_outcome}


def evii(outcomes, actions, signals, info_cost=0):
    check_lottery(outcomes, actions)
    if not signals:
        raise Refused('no signals')
    priors = [F(o['probability']) for o in outcomes]
    n = len(outcomes)
    for i in range(n):
        col = sum((F(s['likelihoods'][i]) for s in signals), F(0))
        if col != 1:
            raise Refused('likelihood column %d sums to %s' % (i, col))
    emv_prior, _ = best_action(outcomes, actions)
    ev_info = F(0)
    per_signal = []
    for s in signals:
        joint = [priors[i] * F(s['likelihoods'][i]) for i in range(n)]
        p_s = sum(joint, F(0))
        post = [j / p_s for j in joint] if p_s > 0 else list(priors)
        emv_s, idx = best_action(outcomes, actions, post)
        ev_info += p_s * emv_s
        per_signal.append({'pSignal': p_s, 'posterior': post, 'emv': emv_s,
                           'bestActionIndex': idx})
    gross = ev_info - emv_prior
    return {'emvPrior': emv_prior, 'evWithInfo': ev_info, 'evii': gross,
            'netEvii': gross - F(info_cost or 0), 'perSignal': per_signal}


def implied_priors(outcomes, indicators):
    stated = [F(o['probability']) for o in outcomes]
    implied = []
    for i in range(len(outcomes)):
        implied.append(sum((F(ind['probability']) * F((ind.get('posteriors') or [])[i] if i < len(ind.get('posteriors') or []) else 0)
                            for ind in indicators), F(0)))
    deltas = [v - s for v, s in zip(implied, stated)]
    return {'stated': stated, 'implied': implied, 'deltas': deltas,
            'consistent': all(abs(d) <= CONSISTENCY_TOL for d in deltas)}


# ---------------------------------------------------------------------
# The information tree, built from the method statement.
# ---------------------------------------------------------------------

def act_node(outcomes, actions, probs):
    return {
        'type': 'decision', 'label': 'Choose action',
        'branches': [{
            'label': a['label'], 'cost': F(a.get('cost', 0) or 0),
            'node': {
                'type': 'chance', 'label': '%s outcome' % a['label'],
                'branches': [{
                    'label': o['label'], 'probability': probs[i],
                    'node': {'type': 'terminal', 'label': o['label'], 'payoff': a['payoffs'][i]},
                } for i, o in enumerate(outcomes)],
            },
        } for a in actions],
    }


def information_tree(outcomes, actions, marginals, posteriors, signals_labels,
                     info_cost, info_label):
    """Signals at the given marginals, each leading to an action decision
    under the given posterior. The caller supplies marginals and posteriors,
    either derived by Bayes from likelihoods or entered directly."""
    priors = [F(o['probability']) for o in outcomes]
    without = act_node(outcomes, actions, priors)
    if not signals_labels:
        return without
    with_info = {
        'type': 'chance', 'label': 'Signal received',
        'branches': [{'label': lab, 'probability': marginals[s],
                      'node': act_node(outcomes, actions, posteriors[s])}
                     for s, lab in enumerate(signals_labels)],
    }
    return {
        'type': 'decision', 'label': 'Information decision',
        'branches': [
            {'label': info_label, 'cost': F(info_cost or 0), 'node': with_info},
            {'label': 'No further information', 'cost': F(0), 'node': without},
        ],
    }


def bayes(outcomes, signals):
    priors = [F(o['probability']) for o in outcomes]
    marg, post = [], []
    for s in signals:
        joint = [priors[i] * F(s['likelihoods'][i]) for i in range(len(outcomes))]
        p_s = sum(joint, F(0))
        marg.append(p_s)
        post.append([j / p_s for j in joint] if p_s > 0 else list(priors))
    return marg, post


# ---------------------------------------------------------------------
# VOI Analyzer (legacy percent input shape).
# ---------------------------------------------------------------------

def voi_analyzer(inputs):
    pct = lambda v: F(v) / 100  # noqa: E731
    outcomes = [{'label': o['name'], 'probability': pct(o['probability'])} for o in inputs['outcomes']]
    act_label = inputs['decisionName']
    actions = [
        {'label': act_label, 'cost': F(inputs['decisionCost']), 'payoffs': [o['payoff'] for o in inputs['outcomes']]},
        {'label': 'Do Not %s' % act_label, 'cost': F(0), 'payoffs': [0 for _ in inputs['outcomes']]},
    ]
    info = inputs['infoScenario']
    emv_without, idx = best_action(outcomes, actions)
    optimal_without = actions[idx]['label']

    def posterior_of(ind):
        post = []
        for o in inputs['outcomes']:
            cp = [c for c in ind['conditionalProbabilities'] if c['outcomeId'] == o['id']]
            post.append(pct(cp[0]['probability']) if cp else F(0))
        return post

    marginals = [pct(ind['probability']) for ind in info['indicators']]
    posteriors = [posterior_of(ind) for ind in info['indicators']]
    labels = [ind['name'] for ind in info['indicators']]

    emv_with_pre = F(0)
    per_indicator = []
    for m, post in zip(marginals, posteriors):
        e, k = best_action(outcomes, actions, post)
        emv_with_pre += m * e
        per_indicator.append({'emv': e, 'bestActionIndex': k})
    cost = F(info['cost'])
    emv_with = emv_with_pre - cost
    voi = emv_with_pre - emv_without
    net = voi - cost
    ev = evpi(outcomes, actions)['evpi']
    cons = implied_priors(outcomes, [{'probability': m, 'posteriors': p} for m, p in zip(marginals, posteriors)])
    verdict = 'acquire' if net > 0 else ('reject' if net < 0 else 'neutral')

    exp = {
        'emvWithoutInfo': emv_without, 'emvWithInfo': emv_with, 'voi': voi, 'netVoi': net,
        'evpi': ev, 'optimalActionWithoutInfo': optimal_without, 'verdict': verdict,
        'perIndicator': per_indicator,
        'consistency': cons,
    }
    tree = information_tree(outcomes, actions, marginals, posteriors, labels, cost,
                            'Acquire %s' % info['name'])
    try:
        ann = rollback(tree)
    except Refused:
        exp['treePresent'] = False
        return exp
    exp['treePresent'] = True
    exp['tree'] = rollback_expected(ann)
    exp['signalChances'] = marginals
    exp['acquireBranchValue'] = ann['branches'][0]['branchValue']
    exp['noInfoBranchValue'] = ann['branches'][1]['branchValue']
    # The picture and the KPI card must be the same analysis.
    assert exp['acquireBranchValue'] == emv_with
    assert exp['noInfoBranchValue'] == emv_without
    return exp


# ---------------------------------------------------------------------
# Shared fixtures (the Suite's hand-derived prospect and VOI defaults).
# ---------------------------------------------------------------------

def fr(v):
    return F(v) if not isinstance(v, F) else v


OUTCOMES = [{'label': 'Success', 'probability': F(3, 10)},
            {'label': 'Dry hole', 'probability': F(7, 10)}]
ACTIONS = [{'label': 'Drill', 'cost': 40, 'payoffs': [300, -10]},
           {'label': 'Farm out', 'cost': 0, 'payoffs': [60, 0]},
           {'label': 'Do nothing', 'cost': 0, 'payoffs': [0, 0]}]
SIGNALS = [{'label': 'Positive seismic', 'likelihoods': [F(8, 10), F(3, 10)]},
           {'label': 'Negative seismic', 'likelihoods': [F(2, 10), F(7, 10)]}]

# Three outcomes, four actions, three signals: a wider lottery so the gate
# is not proven on binary cases alone.
OUTCOMES3 = [{'label': 'Large', 'probability': F(2, 10)},
             {'label': 'Medium', 'probability': F(5, 10)},
             {'label': 'Dry', 'probability': F(3, 10)}]
ACTIONS4 = [{'label': 'Drill alone', 'cost': 60, 'payoffs': [500, 150, -20]},
            {'label': 'Drill with partner', 'cost': 30, 'payoffs': [250, 75, -10]},
            {'label': 'Farm out', 'cost': 0, 'payoffs': [80, 30, 0]},
            {'label': 'Relinquish', 'cost': 0, 'payoffs': [0, 0, 0]}]
SIGNALS3 = [{'label': 'Bright', 'likelihoods': [F(7, 10), F(3, 10), F(1, 10)]},
            {'label': 'Flat', 'likelihoods': [F(2, 10), F(5, 10), F(3, 10)]},
            {'label': 'Dim', 'likelihoods': [F(1, 10), F(2, 10), F(6, 10)]}]


def terminal(label, payoff):
    return {'type': 'terminal', 'label': label, 'payoff': payoff}


def drill_tree():
    return {
        'type': 'decision', 'label': 'Prospect decision',
        'branches': [
            {'label': 'Drill', 'cost': 40, 'node': {
                'type': 'chance', 'label': 'Drill outcome',
                'branches': [
                    {'label': 'Success', 'probability': F(3, 10), 'node': terminal('Success', 300)},
                    {'label': 'Dry hole', 'probability': F(7, 10), 'node': terminal('Dry hole', -10)},
                ]}},
            {'label': 'Farm out', 'cost': 0, 'node': {
                'type': 'chance', 'label': 'Farm-out outcome',
                'branches': [
                    {'label': 'Success', 'probability': F(3, 10), 'node': terminal('Carried success', 60)},
                    {'label': 'Dry hole', 'probability': F(7, 10), 'node': terminal('Dry hole', 0)},
                ]}},
            {'label': 'Do nothing', 'cost': 0, 'node': terminal('Walk away', 0)},
        ],
    }


def two_stage_tree():
    return {
        'type': 'decision', 'label': 'root',
        'branches': [{'label': 'Test', 'cost': 5, 'node': {
            'type': 'chance', 'label': 'test result',
            'branches': [
                {'label': 'Good', 'probability': F(4, 10), 'node': {
                    'type': 'decision', 'label': 'after good',
                    'branches': [
                        {'label': 'Develop', 'cost': 50, 'node': terminal('Develop', 200)},
                        {'label': 'Sell', 'cost': 0, 'node': terminal('Sell', 80)},
                    ]}},
                {'label': 'Bad', 'probability': F(6, 10), 'node': terminal('Bad', 20)},
            ]}}],
    }


VOI_DEFAULTS = {
    'projectName': 'Test Prospect',
    'decisionName': 'Drill Exploration Well',
    'decisionCost': 40,
    'outcomes': [
        {'id': 1, 'name': 'Success Case', 'probability': 30, 'payoff': 300},
        {'id': 2, 'name': 'Dry Hole', 'probability': 70, 'payoff': -50},
    ],
    'infoScenario': {
        'name': '3D Seismic Survey',
        'cost': 10,
        'indicators': [
            {'id': 1, 'name': 'Positive Seismic', 'probability': 40,
             'conditionalProbabilities': [{'outcomeId': 1, 'probability': 60}, {'outcomeId': 2, 'probability': 40}]},
            {'id': 2, 'name': 'Negative Seismic', 'probability': 60,
             'conditionalProbabilities': [{'outcomeId': 1, 'probability': 10}, {'outcomeId': 2, 'probability': 90}]},
        ],
    },
}


def voi_inputs(cost=10, pos_probability=40, pos_post=(60, 40), neg_post=(10, 90)):
    d = json.loads(json.dumps(VOI_DEFAULTS))
    d['infoScenario']['cost'] = cost
    ind = d['infoScenario']['indicators']
    ind[0]['probability'] = pos_probability
    ind[1]['probability'] = 100 - pos_probability
    ind[0]['conditionalProbabilities'][0]['probability'] = pos_post[0]
    ind[0]['conditionalProbabilities'][1]['probability'] = pos_post[1]
    ind[1]['conditionalProbabilities'][0]['probability'] = neg_post[0]
    ind[1]['conditionalProbabilities'][1]['probability'] = neg_post[1]
    return d


def voi_inputs_at_accuracy(a, cost=10):
    """Bayes-consistent indicators for a symmetric signal of accuracy a
    (P(pos|success) = P(neg|dry) = a) against the 30/70 default priors,
    expressed in the percent shape the analyzer types."""
    a = F(a)
    p_s, p_d = F(3, 10), F(7, 10)
    p_pos = p_s * a + p_d * (1 - a)
    p_neg = 1 - p_pos
    post_pos = [p_s * a / p_pos, p_d * (1 - a) / p_pos]
    post_neg = [p_s * (1 - a) / p_neg, p_d * a / p_neg]
    return voi_inputs(cost=cost, pos_probability=p_pos * 100,
                      pos_post=(post_pos[0] * 100, post_pos[1] * 100),
                      neg_post=(post_neg[0] * 100, post_neg[1] * 100))


# ---------------------------------------------------------------------
# Case builders.
# ---------------------------------------------------------------------

def rollback_cases():
    cases = []

    def add(cid, desc, tree):
        ann = rollback(tree)
        cases.append({'id': cid, 'description': desc, 'tree': tree,
                      'expected': rollback_expected(ann)})

    add('drillFarmOut',
        'Suite decisionTree.test.js + templates.js drillFarmOut: P(success) 0.3; drill cost 40 with 300 / -10; farm out 60 / 0; do nothing 0. EMV 43, drill optimal.',
        drill_tree())
    add('twoStageSequential',
        'Suite: test (cost 5) then good 0.4 / bad 0.6; after good develop (cost 50, 200) vs sell 80; after bad 20. Root 0.4*150 + 0.6*20 - 5 = 67.',
        two_stage_tree())
    add('distributionPayoff',
        'Suite: a terminal carrying a distribution summary is worth its mean; 0.5*100 + 0.5*50 = 75.',
        {'type': 'chance', 'label': 'c', 'branches': [
            {'label': 'a', 'probability': F(1, 2), 'node': {'type': 'terminal', 'payoff': {'mean': 100, 'p90': 40, 'p50': 95, 'p10': 180, 'ref': 'mc-run'}}},
            {'label': 'b', 'probability': F(1, 2), 'node': terminal('b', 50)},
        ]})
    add('terminalRoot', 'Degenerate: a lone terminal rolls back to its payoff.', terminal('only', -12.5))
    add('singleBranchChance',
        'Degenerate: a chance node with one branch at probability 1 is worth its child less the branch cost.',
        {'type': 'chance', 'label': 'certain', 'branches': [
            {'label': 'only', 'probability': 1, 'cost': 7, 'node': terminal('x', 50)}]})
    add('singleBranchDecision',
        'Degenerate: a decision with one branch has no choice; bestBranchIndex 0.',
        {'type': 'decision', 'label': 'forced', 'branches': [
            {'label': 'only', 'cost': 3, 'node': terminal('x', 10)}]})
    add('equalEmvTie',
        'Degenerate: a decision whose branches tie exactly (both 30) resolves to the first branch listed; the optimal path follows it and not the other.',
        {'type': 'decision', 'label': 'tie', 'branches': [
            {'label': 'A', 'cost': 10, 'node': terminal('A', 40)},
            {'label': 'B', 'cost': 0, 'node': {'type': 'chance', 'label': 'Bc', 'branches': [
                {'label': 'hi', 'probability': F(1, 4), 'node': terminal('hi', 60)},
                {'label': 'lo', 'probability': F(3, 4), 'node': terminal('lo', 20)}]}},
            {'label': 'C', 'cost': 0, 'node': terminal('C', 29.999)},
        ]})
    add('allNegative',
        'Degenerate: every payoff negative; the best decision is the least bad, and costs still subtract.',
        {'type': 'decision', 'label': 'least bad', 'branches': [
            {'label': 'A', 'cost': 5, 'node': {'type': 'chance', 'label': 'Ac', 'branches': [
                {'label': 'p', 'probability': F(1, 3), 'node': terminal('p', -30)},
                {'label': 'q', 'probability': F(2, 3), 'node': terminal('q', -60)}]}},
            {'label': 'B', 'cost': 0, 'node': terminal('B', -52)},
        ]})
    add('thirdsProbabilities',
        'Boundary: probabilities of one third each, which no binary float represents; the engine must accept the float images and agree with the exact result.',
        {'type': 'chance', 'label': 'thirds', 'branches': [
            {'label': 'a', 'probability': F(1, 3), 'node': terminal('a', 90)},
            {'label': 'b', 'probability': F(1, 3), 'node': terminal('b', 30)},
            {'label': 'c', 'probability': F(1, 3), 'node': terminal('c', -15)},
        ]})
    add('chanceRootWithBranchCosts',
        'Chance at the root with a cost on every branch and a nested decision under one of them; EMV subtracts the branch costs before weighting.',
        {'type': 'chance', 'label': 'weather', 'branches': [
            {'label': 'calm', 'probability': F(6, 10), 'cost': 2, 'node': {'type': 'decision', 'label': 'go', 'branches': [
                {'label': 'sail', 'cost': 1, 'node': terminal('sail', 20)},
                {'label': 'wait', 'cost': 0, 'node': terminal('wait', 5)}]}},
            {'label': 'storm', 'probability': F(4, 10), 'cost': 8, 'node': terminal('storm', -25)},
        ]})
    add('missingCostAndNullPayoff',
        'Boundary: absent cost fields count as 0 and a null payoff is worth 0.',
        {'type': 'decision', 'label': 'sparse', 'branches': [
            {'label': 'A', 'node': terminal('A', None)},
            {'label': 'B', 'node': {'type': 'chance', 'label': 'Bc', 'branches': [
                {'label': 'x', 'probability': F(1, 2), 'node': terminal('x', 8)},
                {'label': 'y', 'probability': F(1, 2), 'node': terminal('y', -2)}]}},
        ]})
    add('deepAlternation',
        'Four levels of alternating decision and chance nodes, so optimal-path marking is checked below the second level.',
        {'type': 'decision', 'label': 'L0', 'branches': [
            {'label': 'go', 'cost': 4, 'node': {'type': 'chance', 'label': 'L1', 'branches': [
                {'label': 'up', 'probability': F(1, 2), 'node': {'type': 'decision', 'label': 'L2', 'branches': [
                    {'label': 'push', 'cost': 6, 'node': {'type': 'chance', 'label': 'L3', 'branches': [
                        {'label': 'win', 'probability': F(7, 10), 'node': terminal('win', 50)},
                        {'label': 'lose', 'probability': F(3, 10), 'node': terminal('lose', -20)}]}},
                    {'label': 'hold', 'cost': 0, 'node': terminal('hold', 12)}]}},
                {'label': 'down', 'probability': F(1, 2), 'node': terminal('down', -3)}]}},
            {'label': 'stop', 'cost': 0, 'node': terminal('stop', 1)},
        ]})
    return cases


def rollback_refusals():
    cases = []

    def add(cid, desc, tree, reason):
        try:
            rollback(tree)
        except Refused:
            pass
        else:
            raise AssertionError('oracle accepted %s' % cid)
        cases.append({'id': cid, 'description': desc, 'tree': tree, 'reason': reason})

    add('probabilitiesSumBelowOne', 'Suite: chance probabilities 0.5 + 0.4 do not sum to 1.',
        {'type': 'chance', 'label': 'bad', 'branches': [
            {'label': 'a', 'probability': F(1, 2), 'node': terminal('a', 1)},
            {'label': 'b', 'probability': F(2, 5), 'node': terminal('b', 1)}]},
        'probabilities sum to 0.9')
    add('probabilitiesSumAboveOne', 'Chance probabilities 0.6 + 0.6 exceed 1.',
        {'type': 'chance', 'label': 'bad', 'branches': [
            {'label': 'a', 'probability': F(3, 5), 'node': terminal('a', 1)},
            {'label': 'b', 'probability': F(3, 5), 'node': terminal('b', 1)}]},
        'probabilities sum to 1.2')
    add('probabilityAboveOne', 'A single branch probability of 1.5 is not a probability even though the sum could be made to fit.',
        {'type': 'chance', 'label': 'bad', 'branches': [
            {'label': 'a', 'probability': F(3, 2), 'node': terminal('a', 1)},
            {'label': 'b', 'probability': F(-1, 2), 'node': terminal('b', 1)}]},
        'probability outside [0, 1]')
    add('emptyBranches', 'A decision node with no branches has nothing to decide.',
        {'type': 'decision', 'label': 'empty', 'branches': []}, 'no branches')
    add('unknownType', 'An unknown node type is refused.',
        {'type': 'lottery', 'label': 'x', 'branches': [{'label': 'a', 'node': terminal('a', 1)}]},
        'unknown node type')
    add('missingChildNode', 'A branch without a node is refused.',
        {'type': 'decision', 'label': 'x', 'branches': [{'label': 'a', 'cost': 0}]}, 'missing node')
    add('nestedRefusal', 'A bad distribution two levels down is still refused at the root.',
        {'type': 'decision', 'label': 'root', 'branches': [
            {'label': 'ok', 'node': terminal('ok', 1)},
            {'label': 'deep', 'node': {'type': 'chance', 'label': 'c', 'branches': [
                {'label': 'a', 'probability': F(1, 2), 'node': {'type': 'chance', 'label': 'cc', 'branches': [
                    {'label': 'z', 'probability': F(1, 5), 'node': terminal('z', 1)}]}},
                {'label': 'b', 'probability': F(1, 2), 'node': terminal('b', 1)}]}},
        ]}, 'nested probabilities sum to 0.2')
    return cases


def evpi_cases():
    cases = []

    def add(cid, desc, outcomes, actions):
        cases.append({'id': cid, 'description': desc, 'outcomes': outcomes, 'actions': actions,
                      'expected': evpi(outcomes, actions)})

    add('prospect', 'Suite: perfect information on the drill / farm-out prospect. EV 0.3*260 = 78; EVPI 78 - 43 = 35.', OUTCOMES, ACTIONS)
    add('voiDefaultLottery', 'The VOI Analyzer default lottery as an outcomes/actions pair: act (cost 40, 300 / -50) vs do nothing. EMV 15, EV perfect 78, EVPI 63.',
        [{'label': 'Success Case', 'probability': F(3, 10)}, {'label': 'Dry Hole', 'probability': F(7, 10)}],
        [{'label': 'Drill Exploration Well', 'cost': 40, 'payoffs': [300, -50]},
         {'label': 'Do Not Drill Exploration Well', 'cost': 0, 'payoffs': [0, 0]}])
    add('threeOutcomesFourActions', 'Three outcomes and four actions with costs; the best action differs by outcome.', OUTCOMES3, ACTIONS4)
    add('dominantAction', 'Degenerate: one action is best under every outcome, so perfect information is worth exactly 0.',
        OUTCOMES, [{'label': 'Always', 'cost': 0, 'payoffs': [100, 50]}, {'label': 'Never', 'cost': 0, 'payoffs': [10, 5]}])
    add('certainOutcome', 'Degenerate: a prior of 1 on one outcome; perfect information is worth 0.',
        [{'label': 'Sure', 'probability': 1}, {'label': 'Never', 'probability': 0}], ACTIONS)
    add('distributionPayoffs', 'Payoffs given as distribution summaries; only the means enter.',
        OUTCOMES, [{'label': 'Drill', 'cost': 40, 'payoffs': [{'mean': 300, 'p10': 500}, {'mean': -10}]},
                   {'label': 'Walk', 'cost': 0, 'payoffs': [0, 0]}])
    for p in (F(1, 10), F(2, 10), F(4, 10), F(5, 10), F(8, 10)):
        add('prospectPriorSweep_%s' % str(float(p)).replace('.', 'p'),
            'Sweep of P(success) over the prospect actions.',
            [{'label': 'Success', 'probability': p}, {'label': 'Dry hole', 'probability': 1 - p}], ACTIONS)
    return cases


def evii_cases():
    cases = []

    def add(cid, desc, outcomes, actions, signals, info_cost=0, extra=None):
        exp = evii(outcomes, actions, signals, info_cost)
        ev = evpi(outcomes, actions)['evpi']
        assert F(0) <= exp['evii'] <= ev, cid
        exp['evpi'] = ev
        rec = {'id': cid, 'description': desc, 'outcomes': outcomes, 'actions': actions,
               'signals': signals, 'infoCost': info_cost, 'expected': exp}
        if extra:
            rec.update(extra)
        cases.append(rec)

    add('seismicBayes', 'Suite: P(pos|success) 0.8, P(pos|dry) 0.3. P(pos) 0.45; posterior success|pos 8/15, |neg 6/55; EV with info 55.5; EVII 12.5; net 7.5 at cost 5.',
        OUTCOMES, ACTIONS, SIGNALS, 5)
    useless = [{'label': 'Heads', 'likelihoods': [F(1, 2), F(1, 2)]}, {'label': 'Tails', 'likelihoods': [F(1, 2), F(1, 2)]}]
    add('uselessSignal', 'Suite: identical likelihood rows for every outcome; the signal is worth 0.', OUTCOMES, ACTIONS, useless)
    assert evii(OUTCOMES, ACTIONS, useless)['evii'] == 0
    perfect = [{'label': 'Says success', 'likelihoods': [1, 0]}, {'label': 'Says dry', 'likelihoods': [0, 1]}]
    add('perfectSignal', 'Suite: a perfect signal recovers EVPI exactly (35).', OUTCOMES, ACTIONS, perfect)
    assert evii(OUTCOMES, ACTIONS, perfect)['evii'] == evpi(OUTCOMES, ACTIONS)['evpi']
    add('threeByThree', 'Three outcomes, four actions, three signals through Bayes.', OUTCOMES3, ACTIONS4, SIGNALS3, 12)
    add('impossibleSignal', 'Degenerate: a third signal with zero likelihood under every outcome has marginal 0, contributes nothing, and reports the prior as its posterior (the documented fallback).',
        OUTCOMES, ACTIONS, [{'label': 'Positive', 'likelihoods': [F(8, 10), F(3, 10)]},
                            {'label': 'Negative', 'likelihoods': [F(2, 10), F(7, 10)]},
                            {'label': 'Never', 'likelihoods': [0, 0]}], 1)
    add('costAboveValue', 'Net EVII negative when the information costs more than it is worth (cost 20 on a 12.5 signal).', OUTCOMES, ACTIONS, SIGNALS, 20)
    add('costEqualsValue', 'Degenerate: information cost exactly equal to gross EVII; net is exactly 0.', OUTCOMES, ACTIONS, SIGNALS, F(25, 2))
    prev = F(-1)
    for k in range(11):
        a = F(1, 2) + F(k, 20)
        sig = [{'label': 'Positive', 'likelihoods': [a, 1 - a]}, {'label': 'Negative', 'likelihoods': [1 - a, a]}]
        e = evii(OUTCOMES, ACTIONS, sig)['evii']
        assert e >= prev, 'EVII must be monotone in accuracy'
        prev = e
        add('accuracySweep_%s' % str(float(a)).replace('.', 'p'),
            'Symmetric signal of accuracy %s on the prospect; EVII rises monotonically from 0 at 0.5 to EVPI at 1.' % float(a),
            OUTCOMES, ACTIONS, sig, 0, {'accuracy': a})
    return cases


def evii_refusals():
    cases = []

    def add(cid, desc, outcomes, actions, signals, reason):
        try:
            evii(outcomes, actions, signals)
        except Refused:
            pass
        else:
            raise AssertionError('oracle accepted %s' % cid)
        cases.append({'id': cid, 'description': desc, 'outcomes': outcomes, 'actions': actions,
                      'signals': signals, 'reason': reason})

    add('likelihoodColumnBelowOne', 'Suite: P(a|success) 0.8 + P(b|success) 0.1 = 0.9.', OUTCOMES, ACTIONS,
        [{'label': 'a', 'likelihoods': [F(8, 10), F(3, 10)]}, {'label': 'b', 'likelihoods': [F(1, 10), F(7, 10)]}],
        'likelihood column for success sums to 0.9')
    add('likelihoodColumnAboveOne', 'Column for the dry outcome sums to 1.2.', OUTCOMES, ACTIONS,
        [{'label': 'a', 'likelihoods': [F(8, 10), F(5, 10)]}, {'label': 'b', 'likelihoods': [F(2, 10), F(7, 10)]}],
        'likelihood column for dry sums to 1.2')
    add('priorsNotDistribution', 'Priors 0.3 + 0.6 do not sum to 1.',
        [{'label': 'S', 'probability': F(3, 10)}, {'label': 'D', 'probability': F(6, 10)}], ACTIONS, SIGNALS,
        'priors sum to 0.9')
    add('noSignals', 'No signals at all.', OUTCOMES, ACTIONS, [], 'no signals')
    add('payoffCountMismatch', 'An action with one payoff for two outcomes.', OUTCOMES,
        [{'label': 'short', 'cost': 0, 'payoffs': [1]}], SIGNALS, 'payoff count')
    return cases


def implied_cases():
    cases = []

    def add(cid, desc, outcomes, indicators):
        cases.append({'id': cid, 'description': desc, 'outcomes': outcomes, 'indicators': indicators,
                      'expected': implied_priors(outcomes, indicators)})

    add('consistentFromBayes', 'Suite: indicator entries derived from the Bayes case reproduce the 0.3 / 0.7 priors.', OUTCOMES,
        [{'label': 'Positive', 'probability': F(45, 100), 'posteriors': [F(8, 15), F(7, 15)]},
         {'label': 'Negative', 'probability': F(55, 100), 'posteriors': [F(6, 55), F(49, 55)]}])
    add('inconsistent', 'Suite: positive posteriors typed as 0.8 / 0.2 imply P(success) 0.42 against 0.3 stated.', OUTCOMES,
        [{'label': 'Positive', 'probability': F(45, 100), 'posteriors': [F(8, 10), F(2, 10)]},
         {'label': 'Negative', 'probability': F(55, 100), 'posteriors': [F(6, 55), F(49, 55)]}])
    add('justInsideTolerance', 'Deltas of exactly 0.005 are consistent (the threshold is inclusive). DISAGREEMENT: the engine evaluates the delta in binary floating point, 0.305 minus 0.3 is 0.0050000000000000044 there, and reports inconsistent; recorded as the engine number, see FINDINGS-decision.md.',
        [{'label': 'S', 'probability': F(3, 10)}, {'label': 'D', 'probability': F(7, 10)}],
        [{'label': 'only', 'probability': 1, 'posteriors': [F(305, 1000), F(695, 1000)]}])
    cases[-1]['disagreement'] = {
        'engineConsistent': False,
        'engineDelta': 0.305 - 0.3,
        'reason': 'the method threshold is inclusive at 0.005 exactly; the engine compares the float delta 0.305 - 0.3 = %r against 0.005 and fails it by 4.4e-18' % (0.305 - 0.3),
    }
    add('justOutsideTolerance', 'Deltas of 0.006 are not.',
        [{'label': 'S', 'probability': F(3, 10)}, {'label': 'D', 'probability': F(7, 10)}],
        [{'label': 'only', 'probability': 1, 'posteriors': [F(306, 1000), F(694, 1000)]}])
    add('missingPosteriorsCountAsZero', 'An indicator with no posteriors contributes nothing, so the implied priors fall short of the stated ones.',
        OUTCOMES, [{'label': 'Positive', 'probability': F(45, 100), 'posteriors': [F(8, 15), F(7, 15)]},
                   {'label': 'Negative', 'probability': F(55, 100)}])
    add('threeOutcomes', 'Three outcomes and three indicators, consistent by construction from SIGNALS3.', OUTCOMES3,
        [{'label': s['label'], 'probability': m, 'posteriors': p}
         for s, m, p in zip(SIGNALS3, *bayes(OUTCOMES3, SIGNALS3))])
    return cases


def information_tree_cases():
    cases = []

    def add(cid, desc, outcomes, actions, signals, info_cost, info_label='Acquire information'):
        marg, post = bayes(outcomes, signals) if signals else ([], [])
        tree = information_tree(outcomes, actions, marg, post, [s['label'] for s in signals], info_cost, info_label)
        ann = rollback(tree)
        exp = rollback_expected(ann)
        closed = evii(outcomes, actions, signals, info_cost) if signals else None
        if closed:
            # The tree must reproduce the closed forms exactly.
            assert ann['branches'][0]['branchValue'] == closed['evWithInfo'] - F(info_cost or 0)
            assert ann['branches'][1]['branchValue'] == closed['emvPrior']
            assert ann['emv'] == max(closed['evWithInfo'] - F(info_cost or 0), closed['emvPrior'])
            exp['signalMarginals'] = marg
            exp['acquireBranchValue'] = ann['branches'][0]['branchValue']
            exp['noInfoBranchValue'] = ann['branches'][1]['branchValue']
            exp['closedForm'] = {'emvPrior': closed['emvPrior'], 'evWithInfo': closed['evWithInfo'],
                                 'netEvii': closed['netEvii'], 'evpi': evpi(outcomes, actions)['evpi']}
        else:
            assert ann['emv'] == best_action(outcomes, actions)[0]
        cases.append({'id': cid, 'description': desc, 'outcomes': outcomes, 'actions': actions,
                      'signals': signals, 'infoCost': info_cost, 'infoLabel': info_label, 'expected': exp})

    add('seismicCost5', 'Suite: EV with info 55.5 less cost 5 = 50.5 beats the prior 43; acquire.', OUTCOMES, ACTIONS, SIGNALS, 5)
    add('seismicCost20', 'Suite: 55.5 less 20 = 35.5 loses to 43; the no-information branch is optimal.', OUTCOMES, ACTIONS, SIGNALS, 20)
    add('valueOfInformationTemplate', 'Suite templates.js valueOfInformation: the same lottery and signals at cost 5 with label Acquire 3D seismic.',
        OUTCOMES, ACTIONS, SIGNALS, 5, 'Acquire 3D seismic')
    add('costExactlyNetZero', 'Degenerate: cost 12.5 makes both root branches worth exactly 43; the tie resolves to the acquire branch listed first.',
        OUTCOMES, ACTIONS, SIGNALS, F(25, 2))
    add('noSignals', 'Degenerate: no signals; the builder returns the plain action decision under the priors (EMV 43).', OUTCOMES, ACTIONS, [], 0)
    add('threeByThreeCost12', 'Three outcomes, four actions, three signals at cost 12.', OUTCOMES3, ACTIONS4, SIGNALS3, 12)
    for c in (0, 5, 10, 15):
        add('costSweep_%d' % c, 'Cost sweep on the seismic tree.', OUTCOMES, ACTIONS, SIGNALS, c)
    return cases


def voi_cases():
    cases = []

    def add(cid, desc, inputs, extra=None):
        exp = voi_analyzer(inputs)
        rec = {'id': cid, 'description': desc, 'inputs': inputs, 'expected': exp}
        if extra:
            rec.update(extra)
        cases.append(rec)

    add('suiteDefaults', 'Suite voiCalculations.test.js defaults: EMV without 15, with 38, VOI 33, net 23, EVPI 63; consistent; tree present with chances 0.4 / 0.6.', voi_inputs())
    add('pricey', 'Suite: cost 50 on the same inputs; net VOI -17; verdict reject.', voi_inputs(cost=50))
    add('malformedPosterior', 'Suite: positive posteriors 90 / 40 do not form a distribution; consistency fails; the KPIs still compute from the entered numbers and NO tree is drawn.',
        voi_inputs(pos_post=(90, 40)))
    add('contradictingPosterior', 'Suite: positive posteriors 90 / 10 (a distribution) contradict the 30 percent prior (implied 42); the tree is still drawn at the entered chances and is not repaired.',
        voi_inputs(pos_post=(90, 10)))
    add('costExactlyValue', 'Degenerate: cost 33 equals the gross VOI; net VOI exactly 0; verdict neutral.', voi_inputs(cost=33))
    add('freeInformation', 'Cost 0; EMV with information equals the pre-cost value 48.', voi_inputs(cost=0))
    # Prior 10 / 90 with a symmetric accuracy-0.8 indicator: P(pos) = 0.26,
    # P(S|pos) = 4/13, P(S|neg) = 1/37. Doing nothing is optimal without
    # information (EMV of acting is 30 - 45 - 40 = -55).
    poor = voi_inputs(pos_probability=F(26), pos_post=(F(400, 13), F(900, 13)),
                      neg_post=(F(100, 37), F(3600, 37)))
    poor['outcomes'][0]['probability'] = 10
    poor['outcomes'][1]['probability'] = 90
    add('neverActWithoutInfo', 'A prior so poor that doing nothing is optimal without information (10 percent success); the EMV without information is 0 and every KPI still follows.', poor)
    for c in (5, 20, 40):
        add('costSweep_%d' % c, 'Information cost sweep on the default indicators.', voi_inputs(cost=c))
    prev = F(-1)
    for k in range(11):
        a = F(1, 2) + F(k, 20)
        inp = voi_inputs_at_accuracy(a)
        exp = voi_analyzer(inp)
        assert exp['consistency']['consistent'], 'sweep inputs are Bayes-consistent by construction'
        assert exp['voi'] >= prev
        prev = exp['voi']
        add('accuracySweep_%s' % str(float(a)).replace('.', 'p'),
            'Bayes-consistent symmetric indicator of accuracy %s against the default priors; VOI rises from 0 at 0.5 to EVPI (63) at 1.' % float(a),
            inp, {'accuracy': a})
    return cases


def main():
    golden = {
        'description': (
            'Economics decision-analysis goldens: EMV rollback over decision, chance and terminal '
            'nodes with branch costs and optimal-path marking; EVPI; EVII through Bayes from priors '
            'and likelihoods; the implied-priors consistency check; the single-stage information tree; '
            'and the VOI Analyzer computation layer on its legacy percent inputs. Independent stdlib '
            'oracle (tools/validation/economics/oracle_decision.py) written from the method statements '
            'in exact rational arithmetic (fractions.Fraction), emitted as full-precision floats. '
            'Money is USD millions ($MM). Probabilities are 0 to 1 except VOI Analyzer inputs, which '
            'are percent (0 to 100) as the form types them. Tree node and branch records are addressed '
            'by `path`, the list of branch indices from the root: node path [] is the root, [i] is '
            'root.branches[i].node, branch path [i, j] is root.branches[i].node.branches[j]. Ties at a '
            'decision resolve to the first branch listed. Every case in the Suite\'s '
            'src/lib/__tests__/decisionTree.test.js and src/utils/__tests__/voiCalculations.test.js is '
            'here, plus the two templates from src/components/decisiontree/templates.js, sweeps of '
            'signal accuracy and information cost, and degenerate and refused cases.'
        ),
        'rollback': rollback_cases(),
        'rollbackRefusals': rollback_refusals(),
        'evpi': evpi_cases(),
        'evii': evii_cases(),
        'eviiRefusals': evii_refusals(),
        'impliedPriors': implied_cases(),
        'informationTree': information_tree_cases(),
        'voi': voi_cases(),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(out(golden), f, indent=1, sort_keys=True)
        f.write('\n')
    counts = {k: len(v) for k, v in golden.items() if isinstance(v, list)}
    print('wrote %s: %s (total %d)' % (OUT, counts, sum(counts.values())))


if __name__ == '__main__':
    main()
