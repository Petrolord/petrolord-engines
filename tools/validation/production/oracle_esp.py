#!/usr/bin/env python3
"""Independent oracle for the ESP engines (Production P5): stage-curve
fitting, affinity scaling, intake conditions and gas handling, total
dynamic head and staging, motor current, cable drop and surface power.
Emits committed goldens to test-data/production/goldens/esp_cases.json.

Independence discipline: written from the METHOD SPEC the JS documents,
not transcribed from it. Two deliberate differences in route:

  * least squares. The engine forms the normal equations and solves
    them by Gaussian elimination; the oracle factors the same design
    matrix by modified Gram-Schmidt QR and back-substitutes. Different
    algorithms, different conditioning behaviour, same minimiser.
  * hydraulic power. The engine builds its constant from rho g Q H in
    field units; the oracle builds the same number the other way, from
    the pressure form hp = q dP / 58824 with dP = 0.433 SG H, so a slip
    in either derivation shows up as a mismatch.

stdlib only. Regenerate:
    python3 tools/validation/production/oracle_esp.py
"""
import json
import math
import os

FT3_PER_BBL = 5.614583
SEC_PER_DAY = 86400
WATER_LBF_FT3 = 62.4
FT_LBF_S_PER_HP = 550
COPPER_ALPHA_PER_F = 0.00393 / 1.8
COPPER_REF_F = 77.0


def hp_divisor():
    """Same constant, built from the pressure form."""
    # hp = q[bbl/d] * dP[psi] / K, K from rho g Q with dP = 0.433 SG H
    # K_pressure = 550 * 86400 / (5.614583 * 144)  (144 in2 per ft2)
    k_pressure = FT_LBF_S_PER_HP * SEC_PER_DAY / (FT3_PER_BBL * 144.0)
    # and head -> pressure through the water column gradient 62.4/144
    return k_pressure / (WATER_LBF_FT3 / 144.0)


HP_DIV = hp_divisor()


def hydraulic_hp(q_bpd, head_ft, sg):
    return q_bpd * head_ft * sg / HP_DIV


# ------------------------------------------------------------ least squares

def polyfit_qr(xs, ys, degree, scale):
    """Least squares by modified Gram-Schmidt QR (independent route)."""
    n = len(xs)
    deg = max(1, min(degree, n - 1))
    s = scale if scale else max(abs(x) for x in xs) or 1.0
    cols = deg + 1
    # design matrix, column-major
    a = [[(x / s) ** k for x in xs] for k in range(cols)]
    q = []
    r = [[0.0] * cols for _ in range(cols)]
    for j in range(cols):
        v = list(a[j])
        for i in range(len(q)):
            r[i][j] = sum(q[i][k] * v[k] for k in range(n))
            v = [v[k] - r[i][j] * q[i][k] for k in range(n)]
        r[j][j] = math.sqrt(sum(t * t for t in v))
        q.append([t / r[j][j] for t in v] if r[j][j] > 1e-300 else [0.0] * n)
    qty = [sum(q[i][k] * ys[k] for k in range(n)) for i in range(cols)]
    coeffs = [0.0] * cols
    for i in range(cols - 1, -1, -1):
        acc = qty[i]
        for j in range(i + 1, cols):
            acc -= r[i][j] * coeffs[j]
        coeffs[i] = acc / r[i][i]
    resid = [poly_eval(coeffs, s, xs[k]) - ys[k] for k in range(n)]
    rmse = math.sqrt(sum(e * e for e in resid) / n)
    return {'coeffs': coeffs, 'scale': s, 'degree': deg, 'rmse': rmse}


def poly_eval(coeffs, scale, x):
    t = x / scale
    acc = 0.0
    for c in reversed(coeffs):
        acc = acc * t + c
    return acc


def fit_curve(points, ref_hz=60.0, head_degree=3, eff_degree=3):
    pts = sorted(points, key=lambda p: p['qBpd'])
    qs = [p['qBpd'] for p in pts]
    scale = max(qs)
    head = polyfit_qr(qs, [p['headFt'] for p in pts], head_degree, scale)
    eff_pts = [p for p in pts if p.get('efficiencyPct')]
    eff = (polyfit_qr([p['qBpd'] for p in eff_pts],
                      [p['efficiencyPct'] / 100.0 for p in eff_pts], eff_degree, scale)
           if len(eff_pts) >= 3 else None)
    return {'refHz': ref_hz, 'qMin': qs[0], 'qMax': qs[-1], 'head': head, 'eff': eff}


