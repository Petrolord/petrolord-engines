#!/usr/bin/env python3
"""Independent oracle for engines/facilities/producedWater.js.

WHAT EACH ROUTE CHECKS, AND WHAT IT CANNOT. The honest answer is not
the same for all of them, so it is written out per route rather than
claimed once at the top. Before FC7-0 three of the six devices, the
whole train, the droplet medians and the oil density had NO route here
at all, and five of the six golden groups were transcriptions of the
engine: the same defect planted in both files and the golden
regenerated left the suite green for the API 421 cut inversion, the
Stokes constant, the salinity multiplier, the brine density slope, the
filter's loading exponent and the crude thermal expansion.

| route | what it checks | what it cannot |
|---|---|---|
| log-normal CDF | the A&S 7.1.26 series, against the C library's erf | nothing: erf is exact to double precision here |
| creeping-flow rise | the 18 in the engine's closed Stokes form, by solving the FORCE BALANCE numerically with Cd = 24/Re typed instead. The 18 is never typed here | the creeping-flow drag law itself |
| terminal rise | the engine's damped iteration on Schiller-Naumann, by bisection on the force residual | the Schiller-Naumann correlation |
| the Stokes gap | that Stokes and the real drag balance still DISAGREE at the Reynolds numbers this module warns at. If anyone ever tidies one route onto the other the gap collapses and the gate fails | -- |
| basin and plate cut | the Hazen capture criterion itself, by MARCHING a droplet's trajectory through the geometry and bisecting on the size that just clears, with the rise velocity from the force balance | the short-circuit factor F and the plate efficiency factor, which are declared choices |
| hydrocyclone cut | the radial migration, by marching it, with the centrifugal field re-derived through the TANGENTIAL VELOCITY rather than the flow ratio, so a wrong exponent on the ratio shows; and the half-area radius criterion, by a Monte Carlo over starting radii uniform by area | the declared liner geometry, design flow and field at design |
| flotation cut | the attachment kinetics assembled from its PARTS (bubble number, swept area, rise velocity, interception, attachment) and marched as an ODE, then bisected. A dropped factor shows | the interception law and the attachment efficiency, both declared |
| filter cut | the depth-filtration inversion, by marching the bed and bisecting on the droplet whose marched removal is exactly one half | the declared reference triple |
| removal integral | the engine's binned quadrature, against a MONTE CARLO sample of the same truncated log-normal. Two entirely different numerical methods | -- |
| the whole train | the stage coupling, the outlet concentration and BOTH droplet medians, by PARTICLE TRACKING: every droplet carries a surviving weight through every stage | -- |
| medianOfBins | that the volume median of a log-normal bin set reproduces its own d50, which is an identity and not a fit | -- |
| truncated tail | 2 Phi(-spanSigma) analytically, which is what makes the bin span visible to the gate at all | -- |
| property fits | NOTHING. The Vogel triple, the salinity multiplier, the brine density slope and the crude thermal expansion are declared choices with no publication in this repository. This file holds a SECOND COPY of each and the jest suite pins all of them by literal value. A PIN IS NOT A VALIDATION and the gate says so in as many words. |

stdlib only. Writes test-data/facilities/goldens/producedwater_cases.json

CAPSTONE CONDITIONS ARE OFF LIMITS as engine test conditions, in both
directions. Nothing here may be lifted into a NextGen capstone and no
capstone's conditions may be lifted into here: FC4's repair took a
capstone's exact conditions for a golden row and the golden handed back
a graded answer. The conditions used here are recorded in
tools/validation/facilities/FINDINGS-producedwater.md so the FC7 course
wave can steer clear of them.
"""

import json
import math
import os
import random

G = 9.80665

# The oracle's OWN copy of every declared constant. Held separately on
# purpose: the jest suite pins the engine's copy against literals, so
# moving a number in both files still fails. That is a pin, not a
# validation.
C = {
    "vogelA": 2.414e-5, "vogelB": 247.8, "vogelC": 140.0,
    "salinityViscosityMultiplier": 1.8,
    "brineDensitySlopeKgM3": 700.0,
    "crudeThermalExpansionPerC": 0.0007,
    "crudeReferenceWaterKgM3": 999.0,
    "defaultNBins": 60, "defaultSpanSigma": 4,
    "defaultSharpness": 3, "interceptionSharpness": 2,
    "interceptionCoefficient": 1.5,
    "shortCircuitFDefault": 1.5, "plateEfficiencyFactor": 0.7,
    "linerDiameterM": 0.035, "linerLengthM": 0.7,
    "designFlowPerLinerM3S": 0.0006, "gFieldAtDesign": 1000.0,
    "coreRadiusFraction": 0.5,
    "overloadTurndown": 1.3,
    "flotationCellDepthM": 3.0, "flotationGasDensityKgM3": 1.2,
    "bubbleMicronDefault": 300.0, "gasRatioDefault": 0.2,
    "attachmentEfficiency": 0.01,
    "filterCoefficientPerM": 3.5, "filterReferenceLoadingMHr": 10.0,
    "filterLoadingExponent": 0.5, "filterReferenceDropletMicron": 20.0,
    "filterReferenceMediaMicron": 800.0,
}


