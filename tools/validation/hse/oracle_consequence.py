#!/usr/bin/env python3
"""Independent oracle for engines/hse/consequence.js (HSE H4).

Runs in the venv /root/hseenv (Python 3.12, numpy, scipy 1.18). Never calls
the JavaScript. Writes test-data/hse/goldens/consequence_cases.json.

Every formula below is transcribed from its source, not from the engine:

  YB    TNO Yellow Book CPR 14E (2005): 2.22 to 2.26 (gas through a hole),
        2.194 to 2.196 (liquid through a hole), 3.13 / 3.24 / 3.25
        (Mackay and Matsugu), 6.64 / 6.65 (pool diameter), 6.66 / 6.67 and
        Table 6.5 (burning rate), 6.12 to 6.14 (Thomas with wind), 6.68 to
        6.70 (tilt), 6.19 / 6.20 / 6.71 (SEP), 6.29 (Bagster), 6.4 (heat
        flux), Appendix 6.1 (view factors, Table 6.A.1), 5.1 (TNT).
  PB    TNO Purple Book CPR 18E (1999): Table 5.1, eq. 5.3 and Table 5.2,
        eq. 5.4, Appendix 6.B.
  OSD   UK HSE SPC/Tech/OSD/30: Tables 2, 17, 18 and Equation 4.
  ALOHA NOAA TM NOS OR&R 43 (2013): section 4.3 and Table 13.
  KG    Kinney and Graham (1985) as printed by Guzas and Earls (2010).
  CCOHS 24.45 L/mol at 25 C and 760 torr.

SECOND ROUTES, and what each can and cannot see

  view factor      route B integrates cos(b1) cos(b2) / (pi s^2) over the
                   visible lateral surface of the (sheared) cylinder by
                   400 x 400 Gauss-Legendre, for the vertical and the
                   horizontal target; it checks every term of the Mudan and
                   Raj closed forms, and it is what shows the closed form
                   failing once the flame overhangs the target plane.
  gas discharge    route B maximises the isentropic nozzle mass flux
                   G(p) = sqrt(2 g/(g-1) P0 rho0 [(p/P0)^(2/g) - (p/P0)^((g+1)/g)])
                   over throat pressures p >= Pa (scipy bounded minimise),
                   which derives choking instead of testing a ratio.
  liquid discharge route B is Torricelli, v = sqrt(2 g h), when the space
                   above the liquid is at ambient pressure.
  plume            route B integrates the plume over y in R and z >= 0
                   (scipy dblquad) and checks u * integral = Q: a lost
                   ground reflection is a factor of two against it.
  probit           route A is scipy.stats.norm; the engine uses the
                   Abramowitz and Stegun 7.1.26 erf (|error| <= 1.5e-7),
                   so probability goldens are gated at 2e-7 absolute.
  Kinney-Graham    one closed form. The PUBLISHED check is a secondary
                   source (CBU 2020 conference paper) whose column matches.
  roots            scipy brentq at xtol 1e-13.

Nothing in the probit, evaporation, TNT or transmissivity sections has a
second route; they are single closed forms whose constants were read
from the sources above and whose published tables are reproduced.
"""

import json
import math
import os

import numpy as np
from scipy import integrate, optimize
from scipy.stats import norm

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'hse', 'goldens', 'consequence_cases.json')

G = 9.80665
R = 8.314462618
ATM = 101325.0
PSI = 6894.757293168361

YB = 'TNO Yellow Book CPR 14E (2005)'
PB = 'TNO Purple Book CPR 18E (1999)'
OSD = 'UK HSE SPC/Tech/OSD/30'
ALOHA = 'NOAA TM NOS OR&R 43 ALOHA Technical Documentation (2013)'
KG = 'Kinney and Graham (1985) via Guzas and Earls (2010) eq. 5'


def pub(text):
    return 'PUBLISHED: ' + text


def der(text):
    return 'ORACLE-DERIVED: ' + text


# ---------------------------------------------------------------- source terms

def liquid(cd, d, rho, h, pal=ATM, pa=ATM):
    a = math.pi * d * d / 4
    p = rho * G * h + pal
    return cd * a * math.sqrt(2 * (p - pa) * rho)


def liquid_torricelli(cd, d, rho, h):
    return cd * (math.pi * d * d / 4) * rho * math.sqrt(2 * G * h)


def gas_yb(cd, d, p0, t0, mw, gam, pa=ATM):
    a = math.pi * d * d / 4
    rho0 = p0 * mw / (R * t0)
    critical = p0 / pa >= ((gam + 1) / 2) ** (gam / (gam - 1))
    if critical:
        psi2 = 1.0
    else:
        r = pa / p0
        psi2 = 2 / (gam - 1) * ((gam + 1) / 2) ** ((gam + 1) / (gam - 1)) * r ** (2 / gam) * (1 - r ** ((gam - 1) / gam))
    q = cd * a * math.sqrt(psi2) * math.sqrt(rho0 * p0 * gam * (2 / (gam + 1)) ** ((gam + 1) / (gam - 1)))
    return q, critical, math.sqrt(psi2)


def gas_nozzle(cd, d, p0, t0, mw, gam, pa=ATM):
    """Route B: maximise the isentropic mass flux over throat pressure p >= pa."""
    a = math.pi * d * d / 4
    rho0 = p0 * mw / (R * t0)

    def flux(p):
        x = p / p0
        return math.sqrt(max(0.0, 2 * gam / (gam - 1) * p0 * rho0 * (x ** (2 / gam) - x ** ((gam + 1) / gam))))
    res = optimize.minimize_scalar(lambda p: -flux(p), bounds=(pa, p0), method='bounded',
                                   options={'xatol': 1e-10 * p0})
    best = max(flux(res.x), flux(pa))
    return cd * a * best


# ---------------------------------------------------------------- dispersion

BRIGGS = {  # ALOHA Table 13, small surface roughness (rural); sy for both
    'A': (0.22, 0.0001, 0.2, 0.0, 0.0),
    'B': (0.16, 0.0001, 0.12, 0.0, 0.0),
    'C': (0.11, 0.0001, 0.08, 0.0002, -0.5),
    'D': (0.08, 0.0001, 0.06, 0.0015, -0.5),
    'E': (0.06, 0.0001, 0.03, 0.0003, -1.0),
    'F': (0.04, 0.0001, 0.016, 0.0003, -1.0),
}


def sig(cls, x):
    sy1, sy2, sz1, sz2, sz3 = BRIGGS[cls]
    return sy1 * x / math.sqrt(1 + sy2 * x), sz1 * x * (1 + sz2 * x) ** sz3


def plume(q, u, sy, sz, y, z, h):
    return q / (2 * math.pi * sy * sz * u) * math.exp(-y * y / (2 * sy * sy)) * (
        math.exp(-(z - h) ** 2 / (2 * sz * sz)) + math.exp(-(z + h) ** 2 / (2 * sz * sz)))


def plume_mass_flux(q, u, sy, sz, h):
    """Route B: u * integral over y in R, z >= 0 of C, should equal q."""
    f = lambda z, y: plume(q, u, sy, sz, y, z, h)
    val, _ = integrate.dblquad(f, -12 * sy, 12 * sy, 0, h + 12 * sz, epsabs=0, epsrel=1e-11)
    return u * val


def ppm_to_mg(ppm, mw, t=298.15, p=ATM):
    vm = R * t / p * 1000
    return ppm * mw / vm


# ---------------------------------------------------------------- fires

def raj_vertical(h, x):
    """YB 6.A.6 to 6.A.11 (Raj), h = L/R, x = X/R."""
    A = (x + 1) ** 2 + h * h
    B = (x - 1) ** 2 + h * h
    fh = (math.atan(math.sqrt((x + 1) / (x - 1)))
          - (x * x - 1 + h * h) / math.sqrt(A * B) * math.atan(math.sqrt((x - 1) * A / ((x + 1) * B)))) / math.pi
    fv = (1 / x * math.atan(h / math.sqrt(x * x - 1))
          + h * (A - 2 * x) / (x * math.sqrt(A * B)) * math.atan(math.sqrt((x - 1) * A / ((x + 1) * B)))
          - h / x * math.atan(math.sqrt((x - 1) / (x + 1)))) / math.pi
    return fv, fh


