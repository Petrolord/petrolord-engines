"""Basin-model oracle (G7.0) — INDEPENDENT reference implementation.

This file is the reference for the BasinFlow Genesis G7 engine rewrite.
Every formula is written from its published definition:

  - Porosity-depth: Athy exponential phi(z) = phi0*exp(-c*z) with the
    Sclater & Christie (1980) North Sea coefficients (the app's
    CompactionModelLibrary carries the same published values).
  - Decompaction: solid-thickness conservation
    Hs = integral(1 - phi(z)) dz over the layer; solved for layer
    thickness by BISECTION (the JS engine uses Newton-Raphson — a
    deliberately different method on the same integral).
  - Heat: 1D conduction, implicit backward Euler on a cell-centred
    non-uniform grid, harmonic-mean interface conductivities,
    Dirichlet surface node at z=0, Neumann basal heat flow.
    Effective conductivity is the geometric mean
    k_eff = k_matrix^(1-phi) * k_water^phi; volumetric heat capacity
    and radiogenic heat production are porosity-weighted.
  - Vitrinite reflectance: Easy%Ro (Sweeney & Burnham 1990, AAPG
    Bulletin 74/10 p.1559): A = 1.0e13 1/s, twenty activation energies
    E = 34..72 kcal/mol step 2, stoichiometric weights summing to 0.85,
    %Ro = exp(-1.6 + 3.7*F) with F the UNNORMALISED weighted reacted
    fraction (so Ro spans the published 0.20-4.69 validity range).
    Constants cross-checked 2026-07-14 against the PyBasin open-source
    implementation (ElcoLuijendijk/pybasin lib/easyRo.py).
  - Kerogen transformation: parallel first-order Arrhenius reactions on
    an arbitrary (potentials, A) set. The potential tables are treated
    as LIBRARY DATA (they are user-editable in the app); the oracle
    validates the INTEGRATOR via closed forms, not the tables.
  - Generation/expulsion: potential [kg HC / m2 column area] =
    rho_grain * Hs * TOC_frac * (HI/1000); cumulative generated =
    potential * TR; retention bucket = pore volume * S_threshold *
    rho_HC, expelled_t = max(expelled_{t-1}, generated_t - cap_t) —
    a MONOTONE state, because expelled hydrocarbons never return even
    when unroofing rebound grows the retention cap.

Shared spec constants (the G7.1 JS engine MUST use identical values):
  SECONDS_PER_MA = 3.1536e13   (365-day year)
  R_GAS          = 8.314       J/(mol K), with E converted kcal->J *4184
  RHO_WATER      = 1030 kg/m3, CP_WATER = 4186 J/(kg K), K_WATER = 0.6
  RHO_HC         = 850  kg/m3, S_EXPULSION_THRESHOLD = 0.1
  MAX_CELL_M     = 100         (thermal grid max cell height)
  DT_MA          = 1.0         (simulation step)

Model spec pinned here (documented for the JS engine):
  * Layers appear instantaneously when ageStart >= t (t counts down
    from the oldest ageStart to 0 in DT_MA steps); each step runs
    geometry -> heat -> kinetics using the newly solved temperatures.
  * First heat solve of a run is the steady state (time term dropped);
    later steps interpolate the previous T(z) profile onto the new
    grid (linear, basal-gradient extrapolation below the old bottom).
  * Kinetics use the temperature interpolated at the layer's centre.
  * Erosion event {age, amount}: a phantom shale section of deposited
    (at-surface) thickness `amount` appears at the youngest ageEnd of
    the layers whose deposition finished before the event, and is
    removed at the event age. Phantoms deepen and heat the layers
    below during the hiatus; their own state is discarded.
  * Basal heat flow is piecewise-linear in age through
    heatFlow.history when type == 'variable', else constant.
  * V1 LIMITATION (documented, deliberate): compaction is Athy-elastic —
    porosity is a pure function of CURRENT depth, so unroofed layers
    re-expand. Irreversible (max-burial) compaction hysteresis is the
    commercial-tool standard and is a recorded follow-on, not v1 scope.

This file must NEVER import from or be checked against any JS in src/
— the JS engine (G7.1) validates against THIS, which is only a genuine
dual implementation if the two sides share no code.

stdlib only — no numpy; regeneration must be byte-identical.
"""

import math

# ---------------------------------------------------------------------------
# Shared spec constants
# ---------------------------------------------------------------------------

