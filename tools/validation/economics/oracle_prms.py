#!/usr/bin/env python3
"""Independent stdlib oracle for engines/economics/prms.js (Economics EC11).

    python3 tools/validation/economics/oracle_prms.py

Writes test-data/economics/goldens/prms_cases.json. Reads no JavaScript and
imports nothing from the engines. Every rule is coded here from the published
texts (sources in FINDINGS-prms.md) by a different road:

  classify       the PRMS 2.1 decision list written out as data: discovery,
                 recovery project, the seven commerciality criteria and the
                 commitment of 2.1.2.1, the five-year benchmark of 2.1.2.3,
                 the sub-class gates of Table 1, Pc of 2.1.3.3, the PIA 2021
                 s.78 and s.79 notes.
  categorize     exact Fractions; incremental and cumulative forms built
                 from each other.
  economic limit an ANNUAL LEDGER on exact Fractions per case: revenue,
                 royalty, opex, capex, straight-line allowances, the loss
                 pool, tax, ADR at the last kept year; the trailing-year trim
                 (cut trailing years whose revenue less royalty less opex is
                 negative, never a year with capital) coded from the rule, and
                 the PRMS 3.1.3.1 peak of the cumulative pre-tax net cash flow
                 on the untrimmed ledger; NPV as an exact Fraction sum.
  aggregation    arithmetic sums and exact means on Fractions; the Monte
                 Carlo replayed with the stated sampler recipe (mulberry32,
                 Box-Muller, Cholesky, the Gaussian copula, the A&S erf, the
                 triangular inverse CDF, the triangular fit by bisection on
                 the mode position) and the simple-statistics quantile; a
                 correlated normal total gets its EXACT quantiles
                 (statistics.NormalDist) as a second witness.
  reconcile      exact Fractions, category by category.
Figures PRINTED inside a message: money rounded to the cent and computed
quantities to 6 decimal places, half away from zero with trailing zeros
dropped; a value within 1e-6 of a rounding tie stops the oracle.
"""
import json
import math
import os
import sys
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction as F
from statistics import NormalDist

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import oracle_jointventure as OJ  # noqa: E402  formatting and refusal helpers (the EC9 witness)
from oracle_screening import mulberry32, ss_quantile_sorted  # noqa: E402  bit-for-bit ports, reused

ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
FIX = os.path.join(ROOT, 'test-data', 'economics', 'ekene-prms', 'ekene-prms.json')
OUT = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'prms_cases.json')
js, js_num, isnum, show, unit = OJ.js, OJ.js_num, OJ.isnum, OJ.show, OJ.unit
Refusal, refuse, must = OJ.Refusal, OJ.refuse, OJ.must
OBJ, LST, check_keys = OJ.OBJ, OJ.LST, OJ.check_keys

CAPS = {'years': 100, 'projects': 50, 'iterations': 200000, 'work': 500000, 'movements': 50}
PSD_TOL = 1e-9
T_YEARS = 5          # PRMS 2.1.2.3
RETENTION_MAX = 10   # PIA 2021 s.78(9)
FDP_YEARS = 2        # PIA 2021 s.79(1)
# the standard normal 90th percentile to double precision (sqrt(2) erfinv(0.8) = 1.281551565544600467 by mpmath,
# whose nearest double is 1.2815515655446004); statistics.NormalDist is held to it within 1e-12
Z90 = 1.2815515655446004
assert abs(NormalDist().inv_cdf(0.9) - Z90) < 1e-12
EXCEEDANCE = 'P90 means a 90% probability the actual quantity meets or exceeds this value, per SPE PRMS.'


def has(d, k):
    return isinstance(d, dict) and k in d