# ------------------------------------------------------------------ #
# properties: a SECOND COPY, pinned by the suite and not validated here
# ------------------------------------------------------------------ #

def water_viscosity(t_c, tds_ppm):
    mu_fresh = C["vogelA"] * 10.0 ** (C["vogelB"] / (t_c + 273.15 - C["vogelC"]))
    return mu_fresh * (1.0 + C["salinityViscosityMultiplier"] * tds_ppm / 1e6)


def water_density(t_c, tds_ppm):
    rho0 = 1000.0 * (1.0 - ((t_c + 288.9414)
                            / (508929.2 * (t_c + 68.12963)))
                     * (t_c - 3.9863) ** 2)
    return rho0 + C["brineDensitySlopeKgM3"] * tds_ppm / 1e6


def oil_density(api, t_c):
    sg60 = 141.5 / (131.5 + api)
    return sg60 * C["crudeReferenceWaterKgM3"] * (
        1.0 - C["crudeThermalExpansionPerC"] * (t_c - 15.56))


# ------------------------------------------------------------------ #
# rise velocities, from the force balance rather than a closed form
# ------------------------------------------------------------------ #

def _bisect(f, lo, hi, iters=200):
    flo = f(lo)
    fhi = f(hi)
    if flo == 0.0:
        return lo
    if fhi == 0.0:
        return hi
    if flo * fhi > 0:
        raise ValueError("bisection bracket does not straddle a root")
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if fm == 0.0:
            return mid
        if (fm > 0) == (flo > 0):
            lo, flo = mid, fm
        else:
            hi = mid
    return 0.5 * (lo + hi)


def creeping_rise(d_m, rho_heavy, rho_light, mu):
    """Terminal velocity in CREEPING FLOW, from the force balance.

    Buoyancy (pi/6) d^3 dRho g against drag Cd (pi/8) d^2 rho v^2 with
    Cd = 24/Re. The 18 in the engine's closed form is a CONSEQUENCE of
    those three expressions and is never typed in this file, which is
    what lets the gate see a change to it.
    """
    d_rho = rho_heavy - rho_light

    def residual(v):
        re = rho_heavy * v * d_m / mu
        cd = 24.0 / re
        buoy = (math.pi / 6.0) * d_m ** 3 * d_rho * G
        drag = cd * (math.pi / 8.0) * d_m ** 2 * rho_heavy * v * v
        return buoy - drag

    return _bisect(residual, 1e-30, 1e9)


def terminal_rise(d_m, rho_heavy, rho_light, mu):
    """Terminal velocity with the Schiller-Naumann drag coefficient."""
    d_rho = rho_heavy - rho_light

    def residual(v):
        re = rho_heavy * v * d_m / mu
        cd = 0.44 if re > 1000.0 else (24.0 / re) * (1.0 + 0.15 * re ** 0.687)
        buoy = (math.pi / 6.0) * d_m ** 3 * d_rho * G
        drag = cd * (math.pi / 8.0) * d_m ** 2 * rho_heavy * v * v
        return buoy - drag

    v = _bisect(residual, 1e-30, 1e9)
    re = rho_heavy * v * d_m / mu
    cd = 0.44 if re > 1000.0 else (24.0 / re) * (1.0 + 0.15 * re ** 0.687)
    return {"vMS": v, "reynolds": re, "dragCoefficient": cd}


def size_for_rise(v_req, rho_w, rho_o, mu):
    """The droplet whose creeping-flow rise is exactly v_req, by
    bisection on the size. No closed inversion anywhere."""
    return _bisect(lambda d: creeping_rise(d, rho_w, rho_o, mu) - v_req,
                   1e-12, 1e-1)


# ------------------------------------------------------------------ #
# gravity devices: the capture criterion by trajectory marching
# ------------------------------------------------------------------ #

