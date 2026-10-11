"""Independent oracle for engines/qi/lfm.js (QI course gate E1c, G5).

Standard library only, no shared code, written from the definitions in the
module header and in Simm and Bacon (2014, Seismic Amplitude, ch. 9: the
horizon-guided low-frequency model), never from the JS loops:

  mapToWellTime   a piecewise-linear map built as a knot table: the trace's
                  horizon times against the well's, extended above the first
                  and below the last knot with slope one (the time offset from
                  the nearest horizon is kept). Evaluated by bisect on the
                  knots (the JS walks the intervals in a loop).
  sampleAt        linear interpolation in EXACT RATIONALS (fractions.Fraction)
                  on the regular log; outside [t0, t0 + (n-1) dt] or next to a
                  null it is missing.
  lfmTrace        explicit inverse-distance weights w = 1 / d^p normalised per
                  sample over the wells that have a value there (a well at the
                  trace takes all the weight), summed with math.fsum; then the
                  samples no well covers are filled: before the first covered
                  sample with the first covered value, after it with the last
                  covered value before them (forward fill).
  blindWellScore  Pearson correlation of AI = exp(ln AI) by the two-pass
                  centred form with math.fsum, and the RMS of the relative AI
                  error in percent, over the samples where both are defined.

Self-asserted anchors (generation fails loudly if any breaks):
  L1 a layered earth whose layer top and base dip linearly between wells:
     with the horizons the model at a trace between the wells reproduces the
     true layered ln(AI) exactly away from the boundary samples; at constant
     time (no horizons) it does not (the negative control of the method).
  L2 IDW of constant wells equals the closed form sum(v/d^p) / sum(1/d^p).
  L3 an estimate of exactly 1.05 times the true AI scores rmsPct = 5 and
     corr = 1.
  L4 the knot map is the identity when the trace and the well horizons agree.

Every case list must be non-empty or the oracle refuses (exit 1).
Regeneration is byte-identical.

Usage: python3 -I tools/validation/qi/oracle_qi_lfm.py [dest.json]
"""
import bisect
import json
import math
import os
import sys
from fractions import Fraction


def fin(v):
    return v is not None and isinstance(v, (int, float)) and math.isfinite(v)


# --- the knot map ------------------------------------------------------------

def well_time(t, trace_h, well_h):
    if len(trace_h) != len(well_h):
        raise ValueError('horizon count')
    if not trace_h:
        return t
    # slope-one extensions as two extra knots far outside
    big = 1e9
    xs = [trace_h[0] - big] + list(trace_h) + [trace_h[-1] + big]
    ys = [well_h[0] - big] + list(well_h) + [well_h[-1] + big]
    if t <= trace_h[0]:
        return well_h[0] + (t - trace_h[0])
    if t >= trace_h[-1]:
        return well_h[-1] + (t - trace_h[-1])
    j = bisect.bisect_left(xs, t)  # xs[j-1] < t <= xs[j]
    x0, x1, y0, y1 = xs[j - 1], xs[j], ys[j - 1], ys[j]
    if x1 - x0 <= 0:
        return y0
    return y0 + (t - x0) / (x1 - x0) * (y1 - y0)


def sample_log(values, t0, dt, t):
    x = (Fraction(t) - Fraction(t0)) / Fraction(dt)
    n = len(values)
    if x < 0 or x > n - 1:
        return None
    i = math.floor(x)
    f = x - i
    a = values[i]
    if f == 0:
        return a if fin(a) else None
    b = values[i + 1]
    if not (fin(a) and fin(b)):
        return None
    return float(Fraction(a) + f * (Fraction(b) - Fraction(a)))


def lfm(wells, at, grid, power=2, exclude=None):
    used = [w for w in wells if w['name'] != exclude]
    if not used:
        raise ValueError('no wells')
    dist = [math.sqrt((w['x'] - at['x']) ** 2 + (w['y'] - at['y']) ** 2) for w in used]
    at_well = [k for k, d in enumerate(dist) if d < 1e-6]
    out = []
    for k in range(grid['ns']):
        t = grid['t0Ms'] + k * grid['dtMs']
        num, den = [], []
        for j, w in enumerate(used):
            if at_well and j != at_well[0]:
                continue
            tw = well_time(t, at.get('horizons') or [], w.get('horizons') or [])
            v = sample_log(w['values'], w['t0Ms'], w['dtMs'], tw)
            if v is None:
                continue
            wt = 1.0 if at_well else 1.0 / dist[j] ** power
            num.append(wt * v)
            den.append(wt)
        out.append(math.fsum(num) / math.fsum(den) if den else None)
    covered = [k for k, v in enumerate(out) if v is not None]
    if not covered:
        raise ValueError('no cover')
    first = covered[0]
    for k in range(first):
        out[k] = out[first]
    for k in range(first + 1, len(out)):
        if out[k] is None:
            out[k] = out[k - 1]
    return out


