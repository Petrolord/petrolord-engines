#!/usr/bin/env python3
"""Independent oracle for the artificial lift screening matrix
(engines/production/liftScreening.js). Emits committed goldens to
test-data/production/goldens/lift_screening_cases.json.

WHAT AN ORACLE FOR A RULES MATRIX CAN AND CANNOT DO, SAID PLAINLY. A
screening matrix is not derived from anything, so there is no second
method to reach its numbers by. Re-typing its branches into Python would
gate nothing at all -- it would copy any mis-signed deduction along with
the rule. This oracle therefore does two different things instead.

  1. A DECLARATIVE PENALTY LEDGER. Every rule is written here as DATA:
     a named entry carrying a predicate, a deduction and the kind of
     reason it emits, either as an ordered BAND (first case that matches
     wins, which is what an if/elif chain means) or as an independent
     FLAG. One generic scorer walks the ledger for every method. Nothing
     in this file is a branch on a method name. A deduction attached to
     the wrong condition, applied twice, or applied with the wrong sign
     shows up as a ledger mismatch, and the ledger is short enough to be
     read against the published rules of thumb by a person.

  2. STRUCTURAL PROPERTIES THE TRANSCRIPTION CANNOT FAKE. These are
     computed, not copied, and they are the real gate:

       monotonicity   turning ON an adverse condition must never RAISE
                      a method's score, and turning on a favourable one
                      must never lower it. The oracle enumerates every
                      boolean condition against every method and emits
                      the sign each one moves the score by, so a rule
                      wired backwards is caught without anyone having to
                      notice it.

       the clamp      every score lands in 0..100 for every corner of
                      the input space the oracle sweeps.

       the band       `recommended` is exactly the set
                      {score >= top - 15 and score > 50}, recomputed
                      from the scores rather than read off the flags.

       ordering       best first, and ties keep catalog order.

       archetypes     seven wells an engineer would argue the answer for
                      in one sentence each, with the method that must
                      come out on top named in the golden.

  3. THE TWO SEAMS, MEASURED. A missing API is coerced to zero and read
     as heavier than any real crude; and the same `targetRate` is
     documented as liquid here and used as oil by the design pass. Both
     are emitted with the score movement they cause.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_liftscreening.py
"""
import json
import os

METHODS = [
    ('gasLift', 'Gas lift', True),
    ('esp', 'ESP', True),
    ('rodPump', 'Rod pump', True),
    ('plunger', 'Plunger lift', True),
    ('pcp', 'Progressing cavity pump', False),
    ('jetPump', 'Jet pump', False),
]


def normalise(inputs):
    """The screening's own input coercion, restated so its consequences
    are visible: `Number(x) || 0` turns a MISSING value into zero, and
    zero is not a neutral reading of anything."""
    def n(key):
        # `Number(x) || 0`: a missing, unparseable or NaN input lands on
        # ZERO, which is the whole of seam 2. Restated rather than
        # avoided, so the consequence can be measured below.
        v = inputs.get(key)
        try:
            f = float(v)
        except (TypeError, ValueError):
            return 0.0
        return 0.0 if f != f else f

    return {
        'targetRate': n('targetRate'), 'depthFt': n('depthFt'), 'gor': n('gor'),
        'wctPct': n('wctPct'), 'api': n('api'), 'bhtF': n('bhtF'),
        'isOffshore': bool(inputs.get('isOffshore')),
        'hasSand': bool(inputs.get('hasSand')),
        'isDeviated': bool(inputs.get('isDeviated')),
        'isHorizontal': bool(inputs.get('isHorizontal')),
        'powerAvailable': inputs.get('powerAvailable') is not False,
        'gasAvailable': inputs.get('gasAvailable') is not False,
        'reservoirPressureLow': bool(inputs.get('reservoirPressureLow')),
    }


def heavy(w):
    return w['api'] < 20


def med(w):
    return 20 <= w['api'] < 30


def duty_index(w):
    """Rate times depth is the group that actually binds a rod string,
    not either number alone."""
    return w['targetRate'] * w['depthFt'] / 1e6


# ---------------------------------------------------------------------
# THE PENALTY LEDGER. Data, not branches.
#
#   ('band', name, [(predicate, delta, kind), ...])  first match wins
#   ('flag', name, predicate, delta, kind)           independent
#   ('always', name, delta, kind)                    unconditional
# ---------------------------------------------------------------------

