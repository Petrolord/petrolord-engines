#!/usr/bin/env python3
"""Independent oracle for the well cost & time engine (Drilling D11):
activity-based time-depth schedule, AFE cost rollup, the cumulative
cost-time accrual curve, the classic ADE ch.1 cost-per-depth formula,
the WellCostIQ-salvage benchmark suggestion, and the ANALYTIC mean /
variance identities for the linear Monte Carlo gate fixture. Emits
test-data/drilling/goldens/wellcost_cases.json.

Independence discipline: all arithmetic re-derived here with explicit
sums (no shared code with the JS engine). Self-asserted BEFORE writing:

  time      hand well, productive hours exactly
            24+20+12+100+8+24+100+12+24+60 = 384 h; NPT stretch 12.5%
            -> 432 h = 18.000 days exactly; drilled 3000 m
  AFE       per-day (100k+60k)*18 = 2,880,000; per-meter 150*3000 =
            450,000; lumps 800k+250k+300k+200k+500k; tangible
            1,050,000 / intangible 4,330,000 / base 5,380,000;
            10% contingency 538,000 -> total 5,918,000 USD exactly
  curve     cost-time endpoint == base subtotal (identity); hand
            checkpoint at the end of the 2000 m casing activity
            (t = 211.5 h stretched): 160000*211.5/24 + 150*2000
            + 550,000 lumps = 2,260,000 USD exactly
  cost/m    (50,000 + 6,000*(100+4+16)) / 1000 = 770 USD/m (ADE ch.1
            form; the published worked example is the ARMED gate L21)
  MC        linear fixture: cost = 5000*(100 + X1+X2+X3) + L + 500,000
            with triangular X_i and L; mean = 5000*162 + 220,000
            + 500,000 = 1,530,000 USD; variance by the exact
            triangular formula (a^2+m^2+b^2-am-ab-mb)/18 summed --
            the suite gate A33 must reproduce both with the CANONICAL
            sampler (seeded) within CLT tolerance

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_wellcost.py
"""
from fractions import Fraction as F

from oracle_torquedrag import write  # noqa: F401

HOURS_PER_DAY = 24

# ------------------------------------------------------- deterministic well

NPT_FRAC = 0.125

ACTIVITIES = [
    dict(id='a1', kind='flat', label='Rig move and spud', durationHr=24),
    dict(id='a2', kind='drill', label='Drill 26in surface hole',
         fromMdM=0, toMdM=500, ropMPerHr=25),
    dict(id='a3', kind='casing', label='Run and cement 20in casing',
         mdM=500, runSpeedMPerHr=500, flatHr=11),
    dict(id='a4', kind='drill', label='Drill 17.5in intermediate hole',
         fromMdM=500, toMdM=2000, ropMPerHr=15),
    dict(id='a5', kind='trip', label='Round trip at 2000 m',
         mdM=2000, tripSpeedMPerHr=500),
    dict(id='a6', kind='casing', label='Run and cement 13-3/8in casing',
         mdM=2000, runSpeedMPerHr=400, flatHr=19),
    dict(id='a7', kind='drill', label='Drill 12.25in production hole',
         fromMdM=2000, toMdM=3000, ropMPerHr=10),
    dict(id='a8', kind='trip', label='Round trip at TD',
         mdM=3000, tripSpeedMPerHr=500),
    dict(id='a9', kind='casing', label='Run and cement 9-5/8in casing',
         mdM=3000, runSpeedMPerHr=300, flatHr=14),
    dict(id='a10', kind='flat', label='Completion and handover', durationHr=60),
]


def productive_hr(a):
    if a['kind'] == 'drill':
        return F(a['toMdM'] - a['fromMdM'], 1) / a['ropMPerHr']
    if a['kind'] == 'trip':
        return F(2 * a['mdM'], 1) / a['tripSpeedMPerHr']
    if a['kind'] == 'casing':
        return F(a['mdM'], 1) / a['runSpeedMPerHr'] + a['flatHr']
    return F(a['durationHr'], 1)