def bep_of(curve):
    if not curve['eff']:
        return None
    best_q, best_e = curve['qMin'], -1e30
    for i in range(401):
        q = curve['qMin'] + (curve['qMax'] - curve['qMin']) * i / 400.0
        e = poly_eval(curve['eff']['coeffs'], curve['eff']['scale'], q)
        if e > best_e:
            best_q, best_e = q, e
    return {'qBpd': best_q, 'efficiency': best_e,
            'headFt': poly_eval(curve['head']['coeffs'], curve['head']['scale'], best_q)}


EXTRAPOLATION_BAND_FRACTION = 0.10


def stage_performance(curve, q_bpd, hz, sg=1.0):
    """Item 5. A stage curve is a cubic through five or six points, and
    past the ends it is an arbitrary shape: this oracle's own fit put
    0.05 ft of head at 4,800 bbl/d on a curve tested to 3,500, and the
    golden gated that number as though it were a reading. Beyond a tenth
    of the tested span past either end there is no answer, and the row
    says so instead."""
    ratio = hz / curve['refHz']
    q_ref = q_bpd / ratio
    band = EXTRAPOLATION_BAND_FRACTION * (curve['qMax'] - curve['qMin'])
    if q_ref < curve['qMin'] - band or q_ref > curve['qMax'] + band:
        return {'ok': False, 'code': 'outsideCurve', 'qRefBpd': q_ref,
                'ratio': ratio, 'inRange': False, 'inBand': False,
                'region': 'downthrust' if q_ref < curve['qMin'] else 'upthrust'}
    head_ref = poly_eval(curve['head']['coeffs'], curve['head']['scale'], q_ref)
    head = head_ref * ratio * ratio
    eff = (poly_eval(curve['eff']['coeffs'], curve['eff']['scale'], q_ref)
           if curve['eff'] else float('nan'))
    bhp = hydraulic_hp(q_bpd, head, sg) / eff if eff and eff > 0 else float('nan')
    bep = bep_of(curve)
    in_range = curve['qMin'] <= q_ref <= curve['qMax']
    if not in_range:
        region = 'downthrust' if q_ref < curve['qMin'] else 'upthrust'
    elif bep and q_ref < 0.75 * bep['qBpd']:
        region = 'downthrust'
    elif bep and q_ref > 1.25 * bep['qBpd']:
        region = 'upthrust'
    else:
        region = 'recommended'
    return {'ok': True, 'headFt': head, 'efficiency': eff, 'bhpPerStage': bhp,
            'qRefBpd': q_ref, 'ratio': ratio, 'inRange': in_range,
            'inBand': True, 'region': region}


# ------------------------------------------------------------------- design

def reference_points(spec):
    lo = spec.get('qMin', 0.5 * spec['bepBpd'])
    hi = spec.get('qMax', 1.4 * spec['bepBpd'])
    out = []
    for i in range(9):
        q = lo + (hi - lo) * i / 8.0
        x = q / spec['bepBpd']
        out.append({
            'qBpd': q,
            'headFt': spec['bepHeadFt'] * (spec['shutoffRatio'] - (spec['shutoffRatio'] - 1) * x * x),
            'efficiencyPct': 100 * spec['bepEfficiency'] * max(0.0, 2 * x - x * x),
        })
    return out


def intake_stream(qo, wct, gor, pvt):
    wc = min(max(wct, 0.0), 0.999)
    qw = qo * wc / (1 - wc) if wc > 0 else 0.0
    qo_res = qo * pvt['bo']
    qw_res = qw * pvt['bw']
    free_gas_scfd = max(0.0, qo * (gor - pvt['rs']))
    gas_res = free_gas_scfd * pvt['bg']
    liquid = qo_res + qw_res
    total = liquid + gas_res
    gvf = gas_res / total if total > 0 else 0.0
    mass_liquid = qo_res * pvt['rhoO'] + qw_res * pvt['rhoW']
    mass = mass_liquid + gas_res * pvt['rhoG']
    return {'qwStbd': qw, 'qoResBpd': qo_res, 'qwResBpd': qw_res,
            'freeGasScfd': free_gas_scfd, 'freeGasResBpd': gas_res,
            'liquidResBpd': liquid, 'totalResBpd': total, 'gvf': gvf,
            'liquidDensityLbFt3': mass_liquid / liquid if liquid > 0 else 0.0,
            'gasDensityLbFt3': pvt['rhoG'],
            'mixtureDensityLbFt3': mass / total if total > 0 else 0.0}


