#!/usr/bin/env python3
"""Independent oracle for engines/facilities/separatorSizing.js.

Built from the method statement in the module header, not from the JS.
Independent routes:
 - circular-segment areas by NUMERICAL INTEGRATION of the circle's
   chord over the liquid depth, and (for the three-phase work) by the
   alternative closed form A = r^2 acos((r-h)/r) - (r-h) sqrt(2rh - h^2),
   against the module's (theta - sin theta) expression
 - the oil-water interface height by NEWTON on that closed form with
   the chord as the derivative, against the module's bisection
 - Souders-Brown and the vessel balances re-derived in SI
 - Stokes settling from first principles (the 1.78e-6 field constant
   is a unit packaging of g d^2 dRho / (18 mu); the oracle computes
   the SI law directly, so the constant is CHECKED)
 - the K derating in exact rational arithmetic
 - DAK z by BISECTION on the reduced density (the module uses Newton),
   and gas density by the SI gas law
 - the L/D sweep: rows, gas capacity, droplet verdicts, preferred
 - slug-catcher volumes by SI geometry

Each retired rule is also computed here as a NEGATIVE CONTROL, so the
gates can show the goldens tell the old behaviour from the new.

stdlib only. Writes test-data/facilities/goldens/separator_cases.json
"""

import json
import math
import os
from fractions import Fraction

FT = 0.3048
IN = 0.0254
BBL = 0.158987294928
LBFT3 = 16.01846337396
CP = 1e-3
G = 9.80665
PSI = 6894.757293168
R_SI = 8.314462618          # J/(mol K)
AIR_MW = 28.9625            # g/mol, dry air
FT3_PER_BBL = BBL / FT ** 3


# ------------------------------------------------------------------ #
# geometry
# ------------------------------------------------------------------ #

def segment_by_integration(d_ft, frac, n=400000):
    """Liquid area of a horizontal cylinder by integrating the chord.

    A = integral_0^h  2*sqrt(r^2 - (r-y)^2) dy, midpoint rule.
    """
    r = d_ft / 2.0
    h = frac * d_ft
    acc = 0.0
    dy = h / n
    for i in range(n):
        y = (i + 0.5) * dy
        acc += 2.0 * math.sqrt(max(0.0, r * r - (r - y) ** 2)) * dy
    return acc


def segment_alt(d, h):
    """A = r^2 acos((r-h)/r) - (r-h) sqrt(2 r h - h^2)."""
    r = d / 2.0
    return r * r * math.acos((r - h) / r) - (r - h) * math.sqrt(max(0.0, 2 * r * h - h * h))


def chord(d, h):
    return 2.0 * math.sqrt(max(0.0, h * (d - h)))


def height_for_area_newton(d, area):
    """Depth whose segment has `area`: Newton, dA/dh = chord(h)."""
    h = d / 2.0
    for _ in range(200):
        c = chord(d, h)
        if c <= 0:
            break
        step = (segment_alt(d, h) - area) / c
        nh = min(max(h - step, 1e-15), d - 1e-15)
        if abs(nh - h) < 1e-15 * d:
            h = nh
            break
        h = nh
    return h


# ------------------------------------------------------------------ #
# K, gas, settling
# ------------------------------------------------------------------ #

K_TABLE = {
    "verticalMesh": Fraction(35, 100), "verticalVane": Fraction(42, 100),
    "verticalNone": Fraction(18, 100), "horizontalMesh": Fraction(45, 100),
    "horizontalVane": Fraction(55, 100), "horizontalNone": Fraction(25, 100),
}
K_FLOOR = Fraction(12, 100)
K_DERATE_PER_100PSI = Fraction(1, 100)


def k_derated_at(base, p_psig):
    """The published rule, and nothing else: 0.01 comes off K for every
    100 psi of gauge pressure above 100 psig."""
    over = max(Fraction(0), Fraction(p_psig) - 100)
    return base - K_DERATE_PER_100PSI * over / 100


