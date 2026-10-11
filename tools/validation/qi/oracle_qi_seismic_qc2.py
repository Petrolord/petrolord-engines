"""Independent oracle for the rest of engines/qi/seismicQc.js (QI course gate
E1c, G6): the spectrum of ARBITRARY traces with its taper, the average
spectrum, signal to noise from coherency and the acquisition footprint.

Standard library only, no shared code, never the JS loops. The existing
oracle_seismic_qc.py (analytic Ricker) is left as it is; this one writes
test-data/qi/goldens.seismicQc2.json.

  taper           the Tukey (tapered cosine) window of Harris (1978, Proc.
                  IEEE 66(1), eq. 38): w = 1/2 [1 - cos(pi i / W)] for
                  0 <= i < W with W = alpha (n - 1) / 2, mirrored, 1 between.
                  The JS takes W = floor(alpha (n - 1) / 2), a taper that ends
                  on a sample. The two agree whenever alpha (n - 1) / 2 is a
                  whole number, which every gated case is; the one case where
                  it is not is reported, with its effect on the band edges, as
                  a documented convention (FINDINGS-E1c.md, C1).
  spectrum        a DIRECT discrete Fourier transform, O(N n), of the tapered
                  trace zero padded to N = twice the next power of two
                  (the JS uses a radix-2 FFT), one sided |X(f)|.
  average         the power mean of the traces' spectra, then the root.
  statistics      the estimators the module header defines: the peak refined
                  by a parabola through the three highest bins (DC excluded),
                  the -6 and -20 dB edges where the amplitude first falls
                  below the level either side of the peak bin, linearly
                  interpolated between bins, and the power centroid
                  sum f A^2 / sum A^2. Cross-checked against the CONTINUOUS
                  transform (the DTFT evaluated at any frequency, edges by
                  bisection): every bin estimate must sit within one bin of it.
  signal to noise Hatton, Worthington and Makin (1986, Seismic Data
                  Processing, 4.4): two traces s + n1 and s + n2 with equal,
                  uncorrelated noise have a normalised correlation
                  c = S / (S + N), so S/N = c / (1 - c). The best c over the
                  searched lags (uncentred, over the overlapping finite
                  samples) per neighbouring pair; the median over pairs.
                  Anchor: on seeded traces the estimate is within 30 percent
                  of the REALISED S/N (the sample powers of the signal and the
                  noise actually drawn).
  footprint       the profile along each axis (the mean over the other axis),
                  the least-squares line removed (centred form), a direct DFT
                  on the grid of N = 4 x next power of two, the periodogram;
                  the peak in the searched period band; the fundamental (the
                  longest sub-multiple m = 4..2 holding half the peak's
                  five-bin power); the share of the variance at it and its
                  harmonics; the prominence over the band's median power.
                  Anchor: a stripe every 4 lines is found at period 4 with
                  most of the profile's variance, and the same slice without
                  it has no prominent period.

Every case list must be non-empty or the oracle refuses (exit 1).
Regeneration is byte-identical.

Usage: python3 -I tools/validation/qi/oracle_qi_seismic_qc2.py [dest.json]
"""
import cmath
import json
import math
import os
import sys


def fin(v):
    return v is not None and math.isfinite(v)


class Lcg:
    """The house seeded generator (ANSI C LCG) with Box-Muller normals."""

    def __init__(self, seed):
        self.s = seed

    def u(self):
        self.s = (self.s * 1103515245 + 12345) % 2147483648
        return self.s / 2147483648

    def g(self):
        a = max(self.u(), 1e-12)
        return math.sqrt(-2 * math.log(a)) * math.cos(2 * math.pi * self.u())


def pow2_at_least(n):
    p = 1
    while p < n:
        p <<= 1
    return p


def harris_tukey(n, alpha, on_sample=False):
    width = alpha * (n - 1) / 2
    if on_sample:
        width = math.floor(width)  # the engine's convention: the taper ends on a sample
    w = []
    for i in range(n):
        j = min(i, n - 1 - i)
        w.append(0.5 * (1 - math.cos(math.pi * j / width)) if j < width else 1.0)
    return w