ALWAYS = lambda w: True  # noqa: E731

LEDGER = {
    'gasLift': [
        ('band', 'gasSupply', [
            (lambda w: not w['gasAvailable'], 60, 'con'),
            (ALWAYS, 0, 'pro')]),
        ('flag', 'makesGas', lambda w: w['gor'] > 500, 0, 'pro'),
        ('band', 'rateRange', [
            (lambda w: w['targetRate'] > 200, 0, 'pro'),
            (ALWAYS, 10, 'neutral')]),
        ('flag', 'sandIrrelevant', lambda w: w['hasSand'], 0, 'pro'),
        ('flag', 'noRods', lambda w: w['isDeviated'] or w['isHorizontal'], 0, 'pro'),
        ('flag', 'offshoreDefault', lambda w: w['isOffshore'], 0, 'pro'),
        ('flag', 'hotOk', lambda w: w['bhtF'] > 300, 0, 'pro'),
        ('flag', 'depleted', lambda w: w['reservoirPressureLow'], 25, 'con'),
        ('flag', 'deep', lambda w: w['depthFt'] > 12000, 10, 'neutral'),
    ],
    'esp': [
        ('band', 'powerSupply', [
            (lambda w: not w['powerAvailable'], 60, 'con'),
            (ALWAYS, 0, 'pro')]),
        ('band', 'rateRange', [
            (lambda w: w['targetRate'] >= 500, 0, 'pro'),
            (lambda w: w['targetRate'] >= 150, 15, 'neutral'),
            (ALWAYS, 35, 'con')]),
        ('band', 'freeGas', [
            (lambda w: w['gor'] > 2000, 35, 'con'),
            (lambda w: w['gor'] > 800, 15, 'neutral'),
            (ALWAYS, 0, 'pro')]),
        ('flag', 'abrasives', lambda w: w['hasSand'], 25, 'con'),
        ('flag', 'tooHot', lambda w: w['bhtF'] > 275, 20, 'con'),
        ('flag', 'lateral', lambda w: w['isHorizontal'], 10, 'neutral'),
        ('flag', 'viscous', heavy, 20, 'con'),
        ('flag', 'offshoreFit', lambda w: w['isOffshore'], 0, 'pro'),
    ],
    'rodPump': [
        ('band', 'dutyIndex', [
            (lambda w: duty_index(w) > 6, 40, 'con'),
            (lambda w: duty_index(w) > 3, 15, 'neutral'),
            (ALWAYS, 0, 'pro')]),
        ('always', 'commonest', 0, 'pro'),
        ('flag', 'economicRate', lambda w: w['targetRate'] < 400, 0, 'pro'),
        ('flag', 'highWatercut', lambda w: w['wctPct'] >= 70, 0, 'pro'),
        ('flag', 'gasInterference', lambda w: w['gor'] > 500, 20, 'con'),
        ('flag', 'sandWear', lambda w: w['hasSand'], 15, 'con'),
        ('band', 'rodWear', [
            (lambda w: w['isHorizontal'], 30, 'con'),
            (lambda w: w['isDeviated'], 15, 'con'),
            (ALWAYS, 0, None)]),
        ('flag', 'offshoreDeck', lambda w: w['isOffshore'], 25, 'con'),
        ('flag', 'positiveDisplacement', lambda w: heavy(w) or med(w), 0, 'pro'),
        ('flag', 'hotOk', lambda w: w['bhtF'] > 300, 0, 'pro'),
    ],
    'plunger': [
        ('band', 'rateCeiling', [
            (lambda w: w['targetRate'] > 200, 45, 'con'),
            (ALWAYS, 0, 'pro')]),
        ('band', 'gasPerBarrel', [
            (lambda w: w['gor'] >= 5000, 0, 'pro'),
            (lambda w: w['gor'] >= 1500, 20, 'neutral'),
            (ALWAYS, 55, 'con')]),
        ('flag', 'deep', lambda w: w['depthFt'] > 12000, 15, 'neutral'),
        ('always', 'cheapest', 0, 'pro'),
        ('flag', 'sandSticks', lambda w: w['hasSand'], 10, 'neutral'),
        ('flag', 'lateral', lambda w: w['isHorizontal'], 10, 'neutral'),
    ],
    'pcp': [
        ('band', 'elastomer', [
            (heavy, 0, 'pro'),
            (med, 0, 'pro'),
            (ALWAYS, 25, 'con')]),
        ('flag', 'sandTolerant', lambda w: w['hasSand'], 0, 'pro'),
        ('band', 'rateRange', [
            (lambda w: w['targetRate'] > 2000, 30, 'con'),
            (lambda w: w['targetRate'] < 50, 10, 'neutral'),
            (ALWAYS, 0, 'pro')]),
        ('flag', 'tooHot', lambda w: w['bhtF'] > 250, 35, 'con'),
        ('flag', 'rodTorque', lambda w: w['depthFt'] > 6000, 20, 'con'),
        ('flag', 'dryStator', lambda w: w['gor'] > 500, 20, 'con'),
        ('flag', 'lateral', lambda w: w['isHorizontal'], 20, 'con'),
    ],
    'jetPump': [
        ('always', 'noMovingParts', 0, 'pro'),
        ('flag', 'sandTolerant', lambda w: w['hasSand'], 0, 'pro'),
        ('flag', 'freePump', lambda w: w['isDeviated'] or w['isHorizontal'], 0, 'pro'),
        ('flag', 'hotOk', lambda w: w['bhtF'] > 300, 0, 'pro'),
        ('always', 'poorEfficiency', 20, 'con'),
        ('flag', 'powerFluidPlant', lambda w: not w['powerAvailable'], 25, 'con'),
        ('flag', 'lowRate', lambda w: w['targetRate'] < 100, 15, 'neutral'),
        ('flag', 'cavitation', lambda w: w['reservoirPressureLow'], 25, 'con'),
    ],
}


