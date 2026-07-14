"""Generate the G8.0 earth-modeling goldens (deterministic, stdlib-only
— no RNG anywhere; rerunning must be byte-identical).

Writes test-data/earthmodel/goldens.json: a complete analytic fixture
model — 3 planar surfaces on distinct source frames resampled onto a
25x20 model grid, a monotonic clamp with a real pinch-out, an L-shaped
fault polygon giving 2 blocks, 4 wells (2 deviated) with tops / zone
intervals / planar property values, well-tie residuals, property
population probes for constant / trend / simple kriging, and per-zone
per-block volume tables.

main() ASSERTS the anchors before writing (G2 fixture-v2 lesson — a
regeneration that breaks physics refuses to land):

  A1  Bilinear resampling reproduces the analytic planes exactly at
      every model node (planes are linear fields; < 1e-9 m).
  A2  Clamping the already-monotonic (S1, S2) stack is a no-op.
  A3  S3 crosses S2 east of x = 1775: exactly 180 nodes clamp, the
      clamped S3 is >= S2 everywhere, and zone-B thickness equals
      max(0, 31 - 0.04*(x-1000)) analytically (< 1e-9).
  A4  Fault-block census is exactly {0: 326, 1: 174} (hand-counted
      from the polygon/lattice geometry).
  A5  Vertical well: TVD == MD, x/y constant. Synthetic 0->90 build:
      both dZ and dE equal 2*dMD/pi (the exact circular arc; < 1e-9).
  A6  Trend fit on planar control values recovers (a, b, c) exactly
      and reproduces every control value (< 1e-9).
  A7  Simple kriging is exact at a data point and returns the mean at
      a target far beyond the variogram range (< 1e-9).
  A8  Zone-A bulk volume equals the closed form 45,000,000 m3
      (thickness 30 + 0.01*(x-1000) over the 25x20, 50 m grid;
      < 1e-6 rel).
  A9  position_at_md returns a station exactly when md hits it.
"""

import json
import math
import os

import oracle

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "..",
                   "test-data", "earthmodel")

MODEL_SPEC = {"x0": 1000.0, "y0": 2000.0, "dx": 50.0, "dy": 50.0,
              "nx": 25, "ny": 20}

# Source frames deliberately differ from the model frame (and from each
# other) so resampling is genuinely exercised.
SRC_SPECS = {
    "s1": {"x0": 900.0, "y0": 1900.0, "dx": 40.0, "dy": 40.0,
           "nx": 40, "ny": 32},
    "s2": {"x0": 950.0, "y0": 1950.0, "dx": 60.0, "dy": 45.0,
           "nx": 27, "ny": 27},
    "s3": {"x0": 880.0, "y0": 1880.0, "dx": 55.0, "dy": 55.0,
           "nx": 30, "ny": 25},
}

# Analytic planar surfaces (depth m, positive down, TVDSS):
#   S1 (Top A)          z = 1500 + 0.05 (x-1000) + 0.02 (y-2000)
#   S2 (Base A = Top B) z = S1 + 30 + 0.01 (x-1000)
#   S3 (Base B)         z = 1561 + 0.02 (x-1000) + 0.02 (y-2000)
# S3 - S2 = 31 - 0.04 (x-1000): crosses zero at x = 1775 (deliberately
# OFF the 50 m node lattice so no exact-tie clamps) -> the model
# columns x = 1800..2200 (9 cols x 20 rows = 180 nodes) must clamp.
PLANES = {
    "s1": lambda x, y: 1500.0 + 0.05 * (x - 1000.0) + 0.02 * (y - 2000.0),
    "s2": lambda x, y: 1530.0 + 0.06 * (x - 1000.0) + 0.02 * (y - 2000.0),
    "s3": lambda x, y: 1561.0 + 0.02 * (x - 1000.0) + 0.02 * (y - 2000.0),
}

# L-shaped fault polygon (world XY); every edge is off the 50 m node
# lattice so containment is unambiguous.
FAULT_POLYGON = [(975.0, 1975.0), (1575.0, 1975.0), (1575.0, 2430.0),
                 (1275.0, 2430.0), (1275.0, 2975.0), (975.0, 2975.0)]

