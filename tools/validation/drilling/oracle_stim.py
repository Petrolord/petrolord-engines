#!/usr/bin/env python3
"""Independent oracle for the stimulation engines (Drilling D9): PKN/KGD
2D frac geometry, Nolte material balance and pump schedule, propped
conductivity, Cinco-Ley-Samaniego fracture productivity, Hawkins/
sandstone/carbonate acidizing and the max matrix rate. Emits
test-data/drilling/goldens/stim_cases.json.

Independence discipline: one consistent published formula set
(Economides PPS / Valko-Economides / Nolte 1986 / Cinco-Ley &
Samaniego) implemented here with numpy-free explicit arithmetic; the
pump-time fixed point is solved with a DIFFERENT iteration (bisection on
t) than the JS quadratic-in-sqrt(t) fixed point, and the schedule mass
is cross-checked by fine trapezoid integration. Closed forms are
self-asserted BEFORE writing:

  E'        2.5e10 / (1 - 0.28^2) = 2.7126736e10 Pa
  PKN       qi 0.053 m3/s, mu 0.2 Pa.s, xf 150 m -> w_max 6.392e-3 m
            (hand arithmetic), w_avg = (pi/5) w_max
  balance   CL = 0 -> eta = 1 and t = Vf/qi exactly; residual < 1e-9
            at the returned solution; eta decreases with CL
  schedule  f_pad = eps = (1-eta)/(1+eta); closed-form mass = exact
            integral of c_EOJ tau^eps (trapezoid agrees rtol 1e-6);
            c(ti) = c_EOJ
  Cinco-Ley f(1.6) = 1.3841 (hand); f(1000) within 5% of ln 2
            (infinite-conductivity limit); s_f monotone in C_fD
  Hawkins   s = (k/ks - 1) ln(rs/rw) explicit; s_after = 0 at ra >= rs
  carbonate skin negative; q_max Darcy identity

The golden rides the D5 geomech profile (closure = SHMIN, reservoir
pressure = PP at the treatment TVD) and the D1 slant well.

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_stim.py
"""
import math

import numpy as np

from oracle_torquedrag import WELLS, rnd, write  # noqa: F401
from oracle_hydraulics import tvd_of  # noqa: F401
from oracle_geomech import PARAMS, horizontal_stresses, make_profile, ucs_horsrud

DARCY = 9.869233e-13
KPSI = 6.894757293168e6  # 1000 psi
MD_M2 = 9.869233e-16

# ------------------------------------------------------------ frac design


def e_prime(e_pa, nu):
    return e_pa / (1.0 - nu * nu)


def frac_geometry(model, qi, mu, xf, hf, ep, closure=None):
    if model == 'pkn':
        wmax = 2.31 * (qi * mu * xf / ep) ** 0.25
        wavg = (math.pi / 5.0) * wmax
        pnet = ep * wmax / (2.0 * hf)
    else:
        wmax = 3.22 * (qi * mu * xf * xf / (ep * hf)) ** 0.25
        wavg = (math.pi / 4.0) * wmax
        pnet = ep * wmax / (4.0 * xf)
    out = dict(model=model, wMaxM=wmax, wAvgM=wavg, pNetPa=pnet)
    if closure is not None:
        out['closurePa'] = closure
        out['bhtpPa'] = closure + pnet
    return out


def kl_of(eta):
    return ((8.0 / 3.0) * eta + math.pi * (1.0 - eta)) / 2.0


def pump_time(qi, hf, xf, wavg, cl):
    vf = 2.0 * xf * hf * wavg
    if cl == 0.0:
        return dict(tiS=vf / qi, etaFrac=1.0, viM3=vf, vfM3=vf, vlM3=0.0)
    leak_area = 2.0 * (2.0 * xf * hf)

    def residual(t):
        eta = vf / (qi * t)
        return qi * t - vf - kl_of(min(eta, 1.0)) * cl * leak_area * math.sqrt(t)

    lo, hi = vf / qi, vf / qi
    while residual(hi) < 0.0:
        hi *= 2.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if residual(mid) < 0.0:
            lo = mid
        else:
            hi = mid
    t = 0.5 * (lo + hi)
    eta = vf / (qi * t)
    return dict(tiS=t, etaFrac=eta, viM3=qi * t, vfM3=vf, vlM3=qi * t - vf)


