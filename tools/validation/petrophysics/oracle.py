"""Petrophysics oracle (G2.0) — INDEPENDENT reference implementations.

Every formula here is written from its primary published definition,
cited at the function. This file must NEVER import from or be checked
against src/utils/petrophysicsCalculations.js — the JS engines (G2.1)
validate against THIS, which is only a genuine dual implementation if
the two sides share no code and no author-copying.

Pure Python stdlib (math only), float64 throughout, deterministic.
Null convention: None in = None out (the JS engines use NaN; the
comparator maps None <-> NaN).

Unit conventions (SI-internal, the G1 registry rule):
  depth m; RHOB g/cc; DT us/m; resistivities ohm.m; GR API;
  temperatures degF ONLY inside the SP/Arps formulas (documented at
  the boundary — the formulas are defined in degF).
"""

import math

# ---- Vsh from GR ----------------------------------------------------------


def igr(gr, gr_clean, gr_clay):
    """Gamma-ray index, linear response: IGR = (GR-GRclean)/(GRclay-GRclean),
    clamped to [0, 1]. The 'linear' Vsh model IS IGR."""
    if gr is None:
        return None
    if gr_clay <= gr_clean:
        raise ValueError("gr_clay must exceed gr_clean")
    x = (gr - gr_clean) / (gr_clay - gr_clean)
    return min(1.0, max(0.0, x))


def vsh_larionov_tertiary(i):
    """Larionov (1969), tertiary/unconsolidated rocks:
    Vsh = 0.083*(2^(3.7*IGR) - 1)."""
    if i is None:
        return None
    return 0.083 * (2.0 ** (3.7 * i) - 1.0)


def vsh_larionov_older(i):
    """Larionov (1969), older/consolidated rocks: Vsh = 0.33*(2^(2*IGR)-1)."""
    if i is None:
        return None
    return 0.33 * (2.0 ** (2.0 * i) - 1.0)


def vsh_clavier(i):
    """Clavier, Hoyle & Meunier (1971): Vsh = 1.7 - sqrt(3.38 - (IGR+0.7)^2)."""
    if i is None:
        return None
    return 1.7 - math.sqrt(3.38 - (i + 0.7) ** 2)


def vsh_steiber(i):
    """Steiber (1970): Vsh = IGR / (3 - 2*IGR)."""
    if i is None:
        return None
    return i / (3.0 - 2.0 * i)


# ---- Porosity -------------------------------------------------------------


def phi_density(rhob, rho_ma, rho_fl):
    """Density porosity: phi = (rho_ma - rho_b)/(rho_ma - rho_fl).
    UNCLAMPED — out-of-range values are information (bad hole, gas,
    wrong matrix), the engine flags rather than hides them."""
    if rhob is None:
        return None
    return (rho_ma - rhob) / (rho_ma - rho_fl)


def phi_sonic_wyllie(dt, dt_ma, dt_fl, cp=1.0):
    """Wyllie, Gregory & Gardner (1956) time-average:
    phi = (dt - dt_ma)/(dt_fl - dt_ma) / cp, cp = compaction factor
    (>= 1; 1 = no correction). Any consistent slowness unit."""
    if dt is None:
        return None
    return (dt - dt_ma) / (dt_fl - dt_ma) / cp


def phi_sonic_rhg(dt, dt_ma, c=0.67):
    """Raymer, Hunt & Gardner (1980) field-observation form:
    phi = C*(dt - dt_ma)/dt, C typically 0.67 (0.625 sometimes used
    for gas-bearing intervals). Any consistent slowness unit."""
    if dt is None:
        return None
    return c * (dt - dt_ma) / dt


def phi_nd(phi_d, phi_n, method="avg"):
    """Neutron-density combination.
    avg: (phiN + phiD)/2 — the standard oil/water form.
    rms: sqrt((phiN^2 + phiD^2)/2) — the gas-zone form (root-mean-
    square weights the higher density porosity up under crossover)."""
    if phi_d is None or phi_n is None:
        return None
    if method == "rms":
        return math.sqrt((phi_d * phi_d + phi_n * phi_n) / 2.0)
    return (phi_d + phi_n) / 2.0


def phi_shale_corrected(phi, vsh, phi_shale):
    """Linear shale-point correction: phi_e = phi - Vsh*phi_shale_apparent,
    where phi_shale_apparent is the tool's reading in 100% shale."""
    if phi is None or vsh is None:
        return None
    return phi - vsh * phi_shale


# ---- Rw utilities ---------------------------------------------------------


