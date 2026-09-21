"""Independent oracle for the Fluid Systems Studio PR78 engine (FS2).

Python stdlib only (repo convention, see tools/validation/welltest).
Every quantity is computed by a route independent of the JavaScript
implementation wherever the mathematics allows:

- Compressibility roots by bracketed bisection between the analytic
  extrema of the cubic (the JS engine uses Cardano + Newton polish).
- ln(phi_i) by numerical quadrature of the residual-Helmholtz integral
      ln phi_i = (1/RT) int_V^inf [dP/dn_i - RT/V'] dV'  -  ln Z
  with dP/dn_i differentiated from the pressure-explicit mole-number
  form of PR (the JS engine uses the packaged closed-form expression,
  so agreement cross-validates the algebra end to end).
- Pure-component saturation pressure by the Maxwell equal-area
  construction, bisected inside the spinodal window (the JS engine uses
  fugacity-equality successive substitution).

Component constants are loaded from the committed, source-cited table
test-data/fluid/componentReference.json - a single
transcription shared by both sides. Run genfixtures.py (same directory)
to regenerate the committed goldens.

Units: psia, degR, lb-mol, ft3 (matches engines/fluid/units.js).
"""

from __future__ import annotations

import json
import math
import os

R = 10.7316  # psia ft3 / (lb-mol degR)
OMEGA_A = 0.457235529
OMEGA_B = 0.077796074
SQRT2 = math.sqrt(2.0)
D1 = 1.0 + SQRT2
D2 = 1.0 - SQRT2

_HERE = os.path.dirname(os.path.abspath(__file__))
_REF_PATH = os.path.join(
    _HERE, "..", "..", "..",
    "test-data", "fluid", "componentReference.json",
)

with open(_REF_PATH, encoding="utf-8") as fh:
    COMPONENTS = json.load(fh)["components"]


# ---------------------------------------------------------------------------
# pure-component and mixture parameters

def kappa(omega: float) -> float:
    if omega > 0.491:
        return 0.379642 + omega * (1.48503 + omega * (-0.164423 + omega * 0.016666))
    return 0.37464 + omega * (1.54226 - omega * 0.26992)


def pure_ab(comp: dict, t_r: float) -> tuple[float, float]:
    tr = t_r / comp["tcR"]
    alpha_sqrt = 1.0 + kappa(comp["omega"]) * (1.0 - math.sqrt(tr))
    rtc = R * comp["tcR"]
    a = OMEGA_A * rtc * rtc * alpha_sqrt * alpha_sqrt / comp["pcPsia"]
    b = OMEGA_B * rtc / comp["pcPsia"]
    return a, b


def mix_params(comps: list[dict], bip: list[list[float]], x: list[float], t_r: float):
    """Return (aij matrix, bi list, a_mix, b_mix)."""
    n = len(comps)
    ab = [pure_ab(c, t_r) for c in comps]
    aij = [
        [math.sqrt(ab[i][0] * ab[j][0]) * (1.0 - bip[i][j]) for j in range(n)]
        for i in range(n)
    ]
    a_mix = sum(x[i] * x[j] * aij[i][j] for i in range(n) for j in range(n))
    b_mix = sum(x[i] * ab[i][1] for i in range(n))
    return aij, [ab[i][1] for i in range(n)], a_mix, b_mix


def pressure(a: float, b: float, t_r: float, v: float) -> float:
    """PR pressure, per-mole form (v = molar volume)."""
    return R * t_r / (v - b) - a / (v * v + 2.0 * b * v - b * b)


# ---------------------------------------------------------------------------
# cubic in Z by bracketed bisection (independent of Cardano)

def _cubic(z: float, big_a: float, big_b: float) -> float:
    c2 = -(1.0 - big_b)
    c1 = big_a - 3.0 * big_b * big_b - 2.0 * big_b
    c0 = -(big_a * big_b - big_b * big_b - big_b ** 3)
    return ((z + c2) * z + c1) * z + c0


def _bisect(f, lo: float, hi: float, iters: int = 200) -> float:
    flo = f(lo)
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if fm == 0.0:
            return mid
        if (flo < 0.0) == (fm < 0.0):
            lo, flo = mid, fm
        else:
            hi = mid
    return 0.5 * (lo + hi)


def z_roots(big_a: float, big_b: float) -> list[float]:
    """All real roots of the PR cubic, ascending."""
    c2 = -(1.0 - big_b)
    c1 = big_a - 3.0 * big_b * big_b - 2.0 * big_b
    f = lambda z: _cubic(z, big_a, big_b)  # noqa: E731

    # stationary points of the cubic: 3z^2 + 2 c2 z + c1 = 0
    disc = c2 * c2 - 3.0 * c1
    lo_bound, hi_bound = -2.0, max(10.0, 2.0 + big_b + big_a)
    if disc <= 0.0:  # monotonic: exactly one real root
        return [_bisect(f, lo_bound, hi_bound)]
    s = math.sqrt(disc)
    e1, e2 = (-c2 - s) / 3.0, (-c2 + s) / 3.0
    roots: list[float] = []
    for lo, hi in ((lo_bound, e1), (e1, e2), (e2, hi_bound)):
        if f(lo) == 0.0:
            roots.append(lo)
        elif (f(lo) < 0.0) != (f(hi) < 0.0):
            roots.append(_bisect(f, lo, hi))
    return sorted(set(roots))