def gas_handling(stream, sep_eff, standard_max=0.10, handler_max=0.25):
    eff = min(max(sep_eff, 0.0), 1.0)
    vented = stream['freeGasResBpd'] * eff
    through = stream['freeGasResBpd'] - vented
    intake = stream['liquidResBpd'] + through
    gvf = through / intake if intake > 0 else 0.0
    mass_through = (stream['liquidResBpd'] * stream['liquidDensityLbFt3']
                    + through * stream['gasDensityLbFt3'])
    density = mass_through / intake if intake > 0 else 0.0
    verdict = 'standard'
    if gvf > handler_max:
        verdict = 'separatorRequired'
    elif gvf > standard_max:
        verdict = 'gasHandler'
    return {'ventedResBpd': vented, 'throughPumpGasResBpd': through,
            'pumpIntakeBpd': intake, 'gvfThroughPump': gvf,
            'mixtureDensityLbFt3': density, 'verdict': verdict}


def size_pump(curve, q_bpd, tdh_ft, hz, sg, nameplate_hp):
    st = stage_performance(curve, q_bpd, hz, sg)
    # A stage that makes no head cannot be stacked into one: the duty is
    # off the end of the curve and the answer is "no design", not a
    # negative stage count. The engine refuses the same way.
    stages = math.ceil(tdh_ft / st['headFt']) if st['headFt'] > 0 else None
    shaft = hydraulic_hp(q_bpd, tdh_ft, sg) / st['efficiency']
    # Item 2. Two powers, and the electrical chain takes the second: the
    # brake power of the stage count actually selected, which is the
    # published sizing power (BHP = stages x BHP/stage x SG). The first
    # is the brake power the duty asks for, smaller by the stage rounding
    # margin, and sizing amps and cable on it understates both.
    bhp_total = st['bhpPerStage'] * stages if stages else None
    return {'stages': stages, 'stage': st,
            'hydraulicHp': hydraulic_hp(q_bpd, tdh_ft, sg),
            'shaftHp': shaft,
            'bhpTotal': bhp_total,
            'motorSizingHp': bhp_total,
            'headMadeFt': st['headFt'] * stages,
            'loadFraction': bhp_total / nameplate_hp if nameplate_hp else None,
            'loadFractionOnShaftHp': shaft / nameplate_hp if nameplate_hp else None}


# --------------------------------------------------------------- electrical

def conductor_resistance(r77, temp_f):
    return r77 * (1 + COPPER_ALPHA_PER_F * (temp_f - COPPER_REF_F))


def surface_requirement(motor_hp, np_hp, np_amps, np_volts, pf, length_ft, r77, cable_f):
    # Item 2. `motor_hp` is the power the pump absorbs at the stage count
    # selected, not the brake power the duty asks for.
    load = motor_hp / np_hp
    amps = np_amps * load
    r = conductor_resistance(r77, cable_f)
    drop = math.sqrt(3) * amps * r * length_ft / 1000.0
    surface = np_volts + drop
    kva = math.sqrt(3) * surface * amps / 1000.0
    loss = 3 * amps * amps * r * (length_ft / 1000.0) / 1000.0
    return {'loadFraction': load, 'amps': amps, 'resistanceOhmsPer1000Ft': r,
            'dropV': drop, 'dropPct': drop / np_volts * 100.0,
            'surfaceVolts': surface, 'kva': kva, 'kw': kva * pf, 'lossKw': loss}


# ------------------------------------------------------------------- cases

VENDOR_POINTS = [
    {'qBpd': 1500, 'headFt': 32.0, 'efficiencyPct': 55.0},
    {'qBpd': 2000, 'headFt': 30.5, 'efficiencyPct': 68.0},
    {'qBpd': 2500, 'headFt': 28.0, 'efficiencyPct': 74.0},
    {'qBpd': 3000, 'headFt': 24.0, 'efficiencyPct': 72.0},
    {'qBpd': 3500, 'headFt': 19.0, 'efficiencyPct': 65.0},
]

