#!/usr/bin/env python3
"""Independent oracle for the gas-well engines (Production P7): the
Turner/Coleman droplet balance, critical velocity and rate, real-gas
density, and the plunger-lift force balance, gas requirement and cycle.

Emits committed goldens to test-data/production/goldens/gaswell_cases.json.

Independence discipline: written from the METHOD SPEC the JS documents,
not transcribed from it. The route differs deliberately at every step:

  * the droplet balance. The engine works in FIELD units throughout,
    converting dyne/cm to lbf/ft and carrying gc. The oracle works
    entirely in SI -- N/m, kg/m3, m/s, with no gc anywhere because SI
    does not need one -- and converts only the final velocity to ft/s.
    A units slip on either side cannot survive that.
  * the rate constant. The engine builds it from 86400 Tsc/(psc 1000).
    The oracle builds it from the molar volume of an ideal gas at
    standard conditions, so the two derivations share no arithmetic.
  * gas density. The engine uses p M/(z R T) with the field R of
    10.7316 psia ft3/(lbmol degR); the oracle uses the SI R of 8.314
    J/(mol K) and converts.
  * plunger lift. The engine works in psi and feet; the oracle works in
    pascals and metres.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_gaswell.py
"""
import json
import math
import os

# --- SI constants, so nothing field-unit leaks into the derivation ---
R_SI = 8.31446261815324          # J/(mol K)
G_SI = 9.80665                   # m/s2
M_AIR_SI = 0.0289647             # kg/mol

# --- conversions, applied only at the boundary ---
FT_PER_M = 1.0 / 0.3048
PA_PER_PSI = 6894.757293168361
KGM3_PER_LBFT3 = 16.018463373960142
M_PER_FT = 0.3048
K_PER_R = 5.0 / 9.0


def gas_density_si(p_pa, t_k, z, sg):
    """rho = p M / (z R T), in kg/m3, from SI constants only."""
    return p_pa * (M_AIR_SI * sg) / (z * R_SI * t_k)


def gas_density_lb_ft3(p_psia, temp_r, z, sg):
    rho_si = gas_density_si(p_psia * PA_PER_PSI, temp_r * K_PER_R, z, sg)
    return rho_si / KGM3_PER_LBFT3


def terminal_velocity_si(sigma_n_m, rho_l_si, rho_g_si, cd=0.44, we=30.0):
    """Droplet terminal velocity in m/s, derived in SI.

    Drag = weight - buoyancy:
        Cd (pi d^2/4) rho_g v^2 / 2 = (pi d^3/6)(rho_L - rho_g) g
      -> v^2 = 4 g d (rho_L - rho_g) / (3 Cd rho_g)

    Largest stable droplet from the critical Weber number:
        We = rho_g v^2 d / sigma  ->  d = We sigma / (rho_g v^2)

    Eliminating d:
        v^4 = 4 We g sigma (rho_L - rho_g) / (3 Cd rho_g^2)

    No gc appears anywhere, which is the point of doing it here.
    """
    d_rho = rho_l_si - rho_g_si
    if rho_g_si <= 0 or d_rho <= 0 or sigma_n_m <= 0:
        return float('nan')
    v4 = 4.0 * we * G_SI * sigma_n_m * d_rho / (3.0 * cd * rho_g_si * rho_g_si)
    return v4 ** 0.25


def terminal_velocity_ft_s(sigma_dyne_cm, rho_l_lb_ft3, rho_g_lb_ft3, cd=0.44, we=30.0):
    sigma_n_m = sigma_dyne_cm * 1e-3          # 1 dyne/cm = 1e-3 N/m
    v_si = terminal_velocity_si(
        sigma_n_m,
        rho_l_lb_ft3 * KGM3_PER_LBFT3,
        rho_g_lb_ft3 * KGM3_PER_LBFT3,
        cd, we,
    )
    return v_si * FT_PER_M


def turner_constant():
    """The 1.593 the texts print, recovered from the SI derivation.

    Evaluate the SI form at sigma = 1 dyne/cm and (rho_L - rho_g) = 1
    lb/ft3 with rho_g = 1 lb/ft3, in ft/s. Whatever comes out IS the
    field-unit constant, because the equation is a pure power law in
    those three groups.
    """
    return terminal_velocity_ft_s(1.0, 2.0, 1.0)


def rate_constant_mscfd():
    """Built from the molar volume at standard conditions, not from
    86400 Tsc/psc.

    One lbmol at 14.7 psia and 519.67 degR occupies R T / p ft3. A
    velocity v through an area A moves v A ft3/s of gas at (p, T, z);
    the moles in it are p (v A) / (z R T) per second, and those moles
    occupy V_std each at standard conditions.
    """
    r_field = 10.731577089016  # psia ft3/(lbmol degR), from R_SI converted
    v_std_ft3_per_lbmol = r_field * 519.67 / 14.7
    # q_std [ft3/d] = 86400 * (p /(z R T)) * V_std  per unit (v A)
    #               = 86400 * p * 519.67 / (14.7 * z * T)
    return 86400.0 * v_std_ft3_per_lbmol / r_field / 1000.0


