#!/usr/bin/env python3
"""Independent oracle for engines/hse/qra.js (HSE H5, quantitative risk).

Runs in the venv /root/hseenv (Python 3.12, numpy 2.5.3, scipy 1.18.1).
Never calls the JavaScript. Writes test-data/hse/goldens/qra_cases.json.

Every formula is transcribed from its source, not from the engine:

  PB    TNO Purple Book CPR 18E (1999): 6.1, 6.2 (IR), 6.3 to 6.6 (societal
        risk, FN = sum f with N >= N), 6.7 to 6.13 (toxic Pd = Pcl Pci,
        ECW = PI / Pcl, Pci = nws ECW / (2 pi R), Fd), Appendix 6.B (worked
        IR at a grid point), Figures 5.2 to 5.5 and Table 5.3 (PE, FE,in,
        FE,out, fpop), eq. 5.4 (heat probit), Table 4.5 (direct ignition),
        section 4.8 (flash fire 0.6, explosion 0.4), Figure 6.8 (F < 1e-3
        N^-2, N >= 10), section 6.3 (IR contours 1e-4 to 1e-8).
  R2P2  UK HSE (2001): paras 128 to 136 and Appendix 3 paras 13 to 17.
  CBA   UK HSE Cost Benefit Analysis checklist (2003 values), worked example.
  BEVI  Besluit externe veiligheid inrichtingen art. 13(1)(b).

The pool fire transect reuses the H4 oracle's own transcriptions of Thomas
and of the Raj and Mudan view factors (oracle_consequence.py), which that
oracle validates against the YB worked example and a numerical integral.

SECOND ROUTES, and what each can and cannot see

  event tree     route B: exact rational arithmetic (fractions.Fraction of
                 the decimal inputs), and conservation (the outcome
                 frequencies sum to f0).
  F-N curve      route B: brute force, for every query N the sum over ALL
                 scenarios with N_i >= N (no sorting, no cumulation), at the
                 corners and on a dense grid; and the identity
                 sum f N = integral of F(N) dN from 0 (PLL as the area).
  F-N exceedance route B: the largest F / line on a dense log grid of N,
                 which approaches the corner value from below.
  LSIR           a Monte Carlo sanity check (numpy PCG64, fixed seed), never
                 a golden: sample a scenario in proportion to f, then death
                 with probability Pd; within 4 standard errors.
  toxic PI       route B: the closed form of the probit across the plume,
                 Y(y) = Y0 - b n y^2 / (2 sy^2), integrated by scipy quad to
                 the analytic cutoff half width (the engine uses Simpson on
                 its own plume and probit).
  discounting    route B: the closed-form growing annuity against the
                 explicit year-by-year sum.
  banding, CBA test, PB fractions, direct ignition: single rules; their
                 boundary cases are the gate.
"""

import json
import math
import os
import sys
from fractions import Fraction

import numpy as np
from scipy import integrate
from scipy.stats import norm

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'hse', 'goldens', 'qra_cases.json')
sys.path.insert(0, HERE)
import oracle_consequence as H4  # noqa: E402  (its transcriptions only; main() is not run)

PB = 'TNO Purple Book CPR 18E (1999)'
R2P2 = 'UK HSE R2P2 (2001)'
CBA = 'UK HSE CBA checklist (2003)'
BEVI = 'Bevi (2004) art. 13(1)(b)'
HOURS_PER_YEAR = 8760
SNAP = 1e-9


def pub(t):
    return 'PUBLISHED: ' + t


def der(t):
    return 'ORACLE-DERIVED: ' + t


def P(y):
    return float(norm.cdf(y - 5))


# ---------------------------------------------------------------- event trees

def tree_leaves(tree, f0, exact=False):
    out = []

    def walk(node, path, p):
        for b in node['branches']:
            q = Fraction(repr(b['probability'])) if exact else b['probability']
            if 'next' in b:
                walk(b['next'], path + [b['name']], p * q)
            else:
                out.append((path + [b['name']], b.get('outcome', b['name']), p * q))
    walk(tree, [], Fraction(1) if exact else 1.0)
    f = Fraction(repr(f0)) if exact else f0
    return [(pa, oc, pr, f * pr) for pa, oc, pr in out]


def flammable_tree(pi, pd, ff=0.6, ex=0.4, imm='jet or pool fire'):
    return {'branches': [
        {'name': 'immediate ignition', 'probability': pi, 'outcome': imm},
        {'name': 'no immediate ignition', 'probability': 1 - pi, 'next': {'branches': [
            {'name': 'delayed ignition', 'probability': pd, 'next': {'branches': [
                {'name': 'flash fire', 'probability': ff}, {'name': 'explosion', 'probability': ex}]}},
            {'name': 'no ignition', 'probability': 1 - pd}]}}]}


# ---------------------------------------------------------------- F-N

def fn_brute(scen, n):
    """F(N): the sum over every scenario with N_i >= N. No sort, no cumulation."""
    return sum(s['frequencyPerYr'] for s in scen if s['fatalities'] >= n)


def fn_corners(scen):
    ns = sorted({s['fatalities'] for s in scen if s['fatalities'] > 0})
    return [{'fatalities': n, 'cumulativeFrequencyPerYr': fn_brute(scen, n)} for n in ns]


def area_under_fn(scen):
    """integral of F(N) dN from 0 to max N, exactly for the step function."""
    ns = sorted({s['fatalities'] for s in scen if s['fatalities'] > 0})
    prev = 0.0
    total = 0.0
    for n in ns:
        total += (n - prev) * fn_brute(scen, n)
        prev = n
    return total


def classify(value, threshold):
    if abs(value - threshold) <= SNAP * abs(threshold):
        return 0
    return 1 if value > threshold else -1


STATE = {1: 'EXCEEDS', 0: 'AT_LINE', -1: 'BELOW'}


def fn_line_compare(scen, C, alpha, nmin=1.0, nmax=math.inf):
    corners = fn_corners(scen)
    rows = []
    prevs = [0.0] + [c['fatalities'] for c in corners[:-1]]
    for c, prev in zip(corners, prevs):
        n = c['fatalities']
        if n < nmin or n > nmax:
            continue
        rows.append((n, c['cumulativeFrequencyPerYr'], prev))
    if nmax != math.inf:
        f = fn_brute(scen, nmax)
        above = [c['fatalities'] for c in corners if c['fatalities'] > nmax]
        if f > 0 and above:
            k = [c['fatalities'] for c in corners].index(above[0])
            prev = 0.0 if k == 0 else corners[k - 1]['fatalities']
            if prev < nmax:
                rows.append((nmax, f, prev))
    checks = []
    for n, f, prev in rows:
        L = C / n ** alpha
        cmp = classify(f, L)
        r = {'fatalities': n, 'curveFrequencyPerYr': f, 'criterionFrequencyPerYr': L, 'ratio': f / L, 'state': STATE[cmp]}
        if cmp == 1:
            r['exceedsOverFatalities'] = {'from': max(prev, (C / f) ** (1 / alpha), nmin), 'to': n}
        checks.append(r)
    # route B: dense grid sup of F / line over [nmin, min(nmax, max N)]
    top = max([c['fatalities'] for c in corners], default=nmin)
    hi = min(nmax, top)
    grid_max = 0.0
    if hi >= nmin:
        g = np.unique(np.concatenate([np.geomspace(nmin, hi, 200001), [nmin, hi]]))
        F = np.array([fn_brute(scen, x) for x in g]) if len(scen) < 8 else None
        if F is None:
            ns = np.array([s['fatalities'] for s in scen])
            fs = np.array([s['frequencyPerYr'] for s in scen])
            F = np.array([fs[ns >= x].sum() for x in g])
        grid_max = float(np.max(F * g ** alpha / C))
    return checks, grid_max