def basin_cut_by_march(q, length, width, depth, rho_w, rho_o, mu, f, steps=5000):
    """March a droplet's trajectory through the basin.

    Water moves horizontally at u = q/(width*depth). A droplet released
    at the floor is captured if it reaches the surface before it reaches
    the outlet; the short-circuit factor F shortens the time it has by
    that factor, which is what F means. Bisect on the droplet size that
    just clears. The Hazen result overflow*F is a CONSEQUENCE, not an
    input.
    """
    u = q / (width * depth)
    t_avail = (length / u) / f

    def rise_reached(d_m):
        v = creeping_rise(d_m, rho_w, rho_o, mu)
        dt = t_avail / steps
        y = 0.0
        for _ in range(steps):
            y += v * dt
        return y - depth

    d = _bisect(rise_reached, 1e-12, 1e-1, iters=100)
    return d * 1e6


def plate_cut_by_march(q, plate_area, n_plates, eff, rho_w, rho_o, mu,
                       channel_height=0.02, steps=5000):
    """The same march through one channel of a plate pack.

    Each of the n channels carries q/n through a channel of height h and
    length l = sqrt(plate_area); the droplet must rise h in the time it
    spends in the channel, and the efficiency factor is the fraction of
    that time that actually settles. The channel HEIGHT cancels out of
    the answer, which the caller can check by marching two of them.
    """
    side = math.sqrt(plate_area)
    u = (q / n_plates) / (side * channel_height)
    t_avail = (side / u) * eff

    def rise_reached(d_m):
        v = creeping_rise(d_m, rho_w, rho_o, mu)
        dt = t_avail / steps
        y = 0.0
        for _ in range(steps):
            y += v * dt
        return y - channel_height

    d = _bisect(rise_reached, 1e-12, 1e-1, iters=100)
    return d * 1e6


# ------------------------------------------------------------------ #
# hydrocyclone: radial marching, with the field through the velocity
# ------------------------------------------------------------------ #

def cyclone_field(turndown, g_at_design, radius_m):
    """The centrifugal field at this turndown, re-derived through the
    TANGENTIAL VELOCITY.

    The field at the design point fixes the tangential velocity there,
    v = sqrt(a r); the velocity goes with the flow through a fixed
    inlet slot; and the field is v^2/r again. The square on the flow
    ratio is a consequence of that, so bending the exponent in the
    engine shows up here.
    """
    r_mean = radius_m / math.sqrt(2.0)
    v_design = math.sqrt(g_at_design * G * r_mean)
    v = v_design * turndown
    return (v * v / r_mean) / G


def cyclone_cut_by_march(q_per_liner, radius_m, length_m, g_at_design,
                         design_flow, core_fraction, rho_w, rho_o, mu,
                         overload, steps=5000):
    """March the droplet radially inward and bisect on its size.

    A droplet starting at the half-area radius must reach the oil core
    within the liner residence time. Above the overload turndown the
    field stops rising with the flow, and the inlet shear penalty is
    applied to the size that comes out.
    """
    turndown = q_per_liner / design_flow
    g_field = cyclone_field(min(turndown, overload), g_at_design, radius_m)
    residence = (math.pi * radius_m ** 2 * length_m) / q_per_liner
    r_start = radius_m / math.sqrt(2.0)
    r_core = radius_m * core_fraction

    def shortfall(d_m):
        v = creeping_rise(d_m, rho_w, rho_o, mu) * g_field
        dt = residence / steps
        r = r_start
        for _ in range(steps):
            r -= v * dt
            if r <= r_core:
                return 1.0
        return (r_core - r) / radius_m

    d = _bisect(shortfall, 1e-12, 1e-1, iters=100)
    penalty = math.sqrt(turndown / overload) if turndown > overload else 1.0
    return {
        "d50cMicron": d * 1e6 * penalty,
        "idealD50cMicron": d * 1e6,
        "gField": g_field,
        "residenceS": residence,
        "turndownRatio": turndown,
        "shearPenalty": penalty,
    }