# Wells: heads, KB, deviation ({md, inc, azi} deg, md ascending), tops
# (name -> MD) and zone intervals (per-well MD ranges, the
# geo_wells_zones shape).
WELLS = {
    "W1": {"x": 1100.0, "y": 2100.0, "kb": 25.0,
           "deviation": [{"md": 2000.0, "inc": 0.0, "azi": 0.0}],
           "tops": {"TopA": 1530.0, "TopB": 1565.0, "BaseB": 1595.0},
           "zones": {"A": (1530.0, 1565.0), "B": (1565.0, 1595.0)}},
    "W2": {"x": 1400.0, "y": 2200.0, "kb": 30.0,
           "deviation": [{"md": 1200.0, "inc": 0.0, "azi": 0.0},
                         {"md": 1500.0, "inc": 45.0, "azi": 90.0},
                         {"md": 1900.0, "inc": 45.0, "azi": 90.0}],
           "tops": {"TopA": 1580.0, "TopB": 1700.0, "BaseB": 1760.0},
           "zones": {"A": (1580.0, 1700.0), "B": (1700.0, 1760.0)}},
    "W3": {"x": 1900.0, "y": 2700.0, "kb": 20.0,
           "deviation": [{"md": 1800.0, "inc": 0.0, "azi": 0.0}],
           "tops": {"TopA": 1580.0, "TopB": 1625.0, "BaseB": 1655.0},
           "zones": {"A": (1580.0, 1625.0), "B": (1625.0, 1655.0)}},
    "W4": {"x": 2050.0, "y": 2150.0, "kb": 28.0,
           "deviation": [{"md": 1800.0, "inc": 0.0, "azi": 0.0}],
           "tops": {"TopA": 1584.0, "TopB": 1630.0, "BaseB": 1660.0},
           "zones": {"A": (1584.0, 1630.0), "B": (1630.0, 1660.0)}},
}

# Planar property fields evaluated at each zone-A control point, so the
# trend fit must recover them exactly (A6).
PROP_PLANES = {
    "phi": (0.32, -4.0e-5, -1.0e-5),
    "sw": (0.25, 2.0e-5, 0.0),
    "ntg": (0.80, 0.0, -2.0e-5),
}

KRIGE_PARAMS = {"model": "spherical", "range": 900.0, "sill": 0.0025,
                "nugget": 0.00025}
KRIGE_PARAMS_EXP = {"model": "exponential", "range": 900.0,
                    "sill": 0.0025, "nugget": 0.00025}
FAR_TARGET = (9999.0, 9999.0)


def plane_val(coeffs, x, y):
    a, b, c = coeffs
    return a + b * (x - 1000.0) + c * (y - 2000.0)


def source_grid(key):
    spec = SRC_SPECS[key]
    fn = PLANES[key]
    return [fn(*oracle.grid_xy(spec, r, c))
            for r in range(spec["ny"]) for c in range(spec["nx"])]


def build_framework():
    grids = {k: source_grid(k) for k in ("s1", "s2", "s3")}
    resampled = [oracle.resample(grids[k], SRC_SPECS[k], MODEL_SPEC)
                 for k in ("s1", "s2", "s3")]
    clamped, counts = oracle.clamp_stack(resampled)
    thick_a = oracle.zone_thickness(clamped[0], clamped[1])
    thick_b = oracle.zone_thickness(clamped[1], clamped[2])
    return grids, resampled, clamped, counts, thick_a, thick_b


def build_wells():
    out = {}
    for name, w in WELLS.items():
        traj = oracle.min_curvature(w["deviation"], w["kb"], w["x"], w["y"])
        out[name] = {"traj": traj}
    return out


def well_ties(clamped, trajs):
    surf_for_top = {"TopA": 0, "TopB": 1, "BaseB": 2}
    ties = []
    for name, w in WELLS.items():
        traj = trajs[name]["traj"]
        for top, md in sorted(w["tops"].items()):
            pos = oracle.position_at_md(traj, md)
            zsurf = oracle.sample_at_xy(clamped[surf_for_top[top]],
                                        MODEL_SPEC, pos["x"], pos["y"])
            resid = (None if oracle.is_null(zsurf)
                     else pos["tvdss"] - zsurf)
            ties.append({"well": name, "top": top, "md": md,
                         "x": pos["x"], "y": pos["y"],
                         "tvdss": pos["tvdss"],
                         "surface_z": None if oracle.is_null(zsurf)
                         else zsurf,
                         "residual_m": resid})
    return ties


def control_points(trajs, zone):
    """Zone control points: XY at the interval's MD midpoint, planar
    property values, weight = interval length."""
    pts = []
    for name, w in WELLS.items():
        top_md, base_md = w["zones"][zone]
        pos = oracle.position_at_md(trajs[name]["traj"],
                                    (top_md + base_md) / 2.0)
        row = {"well": name, "x": pos["x"], "y": pos["y"],
               "w": base_md - top_md}
        for prop, coeffs in sorted(PROP_PLANES.items()):
            row[prop] = plane_val(coeffs, pos["x"], pos["y"])
        pts.append(row)
    return pts