REFERENCE_SPECS = [
    {'id': 'ref-540-2500', 'bepBpd': 2500, 'bepHeadFt': 28, 'shutoffRatio': 1.35,
     'bepEfficiency': 0.70, 'qMin': 1250, 'qMax': 3500},
    {'id': 'ref-675-7000', 'bepBpd': 7000, 'bepHeadFt': 18, 'shutoffRatio': 1.30,
     'bepEfficiency': 0.74, 'qMin': 4000, 'qMax': 9800},
]

DESIGNS = [
    {
        'id': 'gassyOffshore',
        'qoStbd': 1200.0, 'wct': 0.5, 'gorScfStb': 500.0,
        'pvt': {'rs': 300.0, 'bo': 1.2, 'bw': 1.02, 'bg': 0.0012,
                'rhoO': 48.0, 'rhoW': 64.0, 'rhoG': 6.0},
        'separatorEfficiency': 0.7,
        'pwfPsia': 1500.0, 'perfTvdFt': 7500.0, 'pumpTvdFt': 7000.0,
        'annulusGradPsiPerFt': 0.32, 'pDischargePsia': 3200.0,
        'hz': 60.0, 'nameplateHp': 250.0, 'curve': 'ref-540-2500',
        # the motor and cable this design would be built with, so the
        # golden gates the electrical chain AT THE DESIGN'S OWN POWER
        # rather than at a power typed into a separate case
        'nameplateAmps': 67.0, 'nameplateVolts': 2400.0, 'powerFactor': 0.85,
        'lengthFt': 7200.0, 'ohmsPer1000FtAt77F': 0.1593, 'cableTempF': 180.0,
    },
    {
        'id': 'highWaterCut',
        'qoStbd': 400.0, 'wct': 0.9, 'gorScfStb': 200.0,
        'pvt': {'rs': 180.0, 'bo': 1.12, 'bw': 1.01, 'bg': 0.0018,
                'rhoO': 51.0, 'rhoW': 65.0, 'rhoG': 4.2},
        'separatorEfficiency': 0.0,
        'pwfPsia': 1100.0, 'perfTvdFt': 6200.0, 'pumpTvdFt': 5800.0,
        'annulusGradPsiPerFt': 0.42, 'pDischargePsia': 2600.0,
        'hz': 50.0, 'nameplateHp': 200.0, 'curve': 'ref-675-7000',
    },
]

ELECTRICAL = [
    {'motorHp': 125.0, 'nameplateHp': 250.0, 'nameplateAmps': 67.0,
     'nameplateVolts': 2400.0, 'powerFactor': 0.85, 'lengthFt': 7200.0,
     'ohmsPer1000FtAt77F': 0.1593, 'cableTempF': 180.0},
    {'motorHp': 78.0, 'nameplateHp': 100.0, 'nameplateAmps': 49.0,
     'nameplateVolts': 1300.0, 'powerFactor': 0.88, 'lengthFt': 6000.0,
     'ohmsPer1000FtAt77F': 0.4028, 'cableTempF': 210.0},
]


