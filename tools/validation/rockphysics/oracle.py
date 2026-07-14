"""Rock physics oracle (G6.0) — INDEPENDENT reference implementations.

Every formula here is written from its primary published definition,
cited at the function, with every numeric constant cross-checked on
2026-07-13 against at least one open, tested implementation:

  - Batzle & Wang 1992 brine/water: bruges (Agile Scientific,
    bruges/rockphysics/fluids.py — caught that the brine-velocity S^2
    coefficient is -820, NOT the -1820 sometimes misquoted).
  - Batzle & Wang 1992 gas + oil: equinor/open_petro_elastic
    material/batzle_wang/{hydro_carbon_gas,oil_properties}.py.
  - Greenberg-Castagna coefficients: rockphypy Emp.py (sand/shale) and
    auralib rp.py (limestone/dolomite + mudrock line).
  - Exact Zoeppritz PP: the Dvorkin et al. (2014) expression form as
    published in bruges reflection.py.

This file must NEVER import from or be checked against any JS in
src/ — the JS engines (G6.1) validate against THIS, which is only a
genuine dual implementation if the two sides share no code.

Unit conventions: Batzle-Wang functions use the paper's native units
(T degC, P MPa, rho g/cc, salinity WEIGHT FRACTION NaCl, GOR L/L,
velocities m/s). The exported `brine()`/`gas()`/`dead_oil()`/
`live_oil()` wrappers return SI (kg/m3, m/s, Pa). Everything else
(Gassmann, AVO, wedge) is SI throughout.

stdlib only — no numpy; regeneration must be byte-identical.
"""

import cmath
import math

# ---------------------------------------------------------------------------
# Batzle & Wang 1992 — "Seismic properties of pore fluids", Geophysics 57(11)
# ---------------------------------------------------------------------------

# Water velocity coefficients w[i][j] (eq 28, Table 1): sum w_ij T^i P^j.
W = [
    [1402.85, 1.524, 3.437e-3, -1.197e-5],
    [4.871, -1.11e-2, 1.739e-4, -1.628e-6],
    [-4.783e-2, 2.747e-4, -2.135e-6, 1.237e-8],
    [1.487e-4, -6.503e-7, -1.455e-8, 1.327e-10],
    [-2.197e-7, 7.987e-10, 5.230e-11, -4.614e-13],
]


def water_density(t, p):
    """Pure water density, g/cc (BW eq 27a). t degC, p MPa."""
    x = (-80.0 * t - 3.3 * t**2 + 0.00175 * t**3 + 489.0 * p - 2.0 * t * p
         + 0.016 * t**2 * p - 1.3e-5 * t**3 * p - 0.333 * p**2
         - 0.002 * t * p**2)
    return 1.0 + 1e-6 * x


def brine_density(t, p, s):
    """NaCl brine density, g/cc (BW eq 27b). s = weight fraction NaCl."""
    x = 300.0 * p - 2400.0 * p * s + t * (80.0 + 3.0 * t - 3300.0 * s
                                          - 13.0 * p + 47.0 * p * s)
    return water_density(t, p) + s * (0.668 + 0.44 * s + 1e-6 * x)


def water_velocity(t, p):
    """Pure water P velocity, m/s (BW eq 28)."""
    return sum(W[i][j] * t**i * p**j for i in range(5) for j in range(4))


def brine_velocity(t, p, s):
    """Brine P velocity, m/s (BW eq 29). The S^2 coefficient is -820."""
    s1 = (1170.0 - 9.6 * t + 0.055 * t**2 - 8.5e-5 * t**3 + 2.6 * p
          - 0.0029 * t * p - 0.0476 * p**2)
    s15 = 780.0 - 10.0 * p + 0.16 * p**2
    return water_velocity(t, p) + s * s1 + s**1.5 * s15 - 820.0 * s**2


def gas_pseudo(t, p, g):
    """Pseudo-reduced temperature and pressure (BW eq 9a). g = gas gravity."""
    ta = t + 273.15
    return ta / (94.72 + 170.75 * g), p / (4.892 - 0.4048 * g)


