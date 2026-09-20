#!/usr/bin/env python3
"""Oracle for engines/downstream/energyEfficiency.js (MD5-0).

WHAT IS INDEPENDENT HERE AND WHAT IS NOT, said plainly.

 1. COMBUSTION is a SPECIES LEDGER in exact rationals: one balanced reaction
    per fuel component, summed, and then a MASS BALANCE that must close:
    fuel + air in equals flue gas out, to the gram. Product molar masses are
    BUILT from the IUPAC conventional atomic weights (C 12.011, H 1.008,
    O 15.999, N 14.007, S 32.06), and air's non-oxygen part ("atmospheric
    nitrogen", with its argon) takes the molar mass that makes air's own
    mass balance close. The engine carried argon at the molar mass of N2 and
    the balance did not close (finding E8).
 2. EXCESS AIR is found by BISECTION on the full dry flue gas composition
    until its oxygen matches the reading. The engine solves a closed form.
 3. EFFICIENCY is a loss ledger built from each flue gas species' mass;
    the fuel SAVING is a duty ledger (fuel = duty / efficiency, for a fixed
    duty), never a formula for the fraction.
 4. THE STEAM TRAP is an ISENTROPIC NOZZLE: throat pressure, throat density
    and throat sound speed, then G = Cd rho* a*. The engine uses the
    collapsed choked-flux formula.
 5. PINCH TARGETS are found WITHOUT A CASCADE: the minimum hot utility is
    the largest heat DEFICIT above any shifted temperature, (cold duty above
    T) minus (hot duty above T), over every candidate T. The engine cascades
    the Problem Table.
 6. THE COST PER TONNE handed to the Carbon Studio is levelised from a PV
    ledger, as in oracle_carbonabatement.py.

WHAT IS PUBLISHED, AND WHERE IT WAS CHECKED (see FINDINGS-carbon.md):
  - O2 in dry air 0.20946 and air 28.9647 kg/kmol: Engineering ToolBox, Air
    composition (reached). US Standard Atmosphere 1976 quotes 0.209476 and
    28.9644 (not reached). PINNED to the engine's values.
  - Water: CODATA dHf gas -241.826, liquid -285.830 kJ/mol (NIST WebBook,
    reached), so the latent heat at 25 C is 44.004 kJ/mol = 2442.6 kJ/kg.
  - Methane dHc -890.7 +/- 0.4 kJ/mol (Pittam and Pilcher 1972, NIST WebBook,
    reached). The other heating values (ISO 6976) were NOT reached.
  - Every cost, Cd, radiation loss and emission factor in these cases is
    SYNTHETIC and says so.

The first cases are the Suite page defaults (src/contexts/
EnergyEfficiencyContext.jsx), with the page's required-but-blank boxes
filled with labelled synthetic values.

stdlib only. Writes test-data/downstream/goldens/energyefficiency_cases.json
"""

import json
import math
import os
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'energyefficiency_cases.json')

AW = {'C': F('12.011'), 'H': F('1.008'), 'O': F('15.999'), 'N': F('14.007'), 'S': F('32.06')}
M = {
    'CO2': AW['C'] + 2 * AW['O'], 'H2O': 2 * AW['H'] + AW['O'], 'SO2': AW['S'] + 2 * AW['O'],
    'N2': 2 * AW['N'], 'O2': 2 * AW['O'],
}
X_O2 = F('0.20946')
M_AIR = F('28.9647')
M['N2atm'] = (M_AIR - X_O2 * M['O2']) / (1 - X_O2)

# name: (c, h, o, s, n, molar mass, LHV, HHV). Since MD45-1 the molar mass
# is BUILT from the atom counts and the atomic weights below (the engine
# builds its table the same way); the table's 44.096, 58.122 and CO2 44.010
# came from older atomic weights and kept the mass balance from closing.
REF = {
    'CH4': (1, 4, 0, 0, 0, F('16.043'), F('802.6'), F('890.8')),
    'C2H6': (2, 6, 0, 0, 0, F('30.070'), F('1428.6'), F('1560.7')),
    'C3H8': (3, 8, 0, 0, 0, F('44.096'), F('2043.1'), F('2219.2')),
    'C4H10': (4, 10, 0, 0, 0, F('58.122'), F('2657.3'), F('2877.5')),
    'H2': (0, 2, 0, 0, 0, F('2.016'), F('241.8'), F('285.8')),
    'CO2': (1, 0, 2, 0, 0, F('44.010'), F(0), F(0)),
    'N2': (0, 0, 0, 0, 2, F('28.014'), F(0), F(0)),
}