# ---------------------------------------------------------------------------
# ln(phi) by residual-Helmholtz quadrature

def ln_phi_numeric(
    comps: list[dict], bip: list[list[float]], x: list[float],
    t_r: float, p_psia: float, z_factor: float, n_panels: int = 4000,
) -> list[float]:
    """ln phi_i = (1/RT) int_V^inf [dP/dn_i - RT/V'] dV' - ln Z, at n = 1 mol.

    dP/dn_i comes from the mole-number form
        P = n R T/(V - Nb) - Na/(V^2 + 2 Nb V - Nb^2),
    Na = sum n_i n_j a_ij, Nb = sum n_i b_i, evaluated at n = 1 so V is the
    molar volume. Substituting u = 1/V' turns the tail integral into a
    smooth finite-interval integrand handled with composite Simpson and
    one Richardson halving step.
    """
    n = len(comps)
    aij, bi, a_mix, b_mix = mix_params(comps, bip, x, t_r)
    s_i = [sum(x[j] * aij[i][j] for j in range(n)) for i in range(n)]
    rt = R * t_r
    v_phase = z_factor * rt / p_psia

    def integrand(u: float) -> list[float]:
        # returns [dP/dn_i - RT/V] / RT * V^2  (the du integrand), V = 1/u
        if u <= 0.0:
            # V -> inf: dP/dn_i - RT/V -> (RT b_mix + RT b_i - 2 S_i)/V^2,
            # so the du-integrand limit is b_mix + b_i - 2 S_i/RT
            return [b_mix + bi[i] - 2.0 * s_i[i] / rt for i in range(n)]
        v = 1.0 / u
        vmb = v - b_mix
        den = v * v + 2.0 * b_mix * v - b_mix * b_mix
        common1 = rt / vmb
        common2 = rt / (vmb * vmb)
        dden_db = 2.0 * v - 2.0 * b_mix
        out = []
        for i in range(n):
            dp_dni = (
                common1
                + common2 * bi[i]
                - (2.0 * s_i[i] * den - a_mix * dden_db * bi[i]) / (den * den)
            )
            out.append((dp_dni - rt / v) * v * v / rt)
        return out

    def simpson(n_iv: int) -> list[float]:
        if n_iv % 2:
            n_iv += 1
        h = (1.0 / v_phase) / n_iv
        total = [0.0] * n
        f0 = integrand(0.0)
        fn = integrand(1.0 / v_phase)
        for i in range(n):
            total[i] = f0[i] + fn[i]
        for k in range(1, n_iv):
            w = 4.0 if k % 2 else 2.0
            fk = integrand(k * h)
            for i in range(n):
                total[i] += w * fk[i]
        return [t * h / 3.0 for t in total]

    coarse = simpson(n_panels)
    fine = simpson(2 * n_panels)
    integral = [(16.0 * fine[i] - coarse[i]) / 15.0 for i in range(n)]
    ln_z = math.log(z_factor)
    return [integral[i] - ln_z for i in range(n)]


def phase_state(
    comps: list[dict], bip: list[list[float]], x: list[float],
    t_r: float, p_psia: float,
) -> dict:
    """Chosen-root phase state with oracle root selection (lowest Gibbs)."""
    n = len(comps)
    _, bi, a_mix, b_mix = mix_params(comps, bip, x, t_r)
    rt = R * t_r
    big_a = a_mix * p_psia / (rt * rt)
    big_b = b_mix * p_psia / rt
    roots = z_roots(big_a, big_b)
    physical = [z for z in roots if z > big_b]
    if not physical:
        physical = [roots[-1]]
    if len(physical) == 1:
        z = physical[0]
        ln_phi = ln_phi_numeric(comps, bip, x, t_r, p_psia, z)
    else:
        cands = [physical[0], physical[-1]]
        phis = [ln_phi_numeric(comps, bip, x, t_r, p_psia, z) for z in cands]
        gibbs = [sum(x[i] * lp[i] for i in range(n)) for lp in phis]
        pick = 0 if gibbs[0] <= gibbs[1] else 1
        z, ln_phi = cands[pick], phis[pick]

    c_shift = sum(x[i] * comps[i].get("shift", 0.0) * bi[i] for i in range(n))
    mw = sum(x[i] * comps[i]["mw"] for i in range(n))
    v_eos = z * rt / p_psia
    v_corr = v_eos - c_shift
    return {
        "roots": roots,
        "z": z,
        "lnPhi": ln_phi,
        "molarVolume": v_corr,
        "density": mw / v_corr,
    }


# ---------------------------------------------------------------------------
# pure-component Psat by Maxwell equal-area construction

def _pressure_extrema(a: float, b: float, t_r: float):
    """(P_at_local_min, P_at_local_max) of the subcritical isotherm P(V)."""
    dp = lambda v: (  # noqa: E731
        -R * t_r / (v - b) ** 2
        + a * (2.0 * v + 2.0 * b) / (v * v + 2.0 * b * v - b * b) ** 2
    )
    vs = [b * (1.0 + 1e-9) * math.exp(k * math.log(1e9) / 20000.0) for k in range(20001)]
    crossings = []
    for v0, v1 in zip(vs, vs[1:]):
        if (dp(v0) < 0.0) != (dp(v1) < 0.0):
            crossings.append(_bisect(dp, v0, v1))
    if len(crossings) < 2:
        return None
    p_vals = [pressure(a, b, t_r, v) for v in crossings]
    return min(p_vals), max(p_vals)


