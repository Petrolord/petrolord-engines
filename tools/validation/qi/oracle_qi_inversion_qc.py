"""Independent oracle for engines/qi/inversionQc.js (QI course gate E2, 2026-10-11).

* halfWindowFor: the half width (samples) of the moving average whose window
  spans one period of the cut frequency, 1000 / (f dt) samples, halved and
  rounded to the nearest integer with halves rounded up, never below 1.
* lowPassFinite: the moving mean over the finite samples within +-half of each
  sample (the window clipped at the ends), computed here from PREFIX SUMS of
  the values and of a finite-sample count (the engine loops over each window);
  a sample that is not finite stays NaN.
* waveletScale: the convolutional model of a post-stack trace (Lindseth 1979;
  Russell 1988): reflectivity as the centred derivative of ln(AI),
  r_i = (m_{i+1} - m_{i-1}) / 2 (zero at the two ends), convolved with the
  centred wavelet. Here it is built as an explicit dense operator G = W D
  (W the Toeplitz matrix of the wavelet, D the difference matrix) and applied
  as a matrix product. The log's gaps are held at the last finite value
  (leading gap at the first); a sample is used where the trace is live
  (|v| <= 1e29) and the ORIGINAL log is finite over +-(half + 1) samples.
  The scale is the vertex of the exact (fractions.Fraction) misfit parabola
  sum (t - s syn)^2 through s = 0, 1, 2; fewer than ten samples refuse.
* blindWellTable: injected estimates with known values (the engine only
  orchestrates); the truth is the log low-passed at truthHz, and for relative
  impedance the log band-passed (low pass at truthHz minus low pass at the
  low cut, 8 Hz by default). Absolute scores: Pearson correlation of AI =
  exp(ln AI) and the RMS of the relative AI error in percent; relative: the
  Pearson correlation of the shapes only. Pearson by Welford's one-pass
  co-moment update (the engine uses two passes).

Standard library only; main() asserts the anchors and writes
test-data/qi/goldens.inversionQc.json (byte-identical on regeneration).
"""
import json
import math
import os
from fractions import Fraction

NAN = float('nan')


def lcg(seed):
    s = seed
    while True:
        s = (s * 6364136223846793005 + 1442695040888963407) % (1 << 64)
        yield (s >> 11) / float(1 << 53) - 0.5


def fin(v):
    return v is not None and isinstance(v, (int, float)) and math.isfinite(v)


def half_window(hz, dt):
    x = 1000.0 / (hz * dt) / 2.0
    lo = math.floor(x)
    r = lo + 1 if x - lo >= 0.5 else lo
    return max(1, int(r))


def low_pass(values, half):
    n = len(values)
    ps = [0.0] * (n + 1)
    pc = [0] * (n + 1)
    for i, v in enumerate(values):
        ps[i + 1] = ps[i] + (v if fin(v) else 0.0)
        pc[i + 1] = pc[i] + (1 if fin(v) else 0)
    out = []
    for i, v in enumerate(values):
        if not fin(v):
            out.append(NAN)
            continue
        a, b = max(0, i - half), min(n - 1, i + half)
        c = pc[b + 1] - pc[a]
        out.append((ps[b + 1] - ps[a]) / c)
    return out


def operator(n, wavelet):
    c = len(wavelet) // 2
    W = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            k = i - j + c
            if 0 <= k < len(wavelet):
                W[i][j] = wavelet[k]
    D = [[0.0] * n for _ in range(n)]
    for i in range(1, n - 1):
        D[i][i + 1] = 0.5
        D[i][i - 1] = -0.5
    return W, D


def matvec(M, x):
    return [sum(a * b for a, b in zip(row, x) if a != 0.0) for row in M]


def hold(values):
    idx = [i for i, v in enumerate(values) if fin(v)]
    if not idx:
        return None
    out = list(values)
    first = idx[0]
    for i in range(first):
        out[i] = values[first]
    for i in range(first + 1, len(out)):
        if not fin(out[i]):
            out[i] = out[i - 1]
    return out


def live(v):
    return fin(v) and abs(v) <= 1e29