def cyclone_capture_fraction_mc(d_micron, q_per_liner, radius_m, length_m,
                                g_at_design, design_flow, core_fraction,
                                rho_w, rho_o, mu, overload,
                                n=200000, seed=8675309):
    """The fraction of droplets of ONE size the liner captures.

    Starting radii uniform over the cross-section BY AREA. This is what
    makes the engine's half-area radius a derived criterion rather than
    a constant: at the reported cut size this fraction must come out at
    one half.
    """
    turndown = q_per_liner / design_flow
    g_field = cyclone_field(min(turndown, overload), g_at_design, radius_m)
    residence = (math.pi * radius_m ** 2 * length_m) / q_per_liner
    penalty = math.sqrt(turndown / overload) if turndown > overload else 1.0
    # the shear penalty coarsens the reported cut, so a droplet of the
    # reported size behaves like one of d/penalty in the ideal liner
    v = creeping_rise((d_micron / penalty) * 1e-6, rho_w, rho_o, mu) * g_field
    reach = v * residence
    r_core = radius_m * core_fraction
    rng = random.Random(seed)
    hit = 0
    for _ in range(n):
        r0 = radius_m * math.sqrt(rng.random())
        if r0 - reach <= r_core:
            hit += 1
    return hit / n


# ------------------------------------------------------------------ #
# flotation: the kinetics assembled from its parts, then marched
# ------------------------------------------------------------------ #

def flotation_parts(q, cell_volume, n_cells, cell_depth, gas_ratio,
                    bubble_micron, rho_w, mu, eps, rho_gas):
    """Assemble the first-order attachment rate from its parts.

    bubble number per unit volume x swept cross-section x rise velocity
    x interception efficiency x attachment probability, with the holdup
    from the superficial gas velocity over the bubble rise. The bubble
    rise cancels between the holdup and the flux, which is why the
    answer does not depend on it; assembling it in this order is what
    catches a dropped factor in the collapsed form.
    """
    d_b = bubble_micron * 1e-6
    residence = cell_volume * n_cells / q
    plan_area = cell_volume / cell_depth
    v_gas = gas_ratio * q / plan_area
    rise = terminal_rise(d_b, rho_w, rho_gas, mu)
    holdup = v_gas / rise["vMS"]
    bubble_volume = (math.pi / 6.0) * d_b ** 3
    n_bubbles = holdup / bubble_volume
    swept = (math.pi / 4.0) * d_b ** 2

    def k_of(d_m):
        e_int = C["interceptionCoefficient"] * (d_m / d_b) ** 2
        return n_bubbles * swept * rise["vMS"] * e_int * eps

    return {
        "residenceS": residence, "planAreaM2": plan_area,
        "superficialGasMS": v_gas, "bubbleRiseMS": rise["vMS"],
        "bubbleReynolds": rise["reynolds"], "gasHoldup": holdup,
        "k_of": k_of,
    }


def flotation_cut_by_march(parts, steps=20000):
    """Bisect on the droplet whose MARCHED attachment reaches one half.

    dEta/dt = k(d) (1 - Eta), integrated by explicit Euler, against the
    engine's closed logarithmic inversion.
    """
    residence = parts["residenceS"]
    k_of = parts["k_of"]

    def attached_minus_half(d_m):
        k = k_of(d_m)
        # as for the bed, the step count has to rise with k*tau or the
        # march steps straight past full attachment and oscillates
        n = min(400000, max(steps, int(20.0 * k * residence) + 1))
        dt = residence / n
        eta = 0.0
        for _ in range(n):
            eta += k * (1.0 - eta) * dt
        return eta - 0.5

    return _bisect(attached_minus_half, 1e-7, 1e-3, iters=100) * 1e6


# ------------------------------------------------------------------ #
# media filter: the bed marched, and the cut size bisected out of it
# ------------------------------------------------------------------ #

def filter_lambda_at(d_micron, q, area, media_micron, lam0, d_ref):
    loading_mhr = (q / area) * 3600.0
    media_factor = (C["filterReferenceMediaMicron"] / media_micron) ** 3
    lam_ref = lam0 * media_factor * (
        C["filterReferenceLoadingMHr"] / max(loading_mhr, 1.0)
    ) ** C["filterLoadingExponent"]
    return lam_ref * (d_micron / d_ref) ** 2


def filter_march(d_micron, q, area, depth, media_micron, lam0, d_ref, n=20000):
    """March the bed layer by layer: dC/dz = -lambda(d) C.

    Explicit Euler, with the step count raised where it has to be so
    that lambda*dz stays small: a coarse droplet has a filter
    coefficient thousands of times the reference one and a fixed step
    count would march it straight through zero.
    """
    lam = filter_lambda_at(d_micron, q, area, media_micron, lam0, d_ref)
    n = min(400000, max(n, int(20.0 * lam * depth) + 1))
    c = 1.0
    dz = depth / n
    for _ in range(n):
        c *= (1.0 - lam * dz)
    return 1.0 - c


