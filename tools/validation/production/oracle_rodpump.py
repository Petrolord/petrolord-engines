#!/usr/bin/env python3
"""Independent oracle for the sucker-rod pumping engines (Production
P6): rod string properties, the tapered-string natural frequency, the
four-bar pumping unit and its torque factor, the damped wave equation
for the predictive card, and the Gibbs harmonic diagnostic.

Emits committed goldens to test-data/production/goldens/rodpump_cases.json.

Independence discipline: written from the METHOD SPEC the JS documents,
not transcribed from it. The route differs deliberately at every step:

  * natural frequency. The engine walks an exact transfer matrix per
    section and bisects for the first root. The oracle discretises the
    bar into many finite elements and finds the smallest eigenvalue of
    the resulting generalised problem by inverse power iteration. One
    is analytic and continuous, the other numerical and discrete.
  * four-bar linkage. The engine intersects two circles in closed form
    and differentiates the beam angle numerically for the torque
    factor. The oracle closes the loop by Newton iteration on the
    constraint residual and gets the torque factor by IMPLICIT
    differentiation of that constraint, which never forms a difference
    quotient at all.
  * wave equation. The engine marches displacement on a collocated
    grid with an explicit central difference. The oracle marches the
    first-order velocity/tension system on a STAGGERED grid with
    classical RK4. Different unknowns, different grid, different
    integrator, so the dispersion errors do not coincide.
  * Gibbs diagnostic. The engine hand-rolls complex arithmetic because
    JavaScript has no complex type. The oracle uses Python's own
    complex numbers, so an error in the hand-rolled multiply, square
    root, sine or cosine cannot hide.
  * pump constant. The engine builds it from cubic inches per barrel;
    the oracle builds it from gallons, so a slip in either shows up.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_rodpump.py
"""
import json
import math
import os

E_PSI = 30.5e6
STEEL_DENSITY = 490.0
STEEL_SG = 7.85
G = 32.174
COUPLING = 1.087

ROD = {
    '1/2': (0.500, 0.726),
    '5/8': (0.625, 1.135),
    '3/4': (0.750, 1.634),
    '7/8': (0.875, 2.224),
    '1': (1.000, 2.904),
    '1 1/8': (1.125, 3.676),
}


def area(d):
    return math.pi * d * d / 4.0


def pump_constant():
    """Built from gallons rather than cubic inches."""
    gal_per_bbl = 42.0
    in3_per_gal = 231.0
    return (math.pi / 4.0) * 1440.0 / (gal_per_bbl * in3_per_gal)


def wave_speed(d, w):
    return math.sqrt(E_PSI * area(d) * G / w)


def string_props(sections, fluid_sg):
    """sections: [(label, length_ft)]"""
    w_air = 0.0
    er = 0.0
    for label, L in sections:
        d, w = ROD[label]
        w_air += w * L
        er += (L * 12.0) / (E_PSI * area(d))
    bf = 1.0 - fluid_sg / STEEL_SG
    return {
        'weightAirLb': w_air,
        'weightFluidLb': w_air * bf,
        'buoyancy': bf,
        'erInPerLb': er,
        'krLbPerIn': 1.0 / er,
    }


# --------------------------------------------- natural frequency by eigenvalue