def build():
    out = {
        'description': (
            'Production P5 ESP goldens. Independent stdlib oracle (QR least '
            'squares against the engine normal-equations solve, hydraulic '
            'power constant rebuilt from the pressure form) against the '
            'engine method spec: stage curves, affinity scaling, intake '
            'stream and gas handling, TDH and staging, motor current, cable '
            'drop and surface power.'
        ),
        'generator': 'tools/validation/production/oracle_esp.py',
        'constants': {'hpHeadDivisor': HP_DIV},
        'vendorCurve': None,
        'referenceCurves': [],
        'affinity': [],
        'designs': [],
        'electrical': [],
    }

    vc = fit_curve(VENDOR_POINTS)
    # Item 23. The RMSE is an average and an average hides one bad point
    # among five good ones, so the per-point residuals are published too
    # and the two percent bar is applied to the worst of them.
    head_height = max(p['headFt'] for p in VENDOR_POINTS)
    head_residuals = [{
        'qBpd': p['qBpd'],
        'headFt': p['headFt'],
        'fittedFt': poly_eval(vc['head']['coeffs'], vc['head']['scale'], p['qBpd']),
        'residualFt': p['headFt'] - poly_eval(vc['head']['coeffs'], vc['head']['scale'], p['qBpd']),
    } for p in VENDOR_POINTS]
    out['vendorCurve'] = {
        'points': VENDOR_POINTS,
        'headCoeffs': vc['head']['coeffs'], 'headScale': vc['head']['scale'],
        'headRmse': vc['head']['rmse'],
        'headCurveHeightFt': head_height,
        'headResiduals': head_residuals,
        'headMaxAbsResidualFt': max(abs(r['residualFt']) for r in head_residuals),
        'effCoeffs': vc['eff']['coeffs'], 'effScale': vc['eff']['scale'],
        'bep': bep_of(vc),
    }

    for spec in REFERENCE_SPECS:
        c = fit_curve(reference_points(spec), head_degree=2, eff_degree=2)
        out['referenceCurves'].append({
            'id': spec['id'], 'spec': spec,
            'bep': bep_of(c),
            'headAtBep': poly_eval(c['head']['coeffs'], c['head']['scale'], spec['bepBpd']),
            'samples': [
                {'qBpd': q, 'headFt': poly_eval(c['head']['coeffs'], c['head']['scale'], q)}
                for q in (spec['qMin'], spec['bepBpd'], spec['qMax'])
            ],
        })

    for hz in (40.0, 50.0, 60.0, 70.0):
        for q in (1800.0, 2500.0, 3200.0):
            out['affinity'].append({
                'hz': hz, 'qBpd': q, 'sg': 0.9,
                **{k: v for k, v in stage_performance(vc, q, hz, 0.9).items()
                   if k in ('ok', 'code', 'headFt', 'efficiency', 'bhpPerStage',
                            'qRefBpd', 'inRange', 'inBand', 'region')},
            })

    for d in DESIGNS:
        curve = vc if d['curve'] == 'vendor' else fit_curve(
            reference_points(next(s for s in REFERENCE_SPECS if s['id'] == d['curve'])),
            head_degree=2, eff_degree=2)
        stream = intake_stream(d['qoStbd'], d['wct'], d['gorScfStb'], d['pvt'])
        gas = gas_handling(stream, d['separatorEfficiency'])
        pip = d['pwfPsia'] - d['annulusGradPsiPerFt'] * max(d['perfTvdFt'] - d['pumpTvdFt'], 0.0)
        grad = gas['mixtureDensityLbFt3'] / 144.0
        tdh = (d['pDischargePsia'] - pip) / grad
        # Item 3. One gradient conversion, 62.4/144, so the specific
        # gravity handed to the power terms is the TRUE one, density
        # over 62.4, and no longer laundered through a rounded 0.433 to
        # keep the design and diagnostics chains agreeing.
        sized = size_pump(curve, gas['pumpIntakeBpd'], tdh, d['hz'],
                          grad / (62.4 / 144.0), d['nameplateHp'])
        row = {
            'id': d['id'], 'inputs': d,
            'stream': stream, 'gas': gas,
            'intakePressurePsia': pip, 'gradientPsiPerFt': grad, 'tdhFt': tdh,
            'sized': sized,
        }
        if 'nameplateAmps' in d:
            # the same surface requirement taken at each of the two
            # powers, so the golden carries the size of the item 2 gap
            row['electricalAtSizingHp'] = surface_requirement(
                sized['motorSizingHp'], d['nameplateHp'], d['nameplateAmps'],
                d['nameplateVolts'], d['powerFactor'], d['lengthFt'],
                d['ohmsPer1000FtAt77F'], d['cableTempF'])
            row['electricalAtShaftHp'] = surface_requirement(
                sized['shaftHp'], d['nameplateHp'], d['nameplateAmps'],
                d['nameplateVolts'], d['powerFactor'], d['lengthFt'],
                d['ohmsPer1000FtAt77F'], d['cableTempF'])
        out['designs'].append(row)

    for e in ELECTRICAL:
        out['electrical'].append({'inputs': e, **surface_requirement(
            e['motorHp'], e['nameplateHp'], e['nameplateAmps'], e['nameplateVolts'],
            e['powerFactor'], e['lengthFt'], e['ohmsPer1000FtAt77F'], e['cableTempF'])})

    return out


def rnd(o, nd=12):
    if isinstance(o, float):
        return round(o, nd)
    if isinstance(o, dict):
        return {k: rnd(v, nd) for k, v in o.items()}
    if isinstance(o, list):
        return [rnd(v, nd) for v in o]
    return o


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.abspath(os.path.join(
        here, '..', '..', '..', 'test-data', 'production', 'goldens', 'esp_cases.json'))
    with open(dest, 'w') as fh:
        json.dump(rnd(build()), fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('wrote', dest)
