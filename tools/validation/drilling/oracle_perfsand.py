#!/usr/bin/env python3
"""Independent oracle for the perforation & sand control engines (Drilling
D8): Karakas-Tariq perforation skin, productivity ratio, underbalance
guideline bands, sieve statistics, Saucier gravel sizing, screen
selection, completion-type advisor and sanding-onset (critical drawdown)
screening. Emits test-data/drilling/goldens/perfsand_cases.json.

Independence discipline: every quantity is recomputed here from the
published bases (SPE 18247 constant tables retyped from the paper's
reproduction in Economides, Petroleum Production Systems; Saucier 5-6x;
US Standard Sieve openings; the Kirsch hoop closed form), with the sieve
interpolation and the CDP sweep written independently of the JS engine.
Closed forms are self-asserted BEFORE writing:

  K-T 90 deg   lp 12", rp 0.25", 4 spf, rw 4.25", kh/kv 1:
               s_h -1.0210, s_v 0.4960, s_wb 0.0095 (hand arithmetic)
  K-T 0 deg    rw' = lp/4 exactly
  crushed      s_cz = 0 when k = kc; grows with k/kc
  monotone     longer lp -> lower total skin; higher spf -> lower s_v
  PR           s = 0 -> 1; s > 0 -> < 1
  sieve        log-linear PSD 1000 -> 10 um: D50 = 100 um, D10 = 630.957,
               C_u = D40/D90 = 10 exactly (by construction)
  Saucier      120 um sand -> band 600-720 um; 20/40 (d50 630.5) matches
  screen       20/40 gravel (min 420 um) -> 16 thou gauge (406.4 um)
  sanding      pwf,crit = (3 S1 - S2 - U)/2 against explicit arithmetic

The golden rides the D5 geomech profile (same grid the gm-1.0.0 harness
curves serve) and the D1 slant well.

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_perfsand.py
"""
import math

import numpy as np

from oracle_torquedrag import WELLS, rnd, write  # noqa: F401
from oracle_hydraulics import tvd_of  # noqa: F401
from oracle_geomech import PARAMS, horizontal_stresses, make_profile, ucs_horsrud

IN = 0.0254
UM = 1e-6
THOU = 25.4e-6
PSI = 6894.757293168
FT_PER_M = 3.280839895

# ------------------------------------------------------------ Karakas-Tariq

KT = {
    0: dict(alpha=0.250, a1=-2.091, a2=0.0453, b1=5.1313, b2=1.8672, c1=1.6e-1, c2=2.675),
    45: dict(alpha=0.860, a1=-1.788, a2=0.2398, b1=1.1915, b2=1.6392, c1=4.6e-5, c2=8.791),
    60: dict(alpha=0.813, a1=-1.898, a2=0.1023, b1=1.3654, b2=1.6490, c1=3.0e-4, c2=7.509),
    90: dict(alpha=0.726, a1=-1.905, a2=0.1038, b1=1.5674, b2=1.6935, c1=1.9e-3, c2=6.155),
    120: dict(alpha=0.648, a1=-2.018, a2=0.0634, b1=1.6136, b2=1.7770, c1=6.6e-3, c2=5.320),
    180: dict(alpha=0.500, a1=-2.025, a2=0.0943, b1=3.0373, b2=1.8115, c1=2.6e-2, c2=4.532),
}