def score_from_ledger(method_id, w):
    """One generic scorer over the ledger. There is no branch on the
    method anywhere in here."""
    score = 100
    kinds = []
    fired = []
    for entry in LEDGER[method_id]:
        if entry[0] == 'always':
            _, name, delta, kind = entry
            score -= delta
            kinds.append(kind)
            if delta:
                fired.append(name)
        elif entry[0] == 'flag':
            _, name, pred, delta, kind = entry
            if pred(w):
                score -= delta
                kinds.append(kind)
                if delta:
                    fired.append(name)
        else:
            _, name, cases = entry
            for pred, delta, kind in cases:
                if pred(w):
                    score -= delta
                    if kind is not None:
                        kinds.append(kind)
                    if delta:
                        fired.append(name)
                    break
    return {'raw': score, 'score': max(0, min(100, score)),
            'reasonKinds': kinds, 'fired': fired}


def screen(inputs):
    w = normalise(inputs)
    rows = []
    for i, (mid, label, has_engine) in enumerate(METHODS):
        s = score_from_ledger(mid, w)
        rows.append({'id': mid, 'label': label, 'hasEngine': has_engine,
                     'catalogIndex': i, 'raw': s['raw'], 'score': s['score'],
                     'reasonKinds': s['reasonKinds'], 'fired': s['fired']})
    # Best first; ties keep catalog order (a stable sort on the score).
    rows.sort(key=lambda r: -r['score'])
    top = rows[0]['score'] if rows else 0
    for r in rows:
        r['recommended'] = r['score'] >= top - 15 and r['score'] > 50
    return rows


# ---------------------------------------------------------------------
# Archetypes: seven wells whose answer an engineer would argue in one
# sentence. The sentence is in the golden, so the gate is not "the code
# still returns what the code returned".
# ---------------------------------------------------------------------