def filter_cut_by_march(q, area, depth, media_micron, lam0, d_ref):
    """The droplet the MARCHED bed removes exactly half of."""
    return _bisect(
        lambda d: filter_march(d, q, area, depth, media_micron, lam0, d_ref,
                               n=8000) - 0.5,
        1e-2, 1e3, iters=100)


# ------------------------------------------------------------------ #
# the distribution and the train, by sampling and particle tracking
# ------------------------------------------------------------------ #

def lognormal_cdf(d, d50, sigma):
    return 0.5 * (1.0 + math.erf(math.log(d / d50) / (sigma * math.sqrt(2.0))))


def grade_efficiency(d, d50c, m):
    r = (d / d50c) ** m
    return r / (1.0 + r)


def sample_truncated(rng, d50, sigma, span):
    """One draw from the same TRUNCATED log-normal the engine bins.

    The engine spans span*sigma either side of the median and
    renormalises, so the oracle rejects outside the same span: the span
    is a stated model parameter the golden carries, not a shared
    constant.
    """
    while True:
        z = rng.gauss(0.0, 1.0)
        if -span <= z <= span:
            return d50 * math.exp(sigma * z)


def removal_by_monte_carlo(d50, sigma, d50c, m, span, n=400000, seed=12345):
    rng = random.Random(seed)
    acc = 0.0
    for _ in range(n):
        acc += grade_efficiency(sample_truncated(rng, d50, sigma, span), d50c, m)
    return acc / n


def weighted_median(sizes_sorted, weights, total):
    """Volume median of weighted droplets, walking the sorted sizes."""
    acc = 0.0
    half = total / 2.0
    for i, d in enumerate(sizes_sorted):
        acc += weights[i]
        if acc >= half:
            return d
    return sizes_sorted[-1]


def train_by_particles(inlet_ppm, d50, sigma, span, devices,
                       n=400000, seed=20260916):
    """PARTICLE TRACKING through the whole train.

    Every droplet carries a surviving weight; each device multiplies it
    by its own pass fraction for that droplet's size. The outlet
    concentration is the mean surviving weight and the outlet median is
    the weighted median of the survivors. Nothing here bins anything,
    which is the point: the engine's quadrature and its median
    interpolation are both being checked.
    """
    rng = random.Random(seed)
    sizes = sorted(sample_truncated(rng, d50, sigma, span) for _ in range(n))
    weights = [1.0] * n
    stages = []
    for dev in devices:
        for i, d in enumerate(sizes):
            weights[i] *= 1.0 - grade_efficiency(d, dev["d50cMicron"], dev["sharpness"])
        total = math.fsum(weights)
        stages.append({
            "name": dev["name"],
            "outletOiwPpm": inlet_ppm * total / n,
            "outletMedianMicron": weighted_median(sizes, weights, total),
        })
    total = math.fsum(weights)
    return {
        "stages": stages,
        "outletOiwPpm": inlet_ppm * total / n,
        "outletMedianMicron": weighted_median(sizes, weights, total),
        "inletMedianMicron": weighted_median(sizes, [1.0] * n, float(n)),
        "samples": n,
    }


# ------------------------------------------------------------------ #