def gas_z(tpr, ppr):
    """Compressibility factor Z and dZ/dPpr (BW eqs 10b-10c)."""
    m = 0.45 + 8.0 * (0.56 - 1.0 / tpr) ** 2
    e = 0.109 * (3.85 - tpr) ** 2 * math.exp(-m * ppr**1.2 / tpr)
    c = 0.03 + 0.00527 * (3.5 - tpr) ** 3
    z = c * ppr + (0.642 * tpr - 0.007 * tpr**4 - 0.52) + e
    dz_dppr = c - e * m * 1.2 * ppr**0.2 / tpr
    return z, dz_dppr


def gas_density(t, p, g):
    """Gas density, g/cc (BW eq 10a): 28.8*G*P/(Z*R*Ta), R = 8.31441."""
    ta = t + 273.15
    tpr, ppr = gas_pseudo(t, p, g)
    z, _ = gas_z(tpr, ppr)
    return 28.8 * g * p / (z * 8.31441 * ta)


def gas_bulk_modulus(t, p, g):
    """Gas adiabatic bulk modulus, MPa (BW eq 11, 11b)."""
    tpr, ppr = gas_pseudo(t, p, g)
    z, dz_dppr = gas_z(tpr, ppr)
    gamma0 = (0.85 + 5.6 / (ppr + 2.0) + 27.1 / (ppr + 3.5) ** 2
              - 8.7 * math.exp(-0.65 * (ppr + 1.0)))
    return gamma0 * p / (1.0 - ppr * dz_dppr / z)


def dead_oil_density(t, p, rho0):
    """Dead oil density, g/cc (BW eqs 18 then 19). rho0 = g/cc at 15.6C/atm."""
    rho_p = (rho0 + (0.00277 * p - 1.71e-7 * p**3) * (rho0 - 1.15) ** 2
             + 3.49e-4 * p)
    return rho_p / (0.972 + 3.81e-4 * (t + 17.78) ** 1.175)


def dead_oil_velocity(t, p, rho0):
    """Dead oil P velocity, m/s (BW eq 20a)."""
    return (2096.0 * math.sqrt(rho0 / (2.6 - rho0)) - 3.7 * t + 4.64 * p
            + 0.0115 * (4.12 * math.sqrt(1.08 / rho0 - 1.0) - 1.0) * t * p)


def live_oil_b0(t, rho0, rg, g):
    """Live oil volume factor B0 (BW eq 23, Standing 1962). rg = GOR L/L."""
    return 0.972 + 0.00038 * (2.4 * rg * math.sqrt(g / rho0) + t + 17.8) ** 1.175


def live_oil_density(t, p, rho0, rg, g):
    """Live (gas-saturated) oil density, g/cc (BW eq 24).

    Follows open_petro_elastic: eq 24 as written — B0 carries the
    temperature dependence; no further eq 18/19 correction is applied.
    """
    b0 = live_oil_b0(t, rho0, rg, g)
    return (rho0 + 0.0012 * g * rg) / b0


def live_oil_velocity(t, p, rho0, rg, g):
    """Live oil P velocity, m/s: eq 20a with the eq-22 pseudo-density."""
    b0 = live_oil_b0(t, rho0, rg, g)
    rho_pseudo = (rho0 / b0) / (1.0 + 0.001 * rg)
    return dead_oil_velocity(t, p, rho_pseudo)


GCC = 1000.0  # g/cc -> kg/m3


def brine(t, p, s):
    """SI brine properties: {rho kg/m3, vp m/s, k Pa} with K = rho*v^2."""
    rho = brine_density(t, p, s) * GCC
    vp = brine_velocity(t, p, s)
    return {"rho": rho, "vp": vp, "k": rho * vp * vp}


def gas(t, p, g):
    """SI gas properties: {rho kg/m3, k Pa}. v is not a BW gas output."""
    rho = gas_density(t, p, g) * GCC
    return {"rho": rho, "k": gas_bulk_modulus(t, p, g) * 1e6}


def dead_oil(t, p, rho0):
    rho = dead_oil_density(t, p, rho0) * GCC
    vp = dead_oil_velocity(t, p, rho0)
    return {"rho": rho, "vp": vp, "k": rho * vp * vp}