REF = {k: v[:5] + (v[0] * AW['C'] + v[1] * AW['H'] + v[2] * AW['O'] + v[3] * AW['S'] + v[4] * AW['N'],) + v[6:]
       for k, v in REF.items()}


def fl(x):
    return None if x is None else float(x)


def species_ledger(fuel):
    """fuel: list of (code, mole fraction). Returns per kmol of fuel."""
    tot = sum(F(str(y)) for _, y in fuel)
    o2 = co2 = h2o = so2 = n2f = F(0)
    lhv = hhv = mass = F(0)
    for code, y in fuel:
        y = F(str(y)) / tot
        c, h, o, s, n, mm, lo, hi = REF[code]
        # CcHhOoSsNn + (c + h/4 + s - o/2) O2 -> c CO2 + h/2 H2O + s SO2 + n/2 N2
        o2 += y * (c + F(h, 4) + s - F(o, 2))
        co2 += y * c
        h2o += y * F(h, 2)
        so2 += y * s
        n2f += y * F(n, 2)
        lhv += y * lo
        hhv += y * hi
        mass += y * mm
    air = o2 / X_O2
    return {'o2': o2, 'air': air, 'co2': co2, 'h2o': h2o, 'so2': so2, 'n2fuel': n2f,
            'n2air': air * (1 - X_O2), 'lhv': lhv, 'hhv': hhv, 'fuelMass': mass}


def flue(st, e):
    dry = {'CO2': st['co2'], 'SO2': st['so2'], 'N2fuel': st['n2fuel'],
           'N2atm': st['n2air'] * (1 + e), 'O2': st['o2'] * e}
    return dry


def o2_fraction(st, e):
    d = flue(st, e)
    return d['O2'] / sum(d.values())


def excess_by_bisection(st, pct):
    target = F(str(pct)) / 100
    lo, hi = F(0), F(50)
    for _ in range(200):
        mid = (lo + hi) / 2
        if o2_fraction(st, mid) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def masses(st, e):
    d = flue(st, e)
    dry_kg = (d['CO2'] * M['CO2'] + d['SO2'] * M['SO2'] + d['N2fuel'] * M['N2']
              + d['N2atm'] * M['N2atm'] + d['O2'] * M['O2'])
    wet_kg = dry_kg + st['h2o'] * M['H2O']
    air_kg = st['air'] * (1 + e) * M_AIR
    return dry_kg, wet_kg, air_kg


def efficiency(st, o2pct, heater, basis):
    e = excess_by_bisection(st, o2pct)
    dry_kg, _, _ = masses(st, e)
    h2o_kg = st['h2o'] * M['H2O']
    ts, ta, tref = F(str(heater['stackTempC'])), F(str(heater['combustionAirTempC'])), F(25)
    cp, cpv, hfg = F(str(heater['flueGasCpKJkgK'])), F(str(heater['waterVapourCpKJkgK'])), F(str(heater['waterLatentHeatKJkg']))
    hv = (st['hhv'] if basis == 'HHV' else st['lhv']) * 1000
    dry = dry_kg * cp * (ts - ta) / hv * 100
    moist = h2o_kg * ((hfg if basis == 'HHV' else 0) + cpv * (ts - tref)) / hv * 100
    rad = F(str(heater['radiationLossPercent']))
    unb = F(str(heater.get('unburnedLossPercent', 0)))
    return {'excessAirFraction': e, 'dry': dry, 'moisture': moist, 'eff': 100 - dry - moist - rad - unb}


ATMOSPHERE_BAR_A = 1.01325  # 101,325 Pa by definition


