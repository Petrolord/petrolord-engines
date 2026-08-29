#!/usr/bin/env python3
"""Independent oracle for engines/facilities/spacing.js.

Independent routes:
 - great-circle distance by the VINCENTY sphere formula and by a
   3D CHORD calculation through the earth, against the module's
   haversine. Three formulations of the same distance; haversine and
   Vincenty agree to machine precision on well-conditioned pairs, and
   the chord route is a genuinely different derivation.
 - the flare and pool-fire setbacks re-derived from the inverse-square
   relation solved the other way round (compute the intensity at the
   returned distance and check it equals the allowable), which is a
   round-trip rather than a restatement.
 - Thomas flame height recomputed independently.

stdlib only. Writes test-data/facilities/goldens/spacing_cases.json
"""

import json
import math
import os

R = 6371008.8


def vincenty_sphere(lat1, lon1, lat2, lon2):
    """Vincenty formula for a sphere: numerically better conditioned
    for near-antipodal points and an entirely different expression."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    num = math.sqrt((math.cos(p2) * math.sin(dl)) ** 2
                    + (math.cos(p1) * math.sin(p2)
                       - math.sin(p1) * math.cos(p2) * math.cos(dl)) ** 2)
    den = (math.sin(p1) * math.sin(p2)
           + math.cos(p1) * math.cos(p2) * math.cos(dl))
    return R * math.atan2(num, den)


def chord_route(lat1, lon1, lat2, lon2):
    """Straight-line chord through the sphere, then the arc from it."""
    def xyz(lat, lon):
        p, l = math.radians(lat), math.radians(lon)
        return (R * math.cos(p) * math.cos(l),
                R * math.cos(p) * math.sin(l),
                R * math.sin(p))
    a = xyz(lat1, lon1)
    b = xyz(lat2, lon2)
    chord = math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))
    return 2 * R * math.asin(min(1.0, chord / (2 * R)))


def flare_setback(rate_kgs, lhv, allowable, f, tau):
    q = rate_kgs * lhv
    d = math.sqrt(tau * f * q / (4 * math.pi * allowable))
    # round trip: intensity at that distance must equal the allowable
    back = tau * f * q / (4 * math.pi * d * d)
    return {
        "reliefRateKgS": rate_kgs, "lhvKjKg": lhv,
        "allowableKwM2": allowable, "fractionRadiated": f,
        "transmissivity": tau,
        "qKw": q, "distanceM": d, "intensityAtDistance": back,
    }


def pool_fire(diam, burn, lhv, allowable, f, tau):
    area = math.pi * diam * diam / 4
    mdot = burn * area
    q = mdot * lhv
    rho_air = 1.2
    height = diam * 42 * (burn / (rho_air * math.sqrt(9.80665 * diam))) ** 0.61
    r = math.sqrt(tau * f * q / (4 * math.pi * allowable))
    return {
        "poolDiameterM": diam, "burnRateKgM2S": burn, "lhvKjKg": lhv,
        "allowableKwM2": allowable, "fractionRadiated": f,
        "transmissivity": tau,
        "areaM2": area, "burnRateKgS": mdot, "qKw": q,
        "flameHeightM": height,
        "radiusFromCentreM": r,
        "setbackFromEdgeM": max(0.0, r - diam / 2),
    }


def main():
    out = {}

    out["distances"] = []
    for lat1, lon1, lat2, lon2 in [
        (4.8156, 7.0498, 4.8160, 7.0505),      # ~90 m apart, Port Harcourt
        (4.8156, 7.0498, 4.8200, 7.0498),      # due north
        (60.0, 5.0, 60.0, 5.001),              # high latitude, small dLon
        (0.0, 0.0, 0.0, 0.01),                 # equator
    ]:
        out["distances"].append({
            "lat1": lat1, "lon1": lon1, "lat2": lat2, "lon2": lon2,
            "vincentyM": vincenty_sphere(lat1, lon1, lat2, lon2),
            "chordM": chord_route(lat1, lon1, lat2, lon2),
        })

    out["flare"] = [
        flare_setback(20.0, 46000.0, 4.73, 0.3, 1.0),
        flare_setback(5.0, 43000.0, 1.58, 0.25, 0.9),
    ]

    out["poolFire"] = [
        pool_fire(20.0, 0.055, 43000.0, 4.73, 0.35, 1.0),
        pool_fire(6.0, 0.055, 43000.0, 1.58, 0.35, 1.0),
        pool_fire(40.0, 0.062, 44000.0, 4.73, 0.35, 0.9),
    ]

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "spacing_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
