#!/usr/bin/env python3
"""Independent oracle for the artificial lift advisor
(engines/production/liftAdvisor.js). Emits committed goldens to
test-data/production/goldens/lift_advisor_cases.json.

WHAT IS BEING GATED. The advisor's own content is POLICY, not physics:
which reference stage to probe with, which motor frame to hang on a
shaft load, which rung of a rod ladder counts as the answer, what a
refusal means, and how a screening opinion is reconciled against a
design. The design chains themselves are gated in their own suites and
are injected here, which is exactly what makes the policy checkable
without judgement.

INDEPENDENCE DISCIPLINE. Written from the policy statement, not by
transcribing the JS:

  reference stage   the engine takes the FIRST catalog entry whose
                    published range covers the duty, falling back to the
                    nearest best-efficiency point. The oracle builds the
                    COVERING SET and the BEP-DISTANCE RANKING as two
                    separate structures and reports both, so where the
                    ranges OVERLAP the ambiguity is measured instead of
                    inherited. Those bands exist (1250-1450, 2200-3500
                    and 4000-5600 bbl/d) and inside them the engine's
                    answer is decided by catalog order, not by fit.

  motor frame       the engine runs a forward `find` for the first frame
                    with 25 per cent headroom. The oracle MINIMISES hp
                    over the set of frames satisfying the inequality,
                    which equals a forward find only if the catalog is
                    hp-ascending -- and the oracle asserts that
                    separately rather than assuming it. It also reports
                    the shaft load above which the fallback returns a
                    frame that does NOT meet the rule.

  rod ladder        the engine scans the ladder and takes the first
                    match. The oracle performs a SET SELECTION over all
                    six rungs at once: the workable set, the meeting
                    subset, then a minimum over ladder position, or a
                    maximum over achieved rate when the meeting subset
                    is empty. A scan and a selection agree only if the
                    ladder really is ordered, which the oracle also
                    checks by computing each rung's displacement.

  plunger GLR       derived from a MASS BALANCE (gas = GOR x oil,
                    liquid = oil / (1 - wc), so GLR = GOR (1 - wc))
                    rather than from the expression in the module.

  reconciliation    enumerated as a full FOUR-WAY TRUTH TABLE over
                    (has an engine, has a design, the design worked, the
                    screening recommended it), so a missing branch
                    cannot hide behind the cases anyone thought to try.

  interpolation     the measured depth at a true vertical depth is
                    written as the closed-form linear interpolant of the
                    bracketing survey stations.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_liftadvisor.py
"""
import json
import math
import os

# ---------------------------------------------------------------------
# The catalogs the policy picks out of, restated here so that a change
# to the catalog is itself caught by the gate rather than silently
# moving every answer.
# ---------------------------------------------------------------------

REFERENCE_STAGES = [
    {'id': 'ref-400-1000', 'housingOdIn': 4.0, 'bepBpd': 1000, 'qMin': 500, 'qMax': 1450},
    {'id': 'ref-540-2500', 'housingOdIn': 5.13, 'bepBpd': 2500, 'qMin': 1250, 'qMax': 3500},
    {'id': 'ref-562-4000', 'housingOdIn': 5.62, 'bepBpd': 4000, 'qMin': 2200, 'qMax': 5600},
    {'id': 'ref-675-7000', 'housingOdIn': 6.75, 'bepBpd': 7000, 'qMin': 4000, 'qMax': 9800},
]

MOTOR_FRAMES = [
    {'id': 'm-60-1000', 'hp': 60}, {'id': 'm-100-1300', 'hp': 100},
    {'id': 'm-150-2000', 'hp': 150}, {'id': 'm-250-2400', 'hp': 250},
    {'id': 'm-400-3300', 'hp': 400},
]

ROD_TRIALS = [
    {'plungerDIn': 1.25, 'strokeIn': 48, 'spm': 6},
    {'plungerDIn': 1.5, 'strokeIn': 54, 'spm': 7},
    {'plungerDIn': 1.75, 'strokeIn': 64, 'spm': 9},
    {'plungerDIn': 2.0, 'strokeIn': 74, 'spm': 10},
    {'plungerDIn': 2.25, 'strokeIn': 86, 'spm': 11},
    {'plungerDIn': 2.75, 'strokeIn': 120, 'spm': 12},
]