def wavelet_scale(pairs, wavelet):
    half = (len(wavelet) - 1) // 2
    used = []  # (syn, trace) as Fractions
    for p in pairs:
        log, tr = p['lnAi'], p['trace']
        h = hold(log)
        if h is None:
            continue
        W, D = operator(len(h), wavelet)
        syn = matvec(W, matvec(D, h))
        for i in range(len(tr)):
            if not live(tr[i]):
                continue
            if not all(0 <= j < len(log) and fin(log[j]) for j in range(i - half - 1, i + half + 2)):
                continue
            used.append((Fraction(syn[i]), Fraction(tr[i])))
    if len(used) < 10 or all(s == 0 for s, _ in used):
        return None
    E = lambda s: sum((t - s * y) ** 2 for y, t in used)
    e0, e1, e2 = E(0), E(1), E(2)
    a = (e2 - 2 * e1 + e0) / 2
    b = e1 - e0 - a
    s = -b / (2 * a)
    return {'scale': float(s), 'samples': len(used)}


def pearson(x, y):
    n = 0
    mx = my = cxy = cxx = cyy = 0.0
    for a, b in zip(x, y):
        n += 1
        dx = a - mx
        mx += dx / n
        dy = b - my
        my += dy / n
        cxy += dx * (b - my)
        cxx += dx * (a - mx)
        cyy += dy * (b - my)
    return cxy / math.sqrt(cxx * cyy) if cxx > 0 and cyy > 0 else NAN


def score_abs(est, truth):
    a, b = [], []
    for e, t in zip(est, truth):
        if fin(e) and fin(t):
            a.append(math.exp(e))
            b.append(math.exp(t))
    if len(a) < 3:
        return {'corr': NAN, 'rmsPct': NAN, 'n': len(a)}
    rel = math.fsum(((p - q) / q) ** 2 for p, q in zip(a, b))
    return {'corr': pearson(a, b), 'rmsPct': 100 * math.sqrt(rel / len(a)), 'n': len(a)}


def score_rel(est, truth):
    a, b = [], []
    for e, t in zip(est, truth):
        if fin(e) and fin(t):
            a.append(e)
            b.append(t)
    if len(a) < 3:
        return {'corr': NAN, 'rmsPct': None, 'n': len(a)}
    return {'corr': pearson(a, b), 'rmsPct': None, 'n': len(a)}


def blind_table(case):
    dt, thz = case['dtMs'], case['truthHz']
    out = []
    for k, w in enumerate(case['wells']):
        truth = low_pass(w['ln_ai'], half_window(thz, dt))
        if not case['absolute']:
            lo = low_pass(w['ln_ai'], half_window(case.get('lowCutHz', 8), dt))
            truth = [t - l for t, l in zip(truth, lo)]
        sc = score_abs if case['absolute'] else score_rel
        out.append({'name': w['name'], 'blind': sc(case['blind'][k], truth), 'withWell': sc(case['withWell'][k], truth)})
    return out


def ricker(fp, dt, half):
    out = []
    for i in range(2 * half + 1):
        t = (i - half) * dt / 1000.0
        a = (math.pi * fp * t) ** 2
        out.append((1 - 2 * a) * math.exp(-a))
    return out


def blocky_log(u, n, base):
    v, out = base, []
    for i in range(n):
        if i % 11 == 0:
            v += 0.08 * next(u)
        out.append(v + 0.01 * next(u))
    return out


def nanify(xs):
    return [None if not fin(x) else x for x in xs]