def pump_schedule(ti, eta, qi, c_eoj, n_steps=8):
    eps = (1.0 - eta) / (1.0 + eta)
    t_pad = eps * ti
    ramp = ti - t_pad
    steps = []
    for j in range(n_steps):
        tau_mid = (j + 0.5) / n_steps
        steps.append(dict(
            tStartS=t_pad + (j / n_steps) * ramp,
            tEndS=t_pad + ((j + 1) / n_steps) * ramp,
            cKgM3=c_eoj * tau_mid ** eps,
            slurryM3=qi * ramp / n_steps,
        ))
    mass = c_eoj * qi * ramp / (1.0 + eps)
    return dict(eps=eps, padFrac=eps, tPadS=t_pad, rampS=ramp,
                padM3=qi * t_pad, steps=steps, massKg=mass)


def pack_perm(k_table, closure_pa):
    pts = sorted((float(k) * KPSI, d * DARCY) for k, d in k_table.items())
    if closure_pa <= pts[0][0]:
        return pts[0][1]
    if closure_pa >= pts[-1][0]:
        return pts[-1][1]
    for (c1, k1), (c2, k2) in zip(pts, pts[1:]):
        if c1 <= closure_pa <= c2:
            f = (closure_pa - c1) / (c2 - c1)
            return math.exp(math.log(k1) + f * (math.log(k2) - math.log(k1)))
    raise AssertionError('unreachable')


def propped(mass, xf, hf, rho, phi, kf, damage):
    areal = mass / (2.0 * xf * hf)
    wp = areal / (rho * (1.0 - phi))
    return dict(arealKgM2=areal, wpM=wp, kfwM3=kf * wp * damage)


def cinco_ley(kfw, k, xf, rw):
    cfd = kfw / (k * xf)
    u = math.log(cfd)
    f = (1.65 - 0.328 * u + 0.116 * u * u) / (
        1.0 + 0.18 * u + 0.064 * u * u + 0.005 * u ** 3)
    s_f = f - math.log(xf / rw)
    return dict(cfd=cfd, f=f, sF=s_f, rwPrimeM=rw * math.exp(-s_f))


def productivity_ratio(re, rw, s):
    ln = math.log(re / rw)
    return dict(ratio=ln / (ln + s), lnReRw=ln)


# ------------------------------------------------------------ acidizing


def hawkins(k_over_ks, rs, rw):
    return (k_over_ks - 1.0) * math.log(rs / rw)


def sandstone(rw, ra, h, phi, pv_factor, k_over_ks, rs):
    vol = pv_factor * math.pi * (ra * ra - rw * rw) * h * phi
    s_before = hawkins(k_over_ks, rs, rw)
    s_after = 0.0 if ra >= rs else (k_over_ks - 1.0) * math.log(rs / ra)
    return dict(volumeM3=vol, sBefore=s_before, sAfter=s_after, removed=ra >= rs)


def carbonate(rw, h, phi, vol, pv_bt):
    r_wh = math.sqrt(rw * rw + vol / (math.pi * h * phi * pv_bt))
    return dict(rWhM=r_wh, skin=-math.log(r_wh / rw))


def max_rate(k, h, p_frac, p_res, mu, re, rw, s):
    return 2.0 * math.pi * k * h * (p_frac - p_res) / (mu * (math.log(re / rw) + s))


# ------------------------------------------------------------ self-asserts

E_PA, NU = PARAMS['ePa'], PARAMS['nu']
QI, MU, XF, HF = 0.053, 0.2, 150.0, 30.0
CL = 1.0e-4
C_EOJ = 800.0
RW, RE, K_MD = 0.108, 300.0, 1.0
DAMAGE = 0.5
PV_FACTOR = 1.5
PV_BT = 1.0


