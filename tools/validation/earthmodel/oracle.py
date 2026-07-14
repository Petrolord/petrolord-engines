"""Independent reference implementation for the Earth Modeling (G8)
engine — layer-cake structural framework, fault-block labeling, well
ties, per-zone property population (constant / trend / simple kriging)
and zone volumes.

stdlib-only; written from primary definitions, NEVER from the JS:

- Bilinear resampling: standard tensor-product linear interpolation
  (e.g. Press et al., Numerical Recipes 3rd ed., sec 3.6), null-aware
  with the house convention (NULL >= 1e29; exact node hits need only
  that node).
- Minimum curvature: standard industry formulation with ratio factor
  RF = (2/dogleg)*tan(dogleg/2) (e.g. Bourgoyne et al., Applied
  Drilling Engineering, SPE Textbook Vol. 2, ch. 8).
- Least-squares plane: normal equations for v = a + b*x + c*y.
- Simple kriging: weights from C * w = c0 with the "honor the data"
  covariance convention C(0) = sill (total), C(h>0) = (sill - nugget)
  * corr(h); prediction = mean + w . (v - mean). Spherical and
  exponential correlation models per Isaaks & Srivastava, An
  Introduction to Applied Geostatistics, ch. 12/16. Exact at data
  points by construction for nugget < sill.
- Point-in-polygon: even-odd ray crossing (Shimrat's algorithm /
  W. Randolph Franklin's PNPOLY formulation).

Grid convention (house, matches src/lib/gridding): z row-major length
nx*ny, z[r*nx + c], world x[c] = x0 + c*dx, y[r] = y0 + r*dy, row 0 =
south, NULL_VALUE = 1e30, |v| >= 1e29 tests as null. Depth is metres,
positive down (TVDSS below MSL for model z).
"""

import math

NULL_VALUE = 1.0e30


def is_null(v):
    return not math.isfinite(v) or abs(v) >= 1e29


# ---------------------------------------------------------------- linalg

def solve(a, b):
    """Gaussian elimination with partial pivoting. a: n x n (list of
    rows, mutated copy), b: length n. Returns x."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[piv][col]) < 1e-14:
            raise ValueError("singular system")
        m[col], m[piv] = m[piv], m[col]
        for r in range(col + 1, n):
            f = m[r][col] / m[col][col]
            if f == 0.0:
                continue
            for c in range(col, n + 1):
                m[r][c] -= f * m[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = m[r][n] - sum(m[r][c] * x[c] for c in range(r + 1, n))
        x[r] = s / m[r][r]
    return x


# ------------------------------------------------------- grids / framework

def grid_xy(spec, r, c):
    return spec["x0"] + c * spec["dx"], spec["y0"] + r * spec["dy"]


def bilinear(z, nx, ny, fx, fy):
    """House-convention bilinear sample at fractional index (fx, fy).
    Exact node hits use only that node; any null corner nulls the
    result; outside the frame is null."""
    if fx < 0 or fy < 0 or fx > nx - 1 or fy > ny - 1:
        return NULL_VALUE
    c0, r0 = int(math.floor(fx)), int(math.floor(fy))
    tx, ty = fx - c0, fy - r0
    c1 = c0 + 1 if tx > 0 else c0
    r1 = r0 + 1 if ty > 0 else r0
    v00, v01 = z[r0 * nx + c0], z[r0 * nx + c1]
    v10, v11 = z[r1 * nx + c0], z[r1 * nx + c1]
    if any(is_null(v) for v in (v00, v01, v10, v11)):
        return NULL_VALUE
    return (v00 * (1 - tx) + v01 * tx) * (1 - ty) \
        + (v10 * (1 - tx) + v11 * tx) * ty


def resample(z, spec_a, spec_b):
    """Bilinear resample z (on spec_a) onto spec_b's frame."""
    out = []
    for r in range(spec_b["ny"]):
        wy = spec_b["y0"] + r * spec_b["dy"]
        fy = (wy - spec_a["y0"]) / spec_a["dy"]
        for c in range(spec_b["nx"]):
            wx = spec_b["x0"] + c * spec_b["dx"]
            fx = (wx - spec_a["x0"]) / spec_a["dx"]
            out.append(bilinear(z, spec_a["nx"], spec_a["ny"], fx, fy))
    return out


def sample_at_xy(z, spec, x, y):
    fx = (x - spec["x0"]) / spec["dx"]
    fy = (y - spec["y0"]) / spec["dy"]
    return bilinear(z, spec["nx"], spec["ny"], fx, fy)


def clamp_stack(surfaces):
    """Depth-down monotonic clamp. surfaces: list of z-arrays (same
    frame), ordered shallow -> deep. Node-wise: a live node is clamped
    to >= the running max of live nodes above it; null nodes stay null
    and do not advance the running max. Returns (clamped, counts) where
    counts[i] = nodes whose value changed on surface i."""
    if not surfaces:
        return [], []
    n = len(surfaces[0])
    clamped = [list(s) for s in surfaces]
    counts = [0] * len(surfaces)
    for j in range(n):
        run = None
        for i, s in enumerate(clamped):
            v = s[j]
            if is_null(v):
                continue
            if run is not None and v < run:
                s[j] = run
                counts[i] += 1
            run = s[j]
    return clamped, counts