def critical_rate_mscfd(v_ft_s, area_ft2, p_psia, temp_r, z):
    return rate_constant_mscfd() * v_ft_s * area_ft2 * p_psia / (temp_r * z)


def tubing_area_ft2(id_in):
    return math.pi * id_in * id_in / (4.0 * 144.0)


# ----------------------------------------------------------- plunger lift

def lift_pressure_pa(line_pa, slug_m, liquid_rho_si, id_m, plunger_kg,
                     depth_m, rho_gas_si, friction_pa):
    """The same static balance, in pascals and metres."""
    area_m2 = math.pi * id_m * id_m / 4.0
    slug_pa = liquid_rho_si * G_SI * slug_m
    plunger_pa = plunger_kg * G_SI / area_m2
    gas_col_pa = rho_gas_si * G_SI * max(depth_m - slug_m, 0.0)
    return {
        'total': line_pa + slug_pa + plunger_pa + gas_col_pa + friction_pa,
        'slug': slug_pa,
        'plunger': plunger_pa,
        'gasColumn': gas_col_pa,
    }


def gas_per_cycle_scf(depth_ft, id_in, p_start, p_end, temp_r, z):
    swept = tubing_area_ft2(id_in) * depth_ft
    p_avg = 0.5 * (p_start + p_end)
    return swept * (p_avg / 14.7) * (519.67 / temp_r) / z


def main():
    cases = {}

    cases['constants'] = {
        'turnerConstant': turner_constant(),
        'rateConstantMscfd': rate_constant_mscfd(),
        'gasDensity_1000psia_600R_z088_sg065':
            gas_density_lb_ft3(1000, 600, 0.88, 0.65),
    }

    # A grid of droplet velocities across water and condensate.
    vel = []
    for sigma, rho_l, label in ((60.0, 67.0, 'water'), (20.0, 45.0, 'condensate')):
        for p in (300.0, 1000.0, 2500.0):
            for t in (540.0, 620.0):
                z = 0.9
                sg = 0.65
                rho_g = gas_density_lb_ft3(p, t, z, sg)
                vt = terminal_velocity_ft_s(sigma, rho_l, rho_g)
                vel.append({
                    'fluid': label, 'sigmaDyneCm': sigma, 'rhoLiquidLbFt3': rho_l,
                    'pPsia': p, 'tempR': t, 'z': z, 'gasSg': sg,
                    'rhoGasLbFt3': rho_g,
                    'terminalFtS': vt,
                    'turnerFtS': vt * 1.2,
                    'colemanFtS': vt,
                    'criticalRateTurnerMscfd': critical_rate_mscfd(
                        vt * 1.2, tubing_area_ft2(2.441), p, t, z),
                })
    cases['velocity'] = vel

    # Plunger lift, computed in SI and reported in field units.
    depth_ft, id_in, slug_ft = 6000.0, 2.441, 200.0
    line_psia, casing_psia = 120.0, 600.0
    liquid_sg, plunger_lb, gas_sg, temp_r, z = 1.02, 6.0, 0.65, 580.0, 0.9
    rho_gas_lb = gas_density_lb_ft3(line_psia, temp_r, z, gas_sg)
    terms = lift_pressure_pa(
        line_psia * PA_PER_PSI,
        slug_ft * M_PER_FT,
        liquid_sg * 1000.0,
        id_in * 0.0254,
        plunger_lb * 0.45359237,
        depth_ft * M_PER_FT,
        rho_gas_lb * KGM3_PER_LBFT3,
        0.0,
    )
    required_psia = terms['total'] / PA_PER_PSI
    gas_scf = gas_per_cycle_scf(depth_ft, id_in, casing_psia, required_psia, temp_r, z)
    liquid_bbl = tubing_area_ft2(id_in) * slug_ft / 5.614583
    cases['plunger'] = {
        'inputs': {
            'depthFt': depth_ft, 'idIn': id_in, 'slugLengthFt': slug_ft,
            'linePressurePsia': line_psia, 'casingPressurePsia': casing_psia,
            'liquidSg': liquid_sg, 'plungerWeightLb': plunger_lb,
            'gasSg': gas_sg, 'avgTempR': temp_r, 'z': z,
        },
        'requiredPsia': required_psia,
        'slugPsi': terms['slug'] / PA_PER_PSI,
        'plungerPsi': terms['plunger'] / PA_PER_PSI,
        'gasColumnPsi': terms['gasColumn'] / PA_PER_PSI,
        'gasPerCycleScf': gas_scf,
        'liquidPerCycleBbl': liquid_bbl,
        'requiredGlrScfBbl': gas_scf / liquid_bbl,
    }

    out = os.path.join(os.path.dirname(__file__), '..', '..', '..',
                       'test-data', 'production', 'goldens', 'gaswell_cases.json')
    with open(os.path.abspath(out), 'w') as fh:
        json.dump(cases, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', os.path.abspath(out))


if __name__ == '__main__':
    main()
