#!/usr/bin/env python3
"""Independent oracle for the production nodal engine: oil and gas inflow
performance, the dry-gas tubing outflow, and the operating point where
the two curves cross. Emits committed goldens to
test-data/production/goldens/nodal_cases.json.

INDEPENDENCE DISCIPLINE. This file is written from the METHOD SPEC the
JS engine documents -- Vogel's dimensionless ratio, Standing's composite
construction, Fetkovich's pressure-squared form, Jones-Blount-Glaze,
Rawlins-Schellhardt, Houpeurt, the Cullender and Smith defining integral,
Colebrook-White, and the slope criterion for nodal stability -- and NOT
by transcribing the JS. Where the two must agree they reach the number
by different roads:

  inverse IPR      the engine inverts pwf(q) with a Brent root find on
                   the forward relation. The oracle uses the CLOSED-FORM
                   inverse of every family: the positive root of the
                   Vogel quadratic, sqrt(pr^2 - (q/C)^(1/n)) for
                   Fetkovich and Rawlins-Schellhardt, the piecewise
                   inverse of the composite, the direct evaluation of
                   Jones. No iteration at all.

  Cullender-Smith  the engine marches the published two-half-step
                   trapezoid and closes with Simpson's rule over three
                   stations. The oracle recognises that the same
                   defining integral is an ODE in depth,
                   dp/dL = 18.75 gammaG / I(p, T(L)), and integrates it
                   with classical RK4 to STEP CONVERGENCE (200 steps; the
                   answer stops moving in the ninth figure past 100)
                   with the temperature evaluated continuously. The engine's answer is the
                   published method; the oracle's is what that method is
                   approximating, so the gap between them is the METHOD's
                   discretisation error and is reported as such.

  average T,z      the engine iterates a fixed point on pwf. The oracle
                   brackets and bisects the same closure.

  node crossings   the engine scans a 40-point rate grid and refines
                   with Brent. The oracle scans up to 4000 points and
                   bisects,
                   and for the analytic-residual instruments it does not
                   search at all: the crossings are the roots of a
                   quadratic and are written down.

  stability        the engine takes a central difference of the residual
                   with a step of 0.5 percent of qmax. The oracle
                   differentiates ANALYTICALLY: d(pwf)/dq = 1 / (dq/dpwf)
                   with dq/dpwf in closed form for every IPR family, and
                   the instrument outflows differentiated by hand.

  operating point  the reduction is computed here too, not inferred.
                   Verifying the crossings does not verify the choice
                   among them, and the choice -- the RIGHTMOST STABLE
                   crossing -- is the number a user actually reads.

  z-factor         Sutton pseudo-criticals into Dranchuk-Abou-Kassem,
                   solved by BISECTION ON z over [0.1, 3] where the
                   engine runs a Newton iteration on the reduced
                   density. Same root, different variable, different
                   method.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_nodal.py
"""
import json
import math
import os

# ---------------------------------------------------------------------
# Gas z-factor: Sutton pseudo-criticals + Dranchuk-Abou-Kassem.
# ---------------------------------------------------------------------

DAK_A = [0.3265, -1.07, -0.5339, 0.01569, -0.05165,
         0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.721]


def sutton(sg):
    """Sutton (1985) pseudo-criticals, degR and psia."""
    return (169.2 + 349.5 * sg - 74.0 * sg * sg,
            756.8 - 131.0 * sg - 3.6 * sg * sg)


def dak_z(ppr, tpr):
    """DAK z by bisection on z itself.

    Writing rho_r = 0.27 ppr / (z tpr), the DAK polynomial gives a second
    value of z; the true z is where the two coincide. The residual
    r(z) = z_poly(rho_r(z)) - z is continuous and changes sign once over
    the physical band, so plain bisection is enough and needs no
    derivative.
    """
    if ppr <= 0:
        return 1.0
    t1 = DAK_A[0] + DAK_A[1] / tpr + DAK_A[2] / tpr ** 3 + DAK_A[3] / tpr ** 4 + DAK_A[4] / tpr ** 5
    t2 = DAK_A[5] + DAK_A[6] / tpr + DAK_A[7] / tpr ** 2
    t3 = DAK_A[8] * (DAK_A[6] / tpr + DAK_A[7] / tpr ** 2)

    def z_poly(r):
        return (1 + t1 * r + t2 * r * r - t3 * r ** 5
                + DAK_A[9] * (1 + DAK_A[10] * r * r) * (r * r / tpr ** 3)
                * math.exp(-DAK_A[10] * r * r))

    def resid(z):
        r = 0.27 * ppr / (z * tpr)
        return z_poly(r) - z

    lo, hi = 0.05, 3.0
    flo, fhi = resid(lo), resid(hi)
    if flo * fhi > 0:
        # Outside the bracket the correlation is being used well beyond
        # its fit range; refuse rather than return a number.
        raise ValueError('DAK residual does not bracket a root at ppr=%g tpr=%g' % (ppr, tpr))
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        fm = resid(mid)
        if flo * fm <= 0:
            hi = mid
        else:
            lo, flo = mid, fm
        if hi - lo < 1e-13:
            break
    return 0.5 * (lo + hi)


def gas_z(p_psia, t_f, sg):
    """z of a sweet hydrocarbon gas. 460 (not 459.67) is the Rankine
    offset the whole production domain uses; mixing the two shifts z in
    the fourth decimal and is not worth the disagreement."""
    tpc, ppc = sutton(sg)
    return dak_z(p_psia / ppc, (t_f + 460.0) / tpc)


# ---------------------------------------------------------------------
# Pipe friction: Colebrook-White by bisection on 1/sqrt(f).
# ---------------------------------------------------------------------