RATE_TOLERANCE = 0.9
HEADROOM = 1.25


# ---------------------------------------------------------------------
# Reference stage: the covering SET and the BEP ranking, separately
# ---------------------------------------------------------------------

def covering_set(q):
    """Every catalog stage whose published range covers the duty. More
    than one can, and that is the point."""
    return [s['id'] for s in REFERENCE_STAGES if s['qMin'] <= q <= s['qMax']]


def bep_ranking(q):
    """The catalog ordered by distance from its best-efficiency point.
    Ties keep catalog order, which is what a strict `<` comparison in a
    reduction does."""
    order = sorted(range(len(REFERENCE_STAGES)),
                   key=lambda i: (abs(REFERENCE_STAGES[i]['bepBpd'] - q), i))
    return [REFERENCE_STAGES[i]['id'] for i in order]


def pick_stage(q):
    """Item 22. The covering set is the candidate set, and the nearest
    best-efficiency point wins inside it. It used to be cov[0], which is
    catalog order, which is always the smaller housing."""
    cov = covering_set(q)
    if cov:
        return next(i for i in bep_ranking(q) if i in cov)
    return bep_ranking(q)[0]


def overlap_bands():
    """Where two published ranges cover the same duty. Item 22: inside
    these the pick is now the nearest best-efficiency point of the two,
    so it moves with the duty across the band instead of being decided
    by catalog order. `pickedByCatalogOrder` is what it used to be, kept
    so the size of the change is on the record."""
    bands = []
    for i in range(len(REFERENCE_STAGES) - 1):
        a, b = REFERENCE_STAGES[i], REFERENCE_STAGES[i + 1]
        lo, hi = max(a['qMin'], b['qMin']), min(a['qMax'], b['qMax'])
        if lo <= hi:
            bands.append({'from': lo, 'to': hi, 'stages': [a['id'], b['id']],
                          'picked': pick_stage(lo),
                          'pickedAtTop': pick_stage(hi),
                          'pickedByCatalogOrder': a['id'],
                          'nearestBepAtTop': bep_ranking(hi)[0]})
    return bands


# ---------------------------------------------------------------------
# Motor frame: a minimisation over the satisfying set
# ---------------------------------------------------------------------

def catalog_is_hp_ascending():
    return all(MOTOR_FRAMES[i]['hp'] < MOTOR_FRAMES[i + 1]['hp']
               for i in range(len(MOTOR_FRAMES) - 1))


def pick_motor(shaft_hp):
    """The smallest frame satisfying hp >= 1.25 x shaft, found by
    MINIMISING over the satisfying set rather than by scanning. Falls
    back to the largest frame in the catalog, which does NOT satisfy the
    rule -- reported as such."""
    ok = [m for m in MOTOR_FRAMES if m['hp'] >= shaft_hp * HEADROOM]
    if ok:
        m = min(ok, key=lambda x: x['hp'])
        return {'id': m['id'], 'hp': m['hp'], 'meetsHeadroom': True,
                'actualHeadroom': m['hp'] / shaft_hp if shaft_hp > 0 else None}
    m = MOTOR_FRAMES[-1]
    return {'id': m['id'], 'hp': m['hp'], 'meetsHeadroom': False,
            'actualHeadroom': m['hp'] / shaft_hp if shaft_hp > 0 else None,
            'overloaded': m['hp'] < shaft_hp}


# ---------------------------------------------------------------------
# The rod ladder, as a selection over the whole set
# ---------------------------------------------------------------------

def displacement(t):
    """Pump displacement is proportional to plunger AREA times stroke
    times speed. The ladder claims to ascend; this is the quantity in
    which it must."""
    return (math.pi / 4.0) * t['plungerDIn'] ** 2 * t['strokeIn'] * t['spm']


def ladder_is_ascending():
    ds = [displacement(t) for t in ROD_TRIALS]
    return all(ds[i] < ds[i + 1] for i in range(len(ds) - 1))