def pure_psat_maxwell(comp: dict, t_r: float) -> float | None:
    """Saturation pressure from equal areas: int_VL^VV P dV = Psat (VV - VL).

    The indefinite integral of PR pressure is analytic (partial fractions on
    V^2 + 2bV - b^2 = (V + D2 b)(V + D1 b)):
        int P dV = RT ln(V - b) - a/(2 sqrt2 b) ln[(V + D2 b)/(V + D1 b)].
    Bisection on the area residual inside the spinodal window.
    """
    if t_r >= comp["tcR"]:
        return None
    a, b = pure_ab(comp, t_r)
    ext = _pressure_extrema(a, b, t_r)
    if ext is None:
        return None
    p_lo = max(ext[0], 1e-10) * (1.0 + 1e-9)
    p_hi = ext[1] * (1.0 - 1e-9)
    if p_hi <= p_lo:
        return None

    def antideriv(v: float) -> float:
        return R * t_r * math.log(v - b) - a / (2.0 * SQRT2 * b) * math.log(
            (v + D2 * b) / (v + D1 * b)
        )

    def area_residual(p: float) -> float:
        rt = R * t_r
        big_a = a * p / (rt * rt)
        big_b = b * p / rt
        zs = [z for z in z_roots(big_a, big_b) if z > big_b]
        v_l = zs[0] * rt / p
        v_v = zs[-1] * rt / p
        return antideriv(v_v) - antideriv(v_l) - p * (v_v - v_l)

    f_lo = area_residual(p_lo)
    f_hi = area_residual(p_hi)
    if (f_lo < 0.0) == (f_hi < 0.0):
        return None
    return _bisect(area_residual, p_lo, p_hi)


# ---------------------------------------------------------------------------
# FS3: stability + two-phase PT flash by plain successive substitution
# (no GDEM, unlike the JS engine; Rachford-Rice by pure bisection, unlike
# the engine's safeguarded Newton). Converged states are sealed with the
# quadrature ln(phi) route via flash_verify().

def ln_phi_closed(comps, bip, x, t_r, p_psia):
    """(z, lnPhi) at the lowest-Gibbs root using the closed-form expression.

    An independent transcription of Monograph 20 eq. 4.28 used only to
    drive the oracle's flash iterations; final states are re-checked
    against ln_phi_numeric by flash_verify().
    """
    n = len(comps)
    aij, bi, a, b = mix_params(comps, bip, x, t_r)
    s_i = [sum(x[j] * aij[i][j] for j in range(n)) for i in range(n)]
    rt = R * t_r
    big_a = a * p_psia / (rt * rt)
    big_b = b * p_psia / rt

    def ln_phi_at(z):
        log_term = math.log((z + D1 * big_b) / (z + D2 * big_b))
        coeff = big_a / (2.0 * SQRT2 * big_b)
        out = []
        for i in range(n):
            br = bi[i] / b
            out.append(
                br * (z - 1.0) - math.log(z - big_b)
                - coeff * (2.0 * s_i[i] / a - br) * log_term
            )
        return out

    roots = [z for z in z_roots(big_a, big_b) if z > big_b]
    if not roots:
        roots = [z_roots(big_a, big_b)[-1]]
    if len(roots) == 1:
        z = roots[0]
        return z, ln_phi_at(z)
    cands = [roots[0], roots[-1]]
    phis = [ln_phi_at(z) for z in cands]
    gibbs = [sum(x[i] * lp[i] for i in range(n)) for lp in phis]
    pick = 0 if gibbs[0] <= gibbs[1] else 1
    return cands[pick], phis[pick]


def wilson_k(comps, t_r, p_psia):
    return [
        c["pcPsia"] / p_psia * math.exp(5.373 * (1.0 + c["omega"]) * (1.0 - c["tcR"] / t_r))
        for c in comps
    ]


def rr_bisect(z, K, iters=200):
    """Rachford-Rice by pure bisection on the negative-flash window."""
    k_max, k_min = max(K), min(K)
    if not (k_max > 1.0 and k_min < 1.0):
        return None

    def g(beta):
        return sum(zi * (ki - 1.0) / (1.0 + beta * (ki - 1.0)) for zi, ki in zip(z, K))

    lo = 1.0 / (1.0 - k_max) + 1e-12
    hi = 1.0 / (1.0 - k_min) - 1e-12
    if not (g(lo) > 0.0 > g(hi)):
        return None
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        if g(mid) > 0.0:
            lo = mid
        else:
            hi = mid
    beta = 0.5 * (lo + hi)
    x = [zi / (1.0 + beta * (ki - 1.0)) for zi, ki in zip(z, K)]
    y = [ki * xi for ki, xi in zip(K, x)]
    sx, sy = sum(x), sum(y)
    return beta, [v / sx for v in x], [v / sy for v in y]


