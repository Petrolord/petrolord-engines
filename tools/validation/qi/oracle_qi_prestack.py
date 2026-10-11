"""Independent oracle for engines/qi/prestack.js and engines/qi/prestackQc.js
(NextGen QI course extraction gate, wave E1a: gaps G1 and G2).

Standard library only, no code shared with the JS or with any other oracle.
Every function below reaches its number by a different route from the JS:

prestack.js
- dixInterval: the RMS function is the triangular linear system
  Vrms_i^2 t_i = sum_{j<=i} v_j^2 (t_j - t_{j-1}) (Dix 1955, Geophysics 20,
  68), solved by forward substitution in EXACT RATIONALS (fractions); the
  square root is taken once, at the end.
- layeredRms: exact rationals over the layers (time-weighted mean of v^2).
- rayTraceAngle: NEWTON on the ray parameter p with the analytic derivative
  dx/dp (the JS bisects), in a substitution q = p * vmax that keeps the
  iterate inside (0, 1). Anchors: one layer is the geometry, tan(theta) =
  x / 2z; Fermat, dT/dx = p, by a central difference of the traced
  traveltime; the small-offset limit sin(theta) -> p v with p = x / (t0
  Vrms^2), which is Walden's slope to first order.
- waldenAngle: Walden (1991, Geophysical Prospecting 39, 915-942), the
  straight ray through a medium of velocity Vrms: tan(theta_rms) = x / (Vrms
  t0), then Snell's law into the layer at Vint, sin(theta) = sin(theta_rms)
  Vint / Vrms. The oracle goes through atan and sin (the JS through the
  hypotenuse), and caps at 90 degrees as the JS documents.
- binOffsets: exact rational floor of x / w (fractions), fold by counting.
- angleGather, partialStack, usableAngle: the angle of each sample from the
  oracle's own Walden route, bins found by bisect over the edges, and the
  partial stack taken DIRECTLY from the raw samples whose angle falls in
  [edges[from], edges[to]) (the JS goes through the bin means and folds).
  The oracle asserts that no live sample sits within 1e-7 degrees of an
  edge, so a float ulp cannot move a sample between bins.
- velocityOnGrid: its own interpolation by bisect, Dix per segment from the
  rational solver.

prestackQc.js
- nmoStretch: the rationalised closed form u / (1 + sqrt(1 + u)) with
  u = (x / (v t0))^2 (Yilmaz 2001, section 3.2: t / t0 - 1), numerically a
  different expression from sqrt(t0^2 + x^2 / v^2) / t0 - 1.
- stretchMuteOffset: BISECTION on the oracle's stretch for the offset where
  it reaches the limit (the JS inverts in closed form).
- residualMoveout: designed truth. The oracle builds NMO-corrected gathers
  with a known parabolic residual dt = a x^2 (Ricker events shifted
  analytically, so no interpolation enters the input), with and without an
  amplitude-versus-offset polarity reversal, and records the designed
  far-offset residual. Its own estimate comes from a continuous
  golden-section search of a stack-power objective on the gather flattened
  with cubic (Catmull-Rom) interpolation: conventional semblance (Neidell
  and Taner 1971) where the waveform keeps its polarity, and the explained
  energy of a straight-line fit across offset (Sarkar, Castagna and Lamb
  2002) where it reverses. The gate compares the engine with the designed
  truth; the oracle estimate shows the truth is recoverable from the data.
- foldSummary: plain counting.

main() asserts every anchor, refuses an empty case list, and writes
test-data/qi/goldens.prestack.json and goldens.prestackQc.json
(json indent 1, sorted keys, trailing newline; regeneration is
byte-identical). Usage: python3 oracle_qi_prestack.py [outdir]
"""
import bisect
import json
import math
import os
import sys
from fractions import Fraction as F

DEG = 180.0 / math.pi


def nan_none(v):
    return None if isinstance(v, float) and math.isnan(v) else v


def nonempty(name, xs):
    if not xs:
        raise SystemExit(f'REFUSED: the {name} sweep is empty')
    return xs


# ---------------------------------------------------------------- velocities