def k_value(internals, p_psig):
    """GPSA rule: K falls 0.01 per 100 psi over 100 psig, floor 0.12
    (the floor binds when the derated value is BELOW 0.12).

    nearFloor is derived HERE FROM THE PUBLISHED RULE and never from the
    JS: a K the floor did not catch is near the floor when one more
    100 psi step of that same rule WOULD put it under. Stated that way
    the flag needs no threshold of its own, and exact rational
    arithmetic decides the boundary cases (a derating landing exactly on
    0.12 is NOT floored and IS near the floor) rather than leaving them
    to binary floating point."""
    base = K_TABLE[internals]
    derated = k_derated_at(base, p_psig)
    floored = derated < K_FLOOR
    near_floor = (not floored) and k_derated_at(base, Fraction(p_psig) + 100) < K_FLOOR
    return {
        "name": f"{internals}At{p_psig}psig",
        "note": ("exact rational derating; floored when the derated K is below 0.12, "
                 "nearFloor when one more 100 psi step of the rule would floor it"),
        "input": {"internalsId": internals, "pPsig": p_psig},
        "expected": {
            "k": float(K_FLOOR if floored else derated),
            "kDerated": float(derated),
            "floored": floored,
            "nearFloor": near_floor,
            "derated": p_psig > 100,
        },
    }


DAK = [0.3265, -1.0700, -0.5339, 0.01569, -0.05165,
       0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.7210]


def dak_z_bisection(ppr, tpr):
    """Dranchuk & Abou-Kassem (1975). Solve rhoR z(rhoR) = 0.27 Ppr/Tpr
    for the smallest positive root by scanning then bisecting."""
    a = DAK

    def z_of(r):
        return (1 + (a[0] + a[1] / tpr + a[2] / tpr ** 3 + a[3] / tpr ** 4 + a[4] / tpr ** 5) * r
                + (a[5] + a[6] / tpr + a[7] / tpr ** 2) * r * r
                - a[8] * (a[6] / tpr + a[7] / tpr ** 2) * r ** 5
                + a[9] * (1 + a[10] * r * r) * (r * r / tpr ** 3) * math.exp(-a[10] * r * r))

    c = 0.27 * ppr / tpr

    def f(r):
        return z_of(r) * r - c

    lo, step = 0.0, 1e-3
    hi = step
    while f(hi) < 0:
        lo, hi = hi, hi + step
        if hi > 5:
            raise RuntimeError("no DAK root bracketed")
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if f(mid) < 0:
            lo = mid
        else:
            hi = mid
    return z_of(0.5 * (lo + hi))


def gas_density(p_psia, t_f, sg):
    tr = t_f + 459.67
    tpc = 169.2 + 349.5 * sg - 74.0 * sg * sg
    ppc = 756.8 - 131.0 * sg - 3.6 * sg * sg
    ppr, tpr = p_psia / ppc, tr / tpc
    out = {"ppr": ppr, "tpr": tpr}
    if tpr < 1.0:
        out["status"] = "refused-tpr-below-range"
    elif tpr > 3.0:
        out["status"] = "refused-tpr-above-range"
    elif ppr > 30:
        out["status"] = "refused-ppr-above-range"
    else:
        z = dak_z_bisection(ppr, tpr)
        # SI gas law: rho = p M / (z R T)
        rho_si = (p_psia * PSI) * (AIR_MW * sg / 1000.0) / (z * R_SI * (tr / 1.8))
        out.update({"status": "ok", "z": z, "rhoLbFt3": rho_si / LBFT3,
                    "pprBelowFit": ppr < 0.2})
    return out


def souders_brown(k, rho_l, rho_g):
    rl = rho_l * LBFT3
    rg = rho_g * LBFT3
    return (k * FT) * math.sqrt((rl - rg) / rg) / FT


def stokes_si(d_micron, sg_heavy, sg_light, mu_cp):
    """v = g d^2 (rho_h - rho_l) / (18 mu), SI, returned in ft/s."""
    d = d_micron * 1e-6
    drho = (sg_heavy - sg_light) * 1000.0
    mu = mu_cp * CP
    return G * d * d * drho / (18.0 * mu) / FT


def stokes_field(d_micron, sg_heavy, sg_light, mu_cp):
    """The field packaging the module states (1.78e-6). Used for the
    three-phase verdicts so a 0.3 percent constant rounding cannot flip
    a verdict; the constant itself is gated by the `stokes` section."""
    return 1.78e-6 * d_micron * d_micron * (sg_heavy - sg_light) / mu_cp


# ------------------------------------------------------------------ #
# sizers
# ------------------------------------------------------------------ #

