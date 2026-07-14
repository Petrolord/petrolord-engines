"""Pore-pressure oracle (PP P0) — INDEPENDENT reference implementation.

Reference for the Pore Pressure Studio engine (G7 follow-on,
docs/scope/PorePressure-PLAN.md). Every formula is written from its
published definition; the JS engine (P1) is written against the
committed goldens, never against this file's code.

  - Hydrostatic: P_h(z) = rho_sw * g * WD + rho_fl * g * z, z metres
    below mudline, WD water depth — seawater column above the mudline,
    pore fluid below (so P_h(0) = S(0) exactly at the mudline).
  - Overburden: S(z) = rho_sw * g * WD + integral rho_b(z') g dz',
    trapezoidal on the sampled density profile (mudline density value
    extends any gap at the top of the log).
  - Gardner (1974): rho[g/cc] = a * V^b, V in m/s with the metric
    coefficient a = 0.31, b = 0.25 (the classic 0.23 pairs with ft/s).
  - Normal compaction trend (e.g. Zhang 2011 review, eq. for
    transit time): dt_n(z) = dt_ma + (dt_ml - dt_ma) * exp(-c z).
    Fitting is exact on the log-transform: ln(dt - dt_ma) is linear in
    z, so ordinary least squares recovers (dt_ml, c) — deterministic,
    no iteration.
  - Eaton (1975): PP = S - (S - P_h) * (dt_n / dt)^n  (sonic form,
    n = 3 default); velocity form uses (V / V_n)^n.
  - Bowers (1995): loading V = V_ml + A * sigma'^B with the PUBLISHED
    parameter domain — V in ft/s, sigma' in psi, V_ml = 5000 ft/s
    default. The oracle takes SI velocity, converts to ft/s, inverts
    sigma' = ((V - V_ml)/A)^(1/B) in psi, returns Pa. Unloading:
    V = V_ml + A * (sigma_max * (sigma'/sigma_max)^(1/U))^B, inverted
    the same way; at sigma' = sigma_max it coincides with loading.
  - Fracture gradient, Eaton form: FG = K * (S - PP) + PP with
    K = nu / (1 - nu) (Matthews-Kelly is the same identity with an
    empirical K(z), so one coefficient-form function serves both).

Shared spec constants (the P1 JS engine MUST use identical values):
  G_ACCEL   = 9.80665  m/s2
  M_PER_FT  = 0.3048
  PA_PER_PSI = 6894.757293168361
Internal units are SI throughout (Pa, m, m/s, kg/m3, s/m for slowness
handled as us/m at the API edge like the LAS registry does).
"""

G_ACCEL = 9.80665
M_PER_FT = 0.3048
PA_PER_PSI = 6894.757293168361


# ---------------------------------------------------------------- pressures

def hydrostatic(z_bml, water_depth, rho_fluid, rho_seawater):
    """Pore-fluid hydrostatic pressure [Pa] at z_bml metres below
    mudline: seawater column above the mudline, pore fluid below."""
    if z_bml < 0:
        raise ValueError("z_bml must be >= 0")
    return G_ACCEL * (rho_seawater * water_depth + rho_fluid * z_bml)


def overburden(zs, rhos, water_depth, rho_seawater):
    """Overburden stress S [Pa] at each sample of the density profile.

    zs: strictly increasing depths below mudline [m], zs[0] may be > 0
    (the first density value extends to the mudline). rhos: bulk
    density [kg/m3]. Trapezoidal integration."""
    if len(zs) != len(rhos) or len(zs) == 0:
        raise ValueError("zs/rhos mismatch")
    out = []
    s = rho_seawater * G_ACCEL * water_depth
    prev_z, prev_rho = 0.0, rhos[0]
    for z, rho in zip(zs, rhos):
        if z < prev_z:
            raise ValueError("zs must be non-decreasing")
        s += 0.5 * (rho + prev_rho) * G_ACCEL * (z - prev_z)
        out.append(s)
        prev_z, prev_rho = z, rho
    return out


# ------------------------------------------------------------------ gardner

def gardner_rho(v, a=0.31, b=0.25):
    """Bulk density [kg/m3] from velocity [m/s], metric Gardner."""
    if v <= 0:
        raise ValueError("velocity must be > 0")
    return 1000.0 * a * v ** b


def gardner_v(rho, a=0.31, b=0.25):
    """Velocity [m/s] from bulk density [kg/m3] (Gardner inverted)."""
    if rho <= 0:
        raise ValueError("density must be > 0")
    return (rho / 1000.0 / a) ** (1.0 / b)