def natural_frequency(sections, elements_per_section=140):
    """Smallest eigenvalue of the discretised bar, clamped-free.

    Assemble consistent element stiffness and mass for a stepped bar and
    run inverse power iteration on K x = lambda M x. Nothing analytic.
    """
    nodes = [0.0]
    props = []
    for label, L in sections:
        d, w = ROD[label]
        h = L / elements_per_section
        for _ in range(elements_per_section):
            nodes.append(nodes[-1] + h)
            props.append((E_PSI * area(d), w / G, h))
    n = len(nodes)          # includes clamped node 0
    dof = n - 1             # free dofs 1..n-1
    K = [[0.0] * dof for _ in range(dof)]
    M = [[0.0] * dof for _ in range(dof)]
    for e, (ea, m, h) in enumerate(props):
        ke = [[ea / h, -ea / h], [-ea / h, ea / h]]
        me = [[m * h / 3.0, m * h / 6.0], [m * h / 6.0, m * h / 3.0]]
        idx = [e - 1, e]    # node e and e+1 -> dof indices e-1, e
        for a in range(2):
            for b in range(2):
                ia, ib = idx[a], idx[b]
                if ia < 0 or ib < 0:
                    continue
                K[ia][ib] += ke[a][b]
                M[ia][ib] += me[a][b]
    # inverse power iteration: solve K y = M x repeatedly
    x = [1.0] * dof
    lam = 0.0
    lu = _lu_decompose([row[:] for row in K])
    for _ in range(300):
        rhs = _matvec(M, x)
        y = _lu_solve(lu, rhs)
        nrm = math.sqrt(sum(v * v for v in y))
        y = [v / nrm for v in y]
        num = sum(a * b for a, b in zip(y, _matvec(K, y)))
        den = sum(a * b for a, b in zip(y, _matvec(M, y)))
        lam = num / den
        x = y
    omega = math.sqrt(lam)          # rad/s, with EA in lb and m in slug/ft
    # EA acts on a strain in ft here because h is in ft, so no extra factor.
    return omega * 60.0 / (2.0 * math.pi)


def _matvec(A, x):
    return [sum(A[i][j] * x[j] for j in range(len(x))) for i in range(len(A))]


def _lu_decompose(A):
    n = len(A)
    piv = list(range(n))
    for k in range(n):
        p = max(range(k, n), key=lambda i: abs(A[i][k]))
        if p != k:
            A[k], A[p] = A[p], A[k]
            piv[k], piv[p] = piv[p], piv[k]
        akk = A[k][k]
        for i in range(k + 1, n):
            A[i][k] /= akk
            f = A[i][k]
            if f:
                for j in range(k + 1, n):
                    A[i][j] -= f * A[k][j]
    return (A, piv)


def _lu_solve(lu, b):
    A, piv = lu
    n = len(A)
    y = [b[piv[i]] for i in range(n)]
    for i in range(n):
        for j in range(i):
            y[i] -= A[i][j] * y[j]
    for i in range(n - 1, -1, -1):
        for j in range(i + 1, n):
            y[i] -= A[i][j] * y[j]
        y[i] /= A[i][i]
    return y


# --------------------------------------------------------- four-bar by Newton

def beam_angle_newton(geom, theta, psi_guess):
    """Close the loop by Newton on |E(psi) - Pc| = P."""
    a, c, p = geom['aIn'], geom['cIn'], geom['pIn']
    ox, oy = -geom['crankBehindIn'], -geom['crankBelowIn']
    pcx = ox + geom['rIn'] * math.cos(theta)
    pcy = oy + geom['rIn'] * math.sin(theta)
    psi = psi_guess
    for _ in range(80):
        ex, ey = c * math.cos(psi), c * math.sin(psi)
        dx, dy = ex - pcx, ey - pcy
        f = dx * dx + dy * dy - p * p
        df = 2.0 * (dx * (-c * math.sin(psi)) + dy * (c * math.cos(psi)))
        if abs(df) < 1e-14:
            break
        step = f / df
        psi -= step
        if abs(step) < 1e-15:
            break
    return psi, a


def torque_factor_implicit(geom, theta, psi):
    """dpsi/dtheta from the constraint, without any difference quotient.

    g(theta, psi) = |E(psi) - Pc(theta)|^2 - P^2 = 0
    dpsi/dtheta = -(dg/dtheta) / (dg/dpsi)
    """
    c, r = geom['cIn'], geom['rIn']
    ox, oy = -geom['crankBehindIn'], -geom['crankBelowIn']
    pcx = ox + r * math.cos(theta)
    pcy = oy + r * math.sin(theta)
    ex, ey = c * math.cos(psi), c * math.sin(psi)
    dx, dy = ex - pcx, ey - pcy
    dg_dtheta = 2.0 * (dx * (r * math.sin(theta)) + dy * (-r * math.cos(theta)))
    dg_dpsi = 2.0 * (dx * (-c * math.sin(psi)) + dy * (c * math.cos(psi)))
    return -dg_dtheta / dg_dpsi