def karakas_tariq(lp, rp, spf_per_m, phasing, rw, kh_over_kv=1.0, rc=None, k_over_kc=None):
    t = KT[phasing]
    h = 1.0 / spf_per_m
    rw_prime = lp / 4.0 if phasing == 0 else t['alpha'] * (rw + lp)
    s_h = math.log(rw / rw_prime)
    h_d = (h / lp) * math.sqrt(kh_over_kv)
    rp_d = (rp / (2.0 * h)) * (1.0 + math.sqrt(1.0 / kh_over_kv))
    a = t['a1'] * math.log10(rp_d) + t['a2']
    b = t['b1'] * rp_d + t['b2']
    s_v = 10.0 ** a * h_d ** (b - 1.0) * rp_d ** b
    rw_d = rw / (lp + rw)
    s_wb = t['c1'] * math.exp(t['c2'] * rw_d)
    s_cz = 0.0
    if rc is not None and k_over_kc is not None:
        s_cz = (h / lp) * math.log(rc / rp) * (k_over_kc - 1.0)
    total = s_h + s_v + s_wb + s_cz
    return dict(sH=s_h, sV=s_v, sWb=s_wb, sCz=s_cz, total=total,
                rwPrimeM=rw_prime, hM=h, hD=h_d, rpD=rp_d, a=a, b=b, rwD=rw_d)


def productivity_ratio(re, rw, s):
    ln = math.log(re / rw)
    return dict(ratio=ln / (ln + s), lnReRw=ln)


UB_BANDS = [
    (100.0, 'high permeability (k >= 100 mD)', (200, 500), (1000, 2000)),
    (10.0, 'moderate permeability (10 <= k < 100 mD)', (500, 1000), (2000, 5000)),
    (0.0, 'low permeability (k < 10 mD)', (1000, 2000), (5000, 10000)),
]


def underbalance(k_md, fluid):
    for min_k, label, oil, gas in UB_BANDS:
        if k_md >= min_k:
            lo, hi = oil if fluid == 'oil' else gas
            return dict(minPa=lo * PSI, maxPa=hi * PSI, minPsi=lo, maxPsi=hi,
                        classLabel=label, fluid=fluid)
    raise AssertionError('unreachable')


# ------------------------------------------------------------ sand control

def sieve_stats(points):
    """points: [(size_m, cum_retained_pct)]; log-linear interpolation."""
    pts = sorted(points, key=lambda p: p[1])
    out = {}
    for pct in (10, 40, 50, 70, 90, 95):
        val = None
        for (s1, c1), (s2, c2) in zip(pts, pts[1:]):
            if c1 <= pct <= c2 and c2 > c1:
                f = (pct - c1) / (c2 - c1)
                val = math.exp(math.log(s1) + f * (math.log(s2) - math.log(s1)))
                break
        out[f'd{pct}M'] = val
    cutoff = 44e-6
    fines = None
    for (s1, c1), (s2, c2) in zip(pts, pts[1:]):
        if s2 <= cutoff <= s1:
            f = (math.log(s1) - math.log(cutoff)) / (math.log(s1) - math.log(s2))
            fines = 100.0 - (c1 + f * (c2 - c1))
            break
    if fines is None:
        if pts[0][0] <= cutoff:
            fines = 100.0 - pts[0][1]
        elif pts[-1][0] >= cutoff:
            fines = 100.0 - pts[-1][1]
    out['finesPct'] = fines
    out['uniformity'] = (out['d40M'] / out['d90M']
                         if out['d40M'] and out['d90M'] else None)
    out['sorting'] = (out['d10M'] / out['d95M']
                      if out['d10M'] and out['d95M'] else None)
    return out


GRAVELS = [
    ('8/12', 1680, 2380), ('12/20', 841, 1680), ('16/30', 595, 1190),
    ('20/40', 420, 841), ('30/50', 297, 595), ('40/60', 250, 420),
    ('50/70', 210, 297),
]
SCREEN_GAUGE_THOU = [6, 8, 10, 12, 16, 20, 25]


def saucier(d50):
    lo, hi = 5.0 * d50, 6.0 * d50
    matches = [m for (m, mn, mx) in GRAVELS if lo <= ((mn + mx) / 2.0) * UM <= hi]
    return dict(bandMinM=lo, bandMaxM=hi, matches=matches)


def gp_screen_gauge(gravel_min_um):
    gmin = gravel_min_um * UM
    fits = [t for t in SCREEN_GAUGE_THOU if t * THOU < gmin]
    return max(fits) if fits else None