def vertical_two_phase(q_gas_ft3s, v_term, q_liq_bpd, ret_min, allowance_ft, d_override=None):
    q = q_gas_ft3s * FT ** 3
    v = v_term * FT
    area_gas = q / v
    d_gas = math.sqrt(4 * area_gas / math.pi)
    d = d_override * FT if d_override else d_gas
    area = math.pi * d * d / 4
    liq_vol = q_liq_bpd * BBL * (ret_min / 1440.0)
    h_liq = liq_vol / area
    height_ft = h_liq / FT + allowance_ft
    return {
        "diameterGasFt": d_gas / FT, "diameterFt": d / FT,
        "hLiquidFt": h_liq / FT, "heightFt": height_ft,
        "ldRatio": height_ft / (d / FT),
        "velocityMargin": (area / area_gas),
        "gasCapacityOk": d_override is None or d_override >= d_gas / FT,
    }


def horizontal_two_phase(d_ft, q_gas_ft3s, v_term, q_liq_bpd, ret_min, frac, integrate=True):
    area_liq = (segment_by_integration(d_ft, frac, n=200000) if integrate
                else segment_alt(d_ft, frac * d_ft))
    area_tot = math.pi * (d_ft / 2) ** 2
    area_gas = area_tot - area_liq
    gas_h = d_ft * (1 - frac)
    v_gas = q_gas_ft3s / area_gas
    len_gas = v_gas * gas_h / v_term
    liq_vol = q_liq_bpd * FT3_PER_BBL * (ret_min / 1440.0)
    len_liq = liq_vol / area_liq
    length = max(len_gas, len_liq)
    return {
        "areaLiquidFt2": area_liq, "areaGasFt2": area_gas,
        "gasVelocityFtS": v_gas, "gasCapacityOk": v_gas <= v_term,
        "lengthGasFt": len_gas, "lengthLiquidFt": len_liq, "lengthFt": length,
        "controlling": "gas" if len_gas >= len_liq else "liquid",
        "ldRatio": length / d_ft,
    }


def horizontal_three_phase(p):
    d = p["diameterFt"]
    frac = p.get("liquidLevelFrac", 0.5)
    h_liq = frac * d
    area_tot = math.pi * d * d / 4
    area_liq = segment_alt(d, h_liq)
    area_gas = area_tot - area_liq
    gas_h = d - h_liq
    vol_oil = p["qOilBpd"] * FT3_PER_BBL * p["oilRetentionMin"] / 1440.0
    vol_wat = p["qWaterBpd"] * FT3_PER_BBL * p["waterRetentionMin"] / 1440.0
    explicit = "waterFracOfLiquid" in p
    share = p["waterFracOfLiquid"] if explicit else vol_wat / (vol_wat + vol_oil)
    a_wat = area_liq * share
    a_oil = area_liq - a_wat
    h_int = height_for_area_newton(d, a_wat)
    water_layer = h_int
    oil_layer = h_liq - h_int
    if explicit:
        l_oil, l_wat = vol_oil / a_oil, vol_wat / a_wat
        l_ret = max(l_oil, l_wat)
        phase = None
        if abs(l_oil - l_wat) > 1e-9 * l_ret:
            phase = "oil" if l_oil > l_wat else "water"
        phase_lengths = {"oilFt": l_oil, "waterFt": l_wat}
    else:
        l_ret = (vol_oil + vol_wat) / area_liq
        phase, phase_lengths = None, None
    v_gas = p["qGasActFt3S"] / area_gas
    l_gas = v_gas * gas_h / p["vTerminalFtS"]
    length = max(l_gas, l_ret)
    v_w = stokes_field(p["waterDropletMicron"], p["sgWater"], p["sgOil"], p["muOilCp"])
    v_o = stokes_field(p["oilDropletMicron"], p["sgWater"], p["sgOil"], p["muWaterCp"])
    q_oil_s = p["qOilBpd"] * FT3_PER_BBL / 86400.0
    q_wat_s = p["qWaterBpd"] * FT3_PER_BBL / 86400.0
    res_oil = a_oil * length / q_oil_s
    res_wat = a_wat * length / q_wat_s
    fall = oil_layer / v_w
    rise = water_layer / v_o
    return {
        "interfaceSplit": "explicit" if explicit else "retention-proportional",
        "waterShare": share,
        "areaLiquidFt2": area_liq, "areaOilFt2": a_oil, "areaWaterFt2": a_wat,
        "interfaceHeightFt": h_int, "waterLayerFt": water_layer, "oilLayerFt": oil_layer,
        "liquidRetentionLengthFt": l_ret,
        "phaseRetentionLengthsFt": phase_lengths,
        "retentionPhase": phase,
        "lengthGasFt": l_gas, "lengthFt": length,
        "controlling": "gas" if l_gas >= l_ret else "liquid-retention",
        "ldRatio": length / d,
        "gasVelocityFtS": v_gas, "gasCapacityOk": v_gas <= p["vTerminalFtS"],
        "dropChecks": {
            "waterDropFallS": fall, "oilDropRiseS": rise,
            "residenceOilS": res_oil, "residenceWaterS": res_wat,
            "waterCarryover": fall > res_oil, "oilCarryunder": rise > res_wat,
        },
        # NEGATIVE CONTROL (retired D2 rule): layer = area / gas-liquid chord
        "retiredChordRule": {
            "waterLayerFt": a_wat / chord(d, h_liq),
            "oilLayerFt": a_oil / chord(d, h_liq),
        },
    }


