#!/usr/bin/env python3
"""Oracle for engines/downstream/lpgCng.js (MD4-0).

WHAT IS INDEPENDENT HERE AND WHAT IS NOT, said plainly.

 1. Z. DAK (Dranchuk and Abou-Kassem 1975) is solved by BISECTION on the
    reduced density, where the engine uses Newton, from Sutton (1985)
    pseudo-criticals. The eleven DAK coefficients and Sutton's six are the
    method spec as the package documents it and as the production oracles
    (oracle_gaslift.py) carry it; the 1975 and 1985 papers are not in this
    repository, so the COEFFICIENTS ARE PINNED, NOT VALIDATED. As a
    plausibility check that is not a golden, Z is also computed by a
    DIFFERENT CORRELATION, Hall and Yarborough (1973), and the two must
    agree to 1.5 percent at every CNG storage state used here.
 2. THE CASCADE is simulated as a mass LEDGER: each vehicle equalises with
    the lowest bank above it, the common pressure found by the Illinois
    false-position method on the conserved mass (the engine bisects), then
    the next bank up; the vehicle stops at its target. The golden asserts
    CONSERVATION (stored = delivered + left in the banks) as well as the
    count. It is isothermal, as the engine is: fast-fill heating is not
    modelled by either, and the course must say so.
 3. QUEUES by the EXACT Erlang C factorial form in rational arithmetic on
    the positions wholly working (the floor), where the engine uses the
    Erlang B recursion through rackQueue.
 4. LEDGERS for the blend (volume to mass through the densities, moles
    through the molar masses), storage (both fill-ratio bases), the
    vaporizer's three terms, the asset float (Little's law) and the
    conversion case.
 5. THE COMPRESSION TRAIN'S THERMODYNAMICS are engines/facilities/
    compression.js, validated in FC3-0 (tools/validation/facilities/
    oracle_compression.py, FINDINGS-rotating.md). Only the UNIT BRIDGE is
    checked here: kg/h to MMscfd through the molar mass and 379.49
    scf/lbmol, and bar(a) to psia.
 6. PINNED, NOT VALIDATED: the typical LPG densities and latent heats (a
    labelled reference the cases pass in), water at 15 C (999.1 kg/m3) for
    a filling density stated on water capacity.

The first case of every block is the Suite page's default (src/contexts/
LpgCngContext.jsx) where the page has one.

stdlib only. Writes test-data/downstream/goldens/lpgcng_cases.json
"""

import json
import math
import os
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'lpgcng_cases.json')

A = [0.3265, -1.0700, -0.5339, 0.01569, -0.05165, 0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.7210]
PSI_PER_BAR = 14.503773773
AIR_MW = 28.9625
R_SI = 8.3144626


def sutton(sg):
    return 169.2 + 349.5 * sg - 74.0 * sg * sg, 756.8 - 131.0 * sg - 3.6 * sg * sg


def dak_z(ppr, tpr):
    t1 = A[0] + A[1] / tpr + A[2] / tpr ** 3 + A[3] / tpr ** 4 + A[4] / tpr ** 5
    t2 = A[5] + A[6] / tpr + A[7] / tpr ** 2
    t3 = A[8] * (A[6] / tpr + A[7] / tpr ** 2)
    c = 0.27 * ppr / tpr

    def z_of(r):
        return (1 + t1 * r + t2 * r * r - t3 * r ** 5
                + A[9] * (1 + A[10] * r * r) * (r * r / tpr ** 3) * math.exp(-A[10] * r * r))
    lo, hi = 0.0, 3.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if z_of(mid) * mid - c > 0:
            hi = mid
        else:
            lo = mid
    return z_of((lo + hi) / 2)