def rounded(x, places, what):
    x = F(x)
    frac = (abs(x) * 10 ** places) % 1
    if abs(frac - F(1, 2)) < F(1, 10 ** 6):
        sys.exit(f'{what} figure {float(x)} is within 1e-6 of a rounding tie at {places} places: change the fixture')
    d = (Decimal(x.numerator) / Decimal(x.denominator)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    return js_num(float(d))


def money(x):
    return rounded(x, 2, 'money')


def dec(x):
    return rounded(x, 6, 'decimal')


def quote(xs):
    return ', '.join(f'"{o}"' for o in xs)


# ----------------------------------------------------------------- checkers
def non_neg(f, v):
    if not (isnum(v) and v >= 0):
        must(f, 'a finite number at or above 0', v)


def positive(f, v):
    if not (isnum(v) and v > 0):
        must(f, 'a finite number above 0', v)


def pct(f, v):
    if not (isnum(v) and 0 <= v <= 100):
        must(f, 'a number from 0 to 100', v)


def pct_pos(f, v):
    if not (isnum(v) and 0 < v <= 100):
        must(f, 'a number above 0 and at most 100', v)


def int_in(f, v, lo, hi):
    if not (isnum(v) and float(v).is_integer() and lo <= v <= hi):
        must(f, f'an integer from {lo} to {hi}', v)


def one_of(f, v, opts):
    if not isinstance(v, str) or v not in opts:
        must(f, 'one of ' + quote(opts), v)


def text(f, v):
    if not (isinstance(v, str) and v.strip() != ''):
        must(f, 'a non-empty string', v)


def boolean(f, v):
    if not isinstance(v, bool):
        must(f, 'true or false (stated; no default)', v)


def absent(f, d, k, why):
    if has(d, k):
        must(f, f'left out {why}', d[k])


def obj(f, v, what):
    if not isinstance(v, dict):
        must(f, f'an object {what}', v)


def list_of(f, v, cap, lo=1):
    if not isinstance(v, list) or len(v) < lo:
        must(f, f'an array of at least {unit(lo, "entry", "entries")}', v)
    if len(v) > cap:
        refuse(f, f'must have at most {cap} entries; got {len(v)}')
    for i, x in enumerate(v):
        if not isinstance(x, dict):
            must(f'{f}[{i}]', 'an object', x)


def get(d, k):
    return d[k] if has(d, k) else OJ.MISSING


def check_cum(f, v):
    obj(f, v, '{ low, best, high }')
    for k in ('low', 'best', 'high'):
        non_neg(f'{f}.{k}', get(v, k))
    if not (v['low'] <= v['best'] <= v['high']):
        must(f, f'ordered low <= best <= high (the P90 low estimate, the P50 best, the P10 high: {EXCEEDANCE})', v)


# -------------------------------------------------------------- accepted keys
CUM = OBJ(['low', 'best', 'high'])
YR = OBJ(['year', 'oil', 'gas'])
SHAPES = {
    'classify': OBJ(['name', 'discovery', 'recoveryProject', 'subClass', 'commerciality', 'economicStatus', 'projectStatus', 'reservesStatus', 'chances', 'nigeria'],
                    commerciality=OBJ(['developmentPlan', 'financialAppropriations', 'timeFrame', 'market', 'facilities', 'approvals', 'firmIntention'],
                                      timeFrame=OBJ(['startWithinYears', 'longerJustified'])),
                    projectStatus=OBJ(['finalInvestmentDecision', 'onProduction']), chances=OBJ(['geologicDiscoveryPct', 'developmentPct']),
                    nigeria=OBJ(['declaration', 'yearsSinceDeclaration'])),
    'categorize': OBJ(['resourceClass', 'method', 'estimates', 'unit'], estimates=OBJ(['low', 'best', 'high', 'first', 'second', 'third'])),
    'economicLimit': OBJ(['effectiveYear', 'forecasts', 'prices', 'costs', 'royalty', 'tax', 'workingInterestPct', 'licence', 'reportingBasis', 'discountRatePct', 'mscfPerBoe'],
                         forecasts=OBJ(['low', 'best', 'high'], low=LST(YR), best=LST(YR), high=LST(YR)), prices=LST(YR),
                         costs=OBJ(['opex', 'capex', 'abandonment'], opex=LST(OBJ(['year', 'amount'])), capex=LST(OBJ(['year', 'amount']))),
                         royalty=OBJ(['ratePct', 'form']), tax=OBJ(['ratePct', 'depreciationYears', 'lossCarryforward']), licence=OBJ(['expiryYear', 'renewalExpected'])),
    'aggregate': OBJ(['resourceClass', 'level', 'unit', 'projects', 'correlation', 'seed', 'iterations'],
                     projects=LST(OBJ(['id', 'name', 'distribution', 'estimates', 'chanceOfCommercialityPct'], distribution=OBJ(['type', 'min', 'mode', 'max', 'mean', 'stdDev']), estimates=CUM)),
                     correlation=OBJ(['type', 'rho', 'pairs'], pairs=LST(OBJ(['a', 'b', 'rho'])))),
    'reconcile': OBJ(['resourceClass', 'unit', 'periodYears', 'opening', 'movements', 'closing', 'tolerance'],
                     opening=CUM, closing=CUM, movements=LST(OBJ(['type', 'low', 'best', 'high', 'quantity', 'note']))),
}

CLASSES = {
    'reserves': {'name': 'Reserves', 'cum': {'low': '1P', 'best': '2P', 'high': '3P'},
                 'inc': {'first': 'Proved (P1)', 'second': 'Probable (P2)', 'third': 'Possible (P3)'}, 'short': ['P1', 'P2', 'P3'], 'section': 'PRMS 2.2.2.2'},
    'contingent': {'name': 'Contingent Resources', 'cum': {'low': '1C', 'best': '2C', 'high': '3C'},
                   'inc': {'first': 'C1', 'second': 'C2', 'third': 'C3'}, 'short': ['C1', 'C2', 'C3'], 'section': 'PRMS 2.2.2.3'},
    'prospective': {'name': 'Prospective Resources', 'cum': {'low': '1U', 'best': '2U', 'high': '3U'}, 'inc': None, 'short': None, 'section': 'PRMS 2.2.2.4'},
}
PROB = {'low': 'P90', 'best': 'P50', 'high': 'P10'}
SUB = {
    'reserves': ['on-production', 'approved-for-development', 'justified-for-development'],
    'contingent': ['development-pending', 'development-on-hold', 'development-unclarified', 'development-not-viable'],
    'prospective': ['prospect', 'lead', 'play'],
}


# ================================================================== classify
CRIT = [
    ('developmentPlan', '(1) a technically mature, feasible development plan', 'PRMS 2.1.2.1(1)'),
    ('financialAppropriations', '(2) financial appropriations in place or highly likely to be secured', 'PRMS 2.1.2.1(2), 2.1.2.4'),
    ('timeFrame', '(3) a reasonable time-frame for development', 'PRMS 2.1.2.1(3), 2.1.2.3'),
    ('economicStatus', '(4) positive economics (economic status "viable")', 'PRMS 2.1.2.1(4), 2.1.3.7.1'),
    ('market', '(5) a reasonable expectation of a market for the sales quantities', 'PRMS 2.1.2.1(5)'),
    ('facilities', '(6) production and transportation facilities available or can be made available', 'PRMS 2.1.2.1(6)'),
    ('approvals', '(7) legal, contractual, environmental, regulatory and government approvals in place or forthcoming', 'PRMS 2.1.2.1(7)'),
    ('firmIntention', "commitment: the entity's firm intention to proceed with development", 'PRMS 2.1.2.1, 2.1.2.3'),
]


def labels(key):
    if key is None:
        return None
    c = CLASSES[key]
    return {'cumulative': dict(c['cum']), 'incremental': dict(c['inc']) if c['inc'] else None}


def classify(a):
    if has(a, 'name'):
        text('name', a['name'])
    one_of('discovery', get(a, 'discovery'), ['discovered', 'undiscovered'])
    one_of('recoveryProject', get(a, 'recoveryProject'), ['established-technology', 'technology-under-development', 'none'])
    disc = a['discovery'] == 'discovered'
    reasons, decisions = [], []

    def decide(rule, section, outcome):
        decisions.append({'rule': rule, 'section': section, 'outcome': outcome})
        reasons.append(f'{rule}: {outcome} ({section})')
    decide('discovery', 'PRMS 2.1.1.1', 'discovered: a known accumulation' if disc else 'undiscovered: a potential accumulation')
    ng = get(a, 'nigeria')
    if has(a, 'nigeria'):
        if not disc:
            must('nigeria', 'left out for an undiscovered accumulation (PIA 2021 s.78(8) declarations follow a discovery)', ng)
        obj('nigeria', ng, '{ declaration, yearsSinceDeclaration }')
        one_of('nigeria.declaration', get(ng, 'declaration'), ['commercial-discovery', 'significant-crude-oil-discovery', 'significant-gas-discovery', 'no-interest'])
        non_neg('nigeria.yearsSinceDeclaration', get(ng, 'yearsSinceDeclaration'))

    def out(cls, key, **extra):
        r = {'class': cls, 'subClass': None, 'economicStatus': None, 'reservesStatus': None, 'chances': None, 'chanceOfCommercialityPct': None,
             'criteria': [], 'unmet': [], 'labels': labels(key), 'nigeria': None, 'decisions': decisions}
        r.update(extra)
        if has(a, 'nigeria'):
            yrs = ng['yearsSinceDeclaration']
            d = ng['declaration']
            if d == 'commercial-discovery':
                note = (f'commercial discovery declared (PIA 2021 s.78(8)(a)); a field development plan is due within {FDP_YEARS} years of the declaration (s.79(1)); '
                        f'{unit(yrs, "year")} since the declaration' + (': the two-year period has passed' if yrs > FDP_YEARS else ''))
            elif d == 'no-interest':
                note = 'discovery declared of no interest (PIA 2021 s.78(8)(c)); the Commission may require relinquishment of the parcels over the structure (s.78(15))'
            else:
                what = 'significant gas discovery' if d == 'significant-gas-discovery' else 'significant crude oil discovery'
                note = (f'{what} declared (PIA 2021 s.78(8)(b)): substantial and potentially commercial but not declarable as commercial (s.318); '
                        f'the licensee may retain the area for a period the Commission determines, at most {RETENTION_MAX} years from the declaration (s.78(9)), an approval being for at least 5 years onshore and in shallow water and 8 in deep water (Significant Crude Oil and Gas Discovery Regulations, 2023, reg. 6(3)); '
                        f'{unit(yrs, "year")} since the declaration'
                        + (': the retention period has ended, so the area is relinquished unless a commercial discovery was declared (s.78(13))' if yrs > RETENTION_MAX else ''))
            r['nigeria'] = {'declaration': d, 'yearsSinceDeclaration': yrs, 'notes': [note]}
            reasons.append(f'Nigeria: {note}')
        r['reasons'] = reasons
        return r

    if a['recoveryProject'] == 'none':
        why = 'for unrecoverable quantities (no recovery project applies)'
        for k in ('subClass', 'commerciality', 'economicStatus', 'projectStatus', 'reservesStatus', 'chances'):
            absent(k, a, k, why)
        cls = 'Discovered Unrecoverable' if disc else 'Undiscovered Unrecoverable'
        decide('recovery project', 'PRMS 2.1.0.1, 2.1.1.2', f'none applies with established technology or technology under development: {cls}')
        return out(cls, None)
    decide('recovery project', 'PRMS 2.1.0.1', 'a project with established technology applies' if a['recoveryProject'] == 'established-technology' else 'a project applies with technology under development')

    if not disc:
        why = 'for an undiscovered accumulation'
        absent('commerciality', a, 'commerciality', f'{why} (PRMS 2.1.2 tests discovered quantities)')
        absent('economicStatus', a, 'economicStatus', f'{why} (PRMS 2.1.3.7 applies to discovered projects)')
        absent('projectStatus', a, 'projectStatus', why)
        absent('reservesStatus', a, 'reservesStatus', why)
        one_of('subClass', get(a, 'subClass'), SUB['prospective'])
        ch = get(a, 'chances')
        obj('chances', ch, '{ geologicDiscoveryPct, developmentPct } for Prospective Resources (PRMS 2.1.3.2, 2.1.3.3)')
        pct('chances.geologicDiscoveryPct', get(ch, 'geologicDiscoveryPct'))
        pct('chances.developmentPct', get(ch, 'developmentPct'))
        pg, pd = ch['geologicDiscoveryPct'], ch['developmentPct']
        pc = F(pg) * F(pd) / 100
        decide('class', 'PRMS 2.1.0.1, Table 1', 'Prospective Resources')
        decide('sub-class', 'PRMS 2.1.3.5.9, Table 1', f"{a['subClass']} (stated)")
        decide('chance of commerciality', 'PRMS 2.1.3.3', f'Pc = Pg x Pd = {js(pg)}% x {js(pd)}% = {dec(pc)}%')
        return out('Prospective Resources', 'prospective', subClass=a['subClass'], chances={'geologicDiscoveryPct': pg, 'developmentPct': pd},
                   chanceOfCommercialityPct=float(pc))

    c = get(a, 'commerciality')
    obj('commerciality', c, '{ developmentPlan, financialAppropriations, timeFrame, market, facilities, approvals, firmIntention } for a discovered accumulation (PRMS 2.1.2.1; no default)')
    for k in ('developmentPlan', 'financialAppropriations'):
        boolean(f'commerciality.{k}', get(c, k))
    tf = get(c, 'timeFrame')
    obj('commerciality.timeFrame', tf, '{ startWithinYears, longerJustified } (PRMS 2.1.2.3)')
    non_neg('commerciality.timeFrame.startWithinYears', get(tf, 'startWithinYears'))
    boolean('commerciality.timeFrame.longerJustified', get(tf, 'longerJustified'))
    for k in ('market', 'facilities', 'approvals', 'firmIntention'):
        boolean(f'commerciality.{k}', get(c, k))
    one_of('economicStatus', get(a, 'economicStatus'), ['viable', 'not-viable', 'undetermined'])
    s = tf['startWithinYears']
    tf_met = s <= T_YEARS or tf['longerJustified']
    met = {'developmentPlan': c['developmentPlan'], 'financialAppropriations': c['financialAppropriations'], 'timeFrame': tf_met,
           'economicStatus': a['economicStatus'] == 'viable', 'market': c['market'], 'facilities': c['facilities'], 'approvals': c['approvals'],
           'firmIntention': c['firmIntention']}
    criteria = [{'criterion': k, 'what': w, 'section': sec, 'met': met[k]} for k, w, sec in CRIT]
    unmet = [x['criterion'] for x in criteria if not x['met']]
    tech = a['recoveryProject'] == 'established-technology'
    extra = ''
    if s > T_YEARS:
        extra = ', a longer time-frame stated as justified' if tf['longerJustified'] else ', no longer time-frame justified'
    reasons.append(f'time-frame: development starts within {unit(s, "year")} against the {T_YEARS}-year benchmark{extra}: {"met" if tf_met else "not met"} (PRMS 2.1.2.3)')
    for x in criteria:
        reasons.append(f"{x['what']}: {'met' if x['met'] else 'not met'} ({x['section']})")

    if not unmet and tech:
        if has(a, 'nigeria') and ng['declaration'] != 'commercial-discovery':
            must('nigeria.declaration', '"commercial-discovery" for a project that meets every commerciality criterion: a significant discovery cannot be declared commercial (PIA 2021 s.318) and a discovery of no interest is not being developed (s.78(8)(c))', ng['declaration'])
        ps = get(a, 'projectStatus')
        obj('projectStatus', ps, '{ finalInvestmentDecision, onProduction } for Reserves (PRMS 2.1.3.5, Table 1)')
        boolean('projectStatus.finalInvestmentDecision', get(ps, 'finalInvestmentDecision'))
        boolean('projectStatus.onProduction', get(ps, 'onProduction'))
        fid, prod = ps['finalInvestmentDecision'], ps['onProduction']
        if prod and not fid:
            must('projectStatus.finalInvestmentDecision', 'true for a project on production (a producing project has passed its investment decision)', fid)
        if prod:
            derived, why, sec = 'on-production', 'on production, selling petroleum to market', 'PRMS 2.1.3.5, Table 1'
        elif fid:
            derived, why, sec = 'approved-for-development', 'final investment decision taken; production yet to start', 'PRMS 2.1.3.5.5, Table 1'
        else:
            derived, why, sec = 'justified-for-development', 'no final investment decision yet', 'PRMS 2.1.3.5.4, Table 1'
        if get(a, 'subClass') != derived:
            must('subClass', f'"{derived}" for this project ({why}: {sec})', get(a, 'subClass'))
        one_of('reservesStatus', get(a, 'reservesStatus'), ['developed-producing', 'developed-non-producing', 'undeveloped'])
        absent('chances', a, 'chances', 'for Reserves (PRMS 2.1.3.3 requires a high degree of certainty in the chance of commerciality; no chance figure is carried)')
        if a['reservesStatus'] == 'developed-producing' and derived != 'on-production':
            must('reservesStatus', '"developed-non-producing" or "undeveloped" for a project that is not on production (developed producing reserves come from completion intervals open and producing, Table 2)', a['reservesStatus'])
        decide('class', 'PRMS 2.1.2.1, Table 1', 'Reserves: every commerciality criterion is met with established technology')
        decide('sub-class', sec, f'{derived}: {why}')
        decide('reserves status', 'PRMS 2.1.3.6, Table 2', f"{a['reservesStatus']} (stated)")
        return out('Reserves', 'reserves', subClass=derived, economicStatus=a['economicStatus'], reservesStatus=a['reservesStatus'], criteria=criteria, unmet=unmet)

    why = 'for Contingent Resources'
    absent('projectStatus', a, 'projectStatus', f'{why} (the project status that sets a Reserves sub-class, PRMS 2.1.3.5)')
    absent('reservesStatus', a, 'reservesStatus', f'{why} (PRMS 2.1.3.6 applies to Reserves)')
    blockers = ([] if tech else ['technology under development']) + unmet
    if get(a, 'subClass') not in SUB['contingent']:
        must('subClass', f"one of {quote(SUB['contingent'])} for Contingent Resources (not commercial: {', '.join(blockers)})", get(a, 'subClass'))
    ch = get(a, 'chances')
    obj('chances', ch, '{ developmentPct } for Contingent Resources (PRMS 2.1.3.3: Pc = Pd)')
    absent('chances.geologicDiscoveryPct', ch, 'geologicDiscoveryPct', 'for a discovered accumulation (the chance of geologic discovery applies to Prospective Resources, PRMS 2.1.3.2)')
    pct('chances.developmentPct', get(ch, 'developmentPct'))
    decide('class', 'PRMS 2.1.2.1, Table 1' if tech else 'PRMS Table 1 (Contingent Resources guidelines)', f"Contingent Resources: not commercial ({', '.join(blockers)})")
    decide('sub-class', 'PRMS 2.1.3.5.6, Table 1', f"{a['subClass']} (stated)")
    es = a['economicStatus']
    decide('economic status', 'PRMS 2.1.3.7', 'economically viable' if es == 'viable' else 'economically not viable' if es == 'not-viable' else 'undetermined')
    decide('chance of commerciality', 'PRMS 2.1.3.3', f"Pc = Pd = {js(ch['developmentPct'])}%")
    return out('Contingent Resources', 'contingent', subClass=a['subClass'], economicStatus=es, chances={'geologicDiscoveryPct': None, 'developmentPct': ch['developmentPct']},
               chanceOfCommercialityPct=ch['developmentPct'], criteria=criteria, unmet=blockers)


# ================================================================ categorize
def categorize(a):
    one_of('resourceClass', get(a, 'resourceClass'), list(CLASSES))
    one_of('method', get(a, 'method'), ['cumulative', 'incremental'])
    text('unit', get(a, 'unit'))
    C = CLASSES[a['resourceClass']]
    est = get(a, 'estimates')
    if a['method'] == 'incremental' and C['inc'] is None:
        must('method', '"cumulative" for Prospective Resources (PRMS 2.2.2.4 defines no incremental terms for them)', a['method'])
    if a['method'] == 'cumulative':
        obj('estimates', est, '{ low, best, high } for the cumulative method')
        for k in ('first', 'second', 'third'):
            absent(f'estimates.{k}', est, k, 'for the cumulative method (state low, best and high)')
        check_cum('estimates', est)
        cum = {k: F(est[k]) for k in ('low', 'best', 'high')}
        inc = {'first': cum['low'], 'second': cum['best'] - cum['low'], 'third': cum['high'] - cum['best']}
    else:
        obj('estimates', est, '{ first, second, third } for the incremental method')
        for k in ('low', 'best', 'high'):
            absent(f'estimates.{k}', est, k, 'for the incremental method (state first, second and third)')
        for k in ('first', 'second', 'third'):
            non_neg(f'estimates.{k}', get(est, k))
        inc = {k: F(est[k]) for k in ('first', 'second', 'third')}
        cum = {'low': inc['first'], 'best': inc['first'] + inc['second'], 'high': inc['first'] + inc['second'] + inc['third']}
    u = a['unit']
    cumulative = [{'case': k, 'label': C['cum'][k], 'probability': PROB[k], 'value': float(cum[k])} for k in ('low', 'best', 'high')]
    reasons = [f"{C['name']}, {a['method']} method ({C['section']}; PRMS 2.2.1.4, 2.2.2.1)"]
    for x in cumulative:
        reasons.append(f"{x['label']} ({x['case']} estimate, {x['probability']}: at least {x['probability'][1:]}% probability of being met or exceeded when probabilistic, PRMS 2.2.1.2): {dec(cum[x['case']])} {u}")
    if C['inc']:
        incremental = [{'label': C['inc'][k], 'value': float(inc[k])} for k in ('first', 'second', 'third')]
        s1, s2, s3 = C['short']
        L = C['cum']
        reasons.append('incremental: ' + ', '.join(f"{C['inc'][k]} {dec(inc[k])}" for k in ('first', 'second', 'third'))
                       + f" {u}; {L['low']} = {s1}, {L['best']} = {s1} + {s2}, {L['high']} = {s1} + {s2} + {s3}")
    else:
        incremental = None
        reasons.append('incremental: no terms are defined for Prospective Resources (PRMS 2.2.2.4)')
    single = cum['low'] == cum['high']
    if single:
        reasons.append('the low, best and high estimates are equal: a single value may describe the expected result (PRMS 2.2.1.3)')
    return {'resourceClass': C['name'], 'method': a['method'], 'unit': u, 'cumulative': cumulative, 'incremental': incremental,
            'exceedance': EXCEEDANCE, 'singleValue': single, 'reasons': reasons}


# ============================================================ economic limit
def check_year_rows(f, rows, y0, n, keys):
    list_of(f, rows, CAPS['years'])
    if n is not None and len(rows) != n:
        refuse(f, f'must have {unit(n, "row")}, one a year from {y0} to {y0 + n - 1}; got {len(rows)}')
    for i, r in enumerate(rows):
        if get(r, 'year') != y0 + i or isinstance(get(r, 'year'), bool):
            must(f'{f}[{i}].year', f'{y0 + i} (one row a year from {y0}, in order)', get(r, 'year'))
        for k in keys:
            non_neg(f'{f}[{i}].{k}', get(r, k))


def ledger(rows, prices, opex, capex, roy, tax, depr_years, loss_cf, adr, rate, y0, trim):
    """One case on exact Fractions. rows: production rows kept by the licence.
    Returns the limit year, the trailing years cut, the undiscounted net cash
    flow, the NPV and the PRMS peak year on the untrimmed ledger."""
    price = {p['year']: (F(p['oil']), F(p['gas'])) for p in prices}
    opx = {o['year']: F(o['amount']) for o in opex}
    cap = {c['year']: F(c['amount']) for c in capex}
    prod = {r['year']: (F(r['oil']), F(r['gas'])) for r in rows}
    last_prod = rows[-1]['year']
    years = sorted(set(prod) | set(cap) | {y for y in opx if y <= last_prod})
    R = F(roy) / 100

    def rev(y):
        o, g = prod.get(y, (F(0), F(0)))
        po, pg = price[y]
        return o * po + g * pg

    def noi(y):
        return rev(y) * (1 - R) - opx.get(y, F(0))
    # PRMS 3.1.3.1 on the untrimmed years: last year the cumulative peaks
    cum, peak, peak_year = F(0), None, None
    for y in years:
        cum += noi(y) - cap.get(y, F(0))
        if peak is None or cum >= peak:
            peak, peak_year = cum, y
    if not (peak > 0):
        peak_year = None
    kept = list(years)
    cut = 0
    if trim:
        nz = [y for y, v in cap.items() if v != 0]
        last_cap = max(nz) if nz else None
        while len(kept) > 1 and (last_cap is None or kept[-1] > last_cap) and noi(kept[-1]) < 0:
            kept.pop()
            cut += 1
    limit = kept[-1]
    depr = {}
    for cy, amt in cap.items():
        for y in range(cy, cy + depr_years):
            depr[y] = depr.get(y, F(0)) + amt / depr_years
    pool = F(0)
    total, pv = F(0), F(0)
    for y in kept:
        r = rev(y)
        royalty = r * R
        taxable = r - royalty - opx.get(y, F(0)) - depr.get(y, F(0))
        if loss_cf:
            if taxable < 0:
                pool += -taxable
                charge = F(0)
            else:
                use = min(pool, taxable)
                pool -= use
                charge = taxable - use
        else:
            charge = taxable
        t = max(F(0), charge * F(tax) / 100)
        ncf = r - royalty - opx.get(y, F(0)) - cap.get(y, F(0)) - t
        if y == limit:
            ncf -= F(adr)
        total += ncf
        pv += ncf / (1 + F(rate) / 100) ** (y - y0)
    return {'limit': limit, 'cut': cut, 'undiscounted': total, 'npv': pv, 'peak': peak_year}


def economic_limit(a):
    int_in('effectiveYear', get(a, 'effectiveYear'), 1900, 2200)
    y0 = a['effectiveYear']
    fc = get(a, 'forecasts')
    obj('forecasts', fc, '{ low, best, high }, each a technical production forecast (PRMS 2.2.2.8)')
    for k in ('low', 'best', 'high'):
        check_year_rows(f'forecasts.{k}', get(fc, k), y0, None, ['oil', 'gas'])
    n = max(len(fc[k]) for k in ('low', 'best', 'high'))
    nmin = min(len(fc[k]) for k in ('low', 'best', 'high'))
    check_year_rows('prices', get(a, 'prices'), y0, n, ['oil', 'gas'])
    costs = get(a, 'costs')
    obj('costs', costs, '{ opex, capex, abandonment }')
    list_of('costs.opex', get(costs, 'opex'), CAPS['years'])
    if len(costs['opex']) != n:
        refuse('costs.opex', f'must have {unit(n, "row")}, one a year from {y0} to {y0 + n - 1}; got {len(costs["opex"])}')
    for i, o in enumerate(costs['opex']):
        if get(o, 'year') != y0 + i:
            must(f'costs.opex[{i}].year', f'{y0 + i} (one row a year from {y0}, in order)', get(o, 'year'))
        non_neg(f'costs.opex[{i}].amount', get(o, 'amount'))
    list_of('costs.capex', get(costs, 'capex'), CAPS['years'], 0)
    seen = set()
    for i, c in enumerate(costs['capex']):
        int_in(f'costs.capex[{i}].year', get(c, 'year'), y0, y0 + nmin - 1)
        non_neg(f'costs.capex[{i}].amount', get(c, 'amount'))
        if c['year'] in seen:
            must(f'costs.capex[{i}].year', 'a year no other capex row has', c['year'])
        seen.add(c['year'])
    non_neg('costs.abandonment', get(costs, 'abandonment'))
    ry = get(a, 'royalty')
    obj('royalty', ry, '{ ratePct, form }')
    if not (isnum(get(ry, 'ratePct')) and 0 <= ry['ratePct'] < 100):
        must('royalty.ratePct', 'a number from 0 to below 100', get(ry, 'ratePct'))
    one_of('royalty.form', get(ry, 'form'), ['royalty-interest', 'production-tax'])
    tx = get(a, 'tax')
    obj('tax', tx, '{ ratePct, depreciationYears, lossCarryforward }')
    pct('tax.ratePct', get(tx, 'ratePct'))
    int_in('tax.depreciationYears', get(tx, 'depreciationYears'), 1, 50)
    boolean('tax.lossCarryforward', get(tx, 'lossCarryforward'))
    pct_pos('workingInterestPct', get(a, 'workingInterestPct'))
    lic = get(a, 'licence')
    obj('licence', lic, '{ expiryYear, renewalExpected }')
    int_in('licence.expiryYear', get(lic, 'expiryYear'), y0, 2300)
    boolean('licence.renewalExpected', get(lic, 'renewalExpected'))
    one_of('reportingBasis', get(a, 'reportingBasis'), ['gross', 'working-interest', 'net-entitlement'])
    if not (isnum(get(a, 'discountRatePct')) and 0 <= a['discountRatePct'] <= 100):
        must('discountRatePct', 'a number from 0 to 100', get(a, 'discountRatePct'))
    positive('mscfPerBoe', get(a, 'mscfPerBoe'))
    cutoff = None if lic['renewalExpected'] else lic['expiryYear']
    if cutoff is not None:
        for i, c in enumerate(costs['capex']):
            if c['year'] > cutoff:
                must(f'costs.capex[{i}].year', f'at most {cutoff}, the licence expiry, when no renewal is expected', c['year'])
    WI = F(a['workingInterestPct'])
    roy = ry['ratePct']
    vol_roy = F(roy) if ry['form'] == 'royalty-interest' else F(0)
    M = F(a['mscfPerBoe'])

    def q(o, g):
        return {'oil': o, 'gas': g, 'boe': o + g / M}

    def basis(x):
        if a['reportingBasis'] == 'gross':
            return x
        r = F(0) if a['reportingBasis'] == 'working-interest' else vol_roy
        f = WI / 100 * (1 - r / 100)
        return q(x['oil'] * f, x['gas'] * f)
    cases = {}
    for k in ('low', 'best', 'high'):
        allr = fc[k]
        rows = allr if cutoff is None else [r for r in allr if r['year'] <= cutoff]
        args = (rows, a['prices'], [o for o in costs['opex'] if o['year'] <= rows[-1]['year']], costs['capex'], roy, tx['ratePct'], tx['depreciationYears'],
                tx['lossCarryforward'], costs['abandonment'], a['discountRatePct'], y0)
        on = ledger(*args, trim=True)
        off = ledger(*args, trim=False)
        econ = on['undiscounted'] > 0
        span = [allr[0]['year'], allr[-1]['year']]
        if econ and off['peak'] != on['limit']:
            must(f'forecasts.{k}', f"a forecast on which the canonical economic limit (cashflow.ts: trailing years whose revenue less royalty less opex is negative are cut, years with capital kept) and the PRMS 3.1.3.1 limit (the year the cumulative net cash flow before tax and ADR peaks) agree; they give {on['limit']} and {'no positive peak' if off['peak'] is None else off['peak']}",
                 f'a {k} forecast from {span[0]} to {span[1]}')
        kept = [r for r in rows if r['year'] <= on['limit']]
        sm = lambda rs, key: sum((F(r[key]) for r in rs), F(0))  # noqa: E731
        cases[k] = {'span': span, 'cut_year': cutoff if cutoff is not None and allr[-1]['year'] > cutoff else None, 'on': on, 'econ': econ,
                    'tech': q(sm(allr, 'oil'), sm(allr, 'gas')), 'within': q(sm(rows, 'oil'), sm(rows, 'gas')), 'kept': q(sm(kept, 'oil'), sm(kept, 'gas'))}
    if cases['best']['econ'] and not cases['high']['econ']:
        must('forecasts.high', 'a forecast that is economic when the best case is (tested on the same costs and prices, PRMS 2.2.0.3: an undiscounted net cash flow above 0)', float(cases['high']['on']['undiscounted']))

    def fq(x):
        return {k: float(v) for k, v in x.items()}
    reasons, per = [], {}
    for k in ('low', 'best', 'high'):
        c = cases[k]
        on = c['on']
        per[k] = {
            'forecastYears': c['span'], 'licenceCutYear': c['cut_year'], 'economicLimitYear': on['limit'], 'yearsTrimmed': on['cut'],
            'undiscountedNetCashFlow': float(on['undiscounted']), 'undiscountedNetCashFlowShare': float(on['undiscounted'] * WI / 100),
            'npv': float(on['npv']), 'npvShare': float(on['npv'] * WI / 100), 'economic': c['econ'], 'technical': fq(c['tech']),
            'beyondLicence': fq(q(c['tech']['oil'] - c['within']['oil'], c['tech']['gas'] - c['within']['gas'])),
            'beyondEconomicLimit': fq(q(c['within']['oil'] - c['kept']['oil'], c['within']['gas'] - c['kept']['gas'])),
            'economicGross': fq(c['kept']), 'reported': fq(basis(c['kept'])),
        }
        cut = f", cut at the licence expiry {c['cut_year']} (no renewal expected)" if c['cut_year'] is not None else ''
        reasons.append(f"{k} case: forecast {c['span'][0]} to {c['span'][1]}{cut}; economic limit {on['limit']} ({unit(on['cut'], 'trailing year')} cut); "
                       f"undiscounted net cash flow {money(on['undiscounted'])} at 100%: {'economic' if c['econ'] else 'not economic'} (PRMS 3.1.2.1: above 0); "
                       f"within the limit {dec(c['kept']['oil'])} bbl oil and {dec(c['kept']['gas'])} Mscf gas gross")
    reserves = None
    if cases['best']['econ']:
        zero = q(F(0), F(0))
        low = basis(cases['low']['kept']) if cases['low']['econ'] else zero
        best = basis(cases['best']['kept'])
        high = basis(cases['high']['kept'])
        if low['boe'] > best['boe'] or best['boe'] > high['boe']:
            must('forecasts', f"forecasts whose truncated quantities are ordered low <= best <= high in BOE (here {dec(low['boe'])}, {dec(best['boe'])} and {dec(high['boe'])})", 'the stated forecasts')
        p2 = q(best['oil'] - low['oil'], best['gas'] - low['gas'])
        p3 = q(high['oil'] - best['oil'], high['gas'] - best['gas'])
        reserves = {'cumulative': {'1P': fq(low), '2P': fq(best), '3P': fq(high)}, 'incremental': {'P1': fq(low), 'P2': fq(p2), 'P3': fq(p3)},
                    'provedZero': not cases['low']['econ']}
        status = 'Reserves: the best case is economic (PRMS 2.1.2.2, 3.1.2.1)'
        reasons.append(status)
        if not cases['low']['econ']:
            reasons.append('the low case is not economic: 1P = 0 and the 2P and 3P estimates stand (PRMS 3.1.2.8; FAQ 3.3); the low case quantities sit inside 2P, never in 1C (FAQ 3.4, no split classification)')
        reasons.append(f"on the {a['reportingBasis']} basis: 1P {dec(low['boe'])}, 2P {dec(best['boe'])}, 3P {dec(high['boe'])} BOE at {js(a['mscfPerBoe'])} Mscf per BOE (supplementary, PRMS 3.2.9.3); P2 {dec(p2['boe'])}, P3 {dec(p3['boe'])}")
    else:
        status = 'not commercial: the best case fails the economic test (PRMS 2.1.2.2, 3.1.2.1); the project stays in Contingent Resources, economically not viable (PRMS 2.1.3.7.1)'
        reasons.append(status)
    if a['reportingBasis'] == 'net-entitlement':
        wi_s, roy_s = js(a['workingInterestPct']), js(roy)
        reasons.append(f'net entitlement: {wi_s}% working interest less the {roy_s}% royalty interest (PRMS 3.3.1.1)' if ry['form'] == 'royalty-interest'
                       else f'net entitlement: {wi_s}% working interest; the {roy_s}% payment is a production tax, so no volume is deducted (PRMS 3.3.1.2)')
    return {'effectiveYear': y0, 'reportingBasis': a['reportingBasis'], 'cases': per, 'reserves': reserves, 'status': status, 'reasons': reasons}


# =============================================================== aggregation
def js_erf(x):
    sign = -1 if x < 0 else 1
    ax = abs(x)
    t = 1 / (1 + 0.3275911 * ax)
    y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * math.exp(-ax * ax)
    return sign * y


def ncdf(x):
    return 0.5 * (1 + js_erf(x / math.sqrt(2)))


def tri_inv(u, a, c, b):
    if a == b:
        return a
    if u <= (c - a) / (b - a):
        return a + math.sqrt(u * (b - a) * (c - a))
    return b - math.sqrt((1 - u) * (b - a) * (b - c))


def tri_fit(p10, p50, p90):
    """Triangular through three percentiles: shape by bisection on the mode
    position m, then range and origin from the 10th and 90th percentiles."""
    if not p90 > p10:
        return p10, p50, p90, True, None

    def g(u, m):
        return math.sqrt(u * m) if u <= m else 1 - math.sqrt((1 - u) * (1 - m))

    def ratio(m):
        return (g(0.5, m) - g(0.1, m)) / (g(0.9, m) - g(0.1, m))
    target = (p50 - p10) / (p90 - p10)
    rmin, rmax = ratio(0), ratio(1)
    exact, side = True, None
    if target <= rmin:
        target, exact, side = rmin, False, 'low'
    elif target >= rmax:
        target, exact, side = rmax, False, 'high'
    lo, hi = 0.0, 1.0
    for _ in range(200):
        m = (lo + hi) / 2
        if ratio(m) < target:
            lo = m
        else:
            hi = m
    m = (lo + hi) / 2
    rng = (p90 - p10) / (g(0.9, m) - g(0.1, m))
    mn = p10 - rng * g(0.1, m)
    return mn, mn + m * rng, mn + rng, exact, side


def box_muller(rng):
    u = 0.0
    v = 0.0
    while u == 0:
        u = rng()
    while v == 0:
        v = rng()
    return math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)