def colebrook(re, rel_rough):
    """Darcy friction factor. Colebrook is linear in x = 1/sqrt(f):

        x = -2 log10( eps/3.7D + 2.51 x / Re )

    so bisect on g(x) = x + 2 log10(eps/3.7D + 2.51 x/Re), which is
    monotone increasing in x. The engine iterates the fixed point in f.
    """
    if re <= 0:
        return 0.0

    def g(x):
        return x + 2 * math.log10(rel_rough / 3.7 + 2.51 * x / re)

    lo, hi = 1.0, 40.0
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if g(mid) > 0:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-15:
            break
    x = 0.5 * (lo + hi)
    return 1.0 / (x * x)


def moody(re, rel_rough):
    """Moody factor with the engine's stated critical-zone convention:
    64/Re below 2000, Colebrook above 4000, linear blend between."""
    if re <= 0:
        return 0.0
    if re < 2000:
        return 64.0 / re
    if re > 4000:
        return colebrook(re, rel_rough)
    f_lam = 64.0 / 2000
    f_turb = colebrook(4000, rel_rough)
    return f_lam + (re - 2000) / 2000.0 * (f_turb - f_lam)


def gas_reynolds(q_mmscfd, sg, mu_cp, d_in):
    if mu_cp <= 0 or d_in <= 0:
        return 0.0
    return 20011.0 * sg * abs(q_mmscfd) / (mu_cp * d_in)


# ---------------------------------------------------------------------
# Oil inflow. Forward relations are the published equations; every
# inverse and every derivative below is CLOSED FORM.
# ---------------------------------------------------------------------

def vogel_ratio(r):
    return 1 - 0.2 * r - 0.8 * r * r


def vogel_inverse_ratio(y):
    """The r in [0,1] with 1 - 0.2r - 0.8r^2 = y. Positive root of
    0.8 r^2 + 0.2 r - (1 - y) = 0."""
    y = min(max(y, 0.0), 1.0)
    disc = 0.04 + 3.2 * (1 - y)
    return (-0.2 + math.sqrt(disc)) / 1.6


class OilIpr(object):
    """A calibrated oil IPR. q in stb/d, p in psia."""

    def __init__(self, model, pr, pb=0.0, pi=None, qmax=None, c=None, n=None,
                 a=None, b=None):
        self.model = model
        self.pr = float(pr)
        self.pb = float(pb)
        self.pi = pi
        self._qmax = qmax
        self.c = c
        self.n = n
        self.a = a
        self.b = b

    # -- calibration from a well test, derived per family ---------------
    @staticmethod
    def from_test(model, pr, test_q, test_pwf, pb=0.0, n=None, ):
        if model == 'pi':
            return OilIpr('pi', pr, pi=test_q / (pr - test_pwf))
        if model == 'vogel':
            return OilIpr('vogel', pr, qmax=test_q / vogel_ratio(test_pwf / pr))
        if model == 'composite':
            if test_pwf >= pb:
                j = test_q / (pr - test_pwf)
            else:
                j = test_q / ((pr - pb) + (pb / 1.8) * vogel_ratio(test_pwf / pb))
            return OilIpr('composite', pr, pb=pb, pi=j)
        if model == 'fetkovich':
            c = test_q / (pr * pr - test_pwf * test_pwf) ** n
            return OilIpr('fetkovich', pr, c=c, n=n)
        raise ValueError('no test calibration for ' + model)

    @property
    def qmax(self):
        if self._qmax is not None:
            return self._qmax
        if self.model == 'pi':
            return self.pi * self.pr
        if self.model == 'composite':
            pb = min(self.pb, self.pr)
            return self.pi * (self.pr - pb) + self.pi * pb / 1.8
        if self.model == 'fetkovich':
            return self.c * (self.pr * self.pr) ** self.n
        if self.model == 'jones':
            if self.b > 0:
                return (-self.a + math.sqrt(self.a ** 2 + 4 * self.b * self.pr)) / (2 * self.b)
            return self.pr / self.a
        raise ValueError('qmax undefined for ' + self.model)

    def q_at(self, pwf):
        """Forward: rate at a flowing pressure (the published equation)."""
        p = max(0.0, pwf)
        if self.model == 'pi':
            return max(0.0, self.pi * (self.pr - p))
        if self.model == 'vogel':
            if p >= self.pr:
                return 0.0
            return self.qmax * vogel_ratio(p / self.pr)
        if self.model == 'composite':
            pb = min(self.pb, self.pr)
            if p >= self.pr:
                return 0.0
            if p >= pb or pb <= 0:
                return self.pi * (self.pr - p)
            qb = self.pi * (self.pr - pb)
            return qb + (self.pi * pb / 1.8) * vogel_ratio(p / pb)
        if self.model == 'fetkovich':
            d = self.pr ** 2 - p ** 2
            return self.c * d ** self.n if d > 0 else 0.0
        if self.model == 'jones':
            dp = self.pr - p
            if dp <= 0:
                return 0.0
            if not self.b:
                return dp / self.a
            return (-self.a + math.sqrt(self.a ** 2 + 4 * self.b * dp)) / (2 * self.b)
        raise ValueError(self.model)

    def pwf_at(self, q):
        """Inverse, IN CLOSED FORM. No root finding anywhere in here."""
        if q <= 0:
            return self.pr
        if q >= self.qmax:
            return 0.0
        if self.model == 'pi':
            return self.pr - q / self.pi
        if self.model == 'vogel':
            return self.pr * vogel_inverse_ratio(q / self.qmax)
        if self.model == 'composite':
            pb = min(self.pb, self.pr)
            qb = self.pi * (self.pr - pb)
            if q <= qb or pb <= 0:
                return self.pr - q / self.pi
            return pb * vogel_inverse_ratio((q - qb) / (self.pi * pb / 1.8))
        if self.model == 'fetkovich':
            return math.sqrt(max(0.0, self.pr ** 2 - (q / self.c) ** (1.0 / self.n)))
        if self.model == 'jones':
            return self.pr - self.a * q - self.b * q * q
        raise ValueError(self.model)

    def dq_dpwf(self, pwf):
        """Analytic slope of the forward relation."""
        p = max(0.0, pwf)
        if self.model == 'pi':
            return -self.pi
        if self.model == 'vogel':
            return self.qmax * (-0.2 / self.pr - 1.6 * p / self.pr ** 2)
        if self.model == 'composite':
            pb = min(self.pb, self.pr)
            if p >= pb or pb <= 0:
                return -self.pi
            return (self.pi * pb / 1.8) * (-0.2 / pb - 1.6 * p / pb ** 2)
        if self.model == 'fetkovich':
            return self.c * self.n * (self.pr ** 2 - p ** 2) ** (self.n - 1) * (-2 * p)
        if self.model == 'jones':
            q = self.q_at(p)
            return -1.0 / (self.a + 2 * self.b * q)
        raise ValueError(self.model)

    def dpwf_dq(self, q):
        """Analytic slope of the inverse, by the inverse-function rule."""
        return 1.0 / self.dq_dpwf(self.pwf_at(q))