def stability_plain(comps, bip, z, t_r, p_psia, tol=1e-13, max_iter=20000):
    """Two-sided Michelsen stability, plain SS. Returns (stable, k_suggest)."""
    _, ln_phi_z = ln_phi_closed(comps, bip, z, t_r, p_psia)
    h = [math.log(zi) + lp for zi, lp in zip(z, ln_phi_z)]
    kw = wilson_k(comps, t_r, p_psia)

    def trial(y0):
        ln_y = [math.log(v) for v in y0]
        for _ in range(max_iter):
            s = sum(math.exp(v) for v in ln_y)
            y = [math.exp(v) / s for v in ln_y]
            _, lp = ln_phi_closed(comps, bip, y, t_r, p_psia)
            ln_new = [h[i] - lp[i] for i in range(len(z))]
            r2 = sum((a - b) ** 2 for a, b in zip(ln_new, ln_y))
            ln_y = ln_new
            if r2 < tol:
                break
        s = sum(math.exp(v) for v in ln_y)
        trivial = sum((ln_y[i] - math.log(z[i])) ** 2 for i in range(len(z))) < 1e-8
        return s, trivial, [math.exp(v) / s for v in ln_y]

    results = []
    for y0 in ([zi * k for zi, k in zip(z, kw)], [zi / k for zi, k in zip(z, kw)]):
        results.append(trial(y0))
    unstable = [(s, y, idx) for idx, (s, triv, y) in enumerate(results)
                if not triv and s > 1.0 + 1e-8]
    if not unstable:
        return True, None
    s, y, idx = max(unstable)  # largest S = most negative tpd
    if idx == 0:  # vapor-like trial
        return False, [yi / zi for yi, zi in zip(y, z)]
    return False, [zi / yi for zi, yi in zip(z, y)]


def flash_plain(comps, bip, z, t_r, p_psia, tol=1e-22, max_iter=100000):
    """Stability-gated two-phase PT flash by plain SS. Returns a dict."""
    stable, k_sug = stability_plain(comps, bip, z, t_r, p_psia)
    if stable:
        return {"phases": 1}
    ln_k = [math.log(k) for k in (k_sug or wilson_k(comps, t_r, p_psia))]
    rr = None
    converged = False
    for _ in range(max_iter):
        rr = rr_bisect(z, [math.exp(v) for v in ln_k])
        if rr is None:
            break
        beta, x, y = rr
        _, lp_l = ln_phi_closed(comps, bip, x, t_r, p_psia)
        _, lp_v = ln_phi_closed(comps, bip, y, t_r, p_psia)
        ln_new = [lp_l[i] - lp_v[i] for i in range(len(z))]
        r2 = sum((a - b) ** 2 for a, b in zip(ln_new, ln_k))
        ln_k = ln_new
        if sum(v * v for v in ln_k) < 1e-10:
            rr = None
            break
        if r2 < tol:
            converged = True
            break
    if rr is None or not converged:
        return {"phases": 1}
    K = [math.exp(v) for v in ln_k]
    beta, x, y = rr_bisect(z, K)
    if not (0.0 < beta < 1.0):
        return {"phases": 1, "negativeFlashBeta": beta}
    st_l = phase_state(comps, bip, x, t_r, p_psia)
    st_v = phase_state(comps, bip, y, t_r, p_psia)
    return {
        "phases": 2, "beta": beta, "K": K, "x": x, "y": y,
        "zL": st_l["z"], "zV": st_v["z"],
        "rhoL": st_l["density"], "rhoV": st_v["density"],
    }


# ---------------------------------------------------------------------------
# FS4: C7+ characterization, stability-boundary bisection, LBC viscosity,
# Weinaug-Katz IFT. All correlation coefficients here are DELIBERATE second
# transcriptions from the published sources (Soreide 1989; Kesler-Lee 1976;
# Lee-Kesler omega; Edmister 1958; Jhaveri-Youngren SPE 13118; Lohrenz-
# Bray-Clark 1964 via SPE 109892; Firoozabadi et al. 1988; Chueh-Prausnitz
# 1967) so a typo on either side of the JS/Python fence fails the gates.

def soreide_tb(mw: float, sg: float) -> float:
    """Soreide (1989) normal boiling point, degR."""
    return 1928.3 - 1.695e5 * mw ** -0.03522 * sg ** 3.266 * math.exp(
        -4.922e-3 * mw - 4.7685 * sg + 3.462e-3 * mw * sg
    )


def kesler_lee_tc(tb: float, sg: float) -> float:
    return 341.7 + 811.0 * sg + (0.4244 + 0.1174 * sg) * tb + (0.4669 - 3.2623 * sg) * 1e5 / tb


def kesler_lee_pc(tb: float, sg: float) -> float:
    ln_pc = (
        8.3634 - 0.0566 / sg
        - (0.24244 + 2.2898 / sg + 0.11857 / sg ** 2) * 1e-3 * tb
        + (1.4685 + 3.648 / sg + 0.47227 / sg ** 2) * 1e-7 * tb ** 2
        - (0.42019 + 1.6977 / sg ** 2) * 1e-10 * tb ** 3
    )
    return math.exp(ln_pc)