def hall_yarborough_z(ppr, tpr):
    t = 1 / tpr
    a = 0.06125 * t * math.exp(-1.2 * (1 - t) ** 2)
    b = t * (14.76 - 9.76 * t + 4.58 * t * t)
    c = t * (90.7 - 242.2 * t + 42.4 * t * t)
    d = 2.18 + 2.82 * t

    def f(y):
        return -a * ppr + (y + y * y + y ** 3 - y ** 4) / (1 - y) ** 3 - b * y * y + c * y ** d
    lo, hi = 1e-12, 0.9
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(mid) > 0:
            hi = mid
        else:
            lo = mid
    return a * ppr / ((lo + hi) / 2)


def z_at(p_bar, t_c, sg):
    tpc, ppc = sutton(sg)
    ppr = p_bar * PSI_PER_BAR / ppc
    tpr = (t_c * 9 / 5 + 32 + 459.67) / tpc
    return dak_z(ppr, tpr), ppr, tpr


def mass(v, p, t_c, sg):
    z, _, _ = z_at(p, t_c, sg)
    return p * 1e5 * v * sg * AIR_MW / (z * R_SI * 1000 * (t_c + 273.15))


def illinois(f, a, b):
    fa, fb = f(a), f(b)
    side = 0
    for _ in range(200):
        c = (a * fb - b * fa) / (fb - fa)
        fc = f(c)
        if abs(fc) < 1e-12 or abs(b - a) < 1e-13:
            return c
        if fc * fb > 0:
            b, fb = c, fc
            if side == -1:
                fa /= 2
            side = -1
        else:
            a, fa = c, fc
            if side == 1:
                fb /= 2
            side = 1
    return c


def cascade(banks, v_tank, p_start, p_target, t_c, sg, max_fills=500):
    m = lambda v, p: mass(v, p, t_c, sg)  # noqa: E731
    per_fill = m(v_tank, p_target) - m(v_tank, p_start)
    state = [dict(b, cur=b['pressureBar']) for b in banks]
    stored = sum(m(b['volumeM3'], b['pressureBar']) for b in banks)
    fills, reach = 0, None
    while fills < max_fills:
        before = [b['cur'] for b in state]
        pv = p_start
        for b in sorted(state, key=lambda x: x['cur']):
            if pv >= p_target - 1e-9:
                break
            if b['cur'] <= pv + 1e-9:
                continue
            total = m(b['volumeM3'], b['cur']) + m(v_tank, pv)
            peq = illinois(lambda p: m(b['volumeM3'], p) + m(v_tank, p) - total, pv, b['cur'])
            if peq >= p_target:
                take = m(v_tank, p_target) - m(v_tank, pv)
                goal = m(b['volumeM3'], b['cur']) - take
                b['cur'] = illinois(lambda p: m(b['volumeM3'], p) - goal, 1e-6, b['cur'])
                pv = p_target
            else:
                b['cur'] = peq
                pv = peq
        if pv < p_target - 1e-6:
            for b, p in zip(state, before):
                b['cur'] = p
            reach = pv
            break
        fills += 1
    left = sum(m(b['volumeM3'], b['cur']) for b in state)
    delivered = fills * per_fill
    assert abs(stored - delivered - left) < 1e-6 * stored, (stored, delivered, left)
    return {'kgPerFill': per_fill, 'fillsBeforeRecharge': fills, 'deliveredKg': delivered, 'storedKg': stored,
            'leftInBanksKg': left, 'cascadeEfficiency': delivered / stored,
            'endBar': [b['cur'] for b in state], 'nextVehicleReachesBar': reach}


def erlang_c(lam, load_min, c):
    lam = F(str(lam))
    mu = F(60) / F(str(load_min))
    a = lam / mu
    if a >= c:
        return {'stable': False, 'utilisation': float(a / c)}
    term = lambda k: a ** k / math.factorial(k)  # noqa: E731
    top = term(c) * F(c) / (c - a)
    pw = top / (sum(term(k) for k in range(c)) + top)
    wq = pw / (c * mu - lam)
    return {'stable': True, 'utilisation': float(a / c), 'probabilityOfWaiting': float(pw),
            'averageWaitMinutes': float(wq * 60), 'queueLength': float(lam * wq)}