def rw_arps(rw1, t1_f, t2_f):
    """Arps resistivity-temperature conversion (NaCl solutions), degF:
    Rw2 = Rw1 * (T1 + 6.77)/(T2 + 6.77)."""
    if rw1 is None:
        return None
    return rw1 * (t1_f + 6.77) / (t2_f + 6.77)


def sp_k(temp_f):
    """SP temperature coefficient: K = 61 + 0.133*T(degF)."""
    return 61.0 + 0.133 * temp_f


def rwe_from_ssp(ssp_mv, rmfe, temp_f):
    """SP chain: SSP = -K*log10(Rmfe/Rwe)  =>  Rwe = Rmfe * 10^(SSP/K).
    Rwe is the EQUIVALENT water resistivity; rwe_to_rw takes it to Rw
    (PT11a, Bateman & Konen 1977) and rmfe_from_rmf gives Rmfe."""
    if ssp_mv is None:
        return None
    return rmfe * 10.0 ** (ssp_mv / sp_k(temp_f))


def _bk_ab(t_f):
    """Bateman & Konen (1977, The Log Analyst 18(5) p. 3-11) fit to the
    Schlumberger Rw vs Rweq chart (SP-2 / Gen-9), T in degF:
    A = 0.131*10^(1/log10(T/19.9) - 2), B = 10^(0.0426/log10(T/50.8)).
    Written from the paper as supplied 2026-09-10, never from the JS."""
    if t_f is None or t_f <= 50.8:
        return None
    a = 0.131 * 10.0 ** (1.0 / math.log10(t_f / 19.9) - 2.0)
    b = 10.0 ** (0.0426 / math.log10(t_f / 50.8))
    return a, b


def rwe_to_rw(rwe, t_f):
    """Rw = (Rwe + A)/(B - 0.5*Rwe); None where the denominator is not
    positive (the fit fails, roughly Rwe > 2 ohm.m) or T <= 50.8 degF."""
    ab = _bk_ab(t_f)
    if ab is None or rwe is None or rwe <= 0:
        return None
    a, b = ab
    den = b - 0.5 * rwe
    if den <= 0:
        return None
    return (rwe + a) / den


def rw_to_rwe(rw, t_f):
    """Inverse: Rwe = (Rw*B - A)/(1 + 0.5*Rw); None when not positive."""
    ab = _bk_ab(t_f)
    if ab is None or rw is None or rw <= 0:
        return None
    a, b = ab
    rwe = (rw * b - a) / (1.0 + 0.5 * rw)
    return rwe if rwe > 0 else None


def rmfe_from_rmf(rmf, rmf_t_f, t_f):
    """Rmfe at formation temperature: Rmfe = 0.85*Rmf(T) when Rmf at
    75 degF exceeds 0.1 ohm.m (standard convention), else the chart
    inverse. Returns (rmfe, rule)."""
    if rmf is None or rmf <= 0:
        return None, None
    rmf_t = rw_arps(rmf, rmf_t_f, t_f)
    rmf_75 = rw_arps(rmf, rmf_t_f, 75.0)
    if rmf_75 > 0.1:
        return 0.85 * rmf_t, "x0.85"
    return rw_to_rwe(rmf_t, t_f), "chart-inverse"


def rw_from_ssp(ssp_mv, rmf, rmf_t_f, t_f):
    """The whole chain at formation temperature."""
    rmfe, rule = rmfe_from_rmf(rmf, rmf_t_f, t_f)
    rwe = rwe_from_ssp(ssp_mv, rmfe, t_f)
    return {"k": sp_k(t_f), "rmfe": rmfe, "rule": rule, "rwe": rwe, "rw": rwe_to_rw(rwe, t_f)}


def rw_from_salinity(ppm_nacl, t_f):
    """Bateman & Konen (1977), The Log Analyst 18(5), fit to the
    Schlumberger Gen-9 resistivity-of-NaCl-solutions chart:
    Rw(75 degF) = 0.0123 + 3647.5 / ppm^0.955, then Arps to t_f.
    A chart FIT (about 10 percent over 1,000-300,000 ppm), not a
    physical law; the UI labels it so."""
    if ppm_nacl is None or ppm_nacl <= 0:
        return None
    rw75 = 0.0123 + 3647.5 / ppm_nacl ** 0.955
    return rw_arps(rw75, 75.0, t_f)


def salinity_from_rw(rw, t_f):
    """Inverse of rw_from_salinity through the same fit."""
    if rw is None or rw <= 0:
        return None
    rw75 = rw_arps(rw, t_f, 75.0)
    if rw75 <= 0.0123:
        return None
    return (3647.5 / (rw75 - 0.0123)) ** (1.0 / 0.955)


