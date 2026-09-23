#!/usr/bin/env python3
"""Golden generator for the Seismolord structure and trace attributes
(engines/seismolord/structureAttributes.js: edge, dip, azimuth, chaos,
curvature_pos, curvature_neg; engines/seismolord/attributes.js: spectral,
rai). Independent vectorised numpy implementation of every recipe; the JS
engines are written separately and must match it.

Run with /root/hseenv/bin/python3 (numpy 2.5, scipy 1.18).

Recipe pinned by the goldens:
- Missing data: outside the survey, dead trace, or null (|v| > 1e29).
  Output NULL (1e30) wherever the centre sample is null. Inputs are the
  float32 values the brick store holds.
- Half windows: hw = floor(windowMs / 2 / dtMs + 0.5) (round half up).
- edge: per time slice, 3x3 Sobel / 8 in il and xl; a neighbour outside the
  survey replicates the nearest survey cell (np.pad mode 'edge'), and a
  neighbour that is then missing takes the CENTRE value; value =
  sqrt(mean over the live samples of [t-hw, t+hw] of gi^2 + gx^2).
- structure tensor: gradients along il, xl, t by central differences,
  one-sided where only one neighbour exists, 0 with neither, 0 at a null
  centre; T = g g^T averaged over the (2r+1)^2 x (2hw+1) box clipped to the
  survey, mean over LIVE samples; eigh, lambda1 >= lambda2 >= lambda3.
  Zero tensor: trace exactly 0.
- dip: v = lambda1 eigenvector, p = -vi/vt, q = -vx/vt (samples per trace);
  zero tensor -> 0; cap at DIP_CAP = 20 samples per trace keeping the
  direction (vt sign + when 0); value hypot(p, q) * dtMs (ms/trace).
- azimuth: atan2(q, p) in degrees in [0, 360), lattice frame (+il toward
  +xl); null for a zero tensor or hypot(p, q) < 1e-6.
- chaos: lambda2 / lambda1 clamped to [0, 1]; zero tensor -> 0.
- curvature: a = dp/dil, c = dq/dxl, b = (dp/dxl + dq/dil)/2 with the same
  central / one-sided / zero rule on the dip FIELDS; kMean = (a+c)/2,
  kPos/kNeg = kMean +- sqrt(((a-c)/2)^2 + b^2), times dtMs (ms/trace^2).
  t = t0 + A (il^2 + xl^2), A > 0, gives POSITIVE curvature 2 A dtMs.
- spectral: per sample z, window z +- hw clamped (n < 4 -> null), nulls
  zero-filled (all-null -> null), np.hanning(n) taper, zero-pad to
  nextpow2(4n), |FFT| at bin round(f * nfft * dt_s) clamped to [0, nfft/2];
  null where the input is null. hw = max(2, round half up).
- rai: c = cumsum(trace, nulls 0); out = c - centred boxcar mean of c over
  [s-hw, s+hw] clamped (edge windows shrink); null where input null.

Synthetic cube (11 x 9 x 48, dt 4 ms): three Ricker reflectors on a
dipping plane plus a dome (anticline in time), a vertical fault (throw
3 samples) between xl 5 and 6, a white-noise patch, a quiet top where the
tensor is exactly zero, three null runs and one dead trace. Self-asserts
physical truths on analytic synthetics AND on the cube before writing.

Usage: gen_structure.py [output.json]
"""

import json
import math
import os
import sys

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

NULL = 1.0e30
NULL_LIM = 1.0e29
NIL, NXL, NS = 11, 9, 48
DT_US = 4000
DT_MS = DT_US / 1000.0
DIP_CAP = 20.0
AZ_MIN_DIP = 1e-6

FAULT_XL = 6            # xl >= 6 is downthrown
THROW = 3.0             # samples
P0, Q0 = 0.3, -0.2      # regional time dip, samples per trace
DOME_A = 0.06           # samples per trace^2 (anticline in time)
DOME_C = (5.0, 4.0)
REFLECTORS = [(16.0, 1.0), (28.0, -0.8), (40.0, 0.6)]

PARAMS = {
    "edge": {"windowMs": 12},
    "tensor": {"windowMs": 24, "radius": 1},
    "tensor_r2": {"windowMs": 24, "radius": 2},
    "spectral": {"freqHz": 30, "windowMs": 40},
    "rai": {"lowCutMs": 60},
}


def hw_of(window_ms, dt_ms=DT_MS):
    return int(math.floor(window_ms / 2.0 / dt_ms + 0.5))