def self_asserts():
    ep = e_prime(E_PA, NU)
    assert abs(ep - 2.7126736e10) < 2e3, ep
    g = frac_geometry('pkn', QI, MU, XF, HF, ep)
    assert abs(g['wMaxM'] - 6.392e-3) < 5e-6, g['wMaxM']
    assert abs(g['wAvgM'] - (math.pi / 5.0) * g['wMaxM']) < 1e-15
    # KGD width exceeds PKN at short xf/hf ratios, and pnet compliances differ.
    gk = frac_geometry('kgd', QI, MU, XF, HF, ep)
    assert gk['pNetPa'] < g['pNetPa']
    # Material balance.
    b0 = pump_time(QI, HF, XF, g['wAvgM'], 0.0)
    assert b0['etaFrac'] == 1.0 and abs(b0['tiS'] - b0['vfM3'] / QI) < 1e-12
    b = pump_time(QI, HF, XF, g['wAvgM'], CL)
    res = QI * b['tiS'] - b['vfM3'] - kl_of(b['etaFrac']) * CL * 4.0 * XF * HF * math.sqrt(b['tiS'])
    assert abs(res) < 1e-6, res
    b_hi = pump_time(QI, HF, XF, g['wAvgM'], 3.0 * CL)
    assert b_hi['etaFrac'] < b['etaFrac']
    # Schedule.
    sch = pump_schedule(b['tiS'], b['etaFrac'], QI, C_EOJ, 8)
    assert abs(sch['padFrac'] - sch['eps']) < 1e-15
    n = 100000
    eps = sch['eps']
    taus = [i / n for i in range(n + 1)]
    trap = sum((taus[i] ** eps + taus[i + 1] ** eps) / 2.0 for i in range(n)) / n
    mass_trap = C_EOJ * QI * sch['rampS'] * trap
    assert abs(mass_trap - sch['massKg']) < 1e-4 * sch['massKg'], (mass_trap, sch['massKg'])
    assert abs(C_EOJ * 1.0 ** eps - C_EOJ) < 1e-12
    # Cinco-Ley: hand value at the UFD optimum, the infinite-conductivity
    # limit, and monotonicity.
    f16 = cinco_ley(1.6 * MD_M2 * XF, MD_M2, XF, RW)
    u = math.log(1.6)
    f_hand = (1.65 - 0.328 * u + 0.116 * u * u) / (1 + 0.18 * u + 0.064 * u * u + 0.005 * u ** 3)
    assert abs(f16['f'] - f_hand) < 1e-12
    assert abs(f_hand - 1.3841) < 1e-3, f_hand
    big = cinco_ley(1000.0 * MD_M2 * XF, MD_M2, XF, RW)
    assert abs(big['f'] - math.log(2.0)) < 0.05 * math.log(2.0), big['f']
    lo = cinco_ley(1.0 * MD_M2 * XF, MD_M2, XF, RW)
    hi = cinco_ley(10.0 * MD_M2 * XF, MD_M2, XF, RW)
    assert hi['sF'] < lo['sF']
    # Acidizing.
    assert abs(hawkins(5.0, 0.5, 0.1) - 4.0 * math.log(5.0)) < 1e-12
    sa = sandstone(0.1, 0.6, 10.0, 0.2, PV_FACTOR, 5.0, 0.5)
    assert sa['removed'] and sa['sAfter'] == 0.0
    ca = carbonate(0.1, 10.0, 0.2, 5.0, PV_BT)
    assert ca['skin'] < 0.0
    q = max_rate(MD_M2, 10.0, 4.0e7, 3.0e7, 1e-3, RE, RW, 0.0)
    hand = 2.0 * math.pi * MD_M2 * 10.0 * 1.0e7 / (1e-3 * math.log(RE / RW))
    assert abs(q - hand) < 1e-12 * hand
    # Pack permeability interpolates INSIDE the table (the kpsi constant
    # bug guard): ISP at 5 kpsi sits between the 4 and 6 kpsi rows.
    k5 = pack_perm(PROPPANT['kAtClosureDarcy'], 5.0 * KPSI) / DARCY
    assert 120.0 < k5 < 180.0, k5
    print('self-asserts OK')


# ------------------------------------------------------------ golden

PROPPANT = dict(name='20/40 ISP ceramic', rhoKgM3=3270.0, packPorosity=0.35,
                kAtClosureDarcy={'2': 250.0, '4': 180.0, '6': 120.0, '8': 70.0})
INTERVAL = dict(topMdM=2450.0, bottomMdM=2550.0)
ACID = dict(raM=0.6, kOverKs=5.0, rsM=0.9, porosity=0.18, volumeM3=8.0)


