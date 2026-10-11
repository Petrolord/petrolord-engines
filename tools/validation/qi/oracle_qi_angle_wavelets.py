"""Independent oracle for engines/qi/angleWavelets.js and
engines/seismolord/wellWavelet.js (QI course gate E2, 2026-10-11).

* Angle reflectivity: Fatti, Smith, Vail, Strauss and Levitt (1994,
  Geophysics 59(9), 1362) three-term form of the Aki-Richards equation,
    R(theta) = (1 + tan^2) dIp/2Ip - 8 K^2 sin^2 dIs/2Is - (tan^2 - 4 K^2 sin^2) drho/2rho,
  K = Vs/Vp, with each relative jump read as the per-sample centred change of
  the log, (ln x_{i+1} - ln x_{i-1}) / 2. A sample is missing unless all
  three logs are finite on both sides of it. Anchor: on a weak-contrast
  two-layer interface it matches a separately coded Aki-Richards (1980)
  reflectivity to second order in the contrast.
* The well wavelet: the damped least-squares (Wiener) wavelet w minimising
  sum_t (sum_k w_k rc_{t-k} - s_t)^2 + lambda sum_k w_k^2, lambda = damping x
  the mean diagonal of the normal matrix, over the trace samples that are
  live (finite and not the Float32 brick null) whose whole reflectivity
  window is defined (outside the log counts as zero). Solved here by
  CHOLESKY factorisation (the engine eliminates with partial pivoting); the
  result peak-normalised and rounded to Float32 as the engine stores it; the
  fit correlation uncentred over the used rows. Refusals: no energy at all,
  or fewer than twice the wavelet length of usable rows.
* Angle wavelets: per angle, each well's wavelet (refused wells skipped),
  then for two or more wells aligned to the first by the lag (|lag| <= 4,
  first maximum from the most negative lag) of the normalised cross-
  correlation computed by a zero-padded DISCRETE FOURIER TRANSFORM (the
  engine sums each lag directly), each normalised to unit energy, averaged,
  renormalised and given the wells' mean wavelet energy; the misfit is each
  aligned wavelet's correlation with the average; the synthetic of each well
  (its reflectivity convolved with the angle's wavelet over the defined
  samples) is scored by a two-pass Pearson correlation (at least 5 samples).

Standard library only; main() asserts the anchors and writes
test-data/qi/goldens.angleWavelets.json (byte-identical on regeneration).
"""
import cmath
import json
import math
import os
import struct

NAN = float('nan')
F32_NULL = struct.unpack('f', struct.pack('f', 1e30))[0]


def f32(x):
    return struct.unpack('f', struct.pack('f', x))[0]


def lcg(seed):
    s = seed
    while True:
        s = (s * 6364136223846793005 + 1442695040888963407) % (1 << 64)
        yield (s >> 11) / float(1 << 53) - 0.5


def fin(v):
    return v is not None and isinstance(v, (int, float)) and math.isfinite(v)


# ---- Fatti reflectivity ------------------------------------------------------

def fatti(theta_deg, K, dIp, dIs, drho):
    t = math.radians(theta_deg)
    s2, t2 = math.sin(t) ** 2, math.tan(t) ** 2
    return (1 + t2) * dIp / 2 - 8 * K * K * s2 * dIs / 2 - (t2 - 4 * K * K * s2) * drho / 2


def angle_reflectivity(well, theta, K):
    n = len(well['ln_ai'])
    ok = lambda i: 0 <= i < n and all(fin(well[k][i]) for k in ('ln_ai', 'ln_si', 'ln_rho'))
    out = []
    for i in range(n):
        if not (ok(i - 1) and ok(i + 1)):
            out.append(NAN)
            continue
        d = {k: (well[k][i + 1] - well[k][i - 1]) / 2 for k in ('ln_ai', 'ln_si', 'ln_rho')}
        out.append(fatti(theta, K, d['ln_ai'], d['ln_si'], d['ln_rho']))
    return out


def aki_richards(vp1, vs1, r1, vp2, vs2, r2, theta):
    t = math.radians(theta)
    vp, vs, rho = (vp1 + vp2) / 2, (vs1 + vs2) / 2, (r1 + r2) / 2
    k2 = (vs / vp) ** 2
    s2 = math.sin(t) ** 2
    return (0.5 * (1 - 4 * k2 * s2) * (r2 - r1) / rho + (vp2 - vp1) / vp / (2 * math.cos(t) ** 2)
            - 4 * k2 * s2 * (vs2 - vs1) / vs)