def overall(checks):
    if any(r['state'] == 'EXCEEDS' for r in checks):
        return 'EXCEEDS'
    if any(r['state'] == 'AT_LINE' for r in checks):
        return 'TOUCHES'
    return 'BELOW'


# ---------------------------------------------------------------- toxic grid point (PB 6.2.5)

def toxic_grid_point(q, u, x, sy, sz, h, z, a, b, n, tmin, nws, cutoff, f=None, pm=None):
    C0 = H4.plume(q, u, sy, sz, 0.0, z, h) * 1e6          # mg/m3
    Y0 = a + b * math.log(C0 ** n * tmin)
    Ycut = 5 + float(norm.ppf(cutoff))
    # Y(y) = Y0 - b n y^2 / (2 sy^2): the analytic half width and integrand
    y1 = sy * math.sqrt(2 * (Y0 - Ycut) / (b * n))
    PI = 2 * integrate.quad(lambda y: P(Y0 - b * n * y * y / (2 * sy * sy)), 0, y1, epsabs=0, epsrel=1e-13, limit=200)[0]
    Pcl = P(Y0)
    ecw = PI / Pcl
    pci = nws * ecw / (2 * math.pi * x)
    pd = Pcl * pci
    out = {'centrelineConcentrationMgM3': C0, 'centrelineProbit': Y0, 'centrelineProbability': Pcl, 'cutoffHalfWidthM': y1,
           'probabilityIntegralM': PI, 'effectiveCloudWidthM': ecw, 'coverageProbability': pci, 'probabilityOfDeath': pd}
    if f is not None:
        out['contributionPerYr'] = f * pm * pd
    return out


# ---------------------------------------------------------------- pool fire transect (via the H4 oracle's transcriptions)

def pool_fire_flux(D, m, x, tau, wind=0.0, nu=None, rho=1.2):
    R = D / 2
    if wind > 0:
        ld, _, _ = H4.thomas_wind(D, m, wind, rho)
        L = ld * D
        t = math.radians(H4.tilt(D, wind, nu)[0])
    else:
        L = H4.thomas_still(D, m, rho)
        t = 0.0
    e = math.exp(-0.12 * D)
    sep = 140e3 * e + 20e3 * (1 - e)                        # YB 6.19 (Mudan)
    a, bb = L / R, x / R
    if x <= R or 1 + a * math.sin(t) >= bb:
        return None, L, math.degrees(t)
    fv, fh = H4.raj_vertical(a, bb) if t == 0 else H4.mudan_tilted(a, bb, t)
    return sep * math.hypot(fv, fh) * tau, L, math.degrees(t)


def thermal_P(q, t, a=-14.9, b=2.56, unit='kW/m2'):
    I = q / 1000 if unit == 'kW/m2' else q
    return P(a + b * math.log(t * I ** (4 / 3)))


def lsir_crossings(d, ir, level):
    xs = []
    for j in range(len(d) - 1):
        A, B = ir[j], ir[j + 1]
        if (A >= level) == (B >= level):
            continue
        if A > 0 and B > 0:
            t = (math.log10(level) - math.log10(A)) / (math.log10(B) - math.log10(A))
        else:
            t = (level - A) / (B - A)
        xs.append(d[j] + t * (d[j + 1] - d[j]))
    return xs