def main():
    self_asserts()
    tvd, sv, pp, dt = make_profile()
    shmin, shmax, clamped = horizontal_stresses(
        sv, pp, PARAMS['nu'], PARAMS['alphaBiot'], PARAMS['ePa'],
        PARAMS['epsX'], PARAMS['epsY'], PARAMS['frictionAngleDeg'],
        PARAMS['regime'])
    ucs = ucs_horsrud(dt)
    stations, shoe, td = WELLS['slant']

    mid_md = 0.5 * (INTERVAL['topMdM'] + INTERVAL['bottomMdM'])
    z = tvd_of(stations, mid_md)
    closure = float(np.interp(z, tvd, shmin))
    p_res = float(np.interp(z, tvd, pp))

    ep = e_prime(E_PA, NU)
    geo = {m: frac_geometry(m, QI, MU, XF, HF, ep, closure) for m in ('pkn', 'kgd')}
    bal = pump_time(QI, HF, XF, geo['pkn']['wAvgM'], CL)
    sch = pump_schedule(bal['tiS'], bal['etaFrac'], QI, C_EOJ, 8)
    kf = pack_perm(PROPPANT['kAtClosureDarcy'], closure)
    prop = propped(sch['massKg'], XF, HF, PROPPANT['rhoKgM3'],
                   PROPPANT['packPorosity'], kf, DAMAGE)
    prod = cinco_ley(prop['kfwM3'], K_MD * MD_M2, XF, RW)
    pr = productivity_ratio(RE, RW, prod['sF'])

    h_acid = INTERVAL['bottomMdM'] - INTERVAL['topMdM']
    sand_case = sandstone(RW, ACID['raM'], h_acid, ACID['porosity'],
                          PV_FACTOR, ACID['kOverKs'], ACID['rsM'])
    carb_case = carbonate(RW, h_acid, ACID['porosity'], ACID['volumeM3'], PV_BT)
    qmax = max_rate(K_MD * MD_M2, h_acid, closure, p_res, 1e-3, RE, RW,
                    sand_case['sBefore'])

    write('stim_cases.json', {
        'description': 'Stimulation oracle: PKN/KGD widths (PPS formula '
                       'set), Nolte material balance (bisection here vs '
                       'the JS fixed point), Nolte pad/ramp schedule, '
                       'proppant pack interp, Cinco-Ley-Samaniego '
                       'productivity, Hawkins/sandstone/carbonate '
                       'acidizing and the Darcy matrix-rate ceiling on '
                       'the D5 geomech profile. JS engine must agree '
                       'rtol 1e-9 (same published constants; independent '
                       'implementation).',
        'params': {
            'ePa': E_PA, 'nu': NU, 'ePrimePa': ep, 'qiM3s': QI, 'muPaS': MU,
            'xfM': XF, 'hfM': HF, 'clMSqrtS': CL, 'cEojKgM3': C_EOJ,
            'nSteps': 8, 'damageFactor': DAMAGE, 'kMd': K_MD, 'reM': RE,
            'rwM': RW, 'pvFactor': PV_FACTOR, 'pvBt': PV_BT,
            'interval': INTERVAL, 'midMdM': mid_md, 'midTvdM': z,
            'closurePa': closure, 'pResPa': p_res, 'proppant': PROPPANT,
            'acid': {'raM': ACID['raM'], 'kOverKs': ACID['kOverKs'],
                     'rsM': ACID['rsM'], 'porosity': ACID['porosity'],
                     'volumeM3': ACID['volumeM3'], 'hM': h_acid},
        },
        'profile': {'tvdM': tvd, 'svPa': sv, 'ppPa': pp, 'dtUsPerM': dt,
                    'shminPa': shmin, 'shmaxPa': shmax, 'ucsPa': ucs,
                    'clampedCount': clamped},
        'stations': [{'md': m, 'inc': i, 'azi': a} for m, i, a in stations],
        'geometry': geo,
        'balance': bal,
        'schedule': sch,
        # Permeabilities/conductivities in darcy units: SI values here are
        # < 1e-9 and would be destroyed by the golden's 9-decimal rounding.
        'proppantPack': {'kfDarcy': kf / DARCY, 'arealKgM2': prop['arealKgM2'],
                         'wpM': prop['wpM'], 'kfwDarcyM': prop['kfwM3'] / DARCY},
        'productivity': {**prod, 'pr': pr},
        'acidizing': {'sandstone': sand_case, 'carbonate': carb_case,
                      'qMaxM3s': qmax},
    })


if __name__ == '__main__':
    main()
