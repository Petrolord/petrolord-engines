#!/usr/bin/env python3
"""Independent oracle for engines/hse/safetyStats.js (HSE H1).

Run with a python that has scipy and mpmath (neither is in the stdlib):

    python3 -m venv /root/hseenv && /root/hseenv/bin/pip install scipy mpmath
    /root/hseenv/bin/python tools/validation/hse/oracle_safetystats.py

It writes test-data/hse/goldens/safetyStats_cases.json. Nothing here reads
or imports the JavaScript. Each value below is reached by a different road
from the engine's:

  route             oracle road                           engine road
  ---------------   -----------------------------------   ------------------
  single rates      exact rational arithmetic             float arithmetic
                    (fractions.Fraction), then float
  pooled/rolling    Fraction sums over the window, per    running JS sums
                    the IOGP five-year rule (published:
                    "summing the total number of
                    incidents ... dividing by the sum of
                    the work hours")
  log gamma, P, Q   mpmath at 50 digits (loggamma,        Lanczos g=7, NR
                    gammainc regularized); scipy          series and Lentz
                    gammaln/gammainc/gammaincc must       continued fraction
                    agree to 1e-12 or the oracle stops
  chi2 quantile     mpmath bisection on the regularized   Wilson-Hilferty
                    gamma at 50 digits; scipy chi2.ppf    start, safeguarded
                    and chi2.isf must agree to 1e-11      Halley on the
                                                          smaller tail
  Garwood CI        scipy chi2.ppf(alpha/2, 2N)/2 and     Gamma quantiles via
                    chi2.ppf(1-alpha/2, 2N+2)/2 in the    the inversion above
                    LITERAL chi-square form, checked
                    against the mpmath quantile
  compareRates      tails by exact mpmath summation of    log-space pmf sums
                    binomial terms (50 digits) and        from Lanczos log
                    scipy binom.cdf/sf; the ratio CI      gamma; CP limits by
                    from scipy binomtest(...).            bisection on those
                    proportion_ci(method='exact')         sums
                    (Clopper-Pearson via beta.ppf)
  u-chart           Fraction centre line, float limits    float throughout
                    from the Montgomery formulas

WHAT IT CANNOT CHECK: which conventions to use. Central versus minlike
two-sided p-values, strict versus inclusive limit crossing, and a zero
count giving a lower limit of 0 are choices, written in FINDINGS and
applied the same way here. The oracle checks the arithmetic of those
choices, not the choices.

Published values are carried as `published` with their printed precision
and source; the test checks the engine rounds to them. Everything else is
`"source": "oracle"`.
"""
import json
import math
import os
from fractions import Fraction as F

import mpmath as mp
from scipy import special, stats

mp.mp.dps = 50
HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, '..', '..', '..', 'test-data', 'hse', 'goldens', 'safetyStats_cases.json')

OSHA = 200000
IOGP = 1000000
FARB = 100000000

LABELS = {
    OSHA: 'per 200,000 hours (OSHA/BLS: 100 full-time workers, 40 h x 50 weeks)',
    IOGP: 'per 1,000,000 hours (IOGP)',
    FARB: 'per 100,000,000 hours (FAR, IOGP)',
}

TOL_EXACT = 1e-12      # rational arithmetic, float rounding only
TOL_SPECIAL = 1e-10    # the brief's gate for the special functions


def close(a, b, rel):
    return abs(a - b) <= rel * max(abs(b), 1e-300)


class Cases:
    def __init__(self):
        self.cases = []

    def add(self, cid, fn, args, expected, tol=TOL_EXACT, source='oracle', published=None, note=None):
        assert cid not in {c['id'] for c in self.cases}, cid
        c = {'id': cid, 'fn': fn, 'args': args, 'expected': expected, 'tol': tol, 'source': source}
        if published is not None:
            c['published'] = published
        if note:
            c['note'] = note
        self.cases.append(c)

    def refuse(self, cid, fn, args, field, note=None):
        self.add(cid, fn, args, {'error': True, 'field': field}, note=note)


