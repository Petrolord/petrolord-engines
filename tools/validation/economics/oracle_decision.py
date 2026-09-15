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
                    risk-neutral actor. Ties at a decision are REPORTED
                    (EC4-1, owner decision 2026-09-15): every branch whose
                    value is within 1e-9 * max(1, |best|) of the best is
                    tied, the node says whether it is indifferent, and the
                    single index the path marking needs is the FIRST listed
                    of the tied ones. Every branch reachable by taking
                    the best decision at every decision node is on the
                    optimal path. Probabilities at a chance node must be a
                    distribution: each in [0, 1], summing to 1 within 1e-6,
                    an inclusive tolerance on the numbers as typed (EC4-8,
                    owner decision 2026-09-15: three branches typed 0.333333
                    sum to 0.999999, exactly on the edge, and are accepted).
                    Accepted probabilities are used as typed and are never
                    renormalised. Anything further off is REFUSED, not
                    repaired.

  money             a cost or a payoff that is OMITTED is 0. One that is
                    PRESENT must be a finite number, or a string holding one:
                    a blank entry, a null, a non-numeric value, a NaN or an
                    infinity is REFUSED, naming what carries it and the
                    field, and a negative cost is refused because a receipt
                    is a payoff (EC4-4, owner decision 2026-09-15).

  EVPI              E over outcomes of the best (payoff minus cost) given
                    the outcome, minus the best expected (payoff minus cost)
                    under the priors. Written directly in that closed form.

  EVII              signal marginals P(s) = sum_o P(o) P(s|o) and posteriors
                    P(o|s) = P(o) P(s|o) / P(s) through Bayes; the value with
                    information is sum_s P(s) max_a E[payoff minus cost | s];
                    EVII is that minus the prior best. Priors, and each
                    likelihood column (over signals, for a fixed outcome),
                    must sum to 1 within the same inclusive 1e-6 or the case
                    is refused. A signal that cannot occur (P(s) = 0)
                    contributes nothing; its posterior is reported as the
                    prior, the engine's documented fallback.
                    Identities the oracle asserts on every case:
                    0 <= EVII <= EVPI; a signal with identical likelihood
                    rows for every outcome is worth 0; a perfect signal is
                    worth exactly EVPI.

  implied priors    P_implied(o) = sum_i P(i) P(o|i) from independently
                    typed indicator marginals and posteriors; consistent when
                    every delta against the stated prior is within half a
                    percent (0.005), the engine's documented threshold,
                    inclusive. (EC4-0 gave the engine a 1e-12 representation
                    allowance so a delta of exactly 0.005 in the typed
                    decimals agrees with this; finding D1 is resolved.)

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
                    independently. As repaired in EC4-0 (owner decision
                    2026-09-14): every percent input must be a distribution
                    or the case is REFUSED, each chance in [0, 100] and each
                    sum within 1e-4 percent points of 100: the outcome
                    chances, the indicator chances, and each indicator's
                    outcome chances (an outcome with no entry counts as 0).
                    EMV without information is the better of acting (sum
                    prior payoff minus decision cost) and not acting (0);
                    EVPI from the closed form. When the implied priors are
                    NOT consistent with the stated ones, those two are
                    reported and everything that depends on the indicator
                    entries is WITHHELD: no EMV with information, no VOI, no
                    net VOI, no verdict, no tree. Otherwise, per indicator,
                    the best action under the entered posteriors; EMV with
                    information before cost is the marginal weighted sum;
                    VOI is the difference; net VOI subtracts the information
                    cost. Every card is the value rounded to 2 decimal
                    places, half away from zero, and a card that rounds to
                    zero reads 0.00 whatever the sign (never -0.00). EC4-2,
                    owner decision 2026-09-15: net VOI is rounded ONCE and the
                    verdict reads that rounded card: 'acquire' when it is
                    above 0.00, 'reject' when below, 'neutral' when it is
                    0.00, that is whenever |net VOI| < 0.005. The diagram is the
                    information tree above with the ENTERED marginals and
                    posteriors. EC4-9, owner decision 2026-09-15: once every
                    typed input has passed, the indicator chances, and each
                    indicator's outcome chances, are each divided by their
                    own sum, and those renormalised sets are the marginals
                    and posteriors for the cards and the diagram alike (the
                    stated outcome chances stay as typed, and the consistency
                    check reads the typed entries). Sums that are exactly 100
                    are unchanged by this (the Bayes inversion the engine performs
                    round-trips exactly, which is a theorem, not an
                    implementation detail).

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
import copy
import json
import math
import os
import re
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'test-data', 'economics',
                                    'goldens', 'decision_cases.json'))

CONSISTENCY_TOL = F(5, 1000)
PERCENT_TOL = F(1, 10000)
PROB_TOL = F(1, 10 ** 6)
TIE_TOL = F(1, 10 ** 9)
DECIMAL = re.compile(r'^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$')
OMITTED = object()


class Refused(Exception):
    """The oracle refuses an input the method statement does not admit."""

    def __init__(self, message, **details):
        super().__init__(message)
        self.details = details


def best_with_ties(values):
    """(best value, first tied index, tied indices, indifferent) under the
    EC4-1 band: within TIE_TOL * max(1, |best|) of the best."""
    best = max(values)
    band = TIE_TOL * max(F(1), abs(best))
    tied = [i for i, v in enumerate(values) if best - v <= band]
    return best, tied[0], tied, len(tied) > 1


def read_amount(raw):
    """('omitted' | 'blank' | 'notNumber' | 'number', value)."""
    if raw is OMITTED:
        return 'omitted', F(0)
    if raw is None:
        return 'blank', None
    if isinstance(raw, bool):
        return 'notNumber', None
    if isinstance(raw, str):
        text = raw.strip()
        if text == '':
            return 'blank', None
        return ('number', F(text)) if DECIMAL.match(text) else ('notNumber', None)
    if isinstance(raw, float):
        return ('number', F(raw)) if math.isfinite(raw) else ('notNumber', None)
    if isinstance(raw, (int, F)):
        return 'number', F(raw)
    return 'notNumber', None


def read_cost(raw, subject, node=None):
    kind, value = read_amount(raw)
    if kind == 'blank':
        raise Refused('%s has a blank cost' % subject, kind='blank', field='cost',
                      subject=subject, node=node)
    if kind == 'notNumber':
        raise Refused('%s has a cost that is not a finite number' % subject, kind='notNumber',
                      field='cost', subject=subject, node=node)
    if value < 0:
        raise Refused('%s has a negative cost' % subject, kind='negative', field='cost',
                      subject=subject, node=node)
    return value


def read_payoff(raw, subject, node=None):
    if isinstance(raw, dict):
        kind, value = read_amount(raw['mean'] if 'mean' in raw else OMITTED)
        if kind != 'number':
            # The message names the distribution, not the terminal, exactly as
            # the engine's long-standing wording does.
            named = 'Distribution payoff' if subject == 'Terminal payoff' else subject
            raise Refused('%s has no finite mean' % named, kind='noMean',
                          field='payoff', subject=named, node=node)
        return value
    kind, value = read_amount(raw)
    if kind == 'blank':
        raise Refused('%s is blank' % subject, kind='blank', field='payoff',
                      subject=subject, node=node)
    if kind == 'notNumber':
        raise Refused('%s is not a finite number' % subject, kind='notNumber', field='payoff',
                      subject=subject, node=node)
    return value


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