def main():
    u = lcg(987)
    dt, n = 4, 120
    wav = ricker(25, dt, 12)
    # wavelet scale: three wells, one with a gap and a leading null log, one trace with dead samples, one log empty
    logs = [blocky_log(u, n, 8.7), blocky_log(u, n, 8.9), blocky_log(u, n, 8.6)]
    for i in range(50, 54):
        logs[1][i] = NAN
    for i in range(0, 15):
        logs[2][i] = NAN
    s_true = 3.7e4
    traces = []
    for lg in logs:
        h = hold(lg)
        W, D = operator(n, wav)
        syn = matvec(W, matvec(D, h))
        traces.append([s_true * y + 40 * next(u) for y in syn])
    for i in range(0, 9):
        traces[0][i] = 1e30
    pairs = [{'lnAi': nanify(lg), 'trace': tr} for lg, tr in zip(logs, traces)]
    pairs.append({'lnAi': [None] * n, 'trace': traces[0]})
    ws = wavelet_scale([{'lnAi': [NAN if v is None else v for v in p['lnAi']], 'trace': p['trace']} for p in pairs], wav)
    assert ws and abs(ws['scale'] / s_true - 1) < 0.01  # anchor: the planted amplitude scale comes back
    # anchor: the dense operator agrees with the direct definition of the centred derivative and convolution
    m = logs[0]
    r = [0.0] + [(m[i + 1] - m[i - 1]) / 2 for i in range(1, n - 1)] + [0.0]
    direct = [sum(wav[k] * r[i - k + 12] for k in range(len(wav)) if 0 <= i - k + 12 < n) for i in range(n)]
    W, D = operator(n, wav)
    assert max(abs(a - b) for a, b in zip(direct, matvec(W, matvec(D, m)))) < 1e-12
    refuse = wavelet_scale([{'lnAi': logs[0], 'trace': [1e30] * n}], wav)
    assert refuse is None

    hw = [{'hz': hz, 'dtMs': d, 'half': half_window(hz, d)} for hz, d in ((8, 4), (50, 4), (60, 2), (8, 2), (500, 4), (40, 4), (12, 4))]
    assert [h['half'] for h in hw][:2] == [16, 3]  # 15.625 -> 16; 2.5 rounds up to 3

    lp_in = logs[1][:]
    lp_cases = [{'values': nanify(lp_in), 'half': h, 'out': nanify(low_pass(lp_in, h))} for h in (1, 3, 16)]
    # anchor: the prefix-sum mean equals a direct window mean at a few samples
    for i in (0, 30, 60, 119):
        win = [v for v in lp_in[max(0, i - 3):i + 4] if fin(v)]
        assert abs(low_pass(lp_in, 3)[i] - sum(win) / len(win)) < 1e-12

    # blind-well tables with injected estimates
    blind_cases = []
    wl = [blocky_log(u, n, 8.8), blocky_log(u, n, 8.5), blocky_log(u, n, 9.0)]
    for i in range(0, 10):
        wl[0][i] = NAN
    for i in range(70, 75):
        wl[2][i] = NAN
    wells = [{'name': nm, 'il': 10 + k, 'xl': 20 + 2 * k, 'ln_ai': nanify(lg)} for k, (nm, lg) in enumerate(zip(['A', 'B', 'C'], wl))]
    blind = [[(v + 0.03 * next(u) + 0.02) if fin(v) else 8.8 for v in lg] for lg in wl]
    withw = [[(v + 0.01 * next(u)) if fin(v) else 8.8 for v in lg] for lg in wl]
    blind[1][5] = NAN
    for absolute, low, thz in ((True, None, 50), (False, None, 50), (False, 10, 40)):
        case = {'dtMs': dt, 'truthHz': thz, 'absolute': absolute, 'wells': [dict(w, ln_ai=[NAN if v is None else v for v in w['ln_ai']]) for w in wells],
                'blind': blind, 'withWell': withw}
        if low is not None:
            case['lowCutHz'] = low
        expect = blind_table(case)
        rec = {'dtMs': dt, 'truthHz': thz, 'absolute': absolute, 'wells': wells, 'blind': [nanify(b) for b in blind],
               'withWell': [nanify(b) for b in withw], 'expect': expect}
        if low is not None:
            rec['lowCutHz'] = low
        blind_cases.append(rec)
    # anchors: the blind estimate (larger perturbation) scores worse than the with-well one; a perfect estimate scores 0
    for row in blind_cases[0]['expect']:
        assert row['blind']['rmsPct'] > row['withWell']['rmsPct']
    perfect = score_abs(low_pass(wl[1], half_window(50, dt)), low_pass(wl[1], half_window(50, dt)))
    assert perfect['rmsPct'] == 0 and abs(perfect['corr'] - 1) < 1e-12
    assert all(r['blind']['rmsPct'] is None for r in blind_cases[1]['expect'])

    for name, lst in (('halfWindow', hw), ('lowPass', lp_cases), ('blind', blind_cases)):
        assert lst, 'refusing an empty sweep: ' + name
    g = {'dtMs': dt, 'wavelet': wav, 'waveletScale': {'pairs': pairs, 'expect': ws, 'refuse': {'pair': {'lnAi': nanify(logs[0]), 'trace': [1e30] * n}}},
         'halfWindow': hw, 'lowPass': lp_cases, 'blind': blind_cases}

    def clean(x):
        if isinstance(x, float) and not math.isfinite(x):
            return None
        if isinstance(x, list):
            return [clean(v) for v in x]
        if isinstance(x, dict):
            return {k: clean(v) for k, v in x.items()}
        return x
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', '..', '..', 'test-data', 'qi', 'goldens.inversionQc.json')
    with open(dest, 'w') as fh:
        json.dump(clean(g), fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors ok; scale', ws, '; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