SECONDS_PER_MA = 3.1536e13
R_GAS = 8.314              # J/(mol K)
KCAL_TO_J = 4184.0
RHO_WATER = 1030.0         # kg/m3 formation water
CP_WATER = 4186.0          # J/(kg K)
K_WATER = 0.6              # W/(m K)
RHO_HC = 850.0             # kg/m3 expelled-HC reference density
S_EXPULSION_THRESHOLD = 0.1
MAX_CELL_M = 100.0
DT_MA = 1.0

# Sweeney & Burnham (1990) Easy%Ro parameters.
EASYRO_A = 1.0e13                                     # 1/s
EASYRO_E_KCAL = [34.0 + 2.0 * i for i in range(20)]   # 34..72
EASYRO_WEIGHTS = [0.03, 0.03, 0.04, 0.04, 0.05, 0.05, 0.06, 0.04, 0.04,
                  0.07, 0.06, 0.06, 0.06, 0.05, 0.05, 0.04, 0.03, 0.02,
                  0.02, 0.01]                          # sum = 0.85


def easyro_from_f(f_reacted):
    """%Ro = exp(-1.6 + 3.7 F); F unnormalised (0..0.85)."""
    return math.exp(-1.6 + 3.7 * f_reacted)


# Lithology libraries — same published values the app carries
# (Sclater & Christie 1980 compaction; standard thermal averages).
LITHOLOGY = {
    'sandstone': {'phi0': 0.49, 'c': 0.00027, 'rho_grain': 2650.0,
                  'k': 3.5, 'radiogenic': 1.2e-6, 'cp': 900.0},
    'shale':     {'phi0': 0.63, 'c': 0.00051, 'rho_grain': 2720.0,
                  'k': 1.8, 'radiogenic': 1.8e-6, 'cp': 1100.0},
    'limestone': {'phi0': 0.45, 'c': 0.00035, 'rho_grain': 2710.0,
                  'k': 2.8, 'radiogenic': 0.8e-6, 'cp': 950.0},
    'salt':      {'phi0': 0.05, 'c': 0.0001, 'rho_grain': 2160.0,
                  'k': 5.5, 'radiogenic': 0.1e-6, 'cp': 850.0},
    'coal':      {'phi0': 0.10, 'c': 0.0002, 'rho_grain': 1300.0,
                  'k': 0.3, 'radiogenic': 0.5e-6, 'cp': 1300.0},
}


# ---------------------------------------------------------------------------
# Compaction / decompaction
# ---------------------------------------------------------------------------

def porosity(z, phi0, c):
    return phi0 * math.exp(-c * z)


def solid_thickness(top, thickness, phi0, c):
    """Hs = integral_top^{top+H} (1 - phi0 e^{-cz}) dz  (analytic)."""
    if c == 0.0:
        return thickness * (1.0 - phi0)
    return thickness + (phi0 / c) * math.exp(-c * top) * (
        math.exp(-c * thickness) - 1.0)


def decompacted_thickness(hs, top, phi0, c):
    """Invert solid_thickness for H at a given burial depth — bisection.

    H is bracketed by [hs, hs/(1-phi0) + 1] (porosity can never push the
    average void fraction past phi0).
    """
    if hs <= 0.0:
        return 0.0
    if phi0 <= 0.0:
        return hs
    lo = hs
    hi = hs / (1.0 - phi0) + 1.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if solid_thickness(top, mid, phi0, c) < hs:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-10:
            break
    return 0.5 * (lo + hi)


# ---------------------------------------------------------------------------
# Heat transport
# ---------------------------------------------------------------------------

def effective_conductivity(k_matrix, phi):
    return (k_matrix ** (1.0 - phi)) * (K_WATER ** phi)


def volumetric_heat_capacity(phi, rho_grain, cp_matrix):
    return phi * RHO_WATER * CP_WATER + (1.0 - phi) * rho_grain * cp_matrix


def _thomas(a, b, c, d):
    """Tridiagonal solve; a: sub (n-1), b: diag (n), c: super (n-1)."""
    n = len(d)
    cp = [0.0] * n
    dp = [0.0] * n
    cp[0] = c[0] / b[0] if n > 1 else 0.0
    dp[0] = d[0] / b[0]
    for i in range(1, n):
        denom = b[i] - a[i - 1] * cp[i - 1]
        cp[i] = (c[i] / denom) if i < n - 1 else 0.0
        dp[i] = (d[i] - a[i - 1] * dp[i - 1]) / denom
    x = [0.0] * n
    x[n - 1] = dp[n - 1]
    for i in range(n - 2, -1, -1):
        x[i] = dp[i] - cp[i] * x[i + 1]
    return x