def blend(comps):
    v = [F(str(c['volumeFraction'])) for c in comps]
    tv = sum(v)
    v = [x / tv for x in v]
    rho = [F(str(c['liquidDensityKgM3'])) for c in comps]
    mass_ = [x * r for x, r in zip(v, rho)]          # kg per m3 of blend
    tm = sum(mass_)
    w = [x / tm for x in mass_]
    moles = [x / F(str(c['molarMassKgKmol'])) for x, c in zip(mass_, comps)]
    return {'densityKgM3': float(tm), 'massFractions': [float(x) for x in w],
            'latentHeatKJkg': float(sum(x * F(str(c['latentHeatKJkg'])) for x, c in zip(w, comps))),
            'molarMassKgKmol': float(tm / sum(moles))}


WATER_KG_M3 = F('999.1')


def storage(cap, fill, basis, rho, demand, lead, safety, load):
    """The LPG storage ledger on either fill-ratio basis: liquid volume
    (capacity x fill x density) or water capacity by mass (capacity x 999.1
    x fill), then the cover, the reorder point and the ullage. Exported in
    MD45-1 (it lived inside main())."""
    cap, fill, rho = F(str(cap)), F(str(fill)), F(str(rho))
    demand, lead, safety, load = F(str(demand)), F(str(lead)), F(str(safety)), F(str(load))
    usable_t = cap * fill * rho / 1000 if basis == 'liquid_volume' else cap * WATER_KG_M3 * fill / 1000
    reorder = demand * (lead + safety)
    return {'usableTonnes': float(usable_t), 'usableM3': float(usable_t * 1000 / rho),
            'coverDays': float(usable_t / demand), 'reorderAtTonnes': float(reorder),
            'ullageAtReorderTonnes': float(usable_t - reorder), 'deliveryFitsUllage': load <= usable_t - reorder}


def vaporizer(m, cpl, tin, tbp, lat, cpv, tout, margin):
    """The vaporizer ledger: warm the liquid to its boiling point at the
    vaporizer pressure, boil it, superheat the vapour, then the design
    margin. kW. Exported in MD45-1 (it lived inside main())."""
    terms = [m * cpl * (tbp - tin), m * lat, m * cpv * (tout - tbp)]
    return {'termsKW': [t / 3600 for t in terms], 'dutyKW': sum(terms) / 3600,
            'designDutyKW': sum(terms) / 3600 * (1 + margin / 100)}


def conversion(km, base_consumption, base_price, base_energy, new_price, new_energy, efficiency_ratio,
               conversion_cost, extra_maintenance):
    """The conversion ledger by energy equivalence: the new fuel's
    consumption from the base fuel's energy over the new fuel's energy and
    the efficiency ratio, the two fuel bills, the saving and the simple
    payback. Exported in MD45-1 (it lived inside main())."""
    nc = F(str(base_consumption)) * F(str(base_energy)) / (F(str(new_energy)) * F(str(efficiency_ratio)))
    km = F(str(km))
    base_cost = F(str(base_consumption)) / 100 * km * F(str(base_price))
    new_cost = nc / 100 * km * F(str(new_price))
    saving = base_cost - new_cost - F(str(extra_maintenance))
    return {'newFuelConsumptionPer100Km': float(nc), 'annualSaving': float(saving),
            'simplePaybackYears': float(F(str(conversion_cost)) / saving) if saving > 0 else None,
            'savingPerKm': float(saving / km)}