def live_oil(t, p, rho0, rg, g):
    rho = live_oil_density(t, p, rho0, rg, g) * GCC
    vp = live_oil_velocity(t, p, rho0, rg, g)
    return {"rho": rho, "vp": vp, "k": rho * vp * vp}


def wood_mix(sats, ks, rhos):
    """Reuss/Wood mixed fluid: K harmonic in saturation, rho arithmetic.

    Rock Physics Handbook (Mavko, Mukerji & Dvorkin), Wood's equation.
    """
    if abs(sum(sats) - 1.0) > 1e-12:
        raise ValueError("saturations must sum to 1")
    k = 1.0 / sum(s / k for s, k in zip(sats, ks) if s > 0.0)
    rho = sum(s * r for s, r in zip(sats, rhos))
    return {"k": k, "rho": rho}


# ---------------------------------------------------------------------------
# Mineral mixing — Voigt-Reuss-Hill (RPH ch. 4)
# ---------------------------------------------------------------------------

def voigt_reuss_hill(fracs, moduli):
    """VRH average of mineral moduli. fracs sum to 1."""
    if abs(sum(fracs) - 1.0) > 1e-12:
        raise ValueError("fractions must sum to 1")
    voigt = sum(f * m for f, m in zip(fracs, moduli))
    reuss = 1.0 / sum(f / m for f, m in zip(fracs, moduli) if f > 0.0)
    return 0.5 * (voigt + reuss)


# ---------------------------------------------------------------------------
# Gassmann (1951) — RPH ch. 6 form
# ---------------------------------------------------------------------------

def gassmann_ksat(kdry, kmin, kfl, phi):
    """K_sat = K_dry + (1 - K_dry/K_min)^2 /
    (phi/K_fl + (1-phi)/K_min - K_dry/K_min^2)."""
    _check_gassmann(kdry, kmin, kfl, phi)
    num = (1.0 - kdry / kmin) ** 2
    den = phi / kfl + (1.0 - phi) / kmin - kdry / kmin**2
    return kdry + num / den


def gassmann_kdry(ksat, kmin, kfl, phi):
    """Inverse Gassmann (RPH): recover K_dry from K_sat."""
    if not 0.0 < phi < 1.0:
        raise ValueError("phi must be in (0,1)")
    if kfl <= 0.0 or kmin <= 0.0:
        raise ValueError("moduli must be positive")
    num = ksat * (phi * kmin / kfl + 1.0 - phi) - kmin
    den = phi * kmin / kfl + ksat / kmin - 1.0 - phi
    return num / den


def gassmann_substitute(ksat_a, kmin, kfl_a, kfl_b, phi):
    """Fluid A -> dry -> fluid B."""
    return gassmann_ksat(gassmann_kdry(ksat_a, kmin, kfl_a, phi),
                         kmin, kfl_b, phi)


def substitute_vels(vp, vs, rho, kmin, phi, fl_a, fl_b):
    """Log-domain substitution: (vp, vs, rho) with fluid A -> fluid B.

    mu is Gassmann-invariant; bulk density swaps the pore fluid:
    rho_b = rho + phi*(rho_fl_b - rho_fl_a).
    fl_a / fl_b are {k, rho} dicts (SI).
    """
    mu = rho * vs * vs
    ksat_a = rho * vp * vp - 4.0 * mu / 3.0
    ksat_b = gassmann_substitute(ksat_a, kmin, fl_a["k"], fl_b["k"], phi)
    rho_b = rho + phi * (fl_b["rho"] - fl_a["rho"])
    vp_b = math.sqrt((ksat_b + 4.0 * mu / 3.0) / rho_b)
    vs_b = math.sqrt(mu / rho_b)
    return {"vp": vp_b, "vs": vs_b, "rho": rho_b, "ksat": ksat_b, "mu": mu}


def _check_gassmann(kdry, kmin, kfl, phi):
    if not 0.0 < phi < 1.0:
        raise ValueError("phi must be in (0,1)")
    if kdry <= 0.0 or kmin <= 0.0 or kfl <= 0.0:
        raise ValueError("moduli must be positive")
    if kdry >= kmin:
        raise ValueError("K_dry must be below K_mineral")


# ---------------------------------------------------------------------------
# Vs estimation — Castagna mudrock line; Greenberg & Castagna (1992)
# ---------------------------------------------------------------------------

