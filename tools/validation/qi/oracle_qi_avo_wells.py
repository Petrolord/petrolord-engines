"""Independent oracle for engines/qi/avoWells.js (QI course gate E2, 2026-10-11).

AVO at the wells: one scale s ties the AVO volumes' intercept and gradient
to the modelled ones over every well, then each well is compared after
scaling. The engine accumulates the normal-equation sums. This oracle never
writes that ratio: it treats the pooled misfit

    E(s) = sum over wells and over {A, B} of (observed - s * modelled)^2

as the quadratic it is, evaluates it EXACTLY (fractions.Fraction from the
binary floats) at s = 0, 1 and 2, and takes the vertex of the parabola
through those three points. The residual is the Euclidean length of the
scaled-minus-modelled (A, B) vector, and the AVO class is the Rutherford and
Williams (1989) scheme with Castagna's class IV, in the shared convention
(owner decision 2026-10-12): class I at A > 0.02, class II for |A| <= 0.02,
class III below with B <= 0, class IV below with B > 0. A well enters the
scale only with no error and finite A and B both modelled and observed
(owner decision 2026-10-12); every other well is listed as excluded with
its reason.

Standard library only; main() asserts the anchors and writes
test-data/qi/goldens.avoWells.json (byte-identical on regeneration).
"""
import json
import math
import os
from fractions import Fraction

BAND = 0.02


def lcg(seed):
    s = seed
    while True:
        s = (s * 6364136223846793005 + 1442695040888963407) % (1 << 64)
        yield (s >> 11) / float(1 << 53) - 0.5


def finite(v):
    return isinstance(v, (int, float)) and math.isfinite(v)


def reason(r):
    o, m = r.get('observed'), r.get('modelled')
    if r.get('error'):
        return r['error']
    if not o:
        return 'no observed value'
    if not (m and finite(m.get('A')) and finite(m.get('B'))):
        return 'no modelled intercept and gradient'
    if not (finite(o.get('A')) and finite(o.get('B'))):
        return 'the seismic intercept or gradient is null at this well'
    return None


def qualifies(r):
    return reason(r) is None


def pooled_cost(rows, s):
    s = Fraction(s)
    e = Fraction(0)
    for r in rows:
        if not qualifies(r):
            continue
        for k in ('A', 'B'):
            d = Fraction(r['observed'][k]) - s * Fraction(r['modelled'][k])
            e += d * d
    return e


def scale_by_vertex(rows):
    n = sum(1 for r in rows if qualifies(r))
    if n == 0:
        return None, 0
    e0, e1, e2 = (pooled_cost(rows, s) for s in (0, 1, 2))
    a = (e2 - 2 * e1 + e0) / 2  # E(s) = a s^2 + b s + c
    b = e1 - e0 - a
    if a <= 0:
        return None, n
    s = -b / (2 * a)
    # anchor: the vertex is the minimum, exactly
    assert pooled_cost(rows, s) <= pooled_cost(rows, s + Fraction(1, 10**9))
    assert pooled_cost(rows, s) <= pooled_cost(rows, s - Fraction(1, 10**9))
    return float(s), n


def avo_class(a, b):
    if not (finite(a) and finite(b)):
        return None
    if a > BAND:
        return 'I'
    if a >= -BAND:
        return 'II'
    return 'IV' if b > 0 else 'III'


def compare(rows):
    s, n = scale_by_vertex(rows)
    wells = []
    for r in rows:
        if s is None or not qualifies(r):
            wells.append({'name': r['name'], 'error': reason(r) or 'no observed value'})
            continue
        sa, sb = r['observed']['A'] / s, r['observed']['B'] / s
        da, db = sa - r['modelled']['A'], sb - r['modelled']['B']
        mc, oc = avo_class(r['modelled']['A'], r['modelled']['B']), avo_class(sa, sb)
        wells.append({'name': r['name'], 'scaled': {'A': sa, 'B': sb}, 'residual': math.sqrt(da * da + db * db),
                      'modelledClass': mc, 'observedClass': oc, 'agree': mc == oc})
    excluded = [{'name': r['name'], 'reason': reason(r)} for r in rows if not qualifies(r)]
    return {'scale': s, 'n': n, 'agree': sum(1 for w in wells if w.get('agree')), 'wells': wells, 'excluded': excluded}


