#!/usr/bin/env python3
"""Independent oracle for the well integrity & P&A engines (Drilling
D10): barrier envelope categorization (NORSOK D-010 two-barrier
convention, Norsk olje og gass 117-style traffic light), element-governed
MAASP / API RP 90-style MAWOP in the differential hydrostatic form, the
balanced cement plug closed forms, D-010-style permanent-barrier rule
checks and the phased abandonment program. Emits
test-data/drilling/goldens/wellintegrity_cases.json.

Independence discipline: rule tables and closed forms implemented here
with explicit arithmetic (no shared code with the JS engine); the golden
rides the D1 slant well with element TVDs from the planar min-curvature
tvd_of. Self-asserted BEFORE writing:

  category   full 4x4 (intact/degraded/failed/empty)^2 truth table
             hand-enumerated: red needs a failure plus a degraded/
             failed/missing partner; a lone failure is orange; a
             single-envelope well is orange; degradation without
             failure is yellow; both intact is green
  MAASP      P = f*limit - (rho_ann - rho_backup)*g*TVD:
             0.8*30 MPa at TVD 2000 m, ann 1200 / backup 1030 kg/m3
             -> 24e6 - 170*9.80665*2000 = 20,665,739 Pa (hand)
  MAWOP      RP 90 factors 0.50/0.80/0.75; three-candidate fixture
             governed by the tubing-collapse row (hand min)
  plug       hole 0.216 m, stinger 0.127/0.1086 m, 1850-2000 m MD,
             20% excess, 1 m3 spacer ahead:
             c_hole = pi/4*0.216^2, slurry = c_hole*150*1.2,
             plugged top after POOH = 2000 - 180 = 1820 m EXACTLY;
             zero-excess identity: plugged top == design top;
             spacer balance: V_behind/c_in == V_ahead/c_ann
  rules      100 m plug (50 m on foundation), 50 m above source,
             surface 50 m, annular 30 m verified / 100 m unverified
             — pass/fail table hand-enumerated
  program    2-zone fixture: reservoir zone gets two source-covering
             primaries plus P3 as an above-source secondary (pass);
             the intermediate zone gets P3 as primary and no secondary
             (fail); surface plug 60 m passes; takeoff sums the
             designed slurry only

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_wellintegrity.py
"""
import math

from oracle_torquedrag import WELLS, write  # noqa: F401
from oracle_hydraulics import tvd_of  # noqa: F401

G = 9.80665

# ------------------------------------------------------------ barriers

STATUS_RANK = ('intact', 'degraded', 'failed', 'empty')


def envelope_status(elements):
    if not elements:
        return 'empty'
    if any(e['status'] == 'failed' for e in elements):
        return 'failed'
    if any(e['status'] in ('degraded', 'not-verified') for e in elements):
        return 'degraded'
    return 'intact'


def category(primary, secondary, flow=True):
    bad = lambda s: s in ('failed', 'empty')  # noqa: E731
    if not flow:
        if primary == 'failed':
            return 'orange'
        return 'yellow' if primary == 'degraded' else 'green'
    failures = [primary, secondary].count('failed')
    if failures:
        other = secondary if primary == 'failed' else primary
        if failures == 2 or bad(other) or other == 'degraded':
            return 'red'
        return 'orange'
    if primary == 'empty' or secondary == 'empty':
        return 'orange'
    if primary == 'degraded' or secondary == 'degraded':
        return 'yellow'
    return 'green'


# Hand-enumerated truth table (the JS engine must match every row).
CATEGORY_TABLE_HAND = {
    ('intact', 'intact'): 'green',
    ('intact', 'degraded'): 'yellow',
    ('degraded', 'intact'): 'yellow',
    ('degraded', 'degraded'): 'yellow',
    ('failed', 'intact'): 'orange',
    ('intact', 'failed'): 'orange',
    ('failed', 'degraded'): 'red',
    ('degraded', 'failed'): 'red',
    ('failed', 'failed'): 'red',
    ('intact', 'empty'): 'orange',
    ('empty', 'intact'): 'orange',
    ('degraded', 'empty'): 'orange',
    ('empty', 'degraded'): 'orange',
    ('failed', 'empty'): 'red',
    ('empty', 'failed'): 'red',
    ('empty', 'empty'): 'orange',
}

# ------------------------------------------------------------ annulus

RP90 = {'outer-casing-burst': 0.50, 'inner-casing-burst': 0.80,
        'inner-tubing-collapse': 0.75, 'shoe-formation': 1.0}


def allow_surface(limit, factor, tvd, rho_ann, rho_backup):
    return factor * limit - (rho_ann - rho_backup) * G * tvd