def schedule(activities, npt_frac):
    stretch = 1 + F(npt_frac).limit_denominator(10**6)
    t = F(0)
    md = F(0)
    drilled = F(0)
    rows = []
    curve = [dict(tHr=0.0, mdM=0.0)]
    for a in activities:
        p = productive_hr(a)
        d = p * stretch
        if a['kind'] == 'drill':
            assert a['fromMdM'] == md, f"{a['id']} discontinuous"
            drilled += a['toMdM'] - a['fromMdM']
            md = F(a['toMdM'])
        t += d
        rows.append(dict(id=a['id'], productiveHr=float(p), durationHr=float(d),
                         endHr=float(t), endMdM=float(md), drilledToM=float(drilled)))
        curve.append(dict(tHr=float(t), mdM=float(md)))
    return rows, curve, t, drilled, md


ROWS, CURVE, TOTAL_HR, DRILLED_M, TD_MD = schedule(ACTIVITIES, NPT_FRAC)

# Hand checks: 384 productive hours, 432 total, 18.000 days.
PRODUCTIVE_HR = sum(F(r['productiveHr']).limit_denominator() for r in ROWS)
assert PRODUCTIVE_HR == 384
assert TOTAL_HR == 432
assert TOTAL_HR / HOURS_PER_DAY == 18
assert DRILLED_M == 3000 and TD_MD == 3000

# --------------------------------------------------------------- AFE costs

CONTINGENCY_FRAC = 0.10

COST_ITEMS = [
    dict(id='c1', label='Rig dayrate', category='intangible', basis='per-day', rate=100000),
    dict(id='c2', label='Integrated services spread', category='intangible', basis='per-day', rate=60000),
    dict(id='c3', label='Mud and consumables', category='intangible', basis='per-meter', rate=150),
    dict(id='c4', label='Casing and accessories', category='tangible', basis='lump', value=800000, atActivityId='a9'),
    dict(id='c5', label='Wellhead', category='tangible', basis='lump', value=250000, atActivityId='a3'),
    dict(id='c6', label='Cementing services', category='intangible', basis='lump', value=300000, atActivityId='a6'),
    dict(id='c7', label='Wireline logging', category='intangible', basis='lump', value=200000, atActivityId='a8'),
    dict(id='c8', label='Completion services', category='intangible', basis='lump', value=500000, atActivityId='a10'),
]

DAYS = TOTAL_HR / HOURS_PER_DAY


def amount(it):
    if it['basis'] == 'per-day':
        return it['rate'] * DAYS
    if it['basis'] == 'per-meter':
        return it['rate'] * DRILLED_M
    return F(it['value'])


BY_ITEM = [dict(id=it['id'], amountUsd=float(amount(it))) for it in COST_ITEMS]
TANGIBLE = sum(amount(it) for it in COST_ITEMS if it['category'] == 'tangible')
INTANGIBLE = sum(amount(it) for it in COST_ITEMS if it['category'] == 'intangible')
BASE = TANGIBLE + INTANGIBLE
CONTINGENCY = F(CONTINGENCY_FRAC).limit_denominator() * BASE
TOTAL = BASE + CONTINGENCY

assert TANGIBLE == 1050000
assert INTANGIBLE == 2880000 + 450000 + 300000 + 200000 + 500000 == 4330000
assert BASE == 5380000
assert CONTINGENCY == 538000
assert TOTAL == 5918000

# ------------------------------------------------------ cost-time accrual

PER_DAY_RATE = sum(it['rate'] for it in COST_ITEMS if it['basis'] == 'per-day')
PER_M_RATE = sum(it['rate'] for it in COST_ITEMS if it['basis'] == 'per-meter')
END_BY_ID = {r['id']: (F(r['endHr']).limit_denominator(), F(r['drilledToM']).limit_denominator()) for r in ROWS}