def ricker_u(u, f_hz=30.0, dt_s=DT_US * 1e-6, support=6.0):
    a = (np.pi * f_hz * u * dt_s) ** 2
    w = (1 - 2 * a) * np.exp(-a)
    return np.where(np.abs(u) <= support, w, 0.0)


def build_cube():
    il = np.arange(NIL)[:, None, None]
    xl = np.arange(NXL)[None, :, None]
    t = np.arange(NS)[None, None, :]
    shift = P0 * il + Q0 * xl + DOME_A * ((il - DOME_C[0]) ** 2 + (xl - DOME_C[1]) ** 2)
    shift = shift + np.where(xl >= FAULT_XL, THROW, 0.0)
    cube = np.zeros((NIL, NXL, NS))
    for t0, amp in REFLECTORS:
        cube += amp * ricker_u(t - (t0 + shift))
    rng = np.random.default_rng(20260923)
    cube[7:10, 1:4, 20:35] += 0.5 * rng.standard_normal((3, 3, 15))
    cube = cube.astype(np.float32).astype(np.float64)
    cube[2, 6, 30:33] = NULL         # null run next to the fault
    cube[4, 2, 45] = NULL            # single null sample
    cube[0, 0, 0:3] = NULL           # null top at a survey corner
    cube[8, 7, :] = NULL             # dead trace
    return cube


def to_nan(cube):
    x = np.array(cube, dtype=np.float64)
    x[np.abs(x) > NULL_LIM] = np.nan
    return x


def shifted(x, axis, k):
    """y[i] = x[i + k] along axis, NaN where i + k falls outside."""
    y = np.full_like(x, np.nan)
    n = x.shape[axis]
    src = [slice(None)] * x.ndim
    dst = [slice(None)] * x.ndim
    if k > 0:
        src[axis] = slice(k, n)
        dst[axis] = slice(0, n - k)
    else:
        src[axis] = slice(0, n + k)
        dst[axis] = slice(-k, n)
    y[tuple(dst)] = x[tuple(src)]
    return y


def diff_rule(x, axis):
    """Central where both neighbours exist, one-sided with one, 0 with none;
    NaN centre stays NaN."""
    fwd = shifted(x, axis, 1)
    bwd = shifted(x, axis, -1)
    hp = ~np.isnan(fwd)
    hm = ~np.isnan(bwd)
    g = np.where(hp & hm, (fwd - bwd) / 2.0,
                 np.where(hp, fwd - x, np.where(hm, x - bwd, 0.0)))
    return np.where(np.isnan(x), np.nan, g)


def box_sum(a, r, hw):
    """Sum over the (2r+1)^2 x (2hw+1) box, zero outside the survey."""
    p = np.pad(a, ((r, r), (r, r), (hw, hw)))
    return sliding_window_view(p, (2 * r + 1, 2 * r + 1, 2 * hw + 1)).sum(axis=(-3, -2, -1))


# ---------------------------------------------------------------- edge