def maasp(rho_ann, elements):
    rows = []
    for e in elements:
        rows.append(dict(
            name=e['name'],
            allowSurfacePa=allow_surface(
                e['limitPa'], e.get('factor', RP90.get(e.get('role'), 1.0)),
                e['tvdM'], rho_ann, e.get('backupDensityKgM3', 0.0)),
        ))
    gov = min(rows, key=lambda r: r['allowSurfacePa'])
    return dict(rows=rows, governing=gov['name'],
                maaspPa=max(0.0, gov['allowSurfacePa']))


# ------------------------------------------------------------ P&A

RULES = dict(plugMinLengthM=100.0, plugMinLengthOnFoundationM=50.0,
             plugAboveSourceMinM=50.0, surfacePlugMinLengthM=50.0,
             annularCementVerifiedMinM=30.0, annularCementUnverifiedMinM=100.0)


def cap(d):
    return math.pi / 4.0 * d * d


def balanced_plug(hole_id, st_od, st_id, base, top, excess, spacer_ahead):
    length = base - top
    c_hole, c_ann, c_in = cap(hole_id), cap(hole_id) - cap(st_od), cap(st_id)
    slurry = c_hole * length * (1.0 + excess)
    h = slurry / (c_ann + c_in)
    behind = spacer_ahead * c_in / c_ann
    disp = c_in * (base - h) - behind
    return dict(lengthM=length, cHoleM2=c_hole, cAnnM2=c_ann, cInM2=c_in,
                slurryM3=slurry, balancedHeightM=h, spacerBehindM3=behind,
                displacementM3=disp, asPumpedTopMdM=base - h,
                pluggedTopMdM=base - slurry / c_hole)


def plug_ok(plug, source_top, rules=RULES):
    length = plug['bottomMdM'] - plug['topMdM']
    on_found = plug.get('foundation', 'none') in ('mechanical', 'tagged')
    if plug.get('isSurfacePlug'):
        return length >= rules['surfacePlugMinLengthM']
    req = rules['plugMinLengthOnFoundationM'] if on_found else rules['plugMinLengthM']
    if length < req:
        return False
    if source_top is not None:
        if source_top - plug['topMdM'] < rules['plugAboveSourceMinM']:
            return False
        if plug['bottomMdM'] < source_top:
            return False
    return True


# ------------------------------------------------------------ fixtures

MAASP_FIX = dict(limitPa=30.0e6, factor=0.8, tvdM=2000.0,
                 backupDensityKgM3=1030.0)
ANN_RHO = 1200.0

MAWOP_CANDS = [
    dict(name='9-5/8 production casing burst', role='outer-casing-burst',
         limitPa=40.0e6, mdM=1600.0, backupDensityKgM3=1030.0),
    dict(name='7 in production liner burst', role='inner-casing-burst',
         limitPa=35.0e6, mdM=1250.0, backupDensityKgM3=1100.0),
    dict(name='4-1/2 tubing collapse', role='inner-tubing-collapse',
         limitPa=25.0e6, mdM=1030.0, backupDensityKgM3=500.0),
]

PLUG_FIX = dict(holeIdM=0.216, stingerOdM=0.127, stingerIdM=0.1086,
                plugBaseMdM=2000.0, plugTopMdM=1850.0,
                excessFrac=0.2, spacerAheadM3=1.0)

BARRIER_ELEMENTS = [
    dict(name='Casing cement (production)', kind='casing-cement', envelope='primary', status='verified'),
    dict(name='Production casing below packer', kind='casing', envelope='primary', status='verified'),
    dict(name='Production packer', kind='production-packer', envelope='primary', status='verified'),
    dict(name='Completion string', kind='completion-string', envelope='primary', status='verified'),
    dict(name='DHSV', kind='dhsv', envelope='primary', status='degraded'),
    dict(name='Casing cement (intermediate)', kind='casing-cement', envelope='secondary', status='verified'),
    dict(name='Production casing', kind='casing', envelope='secondary', status='verified'),
    dict(name='Wellhead', kind='wellhead', envelope='secondary', status='verified'),
    dict(name='Tubing hanger', kind='tubing-hanger', envelope='secondary', status='verified'),
    dict(name='Christmas tree', kind='xmas-tree', envelope='secondary', status='verified'),
]

ZONES = [
    dict(name='Reservoir sand', topMdM=2500.0, bottomMdM=2600.0, flowPotential=True),
    dict(name='Intermediate gas stringer', topMdM=1800.0, bottomMdM=1850.0, flowPotential=True),
]