def fl(x):
    return float(x)


# ---------------------------------------------------------------- rates

def rate(count, hours, base):
    return fl(F(count) * base / F(hours))


def pooled(counts, hours, base):
    c = sum(counts)
    h = sum(F(x) for x in hours)
    per = [fl(F(ci) * base / F(hi)) if hi > 0 else None for ci, hi in zip(counts, hours)]
    rated = [F(ci) * base / F(hi) for ci, hi in zip(counts, hours) if hi > 0]
    return {
        'rate': fl(F(c) * base / h), 'count': c, 'exposureHours': fl(h),
        'periodRates': per, 'meanOfPeriodRates': fl(sum(rated) / len(rated)),
        'periodsWithoutHours': len(per) - len(rated),
    }


def rolling(counts, hours, base, w):
    out = []
    for end in range(w - 1, len(counts)):
        s = end - w + 1
        cs, hs = counts[s:end + 1], hours[s:end + 1]
        c = sum(cs)
        h = sum(F(x) for x in hs)
        rated = [F(ci) * base / F(hi) for ci, hi in zip(cs, hs) if hi > 0]
        out.append({
            'startIndex': s, 'endIndex': end, 'count': c, 'exposureHours': fl(h),
            'rate': fl(F(c) * base / h) if h > 0 else None,
            'meanOfPeriodRates': fl(sum(rated) / len(rated)) if rated else None,
            'periodsWithoutHours': w - len(rated),
        })
    return out


# ----------------------------------------------------- special functions

def mp_chi2_ppf(p, df, upper=False):
    """x with P(chi2_df <= x) = p (or P(chi2_df > x) = p when upper), 50 digits."""
    a = mp.mpf(df) / 2
    p = mp.mpf(p)
    if upper:
        f = lambda x: mp.gammainc(a, x, mp.inf, regularized=True) - p
    else:
        f = lambda x: mp.gammainc(a, 0, x, regularized=True) - p
    # bracket, then bisect the monotone function to 1e-40 relative
    lo, hi = mp.mpf(0), mp.mpf(max(1, df))
    sgn = -1 if upper else 1
    while sgn * f(hi) < 0:
        lo, hi = hi, hi * 2
    for _ in range(200):
        mid = (lo + hi) / 2
        if sgn * f(mid) < 0:
            lo = mid
        else:
            hi = mid
        if hi - lo < mp.mpf(10) ** -40 * hi:
            break
    return 2 * (lo + hi) / 2


def chi2_q(p, df):
    m = fl(mp_chi2_ppf(p, df))
    s = stats.chi2.ppf(p, df)
    assert close(s, m, 1e-11), ('scipy chi2.ppf disagrees with mpmath', p, df, s, m)
    return m


def chi2_q_upper(q, df):
    m = fl(mp_chi2_ppf(q, df, upper=True))
    s = stats.chi2.isf(q, df)
    assert close(s, m, 1e-11), ('scipy chi2.isf disagrees with mpmath', q, df, s, m)
    return m


def garwood(n, hours, base, conf):
    alpha = 1 - conf
    # the literal chi-square form of Garwood (1936)
    lo_c = 0.0 if n == 0 else stats.chi2.ppf(alpha / 2, 2 * n) / 2
    hi_c = stats.chi2.ppf(1 - alpha / 2, 2 * n + 2) / 2
    # arbiter: the 50-digit quantile. The upper limit is taken on the upper
    # tail at alpha/2 (1 - alpha/2 in floating point is not exactly that).
    lo_m = 0.0 if n == 0 else fl(mp_chi2_ppf(alpha / 2, 2 * n)) / 2
    hi_m = fl(mp_chi2_ppf(alpha / 2, 2 * n + 2, upper=True)) / 2
    assert lo_c == 0 or close(lo_c, lo_m, 1e-11), (n, lo_c, lo_m)
    assert close(hi_c, hi_m, 1e-11), (n, hi_c, hi_m)
    scale = F(base) / F(hours)
    return {
        'rate': fl(F(n) * scale), 'lower': fl(mp.mpf(lo_m) * mp.mpf(scale.numerator) / scale.denominator),
        'upper': fl(mp.mpf(hi_m) * mp.mpf(scale.numerator) / scale.denominator),
        'countLower': lo_m, 'countUpper': hi_m, 'count': n,
    }