def dft_amp(trace, dt_ms, alpha, on_sample=False):
    n = len(trace)
    w = harris_tukey(n, alpha, on_sample) if alpha > 0 else [1.0] * n
    x = [(v if fin(v) else 0.0) * wi for v, wi in zip(trace, w)]
    N = 2 * pow2_at_least(n)
    df = 1000 / (N * dt_ms)
    amp = []
    for k in range(N // 2 + 1):
        re = math.fsum(x[i] * math.cos(2 * math.pi * k * i / N) for i in range(n))
        im = math.fsum(-x[i] * math.sin(2 * math.pi * k * i / N) for i in range(n))
        amp.append(math.hypot(re, im))
    return [k * df for k in range(N // 2 + 1)], amp, df, x


def dtft_amp(x, dt_ms, f):
    s = sum(v * cmath.exp(-2j * math.pi * f * dt_ms / 1000 * i) for i, v in enumerate(x))
    return abs(s)


def stats(freq, amp):
    k_max = max(range(1, len(amp)), key=lambda k: (amp[k], -k))
    peak_f, peak_a = freq[k_max], amp[k_max]
    if 0 < k_max < len(amp) - 1:
        a, b, c = amp[k_max - 1], amp[k_max], amp[k_max + 1]
        # the vertex of the parabola through (-1, a), (0, b), (1, c)
        curv = a - 2 * b + c
        if curv < 0:
            p = (a - c) / (2 * curv)
            peak_f = freq[k_max] + p * (freq[1] - freq[0])
            peak_a = b + 0.5 * (c - a) * p + 0.5 * curv * p * p
    pw = [v * v for v in amp]
    centroid = math.fsum(f * p for f, p in zip(freq, pw)) / math.fsum(pw)

    def edges(level):
        thr = peak_a * level
        lo, hi = freq[0], freq[-1]
        k = k_max
        while k > 0:
            if amp[k - 1] < thr:
                lo = freq[k - 1] + (thr - amp[k - 1]) / (amp[k] - amp[k - 1]) * (freq[k] - freq[k - 1])
                break
            k -= 1
        k = k_max
        while k < len(amp) - 1:
            if amp[k + 1] < thr:
                hi = freq[k] + (amp[k] - thr) / (amp[k] - amp[k + 1]) * (freq[k + 1] - freq[k])
                break
            k += 1
        return [lo, hi]

    b6, b20 = edges(10 ** (-6 / 20)), edges(10 ** (-20 / 20))
    return {'peakHz': peak_f, 'peakAmp': peak_a, 'centroidHz': centroid, 'band6': b6, 'band20': b20, 'kMax': k_max}


def continuous_edges(x, dt_ms, peak_f, level, df):
    """Edges on the DTFT by bisection, starting from the bin estimates' side."""
    ap = max(dtft_amp(x, dt_ms, peak_f + d * df / 20) for d in range(-20, 21))
    thr = ap * level

    def root(a, b):
        fa = dtft_amp(x, dt_ms, a) - thr
        for _ in range(60):
            m = (a + b) / 2
            fm = dtft_amp(x, dt_ms, m) - thr
            if (fm > 0) == (fa > 0):
                a, fa = m, fm
            else:
                b = m
        return (a + b) / 2

    lo = peak_f
    while lo > 0 and dtft_amp(x, dt_ms, lo) >= thr:
        lo -= df / 4
    hi = peak_f
    while dtft_amp(x, dt_ms, hi) >= thr:
        hi += df / 4
    return [root(max(lo, 0.0), lo + df / 4) if lo > 0 else 0.0, root(hi - df / 4, hi)]


def ricker(fp, dt_ms, half):
    out = []
    for i in range(-half, half + 1):
        a = (math.pi * fp * i * dt_ms / 1000) ** 2
        out.append((1 - 2 * a) * math.exp(-a))
    return out


def synthetic(n, dt_ms, fp, seed, noise):
    g = Lcg(seed)
    rc = [0.0] * n
    for i in range(n):
        if g.u() < 0.12:
            rc[i] = 0.2 * g.g()
    w = ricker(fp, dt_ms, 30)
    out = []
    for i in range(n):
        s = 0.0
        for k, wk in enumerate(w):
            j = i - (k - 30)
            if 0 <= j < n:
                s += wk * rc[j]
        out.append(round(s + noise * g.g(), 6))
    return out


# --- signal to noise ---------------------------------------------------------

def ncc(a, b, lag):
    xy, xx, yy = [], [], []
    for i, x in enumerate(a):
        j = i + lag
        if 0 <= j < len(b) and fin(x) and fin(b[j]):
            xy.append(x * b[j])
            xx.append(x * x)
            yy.append(b[j] * b[j])
    sxx, syy = math.fsum(xx), math.fsum(yy)
    return math.fsum(xy) / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else None


def snr(traces, max_lag):
    per = []
    for a, b in zip(traces, traces[1:]):
        cs = [c for c in (ncc(a, b, lag) for lag in range(-max_lag, max_lag + 1)) if c is not None]
        if not cs:
            continue
        c = min(max(max(cs), 0.0), 0.999999)
        per.append(c / (1 - c))
    srt = sorted(per)
    m = len(srt)
    med = srt[(m - 1) // 2] if m % 2 else 0.5 * (srt[m // 2 - 1] + srt[m // 2])
    return {'snr': med, 'snrDb': 10 * math.log10(med) if med > 0 else None, 'pairs': m, 'perPair': per}


def snr_traces(target, seed, n, count, dip):
    g = Lcg(seed)
    sig = [g.g() for _ in range(n + 40)]
    sd = 1 / math.sqrt(target)
    traces, noise = [], []
    for k in range(count):
        nz = [sd * g.g() for _ in range(n)]
        noise.append(nz)
        traces.append([round(sig[i + 20 + k * dip] + nz[i], 6) for i in range(n)])
    s_pow = math.fsum(v * v for v in sig[20:20 + n]) / n
    n_pow = math.fsum(v * v for nz in noise for v in nz) / (n * count)
    return traces, s_pow / n_pow


# --- footprint ---------------------------------------------------------------

def stripe(p, min_p, max_p):
    n = len(p)
    km = (n - 1) / 2
    pm = math.fsum(p) / n
    slope = math.fsum((k - km) * (v - pm) for k, v in enumerate(p)) / math.fsum((k - km) ** 2 for k in range(n))
    d = [v - (pm + slope * (k - km)) for k, v in enumerate(p)]
    N = pow2_at_least(n) * 4
    half = N // 2
    P = [0.0] * half
    for k in range(1, half):
        re = math.fsum(d[i] * math.cos(2 * math.pi * k * i / N) for i in range(n))
        im = math.fsum(d[i] * math.sin(2 * math.pi * k * i / N) for i in range(n))
        P[k] = re * re + im * im
    total = math.fsum(P[1:])

    def near(k):
        return math.fsum(P[q] for q in range(max(1, k - 2), min(half - 1, k + 2) + 1))

    band = [k for k in range(1, half) if min_p <= N / k <= max_p]
    if not band or not total > 0:
        return {'period': None, 'share': 0, 'prominence': 0}
    k_peak = max(band, key=lambda k: (P[k], -k))
    kf = k_peak
    for m in (4, 3, 2):
        cand = int(math.floor(k_peak / m + 0.5))
        if cand < 1 or N / cand > max_p:
            continue
        if near(cand) >= 0.5 * near(k_peak):
            kf = cand
            break
    harm = math.fsum(near(h * kf) for h in range(1, half) if h * kf < half)
    srt = sorted(P[k] for k in band)
    med = srt[(len(srt) - 1) // 2]
    return {'period': N / kf, 'share': min(1.0, harm / total), 'prominence': P[k_peak] / med if med > 0 else None}


def footprint(sl, min_p=2, max_p=16):
    n_il, n_xl = len(sl), len(sl[0])

    def mean(vals):
        v = [x for x in vals if fin(x)]
        return math.fsum(v) / len(v) if v else 0.0
    along_xl = [mean([sl[i][j] for i in range(n_il)]) for j in range(n_xl)]
    along_il = [mean(sl[i]) for i in range(n_il)]
    return {'alongCrossline': stripe(along_xl, min_p, max_p), 'alongInline': stripe(along_il, min_p, max_p)}


def make_slice(kind, seed, n_il=40, n_xl=64):
    g = Lcg(seed)
    out = []
    for i in range(n_il):
        row = []
        for j in range(n_xl):
            base = 1 + 0.01 * i + 0.005 * j + 0.05 * g.g()
            if kind == 'add4':
                base += 0.3 if j % 4 == 0 else 0
            elif kind == 'gain4':
                base *= 1.6 if j % 4 == 0 else 1
            elif kind == 'both':
                base += (0.3 if j % 4 == 0 else 0) + (0.2 if i % 6 == 0 else 0)
            row.append(round(base, 6))
        out.append(row)
    return out


def main():
    dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'test-data', 'qi', 'goldens.seismicQc2.json')

    # taper anchors: Hann at alpha = 1, a box at alpha = 0 handled by the caller
    hann = harris_tukey(9, 1.0)
    assert all(abs(hann[i] - 0.5 * (1 - math.cos(2 * math.pi * i / 8))) < 1e-15 for i in range(9))

    spectra = []
    for (name, n, dt, fp, seed, noise, alpha, nulls) in (
            ('ricker30_n301_taper0.1', 301, 2.0, 30, 3, 0.002, 0.1, False),
            ('ricker20_n257_taper0.25', 257, 4.0, 20, 4, 0.01, 0.25, False),
            ('ricker45_n401_taper0.1_nulls', 401, 2.0, 45, 5, 0.005, 0.1, True),
            ('ricker25_n201_box', 201, 2.0, 25, 6, 0.0, 0.0, False)):
        tr = synthetic(n, dt, fp, seed, noise)
        if nulls:
            for i in range(0, 12):
                tr[i] = None
            tr[200] = None
        assert alpha == 0 or abs(alpha * (n - 1) / 2 - round(alpha * (n - 1) / 2)) < 1e-12
        freq, amp, df, x = dft_amp(tr, dt, alpha)
        st = stats(freq, amp)
        cont = continuous_edges(x, dt, st['peakHz'], 10 ** (-6 / 20), df)
        assert abs(cont[0] - st['band6'][0]) < df and abs(cont[1] - st['band6'][1]) < df, (name, cont, st['band6'])
        spectra.append({'name': name, 'trace': tr, 'dtMs': dt, 'taper': alpha, 'df': df, 'nBins': len(amp),
                        'ampEvery16': [amp[k] for k in range(0, len(amp), 16)], 'stats': st, 'continuous6': cont})

    # the average spectrum of a trace set (the capstone's supplied patch)
    patch = [synthetic(301, 2.0, 28, 40 + k, 0.004) for k in range(6)]
    per = [dft_amp(t, 2.0, 0.1) for t in patch]
    avg_amp = [math.sqrt(math.fsum(p[1][k] ** 2 for p in per) / len(per)) for k in range(len(per[0][1]))]
    avg = {'traces': patch, 'dtMs': 2.0, 'taper': 0.1, 'ampEvery16': avg_amp[::16], 'stats': stats(per[0][0], avg_amp)}

    # the convention case C1: alpha (n - 1) / 2 not whole (n = 300, alpha 0.1: 14.95)
    tr = synthetic(300, 2.0, 30, 7, 0.002)
    freq, amp, df, _ = dft_amp(tr, 2.0, 0.1)
    f2, a2, _, _ = dft_amp(tr, 2.0, 0.1, on_sample=True)
    c1 = {'trace': tr, 'dtMs': 2.0, 'taper': 0.1, 'harrisStats': stats(freq, amp), 'onSampleStats': stats(f2, a2), 'df': df}
    assert c1['onSampleStats']['band6'] != c1['harrisStats']['band6']

    # signal to noise
    snr_cases = []
    for target, seed, dip, lag, nulls in ((1, 11, 0, 3, False), (4, 12, 1, 3, False), (16, 13, 0, 2, True), (4, 21, 1, 0, False)):
        traces, realised = snr_traces(target, seed, 800, 8, dip)
        if nulls:
            for i in range(100, 130):
                traces[3][i] = None
        r = snr(traces, lag)
        if lag >= dip:
            assert abs(r['snr'] - realised) / realised < 0.3, (target, r['snr'], realised)
        else:
            assert r['snr'] < 1  # negative control: no lag search, the dip decorrelates
        snr_cases.append({'traces': traces, 'maxLag': lag, 'designed': target, 'realised': realised, 'out': r})

    # footprint
    fp_cases = []
    for kind, seed, n_il in (('add4', 5, 40), ('gain4', 6, 24), ('none', 7, 24), ('both', 8, 48)):
        sl = make_slice(kind, seed, n_il)
        f = footprint(sl)
        if kind in ('add4', 'gain4', 'both'):
            assert f['alongCrossline']['period'] == 4 and f['alongCrossline']['share'] > 0.5
        if kind == 'both':
            assert f['alongInline']['period'] == 6 or abs(f['alongInline']['period'] - 6) < 0.1
        if kind == 'none':
            for ax in f.values():
                assert ax['share'] < 0.3 or ax['prominence'] < 10
        fp_cases.append({'kind': kind, 'slice': sl, 'out': f})

    for nm, lst in (('spectra', spectra), ('snr', snr_cases), ('footprint', fp_cases), ('patch', patch)):
        if not lst:
            print('REFUSED: empty case list', nm)
            sys.exit(1)
    golden = {'spectra': spectra, 'average': avg, 'taperConvention': c1, 'snr': snr_cases, 'footprint': fp_cases}
    with open(dest, 'w') as fh:
        json.dump(golden, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors ok;', len(spectra), 'spectra, 1 patch,', len(snr_cases), 'snr,', len(fp_cases),
          'footprint; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