def ld_sweep(mode, diameters, ld_min, ld_max, args):
    rows = []
    for d in sorted(diameters):
        if mode == "vertical2":
            r = vertical_two_phase(args["qGasActFt3S"], args["vTerminalFtS"], args["qLiquidBpd"],
                                   args["retentionMin"], args.get("allowanceFt", 6), d)
            length = r["heightFt"]
        elif mode == "horizontal2":
            r = horizontal_two_phase(d, args["qGasActFt3S"], args["vTerminalFtS"], args["qLiquidBpd"],
                                     args["retentionMin"], args.get("liquidLevelFrac", 0.5),
                                     integrate=False)
            length = r["lengthFt"]
        else:
            r = horizontal_three_phase(dict(args, diameterFt=d))
            length = r["lengthFt"]
        reasons = []
        if not r["gasCapacityOk"]:
            reasons.append("gas-capacity")
        dc = r.get("dropChecks")
        if dc and dc["waterCarryover"]:
            reasons.append("water-carryover")
        if dc and dc["oilCarryunder"]:
            reasons.append("oil-carryunder")
        feasible = not reasons
        in_range = ld_min <= r["ldRatio"] <= ld_max
        if not in_range:
            reasons.append("ld-out-of-band")
        rows.append({"diameterFt": d, "lengthFt": length, "ldRatio": r["ldRatio"],
                     "feasible": feasible, "inRange": in_range, "reasons": reasons})
    pref = next((r for r in rows if r["feasible"] and r["inRange"]), None)
    if pref:
        status = "selected"
    else:
        status = "none-in-band" if any(r["feasible"] for r in rows) else "none-feasible"
    # NEGATIVE CONTROL (retired D1 rule): first in-band row in LIST order,
    # gas capacity ignored
    retired = None
    for d in diameters:
        row = next(r for r in rows if r["diameterFt"] == d)
        if row["inRange"]:
            retired = d
            break
    return {"rows": rows, "preferredDiameterFt": pref["diameterFt"] if pref else None,
            "preferredStatus": status, "retiredPreferredDiameterFt": retired}


def vessel_slug(slug_bbl, q_liq_bpd, hold_min, fill, ld):
    normal = q_liq_bpd * hold_min / 1440.0
    working = slug_bbl + normal
    vol_m3 = working * BBL / fill
    d_m = (4 * vol_m3 / (math.pi * ld)) ** (1.0 / 3.0)
    return {"normalBbl": normal, "totalVolumeFt3": vol_m3 / FT ** 3,
            "diameterFt": d_m / FT, "lengthFt": ld * d_m / FT}


def finger_slug(slug_bbl, id_in, n_f, fill):
    vol_m3 = slug_bbl * BBL / fill
    area_m2 = math.pi * (id_in * IN) ** 2 / 4
    length_m = vol_m3 / (area_m2 * n_f)
    return {"totalVolumeFt3": vol_m3 / FT ** 3, "fingerLengthFt": length_m / FT}


def case(name, note, inp, expected):
    return {"name": name, "note": note, "input": inp, "expected": expected}


# ------------------------------------------------------------------ #

THREE_BASE = {
    "diameterFt": 10.0, "qGasActFt3S": 20.0, "vTerminalFtS": 1.0,
    "qOilBpd": 6000, "qWaterBpd": 4000, "oilRetentionMin": 5, "waterRetentionMin": 5,
    "sgOil": 0.85, "sgWater": 1.05, "muOilCp": 2.0, "muWaterCp": 0.7,
    "waterDropletMicron": 500, "oilDropletMicron": 200,
}