# ---------------------------------------------------------------------- nct

def nct_dt(z, dt_ml, dt_ma, c):
    """Normal-compaction transit time [us/m] at depth z below mudline."""
    from math import exp
    return dt_ma + (dt_ml - dt_ma) * exp(-c * z)


def fit_nct(zs, dts, dt_ma):
    """Fit (dt_ml, c) of the NCT by exact least squares on
    ln(dt - dt_ma) vs z. Every dt must exceed dt_ma."""
    from math import exp, log
    if len(zs) != len(dts) or len(zs) < 2:
        raise ValueError("need >= 2 picks")
    ys = []
    for dt in dts:
        if dt <= dt_ma:
            raise ValueError("pick at or below matrix transit time")
        ys.append(log(dt - dt_ma))
    n = float(len(zs))
    sz = sum(zs); sy = sum(ys)
    szz = sum(z * z for z in zs); szy = sum(z * y for z, y in zip(zs, ys))
    denom = n * szz - sz * sz
    if denom == 0:
        raise ValueError("degenerate picks (single depth)")
    slope = (n * szy - sz * sy) / denom
    intercept = (sy - slope * sz) / n
    return {"dt_ml": dt_ma + exp(intercept), "c": -slope}


# -------------------------------------------------------------------- eaton

def eaton(S, P_h, ratio, n=3.0):
    """Eaton pore pressure [Pa]. ratio = dt_n/dt (sonic) or V/V_n
    (velocity) — both < 1 in overpressure."""
    if ratio <= 0:
        raise ValueError("ratio must be > 0")
    return S - (S - P_h) * ratio ** n


# ------------------------------------------------------------------- bowers

def bowers_v_loading(sigma_pa, A, B, v_ml_fts=5000.0):
    """Bowers loading-curve velocity [m/s] from effective stress [Pa]."""
    if sigma_pa < 0:
        raise ValueError("effective stress must be >= 0")
    v_fts = v_ml_fts + A * (sigma_pa / PA_PER_PSI) ** B
    return v_fts * M_PER_FT


def bowers_sigma_loading(v_ms, A, B, v_ml_fts=5000.0):
    """Effective stress [Pa] from velocity [m/s], Bowers loading."""
    v_fts = v_ms / M_PER_FT
    if v_fts <= v_ml_fts:
        raise ValueError("velocity at or below mudline velocity")
    return ((v_fts - v_ml_fts) / A) ** (1.0 / B) * PA_PER_PSI


def bowers_v_unloading(sigma_pa, sigma_max_pa, A, B, U, v_ml_fts=5000.0):
    """Bowers unloading-curve velocity [m/s]; sigma_max is the maximum
    effective stress reached before unloading. U >= 1; U = 1 reduces to
    the loading curve."""
    if not (0 <= sigma_pa <= sigma_max_pa):
        raise ValueError("need 0 <= sigma <= sigma_max")
    if U < 1:
        raise ValueError("U must be >= 1")
    smax_psi = sigma_max_pa / PA_PER_PSI
    s_psi = sigma_pa / PA_PER_PSI
    v_fts = v_ml_fts + A * (smax_psi * (s_psi / smax_psi) ** (1.0 / U)) ** B
    return v_fts * M_PER_FT


def bowers_sigma_unloading(v_ms, sigma_max_pa, A, B, U, v_ml_fts=5000.0):
    """Effective stress [Pa] from velocity [m/s], Bowers unloading."""
    smax_psi = sigma_max_pa / PA_PER_PSI
    v_fts = v_ms / M_PER_FT
    if v_fts <= v_ml_fts:
        raise ValueError("velocity at or below mudline velocity")
    inner = ((v_fts - v_ml_fts) / A) ** (1.0 / B) / smax_psi
    return smax_psi * inner ** U * PA_PER_PSI


# ---------------------------------------------------------- fracture gradient

def frac_pressure(S, PP, K):
    """Fracture pressure [Pa], coefficient form: FG = K(S - PP) + PP.
    Eaton: K = nu/(1-nu); Matthews-Kelly: K = Ko(z)."""
    if K < 0:
        raise ValueError("K must be >= 0")
    return K * (S - PP) + PP


def eaton_K(nu):
    if not (0 <= nu < 0.5):
        raise ValueError("nu must be in [0, 0.5)")
    return nu / (1.0 - nu)