def lee_kesler_omega(tb: float, tc: float, pc: float, sg: float) -> float:
    tbr = tb / tc
    if tbr > 0.8:
        kw = tb ** (1.0 / 3.0) / sg
        return (-7.904 + 0.1352 * kw - 0.007465 * kw ** 2 + 8.359 * tbr
                + (1.408 - 0.01063 * kw) / tbr)
    t6 = tbr ** 6
    num = (-math.log(pc / 14.696) - 5.92714 + 6.09648 / tbr
           + 1.28862 * math.log(tbr) - 0.169347 * t6)
    den = 15.2518 - 15.6875 / tbr - 13.4721 * math.log(tbr) + 0.43577 * t6
    return num / den


def edmister_omega(tb: float, tc: float, pc: float) -> float:
    return (3.0 / 7.0) * math.log10(pc / 14.696) / (tc / tb - 1.0) - 1.0


_JY = {"paraffin": (2.258, 0.1823), "naphthene": (3.004, 0.2324), "aromatic": (2.516, 0.2008)}


def jy_shift(mw: float, family: str = "paraffin") -> float:
    a0, a1 = _JY[family]
    return 1.0 - a0 / mw ** a1


def lbc_vc7(mw: float, sg: float) -> float:
    """LBC (1964) C7+ critical volume, ft3/lb-mol."""
    return 21.573 + 0.015122 * mw - 27.656 * sg + 0.070615 * mw * sg


def firoozabadi_parachor(mw: float) -> float:
    return -11.4 + 3.23 * mw - 0.0022 * mw ** 2


def chueh_prausnitz(vc_i: float, vc_j: float, a: float = 1.0, b: float = 1.0) -> float:
    ci, cj = vc_i ** (1.0 / 3.0), vc_j ** (1.0 / 3.0)
    return a * (1.0 - (2.0 * math.sqrt(ci * cj) / (ci + cj)) ** b)


def characterize(mw: float, sg: float, tb: float | None = None) -> dict:
    """Mirror of the engine's characterizePlusFraction (paraffin/Lee-Kesler)."""
    tb = tb if tb is not None else soreide_tb(mw, sg)
    tc = kesler_lee_tc(tb, sg)
    pc = kesler_lee_pc(tb, sg)
    vc = lbc_vc7(mw, sg)
    return {
        "mw": mw,
        "tbR": tb,
        "tcR": tc,
        "pcPsia": pc,
        "omega": lee_kesler_omega(tb, tc, pc, sg),
        "omegaEdmister": edmister_omega(tb, tc, pc),
        "vcFt3PerLbmol": vc,
        "parachor": firoozabadi_parachor(mw),
        "shift": jy_shift(mw),
        "bipC1": chueh_prausnitz(COMPONENTS["C1"]["vcFt3PerLbmol"], vc),
    }


def stability_boundaries(comps, bip, z, t_r, p_min=14.696, p_max=12000.0,
                         n_scan=40, tol=0.05):
    """Phase-boundary pressures by log-grid scan + bisection on the plain-SS
    stability flag; classification by a flash probed 1% inside (matches the
    engine's scheme so both sides locate the same flips)."""
    ln_lo, ln_hi = math.log(p_min), math.log(p_max)
    grid = [math.exp(ln_lo + (ln_hi - ln_lo) * i / (n_scan - 1)) for i in range(n_scan)]

    def unstable(p):
        stable, _ = stability_plain(comps, bip, z, t_r, p)
        return not stable

    flags = [unstable(p) for p in grid]
    out = []
    for i in range(1, n_scan):
        if flags[i] == flags[i - 1]:
            continue
        lo, hi, lo_u = grid[i - 1], grid[i], flags[i - 1]
        while hi - lo > tol:
            mid = 0.5 * (lo + hi)
            if unstable(mid) == lo_u:
                lo = mid
            else:
                hi = mid
        pb = 0.5 * (lo + hi)
        inset = max(5.0 * tol, 0.01 * pb)
        p_probe = max(p_min, pb - inset) if lo_u else pb + inset
        res = flash_plain(comps, bip, z, t_r, p_probe)
        kind = "indeterminate"
        if res["phases"] == 2:
            kind = "bubble" if res["beta"] < 0.5 else "dew"
        elif "negativeFlashBeta" in res:
            kind = "bubble" if res["negativeFlashBeta"] <= 0.0 else "dew"
        out.append({"pPsia": pb, "kind": kind, "twoPhaseSide": "below" if lo_u else "above"})
    return out


# ---- LBC viscosity + Weinaug-Katz IFT (field units per SPE 109892) --------

LBC_A = (0.1023, 0.023364, 0.058533, -0.040758, 0.0093324)
LBMOL_FT3_TO_GMOL_CM3 = 0.016018463


def xi_visc(tc: float, pc: float, mw: float) -> float:
    return 5.35 * (tc / (mw ** 3 * pc ** 4)) ** (1.0 / 6.0)


def dilute_component_visc(comp: dict, t_r: float) -> float:
    tr = t_r / comp["tcR"]
    xi = xi_visc(comp["tcR"], comp["pcPsia"], comp["mw"])
    if tr <= 1.5:
        return 34e-5 * tr ** 0.94 / xi
    return 17.78e-5 * (4.58 * tr - 1.67) ** 0.625 / xi