# ---- the well wavelet --------------------------------------------------------

def live(v):
    return fin(v) and v != F32_NULL


def cholesky_solve(A, b):
    n = len(b)
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = A[i][j] - math.fsum(L[i][k] * L[j][k] for k in range(j))
            if i == j:
                if s <= 0:
                    return None
                L[i][i] = math.sqrt(s)
            else:
                L[i][j] = s / L[j][j]
    y = [0.0] * n
    for i in range(n):
        y[i] = (b[i] - math.fsum(L[i][k] * y[k] for k in range(i))) / L[i][i]
    x = [0.0] * n
    for i in reversed(range(n)):
        x[i] = (y[i] - math.fsum(L[k][i] * x[k] for k in range(i + 1, n))) / L[i][i]
    return x


class Refused(Exception):
    pass


def well_wavelet(rc, s, half, damping=1e-3):
    n = min(len(rc), len(s))
    m = 2 * half + 1
    rows = []
    for t in range(n):
        if not live(s[t]):
            continue
        row, good = [], True
        for k in range(-half, half + 1):
            i = t - k
            if 0 <= i < n:
                if not live(rc[i]):
                    good = False
                    break
                row.append(rc[i])
            else:
                row.append(0.0)
        if good:
            rows.append((row, s[t]))
    if not any(any(v != 0 for v in r) for r, _ in rows):
        raise Refused('flat')
    if len(rows) < 2 * m:
        raise Refused('short', len(rows), 2 * m)
    A = [[math.fsum(r[i] * r[j] for r, _ in rows) for j in range(m)] for i in range(m)]
    b = [math.fsum(r[i] * v for r, v in rows) for i in range(m)]
    lam = damping * math.fsum(A[i][i] for i in range(m)) / m
    for i in range(m):
        A[i][i] += lam
    w = cholesky_solve(A, b)
    pp = ps = ss = 0.0
    for r, v in rows:
        p = math.fsum(a * c for a, c in zip(r, w))
        pp += p * p
        ps += p * v
        ss += v * v
    peak = max(abs(v) for v in w) or 1.0
    return {'wavelet': [f32(v / peak) for v in w], 'used': len(rows),
            'fitCorr': ps / math.sqrt(pp * ss) if pp > 0 and ss > 0 else 0.0, 'w64': w}


# ---- alignment and averaging -------------------------------------------------

def dft(x, sign):
    N = len(x)
    return [sum(x[j] * cmath.exp(sign * 2j * math.pi * j * k / N) for j in range(N)) for k in range(N)]


def unit(w):
    e = math.sqrt(math.fsum(v * v for v in w))
    return [v / e if e > 0 else 0.0 for v in w]


def align(a, b, max_lag):
    n = len(a)
    N = 1
    while N < 2 * n:
        N *= 2
    A = dft(list(a) + [0.0] * (N - n), -1)
    B = dft(list(b) + [0.0] * (N - n), -1)
    c = dft([p * q.conjugate() for p, q in zip(A, B)], 1)
    ea = math.sqrt(math.fsum(v * v for v in a))
    eb = math.sqrt(math.fsum(v * v for v in b))
    best, bc = 0, -math.inf
    for lag in range(-max_lag, max_lag + 1):
        v = (c[lag % N].real / N) / (ea * eb) if ea * eb > 0 else 0.0
        if v > bc:
            best, bc = lag, v
    out = [b[i - best] if 0 <= i - best < len(b) else 0.0 for i in range(n)]
    return out, best


def zero_lag(a, b):
    ea = math.sqrt(math.fsum(v * v for v in a))
    eb = math.sqrt(math.fsum(v * v for v in b))
    return math.fsum(p * q for p, q in zip(a, b)) / (ea * eb) if ea * eb > 0 else 0.0


def compare(wavelets, max_lag=4):
    ref = unit(wavelets[0][1])
    aligned = [(wavelets[0][0], ref, 0)]
    for name, w in wavelets[1:]:
        al, lag = align(ref, unit(w), max_lag)
        aligned.append((name, unit(al), lag))
    n = len(ref)
    avg = unit([math.fsum(a[1][i] for a in aligned) / len(aligned) for i in range(n)])
    return avg, [{'name': a[0], 'corrToAverage': zero_lag(a[1], avg)} for a in aligned], [a[2] for a in aligned]