def select_rung(outcomes, target):
    """outcomes[i] is one of
         {'refused': reason}
         {'producedBpd': x, 'loadingPct': y}      (y may be None = unknown)

    The policy: discard a refused rung; discard a rung whose worst rod
    section runs OVER 100 per cent of its allowable; of what remains,
    take the lowest-index rung producing at least RATE_TOLERANCE of the
    target; failing that, report the rung that got closest as a
    SHORTFALL.

    NOTE THE UNKNOWN. A rung whose loading is not known is NOT
    discarded, because `NaN > 100` is false. That is the engine's
    behaviour and it is reproduced here so the consequence is visible in
    the golden rather than hidden.
    """
    workable = []
    attempts = []
    for i, o in enumerate(outcomes):
        if 'refused' in o:
            attempts.append({'index': i, 'reason': o['refused']})
            continue
        loading = o['loadingPct']
        overloaded = loading is not None and loading > 100
        if overloaded:
            attempts.append({'index': i, 'reason': 'overloaded'})
            continue
        workable.append({'index': i, 'producedBpd': o['producedBpd'],
                         'loadingPct': loading,
                         'loadingKnown': loading is not None})

    meets = [x for x in workable if x['producedBpd'] >= target * RATE_TOLERANCE]
    if meets:
        best = min(meets, key=lambda x: x['index'])
        return {'ok': True, 'index': best['index'],
                'producedBpd': best['producedBpd'],
                'loadingPct': best['loadingPct'],
                'loadingKnown': best['loadingKnown'],
                'workableIndices': [x['index'] for x in workable],
                'meetsIndices': [x['index'] for x in meets],
                'attempts': len(attempts)}
    if workable:
        # first on ties, which is what a strict > in a reduction gives
        best = max(workable, key=lambda x: (x['producedBpd'], -x['index']))
        return {'ok': False, 'shortfall': True, 'index': best['index'],
                'producedBpd': best['producedBpd'],
                'targetBpd': target,
                'workableIndices': [x['index'] for x in workable],
                'meetsIndices': [], 'attempts': len(attempts)}
    return {'ok': False, 'shortfall': False, 'index': None,
            'workableIndices': [], 'meetsIndices': [], 'attempts': len(attempts)}