def trap_nozzle(d_mm, p_bar, cd, rho, k, hours, p_down_bar=ATMOSPHERE_BAR_A):
    """An isentropic nozzle from stagnation (p0, rho0). The throat sits at the
    larger of the downstream pressure and the critical pressure; the throat
    density follows the isentrope and the velocity the enthalpy drop,
    v = sqrt(2 k/(k-1) p0/rho0 (1 - (pt/p0)^((k-1)/k))). At the critical
    pressure v is the throat sound speed. The engine uses the collapsed
    choked-flux formula and, since MD45-1, the collapsed subsonic one."""
    d_mm, p, cd, rho, k, pd = (float(x) for x in (d_mm, p_bar, cd, rho, k, p_down_bar))
    p0 = p * 1e5
    ratio = (2 / (k + 1)) ** (k / (k - 1))
    choked = pd / p <= ratio
    if choked:
        p_star = p0 * ratio
        rho_star = rho * (2 / (k + 1)) ** (1 / (k - 1))
        a_star = math.sqrt(k * p_star / rho_star)
        g = cd * rho_star * a_star
    else:
        pt = pd * 1e5
        rho_t = rho * (pt / p0) ** (1 / k)
        v = math.sqrt(2 * k / (k - 1) * p0 / rho * (1 - (pt / p0) ** ((k - 1) / k)))
        g = cd * rho_t * v
    area = math.pi * (d_mm / 1000) ** 2 / 4
    kgh = g * area * 3600
    return {'kgPerHour': kgh, 'tonnesPerYear': kgh * hours / 1000, 'criticalPressureRatio': ratio,
            'pressureRatio': pd / p, 'choked': choked, 'downstreamPressureBarA': pd}


def duty_ledger(eff_current_pct, eff_target_pct, annual_fuel_gj=None, duty=1000):
    """The tuning saving as a DUTY LEDGER: at a fixed duty the fuel is the
    duty over the efficiency, so the fuel at each efficiency is written out
    and the saving is the fuel saved over the current fuel. Never a formula
    for the fraction. Exported in MD45-1 (it lived inside main())."""
    duty = F(str(duty))
    ec, et = F(str(eff_current_pct)), F(str(eff_target_pct))
    fuel_c, fuel_t = duty / (ec / 100), duty / (et / 100)
    frac = (fuel_c - fuel_t) / fuel_c
    return {'fuelCurrent': fuel_c, 'fuelTarget': fuel_t, 'fuelSavingFraction': frac,
            'annualEnergySavedGJ': None if annual_fuel_gj is None else F(str(annual_fuel_gj)) * frac,
            'differenceShortcut': (et - ec) / 100}


def pinch_by_deficit(streams, dtmin):
    half = F(str(dtmin)) / 2
    hot, cold = [], []
    for s in streams:
        ts, tt, cp = F(str(s['supplyC'])), F(str(s['targetC'])), F(str(s['cpKWperK']))
        if ts == tt or cp == 0:
            continue
        if ts > tt:
            hot.append((tt - half, ts - half, cp))
        else:
            cold.append((ts + half, tt + half, cp))
    cands = sorted({x for lo, hi, _ in hot + cold for x in (lo, hi)}, reverse=True)

    def above(lst, t):
        return sum(cp * max(F(0), hi - max(lo, t)) for lo, hi, cp in lst)

    deficits = [(above(cold, t) - above(hot, t), t) for t in cands]
    qh = max(F(0), max(d for d, _ in deficits))
    hot_total = sum(cp * (hi - lo) for lo, hi, cp in hot)
    cold_total = sum(cp * (hi - lo) for lo, hi, cp in cold)
    qc = qh + hot_total - cold_total
    # the pinch: an INTERIOR temperature where the heat flow qh - deficit is zero
    interior = cands[1:-1]
    pinch = [t for d, t in deficits if t in interior and qh - d == 0]
    return {'hotUtilityKW': fl(qh), 'coldUtilityKW': fl(qc), 'pinchShiftedC': fl(pinch[0]) if pinch else None,
            'pinchHotC': fl(pinch[0] + half) if pinch else None, 'pinchColdC': fl(pinch[0] - half) if pinch else None,
            'thresholdProblem': qh == 0 or qc == 0, 'heatRecoveredKW': fl(hot_total - qc)}