def convolve_defined(r, w):
    h = (len(w) - 1) // 2
    out = []
    for i in range(len(r)):
        terms = [w[k + h] * r[i - k] for k in range(-h, h + 1) if 0 <= i - k < len(r) and fin(r[i - k])]
        out.append(math.fsum(terms) if terms else NAN)
    return out


def pearson(a, b):
    pts = [(x, y) for x, y in zip(a, b) if fin(x) and fin(y)]
    if len(pts) < 5:
        return NAN
    n = len(pts)
    mx = math.fsum(p[0] for p in pts) / n
    my = math.fsum(p[1] for p in pts) / n
    sxy = math.fsum((x - mx) * (y - my) for x, y in pts)
    sxx = math.fsum((x - mx) ** 2 for x, _ in pts)
    syy = math.fsum((y - my) ** 2 for _, y in pts)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else NAN


def angle_wavelets(wells, traces_by_well, thetas, K, half):
    out = []
    for k, theta in enumerate(thetas):
        per = []
        for j, w in enumerate(wells):
            tr = [NAN if v is None else v for v in traces_by_well[j][k]]
            rc = angle_reflectivity(w, theta, K)
            try:
                ex = well_wavelet(rc, tr, half)
            except Refused:
                continue
            if any(v != 0 for v in ex['wavelet']):
                per.append((w['name'], ex, rc, tr))
        if not per:
            out.append({'angle': theta, 'samples': None, 'wells': [{'name': w['name'], 'fitCorr': NAN, 'synthCorr': NAN} for w in wells], 'misfit': [], 'lags': []})
            continue
        if len(per) > 1:
            avg, misfit, lags = compare([(p[0], p[1]['wavelet']) for p in per])
            energy = math.fsum(math.sqrt(math.fsum(v * v for v in p[1]['wavelet'])) for p in per) / len(per)
            samples = [v * energy for v in avg]
        else:
            samples, misfit, lags = list(per[0][1]['wavelet']), [], [0]
        out.append({'angle': theta, 'samples': samples, 'misfit': misfit, 'lags': lags,
                    'wells': [{'name': p[0], 'fitCorr': p[1]['fitCorr'], 'synthCorr': pearson(convolve_defined(p[2], samples), p[3])} for p in per]})
    return out


# ---- the cases ---------------------------------------------------------------

def ricker(fp, dt, half, scale=1.0):
    out = []
    for i in range(2 * half + 1):
        t = (i - half) * dt / 1000.0
        a = (math.pi * fp * t) ** 2
        out.append(scale * (1 - 2 * a) * math.exp(-a))
    return out


def make_well(u, name, n, flat=False):
    w = {'name': name, 'ln_ai': [], 'ln_si': [], 'ln_rho': []}
    a, s, r = 8.8, 8.1, 0.85
    for i in range(n):
        if not flat and i % 9 == 0:
            a += 0.06 * next(u)
            s += 0.07 * next(u)
            r += 0.02 * next(u)
        w['ln_ai'].append(a)
        w['ln_si'].append(s)
        w['ln_rho'].append(r)
    return w


def stack(well, theta, K, wav, u, noise, shift=0):
    n = len(well['ln_ai'])
    filled = {k: [v if fin(v) else 0.0 for v in well[k]] for k in ('ln_ai', 'ln_si', 'ln_rho')}
    r = [0.0] + [fatti(theta, K, *[(filled[k][i + 1] - filled[k][i - 1]) / 2 for k in ('ln_ai', 'ln_si', 'ln_rho')]) for i in range(1, n - 1)] + [0.0]
    h = (len(wav) - 1) // 2
    syn = [math.fsum(wav[k + h] * r[i - k] for k in range(-h, h + 1) if 0 <= i - k < n) for i in range(n)]
    out = [syn[min(n - 1, max(0, i - shift))] + noise * next(u) for i in range(n)]
    return out


def clean(x):
    if isinstance(x, float) and not math.isfinite(x):
        return None
    if isinstance(x, list):
        return [clean(v) for v in x]
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items() if k != 'w64'}
    if isinstance(x, tuple):
        return [clean(v) for v in x]
    return x