def score(est, truth):
    a, b = [], []
    for e, t in zip(est, truth):
        if fin(e) and fin(t):
            a.append(math.exp(e))
            b.append(math.exp(t))
    n = len(a)
    if n < 3:
        return {'corr': None, 'rmsPct': None, 'n': n}
    ma, mb = math.fsum(a) / n, math.fsum(b) / n
    sab = math.fsum((x - ma) * (y - mb) for x, y in zip(a, b))
    saa = math.fsum((x - ma) ** 2 for x in a)
    sbb = math.fsum((y - mb) ** 2 for y in b)
    rel = math.fsum(((x - y) / y) ** 2 for x, y in zip(a, b))
    return {'corr': sab / math.sqrt(saa * sbb) if saa > 0 and sbb > 0 else None,
            'rmsPct': 100 * math.sqrt(rel / n), 'n': n}


# --- the cases ---------------------------------------------------------------

def layered(ns, dt, top, base, vals=(8.5, 8.9, 8.7)):
    out = []
    for k in range(ns):
        t = k * dt
        out.append(vals[0] if t < top else vals[1] if t < base else vals[2])
    return out


def smooth_log(ns, dt, top, base, seed):
    """ln(AI) that varies with proportional position between the horizons."""
    out = []
    for k in range(ns):
        t = k * dt
        if t < top:
            v = 8.4 + 0.0004 * (t - top)
        elif t < base:
            p = (t - top) / (base - top)
            v = 8.8 + 0.12 * math.sin(math.pi * p + 0.3 * seed) + 0.05 * p
        else:
            v = 8.75 + 0.0002 * (t - base)
        out.append(round(v, 9))
    return out