def pickett_fit(points):
    """Pickett (1966/1973) water-line fit. points = [(phi, rt), ...] on
    the assumed Sw=1 line. Archie at Sw=1: log10(Rt) = log10(a*Rw)
    - m*log10(phi). Ordinary least squares in log10 space returns
    (m, a_rw) with m reported positive."""
    xs = [math.log10(p) for p, _ in points]
    ys = [math.log10(r) for _, r in points]
    n = float(len(points))
    sx, sy = sum(xs), sum(ys)
    sxx = sum(x * x for x in xs)
    sxy = sum(x * y for x, y in zip(xs, ys))
    slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    intercept = (sy - slope * sx) / n
    return (-slope, 10.0 ** intercept)


# ---- Water saturation -----------------------------------------------------


def sw_archie(rt, phi, rw, a=1.0, m=2.0, n=2.0):
    """Archie (1942): Sw = ((a*Rw)/(phi^m * Rt))^(1/n). UNCLAMPED —
    Sw > 1 is information (the engine clamps for display and flags)."""
    if rt is None or phi is None:
        return None
    if rt <= 0.0 or phi <= 0.0:
        return None
    return ((a * rw) / (phi ** m * rt)) ** (1.0 / n)


def sw_simandoux(rt, phi, rw, vsh, rsh, a=1.0, m=2.0):
    """Simandoux (1963), classic form (n=2 built into the quadratic):
    1/Rt = phi^m*Sw^2/(a*Rw) + Vsh*Sw/Rsh.
    Positive root of C*Sw^2 + D*Sw - 1/Rt = 0 with
    C = phi^m/(a*Rw), D = Vsh/Rsh. Reduces exactly to Archie (n=2)
    at Vsh = 0."""
    if rt is None or phi is None or vsh is None:
        return None
    if rt <= 0.0 or phi <= 0.0:
        return None
    c = phi ** m / (a * rw)
    d = vsh / rsh
    return (-d + math.sqrt(d * d + 4.0 * c / rt)) / (2.0 * c)


def sw_indonesia(rt, phi, rw, vsh, rsh, a=1.0, m=2.0, n=2.0):
    """Poupon & Leveaux (1971) 'Indonesia':
    1/sqrt(Rt) = (Vsh^(1-Vsh/2)/sqrt(Rsh) + phi^(m/2)/sqrt(a*Rw)) * Sw^(n/2).
    Reduces exactly to Archie at Vsh = 0."""
    if rt is None or phi is None or vsh is None:
        return None
    if rt <= 0.0 or phi <= 0.0:
        return None
    term_sh = (vsh ** (1.0 - 0.5 * vsh)) / math.sqrt(rsh) if vsh > 0.0 else 0.0
    term_phi = phi ** (m / 2.0) / math.sqrt(a * rw)
    return ((1.0 / math.sqrt(rt)) / (term_sh + term_phi)) ** (2.0 / n)


# ---- Formation temperature (PS5) ------------------------------------------


def temp_at_depth(z_m, surface_c, bht_c, bht_depth_m):
    """Linear geothermal profile: T(z) = Ts + (BHT - Ts)*z/z_bht (degC).
    Depths below the BHT station extrapolate on the same gradient."""
    if z_m is None:
        return None
    return surface_c + (bht_c - surface_c) * (z_m / bht_depth_m)


def c_to_f(t_c):
    """degC -> degF (the Arps/SP formulas are defined in degF)."""
    return t_c * 9.0 / 5.0 + 32.0


def rw_at_temp(rw_ref, ref_c, t_c):
    """Rw at formation temperature: Arps conversion, degC in, degF
    inside (rw_arps owns the 6.77 offset)."""
    if t_c is None:
        return None
    return rw_arps(rw_ref, c_to_f(ref_c), c_to_f(t_c))


# ---- Shaly-sand Sw (PS5) --------------------------------------------------


def b_juhasz(t_c):
    """Juhasz (1981, SPWLA 22nd Annual Logging Symposium, paper Z),
    polynomial fit for the Waxman-Smits equivalent counterion
    conductance: B = -1.28 + 0.225*T - 0.0004059*T^2 (T degC,
    B in (S/m)/(meq/cm3))."""
    return -1.28 + 0.225 * t_c - 0.0004059 * t_c * t_c


def qv_from_cec(cec_meq_100g, phit, rho_grain):
    """Waxman & Smits (1968): Qv = CEC*(1-phit)*rho_grain/(100*phit),
    CEC in meq/100 g, rho_grain g/cc -> Qv in meq/cm3."""
    if phit is None or phit <= 0.0 or phit >= 1.0:
        return None
    return cec_meq_100g * (1.0 - phit) * rho_grain / (100.0 * phit)


