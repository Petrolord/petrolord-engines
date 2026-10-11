"""Independent oracle for engines/qi/wavelets.js (NextGen QI extraction gate, E1b, gap G4).

The engine's contract (White and Simm 2003 practice for a field wavelet):
linear resampling about the centre sample; unit-energy normalisation;
alignment of b to a by the lag in |lag| <= maxLag that maximises the
cross-correlation normalised by the two FULL energies (zero outside, the
first maximum wins, so the most negative lag on an exact tie); then align
every wavelet to the first, normalise, average, normalise the average, and
report zero-lag similarities and each wavelet's correlation to the average.

The routes here are different from the engine's:
- Resampling in EXACT RATIONALS (fractions.Fraction): the sample positions
  c + k dtOut / dtIn and the interpolation weights are exact; only the final
  value is rounded once to float.
- Cross-correlation by the discrete Fourier transform: both wavelets zero
  padded to N >= 2n, r = IDFT(DFT(a) conj(DFT(b))), the lags read from the
  circular result (negative lags at N + lag). The engine sums in the time
  domain.
- Every golden case asserts the best lag beats the runner-up by more than
  1e-9, so no golden lag rests on a floating-point tie.

Anchors: on-grid decimation is exact; a piecewise-linear signal is resampled
exactly; the DFT correlation equals a direct sum on a small case; a known
integer shift is recovered with correlation 1; identical wavelets average to
themselves. Standard library only; main() refuses an empty case list and
writes test-data/qi/goldens.qiWavelets.json (byte-identical on rerun).
"""
import cmath
import json
import math
import os
import sys
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))


def nonempty(name, xs):
    if not xs:
        sys.exit('REFUSED: empty case list ' + name)
    return xs


def resample(w, dt_in, dt_out):
    n = len(w)
    c = Fraction(n - 1, 2)
    r = Fraction(repr(dt_out)) / Fraction(repr(dt_in))  # the decimal intervals as typed
    half = math.floor(c / r)
    out = []
    for k in range(-half, half + 1):
        x = c + k * r
        i = math.floor(x)
        f = x - i
        a = Fraction(w[i])
        if f == 0:
            out.append(float(a))
        else:
            b = Fraction(w[i + 1])
            out.append(float(a * (1 - f) + b * f))
    return out


def energy(w):
    return math.sqrt(math.fsum(v * v for v in w))


def normalise(w):
    e = energy(w)
    return [v / e if e > 0 else 0.0 for v in w]


def dft(x, inverse=False):
    N = len(x)
    sgn = 1 if inverse else -1
    out = []
    for k in range(N):
        s = 0j
        for j in range(N):
            s += x[j] * cmath.exp(sgn * 2j * math.pi * j * k / N)
        out.append(s / N if inverse else s)
    return out


def xcorr_dft(a, b):
    """r[lag] = sum_i a[i] b[i - lag] for |lag| < len, by the DFT."""
    n = max(len(a), len(b))
    N = 1
    while N < 2 * n:
        N *= 2
    A = dft(list(a) + [0.0] * (N - len(a)))
    B = dft(list(b) + [0.0] * (N - len(b)))
    r = dft([x * y.conjugate() for x, y in zip(A, B)], inverse=True)
    # IDFT(A conj B)[l] = sum_j a[j + l] b[j] = sum_i a[i] b[i - l]
    return lambda lag: r[lag % N].real


def align(a, b, max_lag):
    r = xcorr_dft(a, b)
    d = energy(a) * energy(b)
    scored = [(lag, r(lag) / d if d > 0 else 0.0) for lag in range(-max_lag, max_lag + 1)]
    best = max(c for _, c in scored)
    # the first lag (most negative) attaining the maximum; refuse a near tie
    lag = next(l for l, c in scored if c == best)
    others = [c for l, c in scored if l != lag]
    gap = best - max(others) if others else 1.0
    assert gap > 1e-9, ('near tie in alignment', gap)
    aligned = [b[i - lag] if 0 <= i - lag < len(b) else 0.0 for i in range(len(a))]
    return aligned, lag, best


def compare(wavelets, max_lag=10):
    ref = normalise(wavelets[0]['samples'])
    al = [dict(name=wavelets[0]['name'], samples=ref, lag=0)]
    for w in wavelets[1:]:
        s, lag, _ = align(ref, normalise(w['samples']), max_lag)
        al.append(dict(name=w['name'], samples=normalise(s), lag=lag))
    n = len(ref)
    avg = [math.fsum(a['samples'][i] for a in al) / len(al) for i in range(n)]
    average = normalise(avg)

    def zc(a, b):
        d = energy(a) * energy(b)
        return math.fsum(x * y for x, y in zip(a, b)) / d if d > 0 else 0.0
    return dict(average=average, lags=[a['lag'] for a in al], aligned=[a['samples'] for a in al],
                similarity=[[zc(a['samples'], b['samples']) for b in al] for a in al],
                misfit=[dict(name=a['name'], corrToAverage=zc(a['samples'], average)) for a in al])


def ricker(fp, dt_ms, half, shift=0.0, phase_deg=0.0):
    """A Ricker, optionally rotated in phase by mixing in its quadrature (odd) partner."""
    out = []
    for i in range(2 * half + 1):
        t = (i - half - shift) * dt_ms / 1000
        a = (math.pi * fp * t) ** 2
        r = (1 - 2 * a) * math.exp(-a)
        q = t * (3 - 2 * a) * math.exp(-a) * math.pi * fp
        p = math.radians(phase_deg)
        out.append(math.cos(p) * r - math.sin(p) * q)
    return out