def main():
    u = lcg(4242)
    n, dt, K, half = 200, 4, 0.5, 12
    thetas = [8, 22, 34]
    wavs = [ricker(30, dt, half, 1.6), ricker(25, dt, half, 1.6), ricker(19, dt, half, 1.6)]
    wells = [make_well(u, 'A', n), make_well(u, 'B', n), make_well(u, 'C', n, flat=True), make_well(u, 'D', n)]
    for i in range(80, 84):
        wells[3]['ln_si'][i] = NAN
    traces = []
    for j, w in enumerate(wells):
        traces.append([stack(w, th, K, wavs[k], u, 2e-4, shift=(1 if j == 1 else 0)) for k, th in enumerate(thetas)])
    for k in range(3):
        for i in range(100, 104):
            traces[0][k][i] = F32_NULL  # the brick null as a Float32 read gives it
        for i in range(120, 123):
            traces[3][k][i] = F32_NULL
        traces[3][k][150] = NAN
    # anchors ----------------------------------------------------------------
    # 1. Fatti agrees with Aki-Richards to second order on weak contrasts
    for eps in (1e-3, 1e-4):
        vp1, vs1, r1 = 3000.0, 1500.0, 2400.0
        vp2, vs2, r2 = vp1 * (1 + eps), vs1 * (1 - 1.3 * eps), r1 * (1 + 0.4 * eps)
        for th in (0, 15, 30):
            K0 = ((vs1 + vs2) / 2) / ((vp1 + vp2) / 2)
            fr = fatti(th, K0, math.log(vp2 * r2 / (vp1 * r1)), math.log(vs2 * r2 / (vs1 * r1)), math.log(r2 / r1))
            ar = aki_richards(vp1, vs1, r1, vp2, vs2, r2, th)
            assert abs(fr - ar) < 5 * eps * eps, (eps, th, fr, ar)
    # 2. the Wiener wavelet recovers the planted wavelet on a noise-free stack
    rc = angle_reflectivity(wells[0], 22, K)
    clean_tr = stack(wells[0], 22, K, wavs[1], lcg(1), 0.0)
    ex = well_wavelet(rc, clean_tr, half, damping=1e-10)
    peak = max(abs(v) for v in wavs[1])
    assert max(abs(a - b / peak) for a, b in zip(ex['wavelet'], wavs[1])) < 1e-5 and ex['fitCorr'] > 0.999999
    # 3. the DFT correlation finds a known shift
    a, b = ricker(30, dt, 8), ricker(30, dt, 8)
    b = b[2:] + [0.0, 0.0]
    al, lag = align(unit(a), unit(b), 4)
    assert lag == 2
    # 4. the flat well is refused
    try:
        well_wavelet(angle_reflectivity(wells[2], 22, K), traces[2][1], half)
        raise AssertionError('flat well not refused')
    except Refused:
        pass
    # the golden cases --------------------------------------------------------
    multi = angle_wavelets(wells, traces, thetas, K, half)
    assert multi and all(m['samples'] for m in multi)
    assert all([x['name'] for x in m['wells']] == ['A', 'B', 'D'] for m in multi)
    assert all(m['lags'][1] != 0 for m in multi), 'the shifted well must need a lag'
    for k, m in enumerate(multi):  # each angle's average follows its own wavelet
        assert zero_lag(m['samples'], wavs[k]) > 0.97
    one = angle_wavelets(wells[:1], [t[1:2] for t in traces[:1]], [22], K, 10)
    none = angle_wavelets(wells[2:3], traces[2:3], thetas, K, half)
    assert none[0]['samples'] is None
    refl = {'theta': 22, 'expect': angle_reflectivity(wells[3], 22, K)}
    wel = {'theta': 22, 'half': half, 'damping': 1e-3, 'expect': well_wavelet(angle_reflectivity(wells[3], 22, K), traces[3][1], half)}
    rc0 = angle_reflectivity(wells[0], 22, K)
    try:
        well_wavelet(rc0[:60], [NAN if v is None else v for v in traces[0][1][:60]], 15)
        raise AssertionError('short log not refused')
    except Refused as e:
        assert e.args[0] == 'short' and 31 <= e.args[1] < 62
        short = {'n': 60, 'half': 15, 'rows': e.args[1], 'need': e.args[2]}
    for name, v in (('multi', multi), ('one', one), ('none', none)):
        assert v, 'refusing an empty sweep: ' + name
    g = {'K': K, 'thetas': thetas, 'half': half, 'wells': wells, 'traces': traces,
         'multi': multi, 'one': one, 'none': none, 'reflectivity': refl, 'wellWavelet': wel, 'short': short}
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', '..', '..', 'test-data', 'qi', 'goldens.angleWavelets.json')
    with open(dest, 'w') as fh:
        json.dump(clean(g), fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors ok; lags', [m['lags'] for m in multi], '; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