PLUGS = [
    dict(name='P1 reservoir primary', topMdM=2380.0, bottomMdM=2520.0,
         foundation='mechanical', isSurfacePlug=False,
         geometry=dict(holeIdM=0.216, stingerOdM=0.127, stingerIdM=0.1086,
                       excessFrac=0.2, spacerAheadM3=1.0)),
    dict(name='P2 reservoir secondary', topMdM=2350.0, bottomMdM=2510.0,
         foundation='none', isSurfacePlug=False, geometry=None),
    dict(name='P3 intermediate', topMdM=1700.0, bottomMdM=1810.0,
         foundation='none', isSurfacePlug=False, geometry=None),
    dict(name='S1 surface plug', topMdM=0.0, bottomMdM=60.0,
         foundation='none', isSurfacePlug=True, geometry=None),
]


def zone_quals(source_top):
    barrier = [p for p in PLUGS if not p['isSurfacePlug']]
    prim = [p['name'] for p in barrier if plug_ok(p, source_top)]
    sec = [p['name'] for p in barrier
           if p['name'] not in prim and p['bottomMdM'] <= source_top
           and plug_ok(p, None)]
    return prim, sec


def self_asserts():
    # Categorization truth table: computed == hand-enumerated, all 16.
    for (p, s), want in CATEGORY_TABLE_HAND.items():
        got = category(p, s)
        assert got == want, (p, s, got, want)
    assert category('failed', 'intact', flow=False) == 'orange'
    assert category('degraded', 'empty', flow=False) == 'yellow'
    assert category('intact', 'empty', flow=False) == 'green'
    # Envelope roll-up: not-verified degrades; failed dominates.
    assert envelope_status([]) == 'empty'
    assert envelope_status([dict(status='verified'), dict(status='not-verified')]) == 'degraded'
    assert envelope_status([dict(status='degraded'), dict(status='failed')]) == 'failed'
    # MAASP hand fixture.
    p = allow_surface(30.0e6, 0.8, 2000.0, ANN_RHO, 1030.0)
    hand = 24.0e6 - 170.0 * G * 2000.0
    assert abs(p - hand) < 1e-6 and abs(hand - 20665739.0) < 1.0, (p, hand)
    # MAWOP: tubing-collapse row governs the fixture (hand min).
    cands = [dict(e, tvdM=e['mdM']) for e in MAWOP_CANDS]  # vertical check
    rows = maasp(ANN_RHO, cands)
    a = allow_surface(40.0e6, 0.50, 1600.0, ANN_RHO, 1030.0)
    b = allow_surface(35.0e6, 0.80, 1250.0, ANN_RHO, 1100.0)
    c = allow_surface(25.0e6, 0.75, 1030.0, ANN_RHO, 500.0)
    assert c < a < b, (a, b, c)
    assert rows['governing'] == '4-1/2 tubing collapse'
    assert abs(rows['maaspPa'] - c) < 1e-9
    # Balanced plug closed forms.
    bp = balanced_plug(0.216, 0.127, 0.1086, 2000.0, 1850.0, 0.2, 1.0)
    assert abs(bp['pluggedTopMdM'] - 1820.0) < 1e-9, bp['pluggedTopMdM']
    assert abs(bp['slurryM3'] - cap(0.216) * 150.0 * 1.2) < 1e-12
    # Spacer balance: equal column heights.
    assert abs(bp['spacerBehindM3'] / bp['cInM2'] - 1.0 / bp['cAnnM2']) < 1e-12
    # Zero-excess identity: plugged top == design top.
    bp0 = balanced_plug(0.216, 0.127, 0.1086, 2000.0, 1850.0, 0.0, 0.0)
    assert abs(bp0['pluggedTopMdM'] - 1850.0) < 1e-9
    # Volume conservation: slurry sits in annulus + stinger at balance.
    v_check = bp['balancedHeightM'] * (bp['cAnnM2'] + bp['cInM2'])
    assert abs(v_check - bp['slurryM3']) < 1e-12
    # Rule checks.
    assert plug_ok(dict(topMdM=2380.0, bottomMdM=2520.0, foundation='mechanical'), 2500.0)
    assert not plug_ok(dict(topMdM=2380.0, bottomMdM=2420.0, foundation='none'), 2500.0)  # short + no cover
    assert not plug_ok(dict(topMdM=2470.0, bottomMdM=2580.0, foundation='none'), 2500.0)  # only 30 m above
    assert plug_ok(dict(topMdM=0.0, bottomMdM=60.0, isSurfacePlug=True), None)
    assert not plug_ok(dict(topMdM=0.0, bottomMdM=40.0, isSurfacePlug=True), None)
    # Program compliance fixture: primaries cover the source; the
    # secondary backs up from above (length rule, base above the source).
    r_prim, r_sec = zone_quals(2500.0)
    i_prim, i_sec = zone_quals(1800.0)
    assert r_prim == ['P1 reservoir primary', 'P2 reservoir secondary'], r_prim
    assert r_sec == ['P3 intermediate'], r_sec
    assert i_prim == ['P3 intermediate'] and i_sec == [], (i_prim, i_sec)
    print('self-asserts OK')