def solve_heat_step(nodes, dt_s, surface_t, basal_q, t_old):
    """One implicit step on cell-centred nodes.

    nodes: list of dicts {z, k, rho_cp, a_vol}; nodes[0] MUST be the
    surface node at z = 0 (Dirichlet). dt_s = None solves steady state.
    t_old: previous temperature per node (ignored for steady state).
    Basal Neumann: (T_n - T_{n-1}) / dz = Q / k_harm(n-1, n).
    """
    n = len(nodes)
    if n == 1:
        return [surface_t]
    a = [0.0] * (n - 1)
    b = [0.0] * n
    c = [0.0] * (n - 1)
    d = [0.0] * n

    b[0] = 1.0
    c[0] = 0.0
    d[0] = surface_t

    for i in range(1, n - 1):
        zi, zm, zp = nodes[i]['z'], nodes[i - 1]['z'], nodes[i + 1]['z']
        dz_up = zi - zm
        dz_dn = zp - zi
        dz_avg = 0.5 * (dz_up + dz_dn)
        k_up = 2.0 * nodes[i]['k'] * nodes[i - 1]['k'] / (
            nodes[i]['k'] + nodes[i - 1]['k'])
        k_dn = 2.0 * nodes[i]['k'] * nodes[i + 1]['k'] / (
            nodes[i]['k'] + nodes[i + 1]['k'])
        w_up = k_up / (dz_up * dz_avg)
        w_dn = k_dn / (dz_dn * dz_avg)
        w_t = (nodes[i]['rho_cp'] / dt_s) if dt_s is not None else 0.0
        a[i - 1] = -w_up
        b[i] = w_t + w_up + w_dn
        c[i] = -w_dn
        d[i] = nodes[i]['a_vol'] + (w_t * t_old[i] if dt_s is not None
                                    else 0.0)

    dz_last = nodes[n - 1]['z'] - nodes[n - 2]['z']
    k_harm = 2.0 * nodes[n - 1]['k'] * nodes[n - 2]['k'] / (
        nodes[n - 1]['k'] + nodes[n - 2]['k'])
    a[n - 2] = -1.0
    b[n - 1] = 1.0
    d[n - 1] = basal_q * dz_last / k_harm

    return _thomas(a, b, c, d)


# ---------------------------------------------------------------------------
# Kinetics
# ---------------------------------------------------------------------------

def arrhenius_rate(a_factor, e_kcal, temp_k):
    return a_factor * math.exp(-(e_kcal * KCAL_TO_J) / (R_GAS * temp_k))


def kinetic_step(fractions, e_kcal_list, a_factor, temp_k, dt_ma):
    """Advance unreacted fractions one step at constant T (closed form)."""
    dt_s = dt_ma * SECONDS_PER_MA
    out = []
    for x, e in zip(fractions, e_kcal_list):
        k = arrhenius_rate(a_factor, e, temp_k)
        out.append(x * math.exp(-k * dt_s))
    return out


def easyro_state():
    return list(EASYRO_WEIGHTS)


def easyro_step(fractions, temp_k, dt_ma):
    return kinetic_step(fractions, EASYRO_E_KCAL, EASYRO_A, temp_k, dt_ma)


def easyro_value(fractions):
    f = sum(w - x for w, x in zip(EASYRO_WEIGHTS, fractions))
    return easyro_from_f(f)


def transformation_ratio(fractions, potentials):
    total = sum(potentials)
    if total <= 0.0:
        return 0.0
    return 1.0 - sum(fractions) / total


def easyro_ramp(t0_c, rate_c_per_ma, t_end_c, substep_ma=0.01):
    """Integrate Easy%Ro under a linear ramp; returns [(T_c, Ro)] each 1C.

    Sub-stepped piecewise-constant integration (temperature evaluated at
    the midpoint of each sub-step).
    """
    fractions = easyro_state()
    out = []
    total_ma = (t_end_c - t0_c) / rate_c_per_ma
    steps = int(round(total_ma / substep_ma))
    next_report = t0_c
    for i in range(steps + 1):
        t_c_now = t0_c + rate_c_per_ma * (i * substep_ma)
        while next_report <= t_c_now + 1e-9:
            out.append((next_report, easyro_value(fractions)))
            next_report += 1.0
        if i < steps:
            t_mid = t_c_now + 0.5 * rate_c_per_ma * substep_ma
            fractions = easyro_step(fractions, t_mid + 273.15, substep_ma)
    return out