# ------------------------------------------------------- rate comparison

def compare(c1, h1, c2, h2, conf):
    n = c1 + c2
    alpha = 1 - conf
    p0 = F(h1) / (F(h1) + F(h2))
    # exact tails by 50-digit summation
    p0m = mp.mpf(p0.numerator) / p0.denominator
    term = lambda j: mp.binomial(n, j) * p0m ** j * (1 - p0m) ** (n - j)
    lower = fl(mp.fsum(term(j) for j in range(0, c1 + 1)))
    upper = fl(mp.fsum(term(j) for j in range(c1, n + 1)))
    # scipy agrees
    assert close(stats.binom.cdf(c1, n, fl(p0)), lower, 1e-9), ('cdf', c1, n)
    assert close(stats.binom.sf(c1 - 1, n, fl(p0)), upper, 1e-9), ('sf', c1, n)
    pval = min(1.0, 2 * min(lower, upper))
    ci = stats.binomtest(c1, n, fl(p0)).proportion_ci(confidence_level=conf, method='exact')
    plo, phi = ci.low, ci.high
    hr = F(h2) / F(h1)
    to_ratio = lambda p: p / (1 - p) * fl(hr)
    out = {
        'rateRatio': None if c2 == 0 else fl((F(c1) / F(h1)) / (F(c2) / F(h2))),
        'rateRatioLower': 0.0 if c1 == 0 else to_ratio(plo),
        'rateRatioUpper': None if c1 == n else to_ratio(phi),
        'upperUnbounded': c1 == n,
        'pValue': pval,
        'lowerTail': lower,
        'upperTail': upper,
        'expectedProportion': fl(p0),
    }
    # the property the central convention buys: p < alpha iff the ratio CI
    # excludes 1 (checked here on the oracle's own numbers)
    lo_r, hi_r = out['rateRatioLower'], out['rateRatioUpper']
    excludes = lo_r > 1 or (hi_r is not None and hi_r < 1)
    assert (pval < alpha) == excludes, ('central test and CP interval disagree', c1, h1, c2, h2)
    return out


# ------------------------------------------------------------- u-chart

def uchart(counts, hours, base):
    units = [F(h) / base for h in hours]
    ubar = F(sum(counts)) / sum(units)
    pts = []
    for i, (c, n) in enumerate(zip(counts, units)):
        u = F(c) / n
        half = 3 * math.sqrt(fl(ubar / n))
        raw = fl(ubar) - half
        lcl = max(0.0, raw)
        ucl = fl(ubar) + half
        sig = 'above' if fl(u) > ucl else ('below' if fl(u) < lcl else None)
        pts.append({'index': i, 'count': c, 'exposureHours': hours[i], 'exposureUnits': fl(n),
                    'u': fl(u), 'lcl': lcl, 'ucl': ucl, 'lclFloored': raw < 0, 'signal': sig})
    return {'centre': fl(ubar), 'points': pts,
            'outOfControl': [p['index'] for p in pts if p['signal']]}


# ------------------------------------------------------------- cases