LADDER_SCENARIOS = [
    {
        'id': 'smallestThatMeets',
        'why': 'Four rungs meet the target. The answer is the SMALLEST of them, '
               'because the ladder ascends in displacement and a bigger unit costs money.',
        'target': 300.0,
        'outcomes': [{'producedBpd': 120.0, 'loadingPct': 40.0},
                     {'producedBpd': 210.0, 'loadingPct': 55.0},
                     {'producedBpd': 340.0, 'loadingPct': 70.0},
                     {'producedBpd': 500.0, 'loadingPct': 80.0},
                     {'producedBpd': 700.0, 'loadingPct': 88.0},
                     {'producedBpd': 1100.0, 'loadingPct': 95.0}],
    },
    {
        'id': 'firstThatDesignsIsNotTheAnswer',
        'why': 'Every rung designs cleanly, but the first one makes a THIRD of what was '
               'asked. Reporting it as a success would be the most misleading thing the '
               'advisor could do.',
        'target': 300.0,
        'outcomes': [{'producedBpd': 100.0, 'loadingPct': 30.0},
                     {'producedBpd': 150.0, 'loadingPct': 42.0},
                     {'producedBpd': 200.0, 'loadingPct': 55.0},
                     {'producedBpd': 250.0, 'loadingPct': 66.0},
                     {'producedBpd': 290.0, 'loadingPct': 74.0},
                     {'producedBpd': 400.0, 'loadingPct': 90.0}],
    },
    {
        'id': 'toleranceBites',
        'why': 'The best rung makes 271 against a target of 300, which is 90.3 per cent '
               'and just inside the tolerance. At 269 it would be a shortfall.',
        'target': 300.0,
        'outcomes': [{'producedBpd': 100.0, 'loadingPct': 30.0},
                     {'producedBpd': 150.0, 'loadingPct': 42.0},
                     {'producedBpd': 200.0, 'loadingPct': 55.0},
                     {'producedBpd': 250.0, 'loadingPct': 66.0},
                     {'producedBpd': 269.0, 'loadingPct': 74.0},
                     {'producedBpd': 271.0, 'loadingPct': 90.0}],
    },
    {
        'id': 'overloadedRungsDiscarded',
        'why': 'Two rungs design but run their rods past the Goodman allowable. They are '
               'not answers, and the largest of them is not the fallback either.',
        'target': 600.0,
        'outcomes': [{'producedBpd': 120.0, 'loadingPct': 40.0},
                     {'producedBpd': 210.0, 'loadingPct': 55.0},
                     {'producedBpd': 340.0, 'loadingPct': 70.0},
                     {'producedBpd': 900.0, 'loadingPct': 105.0},
                     {'producedBpd': 700.0, 'loadingPct': 88.0},
                     {'producedBpd': 1400.0, 'loadingPct': 130.0}],
    },
    {
        'id': 'shortfall',
        'why': 'Rod pumping is rate-limited by the plunger it can swing at this depth, and '
               'this well is past it. The honest answer is the achieved rate, not a refusal '
               'with no number in it. The target is stated in LIQUID and the ladder is '
               'walked against the oil derived from it, so 2,400 bbl/d at 40 per cent water '
               'cut is 1,440 stb/d of oil against a best rung of 1,100.',
        'target': 2400.0,
        'outcomes': [{'producedBpd': 120.0, 'loadingPct': 40.0},
                     {'producedBpd': 210.0, 'loadingPct': 55.0},
                     {'producedBpd': 340.0, 'loadingPct': 70.0},
                     {'producedBpd': 500.0, 'loadingPct': 80.0},
                     {'producedBpd': 700.0, 'loadingPct': 88.0},
                     {'producedBpd': 1100.0, 'loadingPct': 95.0}],
    },
    {
        'id': 'loadingUnknownFailsOpen',
        'why': 'FINDING. One rung comes back with no worst rod section, so its loading is '
               'unknown. The guard compares an unknown against 100 and lets it through, so '
               'the rung becomes the ANSWER and its loading is reported as NaN. Had the '
               'unknown been treated as a failure the answer would have been a shortfall '
               'at 1100 bbl/d instead. The target is 3,400 bbl/d of liquid, which is 2,040 '
               'stb/d of oil at 40 per cent water cut.',
        'target': 3400.0,
        'outcomes': [{'producedBpd': 120.0, 'loadingPct': 40.0},
                     {'producedBpd': 210.0, 'loadingPct': 55.0},
                     {'producedBpd': 340.0, 'loadingPct': 70.0},
                     {'producedBpd': 500.0, 'loadingPct': 80.0},
                     {'producedBpd': 1100.0, 'loadingPct': 95.0},
                     {'producedBpd': 3000.0, 'loadingPct': None}],
    },
    {
        'id': 'nothingDesigns',
        'why': 'The chain refuses every rung. There is no design and no shortfall to '
               'report, only the reason the last attempt failed.',
        'target': 500.0,
        'outcomes': [{'refused': 'no inflow'}] * 6,
    },
]


LADDER_WCT_PCT = 40.0


def ladder_alternative(scenario):
    """The same scenario with an unknown loading treated as a FAILURE
    rather than a pass, so the golden carries what the fails-open guard
    is actually costing."""
    outcomes = [dict(o) for o in scenario['outcomes']]
    strict = []
    for o in outcomes:
        if 'refused' not in o and o['loadingPct'] is None:
            strict.append({'refused': 'loading unknown'})
        else:
            strict.append(o)
    return select_rung(strict, oil_design_rate(scenario['target'], LADDER_WCT_PCT))


# ---------------------------------------------------------------------
# Small closed forms
# ---------------------------------------------------------------------

def liquid_gravity(api, wct):
    """Oil and water in the produced proportion, water taken as 1.0."""
    return (141.5 / (api + 131.5)) * (1.0 - wct) + wct