def dix_rational(vrms, t0):
    """Interval velocities by forward substitution on Vrms^2 t = sum v^2 dt."""
    vr = [F(v) for v in vrms]
    ts = [F(t) for t in t0]
    sq = []  # v_j^2
    cum = F(0)
    prev_t = F(0)
    for i, (v, t) in enumerate(zip(vr, ts)):
        dt = t - prev_t if i else t
        rhs = v * v * t
        if i == 0:
            sq.append(v * v)  # the first sample is its own interval velocity
            cum = rhs
        else:
            vi2 = (rhs - cum) / dt
            assert vi2 > 0, 'no real interval velocity'
            sq.append(vi2)
            cum = rhs
        prev_t = t
    return [math.sqrt(float(s)) for s in sq], sq


def layered_rms_rational(layers):
    t = F(0)
    s = F(0)
    out = []
    for l in layers:
        dt = F(2) * F(l['thicknessM']) / F(l['v'])
        t += dt
        s += F(l['v']) ** 2 * dt
        out.append({'t0': float(t), 'vrms': math.sqrt(float(s / t)), '_t': t, '_s': s})
    return out


def velocity_on_grid(tms, vrms, ns, dtms, t0ms=0.0):
    seg = dix_rational(vrms, [max(t, 1e-6) / 1000 for t in tms])[0] if len(tms) > 1 else [vrms[0]]
    out_r, out_i = [], []
    for k in range(ns):
        t = t0ms + k * dtms
        if t <= tms[0]:
            out_r.append(vrms[0]); out_i.append(seg[0]); continue
        if t >= tms[-1]:
            out_r.append(vrms[-1]); out_i.append(seg[-1]); continue
        j = bisect.bisect_left(tms, t) - 1  # tms[j] < t <= tms[j+1]
        f = (t - tms[j]) / (tms[j + 1] - tms[j])
        out_r.append(vrms[j] + f * (vrms[j + 1] - vrms[j]))
        out_i.append(seg[j + 1])
    return out_r, out_i


# ---------------------------------------------------------------- angles

def ray_trace(layers, target, x):
    """Newton on q = p vmax in (0, 1); returns (theta_deg, p, traveltime)."""
    if x == 0:
        return 0.0, 0.0, sum(2 * l['thicknessM'] / l['v'] for l in layers[:target + 1])
    above = layers[:target + 1]
    vmax = max(l['v'] for l in above)

    def xp(q):
        p = q / vmax
        s, d = 0.0, 0.0
        for l in above:
            pv = p * l['v']
            c = math.sqrt(1 - pv * pv)
            s += l['thicknessM'] * pv / c
            d += l['thicknessM'] * l['v'] / (c ** 3) / vmax  # dx/dq per half
        return 2 * s, 2 * d

    q = 0.5
    for _ in range(100):
        xv, d = xp(q)
        step = (xv - x) / d
        qn = q - step
        if qn <= 0:
            qn = q / 2
        elif qn >= 1:
            qn = (q + 1) / 2
        if abs(qn - q) < 1e-16:
            q = qn
            break
        q = qn
    p = q / vmax
    assert abs(xp(q)[0] - x) < 1e-7 * max(1.0, x)
    tt = sum(2 * l['thicknessM'] / (l['v'] * math.sqrt(1 - (p * l['v']) ** 2)) for l in above)
    return math.degrees(math.asin(p * layers[target]['v'])), p, tt


def walden(x, t0, vrms, vint):
    if not (t0 > 0 and vrms > 0 and vint > 0):
        return float('nan')
    th_rms = math.atan2(x, vrms * t0)
    s = math.sin(th_rms) * vint / vrms
    return 90.0 if s >= 1 else math.degrees(math.asin(s))


# ---------------------------------------------------------------- gathers