def zone_thickness(z_top, z_base):
    """Base - top (positive down => thickness); null if either null."""
    return [NULL_VALUE if (is_null(a) or is_null(b)) else b - a
            for a, b in zip(z_top, z_base)]


def surface_stats(z):
    live = [v for v in z if not is_null(v)]
    if not live:
        return {"min": None, "max": None, "mean": None, "count": 0}
    return {"min": min(live), "max": max(live),
            "mean": sum(live) / len(live), "count": len(live)}


# ------------------------------------------------------------ fault blocks

def point_in_polygon(x, y, verts):
    """Even-odd ray crossing. verts: [(x, y), ...] closed implicitly."""
    inside = False
    n = len(verts)
    for i in range(n):
        x1, y1 = verts[i]
        x2, y2 = verts[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xin:
                inside = not inside
    return inside


def label_blocks(spec, polygons):
    """Per-node block labels. Label = 1 + index of the FIRST polygon
    containing the node; nodes outside all polygons get 0."""
    labels = []
    for r in range(spec["ny"]):
        for c in range(spec["nx"]):
            x, y = grid_xy(spec, r, c)
            lab = 0
            for i, poly in enumerate(polygons):
                if point_in_polygon(x, y, poly):
                    lab = i + 1
                    break
            labels.append(lab)
    return labels


# ------------------------------------------------------------- well paths

def min_curvature(deviation, kb_m, x0, y0):
    """Minimum-curvature trajectory. deviation: [{md, inc, azi}] deg,
    md ascending, starting from the wellhead (md 0 implied vertical if
    the first station is not md 0). Returns stations
    [{md, x, y, tvd, tvdss}] with tvd below KB and tvdss = tvd - kb_m
    (positive down below MSL)."""
    sts = [{"md": 0.0, "inc": 0.0, "azi": 0.0}]
    for d in deviation:
        if d["md"] > sts[-1]["md"]:
            sts.append({"md": float(d["md"]), "inc": float(d["inc"]),
                        "azi": float(d["azi"])})
    out = [{"md": 0.0, "x": x0, "y": y0, "tvd": 0.0, "tvdss": -kb_m}]
    for a, b in zip(sts, sts[1:]):
        dmd = b["md"] - a["md"]
        i1, i2 = math.radians(a["inc"]), math.radians(b["inc"])
        a1, a2 = math.radians(a["azi"]), math.radians(b["azi"])
        cosd = math.cos(i2 - i1) - math.sin(i1) * math.sin(i2) \
            * (1 - math.cos(a2 - a1))
        dog = math.acos(max(-1.0, min(1.0, cosd)))
        rf = 1.0 if dog <= 1e-4 else (2.0 / dog) * math.tan(dog / 2.0)
        dn = dmd / 2.0 * (math.sin(i1) * math.cos(a1)
                          + math.sin(i2) * math.cos(a2)) * rf
        de = dmd / 2.0 * (math.sin(i1) * math.sin(a1)
                          + math.sin(i2) * math.sin(a2)) * rf
        dz = dmd / 2.0 * (math.cos(i1) + math.cos(i2)) * rf
        p = out[-1]
        out.append({"md": b["md"], "x": p["x"] + de, "y": p["y"] + dn,
                    "tvd": p["tvd"] + dz, "tvdss": p["tvd"] + dz - kb_m})
    return out


def position_at_md(traj, md):
    """Linear-in-MD interpolation between minimum-curvature stations
    (documented v1 convention; both sides implement exactly this).
    Beyond TD, extrapolates along the last segment's direction is NOT
    done — clamps to the last station."""
    if md <= traj[0]["md"]:
        t = traj[0]
        return {"x": t["x"], "y": t["y"], "tvd": t["tvd"],
                "tvdss": t["tvdss"]}
    for a, b in zip(traj, traj[1:]):
        if md <= b["md"]:
            f = (md - a["md"]) / (b["md"] - a["md"])
            return {k: a[k] + f * (b[k] - a[k])
                    for k in ("x", "y", "tvd", "tvdss")}
    t = traj[-1]
    return {"x": t["x"], "y": t["y"], "tvd": t["tvd"], "tvdss": t["tvdss"]}


# ------------------------------------------------------ property population

def weighted_mean(values, weights):
    sw = sum(weights)
    if sw <= 0:
        raise ValueError("non-positive total weight")
    return sum(v * w for v, w in zip(values, weights)) / sw


def plane_fit(points):
    """Least-squares v = a + b*x + c*y. points: [{x, y, v}]. Normal
    equations; raises on degenerate (collinear / < 3) configurations."""
    n = len(points)
    if n < 3:
        raise ValueError("plane fit needs >= 3 points")
    sx = sum(p["x"] for p in points)
    sy = sum(p["y"] for p in points)
    sxx = sum(p["x"] * p["x"] for p in points)
    syy = sum(p["y"] * p["y"] for p in points)
    sxy = sum(p["x"] * p["y"] for p in points)
    sv = sum(p["v"] for p in points)
    sxv = sum(p["x"] * p["v"] for p in points)
    syv = sum(p["y"] * p["v"] for p in points)
    a_mat = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]]
    return solve(a_mat, [sv, sxv, syv])  # [a, b, c]