def md_at_tvd(points, tvd):
    """The closed-form linear interpolant between the bracketing survey
    stations. Below the deepest station the deepest measured depth is
    returned; a trajectory says nothing about hole not yet drilled."""
    if not points:
        return 0.0
    if not tvd > 0:
        return points[0]['md']
    for i in range(1, len(points)):
        if points[i]['tvd'] >= tvd:
            span = points[i]['tvd'] - points[i - 1]['tvd']
            if not span > 0:
                return points[i]['md']
            f = (tvd - points[i - 1]['tvd']) / span
            return points[i - 1]['md'] + f * (points[i]['md'] - points[i - 1]['md'])
    return points[-1]['md']


TRAJECTORY = [
    {'md': 0.0, 'tvd': 0.0},
    {'md': 3000.0, 'tvd': 3000.0},
    {'md': 5000.0, 'tvd': 4600.0},   # building
    {'md': 8000.0, 'tvd': 6400.0},   # tangent at ~53 degrees
    {'md': 11000.0, 'tvd': 7000.0},  # near horizontal
]


def oil_design_rate(target_liquid_rate, wct_pct):
    """Item 19, second half. The rate at the door is LIQUID; every
    design chain consumes OIL."""
    wct = min(max(wct_pct, 0.0), 100.0)
    return target_liquid_rate * (1.0 - wct / 100.0)


def plunger_glr(target_rate, gor, wct_pct):
    """GLR from a MASS BALANCE, not from the module's expression.

    gas    = GOR x oil
    liquid = oil + water = oil / (1 - wc)
    GLR    = gas / liquid = GOR (1 - wc)

    Since item 19 the rate at the door is the LIQUID rate, so the oil is
    derived from it and the liquid the cycle sees IS the number that came
    in. It used to be that number divided by (1 - wc), which on a 40 per
    cent water cut well is a liquid rate two thirds again too big. The
    GLR itself is invariant, which is why nothing downstream of it moves.

    The water cut is clamped just under one, because at exactly one
    there is no oil to carry the gas and the ratio is not defined.
    """
    wct = min(max(wct_pct / 100.0, 0.0), 0.999)
    # the derivation is taken at the SAME clamped water cut, so the two
    # readings of the ratio agree at 100 per cent water cut as well
    oil = oil_design_rate(target_rate, wct * 100.0)
    liquid = oil / (1.0 - wct) if wct > 0 else oil
    return {'wctFrac': wct, 'oilBpd': oil, 'liquidBpd': liquid,
            'glrScfBbl': gor * (1.0 - wct) if target_rate > 0 else gor,
            'glrByRatio': (gor * oil / liquid) if liquid > 0 else gor}


# ---------------------------------------------------------------------
# The reconciliation truth table
# ---------------------------------------------------------------------

def verdict(has_engine, has_design, design_ok, recommended):
    if not has_engine:
        return 'noEngine'
    if not has_design:
        return 'notRun'
    if design_ok and recommended:
        return 'agreeYes'
    if design_ok and not recommended:
        return 'designYes'
    if not design_ok and recommended:
        return 'designNo'
    return 'agreeNo'


def truth_table():
    rows = []
    for has_engine in (True, False):
        for has_design in (True, False):
            for design_ok in (True, False):
                for recommended in (True, False):
                    if not has_design and design_ok:
                        continue  # not a state that exists
                    rows.append({
                        'hasEngine': has_engine, 'hasDesign': has_design,
                        'designOk': design_ok, 'recommended': recommended,
                        'verdict': verdict(has_engine, has_design, design_ok, recommended),
                    })
    return rows


RECONCILE_CASE = {
    'why': 'One well, four engine-backed methods and two screened-only ones. The matrix '
           'liked the rod pump and the design refuses it; it was lukewarm about plunger '
           'lift and the design runs it cleanly. Both are disagreements and both are '
           'resolved in favour of the design, which solved the well.',
    'screening': [
        {'id': 'gasLift', 'score': 100, 'recommended': True, 'hasEngine': True},
        {'id': 'rodPump', 'score': 90, 'recommended': True, 'hasEngine': True},
        {'id': 'esp', 'score': 60, 'recommended': False, 'hasEngine': True},
        {'id': 'pcp', 'score': 55, 'recommended': False, 'hasEngine': False},
        {'id': 'plunger', 'score': 45, 'recommended': False, 'hasEngine': True},
        {'id': 'jetPump', 'score': 40, 'recommended': False, 'hasEngine': False},
    ],
    'design': {'gasLift': True, 'rodPump': False, 'esp': False, 'plunger': True},
}


