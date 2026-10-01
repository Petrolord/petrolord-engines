"""Rock Physics Studio U2 oracle (2026-10-01): independent stdlib-Python
reference implementations for the U2 engines. Shares NO code with the
JavaScript; the primitives it builds on (Zoeppritz, Gassmann,
Greenberg-Castagna, Ricker, convolution) are the G6.0 oracle's.

  angle gather        primaries-only convolutional gather, one trace per
                      incidence angle (exact Zoeppritz real part)
  constant phase      w cos(phi) + H[w] sin(phi), H by the analytic signal
                      (zero-pad to a power of two, scipy.signal.hilbert
                      weights), written as a plain DFT
  intercept/gradient  least squares of R = A + B sin^2(theta)
  fluid line          Castagna, Swan and Foster (1998) slope and a principal
                      axis fit through the origin
  iterative Vs        Greenberg-Castagna 1992 procedure (RPH 7.9)
  templates           Nur critical-porosity sand line + Gassmann; Castagna
                      mudrock line with Gardner density
  pseudo-sonic        Gardner et al. (1974) inverse; Faust (1953)
  Voigt fluid mix     arithmetic average of phase moduli
"""

import cmath
import math

import oracle

M_PER_FT = 0.3048


# ---------------------------------------------------------------------------
# Angle gather
# ---------------------------------------------------------------------------

def two_way_time_ms(depth, vp):
    t = [0.0]
    for i in range(1, len(depth)):
        dz = depth[i] - depth[i - 1]
        t.append(t[-1] + 2000.0 * dz * 0.5 * (1.0 / vp[i] + 1.0 / vp[i - 1]))
    return t


def logs_to_time(depth, vp, vs, rho, dt_ms):
    t = two_way_time_ms(depth, vp)
    nt = int(math.floor(t[-1] / dt_ms)) + 1
    out = {"t": [], "depth": [], "vp": [], "vs": [], "rho": []}
    j = 0
    for k in range(nt):
        tk = k * dt_ms
        while j < len(t) - 2 and t[j + 1] < tk:
            j += 1
        span = t[j + 1] - t[j]
        w = min(1.0, max(0.0, (tk - t[j]) / span)) if span > 0 else 0.0
        out["t"].append(tk)
        for key, arr in (("depth", depth), ("vp", vp), ("vs", vs),
                         ("rho", rho)):
            out[key].append(arr[j] + w * (arr[j + 1] - arr[j]))
    return out


def reflectivity_series(vp, vs, rho, theta_deg):
    n = len(vp)
    rc = [0.0] * n
    for k in range(1, n):
        if (vp[k], vs[k], rho[k]) == (vp[k - 1], vs[k - 1], rho[k - 1]):
            continue
        rc[k] = oracle.zoeppritz_rpp(vp[k - 1], vs[k - 1], rho[k - 1],
                                     vp[k], vs[k], rho[k], theta_deg).real
    return rc


def hilbert_imag(x):
    """Imaginary part of the analytic signal: zero-pad to the next power
    of two, keep DC and Nyquist, double the positive frequencies, zero the
    negative ones (scipy.signal.hilbert), cropped back to len(x)."""
    ns = len(x)
    n = 1
    while n < ns:
        n *= 2
    xs = list(x) + [0.0] * (n - ns)
    spec = [sum(xs[m] * cmath.exp(-2j * math.pi * k * m / n)
                for m in range(n)) for k in range(n)]
    for k in range(n):
        if k == 0 or k == n // 2:
            continue
        spec[k] = spec[k] * 2.0 if k < n // 2 else 0.0
    out = []
    for m in range(ns):
        v = sum(spec[k] * cmath.exp(2j * math.pi * k * m / n)
                for k in range(n)) / n
        out.append(v.imag)
    return out


def rotate_phase(w, phase_deg):
    phi = math.radians(phase_deg)
    im = hilbert_imag(w)
    return [math.cos(phi) * a + math.sin(phi) * b for a, b in zip(w, im)]


def angle_gather_time(vp, vs, rho, angles, wavelet):
    return [oracle.convolve_same(reflectivity_series(vp, vs, rho, th),
                                 wavelet) for th in angles]


def fit_intercept_gradient(angles, amps, max_angle=30.0):
    xs, ys = [], []
    for th, y in zip(angles, amps):
        if th <= max_angle:
            xs.append(math.sin(math.radians(th)) ** 2)
            ys.append(y)
    n = len(xs)
    sx, sy = sum(xs), sum(ys)
    sxx = sum(x * x for x in xs)
    sxy = sum(x * y for x, y in zip(xs, ys))
    b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    return (sy - b * sx) / n, b