def advisor(cu, fines):
    if cu < 3 and fines < 2:
        return 'standalone wire-wrap screen viable'
    if cu < 5 and fines < 5:
        return 'standalone premium screen viable'
    if cu < 5 and fines < 10:
        return 'gravel pack'
    return 'gravel pack with fines management / frac-pack evaluation'


def pwf_crit(s1, s2, ucs, boost=1.0):
    return (3.0 * s1 - s2 - boost * ucs) / 2.0


# ------------------------------------------------------------ self-asserts

def self_asserts():
    # Hand-computed 90 deg case.
    r = karakas_tariq(12 * IN, 0.25 * IN, 4 * FT_PER_M, 90, 4.25 * IN)
    assert abs(r['sH'] - (-1.0210)) < 2e-3, r['sH']
    assert abs(r['sV'] - 0.4960) < 2e-3, r['sV']
    assert abs(r['sWb'] - 0.0095) < 5e-4, r['sWb']
    # 0 deg limit.
    r0 = karakas_tariq(12 * IN, 0.25 * IN, 4 * FT_PER_M, 0, 4.25 * IN)
    assert abs(r0['rwPrimeM'] - (12 * IN) / 4.0) < 1e-12
    # Crushed zone.
    base = karakas_tariq(12 * IN, 0.25 * IN, 4 * FT_PER_M, 90, 4.25 * IN,
                         rc=0.75 * IN, k_over_kc=1.0)
    dmg = karakas_tariq(12 * IN, 0.25 * IN, 4 * FT_PER_M, 90, 4.25 * IN,
                        rc=0.75 * IN, k_over_kc=5.0)
    assert base['sCz'] == 0.0 and dmg['sCz'] > 0.0
    # Monotonicity.
    long_p = karakas_tariq(24 * IN, 0.25 * IN, 4 * FT_PER_M, 90, 4.25 * IN)
    assert long_p['total'] < r['total']
    dense = karakas_tariq(12 * IN, 0.25 * IN, 8 * FT_PER_M, 90, 4.25 * IN)
    assert dense['sV'] < r['sV']
    # PR.
    assert abs(productivity_ratio(300.0, 0.108, 0.0)['ratio'] - 1.0) < 1e-12
    assert productivity_ratio(300.0, 0.108, 5.0)['ratio'] < 1.0
    # Sieve on the log-linear synthetic: size(pct) = 1000 um * 10^(-2 pct/100).
    pts = [(1000.0 * UM * 10.0 ** (-2.0 * c / 100.0), float(c))
           for c in range(0, 101, 10)]
    s = sieve_stats(pts)
    assert abs(s['d50M'] - 100.0 * UM) < 1e-12, s['d50M']
    assert abs(s['d10M'] - 1000.0 * UM * 10.0 ** -0.2) < 1e-12
    assert abs(s['uniformity'] - 10.0) < 1e-9, s['uniformity']
    # The CDP sweep visits the interval BOTTOM at every step size, including
    # the ones that do not divide the interval. This is the assertion the
    # old shape would have failed: 2450 to 2550 at 30 m stopped at 2540.
    assert cdp_mds(2450.0, 2550.0, 10.0)[-1] == 2550.0
    assert len(cdp_mds(2450.0, 2550.0, 10.0)) == 11
    assert cdp_mds(2450.0, 2550.0, 30.0)[-1] == 2550.0
    assert len(cdp_mds(2450.0, 2550.0, 30.0)) == 5
    assert cdp_mds(2450.0, 2550.0, 150.0) == [2450.0, 2550.0]
    for st in (7.0, 10.0, 13.0, 25.0, 30.0, 40.0, 99.0, 100.0, 150.0):
        mds = cdp_mds(2450.0, 2550.0, st)
        assert mds[0] == 2450.0 and mds[-1] == 2550.0, (st, mds)
        assert all(b > a for a, b in zip(mds, mds[1:])), (st, mds)
    # Saucier + screen.
    sc = saucier(120.0 * UM)
    assert abs(sc['bandMinM'] - 600e-6) < 1e-12 and abs(sc['bandMaxM'] - 720e-6) < 1e-12
    assert '20/40' in sc['matches'], sc['matches']
    assert gp_screen_gauge(420.0) == 16
    # Sanding closed form, explicit arithmetic.
    s1, s2, ucs = 60e6, 45e6, 40e6
    assert abs(pwf_crit(s1, s2, ucs) - ((180e6 - 45e6 - 40e6) / 2.0)) < 1e-6
    print('self-asserts OK')