def payoff_value(p, node=None):
    return read_payoff(p, 'Terminal payoff', node)


def is_distribution(probs):
    return all(F(0) <= p <= F(1) for p in probs) and abs(sum(probs, F(0)) - 1) <= PROB_TOL


def card(v):
    """(text, value) of a money card: 2 decimal places, half away from zero
    on the magnitude, zero always unsigned."""
    v = F(v)
    cents = int(abs(v) * 100 + F(1, 2))  # floor of a non-negative Fraction
    if cents == 0:
        return '0.00', F(0)
    text = '%s%d.%02d' % ('-' if v < 0 else '', cents // 100, cents % 100)
    return text, (F(cents, 100) if v > 0 else -F(cents, 100))


def evaluate(node):
    """Return an annotated copy: emv on every node, bestBranchIndex on
    decisions, branchValue on every branch."""
    if node is None or not isinstance(node, dict):
        raise Refused('missing node')
    t = node.get('type')
    label = node.get('label')
    if t == 'terminal':
        return {'type': t, 'emv': payoff_value(node.get('payoff', OMITTED), label)}
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
            bv = child['emv'] - read_cost(b.get('cost', OMITTED), 'Branch "%s"' % (b.get('label') or ''), label)
            ann.append({'branchValue': bv, 'node': child, 'probability': p})
            emv += p * bv
        return {'type': t, 'emv': emv, 'branches': ann}
    if t == 'decision':
        ann = []
        for b in branches:
            child = evaluate(b.get('node'))
            bv = child['emv'] - read_cost(b.get('cost', OMITTED), 'Branch "%s"' % (b.get('label') or ''), label)
            ann.append({'branchValue': bv, 'node': child})
        emv, best, tied, indifferent = best_with_ties([a['branchValue'] for a in ann])
        return {'type': t, 'emv': emv, 'branches': ann, 'bestBranchIndex': best,
                'tiedIndices': tied, 'indifferent': indifferent}
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
            rec['tiedIndices'] = node['tiedIndices']
            rec['indifferent'] = node['indifferent']
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
        exp['tiedIndices'] = ann['tiedIndices']
        exp['indifferent'] = ann['indifferent']
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
    for a in actions:
        action_cost(a)
        for i in range(len(outcomes)):
            action_payoff(a, outcomes, i)


def action_cost(a):
    return read_cost(a.get('cost', OMITTED), 'Action "%s"' % (a.get('label') or ''))


def action_payoff(a, outcomes, i):
    return read_payoff(a['payoffs'][i],
                       'Payoff of action "%s" for outcome "%s"'
                       % (a.get('label') or '', outcomes[i].get('label', i)))


def action_value(a, outcomes, probs):
    return sum((p * action_payoff(a, outcomes, i) for i, p in enumerate(probs)), F(0)) - action_cost(a)


def best_action(outcomes, actions, probs=None):
    """(emv, index, tied indices, indifferent); the index is the first listed
    of the tied actions."""
    check_lottery(outcomes, actions)
    p = probs if probs is not None else [F(o['probability']) for o in outcomes]
    vals = [action_value(a, outcomes, p) for a in actions]
    return best_with_ties(vals)


def evpi(outcomes, actions):
    check_lottery(outcomes, actions)
    priors = [F(o['probability']) for o in outcomes]
    emv_prior, best_prior, tied_prior, indifferent_prior = best_action(outcomes, actions)
    ev_perfect = F(0)
    per_outcome = []
    for i, p in enumerate(priors):
        vals = [action_payoff(a, outcomes, i) - action_cost(a) for a in actions]
        best_here, b, _, _ = best_with_ties(vals)
        per_outcome.append(b)
        ev_perfect += p * best_here
    return {'emvPrior': emv_prior, 'bestActionIndex': best_prior,
            'bestActionTiedIndices': tied_prior, 'indifferent': indifferent_prior,
            'evWithPerfect': ev_perfect, 'evpi': ev_perfect - emv_prior,
            'perfectBestActionIndex': per_outcome}


def evii(outcomes, actions, signals, info_cost=0):
    check_lottery(outcomes, actions)
    net_cost = read_cost(info_cost, 'The information')
    if not signals:
        raise Refused('no signals')
    priors = [F(o['probability']) for o in outcomes]
    n = len(outcomes)
    for i in range(n):
        col = sum((F(s['likelihoods'][i]) for s in signals), F(0))
        if abs(col - 1) > PROB_TOL:
            raise Refused('likelihood column %d sums to %s' % (i, col))
    emv_prior = best_action(outcomes, actions)[0]
    ev_info = F(0)
    per_signal = []
    for s in signals:
        joint = [priors[i] * F(s['likelihoods'][i]) for i in range(n)]
        p_s = sum(joint, F(0))
        post = [j / p_s for j in joint] if p_s > 0 else list(priors)
        emv_s, idx, tied, indifferent = best_action(outcomes, actions, post)
        ev_info += p_s * emv_s
        per_signal.append({'pSignal': p_s, 'posterior': post, 'emv': emv_s,
                           'bestActionIndex': idx, 'tiedActionIndices': tied,
                           'indifferent': indifferent})
    gross = ev_info - emv_prior
    return {'emvPrior': emv_prior, 'evWithInfo': ev_info, 'evii': gross,
            'netEvii': gross - net_cost, 'perSignal': per_signal}


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
            'label': a['label'], 'cost': action_cost(a),
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
            {'label': info_label, 'cost': read_cost(info_cost, 'The information'), 'node': with_info},
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

def voi_percent_refusal(inputs):
    """The first percent input that is not a distribution, as (reason, sum
    in percent) with sum None for a range refusal, or None when all are."""
    outs = inputs.get('outcomes') or []
    if not outs:
        return ('no outcomes', None)
    for o in outs:
        if not (0 <= F(o['probability']) <= 100):
            return ('outcome chance outside 0 to 100', None)
    tot = sum((F(o['probability']) for o in outs), F(0))
    if abs(tot - 100) > PERCENT_TOL:
        return ('outcome chances sum to %s percent' % float(tot), tot)
    inds = (inputs.get('infoScenario') or {}).get('indicators') or []
    if not inds:
        return ('no indicators', None)
    for ind in inds:
        if not (0 <= F(ind['probability']) <= 100):
            return ('indicator chance outside 0 to 100', None)
    tot = sum((F(ind['probability']) for ind in inds), F(0))
    if abs(tot - 100) > PERCENT_TOL:
        return ('indicator chances sum to %s percent' % float(tot), tot)
    for ind in inds:
        chances = []
        for o in outs:
            cp = [c for c in ind.get('conditionalProbabilities') or [] if c['outcomeId'] == o['id']]
            v = F(cp[0]['probability']) if cp else F(0)
            if not (0 <= v <= 100):
                return ('outcome chance given %s outside 0 to 100' % ind['name'], None)
            chances.append(v)
        tot = sum(chances, F(0))
        if abs(tot - 100) > PERCENT_TOL:
            return ('outcome chances given %s sum to %s percent' % (ind['name'], float(tot)), tot)
    return None


def voi_analyzer(inputs):
    if voi_percent_refusal(inputs) is not None:
        raise Refused(voi_percent_refusal(inputs)[0])
    pct = lambda v: F(v) / 100  # noqa: E731
    outcomes = [{'label': o['name'], 'probability': pct(o['probability'])} for o in inputs['outcomes']]
    act_label = inputs['decisionName']
    # EC4-4: the survey cost is money and is read before anything uses it.
    info_cost_value = read_cost(inputs['infoScenario']['cost'],
                                'Information scenario "%s"' % (inputs['infoScenario'].get('name') or ''))
    actions = [
        {'label': act_label, 'cost': inputs['decisionCost'], 'payoffs': [o['payoff'] for o in inputs['outcomes']]},
        {'label': 'Do Not %s' % act_label, 'cost': F(0), 'payoffs': [0 for _ in inputs['outcomes']]},
    ]
    info = inputs['infoScenario']
    emv_without, idx, tied_without, indifferent_without = best_action(outcomes, actions)
    optimal_without = actions[idx]['label']
    best_without = {'actionIndex': idx, 'tiedIndices': tied_without,
                    'indifferent': indifferent_without,
                    'tiedLabels': [actions[k]['label'] for k in tied_without]}
    ev = evpi(outcomes, actions)['evpi']

    def posterior_of(ind):
        post = []
        for o in inputs['outcomes']:
            cp = [c for c in ind['conditionalProbabilities'] if c['outcomeId'] == o['id']]
            post.append(pct(cp[0]['probability']) if cp else F(0))
        return post

    typed_marginals = [pct(ind['probability']) for ind in info['indicators']]
    typed_posteriors = [posterior_of(ind) for ind in info['indicators']]
    labels = [ind['name'] for ind in info['indicators']]
    cons = implied_priors(outcomes, [{'probability': m, 'posteriors': p}
                                     for m, p in zip(typed_marginals, typed_posteriors)])

    def unit(xs):
        total = sum(xs, F(0))
        return [x / total for x in xs]

    marginals = unit(typed_marginals)
    posteriors = [unit(p) for p in typed_posteriors]

    if not cons['consistent']:
        return {
            'emvWithoutInfo': emv_without, 'emvWithInfo': None, 'voi': None, 'netVoi': None,
            'evpi': ev, 'optimalActionWithoutInfo': optimal_without, 'verdict': None,
            'cards': {'emvWithoutInfo': card(emv_without)[0], 'emvWithInfo': None, 'voi': None,
                      'netVoi': None, 'evpi': card(ev)[0]},
            'consistency': cons, 'withheld': True, 'treePresent': False,
            'bestActionWithoutInfo': best_without,
        }

    emv_with_pre = F(0)
    per_indicator = []
    for m, post in zip(marginals, posteriors):
        e, k, tied_k, indifferent_k = best_action(outcomes, actions, post)
        emv_with_pre += m * e
        per_indicator.append({'emv': e, 'bestActionIndex': k, 'tiedActionIndices': tied_k,
                              'indifferent': indifferent_k})
    cost = info_cost_value
    emv_with = emv_with_pre - cost
    voi = emv_with_pre - emv_without
    net = voi - cost
    net_text, net_card = card(net)
    verdict = 'acquire' if net_card > 0 else ('reject' if net_card < 0 else 'neutral')

    exp = {
        'emvWithoutInfo': emv_without, 'emvWithInfo': emv_with, 'voi': voi, 'netVoi': net,
        'evpi': ev, 'optimalActionWithoutInfo': optimal_without, 'verdict': verdict,
        'cards': {'emvWithoutInfo': card(emv_without)[0], 'emvWithInfo': card(emv_with)[0],
                  'voi': card(voi)[0], 'netVoi': net_text, 'evpi': card(ev)[0]},
        'perIndicator': per_indicator,
        'bestActionWithoutInfo': best_without,
        'consistency': cons, 'withheld': False,
    }
    tree = information_tree(outcomes, actions, marginals, posteriors, labels, cost,
                            'Acquire %s' % info['name'])
    ann = rollback(tree)  # every entry is a distribution, so this cannot refuse
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
THIRDS6 = [{'label': 'Large', 'probability': F('0.333333')},
           {'label': 'Medium', 'probability': F('0.333333')},
           {'label': 'Dry', 'probability': F('0.333333')}]
SIGNALS3 = [{'label': 'Bright', 'likelihoods': [F(7, 10), F(3, 10), F(1, 10)]},
            {'label': 'Flat', 'likelihoods': [F(2, 10), F(5, 10), F(3, 10)]},
            {'label': 'Dim', 'likelihoods': [F(1, 10), F(2, 10), F(6, 10)]}]


def inject(record, path, value):
    """A deep copy of `record` with `value` written at `path` (a list of keys
    and indices). Used for NaN and infinity, which JSON cannot carry: the
    emitted case holds a placeholder string and a `nonFinite` instruction."""
    live = copy.deepcopy(record)
    target = live
    for k in path[:-1]:
        target = target[k]
    target[path[-1]] = value
    return live


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


def voi_thirds(chance='33.3333'):
    """Three outcomes at a typed third each, two indicators 50 / 50 whose
    outcome chances are consistent with the thirds."""
    c = F(chance)
    return {
        'projectName': 'Thirds Prospect',
        'decisionName': 'Drill Exploration Well',
        'decisionCost': 40,
        'outcomes': [
            {'id': 1, 'name': 'Large', 'probability': c, 'payoff': 300},
            {'id': 2, 'name': 'Small', 'probability': c, 'payoff': 60},
            {'id': 3, 'name': 'Dry Hole', 'probability': c, 'payoff': -50},
        ],
        'infoScenario': {
            'name': '3D Seismic Survey',
            'cost': 10,
            'indicators': [
                {'id': 1, 'name': 'Positive Seismic', 'probability': 50,
                 'conditionalProbabilities': [{'outcomeId': 1, 'probability': 50},
                                              {'outcomeId': 2, 'probability': 30},
                                              {'outcomeId': 3, 'probability': 20}]},
                {'id': 2, 'name': 'Negative Seismic', 'probability': 50,
                 'conditionalProbabilities': [{'outcomeId': 1, 'probability': F('16.6666')},
                                              {'outcomeId': 2, 'probability': F('36.6667')},
                                              {'outcomeId': 3, 'probability': F('46.6667')}]},
            ],
        },
    }


# Outcome chances given each of three indicators, as (typed four-place
# decimal, exact fraction) pairs, in percent.
ALL_THIRDS_ROWS = [[('33.3333', F(100, 3))] * 3] * 3
INFORMATIVE_ROWS = [
    [('66.6666', F(200, 3)), ('22.2222', F(200, 9)), ('11.1111', F(100, 9))],
    [('22.2222', F(200, 9)), ('55.5555', F(500, 9)), ('22.2222', F(200, 9))],
    [('11.1111', F(100, 9)), ('22.2222', F(200, 9)), ('66.6666', F(200, 3))],
]


def voi_compound(rows, typed_third):
    """Three outcomes and three indicators, every chance a third; typed to
    four places when typed_third is given, exact otherwise."""
    third = F(typed_third) if typed_third else F(100, 3)
    pick = (lambda pair: F(pair[0])) if typed_third else (lambda pair: pair[1])
    names = ['Large', 'Small', 'Dry Hole']
    return {
        'projectName': 'Compound Edge Prospect',
        'decisionName': 'Drill Exploration Well',
        'decisionCost': 40,
        'outcomes': [{'id': i + 1, 'name': n, 'probability': third, 'payoff': pay}
                     for i, (n, pay) in enumerate(zip(names, (300, 60, -50)))],
        'infoScenario': {
            'name': '3D Seismic Survey',
            'cost': 1,
            'indicators': [{'id': k + 1, 'name': lab, 'probability': third,
                            'conditionalProbabilities': [{'outcomeId': i + 1, 'probability': pick(row[i])}
                                                         for i in range(3)]}
                           for k, (lab, row) in enumerate(zip(('Bright', 'Flat', 'Dim'), rows))],
        },
    }


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
        'EC4-1: a decision whose first two branches tie exactly (both 30) reports tiedIndices [0, 1] and indifferent; the third (29.999) is outside the band. bestBranchIndex stays the first listed so the optimal-path marking has one branch to follow.',
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
    add('thirdsTypedToSixPlaces',
        'EC4-8: three branches typed 0.333333 sum to 0.999999, exactly 1e-6 short, which the inclusive tolerance accepts. The probabilities are used as typed: EMV 0.333333 * (90 + 30 - 15) = 34.999965.',
        {'type': 'chance', 'label': 'thirds typed', 'branches': [
            {'label': 'a', 'probability': F('0.333333'), 'node': terminal('a', 90)},
            {'label': 'b', 'probability': F('0.333333'), 'node': terminal('b', 30)},
            {'label': 'c', 'probability': F('0.333333'), 'node': terminal('c', -15)},
        ]})
    add('chanceRootWithBranchCosts',
        'Chance at the root with a cost on every branch and a nested decision under one of them; EMV subtracts the branch costs before weighting.',
        {'type': 'chance', 'label': 'weather', 'branches': [
            {'label': 'calm', 'probability': F(6, 10), 'cost': 2, 'node': {'type': 'decision', 'label': 'go', 'branches': [
                {'label': 'sail', 'cost': 1, 'node': terminal('sail', 20)},
                {'label': 'wait', 'cost': 0, 'node': terminal('wait', 5)}]}},
            {'label': 'storm', 'probability': F(4, 10), 'cost': 8, 'node': terminal('storm', -25)},
        ]})
    add('omittedCostAndPayoffAreZero',
        'EC4-4: an OMITTED cost field is 0, and so is an omitted payoff. Only entries that are present are read, so a sparse tree still rolls back.',
        {'type': 'decision', 'label': 'sparse', 'branches': [
            {'label': 'A', 'node': {'type': 'terminal', 'label': 'A'}},
            {'label': 'B', 'node': {'type': 'chance', 'label': 'Bc', 'branches': [
                {'label': 'x', 'probability': F(1, 2), 'node': terminal('x', 8)},
                {'label': 'y', 'probability': F(1, 2), 'node': terminal('y', -2)}]}},
        ]})
    add('floatResidueTie',
        'EC4-1: two branches worth exactly 0.3 in decimals. In binary the chance branch evaluates to 0.30000000000000004, one ulp above the terminal listed first, so the retired strictly-greater rule recommended the SECOND branch. Residue inside the band is a tie, and the first listed keeps the marking.',
        {'type': 'decision', 'label': 'residue', 'branches': [
            {'label': 'Sell now', 'node': terminal('Sell now', F(3, 10))},
            {'label': 'Keep', 'node': {'type': 'chance', 'label': 'Keep outcome', 'branches': [
                {'label': 'up', 'probability': F(2, 10), 'node': terminal('up', F(7, 10))},
                {'label': 'down', 'probability': F(8, 10), 'node': terminal('down', F(2, 10))}]}},
        ]})
    add('withinToleranceTie',
        'EC4-1: branch values 43 and 43.00000001, a gap of 1e-8 inside the band 1e-9 * max(1, 43) = 4.3e-8: tied, indifferent, and the first listed carries the marking while the node EMV is the larger value.',
        {'type': 'decision', 'label': 'within band', 'branches': [
            {'label': 'A', 'node': terminal('A', 43)},
            {'label': 'B', 'node': terminal('B', F('43.00000001'))},
        ]})
    add('nearTieOutsideTolerance',
        'EC4-1 control: branch values 43 and 43.0000001, a gap of 1e-7 outside the same band: not tied, and the larger branch (listed second) is the one recommended.',
        {'type': 'decision', 'label': 'outside band', 'branches': [
            {'label': 'A', 'node': terminal('A', 43)},
            {'label': 'B', 'node': terminal('B', F('43.0000001'))},
        ]})
    add('absoluteFloorTie',
        'EC4-1: below unit magnitude the band is absolute. Values 0.2 and 0.2000000005 differ by 5e-10, inside the 1e-9 floor, so they tie.',
        {'type': 'decision', 'label': 'small', 'branches': [
            {'label': 'A', 'node': terminal('A', F(2, 10))},
            {'label': 'B', 'node': terminal('B', F('0.2000000005'))},
        ]})
    add('numericStringMoney',
        'EC4-4: costs and payoffs typed as numeric strings (with surrounding spaces) are numbers, so a form that stores text still rolls back: 40 - 10 = 30 against a chance node worth 2.75.',
        {'type': 'decision', 'label': 'typed as text', 'branches': [
            {'label': 'A', 'cost': '10', 'node': terminal('A', '40')},
            {'label': 'B', 'cost': ' 5 ', 'node': {'type': 'chance', 'label': 'Bc', 'branches': [
                {'label': 'x', 'probability': F(1, 2), 'node': terminal('x', '18')},
                {'label': 'y', 'probability': F(1, 2), 'node': terminal('y', '-2.5')}]}},
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
    add('thirdsTypedToThreePlaces', 'EC4-8: three branches typed 0.333 sum to 0.999, a thousandth short; the binary allowance does not widen the tolerance.',
        {'type': 'chance', 'label': 'thirds', 'branches': [
            {'label': 'a', 'probability': F('0.333'), 'node': terminal('a', 90)},
            {'label': 'b', 'probability': F('0.333'), 'node': terminal('b', 30)},
            {'label': 'c', 'probability': F('0.333'), 'node': terminal('c', -15)}]},
        'probabilities sum to 0.999')
    add('sumShortByTwoMillionths', 'EC4-8: 0.333333 + 0.333333 + 0.333332 = 0.999998, twice the tolerance short; still refused.',
        {'type': 'chance', 'label': 'short', 'branches': [
            {'label': 'a', 'probability': F('0.333333'), 'node': terminal('a', 90)},
            {'label': 'b', 'probability': F('0.333333'), 'node': terminal('b', 30)},
            {'label': 'c', 'probability': F('0.333332'), 'node': terminal('c', -15)}]},
        'probabilities sum to 0.999998')
    add('emptyBranches', 'A decision node with no branches has nothing to decide.',
        {'type': 'decision', 'label': 'empty', 'branches': []}, 'no branches')
    add('unknownType', 'An unknown node type is refused.',
        {'type': 'lottery', 'label': 'x', 'branches': [{'label': 'a', 'node': terminal('a', 1)}]},
        'unknown node type')
    add('missingChildNode', 'A branch without a node is refused.',
        {'type': 'decision', 'label': 'x', 'branches': [{'label': 'a', 'cost': 0}]}, 'missing node')
    def money(cid, desc, tree, refusal, refused_value, non_finite=None):
        """A refusal that names what carries the money and which field."""
        rec = {'id': cid, 'description': desc, 'tree': tree, 'reason': desc.split(':')[0],
               'refusal': refusal, 'refusedValue': refused_value}
        if non_finite:
            rec['nonFinite'] = non_finite
        live = rec
        for injection in non_finite or []:
            live = inject(live, injection['at'], float(injection['value']))
        try:
            rollback(live['tree'])
        except Refused as err:
            for k, v in refusal.items():
                assert err.details.get(k) == v, (cid, k, err.details.get(k), v)
        else:
            raise AssertionError('oracle accepted %s' % cid)
        cases.append(rec)

    def drill_branch(cost=None, payoff=300, omit_cost=False):
        branch = {'label': 'Drill', 'node': terminal('Success', payoff)}
        if not omit_cost:
            branch['cost'] = cost
        return {'type': 'decision', 'label': 'Prospect decision', 'branches': [branch]}

    at_cost = ['tree', 'branches', 0, 'cost']
    at_payoff = ['tree', 'branches', 0, 'node', 'payoff']
    branch_cost = {'kind': None, 'field': 'cost', 'subject': 'Branch "Drill"', 'node': 'Prospect decision'}

    def cost_refusal(kind):
        return dict(branch_cost, kind=kind)

    money('blankCostRefused', 'EC4-4: a branch cost typed and then cleared (a blank string) is refused by node label. Before, it read as 0 and the branch looked free.',
          drill_branch(''), cost_refusal('blank'), '')
    money('nullCostRefused', 'EC4-4: a null branch cost is refused the same way a blank one is.',
          drill_branch(None), cost_refusal('blank'), None)
    money('nonNumericCostRefused', 'EC4-4: a branch cost of "abc" is refused. Before, Number("abc") || 0 made it free.',
          drill_branch('abc'), cost_refusal('notNumber'), 'abc')
    money('nanCostRefused', 'EC4-4: a branch cost of NaN is refused. Before, NaN || 0 made it free.',
          drill_branch('NaN'), cost_refusal('notNumber'), 'NaN',
          [{'at': at_cost, 'value': 'NaN'}, {'at': ['refusedValue'], 'value': 'NaN'}])
    money('infiniteCostRefused', 'EC4-4: an infinite branch cost is refused rather than propagated.',
          drill_branch('Infinity'), cost_refusal('notNumber'), 'Infinity',
          [{'at': at_cost, 'value': 'Infinity'}, {'at': ['refusedValue'], 'value': 'Infinity'}])
    money('negativeCostRefused', 'EC4-4: a branch cost of -5 is refused: a receipt belongs in the payoff. Before, it was added to the branch value as income.',
          drill_branch(-5), cost_refusal('negative'), -5)
    money('negativeCostStringRefused', 'EC4-4: a negative cost typed as text is refused the same way.',
          drill_branch('-3'), cost_refusal('negative'), '-3')
    money('nullPayoffRefused', 'EC4-4: a terminal payoff of null is refused by node label. Before, it was worth 0, so a cleared field looked like a break-even outcome.',
          drill_branch(cost=0, payoff=None),
          {'kind': 'blank', 'field': 'payoff', 'subject': 'Terminal payoff', 'node': 'Success'}, None)
    money('blankPayoffRefused', 'EC4-4: a blank terminal payoff is refused. Before, Number("") was 0.',
          drill_branch(cost=0, payoff=''),
          {'kind': 'blank', 'field': 'payoff', 'subject': 'Terminal payoff', 'node': 'Success'}, '')
    money('nonNumericPayoffRefused', 'EC4-4: a terminal payoff of "abc" is refused, and the refusal now names the node.',
          drill_branch(cost=0, payoff='abc'),
          {'kind': 'notNumber', 'field': 'payoff', 'subject': 'Terminal payoff', 'node': 'Success'}, 'abc')
    money('nanPayoffRefused', 'EC4-4: a terminal payoff of NaN is refused, naming the node.',
          drill_branch(cost=0, payoff='NaN'),
          {'kind': 'notNumber', 'field': 'payoff', 'subject': 'Terminal payoff', 'node': 'Success'}, 'NaN',
          [{'at': at_payoff, 'value': 'NaN'}, {'at': ['refusedValue'], 'value': 'NaN'}])
    money('booleanPayoffRefused', 'EC4-4: a boolean payoff is not a number. Before, true was worth 1.',
          drill_branch(cost=0, payoff=True),
          {'kind': 'notNumber', 'field': 'payoff', 'subject': 'Terminal payoff', 'node': 'Success'}, True)
    money('distributionBlankMeanRefused', 'EC4-4: a distribution payoff whose mean is blank is refused. Before, Number("") gave it a mean of 0.',
          drill_branch(cost=0, payoff={'mean': '', 'p90': 40}),
          {'kind': 'noMean', 'field': 'payoff', 'subject': 'Distribution payoff', 'node': 'Success'}, '')
    money('nestedBlankCostRefused', 'EC4-4: a blank cost two levels down is refused naming the node that carries it, not the root.',
          {'type': 'decision', 'label': 'root', 'branches': [
              {'label': 'ok', 'cost': 0, 'node': terminal('ok', 1)},
              {'label': 'deep', 'cost': 0, 'node': {'type': 'chance', 'label': 'Weather', 'branches': [
                  {'label': 'calm', 'probability': F(1, 2), 'cost': '', 'node': terminal('calm', 10)},
                  {'label': 'storm', 'probability': F(1, 2), 'node': terminal('storm', 1)}]}},
          ]},
          {'kind': 'blank', 'field': 'cost', 'subject': 'Branch "calm"', 'node': 'Weather'}, '')

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
    add('tiedActionsAtPrior',
        'EC4-1: two actions worth exactly 37 under the priors (100 / 10 free against 110 / 10 at a cost of 3); the best-action result reports both as tied and says the choice is indifferent.',
        OUTCOMES, [{'label': 'Alpha', 'cost': 0, 'payoffs': [100, 10]},
                   {'label': 'Beta', 'cost': 3, 'payoffs': [110, 10]},
                   {'label': 'Gamma', 'cost': 0, 'payoffs': [20, 20]}])
    add('omittedAndStringCosts',
        'EC4-4: the prospect with the drill cost typed as the string "40", the farm-out cost omitted entirely and one payoff as text; every number reads as it looks, so EVPI is still 35.',
        OUTCOMES, [{'label': 'Drill', 'cost': '40', 'payoffs': ['300', -10]},
                   {'label': 'Farm out', 'payoffs': [60, 0]},
                   {'label': 'Do nothing', 'cost': 0, 'payoffs': [0, 0]}])
    add('thirdsPriorsSixPlaces', 'EC4-8: three outcome priors typed 0.333333 (sum 0.999999, on the edge) are accepted and used as typed.',
        THIRDS6, ACTIONS4)
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
    add('likelihoodColumnSixPlaces', 'EC4-8: three signals whose likelihoods under success are typed 0.333333 (column sum 0.999999, on the edge) are accepted; the dry column is 0.1 / 0.3 / 0.6.',
        OUTCOMES, ACTIONS, [{'label': 'High', 'likelihoods': [F('0.333333'), F(1, 10)]},
                            {'label': 'Mid', 'likelihoods': [F('0.333333'), F(3, 10)]},
                            {'label': 'Low', 'likelihoods': [F('0.333333'), F(6, 10)]}], 2)
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
    add('likelihoodColumnShortByTwoMillionths', 'EC4-8: likelihoods under success 0.333333 + 0.333333 + 0.333332 = 0.999998; still refused.',
        OUTCOMES, ACTIONS, [{'label': 'High', 'likelihoods': [F('0.333333'), F(1, 10)]},
                            {'label': 'Mid', 'likelihoods': [F('0.333333'), F(3, 10)]},
                            {'label': 'Low', 'likelihoods': [F('0.333332'), F(6, 10)]}],
        'likelihood column for success sums to 0.999998')
    add('priorsShortByTwoMillionths', 'EC4-8: priors 0.333333 + 0.333333 + 0.333332 = 0.999998; still refused.',
        [{'label': 'Large', 'probability': F('0.333333')}, {'label': 'Medium', 'probability': F('0.333333')},
         {'label': 'Dry', 'probability': F('0.333332')}], ACTIONS4, SIGNALS3,
        'priors sum to 0.999998')
    add('noSignals', 'No signals at all.', OUTCOMES, ACTIONS, [], 'no signals')
    add('payoffCountMismatch', 'An action with one payoff for two outcomes.', OUTCOMES,
        [{'label': 'short', 'cost': 0, 'payoffs': [1]}], SIGNALS, 'payoff count')
    return cases


def lottery_refusals():
    """EC4-4 in the lottery shape: action costs, action payoffs and the
    information cost, each refused naming the action or the information."""
    cases = []
    ORACLE_CALLS = {
        'bestActionEmv': lambda r: best_action(r['outcomes'], r['actions']),
        'evpi': lambda r: evpi(r['outcomes'], r['actions']),
        'evii': lambda r: evii(r['outcomes'], r['actions'], r['signals'], r['infoCost']),
        'buildInformationTree': lambda r: act_node(r['outcomes'], r['actions'],
                                                   [F(o['probability']) for o in r['outcomes']]),
    }

    def add(cid, desc, actions, calls, refusal, refused_value, info_cost=0, non_finite=None):
        rec = {'id': cid, 'description': desc, 'outcomes': OUTCOMES, 'actions': actions,
               'signals': SIGNALS, 'infoCost': info_cost, 'calls': calls,
               'reason': desc.split(':')[0], 'refusal': refusal, 'refusedValue': refused_value}
        if non_finite:
            rec['nonFinite'] = non_finite
        live = rec
        for injection in non_finite or []:
            live = inject(live, injection['at'], float(injection['value']))
        for name in calls:
            try:
                ORACLE_CALLS[name](live)
            except Refused as err:
                for k, v in refusal.items():
                    assert err.details.get(k) == v, (cid, name, k, err.details.get(k), v)
            else:
                raise AssertionError('oracle accepted %s via %s' % (cid, name))
        cases.append(rec)

    ALL = ['bestActionEmv', 'evpi', 'evii', 'buildInformationTree']
    LOTTERY = ['bestActionEmv', 'evpi', 'evii']
    INFO = ['evii']

    def drill(cost=0, payoffs=(300, -10)):
        return [{'label': 'Drill', 'cost': cost, 'payoffs': list(payoffs)},
                {'label': 'Do nothing', 'cost': 0, 'payoffs': [0, 0]}]

    action_cost_refusal = {'field': 'cost', 'subject': 'Action "Drill"', 'node': None}
    payoff_subject = 'Payoff of action "Drill" for outcome "Success"'

    add('actionBlankCostRefused', 'EC4-4: a blank action cost is refused. Before, it read as 0 and the action looked free.',
        drill(cost=''), ALL, dict(action_cost_refusal, kind='blank'), '')
    add('actionNullCostRefused', 'EC4-4: a null action cost is refused.',
        drill(cost=None), ALL, dict(action_cost_refusal, kind='blank'), None)
    add('actionNonNumericCostRefused', 'EC4-4: an action cost of "abc" is refused.',
        drill(cost='abc'), ALL, dict(action_cost_refusal, kind='notNumber'), 'abc')
    add('actionNanCostRefused', 'EC4-4: an action cost of NaN is refused.',
        drill(cost='NaN'), ALL, dict(action_cost_refusal, kind='notNumber'), 'NaN',
        non_finite=[{'at': ['actions', 0, 'cost'], 'value': 'NaN'}, {'at': ['refusedValue'], 'value': 'NaN'}])
    add('actionNegativeCostRefused', 'EC4-4: an action cost of -40 is refused: a receipt belongs in the payoffs.',
        drill(cost=-40), ALL, dict(action_cost_refusal, kind='negative'), -40)
    add('actionBlankPayoffRefused', 'EC4-4: a blank payoff is refused naming the action and the outcome. Before it was 0.',
        drill(payoffs=('', -10)), LOTTERY,
        {'kind': 'blank', 'field': 'payoff', 'subject': payoff_subject, 'node': None}, '')
    add('actionNullPayoffRefused', 'EC4-4: a null payoff is refused naming the action and the outcome.',
        drill(payoffs=(None, -10)), LOTTERY,
        {'kind': 'blank', 'field': 'payoff', 'subject': payoff_subject, 'node': None}, None)
    add('actionNonNumericPayoffRefused', 'EC4-4: a payoff of "abc" is refused naming the action and the outcome.',
        drill(payoffs=('abc', -10)), LOTTERY,
        {'kind': 'notNumber', 'field': 'payoff', 'subject': payoff_subject, 'node': None}, 'abc')
    add('actionInfinitePayoffRefused', 'EC4-4: an infinite payoff is refused rather than propagated into an EMV.',
        drill(payoffs=('Infinity', -10)), LOTTERY,
        {'kind': 'notNumber', 'field': 'payoff', 'subject': payoff_subject, 'node': None}, 'Infinity',
        non_finite=[{'at': ['actions', 0, 'payoffs', 0], 'value': 'Infinity'},
                    {'at': ['refusedValue'], 'value': 'Infinity'}])
    add('infoCostBlankRefused', 'EC4-4: a blank information cost is refused. Before, it read as 0 and the net EVII equalled the gross.',
        drill(cost=40), INFO, {'kind': 'blank', 'field': 'cost', 'subject': 'The information', 'node': None},
        '', info_cost='')
    add('infoCostNonNumericRefused', 'EC4-4: an information cost of "abc" is refused.',
        drill(cost=40), INFO, {'kind': 'notNumber', 'field': 'cost', 'subject': 'The information', 'node': None},
        'abc', info_cost='abc')
    add('infoCostNegativeRefused', 'EC4-4: a negative information cost is refused: a payment received for acquiring data belongs in the payoffs.',
        drill(cost=40), INFO, {'kind': 'negative', 'field': 'cost', 'subject': 'The information', 'node': None},
        -5, info_cost=-5)
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
    add('justInsideTolerance', 'Deltas of exactly 0.005 are consistent (the threshold is inclusive). In binary floating point 0.305 minus 0.3 is 0.0050000000000000044; before EC4-0 the engine reported that inconsistent (finding D1), and its 1e-12 representation allowance now agrees with the method.',
        [{'label': 'S', 'probability': F(3, 10)}, {'label': 'D', 'probability': F(7, 10)}],
        [{'label': 'only', 'probability': 1, 'posteriors': [F(305, 1000), F(695, 1000)]}])
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
    add('costExactlyNetZero', 'EC4-1: cost 12.5 makes both root branches worth exactly 43, so the root is indifferent between acquiring the information and not; bestBranchIndex is the acquire branch, listed first.',
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
    add('contradictingPosterior', 'Positive posteriors 90 / 10 (a distribution) contradict the 30 percent prior (implied 42). Before EC4-0 this reported a gross VOI of 75 above the EVPI of 63; now EMV without information and EVPI are reported and the rest is withheld.',
        voi_inputs(pos_post=(90, 10)))
    add('identicalPosteriorsWithheld', 'Both indicators typed 20 / 80 imply a 20 percent success chance against 30 stated. Before EC4-0 this reported a gross VOI of -15, below zero; now withheld.',
        voi_inputs(pos_post=(20, 80), neg_post=(20, 80)))
    add('certainPosteriorsWithheld', 'Both indicators typed 100 / 0 imply certain success against 30 stated. Before EC4-0 this reported a gross VOI of 245 beside an EVPI of 63; now withheld.',
        voi_inputs(pos_post=(100, 0), neg_post=(100, 0)))
    add('consistentAtHalfPercent', 'Positive posteriors 61.25 / 38.75 imply 30.5 percent success against 30 stated, a delta of exactly half a percent: consistent (inclusive threshold), so every KPI and the tree are reported.',
        voi_inputs(pos_post=(F(6125, 100), F(3875, 100))))
    add('withheldPastHalfPercent', 'Positive posteriors 61.5 / 38.5 imply 30.6 percent success against 30 stated, a delta of 0.6 percent: withheld.',
        voi_inputs(pos_post=(F(615, 10), F(385, 10))))
    add('costExactlyValue', 'Degenerate: cost 33 equals the gross VOI; net VOI exactly 0; card 0.00; verdict neutral.', voi_inputs(cost=33))
    add('netRoundsToZeroFromAbove', 'EC4-2: cost 32.996 leaves a net VOI of +0.004, which rounds to a 0.00 card; the verdict reads that card and is neutral. Before, the unrounded value put "Since this is positive" under a 0.00 card.',
        voi_inputs(cost=F('32.996')))
    add('netRoundsToZeroFromBelow', 'EC4-2: cost 33.004 leaves a net VOI of -0.004; the card reads 0.00 (never -0.00) and the verdict is neutral. Before, the card read -0.00 under "not justified".',
        voi_inputs(cost=F('33.004')))
    add('netHalfCentAbove', 'EC4-2 boundary: cost 32.995 leaves exactly +0.005, which rounds half away from zero to a 0.01 card; verdict acquire.',
        voi_inputs(cost=F('32.995')))
    add('netHalfCentBelow', 'EC4-2 boundary: cost 33.005 leaves exactly -0.005, which rounds to a -0.01 card; verdict reject.',
        voi_inputs(cost=F('33.005')))
    add('netClearlyPositive', 'EC4-2: cost 32.9 leaves a net VOI of +0.10; card 0.10; verdict acquire.', voi_inputs(cost=F('32.9')))
    add('netClearlyNegative', 'EC4-2: cost 33.1 leaves a net VOI of -0.10; card -0.10; verdict reject.', voi_inputs(cost=F('33.1')))
    for cid, desc, inp in (
            ('compoundEdgeAllThirds', 'EC4-9: every outcome chance, indicator chance and outcome chance given an indicator typed 33.3333, so every sum sits on the 1e-4 edge. Before EC4-9 the diagram\'s "Signal received" node summed to 0.999998 and the analysis was refused; the renormalised indicator sets now give the full cards and diagram (a useless signal, VOI 0).',
             voi_compound(ALL_THIRDS_ROWS, '33.3333')),
            ('compoundEdgeAllThirdsExact', 'EC4-9 reference: the same analysis at exact thirds; compoundEdgeAllThirds agrees with it within the stated tolerance.',
             voi_compound(ALL_THIRDS_ROWS, None)),
            ('compoundEdgeInformative', 'EC4-9: outcome and indicator chances typed 33.3333, and informative outcome chances given each indicator typed to four places (66.6666 / 22.2222 / 11.1111 and its mirrors), every sum on the edge. Refused at "Signal received" before EC4-9; now the full analysis.',
             voi_compound(INFORMATIVE_ROWS, '33.3333')),
            ('compoundEdgeInformativeExact', 'EC4-9 reference: the same analysis at exact thirds and ninths; compoundEdgeInformative agrees with it within the stated tolerance.',
             voi_compound(INFORMATIVE_ROWS, None))):
        add(cid, desc, inp)
    tied = voi_inputs()
    tied['decisionCost'] = 55
    add('actionsTiedWithoutInfo',
        'EC4-1: a decision cost of 55 makes drilling worth exactly 0 without information, the same as not drilling. Both actions are tied, the Analyzer says the decision is indifferent between them, and it names both instead of the first listed.',
        tied)
    near_tie = voi_inputs()
    near_tie['decisionCost'] = F('54.9999')
    add('actionsNearTieOutsideTolerance',
        'EC4-1 control: a decision cost of 54.9999 leaves drilling worth 0.0001, outside the band, so drilling alone is optimal even though the EMV card still reads 0.00.',
        near_tie)
    add('thirdsOutcomeChancesFourPlaces', 'EC4-8: three outcome chances typed 33.3333 percent sum to 99.9999, exactly 1e-4 percent points short, and are accepted end to end (prior tree included); indicators 50 / 50 with outcome chances 50 / 30 / 20 and 16.6666 / 36.6667 / 46.6667, consistent with the stated thirds.',
        voi_thirds())
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


def voi_refusals():
    cases = []

    def add(cid, desc, inputs):
        refusal = voi_percent_refusal(inputs)
        assert refusal is not None, 'oracle accepted %s' % cid
        try:
            voi_analyzer(inputs)
        except Refused:
            pass
        else:
            raise AssertionError('oracle accepted %s' % cid)
        rec = {'id': cid, 'description': desc, 'inputs': inputs, 'reason': refusal[0]}
        if refusal[1] is not None:
            rec['sumPercent'] = refusal[1]
        cases.append(rec)

    add('posteriorsAboveHundred', 'Suite: positive posteriors 90 / 40 sum to 130. Before EC4-0 the KPIs computed from them (VOI 69 above the EVPI of 63) and only the diagram was withheld.',
        voi_inputs(pos_post=(90, 40)))
    mixed = voi_inputs(pos_probability=50, pos_post=(60, 50), neg_post=(0, 90))
    add('posteriorsOffsetButPriorsAgree', 'Indicators 50 / 50 with outcome chances 60 / 50 (sum 110) and 0 / 90 (sum 90). The implied priors still equal the stated 30 / 70, so the consistency check passed, and before EC4-0 the cards (EMV with information 47.5) disagreed with the diagram (45.5).',
        mixed)
    over = voi_inputs()
    over['infoScenario']['indicators'][1]['probability'] = 70
    add('indicatorChancesAboveHundred', 'Indicator chances 40 + 70 = 110. Before EC4-0 the cards matched the defaults and the diagram silently disappeared.', over)
    short = voi_inputs()
    short['outcomes'][1]['probability'] = 60
    add('outcomeChancesBelowHundred', 'Outcome chances 30 + 60 = 90, named in percent.', short)
    missing = voi_inputs()
    missing['infoScenario']['indicators'][0]['conditionalProbabilities'] = [{'outcomeId': 1, 'probability': 60}]
    add('missingOutcomeChanceCountsAsZero', 'The positive indicator has no entry for the dry hole, so its outcome chances sum to 60.', missing)
    negative = voi_inputs(pos_post=(-10, 110))
    add('chanceOutsideRange', 'Outcome chances -10 / 110 sum to 100 but are not chances.', negative)
    three = voi_thirds('33.333')
    add('thirdsOutcomeChancesThreePlaces', 'EC4-8: outcome chances typed 33.333 percent sum to 99.999, a thousandth of a point short; the binary allowance does not widen the tolerance.', three)
    short3 = voi_thirds()
    short3['outcomes'][2]['probability'] = F('33.3332')
    add('outcomeChancesShortByTwoTenThousandths', 'EC4-8: 33.3333 + 33.3333 + 33.3332 = 99.9998 percent, twice the tolerance short; still refused.', short3)
    none = voi_inputs()
    none['infoScenario']['indicators'] = []
    add('noIndicators', 'An information scenario with no indicators has nothing to value.', none)

    def money(cid, desc, inputs, refusal):
        """EC4-4: money in the Analyzer inputs, refused by field."""
        assert voi_percent_refusal(inputs) is None, 'the percent inputs are distributions'
        try:
            voi_analyzer(inputs)
        except Refused as err:
            for k, v in refusal.items():
                assert err.details.get(k) == v, (cid, k, err.details.get(k), v)
        else:
            raise AssertionError('oracle accepted %s' % cid)
        cases.append({'id': cid, 'description': desc, 'inputs': inputs,
                      'reason': desc.split(':')[0], 'refusal': refusal})

    blank_survey = voi_inputs()
    blank_survey['infoScenario']['cost'] = ''
    money('surveyCostBlank', 'EC4-4: a survey cost cleared to a blank string is refused naming the scenario. Before, it read as 0 and the net VOI equalled the gross.',
          blank_survey, {'kind': 'blank', 'field': 'cost',
                         'subject': 'Information scenario "3D Seismic Survey"', 'node': None})
    text_survey = voi_inputs()
    text_survey['infoScenario']['cost'] = 'abc'
    money('surveyCostNonNumeric', 'EC4-4: a survey cost of "abc" is refused. Before, the cards read NaN.',
          text_survey, {'kind': 'notNumber', 'field': 'cost',
                        'subject': 'Information scenario "3D Seismic Survey"', 'node': None})
    negative_survey = voi_inputs()
    negative_survey['infoScenario']['cost'] = -10
    money('surveyCostNegative', 'EC4-4: a survey cost of -10 is refused: a receipt belongs in the payoffs. Before, it was added to the value of information.',
          negative_survey, {'kind': 'negative', 'field': 'cost',
                            'subject': 'Information scenario "3D Seismic Survey"', 'node': None})
    blank_decision = voi_inputs()
    blank_decision['decisionCost'] = ''
    money('decisionCostBlank', 'EC4-4: a blank decision cost is refused naming the action. Before, the well looked free to drill.',
          blank_decision, {'kind': 'blank', 'field': 'cost',
                           'subject': 'Action "Drill Exploration Well"', 'node': None})
    null_payoff = voi_inputs()
    null_payoff['outcomes'][1]['payoff'] = None
    money('outcomePayoffNull', 'EC4-4: an outcome payoff cleared to null is refused naming the action and the outcome. Before, it was worth 0, so a dry hole looked free.',
          null_payoff, {'kind': 'blank', 'field': 'payoff',
                        'subject': 'Payoff of action "Drill Exploration Well" for outcome "Dry Hole"',
                        'node': None})
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
            'signal accuracy and information cost, and degenerate and refused cases. EC4-1 (owner '
            'decision 2026-09-15): a decision node and a best-action result carry every tied index and '
            'whether the choice is indifferent, and the first listed of the tied ones keeps the '
            'optimal-path marking. EC4-4 (same date): money that is omitted is 0, money that is present '
            'must be a finite number, and a negative cost is refused, each naming what carries it '
            '(rollbackRefusals, lotteryRefusals and the money cases in voiRefusals); a case carrying a '
            'NaN or an infinity holds a placeholder string and a `nonFinite` instruction, since JSON '
            'cannot hold either. As repaired in EC4-0, '
            'the VOI Analyzer refuses percent inputs that are not distributions (voiRefusals) and withholds '
            'everything that depends on the indicator entries when they contradict the stated priors.'
        ),
        'rollback': rollback_cases(),
        'rollbackRefusals': rollback_refusals(),
        'lotteryRefusals': lottery_refusals(),
        'evpi': evpi_cases(),
        'evii': evii_cases(),
        'eviiRefusals': evii_refusals(),
        'impliedPriors': implied_cases(),
        'informationTree': information_tree_cases(),
        'voi': voi_cases(),
        'voiRefusals': voi_refusals(),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(out(golden), f, indent=1, sort_keys=True)
        f.write('\n')
    counts = {k: len(v) for k, v in golden.items() if isinstance(v, list)}
    print('wrote %s: %s (total %d)' % (OUT, counts, sum(counts.values())))


if __name__ == '__main__':
    main()