# ---------------------------------------------------------------------------
# Full forward model
# ---------------------------------------------------------------------------

def _interp(x, pts):
    """Piecewise-linear on sorted (x, y) pairs; clamped ends."""
    if not pts:
        return 0.0
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for i in range(len(pts) - 1):
        x0, y0 = pts[i]
        x1, y1 = pts[i + 1]
        if x0 <= x <= x1:
            if x1 == x0:
                return y0
            return y0 + (x - x0) * (y1 - y0) / (x1 - x0)
    return pts[-1][1]


def _heat_flow_at(heat_flow, age):
    if heat_flow.get('type') == 'variable' and heat_flow.get('history'):
        pts = sorted((p['age'], p['value']) for p in heat_flow['history'])
        return _interp(age, pts) / 1000.0
    return heat_flow.get('value', 60.0) / 1000.0


def _build_phantoms(layers, erosion_events):
    phantoms = []
    for idx, ev in enumerate(erosion_events or []):
        age = float(ev['age'])
        amount = float(ev['amount'])
        if amount <= 0.0:
            continue
        ends = [l['ageEnd'] for l in layers if l['ageEnd'] > age]
        if not ends:
            continue
        deposit_age = min(ends)
        lith = LITHOLOGY['shale']
        hs = solid_thickness(0.0, amount, lith['phi0'], lith['c'])
        phantoms.append({
            'id': '__phantom_%d' % idx,
            'name': 'Eroded section %d' % idx,
            'lithology': 'shale',
            'ageStart': deposit_age,
            'erodeAge': age,
            'hs': hs,
            'phantom': True,
        })
    return phantoms