# ------------------------------------------------------------ golden

RW = 4.25 * IN  # 8.5" hole
RE = 300.0
K_MD = 50.0
KH_OVER_KV = 3.0

GUN_CASES = [
    dict(key='through-tubing-2-1-8', lpM=15 * IN, rpM=0.15 * IN,
         spfPerM=4 * FT_PER_M, phasingDeg=0,
         rcM=0.15 * IN + 0.5 * IN, kOverKc=5.0),
    dict(key='hsd-4-5-8', lpM=32 * IN, rpM=0.215 * IN,
         spfPerM=12 * FT_PER_M, phasingDeg=45,
         rcM=0.215 * IN + 0.5 * IN, kOverKc=5.0),
]

# A realistic 9-point sieve for the golden (fine sand; d50 ~113 um so the
# Saucier band lands on 20/40, fines 9% so the advisor says gravel pack).
SIEVE = [
    (500.0 * UM, 2.0), (350.0 * UM, 6.0), (250.0 * UM, 14.0),
    (177.0 * UM, 28.0), (125.0 * UM, 45.0), (88.0 * UM, 62.0),
    (62.0 * UM, 78.0), (44.0 * UM, 91.0), (20.0 * UM, 97.0),
]

INTERVAL = dict(topMdM=2450.0, bottomMdM=2550.0)
BOOST = 1.0
STEP = 10.0
RAGGED_STEP = 30.0  # deliberately does not divide the 100 m interval


def cdp_mds(top, bottom, step):
    """The measured depths a sweep must visit.

    Built as a list rather than as a while loop, deliberately: the engine's
    loop and a transcription of it would share any endpoint mistake, and the
    endpoint is exactly where this went wrong. Whole steps from the top, then
    the bottom itself whenever the last whole step falls short of it. The
    interval BOTTOM is always screened.
    """
    n = int(math.floor((bottom - top) / step + 1e-9))
    mds = [top + i * step for i in range(n + 1)]
    if mds[-1] < bottom - 1e-9:
        mds.append(bottom)
    else:
        mds[-1] = bottom
    return mds


def cdp_profile(stations, tvd, sv, shmax, shmin, pp, ucs, geometry,
                top=None, bottom=None, step=None):
    top = INTERVAL['topMdM'] if top is None else top
    bottom = INTERVAL['bottomMdM'] if bottom is None else bottom
    step = STEP if step is None else step
    rows = []
    for m in cdp_mds(top, bottom, step):
        z = tvd_of(stations, m)
        at = lambda arr: float(np.interp(z, tvd, arr))  # noqa: E731
        svz, sxz, snz, ppz, uz = at(sv), at(shmax), at(shmin), at(pp), at(ucs)
        if geometry == 'perf-tunnel':
            s1, s2 = max(svz, sxz), min(svz, sxz)
        else:
            s1, s2 = sxz, snz
        pc = pwf_crit(s1, s2, uz, BOOST)
        rows.append(dict(mdM=m, tvdM=z, ppPa=ppz, pwfCritPa=pc, cdpPa=ppz - pc))
    governing = min(rows, key=lambda r: r['cdpPa'])
    return rows, governing