def mudan_tilted(a, b, t):
    """YB 6.A.14, 6.A.15 (Mudan); the square roots are restored from the
    worked example (A = 4.2384, C = 3.07555 reproduce only with them)."""
    s, c = math.sin(t), math.cos(t)
    A = math.sqrt(a * a + (b + 1) ** 2 - 2 * a * (b + 1) * s)
    B = math.sqrt(a * a + (b - 1) ** 2 - 2 * a * (b - 1) * s)
    C = math.sqrt(1 + (b * b - 1) * c * c)
    D = math.sqrt((b - 1) / (b + 1))
    E = a * c / (b - a * s)
    F = math.sqrt(b * b - 1)
    arcs = math.atan((a * b - F * F * s) / (F * C)) + math.atan(F * s / C)
    fv = (-E * math.atan(D) + E * (a * a + (b + 1) ** 2 - 2 * b * (1 + a * s)) / (A * B) * math.atan(A * D / B)
          + c / C * arcs) / math.pi
    fh = (math.atan(1 / D) + s / C * arcs
          - (a * a + (b + 1) ** 2 - 2 * (b + 1 + a * b * s)) / (A * B) * math.atan(A * D / B)) / math.pi
    return fv, fh


def vf_numeric(a, b, t, n=400):
    """Route B: Gauss-Legendre over the visible lateral surface. R = 1.
    Surface P = (cos p + z tan t, sin p, z), z in [0, a cos t]; outward
    normal (not unit) N = (cos p, sin p, -cos p tan t), |N| dp dz = dA.
    N.(T - P) = X cos p - 1, so the visible arc is |p| < acos(1/X)."""
    X = b
    H = a * math.cos(t)
    tt = math.tan(t)
    p0 = math.acos(1 / X)
    xg, wg = np.polynomial.legendre.leggauss(n)
    ph = p0 * xg
    wph = p0 * wg
    zz = H / 2 * (xg + 1)
    wz = H / 2 * wg
    P, Z = np.meshgrid(ph, zz, indexing='ij')
    W = np.outer(wph, wz)
    dx = np.cos(P) + Z * tt - X
    dy = np.sin(P)
    dz = Z
    s2 = dx * dx + dy * dy + dz * dz
    ndot = -(np.cos(P) * dx + np.sin(P) * dy - np.cos(P) * tt * dz)   # |N| cos(b2) s
    fv = float(np.sum(W * np.maximum(-dx, 0) * ndot / (math.pi * s2 * s2)))
    fh = float(np.sum(W * dz * ndot / (math.pi * s2 * s2)))
    return fv, fh


def thomas_still(d, m, rho=1.2):
    return d * 42 * (m / (rho * math.sqrt(G * d))) ** 0.61


def thomas_wind(d, m, u, rho):
    uc = (G * m * d / rho) ** (1 / 3)
    us = u / uc if u > uc else 1.0
    return 55 * (m / (rho * (G * d) ** 0.5)) ** 0.67 * us ** -0.21, uc, us


def tilt(d, u, nu):
    fr = u * u / (G * d)
    re = u * d / nu
    c = 0.666 * fr ** 0.333 * re ** 0.117
    return math.degrees(math.asin((math.sqrt(4 * c * c + 1) - 1) / (2 * c))), fr, re, c


# ---------------------------------------------------------------- explosions

def kg_ratio(z):
    return 808 * (1 + (z / 4.5) ** 2) / (math.sqrt(1 + (z / 0.048) ** 2) * math.sqrt(1 + (z / 0.32) ** 2)
                                           * math.sqrt(1 + (z / 1.35) ** 2))


# ---------------------------------------------------------------- probits

def P(y):
    return float(norm.cdf(y - 5))