def reconcile_case():
    rows = []
    for s in RECONCILE_CASE['screening']:
        has_design = s['id'] in RECONCILE_CASE['design']
        ok = RECONCILE_CASE['design'].get(s['id'], False)
        rows.append({'id': s['id'], 'score': s['score'],
                     'verdict': verdict(s['hasEngine'], has_design, ok, s['recommended']),
                     'designOk': ok if has_design else None})
    ranked = sorted(range(len(rows)),
                    key=lambda i: (0 if rows[i]['designOk'] else 1, -rows[i]['score'], i))
    return {
        'rows': rows,
        'disagreements': [r['id'] for r in rows if r['verdict'] in ('designYes', 'designNo')],
        'workable': [r['id'] for r in rows if r['designOk']],
        'ranked': [rows[i]['id'] for i in ranked],
    }


# ---------------------------------------------------------------------
# The plunger pass, end to end
# ---------------------------------------------------------------------

PLUNGER_WELLS = [
    {
        'id': 'gassyStripper',
        'why': 'A gas well making twenty barrels a day with twelve thousand scf behind each '
               'one. There is far more gas than a cycle needs and the plunger runs.',
        'targetRate': 20.0, 'wctPct': 30.0, 'gorScfStb': 12000.0, 'whp': 120.0,
        'tvdMax': 7000.0, 'idIn': 2.441, 'api': 45.0, 'gasSg': 0.62,
        'whtF': 90.0, 'bhtF': 210.0,
        'facility': {'slugLengthFt': 150.0, 'plungerWeightLb': 6.0},
    },
    {
        'id': 'notEnoughGas',
        'why': 'The same depth and the same slug, but two hundred scf per barrel. There is '
               'no external energy source in plunger lift, so this well cannot be plunged '
               'and the answer is a refusal with the number in it.',
        'targetRate': 60.0, 'wctPct': 30.0, 'gorScfStb': 200.0, 'whp': 120.0,
        'tvdMax': 7000.0, 'idIn': 2.441, 'api': 32.0, 'gasSg': 0.65,
        'whtF': 90.0, 'bhtF': 210.0,
        'facility': {'slugLengthFt': 150.0, 'plungerWeightLb': 6.0},
    },
    {
        'id': 'wateredOutCutsTheGlr',
        'why': 'Nine thousand scf per barrel of OIL, but ninety per cent water: every point '
               'of water cut is gas the cycle no longer has per barrel it must lift, so the '
               'ratio the cycle actually sees is nine hundred.',
        'targetRate': 15.0, 'wctPct': 90.0, 'gorScfStb': 9000.0, 'whp': 120.0,
        'tvdMax': 6000.0, 'idIn': 2.441, 'api': 38.0, 'gasSg': 0.65,
        'whtF': 90.0, 'bhtF': 190.0,
        'facility': {'slugLengthFt': 150.0, 'plungerWeightLb': 6.0},
    },
]


def plunger_inputs(w):
    """What the advisor must hand the plunger chain, derived from the
    stated defaults rather than read off the module."""
    wct = w['wctPct'] / 100.0
    facility = w['facility']
    depth = w['tvdMax']
    # A linear temperature between wellhead and bottomhole; the average
    # of the two ends is the average of a straight line.
    avg_temp_r = (w['whtF'] + w['bhtF']) / 2.0 + 460.0
    return {
        'depthFt': depth,
        'idIn': w['idIn'],
        'linePressurePsia': w['whp'],
        'casingPressurePsia': facility.get('casingPressurePsia', w['whp'] * 2.5),
        'slugLengthFt': facility.get('slugLengthFt', 150.0),
        'liquidSg': liquid_gravity(w['api'], wct),
        'plungerWeightLb': facility.get('plungerWeightLb', 6.0),
        'gasSg': w['gasSg'],
        'avgTempR': avg_temp_r,
        'z': 0.9,
        'wellGlrScfBbl': plunger_glr(w['targetRate'], w['gorScfStb'], w['wctPct'])['glrScfBbl'],
        'afterflowMin': 20,
        'shutInMin': 30,
    }