def _bisect(f, lo, hi, iters=200):
    """Pure bisection (deliberately DIFFERENT numerics from the JS
    Newton solvers, per the independence rule)."""
    flo = f(lo)
    fhi = f(hi)
    if flo == 0.0:
        return lo
    if fhi == 0.0:
        return hi
    if flo * fhi > 0.0:
        return None
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if fm == 0.0:
            return mid
        if flo * fm < 0.0:
            hi = mid
        else:
            lo = mid
            flo = fm
    return 0.5 * (lo + hi)


def sw_waxman_smits(rt, phi, rw, qv, b, a=1.0, m_star=2.0, n_star=2.0):
    """Waxman & Smits (1968, SPE Journal 8(2), "Electrical
    Conductivities in Oil-Bearing Shaly Sands"):
    1/Rt = (phi^m* * Sw^n* / a) * (1/Rw + B*Qv/Sw).
    NOTE m*/n* are the shaly-rock exponents, NOT Archie's m/n.
    Implicit in Sw; bisection on [1e-9, 10]. Reduces exactly to
    Archie at Qv = 0. UNCLAMPED."""
    if rt is None or phi is None:
        return None
    if rt <= 0.0 or phi <= 0.0:
        return None
    target = 1.0 / rt
    k = phi ** m_star / a

    def f(sw):
        return k * sw ** n_star * (1.0 / rw + b * qv / sw) - target

    return _bisect(f, 1e-9, 10.0)


def sw_dual_water(rt, phit, rwf, rwb, swb, a=1.0, m0=2.0, n0=2.0):
    """Clavier, Coates & Dumanoir (1984, SPE Journal 24(2),
    "Theoretical and Experimental Bases for the Dual-Water Model"):
    1/Rt = (phit^m0 * Swt^n0 / a) * (1/Rwf + (Swb/Swt)*(1/Rwb - 1/Rwf)).
    Implicit in Swt; bisection on [1e-9, 10]. Reduces exactly to
    Archie (Rw = Rwf) at Swb = 0. UNCLAMPED."""
    if rt is None or phit is None:
        return None
    if rt <= 0.0 or phit <= 0.0:
        return None
    target = 1.0 / rt
    k = phit ** m0 / a
    dc = 1.0 / rwb - 1.0 / rwf

    def f(swt):
        return k * swt ** n0 * (1.0 / rwf + swb * dc / swt) - target

    return _bisect(f, 1e-9, 10.0)


def sw_mod_simandoux(rt, phi, rw, vsh, rsh, a=1.0, m=2.0, n=2.0):
    """Bardon & Pied (1969) modified Simandoux:
    1/Rt = phi^m*Sw^n/(a*Rw*(1-Vsh)) + Vsh*Sw/Rsh.
    Implicit for general n; bisection on [1e-9, 10]. Reduces exactly
    to Archie at Vsh = 0. UNCLAMPED; Vsh >= 1 has no clean term and
    returns None."""
    if rt is None or phi is None or vsh is None:
        return None
    if rt <= 0.0 or phi <= 0.0 or vsh >= 1.0:
        return None
    target = 1.0 / rt
    c = phi ** m / (a * rw * (1.0 - vsh))
    d = vsh / rsh

    def f(sw):
        return c * sw ** n + d * sw - target

    return _bisect(f, 1e-9, 10.0)



# ---- Matrix ID + Hingle (PS10) --------------------------------------------


def hingle_y(rt, m):
    """Hingle (1959) transform y = Rt^(-1/m) — the Sw=1 locus becomes a
    line through the origin on a phi (x) vs y plot."""
    if rt is None or rt <= 0.0:
        return None
    return rt ** (-1.0 / m)


def hingle_fit(depth, phi, rt, top, base, a=1.0, m=2.0):
    """Least-squares slope THROUGH THE ORIGIN of y = Rt^(-1/m) vs phi
    over the window, inverted for Rw = slope^(-m)/a."""
    sxy = sxx = 0.0
    n = 0
    for z, f, r in zip(depth, phi, rt):
        if z < top or z > base:
            continue
        if f is None or r is None or f <= 0.0 or r <= 0.0:
            continue
        y = hingle_y(r, m)
        sxy += f * y
        sxx += f * f
        n += 1
    slope = sxy / sxx
    return slope ** (-m) / a, slope, n


def rho_maa(rhob, phi, rho_fl):
    """Doveton (1994): rho_maa = (rho_b - phi*rho_fl)/(1 - phi)."""
    if rhob is None or phi is None or phi >= 1.0:
        return None
    return (rhob - phi * rho_fl) / (1.0 - phi)