def future_ipr(ipr, pr_future):
    """The published depletion rules, re-derived: Eickmeier's cube for
    Vogel, C proportional to pr for Fetkovich, coefficients held for the
    straight line and for Jones, PI held for the composite."""
    ratio = pr_future / ipr.pr
    if ipr.model == 'vogel':
        return OilIpr('vogel', pr_future, qmax=ipr.qmax * ratio ** 3)
    if ipr.model == 'fetkovich':
        return OilIpr('fetkovich', pr_future, c=ipr.c * ratio, n=ipr.n)
    if ipr.model == 'composite':
        return OilIpr('composite', pr_future, pb=min(ipr.pb, pr_future), pi=ipr.pi)
    if ipr.model == 'jones':
        return OilIpr('jones', pr_future, a=ipr.a, b=ipr.b)
    return OilIpr('pi', pr_future, pi=ipr.pi)


# ---------------------------------------------------------------------
# Gas inflow. Both families are explicit in pwf^2, so both inverses are
# a square root and neither needs a solver.
# ---------------------------------------------------------------------

class BackPressureIpr(object):
    """Rawlins and Schellhardt: q = C (pr^2 - pwf^2)^n, q in Mscf/d."""

    def __init__(self, pr, c, n):
        self.pr, self.c, self.n = float(pr), float(c), float(n)

    @property
    def aof(self):
        return self.c * (self.pr ** 2) ** self.n

    def q_at(self, pwf):
        d = self.pr ** 2 - max(0.0, pwf) ** 2
        return self.c * d ** self.n if d > 0 else 0.0

    def pwf_at(self, q):
        if q <= 0:
            return self.pr
        if q >= self.aof:
            return 0.0
        return math.sqrt(max(0.0, self.pr ** 2 - (q / self.c) ** (1.0 / self.n)))

    def dpwf_dq(self, q):
        # pwf^2 = pr^2 - (q/C)^(1/n)  =>  2 pwf dpwf = -(1/(nC)) (q/C)^(1/n - 1)
        pwf = self.pwf_at(q)
        if pwf <= 0:
            return float('-inf')
        return -((q / self.c) ** (1.0 / self.n - 1)) / (2 * pwf * self.n * self.c)


class LitIpr(object):
    """Houpeurt / LIT: pr^2 - pwf^2 = a q + b q^2, q in Mscf/d."""

    def __init__(self, pr, a, b):
        self.pr, self.a, self.b = float(pr), float(a), float(b)

    @property
    def aof(self):
        # a q + b q^2 = pr^2
        if self.b > 0:
            return (-self.a + math.sqrt(self.a ** 2 + 4 * self.b * self.pr ** 2)) / (2 * self.b)
        return self.pr ** 2 / self.a

    def q_at(self, pwf):
        d = self.pr ** 2 - max(0.0, pwf) ** 2
        if d <= 0:
            return 0.0
        if self.b > 0:
            return (-self.a + math.sqrt(self.a ** 2 + 4 * self.b * d)) / (2 * self.b)
        return d / self.a

    def pwf_at(self, q):
        if q <= 0:
            return self.pr
        d = self.pr ** 2 - self.a * q - self.b * q * q
        return math.sqrt(d) if d > 0 else 0.0

    def dpwf_dq(self, q):
        pwf = self.pwf_at(q)
        if pwf <= 0:
            return float('-inf')
        return -(self.a + 2 * self.b * q) / (2 * pwf)


def chord_pwf(ipr, n_points, q):
    """pwf read off the SAMPLED deliverability curve by linear
    interpolation, which is what a consumer must do when the inflow is a
    pseudo-pressure table with no inverse. Sampled evenly in pressure
    from pr to zero, per the documented curve contract. Included so the
    bias of that reading is a measured number in the golden rather than
    an opinion. The sampling is even in PRESSURE, which leaves it sparse
    in rate exactly where the curve is steepest, and the reading comes
    out low on both empirical families."""
    pts = []
    for i in range(n_points):
        pwf = ipr.pr * (1 - i / float(n_points - 1))
        pts.append((ipr.q_at(pwf), pwf))
    pts.sort()
    if q <= pts[0][0]:
        return pts[0][1]
    for i in range(1, len(pts)):
        if q <= pts[i][0]:
            q0, p0 = pts[i - 1]
            q1, p1 = pts[i]
            t = 0.0 if q1 == q0 else (q - q0) / (q1 - q0)
            return p0 + t * (p1 - p0)
    return 0.0