ARCHETYPES = [
    {
        'id': 'deepWateredOutOffshore',
        'why': 'Deep, high liquid rate, watered out, offshore with power on the platform. '
               'This is the well ESPs and gas lift exist for, and no beam unit belongs on a deck.',
        'expectTop': ('esp', 'gasLift'),
        'inputs': {'targetRate': 4500, 'depthFt': 9500, 'gor': 350, 'wctPct': 78,
                   'api': 33, 'bhtF': 210, 'isOffshore': True, 'isDeviated': True},
    },
    {
        'id': 'shallowStripper',
        'why': 'A shallow onshore stripper making a hundred barrels a day. Rod pumping is '
               'the cheapest thing in the world to run and every field hand knows one.',
        'expectTop': ('rodPump',),
        'inputs': {'targetRate': 110, 'depthFt': 3200, 'gor': 180, 'wctPct': 55,
                   'api': 34, 'bhtF': 130},
    },
    {
        'id': 'gassyLowLiquid',
        'why': 'A gas well loading up: barely any liquid and thousands of scf per barrel to '
               'drive a plunger with. There is no cheaper lift and no external power needed.',
        'expectTop': ('plunger',),
        'inputs': {'targetRate': 25, 'depthFt': 7800, 'gor': 12000, 'wctPct': 40,
                   'api': 48, 'bhtF': 190},
    },
    {
        'id': 'heavyOilSandy',
        'why': 'Shallow, heavy, sandy, viscous crude. A progressing cavity pump is the best '
               'thing in the world at exactly this and a centrifugal is the worst.',
        'expectTop': ('pcp', 'rodPump'),
        'inputs': {'targetRate': 260, 'depthFt': 2400, 'gor': 90, 'wctPct': 45,
                   'api': 14, 'bhtF': 105, 'hasSand': True},
    },
    {
        'id': 'noPower',
        'why': 'No electricity at the wellsite. That single fact removes the ESP from the '
               'conversation and makes the answer gas lift.',
        'expectTop': ('gasLift',),
        'inputs': {'targetRate': 900, 'depthFt': 8000, 'gor': 600, 'wctPct': 60,
                   'api': 32, 'bhtF': 220, 'powerAvailable': False},
    },
    {
        'id': 'noGas',
        'why': 'No injection gas and no compression. Gas lift is not an option however well '
               'the rest of the well suits it, and the ESP takes over.',
        'expectTop': ('esp',),
        'inputs': {'targetRate': 1600, 'depthFt': 8000, 'gor': 300, 'wctPct': 65,
                   'api': 31, 'bhtF': 200, 'gasAvailable': False},
    },
    {
        'id': 'hotDeepSandyHorizontal',
        'why': 'Hot, deep, sandy and horizontal: everything downhole gets cooked, cut or '
               'worn. Gas lift has nothing downhole to lose.',
        'expectTop': ('gasLift',),
        'inputs': {'targetRate': 1200, 'depthFt': 13500, 'gor': 900, 'wctPct': 50,
                   'api': 36, 'bhtF': 330, 'hasSand': True, 'isHorizontal': True},
    },
]

# The base well the monotonicity sweep perturbs.
BASE_WELL = {'targetRate': 800, 'depthFt': 8000, 'gor': 600, 'wctPct': 50,
             'api': 32, 'bhtF': 200}

ADVERSE_TOGGLES = ['hasSand', 'isHorizontal', 'isDeviated', 'isOffshore',
                   'reservoirPressureLow']
SUPPLY_TOGGLES = ['powerAvailable', 'gasAvailable']


def monotonicity():
    """For every boolean condition and every method, the SIGN the score
    moves in. Nothing here is copied from the rules; it is measured by
    running the scorer twice."""
    out = []
    base = {r['id']: r['score'] for r in screen(BASE_WELL)}
    for key in ADVERSE_TOGGLES:
        on = {r['id']: r['score'] for r in screen(dict(BASE_WELL, **{key: True}))}
        out.append({'condition': key, 'turnedOn': True,
                    'deltas': {m: on[m] - base[m] for m in base}})
    for key in SUPPLY_TOGGLES:
        off = {r['id']: r['score'] for r in screen(dict(BASE_WELL, **{key: False}))}
        out.append({'condition': key, 'turnedOn': False,
                    'deltas': {m: off[m] - base[m] for m in base}})
    return {'base': BASE_WELL, 'baseScores': base, 'cases': out}


def sweep():
    """A coarse sweep of the continuous inputs, emitted so the clamp and
    the recommendation band are gated over a range rather than at a
    point."""
    rows = []
    for rate in (30, 300, 800, 2500):
        for depth in (1500, 5000, 13000):
            for gor in (0, 600, 3000, 9000):
                for api in (14, 25, 38):
                    res = screen({'targetRate': rate, 'depthFt': depth, 'gor': gor,
                                  'api': api, 'bhtF': 200, 'wctPct': 50})
                    rows.append({
                        'inputs': {'targetRate': rate, 'depthFt': depth, 'gor': gor,
                                   'api': api, 'bhtF': 200, 'wctPct': 50},
                        'scores': {r['id']: r['score'] for r in res},
                        'order': [r['id'] for r in res],
                        'recommended': [r['id'] for r in res if r['recommended']],
                    })
    return rows