def main():
    page_lpg = [
        {'code': 'propane', 'volumeFraction': 0.4, 'liquidDensityKgM3': 508, 'molarMassKgKmol': 44.096, 'latentHeatKJkg': 425},
        {'code': 'butane', 'volumeFraction': 0.6, 'liquidDensityKgM3': 584, 'molarMassKgKmol': 58.122, 'latentHeatKJkg': 385},
    ]
    blends = [{'name': 'Suite default 40/60 by volume', 'components': page_lpg, **blend(page_lpg)},
              {'name': 'commercial propane 95/5', 'components': [dict(page_lpg[0], volumeFraction=0.95), dict(page_lpg[1], volumeFraction=0.05)],
               **blend([dict(page_lpg[0], volumeFraction=0.95), dict(page_lpg[1], volumeFraction=0.05)])}]
    rho = blends[0]['densityKgM3']

    stores = []
    for name, fill, basis in [('page vessel, 0.85 of the liquid volume', 0.85, 'liquid_volume'),
                              ('page vessel, a 0.42 filling density on water capacity', 0.42, 'water_capacity_mass')]:
        stores.append({'name': name, 'vesselCapacityM3': 100, 'maxFillRatio': fill, 'fillRatioBasis': basis,
                       'liquidDensityKgM3': rho, 'demandTonnesPerDay': 6, 'leadTimeDays': 3, 'safetyDays': 2,
                       'deliveryTonnes': 15, **storage(100, fill, basis, rho, 6, 3, 2, 15)})

    lat = blends[0]['latentHeatKJkg']
    m_, cpl, tin, tbp, cpv, tout, marg = 500, 2.5, 5, 12, 1.7, 30, 20
    vap = {'name': 'boiling point 12 C at the vaporizer pressure, inlet 5 C',
           'massFlowKgHr': m_, 'latentHeatKJkg': lat, 'liquidCpKJkgK': cpl, 'inletTempC': tin,
           'boilingPointC': tbp, 'vapourCpKJkgK': cpv, 'outletTempC': tout, 'designMarginPercent': marg,
           **vaporizer(m_, cpl, tin, tbp, lat, cpv, tout, marg)}
    vaporizer_before = {'name': 'the page default: inlet 25 C against n-butane atmospheric -0.5 C',
                        'mainDutyKW': (500 * 2.5 * (-0.5 - 25) + 500 * lat + 500 * 1.7 * (15 + 0.5)) / 3600,
                        'latentAloneKW': 500 * lat / 3600}

    bottling = []
    for name, cyl, fill, pos, hrs, av in [('Suite default: 16 positions at 0.9', 2400, 2.5, 16, 8, 0.9),
                                          ('14.55 working: the floor is 14, rounding said 15', 2200, 2.5, 15, 8, 0.97)]:
        eff = F(pos) * F(str(av))
        c = math.floor(eff)
        bottling.append({'name': name, 'cylindersPerDay': cyl, 'fillMinutesPerCylinder': fill, 'positions': pos,
                         'shiftHoursPerDay': hrs, 'availabilityFraction': av, 'queuePositions': c,
                         'effectivePositions': float(eff), **erlang_c(F(cyl) / hrs, fill, c),
                         'throughputCapacityPerDay': float(eff * hrs * 60 / F(str(fill)))})

    dispensing = [{'name': 'Suite default: 12 an hour, 5 minutes, 2 dispensers', 'vehiclesPerHour': 12,
                   'fillMinutes': 5, 'dispensers': 2, **erlang_c(12, 5, 2)}]

    floats = []
    for name, rate, stages, spares in [
        ('Suite cylinder float', 2400, [21, 1, 2, 1], 0.1),
        ('Suite trailer float', 3, [0.25, 0.4, 1.2, 0.4], 0.15),
    ]:
        cyc = sum(F(str(d)) for d in stages)
        circ = F(rate) * cyc
        sp = circ * F(str(spares))
        floats.append({'name': name, 'unitsPerDay': rate, 'stageDays': stages, 'sparesFraction': spares,
                       'cycleDays': float(cyc), 'inCirculation': float(circ), 'sparesAllowance': float(sp),
                       'fleetRequired': math.ceil(circ + sp)})

    vessels = []
    for v, p, t, sg in [(1.5, 250, 15, 0.6), (0.08, 200, 15, 0.6), (1.0, 100, 30, 0.65)]:
        z, ppr, tpr = z_at(p, t, sg)
        hy = hall_yarborough_z(ppr, tpr)
        assert abs(hy / z - 1) < 0.015, (p, z, hy)
        ideal = p * 1e5 * v * sg * AIR_MW / (R_SI * 1000 * (t + 273.15))
        vessels.append({'volumeM3': v, 'pressureBar': p, 'temperatureC': t, 'gasSg': sg, 'z': z,
                        'hallYarboroughZ': hy, 'massKg': ideal / z, 'idealMassKg': ideal})

    page_banks = [{'label': 'Low', 'volumeM3': 1.5, 'pressureBar': 250}, {'label': 'Mid', 'volumeM3': 1.5, 'pressureBar': 250},
                  {'label': 'High', 'volumeM3': 1.5, 'pressureBar': 250}]
    cascades = []
    for name, banks, v, ps, pt in [
        ('Suite default: three 1.5 m3 banks at 250, a 0.08 m3 vehicle 20 to 200', page_banks, 0.08, 20, 200),
        ('a staged cascade: 150, 220, 280', [dict(page_banks[0], pressureBar=150), dict(page_banks[1], pressureBar=220),
                                             dict(page_banks[2], pressureBar=280)], 0.08, 20, 200),
        ('banks at 180 cannot finish a 200 fill', [dict(b, pressureBar=180) for b in page_banks], 0.08, 20, 200),
    ]:
        cascades.append({'name': name, 'banks': banks, 'vehicleTankM3': v, 'vehicleStartBar': ps,
                         'vehicleTargetBar': pt, 'temperatureC': 15, 'gasSg': 0.6,
                         **cascade(banks, v, ps, pt, 15, 0.6)})
    main_before = {'fillsBeforeRecharge': 10, 'cascadeEfficiency': 0.138689,
                   'note': 'origin/main counted only gas above the vehicle target as deliverable'}

    kg_h, sg = 250, 0.6
    q = kg_h / (sg * AIR_MW) * (379.49 / 0.45359237) * 24 / 1e6
    compression = {'throughputKgPerHour': kg_h, 'gasSg': sg, 'suctionBar': 4, 'dischargeBar': 250,
                   'qMMscfd': q, 'suctionPsia': 4 * PSI_PER_BAR}

    conv = []
    for name, eff in [('Suite default, energy equivalence at a ratio of 1', 1), ('a converted engine at 0.9', 0.9)]:
        km, bc, bp, be, np_, ne, capex, maint = 40000, 12, 950, 32, 500, 48, 900000, 40000
        conv.append({'name': name, 'efficiencyRatio': eff, **conversion(km, bc, bp, be, np_, ne, eff, capex, maint)})

    doc = {
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_lpgcng.py',
            'method': 'DAK by bisection (Hall-Yarborough as a plausibility check); a cascade mass ledger by false position; exact Erlang C; ledgers',
            'engine': 'engines/downstream/lpgCng.js',
            'published': 'none validated: DAK and Sutton coefficients pinned as the package method spec; LPG properties are the engine\'s labelled typical table',
        },
        'blends': blends, 'storage': stores, 'vaporizer': vap, 'vaporizerBefore': vaporizer_before,
        'bottling': bottling, 'dispensing': dispensing, 'floats': floats, 'vessels': vessels,
        'cascades': cascades, 'cascadeMainBefore': main_before, 'compression': compression, 'conversion': conv,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    for c in cascades:
        print(c['name'], c['fillsBeforeRecharge'], round(c['cascadeEfficiency'], 6), [round(x, 3) for x in c['endBar']], c['nextVehicleReachesBar'])
    for v in vessels:
        print('Z', v['pressureBar'], round(v['z'], 6), 'HY', round(v['hallYarboroughZ'], 6))
    print('vaporizer before', vaporizer_before)


if __name__ == '__main__':
    main()