# ---------------------------------------------------------------------
# Dry-gas tubing outflow.
#
# Cullender and Smith state the column as
#
#     integral from ptf to pwf of I(p) dp = 18.75 gammaG L
#     I(p) = (p/Tz) / [ (H/L)(p/Tz)^2/1000 + F^2 ]
#     F^2  = 0.667 f q^2 / d^5        (q MMscf/d, d in)
#
# Differentiating the left side with respect to length gives the ODE
# dp/dL = 18.75 gammaG / I(p, T(L)), which is what is integrated here,
# with T linear in measured depth. The engine instead evaluates the
# integral with two trapezoid half-steps and one Simpson pass, so the
# two answers differ by the published method's own truncation error.
# ---------------------------------------------------------------------

def cs_integrand(p, t_r, z, elev_ratio, f2):
    ptz = p / (t_r * z)
    denom = elev_ratio * ptz * ptz / 1000.0 + f2
    return ptz / denom if denom > 0 else 0.0


def cs_bhp_rk4(ptf, sg, md_ft, tvd_ft, wht_f, bht_f, q_mmscfd=0.0,
               id_in=2.441, rough_in=0.0006, mu_cp=0.012, f_moody=None,
               steps=200):
    """Flowing (or static) BHP by RK4 on dp/dL. Returns (pwf, pmf, f)."""
    elev = tvd_ft / md_ft
    f2 = 0.0
    f_used = 0.0
    if q_mmscfd > 0:
        f_used = f_moody if f_moody is not None else moody(
            gas_reynolds(q_mmscfd, sg, mu_cp, id_in), rough_in / id_in)
        f2 = 0.667 * f_used * q_mmscfd * q_mmscfd / id_in ** 5
    rhs = 18.75 * sg

    def t_at(length):
        return wht_f + (bht_f - wht_f) * length / md_ft

    def slope(length, p):
        t_r = t_at(length) + 460.0
        z = gas_z(p, t_at(length), sg)
        i = cs_integrand(p, t_r, z, elev, f2)
        return rhs / i if i > 0 else 0.0

    h = md_ft / steps
    p = ptf
    pmf = None
    for k in range(steps):
        length = k * h
        if pmf is None and length >= md_ft / 2.0:
            pmf = p
        k1 = slope(length, p)
        k2 = slope(length + h / 2, p + h * k1 / 2)
        k3 = slope(length + h / 2, p + h * k2 / 2)
        k4 = slope(length + h, p + h * k3)
        p += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6.0
    return p, pmf, f_used


def cs_integral_check(ptf, pwf, sg, md_ft, tvd_ft, wht_f, bht_f, q_mmscfd,
                      id_in, rough_in, mu_cp, f_moody=None, n=1000):
    """The defining integral evaluated on the oracle's own answer, as a
    closure test on the oracle itself: it must return 18.75 gammaG L.

    Temperature has to be tied to depth, and depth to pressure, so the
    pressure at each length is taken from the same RK4 march and the
    integral is accumulated by the trapezoid over p with T at the
    matching depth."""
    elev = tvd_ft / md_ft
    f2 = 0.0
    if q_mmscfd > 0:
        f = f_moody if f_moody is not None else moody(
            gas_reynolds(q_mmscfd, sg, mu_cp, id_in), rough_in / id_in)
        f2 = 0.667 * f * q_mmscfd * q_mmscfd / id_in ** 5
    rhs = 18.75 * sg
    h = md_ft / n
    p = ptf
    total = 0.0

    def t_at(length):
        return wht_f + (bht_f - wht_f) * length / md_ft

    def i_at(length, pp):
        return cs_integrand(pp, t_at(length) + 460.0, gas_z(pp, t_at(length), sg), elev, f2)

    for k in range(n):
        length = k * h
        i1 = i_at(length, p)
        dp = h * rhs / i1
        p2 = p + dp
        i2 = i_at(length + h, p2)
        total += 0.5 * (i1 + i2) * (p2 - p)
        p = p2
    return total, 18.75 * sg * md_ft


def avg_tz_bhp(ptf, sg, md_ft, tvd_ft, wht_f, bht_f, q_mscfd=0.0,
               id_in=2.441, rough_in=0.0006, mu_cp=0.012, f_moody=None):
    """Katz average temperature and z (Guo and Ghalambor Eq. 4.54),
    closed by BISECTION on pwf rather than by the engine's fixed point."""
    cos = tvd_ft / md_ft
    t_bar_r = (wht_f + bht_f) / 2.0 + 460.0
    f = 0.0
    if q_mscfd > 0:
        f = f_moody if f_moody is not None else moody(
            gas_reynolds(q_mscfd / 1000.0, sg, mu_cp, id_in), rough_in / id_in)

    def resid(pwf):
        p_bar = (ptf + pwf) / 2.0
        z_bar = gas_z(p_bar, t_bar_r - 460.0, sg)
        s = 0.0375 * sg * md_ft * cos / (t_bar_r * z_bar)
        es = math.exp(s)
        fric = 0.0
        if q_mscfd > 0:
            fric = (6.67e-4 * (es - 1) * f * q_mscfd ** 2 * t_bar_r ** 2 * z_bar ** 2
                    / (id_in ** 5 * cos))
        return math.sqrt(es * ptf * ptf + fric) - pwf

    lo, hi = ptf, ptf * 100.0
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if resid(mid) > 0:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-12:
            break
    return 0.5 * (lo + hi)


# ---------------------------------------------------------------------
# The node solve.
#
# Crossings by a 4000-point scan and bisection to 1e-12 of qmax; the
# engine uses 40 points and Brent. Stability from the ANALYTIC slope of
# the residual, where the engine takes a central difference of half a
# per cent of qmax. The operating point -- the rightmost stable crossing
# -- is computed here, not read off the crossings by eye.
# ---------------------------------------------------------------------