def population_fixtures(cps, labels):
    phi_pts = [{"x": p["x"], "y": p["y"], "v": p["phi"], "w": p["w"]}
               for p in cps]
    mean = sum(p["v"] for p in phi_pts) / len(phi_pts)
    targets = [(1250.0, 2250.0), (1500.0, 2500.0), (2000.0, 2300.0),
               (1750.0, 2050.0), (phi_pts[0]["x"], phi_pts[0]["y"]),
               FAR_TARGET]
    krige_sph = oracle.simple_krige(phi_pts, mean, KRIGE_PARAMS["model"],
                                    KRIGE_PARAMS["range"],
                                    KRIGE_PARAMS["sill"],
                                    KRIGE_PARAMS["nugget"], targets)
    krige_exp = oracle.simple_krige(phi_pts, mean,
                                    KRIGE_PARAMS_EXP["model"],
                                    KRIGE_PARAMS_EXP["range"],
                                    KRIGE_PARAMS_EXP["sill"],
                                    KRIGE_PARAMS_EXP["nugget"], targets)
    trend_coeffs = oracle.plane_fit(phi_pts)
    trend_probes = [{"x": tx, "y": ty,
                     "v": trend_coeffs[0] + trend_coeffs[1] * tx
                     + trend_coeffs[2] * ty}
                    for tx, ty in targets[:4]]
    constant = oracle.weighted_mean([p["v"] for p in phi_pts],
                                    [p["w"] for p in phi_pts])
    return {
        "points": phi_pts,
        "mean": mean,
        "constant_weighted": constant,
        "trend": {"coeffs": trend_coeffs, "probes": trend_probes},
        "krige_spherical": {"params": KRIGE_PARAMS,
                            "targets": [list(t) for t in targets],
                            "values": krige_sph},
        "krige_exponential": {"params": KRIGE_PARAMS_EXP,
                              "targets": [list(t) for t in targets],
                              "values": krige_exp},
    }


def block_constant_props(cps, labels):
    """Constant-method property grids per block (the volumes input):
    each block uses only its own wells; blocks with no wells fall back
    to the all-well constant (the documented ladder, applied here by
    the fixture so volumes stay deterministic)."""
    def well_block(p):
        return 1 if oracle.point_in_polygon(p["x"], p["y"],
                                            FAULT_POLYGON) else 0

    grids = {}
    for prop in sorted(PROP_PLANES):
        vals_all = [p[prop] for p in cps]
        wts_all = [p["w"] for p in cps]
        per_block = {}
        for blk in (0, 1):
            vals = [p[prop] for p in cps if well_block(p) == blk]
            wts = [p["w"] for p in cps if well_block(p) == blk]
            per_block[blk] = (oracle.weighted_mean(vals, wts) if vals
                              else oracle.weighted_mean(vals_all, wts_all))
        grids[prop] = [per_block[lab] for lab in labels]
    return grids