def accrual_at(t_hr, drilled_m):
    lumps = sum(F(it['value']) for it in COST_ITEMS
                if it['basis'] == 'lump' and END_BY_ID[it['atActivityId']][0] <= t_hr)
    return F(PER_DAY_RATE) * t_hr / HOURS_PER_DAY + F(PER_M_RATE) * drilled_m + lumps


COST_CURVE = [dict(tHr=0.0, usd=float(accrual_at(F(0), F(0))))] + [
    dict(tHr=r['endHr'], usd=float(accrual_at(*END_BY_ID[r['id']]))) for r in ROWS
]

# Endpoint identity + the hand checkpoint at the end of a6.
assert accrual_at(*END_BY_ID['a10']) == BASE
A6 = END_BY_ID['a6']
assert A6[0] == F(423, 2)  # 211.5 h  (188 h productive * 1.125)
assert accrual_at(*A6) == 2260000

# ------------------------------------------------------------- cost per m

CPM_IN = dict(bitCostUsd=50000, rigRateUsdPerHr=6000,
              drillingHr=100, connectionHr=4, tripHr=16, intervalM=1000)
CPM = F(CPM_IN['bitCostUsd']
        + CPM_IN['rigRateUsdPerHr'] * (CPM_IN['drillingHr'] + CPM_IN['connectionHr'] + CPM_IN['tripHr']),
        CPM_IN['intervalM'])
assert CPM == 770

# ------------------------------------------------------------- benchmarks

# WellCostIQ salvage table: Gulf of Mexico / Offshore shelf / 3000 m.
BM_IN = dict(region='Gulf of Mexico', wellType='Offshore shelf', mdM=3000)
BM = dict(rigRateUsdPerDay=450000, spreadRateUsdPerDay=200000,
          dryHoleDays=9, bestInClassDays=8, indicative=True)
assert round(3000 * 0.003 * 1.0) == 9
assert round(9 * 0.85) == 8

# ------------------------------------------- linear Monte Carlo fixture


def tri_mean(a, m, b):
    return F(a + m + b, 3)


def tri_var(a, m, b):
    return F(a * a + m * m + b * b - a * m - a * b - m * b, 18)


X1, X2, X3 = (20, 30, 46), (10, 20, 24), (5, 10, 21)
L = (100000, 200000, 360000)

MC_PROGRAM = [
    dict(id='m1', kind='flat', label='Fixed operations', durationHr=100),
    dict(id='m2', kind='flat', label='Uncertain phase 1', durationHr=30),
    dict(id='m3', kind='flat', label='Uncertain phase 2', durationHr=20),
    dict(id='m4', kind='flat', label='Uncertain phase 3', durationHr=10),
]
MC_ITEMS = [
    dict(id='mc1', label='Spread rate', category='intangible', basis='per-day', rate=120000),
    dict(id='mc2', label='Uncertain lump', category='intangible', basis='lump', value=200000),
    dict(id='mc3', label='Fixed lump', category='tangible', basis='lump', value=500000),
]
MC_UNCERTAINTIES = [
    dict(target='activity', id='m2', field='durationHr',
         dist=dict(type='triangular', min=X1[0], mode=X1[1], max=X1[2])),
    dict(target='activity', id='m3', field='durationHr',
         dist=dict(type='triangular', min=X2[0], mode=X2[1], max=X2[2])),
    dict(target='activity', id='m4', field='durationHr',
         dist=dict(type='triangular', min=X3[0], mode=X3[1], max=X3[2])),
    dict(target='item', id='mc2', field='value',
         dist=dict(type='triangular', min=L[0], mode=L[1], max=L[2])),
]