def unit_cycle(geom, steps=360):
    psis, tfs = [], []
    psi = math.pi * 0.6
    for i in range(steps):
        theta = 2.0 * math.pi * i / steps
        psi, a = beam_angle_newton(geom, theta, psi)
        psis.append(psi)
        tfs.append(a * torque_factor_implicit(geom, theta, psi))
    lo = min(psis)
    pos = [geom['aIn'] * (v - lo) for v in psis]
    return {
        'strokeIn': geom['aIn'] * (max(psis) - lo),
        'positionIn': pos,
        'torqueFactorIn': tfs,
        'upstrokeFraction': sum(1 for t in tfs if t < 0) / steps,
    }


# ------------------------------------------ wave equation, staggered + RK4

def predict(sections, surface_pos_ft, stroke_ft, spm, fo_lb, fillage,
            damping_ratio, cells=48, steps_per_cycle=None, cycles=8,
            first_cycle_seed_ft=None):
    """First-order velocity/tension system on a staggered grid, RK4.

    v lives at cell centres, T at faces. dv/dt = (dT/dx)/m - kappa v,
    dT/dt = EA dv/dx. Displacement is integrated alongside so the pump
    constraint can be applied.
    """
    total_L = sum(L for _, L in sections)

    def sec_at(x):
        acc = 0.0
        for label, L in sections:
            acc += L
            if x <= acc + 1e-9:
                return label
        return sections[-1][0]

    dx = total_L / cells
    ea_c, m_c, a_c = [], [], []
    for i in range(cells):
        d, w = ROD[sec_at((i + 0.5) * dx)]
        ea_c.append(E_PSI * area(d))
        m_c.append(w / G)
        a_c.append(wave_speed(d, w))
    a_max = max(a_c)
    kappa = damping_ratio * math.pi * a_max / total_L
    period = 60.0 / spm
    # Step from the Courant condition, not from a fixed count: a fixed
    # count is stable at one pumping speed and diverges at another.
    if steps_per_cycle is None:
        dt_cfl = dx / a_max
        steps_per_cycle = max(1200, int(math.ceil(period / (0.5 * dt_cfl))))
    dt = period / steps_per_cycle

    u = [0.0] * cells      # displacement at centres
    v = [0.0] * cells
    T = [0.0] * (cells + 1)

    state = 'falling'
    plunger_top = 0.0
    # The empty part of a partly filled barrel on the FIRST cycle is
    # measured against a seed, because the plunger stroke it is a
    # fraction of has not been computed yet. Every cycle after the first
    # is seeded from the previous cycle's computed stroke, at the foot
    # of the loop. The opening seed is the SURFACE stroke unless the
    # caller names another one, which is what lets the golden carry how
    # far the answer moves when it is changed. Item 39.
    sp_prev = stroke_ft if first_cycle_seed_ft is None else first_cycle_seed_ft
    surf_was_down = True

    def deriv(u_, v_, T_, u_top, v_top, clamp):
        du = list(v_)
        dv = [0.0] * cells
        dT = [0.0] * (cells + 1)
        for i in range(cells):
            dv[i] = (T_[i + 1] - T_[i]) / (dx * m_c[i]) - kappa * v_[i]
        for i in range(1, cells):
            ea = 0.5 * (ea_c[i - 1] + ea_c[i])
            dT[i] = ea * (v_[i] - v_[i - 1]) / dx
        # Top face: driven by the polished rod, so the strain rate there
        # is measured against the SURFACE velocity. Using zero here
        # pretends the polished rod is standing still, which corrupts
        # the first cell and with it the surface load.
        dT[0] = ea_c[0] * (v_[0] - v_top) / (dx / 2.0)
        dT[cells] = 0.0
        if clamp:
            dv[cells - 1] = 0.0
            du[cells - 1] = 0.0
        return du, dv, dT

    last = None
    for cyc in range(cycles):
        rec = []
        pmin, pmax = 1e30, -1e30
        for step in range(steps_per_cycle):
            t = step / steps_per_cycle
            down_now = surface_pos_ft((t + 1e-4) % 1.0) > surface_pos_ft((t - 1e-4) % 1.0)
            if down_now and not surf_was_down:
                state = 'pound'
                plunger_top = u[cells - 1]
            elif (not down_now) and surf_was_down:
                state = 'transfer_up'
            surf_was_down = down_now

            t_up = T[cells - 1]
            if state == 'transfer_up' and t_up >= fo_lb:
                state = 'lifting'
            if state == 'pound':
                if u[cells - 1] - plunger_top >= max(0.0, 1 - fillage) * sp_prev:
                    state = 'transfer_zero'
            if state == 'transfer_zero' and t_up <= 0.0:
                state = 'falling'
            clamp = state in ('transfer_up', 'transfer_zero')
            f_pump = 0.0 if state == 'falling' else fo_lb
            T[cells] = t_up if clamp else f_pump

            u_top = surface_pos_ft(t)
            h = 1e-5
            v_top = (surface_pos_ft((t + h) % 1.0)
                     - surface_pos_ft((t - h + 1.0) % 1.0)) / (2 * h * period)
            # RK4 on (u, v, T)
            k1 = deriv(u, v, T, u_top, v_top, clamp)
            u2 = [u[i] + 0.5 * dt * k1[0][i] for i in range(cells)]
            v2 = [v[i] + 0.5 * dt * k1[1][i] for i in range(cells)]
            T2 = [T[i] + 0.5 * dt * k1[2][i] for i in range(cells + 1)]
            k2 = deriv(u2, v2, T2, u_top, v_top, clamp)
            u3 = [u[i] + 0.5 * dt * k2[0][i] for i in range(cells)]
            v3 = [v[i] + 0.5 * dt * k2[1][i] for i in range(cells)]
            T3 = [T[i] + 0.5 * dt * k2[2][i] for i in range(cells + 1)]
            k3 = deriv(u3, v3, T3, u_top, v_top, clamp)
            u4 = [u[i] + dt * k3[0][i] for i in range(cells)]
            v4 = [v[i] + dt * k3[1][i] for i in range(cells)]
            T4 = [T[i] + dt * k3[2][i] for i in range(cells + 1)]
            k4 = deriv(u4, v4, T4, u_top, v_top, clamp)
            for i in range(cells):
                u[i] += dt / 6.0 * (k1[0][i] + 2 * k2[0][i] + 2 * k3[0][i] + k4[0][i])
                v[i] += dt / 6.0 * (k1[1][i] + 2 * k2[1][i] + 2 * k3[1][i] + k4[1][i])
            for i in range(cells + 1):
                T[i] += dt / 6.0 * (k1[2][i] + 2 * k2[2][i] + 2 * k3[2][i] + k4[2][i])
            # re-impose the surface displacement through the top face
            T[0] = ea_c[0] * (u[0] - u_top) / (dx / 2.0)
            if clamp:
                v[cells - 1] = 0.0
            rec.append((t, u_top, T[0], u[cells - 1], f_pump))
            pmin = min(pmin, u[cells - 1])
            pmax = max(pmax, u[cells - 1])
        sp_prev = max(pmax - pmin, 1e-9)
        last = (rec, pmin, pmax)
    rec, pmin, pmax = last
    return {
        'plungerStrokeIn': (pmax - pmin) * 12.0,
        'prlDynMaxLb': max(r[2] for r in rec),
        'prlDynMinLb': min(r[2] for r in rec),
    }