def main():
    out = {"declaredConstants": C}

    # --- the CDF series against the C library's erf ---
    out["cdf"] = [
        {"d": d, "d50": d50, "sigma": s, "cdf": lognormal_cdf(d, d50, s)}
        for d, d50, s in [(10, 30, 0.7), (30, 30, 0.7), (100, 30, 0.7),
                          (5, 15, 0.9), (60, 15, 0.9), (0.5, 25, 0.6),
                          (400, 25, 0.6)]
    ]

    # --- the bin grid: the truncated tail is 2 Phi(-span), exactly ---
    out["binGrid"] = [
        {"d50": d50, "sigma": s, "nBins": n, "spanSigma": span,
         "truncatedTailFraction": 2.0 * lognormal_cdf(math.exp(-span), 1.0, 1.0),
         "medianMicron": d50}
        for d50, s, n, span in [(30, 0.7, 60, 4), (30, 0.7, 30, 4),
                                (12, 0.9, 60, 4), (30, 0.7, 60, 5),
                                (30, 0.7, 240, 6)]
    ]

    # --- the removal integral: quadrature against sampling ---
    out["removal"] = [
        {"d50": d50, "sigma": s, "d50cMicron": d50c, "sharpness": m,
         "spanSigma": 4,
         "removalFraction": removal_by_monte_carlo(d50, s, d50c, m, 4)}
        for d50, s, d50c, m in [
            (30, 0.7, 15, 3), (30, 0.7, 30, 3), (30, 0.7, 60, 3),
            (15, 0.9, 20, 2), (50, 0.6, 10, 4), (30, 0.7, 12, 2),
        ]
    ]

    # --- the property fits: a SECOND COPY, pinned and not validated ---
    out["properties"] = [
        {"tC": t, "tdsPpm": tds, "muPaS": water_viscosity(t, tds),
         "rhoWater": water_density(t, tds)}
        for t, tds in [(25, 0), (50, 35000), (60, 150000), (90, 80000),
                       (5, 0), (48.888888888888886, 35000), (100, 300000)]
    ]
    out["oilDensity"] = [
        {"apiGravity": api, "tC": t, "sg60": 141.5 / (131.5 + api),
         "rhoOil": oil_density(api, t)}
        for api, t in [(32, 48.888888888888886), (25, 25), (40, 90),
                       (15, 60), (8, 15.56), (55, 20)]
    ]

    # --- rise velocities from the force balance ---
    out["rise"] = []
    for d, api, t_c, tds in [(5, 25, 25, 0), (30, 32, 50, 35000),
                             (10, 25, 25, 0), (100, 40, 90, 150000),
                             (250, 32, 50, 35000)]:
        rho_w = water_density(t_c, tds)
        rho_o = oil_density(api, t_c)
        mu = water_viscosity(t_c, tds)
        d_m = d * 1e-6
        v_creep = creeping_rise(d_m, rho_w, rho_o, mu)
        real = terminal_rise(d_m, rho_w, rho_o, mu)
        out["rise"].append({
            "dMicron": d, "apiGravity": api, "tC": t_c, "tdsPpm": tds,
            "rhoWater": rho_w, "rhoOil": rho_o, "muPaS": mu,
            "vCreepingMS": v_creep,
            "creepingReynolds": rho_w * v_creep * d_m / mu,
            "vTerminalMS": real["vMS"],
            "terminalReynolds": real["reynolds"],
            "stokesOverTerminal": v_creep / real["vMS"],
        })

    # --- bubbles: where Stokes is the wrong law and the module says so ---
    out["bubbleRise"] = []
    for d, rho_w, mu, rho_gas in [(300, 1013.06, 5.8955e-4, 1.2),
                                  (80, 1013.06, 5.8955e-4, 1.2),
                                  (20, 1013.06, 5.8955e-4, 1.2),
                                  (1000, 998.2, 1.002e-3, 1.2)]:
        real = terminal_rise(d * 1e-6, rho_w, rho_gas, mu)
        out["bubbleRise"].append({
            "dMicron": d, "rhoWater": rho_w, "muPaS": mu,
            "rhoGasKgM3": rho_gas,
            "vTerminalMS": real["vMS"], "reynolds": real["reynolds"],
            "dragCoefficient": real["dragCoefficient"],
        })

    # --- API 421 basins, by trajectory marching ---
    # Two rows well inside the creeping-flow band, one deliberately
    # outside it and one deliberately over the velocity limit, so the
    # gate can tell a case inside a stated band from one outside it.
    out["apiSeparator"] = []
    for q, l, w, depth, t_c, tds, api, f, states_f in [
        (0.005, 12.0, 2.0, 1.2, 50, 35000, 32, 1.5, False),
        (0.004, 8.0, 1.5, 1.0, 25, 0, 25, 1.8, True),
        (0.09, 12.0, 2.0, 1.2, 50, 35000, 32, 1.5, True),
        (0.03, 20.0, 2.5, 0.75, 60, 150000, 38, 1.3, True),
    ]:
        rho_w = water_density(t_c, tds)
        rho_o = oil_density(api, t_c)
        mu = water_viscosity(t_c, tds)
        d50c = basin_cut_by_march(q, l, w, depth, rho_w, rho_o, mu, f)
        horiz = q / (w * depth)
        cut_v = creeping_rise(d50c * 1e-6, rho_w, rho_o, mu)
        row = {
            "flowM3S": q, "lengthM": l, "widthM": w, "depthM": depth,
            "rhoWater": rho_w, "rhoOil": rho_o, "muPaS": mu,
            "overflowRateMS": q / (l * w),
            "designRiseMS": (q / (l * w)) * f,
            "d50cMicron": d50c,
            "cutReynolds": rho_w * cut_v * d50c * 1e-6 / mu,
            "horizontalVelocityMS": horiz,
            "residenceS": l / horiz,
            "expectVelocityWarning": horiz > 0.015,
        }
        # one row states no short-circuit factor at all, so the
        # module's own default is what the golden exercises
        if states_f:
            row["shortCircuitF"] = f
        out["apiSeparator"].append(row)

    # --- plate packs, by the same march through one channel ---
    out["plateInterceptor"] = []
    for q, area, n, eff, t_c, tds, api, states_eff in [
        (0.005, 2.0, 40, 0.7, 50, 35000, 32, False),
        (0.09, 2.0, 40, 0.7, 50, 35000, 32, True),
        (0.02, 1.5, 60, 0.5, 25, 0, 25, True),
    ]:
        rho_w = water_density(t_c, tds)
        rho_o = oil_density(api, t_c)
        mu = water_viscosity(t_c, tds)
        d50c = plate_cut_by_march(q, area, n, eff, rho_w, rho_o, mu)
        # the channel height must cancel: march a second one to prove it
        d50c_alt = plate_cut_by_march(q, area, n, eff, rho_w, rho_o, mu,
                                      channel_height=0.05)
        cut_v = creeping_rise(d50c * 1e-6, rho_w, rho_o, mu)
        row = {
            "flowM3S": q, "plateAreaM2": area, "nPlates": n,
            "rhoWater": rho_w, "rhoOil": rho_o, "muPaS": mu,
            "effectiveAreaM2": area * n * eff,
            "designRiseMS": q / (area * n * eff),
            "d50cMicron": d50c,
            "channelHeightIndependence": abs(d50c / d50c_alt - 1.0),
            "cutReynolds": rho_w * cut_v * d50c * 1e-6 / mu,
        }
        if states_eff:
            row["efficiencyFactor"] = eff
        out["plateInterceptor"].append(row)

    # --- hydrocyclones, by radial marching plus a capture Monte Carlo ---
    out["hydrocyclone"] = []
    for q, n_liners, t_c, tds, api, states_all in [
        (0.012, 20, 50, 35000, 32, False),
        (0.09201, 160, 48.888888888888886, 35000, 32, False),
        (0.004, 20, 50, 35000, 32, True),
        (0.018, 20, 50, 35000, 32, True),
        (0.03, 40, 60, 150000, 38, True),
    ]:
        rho_w = water_density(t_c, tds)
        rho_o = oil_density(api, t_c)
        mu = water_viscosity(t_c, tds)
        radius = C["linerDiameterM"] / 2.0
        march = cyclone_cut_by_march(
            q / n_liners, radius, C["linerLengthM"], C["gFieldAtDesign"],
            C["designFlowPerLinerM3S"], C["coreRadiusFraction"],
            rho_w, rho_o, mu, C["overloadTurndown"])
        mc = cyclone_capture_fraction_mc(
            march["d50cMicron"], q / n_liners, radius, C["linerLengthM"],
            C["gFieldAtDesign"], C["designFlowPerLinerM3S"],
            C["coreRadiusFraction"], rho_w, rho_o, mu, C["overloadTurndown"])
        row = {
            "flowM3S": q, "nLiners": n_liners,
            "rhoWater": rho_w, "rhoOil": rho_o, "muPaS": mu,
            "d50cMicron": march["d50cMicron"],
            "idealD50cMicron": march["idealD50cMicron"],
            "gField": march["gField"],
            "residenceS": march["residenceS"],
            "turndownRatio": march["turndownRatio"],
            "shearPenalty": march["shearPenalty"],
            "mcCaptureFractionAtCut": mc,
            "expectStarvedWarning": march["turndownRatio"] < 0.5,
            "expectOverloadWarning": march["turndownRatio"] > C["overloadTurndown"],
        }
        if states_all:
            row["linerDiameterM"] = C["linerDiameterM"]
            row["linerLengthM"] = C["linerLengthM"]
            row["designFlowPerLinerM3S"] = C["designFlowPerLinerM3S"]
            row["gFieldAtDesign"] = C["gFieldAtDesign"]
            row["coreRadiusFraction"] = C["coreRadiusFraction"]
        out["hydrocyclone"].append(row)

    # --- flotation, assembled from parts and marched ---
    out["flotation"] = []
    for q, vol, n_cells, depth, ratio, bubble, t_c, tds, api, states_all in [
        (0.09201, 8.0, 4, 3.0, 0.2, 300, 48.888888888888886, 35000, 32, False),
        (0.09201, 8.0, 4, 3.0, 0.03, 80, 48.888888888888886, 35000, 32, True),
        (0.05, 8.0, 4, 3.0, 0.2, 300, 50, 35000, 32, True),
        (1.0, 8.0, 4, 3.0, 0.2, 300, 50, 35000, 32, True),
        (0.05, 20.0, 1, 4.0, 0.5, 600, 25, 0, 25, True),
    ]:
        rho_w = water_density(t_c, tds)
        rho_o = oil_density(api, t_c)
        mu = water_viscosity(t_c, tds)
        parts = flotation_parts(q, vol, n_cells, depth, ratio, bubble,
                                rho_w, mu, C["attachmentEfficiency"],
                                C["flotationGasDensityKgM3"])
        row = {
            "flowM3S": q, "cellVolumeM3": vol, "nCells": n_cells,
            "rhoWater": rho_w, "rhoOil": rho_o, "muPaS": mu,
            "residenceS": parts["residenceS"],
            "planAreaM2": parts["planAreaM2"],
            "superficialGasMS": parts["superficialGasMS"],
            "bubbleRiseMS": parts["bubbleRiseMS"],
            "bubbleReynolds": parts["bubbleReynolds"],
            "gasHoldup": parts["gasHoldup"],
            "d50cMicron": flotation_cut_by_march(parts),
            "expectResidenceWarning": parts["residenceS"] < 60,
            "expectHoldupWarning": parts["gasHoldup"] > 0.2,
        }
        if states_all:
            row["cellDepthM"] = depth
            row["gasRatio"] = ratio
            row["bubbleMicron"] = bubble
            row["attachmentEfficiency"] = C["attachmentEfficiency"]
            row["gasDensityKgM3"] = C["flotationGasDensityKgM3"]
        out["flotation"].append(row)

    # --- the filter: one route, marched, and its cut bisected out of it ---
    out["mediaFilter"] = []
    for q, area, depth, media, lam0, states_all in [
        (0.05, 6.0, 0.9, 800.0, 3.5, False),
        (0.09201, 16.0, 0.9, 800.0, 3.5, True),
        (0.09, 4.0, 1.2, 800.0, 3.5, True),
        (0.05, 16.0, 3.0, 1200.0, 4.2, True),
        (0.09201, 16.0, 0.1, 800.0, 3.5, True),
    ]:
        d_ref = C["filterReferenceDropletMicron"]
        row = {
            "flowM3S": q, "areaM2": area,
            "loadingMHr": (q / area) * 3600.0,
            "lambdaAtRefPerM": filter_lambda_at(d_ref, q, area, media, lam0, d_ref),
            "removalAtRefDroplet": filter_march(d_ref, q, area, depth, media, lam0, d_ref),
            "d50cMicron": filter_cut_by_march(q, area, depth, media, lam0, d_ref),
            "referenceDropletMicron": d_ref,
            "expectBreakthroughWarning": (q / area) * 3600.0 > 25.0,
        }
        if states_all:
            row["bedDepthM"] = depth
            row["mediaMicron"] = media
            row["filterCoefficientPerM"] = lam0
        out["mediaFilter"].append(row)

    # --- the whole train, by particle tracking ---
    out["train"] = []
    for label, inlet_ppm, d50, sigma, devices in [
        ("the Suite's own shipped default train", 500, 30, 0.7, [
            {"name": "CPI", "d50cMicron": 100.0, "sharpness": 3},
            {"name": "Hydrocyclone", "d50cMicron": 4.6, "sharpness": 3},
            {"name": "Walnut shell filter", "d50cMicron": 11.2, "sharpness": 2},
        ]),
        ("three identical devices, to show the coupling", 500, 30, 0.7, [
            {"name": "A", "d50cMicron": 12, "sharpness": 3},
            {"name": "B", "d50cMicron": 12, "sharpness": 3},
            {"name": "C", "d50cMicron": 12, "sharpness": 3},
        ]),
        ("fine sheared inlet water", 2000, 12, 0.9, [
            {"name": "CPI", "d50cMicron": 60, "sharpness": 3},
            {"name": "IGF", "d50cMicron": 18, "sharpness": 2},
        ]),
    ]:
        res = train_by_particles(inlet_ppm, d50, sigma, 4, devices)
        out["train"].append({
            "label": label, "inletOiwPpm": inlet_ppm,
            "inletD50Micron": d50, "sigma": sigma, "spanSigma": 4,
            "devices": devices,
            "stages": res["stages"],
            "outletOiwPpm": res["outletOiwPpm"],
            "outletMedianMicron": res["outletMedianMicron"],
            "inletMedianMicron": res["inletMedianMicron"],
            "samples": res["samples"],
        })

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "producedwater_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