def seams():
    """The two seams, with the score movement each causes."""
    known = {'targetRate': 700, 'depthFt': 6500, 'gor': 400, 'wctPct': 60,
             'api': 35, 'bhtF': 210}
    missing = dict(known)
    del missing['api']
    a = {r['id']: r['score'] for r in screen(known)}
    b = {r['id']: r['score'] for r in screen(missing)}

    # Seam 2: the same number read as OIL (what the design pass does)
    # and as LIQUID (what this module's contract said). At 70 per cent
    # water cut the liquid rate is 3.33x the oil rate.
    oil_rate, wct = 300.0, 70.0
    liquid_rate = oil_rate / (1.0 - wct / 100.0)
    as_oil = screen({'targetRate': oil_rate, 'depthFt': 7000, 'gor': 600,
                     'wctPct': wct, 'api': 30, 'bhtF': 210})
    as_liquid = screen({'targetRate': liquid_rate, 'depthFt': 7000, 'gor': 600,
                        'wctPct': wct, 'api': 30, 'bhtF': 210})
    return {
        'missingApiIsHeavy': {
            'known': known, 'knownScores': a, 'missingScores': b,
            'deltas': {m: b[m] - a[m] for m in a},
            'note': ('An absent API is coerced to zero, and zero reads as heavier than any '
                     'real crude. The ESP loses its viscosity points and the PCP gains its '
                     'best reason, on no information at all.'),
        },
        'targetRateOilVersusLiquid': {
            'oilRate': oil_rate, 'wctPct': wct, 'liquidRate': liquid_rate,
            'asOilScores': {r['id']: r['score'] for r in as_oil},
            'asLiquidScores': {r['id']: r['score'] for r in as_liquid},
            'asOilOrder': [r['id'] for r in as_oil],
            'asLiquidOrder': [r['id'] for r in as_liquid],
            'asOilRecommended': [r['id'] for r in as_oil if r['recommended']],
            'asLiquidRecommended': [r['id'] for r in as_liquid if r['recommended']],
            'note': ('The same well, the same duty, one number read two ways. The shipped '
                     'studio passes the OIL rate; this module documented LIQUID.'),
        },
    }


def emit():
    out = {
        'description': (
            'Artificial lift screening goldens: the six-method rules matrix, its scores, '
            'reason kinds, recommendation band and ordering. Independent stdlib oracle '
            '(tools/validation/production/oracle_liftscreening.py). A rules matrix has no '
            'second method to reach its numbers by, and the oracle says so: it re-expresses '
            'every rule as a DECLARATIVE PENALTY LEDGER walked by one generic scorer with '
            'no branch on a method anywhere, and it gates STRUCTURAL PROPERTIES that a '
            'transcription cannot fake -- that no adverse condition ever raises a score, '
            'that the clamp holds over a swept input space, that the recommendation band is '
            'exactly {score >= top - 15 and score > 50} recomputed from the scores, that '
            'ties keep catalog order, and that seven archetype wells rank the way an '
            'engineer would argue in one sentence. Also carries the two seams found on '
            'extraction: a missing API read as ultra-heavy crude, and the same targetRate '
            'documented as liquid here and used as oil by the design pass. '
            'Field units: bbl/d, ft, scf/stb, per cent water cut, degrees API, degF.'),
        'methods': [{'id': m, 'label': lab, 'hasEngine': he} for m, lab, he in METHODS],
        'archetypes': [dict(a, result=screen(a['inputs'])) for a in ARCHETYPES],
        'monotonicity': monotonicity(),
        'sweep': sweep(),
        'seams': seams(),
        'emptyInput': screen({}),
    }
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.abspath(os.path.join(
        here, '..', '..', '..', 'test-data', 'production', 'goldens',
        'lift_screening_cases.json'))
    with open(dest, 'w') as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', dest)


if __name__ == '__main__':
    emit()