def chol(Mx):
    n = len(Mx)
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = 0.0
            for k in range(j):
                s += L[i][k] * L[j][k]
            if i == j:
                L[i][j] = math.sqrt(max(Mx[i][i] - s, 0))
            else:
                L[i][j] = 0 if L[j][j] == 0 else (1.0 / L[j][j]) * (Mx[i][j] - s)
    return L


def marginal(d, x):
    t = d['type']
    if t == 'normal':
        return d['mean'] + d['stdDev'] * x
    if t == 'lognormal':
        m, sd = d['mean'], d['stdDev']
        m2, sd2 = m * m, sd * sd
        mu = math.log(m2 / math.sqrt(m2 + sd2))
        sg = math.sqrt(math.log(1 + sd2 / m2))
        return math.exp(mu + sg * x)
    return tri_inv(ncdf(x), d['min'], d['mode'], d['max'])


def kahan_mean(x):
    s = x[0]
    corr = 0.0
    for v in x[1:]:
        t = s + v
        if abs(s) >= abs(v):
            corr += s - t + v
        else:
            corr += v - t + s
        s = t
    return (s + corr) / len(x)


def check_project(p, i, need_chance):
    pre = f'projects[{i}]'
    text(f'{pre}.id', get(p, 'id'))
    if has(p, 'name'):
        text(f'{pre}.name', p['name'])
    d = get(p, 'distribution')
    dp = f'{pre}.distribution'
    obj(dp, d, '{ type } with type one of "triangular-fit", "triangular", "lognormal", "normal" (no default)')
    one_of(f'{dp}.type', get(d, 'type'), ['triangular-fit', 'triangular', 'lognormal', 'normal'])
    t = d['type']
    below = 0.0
    if t == 'triangular-fit':
        w = 'for "triangular-fit" (the fit reads the stated estimates)'
        for k in ('min', 'mode', 'max', 'mean', 'stdDev'):
            absent(f'{dp}.{k}', d, k, w)
        check_cum(f'{pre}.estimates', get(p, 'estimates'))
        est = p['estimates']
        mn, mo, mx, exact, side = tri_fit(float(est['low']), float(est['best']), float(est['high']))
        if not exact:
            must(f'{pre}.estimates', f'low, best and high that a triangular distribution passes through exactly (lib/stats fitTriangularToPercentiles): the best estimate sits too near the {side} estimate for any triangular', est)
        if est['low'] == est['high']:
            dist = {'type': 'constant', 'value': est['low']}
            mean = F(est['low'])
        else:
            dist = {'type': 'triangular', 'min': mn, 'mode': mo, 'max': mx}
            mean = (F(mn) + F(mo) + F(mx)) / 3
        cases = {'low': F(est['low']), 'best': F(est['best']), 'high': F(est['high'])}
        if mn < 0:
            must(f'{pre}.estimates', f'low, best and high whose fitted triangular stays at or above 0 (its minimum would be {dec(mn)})', est)
    elif t == 'triangular':
        absent(f'{pre}.estimates', p, 'estimates', 'when the distribution is stated (the engine reads the estimates off it)')
        w = 'for "triangular" (min, mode and max are stated)'
        absent(f'{dp}.mean', d, 'mean', w)
        absent(f'{dp}.stdDev', d, 'stdDev', w)
        for k in ('min', 'mode', 'max'):
            non_neg(f'{dp}.{k}', get(d, k))
        if not (d['min'] <= d['mode'] <= d['max'] and d['min'] < d['max']):
            must(dp, 'a triangular with min <= mode <= max and min < max', d)
        dist = {'type': 'triangular', 'min': d['min'], 'mode': d['mode'], 'max': d['max']}
        cases = {k: F(tri_inv(u, d['min'], d['mode'], d['max'])) for k, u in (('low', 0.1), ('best', 0.5), ('high', 0.9))}
        mean = (F(d['min']) + F(d['mode']) + F(d['max'])) / 3
    else:
        absent(f'{pre}.estimates', p, 'estimates', 'when the distribution is stated (the engine reads the estimates off it)')
        w = f'for "{t}" (mean and stdDev are stated)'
        for k in ('min', 'mode', 'max'):
            absent(f'{dp}.{k}', d, k, w)
        positive(f'{dp}.mean', get(d, 'mean'))
        positive(f'{dp}.stdDev', get(d, 'stdDev'))
        m, sd = d['mean'], d['stdDev']
        dist = {'type': t, 'mean': m, 'stdDev': sd}
        mean = F(m)
        if t == 'normal':
            cases = {'low': F(m) - F(Z90) * F(sd), 'best': F(m), 'high': F(m) + F(Z90) * F(sd)}
            if cases['low'] < 0:
                must(dp, f"a normal whose low estimate (the mean less {js(Z90)} standard deviations, here {dec(cases['low'])}) stays at or above 0", d)
            below = ncdf(-m / sd)
        else:
            s2 = math.log(1 + (sd * sd) / (m * m))
            mu = math.log(m) - s2 / 2
            s = math.sqrt(s2)
            cases = {'low': F(math.exp(mu - Z90 * s)), 'best': F(math.exp(mu)), 'high': F(math.exp(mu + Z90 * s))}
    if need_chance:
        pct(f'{pre}.chanceOfCommercialityPct', get(p, 'chanceOfCommercialityPct'))
    else:
        absent(f'{pre}.chanceOfCommercialityPct', p, 'chanceOfCommercialityPct', 'for Reserves (their chance of commerciality is not a stated figure, PRMS 2.1.3.3)')
    return {'dist': dist, 'cases': cases, 'mean': mean, 'below': below}