def edge_volume(cube, window_ms):
    hw = hw_of(window_ms)
    x = to_nan(cube)
    ok = ~np.isnan(x)
    xp = np.pad(x, ((1, 1), (1, 1), (0, 0)), mode="edge")
    nI, nJ, _ = x.shape

    def nb(di, dj):
        v = xp[1 + di:1 + di + nI, 1 + dj:1 + dj + nJ, :]
        return np.where(np.isnan(v), x, v)

    w = {-1: 1.0, 0: 2.0, 1: 1.0}
    gi = sum(w[k] * (nb(1, k) - nb(-1, k)) for k in (-1, 0, 1)) / 8.0
    gx = sum(w[k] * (nb(k, 1) - nb(k, -1)) for k in (-1, 0, 1)) / 8.0
    g2 = np.where(ok, gi ** 2 + gx ** 2, 0.0)
    s = sliding_window_view(np.pad(g2, ((0, 0), (0, 0), (hw, hw))), 2 * hw + 1, axis=2).sum(-1)
    n = sliding_window_view(np.pad(ok.astype(float), ((0, 0), (0, 0), (hw, hw))), 2 * hw + 1, axis=2).sum(-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.sqrt(s / n)
    return np.where(ok, out, np.nan)


# ------------------------------------------------------ structure tensor

def tensor_fields(cube, window_ms, radius):
    """(p, q, chaos, zero, ok) over the whole volume."""
    hw = hw_of(window_ms)
    r = int(max(1, min(2, math.floor(radius))))
    x = to_nan(cube)
    ok = ~np.isnan(x)
    g = [np.where(ok, diff_rule(x, ax), 0.0) for ax in (0, 1, 2)]
    n = box_sum(ok.astype(float), r, hw)
    pairs = [(0, 0), (0, 1), (0, 2), (1, 1), (1, 2), (2, 2)]
    comp = {pr: box_sum(g[pr[0]] * g[pr[1]], r, hw) for pr in pairs}
    with np.errstate(invalid="ignore", divide="ignore"):
        T = np.zeros(x.shape + (3, 3))
        for (a, b), s in comp.items():
            T[..., a, b] = s / n
            T[..., b, a] = s / n
    T[~ok] = 0.0
    trace = T[..., 0, 0] + T[..., 1, 1] + T[..., 2, 2]
    zero = trace == 0
    lam, vec = np.linalg.eigh(T)                    # ascending
    l1, l2 = lam[..., 2], lam[..., 1]
    v = vec[..., :, 2]
    vi, vx, vt = v[..., 0], v[..., 1], v[..., 2]
    h = np.hypot(vi, vx)
    with np.errstate(invalid="ignore", divide="ignore"):
        capped = np.abs(vt) * DIP_CAP < h
        sg = np.where(vt < 0, -1.0, 1.0)
        p = np.where(h == 0, 0.0, np.where(capped, -sg * vi / h * DIP_CAP, -vi / vt))
        q = np.where(h == 0, 0.0, np.where(capped, -sg * vx / h * DIP_CAP, -vx / vt))
        chaos = np.clip(np.where(l1 > 0, l2 / l1, 0.0), 0.0, 1.0)
    p = np.where(zero, 0.0, p)
    q = np.where(zero, 0.0, q)
    chaos = np.where(zero, 0.0, chaos)
    # eigen residual check: T v = l1 v
    res = np.abs(np.einsum("...ij,...j->...i", T, v) - l1[..., None] * v).max()
    assert res < 1e-9 * max(1.0, np.abs(T).max()), f"eigh residual {res}"
    nanm = lambda a: np.where(ok, a, np.nan)
    return nanm(p), nanm(q), nanm(chaos), zero, ok


def dip_volume(cube, window_ms, radius):
    p, q, _, _, _ = tensor_fields(cube, window_ms, radius)
    return np.hypot(p, q) * DT_MS


def azimuth_volume(cube, window_ms, radius):
    p, q, _, zero, ok = tensor_fields(cube, window_ms, radius)
    az = np.degrees(np.arctan2(q, p))
    az = np.where(az < 0, az + 360.0, az)
    az = np.where(az >= 360.0, az - 360.0, az)
    undefined = zero | (np.hypot(p, q) < AZ_MIN_DIP) | ~ok
    return np.where(undefined, np.nan, az)


def chaos_volume(cube, window_ms, radius):
    return tensor_fields(cube, window_ms, radius)[2]


def curvature_volumes(cube, window_ms, radius):
    p, q, _, _, ok = tensor_fields(cube, window_ms, radius)
    a = diff_rule(p, 0)
    c = diff_rule(q, 1)
    b = (diff_rule(p, 1) + diff_rule(q, 0)) / 2.0
    k_mean = (a + c) / 2.0
    rad = np.sqrt(((a - c) / 2.0) ** 2 + b ** 2)
    return (k_mean + rad) * DT_MS, (k_mean - rad) * DT_MS


# --------------------------------------------------------- trace attributes

def nextpow2(n):
    return 1 << int(math.ceil(math.log2(n)))


def spectral_trace(tr, freq_hz, window_ms, dt_us=DT_US):
    dt_s = dt_us * 1e-6
    hw = max(2, hw_of(window_ms, dt_us / 1000.0))
    ns = len(tr)
    nul = np.abs(tr) > NULL_LIM
    x = np.where(nul, 0.0, tr)
    out = np.full(ns, np.nan)
    for z in range(ns):
        if nul[z]:
            continue
        s0, s1 = max(0, z - hw), min(ns - 1, z + hw)
        n = s1 - s0 + 1
        if n < 4 or nul[s0:s1 + 1].all():
            continue
        nfft = nextpow2(4 * n)
        buf = np.zeros(nfft)
        buf[:n] = x[s0:s1 + 1] * np.hanning(n)
        k = int(min(nfft // 2, max(0, math.floor(freq_hz * nfft * dt_s + 0.5))))
        out[z] = np.abs(np.fft.fft(buf)[k])
    return out


def rai_trace(tr, low_cut_ms, dt_us=DT_US):
    hw = max(1, hw_of(low_cut_ms, dt_us / 1000.0))
    nul = np.abs(tr) > NULL_LIM
    c = np.cumsum(np.where(nul, 0.0, tr))
    ns = len(tr)
    idx = np.arange(ns)
    lo = np.maximum(0, idx - hw)
    hi = np.minimum(ns - 1, idx + hw)
    pre = np.concatenate([[0.0], np.cumsum(c)])
    mean = (pre[hi + 1] - pre[lo]) / (hi - lo + 1)
    return np.where(nul, np.nan, c - mean)


def per_trace(cube, fn):
    out = np.full(cube.shape, np.nan)
    for i in range(cube.shape[0]):
        for j in range(cube.shape[1]):
            if (np.abs(cube[i, j]) > NULL_LIM).all():
                continue
            out[i, j] = fn(cube[i, j])
    return out


# ------------------------------------------------------------ self-asserts

def plane_wave(p, q, n_il=15, n_xl=15, ns=64, period=40.0):
    il = np.arange(n_il)[:, None, None]
    xl = np.arange(n_xl)[None, :, None]
    t = np.arange(ns)[None, None, :]
    return np.cos(2 * np.pi * (t - p * il - q * xl) / period).astype(np.float32).astype(np.float64)


def surface_cube(fn, n=15, ns=96, period=40.0, t0=48.0):
    """Reflectivity-free analytic reflector family: cosine of (t - tau)."""
    il = np.arange(n)[:, None, None] - n // 2
    xl = np.arange(n)[None, :, None] - n // 2
    t = np.arange(ns)[None, None, :]
    tau = fn(il, xl)
    return np.cos(2 * np.pi * (t - t0 - tau) / period).astype(np.float32).astype(np.float64)


def self_assert_truths():
    inner = (slice(3, -3), slice(3, -3), slice(8, -8))
    # dip and azimuth on planar data in all four quadrants
    for p, q in [(1.0, 0.6), (-0.8, 0.9), (-1.2, -0.5), (0.7, -1.1)]:
        cube = plane_wave(p, q)
        pp, qq, ch, _, _ = tensor_fields(cube, 24, 1)
        dip = np.hypot(pp, qq)[inner]
        az = np.degrees(np.arctan2(qq, pp))[inner]
        true_dip = math.hypot(p, q)
        true_az = math.degrees(math.atan2(q, p))
        derr = np.abs(dip / true_dip - 1).max()
        aerr = np.abs((az - true_az + 180) % 360 - 180).max()
        assert derr < 0.02, f"dip error {derr} at {(p, q)}"
        assert aerr < 1.0, f"azimuth error {aerr} at {(p, q)}"
        assert ch[inner].max() < 0.1, f"planar chaos {ch[inner].max()}"
    # curvature: dome, syncline, saddle
    A = 0.05
    # the vertical window spans one full period of the 40-sample cosine
    # (160 ms = 41 samples): a shorter window weights the box by the phase
    # and the curvature ripples about the truth by a few percent
    c_in = (slice(4, -4), slice(4, -4), slice(24, -24))
    expect = 2 * A * DT_MS
    for fn, sp, sn in [
        (lambda i, x: A * (i ** 2 + x ** 2), 1, 1),
        (lambda i, x: -A * (i ** 2 + x ** 2), -1, -1),
        (lambda i, x: A * (i ** 2 - x ** 2), 1, -1),
    ]:
        kp, kn = curvature_volumes(surface_cube(fn), 160, 1)
        kp, kn = kp[c_in], kn[c_in]
        assert np.abs(kp / (sp * expect) - 1).max() < 0.02, f"kPos {kp.min()}..{kp.max()} vs {sp * expect}"
        assert np.abs(kn / (sn * expect) - 1).max() < 0.02, f"kNeg {kn.min()}..{kn.max()} vs {sn * expect}"
    # chaos on white noise
    rng = np.random.default_rng(1)
    noise = rng.standard_normal((12, 12, 64))
    assert np.nanmean(tensor_fields(noise, 24, 1)[2]) > 0.5, "white-noise chaos too low"
    # spectral: a 30 Hz cosine reads stronger at 30 than at 60 Hz
    tt = np.arange(64)
    cos30 = np.cos(2 * np.pi * 30.0 * tt * DT_US * 1e-6)
    s30 = spectral_trace(cos30, 30, 40)
    s60 = spectral_trace(cos30, 60, 40)
    assert (s30[8:-8] > 2 * s60[8:-8]).all(), "30 Hz cosine not strongest at 30 Hz"
    # rai: a single spike becomes a step
    spike = np.zeros(64)
    spike[32] = 1.0
    r = rai_trace(spike, 60)
    hw = hw_of(60)
    jump = r[32] - r[31]
    assert abs(jump - (1 - 1 / (2 * hw + 1))) < 1e-12, f"rai jump {jump}"
    assert np.abs(r[: 32 - 2 * hw - 1]).max() < 1e-12 and np.abs(r[33 + 2 * hw:]).max() < 1e-12


def self_assert_cube(cube, g):
    nul = np.abs(cube) > NULL_LIM
    for k, v in g.items():
        assert (np.isnan(v)[nul]).all(), f"{k}: null centre must stay null"
    assert np.isnan(g["dip"][8, 7]).all(), "dead trace must stay null"
    # quiet top: zero tensor -> dip 0, chaos 0, azimuth null
    assert g["dip"][5, 4, 0] == 0 and g["chaos"][5, 4, 0] == 0 and np.isnan(g["azimuth"][5, 4, 0])
    # edge: the fault columns (xl 5 and 6) carry the maximum at the
    # middle reflector on a clean inline
    e = g["edge"][4, :, 26:34].max(axis=1)
    assert int(np.argmax(e)) in (5, 6), f"edge peak at xl {np.argmax(e)}"
    assert e[5:7].max() > 1.5 * e[1:4].max(), f"edge contrast {e}"
    # chaos: noise patch well above the clean interior at the same times
    assert np.nanmean(g["chaos"][7:10, 1:4, 22:33]) > 2 * np.nanmean(g["chaos"][1:4, 1:4, 22:33])
    # curvature: dome crest positive on both, reflector time
    assert g["curvature_pos"][5, 3, 16] > 0 and g["curvature_neg"][5, 3, 16] > 0
    # dip on the clean flank near the regional value (sqrt(.3^2+.2^2) ~ 0.36
    # samples per trace plus the dome gradient)
    assert 0.0 < g["dip"][5, 3, 16] < 3.0
    print("cube self-asserts OK")


def rows(a):
    out = np.where(np.isnan(a), NULL, a)
    return [[[float(f"{v:.12g}") for v in tr] for tr in row] for row in out]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "structure_golden.json")
    self_assert_truths()
    print("analytic self-asserts OK")
    cube = build_cube()
    E, T, T2 = PARAMS["edge"], PARAMS["tensor"], PARAMS["tensor_r2"]
    kp, kn = curvature_volumes(cube, T["windowMs"], T["radius"])
    kp2, kn2 = curvature_volumes(cube, T2["windowMs"], T2["radius"])
    g = {
        "edge": edge_volume(cube, E["windowMs"]),
        "dip": dip_volume(cube, T["windowMs"], T["radius"]),
        "azimuth": azimuth_volume(cube, T["windowMs"], T["radius"]),
        "chaos": chaos_volume(cube, T["windowMs"], T["radius"]),
        "curvature_pos": kp,
        "curvature_neg": kn,
        "dip_r2": dip_volume(cube, T2["windowMs"], T2["radius"]),
        "chaos_r2": chaos_volume(cube, T2["windowMs"], T2["radius"]),
        "curvature_pos_r2": kp2,
        "curvature_neg_r2": kn2,
        "spectral": per_trace(cube, lambda tr: spectral_trace(tr, **{"freq_hz": 30, "window_ms": 40})),
        "rai": per_trace(cube, lambda tr: rai_trace(tr, 60)),
    }
    self_assert_cube(cube, g)
    doc = {
        "generator": "test-data/seismolord/structure/gen_structure.py",
        "dt_us": DT_US,
        "shape": [NIL, NXL, NS],
        "null_value": NULL,
        "params": {
            "edge": E, "dip": T, "azimuth": T, "chaos": T, "curvature_pos": T, "curvature_neg": T,
            "dip_r2": T2, "chaos_r2": T2, "curvature_pos_r2": T2, "curvature_neg_r2": T2,
            "spectral": PARAMS["spectral"], "rai": PARAMS["rai"],
        },
        "fault_xl": FAULT_XL,
        "cube": [[[float(str(np.float32(v))) if abs(v) <= NULL_LIM else NULL for v in tr] for tr in row] for row in cube],
        "golden": {k: rows(v) for k, v in g.items()},
    }
    with open(out_path, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