# ---------------------------------------------- Gibbs, with real complex type

def diagnose(sections, positions_in, loads_lb, w_rf, spm, damping_ratio, harmonics=24):
    N = len(positions_in)
    total_L = sum(L for _, L in sections)
    a_max = max(wave_speed(*ROD[l]) for l, _ in sections)
    kappa = damping_ratio * math.pi * a_max / total_L
    omega1 = 2.0 * math.pi * spm / 60.0

    def coeffs(vals, k):
        s = 0j
        for j, val in enumerate(vals):
            s += val * complex(math.cos(-2 * math.pi * k * j / N),
                               math.sin(-2 * math.pi * k * j / N))
        return s / N

    u_s = [p / 12.0 for p in positions_in]
    t_s = [l - w_rf for l in loads_lb]

    UL, TL = [], []
    for k in range(harmonics + 1):
        u = coeffs(u_s, k)
        t = coeffs(t_s, k)
        for label, L in sections:
            d, w = ROD[label]
            ea = E_PSI * area(d)
            a = wave_speed(d, w)
            if k == 0:
                u = u + t * L / ea
                continue
            omega = omega1 * k
            beta = complex(omega * omega, -omega * kappa) ** 0.5 / a
            bx = beta * L
            cb, sb = _ccos(bx), _csin(bx)
            u, t = u * cb + t * sb / (ea * beta), -u * ea * beta * sb + t * cb
        UL.append(u)
        TL.append(t)

    plunger, load = [], []
    for j in range(N):
        us, ts = UL[0].real, TL[0].real
        for k in range(1, harmonics + 1):
            e = complex(math.cos(2 * math.pi * k * j / N), math.sin(2 * math.pi * k * j / N))
            us += 2 * (UL[k] * e).real
            ts += 2 * (TL[k] * e).real
        plunger.append(us)
        load.append(ts)
    return {
        'plungerStrokeIn': (max(plunger) - min(plunger)) * 12.0,
        'pumpLoadMinLb': min(load),
        'pumpLoadMaxLb': max(load),
    }