def u_maa(pef, rhob, phi, u_fl=0.398):
    """Doveton (1994): U = Pe*rho_e, rho_e = (rho_b + 0.1883)/1.0704;
    U_maa = (U - phi*U_fl)/(1 - phi)."""
    if pef is None or rhob is None or phi is None or phi >= 1.0:
        return None
    rho_e = (rhob + 0.1883) / 1.0704
    return (pef * rho_e - phi * u_fl) / (1.0 - phi)


def thomas_stieber(phit, vsh, phi_sand, phi_sh):
    """Thomas & Stieber (1975, SPE 4271) end-member porosities at this
    Vsh, and the nearest model to the measured porosity."""
    if vsh is None:
        return None
    models = {
        "laminated": phi_sand * (1.0 - vsh) + phi_sh * vsh,
        "dispersed": phi_sand - vsh * (1.0 - phi_sh),
        "structural": phi_sand + vsh * phi_sh,
    }
    nearest = None
    if phit is not None:
        best = float("inf")
        for name, value in models.items():
            d = abs(phit - value)
            if d < best:
                best = d
                nearest = name
    models["nearest"] = nearest
    return models


def two_mineral_solve(rhob, nphi, rho1, n1, rho2, n2, rho_fl, n_fl):
    """Exact 2-mineral density-neutron solve (v1 + v2 + phi = 1),
    UNCLAMPED — negative volumes are information."""
    if rhob is None or nphi is None:
        return None
    a11 = rho1 - rho_fl
    a12 = rho2 - rho_fl
    a21 = n1 - n_fl
    a22 = n2 - n_fl
    det = a11 * a22 - a12 * a21
    if abs(det) < 1e-12:
        return None
    b1 = rhob - rho_fl
    b2 = nphi - n_fl
    v1 = (b1 * a22 - b2 * a12) / det
    v2 = (a11 * b2 - a21 * b1) / det
    return {"v1": v1, "v2": v2, "phi": 1.0 - v1 - v2}


def rho_electron(rhob):
    """Chart-book electron density rho_e = (rho_b + 0.1883)/1.0704."""
    return (rhob + 0.1883) / 1.0704


def u_of(pe, rho):
    """A mineral's volumetric photoelectric index U = Pe * rho_e(rho)."""
    return pe * rho_electron(rho)


def _gauss4(a, b):
    """Own elimination with partial pivoting (never numpy, never the JS)."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[piv][col]) < 1e-14:
            return None
        m[col], m[piv] = m[piv], m[col]
        for r in range(col + 1, n):
            f = m[r][col] / m[col][col]
            if f == 0.0:
                continue
            for c in range(col, n + 1):
                m[r][c] -= f * m[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        sacc = m[r][n]
        for c in range(r + 1, n):
            sacc -= m[r][c] * x[c]
        x[r] = sacc / m[r][r]
    return x


def three_mineral_solve(rhob, nphi, pef, minerals, fluid, tol=1e-9):
    """PT11d stage one (Doveton 1994 ch. 3, determined case): v1, v2, v3,
    phi from rhob, nphi, U = pef*rho_e(rhob) and closure, each mineral
    {rho, nphi, u}, fluid {rho, nphi, u}. Returns a dict with flag 0
    accepted, 1 singular, 2 a fraction outside [0, 1] beyond tol (with the
    excursion as residual and the unclamped solution), 3 missing input."""
    if rhob is None or nphi is None or pef is None:
        return {"flag": 3, "v": [None] * 3, "phi": None, "residual": None}
    u = pef * rho_electron(rhob)
    a = [[m["rho"] for m in minerals] + [fluid["rho"]],
         [m["nphi"] for m in minerals] + [fluid["nphi"]],
         [m["u"] for m in minerals] + [fluid["u"]],
         [1.0, 1.0, 1.0, 1.0]]
    x = _gauss4(a, [rhob, nphi, u, 1.0])
    if x is None:
        return {"flag": 1, "v": [None] * 3, "phi": None, "residual": None}
    exc = max(max(-f, f - 1.0) for f in x)
    exc = max(exc, 0.0)
    if exc > tol:
        return {"flag": 2, "v": [None] * 3, "phi": None, "residual": exc, "unclamped": x}
    return {"flag": 0, "v": x[:3], "phi": x[3], "residual": 0.0, "unclamped": x}


# ---- Curve normalization (PS7) --------------------------------------------


def percentile(values, p):
    """p-th percentile (0-100) of the finite values, linear
    interpolation on rank (n-1)*p/100 (the numpy 'linear' method)."""
    finite = sorted(v for v in values if v is not None)
    if not finite:
        return None
    rank = (len(finite) - 1) * p / 100.0
    lo = int(math.floor(rank))
    hi = int(math.ceil(rank))
    if lo == hi:
        return finite[lo]
    return finite[lo] + (finite[hi] - finite[lo]) * (rank - lo)


def _mean_std(values):
    finite = [v for v in values if v is not None]
    if not finite:
        return None, None
    mean = sum(finite) / len(finite)
    var = sum((v - mean) ** 2 for v in finite) / len(finite)   # population
    return mean, math.sqrt(var)


def fit_normalization_two_point(ref, target, p_low=5.0, p_high=95.0):
    """Two-point (percentile-anchor) field normalization: match the
    target's pLow/pHigh percentiles to the reference's. Returns
    (shift, scale) for v' = shift + scale*v."""
    r_lo, r_hi = percentile(ref, p_low), percentile(ref, p_high)
    t_lo, t_hi = percentile(target, p_low), percentile(target, p_high)
    scale = (r_hi - r_lo) / (t_hi - t_lo)
    return r_lo - t_lo * scale, scale