def bin_offsets(offsets, w):
    idx = []
    for o in offsets:
        if o is None or not math.isfinite(o) or o < 0:
            idx.append(-1)
        else:
            idx.append(int(F(o) // F(w)))
    n = max([0] + idx) + 1
    fold = [idx.count(k) for k in range(n)]
    return idx, [(k + 0.5) * w for k in range(n)], fold


def live(v):
    return v is not None and math.isfinite(v) and abs(v) < 1e29


def angle_bins(case):
    """Per sample: the list of (bin, value) from the oracle's own angles."""
    edges = case['edges']
    ns = len(case['vrms'])
    per = [[] for _ in range(ns)]
    margin = float('inf')
    for tr, x in zip(case['traces'], case['offsets']):
        for i in range(ns):
            v = tr[i]
            if not live(v):
                continue
            a = walden(x, (case['t0Ms'] + i * case['dtMs']) / 1000, case['vrms'][i], case['vint'][i])
            if not math.isfinite(a):
                continue
            margin = min(margin, min(abs(a - e) for e in edges))
            if a < edges[0] or a >= edges[-1]:
                continue
            b = bisect.bisect_right(edges, a) - 1
            per[i].append((b, v, a))
    assert margin > 1e-7, f'a sample sits {margin} deg from a bin edge'
    return per


def angle_gather(case):
    nb = len(case['edges']) - 1
    per = angle_bins(case)
    ns = len(per)
    gather = [[None] * ns for _ in range(nb)]
    fold = [[0] * ns for _ in range(nb)]
    for i, items in enumerate(per):
        for b in range(nb):
            vals = [v for (bb, v, _) in items if bb == b]
            fold[b][i] = len(vals)
            gather[b][i] = math.fsum(vals) / len(vals) if vals else None
    return gather, fold, per


def partial_stack_direct(case, per, frm, to):
    lo, hi = case['edges'][frm], case['edges'][to]
    out = []
    for items in per:
        vals = [v for (_, v, a) in items if lo <= a < hi]
        out.append(math.fsum(vals) / len(vals) if vals else None)
    return out


def usable(fold, edges, min_fold):
    ns = len(fold[0])
    out = []
    for i in range(ns):
        k = 0
        while k < len(fold) and fold[k][i] >= min_fold:
            k += 1
        out.append(edges[k] if k > 0 else None)
    return out


# ---------------------------------------------------------------- QC

def stretch(x, t0, v):
    if not (t0 > 0 and v > 0):
        return float('nan')
    u = (x / (v * t0)) ** 2
    return u / (1 + math.sqrt(1 + u))


def mute_offset(t0, v, smax):
    lo, hi = 0.0, 1.0
    while stretch(hi, t0, v) < smax:
        hi *= 2
    for _ in range(300):
        mid = (lo + hi) / 2
        if stretch(mid, t0, v) < smax:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def ricker(t_ms, fp):
    a = (math.pi * fp * t_ms / 1000) ** 2
    return (1 - 2 * a) * math.exp(-a)


def make_gather(offsets, ns, dtms, centre, curv, fp, amp=lambda u: 1.0, second=None):
    far = offsets[-1]
    out = []
    for x in offsets:
        u = x / far
        sh = curv * x * x
        tr = []
        for i in range(ns):
            v = amp(u) * ricker(i * dtms - (centre + sh), fp)
            if second:
                c2, amp2 = second
                v += amp2(u) * ricker(i * dtms - (c2 + sh), fp)
            tr.append(float(f'{v:.12g}'))
        out.append(tr)
    return out


def cubic(tr, p):
    i = math.floor(p)
    f = p - i
    if i - 1 < 0 or i + 2 >= len(tr):
        return None
    y0, y1, y2, y3 = tr[i - 1], tr[i], tr[i + 1], tr[i + 2]
    return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)))


def objective(traces, offsets, dtms, i0, i1, rmo_far, kind):
    far = offsets[-1]
    num = den = 0.0
    for i in range(i0, i1 + 1):
        ys, us = [], []
        for tr, x in zip(traces, offsets):
            v = cubic(tr, i + rmo_far * (x / far) ** 2 / dtms)
            if v is not None:
                ys.append(v); us.append(x / far)
        n = len(ys)
        if n < 4:
            continue
        if kind == 'semblance':
            num += sum(ys) ** 2
            den += n * sum(y * y for y in ys)
        else:  # straight line in u, explained energy
            mu, my = sum(us) / n, sum(ys) / n
            suu = sum((u - mu) ** 2 for u in us)
            b = sum((u - mu) * (y - my) for u, y in zip(us, ys)) / suu
            num += sum((my + b * (u - mu)) ** 2 for u in us)
            den += sum(y * y for y in ys)
    return num / den


def oracle_rmo(traces, offsets, dtms, centre, kind, window=40, maxlag=24):
    c = round(centre / dtms)
    h = round(window / dtms)
    i0, i1 = c - h, c + h
    grid = [j * 0.1 for j in range(-int(maxlag * 10), int(maxlag * 10) + 1)]
    vals = [objective(traces, offsets, dtms, i0, i1, g, kind) for g in grid]
    k = max(range(len(grid)), key=lambda j: vals[j])
    a, b = grid[max(0, k - 1)], grid[min(len(grid) - 1, k + 1)]
    g = (math.sqrt(5) - 1) / 2
    for _ in range(80):
        c1, c2 = b - g * (b - a), a + g * (b - a)
        if objective(traces, offsets, dtms, i0, i1, c1, kind) > objective(traces, offsets, dtms, i0, i1, c2, kind):
            b = c2
        else:
            a = c1
    return (a + b) / 2