def build():
    c = Cases()

    # ---- BLS worked example (published) ----
    bls = 'BLS, How to compute a firm\'s incidence rate (bls.gov/iif/overview/compute-nonfatal-incidence-rates.htm)'
    c.add('bls-trir-abc-company', 'incidenceRate', {'count': 7, 'exposureHours': 400000, 'base': OSHA},
          {'rate': rate(7, 400000, OSHA), 'basis.base': OSHA, 'basis.baseLabel': LABELS[OSHA]},
          source='published', published={'field': 'rate', 'value': 3.5, 'decimals': 1, 'ref': bls + ': (7 x 200,000) / 400,000 = 3.5'})
    c.add('bls-dart-abc-company', 'incidenceRate', {'count': 3, 'exposureHours': 400000, 'base': OSHA},
          {'rate': rate(3, 400000, OSHA)},
          source='published', published={'field': 'rate', 'value': 1.5, 'decimals': 1, 'ref': bls + ': DART (3 x 200,000) / 400,000 = 1.5'})

    # ---- IOGP 2024 data (published) ----
    iogp = 'IOGP Safety performance indicators, 2024 data (report 2024s)'
    hrs = {2020: 2544201000, 2021: 2679026000, 2022: 2579000000, 2023: 3291382000, 2024: 4158877000}
    fat = {2020: 14, 2021: 20, 2022: 33, 2023: 27, 2024: 32}
    c.add('iogp-far-2024', 'fatalAccidentRate', {'fatalities': 32, 'exposureHours': hrs[2024]},
          {'rate': rate(32, hrs[2024], FARB), 'basis.base': FARB},
          source='published', published={'field': 'rate', 'value': 0.77, 'decimals': 2,
                                         'ref': iogp + ' section 1.2 (32 fatalities, FAR 0.77) and Table 38A (4,158,877 thousand work hours)'})
    c.add('iogp-far-2023', 'fatalAccidentRate', {'fatalities': 27, 'exposureHours': hrs[2023]},
          {'rate': rate(27, hrs[2023], FARB)},
          source='published', published={'field': 'rate', 'value': 0.82, 'decimals': 2,
                                         'ref': iogp + ' section 1.2 (27 fatalities in 2023, FAR 0.82) and Table 38A (3,291,382 thousand)'})
    c.add('iogp-far-2024-as-incidence-rate', 'incidenceRate', {'count': 32, 'exposureHours': hrs[2024], 'base': FARB},
          {'rate': rate(32, hrs[2024], FARB), 'basis.baseLabel': LABELS[FARB]},
          source='published', published={'field': 'rate', 'value': 0.77, 'decimals': 2, 'ref': iogp + ' section 1.2'})
    c.add('iogp-fir-2024', 'incidenceRate', {'count': 21, 'exposureHours': hrs[2024], 'base': FARB},
          {'rate': rate(21, hrs[2024], FARB)},
          note='IOGP FIR (fatal incidents per 100 million hours): 21 incidents in 2024 (section 1.2). The report prints no overall FIR figure in its text, so the value is oracle-derived.')
    c.add('iogp-trir-2024', 'incidenceRate', {'count': 3071, 'exposureHours': 3795000000, 'base': IOGP},
          {'rate': rate(3071, 3795000000, IOGP), 'basis.baseLabel': LABELS[IOGP]},
          source='published', published={'field': 'rate', 'value': 0.81, 'decimals': 2,
                                         'ref': iogp + ' section 2.5 (3,071 recordables over 3,795 million hours with MTC reported) and 1.3 (TRIR 0.81); the hours are printed to the nearest million'})
    years = [2020, 2021, 2022, 2023, 2024]
    pr = pooled([fat[y] for y in years], [hrs[y] for y in years], FARB)
    c.add('iogp-far-five-year-2020-2024', 'pooledRate',
          {'counts': [fat[y] for y in years], 'exposureHours': [hrs[y] for y in years], 'base': FARB}, pr,
          note='IOGP five-year rolling average rule (published in the 2024 report, section 3.5 box): sum of fatalities 2020-2024 over sum of work hours / 100,000,000. Inputs published (Table 5 OVERALL, Table 38A OVERALL); the pooled value itself is oracle-derived because the report shows it only on a chart. It differs from the mean of the five annual FARs, which is the point.')
    c.add('iogp-far-five-year-rolling-window', 'rollingRate',
          {'counts': [fat[y] for y in years], 'exposureHours': [hrs[y] for y in years], 'base': FARB, 'windowPeriods': 5},
          {'windows': rolling([fat[y] for y in years], [hrs[y] for y in years], FARB, 5)})

    # ---- rates, oracle ----
    c.add('rate-zero-count', 'incidenceRate', {'count': 0, 'exposureHours': 123456, 'base': OSHA}, {'rate': 0.0})
    c.add('rate-very-small-exposure', 'incidenceRate', {'count': 1, 'exposureHours': 40, 'base': OSHA},
          {'rate': rate(1, 40, OSHA)}, note='one week of one worker: a rate of 5000 per 200,000 hours, arithmetically right and meaningless without its interval')
    c.add('rate-iogp-ltif', 'incidenceRate', {'count': 4, 'exposureHours': 2750000, 'base': IOGP}, {'rate': rate(4, 2750000, IOGP)})
    c.add('rate-custom-base', 'incidenceRate', {'count': 5, 'exposureHours': 90000, 'base': 100000},
          {'rate': rate(5, 90000, 100000), 'basis.baseLabel': 'per 100000 hours'})
    c.add('far-zero', 'fatalAccidentRate', {'fatalities': 0, 'exposureHours': 5e6}, {'rate': 0.0})
    c.add('severity-osha-base', 'severityRate', {'daysLost': 312, 'exposureHours': 400000, 'base': OSHA},
          {'rate': rate(312, 400000, OSHA)})
    c.add('severity-million-base', 'severityRate', {'daysLost': 45.5, 'exposureHours': 1830000, 'base': IOGP},
          {'rate': fl(F('45.5') * IOGP / 1830000)})
    c.add('pse-tier1-200k', 'pseRate', {'tier': 1, 'pseCount': 2, 'exposureHours': 1650000, 'base': OSHA},
          {'rate': rate(2, 1650000, OSHA), 'tier': 1},
          note='API Guide to Reporting Process Safety Events (2022) section 3.3 formula; values oracle-derived (the guide prints no worked example)')
    c.add('pse-tier2-1m', 'pseRate', {'tier': 2, 'pseCount': 9, 'exposureHours': 1650000, 'base': IOGP},
          {'rate': rate(9, 1650000, IOGP), 'tier': 2})

    # ---- refusals (validation is part of the contract) ----
    c.refuse('refuse-zero-hours', 'incidenceRate', {'count': 1, 'exposureHours': 0, 'base': OSHA}, 'exposureHours')
    c.refuse('refuse-negative-hours', 'incidenceRate', {'count': 1, 'exposureHours': -5, 'base': OSHA}, 'exposureHours')
    c.refuse('refuse-missing-base', 'incidenceRate', {'count': 1, 'exposureHours': 1000}, 'base')
    c.refuse('refuse-fractional-count', 'incidenceRate', {'count': 1.5, 'exposureHours': 1000, 'base': OSHA}, 'count')
    c.refuse('refuse-negative-count', 'incidenceRate', {'count': -1, 'exposureHours': 1000, 'base': OSHA}, 'count')
    c.refuse('refuse-far-zero-hours', 'fatalAccidentRate', {'fatalities': 1, 'exposureHours': 0}, 'exposureHours')
    c.refuse('refuse-severity-negative-days', 'severityRate', {'daysLost': -1, 'exposureHours': 1000, 'base': OSHA}, 'daysLost')
    c.refuse('refuse-severity-missing-base', 'severityRate', {'daysLost': 3, 'exposureHours': 1000}, 'base')
    c.refuse('refuse-pse-tier-3', 'pseRate', {'tier': 3, 'pseCount': 1, 'exposureHours': 1000, 'base': OSHA}, 'tier')
    c.refuse('refuse-pse-tier-missing', 'pseRate', {'pseCount': 1, 'exposureHours': 1000, 'base': OSHA}, 'tier')
    c.refuse('refuse-pse-base-100m', 'pseRate', {'tier': 1, 'pseCount': 1, 'exposureHours': 1000, 'base': FARB}, 'base')
    c.refuse('refuse-ci-confidence-95', 'rateConfidenceInterval', {'count': 1, 'exposureHours': 1000, 'base': OSHA, 'confidence': 95}, 'confidence')
    c.refuse('refuse-ci-zero-hours', 'rateConfidenceInterval', {'count': 0, 'exposureHours': 0, 'base': OSHA, 'confidence': 0.95}, 'exposureHours')
    c.refuse('refuse-compare-no-events', 'compareRates', {'count1': 0, 'exposureHours1': 1000, 'count2': 0, 'exposureHours2': 1000, 'confidence': 0.95}, 'count1')
    c.refuse('refuse-compare-zero-hours', 'compareRates', {'count1': 1, 'exposureHours1': 1000, 'count2': 2, 'exposureHours2': 0, 'confidence': 0.95}, 'exposureHours2')
    c.refuse('refuse-pooled-length-mismatch', 'pooledRate', {'counts': [1, 2], 'exposureHours': [1000], 'base': OSHA}, 'exposureHours')
    c.refuse('refuse-pooled-events-without-hours', 'pooledRate', {'counts': [1, 2], 'exposureHours': [1000, 0], 'base': OSHA}, 'exposureHours[1]')
    c.refuse('refuse-pooled-all-zero-hours', 'pooledRate', {'counts': [0, 0], 'exposureHours': [0, 0], 'base': OSHA}, 'exposureHours')
    c.refuse('refuse-rolling-no-window', 'rollingRate', {'counts': [1, 2], 'exposureHours': [1000, 1000], 'base': OSHA}, 'windowPeriods')
    c.refuse('refuse-rolling-window-too-long', 'rollingRate', {'counts': [1, 2], 'exposureHours': [1000, 1000], 'base': OSHA, 'windowPeriods': 12}, 'windowPeriods')
    c.refuse('refuse-uchart-zero-hours-point', 'uChart', {'counts': [1, 0, 2], 'exposureHours': [1000, 0, 1000], 'base': OSHA}, 'exposureHours[1]')
    c.refuse('refuse-uchart-no-events', 'uChart', {'counts': [0, 0], 'exposureHours': [1000, 1000], 'base': OSHA}, 'counts')

    # ---- rolling 12-month, with a month of no hours ----
    counts = [0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 3, 0, 1]
    hours = [21000, 20500, 400, 22000, 23000, 0, 19000, 21500, 22500, 20000, 18000, 24000, 22000, 1200]
    c.add('rolling-12-month-zero-hour-month', 'rollingRate',
          {'counts': counts, 'exposureHours': hours, 'base': OSHA, 'windowPeriods': 12},
          {'windows': rolling(counts, hours, OSHA, 12)},
          note='month 5 has no hours (a shutdown): it adds nothing to the pooled rate and has no rate of its own. Month 2 (400 hours, 0 events) and month 13 (1,200 hours, 1 event) show how a thin month drags the mean of monthly rates while barely moving the pooled rate.')
    c.add('pooled-12-months', 'pooledRate', {'counts': counts[:12], 'exposureHours': hours[:12], 'base': OSHA},
          pooled(counts[:12], hours[:12], OSHA))
    all_zero_window_counts = [0, 0, 0, 1]
    all_zero_window_hours = [0, 0, 0, 5000]
    c.add('rolling-window-without-hours', 'rollingRate',
          {'counts': all_zero_window_counts, 'exposureHours': all_zero_window_hours, 'base': OSHA, 'windowPeriods': 2},
          {'windows': rolling(all_zero_window_counts, all_zero_window_hours, OSHA, 2)},
          note='the first two windows have no hours at all: rate and mean are null, never 0')

    # ---- special functions ----
    for a in [0.5, 1, 1.5, 2, 3.7, 10, 50.5, 100, 1000, 100000]:
        m = fl(mp.loggamma(mp.mpf(a)))
        assert close(special.gammaln(a), m, 1e-13) or abs(m) < 1e-15
        c.add(f'loggamma-{a}', 'logGamma', [a], m, tol=TOL_SPECIAL if abs(m) > 1e-3 else 1e-14,
              note='absolute tolerance where ln Gamma is 0' if abs(m) < 1e-15 else None)
    for a, x in [(0.5, 0.01), (0.5, 3), (1, 1), (2.5, 0.7), (5, 4), (5, 6), (5, 20), (10, 9.5), (10, 11.5),
                 (32, 20), (33, 50), (100, 90), (100, 125), (500.5, 480), (1000, 1100)]:
        pm = fl(mp.gammainc(mp.mpf(a), 0, mp.mpf(x), regularized=True))
        qm = fl(mp.gammainc(mp.mpf(a), mp.mpf(x), mp.inf, regularized=True))
        assert close(special.gammainc(a, x), pm, 1e-12), (a, x)
        assert close(special.gammaincc(a, x), qm, 1e-12), (a, x)
        c.add(f'gammaP-{a}-{x}', 'regularizedGammaP', [a, x], pm, tol=TOL_SPECIAL)
        c.add(f'gammaQ-{a}-{x}', 'regularizedGammaQ', [a, x], qm, tol=TOL_SPECIAL)
    for df in [1, 2, 3, 4, 5, 10, 14, 20, 21, 40, 64, 66, 100, 200, 1000, 2001]:
        for p in [1e-10, 1e-4, 0.005, 0.025, 0.05, 0.5, 0.95, 0.975, 0.995]:
            c.add(f'chi2-ppf-{df}-{p}', 'chiSquareQuantile', [p, df], chi2_q(p, df), tol=TOL_SPECIAL)
        for q in [1e-12, 0.005, 0.025, 0.05]:
            c.add(f'chi2-isf-{df}-{q}', 'chiSquareQuantileUpper', [q, df], chi2_q_upper(q, df), tol=TOL_SPECIAL)

    # ---- Garwood exact Poisson intervals ----
    for n in [0, 1, 2, 3, 5, 10, 32, 100, 1000]:
        g = garwood(n, 1, 1, 0.95)
        c.add(f'garwood-95-count-{n}', 'rateConfidenceInterval',
              {'count': n, 'exposureHours': 1, 'base': 1, 'confidence': 0.95},
              {k: g[k] for k in ('rate', 'lower', 'upper', 'countLower', 'countUpper')}, tol=TOL_SPECIAL)
    for n, conf in [(0, 0.90), (1, 0.90), (4, 0.99), (0, 0.99), (12, 0.80)]:
        g = garwood(n, 1, 1, conf)
        c.add(f'garwood-{conf}-count-{n}', 'rateConfidenceInterval',
              {'count': n, 'exposureHours': 1, 'base': 1, 'confidence': conf},
              {k: g[k] for k in ('lower', 'upper', 'countLower', 'countUpper')}, tol=TOL_SPECIAL)
    g = garwood(7, 400000, OSHA, 0.95)
    c.add('garwood-bls-abc-company', 'rateConfidenceInterval',
          {'count': 7, 'exposureHours': 400000, 'base': OSHA, 'confidence': 0.95},
          {k: g[k] for k in ('rate', 'lower', 'upper')}, tol=TOL_SPECIAL,
          note='the BLS example rate 3.5 with its 95 percent exact interval (interval oracle-derived)')
    g = garwood(32, hrs[2024], FARB, 0.95)
    c.add('garwood-iogp-far-2024', 'rateConfidenceInterval',
          {'count': 32, 'exposureHours': hrs[2024], 'base': FARB, 'confidence': 0.95},
          {k: g[k] for k in ('rate', 'lower', 'upper')}, tol=TOL_SPECIAL)
    g = garwood(0, 2000, OSHA, 0.95)
    c.add('garwood-zero-events-small-exposure', 'rateConfidenceInterval',
          {'count': 0, 'exposureHours': 2000, 'base': OSHA, 'confidence': 0.95},
          {k: g[k] for k in ('rate', 'lower', 'upper')}, tol=TOL_SPECIAL,
          note='a clean year for one worker: rate 0, upper limit 368.9 per 200,000 hours')
    g = garwood(1, 40, OSHA, 0.95)
    c.add('garwood-one-event-tiny-exposure', 'rateConfidenceInterval',
          {'count': 1, 'exposureHours': 40, 'base': OSHA, 'confidence': 0.95},
          {k: g[k] for k in ('rate', 'lower', 'upper')}, tol=TOL_SPECIAL)

    # ---- rate comparison ----
    tol_cmp = TOL_SPECIAL
    for cid, (c1, h1, c2, h2, conf) in {
        'compare-large-exposure': (26, 3200000000, 6, 958877000, 0.95),
        'compare-small-counts': (10, 100000, 3, 120000, 0.95),
        'compare-equal-rates': (5, 250000, 10, 500000, 0.95),
        'compare-first-zero': (0, 180000, 6, 210000, 0.95),
        'compare-second-zero': (4, 90000, 0, 150000, 0.95),
        'compare-one-event-each': (1, 50000, 1, 50000, 0.90),
        'compare-large-counts': (3071, 3795000000, 2764, 3291382000, 0.95),
        'compare-borderline-99': (18, 400000, 7, 420000, 0.99),
    }.items():
        c.add(cid, 'compareRates',
              {'count1': c1, 'exposureHours1': h1, 'count2': c2, 'exposureHours2': h2, 'confidence': conf},
              compare(c1, h1, c2, h2, conf), tol=tol_cmp)

    # ---- u-charts ----
    counts = [2, 1, 3, 0, 2, 9, 1, 2, 0, 1, 2, 1]
    hours = [48000, 52000, 61000, 30000, 55000, 50000, 47000, 20000, 15000, 58000, 60000, 49000]
    c.add('uchart-one-high-month', 'uChart', {'counts': counts, 'exposureHours': hours, 'base': OSHA},
          uchart(counts, hours, OSHA),
          note='12 months, varying hours; month 5 (9 events in 50,000 hours) is above its limit; every lower limit is floored at 0')
    counts = [48, 52, 61, 0, 55, 47, 50]
    hours = [5000000, 5200000, 6100000, 4800000, 5500000, 4700000, 5000000]
    c.add('uchart-positive-lcl-with-a-low-point', 'uChart', {'counts': counts, 'exposureHours': hours, 'base': OSHA},
          uchart(counts, hours, OSHA),
          note='large exposure gives positive lower limits; a month with 0 events in 4.8 million hours falls below its lower limit (a signal worth investigating as under-reporting)')
    counts = [3, 0, 1]
    hours = [2000, 2000, 400000]
    c.add('uchart-small-exposure-wide-limits', 'uChart', {'counts': counts, 'exposureHours': hours, 'base': OSHA},
          uchart(counts, hours, OSHA),
          note='two thin periods: limits scale with 1/sqrt(n_i)')
    counts = [18, 0]
    hours = [1800000, 1800000]
    c.add('uchart-points-on-the-limits', 'uChart', {'counts': counts, 'exposureHours': hours, 'base': OSHA},
          uchart(counts, hours, OSHA),
          note='ubar = 1 and n = 9 per point, so the limits are exactly 0 and 2 and the points sit exactly on them: under the strict rule (Montgomery: a point OUTSIDE the limits) neither signals')
    return c


def main():
    c = build()
    out = {
        'module': 'safetyStats',
        'generatedBy': 'tools/validation/hse/oracle_safetystats.py',
        'description': 'Incidence, FAR, severity and API 754 PSE rates; pooled and rolling rates; Garwood exact Poisson intervals; conditional exact rate comparison; u-chart. Published values carry their source; everything else is oracle-derived with scipy and mpmath.',
        'cases': c.cases,
    }
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with open(DEST, 'w') as fh:
        json.dump(out, fh, indent=1)
        fh.write('\n')
    pub = sum(1 for x in c.cases if x['source'] == 'published')
    print('wrote', os.path.relpath(DEST), len(c.cases), 'cases,', pub, 'published')


if __name__ == '__main__':
    main()
