#!/usr/bin/env python3
"""Independent oracle for engines/facilities/producedWater.js.

Independent routes:
 - the log-normal distribution integrated against a grade-efficiency
   curve by MONTE CARLO sampling of droplet diameters, rather than the
   module's binned quadrature. Two entirely different numerical
   methods for the same integral.
 - the log-normal CDF from math.erf (the C library's), against the
   module's Abramowitz & Stegun series approximation
 - Stokes rise and the API 421 cut-size inversion re-derived directly
 - depth filtration by explicit layer-by-layer marching of the bed,
   against the module's closed exponential

stdlib only. Writes test-data/facilities/goldens/producedwater_cases.json
"""

import json
import math
import os
import random

G = 9.80665


def lognormal_cdf(d, d50, sigma):
    return 0.5 * (1.0 + math.erf(math.log(d / d50) / (sigma * math.sqrt(2.0))))


def grade_efficiency(d, d50c, m):
    r = (d / d50c) ** m
    return r / (1.0 + r)


def removal_by_monte_carlo(d50, sigma, d50c, m, n=400000, seed=12345):
    """Volume-weighted removal by sampling the log-normal directly.

    The distribution is a VOLUME distribution, so a uniform sample of
    it already carries volume weight: draw diameters from the
    log-normal and average the grade efficiency.
    """
    rng = random.Random(seed)
    acc = 0.0
    for _ in range(n):
        d = math.exp(rng.gauss(math.log(d50), sigma))
        acc += grade_efficiency(d, d50c, m)
    return acc / n


def water_viscosity(t_c, tds_ppm):
    mu_fresh = 2.414e-5 * 10.0 ** (247.8 / (t_c + 273.15 - 140.0))
    w = min(max(tds_ppm, 0), 300000) / 1e6
    return mu_fresh * (1.0 + 1.8 * w)


def water_density(t_c, tds_ppm):
    rho0 = 1000.0 * (1.0 - ((t_c + 288.9414)
                            / (508929.2 * (t_c + 68.12963)))
                     * (t_c - 3.9863) ** 2)
    w = min(max(tds_ppm, 0), 300000) / 1e6
    return rho0 + 700.0 * w


def oil_density(api, t_c):
    sg60 = 141.5 / (131.5 + api)
    return sg60 * 999.0 * (1.0 - 0.0007 * (t_c - 15.56))


def stokes_rise(d_micron, rho_w, rho_o, mu):
    d = d_micron * 1e-6
    return G * d * d * (rho_w - rho_o) / (18.0 * mu)


def api_separator(q, l, w, depth, rho_w, rho_o, mu, f):
    area = l * w
    overflow = q / area
    design_rise = overflow * f
    d = math.sqrt(18.0 * mu * design_rise / (G * (rho_w - rho_o)))
    return {
        "flowM3S": q, "lengthM": l, "widthM": w, "depthM": depth,
        "rhoWater": rho_w, "rhoOil": rho_o, "muPaS": mu,
        "shortCircuitF": f,
        "overflowRateMS": overflow,
        "d50cMicron": d * 1e6,
        "horizontalVelocityMS": q / (w * depth),
        "residenceS": l / (q / (w * depth)),
    }


def media_filter_by_marching(q, area, depth, lam0, n=20000):
    """March the bed layer by layer: dC/dz = -lambda C."""
    loading_ms = q / area
    loading_mhr = loading_ms * 3600.0
    lam = lam0 * (10.0 / max(loading_mhr, 1.0)) ** 0.5
    c = 1.0
    dz = depth / n
    for _ in range(n):
        c *= (1.0 - lam * dz)   # explicit Euler; n large so it converges
    return {
        "flowM3S": q, "areaM2": area, "bedDepthM": depth,
        "filterCoefficientPerM": lam0,
        "loadingMHr": loading_mhr,
        "lambdaPerM": lam,
        "removalFraction": 1.0 - c,
    }


def main():
    out = {}

    out["cdf"] = []
    for d, d50, sigma in [(10, 30, 0.7), (30, 30, 0.7), (100, 30, 0.7),
                          (5, 15, 0.9), (60, 15, 0.9)]:
        out["cdf"].append({"d": d, "d50": d50, "sigma": sigma,
                           "cdf": lognormal_cdf(d, d50, sigma)})

    out["removal"] = []
    for d50, sigma, d50c, m in [
        (30, 0.7, 15, 3), (30, 0.7, 30, 3), (30, 0.7, 60, 3),
        (15, 0.9, 20, 2), (50, 0.6, 10, 4),
    ]:
        out["removal"].append({
            "d50": d50, "sigma": sigma, "d50cMicron": d50c, "sharpness": m,
            "removalFraction": removal_by_monte_carlo(d50, sigma, d50c, m),
        })

    out["properties"] = []
    for t_c, tds in [(25, 0), (50, 35000), (60, 150000), (90, 80000)]:
        out["properties"].append({
            "tC": t_c, "tdsPpm": tds,
            "muPaS": water_viscosity(t_c, tds),
            "rhoWater": water_density(t_c, tds),
        })

    out["stokes"] = []
    for d, api, t_c, tds in [(30, 32, 50, 35000), (10, 25, 25, 0), (100, 40, 90, 150000)]:
        rho_w = water_density(t_c, tds)
        rho_o = oil_density(api, t_c)
        mu = water_viscosity(t_c, tds)
        out["stokes"].append({
            "dMicron": d, "apiGravity": api, "tC": t_c, "tdsPpm": tds,
            "rhoWater": rho_w, "rhoOil": rho_o, "muPaS": mu,
            "vMS": stokes_rise(d, rho_w, rho_o, mu),
        })

    out["apiSeparator"] = []
    for q, l, w, depth, t_c, tds, api, f in [
        (0.09, 12.0, 2.0, 1.2, 50, 35000, 32, 1.5),
        (0.03, 8.0, 1.5, 1.0, 25, 0, 25, 1.8),
    ]:
        rho_w = water_density(t_c, tds)
        rho_o = oil_density(api, t_c)
        mu = water_viscosity(t_c, tds)
        out["apiSeparator"].append(api_separator(q, l, w, depth, rho_w, rho_o, mu, f))

    out["mediaFilter"] = [
        media_filter_by_marching(0.05, 6.0, 0.9, 3.5),
        media_filter_by_marching(0.09, 4.0, 1.2, 3.5),
    ]

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "producedwater_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