def fold_summary(fold, centres, min_fold):
    total = sum(fold)
    far = None
    for b, f in enumerate(fold):
        if f >= min_fold:
            far = centres[b]
    return {'total': total, 'farOffset': far, 'liveBins': sum(1 for f in fold if f >= min_fold)}


# ---------------------------------------------------------------- main

def main(outdir):
    # --- anchors -------------------------------------------------------
    two = [{'thicknessM': 1000, 'v': 2000}, {'thicknessM': 1500, 'v': 3000}]
    r2 = layered_rms_rational(two)
    assert r2[0]['_t'] == 1 and r2[1]['_t'] == 2
    assert r2[1]['_s'] / r2[1]['_t'] == F(6500000)  # Vrms^2 = (4e6 * 1 + 9e6 * 1) / 2
    v_back, sq = dix_rational([r['vrms'] for r in r2], [r['t0'] for r in r2])
    assert abs(v_back[1] - 3000) < 1e-9 and abs(v_back[0] - 2000) < 1e-12
    th, p, _ = ray_trace([{'thicknessM': 1000, 'v': 2000}], 0, 1000)
    assert abs(th - math.degrees(math.atan(0.5))) < 1e-10
    four = [{'thicknessM': 600, 'v': 1800}, {'thicknessM': 500, 'v': 2200}, {'thicknessM': 700, 'v': 2700}, {'thicknessM': 400, 'v': 3200}]
    r4 = layered_rms_rational(four)
    # Fermat: dT/dx = p
    for x in (300.0, 1200.0, 2000.0):
        _, p, _ = ray_trace(four, 3, x)
        hh = 0.01
        dtdx = (ray_trace(four, 3, x + hh)[2] - ray_trace(four, 3, x - hh)[2]) / (2 * hh)
        assert abs(dtdx - p) < 1e-9 * 1e3 * p, (dtdx, p)
    # small-offset limit: exact and Walden share the slope p v, p = x / (t0 Vrms^2)
    x = 1.0
    ex = math.sin(math.radians(ray_trace(four, 3, x)[0]))
    wa = math.sin(math.radians(walden(x, r4[3]['t0'], r4[3]['vrms'], 3200)))
    lim = x / (r4[3]['t0'] * r4[3]['vrms'] ** 2) * 3200
    assert abs(ex - lim) / lim < 1e-5 and abs(wa - lim) / lim < 1e-6
    # one homogeneous layer: Walden IS the exact ray
    one = [{'thicknessM': 1500, 'v': 2500}]
    ro = layered_rms_rational(one)
    for x in (500.0, 1500.0, 3000.0):
        assert abs(walden(x, ro[0]['t0'], ro[0]['vrms'], 2500) - ray_trace(one, 0, x)[0]) < 1e-9
    # NMO stretch closed form and the mute root
    assert abs(stretch(2000, 1, 2000) - (math.sqrt(2) - 1)) < 1e-15
    assert abs(stretch(mute_offset(1.2, 2500, 0.3), 1.2, 2500) - 0.3) < 1e-12

    # --- prestack goldens ---------------------------------------------
    models = nonempty('layered model', [
        {'name': 'two_layer', 'layers': two},
        {'name': 'four_layer', 'layers': four},
        # a slow target under a fast layer: the angle is in the target layer, not the fastest one
        {'name': 'low_velocity_target', 'layers': [{'thicknessM': 500, 'v': 1800}, {'thicknessM': 400, 'v': 2900}, {'thicknessM': 350, 'v': 2300}]},
        {'name': 'ekene_like', 'layers': [{'thicknessM': 450, 'v': 1650}, {'thicknessM': 380, 'v': 1950}, {'thicknessM': 520, 'v': 2350}, {'thicknessM': 300, 'v': 2867}, {'thicknessM': 400, 'v': 3100}]},
    ])
    dix_cases, ray_cases = [], []
    for m in models:
        r = layered_rms_rational(m['layers'])
        vrms = [q['vrms'] for q in r]
        t0 = [q['t0'] for q in r]
        dix_cases.append({'name': m['name'], 'layers': m['layers'], 'vrms': vrms, 't0': t0,
                          'vint': dix_rational(vrms, t0)[0]})
        for target in range(len(m['layers'])):
            for x in nonempty('offset', [0.0, 250.0, 800.0, 1600.0, 2500.0]):
                ex = ray_trace(m['layers'], target, x)[0]
                wa = walden(x, t0[target], vrms[target], m['layers'][target]['v'])
                ray_cases.append({'model': m['name'], 'target': target, 'offsetM': x, 'exactDeg': ex, 'waldenDeg': wa,
                                  't0': t0[target], 'vrms': vrms[target], 'vint': m['layers'][target]['v']})
    # Walden against the exact ray: within 1.5 degrees up to the target depth on these earths
    for rc in ray_cases:
        depth = sum(l['thicknessM'] for l in next(mm for mm in models if mm['name'] == rc['model'])['layers'][:rc['target'] + 1])
        if rc['offsetM'] <= depth:
            assert abs(rc['waldenDeg'] - rc['exactDeg']) < 1.5, rc
    walden_extra = [{'offsetM': x, 't0': t, 'vrms': vr, 'vint': vi, 'deg': nan_none(walden(x, t, vr, vi))}
                    for (x, t, vr, vi) in [(1000, 1.0, 2000, 2000), (2500, 1.2, 2400, 3000), (6000, 0.5, 2000, 4000), (100, 0.0, 2000, 2000), (1700, 1.517, 2316, 2867)]]
    bins_cases = []
    for offs, w in nonempty('bin', [([0, 24, 25, 99, -1, None, 50], 25), ([100, 300, 500, 700, 900, 1100, 1300, 199.99999, 200, 2500], 200), ([10.5, 10.5, 31.4999, 31.5, 63.0], 10.5)]):
        idx, cen, fold = bin_offsets(offs, w)
        bins_cases.append({'offsets': offs, 'widthM': w, 'index': idx, 'centres': cen, 'fold': fold})
    vg_cases = []
    for tms, vr, ns, dt, t0ms in nonempty('velocity table', [
        ([200, 600, 1000, 1400], [1700, 1900, 2150, 2380], 90, 20, 0),
        ([0, 500, 1500], [1600, 2000, 2600], 50, 40, 100),
        ([800], [2200], 5, 100, 0),
    ]):
        r, i = velocity_on_grid(tms, vr, ns, dt, t0ms)
        vg_cases.append({'tMs': tms, 'vrms': vr, 'ns': ns, 'dtMs': dt, 't0Ms': t0ms, 'outVrms': r, 'outVint': i})

    # an angle-gather case on a velocity function from the table (inputs pinned)
    ns, dtms, t0ms = 60, 8, 900
    vr_g, vi_g = velocity_on_grid([600, 1000, 1400], [1900, 2150, 2380], ns, dtms, t0ms)
    offsets = [100 + 200 * k for k in range(13)]
    traces = []
    for j, x in enumerate(offsets):
        tr = []
        for i in range(ns):
            if (i * 7 + j * 3) % 23 == 0:
                tr.append(None)
            elif (i + 2 * j) % 31 == 0:
                tr.append(1e30)
            else:
                tr.append(round(math.sin(0.37 * i + 0.11 * j) * (1 - 0.02 * j) + 0.05 * math.cos(1.3 * i * j), 9))
        traces.append(tr)
    gcase = {'traces': traces, 'offsets': offsets, 'vrms': vr_g, 'vint': vi_g, 'dtMs': dtms, 't0Ms': t0ms, 'edges': [0, 5, 15, 25, 35, 45]}
    gather, gfold, per = angle_gather(gcase)
    stacks = [{'from': a, 'to': b, 'stack': partial_stack_direct(gcase, per, a, b)} for a, b in nonempty('stack', [(1, 2), (2, 3), (3, 4), (0, 5), (1, 4)])]
    # cross-check the direct stack against fold-weighted bin means
    for s in stacks:
        for i in range(ns):
            n = sum(gfold[k][i] for k in range(s['from'], s['to']))
            if n:
                via = math.fsum(gather[k][i] * gfold[k][i] for k in range(s['from'], s['to']) if gfold[k][i]) / n
                assert abs(via - s['stack'][i]) < 1e-12
            else:
                assert s['stack'][i] is None
    usable_cases = [{'minFold': mf, 'deg': usable(gfold, gcase['edges'], mf)} for mf in nonempty('min fold', [1, 2, 3, 4])]
    assert any(v is not None for u in usable_cases for v in u['deg'])
    assert len({tuple(u['deg']) for u in usable_cases}) > 1

    prestack = {
        'dix': dix_cases, 'rays': ray_cases, 'walden': walden_extra, 'bins': bins_cases, 'velocityOnGrid': vg_cases,
        'angleGather': dict(gcase, gather=gather, fold=gfold), 'partialStacks': stacks, 'usable': usable_cases,
    }

    # --- prestackQc goldens -------------------------------------------
    st_cases = [{'offsetM': x, 't0S': t, 'v': v, 'stretch': nan_none(stretch(x, t, v))}
                for (x, t, v) in nonempty('stretch', [(0, 1, 2000), (2000, 1, 2000), (2500, 1.517, 2316), (1300, 0.8, 1900), (100, 0, 2000), (3000, 2.2, 3100)])]
    mute_cases = [{'t0S': t, 'v': v, 'maxStretch': s, 'offsetM': mute_offset(t, v, s)}
                  for (t, v, s) in nonempty('mute', [(1.2, 2500, 0.3), (1.517, 2316, 0.25), (0.6, 1800, 0.15), (2.0, 3000, 0.5)])]
    rdt, rns, rcentre = 2.0, 120, 120.0
    roffs = [100 + 150 * k for k in range(16)]
    far = roffs[-1]
    rmo_cases = []
    for name, rmo_far, amp, second, kind in nonempty('residual moveout', [
        ('flat', 0.0, None, None, 'semblance'),
        ('positive_8ms', 8.0, None, None, 'semblance'),
        ('negative_6ms', -6.0, None, None, 'semblance'),
        ('dimming_3ms', 3.0, (lambda u: 1 - 0.5 * u), None, 'semblance'),
        ('polarity_flip_flat', 0.0, (lambda u: 0.15 - 0.45 * u), None, 'line'),
        ('polarity_flip_5ms', 5.0, (lambda u: 0.15 - 0.45 * u), None, 'line'),
        ('two_events_opposite_avo_flat', 0.0, (lambda u: 1 - 1.6 * u), (rcentre + 14, lambda u: -0.4 + 1.5 * u), 'line'),
        ('two_events_opposite_avo_3p3ms', 3.3, (lambda u: 1 - 1.6 * u), (rcentre + 14, lambda u: -0.4 + 1.5 * u), 'line'),
    ]):
        curv = rmo_far / (far * far)
        tr = make_gather(roffs, rns, rdt, rcentre, curv, 30, amp or (lambda u: 1.0), second)
        est = oracle_rmo(tr, roffs, rdt, rcentre, kind)
        assert abs(est - rmo_far) < 0.25, (name, est)
        rmo_cases.append({'name': name, 'traces': tr, 'offsets': roffs, 'dtMs': rdt, 'centreMs': rcentre,
                          'designedRmoFarMs': rmo_far, 'designedCurvature': curv, 'oracleRmoFarMs': est,
                          # one waveform across offset: the lags are timing; two events with opposite AVO change the waveform
                          'expectMethod': 'ab-semblance' if second else 'correlation'})
    fold_cases = [{'fold': f, 'centres': c, 'minFold': m, 'summary': fold_summary(f, c, m)}
                  for (f, c, m) in nonempty('fold', [([3, 2, 0, 1], [50, 150, 250, 350], 1), ([3, 2, 0, 1], [50, 150, 250, 350], 2),
                                                     ([0, 0, 0], [100, 300, 500], 1), ([12, 12, 11, 9, 6, 2], [100, 300, 500, 700, 900, 1100], 6)])]
    prestack_qc = {'stretch': st_cases, 'mute': mute_cases, 'rmo': rmo_cases, 'fold': fold_cases}

    for name, g in (('goldens.prestack.json', prestack), ('goldens.prestackQc.json', prestack_qc)):
        dest = os.path.join(outdir, name)
        with open(dest, 'w') as fh:
            json.dump(g, fh, indent=1, sort_keys=True, allow_nan=False)
            fh.write('\n')
        print('wrote', os.path.normpath(dest))
    print('anchors ok; rays', len(ray_cases), 'rmo', [(c['name'], round(c['oracleRmoFarMs'], 3)) for c in rmo_cases])


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', '..', '..', 'test-data', 'qi'))