def main():
    out = {}

    out["segments"] = [
        case(f"segment{int(d)}ftAt{frac}", "closed form vs midpoint integration of the chord",
             {"diameterFt": d, "liquidLevelFrac": frac},
             {"areaLiquidFt2": segment_by_integration(d, frac)})
        for d, frac in [(8.0, 0.5), (10.0, 0.3), (6.0, 0.75), (12.0, 0.5)]
    ]

    out["kValue"] = [k_value(i, p) for i, p in [
        ("verticalMesh", 50), ("verticalMesh", 1100), ("horizontalVane", 2500),
        ("verticalNone", 650), ("verticalNone", 3000), ("horizontalNone", 1500),
    ]]

    out["gasDensity"] = []
    for name, p, t, sg in [
        ("sg065At1000psia100F", 1000.0, 100.0, 0.65),
        ("sg065At100psia100FBelowFitPpr", 100.0, 100.0, 0.65),
        ("sg070At2500psia150F", 2500.0, 150.0, 0.70),
        ("sg080At500psia60F", 500.0, 60.0, 0.80),
        ("coldGasTprBelowRange", 1000.0, -150.0, 0.65),
        ("hotGasTprAboveRange", 500.0, 700.0, 0.65),
        ("pprAboveRange", 25000.0, 150.0, 0.65),
    ]:
        out["gasDensity"].append(case(
            name, "DAK by bisection on reduced density, SI gas law; range 1.0 <= Tpr <= 3.0, Ppr <= 30",
            {"pPsia": p, "tF": t, "gasSg": sg}, gas_density(p, t, sg)))

    out["soudersBrown"] = [
        case(f"souders{k}", "SI re-derivation", {"k": k, "rhoLLbFt3": rl, "rhoGLbFt3": rg},
             {"vFtS": souders_brown(k, rl, rg)})
        for k, rl, rg in [(0.35, 52.0, 2.5), (0.45, 55.0, 5.0), (0.18, 62.4, 0.8)]
    ]

    out["stokes"] = [
        case(f"stokes{dm}um", "SI Stokes law checks the 1.78e-6 field constant",
             {"dropletMicron": dm, "sgHeavy": sgh, "sgLight": sgl, "muCp": mu},
             {"vFtS": stokes_si(dm, sgh, sgl, mu)})
        for dm, sgh, sgl, mu in [(500, 1.05, 0.85, 2.0), (150, 1.02, 0.80, 5.0), (1000, 1.08, 0.9, 1.0)]
    ]

    out["vertical"] = []
    for name, args in [
        ("vertical12ft3sGasSized", (12.0, 0.85, 3000, 3, 6)),
        ("vertical30ft3sGasSized", (30.0, 1.2, 8000, 2, 7)),
    ]:
        q, v, ql, rm, al = args
        out["vertical"].append(case(
            name, "diameter from the gas load, height from retention plus allowance",
            {"qGasActFt3S": q, "vTerminalFtS": v, "qLiquidBpd": ql, "retentionMin": rm, "allowanceFt": al},
            vertical_two_phase(q, v, ql, rm, al)))

    # The old first case (8 ft, 12 ft3/s, 3000 bpd) was a vessel 2.25 ft
    # long, L/D 0.28, and the second was L/D 0.8. Both replaced by
    # vessels a designer would build, liquid controlled and in band.
    out["horizontal"] = []
    for name, note, (d, q, v, ql, rm, fr) in [
        ("horizontal6ftHalfFullLiquidControlledInBand",
         "physical: L/D about 3.45, gas velocity below Souders-Brown",
         (6.0, 10.0, 0.85, 25000, 3, 0.5)),
        ("horizontal8ftAt40pctLiquidControlledInBand",
         "physical: L/D about 3.9, gas velocity below Souders-Brown",
         (8.0, 30.0, 1.1, 30000, 5, 0.4)),
    ]:
        out["horizontal"].append(case(
            name, note,
            {"diameterFt": d, "qGasActFt3S": q, "vTerminalFtS": v, "qLiquidBpd": ql,
             "retentionMin": rm, "liquidLevelFrac": fr},
            horizontal_two_phase(d, q, v, ql, rm, fr)))

    three = [
        ("d2Probe10ftHalfFull40pctWaterExplicit",
         "D2 probe: exact water layer 2.54 ft where the retired chord rule gave 1.57 ft; the explicit 0.4 equals the proportional share, so the phase lengths tie and retentionPhase is null",
         dict(THREE_BASE, waterFracOfLiquid=0.4)),
        ("explicit25pctWaterWaterRetentionSets",
         "explicit split below the proportional share: the water layer is smaller, so the water retention sets the length and retentionPhase is water",
         dict(THREE_BASE, waterFracOfLiquid=0.25)),
        ("proportionalSplitLiquidRetention",
         "D3: proportional split, one liquid retention requirement",
         dict(THREE_BASE)),
        ("thickOilWaterCarryover",
         "200 cP oil, 100 micron water drops, 1 min oil retention: water carryover",
         dict(THREE_BASE, muOilCp=200.0, waterDropletMicron=100, oilRetentionMin=1)),
        ("lowLevelSmallOilDropCarryunder",
         "liquid at 0.3, 30 micron oil drops in 2 cP water, 3 min water retention: oil carryunder",
         dict(THREE_BASE, liquidLevelFrac=0.3, oilDropletMicron=30, muWaterCp=2.0, waterRetentionMin=3)),
        ("gasOverloaded6ftGasControls",
         "gas controls only when the gas velocity exceeds Souders-Brown, so this vessel fails gas capacity",
         dict(THREE_BASE, diameterFt=6.0, qGasActFt3S=40.0, vTerminalFtS=0.5, qOilBpd=300, qWaterBpd=200)),
    ]
    out["threePhase"] = [case(n, note, p, horizontal_three_phase(p)) for n, note, p in three]

    out["sweep"] = []
    vprobe = {"qGasActFt3S": 30.0, "vTerminalFtS": 0.8, "qLiquidBpd": 10000, "retentionMin": 3, "allowanceFt": 6}
    for name, note, mode, ds, lo, hi, args in [
        ("d1ProbeVertical4ftGasOverloaded",
         "D1 probe: the retired rule preferred 4 ft at velocity margin 0.34 (gas needs 6.91 ft); no feasible row is in band",
         "vertical2", [4.0, 6.0, 7.0, 8.0], 3, 5, vprobe),
        ("verticalUnsortedListSmallestFeasible",
         "unsorted list: the retired rule took the first in-band row in list order (8 ft); the smallest feasible in band is 7 ft",
         "vertical2", [10.0, 8.0, 6.0, 4.0, 7.0], 1, 2, vprobe),
        ("verticalNoneFeasible",
         "every diameter is below the gas-required diameter",
         "vertical2", [2.0, 3.0, 4.0], 1, 10, vprobe),
        ("horizontal2InBandButGasOverloaded",
         "7.5 ft is in band but its gas velocity exceeds Souders-Brown; 8.5 ft is the smallest feasible in band",
         "horizontal2", [6.0, 7.0, 7.5, 8.5, 10.0], 3, 5,
         {"qGasActFt3S": 27.0, "vTerminalFtS": 1.1, "qLiquidBpd": 40000, "retentionMin": 5, "liquidLevelFrac": 0.5}),
        ("horizontal3DropletVerdictsGateFeasibility",
         "8 ft is in band but gas-overloaded, 10 and 12 ft are in band but a 250 micron water drop cannot leave the oil layer; the retired rule preferred 8 ft",
         "horizontal3", [8.0, 10.0, 12.0, 14.0], 1, 7,
         {k: v for k, v in dict(THREE_BASE, qOilBpd=30000, qWaterBpd=20000, qGasActFt3S=30.0,
                                muOilCp=3.0, waterDropletMicron=250).items() if k != "diameterFt"}),
    ]:
        out["sweep"].append(case(
            name, note,
            dict({"mode": mode, "diametersFt": ds, "ldMin": lo, "ldMax": hi}, **args),
            ld_sweep(mode, ds, lo, hi, args)))

    out["vesselSlug"] = []
    for name, (s, q, hm, f, ld) in [
        ("vessel200bblSlugLd4", (200, 5000, 5, 0.6, 4)),
        ("vessel1200bblSlugLd5", (1200, 20000, 10, 0.7, 5)),
    ]:
        out["vesselSlug"].append(case(
            name, "SI geometry",
            {"slugBbl": s, "qLiquidBpd": q, "holdMin": hm, "fillFraction": f, "ldRatio": ld},
            vessel_slug(s, q, hm, f, ld)))

    out["fingerSlug"] = []
    for name, (s, i, n, f) in [
        ("finger1500bbl6x24in", (1500, 24, 6, 0.8)),
        ("finger500bbl4x16in", (500, 16, 4, 0.75)),
    ]:
        out["fingerSlug"].append(case(
            name, "SI geometry",
            {"slugBbl": s, "fingerIdIn": i, "nFingers": n, "fillFraction": f},
            finger_slug(s, i, n, f)))

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "separator_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write("\n")
    print("wrote", dest)


if __name__ == "__main__":
    main()