# ---------------------------------------------------------------------
# Pass-level refusals
# ---------------------------------------------------------------------

# Item 19, second half. The absolute open flow is an OIL rate, and the
# target at the door is a LIQUID rate, so the comparison is made on the
# oil derived from it. Every case here carries the water cut it is run
# at and the oil rate that follows, and the three AOF cases are stated in
# LIQUID terms that land on the moved boundary: at 40 per cent water cut
# a 2,000 bbl/d liquid target is exactly the 1,200 stb/d open flow.
PASS_REFUSALS = [
    {'id': 'noModel', 'why': 'Nothing to design against.',
     'model': None, 'targetRate': 500.0, 'wctPct': 40.0, 'expect': 'incomplete'},
    {'id': 'gasWell', 'why': 'This pass designs lift for an OIL well.',
     'phase': 'gas', 'qmax': 5000.0, 'targetRate': 500.0, 'wctPct': 40.0, 'expect': 'gas'},
    {'id': 'noTarget', 'why': 'A target rate is needed before anything can be designed.',
     'phase': 'oil', 'qmax': 5000.0, 'targetRate': 0.0, 'wctPct': 40.0, 'expect': 'noTarget'},
    {'id': 'aboveAof',
     'why': 'No lift method makes a well produce more than it can deliver, so running four '
            'design chains to say so would be theatre. 2,200 bbl/d of liquid at 40 per cent '
            'water cut is 1,320 stb/d of oil against an open flow of 1,200.',
     'phase': 'oil', 'qmax': 1200.0, 'targetRate': 2200.0, 'wctPct': 40.0, 'expect': 'aboveAof'},
    {'id': 'atAof', 'why': 'AT the absolute open flow is also refused, not just above it. '
                           '2,000 bbl/d of liquid at 40 per cent water cut is exactly 1,200.',
     'phase': 'oil', 'qmax': 1200.0, 'targetRate': 2000.0, 'wctPct': 40.0, 'expect': 'aboveAof'},
    {'id': 'justBelowAof', 'why': 'Just below it the pass runs: 1,998 bbl/d of liquid is '
                                  '1,198.8 stb/d of oil.',
     'phase': 'oil', 'qmax': 1200.0, 'targetRate': 1998.0, 'wctPct': 40.0, 'expect': 'runs'},
]


# ---------------------------------------------------------------------