def lcg(seed):
    s = seed
    while True:
        s = (1103515245 * s + 12345) % 2147483648
        yield s / 2147483648 - 0.5


def main():
    noise = lcg(4242)

    # resampling cases
    base2 = ricker(25, 2, 40)
    tri = [float(abs(i - 10)) * 0.5 - 2.0 for i in range(21)]  # piecewise linear
    odd = [0.37 * math.sin(0.7 * i) + 0.1 * next(noise) for i in range(33)]
    rcases = nonempty('resample', [
        dict(name='ricker_2_to_4', w=base2, dtIn=2, dtOut=4),
        dict(name='ricker_2_to_1', w=base2, dtIn=2, dtOut=1),
        dict(name='ricker_2_to_3', w=base2, dtIn=2, dtOut=3),
        dict(name='odd_4_to_2p5', w=odd, dtIn=4, dtOut=2.5),
        dict(name='odd_1_to_0p75', w=odd, dtIn=1, dtOut=0.75),
        dict(name='tri_1_to_0p4', w=tri, dtIn=1, dtOut=0.4),
    ])
    for c in rcases:
        c['out'] = resample(c['w'], c['dtIn'], c['dtOut'])
    # anchor: on-grid decimation keeps every other sample exactly
    assert rcases[0]['out'] == base2[::2]
    # anchor: a piecewise-linear signal with knots on the grid is resampled exactly
    t = rcases[5]
    c0 = 10
    for k, v in enumerate(t['out']):
        x = c0 + (k - (len(t['out']) - 1) // 2) * 0.4
        assert abs(v - (abs(x - 10) * 0.5 - 2.0)) < 1e-12

    # anchor: DFT correlation equals the direct sum
    a, b = [1.0, 2.0, -1.0, 0.5], [0.5, -1.0, 3.0, 0.25]
    r = xcorr_dft(a, b)
    for lag in range(-3, 4):
        direct = sum(a[i] * b[i - lag] for i in range(4) if 0 <= i - lag < 4)
        assert abs(r(lag) - direct) < 1e-12

    # alignment cases
    w0 = ricker(30, 2, 40)
    acases = []
    for name, b, max_lag in [
        ('shift_plus4', ricker(30, 2, 40, 4), 10),
        ('shift_minus3_noisy', [v + 0.03 * next(noise) for v in ricker(30, 2, 40, -3)], 10),
        ('shift_beyond_search', ricker(30, 2, 40, 6), 4),
        ('rotated_45_shift2', ricker(30, 2, 40, 2, 45), 10),
        ('no_search', ricker(30, 2, 40, 4), 0),
    ]:
        al, lag, corr = align(w0, b, max_lag)
        acases.append(dict(name=name, a=w0, b=b, maxLag=max_lag, lag=lag, corr=corr, aligned=al))
    nonempty('align', acases)
    assert acases[0]['lag'] == -4 and abs(acases[0]['corr'] - 1) < 1e-6
    assert acases[4]['lag'] == 0

    # comparison cases
    ccases = []
    sets = [
        ('three_scaled_shifted', [
            dict(name='W1', samples=ricker(28, 2, 40)),
            dict(name='W2', samples=[3 * v for v in ricker(28, 2, 40, 3)]),
            dict(name='W3', samples=[0.5 * v for v in ricker(28, 2, 40, -2)]),
        ], 10),
        ('noisy_four', [dict(name='E%d' % (k + 1), samples=[v + 0.05 * next(noise) for v in ricker(26 + 2 * k, 2, 30, (k - 1) * 1.5)]) for k in range(4)], 10),
        ('one_rotated', [
            dict(name='W1', samples=ricker(28, 2, 40)),
            dict(name='W2', samples=[v + 0.02 * next(noise) for v in ricker(28, 2, 40)]),
            dict(name='W3', samples=ricker(28, 2, 40, 1, 90)),
        ], 10),
        ('narrow_search', [dict(name='A%d' % k, samples=[v * (1 + 0.1 * k) + 0.04 * next(noise) for v in ricker(32, 2, 25, 3.3 * k)]) for k in range(3)], 4),  # the third lies beyond the search
    ]
    for name, ws, max_lag in sets:
        res = compare(ws, max_lag)
        ccases.append(dict(name=name, wavelets=ws, maxLag=max_lag, **res))
    nonempty('compare', ccases)
    # anchor: identical (scaled and shifted) wavelets average to themselves
    s0 = ccases[0]
    assert s0['lags'] == [0, -3, 2]
    for row in s0['similarity']:
        for v in row:
            assert v > 0.999
    # anchor: the rotated well stands out
    m = {x['name']: x['corrToAverage'] for x in ccases[2]['misfit']}
    # anchor: the narrow search stops at its edge (the third wavelet is shifted 6.6 samples)
    assert ccases[3]['lags'][2] == -4, ccases[3]['lags']
    assert m['W3'] < m['W1'] - 0.05

    g = dict(resample=rcases, align=acases, compare=ccases)
    dest = os.path.join(ROOT, 'test-data', 'qi', 'goldens.qiWavelets.json')
    if len(sys.argv) > 1:
        dest = sys.argv[1]
    with open(dest, 'w') as fh:
        json.dump(g, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors ok; resample', len(rcases), 'align', len(acases), 'compare', len(ccases), '; wrote', dest)


if __name__ == '__main__':
    main()