def levelised(capex, annual_value, tonnes, life, r):
    capex, annual_value, tonnes, r = F(str(capex)), F(str(annual_value)), F(str(tonnes)), F(str(r))
    pv_c, pv_t = capex, F(0)
    for y in range(1, life + 1):
        pv_c -= annual_value / (1 + r) ** y
        pv_t += tonnes / (1 + r) ** y
    return pv_c / pv_t


PAGE_FUEL = [('CH4', '0.9'), ('C2H6', '0.08'), ('N2', '0.02')]
PAGE_HEATER = {'stackTempC': 220, 'combustionAirTempC': 25, 'flueGasCpKJkgK': '1.10', 'waterVapourCpKJkgK': '1.95',
               'waterLatentHeatKJkg': 2442, 'unburnedLossPercent': 0,
               'radiationLossPercent': '1.5'}  # radiation: SYNTHETIC (the page leaves it blank)
PAGE_PINCH = [
    {'label': 'H1 reactor effluent', 'supplyC': 150, 'targetC': 60, 'cpKWperK': 2.0},
    {'label': 'H2 product cooler', 'supplyC': 90, 'targetC': 60, 'cpKWperK': 8.0},
    {'label': 'C1 feed preheat', 'supplyC': 20, 'targetC': 125, 'cpKWperK': 2.5},
    {'label': 'C2 reboiler feed', 'supplyC': 25, 'targetC': 100, 'cpKWperK': 3.0},
]
SYNTH_EF = 56  # kg CO2e / GJ, SYNTHETIC input
SYNTH_CD = '0.7'