def main():
    self_asserts()
    tvd, sv, pp, dt = make_profile()
    shmin, shmax, clamped = horizontal_stresses(
        sv, pp, PARAMS['nu'], PARAMS['alphaBiot'], PARAMS['ePa'],
        PARAMS['epsX'], PARAMS['epsY'], PARAMS['frictionAngleDeg'],
        PARAMS['regime'])
    ucs = ucs_horsrud(dt)
    stations, shoe, td = WELLS['slant']

    guns = []
    for g in GUN_CASES:
        kt = karakas_tariq(g['lpM'], g['rpM'], g['spfPerM'], g['phasingDeg'],
                           RW, KH_OVER_KV, g['rcM'], g['kOverKc'])
        pr = productivity_ratio(RE, RW, kt['total'])
        guns.append(dict(inputs=dict(g, rwM=RW, khOverKv=KH_OVER_KV),
                         expected=dict(skin=kt, pr=pr)))

    stats = sieve_stats(SIEVE)
    sauc = saucier(stats['d50M'])
    gauge = None
    if sauc['matches']:
        gravel_min_um = next(mn for (m, mn, mx) in GRAVELS
                             if m == sauc['matches'][0])
        gauge = gp_screen_gauge(gravel_min_um)
    ind = advisor(stats['uniformity'], stats['finesPct'])

    cdp = {}
    for geometry in ('perf-tunnel', 'openhole'):
        rows, governing = cdp_profile(stations, tvd, sv, shmax, shmin, pp,
                                      ucs, geometry)
        cdp[geometry] = dict(rows=rows, governing=governing)

    # A step that does NOT divide the interval. The golden's own 10 m step
    # divides 100 m evenly, so it cannot tell an endpoint-inclusive sweep
    # from one that stops at the last whole step. This case can.
    ragged_rows, ragged_gov = cdp_profile(stations, tvd, sv, shmax, shmin, pp,
                                          ucs, 'perf-tunnel', step=RAGGED_STEP)
    ragged = dict(stepMdM=RAGGED_STEP, rows=ragged_rows, governing=ragged_gov,
                  interval=INTERVAL, geometry='perf-tunnel')

    # The sanding closed-form fixture (self-asserted above).
    fixture = dict(inputs=dict(s1Pa=60e6, s2Pa=45e6, ucsPa=40e6, boostFactor=1.0),
                   expected=dict(pwfCritPa=pwf_crit(60e6, 45e6, 40e6)))

    write('perfsand_cases.json', {
        'description': 'Perforation & sand control oracle: independent '
                       'Karakas-Tariq (SPE 18247 tables), radial-flow PR, '
                       'underbalance guideline bands, sieve statistics, '
                       'Saucier gravel sizing, gravel-pack screen gauge, '
                       'Tiffin-style advisor and Kirsch sanding-onset CDP '
                       'sweep on the D5 geomech profile. JS engine must '
                       'agree rtol 1e-9 (same published constants; '
                       'independent implementation).',
        'params': {'rwM': RW, 'reM': RE, 'kMd': K_MD,
                   'khOverKv': KH_OVER_KV, 'boostFactor': BOOST,
                   'stepMdM': STEP, 'interval': INTERVAL},
        'profile': {'tvdM': tvd, 'svPa': sv, 'ppPa': pp, 'dtUsPerM': dt,
                    'shminPa': shmin, 'shmaxPa': shmax, 'ucsPa': ucs,
                    'clampedCount': clamped},
        'stations': [{'md': m, 'inc': i, 'azi': a} for m, i, a in stations],
        'guns': guns,
        'underbalance': {'inputs': {'kMd': K_MD},
                         'oil': underbalance(K_MD, 'oil'),
                         'gas': underbalance(K_MD, 'gas')},
        'sieve': {'points': [{'sizeM': s, 'cumRetainedPct': c} for s, c in SIEVE],
                  'expected': stats},
        'gravel': {'expected': sauc,
                   'screenGaugeThou': gauge,
                   'advisorIndication': ind},
        'sanding': {'fixture': fixture, 'cdp': cdp, 'cdpRagged': ragged},
    })


if __name__ == '__main__':
    main()