def aggregate(a, sample=True):
    one_of('resourceClass', get(a, 'resourceClass'), list(CLASSES))
    one_of('level', get(a, 'level'), ['field', 'above-field'])
    text('unit', get(a, 'unit'))
    list_of('projects', get(a, 'projects'), CAPS['projects'])
    C = CLASSES[a['resourceClass']]
    risked = a['resourceClass'] != 'reserves'
    P, ids = [], set()
    for i, p in enumerate(a['projects']):
        r = check_project(p, i, risked)
        if p['id'] in ids:
            must(f'projects[{i}].id', 'an id no other project has', p['id'])
        ids.add(p['id'])
        r['id'] = p['id']
        r['chance'] = p['chanceOfCommercialityPct'] if risked else None
        P.append(r)
    seed = get(a, 'seed')
    if not (isnum(seed) and float(seed).is_integer() and 0 <= seed <= 4294967295):
        must('seed', 'an integer from 0 to 4294967295 (the mulberry32 seed; no default)', seed)
    int_in('iterations', get(a, 'iterations'), 100, CAPS['iterations'])
    it = a['iterations']
    if it * len(P) > CAPS['work']:
        must('iterations', f"at most {CAPS['work'] // len(P)} for {unit(len(P), 'project')} (iterations x projects at most {CAPS['work']})", it)
    varying = [p['id'] for p in P if p['dist']['type'] != 'constant']
    cr = get(a, 'correlation')
    obj('correlation', cr, '{ type: "uniform", rho } or { type: "pairs", pairs } (stated; no default)')
    one_of('correlation.type', get(cr, 'type'), ['uniform', 'pairs'])

    def rho_ok(f, v):
        if not (isnum(v) and -1 < v < 1):
            must(f, 'a number above -1 and below 1 (the canonical sampler takes a correlation strictly between -1 and 1)', v)
    pairs = []
    if cr['type'] == 'uniform':
        absent('correlation.pairs', cr, 'pairs', 'for a uniform correlation')
        rho_ok('correlation.rho', get(cr, 'rho'))
        for i in range(len(varying)):
            for j in range(i + 1, len(varying)):
                pairs.append({'a': varying[i], 'b': varying[j], 'rho': cr['rho']})
    else:
        absent('correlation.rho', cr, 'rho', 'for stated pairs')
        list_of('correlation.pairs', get(cr, 'pairs'), CAPS['projects'] * (CAPS['projects'] - 1) // 2, 0)
        seen = set()
        for i, q in enumerate(cr['pairs']):
            f = f'correlation.pairs[{i}]'
            one_of(f'{f}.a', get(q, 'a'), varying)
            one_of(f'{f}.b', get(q, 'b'), varying)
            rho_ok(f'{f}.rho', get(q, 'rho'))
            if q['a'] == q['b']:
                must(f'{f}.b', 'a project other than a', q['b'])
            key = frozenset((q['a'], q['b']))
            if key in seen:
                must(f, 'a pair stated once', q)
            seen.add(key)
            pairs.append({'a': q['a'], 'b': q['b'], 'rho': q['rho']})
        need = len(varying) * (len(varying) - 1) // 2
        if len(seen) != need:
            miss = next(f'{varying[i]} and {varying[j]}' for i in range(len(varying)) for j in range(i + 1, len(varying)) if frozenset((varying[i], varying[j])) not in seen)
            must('correlation.pairs', f'one pair for each of the {need} pairs of varying projects (0 is stated, never assumed); the first missing pair is {miss}', unit(len(seen), 'pair'))
    n = len(varying)
    Cm = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    for q in pairs:
        i, j = varying.index(q['a']), varying.index(q['b'])
        Cm[i][j] = Cm[j][i] = q['rho']
    Lc = chol(Cm)
    worst = 0.0
    for i in range(n):
        for j in range(n):
            s = 0.0
            for k in range(n):
                s += Lc[i][k] * Lc[j][k]
            worst = max(worst, abs(s - Cm[i][j]))
    if worst > PSD_TOL:
        must('correlation', f'a positive semidefinite correlation matrix (the Cholesky factor misses the stated matrix by {dec(worst)})', cr)
    arith = {k: sum((p['cases'][k] for p in P), F(0)) for k in ('low', 'best', 'high')}
    som = sum((p['mean'] for p in P), F(0))
    const = 0
    for p in P:
        if p['dist']['type'] == 'constant':
            const += p['dist']['value']
    rng = mulberry32(int(seed))
    dists = {p['id']: p['dist'] for p in P}
    totals = []
    for _ in range(it):
        Z = [box_muller(rng) for _ in range(n)]
        t = const
        for r in range(n):
            x = 0.0
            for c in range(r + 1):
                x += Lc[r][c] * Z[c]
            t += marginal(dists[varying[r]], x)
        totals.append(t)
    srt = sorted(totals)
    stat = {'low': ss_quantile_sorted(srt, 0.1), 'best': ss_quantile_sorted(srt, 0.5), 'high': ss_quantile_sorted(srt, 0.9), 'mean': kahan_mean(totals)}
    risked_mean = sum((F(p['chance']) * p['mean'] / 100 for p in P), F(0)) if risked else None
    lab = C['cum']
    u = a['unit']
    reasons = [
        f"{C['name']}, {unit(len(P), 'project')} at the {'field, property or project' if a['level'] == 'field' else 'above-field'} level; correlation "
        + (f"{js(cr['rho'])} for every pair of varying projects" if cr['type'] == 'uniform' else f"stated for {unit(len(pairs), 'pair')}") + ' (PRMS 4.2.5.3)',
        f"arithmetic summation by category: {lab['low']} {dec(arith['low'])}, {lab['best']} {dec(arith['best'])}, {lab['high']} {dec(arith['high'])} {u} (PRMS 4.2.5.2)",
        f"statistical aggregation (canonical Monte Carlo, seed {js(seed)}, {unit(it, 'iteration')}): P90 {dec(stat['low'])}, P50 {dec(stat['best'])}, P10 {dec(stat['high'])}, mean {dec(stat['mean'])} {u}",
        f"the arithmetic sum of the low estimates is not the P90 of the total: it is the P90 only when every project is totally dependent (PRMS 4.2.5.2); here the statistical low exceeds it by {dec(F(stat['low']) - arith['low'])} and the arithmetic high exceeds the statistical high by {dec(arith['high'] - F(stat['high']))}",
        f"the mean of the total is the sum of the means (no portfolio effect in means, PRMS 4.2.5.2): {dec(som)} exact, {dec(stat['mean'])} sampled",
        (f"above the field level report the arithmetic sums, with the caution that the aggregate {lab['low']} may be very conservative and the aggregate {lab['high']} very optimistic (PRMS 4.2.5.4; 17 CFR 229.1202(a)(3) (Regulation S-K Item 1202)); the statistical figures serve portfolio analysis (PRMS 4.2.5.5)"
         if a['level'] == 'above-field' else 'at the field, property or project level statistical aggregation may be reported (PRMS 4.2.5.4)'),
    ]
    for p in P:
        if dec(p['below']) != '0':
            reasons.append(f"{p['id']}: a normal distribution draws below 0 with chance {dec(p['below'])} (lib/stats normalCDF); those draws stay in the total")
    if risked:
        reasons.append(f"risked mean: the sum of chance of commerciality x mean, {dec(risked_mean)} {u}; state the classes separately and whether each figure is risked (PRMS 4.2.6; FAQ 6.9; AG 2011 6.4)")
    res = {
        'resourceClass': C['name'], 'level': a['level'], 'unit': u, 'labels': dict(lab),
        'projects': [{'id': p['id'], 'low': float(p['cases']['low']), 'best': float(p['cases']['best']), 'high': float(p['cases']['high']), 'mean': float(p['mean']),
                      'chanceBelowZero': p['below'], 'chanceOfCommercialityPct': p['chance'], 'distribution': dict(p['dist'])} for p in P],
        'arithmetic': {k: float(v) for k, v in arith.items()}, 'statistical': stat, 'sumOfMeans': float(som),
        'portfolioEffect': {'low': float(F(stat['low']) - arith['low']), 'high': float(arith['high'] - F(stat['high']))},
        'riskedMean': float(risked_mean) if risked else None,
        'reportable': 'arithmetic' if a['level'] == 'above-field' else 'arithmetic-or-statistical',
        'correlation': {'type': cr['type'], 'pairs': pairs}, 'seed': seed, 'iterations': it, 'reasons': reasons,
    }
    # witnesses for the Monte Carlo: the exact mean; a normal-only total has exact quantiles
    sds = []
    for p in P:
        d = p['dist']
        if d['type'] in ('normal', 'lognormal'):
            sds.append(d['stdDev'])
        elif d['type'] == 'triangular':
            a_, c_, b_ = d['min'], d['mode'], d['max']
            sds.append(math.sqrt((a_ * a_ + b_ * b_ + c_ * c_ - a_ * b_ - a_ * c_ - b_ * c_) / 18))
        else:
            sds.append(0.0)
    witness = {'mean': float(som), 'meanBand': 5 * sum(sds) / math.sqrt(it), 'quantiles': None}
    if all(p['dist']['type'] in ('normal', 'constant') for p in P):
        var = 0.0
        sdv = {p['id']: p['dist']['stdDev'] for p in P if p['dist']['type'] == 'normal'}
        for i in varying:
            var += sdv[i] ** 2
        for q in pairs:
            var += 2 * q['rho'] * sdv[q['a']] * sdv[q['b']]
        nd = NormalDist(float(som), math.sqrt(var))
        witness['quantiles'] = {'low': nd.inv_cdf(0.1), 'best': nd.inv_cdf(0.5), 'high': nd.inv_cdf(0.9), 'sd': math.sqrt(var)}
    return res, witness


# ============================================================ reconciliation
MOVES = {
    'revisions': (0, 'revisions of previous estimates (signed)'),
    'improved-recovery': (1, 'improved recovery (additions)'),
    'extensions-and-discoveries': (1, 'extensions and discoveries (additions)'),
    'acquisitions': (1, 'acquisitions (additions)'),
    'divestments': (-1, 'divestments (entered as positive, subtracted)'),
    'transfers': (0, 'transfers between classes (signed; in positive, out negative)'),
    'production': (-1, 'production (one quantity, subtracted from every category)'),
}


def reconcile(a):
    one_of('resourceClass', get(a, 'resourceClass'), ['reserves', 'contingent'])
    text('unit', get(a, 'unit'))
    positive('periodYears', get(a, 'periodYears'))
    check_cum('opening', get(a, 'opening'))
    list_of('movements', get(a, 'movements'), CAPS['movements'], 0)
    C = CLASSES[a['resourceClass']]
    lab = C['cum']
    ks = ('low', 'best', 'high')
    moves, prod = [], F(0)
    for i, m in enumerate(a['movements']):
        f = f'movements[{i}]'
        one_of(f'{f}.type', get(m, 'type'), list(MOVES))
        if has(m, 'note'):
            text(f'{f}.note', m['note'])
        sign = MOVES[m['type']][0]
        if m['type'] == 'production':
            if a['resourceClass'] != 'reserves':
                must(f'{f}.type', f"one of {quote([t for t in MOVES if t != 'production'])} for Contingent Resources (produced quantities come out of Reserves; sub-economic production moves from Contingent Resources to production and is shown as a revision, PRMS 3.1.3.5)", m['type'])
            w = 'for production (one quantity applies to every category)'
            for k in ks:
                absent(f'{f}.{k}', m, k, w)
            non_neg(f'{f}.quantity', get(m, 'quantity'))
            prod += F(m['quantity'])
            moves.append({'type': 'production', **{k: -F(m['quantity']) for k in ks}})
            continue
        absent(f'{f}.quantity', m, 'quantity', f"for {m['type']} (state low, best and high)")
        for k in ks:
            if sign == 0:
                if not isnum(get(m, k)):
                    must(f'{f}.{k}', 'a finite number (signed)', get(m, k))
            else:
                non_neg(f'{f}.{k}', get(m, k))
        s = -1 if sign == -1 else 1
        moves.append({'type': m['type'], **{k: s * F(m[k]) for k in ks}})
    check_cum('closing', get(a, 'closing'))
    non_neg('tolerance', get(a, 'tolerance'))
    op = {k: F(a['opening'][k]) for k in ks}
    comp = {k: op[k] + sum((m[k] for m in moves), F(0)) for k in ks}
    diff = {k: F(a['closing'][k]) - comp[k] for k in ks}
    tol = F(a['tolerance'])
    closes = all(abs(diff[k]) <= tol for k in ks)
    order = not (comp['low'] <= comp['best'] <= comp['high'])
    neg = [k for k in ks if comp[k] < 0]
    adds = sum((m['best'] for m in moves if m['type'] != 'production'), F(0))
    rr = adds / prod if prod > 0 else None
    life = F(a['closing']['best']) / (prod / F(a['periodYears'])) if prod > 0 else None
    by = {}
    for t in MOVES:
        ms = [m for m in moves if m['type'] == t]
        if ms:
            by[t] = {k: sum((m[k] for m in ms), F(0)) for k in ks}
    u = a['unit']
    cl = a['closing']
    reasons = [f"{C['name']} reconciliation in {u}: opening {lab['low']} {dec(op['low'])}, {lab['best']} {dec(op['best'])}, {lab['high']} {dec(op['high'])}"]
    for t, v in by.items():
        reasons.append(f"{MOVES[t][1]}: {lab['low']} {dec(v['low'])}, {lab['best']} {dec(v['best'])}, {lab['high']} {dec(v['high'])}")
    reasons.append(f"computed closing: {lab['low']} {dec(comp['low'])}, {lab['best']} {dec(comp['best'])}, {lab['high']} {dec(comp['high'])}; stated closing {lab['low']} {dec(cl['low'])}, {lab['best']} {dec(cl['best'])}, {lab['high']} {dec(cl['high'])}")
    if closes:
        reasons.append(f"the reconciliation closes: every category within the stated tolerance {js(a['tolerance'])}")
    else:
        bad = ', '.join(f"{lab[k]} differs by {dec(diff[k])}" for k in ks if abs(diff[k]) > tol)
        reasons.append(f"the reconciliation does not close: {bad} (tolerance {js(a['tolerance'])})")
    if order:
        reasons.append(f"the computed closing is out of order ({lab['low']} <= {lab['best']} <= {lab['high']} fails)")
    if neg:
        reasons.append(f"the computed closing is below 0 for {', '.join(lab[k] for k in neg)}")
    if rr is not None:
        reasons.append(f"{lab['best']} replacement ratio: every movement other than production (additions, revisions and transfers) {dec(adds)} over production {dec(prod)} = {dec(rr)}; {lab['best']} life index {dec(life)} years at the period's production rate")

    def fc(x):
        return {k: float(v) for k, v in x.items()}

    def inc(x):
        return {'first': float(x['low']), 'second': float(x['best'] - x['low']), 'third': float(x['high'] - x['best'])}
    return {
        'resourceClass': C['name'], 'unit': u, 'labels': dict(lab), 'opening': dict(a['opening']),
        'movements': [{'type': m['type'], **{k: float(m[k]) for k in ks}} for m in moves], 'byType': {t: fc(v) for t, v in by.items()},
        'computedClosing': fc(comp), 'statedClosing': dict(cl), 'difference': fc(diff), 'closes': closes, 'orderViolation': order,
        'negativeCategories': [lab[k] for k in neg],
        'incremental': {'opening': inc(op), 'closing': inc(comp), 'labels': dict(C['inc'])} if C['inc'] else None,
        'production': float(prod), 'replacementRatio': float(rr) if rr is not None else None, 'lifeIndexYears': float(life) if life is not None else None,
        'reasons': reasons,
    }


# ===================================================================== cases
CASES = []
FNS = {'classify': classify, 'categorize': categorize, 'economicLimit': economic_limit, 'aggregate': aggregate, 'reconcile': reconcile}


def run(fn, args):
    try:
        if not isinstance(args, dict):
            must('options', 'an object of named inputs', args)
        check_keys(args, SHAPES[fn], '')
        r = FNS[fn](args)
        return r
    except Refusal as e:
        return {'error': True, 'field': e.field, 'message': e.message}


def add(cid, fn, args, expect_error=None, tol=1e-9):
    args = json.loads(json.dumps(args))
    r = run(fn, json.loads(json.dumps(args)))
    c = {'id': cid, 'fn': fn, 'args': args, 'tol': tol}
    if fn == 'aggregate' and not (isinstance(r, dict) and r.get('error') is True):
        r, witness = r
        c['witness'] = witness
    c['expected'] = r
    is_err = isinstance(r, dict) and r.get('error') is True
    if expect_error is not None and not is_err:
        sys.exit(f'{cid}: expected a refusal on {expect_error}, got a result')
    if expect_error is not None and r['field'] != expect_error:
        sys.exit(f'{cid}: refused on {r["field"]}, expected {expect_error}: {r["message"]}')
    if expect_error is None and is_err:
        sys.exit(f'{cid}: unexpected refusal: {r["message"]}')
    CASES.append(c)
    return r


def ok(cid, fn, args, **kw):
    return add(cid, fn, args, **kw)


def refused(cid, fn, args, field):
    return add(cid, fn, args, expect_error=field)


def without(d, *ks):
    return {k: v for k, v in d.items() if k not in ks}


def build():
    with open(FIX) as f:
        fx = json.load(f)
    P = {p['id']: p['args'] for p in fx['projects']}

    # ---- classify: the Ekene projects
    for pid, args in P.items():
        ok(f'class-{pid.lower()}', 'classify', args)
    full = P['EKN-2']['commerciality']
    base = P['EKN-2']
    ok('class-justified', 'classify', dict(base, subClass='justified-for-development', projectStatus={'finalInvestmentDecision': False, 'onProduction': False}))
    ok('class-time-frame-5-met', 'classify', dict(base, commerciality=dict(full, timeFrame={'startWithinYears': 5, 'longerJustified': False})))
    refused('class-time-frame-6-contingent-subclass', 'classify', dict(without(base, 'projectStatus', 'reservesStatus'), commerciality=dict(full, timeFrame={'startWithinYears': 6, 'longerJustified': False})), 'subClass')
    refused('class-time-frame-6-project-status', 'classify', dict(base, commerciality=dict(full, timeFrame={'startWithinYears': 6, 'longerJustified': False})), 'projectStatus')
    ok('class-time-frame-6-contingent', 'classify', dict(without(base, 'projectStatus', 'reservesStatus'), subClass='development-pending', chances={'developmentPct': 90},
                                                         commerciality=dict(full, timeFrame={'startWithinYears': 6, 'longerJustified': False})))
    ok('class-time-frame-8-justified', 'classify', dict(base, commerciality=dict(full, timeFrame={'startWithinYears': 8, 'longerJustified': True})))
    ok('class-economics-undetermined', 'classify', dict(without(base, 'projectStatus', 'reservesStatus'), economicStatus='undetermined', subClass='development-pending', chances={'developmentPct': 70}))
    ok('class-no-firm-intention', 'classify', dict(without(base, 'projectStatus', 'reservesStatus'), commerciality=dict(full, firmIntention=False), subClass='development-pending', chances={'developmentPct': 80}))
    ok('class-tech-under-development-only', 'classify', dict(without(base, 'projectStatus', 'reservesStatus'), recoveryProject='technology-under-development', subClass='development-unclarified', chances={'developmentPct': 30}))
    ok('class-undiscovered-unrecoverable', 'classify', {'discovery': 'undiscovered', 'recoveryProject': 'none'})
    ok('class-play', 'classify', {'discovery': 'undiscovered', 'recoveryProject': 'technology-under-development', 'subClass': 'play', 'chances': {'geologicDiscoveryPct': 10, 'developmentPct': 50}})
    ok('class-pg-zero', 'classify', {'discovery': 'undiscovered', 'recoveryProject': 'established-technology', 'subClass': 'prospect', 'chances': {'geologicDiscoveryPct': 0, 'developmentPct': 50}})
    ok('class-nigeria-retention-10', 'classify', dict(P['EKN-3'], nigeria={'declaration': 'significant-gas-discovery', 'yearsSinceDeclaration': 10}))
    ok('class-nigeria-retention-11', 'classify', dict(P['EKN-3'], nigeria={'declaration': 'significant-crude-oil-discovery', 'yearsSinceDeclaration': 11}))
    ok('class-nigeria-fdp-2', 'classify', dict(P['EKN-2'], nigeria={'declaration': 'commercial-discovery', 'yearsSinceDeclaration': 2}))
    ok('class-nigeria-no-interest', 'classify', dict(P['EKN-8'], nigeria={'declaration': 'no-interest', 'yearsSinceDeclaration': 1}))
    refused('class-refuse-nigeria-significant-reserves', 'classify', dict(P['EKN-2'], nigeria={'declaration': 'significant-gas-discovery', 'yearsSinceDeclaration': 1}), 'nigeria.declaration')
    refused('class-refuse-nigeria-undiscovered', 'classify', dict(P['EKN-6'], nigeria={'declaration': 'commercial-discovery', 'yearsSinceDeclaration': 0}), 'nigeria')
    refused('class-refuse-nigeria-declaration', 'classify', dict(P['EKN-3'], nigeria={'declaration': 'significant', 'yearsSinceDeclaration': 0}), 'nigeria.declaration')
    refused('class-refuse-subclass-approved-stated-justified', 'classify', dict(base, subClass='justified-for-development'), 'subClass')
    refused('class-refuse-subclass-reserves-stated-pending', 'classify', dict(base, subClass='development-pending'), 'subClass')
    refused('class-refuse-subclass-contingent-stated-approved', 'classify', P['EKN-3'] | {'subClass': 'approved-for-development'}, 'subClass')
    refused('class-refuse-prospective-subclass', 'classify', dict(P['EKN-6'], subClass='development-pending'), 'subClass')
    refused('class-refuse-producing-without-fid', 'classify', dict(P['EKN-1'], projectStatus={'finalInvestmentDecision': False, 'onProduction': True}), 'projectStatus.finalInvestmentDecision')
    refused('class-refuse-dp-not-producing', 'classify', dict(base, reservesStatus='developed-producing'), 'reservesStatus')
    refused('class-refuse-reserves-chances', 'classify', dict(base, chances={'developmentPct': 95}), 'chances')
    refused('class-refuse-contingent-pg', 'classify', dict(P['EKN-3'], chances={'geologicDiscoveryPct': 50, 'developmentPct': 50}), 'chances.geologicDiscoveryPct')
    refused('class-refuse-contingent-no-chances', 'classify', without(P['EKN-3'], 'chances'), 'chances')
    refused('class-refuse-contingent-project-status', 'classify', dict(P['EKN-3'], projectStatus={'finalInvestmentDecision': False, 'onProduction': False}), 'projectStatus')
    refused('class-refuse-prospective-commerciality', 'classify', dict(P['EKN-6'], commerciality=full), 'commerciality')
    refused('class-refuse-prospective-pd', 'classify', dict(P['EKN-6'], chances={'geologicDiscoveryPct': 25}), 'chances.developmentPct')
    refused('class-refuse-unrecoverable-subclass', 'classify', dict(P['EKN-8'], subClass='development-not-viable'), 'subClass')
    refused('class-refuse-missing-criterion', 'classify', dict(base, commerciality=without(full, 'market')), 'commerciality.market')
    refused('class-refuse-criterion-not-boolean', 'classify', dict(base, commerciality=dict(full, approvals='yes')), 'commerciality.approvals')
    refused('class-refuse-time-frame', 'classify', dict(base, commerciality=dict(full, timeFrame={'startWithinYears': -1, 'longerJustified': False})), 'commerciality.timeFrame.startWithinYears')
    refused('class-refuse-economic-status', 'classify', dict(base, economicStatus='positive'), 'economicStatus')
    refused('class-refuse-discovery', 'classify', dict(base, discovery='appraised'), 'discovery')
    refused('class-refuse-unknown-key', 'classify', dict(base, commerciality=dict(full, markets=True)), 'commerciality.markets')
    refused('class-refuse-unknown-top', 'classify', dict(base, maturity='high'), 'maturity')

    # ---- categorize
    ok('cat-faq33-incremental', 'categorize', {'resourceClass': 'reserves', 'method': 'incremental', 'estimates': {'first': 5, 'second': 2, 'third': 3}, 'unit': 'MMbbl'})
    ok('cat-reserves-cumulative', 'categorize', {'resourceClass': 'reserves', 'method': 'cumulative', 'estimates': {'low': 8.89, 'best': 16.65, 'high': 24.99}, 'unit': 'MMbbl'})
    ok('cat-contingent-incremental', 'categorize', {'resourceClass': 'contingent', 'method': 'incremental', 'estimates': {'first': 3, 'second': 1.5, 'third': 2}, 'unit': 'MMboe'})
    ok('cat-contingent-cumulative', 'categorize', {'resourceClass': 'contingent', 'method': 'cumulative', 'estimates': {'low': 3, 'best': 4.5, 'high': 6.5}, 'unit': 'MMboe'})
    ok('cat-prospective', 'categorize', {'resourceClass': 'prospective', 'method': 'cumulative', 'estimates': {'low': 12, 'best': 30, 'high': 70}, 'unit': 'MMbbl'})
    ok('cat-single-value', 'categorize', {'resourceClass': 'reserves', 'method': 'cumulative', 'estimates': {'low': 2, 'best': 2, 'high': 2}, 'unit': 'MMbbl'})
    ok('cat-zero-increment', 'categorize', {'resourceClass': 'reserves', 'method': 'incremental', 'estimates': {'first': 0, 'second': 7, 'third': 0}, 'unit': 'MMbbl'})
    refused('cat-refuse-out-of-order', 'categorize', {'resourceClass': 'reserves', 'method': 'cumulative', 'estimates': {'low': 10, 'best': 8, 'high': 12}, 'unit': 'MMbbl'}, 'estimates')
    refused('cat-refuse-prospective-incremental', 'categorize', {'resourceClass': 'prospective', 'method': 'incremental', 'estimates': {'first': 1, 'second': 1, 'third': 1}, 'unit': 'MMbbl'}, 'method')
    refused('cat-refuse-negative-increment', 'categorize', {'resourceClass': 'contingent', 'method': 'incremental', 'estimates': {'first': 1, 'second': -1, 'third': 1}, 'unit': 'MMbbl'}, 'estimates.second')
    refused('cat-refuse-mixed-forms', 'categorize', {'resourceClass': 'reserves', 'method': 'cumulative', 'estimates': {'low': 1, 'best': 2, 'high': 3, 'second': 1}, 'unit': 'MMbbl'}, 'estimates.second')
    refused('cat-refuse-incremental-with-low', 'categorize', {'resourceClass': 'reserves', 'method': 'incremental', 'estimates': {'low': 1, 'first': 1, 'second': 1, 'third': 1}, 'unit': 'MMbbl'}, 'estimates.low')
    refused('cat-refuse-unit', 'categorize', {'resourceClass': 'reserves', 'method': 'cumulative', 'estimates': {'low': 1, 'best': 2, 'high': 3}, 'unit': ' '}, 'unit')
    refused('cat-refuse-class', 'categorize', {'resourceClass': 'resources', 'method': 'cumulative', 'estimates': {'low': 1, 'best': 2, 'high': 3}, 'unit': 'MMbbl'}, 'resourceClass')

    # ---- economic limit
    E = fx['economicLimit']
    ok('econ-ekene', 'economicLimit', E)
    ok('econ-ekene-gross', 'economicLimit', dict(E, reportingBasis='gross'))
    ok('econ-ekene-working-interest', 'economicLimit', dict(E, reportingBasis='working-interest'))
    ok('econ-ekene-production-tax', 'economicLimit', dict(E, royalty={'ratePct': 15, 'form': 'production-tax'}))
    ok('econ-ekene-renewal-expected', 'economicLimit', dict(E, licence={'expiryYear': 2040, 'renewalExpected': True}))
    ok('econ-ekene-no-loss-relief', 'economicLimit', dict(E, tax={'ratePct': 30, 'depreciationYears': 5, 'lossCarryforward': False}))
    # FAQ 3.3: low 5, best 7 (5 + 2); the low case fails the economic test
    faq = {'effectiveYear': 2027,
           'forecasts': {'low': [{'year': 2027, 'oil': 5000000, 'gas': 0}], 'best': [{'year': 2027, 'oil': 7000000, 'gas': 0}], 'high': [{'year': 2027, 'oil': 9000000, 'gas': 0}]},
           'prices': [{'year': 2027, 'oil': 10, 'gas': 0}], 'costs': {'opex': [{'year': 2027, 'amount': 0}], 'capex': [{'year': 2027, 'amount': 60000000}], 'abandonment': 0},
           'royalty': {'ratePct': 0, 'form': 'royalty-interest'}, 'tax': {'ratePct': 0, 'depreciationYears': 1, 'lossCarryforward': True}, 'workingInterestPct': 100,
           'licence': {'expiryYear': 2027, 'renewalExpected': False}, 'reportingBasis': 'gross', 'discountRatePct': 0, 'mscfPerBoe': 6}
    ok('econ-faq33-low-fails', 'economicLimit', faq)
    ok('econ-best-fails', 'economicLimit', dict(faq, costs=dict(faq['costs'], capex=[{'year': 2027, 'amount': 80000000}]), forecasts=dict(faq['forecasts'], high=[{'year': 2027, 'oil': 9000000, 'gas': 0}])))
    ok('econ-exactly-zero-not-economic', 'economicLimit', dict(faq, costs=dict(faq['costs'], capex=[{'year': 2027, 'amount': 70000000}])))
    refused('econ-refuse-high-uneconomic', 'economicLimit', dict(faq, forecasts=dict(faq['forecasts'], high=[{'year': 2027, 'oil': 5500000, 'gas': 0}])), 'forecasts.high')
    # limit boundary: a tail year at exactly 0 net operating income is kept (the rule cuts below 0 only)
    yrs = [2027, 2028, 2029]
    tail = {'effectiveYear': 2027,
            'forecasts': {k: [{'year': y, 'oil': o, 'gas': 0} for y, o in zip(yrs, v)] for k, v in (('low', [100000, 50000, 20000]), ('best', [100000, 50000, 20000]), ('high', [100000, 50000, 20000]))},
            'prices': [{'year': y, 'oil': 50, 'gas': 0} for y in yrs], 'costs': {'opex': [{'year': y, 'amount': 1000000} for y in yrs], 'capex': [], 'abandonment': 0},
            'royalty': {'ratePct': 0, 'form': 'royalty-interest'}, 'tax': {'ratePct': 0, 'depreciationYears': 1, 'lossCarryforward': True}, 'workingInterestPct': 100,
            'licence': {'expiryYear': 2040, 'renewalExpected': False}, 'reportingBasis': 'gross', 'discountRatePct': 10, 'mscfPerBoe': 6}
    ok('econ-tail-exactly-zero-kept', 'economicLimit', tail)
    ok('econ-tail-one-below-cut', 'economicLimit', dict(tail, forecasts={k: [{'year': y, 'oil': o, 'gas': 0} for y, o in zip(yrs, [100000, 50000, 19999])] for k in ('low', 'best', 'high')}))
    # a late dip not offset: the canonical limit and the PRMS peak disagree
    dip = dict(tail, forecasts={k: [{'year': y, 'oil': o, 'gas': 0} for y, o in zip([2027, 2028, 2029, 2030], [100000, 10000, 25000, 22000])] for k in ('low', 'best', 'high')},
               prices=[{'year': y, 'oil': 50, 'gas': 0} for y in [2027, 2028, 2029, 2030]], costs={'opex': [{'year': y, 'amount': 1000000} for y in [2027, 2028, 2029, 2030]], 'capex': [], 'abandonment': 0})
    refused('econ-refuse-limit-disagrees', 'economicLimit', dip, 'forecasts.low')
    refused('econ-refuse-prices-short', 'economicLimit', dict(E, prices=E['prices'][:-1]), 'prices')
    refused('econ-refuse-year-gap', 'economicLimit', dict(E, forecasts=dict(E['forecasts'], best=E['forecasts']['best'][:3] + E['forecasts']['best'][4:])), 'forecasts.best[3].year')
    refused('econ-refuse-capex-after-licence', 'economicLimit', dict(E, licence={'expiryYear': 2030, 'renewalExpected': False}, costs=dict(E['costs'], capex=[{'year': 2031, 'amount': 1}])), 'costs.capex[0].year')
    refused('econ-refuse-capex-duplicate', 'economicLimit', dict(E, costs=dict(E['costs'], capex=[{'year': 2027, 'amount': 1}, {'year': 2027, 'amount': 2}])), 'costs.capex[1].year')
    refused('econ-refuse-royalty-100', 'economicLimit', dict(E, royalty={'ratePct': 100, 'form': 'royalty-interest'}), 'royalty.ratePct')
    refused('econ-refuse-royalty-form', 'economicLimit', dict(E, royalty={'ratePct': 15, 'form': 'cash'}), 'royalty.form')
    refused('econ-refuse-no-tax', 'economicLimit', without(E, 'tax'), 'tax')
    refused('econ-refuse-loss-cf-unstated', 'economicLimit', dict(E, tax={'ratePct': 30, 'depreciationYears': 5}), 'tax.lossCarryforward')
    refused('econ-refuse-wi-zero', 'economicLimit', dict(E, workingInterestPct=0), 'workingInterestPct')
    refused('econ-refuse-licence-before', 'economicLimit', dict(E, licence={'expiryYear': 2026, 'renewalExpected': False}), 'licence.expiryYear')
    refused('econ-refuse-basis', 'economicLimit', dict(E, reportingBasis='net'), 'reportingBasis')
    refused('econ-refuse-boe', 'economicLimit', dict(E, mscfPerBoe=0), 'mscfPerBoe')
    refused('econ-refuse-opex-short', 'economicLimit', dict(E, costs=dict(E['costs'], opex=E['costs']['opex'][:-1])), 'costs.opex')
    refused('econ-refuse-negative-oil', 'economicLimit', dict(E, forecasts=dict(E['forecasts'], low=[dict(E['forecasts']['low'][0], oil=-1)] + E['forecasts']['low'][1:])), 'forecasts.low[0].oil')
    refused('econ-refuse-unknown-key', 'economicLimit', dict(E, costs=dict(E['costs'], adr=1)), 'costs.adr')

    # ---- aggregation
    AR, AC = fx['aggregation']['reserves'], fx['aggregation']['contingent']
    ok('agg-ekene-reserves', 'aggregate', AR)
    ok('agg-ekene-reserves-above-field', 'aggregate', dict(AR, level='above-field'))
    ok('agg-ekene-reserves-independent', 'aggregate', dict(AR, correlation={'type': 'uniform', 'rho': 0}))
    ok('agg-ekene-reserves-strong', 'aggregate', dict(AR, correlation={'type': 'uniform', 'rho': 0.95}))
    ok('agg-ekene-contingent', 'aggregate', AC)
    ok('agg-prospective', 'aggregate', {'resourceClass': 'prospective', 'level': 'field', 'unit': 'MMbbl', 'seed': 5, 'iterations': 5000, 'correlation': {'type': 'uniform', 'rho': 0},
                                        'projects': [{'id': 'EKN-6', 'distribution': {'type': 'lognormal', 'mean': 40, 'stdDev': 25}, 'chanceOfCommercialityPct': 20},
                                                     {'id': 'EKN-7', 'distribution': {'type': 'triangular', 'min': 2, 'mode': 6, 'max': 20}, 'chanceOfCommercialityPct': 10.5}]})
    # AG 2011 6.3 Table 6.2: blocks A and B, expectation 53.4 and 35.6, Proved 43.3 and 28.5 (10^9 m3); symmetric (normal) uncertainty with
    # mean - Proved as the 90% half-width; independent: the printed probabilistic Proved is 77, the arithmetic 71.8 (printed 72 on Fig. 6.5)
    agA, agB = (53.4 - 43.3) / Z90, (35.6 - 28.5) / Z90
    ok('agg-ag2011-table62-independent', 'aggregate', {'resourceClass': 'reserves', 'level': 'field', 'unit': 'billion m3 GIIP', 'seed': 2011, 'iterations': 200000,
                                                        'correlation': {'type': 'uniform', 'rho': 0},
                                                        'projects': [{'id': 'A', 'name': 'Block A (AG 2011 Table 6.2)', 'distribution': {'type': 'normal', 'mean': 53.4, 'stdDev': agA}},
                                                                     {'id': 'B', 'name': 'Block B (AG 2011 Table 6.2)', 'distribution': {'type': 'normal', 'mean': 35.6, 'stdDev': agB}}]})
    ok('agg-ag2011-table62-dependent', 'aggregate', {'resourceClass': 'reserves', 'level': 'field', 'unit': 'billion m3 GIIP', 'seed': 2011, 'iterations': 200000,
                                                      'correlation': {'type': 'uniform', 'rho': 0.999},
                                                      'projects': [{'id': 'A', 'distribution': {'type': 'normal', 'mean': 53.4, 'stdDev': agA}},
                                                                   {'id': 'B', 'distribution': {'type': 'normal', 'mean': 35.6, 'stdDev': agB}}]})
    # NUPRC media release, national reserves as at 1 January 2026: 2P associated gas 100.21 Tcf and non-associated gas 114.98 Tcf, total 215.19 Tcf
    ok('agg-nuprc-2026-gas-2p', 'aggregate', {'resourceClass': 'reserves', 'level': 'above-field', 'unit': 'Tcf', 'seed': 1, 'iterations': 100, 'correlation': {'type': 'uniform', 'rho': 0},
                                              'projects': [{'id': 'AG', 'name': 'associated gas, 2P as published', 'distribution': {'type': 'triangular-fit'}, 'estimates': {'low': 100.21, 'best': 100.21, 'high': 100.21}},
                                                           {'id': 'NAG', 'name': 'non-associated gas, 2P as published', 'distribution': {'type': 'triangular-fit'}, 'estimates': {'low': 114.98, 'best': 114.98, 'high': 114.98}}]})
    ok('agg-constant-project', 'aggregate', dict(AR, projects=AR['projects'] + [{'id': 'EKN-C', 'distribution': {'type': 'triangular-fit'}, 'estimates': {'low': 1.2, 'best': 1.2, 'high': 1.2}}],
                                                 correlation=AR['correlation']))
    ok('agg-negative-correlation', 'aggregate', dict(AR, correlation={'type': 'uniform', 'rho': -0.4}))
    refused('agg-refuse-psd', 'aggregate', dict(AR, correlation={'type': 'uniform', 'rho': -0.6}), 'correlation')
    refused('agg-refuse-rho-one', 'aggregate', dict(AR, correlation={'type': 'uniform', 'rho': 1}), 'correlation.rho')
    refused('agg-refuse-missing-pair', 'aggregate', dict(AR, correlation={'type': 'pairs', 'pairs': AR['correlation']['pairs'][:2]}), 'correlation.pairs')
    refused('agg-refuse-duplicate-pair', 'aggregate', dict(AR, correlation={'type': 'pairs', 'pairs': AR['correlation']['pairs'] + [{'a': 'EKN-2', 'b': 'EKN-1', 'rho': 0.5}]}), 'correlation.pairs[3]')
    refused('agg-refuse-pair-constant', 'aggregate', dict(AR, projects=AR['projects'] + [{'id': 'EKN-C', 'distribution': {'type': 'triangular-fit'}, 'estimates': {'low': 1, 'best': 1, 'high': 1}}],
                                                        correlation={'type': 'pairs', 'pairs': AR['correlation']['pairs'] + [{'a': 'EKN-1', 'b': 'EKN-C', 'rho': 0.1}]}), 'correlation.pairs[3].b')
    refused('agg-refuse-no-correlation', 'aggregate', without(AR, 'correlation'), 'correlation')
    refused('agg-refuse-no-seed', 'aggregate', without(AR, 'seed'), 'seed')
    refused('agg-refuse-iterations', 'aggregate', dict(AR, iterations=50), 'iterations')
    refused('agg-refuse-work', 'aggregate', dict(AR, projects=[dict(p, id=f'X{i}') for i, p in enumerate(AR['projects'] * 4)][:11], correlation={'type': 'uniform', 'rho': 0}, iterations=200000), 'iterations')
    refused('agg-refuse-tri-fit-inexact', 'aggregate', dict(AR, projects=[dict(AR['projects'][0], estimates={'low': 10, 'best': 15, 'high': 24})] + AR['projects'][1:]), 'projects[0].estimates')
    refused('agg-refuse-tri-fit-negative', 'aggregate', dict(AR, projects=[dict(AR['projects'][0], estimates={'low': 0.1, 'best': 1, 'high': 3})] + AR['projects'][1:]), 'projects[0].estimates')
    refused('agg-refuse-normal-negative-low', 'aggregate', dict(AR, projects=AR['projects'][:2] + [dict(AR['projects'][2], distribution={'type': 'normal', 'mean': 1, 'stdDev': 1})]), 'projects[2].distribution')
    refused('agg-refuse-stated-with-estimates', 'aggregate', dict(AR, projects=AR['projects'][:1] + [dict(AR['projects'][1], estimates={'low': 1, 'best': 2, 'high': 3})] + AR['projects'][2:]), 'projects[1].estimates')
    refused('agg-refuse-reserves-chance', 'aggregate', dict(AR, projects=[dict(AR['projects'][0], chanceOfCommercialityPct=100)] + AR['projects'][1:]), 'projects[0].chanceOfCommercialityPct')
    refused('agg-refuse-contingent-no-chance', 'aggregate', dict(AC, projects=[without(AC['projects'][0], 'chanceOfCommercialityPct')] + AC['projects'][1:]), 'projects[0].chanceOfCommercialityPct')
    refused('agg-refuse-duplicate-id', 'aggregate', dict(AR, projects=AR['projects'] + [AR['projects'][0]]), 'projects[3].id')
    refused('agg-refuse-triangular-order', 'aggregate', dict(AC, projects=AC['projects'][:2] + [dict(AC['projects'][2], distribution={'type': 'triangular', 'min': 3, 'mode': 2, 'max': 6})]), 'projects[2].distribution')
    refused('agg-refuse-level', 'aggregate', dict(AR, level='company'), 'level')
    refused('agg-refuse-dist-type', 'aggregate', dict(AR, projects=[dict(AR['projects'][1], distribution={'type': 'beta', 'mean': 1, 'stdDev': 1})]), 'projects[0].distribution.type')
    refused('agg-refuse-unknown-key', 'aggregate', dict(AR, correlation={'type': 'uniform', 'rho': 0, 'matrix': []}), 'correlation.matrix')

    # ---- reconciliation
    RC = fx['reconciliation']
    ok('rec-ekene', 'reconcile', RC)
    ok('rec-ekene-not-closing', 'reconcile', dict(RC, closing={'low': 18.3, 'best': 25.8, 'high': 33.9}))
    exact = {'resourceClass': 'reserves', 'unit': 'MMbbl', 'periodYears': 1, 'opening': {'low': 10, 'best': 15, 'high': 20},
             'movements': [{'type': 'revisions', 'low': 0, 'best': 0.5, 'high': 0}], 'closing': {'low': 10, 'best': 15.25, 'high': 20}, 'tolerance': 0.25}
    ok('rec-difference-exactly-tolerance', 'reconcile', exact)
    ok('rec-difference-above-tolerance', 'reconcile', dict(exact, closing={'low': 10, 'best': 15.1875, 'high': 20}))
    ok('rec-contingent', 'reconcile', {'resourceClass': 'contingent', 'unit': 'MMboe', 'periodYears': 1, 'opening': {'low': 9, 'best': 14, 'high': 22},
                                       'movements': [{'type': 'transfers', 'low': -3.4, 'best': -5.1, 'high': -6.9}, {'type': 'extensions-and-discoveries', 'low': 2, 'best': 3.5, 'high': 6}],
                                       'closing': {'low': 7.6, 'best': 12.4, 'high': 21.1}, 'tolerance': 0.001})
    ok('rec-divest-acquire', 'reconcile', {'resourceClass': 'reserves', 'unit': 'MMbbl', 'periodYears': 2, 'opening': {'low': 10, 'best': 15, 'high': 20},
                                           'movements': [{'type': 'divestments', 'low': 2, 'best': 3, 'high': 4}, {'type': 'acquisitions', 'low': 1, 'best': 1.5, 'high': 2},
                                                         {'type': 'production', 'quantity': 1}, {'type': 'production', 'quantity': 1}],
                                           'closing': {'low': 7, 'best': 11.5, 'high': 16}, 'tolerance': 0})
    ok('rec-order-breaks', 'reconcile', {'resourceClass': 'reserves', 'unit': 'MMbbl', 'periodYears': 1, 'opening': {'low': 10, 'best': 12, 'high': 14},
                                         'movements': [{'type': 'revisions', 'low': 3, 'best': 0, 'high': 0}], 'closing': {'low': 12, 'best': 12, 'high': 14}, 'tolerance': 0.5})
    ok('rec-no-production', 'reconcile', {'resourceClass': 'reserves', 'unit': 'MMbbl', 'periodYears': 1, 'opening': {'low': 1, 'best': 2, 'high': 3}, 'movements': [],
                                          'closing': {'low': 1, 'best': 2, 'high': 3}, 'tolerance': 0})
    refused('rec-refuse-contingent-production', 'reconcile', {'resourceClass': 'contingent', 'unit': 'MMboe', 'periodYears': 1, 'opening': {'low': 1, 'best': 2, 'high': 3},
                                                              'movements': [{'type': 'production', 'quantity': 1}], 'closing': {'low': 0, 'best': 1, 'high': 2}, 'tolerance': 0}, 'movements[0].type')
    refused('rec-refuse-production-by-category', 'reconcile', dict(RC, movements=[{'type': 'production', 'low': 1, 'best': 1, 'high': 1}]), 'movements[0].low')
    refused('rec-refuse-negative-addition', 'reconcile', dict(RC, movements=[{'type': 'improved-recovery', 'low': -1, 'best': 0, 'high': 0}]), 'movements[0].low')
    refused('rec-refuse-negative-divestment', 'reconcile', dict(RC, movements=[{'type': 'divestments', 'low': -1, 'best': 0, 'high': 0}]), 'movements[0].low')
    refused('rec-refuse-quantity-on-revision', 'reconcile', dict(RC, movements=[{'type': 'revisions', 'low': 0, 'best': 0, 'high': 0, 'quantity': 1}]), 'movements[0].quantity')
    refused('rec-refuse-type', 'reconcile', dict(RC, movements=[{'type': 'discoveries', 'low': 0, 'best': 0, 'high': 0}]), 'movements[0].type')
    refused('rec-refuse-opening-order', 'reconcile', dict(RC, opening={'low': 21, 'best': 15.2, 'high': 27.5}), 'opening')
    refused('rec-refuse-no-tolerance', 'reconcile', without(RC, 'tolerance'), 'tolerance')
    refused('rec-refuse-period', 'reconcile', dict(RC, periodYears=0), 'periodYears')
    refused('rec-refuse-class', 'reconcile', dict(RC, resourceClass='prospective'), 'resourceClass')
    refused('rec-refuse-unknown-key', 'reconcile', dict(RC, movements=[dict(RC['movements'][0], year=2027)]), 'movements[0].year')


def main():
    build()
    ids = [c['id'] for c in CASES]
    if len(set(ids)) != len(ids):
        sys.exit('duplicate case ids')
    doc = {
        'module': 'prms',
        'generatedBy': 'tools/validation/economics/oracle_prms.py',
        'engine': 'engines/economics/prms.js',
        'tolerance': {'absoluteFloor': 1e-6, 'note': 'relative tol per case (1e-9); absolute floor 1e-6; the Monte Carlo figures of aggregate are the oracle\'s replay of the stated sampler recipe, and each case\'s "witness" holds the exact mean (and, for a normal total, the exact quantiles) the gate checks the sampled figures against within 5 standard errors'},
        'cases': CASES,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(doc, f, indent=1, ensure_ascii=True, allow_nan=False)
        f.write('\n')
    n_err = sum(1 for c in CASES if isinstance(c['expected'], dict) and c['expected'].get('error') is True)
    print(f'wrote {os.path.relpath(OUT, ROOT)}: {len(CASES)} cases, {n_err} refusals')


if __name__ == '__main__':
    main()