def main():
    grids_src, resampled, clamped, counts, thick_a, thick_b = \
        build_framework()
    trajs = build_wells()
    labels = oracle.label_blocks(MODEL_SPEC, [FAULT_POLYGON])
    census = {}
    for lab in labels:
        census[lab] = census.get(lab, 0) + 1
    ties = well_ties(clamped, trajs)
    cps_a = control_points(trajs, "A")
    cps_b = control_points(trajs, "B")
    pop = population_fixtures(cps_a, labels)
    props_a = block_constant_props(cps_a, labels)
    props_b = block_constant_props(cps_b, labels)
    vol_a = oracle.zone_volumes(MODEL_SPEC, thick_a, labels, props_a)
    vol_b = oracle.zone_volumes(MODEL_SPEC, thick_b, labels, props_b)

    # ---- anchors ----------------------------------------------------
    # A1 resampling reproduces the analytic planes
    for k, z in zip(("s1", "s2", "s3"), resampled):
        for r in range(MODEL_SPEC["ny"]):
            for c in range(MODEL_SPEC["nx"]):
                x, y = oracle.grid_xy(MODEL_SPEC, r, c)
                assert abs(z[r * MODEL_SPEC["nx"] + c]
                           - PLANES[k](x, y)) < 1e-9, (k, r, c)

    # A2 monotonic sub-stack is a no-op
    _, counts12 = oracle.clamp_stack(resampled[:2])
    assert counts12 == [0, 0], counts12

    # A3 pinch-out clamps exactly the eastern 180 nodes; thickness law
    assert counts == [0, 0, 180], counts
    for j, (v2, v3) in enumerate(zip(clamped[1], clamped[2])):
        assert v3 >= v2 - 1e-12, j
    for r in range(MODEL_SPEC["ny"]):
        for c in range(MODEL_SPEC["nx"]):
            x, _ = oracle.grid_xy(MODEL_SPEC, r, c)
            want = max(0.0, 31.0 - 0.04 * (x - 1000.0))
            assert abs(thick_b[r * MODEL_SPEC["nx"] + c] - want) < 1e-9

    # A4 hand-counted census
    assert census == {0: 326, 1: 174}, census

    # A5 vertical well identity + exact circular-arc build
    for st in trajs["W1"]["traj"]:
        assert st["tvd"] == st["md"]
        assert st["x"] == WELLS["W1"]["x"] and st["y"] == WELLS["W1"]["y"]
    arc = oracle.min_curvature([{"md": 1000.0, "inc": 90.0, "azi": 90.0}],
                               0.0, 0.0, 0.0)
    want = 2.0 * 1000.0 / math.pi
    assert abs(arc[-1]["tvd"] - want) < 1e-9, arc[-1]
    assert abs(arc[-1]["x"] - want) < 1e-9, arc[-1]

    # A6 planar trend recovery, exact at the wells
    a, b, c = pop["trend"]["coeffs"]
    a0, bx, cy = PROP_PLANES["phi"]
    # plane_val uses offsets from (1000, 2000); convert to absolute
    assert abs(b - bx) < 1e-9 and abs(c - cy) < 1e-9
    assert abs(a - (a0 - bx * 1000.0 - cy * 2000.0)) < 1e-9
    for p in pop["points"]:
        assert abs((a + b * p["x"] + c * p["y"]) - p["v"]) < 1e-9

    # A7 kriging: exact at data, mean far away
    assert abs(pop["krige_spherical"]["values"][4]
               - pop["points"][0]["v"]) < 1e-9
    assert abs(pop["krige_spherical"]["values"][5] - pop["mean"]) < 1e-9

    # A8 closed-form zone-A bulk volume
    assert abs(vol_a["total"]["bulk_m3"] - 45_000_000.0) \
        / 45_000_000.0 < 1e-6, vol_a["total"]

    # A9 position_at_md hits stations exactly
    st = trajs["W2"]["traj"][2]
    pos = oracle.position_at_md(trajs["W2"]["traj"], st["md"])
    assert pos["x"] == st["x"] and pos["tvdss"] == st["tvdss"]

    # ---- write ------------------------------------------------------
    goldens = {
        "model_spec": MODEL_SPEC,
        "source_specs": SRC_SPECS,
        "source_grids": grids_src,
        "fault_polygon": [list(v) for v in FAULT_POLYGON],
        "framework": {
            "resampled": resampled,
            "clamped": clamped,
            "clamp_counts": counts,
            "thickness_a": thick_a,
            "thickness_b": thick_b,
            "stats": {
                "s1": oracle.surface_stats(clamped[0]),
                "s2": oracle.surface_stats(clamped[1]),
                "s3": oracle.surface_stats(clamped[2]),
                "thickness_a": oracle.surface_stats(thick_a),
                "thickness_b": oracle.surface_stats(thick_b),
            },
        },
        "blocks": {"labels": labels,
                   "census": {str(k): v for k, v in census.items()}},
        "wells": {
            name: {
                "head": {"x": w["x"], "y": w["y"], "kb": w["kb"]},
                "deviation": w["deviation"],
                "tops": w["tops"],
                "zones": {z: {"top_md": t, "base_md": bmd}
                          for z, (t, bmd) in w["zones"].items()},
                "traj": trajs[name]["traj"],
            } for name, w in WELLS.items()
        },
        "well_ties": ties,
        "control_points_a": cps_a,
        "control_points_b": cps_b,
        "population": pop,
        "block_prop_values": {
            zone_key: {
                prop: {"block0": props[prop][labels.index(0)],
                       "block1": props[prop][labels.index(1)]}
                for prop in sorted(PROP_PLANES)
            }
            for zone_key, props in (("zone_a", props_a),
                                    ("zone_b", props_b))
        },
        "volumes": {
            "zone_a": {str(k): v for k, v in vol_a.items()},
            "zone_b": {str(k): v for k, v in vol_b.items()},
        },
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "goldens.json"), "w") as f:
        json.dump(goldens, f, indent=1, sort_keys=True)
        f.write("\n")
    print("anchors OK; goldens written to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