def lbc_viscosity(comps: list[dict], x: list[float], t_r: float, molar_volume: float) -> float:
    num = den = 0.0
    for xi_, c in zip(x, comps):
        w = xi_ * math.sqrt(c["mw"])
        num += w * dilute_component_visc(c, t_r)
        den += w
    mu0 = num / den
    tpc = sum(xi_ * c["tcR"] for xi_, c in zip(x, comps))
    ppc = sum(xi_ * c["pcPsia"] for xi_, c in zip(x, comps))
    vpc = sum(xi_ * c["vcFt3PerLbmol"] for xi_, c in zip(x, comps))
    mw = sum(xi_ * c["mw"] for xi_, c in zip(x, comps))
    rho_r = vpc / molar_volume
    a0, a1, a2, a3, a4 = LBC_A
    poly = a0 + rho_r * (a1 + rho_r * (a2 + rho_r * (a3 + rho_r * a4)))
    return mu0 + (poly ** 4 - 1e-4) / xi_visc(tpc, ppc, mw)


def weinaug_katz(comps, x, y, v_liq: float, v_vap: float) -> float:
    rho_l = LBMOL_FT3_TO_GMOL_CM3 / v_liq
    rho_v = LBMOL_FT3_TO_GMOL_CM3 / v_vap
    s = sum(c["parachor"] * (xi_ * rho_l - yi_ * rho_v)
            for c, xi_, yi_ in zip(comps, x, y))
    return max(s, 0.0) ** 4


def flash_verify(comps, bip, result, t_r, p_psia):
    """Seal a two-phase result with the quadrature ln(phi) route: return the
    worst relative fugacity mismatch max_i |x_i phiL_i - y_i phiV_i| / (x_i phiL_i)."""
    lp_l = ln_phi_numeric(comps, bip, result["x"], t_r, p_psia,
                          phase_state(comps, bip, result["x"], t_r, p_psia)["z"])
    lp_v = ln_phi_numeric(comps, bip, result["y"], t_r, p_psia,
                          phase_state(comps, bip, result["y"], t_r, p_psia)["z"])
    worst = 0.0
    for i in range(len(result["x"])):
        f_l = result["x"][i] * math.exp(lp_l[i])
        f_v = result["y"][i] * math.exp(lp_v[i])
        worst = max(worst, abs(f_l - f_v) / f_l)
    return worst


# ---------------------------------------------------------------------------
# FS6: compositional separator train (independent counterpart of
# engines/fluid/separator.js). Sequential flash_plain through
# the stage list, equilibrium vapor drawn off, liquid fed forward, stock
# tank (14.696 psia / 60 F) appended. Surface constants are deliberate
# second statements of the engine's (GPSA air MW, water at 60 F,
# ideal-gas sc molar volume from R above).

PSC = 14.696
TSC = 519.67
SCF_PER_LBMOL = R * TSC / PSC
MW_AIR = 28.9647
RHO_WATER_60F = 62.3664
FT3_PER_BBL = 5.614583


def _liquid_like(comps, bip, x, t_r, p_psia) -> bool:
    """v/b < 1.75 liquid-likeness heuristic (same convention as pr78.purePsat);
    only used to classify single-phase stage outcomes."""
    _, _, _, b_mix = mix_params(comps, bip, x, t_r)
    st = phase_state(comps, bip, x, t_r, p_psia)
    v_eos = st["z"] * R * t_r / p_psia
    return v_eos / b_mix < 1.75