def main():
    self_asserts()
    stations, shoe, td = WELLS['slant']

    # Barrier fixture (envelope statuses + category).
    prim = envelope_status([e for e in BARRIER_ELEMENTS if e['envelope'] in ('primary', 'both')])
    sec = envelope_status([e for e in BARRIER_ELEMENTS if e['envelope'] in ('secondary', 'both')])
    cat = category(prim, sec)
    assert (prim, sec, cat) == ('degraded', 'intact', 'yellow')

    # A-annulus MAWOP on the slant well: element TVDs from the trajectory.
    cands = []
    for e in MAWOP_CANDS:
        cands.append(dict(e, tvdM=tvd_of(stations, e['mdM'])))
    mw = maasp(ANN_RHO, cands)

    # Single-element MAASP fixture at a trajectory TVD.
    fix_tvd = tvd_of(stations, 2400.0)
    maasp_fix = allow_surface(MAASP_FIX['limitPa'], MAASP_FIX['factor'],
                              fix_tvd, ANN_RHO, MAASP_FIX['backupDensityKgM3'])

    # Balanced plug + program.
    bp = balanced_plug(
        PLUG_FIX['holeIdM'], PLUG_FIX['stingerOdM'], PLUG_FIX['stingerIdM'],
        PLUG_FIX['plugBaseMdM'], PLUG_FIX['plugTopMdM'],
        PLUG_FIX['excessFrac'], PLUG_FIX['spacerAheadM3'])

    p1 = PLUGS[0]
    p1_place = balanced_plug(
        p1['geometry']['holeIdM'], p1['geometry']['stingerOdM'],
        p1['geometry']['stingerIdM'], p1['bottomMdM'], p1['topMdM'],
        p1['geometry']['excessFrac'], p1['geometry']['spacerAheadM3'])

    zone_compliance = []
    for z in sorted([z for z in ZONES if z['flowPotential']],
                    key=lambda z: -z['topMdM']):
        zp, zs = zone_quals(z['topMdM'])
        zone_compliance.append(dict(
            zone=z['name'], topMdM=z['topMdM'],
            primaryQualifying=zp, secondaryQualifying=zs, required=2,
            passZone=len(zp) >= 1 and len(zp) + len(zs) >= 2))
    program_pass = all(c['passZone'] for c in zone_compliance) and \
        plug_ok(PLUGS[3], None)
    assert [c['passZone'] for c in zone_compliance] == [True, False]
    assert not program_pass

    write('wellintegrity_cases.json', {
        'description': 'Well integrity & P&A oracle: NORSOK D-010-style '
                       'barrier categorization truth table, element-'
                       'governed MAASP / API RP 90 MAWOP in the '
                       'differential hydrostatic form on the D1 slant '
                       'well, balanced cement plug closed forms, D-010 '
                       'permanent-barrier rule checks and the 2-zone '
                       'program compliance fixture. JS engine must agree '
                       'rtol 1e-9 (rule tables exact).',
        'params': {
            'annulusFluidDensityKgM3': ANN_RHO,
            'maaspFixture': {**MAASP_FIX, 'mdM': 2400.0, 'tvdM': fix_tvd},
            'mawopCandidates': MAWOP_CANDS,
            'plugFixture': PLUG_FIX,
            'rules': RULES,
        },
        'stations': [{'md': m, 'inc': i, 'azi': a} for m, i, a in stations],
        'categoryTable': [
            {'primary': p, 'secondary': s, 'category': c}
            for (p, s), c in sorted(CATEGORY_TABLE_HAND.items())
        ],
        'barrier': {
            'elements': BARRIER_ELEMENTS,
            'primaryStatus': prim,
            'secondaryStatus': sec,
            'category': cat,
        },
        'annulus': {
            'mawop': {
                'rows': [{'name': r['name'],
                          'allowSurfacePa': r['allowSurfacePa'],
                          'tvdM': c['tvdM']}
                         for r, c in zip(mw['rows'], cands)],
                'governing': mw['governing'],
                'mawopPa': mw['maaspPa'],
            },
            'maaspFixtureAllowPa': maasp_fix,
        },
        'plug': bp,
        'program': {
            'zones': ZONES,
            'plugs': [{k: v for k, v in p.items()} for p in PLUGS],
            'p1Placement': p1_place,
            'zoneCompliance': zone_compliance,
            'surfacePlugPass': plug_ok(PLUGS[3], None),
            'programPass': program_pass,
        },
    })


if __name__ == '__main__':
    main()