# Vs = a2*Vp^2 + a1*Vp + a0, all in km/s (GC 1992 Table 1; RPH p. 516).
GC_COEFF = {
    "sandstone": (0.0, 0.80416, -0.85588),
    "limestone": (-0.05508, 1.01677, -1.03049),
    "dolomite": (0.0, 0.58321, -0.07775),
    "shale": (0.0, 0.76969, -0.86735),
}


def castagna_mudrock_vs(vp):
    """Castagna et al. (1985) mudrock line: Vs = 0.8621*Vp - 1172.4 (m/s)."""
    return 0.8621 * vp - 1172.4


def gc_lith_vs(vp, lith):
    """Single-lithology GC Vs from Vp, m/s in, m/s out."""
    a2, a1, a0 = GC_COEFF[lith]
    vpk = vp / 1000.0
    return (a2 * vpk**2 + a1 * vpk + a0) * 1000.0


def greenberg_castagna_vs(vp, fracs):
    """GC composite: average of arithmetic and harmonic lithology means.

    fracs: {lith: volume fraction}, sum 1 (GC 1992 eq for multimineral
    brine-saturated rock).
    """
    if abs(sum(fracs.values()) - 1.0) > 1e-12:
        raise ValueError("lithology fractions must sum to 1")
    vss = {l: gc_lith_vs(vp, l) for l in fracs}
    arith = sum(f * vss[l] for l, f in fracs.items() if f > 0.0)
    harm = 1.0 / sum(f / vss[l] for l, f in fracs.items() if f > 0.0)
    return 0.5 * (arith + harm)


# ---------------------------------------------------------------------------
# AVO — exact Zoeppritz PP (Dvorkin et al. 2014 expression form),
# Aki & Richards 3-term, Shuey 2-/3-term, Rutherford-Williams classes
# ---------------------------------------------------------------------------

def zoeppritz_rpp(vp1, vs1, rho1, vp2, vs2, rho2, theta_deg):
    """Exact Zoeppritz PP reflectivity (complex past critical).

    Cosines use the Im >= 0 branch of sqrt(1 - (p*v)^2) so evanescent
    transmitted waves decay.
    """
    th1 = math.radians(theta_deg)
    p = math.sin(th1) / vp1

    def cosine(v):
        return cmath.sqrt(1.0 - (p * v) ** 2)

    sin_phi1, sin_phi2, sin_th2 = p * vs1, p * vs2, p * vp2
    cos_th1 = math.cos(th1)
    cos_th2, cos_phi1, cos_phi2 = cosine(vp2), cosine(vs1), cosine(vs2)

    a = rho2 * (1 - 2 * sin_phi2**2) - rho1 * (1 - 2 * sin_phi1**2)
    b = rho2 * (1 - 2 * sin_phi2**2) + 2 * rho1 * sin_phi1**2
    c = rho1 * (1 - 2 * sin_phi1**2) + 2 * rho2 * sin_phi2**2
    d = 2 * (rho2 * vs2**2 - rho1 * vs1**2)

    e = b * cos_th1 / vp1 + c * cos_th2 / vp2
    f = b * cos_phi1 / vs1 + c * cos_phi2 / vs2
    g = a - d * (cos_th1 / vp1) * (cos_phi2 / vs2)
    h = a - d * (cos_th2 / vp2) * (cos_phi1 / vs1)

    den = e * f + g * h * p**2
    return (f * (b * cos_th1 / vp1 - c * cos_th2 / vp2)
            - h * p**2 * (a + d * (cos_th1 / vp1) * (cos_phi2 / vs2))) / den


def aki_richards(vp1, vs1, rho1, vp2, vs2, rho2, theta_deg):
    """Aki & Richards (1980) 3-term linearization (bruges form)."""
    th = math.radians(theta_deg)
    vp, vs = 0.5 * (vp1 + vp2), 0.5 * (vs1 + vs2)
    rho = 0.5 * (rho1 + rho2)
    dvp, dvs, drho = vp2 - vp1, vs2 - vs1, rho2 - rho1
    th2 = math.asin(math.sin(th) * vp2 / vp1)
    th_mean = 0.5 * (th + th2)
    return (0.5 * drho / rho
            - 2.0 * (vs / vp1) ** 2 * (drho / rho) * math.sin(th) ** 2
            + 0.5 * (dvp / vp) / math.cos(th_mean) ** 2
            - 4.0 * (vs / vp1) ** 2 * (dvs / vs) * math.sin(th) ** 2)