RATE_PER_HR = F(120000, HOURS_PER_DAY)  # 5000 USD per stretched hour
MEAN_HR = 100 + tri_mean(*X1) + tri_mean(*X2) + tri_mean(*X3)
assert MEAN_HR == 162
MEAN_USD = RATE_PER_HR * MEAN_HR + tri_mean(*L) + 500000
assert MEAN_USD == 1530000
VAR_HR = tri_var(*X1) + tri_var(*X2) + tri_var(*X3)
assert VAR_HR == F(873, 18)  # 48.5
VAR_USD = RATE_PER_HR ** 2 * VAR_HR + tri_var(*L)
assert VAR_USD == 25_000_000 * F(873, 18) + tri_var(*L)
MEAN_DAYS = MEAN_HR / F(HOURS_PER_DAY)
VAR_DAYS = VAR_HR / F(HOURS_PER_DAY) ** 2


def main():
    write('wellcost_cases.json', {
        'description': 'Well cost & time oracle: activity schedule / '
                       'time-depth curve on the 3-section hand well '
                       '(384 productive h, 12.5% NPT -> 18.000 days), '
                       'the exact AFE rollup (base 5,380,000 / total '
                       '5,918,000 USD), the cost-time accrual curve '
                       'with its endpoint identity, the ADE ch.1 cost '
                       'per metre (770 USD/m), the WellCostIQ-salvage '
                       'benchmark suggestion, and analytic mean/var for '
                       'the linear MC gate fixture. JS engine must '
                       'agree rtol 1e-9; MC via the canonical suite '
                       'sampler within CLT tolerance.',
        'caseDoc': {
            'name': 'Golden Cost & Time',
            'program': {'activities': ACTIVITIES, 'nptFrac': NPT_FRAC},
            'costs': {'items': COST_ITEMS, 'contingencyFrac': CONTINGENCY_FRAC},
            'risk': {
                'iterations': 2000,
                'seed': 42,
                'uncertainties': [
                    dict(target='activity', id='a4', field='ropMPerHr',
                         dist=dict(type='triangular', min=10, mode=15, max=22)),
                    dict(target='activity', id='a7', field='ropMPerHr',
                         dist=dict(type='triangular', min=6, mode=10, max=14)),
                    dict(target='item', id='c1', field='rate',
                         dist=dict(type='triangular', min=85000, mode=100000, max=130000)),
                    dict(target='item', id='c8', field='value',
                         dist=dict(type='triangular', min=350000, mode=500000, max=800000)),
                ],
            },
        },
        'totals': {
            'productiveHr': float(PRODUCTIVE_HR),
            'nptHr': float(TOTAL_HR - PRODUCTIVE_HR),
            'totalHr': float(TOTAL_HR),
            'totalDays': float(DAYS),
            'drilledM': float(DRILLED_M),
            'tdMdM': float(TD_MD),
        },
        'rows': ROWS,
        'curve': CURVE,
        'afe': {
            'byItem': BY_ITEM,
            'tangibleUsd': float(TANGIBLE),
            'intangibleUsd': float(INTANGIBLE),
            'baseUsd': float(BASE),
            'contingencyUsd': float(CONTINGENCY),
            'totalUsd': float(TOTAL),
        },
        'costCurve': COST_CURVE,
        'costCurveCheckpoint': {'tHr': 211.5, 'usd': 2260000.0},
        'costPerMeter': {'inputs': CPM_IN, 'usdPerM': float(CPM)},
        'benchmark': {'inputs': BM_IN, 'suggestion': BM},
        'mc': {
            'program': {'activities': MC_PROGRAM, 'nptFrac': 0},
            'costs': {'items': MC_ITEMS, 'contingencyFrac': 0},
            'uncertainties': MC_UNCERTAINTIES,
            'analytic': {
                'meanUsd': float(MEAN_USD),
                'varUsd': float(VAR_USD),
                'sdUsd': float(VAR_USD) ** 0.5,
                'meanDays': float(MEAN_DAYS),
                'varDays': float(VAR_DAYS),
            },
        },
    })


if __name__ == '__main__':
    main()
