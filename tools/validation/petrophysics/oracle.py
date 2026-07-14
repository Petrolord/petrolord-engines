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
    """Quicklook SP chain: SSP = -K*log10(Rmfe/Rwe)  =>
    Rwe = Rmfe * 10^(SSP/K).
    v1 SCOPE NOTE (plan Q4): Rmfe ~= Rmf and Rw ~= Rwe are the
    documented quicklook approximations (valid for moderately saline,
    predominantly NaCl waters). The full Rmf->Rmfe and Rwe->Rw
    conversions (Bateman & Konen 1977) land only with a
    page-referenced source in hand — coefficients were not verifiable
    from open sources on 2026-07-13 and will not be guessed."""
    if ssp_mv is None:
        return None
    return rmfe * 10.0 ** (ssp_mv / sp_k(temp_f))


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