def separator_train(comps, bip, z, stages, res_tp=None):
    """stages: [(t_r, p_psia)] sorted high->low pressure by the caller;
    a stock-tank stage is appended unless the last stage already is one.
    res_tp: optional (t_r, p_psia) reservoir state for the Bo block.
    Basis 1 lb-mol feed. Returns a plain dict for the goldens."""
    train = list(stages)
    if not train or train[-1][1] > PSC + 1e-6:
        train.append((TSC, PSC))

    rows = []
    feed_comp = list(z)
    feed_moles = 1.0
    for i, (t_r, p_psia) in enumerate(train):
        if feed_moles < 1e-12:
            rows.append({"tR": t_r, "pPsia": p_psia, "phases": 0,
                         "vaporMoles": 0.0, "liquidMoles": 0.0,
                         "x": None, "y": None, "gasGravity": None})
            continue
        res = flash_plain(comps, bip, feed_comp, t_r, p_psia)
        if res["phases"] == 2:
            beta, x, y = res["beta"], res["x"], res["y"]
            mw_v = sum(yi * c["mw"] for yi, c in zip(y, comps))
            rows.append({"tR": t_r, "pPsia": p_psia, "phases": 2, "beta": beta,
                         "vaporMoles": feed_moles * beta,
                         "liquidMoles": feed_moles * (1.0 - beta),
                         "x": x, "y": y, "K": res["K"],
                         "gasGravity": mw_v / MW_AIR})
            feed_comp, feed_moles = x, feed_moles * (1.0 - beta)
        else:
            is_liq = _liquid_like(comps, bip, feed_comp, t_r, p_psia)
            if "negativeFlashBeta" in res:
                is_liq = res["negativeFlashBeta"] <= 0.0
            mw_f = sum(zi * c["mw"] for zi, c in zip(feed_comp, comps))
            rows.append({"tR": t_r, "pPsia": p_psia, "phases": 1,
                         "vaporMoles": 0.0 if is_liq else feed_moles,
                         "liquidMoles": feed_moles if is_liq else 0.0,
                         "x": feed_comp if is_liq else None,
                         "y": None if is_liq else feed_comp,
                         "gasGravity": None if is_liq else mw_f / MW_AIR})
            if not is_liq:
                feed_moles = 0.0

    out = {"stages": rows, "stockTank": None, "totals": None, "bo": None}
    st_row = rows[-1]
    if st_row["liquidMoles"] >= 1e-12:
        st = phase_state(comps, bip, st_row["x"], TSC, PSC)
        sg = st["density"] / RHO_WATER_60F
        sto_ft3 = st_row["liquidMoles"] * st["molarVolume"]
        sto_bbl = sto_ft3 / FT3_PER_BBL
        mw_o = sum(xi * c["mw"] for xi, c in zip(st_row["x"], comps))
        sep_scf = sum(r["vaporMoles"] for r in rows[:-1]) * SCF_PER_LBMOL
        st_scf = st_row["vaporMoles"] * SCF_PER_LBMOL
        vap_moles = sum(r["vaporMoles"] for r in rows)
        vap_mass = sum(
            r["vaporMoles"] * sum(yi * c["mw"] for yi, c in zip(r["y"], comps))
            for r in rows if r["vaporMoles"] > 0.0)
        out["stockTank"] = {"moles": st_row["liquidMoles"], "density": st["density"],
                            "molarVolume": st["molarVolume"], "apparentMw": mw_o,
                            "sg": sg, "api": 141.5 / sg - 131.5}
        out["totals"] = {
            "separatorGor": sep_scf / sto_bbl,
            "stockTankGor": st_scf / sto_bbl,
            "totalGor": (sep_scf + st_scf) / sto_bbl,
            "surfaceGasGravity": (vap_mass / vap_moles / MW_AIR) if vap_moles > 1e-12 else None,
            "stoVolFt3PerFeedMol": sto_ft3,
        }

    if res_tp is not None:
        rt_r, rp = res_tp
        res_flash = flash_plain(comps, bip, z, rt_r, rp)
        if res_flash["phases"] == 2:
            out["bo"] = {"reservoirPhases": 2, "multistage": None, "singleStage": None}
        else:
            v_res = phase_state(comps, bip, z, rt_r, rp)["molarVolume"]
            bo = {"reservoirPhases": 1, "vResFt3PerFeedMol": v_res,
                  "multistage": None, "singleStage": None, "singleStageGor": None}
            if out["totals"]:
                bo["multistage"] = v_res / out["totals"]["stoVolFt3PerFeedMol"]
            single = flash_plain(comps, bip, z, TSC, PSC)
            if single["phases"] == 2 and single["beta"] < 1.0:
                stp = phase_state(comps, bip, single["x"], TSC, PSC)
                v1 = (1.0 - single["beta"]) * stp["molarVolume"]
                bo["singleStage"] = v_res / v1
                bo["singleStageGor"] = single["beta"] * SCF_PER_LBMOL / (v1 / FT3_PER_BBL)
            out["bo"] = bo
    return out


# ---------------------------------------------------------------------------
# FS7: CCE + differential liberation + composite black-oil table
# (independent counterparts of engines/fluid/experiments.js).
# All flashes go through flash_plain; volumes through phase_state. The Bg
# conversion is a deliberate second statement of the engine's rb/scf form.


def bg_rb_per_scf(z_gas: float, t_r: float, p_psia: float) -> float:
    return (z_gas * t_r / p_psia) * (PSC / TSC) / FT3_PER_BBL


def cce_expansion(comps, bip, z, t_r, psat, pressures):
    """Constant composition expansion rows on the given descending grid."""
    v_sat = phase_state(comps, bip, z, t_r, psat)["molarVolume"]
    rows = []
    for p in sorted(pressures, reverse=True):
        res = flash_plain(comps, bip, z, t_r, p)
        if res["phases"] == 2:
            v_l = (1.0 - res["beta"]) * phase_state(comps, bip, res["x"], t_r, p)["molarVolume"]
            v_v = res["beta"] * phase_state(comps, bip, res["y"], t_r, p)["molarVolume"]
            rows.append({"pPsia": p, "phases": 2, "beta": res["beta"],
                         "relVol": (v_l + v_v) / v_sat,
                         "liquidVolFrac": v_l / (v_l + v_v)})
        else:
            st = phase_state(comps, bip, z, t_r, p)
            rows.append({"pPsia": p, "phases": 1, "beta": None,
                         "relVol": st["molarVolume"] / v_sat,
                         "liquidVolFrac": None})
    return {"vSat": v_sat, "rows": rows}