def main():
    g = {'module': 'qra', 'generatedBy': 'tools/validation/hse/oracle_qra.py',
         'description': 'HSE H5 quantitative risk assessment: event trees, LSIR, IRPA, PLL, FAR, F-N and criteria, ALARP, cost-benefit, PB fractions, consequence linkage.',
         'tolerances': {'routeA': 'relative 1e-12 (sums and products of doubles)', 'toxicIntegral': 'relative 1e-9 (engine Simpson on 4000 intervals vs scipy quad)',
                        'poolFire': 'relative 1e-10', 'published': 'per case, stated with the case'}}

    # ------------------------------------------------------------ event trees
    trees = []
    specs = [
        ('flammable-default', 1e-3, flammable_tree(0.2, 0.5), der('PB 4.8 split with illustrative ignition probabilities')),
        ('flammable-pb-table-4.5-large-gas', 2.5e-5, flammable_tree(0.7, 0.3), der('direct ignition 0.7 (PB Table 4.5, > 100 kg/s, average/high reactivity), delayed 0.3 illustrative')),
        ('three-way-with-pooled-outcome', 0.013, {'branches': [
            {'name': 'isolation succeeds', 'probability': 0.9, 'next': {'branches': [
                {'name': 'small fire', 'probability': 0.05, 'outcome': 'fire'}, {'name': 'no fire', 'probability': 0.95, 'outcome': 'safe'}]}},
            {'name': 'isolation fails', 'probability': 0.07, 'next': {'branches': [
                {'name': 'large fire', 'probability': 0.3, 'outcome': 'fire'}, {'name': 'no fire', 'probability': 0.7, 'outcome': 'safe'}]}},
            {'name': 'isolation unavailable', 'probability': 0.03, 'outcome': 'escalation'}]},
         der('0.9 + 0.07 + 0.03 sums to 1 only within rounding; two leaves pool into "fire"')),
        ('zero-probability-branch', 4e-4, {'branches': [{'name': 'a', 'probability': 0.0}, {'name': 'b', 'probability': 1.0}]}, der('a zero branch is allowed')),
    ]
    for cid, f0, tree, src in specs:
        leaves = tree_leaves(tree, f0)
        exact = tree_leaves(tree, f0, exact=True)
        totals = {}
        for _, oc, _, fr in leaves:
            totals[oc] = totals.get(oc, 0.0) + fr
        exact_total = sum(fr for _, _, _, fr in exact)
        trees.append({'id': cid, 'source': src, 'args': {'initiatingFrequencyPerYr': f0, 'tree': tree},
                      'expected': {'outcomes': [{'path': pa, 'outcome': oc, 'probability': pr, 'frequencyPerYr': fr} for pa, oc, pr, fr in leaves],
                                   'outcomeTotalsPerYr': totals},
                      'routeB': {'exactFrequencies': [float(fr) for _, _, _, fr in exact], 'exactTotal': float(exact_total), 'f0': f0}})
    flam = [{'id': 'builder-default-split', 'source': der('flammableReleaseEventTree with the PB 0.6 / 0.4 split'),
             'args': {'initiatingFrequencyPerYr': 1e-3, 'immediateIgnitionProbability': 0.2, 'delayedIgnitionProbability': 0.5},
             'expectedTotals': {'jet or pool fire': 1e-3 * 0.2, 'flash fire': 1e-3 * 0.8 * 0.5 * 0.6, 'explosion': 1e-3 * 0.8 * 0.5 * 0.4, 'no ignition': 1e-3 * 0.8 * 0.5}},
            {'id': 'builder-custom-split', 'source': der('caller split 0.75 / 0.25'),
             'args': {'initiatingFrequencyPerYr': 3e-4, 'immediateIgnitionProbability': 0.065, 'delayedIgnitionProbability': 0.1,
                      'vapourCloudSplit': {'flashFire': 0.75, 'explosion': 0.25}, 'immediateOutcome': 'pool fire'},
             'expectedTotals': {'pool fire': 3e-4 * 0.065, 'flash fire': 3e-4 * 0.935 * 0.1 * 0.75, 'explosion': 3e-4 * 0.935 * 0.1 * 0.25, 'no ignition': 3e-4 * 0.935 * 0.9}}]

    # PB Table 4.5 as printed, and its band edges
    t45 = {'k1-liquid': [0.065, 0.065, 0.065], 'gas-low-reactivity': [0.02, 0.04, 0.09], 'gas-average-high-reactivity': [0.2, 0.5, 0.7]}
    ign = []
    for sub, row in t45.items():
        for rel, x, band in (('continuous', 5.0, 0), ('continuous', 10.0, 1), ('continuous', 100.0, 1), ('continuous', 100.0001, 2),
                             ('instantaneous', 999.0, 0), ('instantaneous', 1000.0, 1), ('instantaneous', 10000.0, 1), ('instantaneous', 20000.0, 2)):
            args = {'releaseType': rel, 'substance': sub}
            args['massRateKgS' if rel == 'continuous' else 'massKg'] = x
            edge = x in (10.0, 100.0, 1000.0, 10000.0)
            ign.append({'args': args, 'probability': row[band],
                        'source': der('PB Table 4.5 band edge: the printed middle band "10 - 100" is read as closed (a judgement)') if edge
                        else pub(PB + ' Table 4.5')})

    # ------------------------------------------------------------ LSIR, IRPA, PLL, FAR
    rng = np.random.default_rng(20260919)
    lsir = []
    for cid, scen in [
        ('three-scenarios', [{'name': 'jet fire', 'frequencyPerYr': 2e-4, 'fatalityProbability': 0.3},
                             {'name': 'flash fire', 'frequencyPerYr': 2.4e-4, 'fatalityProbability': 1.0},
                             {'name': 'explosion', 'frequencyPerYr': 1.6e-4, 'fatalityProbability': 0.02}]),
        ('with-zero-frequency', [{'name': 'toxic', 'frequencyPerYr': 5e-7 * 0.0368, 'fatalityProbability': 0.381},
                                 {'name': 'unused', 'frequencyPerYr': 0.0, 'fatalityProbability': 0.9}]),
    ]:
        total = sum(s['frequencyPerYr'] * s['fatalityProbability'] for s in scen)
        f = np.array([s['frequencyPerYr'] for s in scen])
        p = np.array([s['fatalityProbability'] for s in scen])
        nmc = 2_000_000
        idx = rng.choice(len(scen), size=nmc, p=f / f.sum())
        deaths = rng.random(nmc) < p[idx]
        est = f.sum() * deaths.mean()
        pbar = total / f.sum()
        se = f.sum() * math.sqrt(pbar * (1 - pbar) / nmc)
        assert abs(est - total) < 4 * se, (cid, est, total, se)
        lsir.append({'id': cid, 'source': der('PB 6.1 / 6.2 sum'), 'args': {'scenarios': scen},
                     'expected': {'lsirPerYr': total, 'contributions': [s['frequencyPerYr'] * s['fatalityProbability'] for s in scen]},
                     'monteCarloSanity': {'samples': nmc, 'seed': 20260919, 'estimate': est, 'standardError': se, 'note': 'not a golden; within 4 standard errors'}})
    pb6b_dir = {'id': 'pb-appendix-6b-contribution', 'source': pub(PB + ' Appendix 6.B step 6: 5e-7 x 0.0368 x 0.381 = 7.0e-9 per year'),
                'args': {'scenarios': [{'name': 'pipe rupture, D 5.0, sector 196-225', 'frequencyPerYr': 5e-7 * 0.0368, 'fatalityProbability': 0.381}]},
                'printed': 7.0e-9, 'printedDecimals': 10}

    irpa = [
        {'id': 'operator-two-areas', 'source': der('IRPA = sum LSIR x occupancy'),
         'args': {'locations': [{'name': 'process area', 'lsirPerYr': 3e-4, 'hoursPerYr': 1200}, {'name': 'control room', 'lsirPerYr': 2e-6, 'occupancyFraction': 0.1, 'vulnerabilityFactor': 0.5}]},
         'expected': {'irpaPerYr': 3e-4 * 1200 / HOURS_PER_YEAR + 2e-6 * 0.1 * 0.5, 'totalOccupancyFraction': 1200 / HOURS_PER_YEAR + 0.1}},
        {'id': 'full-occupancy', 'source': der('occupancy exactly 1 is allowed'),
         'args': {'locations': [{'name': 'a', 'lsirPerYr': 1e-5, 'occupancyFraction': 0.6}, {'name': 'b', 'lsirPerYr': 4e-5, 'occupancyFraction': 0.4}]},
         'expected': {'irpaPerYr': 1e-5 * 0.6 + 4e-5 * 0.4, 'totalOccupancyFraction': 1.0}},
    ]
    pll = [{'id': 'fractional-and-zero-N', 'source': der('PLL = sum f N; N need not be whole (PB 6.3)'),
            'args': {'scenarios': [{'name': 'a', 'frequencyPerYr': 1e-3, 'fatalities': 0.4}, {'name': 'b', 'frequencyPerYr': 2e-5, 'fatalities': 12},
                                   {'name': 'c', 'frequencyPerYr': 3e-7, 'fatalities': 150}, {'name': 'd', 'frequencyPerYr': 0.01, 'fatalities': 0}]},
            'expected': {'pllPerYr': 1e-3 * 0.4 + 2e-5 * 12 + 3e-7 * 150}}]
    far = [{'id': 'platform', 'source': der('FAR = PLL x 1e8 / hours'), 'args': {'pllPerYr': 6.9e-3, 'exposedHoursPerYr': 120 * 8760 / 2},
            'expected': {'far': 6.9e-3 * 1e8 / (120 * 8760 / 2)}},
           {'id': 'whole-count', 'source': der('equals safetyStats.fatalAccidentRate for a whole count'), 'args': {'pllPerYr': 3, 'exposedHoursPerYr': 2.5e7},
            'expected': {'far': 3 * 1e8 / 2.5e7}}]

    # ------------------------------------------------------------ F-N
    fn_sets = {
        'mixed': [{'name': 'a', 'frequencyPerYr': 1e-4, 'fatalities': 15}, {'name': 'b', 'frequencyPerYr': 5e-6, 'fatalities': 120},
                  {'name': 'c', 'frequencyPerYr': 1e-3, 'fatalities': 0}, {'name': 'd', 'frequencyPerYr': 3e-5, 'fatalities': 15},
                  {'name': 'e', 'frequencyPerYr': 2e-3, 'fatalities': 1.5}, {'name': 'f', 'frequencyPerYr': 7e-7, 'fatalities': 900}],
        'compliant': [{'name': 'a', 'frequencyPerYr': 5e-6, 'fatalities': 12}, {'name': 'b', 'frequencyPerYr': 5e-8, 'fatalities': 110},
                      {'name': 'c', 'frequencyPerYr': 1e-3, 'fatalities': 2}],
        'all-zero': [{'name': 'a', 'frequencyPerYr': 1e-2, 'fatalities': 0}],
        'r2p2-touch': [{'name': 'a', 'frequencyPerYr': 1.5e-4, 'fatalities': 50}, {'name': 'b', 'frequencyPerYr': 5e-5, 'fatalities': 80}],
        'r2p2-over': [{'name': 'a', 'frequencyPerYr': 1.5e-4, 'fatalities': 60}, {'name': 'b', 'frequencyPerYr': 6e-5, 'fatalities': 80}],
        'line-touch': [{'name': 'a', 'frequencyPerYr': 0.01 / 20, 'fatalities': 20}, {'name': 'b', 'frequencyPerYr': 1e-6, 'fatalities': 4}],
    }
    fncurves = []
    for k, scen in fn_sets.items():
        corners = fn_corners(scen)
        grid = [0.5, 1.0, 1.5, 2.0, 7.0, 15.0, 15.0000001, 49.99, 50.0, 120.0, 899.0, 900.0, 901.0]
        fncurves.append({'id': k, 'source': der('PB 6.6, brute force'), 'args': {'scenarios': scen},
                         'expected': {'points': corners, 'expectedFatalitiesPerYr': sum(s['frequencyPerYr'] * s['fatalities'] for s in scen),
                                      'zeroFatalityFrequencyPerYr': sum(s['frequencyPerYr'] for s in scen if s['fatalities'] == 0)},
                         'routeB': {'grid': [{'n': n, 'F': fn_brute(scen, n)} for n in grid], 'areaUnderCurve': area_under_fn(scen)}})
    comparisons = []
    for cid, key, crit, src in [
        ('mixed-vs-vrom', 'mixed', 'vrom-establishments', der('PB Figure 6.8 / Bevi line')),
        ('compliant-vs-vrom', 'compliant', 'vrom-establishments', der('below the line everywhere')),
        ('mixed-vs-line-nmax', 'mixed', {'constantC': 1e-2, 'exponentAlpha': 1, 'minFatalities': 1, 'maxFatalities': 500}, der('a caller line with nMax inside a step')),
        ('line-touch', 'line-touch', {'constantC': 1e-2, 'exponentAlpha': 1}, der('the curve corner lies exactly on F = 0.01 / N')),
        ('r2p2-touch', 'r2p2-touch', 'r2p2-para-136', der('F(50) = 1.5e-4 + 5e-5 = 2e-4, exactly the R2P2 point: not "more than"')),
        ('r2p2-over', 'r2p2-over', 'r2p2-para-136', der('F(50) = 2.1e-4 > 1 in 5000')),
    ]:
        scen = fn_sets[key]
        if isinstance(crit, str) and crit == 'vrom-establishments':
            checks, gm = fn_line_compare(scen, 1e-3, 2, 10)
        elif isinstance(crit, str):
            f = fn_brute(scen, 50)
            cmp = classify(f, 1 / 5000)
            checks = [{'fatalities': 50, 'curveFrequencyPerYr': f, 'criterionFrequencyPerYr': 1 / 5000, 'ratio': f / (1 / 5000), 'state': STATE[cmp]}]
            gm = None
        else:
            checks, gm = fn_line_compare(scen, crit['constantC'], crit['exponentAlpha'], crit.get('minFatalities', 1), crit.get('maxFatalities', math.inf))
        comparisons.append({'id': cid, 'source': src, 'args': {'scenarios': scen, 'criterion': crit},
                            'expected': {'state': overall(checks), 'checks': checks, 'maxRatio': max((r['ratio'] for r in checks), default=0)},
                            'routeB': {'gridMaxRatio': gm}})
    bevi_points = [{'fatalities': 10, 'printed': 1e-5}, {'fatalities': 100, 'printed': 1e-7}, {'fatalities': 1000, 'printed': 1e-9}]

    # ------------------------------------------------------------ ALARP
    alarp = []
    for rate_text, denom, thr, band, src in [
        ('agriculture 1999/00, 1 in 12 984', 12984, 'r2p2-workers', 'TOLERABLE', pub(R2P2 + ' para 128 box: worker rates "normally well below the upper limit" of 1 in 1000')),
        ('construction 1999/00, 1 in 21 438', 21438, 'r2p2-workers', 'TOLERABLE', pub(R2P2 + ' para 128 box')),
        ('mining and quarrying 1999/00, 1 in 14 564', 14564, 'r2p2-workers', 'TOLERABLE', pub(R2P2 + ' para 128 box')),
        ('service sector 1999/00, 1 in 388 565', 388565, 'r2p2-workers', 'TOLERABLE', pub(R2P2 + ' para 128 box (still above 1 in a million)')),
        ('public, gas 1994/5-1998/9, 1 in 1 510 000', 1510000, 'r2p2-public', 'BROADLY_ACCEPTABLE', pub(R2P2 + ' para 128 box: "below the limit of what is often regarded as broadly acceptable"')),
    ]:
        alarp.append({'id': rate_text, 'source': src, 'args': {'individualRiskPerYr': 1 / denom, 'thresholds': thr}, 'expected': {'band': band, 'atBoundary': None}})
    for ir, thr, band, at, note in [
        (1e-3, 'r2p2-workers', 'TOLERABLE', 'unacceptable', 'exactly 1e-3: not "more than"'),
        (1e-4 * 10, 'r2p2-workers', 'TOLERABLE', 'unacceptable', '1e-4 x 10 = 0.0010000000000000002 snaps to 1e-3'),
        (1.001e-3, 'r2p2-workers', 'UNACCEPTABLE', None, 'just above'),
        (1e-4, 'r2p2-public', 'TOLERABLE', 'unacceptable', 'public limit exactly'),
        (2e-4, 'r2p2-public', 'UNACCEPTABLE', None, 'public, above'),
        (1e-6, 'r2p2-workers', 'BROADLY_ACCEPTABLE', 'broadly-acceptable', 'exactly 1e-6: at or below'),
        (1.0000001e-6, 'r2p2-public', 'TOLERABLE', None, '1e-7 relative above 1e-6 is outside the snap'),
        (0.0, 'r2p2-public', 'BROADLY_ACCEPTABLE', None, 'zero risk'),
        (5e-5, {'unacceptableAbovePerYr': 1e-4, 'broadlyAcceptableAtOrBelowPerYr': 1e-5}, 'TOLERABLE', None, 'user thresholds'),
        (1e-5, {'unacceptableAbovePerYr': 1e-4, 'broadlyAcceptableAtOrBelowPerYr': 1e-5}, 'BROADLY_ACCEPTABLE', 'broadly-acceptable', 'user lower edge'),
    ]:
        alarp.append({'id': note, 'source': der('boundary convention'), 'args': {'individualRiskPerYr': ir, 'thresholds': thr}, 'expected': {'band': band, 'atBoundary': at}})

    # ------------------------------------------------------------ cost-benefit
    def pv_annuity(B, r, gr, n):
        """Route B: closed-form growing annuity, year-end, t = 1..n."""
        if abs((1 + gr) / (1 + r) - 1) < 1e-15:
            return B * n
        x = (1 + gr) / (1 + r)
        return B * x * (1 - x ** n) / (1 - x)

    def pv_sum(B, r, gr, n):
        return sum(B * (1 + gr) ** t / (1 + r) ** t for t in range(1, n + 1))

    cba = []
    hse_args = {'deltaPllPerYr': 20 * 1e-5, 'vpf': 1336800,
                'otherHarms': [{'name': 'permanently incapacitating injury', 'expectedCasesPerYr': 40 * 1e-5, 'valuePerCase': 207200},
                               {'name': 'serious injury', 'expectedCasesPerYr': 100 * 1e-5, 'valuePerCase': 20500},
                               {'name': 'slight injury', 'expectedCasesPerYr': 200 * 1e-5, 'valuePerCase': 300}],
                'lifetimeYears': 25, 'capitalCost': 93000, 'disproportionFactor': 10}
    B = 20 * 1336800 * 1e-5 + 40 * 207200 * 1e-5 + 100 * 20500 * 1e-5 + 200 * 300 * 1e-5
    cba.append({'id': 'hse-cba-checklist-example', 'source': pub(CBA + ' worked example: 6684 + 2072 + 512 + 15 = 9,283; "up to ... 93,000 (9300 x 10)"'),
                'args': hse_args,
                'expected': {'presentValueBenefit': B * 25, 'fatalityBenefitPerYr': 20 * 1336800 * 1e-5, 'maximumReasonablyPracticableCost': 10 * B * 25,
                             'verdict': 'GROSSLY_DISPROPORTIONATE' if 93000 > 10 * B * 25 else 'NOT_GROSSLY_DISPROPORTIONATE'},
                'printed': {'fatalities': 6684, 'permanent': 2072, 'serious': 512, 'slight': 15, 'total': 9283, 'maxCost': 93000},
                'printedAbsTol': 1.0, 'printedMaxCostRelTol': 0.01})
    cba.append({'id': 'r2p2-vpf-footnote', 'source': pub(R2P2 + ' App. 3 para 13 margin: a VPF of 1 000 000 means a 1 in 100 000 risk reduction is worth about 10'),
                'args': {'deltaPllPerYr': 1e-5, 'vpf': 1e6, 'lifetimeYears': 1, 'capitalCost': 10, 'disproportionFactor': 1},
                'expected': {'presentValueBenefit': 10.0, 'verdict': 'NOT_GROSSLY_DISPROPORTIONATE', 'atBoundary': True}, 'printed': 10})
    for cid, args in [
        ('discounted-cba-2003-rates', {'deltaPllPerYr': 3e-4, 'vpf': 1.6e6, 'lifetimeYears': 20, 'capitalCost': 250000, 'annualCost': 4000,
                                       'disproportionFactor': 6, 'benefitDiscountRate': 0.015, 'costDiscountRate': 0.035}),
        ('r2p2-6pc-with-4pc-uprating', {'deltaPllPerYr': 1e-3, 'vpf': 1e6, 'lifetimeYears': 30, 'capitalCost': 180000, 'annualCost': 2500,
                                        'disproportionFactor': 3, 'benefitDiscountRate': 0.06, 'costDiscountRate': 0.06, 'benefitGrowthRate': 0.04}),
        ('grossly-disproportionate', {'deltaPllPerYr': 1e-5, 'vpf': 2e6, 'lifetimeYears': 10, 'capitalCost': 5e6, 'disproportionFactor': 10}),
    ]:
        Bp = args['deltaPllPerYr'] * args['vpf']
        r = args.get('benefitDiscountRate', 0.0)
        gr = args.get('benefitGrowthRate', 0.0)
        rc = args.get('costDiscountRate', 0.0)
        n = args['lifetimeYears']
        pvb = pv_sum(Bp, r, gr, n)
        pvb_b = pv_annuity(Bp, r, gr, n)
        pvc = args['capitalCost'] + pv_sum(args.get('annualCost', 0.0), rc, 0.0, n)
        pvc_b = args['capitalCost'] + pv_annuity(args.get('annualCost', 0.0), rc, 0.0, n)
        cba.append({'id': cid, 'source': der('year-end discounting'), 'args': args,
                    'expected': {'presentValueBenefit': pvb, 'presentValueCost': pvc, 'costPerFatalityPrevented': pvc / (args['deltaPllPerYr'] * n),
                                 'costToBenefitRatio': pvc / pvb,
                                 'verdict': 'GROSSLY_DISPROPORTIONATE' if classify(pvc, args['disproportionFactor'] * pvb) == 1 else 'NOT_GROSSLY_DISPROPORTIONATE'},
                    'routeB': {'presentValueBenefit': pvb_b, 'presentValueCost': pvc_b}})
    cba.append({'id': 'exactly-at-df', 'source': der('cost = DF x benefit exactly: not grossly disproportionate'),
                'args': {'deltaPllPerYr': 2e-4, 'vpf': 1.5e6, 'lifetimeYears': 10, 'capitalCost': 3 * 2e-4 * 1.5e6 * 10, 'disproportionFactor': 3},
                'expected': {'verdict': 'NOT_GROSSLY_DISPROPORTIONATE', 'atBoundary': True}})

    # ------------------------------------------------------------ PB fractions
    def heatP(q, t):
        return P(-36.38 + 2.56 * math.log(q ** (4 / 3) * t))
    fr = []
    for cid, args, pe, fin_, fout in [
        ('toxic-day', {'effect': 'toxic', 'probabilityOfDeath': 0.835, 'period': 'day'}, 0.835, 0.0835, 0.835),
        ('toxic-night', {'effect': 'toxic', 'probabilityOfDeath': 0.4, 'period': 'night'}, 0.4, 0.04, 0.4),
        ('fire-envelope', {'effect': 'fire', 'insideFlameEnvelope': True, 'period': 'day'}, 1, 1, 1),
        ('fire-35kW-exact', {'effect': 'fire', 'heatFluxWM2': 35000, 'fireDurationS': 10, 'period': 'day'}, 1, 1, 1),
        ('fire-12kW-60s-capped', {'effect': 'fire', 'heatFluxWM2': 12000, 'fireDurationS': 60, 'period': 'night'}, heatP(12000, 20), 0, 0.14 * heatP(12000, 20)),
        ('fire-20kW-8s', {'effect': 'fire', 'heatFluxWM2': 20000, 'fireDurationS': 8, 'fractionIndoors': 0.5}, heatP(20000, 8), 0, 0.14 * heatP(20000, 8)),
        ('fire-zero-flux', {'effect': 'fire', 'heatFluxWM2': 0, 'fireDurationS': 8, 'period': 'day'}, 0, 0, 0),
        ('flash-in', {'effect': 'flash-fire', 'insideFlameEnvelope': True, 'period': 'night'}, 1, 1, 1),
        ('flash-out', {'effect': 'flash-fire', 'insideFlameEnvelope': False, 'period': 'night'}, 0, 0, 0),
        ('vce-0.3-exact', {'effect': 'explosion', 'peakOverpressurePa': 30000, 'period': 'day'}, 0, 0.025, 0),
        ('vce-0.31', {'effect': 'explosion', 'peakOverpressurePa': 31000, 'period': 'day'}, 1, 1, 1),
        ('vce-0.1-exact', {'effect': 'explosion', 'peakOverpressurePa': 10000, 'period': 'day'}, 0, 0, 0),
        ('vce-0.2', {'effect': 'explosion', 'peakOverpressurePa': 20000, 'period': 'night'}, 0, 0.025, 0),
    ]:
        f_in = args.get('fractionIndoors', {'day': 0.93, 'night': 0.99}.get(args.get('period')))
        fr.append({'id': cid, 'source': der('the rules of PB Figures 5.2 to 5.5, Table 5.3 and eq. 6.13 applied; the PB prints no numeric example') if 'exact' not in cid else der('threshold edge as the PB figures print it (>= 35 kW/m2; > 0.3 and > 0.1 barg)'),
                   'args': args, 'expected': {'probabilityOfDeath': pe, 'fractionDyingIndoors': fin_, 'fractionDyingOutdoors': fout,
                                              'fractionIndoors': f_in, 'fractionOfDeaths': fin_ * f_in + fout * (1 - f_in)}})

    # ------------------------------------------------------------ toxic grid point, PB Appendix 6.B
    tg = toxic_grid_point(100.0, 5.0, 361.0, 28.8, 10.3, 1.0, 1.0, -7.4, 1.0, 1.0, 30.0, 12, 0.01, 5e-7, 0.0368)
    pb6b = {'id': 'pb-appendix-6b', 'source': pub(PB + ' Appendix 6.B: C 21.3 g/m3, Pr 5.97, Pcl 0.835, PI 72 m, ECW 86.2 m, Pci 0.456, Pd 0.381, dIR 7.0e-9'),
            'args': {'massRateKgS': 100, 'windSpeedMS': 5, 'distanceM': 361, 'sigmaYM': 28.8, 'sigmaZM': 10.3, 'releaseHeightM': 1, 'receptorHeightM': 1,
                     'coefficients': 'pb-carbon-monoxide', 'exposureMinutes': 30, 'windSectors': 12, 'cutoffProbability': 0.01,
                     'frequencyPerYr': 5e-7, 'weatherDirectionProbability': 0.0368},
            'expected': tg,
            'printed': {'centrelineConcentrationMgM3': 21300, 'centrelineProbit': 5.97, 'centrelineProbability': 0.835, 'probabilityIntegralM': 72,
                        'effectiveCloudWidthM': 86.2, 'coverageProbability': 0.456, 'probabilityOfDeath': 0.381, 'contributionPerYr': 7.0e-9,
                        'weatherDirectionProbability': 0.0368},
            'printedChainTolerances': {'centrelineConcentrationMgM3': 0.005, 'centrelineProbit': 0.001, 'centrelineProbability': 0.003, 'probabilityIntegralM': 0.007,
                                       'effectiveCloudWidthM': 0.002, 'coverageProbability': 0.002, 'probabilityOfDeath': 0.002, 'contributionPerYr': 0.005},
            'printedStepwise': {'ecw': 72 / 0.835, 'pci': 12 * 86.2 / (2 * math.pi * 361), 'pd': 0.835 * 0.456, 'dir': 5e-7 * 0.0368 * 0.381,
                                'pmPphi': 0.44 * 0.0376 + 0.56 * 0.0362}}
    tg2 = toxic_grid_point(20.0, 3.0, 250.0, 22.0, 9.0, 0.0, 1.0, -6.35, 0.5, 2.75, 30.0, 12, 0.01)
    tox = [{'id': 'chlorine-ground-release-60min-capped', 'source': der('PB chlorine probit, 60 min capped to 30'),
            'args': {'massRateKgS': 20, 'windSpeedMS': 3, 'distanceM': 250, 'sigmaYM': 22, 'sigmaZM': 9, 'releaseHeightM': 0, 'receptorHeightM': 1,
                     'coefficients': 'pb-chlorine', 'exposureMinutes': 60},
            'expected': tg2}]

    # ------------------------------------------------------------ transects
    fluxes = [60000.0, 25000.0, 12500.0, 6300.0, 4000.0, 1600.0, 0.0]
    thermal = [{'id': 'eisenberg-30s', 'source': der('Eisenberg (OSD/30 Table 17) at 30 s'), 'args': {'heatFluxesWM2': fluxes, 'exposureTimeS': 30},
                'expected': [thermal_P(q, 30) if q > 0 else 0.0 for q in fluxes]},
               {'id': 'purple-book-20s', 'source': der('PB 5.4 at 20 s'), 'args': {'heatFluxesWM2': fluxes, 'exposureTimeS': 20, 'coefficients': 'purple-book'},
                'expected': [thermal_P(q, 20, -36.38, 2.56, 'W/m2') if q > 0 else 0.0 for q in fluxes]}]
    pool = []
    for cid, D, m, tau, wind, nu, xs in [
        ('still-air-20m', 20.0, 0.055, 0.8, 0.0, None, [0.0, 10.0, 12.0, 15.0, 20.0, 30.0, 45.0, 60.0, 90.0]),
        ('wind-5ms-overhang', 20.0, 0.055, 0.8, 5.0, 1.5e-5, [5.0, 15.0, 20.0, 30.0, 45.0, 60.0, 90.0]),
    ]:
        pts = []
        for x in xs:
            q, L, tdeg = pool_fire_flux(D, m, x, tau, wind, nu)
            if q is None:
                pts.append({'distanceFromCentreM': x, 'state': 'IN_FLAME_ENVELOPE', 'heatFluxWM2': None, 'probability': 1.0})
            else:
                pts.append({'distanceFromCentreM': x, 'state': 'RADIATION', 'heatFluxWM2': q, 'probability': thermal_P(q, 60)})
        args = {'distancesFromCentreM': xs, 'exposureTimeS': 60, 'poolDiameterM': D, 'burningFluxKgM2S': m, 'heatOfCombustionJKg': 4.4e7,
                'sep': {'method': 'mudan-diameter'}, 'transmissivity': tau}
        if wind > 0:
            args.update({'flameLengthMethod': 'thomas-wind', 'windSpeed10mMS': wind, 'airKinematicViscosityM2S': nu})
        pool.append({'id': cid, 'source': der('H4 oracle Thomas, Raj / Mudan, YB 6.19 SEP, then Eisenberg at 60 s; PB Figure 5.4 flame envelope'),
                     'args': args, 'expected': pts, 'tiltDeg': tdeg})
    # LSIR along the still-air transect, two scenarios, PB contour levels
    sa = pool[0]
    d = sa['args']['distancesFromCentreM']
    p_fire = [p['probability'] for p in sa['expected']]
    p_flash = [1.0 if x <= 30 else 0.0 for x in d]
    scen = [{'name': 'pool fire', 'frequencyPerYr': 2e-4, 'fatalityProbabilities': p_fire},
            {'name': 'flash fire', 'frequencyPerYr': 3e-6, 'fatalityProbabilities': p_flash}]
    ir = [2e-4 * a + 3e-6 * b for a, b in zip(p_fire, p_flash)]
    levels = [1e-4, 1e-5, 1e-6, 1e-7, 1e-8]
    transect = {'id': 'pool-and-flash-fire', 'source': der('PB 6.1 / 6.2 along a transect; contours per PB 6.3'),
                'args': {'distancesM': d, 'scenarios': scen},
                'expected': {'lsirPerYr': ir, 'contours': [{'levelPerYr': L, 'crossingsM': lsir_crossings(d, ir, L)} for L in levels]}}

    refusals = [
        {'fn': 'eventTree', 'args': {'initiatingFrequencyPerYr': 1e-3, 'tree': {'branches': [{'name': 'a', 'probability': 0.6}, {'name': 'b', 'probability': 0.3}]}}, 'field': 'tree.branches'},
        {'fn': 'eventTree', 'args': {'initiatingFrequencyPerYr': 1e-3, 'tree': {'branches': [{'name': 'a', 'probability': 0.6}, {'name': 'b', 'probability': 0.4000001}]}}, 'field': 'tree.branches'},
        {'fn': 'eventTree', 'args': {'initiatingFrequencyPerYr': 1e-3, 'tree': {'branches': [{'name': 'a', 'probability': 0.5, 'next': {'branches': [{'name': 'x', 'probability': 0.5}, {'name': 'y', 'probability': 0.6}]}}, {'name': 'b', 'probability': 0.5}]}}, 'field': 'tree.branches[0].next.branches'},
        {'fn': 'eventTree', 'args': {'initiatingFrequencyPerYr': 1e-3, 'tree': {'branches': [{'name': 'a', 'probability': 1.2}, {'name': 'b', 'probability': -0.2}]}}, 'field': 'tree.branches[0].probability'},
        {'fn': 'eventTree', 'args': {'initiatingFrequencyPerYr': 1e-3, 'tree': {'branches': [{'name': 'a', 'probability': 0.5}, {'name': 'a', 'probability': 0.5}]}}, 'field': 'tree.branches[1].name'},
        {'fn': 'eventTree', 'args': {'initiatingFrequencyPerYr': 0, 'tree': {'branches': [{'name': 'a', 'probability': 1}]}}, 'field': 'initiatingFrequencyPerYr'},
        {'fn': 'eventTree', 'args': {'initiatingFrequencyPerYr': 1e-3, 'tree': {'branches': []}}, 'field': 'tree.branches'},
        {'fn': 'flammableReleaseEventTree', 'args': {'initiatingFrequencyPerYr': 1e-3, 'immediateIgnitionProbability': 0.1, 'delayedIgnitionProbability': 0.3, 'vapourCloudSplit': {'flashFire': 0.6, 'explosion': 0.6}}, 'field': 'vapourCloudSplit'},
        {'fn': 'flammableReleaseEventTree', 'args': {'initiatingFrequencyPerYr': 1e-3, 'immediateIgnitionProbability': 1.1, 'delayedIgnitionProbability': 0.3}, 'field': 'immediateIgnitionProbability'},
        {'fn': 'pbDirectIgnitionProbability', 'args': {'releaseType': 'continuous', 'massRateKgS': 5, 'substance': 'gas'}, 'field': 'substance'},
        {'fn': 'pbDirectIgnitionProbability', 'args': {'releaseType': 'puff', 'massKg': 5, 'substance': 'k1-liquid'}, 'field': 'releaseType'},
        {'fn': 'locationIndividualRisk', 'args': {'scenarios': []}, 'field': 'scenarios'},
        {'fn': 'locationIndividualRisk', 'args': {'scenarios': [{'name': 'a', 'frequencyPerYr': 1e-4, 'fatalityProbability': 1.5}]}, 'field': 'scenarios[0].fatalityProbability'},
        {'fn': 'locationIndividualRisk', 'args': {'scenarios': [{'name': 'a', 'frequencyPerYr': -1e-4, 'fatalityProbability': 0.5}]}, 'field': 'scenarios[0].frequencyPerYr'},
        {'fn': 'individualRiskPerAnnum', 'args': {'locations': [{'name': 'a', 'lsirPerYr': 1e-4, 'occupancyFraction': 1.2}]}, 'field': 'locations[0].occupancyFraction'},
        {'fn': 'individualRiskPerAnnum', 'args': {'locations': [{'name': 'a', 'lsirPerYr': 1e-4, 'occupancyFraction': 0.7}, {'name': 'b', 'lsirPerYr': 1e-5, 'occupancyFraction': 0.4}]}, 'field': 'locations'},
        {'fn': 'individualRiskPerAnnum', 'args': {'locations': [{'name': 'a', 'lsirPerYr': 1e-4, 'hoursPerYr': 9000}]}, 'field': 'locations[0].hoursPerYr'},
        {'fn': 'individualRiskPerAnnum', 'args': {'locations': [{'name': 'a', 'lsirPerYr': 1e-4}]}, 'field': 'locations[0].occupancyFraction'},
        {'fn': 'individualRiskPerAnnum', 'args': {'locations': [{'name': 'a', 'lsirPerYr': 1e-4, 'occupancyFraction': 0.5, 'vulnerabilityFactor': 2}]}, 'field': 'locations[0].vulnerabilityFactor'},
        {'fn': 'potentialLossOfLife', 'args': {'scenarios': [{'name': 'a', 'frequencyPerYr': 1e-4, 'fatalities': -1}]}, 'field': 'scenarios[0].fatalities'},
        {'fn': 'potentialLossOfLife', 'args': {}, 'field': 'scenarios'},
        {'fn': 'fatalAccidentRateFromPll', 'args': {'pllPerYr': 1e-3, 'exposedHoursPerYr': 0}, 'field': 'exposedHoursPerYr'},
        {'fn': 'fnCurve', 'args': {'scenarios': []}, 'field': 'scenarios'},
        {'fn': 'fnCriterionComparison', 'args': {'scenarios': [{'name': 'a', 'frequencyPerYr': 1e-4, 'fatalities': 5}], 'criterion': 'hse-line'}, 'field': 'criterion'},
        {'fn': 'fnCriterionComparison', 'args': {'scenarios': [{'name': 'a', 'frequencyPerYr': 1e-4, 'fatalities': 5}], 'criterion': {'constantC': 1e-3}}, 'field': 'criterion.exponentAlpha'},
        {'fn': 'fnCriterionComparison', 'args': {'scenarios': [{'name': 'a', 'frequencyPerYr': 1e-4, 'fatalities': 5}], 'criterion': {'constantC': 1e-3, 'exponentAlpha': 1, 'minFatalities': 10, 'maxFatalities': 5}}, 'field': 'criterion.maxFatalities'},
        {'fn': 'alarpBand', 'args': {'individualRiskPerYr': 1e-5, 'thresholds': 'hse'}, 'field': 'thresholds'},
        {'fn': 'alarpBand', 'args': {'individualRiskPerYr': 1e-5, 'thresholds': {'unacceptableAbovePerYr': 1e-6, 'broadlyAcceptableAtOrBelowPerYr': 1e-4}}, 'field': 'thresholds.broadlyAcceptableAtOrBelowPerYr'},
        {'fn': 'alarpBand', 'args': {'individualRiskPerYr': -1e-5, 'thresholds': 'r2p2-public'}, 'field': 'individualRiskPerYr'},
        {'fn': 'costBenefit', 'args': {'deltaPllPerYr': 1e-4, 'lifetimeYears': 10, 'capitalCost': 1e5, 'disproportionFactor': 3}, 'field': 'vpf'},
        {'fn': 'costBenefit', 'args': {'deltaPllPerYr': 1e-4, 'vpf': 1e6, 'lifetimeYears': 10, 'capitalCost': 1e5, 'disproportionFactor': 0.5}, 'field': 'disproportionFactor'},
        {'fn': 'costBenefit', 'args': {'deltaPllPerYr': 1e-4, 'vpf': 1e6, 'lifetimeYears': 10, 'capitalCost': 1e5}, 'field': 'disproportionFactor'},
        {'fn': 'costBenefit', 'args': {'deltaPllPerYr': 0, 'vpf': 1e6, 'lifetimeYears': 10, 'capitalCost': 1e5, 'disproportionFactor': 3}, 'field': 'deltaPllPerYr'},
        {'fn': 'costBenefit', 'args': {'deltaPllPerYr': -1e-4, 'vpf': 1e6, 'lifetimeYears': 10, 'capitalCost': 1e5, 'disproportionFactor': 3}, 'field': 'deltaPllPerYr'},
        {'fn': 'costBenefit', 'args': {'deltaPllPerYr': 1e-4, 'vpf': 1e6, 'lifetimeYears': 12.5, 'capitalCost': 1e5, 'disproportionFactor': 3}, 'field': 'lifetimeYears'},
        {'fn': 'costBenefit', 'args': {'deltaPllPerYr': 1e-4, 'vpf': 1e6, 'lifetimeYears': 10, 'capitalCost': 1e5, 'disproportionFactor': 3, 'costDiscountRate': -1}, 'field': 'costDiscountRate'},
        {'fn': 'pbFatalityFractions', 'args': {'effect': 'toxic', 'probabilityOfDeath': 0.5}, 'field': 'period'},
        {'fn': 'pbFatalityFractions', 'args': {'effect': 'toxic', 'probabilityOfDeath': 0.5, 'period': 'day', 'fractionIndoors': 0.9}, 'field': 'fractionIndoors'},
        {'fn': 'pbFatalityFractions', 'args': {'effect': 'fire', 'heatFluxWM2': 10000, 'period': 'day'}, 'field': 'fireDurationS'},
        {'fn': 'pbFatalityFractions', 'args': {'effect': 'bleve', 'period': 'day'}, 'field': 'effect'},
        {'fn': 'toxicPlumeGridPointRisk', 'args': {'massRateKgS': 100, 'windSpeedMS': 5, 'distanceM': 361, 'sigmaYM': 28.8, 'sigmaZM': 10.3, 'coefficients': 'pb-carbon-monoxide', 'exposureMinutes': 30, 'windSectors': 0}, 'field': 'windSectors'},
        {'fn': 'toxicPlumeGridPointRisk', 'args': {'massRateKgS': 100, 'windSpeedMS': 0, 'distanceM': 361, 'sigmaYM': 28.8, 'sigmaZM': 10.3, 'coefficients': 'pb-carbon-monoxide', 'exposureMinutes': 30}, 'field': 'windSpeedMS'},
        {'fn': 'thermalFatalityTransect', 'args': {'heatFluxesWM2': [1000, -5], 'exposureTimeS': 20}, 'field': 'heatFluxesWM2[1]'},
        {'fn': 'poolFireFatalityTransect', 'args': {'distancesFromCentreM': [30], 'exposureTimeS': 30, 'poolDiameterM': 20, 'burningFluxKgM2S': 0.055, 'heatOfCombustionJKg': 4.4e7, 'sep': {'method': 'mudan-diameter'}}, 'field': 'transmissivity'},
        {'fn': 'lsirTransect', 'args': {'distancesM': [10, 10], 'scenarios': [{'name': 'a', 'frequencyPerYr': 1e-4, 'fatalityProbabilities': [1, 0.5]}]}, 'field': 'distancesM[1]'},
        {'fn': 'lsirTransect', 'args': {'distancesM': [10, 20], 'scenarios': [{'name': 'a', 'frequencyPerYr': 1e-4, 'fatalityProbabilities': [1]}]}, 'field': 'scenarios[0].fatalityProbabilities'},

        # Fail-opens closed 2026-09-20 (FINDINGS-qra.md section 9). A preset
        # looked up as table[key] walks the prototype chain, so an unknown
        # name that happens to be an Object.prototype key returned a truthy
        # function and passed the `if (!row)` guard. Before the fix each of
        # these returned a RESULT, not a refusal: alarpBand said
        # BROADLY_ACCEPTABLE, fnCriterionComparison said BELOW (compliant),
        # pbDirectIgnitionProbability returned no probability at all, and
        # pbFatalityFractions returned a NaN fraction of deaths.
        {'fn': 'alarpBand', 'args': {'individualRiskPerYr': 1e-2, 'thresholds': 'constructor'}, 'field': 'thresholds'},
        {'fn': 'alarpBand', 'args': {'individualRiskPerYr': 1e-2, 'thresholds': 'toString'}, 'field': 'thresholds'},
        {'fn': 'fnCriterionComparison', 'args': {'scenarios': [{'name': 'a', 'frequencyPerYr': 1e-2, 'fatalities': 100}], 'criterion': 'valueOf'}, 'field': 'criterion'},
        {'fn': 'fnCriterionComparison', 'args': {'scenarios': [{'name': 'a', 'frequencyPerYr': 1e-2, 'fatalities': 100}], 'criterion': '__proto__'}, 'field': 'criterion'},
        {'fn': 'pbDirectIgnitionProbability', 'args': {'releaseType': 'continuous', 'massRateKgS': 50, 'substance': 'constructor'}, 'field': 'substance'},
        {'fn': 'pbDirectIgnitionProbability', 'args': {'releaseType': 'continuous', 'massRateKgS': 50, 'substance': 'hasOwnProperty'}, 'field': 'substance'},
        {'fn': 'pbFatalityFractions', 'args': {'effect': 'toxic', 'probabilityOfDeath': 0.5, 'period': 'toString'}, 'field': 'period'},
        {'fn': 'pbFatalityFractions', 'args': {'effect': 'toxic', 'probabilityOfDeath': 0.5, 'period': 'constructor'}, 'field': 'period'},
    ]

    g.update({
        'eventTrees': {'trees': trees, 'flammable': flam, 'directIgnition': ign},
        'individualRisk': {'lsir': lsir, 'pbAppendix6bContribution': pb6b_dir, 'irpa': irpa, 'pll': pll, 'far': far},
        'fn': {'curves': fncurves, 'comparisons': comparisons, 'beviPoints': bevi_points},
        'alarp': alarp,
        'costBenefit': cba,
        'pbFractions': fr,
        'toxicGridPoint': {'pbAppendix6b': pb6b, 'derived': tox},
        'transects': {'thermal': thermal, 'poolFire': pool, 'lsir': transect},
        'refusals': refusals,
    })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(g, fh, indent=1, allow_nan=False)
        fh.write('\n')

    print('PB 6.B chain:', {k: round(v, 6) if abs(v) > 1e-3 else v for k, v in tg.items()})
    print('PB 6.B stepwise:', pb6b['printedStepwise'])
    print('HSE CBA benefit per yr %.4f, 25 yr %.4f, x10 %.2f' % (B, 25 * B, 250 * B))
    for c in comparisons:
        print('FN', c['id'], c['expected']['state'], 'maxRatio %.6g' % c['expected']['maxRatio'], 'grid %s' % c['routeB']['gridMaxRatio'])
    for c in fncurves:
        print('FN area', c['id'], c['expected']['expectedFatalitiesPerYr'], c['routeB']['areaUnderCurve'])
    for c in lsir:
        print('MC', c['id'], c['expected']['lsirPerYr'], c['monteCarloSanity']['estimate'], c['monteCarloSanity']['standardError'])
    for p in pool:
        print('pool', p['id'], 'tilt %.3f' % p['tiltDeg'], [(q['distanceFromCentreM'], q['state'][:3], None if q['heatFluxWM2'] is None else round(q['heatFluxWM2'], 1), round(q['probability'], 5)) for q in p['expected']])
    print('contours', transect['expected']['contours'])
    print('wrote', os.path.relpath(OUT, ROOT))


if __name__ == '__main__':
    main()