def fit_normalization_meanstd(ref, target):
    """Mean/population-std matching normalization -> (shift, scale)."""
    r_mean, r_std = _mean_std(ref)
    t_mean, t_std = _mean_std(target)
    scale = r_std / t_std
    return r_mean - t_mean * scale, scale


def apply_normalization(values, shift, scale):
    return [None if v is None else shift + scale * v for v in values]


# ---- Log conditioning (PS8) -----------------------------------------------
# depth_shift_block is a CONSTANT block shift and depth_shift_tie_points
# (PT11c) the stretch-and-squeeze warp through tie points; both resampled
# back onto the original grid — deliberately NOT interval-wise
# stretch/squeeze correlation (a Techlog-class interactive depth match
# is a program of its own).


def despike_hampel(x, half_window, n_sigma):
    """Hampel filter (Hampel 1974; Pearson et al. 2016 review):
    replace x[i] with the window median where
    |x[i] - median| > n_sigma * 1.4826 * MAD. A zero-MAD window (at
    least half the samples identical) treats ANY deviation from the
    median as a spike — the strict inequality handles it. None passes
    through and never enters a window."""
    out = list(x)
    n = len(x)
    for i in range(n):
        if x[i] is None:
            continue
        w = [x[j] for j in range(max(0, i - half_window), min(n, i + half_window + 1))
             if x[j] is not None]
        if len(w) < 3:
            continue
        w.sort()
        med = w[len(w) // 2] if len(w) % 2 else 0.5 * (w[len(w) // 2 - 1] + w[len(w) // 2])
        mad_list = sorted(abs(v - med) for v in w)
        mad = mad_list[len(mad_list) // 2] if len(mad_list) % 2 else 0.5 * (
            mad_list[len(mad_list) // 2 - 1] + mad_list[len(mad_list) // 2])
        if abs(x[i] - med) > n_sigma * 1.4826 * mad:
            out[i] = med
    return out


def smooth_mean(x, half_window):
    """Centred moving mean of the finite window values; a None centre
    stays None (smoothing never fabricates samples)."""
    out = []
    n = len(x)
    for i in range(n):
        if x[i] is None:
            out.append(None)
            continue
        w = [x[j] for j in range(max(0, i - half_window), min(n, i + half_window + 1))
             if x[j] is not None]
        out.append(sum(w) / len(w))
    return out


def smooth_median(x, half_window):
    """Centred moving median; a None centre stays None."""
    out = []
    n = len(x)
    for i in range(n):
        if x[i] is None:
            out.append(None)
            continue
        w = sorted(x[j] for j in range(max(0, i - half_window), min(n, i + half_window + 1))
                   if x[j] is not None)
        m = w[len(w) // 2] if len(w) % 2 else 0.5 * (w[len(w) // 2 - 1] + w[len(w) // 2])
        out.append(m)
    return out


def depth_shift_block(depth, x, shift_m):
    """Constant block shift: the shifted curve at depth z reads the
    original at z - shift through _read_at (gaps never bridged)."""
    return [_read_at(depth, x, z - shift_m) for z in depth]


def _read_at(depth, x, zq):
    """Bracketing linear interpolation of x at zq; None outside the
    extent or beside a None (gaps never bridged)."""
    n = len(depth)
    if zq < depth[0] or zq > depth[n - 1]:
        return None
    lo, hi = 0, n - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if depth[mid] <= zq:
            lo = mid
        else:
            hi = mid
    # a read exactly on a sample is that sample (PT11c: the identity warp
    # returns the input byte for byte); only a read BETWEEN samples needs
    # both brackets finite
    if zq == depth[lo]:
        return x[lo]
    if zq == depth[hi]:
        return x[hi]
    if x[lo] is None or x[hi] is None:
        return None
    t = (zq - depth[lo]) / (depth[hi] - depth[lo])
    return x[lo] + t * (x[hi] - x[lo])


def tie_point_warp(pairs):
    """PT11c: warp(z) through [ref, target] pairs sorted by ref: piecewise
    linear between ties, z + (target_outer - ref_outer) beyond them.
    Returns (warp, error): error names crossing or duplicate ties."""
    sorted_pairs = sorted((float(r), float(t)) for r, t in pairs)
    for (r0, t0), (r1, t1) in zip(sorted_pairs, sorted_pairs[1:]):
        if r1 == r0:
            return None, "duplicate reference depth"
        if not t1 > t0:
            return None, "ties cross"
    m = len(sorted_pairs)

    def warp(z):
        if m == 0:
            return z
        if m == 1 or z <= sorted_pairs[0][0]:
            return z + (sorted_pairs[0][1] - sorted_pairs[0][0])
        if z >= sorted_pairs[-1][0]:
            return z + (sorted_pairs[-1][1] - sorted_pairs[-1][0])
        lo, hi = 0, m - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if sorted_pairs[mid][0] <= z:
                lo = mid
            else:
                hi = mid
        r0, t0 = sorted_pairs[lo]
        r1, t1 = sorted_pairs[hi]
        return t0 + (z - r0) / (r1 - r0) * (t1 - t0)
    return warp, None


def depth_shift_tie_points(depth, x, pairs):
    warp, err = tie_point_warp(pairs)
    if err:
        raise ValueError(err)
    return [_read_at(depth, x, warp(z)) for z in depth]


def shift_curve(depth, pairs):
    warp, err = tie_point_warp(pairs)
    if err:
        raise ValueError(err)
    return [z - warp(z) for z in depth]


def bad_hole_flag(cali, bit_size, drho, washout_over, drho_max):
    """Per-sample bad-hole flag: caliper reads more than washout_over
    over bit size (same units as the caliper curve), OR |DRHO| exceeds
    drho_max (g/cc). A missing curve skips its criterion; a sample
    with both inputs missing is not flagged."""
    n = len(cali) if cali is not None else len(drho)
    out = []
    for i in range(n):
        f = False
        if cali is not None and cali[i] is not None and cali[i] - bit_size > washout_over:
            f = True
        if drho is not None and drho[i] is not None and abs(drho[i]) > drho_max:
            f = True
        out.append(1 if f else 0)
    return out


def apply_bad_hole(x, flags, mode, max_gap_samples):
    """Null or bridge flagged samples. 'null' -> None. 'interp' ->
    linear bridge across flagged runs of length <= max_gap_samples
    with finite neighbours on both sides; longer or unbounded runs
    -> None (a visible cap, never silent fabrication)."""
    n = len(x)
    out = list(x)
    i = 0
    while i < n:
        if not flags[i]:
            i += 1
            continue
        j = i
        while j < n and flags[j]:
            j += 1
        run = j - i
        lo = i - 1
        hi = j
        can_bridge = (mode == "interp" and run <= max_gap_samples
                      and lo >= 0 and hi < n
                      and x[lo] is not None and x[hi] is not None)
        for k in range(i, j):
            if can_bridge:
                t = (k - lo) / (hi - lo)
                out[k] = x[lo] + t * (x[hi] - x[lo])
            else:
                out[k] = None
        i = j
    return out


# ---- Permeability + BVW (PS6) ---------------------------------------------
# Constants are pinned to ONE cited form each (fraction inputs, mD out)
# because every published "Timur" differs by unit convention:
#   Timur (1968, SPWLA 9th): k = 0.136*phi%^4.4/Swi%^2  ->  fractions:
#     k = 8581*phi^4.4/Swirr^2
#   Tixier (1949): k^0.5 = 250*phi^3/Swirr  ->  k = 62500*phi^6/Swirr^2
#   Coates & Denoo (1981): k^0.5 = c*phi^2*(1-Swirr)/Swirr, c = 100
#   Wyllie & Rose (1950) generalized k^0.5 = c*phi^q/Swirr with the
#     Morris & Biggs (1967) presets c = 250 (oil), 79 (gas), q = 3


def k_timur(phi, swirr):
    if phi is None or swirr is None or phi <= 0.0 or swirr <= 0.0:
        return None
    return 8581.0 * phi ** 4.4 / swirr ** 2


def k_tixier(phi, swirr):
    if phi is None or swirr is None or phi <= 0.0 or swirr <= 0.0:
        return None
    return (250.0 * phi ** 3 / swirr) ** 2


def k_coates(phi, swirr, c=100.0):
    if phi is None or swirr is None or phi <= 0.0 or swirr <= 0.0 or swirr > 1.0:
        return None
    return (c * phi ** 2 * (1.0 - swirr) / swirr) ** 2


def k_wyllie_rose(phi, swirr, c, q):
    if phi is None or swirr is None or phi <= 0.0 or swirr <= 0.0:
        return None
    return (c * phi ** q / swirr) ** 2


def bvw(phi, sw):
    """Bulk volume water phi*Sw (Buckles 1965 diagnostic)."""
    if phi is None or sw is None:
        return None
    return phi * sw


def swirr_from_buckles(phi, buckles_const):
    """Swirr from the constant-BVW rule, CLAMPED to 1 (an over-unity
    Swirr means the rock is at or past irreducible everywhere; the
    perm correlations need a physical saturation)."""
    if phi is None or phi <= 0.0:
        return None
    return min(1.0, buckles_const / phi)


def k_geom_mean(ks, flags, thickness):
    """Thickness-weighted geometric mean of k over flagged pay samples
    (None when no valid pay sample carries a positive k)."""
    s = 0.0
    w = 0.0
    for k, f, th in zip(ks, flags, thickness):
        if not f or k is None or k <= 0.0:
            continue
        s += math.log(k) * th
        w += th
    return math.exp(s / w) if w > 0.0 else None


# ---- Cutoffs / net pay ----------------------------------------------------


def sample_thickness(depth):
    """Per-sample interval thickness by midpoint split — exact for
    regular sampling, correct for irregular (the depth vector is data,
    the G1 lesson). Endpoints take their single half-interval plus
    half of itself (i.e. the conventional edge extension)."""
    n = len(depth)
    if n == 1:
        return [0.0]
    th = []
    for i in range(n):
        lo = depth[i] - (depth[i] - depth[i - 1]) / 2.0 if i > 0 else depth[0] - (depth[1] - depth[0]) / 2.0
        hi = depth[i] + (depth[i + 1] - depth[i]) / 2.0 if i < n - 1 else depth[n - 1] + (depth[n - 1] - depth[n - 2]) / 2.0
        th.append(hi - lo)
    return th


def net_pay(depth, phi, vsh, sw, cut_phi, cut_vsh, cut_sw, top=None, base=None):
    """Cutoff flags + zone summary over [top, base] (inclusive of any
    sample whose depth lies in the window; None = whole log).
    Flag: phi >= cut_phi AND vsh <= cut_vsh AND sw <= cut_sw; samples
    with any None input are NOT pay and NOT gross-average inputs.
    Returns dict: gross_m, net_m, ntg, and net-weighted phi/vsh/sw
    averages (None when net = 0)."""
    th = sample_thickness(depth)
    gross = net = 0.0
    sphi = svsh = ssw = 0.0
    flags = []
    for i, d in enumerate(depth):
        inside = (top is None or d >= top) and (base is None or d <= base)
        if not inside:
            flags.append(None)
            continue
        gross += th[i]
        valid = phi[i] is not None and vsh[i] is not None and sw[i] is not None
        f = bool(valid and phi[i] >= cut_phi and vsh[i] <= cut_vsh and sw[i] <= cut_sw)
        flags.append(f)
        if f:
            net += th[i]
            sphi += phi[i] * th[i]
            svsh += vsh[i] * th[i]
            ssw += sw[i] * th[i]
    out = {
        "gross_m": gross,
        "net_m": net,
        "ntg": (net / gross) if gross > 0 else None,
        "phi_avg": (sphi / net) if net > 0 else None,
        "vsh_avg": (svsh / net) if net > 0 else None,
        "sw_avg": (ssw / net) if net > 0 else None,
    }
    return flags, out


# ---- probabilistic (PT10c) ------------------------------------------------
# Lognormal quantile by moment matching (Aitchison & Brown 1957, "The
# Lognormal Distribution", ch. 2): for a lognormal with arithmetic mean m
# and standard deviation s, mu = ln(m^2 / sqrt(m^2 + s^2)) and
# sigma = sqrt(ln(1 + s^2 / m^2)); the q-quantile is exp(mu + sigma * z_q)
# with z_q the standard-normal quantile (statistics.NormalDist, stdlib).
# Because Archie's Sw is monotone increasing in Rw, the q-quantile of Sw
# under an uncertain Rw is sw_archie at the q-quantile of Rw: an EXACT
# reference for a Monte Carlo engine, no sampling needed.
def lognormal_quantile(mean, sd, q):
    from statistics import NormalDist
    m2 = mean * mean
    s2 = sd * sd
    mu = math.log(m2 / math.sqrt(m2 + s2))
    sigma = math.sqrt(math.log(1.0 + s2 / m2))
    return math.exp(mu + sigma * NormalDist().inv_cdf(q))
