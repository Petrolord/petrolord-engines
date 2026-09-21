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
 - checkLayout from its stated contract: pairs judged by Vincenty
   distance, only positive requirements counted, skipped items, pass
   and passStatus, complete, the absolute ordering and both named
   worst rankings. The spacing table is typed here from the module's
   stated figures (a table is a table; the gate checks the lookup).

Each retired rule is also computed as a NEGATIVE CONTROL: the old
checkLayout counted zero-requirement pairs, passed with nothing
checked, and ranked "worst" by relative shortfall.

stdlib only. Writes test-data/facilities/goldens/spacing_cases.json
"""

import json
import math
import os

R = 6371008.8

TABLE = {
    "wellhead": {"wellhead": 3, "manifold": 8, "separator": 15, "heaterTreater": 30, "tank": 30,
                 "flare": 60, "pump": 15, "compressor": 30, "control": 30, "valve": 0, "psv": 0},
    "manifold": {"manifold": 3, "separator": 8, "heaterTreater": 15, "tank": 15, "flare": 60,
                 "pump": 8, "compressor": 15, "control": 30, "valve": 0, "psv": 0},
    "separator": {"separator": 3, "heaterTreater": 15, "tank": 15, "flare": 60, "pump": 8,
                  "compressor": 15, "control": 30, "valve": 0, "psv": 0},
    "heaterTreater": {"heaterTreater": 8, "tank": 30, "flare": 60, "pump": 15, "compressor": 15,
                      "control": 30, "valve": 0, "psv": 0},
    "tank": {"tank": 3, "flare": 60, "pump": 15, "compressor": 30, "control": 30,
             "valve": 0, "psv": 0},
    "flare": {"flare": 60, "pump": 60, "compressor": 60, "control": 90, "valve": 0, "psv": 0},
    "pump": {"pump": 3, "compressor": 8, "control": 15, "valve": 0, "psv": 0},
    "compressor": {"compressor": 8, "control": 30, "valve": 0, "psv": 0},
    "control": {"control": 0, "valve": 0, "psv": 0},
    "valve": {"valve": 0, "psv": 0},
    "psv": {"psv": 0},
}


def required(a, b):
    if a in TABLE and b in TABLE[a]:
        return TABLE[a][b]
    if b in TABLE and a in TABLE[b]:
        return TABLE[b][a]
    return None


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
    return {"qKw": q, "distanceM": d, "intensityAtDistance": back}


def pool_fire(diam, burn, lhv, allowable, f, tau):
    area = math.pi * diam * diam / 4
    mdot = burn * area
    q = mdot * lhv
    rho_air = 1.2
    height = diam * 42 * (burn / (rho_air * math.sqrt(9.80665 * diam))) ** 0.61
    r = math.sqrt(tau * f * q / (4 * math.pi * allowable))
    within = r <= diam / 2
    return {
        "areaM2": area, "burnRateKgS": mdot, "qKw": q,
        "flameHeightM": height,
        "radiusFromCentreM": r,
        "intensityAtRadius": tau * f * q / (4 * math.pi * r * r),
        "setbackFromEdgeM": 0.0 if within else r - diam / 2,
        "setbackStatus": "within-pool-edge" if within else "beyond-pool-edge",
        "nearFieldNote": r < height,
        # NEGATIVE CONTROL: the retired max(0) clamp had no status
        "retiredClampSetbackM": max(0.0, r - diam / 2),
    }


# ------------------------------------------------------------------ #
# layout
# ------------------------------------------------------------------ #

LAT0, LON0 = 4.8156, 7.0498


def place(item_id, name, typ, north_m, east_m):
    return {
        "id": item_id, "name": name, "type": typ,
        "lat": LAT0 + north_m / 111320.0,
        "lon": LON0 + east_m / (111320.0 * math.cos(math.radians(LAT0))),
    }


def unplaced(item_id, name, typ):
    return {"id": item_id, "name": name, "type": typ, "lat": None, "lon": None}


def ok(it):
    return isinstance(it.get("lat"), (int, float)) and isinstance(it.get("lon"), (int, float))


def check_layout(items, sources):
    skipped = [{"id": it["id"], "reason": "bad-coordinates"} for it in items if not ok(it)]
    unknown, violations = [], []
    checked = zero = 0
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            a, b = items[i], items[j]
            if not (ok(a) and ok(b)):
                continue
            req = required(a["type"], b["type"])
            if req is None:
                unknown.append({"typeA": a["type"], "typeB": b["type"]})
                continue
            if req <= 0:
                zero += 1
                continue
            d = vincenty_sphere(a["lat"], a["lon"], b["lat"], b["lon"])
            checked += 1
            if d < req:
                violations.append({"kind": "spacing", "aId": a["id"], "bId": b["id"],
                                   "actualM": d, "requiredM": req, "shortfallM": req - d,
                                   "shortfallFraction": (req - d) / req, "order": len(violations)})
    for src in sources:
        s = next((it for it in items if it["id"] == src["id"]), None)
        if s is None:
            skipped.append({"id": src["id"], "reason": "radiation-source-not-placed"})
            continue
        if not ok(s):
            continue
        for o in items:
            if o["id"] == s["id"] or not ok(o):
                continue
            if not src["setbackM"] > 0:
                zero += 1
                continue
            d = vincenty_sphere(s["lat"], s["lon"], o["lat"], o["lon"])
            checked += 1
            if d < src["setbackM"]:
                violations.append({"kind": "radiation", "aId": s["id"], "bId": o["id"],
                                   "actualM": d, "requiredM": src["setbackM"],
                                   "shortfallM": src["setbackM"] - d,
                                   "shortfallFraction": (src["setbackM"] - d) / src["setbackM"],
                                   "order": len(violations)})
    by_abs = sorted(violations, key=lambda v: (-v["shortfallM"], -v["shortfallFraction"], v["order"]))
    by_rel = sorted(violations, key=lambda v: (-v["shortfallFraction"], -v["shortfallM"], v["order"]))
    pair = lambda v: None if v is None else [v["kind"], v["aId"], v["bId"]]
    return {
        "checked": checked,
        "zeroRequirementPairs": zero,
        "violations": [dict({k: v[k] for k in v if k != "order"}) for v in by_abs],
        "worstAbsolutePair": pair(by_abs[0] if by_abs else None),
        "worstRelativePair": pair(by_rel[0] if by_rel else None),
        "unknownPairs": unknown,
        "skipped": skipped,
        "complete": not skipped and not unknown,
        "pass": None if checked == 0 else not violations,
        "passStatus": "nothing-checked" if checked == 0 else "checked",
    }


def retired_check_layout(items, sources):
    """NEGATIVE CONTROL: the retired rule. Bad coordinates dropped
    silently, zero-requirement pairs counted, pass = no violations,
    worst = largest RELATIVE shortfall."""
    checked, viol = 0, []
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            a, b = items[i], items[j]
            req = required(a["type"], b["type"])
            if req is None or not (ok(a) and ok(b)):
                continue
            d = vincenty_sphere(a["lat"], a["lon"], b["lat"], b["lon"])
            checked += 1
            if req > 0 and d < req:
                viol.append((((req - d) / req), ["spacing", a["id"], b["id"]]))
    for src in sources:
        s = next((it for it in items if it["id"] == src["id"]), None)
        if s is None or not src["setbackM"] > 0:
            continue
        for o in items:
            if o["id"] == s["id"] or not (ok(s) and ok(o)):
                continue
            d = vincenty_sphere(s["lat"], s["lon"], o["lat"], o["lon"])
            checked += 1
            if d < src["setbackM"]:
                viol.append(((src["setbackM"] - d) / src["setbackM"], ["radiation", s["id"], o["id"]]))
    viol.sort(key=lambda v: -v[0])
    return {"checked": checked, "pass": not viol, "worstPair": viol[0][1] if viol else None}


def case(name, note, inp, expected):
    return {"name": name, "note": note, "input": inp, "expected": expected}


def main():
    out = {}

    out["distances"] = []
    for name, (lat1, lon1, lat2, lon2) in [
        ("portHarcourt90m", (4.8156, 7.0498, 4.8160, 7.0505)),
        ("portHarcourtDueNorth", (4.8156, 7.0498, 4.8200, 7.0498)),
        ("highLatitudeSmallDLon", (60.0, 5.0, 60.0, 5.001)),
        ("equator", (0.0, 0.0, 0.0, 0.01)),
    ]:
        out["distances"].append(case(
            name, "haversine against Vincenty and the 3D chord",
            {"lat1": lat1, "lon1": lon1, "lat2": lat2, "lon2": lon2},
            {"vincentyM": vincenty_sphere(lat1, lon1, lat2, lon2),
             "chordM": chord_route(lat1, lon1, lat2, lon2)}))

    out["flare"] = []
    for name, (rate, lhv, allow, f, tau) in [
        ("flare20kgsAt4p73", (20.0, 46000.0, 4.73, 0.3, 1.0)),
        ("flare5kgsAt1p58", (5.0, 43000.0, 1.58, 0.25, 0.9)),
    ]:
        out["flare"].append(case(
            name, "point source, round trip to the allowable",
            {"reliefRateKgS": rate, "lhvKjKg": lhv, "allowableKwM2": allow,
             "fractionRadiated": f, "transmissivity": tau},
            flare_setback(rate, lhv, allow, f, tau)))

    out["poolFire"] = []
    for name, note, (diam, burn, lhv, allow, f, tau) in [
        ("pool20mAt4p73", "point source from the pool centre, beyond the edge", (20.0, 0.055, 43000.0, 4.73, 0.35, 1.0)),
        ("pool6mAt1p58", "point source from the pool centre, beyond the edge", (6.0, 0.055, 43000.0, 1.58, 0.35, 1.0)),
        ("pool40mAt4p73Tau0p9", "point source from the pool centre, beyond the edge", (40.0, 0.062, 44000.0, 4.73, 0.35, 0.9)),
        ("withinPoolEdgeEdgeCase",
         "deliberate edge case: an allowable of 4000 kW/m2 puts the point-source radius inside the pool edge, so the setback is 0 with setbackStatus within-pool-edge",
         (20.0, 0.055, 43000.0, 4000.0, 0.35, 1.0)),
    ]:
        out["poolFire"].append(case(
            name, note,
            {"poolDiameterM": diam, "burnRateKgM2S": burn, "lhvKjKg": lhv,
             "allowableKwM2": allow, "fractionRadiated": f, "transmissivity": tau},
            pool_fire(diam, burn, lhv, allow, f, tau)))

    flare68 = flare_setback(20.0, 46000.0, 4.73, 0.3, 1.0)["distanceM"]
    layouts = [
        ("s4RankingsDisagree",
         "pumps 1 m apart (2 m short of 3 m, fraction 0.67) against a control room 50 m from a flare (40 m short of 90 m, fraction 0.44): worstAbsolute is the flare pair, worstRelative the pumps; the retired worst was the pumps",
         [place("p1", "Pump 1", "pump", 0, 0), place("p2", "Pump 2", "pump", 1, 0),
          place("f1", "Flare", "flare", 0, 500), place("c1", "Control room", "control", 50, 500)],
         []),
        ("s3AllUnplacedNothingChecked",
         "retired rule: checked 0 and pass true; now pass null, passStatus nothing-checked, both items skipped",
         [unplaced("w1", "Wellhead", "wellhead"), unplaced("s1", "Separator", "separator")],
         []),
        ("s3ZeroRequirementPairOnly",
         "a valve beside a PSV has no requirement: the retired rule counted it as one passed check",
         [place("v1", "Valve", "valve", 0, 0), place("r1", "PSV", "psv", 1, 0)],
         []),
        ("s3SkippedItemPassesButIncomplete",
         "three well-spread items pass, a fourth has no coordinates: pass true, complete false",
         [place("w1", "Wellhead", "wellhead", 0, 0), place("s1", "Separator", "separator", 200, 0),
          place("t1", "Tank", "tank", 400, 0), unplaced("x1", "Unplaced tank", "tank")],
         []),
        ("radiationAndTableWithGhostSource",
         "a tank 50 m from a flare breaks the 60 m table figure and the 68 m computed setback; a radiation source with no placed item is skipped",
         [place("f1", "Flare", "flare", 0, 0), place("t1", "Tank", "tank", 50, 0)],
         [{"id": "f1", "setbackM": flare68, "allowableKwM2": 4.73, "label": "Flare radiation"},
          {"id": "ghost", "setbackM": 40.0, "allowableKwM2": 4.73, "label": "Unplaced flare"}]),
        ("unknownPairIncomplete",
         "an unknown type pair is reported and makes the check incomplete; the known pair is still judged",
         [place("a", "Thing", "unicorn", 0, 0), place("b", "Tank", "tank", 2, 0),
          place("c", "Wellhead", "wellhead", 10, 0)],
         []),
    ]
    out["layout"] = []
    for name, note, items, sources in layouts:
        exp = check_layout(items, sources)
        exp["retiredRule"] = retired_check_layout(items, sources)
        out["layout"].append(case(name, note, {"items": items, "radiationSources": sources}, exp))

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "spacing_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write("\n")
    print("wrote", dest)


if __name__ == "__main__":
    main()