def correlation(h, model, rng):
    if h <= 0:
        return 1.0
    if model == "spherical":
        if h >= rng:
            return 0.0
        u = h / rng
        return 1.0 - (1.5 * u - 0.5 * u ** 3)
    if model == "exponential":
        return math.exp(-3.0 * h / rng)
    raise ValueError("unknown variogram model " + model)


def cov(h, model, rng, sill, nugget):
    """Honor-the-data convention: C(0) = sill; C(h>0) = (sill - nugget)
    * corr(h)."""
    if h <= 0:
        return sill
    return (sill - nugget) * correlation(h, model, rng)


def simple_krige(points, mean, model, rng, sill, nugget, targets):
    """points: [{x, y, v}]; targets: [(x, y)]. Returns predictions."""
    n = len(points)
    a_mat = [[cov(math.hypot(points[i]["x"] - points[j]["x"],
                             points[i]["y"] - points[j]["y"]),
                  model, rng, sill, nugget) for j in range(n)]
             for i in range(n)]
    resid = [p["v"] - mean for p in points]
    out = []
    for tx, ty in targets:
        c0 = [cov(math.hypot(p["x"] - tx, p["y"] - ty),
                  model, rng, sill, nugget) for p in points]
        w = solve(a_mat, c0)
        out.append(mean + sum(wi * ri for wi, ri in zip(w, resid)))
    return out


def populate(spec, method, points, params, labels=None, block=None):
    """Populate a property grid on spec. method: constant | trend |
    krige. points: [{x, y, v, w}] (w = weight, constant only). labels /
    block restrict output to nodes with labels[j] == block (other nodes
    null). Fallback ladder (krige -> trend -> constant) is decided by
    the CALLER (engine glue) — the oracle populates with the method
    given and raises if it cannot."""
    if not points:
        raise ValueError("no control points")
    if method == "constant":
        val = weighted_mean([p["v"] for p in points],
                            [p.get("w", 1.0) for p in points])
        fn = lambda x, y: val  # noqa: E731
    elif method == "trend":
        a, b, c = plane_fit(points)
        fn = lambda x, y: a + b * x + c * y  # noqa: E731
    elif method == "krige":
        mean = params.get("mean")
        if mean is None:
            mean = weighted_mean([p["v"] for p in points],
                                 [1.0] * len(points))
        cache = {}

        def fn(x, y):
            key = (x, y)
            if key not in cache:
                cache[key] = simple_krige(
                    points, mean, params["model"], params["range"],
                    params["sill"], params["nugget"], [(x, y)])[0]
            return cache[key]
    else:
        raise ValueError("unknown method " + method)
    out = []
    for r in range(spec["ny"]):
        for c in range(spec["nx"]):
            j = r * spec["nx"] + c
            if labels is not None and labels[j] != block:
                out.append(NULL_VALUE)
                continue
            x, y = grid_xy(spec, r, c)
            out.append(fn(x, y))
    return out


# ---------------------------------------------------------------- volumes

def zone_volumes(spec, thickness, labels, props):
    """Cell-centred volume sums per block. props: {ntg, phi, sw} grids
    (any may be None). A node contributes only where thickness AND all
    provided property grids are live. Returns {block: {bulk_m3,
    net_m3, pore_m3, hcpv_m3, cells}} plus block 'total'."""
    cell = spec["dx"] * spec["dy"]
    blocks = {}

    def add(lab, t, ntg, phi, sw):
        b = blocks.setdefault(lab, {"bulk_m3": 0.0, "net_m3": 0.0,
                                    "pore_m3": 0.0, "hcpv_m3": 0.0,
                                    "cells": 0})
        bv = t * cell
        b["bulk_m3"] += bv
        b["cells"] += 1
        if ntg is not None:
            b["net_m3"] += bv * ntg
            if phi is not None:
                b["pore_m3"] += bv * ntg * phi
                if sw is not None:
                    b["hcpv_m3"] += bv * ntg * phi * (1.0 - sw)

    ntg_g, phi_g, sw_g = (props.get("ntg"), props.get("phi"),
                          props.get("sw"))
    for j, t in enumerate(thickness):
        if is_null(t):
            continue
        ntg = None if ntg_g is None else ntg_g[j]
        phi = None if phi_g is None else phi_g[j]
        sw = None if sw_g is None else sw_g[j]
        if any(v is not None and is_null(v) for v in (ntg, phi, sw)):
            continue
        add(labels[j] if labels is not None else 0, t, ntg, phi, sw)
        add("total", t, ntg, phi, sw)
    return blocks