def diff_lib(comps, bip, z, t_r, psat, pressures):
    """Differential liberation from psat down the given descending grid,
    with the 60 F / 14.696 psia cooldown defining the residual oil."""
    sat = phase_state(comps, bip, z, t_r, psat)
    stages = [{"pPsia": psat, "isSaturation": True, "oilMoles": 1.0, "x": list(z),
               "vOil": sat["molarVolume"], "vOilMolar": sat["molarVolume"],
               "oilDensity": sat["density"], "gasMolesRemoved": 0.0, "y": None,
               "gasZ": None, "vGasMolar": None, "gasGravity": None,
               "gasScf": 0.0, "bg": None}]
    comp = list(z)
    moles = 1.0
    for p in sorted(pressures, reverse=True):
        if p >= psat or moles < 1e-12:
            continue
        res = flash_plain(comps, bip, comp, t_r, p)
        if res["phases"] != 2:
            st = phase_state(comps, bip, comp, t_r, p)
            stages.append({"pPsia": p, "isSaturation": False, "oilMoles": moles,
                           "x": comp, "vOil": moles * st["molarVolume"],
                           "vOilMolar": st["molarVolume"], "oilDensity": st["density"],
                           "gasMolesRemoved": 0.0, "y": None, "gasZ": None,
                           "vGasMolar": None, "gasGravity": None, "gasScf": 0.0, "bg": None})
            continue
        st_l = phase_state(comps, bip, res["x"], t_r, p)
        st_v = phase_state(comps, bip, res["y"], t_r, p)
        gas_moles = moles * res["beta"]
        mw_gas = sum(yi * c["mw"] for yi, c in zip(res["y"], comps))
        stages.append({"pPsia": p, "isSaturation": False,
                       "oilMoles": moles * (1.0 - res["beta"]), "x": res["x"],
                       "vOil": moles * (1.0 - res["beta"]) * st_l["molarVolume"],
                       "vOilMolar": st_l["molarVolume"], "oilDensity": st_l["density"],
                       "gasMolesRemoved": gas_moles, "y": res["y"],
                       "gasZ": st_v["z"], "vGasMolar": st_v["molarVolume"],
                       "gasGravity": mw_gas / MW_AIR,
                       "gasScf": gas_moles * SCF_PER_LBMOL,
                       "bg": bg_rb_per_scf(st_v["z"], t_r, p)})
        comp = res["x"]
        moles *= (1.0 - res["beta"])

    cooldown_scf = 0.0
    residual = None
    if moles >= 1e-12:
        cool = flash_plain(comps, bip, comp, TSC, PSC)
        if cool["phases"] == 2:
            cooldown_scf = moles * cool["beta"] * SCF_PER_LBMOL
            st = phase_state(comps, bip, cool["x"], TSC, PSC)
            residual = {"moles": moles * (1.0 - cool["beta"]), "x": cool["x"],
                        "volFt3": moles * (1.0 - cool["beta"]) * st["molarVolume"],
                        "density": st["density"]}
        else:
            st = phase_state(comps, bip, comp, TSC, PSC)
            residual = {"moles": moles, "x": comp,
                        "volFt3": moles * st["molarVolume"], "density": st["density"]}

    if residual:
        below = cooldown_scf
        res_bbl = residual["volFt3"] / FT3_PER_BBL
        for st in reversed(stages):
            st["rsd"] = below / res_bbl
            st["bod"] = st["vOil"] / residual["volFt3"]
            below += st["gasScf"]

    totals = ({"bodb": stages[0]["bod"], "rsdb": stages[0]["rsd"]} if residual else None)
    return {"stages": stages, "residual": residual,
            "cooldownGasScf": cooldown_scf, "totals": totals}


def black_oil_table(comps, bip, z, t_r, sep_stages, psat, dl_pressures, undersat_pressures):
    """Separator-adjusted composite (Amyx): second transcription of the
    engine's arithmetic on this oracle's own DL + separator results."""
    dl = diff_lib(comps, bip, z, t_r, psat, dl_pressures)
    sep = separator_train(comps, bip, z, sep_stages)
    v_sat = dl["stages"][0]["vOil"]
    bofb = v_sat / sep["totals"]["stoVolFt3PerFeedMol"]
    rsfb = sep["totals"]["totalGor"]
    bodb, rsdb = dl["totals"]["bodb"], dl["totals"]["rsdb"]
    adjust = bofb / bodb

    rows = []
    for p in sorted(undersat_pressures, reverse=True):
        st = phase_state(comps, bip, z, t_r, p)
        rows.append({"pressure": p, "phase": "undersaturated", "Rs": rsfb,
                     "Bo": bofb * st["molarVolume"] / v_sat, "Bg": None, "Z": None,
                     "mu_o": lbc_viscosity(comps, z, t_r, st["molarVolume"]),
                     "mu_g": None})
    for st in dl["stages"]:
        rows.append({
            "pressure": st["pPsia"],
            "phase": "saturated" if st["isSaturation"] else "two-phase",
            "Rs": max(0.0, rsfb - (rsdb - st["rsd"]) * adjust),
            "Bo": st["bod"] * adjust,
            "Bg": st["bg"], "Z": st["gasZ"],
            "mu_o": lbc_viscosity(comps, st["x"], t_r, st["vOilMolar"]),
            "mu_g": (lbc_viscosity(comps, st["y"], t_r, st["vGasMolar"])
                     if st["y"] is not None else None),
        })
    return {"pb": psat, "rows": rows,
            "kpis": {"rsfb": rsfb, "bofb": bofb, "bodb": bodb, "rsdb": rsdb,
                     "stoApi": sep["stockTank"]["api"],
                     "surfaceGasGravity": sep["totals"]["surfaceGasGravity"],
                     "residualOilDensity": dl["residual"]["density"]},
            "dl": dl, "sep": sep}