def shuey(vp1, vs1, rho1, vp2, vs2, rho2, theta_deg, three_term=True):
    """Shuey (1985) approximation. Returns (A, B, C, R(theta))."""
    th = math.radians(theta_deg)
    vp, vs = 0.5 * (vp1 + vp2), 0.5 * (vs1 + vs2)
    rho = 0.5 * (rho1 + rho2)
    dvp, dvs, drho = vp2 - vp1, vs2 - vs1, rho2 - rho1
    a = 0.5 * (dvp / vp + drho / rho)
    b = (0.5 * dvp / vp
         - 2.0 * (vs / vp) ** 2 * (drho / rho + 2.0 * dvs / vs))
    c = 0.5 * dvp / vp
    r = a + b * math.sin(th) ** 2
    if three_term:
        r += c * (math.tan(th) ** 2 - math.sin(th) ** 2)
    return a, b, c, r


def avo_class(a, b, threshold=0.02):
    """Rutherford & Williams (1989) classes I-III + Castagna class IV.

    threshold: |A| bound separating class II from I/III (documented
    convention; the literature draws the II band qualitatively).
    """
    if a > threshold:
        return "I"
    if abs(a) <= threshold:
        return "II"
    return "IV" if b > 0.0 else "III"


# ---------------------------------------------------------------------------
# Wedge / tuning — Ricker wavelet + convolution (independent of the JS)
# ---------------------------------------------------------------------------

def ricker(freq_hz, dt_ms, half_length_ms):
    """Ricker wavelet (1 - 2 pi^2 f^2 t^2) exp(-pi^2 f^2 t^2), unit peak."""
    n = int(round(half_length_ms / dt_ms))
    out = []
    for i in range(-n, n + 1):
        t = i * dt_ms / 1000.0
        u = (math.pi * freq_hz * t) ** 2
        out.append((1.0 - 2.0 * u) * math.exp(-u))
    return out


def convolve_same(signal, kernel):
    """'same' convolution, kernel centred (odd length)."""
    half = len(kernel) // 2
    n = len(signal)
    out = [0.0] * n
    for i in range(n):
        acc = 0.0
        for j, kv in enumerate(kernel):
            si = i + half - j
            if 0 <= si < n:
                acc += signal[si] * kv
        out[i] = acc
    return out


def wedge_trace(thickness_ms, rc_top, rc_base, freq_hz, dt_ms, trace_ms):
    """Two-spike wedge trace: rc_top at t0, rc_base at t0+thickness."""
    n = int(round(trace_ms / dt_ms)) + 1
    t0 = n // 3
    spikes = [0.0] * n
    spikes[t0] += rc_top
    ib = t0 + int(round(thickness_ms / dt_ms))
    if ib < n:
        spikes[ib] += rc_base
    return convolve_same(spikes, ricker(freq_hz, dt_ms, 60.0)), t0


def wedge_tuning_curve(rc_top, rc_base, freq_hz, dt_ms, max_thickness_ms):
    """Peak |amplitude| near the top interface vs wedge thickness."""
    curve = []
    steps = int(round(max_thickness_ms / dt_ms))
    for k in range(steps + 1):
        thickness = k * dt_ms
        trace, t0 = wedge_trace(thickness, rc_top, rc_base, freq_hz, dt_ms,
                                max_thickness_ms * 3.0)
        w = int(round(0.5 * math.sqrt(6.0) / (math.pi * freq_hz) * 1000.0
                      / dt_ms)) + 1
        lo, hi = max(0, t0 - w), t0 + w + 1
        curve.append(max(abs(v) for v in trace[lo:hi]))
    return curve


def tuning_thickness_ms(curve, dt_ms):
    """Thickness at maximum of the tuning curve."""
    best = max(range(len(curve)), key=lambda i: curve[i])
    return best * dt_ms
