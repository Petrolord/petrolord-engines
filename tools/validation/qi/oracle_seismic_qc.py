"""Analytic oracle for engines/qi/seismicQc.js (QI programme Q4a, A5).

The Ricker wavelet's amplitude spectrum is A(f) = (2 / sqrt(pi)) f^2 / fp^3
exp(-f^2 / fp^2) (e.g. Ryan 1994; Wang 2015, Geophysics 80(2), A31): it
peaks at f = fp exactly, and with x = f / fp the relative amplitude is
x^2 exp(1 - x^2). The band edges at -6 dB and -20 dB are the roots of
x^2 exp(1 - x^2) = 10^(-dB/20) either side of x = 1, found by bisection.
The centroid of the power spectrum A(f)^2 is analytic too:
  integral f A^2 df / integral A^2 df = fp * Gamma(3) / Gamma(5/2) / sqrt(2)
                                       = fp * 2 / (0.75 sqrt(pi)) / sqrt(2).
Standard library only; main() asserts the anchors and writes
test-data/qi/goldens.seismicQc.json.
"""
import json
import math
import os


def rel(x):
    return x * x * math.exp(1 - x * x)


def edge(level, side):
    lo, hi = (1e-9, 1.0) if side < 0 else (1.0, 10.0)
    for _ in range(200):
        mid = (lo + hi) / 2
        above = rel(mid) > level
        if side < 0:
            lo, hi = (lo, mid) if above else (mid, hi)
        else:
            lo, hi = (mid, hi) if above else (lo, mid)
    return (lo + hi) / 2


def main():
    l6, l20 = 10 ** (-6 / 20), 10 ** (-20 / 20)
    x6 = (edge(l6, -1), edge(l6, 1))
    x20 = (edge(l20, -1), edge(l20, 1))
    # anchors: the edges sit on the level; the peak is at x = 1 and is the maximum
    for x, lv in ((x6[0], l6), (x6[1], l6), (x20[0], l20), (x20[1], l20)):
        assert abs(rel(x) - lv) < 1e-12
    assert rel(1.0) == 1.0 and rel(0.999) < 1 and rel(1.001) < 1
    centroid = 2 / (0.75 * math.sqrt(math.pi)) / math.sqrt(2)
    # check the centroid by numerical integration
    num = den = 0.0
    for i in range(1, 200001):
        x = i * 5e-5
        p = (x * x * math.exp(-x * x)) ** 2
        num += x * p
        den += p
    assert abs(num / den - centroid) < 1e-6
    g = {'ricker': [dict(fp=fp, peakHz=fp, band6=[fp * x6[0], fp * x6[1]], band20=[fp * x20[0], fp * x20[1]], centroidHz=fp * centroid) for fp in (15, 25, 30, 45)]}
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', '..', '..', 'test-data', 'qi', 'goldens.seismicQc.json')
    with open(dest, 'w') as fh:
        json.dump(g, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors ok; x6', x6, 'x20', x20, 'centroid/fp', centroid, '; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