def main():
    g = {'module': 'consequence', 'generatedBy': 'tools/validation/hse/oracle_consequence.py',
         'description': 'HSE H4 consequence modelling: source terms, Gaussian plume, pool fire solid flame, TNT and Kinney-Graham, probits.',
         'tolerances': {
             'routeA': 'relative 1e-10 for closed forms (both sides IEEE double; pow chains)',
             'roots': 'relative 1e-9',
             'probability': 'absolute 2e-7 (engine erf is Abramowitz and Stegun 7.1.26)',
             'viewFactorRouteB': 'absolute 1e-9 between closed form and 400 x 400 Gauss-Legendre',
             'published': 'per case, stated with the case',
         }}

    # ---------------- liquid
    liq = []
    q = liquid(0.62, 0.1, 812.5, 11.12)
    liq.append({'id': 'yb-acrylonitrile-500s', 'source': pub(YB + ' 2.6.4.1: acrylonitrile, d 0.1 m, Cd 0.62, rho 812.5, level 11.12 m at 500 s, printed qS = 58.44 kg/s'),
                'args': {'dischargeCoefficient': 0.62, 'holeDiameterM': 0.1, 'liquidDensityKgM3': 812.5, 'liquidHeadM': 11.12},
                'expected': {'massRateKgS': q}, 'printed': 58.44, 'publishedRelTol': 5e-4,
                'routeB': liquid_torricelli(0.62, 0.1, 812.5, 11.12)})
    for cid, args in [
        ('pressurised-water', dict(dischargeCoefficient=0.62, holeDiameterM=0.0254, liquidDensityKgM3=1000, liquidHeadM=0, pressureAboveLiquidPa=ATM + 7e5)),
        ('head-and-pressure', dict(dischargeCoefficient=0.82, holeAreaM2=1e-3, liquidDensityKgM3=700, liquidHeadM=4.5, pressureAboveLiquidPa=3e5)),
        ('rounded-orifice', dict(dischargeCoefficient=0.96, holeDiameterM=0.05, liquidDensityKgM3=850, liquidHeadM=2.0)),
    ]:
        d = args.get('holeDiameterM') or math.sqrt(4 * args['holeAreaM2'] / math.pi)
        qq = liquid(args['dischargeCoefficient'], d, args['liquidDensityKgM3'], args['liquidHeadM'], args.get('pressureAboveLiquidPa', ATM))
        c = {'id': cid, 'source': der('illustrative inputs'), 'args': args, 'expected': {'massRateKgS': qq}}
        if args.get('pressureAboveLiquidPa', ATM) == ATM:
            c['routeB'] = liquid_torricelli(args['dischargeCoefficient'], d, args['liquidDensityKgM3'], args['liquidHeadM'])
        liq.append(c)
    # Table 2.8 row 0 does NOT reproduce (erratum): record it
    table28 = {'printedT0MassRateKgS': 60.915, 'printedT0LevelM': 11.20, 'bernoulliAtThatLevel': liquid(0.62, 0.1, 812.5, 11.20)}

    # ---------------- gas
    gas = []
    h2 = dict(dischargeCoefficient=0.62, holeDiameterM=0.1, upstreamPressurePa=50e5, upstreamTemperatureK=288.15,
              molarMassKgMol=0.002016, heatCapacityRatio=1.405)
    qh, crit, psi = gas_yb(0.62, 0.1, 50e5, 288.15, 0.002016, 1.405)
    gas.append({'id': 'yb-hydrogen-t0', 'source': pub(YB + ' 2.6.2.1 / Table 2.3: hydrogen 50 bar, 288.15 K, d 0.1 m, Cd 0.62, printed 15.31 kg/s at t = 0; gamma NOT printed, 1.405 inferred (1.40 gives 15.29)'),
                'args': h2, 'expected': {'massRateKgS': qh, 'choked': crit}, 'printed': 15.31, 'printedDecimals': 2,
                'routeB': gas_nozzle(0.62, 0.1, 50e5, 288.15, 0.002016, 1.405)})
    for cid, args in [
        ('methane-choked', dict(dischargeCoefficient=0.62, holeDiameterM=0.025, upstreamPressurePa=70e5, upstreamTemperatureK=300, molarMassKgMol=0.016043, heatCapacityRatio=1.31)),
        ('nitrogen-subsonic', dict(dischargeCoefficient=0.62, holeDiameterM=0.01, upstreamPressurePa=1.5e5, upstreamTemperatureK=293.15, molarMassKgMol=0.028013, heatCapacityRatio=1.4)),
        ('air-barely-subsonic', dict(dischargeCoefficient=0.8, holeDiameterM=0.02, upstreamPressurePa=1.9e5, upstreamTemperatureK=293.15, molarMassKgMol=0.028965, heatCapacityRatio=1.4)),
        ('air-barely-choked', dict(dischargeCoefficient=0.8, holeDiameterM=0.02, upstreamPressurePa=1.92e5, upstreamTemperatureK=293.15, molarMassKgMol=0.028965, heatCapacityRatio=1.4)),
        ('co2-high-gamma-low', dict(dischargeCoefficient=1.0, holeAreaM2=2e-4, upstreamPressurePa=4e5, upstreamTemperatureK=310, molarMassKgMol=0.04401, heatCapacityRatio=1.29, ambientPressurePa=2.5e5)),
    ]:
        d = args.get('holeDiameterM') or math.sqrt(4 * args['holeAreaM2'] / math.pi)
        qq, cc, ps = gas_yb(args['dischargeCoefficient'], d, args['upstreamPressurePa'], args['upstreamTemperatureK'],
                            args['molarMassKgMol'], args['heatCapacityRatio'], args.get('ambientPressurePa', ATM))
        gas.append({'id': cid, 'source': der('illustrative inputs'), 'args': args,
                    'expected': {'massRateKgS': qq, 'choked': cc, 'outflowCoefficientPsi': ps},
                    'routeB': gas_nozzle(args['dischargeCoefficient'], d, args['upstreamPressurePa'], args['upstreamTemperatureK'],
                                         args['molarMassKgMol'], args['heatCapacityRatio'], args.get('ambientPressurePa', ATM))})

    # ---------------- pools
    pools = []
    D = math.sqrt(4 * 28.3 / (math.pi * 0.02))
    pools.append({'id': 'yb-benzene-pool', 'source': pub(YB + ' 6.6.3: V 28.3 m3, delta 0.02 m, printed D = 42.445 m and A = 1415 m2'),
                  'args': {'spillVolumeM3': 28.3, 'poolThicknessM': 0.02},
                  'expected': {'areaM2': 28.3 / 0.02, 'equivalentDiameterM': D, 'containment': 'UNCONFINED_STATED_THICKNESS'},
                  'printed': {'equivalentDiameterM': 42.445, 'areaM2': 1415}})
    pools.append({'id': 'bund-confined', 'source': der('illustrative bund'), 'args': {'spillVolumeM3': 150, 'bundAreaM2': 900, 'bundWallHeightM': 1.2},
                  'expected': {'areaM2': 900, 'depthM': 150 / 900, 'equivalentDiameterM': math.sqrt(4 * 900 / math.pi), 'containment': 'CONFINED'}})
    pools.append({'id': 'bund-exactly-full', 'source': der('depth equal to the wall height is still confined'), 'args': {'spillVolumeM3': 1080, 'bundAreaM2': 900, 'bundWallHeightM': 1.2},
                  'expected': {'areaM2': 900, 'depthM': 1.2, 'equivalentDiameterM': math.sqrt(4 * 900 / math.pi), 'containment': 'CONFINED'}})

    # ---------------- evaporation (single route)
    evap = []
    for cid, d, u, pv, mw, t, sc in [('hexane-10m', 10.0, 5.0, 16000.0, 0.08618, 293.15, 0.8),
                                      ('toluene-3m', 3.0, 2.0, 2900.0, 0.09214, 293.15, 0.8),
                                      ('methanol-sc', 20.0, 8.0, 13000.0, 0.03204, 293.15, 1.2)]:
        km = 0.004786 * u ** 0.78 * d ** -0.11 * sc ** -0.67
        fl = km * pv * mw / (R * t)
        evap.append({'id': cid, 'source': der('Mackay and Matsugu per YB 3.24; illustrative properties'),
                     'args': {'poolDiameterM': d, 'windSpeed10mMS': u, 'vapourPressurePa': pv, 'molarMassKgMol': mw, 'liquidTemperatureK': t, 'schmidtNumber': sc},
                     'expected': {'massTransferCoefficientMS': km, 'evaporationFluxKgM2S': fl, 'evaporationRateKgS': fl * math.pi * d * d / 4}})

    # ---------------- sigmas and plume
    sigmas = []
    for cls in 'ABCDEF':
        for x in (50.0, 100.0, 500.0, 1000.0, 5000.0, 10000.0, 20000.0):
            sy, sz = sig(cls, x)
            sigmas.append({'stabilityClass': cls, 'downwindDistanceM': x, 'sigmaYM': sy, 'sigmaZM': sz, 'warning': x < 100 or x > 10000})
    plumes = []
    # PB Appendix 6.B CO case, sigmas as printed
    cpb = plume(100, 5, 28.8, 10.3, 0, 1, 1)
    plumes.append({'id': 'pb-co-361m', 'source': pub(PB + ' Appendix 6.B: Q 100 kg/s, u 5 m/s, h = z = 1 m, sigma_y 28.8 m, sigma_z 10.3 m (as printed), C = 21.3 g/m3'),
                   'args': {'massRateKgS': 100, 'windSpeedMS': 5, 'downwindDistanceM': 361, 'receptorHeightM': 1, 'releaseHeightM': 1, 'sigmaYM': 28.8, 'sigmaZM': 10.3},
                   'expected': {'concentrationKgM3': cpb}, 'printed': {'concentrationGM3': 21.3}, 'routeB': plume_mass_flux(100, 5, 28.8, 10.3, 1) / 100})
    for cid, args in [
        ('ground-D-1km', dict(massRateKgS=1.0, windSpeedMS=3.0, downwindDistanceM=1000, stabilityClass='D')),
        ('ground-F-500m', dict(massRateKgS=0.5, windSpeedMS=2.0, downwindDistanceM=500, stabilityClass='F')),
        ('ground-A-200m', dict(massRateKgS=2.0, windSpeedMS=1.5, downwindDistanceM=200, stabilityClass='A')),
        ('elevated-C-2km', dict(massRateKgS=5.0, windSpeedMS=4.0, downwindDistanceM=2000, stabilityClass='C', releaseHeightM=50)),
        ('offaxis-E-800m', dict(massRateKgS=1.0, windSpeedMS=2.5, downwindDistanceM=800, stabilityClass='E', crosswindDistanceM=40, receptorHeightM=2, releaseHeightM=10)),
        ('ppm-chlorine-D', dict(massRateKgS=1.0, windSpeedMS=3.0, downwindDistanceM=1500, stabilityClass='D', molarMassGMol=70.906, temperatureK=293.15)),
        ('below-100m-B', dict(massRateKgS=1.0, windSpeedMS=2.0, downwindDistanceM=60, stabilityClass='B')),
    ]:
        sy, sz = sig(args['stabilityClass'], args['downwindDistanceM'])
        c = plume(args['massRateKgS'], args['windSpeedMS'], sy, sz, args.get('crosswindDistanceM', 0), args.get('receptorHeightM', 0), args.get('releaseHeightM', 0))
        e = {'concentrationKgM3': c, 'sigmaYM': sy, 'sigmaZM': sz}
        if 'molarMassGMol' in args:
            e['concentrationPpm'] = c * 1e6 * (R * args['temperatureK'] / ATM * 1000) / args['molarMassGMol']
        plumes.append({'id': cid, 'source': der('Briggs rural sigmas, ALOHA Table 13'), 'args': args, 'expected': e,
                       'warning': args['downwindDistanceM'] < 100,
                       'routeB': plume_mass_flux(args['massRateKgS'], args['windSpeedMS'], sy, sz, args.get('releaseHeightM', 0)) / args['massRateKgS']})

    dists = []
    for cid, args in [
        ('D-ground-100mg', dict(massRateKgS=1.0, windSpeedMS=3.0, stabilityClass='D', targetConcentrationMgM3=100)),
        ('F-ground-50mg', dict(massRateKgS=0.5, windSpeedMS=2.0, stabilityClass='F', targetConcentrationMgM3=50)),
        ('D-elevated-two-roots', dict(massRateKgS=1.0, windSpeedMS=3.0, stabilityClass='D', releaseHeightM=30, targetConcentrationMgM3=1)),
        ('D-elevated-not-reached', dict(massRateKgS=1.0, windSpeedMS=3.0, stabilityClass='D', releaseHeightM=100, targetConcentrationMgM3=1000)),
        ('F-beyond-range', dict(massRateKgS=50.0, windSpeedMS=1.0, stabilityClass='F', targetConcentrationMgM3=0.1)),
    ]:
        cls = args['stabilityClass']
        h = args.get('releaseHeightM', 0)
        f = lambda x: 1e6 * plume(args['massRateKgS'], args['windSpeedMS'], *sig(cls, x), 0, 0, h)
        lo, hi = 1.0, 1e5
        res = optimize.minimize_scalar(lambda lx: -f(math.exp(lx)), bounds=(math.log(lo), math.log(hi)), method='bounded', options={'xatol': 1e-12})
        px = math.exp(res.x)
        if f(lo) >= f(px):
            px = lo
        pk = f(px)
        tgt = args['targetConcentrationMgM3']
        e = {'peakConcentrationMgM3': pk}
        if pk < tgt:
            e.update(state='NOT_REACHED', nearDistanceM=None, farDistanceM=None)
        else:
            far = None if f(hi) >= tgt else optimize.brentq(lambda x: f(x) - tgt, px, hi, xtol=1e-13, rtol=1e-14)
            near = optimize.brentq(lambda x: f(x) - tgt, lo, px, xtol=1e-13, rtol=1e-14) if (px > lo and f(lo) < tgt) else None
            e.update(state='REACHED' if far is not None else 'BEYOND_SEARCH_RANGE', nearDistanceM=near, farDistanceM=far)
        dists.append({'id': cid, 'source': der('brentq on the reflected plume, Briggs rural'), 'args': args, 'expected': e})

    conv = []
    for mw in (17.031, 34.08, 70.906, 92.14, 28.01):
        conv.append({'id': 'ccohs-%g' % mw, 'source': pub('CCOHS: mg/m3 = ppm x MW / 24.45 at 25 C, 760 torr; engine uses R T / P = 24.465 L/mol, gate 0.1 percent'),
                     'args': {'concentrationPpm': 100.0, 'molarMassGMol': mw}, 'printed': 100.0 * mw / 24.45,
                     'expected': {'concentrationMgM3': ppm_to_mg(100.0, mw)}})
    conv.append({'id': 'hot-low-pressure', 'source': der('ideal gas at 350 K, 90 kPa'), 'args': {'concentrationPpm': 250.0, 'molarMassGMol': 64.066, 'temperatureK': 350.0, 'pressurePa': 90000.0},
                 'expected': {'concentrationMgM3': ppm_to_mg(250.0, 64.066, 350.0, 90000.0)}})

    # ---------------- fires
    D = math.sqrt(4 * 28.3 / (math.pi * 0.02))
    m2 = 0.085 * (1 - math.exp(-2.7 * D))
    ld, uc, us = thomas_wind(D, m2, 5.0, 1.2243)
    th, fr, re, cc = tilt(D, 5.0, 7.5133e-6)
    sep_m = 140e3 * math.exp(-0.12 * D) + 20e3 * (1 - math.exp(-0.12 * D))
    sep_max = 0.40 * m2 * 4.015e7 / (1 + 4 * ld)
    sep_act = sep_max * 0.2 + 20e3 * 0.8
    fv, fh = mudan_tilted(ld * D / (D / 2), 100 / (D / 2), math.radians(th))
    yb_pool = {
        'id': 'yb-benzene-pool-fire', 'source': pub(YB + ' 6.6.3 steps 1 to 13 (benzene, confined, u10 5 m/s, X 100 m from the centre, tau 0.71474 from Hottel charts)'),
        'args': {'poolDiameterM': D, 'burningFluxKgM2S': m2, 'heatOfCombustionJKg': 4.015e7, 'flameLengthMethod': 'thomas-wind', 'airDensityKgM3': 1.2243,
                 'windSpeed10mMS': 5.0, 'airKinematicViscosityM2S': 7.5133e-6,
                 'sep': {'method': 'radiative-fraction-soot', 'radiativeFraction': 0.4, 'sootFraction': 0.8}, 'distanceFromCentreM': 100.0, 'transmissivity': 0.71474},
        'expected': {'flameLengthM': ld * D, 'tiltDeg': th, 'surfaceEmissivePowerWM2': sep_act, 'viewFactorVertical': fv, 'viewFactorHorizontal': fh,
                     'viewFactorMax': math.hypot(fv, fh), 'heatFluxWM2': sep_act * math.hypot(fv, fh) * 0.71474},
        'intermediate': {'characteristicWindSpeedMS': uc, 'scaledWindSpeed': us, 'lengthToDiameter': ld, 'froudeNumber': fr, 'reynoldsNumber': re, 'tiltParameter': cc,
                         'sepMudan': sep_m, 'sepMax': sep_max},
        'printed': {'equivalentDiameterM': 42.445, 'characteristicWindSpeedMS': 3.06866, 'scaledWindSpeed': 1.62937, 'lengthToDiameter': 1.101938, 'flameLengthM': 46.7725,
                    'froudeNumber': 0.0545, 'reynoldsNumber': 2.824e7, 'tiltParameter': 1.94315, 'tiltDeg': 50.8286, 'sepMudan': 21e3, 'sepMax': 25.24e4,
                    'sepAct': 6.6e4, 'viewFactorVertical': 0.091915, 'viewFactorHorizontal': 0.029146, 'viewFactorMax': 0.0964, 'heatFluxWM2': 4.581e3},
        'publishedRelTol': {'characteristicWindSpeedMS': 1e-4, 'scaledWindSpeed': 1e-4, 'lengthToDiameter': 1e-4, 'flameLengthM': 1e-4, 'reynoldsNumber': 1e-3,
                            'tiltParameter': 1e-5, 'tiltDeg': 1e-5, 'sepMudan': 0.02, 'sepMax': 1e-3, 'sepAct': 0.01, 'viewFactorVertical': 1e-4,
                            'viewFactorHorizontal': 2e-4, 'viewFactorMax': 1e-3, 'heatFluxWM2': 1e-3},
        'errata': {'froudeNumber': 'printed 0.0545 is wrong: 5^2 / (9.80665 x 42.445) = %.5f, and the printed tan/cos 1.94315 and tilt 50.8286 follow only from %.5f' % (fr, fr)},
    }

    vfs = []
    vfs.append({'id': 'yb-pool-example-vf', 'source': pub(YB + ' 6.6.3 step 12: a 2.20396, b 4.712, tilt 50.8286 deg, printed Fv 0.091915, Fh 0.029146'),
                'args': {'flameRadiusM': 1.0, 'flameLengthM': 2.20396, 'distanceFromAxisM': 4.712, 'tiltDeg': 50.8286},
                'expected': dict(zip(('viewFactorVertical', 'viewFactorHorizontal'), mudan_tilted(2.20396, 4.712, math.radians(50.8286)))),
                'printed': {'viewFactorVertical': 0.091915, 'viewFactorHorizontal': 0.029146}, 'printedAbsTol': 2e-6})
    vfs.append({'id': 'yb-jet-example-vf', 'source': pub(YB + ' 6.6.2 step 29: a 11.18, b 14.43166, tilt 2.00843 deg, printed Fv 0.02665, Fh 0.00934'),
                'args': {'flameRadiusM': 1.0, 'flameLengthM': 11.18, 'distanceFromAxisM': 14.43166, 'tiltDeg': 2.00843},
                'expected': dict(zip(('viewFactorVertical', 'viewFactorHorizontal'), mudan_tilted(11.18, 14.43166, math.radians(2.00843)))),
                'printed': {'viewFactorVertical': 0.02665, 'viewFactorHorizontal': 0.00934}, 'printedAbsTol': 5e-6})
    # Table 6.A.1 (Raj, vertical cylinder), 1e3 x F, '-' cells omitted
    HR = [0.1, 0.2, 0.5, 1.0, 2.0, 3.0, 5.0, 6.0, 10.0, 20.0]
    FH = {1.1: [132, 242, 332, 354, 360, 362, 362, 362, 363, 363], 1.2: [44, 120, 243, 291, 307, 310, 312, 312, 313, 314],
          1.3: [20, 65, 178, 242, 268, 274, 277, 278, 278, 279], 1.4: [11, 38, 130, 203, 238, 246, 250, 251, 252, 253],
          1.5: [6, 24, 97, 170, 212, 222, 228, 229, 231, 232], 2.0: [1, 5, 27, 73, 126, 145, 158, 160, 164, 166],
          3.0: [None, None, 5, 19, 50, 71, 91, 95, 103, 107], 4.0: [None, None, 1, 7, 22, 38, 57, 62, 73, 78],
          5.0: [None, None, None, 3, 11, 21, 37, 43, 54, 61], 10.0: [None, None, None, None, 1, 3, 7, 9, 17, 26],
          20.0: [None, None, None, None, None, None, 1, 1, 3, 8]}
    FV = {1.1: [330, 415, 449, 453, 454, 454, 454, 454, 454, 455], 1.2: [196, 308, 397, 413, 416, 416, 416, 416, 416, 417],
          1.3: [130, 227, 344, 376, 383, 384, 384, 384, 384, 385], 1.4: [94, 173, 296, 342, 354, 356, 356, 357, 357, 357],
          1.5: [71, 135, 253, 312, 329, 332, 333, 333, 333, 333], 2.0: [28, 56, 126, 194, 236, 245, 248, 249, 249, 250],
          3.0: [9, 19, 47, 86, 132, 150, 161, 163, 165, 167], 4.0: [5, 10, 24, 47, 80, 100, 115, 119, 123, 125],
          5.0: [3, 6, 15, 29, 53, 69, 86, 91, 97, 100], 10.0: [None, 1, 3, 6, 13, 19, 29, 32, 42, 48],
          20.0: [None, None, None, 1, 3, 4, 7, 9, 14, 21]}
    FM = {1.1: [356, 481, 559, 575, 580, 581, 581, 581, 581, 581], 1.2: [210, 331, 466, 505, 517, 519, 520, 521, 521, 521],
          1.3: [132, 236, 387, 448, 468, 472, 474, 474, 475, 475], 1.4: [94, 117, 323, 398, 427, 433, 436, 436, 437, 437],
          1.5: [72, 138, 271, 355, 392, 400, 404, 404, 405, 406], 2.0: [28, 56, 129, 208, 267, 285, 294, 296, 299, 300],
          3.0: [9, 19, 48, 88, 141, 166, 185, 189, 195, 197], 4.0: [5, 10, 24, 47, 83, 106, 129, 134, 143, 147],
          5.0: [3, 6, 15, 29, 54, 73, 94, 100, 111, 117], 10.0: [None, 1, 3, 6, 13, 19, 30, 34, 45, 55],
          20.0: [None, None, None, 1, 3, 4, 7, 9, 14, 22]}
    table = []
    misprints = []
    for xr in FH:
        for j, hr in enumerate(HR):
            fv_, fh_ = raj_vertical(hr, xr)
            fm_ = math.hypot(fv_, fh_)
            for name, tab, val in (('Fh', FH, fh_), ('Fv', FV, fv_), ('Fmax', FM, fm_)):
                pr = tab[xr][j]
                if pr is None:
                    continue
                ok = abs(1e3 * val - pr) <= 1.0
                row = {'table': name, 'xr': xr, 'hr': hr, 'printed': pr, 'computed1e3': 1e3 * val}
                if ok:
                    table.append(row)
                else:
                    misprints.append(row)
    for cid, h, x, tdeg in [('vertical-h2-x2', 2.0, 2.0, 0.0), ('vertical-h5-x3', 5.0, 3.0, 0.0), ('tilt-40-toward', 3.0, 3.0, 40.0),
                            ('tilt-40-away', 3.0, 3.0, -40.0), ('tilt-60-away-close', 3.0, 2.2, -60.0), ('near-overhang', 3.0, 3.2, 45.0),
                            ('slender-far', 20.0, 20.0, 10.0)]:
        fv_, fh_ = mudan_tilted(h, x, math.radians(tdeg))
        vfs.append({'id': cid, 'source': der('Mudan tilted-cylinder closed form'), 'args': {'flameRadiusM': 2.5, 'flameLengthM': 2.5 * h, 'distanceFromAxisM': 2.5 * x, 'tiltDeg': tdeg},
                    'expected': {'viewFactorVertical': fv_, 'viewFactorHorizontal': fh_}})
    for c in vfs:
        a_ = c['args']
        rb = vf_numeric(a_['flameLengthM'] / a_['flameRadiusM'], a_['distanceFromAxisM'] / a_['flameRadiusM'], math.radians(a_['tiltDeg']))
        c['routeB'] = {'viewFactorVertical': rb[0], 'viewFactorHorizontal': rb[1]}
        c['expected']['viewFactorMax'] = math.hypot(c['expected']['viewFactorVertical'], c['expected']['viewFactorHorizontal'])
    # overhang: the closed form departs from route B; the engine refuses
    overhang = []
    for h, x, tdeg in [(2.0, 1.5, 30.0), (3.0, 2.5, 45.0), (3.0, 2.2, 60.0)]:
        cf = mudan_tilted(h, x, math.radians(tdeg))
        nb = vf_numeric(h, x, math.radians(tdeg))
        overhang.append({'a': h, 'b': x, 'tiltDeg': tdeg, 'closedFormFv': cf[0], 'routeBFv': nb[0], 'closedFormFh': cf[1], 'routeBFh': nb[1]})

    burning = []
    for fuel, mi, kb in [('gasoline', 0.055, 2.1), ('lng', 0.078, 1.1), ('methanol', 0.015, None), ('benzene', 0.085, 2.7)]:
        for d in (0.5, 2.0, 20.0):
            burning.append({'id': '%s-%g' % (fuel, d), 'source': pub(YB + ' Table 6.5 (Babrauskas 1983) coefficients; value by YB 6.66'),
                            'args': {'method': 'babrauskas', 'fuel': fuel, 'poolDiameterM': d},
                            'expected': {'burningFluxKgM2S': mi if kb is None else mi * (1 - math.exp(-kb * d))}})
    burning.append({'id': 'burgess-hexane', 'source': der('Burgess YB 6.67, illustrative hexane properties'),
                    'args': {'method': 'burgess', 'heatOfCombustionJKg': 4.47e7, 'heatOfVaporisationJKg': 3.35e5, 'liquidHeatCapacityJKgK': 2260, 'boilingPointK': 341.9, 'ambientTemperatureK': 293.15},
                    'expected': {'burningFluxKgM2S': 0.001 * 4.47e7 / (3.35e5 + 2260 * (341.9 - 293.15))}})
    burning.append({'id': 'burgess-at-boiling-point', 'source': der('Tb = Ta: no sensible heat term'),
                    'args': {'method': 'burgess', 'heatOfCombustionJKg': 4.6e7, 'heatOfVaporisationJKg': 4.26e5, 'liquidHeatCapacityJKgK': 2500, 'boilingPointK': 293.15, 'ambientTemperatureK': 293.15},
                    'expected': {'burningFluxKgM2S': 0.001 * 4.6e7 / 4.26e5}})

    flames = []
    for cid, d, m, rho, u, meth in [('still-gasoline-10m', 10.0, 0.055, 1.2, 0.0, 'thomas-still-air'), ('still-lng-30m', 30.0, 0.078, 1.2, 0.0, 'thomas-still-air'),
                                    ('still-rho-1.16', 5.0, 0.04, 1.16, 0.0, 'thomas-still-air'),
                                    ('wind-below-uc', 20.0, 0.055, 1.2, 1.0, 'thomas-wind'), ('wind-above-uc', 20.0, 0.055, 1.2, 8.0, 'thomas-wind')]:
        if meth == 'thomas-still-air':
            L = thomas_still(d, m, rho)
            e = {'flameLengthM': L}
        else:
            ld_, uc_, us_ = thomas_wind(d, m, u, rho)
            e = {'flameLengthM': ld_ * d, 'characteristicWindSpeedMS': uc_, 'scaledWindSpeed': us_}
        flames.append({'id': cid, 'source': der('Thomas (1963) still air; YB 6.12 to 6.14 with wind'),
                       'args': {'method': meth, 'poolDiameterM': d, 'burningFluxKgM2S': m, 'airDensityKgM3': rho, 'windSpeed10mMS': u}, 'expected': e})

    tilts = []
    for d, u, nu in [(10.0, 3.0, 1.5e-5), (42.445658856946196, 5.0, 7.5133e-6), (5.0, 12.0, 1.5e-5)]:
        th_, fr_, re_, c_ = tilt(d, u, nu)
        tilts.append({'id': 'tilt-%g-%g' % (d, u), 'source': der('YB 6.16, 6.68 to 6.70'), 'args': {'poolDiameterM': d, 'windSpeed10mMS': u, 'airKinematicViscosityM2S': nu},
                      'expected': {'tiltDeg': th_, 'froudeNumber': fr_, 'reynoldsNumber': re_}})

    taus = []
    for pw, x in [(1193.5, 10.0), (1193.5, 50.0), (1705.0, 58.0), (2000.0, 5.0), (1000.0, 100.0)]:
        pr = pw * x
        taus.append({'id': 'bagster-%g-%g' % (pw, x), 'source': der('Bagster YB 6.29; the endpoints 1e4 and 1e5 are inside'), 'args': {'waterVapourPartialPressurePa': pw, 'pathLengthM': x},
                     'expected': {'transmissivity': 2.02 * pr ** -0.09}})

    # ---------------- explosions
    tnt = []
    for cid, m, h, eta, e in [('propane-10t-3pct', 10000.0, 4.635e7, 0.03, 4.6e6), ('methane-1t-10pct', 1000.0, 5.0e7, 0.10, 4.68e6)]:
        tnt.append({'id': cid, 'source': der('YB 5.1, illustrative'), 'args': {'fuelMassKg': m, 'heatOfCombustionJKg': h, 'yieldFactor': eta, 'tntBlastEnergyJKg': e},
                    'expected': {'tntMassKg': eta * m * h / e}})
    kg = []
    for w, rr, pr in [(1.0, 5.0, 29.24), (0.5, 5.0, 19.63), (0.1, 5.0, 9.066), (0.1, 2.0, 38.71), (0.1, 1.0, 174.87)]:
        z = rr / w ** (1 / 3)
        kg.append({'id': 'cbu-%gkg-%gm' % (w, rr), 'source': pub('CBU International Conference 2020 (Prague) Tables 1 and 2, column "Kinney", 101.325 kPa; the paper prints the formula with 800 and 0.049, but its column reproduces 808 and 0.048'),
                   'args': {'distanceM': rr, 'tntMassKg': w}, 'expected': {'scaledDistanceMKg13': z, 'overpressurePa': kg_ratio(z) * ATM}, 'printedKPa': pr, 'publishedRelTol': 5e-4})
    for z in (0.05, 0.3, 1.0, 3.0, 10.0, 25.0, 40.0):
        kg.append({'id': 'z-%g' % z, 'source': der('Kinney and Graham closed form'), 'args': {'scaledDistanceMKg13': z}, 'expected': {'overpressureRatio': kg_ratio(z), 'overpressurePa': kg_ratio(z) * ATM}})
    zs = np.geomspace(0.05, 40, 20001)
    mono = bool(all(kg_ratio(zs[i + 1]) < kg_ratio(zs[i]) for i in range(len(zs) - 1)))
    kginv = []
    for w, p in [(100.0, 6894.757293168361), (100.0, 20684.271879505083), (1000.0, 3447.3786465841804), (5.0, 1e5)]:
        z = optimize.brentq(lambda zz: kg_ratio(zz) - p / ATM, 0.05, 40, xtol=1e-14, rtol=1e-14)
        kginv.append({'id': 'inv-%gkg-%gPa' % (w, round(p)), 'source': der('brentq on Kinney and Graham'), 'args': {'tntMassKg': w, 'overpressurePa': p},
                      'expected': {'scaledDistanceMKg13': z, 'distanceM': z * w ** (1 / 3)}})

    # ---------------- probits
    t51 = []
    grid = [[None, 2.67, 2.95, 3.12, 3.25, 3.36, 3.45, 3.52, 3.59, 3.66], [3.72, 3.77, 3.82, 3.87, 3.92, 3.96, 4.01, 4.05, 4.08, 4.12],
            [4.16, 4.19, 4.23, 4.26, 4.29, 4.33, 4.36, 4.39, 4.42, 4.45], [4.48, 4.50, 4.53, 4.56, 4.59, 4.61, 4.64, 4.67, 4.69, 4.72],
            [4.75, 4.77, 4.80, 4.82, 4.85, 4.87, 4.90, 4.92, 4.95, 4.97], [5.00, 5.03, 5.05, 5.08, 5.10, 5.13, 5.15, 5.18, 5.20, 5.23],
            [5.25, 5.28, 5.31, 5.33, 5.36, 5.39, 5.41, 5.44, 5.47, 5.50], [5.52, 5.55, 5.58, 5.61, 5.64, 5.67, 5.71, 5.74, 5.77, 5.81],
            [5.84, 5.88, 5.92, 5.95, 5.99, 6.04, 6.08, 6.13, 6.18, 6.23], [6.28, 6.34, 6.41, 6.48, 6.55, 6.64, 6.75, 6.88, 7.05, 7.33]]
    t51_bad = []
    for i in range(10):
        for j in range(10):
            pr = grid[i][j]
            if pr is None:
                continue
            p = round(0.1 * i + 0.01 * j, 2)
            y = 5 + float(norm.ppf(p))
            rounded = round(y + 1e-12, 2)
            row = {'probability': p, 'printedProbit': pr, 'probit': y}
            (t51 if abs(rounded - pr) < 1e-9 else t51_bad).append(row)

    thermal = []
    for cid, pre, q, t in [('eisenberg-10kW-30s', 'eisenberg', 10e3, 30.0), ('eisenberg-35kW-20s', 'eisenberg', 35e3, 20.0),
                           ('tsao-perry-20kW-20s', 'tsao-perry', 20e3, 20.0), ('lees-12.5kW-60s', 'lees', 12.5e3, 60.0),
                           ('purple-book-20kW-20s', 'purple-book', 20e3, 20.0)]:
        a, b, unit = {'eisenberg': (-14.9, 2.56, 'kW'), 'tsao-perry': (-12.8, 2.56, 'kW'), 'lees': (-10.7, 1.99, 'kW'), 'purple-book': (-36.38, 2.56, 'W')}[pre]
        I = q / 1000 if unit == 'kW' else q
        y = a + b * math.log(t * I ** (4 / 3))
        thermal.append({'id': cid, 'source': der('OSD/30 Table 17 and PB 5.4 coefficients'), 'args': {'coefficients': pre, 'heatFluxWM2': q, 'exposureTimeS': t},
                        'expected': {'probit': y, 'probability': P(y)}})
    # the brief's W/m2 form of Eisenberg, -14.9 + 2.56 ln(t q^(4/3) / 1e4)
    brief_form = {'heatFluxWM2': 10e3, 'exposureTimeS': 30.0, 'probit': -14.9 + 2.56 * math.log(30.0 * (10e3) ** (4 / 3) / 1e4)}
    lethal = []
    for pre, a, b, ld1, ld50 in [('eisenberg', -14.9, 2.56, 960, 2380), ('tsao-perry', -12.8, 2.56, 420, 1046), ('lees', -10.7, 1.99, 828, 2670)]:
        v1 = math.exp((5 + float(norm.ppf(0.01)) - a) / b)
        v50 = math.exp((5 - a) / b)
        lethal.append({'id': pre, 'source': pub(OSD + ' Table 17, lethal thermal dose (kW/m2)^(4/3) s'), 'a': a, 'b': b, 'printed1': ld1, 'printed50': ld50,
                       'expected1': v1, 'expected50': v50, 'publishedRelTol': 5e-3})
    tno_osd = {'a': -15.3, 'b': 3.02, 'printed1': 389, 'printed50': 841, 'computed1': math.exp((5 + float(norm.ppf(0.01)) + 15.3) / 3.02), 'computed50': math.exp(20.3 / 3.02)}
    t18 = []
    T18 = {10: (0, 5, 39), 20: (1, 53, 93), 30: (11, 87, 100), 40: (31, 97, 100), 50: (53, 99, 100), 60: (71, 100, 100)}
    for t, row in T18.items():
        for I, pr in zip((10.0, 20.0, 30.0), row):
            y = -12.8 + 2.56 * math.log(t * I ** (4 / 3))
            t18.append({'exposureTimeS': t, 'heatFluxWM2': I * 1000, 'printedPercent': pr, 'percent': 100 * P(y)})

    toxic = []
    toxic.append({'id': 'pb-co-appendix-6b', 'source': pub(PB + ' Appendix 6.B step 4.3: CO 21,300 mg/m3, 30 min, printed Pr 5.97 and P 0.835 (read from Table 5.1)'),
                  'args': {'coefficients': 'pb-carbon-monoxide', 'concentrationMgM3': 21300.0, 'exposureMinutes': 30.0},
                  'expected': {'probit': -7.4 + math.log(21300.0 * 30.0), 'probability': P(-7.4 + math.log(21300.0 * 30.0))},
                  'printed': {'probit': 5.97, 'probability': 0.835}, 'printedProbabilityAbsTol': 0.002})
    toxic.append({'id': 'pb-chlorine-ppm-converted', 'source': der('PB chlorine (mg/m3) given ppm, converted at 25 C 1 atm'),
                  'args': {'coefficients': 'pb-chlorine', 'concentrationPpm': 50.0, 'exposureMinutes': 10.0, 'molarMassGMol': 70.906},
                  'expected': {'probit': -6.35 + 0.5 * math.log(ppm_to_mg(50.0, 70.906) ** 2.75 * 10.0)}})
    toxic.append({'id': 'lees-ammonia-ppm', 'source': der('Lees ammonia (ppm)'), 'args': {'coefficients': 'lees-ammonia', 'concentrationPpm': 12000.0, 'exposureMinutes': 20.0},
                  'expected': {'probit': -35.9 + 1.85 * math.log(12000.0 ** 2 * 20.0)}})
    for c in toxic:
        c['expected'].setdefault('probability', P(c['expected']['probit']))
    # OSD/30 Table 2 LC columns
    LEES = [('acrolein', -9.93, 2.05, 1.0, 93, 16, 291, 48), ('ammonia', -35.9, 1.85, 2.0, 15057, 6147, 28264, 11539),
            ('benzene', -109.78, 5.3, 2.0, 18096, 7388, 22545, 9204), ('carbon-monoxide', -37.98, 3.7, 1.0, 11810, 1968, 22169, 3695),
            ('chlorine', -8.29, 0.92, 2.0, 173, 71, 613, 250), ('hydrogen-chloride', -16.85, 2.0, 1.0, 3464, 577, 11106, 1851),
            ('hydrogen-sulphide', -31.42, 3.008, 1.43, 897, 256, 1543, 441), ('nitrogen-dioxide', -13.79, 1.4, 2.0, 160, 65, 367, 150),
            ('phosgene', -19.27, 3.686, 1.0, 77, 13, 145, 24), ('sulphur-dioxide', -15.67, 2.1, 1.0, 1241, 207, 3764, 627),
            ('toluene', -6.794, 0.41, 2.5, 5352, 2614, 51965, 25377), ('hydrogen-fluoride', -35.87, 3.354, 1.0, 19652, 3260, 39184, 6531),
            ('hydrogen-cyanide', -29.42, 3.008, 1.43, 564, 161, 969, 277)]
    lc = []
    lc_bad = []
    for name, a, b, n, l1_5, l1_30, l50_5, l50_30 in LEES:
        for p, t, pr in ((0.01, 5, l1_5), (0.01, 30, l1_30), (0.5, 5, l50_5), (0.5, 30, l50_30)):
            y = 5 + float(norm.ppf(p))
            c = (math.exp((y - a) / b) / t) ** (1 / n)
            row = {'preset': 'lees-' + name, 'probability': p, 'exposureMinutes': t, 'printedPpm': pr, 'ppm': c}
            (lc if abs(c / pr - 1) <= 0.01 or abs(c - pr) <= 1 else lc_bad).append(row)
    overp = []
    for p, printed_psig in [(0.01, 2.4), (0.5, 13.1), (0.95, 43.5)]:
        y = 5 + float(norm.ppf(p))
        overp.append({'probability': p, 'printedPsig': printed_psig, 'psig': math.exp((y - 1.47) / 1.37), 'publishedRelTol': 0.01})
    overp_cases = [{'id': 'hsc-5psi', 'source': der('HSC probit'), 'args': {'coefficients': 'hsc', 'overpressurePa': 5 * PSI},
                    'expected': {'probit': 1.47 + 1.37 * math.log(5.0), 'probability': P(1.47 + 1.37 * math.log(5.0))}}]

    refusals = [
        {'fn': 'liquidOrificeDischarge', 'args': {'dischargeCoefficient': 0.62, 'holeDiameterM': 0.1, 'liquidDensityKgM3': 800, 'liquidHeadM': -1}, 'field': 'liquidHeadM'},
        {'fn': 'liquidOrificeDischarge', 'args': {'dischargeCoefficient': 1.2, 'holeDiameterM': 0.1, 'liquidDensityKgM3': 800, 'liquidHeadM': 1}, 'field': 'dischargeCoefficient'},
        {'fn': 'liquidOrificeDischarge', 'args': {'dischargeCoefficient': 0.62, 'holeDiameterM': 0.1, 'liquidDensityKgM3': 800, 'liquidHeadM': 0}, 'field': 'pressureAboveLiquidPa'},
        {'fn': 'gasOrificeDischarge', 'args': {'dischargeCoefficient': 0.62, 'holeDiameterM': 0.01, 'upstreamPressurePa': ATM, 'upstreamTemperatureK': 300, 'molarMassKgMol': 0.028, 'heatCapacityRatio': 1.4}, 'field': 'upstreamPressurePa'},
        {'fn': 'gasOrificeDischarge', 'args': {'dischargeCoefficient': 0.62, 'holeDiameterM': 0.01, 'upstreamPressurePa': 5e5, 'upstreamTemperatureK': 300, 'molarMassKgMol': 0.028, 'heatCapacityRatio': 1.0}, 'field': 'heatCapacityRatio'},
        {'fn': 'gasOrificeDischarge', 'args': {'dischargeCoefficient': 0.62, 'holeDiameterM': -0.01, 'upstreamPressurePa': 5e5, 'upstreamTemperatureK': 300, 'molarMassKgMol': 0.028, 'heatCapacityRatio': 1.4}, 'field': 'holeDiameterM'},
        {'fn': 'poolFromSpill', 'args': {'spillVolumeM3': 1200, 'bundAreaM2': 900, 'bundWallHeightM': 1.2}, 'field': 'spillVolumeM3'},
        {'fn': 'poolFromSpill', 'args': {'spillVolumeM3': 10}, 'field': 'bundAreaM2'},
        {'fn': 'poolFromSpill', 'args': {'spillVolumeM3': -5, 'bundAreaM2': 100}, 'field': 'spillVolumeM3'},
        {'fn': 'poolEvaporationMackayMatsugu', 'args': {'poolDiameterM': 5, 'windSpeed10mMS': 3, 'vapourPressurePa': 120000, 'molarMassKgMol': 0.044, 'liquidTemperatureK': 231}, 'field': 'vapourPressurePa'},
        {'fn': 'poolEvaporationMackayMatsugu', 'args': {'poolDiameterM': 5, 'windSpeed10mMS': 0, 'vapourPressurePa': 1000, 'molarMassKgMol': 0.09, 'liquidTemperatureK': 293}, 'field': 'windSpeed10mMS'},
        {'fn': 'briggsRuralSigmas', 'args': {'stabilityClass': 'G', 'downwindDistanceM': 500}, 'field': 'stabilityClass'},
        {'fn': 'briggsRuralSigmas', 'args': {'downwindDistanceM': 500}, 'field': 'stabilityClass'},
        {'fn': 'gaussianPlume', 'args': {'massRateKgS': 1, 'windSpeedMS': 3, 'downwindDistanceM': 0, 'stabilityClass': 'D'}, 'field': 'downwindDistanceM'},
        {'fn': 'gaussianPlume', 'args': {'massRateKgS': 1, 'windSpeedMS': 0, 'downwindDistanceM': 100, 'stabilityClass': 'D'}, 'field': 'windSpeedMS'},
        {'fn': 'gaussianPlume', 'args': {'massRateKgS': -1, 'windSpeedMS': 3, 'downwindDistanceM': 100, 'stabilityClass': 'D'}, 'field': 'massRateKgS'},
        {'fn': 'gaussianPlume', 'args': {'massRateKgS': 1, 'windSpeedMS': 3, 'downwindDistanceM': 100, 'stabilityClass': 'D', 'sigmaYM': 5, 'sigmaZM': 3}, 'field': 'stabilityClass'},
        {'fn': 'cylinderViewFactor', 'args': {'flameRadiusM': 5, 'flameLengthM': 10, 'distanceFromAxisM': 5}, 'field': 'distanceFromAxisM'},
        {'fn': 'cylinderViewFactor', 'args': {'flameRadiusM': 1, 'flameLengthM': 3, 'distanceFromAxisM': 2.5, 'tiltDeg': 45}, 'field': 'tiltDeg'},
        {'fn': 'cylinderViewFactor', 'args': {'flameRadiusM': 1, 'flameLengthM': 3, 'distanceFromAxisM': 5, 'tiltDeg': 90}, 'field': 'tiltDeg'},
        {'fn': 'atmosphericTransmissivityBagster', 'args': {'waterVapourPartialPressurePa': 1193.5, 'pathLengthM': 100}, 'field': 'pathLengthM'},
        {'fn': 'atmosphericTransmissivityBagster', 'args': {'waterVapourPartialPressurePa': 1193.5, 'pathLengthM': 5}, 'field': 'pathLengthM'},
        {'fn': 'poolBurningRate', 'args': {'method': 'burgess', 'heatOfCombustionJKg': 5e7, 'heatOfVaporisationJKg': 5e5, 'liquidHeatCapacityJKgK': 3000, 'boilingPointK': 112, 'ambientTemperatureK': 288}, 'field': 'boilingPointK'},
        {'fn': 'poolBurningRate', 'args': {'method': 'babrauskas', 'fuel': 'diesel', 'poolDiameterM': 5}, 'field': 'fuel'},
        {'fn': 'kinneyGrahamOverpressure', 'args': {'scaledDistanceMKg13': 0.04}, 'field': 'scaledDistanceMKg13'},
        {'fn': 'kinneyGrahamOverpressure', 'args': {'scaledDistanceMKg13': 41}, 'field': 'scaledDistanceMKg13'},
        {'fn': 'kinneyGrahamOverpressure', 'args': {'distanceM': 0, 'tntMassKg': 1}, 'field': 'distanceM'},
        {'fn': 'kinneyGrahamOverpressure', 'args': {'distanceM': 10, 'tntMassKg': -1}, 'field': 'tntMassKg'},
        {'fn': 'distanceForOverpressure', 'args': {'tntMassKg': 1, 'overpressurePa': 100}, 'field': 'overpressurePa'},
        {'fn': 'tntEquivalentMass', 'args': {'fuelMassKg': 1000, 'heatOfCombustionJKg': 5e7, 'yieldFactor': 0.1, 'tntBlastEnergyJKg': 4680}, 'field': 'tntBlastEnergyJKg'},
        {'fn': 'tntEquivalentMass', 'args': {'fuelMassKg': 1000, 'heatOfCombustionJKg': 5e7, 'yieldFactor': 0, 'tntBlastEnergyJKg': 4.68e6}, 'field': 'yieldFactor'},
        {'fn': 'thermalProbit', 'args': {'coefficients': 'tno', 'heatFluxWM2': 1e4, 'exposureTimeS': 10}, 'field': 'coefficients'},
        {'fn': 'thermalProbit', 'args': {'coefficients': 'eisenberg', 'heatFluxWM2': 0, 'exposureTimeS': 10}, 'field': 'heatFluxWM2'},
        {'fn': 'toxicProbit', 'args': {'coefficients': 'pb-chlorine', 'concentrationPpm': 50, 'exposureMinutes': 10}, 'field': 'molarMassGMol'},
        {'fn': 'toxicProbit', 'args': {'coefficients': 'lees-chlorine', 'concentrationPpm': 50, 'concentrationMgM3': 145, 'exposureMinutes': 10}, 'field': 'concentrationPpm'},
    ]

    g.update({
        'sourceTerms': {'liquid': liq, 'gas': gas, 'pools': pools, 'evaporation': evap, 'erratumTable28': table28},
        'dispersion': {'briggsTable': {k: dict(zip(('sy1', 'sy2', 'sz1', 'sz2', 'sz3'), v)) for k, v in BRIGGS.items()},
                       'sigmas': sigmas, 'plume': plumes, 'distance': dists, 'conversions': conv},
        'fires': {'burningRate': burning, 'flameLength': flames, 'tilt': tilts, 'viewFactor': vfs, 'rajTable': table, 'rajTableMisprints': misprints,
                  'overhangDeparture': overhang, 'transmissivity': taus, 'ybPoolFire': yb_pool},
        'explosions': {'tnt': tnt, 'kinneyGraham': kg, 'kinneyGrahamMonotoneOnRange': mono, 'inverse': kginv},
        'probits': {'table51': t51, 'table51Misprints': t51_bad, 'thermal': thermal, 'briefEisenbergForm': brief_form, 'lethalDose': lethal,
                    'tnoOsdRowDoesNotReproduce': tno_osd, 'osdTable18': t18, 'toxic': toxic, 'leesLc': lc, 'leesLcMisprints': lc_bad,
                    'hscPrinted': overp, 'overpressure': overp_cases},
        'refusals': refusals,
    })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(g, fh, indent=1)
        fh.write('\n')

    # ------- report
    print('liquid yb: %.5f printed 58.44; torricelli %.12g' % (liq[0]['expected']['massRateKgS'], liq[0]['routeB']))
    print('table 2.8 t0: printed 60.915 at 11.20 m, Bernoulli gives %.4f' % table28['bernoulliAtThatLevel'])
    for c in gas:
        print('gas %-22s A=%.10g B=%.10g rel=%.2e choked=%s' % (c['id'], c['expected']['massRateKgS'], c['routeB'], c['routeB'] / c['expected']['massRateKgS'] - 1, c['expected']['choked']))
    for c in plumes:
        print('plume %-16s C=%.6g mass-flux ratio=%.12f' % (c['id'], c['expected']['concentrationKgM3'], c['routeB']))
    for c in dists:
        print('dist', c['id'], c['expected'])
    for c in vfs:
        print('vf %-20s Fv %.9f (B %.9f) Fh %.9f (B %.9f)' % (c['id'], c['expected']['viewFactorVertical'], c['routeB']['viewFactorVertical'],
                                                         c['expected']['viewFactorHorizontal'], c['routeB']['viewFactorHorizontal']))
    print('overhang departures:', [(o['a'], o['b'], o['tiltDeg'], round(o['closedFormFv'] - o['routeBFv'], 5)) for o in overhang])
    print('Raj table cells reproduced %d, misprints %s' % (len(table), misprints))
    print('yb pool fire', yb_pool['expected'], yb_pool['intermediate'])
    print('KG monotone on [0.05, 40]:', mono, [(c['id'], round(c['expected']['overpressurePa'] / 1000, 4), c.get('printedKPa')) for c in kg[:5]])
    print('Table 5.1 reproduced %d, misprints %s' % (len(t51), t51_bad))
    print('lethal', [(c['id'], round(c['expected1']), c['printed1'], round(c['expected50']), c['printed50']) for c in lethal], 'TNO row', tno_osd)
    print('table 18', [(r['exposureTimeS'], r['heatFluxWM2'], r['printedPercent'], round(r['percent'], 2)) for r in t18])
    print('Lees LC reproduced %d, misprints %s' % (len(lc), lc_bad))
    print('HSC', overp)
    print('wrote', os.path.relpath(OUT, ROOT))


if __name__ == '__main__':
    main()