def make_cases():
    u = lcg(20261011)
    cases = []
    # 1. six wells on a common scale with scatter, one with an error, one with no observation
    rows = []
    for k in range(6):
        a = 0.12 * next(u)
        b = -2.5 * a + 0.1 * next(u)
        g = 0.0123
        rows.append({'name': 'W%d' % (k + 1), 'modelled': {'A': a, 'B': b},
                     'observed': {'A': g * a + 2e-4 * next(u), 'B': g * b + 4e-4 * next(u)}})
    # a well flagged with an error stays out of the scale, values or not (owner decision 2026-10-12)
    rows[4]['error'] = 'no density log'
    rows[5]['observed'] = None
    cases.append({'name': 'six wells, scatter, an error and a missing observation', 'rows': rows})
    # 2. the polarity reversed: a negative scale, classes compared after it
    flipped = []
    for r in rows:
        f = dict(r)
        f['observed'] = None if not r['observed'] else {'A': -r['observed']['A'], 'B': -r['observed']['B']}
        flipped.append(f)
    cases.append({'name': 'polarity reversed', 'rows': flipped})
    # 3. one well whose seismic class differs (II modelled, III seen) and the class IV / I borders
    cases.append({'name': 'a class that differs', 'rows': [
        {'name': 'E1', 'modelled': {'A': 0.137, 'B': -0.388}, 'observed': {'A': 2 * 0.137, 'B': 2 * -0.388}},
        {'name': 'E2', 'modelled': {'A': 0.01, 'B': -0.2}, 'observed': {'A': -0.09, 'B': -0.41}},
        {'name': 'E3', 'modelled': {'A': -0.08, 'B': 0.05}, 'observed': {'A': -0.161, 'B': 0.099}},
        {'name': 'E4', 'modelled': {'A': -0.05, 'B': -0.12}, 'observed': {'A': -0.1, 'B': -0.24}},
    ]})
    # 5 (appended below). a live A with a null B, a null A with a live B, an error well carrying values: all three stay
    # out of the scale, so it equals the scale over the two clean wells exactly
    # 4. nothing observed: no scale, every well says why
    cases.append({'name': 'nothing observed', 'rows': [
        {'name': 'N1', 'modelled': {'A': 0.1, 'B': -0.2}, 'observed': None},
        {'name': 'N2', 'modelled': {'A': 0.1, 'B': -0.2}, 'observed': None, 'error': 'no gather'}]})
    cases.append({'name': 'null and NaN gradients and an error well stay out of the scale', 'rows': [
        {'name': 'C1', 'modelled': {'A': 0.25, 'B': -0.5}, 'observed': {'A': 0.75, 'B': -1.5}},
        {'name': 'C2', 'modelled': {'A': -0.125, 'B': 0.5}, 'observed': {'A': -0.375, 'B': 1.5}},
        {'name': 'C3', 'modelled': {'A': 0.1, 'B': -0.2}, 'observed': {'A': 0.2, 'B': None}},
        {'name': 'C4', 'modelled': {'A': 0.1, 'B': -0.2}, 'observed': {'A': None, 'B': -0.4}},
        {'name': 'C5', 'modelled': {'A': 0.1, 'B': 0.1}, 'observed': {'A': 1.0, 'B': 1.0}, 'error': 'trace outside the survey'},
        {'name': 'C6', 'modelled': {'A': 0.1, 'B': None}, 'observed': {'A': 0.3, 'B': -0.6}}]})
    return cases


def well_points_cases():
    rows = [{'name': 'A', 'ok': True, 'il': 1, 'xl': 2, 'topTwt': 1500.5},
            {'name': 'B', 'ok': True, 'il': 3, 'xl': 4, 'topTwt': None},
            {'name': 'C', 'ok': False, 'il': 5, 'xl': 6, 'topTwt': 1400},
            {'name': 'D', 'ok': True, 'il': 7, 'xl': 8, 'topTwt': 0}]
    pts = [{'name': r['name'], 'il': r['il'], 'xl': r['xl'], 't_ms': r['topTwt']} for r in rows
           if r['ok'] and finite(r['topTwt'])]
    return {'rows': rows, 'points': pts}


def main():
    cases = make_cases()
    assert cases, 'refusing to write an empty sweep'
    out = []
    for c in cases:
        assert c['rows'], 'empty case'
        out.append({'name': c['name'], 'rows': c['rows'], 'expect': compare(c['rows'])})
    # anchors: an exactly proportional pair of wells gives that factor exactly; the reversal flips the sign
    exact = compare([{'name': 'x', 'modelled': {'A': 0.25, 'B': -0.5}, 'observed': {'A': 0.75, 'B': -1.5}},
                     {'name': 'y', 'modelled': {'A': -0.125, 'B': 0.5}, 'observed': {'A': -0.375, 'B': 1.5}}])
    assert exact['scale'] == 3.0 and all(w['residual'] == 0 for w in exact['wells'])
    assert out[1]['expect']['scale'] < 0 and abs(out[1]['expect']['scale'] + out[0]['expect']['scale']) < 1e-15
    assert out[2]['expect']['agree'] == 3 and out[3]['expect']['scale'] is None
    # the decided pooling: only the two clean wells, proportional by 3, enter; four are excluded with reasons
    assert out[4]['expect']['scale'] == 3.0 and out[4]['expect']['n'] == 2
    assert [e['name'] for e in out[4]['expect']['excluded']] == ['C3', 'C4', 'C5', 'C6']
    assert out[0]['expect']['n'] == 4 and [e['name'] for e in out[0]['expect']['excluded']] == ['W5', 'W6']
    g = {'cases': out, 'wellPoints': well_points_cases()}
    assert g['wellPoints']['points'] and len(g['wellPoints']['points']) == 2
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', '..', '..', 'test-data', 'qi', 'goldens.avoWells.json')
    with open(dest, 'w') as fh:
        json.dump(g, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors ok;', len(out), 'cases; scales', [c['expect']['scale'] for c in out], '; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