def solve_node(ipr_pwf, vlp_bhp, dresid, q_max, n_scan=4000):
    def g(q):
        return vlp_bhp(q) - ipr_pwf(q)

    lo_q = q_max * 1e-6
    hi_q = q_max * (1 - 1e-9)
    xs = [lo_q + (hi_q - lo_q) * i / float(n_scan) for i in range(n_scan + 1)]
    roots = []
    prev_q, prev_g = xs[0], g(xs[0])
    for q in xs[1:]:
        cur = g(q)
        if prev_g == 0.0:
            roots.append(prev_q)
        elif prev_g * cur < 0:
            a, b, fa = prev_q, q, prev_g
            for _ in range(200):
                m = 0.5 * (a + b)
                fm = g(m)
                if fa * fm <= 0:
                    b = m
                else:
                    a, fa = m, fm
                if b - a < q_max * 1e-11:
                    break
            roots.append(0.5 * (a + b))
        prev_q, prev_g = q, cur
    if prev_g == 0.0:
        roots.append(prev_q)

    inter = []
    for q in roots:
        inter.append({'q': q, 'pwf': ipr_pwf(q), 'stable': dresid(q) > 0})
    stable = [x for x in inter if x['stable']]
    op = stable[-1] if stable else None
    status = 'flowing' if op else ('no-stable-solution' if inter else 'dead')
    return {'intersections': inter, 'op': op, 'status': status}


# ---------------------------------------------------------------------
# Instrument outflows.
#
# These are TEST INSTRUMENTS, not correlations, and they are labelled as
# such wherever they appear. A real tubing curve for an oil well is a
# multiphase traverse and belongs to the consumer that owns the PVT
# stack; what the node solver needs to be gated on is its ability to
# find and classify crossings, and for that a curve whose crossings are
# known in closed form is worth more than a correlation whose crossings
# are only known numerically.
#
#   gravityFriction  bhp = pWh + gGrav/(1 + q/qRef) + kFric q^2
#                    J-shaped for the same reason a real one is: a term
#                    that falls as the column lightens plus a term that
#                    grows as the square of rate.
#
#   quadraticResidual  bhp = iprPwf(q) + c0 + c2 (q - q0)^2
#                    the residual IS a parabola, so its two crossings
#                    are q0 +/- sqrt(-c0/c2) exactly and their stability
#                    follows from the sign of 2 c2 (q - q0). Nothing is
#                    searched for.
# ---------------------------------------------------------------------

def grav_fric(p_wh, g_grav, q_ref, k_fric):
    def bhp(q):
        return p_wh + g_grav / (1 + q / q_ref) + k_fric * q * q

    def dbhp(q):
        return -g_grav / q_ref / (1 + q / q_ref) ** 2 + 2 * k_fric * q
    return bhp, dbhp