def _ccos(z):
    return complex(math.cos(z.real) * math.cosh(z.imag),
                   -math.sin(z.real) * math.sinh(z.imag))


def _csin(z):
    return complex(math.sin(z.real) * math.cosh(z.imag),
                   math.cos(z.real) * math.sinh(z.imag))


# ------------------------------------------------------------------ goldens

def main():
    cases = {}
    cases['constants'] = {
        'pumpConstant': pump_constant(),
        'waveSpeed78': wave_speed(*ROD['7/8']),
        'couplingRatios': {k: ROD[k][1] / ((area(ROD[k][0]) / 144.0) * STEEL_DENSITY)
                           for k in ROD},
    }

    uni = [('7/8', 6000.0)]
    tap = [('7/8', 3000.0), ('3/4', 2000.0)]
    cases['strings'] = {
        'uniform': dict(string_props(uni, 1.0), n0Spm=natural_frequency(uni)),
        'taper': dict(string_props(tap, 1.0), n0Spm=natural_frequency(tap)),
    }

    geom = {'aIn': 106.6667, 'cIn': 64.0, 'pIn': 80.0,
            'crankBehindIn': 92.8, 'crankBelowIn': 60.8, 'rIn': 28.8}
    cyc = unit_cycle(geom, steps=360)
    cases['unit'] = {
        'geometry': geom,
        'strokeIn': cyc['strokeIn'],
        'upstrokeFraction': cyc['upstrokeFraction'],
        'torqueFactorMaxIn': max(abs(t) for t in cyc['torqueFactorIn']),
        'positionSample': cyc['positionIn'][::30],
        'torqueFactorSample': cyc['torqueFactorIn'][::30],
    }

    stroke_ft = 64.0 / 12.0

    def shm(f):
        return (stroke_ft / 2.0) * (1 - math.cos(2 * math.pi * f))

    props = string_props(tap, 1.0)
    pred = {}
    for spm in (5, 9):
        r = predict(tap, shm, stroke_ft, spm, 5000.0, 1.0, 0.10)
        pred[str(spm)] = {
            'plungerStrokeIn': r['plungerStrokeIn'],
            'pprlLb': props['weightFluidLb'] + r['prlDynMaxLb'],
            'mprlLb': props['weightFluidLb'] + r['prlDynMinLb'],
        }
    cases['predict'] = {
        'sections': [[a, b] for a, b in tap],
        'strokeIn': 64.0,
        'fluidLoadLb': 5000.0,
        'dampingRatio': 0.10,
        'bySpm': pred,
    }

    # PARTIAL FILLAGE, WHICH NOTHING IN THIS FILE COVERED. Every predict
    # case above is fillage 1, and a full pump never enters the pound
    # down state at all: the whole partly filled branch of both
    # implementations was ungated. It is the field normal case.
    #
    # Each row is computed twice, once with the first cycle's empty
    # length seeded from the SURFACE stroke, which is what both
    # implementations ship, and once from the static estimate
    # S - Fo/k_r, which is what item 39 proposes. The gap between the
    # two is the seed dependence of the answer, measured by this
    # implementation rather than argued about.
    partial = []
    static_seed_ft = max(stroke_ft - 5000.0 / props['krLbPerIn'] / 12.0, 0.1)
    for spm in (5, 9):
        for fillage in (1.0, 0.6, 0.3):
            r = predict(tap, shm, stroke_ft, spm, 5000.0, fillage, 0.10)
            rs = predict(tap, shm, stroke_ft, spm, 5000.0, fillage, 0.10,
                         first_cycle_seed_ft=static_seed_ft)
            partial.append({
                'spm': spm,
                'fillage': fillage,
                'plungerStrokeIn': r['plungerStrokeIn'],
                'pprlLb': props['weightFluidLb'] + r['prlDynMaxLb'],
                'mprlLb': props['weightFluidLb'] + r['prlDynMinLb'],
                'plungerStrokeInStaticSeed': rs['plungerStrokeIn'],
                'pprlLbStaticSeed': props['weightFluidLb'] + rs['prlDynMaxLb'],
                'mprlLbStaticSeed': props['weightFluidLb'] + rs['prlDynMinLb'],
            })
    cases['partialFillage'] = {
        'sections': [[a, b] for a, b in tap],
        'strokeIn': 64.0,
        'fluidLoadLb': 5000.0,
        'dampingRatio': 0.10,
        'surfaceStrokeSeedFt': stroke_ft,
        'staticSeedFt': static_seed_ft,
        'rows': partial,
    }

    # A synthetic surface card the diagnostic can be run on: a smooth
    # closed loop, so both implementations get exactly the same input.
    n = 120
    pos, ld = [], []
    for j in range(n):
        f = j / n
        pos.append(32.0 * (1 - math.cos(2 * math.pi * f)))
        ld.append(props['weightFluidLb'] + 2500.0 - 2500.0 * math.cos(2 * math.pi * f)
                  + 300.0 * math.sin(4 * math.pi * f))
    cases['diagnose'] = {
        'sections': [[a, b] for a, b in tap],
        'spm': 9,
        'dampingRatio': 0.10,
        'harmonics': 24,
        'positionsIn': pos,
        'loadsLb': ld,
        'result': diagnose(tap, pos, ld, props['weightFluidLb'], 9, 0.10, 24),
    }

    out = os.path.join(os.path.dirname(__file__), '..', '..', '..',
                       'test-data', 'production', 'goldens', 'rodpump_cases.json')
    with open(os.path.abspath(out), 'w') as fh:
        json.dump(cases, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', os.path.abspath(out))


if __name__ == '__main__':
    main()