def main():
    dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'test-data', 'qi', 'goldens.lfm.json')

    # L4 identity and the map cases
    for t in (100.0, 433.3, 612.0, 999.0):
        assert well_time(t, [400, 600, 800], [400, 600, 800]) == t
    map_cases = []
    for (H, h) in (([500, 600], [400, 600]), ([300, 520, 760], [340, 500, 820]), ([], []), ([450], [470]),
                   ([200, 200.0, 500], [250, 260, 600])):
        for t in (0, 150, 200, 333.5, 450, 499, 520, 550, 600, 700, 760, 800, 1000):
            map_cases.append({'t': t, 'trace': H, 'well': h, 'out': well_time(t, H, h)})

    sample_cases = []
    vals = [0.0, 10.0, 20.0, None, 40.0, 50.0]
    for t in (0, 0.01, 2, 4, 6, 9, 10, 12, 14, 16, 18, 20, 21, -1, 3.3):
        sample_cases.append({'values': vals, 't0': 0, 'dt': 4, 't': t, 'out': sample_log(vals, 0, 4, t)})
    for t in (100, 100.02, 101, 103.999, 107.5, 108, 111):
        sample_cases.append({'values': [8.1, 8.3, 8.2], 't0': 100, 'dt': 4, 't': t,
                             'out': sample_log([8.1, 8.3, 8.2], 100, 4, t)})

    # L1 the layered earth: anchor and negative control
    ns, dt = 251, 4
    A = {'name': 'A', 'x': 0, 'y': 0, 't0Ms': 0, 'dtMs': dt, 'values': layered(ns, dt, 400, 600), 'horizons': [400, 600]}
    B = {'name': 'B', 'x': 1000, 'y': 0, 't0Ms': 0, 'dtMs': dt, 'values': layered(ns, dt, 600, 800), 'horizons': [600, 800]}
    g = {'t0Ms': 0, 'dtMs': dt, 'ns': ns}
    m = lfm([A, B], {'x': 500, 'y': 0, 'horizons': [500, 700]}, g)
    truth = layered(ns, dt, 500, 700)
    for t in (200, 480, 520, 600, 680, 720, 900):
        assert abs(m[t // 4] - truth[t // 4]) < 1e-12, t
    flat = lfm([{**A, 'horizons': None}, {**B, 'horizons': None}], {'x': 500, 'y': 0}, g)
    assert abs(flat[520 // 4] - truth[520 // 4]) + abs(flat[680 // 4] - truth[680 // 4]) > 0.2

    # L2 IDW of constant wells
    cw = [{'name': n, 'x': x, 'y': y, 't0Ms': 0, 'dtMs': 4, 'values': [v] * 40}
          for n, x, y, v in (('A', 0, 0, 8.0), ('B', 300, 0, 9.0), ('C', 100, 250, 10.0))]
    for p in (1, 2, 3):
        got = lfm(cw, {'x': 120, 'y': 40}, {'t0Ms': 0, 'dtMs': 4, 'ns': 40}, power=p)[0]
        ds = [math.hypot(w['x'] - 120, w['y'] - 40) for w in cw]
        want = sum(w['values'][0] / d ** p for w, d in zip(cw, ds)) / sum(1 / d ** p for d in ds)
        assert abs(got - want) < 1e-12

    # the golden traces: four wells with smooth logs, dipping horizons, gaps
    ns, dt = 160, 4
    wells = []
    for k, (name, x, y, top, base, t0) in enumerate((
            ('W1', 0.0, 0.0, 240, 400, 0), ('W2', 1200.0, 150.0, 280, 460, 8),
            ('W3', 300.0, 1100.0, 220, 380, 0), ('W4', 1500.0, 1300.0, 300, 500, 20))):
        nw = 150
        v = smooth_log(nw, dt, top - t0, base - t0, k)
        if name == 'W2':
            for i in range(60, 66):
                v[i] = None  # a gap in the log
        if name == 'W3':
            v = v[:120] + [None] * (nw - 120)  # the log stops early
        wells.append({'name': name, 'x': x, 'y': y, 't0Ms': t0, 'dtMs': dt, 'values': v, 'horizons': [top, base]})
    traces = []
    for (x, y, H, power, exclude) in (
            (600.0, 500.0, [255, 420], 2, None),
            (0.0, 0.0, [240, 400], 2, None),       # at W1: W1 alone
            (0.0, 0.0, [240, 400], 2, 'W1'),       # W1 left out (blind)
            (1400.0, 900.0, [290, 480], 1, None),
            (900.0, 1250.0, [262, 455], 3, 'W4'),
            (700.0, 300.0, None, 2, None)):       # constant time
        at = {'x': x, 'y': y}
        ws = wells if H else [{**w, 'horizons': None} for w in wells]
        if H:
            at['horizons'] = H
        out = lfm(ws, at, {'t0Ms': 0, 'dtMs': dt, 'ns': ns}, power=power, exclude=exclude)
        traces.append({'at': at, 'power': power, 'exclude': exclude, 'horizons': bool(H), 'lfm': out})
    # at the well the model is the well (inside its cover)
    t1 = traces[1]['lfm']
    for i, v in enumerate(wells[0]['values']):
        if v is not None and i < ns:
            assert t1[i] == v

    # L3 and the scores
    tr = [8.5 + 0.01 * math.sin(i / 3) for i in range(50)]
    s = score([v + math.log(1.05) for v in tr], tr)
    assert abs(s['rmsPct'] - 5) < 1e-9 and abs(s['corr'] - 1) < 1e-12
    score_cases = []
    est = traces[2]['lfm']
    truth_w1 = [wells[0]['values'][i] if i < 150 else None for i in range(ns)]
    score_cases.append({'est': est, 'truth': truth_w1, 'out': score(est, truth_w1)})
    e2 = [round(v + 0.03 * math.cos(i / 5) - 0.01, 9) if v is not None else None for i, v in enumerate(truth_w1)]
    e2[10] = None
    score_cases.append({'est': e2, 'truth': truth_w1, 'out': score(e2, truth_w1)})
    score_cases.append({'est': [8.0, None, 8.1], 'truth': [8.0, 8.2, None], 'out': score([8.0, None, 8.1], [8.0, 8.2, None])})
    two = ([8.0, 8.3, None, 8.1], [8.1, 8.2, 8.4, None])  # two samples in common: no score
    score_cases.append({'est': two[0], 'truth': two[1], 'out': score(*two)})
    three = ([8.0, 8.3, 8.25, 8.1], [8.1, 8.2, 8.4, None])  # three: the smallest scored set
    score_cases.append({'est': three[0], 'truth': three[1], 'out': score(*three)})

    for name, lst in (('map', map_cases), ('sample', sample_cases), ('traces', traces), ('scores', score_cases)):
        if not lst:
            print('REFUSED: empty case list', name)
            sys.exit(1)
    golden = {'map': map_cases, 'sample': sample_cases, 'grid': {'t0Ms': 0, 'dtMs': dt, 'ns': ns},
              'wells': wells, 'traces': traces, 'scores': score_cases}
    with open(dest, 'w') as fh:
        json.dump(golden, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors L1-L4 ok;', len(map_cases), 'map,', len(sample_cases), 'sample,', len(traces), 'traces,',
          len(score_cases), 'scores; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