def zero_crossings(args, lo, hi, step=0.01):
    """Angles (deg) where the real Zoeppritz coefficient changes sign."""
    out = []
    prev = oracle.zoeppritz_rpp(*args, lo).real
    th = lo
    while th < hi:
        nxt = th + step
        cur = oracle.zoeppritz_rpp(*args, nxt).real
        if (prev < 0) != (cur < 0):
            out.append(th + step * prev / (prev - cur))
        prev, th = cur, nxt
    return out


# ---------------------------------------------------------------------------
# Fluid line
# ---------------------------------------------------------------------------

def background_slope(vs_over_vp, g=0.25):
    """Castagna, Swan and Foster (1998): constant Vp/Vs, rho ~ Vp^g."""
    return (1.0 - 4.0 * vs_over_vp ** 2 * (g + 2.0)) / (1.0 + g)


def fit_fluid_line(points):
    saa = sum(a * a for a, _ in points)
    sbb = sum(b * b for _, b in points)
    sab = sum(a * b for a, b in points)
    t = 0.5 * math.atan2(2.0 * sab, saa - sbb)
    return math.tan(t)


def distance_from_line(a, b, slope):
    return (b - slope * a) / math.sqrt(1.0 + slope * slope)


# ---------------------------------------------------------------------------
# Iterative Vs
# ---------------------------------------------------------------------------

def gc_sand_shale(vp, vsh):
    if vsh <= 0.0:
        return oracle.gc_lith_vs(vp, "sandstone")
    if vsh >= 1.0:
        return oracle.gc_lith_vs(vp, "shale")
    return oracle.greenberg_castagna_vs(vp, {"sandstone": 1.0 - vsh,
                                             "shale": vsh})


def iterative_vs(vp, rho, phi, kmin, fl_insitu, fl_brine, vsh=0.0,
                 tol=1e-12, max_iter=200):
    vs = gc_sand_shale(vp, vsh)
    for it in range(1, max_iter + 1):
        wet = oracle.substitute_vels(vp, vs, rho, kmin, phi, fl_insitu,
                                     fl_brine)
        vs_brine = gc_sand_shale(wet["vp"], vsh)
        nxt = math.sqrt(wet["rho"] * vs_brine ** 2 / rho)
        change = abs(nxt - vs) / vs
        vs = nxt
        if change < tol:
            return vs, wet["vp"], it
    raise RuntimeError("iterative Vs did not converge")


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

def gardner_rho(vp, a=0.23, b=0.25):
    """Gardner et al. (1974): rho(g/cc) = a V(ft/s)^b; returns kg/m3."""
    return 1000.0 * a * (vp / M_PER_FT) ** b


def gardner_vp(rho, a=0.23, b=0.25):
    return M_PER_FT * (rho / 1000.0 / a) ** (1.0 / b)


def faust_vp(depth_m, rt, gamma=1948.0):
    """Faust (1953): V(ft/s) = gamma (Z(ft) R(ohm m))^(1/6); returns m/s."""
    return M_PER_FT * gamma * ((depth_m / M_PER_FT) * rt) ** (1.0 / 6.0)


def sand_point(kmin, mumin, rhomin, kfl, rhofl, phi, phic=0.4):
    """Nur critical-porosity frame + Gassmann."""
    f = 1.0 - phi / phic
    kdry, mu = kmin * f, mumin * f
    if phi == 0.0:
        k, rho = kmin, rhomin
    else:
        k = oracle.gassmann_ksat(kdry, kmin, kfl, phi)
        rho = (1.0 - phi) * rhomin + phi * rhofl
    vp = math.sqrt((k + 4.0 * mu / 3.0) / rho)
    vs = math.sqrt(mu / rho)
    return {"phi": phi, "vp": vp, "vs": vs, "rho": rho, "ai": vp * rho,
            "vpvs": vp / vs, "k": k, "mu": mu}


def mudrock_point(vp):
    vs = oracle.castagna_mudrock_vs(vp)
    rho = gardner_rho(vp)
    return {"vp": vp, "vs": vs, "rho": rho, "ai": vp * rho, "vpvs": vp / vs}


# ---------------------------------------------------------------------------
# Voigt fluid mix
# ---------------------------------------------------------------------------

def voigt_mix(sats, ks, rhos):
    return {"k": sum(s * k for s, k in zip(sats, ks)),
            "rho": sum(s * r for s, r in zip(sats, rhos))}