def run_basin_model(project):
    """Forward model per the pinned spec. Returns per-real-layer series.

    project: {'stratigraphy': [{id, name, thickness, lithology, ageStart,
    ageEnd, sourceRock?: {isSource, toc (percent), hi, kerogen:
    {potentials, a_factor}}}], 'heatFlow': {...}, 'erosionEvents':
    [{age, amount}], 'settings': {'surfaceTemp': C}}

    Layer thickness input = present-day thickness (solid thickness is
    derived from the present-day stack, top down).
    """
    layers = [dict(l) for l in project['stratigraphy']]
    layers.sort(key=lambda l: -float(l['ageStart']))
    surface_t = float(project.get('settings', {}).get('surfaceTemp', 20.0))

    # Present-day solid thicknesses, top down (youngest at top).
    depth = 0.0
    for l in sorted(layers, key=lambda l: float(l['ageStart'])):
        lith = LITHOLOGY[l['lithology']]
        l['hs'] = solid_thickness(depth, float(l['thickness']),
                                  lith['phi0'], lith['c'])
        depth += float(l['thickness'])

    phantoms = _build_phantoms(layers, project.get('erosionEvents'))
    all_layers = layers + phantoms

    max_age = max(float(l['ageStart']) for l in layers)
    times = []
    t = max_age
    while t >= -1e-9:
        times.append(round(t, 9))
        t -= DT_MA

    # Kinetic states per real layer.
    states = {}
    for l in layers:
        st = {'vitrinite': easyro_state(), 'ro': easyro_from_f(0.0),
              'expelled': 0.0}
        sr = l.get('sourceRock')
        if sr and sr.get('isSource'):
            st['kerogen'] = list(sr['kerogen']['potentials'])
            st['a_factor'] = float(sr['kerogen']['a_factor'])
            st['potential_mass'] = (LITHOLOGY[l['lithology']]['rho_grain']
                                    * l['hs'] * (float(sr['toc']) / 100.0)
                                    * (float(sr['hi']) / 1000.0))
        states[l['id']] = st

    series = {l['id']: {'age': [], 'top': [], 'bottom': [], 'temp_c': [],
                        'ro': [], 'tr': [], 'generated_kg_m2': [],
                        'expelled_kg_m2': []} for l in layers}

    prev_profile = None      # [(z, T)] of the previous step
    prev_basal_grad = None

    for t in times:
        active = []
        for l in all_layers:
            if float(l['ageStart']) < t - 1e-9:
                continue
            if l.get('phantom') and t <= l['erodeAge'] + 1e-9:
                continue
            active.append(l)
        active.sort(key=lambda l: float(l['ageStart']))

        # Geometry: decompact top-down.
        depth = 0.0
        geo = []
        for l in active:
            lith = LITHOLOGY[l['lithology']]
            h = decompacted_thickness(l['hs'], depth, lith['phi0'],
                                      lith['c'])
            geo.append({'layer': l, 'top': depth, 'bottom': depth + h,
                        'h': h, 'lith': lith})
            depth += h

        # Thermal grid: surface node + cell-centred nodes.
        # Cell count uses ceil(h/MAX_CELL - 1e-9): layer thicknesses can
        # land exactly on a cell boundary (e.g. 1600.0 m), where the
        # oracle's bisection and the JS engine's Newton-Raphson would
        # otherwise resolve to opposite sides of the ceil step.
        nodes = [{'z': 0.0,
                  'k': effective_conductivity(
                      geo[0]['lith']['k'],
                      porosity(0.0, geo[0]['lith']['phi0'],
                               geo[0]['lith']['c'])) if geo else 1.0,
                  'rho_cp': 1.0, 'a_vol': 0.0}]
        for g in geo:
            m = max(1, int(math.ceil(g['h'] / MAX_CELL_M - 1e-9)))
            dz = g['h'] / m
            for j in range(m):
                zc = g['top'] + (j + 0.5) * dz
                phi = porosity(zc, g['lith']['phi0'], g['lith']['c'])
                nodes.append({
                    'z': zc,
                    'k': effective_conductivity(g['lith']['k'], phi),
                    'rho_cp': volumetric_heat_capacity(
                        phi, g['lith']['rho_grain'], g['lith']['cp']),
                    'a_vol': g['lith']['radiogenic'] * (1.0 - phi),
                })

        basal_q = _heat_flow_at(project['heatFlow'], t)

        if prev_profile is None:
            temps = solve_heat_step(nodes, None, surface_t, basal_q, None)
        else:
            t_old = []
            z_max_prev = prev_profile[-1][0]
            t_bot_prev = prev_profile[-1][1]
            for nd in nodes:
                if nd['z'] <= z_max_prev:
                    t_old.append(_interp(nd['z'], prev_profile))
                else:
                    t_old.append(t_bot_prev + prev_basal_grad
                                 * (nd['z'] - z_max_prev))
            temps = solve_heat_step(nodes, DT_MA * SECONDS_PER_MA,
                                    surface_t, basal_q, t_old)

        profile = sorted(zip((nd['z'] for nd in nodes), temps))
        prev_profile = profile
        k_bottom = nodes[-1]['k'] if nodes else 1.0
        prev_basal_grad = basal_q / k_bottom

        # Kinetics + bookkeeping (real layers only).
        for g in geo:
            l = g['layer']
            if l.get('phantom'):
                continue
            st = states[l['id']]
            zc = 0.5 * (g['top'] + g['bottom'])
            t_c = _interp(zc, profile)
            t_k = t_c + 273.15

            st['vitrinite'] = easyro_step(st['vitrinite'], t_k, DT_MA)
            ro = easyro_value(st['vitrinite'])
            st['ro'] = max(st['ro'], ro)

            tr = 0.0
            generated = 0.0
            expelled = 0.0
            if 'kerogen' in st:
                sr = l['sourceRock']
                st['kerogen'] = kinetic_step(
                    st['kerogen'], EASYRO_E_KCAL, st['a_factor'], t_k,
                    DT_MA)
                tr = transformation_ratio(
                    st['kerogen'], sr['kerogen']['potentials'])
                generated = st['potential_mass'] * tr
                phi_avg = 0.5 * (
                    porosity(g['top'], g['lith']['phi0'], g['lith']['c'])
                    + porosity(g['bottom'], g['lith']['phi0'],
                               g['lith']['c']))
                cap = g['h'] * phi_avg * S_EXPULSION_THRESHOLD * RHO_HC
                st['expelled'] = max(st['expelled'], generated - cap)
                expelled = st['expelled']

            s = series[l['id']]
            s['age'].append(t)
            s['top'].append(g['top'])
            s['bottom'].append(g['bottom'])
            s['temp_c'].append(t_c)
            s['ro'].append(st['ro'])
            s['tr'].append(tr)
            s['generated_kg_m2'].append(generated)
            s['expelled_kg_m2'].append(expelled)

    return {'layers': [{'id': l['id'], 'name': l['name']} for l in layers],
            'series': series}