def main():
    fuels = {'page': PAGE_FUEL, 'testGas': [('CH4', '0.9'), ('C2H6', '0.1')],
             'mixed': [('CH4', '0.7'), ('C3H8', '0.1'), ('C4H10', '0.05'), ('H2', '0.1'), ('CO2', '0.03'), ('N2', '0.02')]}
    stoich = {}
    for name, fuel in fuels.items():
        st = species_ledger(fuel)
        e = excess_by_bisection(st, 3)
        dry_kg, wet_kg, air_kg = masses(st, e)
        stoich[name] = {
            'fuel': [{'code': c, 'moleFraction': float(F(y))} for c, y in fuel],
            'o2PerKmolFuel': fl(st['o2']), 'stoichAirPerKmolFuel': fl(st['air']),
            'co2PerKmolFuel': fl(st['co2']), 'h2oPerKmolFuel': fl(st['h2o']),
            'n2PerKmolFuel': fl(st['n2air'] + st['n2fuel']), 'fuelMolarMassKgKmol': fl(st['fuelMass']),
            'stoichAirKgPerKgFuel': fl(st['air'] * M_AIR / st['fuelMass']),
            'lhvMJPerKmolFuel': fl(st['lhv']), 'hhvMJPerKmolFuel': fl(st['hhv']),
            'at3': {'excessAirFraction': fl(e), 'dryFlueGasKgPerKmolFuel': fl(dry_kg),
                    'wetFlueGasKg': fl(wet_kg), 'fuelPlusAirKg': fl(st['fuelMass'] + air_kg)},
        }
    st = species_ledger(PAGE_FUEL)
    excess = {str(p): fl(excess_by_bisection(st, p)) for p in (0, 3, 6, 10)}

    eff = {}
    for basis in ('LHV', 'HHV'):
        for o2 in (6, 3):
            r = efficiency(st, o2, PAGE_HEATER, basis)
            eff[f'{basis}@{o2}'] = {'efficiencyPercent': fl(r['eff']), 'dryPercent': fl(r['dry']), 'moisturePercent': fl(r['moisture'])}
    # the tuning saving as a DUTY LEDGER: a fixed duty of 1000 GJ
    led = duty_ledger(eff['LHV@6']['efficiencyPercent'], eff['LHV@3']['efficiencyPercent'], 500000)
    saving = {'fuelSavingFraction': fl(led['fuelSavingFraction']), 'annualEnergySavedGJ': fl(led['annualEnergySavedGJ']),
              'differenceShortcut': fl(led['differenceShortcut'])}

    trap = {}
    for k in ('1.3', '1.135'):
        t = trap_nozzle(3, 11, SYNTH_CD, '5.6', k, 8760)
        fuel_gj = t['tonnesPerYear'] * 2700 / 1000 / 0.85
        trap[k] = {**t, 'annualCost': t['tonnesPerYear'] * 25, 'annualFuelGJ': fuel_gj,
                   'annualTonnesCo2e': fuel_gj * SYNTH_EF / 1000, 'population40TonnesPerYear': t['tonnesPerYear'] * 40}

    # condensate ledger, page defaults; treatment SYNTHETIC 1.2
    extra = F(20) * (F('0.7') - F('0.4')) * 8760
    mj_per_t = F('4.19') * (90 - 25)
    fuel_gj = extra * mj_per_t / 1000 / F('0.85')
    cond = {'extraCondensateTonnesPerYear': fl(extra), 'energySavedGJPerYear': fl(fuel_gj),
            'fuel': fl(fuel_gj * 8), 'water': fl(extra * F('0.6')), 'treatment': fl(extra * F('1.2')),
            'annualValueFloor': fl(fuel_gj * 8 + extra * F('0.6')),
            'annualValueFull': fl(fuel_gj * 8 + extra * F('0.6') + extra * F('1.2')),
            'annualTonnesCo2e': fl(fuel_gj * SYNTH_EF / 1000)}

    total = F(900000 + 120000 + 60000)
    intensity = {'totalEnergyGJ': fl(total), 'intensityMJPerTonne': fl(total * 1000 / 1500000),
                 'peer': 700, 'versusPeer': fl(total * 1000 / 1500000 / 700), 'gap': fl(total * 1000 / 1500000 - 700),
                 'withoutPowerIntensity': fl(F(960000) * 1000 / 1500000)}

    pinch = {str(dt): pinch_by_deficit(PAGE_PINCH, dt) for dt in (10, 20, 30)}
    threshold = pinch_by_deficit([{'supplyC': 200, 'targetC': 50, 'cpKWperK': 10}, {'supplyC': 30, 'targetC': 60, 'cpKWperK': 1}], 10)
    # price saving: 12000 GJ at 8 a GJ, EF 56, 250000 over 10 years at 10 percent (all SYNTHETIC)
    lev = levelised(250000, 12000 * 8, F(12000 * 56, 1000), 10, '0.1')

    # MD45-1. F6: the trap tested against the critical pressure ratio. The
    # page trap (3 mm, 11 bar a, 5.6 kg/m3, Cd 0.7, k 1.135) to atmosphere
    # is choked; into an 8 bar a header it is not; the recon's 1.2 bar a
    # trap (0.7 kg/m3) to atmosphere is not.
    trap_md45 = [
        {'name': 'page trap to atmosphere, downstream left out', 'args': {'orificeDiameterMm': 3, 'upstreamPressureBarA': 11, 'dischargeCoefficient': 0.7,
                                                                        'steamDensityKgM3': 5.6, 'specificHeatRatio': 1.135, 'hoursPerYear': 8760},
         **trap_nozzle(3, 11, SYNTH_CD, '5.6', '1.135', 8760)},
        {'name': 'page trap into an 8 bar a header', 'args': {'orificeDiameterMm': 3, 'upstreamPressureBarA': 11, 'dischargeCoefficient': 0.7,
                                                              'steamDensityKgM3': 5.6, 'specificHeatRatio': 1.135, 'hoursPerYear': 8760,
                                                              'downstreamPressureBarA': 8},
         **trap_nozzle(3, 11, SYNTH_CD, '5.6', '1.135', 8760, 8)},
        {'name': 'a 1.2 bar a trap to atmosphere', 'args': {'orificeDiameterMm': 3, 'upstreamPressureBarA': 1.2, 'dischargeCoefficient': 0.7,
                                                            'steamDensityKgM3': 0.7, 'specificHeatRatio': 1.135, 'hoursPerYear': 8760},
         **trap_nozzle(3, '1.2', SYNTH_CD, '0.7', '1.135', 8760)},
        {'name': 'page trap exactly at a 5 bar a header (choked)', 'args': {'orificeDiameterMm': 3, 'upstreamPressureBarA': 11, 'dischargeCoefficient': 0.7,
                                                                           'steamDensityKgM3': 5.6, 'specificHeatRatio': 1.135, 'hoursPerYear': 8760,
                                                                           'downstreamPressureBarA': 5},
         **trap_nozzle(3, 11, SYNTH_CD, '5.6', '1.135', 8760, 5)},
    ]
    trap_refusals = [
        {'name': 'a blank downstream pressure', 'downstreamPressureBarA': ''},
        {'name': 'a downstream pressure at the upstream one', 'downstreamPressureBarA': 11},
        {'name': 'a negative downstream pressure', 'downstreamPressureBarA': -1},
    ]
    # F2: the basis in any case is LHV or HHV; anything else is refused.
    basis_cases = {'hhv': 'HHV', 'Lhv': 'LHV', ' HHV ': 'HHV'}
    basis_refusals = ['Btu', 'GCV', '', None]
    # F7 and F5: losses below zero, and a condensate target below the current.
    loss_refusals = [{'name': 'a negative radiation loss', 'radiationLossPercent': -3},
                     {'name': 'a negative unburned loss', 'unburnedLossPercent': -1}]
    condensate_refusal = {'steamTonnesPerHour': 20, 'currentReturnFraction': 0.7, 'targetReturnFraction': 0.4, 'condensateTempC': 90,
                          'makeupTempC': 25, 'boilerEfficiencyFraction': 0.85, 'hoursPerYear': 8760}

    doc = {
        'md45': {'traps': trap_md45, 'trapRefusals': trap_refusals, 'basisCases': basis_cases, 'basisRefusals': basis_refusals,
                 'lossRefusals': loss_refusals, 'condensateBelowCurrent': condensate_refusal,
                 'dutyLedger': {'current': eff['LHV@6']['efficiencyPercent'], 'target': eff['LHV@3']['efficiencyPercent'], 'annualFuelGJ': 500000,
                                'fuelSavingFraction': fl(led['fuelSavingFraction']), 'annualEnergySavedGJ': fl(led['annualEnergySavedGJ'])}},
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_energyefficiency.py',
            'method': 'a species ledger and a mass balance in exact rationals; excess air by bisection; a loss ledger and a duty ledger; an isentropic nozzle; pinch by the largest heat deficit, no cascade; a levelised PV ledger',
            'engine': 'engines/downstream/energyEfficiency.js',
            'published': 'air O2 0.20946 and 28.9647 kg/kmol (Engineering ToolBox, PINNED); water latent heat 44.004 kJ/mol from CODATA formation enthalpies (NIST WebBook). Costs, Cd, radiation loss and emission factor are SYNTHETIC.',
        },
        'molarMasses': {k: fl(v) for k, v in M.items()},
        'stoichiometry': stoich,
        'excessAir': excess,
        'heater': PAGE_HEATER,
        'efficiency': eff,
        'saving': saving,
        'trap': trap,
        'condensate': cond,
        'intensity': intensity,
        'pinchStreams': PAGE_PINCH,
        'pinch': pinch,
        'threshold': threshold,
        'priceSaving': {'costPerTonneCo2e': fl(lev), 'annualValue': 96000, 'annualTonnesCo2e': 672},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('page fuel mass balance at 3%:', stoich['page']['at3'])
    print('eff', eff, '\nsaving', saving, '\ntrap', {k: round(v['kgPerHour'], 6) for k, v in trap.items()})
    print('pinch', pinch, '\nthreshold', threshold, '\nlev', float(lev))


if __name__ == '__main__':
    main()