def emit():
    out = {}
    out['description'] = (
        'Production nodal goldens: oil and gas inflow performance, the '
        'dry-gas Cullender-Smith tubing outflow, and the operating point '
        'where inflow and outflow cross. Independent stdlib oracle '
        '(tools/validation/production/oracle_nodal.py) written from the '
        'published method statements: every IPR inverse in closed form '
        'against the engine\'s Brent root find, the Cullender-Smith '
        'integral as an RK4 ODE in depth against the engine\'s two-step '
        'trapezoid plus Simpson, node crossings by a 4000-point scan and '
        'bisection against the engine\'s 40-point scan and Brent, and '
        'stability from the analytic residual slope against the engine\'s '
        'half-a-per-cent central difference. Field units: psia, stb/d for '
        'oil, Mscf/d for gas, ft, degF, in.')

    # -- 1. oil IPR curves and inverses --------------------------------
    oil_specs = [
        ('straightLine', OilIpr('pi', 3200, pi=1.8)),
        ('vogelSaturated', OilIpr('vogel', 2400, qmax=1500)),
        ('compositeStanding', OilIpr('composite', 3000, pb=2000, pi=1.2)),
        ('fetkovich', OilIpr('fetkovich', 3500, c=8.5e-5, n=0.87)),
        ('jonesBlountGlaze', OilIpr('jones', 2800, a=0.9, b=0.0015)),
    ]
    oil = []
    for cid, ipr in oil_specs:
        pwfs = [ipr.pr * f for f in (1.0, 0.9, 0.75, 0.5, 0.25, 0.1, 0.0)]
        qs = [ipr.qmax * f for f in (0.05, 0.2, 0.5, 0.8, 0.95)]
        oil.append({
            'id': cid,
            'model': ipr.model,
            'inputs': {k: v for k, v in
                       (('pr', ipr.pr), ('pb', ipr.pb), ('pi', ipr.pi),
                        ('qmax', ipr._qmax), ('c', ipr.c), ('n', ipr.n),
                        ('a', ipr.a), ('b', ipr.b)) if v is not None},
            'qmax': ipr.qmax,
            'forward': [{'pwf': p, 'q': ipr.q_at(p)} for p in pwfs],
            'inverse': [{'q': q, 'pwf': ipr.pwf_at(q)} for q in qs],
            'dpwfdq': [{'q': q, 'dpwfdq': ipr.dpwf_dq(q)} for q in qs],
        })
    out['oilIpr'] = oil

    # -- 2. calibration from a production test -------------------------
    cal = []
    for cid, model, pr, pb, tq, tp, n in [
        ('piFromTest', 'pi', 3200, 0, 900.0, 2700.0, None),
        ('vogelFromTest', 'vogel', 2400, 0, 700.0, 1500.0, None),
        ('compositeTestAbovePb', 'composite', 3000, 2000, 600.0, 2500.0, None),
        ('compositeTestBelowPb', 'composite', 3000, 2000, 1500.0, 1400.0, None),
        ('fetkovichFromTest', 'fetkovich', 3500, 0, 1100.0, 2900.0, 0.87),
    ]:
        ipr = OilIpr.from_test(model, pr, tq, tp, pb=pb, n=n)
        cal.append({
            'id': cid, 'model': model,
            'inputs': {'pr': pr, 'pb': pb, 'testQ': tq, 'testPwf': tp,
                       **({'n': n} if n is not None else {})},
            'pi': ipr.pi, 'c': ipr.c, 'n': ipr.n,
            'qmax': ipr.qmax,
            # the calibration has to reproduce the test point it was fitted to
            'qAtTestPwf': ipr.q_at(tp),
        })
    out['iprCalibration'] = cal

    # -- 3. depletion --------------------------------------------------
    fut = []
    for cid, ipr, prf in [
        ('vogelEickmeier', OilIpr('vogel', 2400, qmax=1500), 1800.0),
        ('fetkovichDecline', OilIpr('fetkovich', 3500, c=8.5e-5, n=0.87), 2500.0),
        ('compositeHeldPi', OilIpr('composite', 3000, pb=2000, pi=1.2), 2400.0),
        ('straightLineHeldPi', OilIpr('pi', 3200, pi=1.8), 2000.0),
    ]:
        f = future_ipr(ipr, prf)
        fut.append({'id': cid, 'model': ipr.model, 'pr': ipr.pr, 'prFuture': prf,
                    'qmax': f.qmax,
                    'pwfAtHalfQmax': f.pwf_at(0.5 * f.qmax)})
    out['futureIpr'] = fut

    # -- 4. gas deliverability -----------------------------------------
    gas = []
    for cid, g in [
        ('rawlinsSchellhardt', BackPressureIpr(4000, 0.01, 0.85)),
        ('rawlinsSchellhardtTurbulent', BackPressureIpr(3200, 0.004, 0.62)),
        ('houpeurtLit', LitIpr(4000, 900.0, 0.35)),
    ]:
        pwfs = [g.pr * f for f in (1.0, 0.8, 0.5, 0.2, 0.0)]
        qs = [g.aof * f for f in (0.1, 0.35, 0.6, 0.9)]
        gas.append({
            'id': cid,
            'model': 'backPressure' if isinstance(g, BackPressureIpr) else 'lit',
            'inputs': ({'pr': g.pr, 'c': g.c, 'n': g.n} if isinstance(g, BackPressureIpr)
                       else {'pr': g.pr, 'a': g.a, 'b': g.b}),
            'aof': g.aof,
            'forward': [{'pwf': p, 'q': g.q_at(p)} for p in pwfs],
            'inverse': [{'q': q, 'pwf': g.pwf_at(q)} for q in qs],
            # what a 40-point chord reading of the same curve gives, and
            # by how much it is high
            'chord40': [{'q': q, 'pwf': chord_pwf(g, 40, q),
                         'biasPsi': chord_pwf(g, 40, q) - g.pwf_at(q)} for q in qs],
        })
    out['gasIpr'] = gas

    # -- 5. tubing outflow ---------------------------------------------
    tub_specs = [
        # id, ptf, sg, md, tvd, wht, bht, qMMscfd, id_in, rough, mu, f override
        ('staticVertical', 800.0, 0.65, 8000.0, 8000.0, 100.0, 200.0, 0.0, 2.441, 0.0006, 0.012, None),
        ('flowingVertical', 800.0, 0.65, 8000.0, 8000.0, 100.0, 200.0, 4.0, 2.441, 0.0006, 0.012, None),
        ('flowingHighRate', 800.0, 0.65, 8000.0, 8000.0, 100.0, 200.0, 9.0, 2.441, 0.0006, 0.012, None),
        ('flowingDeviated', 1000.0, 0.70, 12000.0, 10400.0, 90.0, 240.0, 6.0, 2.992, 0.0006, 0.014, None),
        ('prescribedFriction', 900.0, 0.68, 10000.0, 10000.0, 110.0, 220.0, 5.0, 2.441, 0.0006, 0.012, 0.015),
    ]
    tub = []
    for (cid, ptf, sg, md, tvd, wht, bht, q, idin, rough, mu, fov) in tub_specs:
        pwf, pmf, f_used = cs_bhp_rk4(ptf, sg, md, tvd, wht, bht, q, idin, rough, mu, fov)
        lhs, rhs = cs_integral_check(ptf, pwf, sg, md, tvd, wht, bht, q, idin, rough, mu, fov)
        tub.append({
            'id': cid,
            'inputs': {'ptf': ptf, 'gasSg': sg, 'mdFt': md, 'tvdFt': tvd,
                       'whtF': wht, 'bhtF': bht, 'qMmscfd': q, 'idIn': idin,
                       'roughnessIn': rough, 'muCp': mu,
                       **({'fMoody': fov} if fov is not None else {})},
            'pwfPsia': pwf,
            'pmfPsia': pmf,
            'fMoodyUsed': f_used,
            'reynolds': gas_reynolds(q, sg, mu, idin) if q > 0 else 0.0,
            'frictionGroupF2': (0.667 * f_used * q * q / idin ** 5) if q > 0 else 0.0,
            'avgTzPwfPsia': avg_tz_bhp(ptf, sg, md, tvd, wht, bht, q * 1000.0,
                                       idin, rough, mu, fov),
            'definingIntegral': lhs,
            'definingIntegralTarget': rhs,
        })
    out['tubing'] = tub

    # -- 5b. z and friction spot values (machine-precision gates) -------
    out['zFactor'] = [{'pPsia': p, 'tF': t, 'gasSg': s, 'z': gas_z(p, t, s)}
                      for (p, t, s) in [(800, 120, 0.65), (2500, 180, 0.65),
                                        (4500, 220, 0.70), (150, 90, 0.60)]]
    out['friction'] = [{'re': re, 'relRough': rr, 'f': moody(re, rr)}
                       for (re, rr) in [(1200, 0.0002), (3000, 0.0002),
                                        (5e4, 0.0002456), (2e6, 0.0002456),
                                        (1e7, 1e-5)]]

    # -- 6. node solves against instrument outflows ---------------------
    nodes = []

    def add_gravfric(cid, ipr, p_wh, g_grav, q_ref, k_fric, note):
        bhp, dbhp = grav_fric(p_wh, g_grav, q_ref, k_fric)
        res = solve_node(ipr.pwf_at, bhp,
                         lambda q: dbhp(q) - ipr.dpwf_dq(q), ipr.qmax)
        probes = [ipr.qmax * f for f in (0.05, 0.25, 0.5, 0.75, 0.95)]
        nodes.append({
            'id': cid,
            'note': note,
            'outflow': {'form': 'gravityFriction', 'pWh': p_wh, 'gGrav': g_grav,
                        'qRef': q_ref, 'kFric': k_fric},
            'ipr': {'model': ipr.model, 'pr': ipr.pr, 'pb': ipr.pb, 'pi': ipr.pi,
                    'qmax': ipr._qmax, 'c': ipr.c, 'n': ipr.n, 'a': ipr.a, 'b': ipr.b},
            'qMax': ipr.qmax,
            'probes': [{'q': q, 'ipr': ipr.pwf_at(q), 'vlp': bhp(q),
                        'g': bhp(q) - ipr.pwf_at(q)} for q in probes],
            'intersections': res['intersections'],
            'op': res['op'],
            'status': res['status'],
        })

    add_gravfric('vogelSingleCrossing', OilIpr('vogel', 2500, qmax=1000),
                 300.0, 900.0, 200.0, 6e-4,
                 'One stable crossing. The root is deliberately nowhere near a '
                 'grid node of the engine\'s 40-point scan, so it can only be '
                 'reached by an actual solve.')
    add_gravfric('compositeTwoCrossings', OilIpr('composite', 3000, pb=2000, pi=1.2),
                 250.0, 3200.0, 250.0, 2.5e-4,
                 'Heavy column: an unstable left-branch crossing and a stable '
                 'right-branch one. The operating point is the reduction over '
                 'the two, not the first found.')
    add_gravfric('deadWell', OilIpr('pi', 1200, pi=0.5),
                 1400.0, 800.0, 300.0, 1e-3,
                 'Outflow above inflow at every rate: no crossing, and the '
                 'well is dead rather than flowing at zero.')

    def add_quadratic(cid, ipr, c0, c2, q0, note, n_grid_hint):
        """The residual is a parabola, so the crossings are algebra."""
        def bhp(q):
            return ipr.pwf_at(q) + c0 + c2 * (q - q0) ** 2

        half = math.sqrt(-c0 / c2)
        roots = [q0 - half, q0 + half]
        inter = [{'q': r, 'pwf': ipr.pwf_at(r), 'stable': (2 * c2 * (r - q0)) > 0}
                 for r in roots]
        stable = [x for x in inter if x['stable']]
        nodes.append({
            'id': cid,
            'note': note,
            'nGridRequired': n_grid_hint,
            'outflow': {'form': 'quadraticResidual', 'c0': c0, 'c2': c2, 'q0': q0},
            'ipr': {'model': ipr.model, 'pr': ipr.pr, 'pb': ipr.pb, 'pi': ipr.pi,
                    'qmax': ipr._qmax, 'c': ipr.c, 'n': ipr.n, 'a': ipr.a, 'b': ipr.b},
            'qMax': ipr.qmax,
            'probes': [{'q': q, 'ipr': ipr.pwf_at(q), 'vlp': bhp(q),
                        'g': bhp(q) - ipr.pwf_at(q)}
                       for q in [ipr.qmax * f for f in (0.05, 0.25, 0.5, 0.75, 0.95)]],
            'intersections': inter,
            'op': stable[-1] if stable else None,
            'status': 'flowing' if stable else ('no-stable-solution' if inter else 'dead'),
        })

    add_quadratic('analyticResidualWide', OilIpr('vogel', 3000, qmax=2000),
                  -40.0, 1e-3, 1000.0,
                  'Closed-form instrument: the residual is a parabola, so both '
                  'crossings and both stability signs are exact algebra with no '
                  'search anywhere in the oracle. Roots 400 stb/d apart, well '
                  'resolved by the default 40-point scan.', 40)
    add_quadratic('analyticResidualPinched', OilIpr('vogel', 3000, qmax=2000),
                  -0.1, 1e-3, 1000.0,
                  'The same instrument with the two crossings only 20 stb/d '
                  'apart, which is less than one interval of the default '
                  '40-point scan across a 2000 stb/d open flow. This is the '
                  'shape a well takes as it approaches loading up, and it is '
                  'where a coarse scan stops seeing the well at all: the '
                  'engine needs nGrid at least 400 here. The golden records '
                  'what is true, not what a 40-point scan finds.', 400)

    out['nodes'] = nodes

    # -- 7. a physical gas node: deliverability x Cullender-Smith -------
    gas_nodes = []
    for (cid, pr, c, n, ptf, sg, md, tvd, wht, bht, idin) in [
        ('gasWellVertical', 4000.0, 0.01, 0.85, 800.0, 0.65, 8000.0, 8000.0, 100.0, 200.0, 2.441),
        ('gasWellDeviatedBigTubing', 3600.0, 0.02, 0.80, 1000.0, 0.70, 12000.0, 10400.0, 90.0, 240.0, 2.992),
    ]:
        ipr = BackPressureIpr(pr, c, n)

        def bhp(q, ptf=ptf, sg=sg, md=md, tvd=tvd, wht=wht, bht=bht, idin=idin):
            # 100 RK4 steps: the march is step-converged to the ninth
            # figure by then, and the node solve calls this a few
            # thousand times.
            return cs_bhp_rk4(ptf, sg, md, tvd, wht, bht, q / 1000.0, idin,
                              0.0006, 0.012, None, steps=100)[0]

        def dresid(q, ipr=ipr, bhp=bhp):
            h = max(ipr.aof * 1e-5, 1e-6)
            return ((bhp(q + h) - bhp(q - h)) / (2 * h)) - ipr.dpwf_dq(q)

        res = solve_node(ipr.pwf_at, bhp, dresid, ipr.aof, n_scan=300)
        probes = [ipr.aof * f for f in (0.1, 0.3, 0.5, 0.7, 0.9)]
        op = res['op']
        # what the same node gives when the inflow is read off a 40-point
        # chord instead of inverted exactly: the bias that motivates
        # gasPwfAtRateExact
        chord_res = solve_node(lambda q, ipr=ipr: chord_pwf(ipr, 40, q), bhp,
                               dresid, ipr.aof, n_scan=300)
        gas_nodes.append({
            'id': cid,
            'ipr': {'model': 'backPressure', 'pr': pr, 'c': c, 'n': n},
            'tubing': {'ptf': ptf, 'gasSg': sg, 'mdFt': md, 'tvdFt': tvd,
                       'whtF': wht, 'bhtF': bht, 'idIn': idin,
                       'roughnessIn': 0.0006, 'muCp': 0.012},
            'qMax': ipr.aof,
            'probes': [{'q': q, 'ipr': ipr.pwf_at(q), 'vlp': bhp(q),
                        'g': bhp(q) - ipr.pwf_at(q)} for q in probes],
            'intersections': res['intersections'],
            'op': op,
            'status': res['status'],
            'opFromChordIpr': chord_res['op'],
            'chordRateBiasMscfd': (chord_res['op']['q'] - op['q']) if (op and chord_res['op']) else None,
        })
    out['gasNodes'] = gas_nodes

    # -- 8. a wellhead-pressure sweep on the first gas node -------------
    base = gas_nodes[0]
    sweep = []
    ipr = BackPressureIpr(base['ipr']['pr'], base['ipr']['c'], base['ipr']['n'])
    for ptf in (500.0, 800.0, 1200.0, 1800.0):
        def bhp(q, ptf=ptf):
            t = base['tubing']
            return cs_bhp_rk4(ptf, t['gasSg'], t['mdFt'], t['tvdFt'], t['whtF'],
                              t['bhtF'], q / 1000.0, t['idIn'], t['roughnessIn'],
                              t['muCp'], None, steps=100)[0]

        def dresid(q, bhp=bhp):
            h = max(ipr.aof * 1e-5, 1e-6)
            return ((bhp(q + h) - bhp(q - h)) / (2 * h)) - ipr.dpwf_dq(q)

        r = solve_node(ipr.pwf_at, bhp, dresid, ipr.aof, n_scan=300)
        sweep.append({'label': 'ptf %g psia' % ptf, 'value': ptf,
                      'status': r['status'],
                      'q': r['op']['q'] if r['op'] else 0.0,
                      'pwf': r['op']['pwf'] if r['op'] else None})
    out['sweep'] = {'node': base['id'], 'parameter': 'ptf', 'cases': sweep}

    # -- 9. the sampled tubing curve and its minimum --------------------
    # The engine samples linspace(qMax*1e-3, qMax, nPoints) and reduces to
    # the lowest sampled point. Both the sampled reduction and the true
    # continuous minimum are given, so the reduction is gated and the
    # sampling error in it is visible.
    t = base['tubing']

    def bhp_curve(q):
        return cs_bhp_rk4(t['ptf'], t['gasSg'], t['mdFt'], t['tvdFt'], t['whtF'],
                          t['bhtF'], q / 1000.0, t['idIn'], t['roughnessIn'],
                          t['muCp'], None, steps=200)[0]

    q_max = ipr.aof
    n_points = 25
    grid = [q_max * 1e-3 + (q_max - q_max * 1e-3) * i / float(n_points - 1)
            for i in range(n_points)]
    curve = [{'q': q, 'bhp': bhp_curve(q)} for q in grid]
    sampled_min = min(curve, key=lambda r: r['bhp'])
    # true minimum by golden-section search on the same continuous curve
    gr = (math.sqrt(5) - 1) / 2
    a, b = grid[0], q_max
    c1, c2 = b - gr * (b - a), a + gr * (b - a)
    f1, f2v = bhp_curve(c1), bhp_curve(c2)
    for _ in range(60):
        if f1 < f2v:
            b, c2, f2v = c2, c1, f1
            c1 = b - gr * (b - a)
            f1 = bhp_curve(c1)
        else:
            a, c1, f1 = c1, c2, f2v
            c2 = a + gr * (b - a)
            f2v = bhp_curve(c2)
        if b - a < q_max * 1e-7:
            break
    q_true = 0.5 * (a + b)
    out['tubingCurve'] = {
        'tubing': t, 'qMax': q_max, 'nPoints': n_points,
        'curve': curve,
        'sampledMinimum': sampled_min,
        'trueMinimum': {'q': q_true, 'bhp': bhp_curve(q_true)},
    }

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.abspath(os.path.join(
        here, '..', '..', '..', 'test-data', 'production', 'goldens', 'nodal_cases.json'))
    with open(dest, 'w') as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', dest)


if __name__ == '__main__':
    emit()