def emit():
    stage_sweep = []
    for q in (100, 400, 500, 900, 1250, 1300, 1449, 1450, 1451, 2200, 2500,
              3000, 3499, 3500, 3501, 4000, 4500, 5600, 5601, 7000, 9800, 12000):
        cov = covering_set(q)
        nearest_in_cov = next((i for i in bep_ranking(q) if i in cov), None) if cov \
            else bep_ranking(q)[0]
        stage_sweep.append({'q': q, 'coveringSet': cov,
                            'bepRanking': bep_ranking(q), 'picked': pick_stage(q),
                            # the rule (item 22): nearest BEP among the
                            # stages that COVER the duty
                            'nearestBepInCoveringSet': nearest_in_cov,
                            'pickedIsNearestInCoveringSet': pick_stage(q) == nearest_in_cov,
                            # and against the whole catalogue, which the
                            # covering set can legitimately differ from:
                            # a stage cannot be run outside its range
                            'pickedIsNearestBep': pick_stage(q) == bep_ranking(q)[0]})

    motor_sweep = [dict(pick_motor(hp), shaftHp=hp)
                   for hp in (10, 40, 48, 48.1, 80, 120, 200, 300, 319, 320, 321,
                              350, 400, 401, 500)]

    out = {
        'description': (
            'Artificial lift advisor goldens: the screening-grade equipment picks '
            '(reference stage, motor frame, rod ladder rung), the plunger design pass end '
            'to end, the pass-level refusals, and the reconciliation of a screening opinion '
            'against a design. Independent stdlib oracle '
            '(tools/validation/production/oracle_liftadvisor.py) written from the policy '
            'statement: the reference stage taken as a COVERING SET plus a separate '
            'BEP-distance ranking so the catalog overlap is measured rather than inherited, '
            'the motor found by MINIMISING over the satisfying set (with the catalog order '
            'asserted separately), the rod rung chosen by a SET SELECTION over all six rungs '
            'where the engine scans and takes the first match, the plunger gas-liquid ratio '
            'derived from a MASS BALANCE, and the reconciliation enumerated as a full '
            'four-way TRUTH TABLE. Field units: stb/d of OIL for the target rate, per cent '
            'water cut, scf/stb, psia, ft, hp, degF.'),
        'catalog': {'referenceStages': REFERENCE_STAGES, 'motorFrames': MOTOR_FRAMES,
                    'rodTrials': ROD_TRIALS,
                    'motorCatalogIsHpAscending': catalog_is_hp_ascending(),
                    'rodLadderIsAscending': ladder_is_ascending(),
                    'rodDisplacements': [displacement(t) for t in ROD_TRIALS],
                    'rateTolerance': RATE_TOLERANCE, 'headroom': HEADROOM},
        'referenceStage': {'sweep': stage_sweep, 'overlapBands': overlap_bands()},
        'motorFrame': {'sweep': motor_sweep,
                       'largestFrameHp': MOTOR_FRAMES[-1]['hp'],
                       'headroomLostAboveShaftHp': MOTOR_FRAMES[-1]['hp'] / HEADROOM,
                       'overloadedAboveShaftHp': MOTOR_FRAMES[-1]['hp']},
        # Item 19, second half. The ladder is walked against the OIL
        # rate now. `target` stays the liquid rate at the door, which is
        # what the scenario states; `oilTargetBpd` is what the chains are
        # asked for, and `resultAtLiquidTarget` is the selection as it
        # was, so the golden carries the size of the move.
        'rodLadder': [dict(
            s,
            wctPct=LADDER_WCT_PCT,
            oilTargetBpd=oil_design_rate(s['target'], LADDER_WCT_PCT),
            result=select_rung(s['outcomes'], oil_design_rate(s['target'], LADDER_WCT_PCT)),
            resultIfUnknownLoadingWereAFailure=ladder_alternative(s),
            resultAtLiquidTarget=select_rung(s['outcomes'], s['target']),
        ) for s in LADDER_SCENARIOS],
        'liquidGravity': [
            {'api': a, 'wct': w, 'sg': liquid_gravity(a, w)}
            for a, w in ((32.0, 0.0), (32.0, 0.5), (32.0, 1.0),
                         (14.0, 0.3), (45.0, 0.8), (10.0, 0.0))
        ],
        'mdAtTvd': {
            'trajectory': TRAJECTORY,
            'cases': [{'tvd': t, 'md': md_at_tvd(TRAJECTORY, t)}
                      for t in (0, -50, 1500, 3000, 3800, 4600, 5500, 6400,
                                6700, 7000, 9000)],
            'emptyTrajectoryMd': md_at_tvd([], 4000),
        },
        'plungerGlr': [
            dict(plunger_glr(r, g, w), targetRate=r, gorScfStb=g, wctPct=w)
            for r, g, w in ((100.0, 3000.0, 0.0), (100.0, 3000.0, 50.0),
                            (100.0, 3000.0, 90.0), (100.0, 3000.0, 100.0),
                            (100.0, 3000.0, -10.0), (0.0, 3000.0, 50.0))
        ],
        'plungerPass': [dict(w, chainInputs=plunger_inputs(w)) for w in PLUNGER_WELLS],
        'passRefusals': PASS_REFUSALS,
        'truthTable': truth_table(),
        'reconcile': dict(RECONCILE_CASE, expected=reconcile_case()),
    }

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.abspath(os.path.join(
        here, '..', '..', '..', 'test-data', 'production', 'goldens',
        'lift_advisor_cases.json'))
    with open(dest, 'w') as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', dest)


if __name__ == '__main__':
    emit()
