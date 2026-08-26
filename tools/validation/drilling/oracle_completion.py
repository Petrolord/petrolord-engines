#!/usr/bin/env python3
"""Independent oracle for the completion design engine (Drilling D7):
API 5CT drift diameters, completion stack-up, run-in clearance against the
exposed casing program, through-bore restriction profile, completion
volumes and seal space-out. Emits
test-data/drilling/goldens/completion_cases.json.

Independence discipline: every quantity is recomputed here from the
published bases (API 5CT drift deductions; plain geometry for capacities)
with interval bookkeeping written independently of the JS engine (explicit
per-centimetre summation for the volume cross-check instead of the JS
breakpoint integration). Closed forms are self-asserted BEFORE writing:

  drift     9-5/8" 47#  ID 8.681"  ->  8.525"   (- 5/32")
            7"     29#  ID 6.184"  ->  6.059"   (- 1/8")
            2-7/8" tbg  ID 2.441"  ->  2.34725" (- 3/32")
  capacity  2-7/8" 6.5# tubing = ID^2/1029.4 bbl/ft = 0.0057884
            (identical to pi/4*ID^2 in SI within 5e-5 relative — the
            1029.4 divisor is itself a rounded constant)
  stack     bottom MD = hanger + sum(lengths) exactly
  profile   governing drift is non-increasing with depth

The golden rides the D1/D6 slant well (TD 3000 m MD) with the D6 golden
9-5/8" two-section casing (47# P-110 / 53.5# L-80, break 1650 m) plus a
7" 29# liner hung at 2400 m — the liner overlap exercises the innermost-
exposed-bore logic and the drift class change.

Regenerate:  tools/validation/drilling/.venv/bin/python \\
                 tools/validation/drilling/oracle_completion.py
"""
import math

from oracle_torquedrag import rnd, write  # noqa: F401

IN = 0.0254
MM = 1e-3

# API 5CT deductions are exact inch fractions (the mm values seen in
# tables are roundings of these).
DRIFT_TBG = (3.0 / 32.0) * IN
DRIFT_CSG_SMALL = (1.0 / 8.0) * IN    # OD <= 8-5/8"
DRIFT_CSG_MID = (5.0 / 32.0) * IN     # 9-5/8" .. 13-3/8"
DRIFT_CSG_LARGE = (3.0 / 16.0) * IN   # OD >= 16"


def drift(od_m, id_m, kind):
    if kind == 'tubing':
        return id_m - DRIFT_TBG
    if od_m <= 8.625 * IN:
        return id_m - DRIFT_CSG_SMALL
    if od_m <= 13.375 * IN:
        return id_m - DRIFT_CSG_MID
    return id_m - DRIFT_CSG_LARGE


def area(d_m):
    return math.pi / 4.0 * d_m * d_m


# ------------------------------------------------------------ self-asserts

def self_assert():
    # Published drift spot values.
    assert abs(drift(9.625 * IN, 8.681 * IN, 'casing') / IN - 8.525) < 2e-3, \
        drift(9.625 * IN, 8.681 * IN, 'casing') / IN
    assert abs(drift(7.0 * IN, 6.184 * IN, 'casing') / IN - 6.059) < 2e-3
    assert abs(drift(2.875 * IN, 2.441 * IN, 'tubing') / IN - 2.34725) < 1e-3
    # Capacity: the field identity ID^2/1029.4 bbl/ft vs SI geometry.
    id_in = 2.441
    bbl_ft_field = id_in * id_in / 1029.4
    m3_per_m = area(id_in * IN)
    bbl_ft_si = m3_per_m / 0.158987294928 * 0.3048
    assert abs(bbl_ft_field - 0.0057884) < 1e-6, bbl_ft_field
    assert abs(bbl_ft_si - bbl_ft_field) / bbl_ft_field < 5e-5
    # Stack telescoping.
    lens = [150.0, 0.9, 2.2, 0.9, 2295.9]
    tops = []
    md = 0.0
    for L in lens:
        tops.append(md)
        md += L
    assert md == sum(lens)
    print('self-asserts pass')


# ------------------------------------------------------------ golden inputs

CASING_STRINGS = [
    {
        'name': '9-5/8" production casing',
        'sections': [
            {'topMdM': 0.0, 'bottomMdM': 1650.0, 'odM': 9.625 * IN, 'idM': 8.681 * IN},
            {'topMdM': 1650.0, 'bottomMdM': 3000.0, 'odM': 9.625 * IN, 'idM': 8.535 * IN},
        ],
    },
    {
        'name': '7" liner',
        'sections': [
            {'topMdM': 2400.0, 'bottomMdM': 3000.0, 'odM': 7.0 * IN, 'idM': 6.184 * IN},
        ],
    },
]

# 3-1/2" completion (catalog planning dims; EUE coupling OD 4.5").
CPL = 4.5 * IN
ID35 = 2.992 * IN
X35 = 2.75 * IN
XN35 = 2.635 * IN

COMPONENTS = [
    {'type': 'tubing', 'name': 'Tubing 3-1/2" EUE', 'lengthM': 150.0, 'odM': CPL, 'idM': ID35},
    {'type': 'flow-coupling', 'name': 'Flow coupling 3-1/2"', 'lengthM': 0.9, 'odM': CPL, 'idM': ID35},
    {'type': 'sssv', 'name': 'TRSV safety valve 3-1/2"', 'lengthM': 2.2, 'odM': 5.75 * IN, 'idM': X35},
    {'type': 'flow-coupling', 'name': 'Flow coupling 3-1/2"', 'lengthM': 0.9, 'odM': CPL, 'idM': ID35},
    {'type': 'tubing', 'name': 'Tubing 3-1/2" EUE', 'lengthM': 2295.9, 'odM': CPL, 'idM': ID35},
    {'type': 'spm', 'name': 'Side pocket mandrel 3-1/2"', 'lengthM': 2.4, 'odM': 5.75 * IN, 'idM': ID35},
    {'type': 'tubing', 'name': 'Tubing 3-1/2" EUE', 'lengthM': 145.2, 'odM': CPL, 'idM': ID35},
    {'type': 'sliding-sleeve', 'name': 'Sliding sleeve 3-1/2"', 'lengthM': 1.5, 'odM': 4.56 * IN, 'idM': X35},
    {'type': 'packer', 'name': 'Production packer 7" casing', 'lengthM': 1.5, 'odM': 5.875 * IN, 'idM': 2.75 * IN},
    {'type': 'tubing', 'name': 'Tubing 3-1/2" EUE', 'lengthM': 2.0, 'odM': CPL, 'idM': ID35},
    {'type': 'nipple-xn', 'name': 'XN no-go nipple 3-1/2"', 'lengthM': 0.45, 'odM': CPL, 'idM': XN35},
    {'type': 'perforated-joint', 'name': 'Perforated joint 3-1/2"', 'lengthM': 3.0, 'odM': 3.5 * IN, 'idM': ID35},
    {'type': 'weg', 'name': 'Wireline entry guide 3-1/2"', 'lengthM': 0.3, 'odM': CPL, 'idM': ID35},
]

HANGER_MD = 0.0
TD_MD = 3000.0
WARN_MARGIN = 0.003


# ------------------------------------------------------------ oracle model

def stack_up():
    md = HANGER_MD
    rows = []
    for c in COMPONENTS:
        r = dict(c)
        r['topMdM'] = md
        md += c['lengthM']
        r['bottomMdM'] = md
        rows.append(r)
    return rows, md


def exposed_profile():
    secs = []
    for s in CASING_STRINGS:
        for sec in s['sections']:
            secs.append(dict(sec, label=s['name']))
    cuts = sorted({x for s in secs for x in (s['topMdM'], s['bottomMdM'])})
    out = []
    for a, b in zip(cuts, cuts[1:]):
        mid = (a + b) / 2
        covering = [s for s in secs if s['topMdM'] <= mid < s['bottomMdM']]
        if not covering:
            continue
        inner = min(covering, key=lambda s: s['idM'])
        seg = {
            'topMdM': a, 'bottomMdM': b, 'idM': inner['idM'], 'odM': inner['odM'],
            'driftM': drift(inner['odM'], inner['idM'], 'casing'), 'label': inner['label'],
        }
        if out and out[-1]['bottomMdM'] == a and out[-1]['idM'] == seg['idM'] \
                and out[-1]['label'] == seg['label']:
            out[-1]['bottomMdM'] = b
        else:
            out.append(seg)
    return out


def governing_drift_to(profile, md):
    best = None
    for seg in profile:
        if seg['topMdM'] >= md:
            break
        if best is None or seg['driftM'] < best['driftM']:
            best = {'driftM': seg['driftM'], 'label': seg['label']}
    return best


def clearance(rows, profile):
    out = []
    for c in rows:
        gov = governing_drift_to(profile, c['bottomMdM'])
        cl = gov['driftM'] - c['odM']
        status = 'FAIL' if cl < 0 else 'WARN' if cl < WARN_MARGIN else 'PASS'
        out.append({
            'name': c['name'], 'odM': c['odM'], 'bottomMdM': c['bottomMdM'],
            'governingDriftM': gov['driftM'], 'controlling': gov['label'],
            'clearanceM': cl, 'status': status,
        })
    return out


def through_bore(rows):
    out = []
    cur = float('inf')
    ctrl = None
    for c in rows:
        if c['idM'] < cur:
            cur = c['idM']
            ctrl = c['name']
        out.append({'name': c['name'], 'cumMinIdM': cur, 'controlling': ctrl})
    return out, cur, ctrl


def volumes(rows, profile, packer_md, bottom_md):
    # Independent route: brute-force 1 cm slices (vs the JS breakpoint
    # integration). 3000 m at 1 cm = 3e5 slices per region — fine.
    def bore_at(md):
        for seg in profile:
            if seg['topMdM'] <= md < seg['bottomMdM']:
                return seg['idM']
        return None

    def comp_at(md):
        for c in rows:
            if c['topMdM'] <= md < c['bottomMdM']:
                return c
        return None

    string_cap = sum(area(c['idM']) * c['lengthM'] for c in rows)
    string_disp = sum(area(c['odM']) * c['lengthM'] for c in rows)

    dz = 0.01
    ann = 0.0
    md = HANGER_MD
    while md < packer_md - 1e-12:
        step = min(dz, packer_md - md)
        mid = md + step / 2
        bore = bore_at(mid)
        c = comp_at(mid)
        od = c['odM'] if c else 0.0
        ann += (area(bore) - area(od)) * step
        md += step

    below = 0.0
    md = packer_md
    while md < bottom_md - 1e-12:
        step = min(dz, bottom_md - md)
        mid = md + step / 2
        bore = bore_at(mid)
        c = comp_at(mid)
        tail = area(c['odM']) * step if c else 0.0
        below += area(bore) * step - tail
        md += step

    return {
        'stringCapacityM3': string_cap,
        'stringDisplacementM3': string_disp,
        'annulusAbovePackerM3': ann,
        'belowPackerM3': below,
    }


def space_out(pbr_len, insert, dl, margin=0.5):
    available = (pbr_len - insert) if dl >= 0 else insert
    remaining = available - abs(dl)
    status = 'FAIL' if remaining < 0 else 'WARN' if remaining < margin else 'PASS'
    return {'availableM': available, 'usedM': abs(dl), 'remainingM': remaining,
            'status': status}


def main():
    self_assert()

    rows, bottom = stack_up()
    profile = exposed_profile()

    # Structural self-asserts on the golden itself.
    drifts = [governing_drift_to(profile, d)['driftM'] for d in (1000.0, 2000.0, 3000.0)]
    assert drifts[0] > drifts[1] > drifts[2], drifts  # non-increasing with depth
    assert abs(drifts[1] / IN - (8.535 - 5.0 / 32.0)) < 1e-9
    assert abs(drifts[2] / IN - (6.184 - 1.0 / 8.0)) < 1e-9
    assert abs(bottom - sum(c['lengthM'] for c in COMPONENTS)) < 1e-12

    packer = next(c for c in rows if c['type'] == 'packer')
    packer_md = packer['bottomMdM']

    cl = clearance(rows, profile)
    tb_rows, tb_min, tb_ctrl = through_bore(rows)
    vols = volumes(rows, profile, packer_md, TD_MD)

    space_cases = [
        {'name': 'heating-elongation', 'pbrLengthM': 6.1, 'insertLengthM': 3.0,
         'expectedDLM': 1.2, 'marginM': 0.5},
        {'name': 'stimulation-contraction', 'pbrLengthM': 6.1, 'insertLengthM': 3.0,
         'expectedDLM': -2.8, 'marginM': 0.5},
    ]
    for c in space_cases:
        c['result'] = space_out(c['pbrLengthM'], c['insertLengthM'],
                                c['expectedDLM'], c['marginM'])

    # Drift table for every catalog-style row the suite gate spot-checks.
    drift_table = [
        {'odIn': 9.625, 'idIn': 8.681, 'kind': 'casing', 'driftIn': drift(9.625 * IN, 8.681 * IN, 'casing') / IN},
        {'odIn': 9.625, 'idIn': 8.535, 'kind': 'casing', 'driftIn': drift(9.625 * IN, 8.535 * IN, 'casing') / IN},
        {'odIn': 7.0, 'idIn': 6.184, 'kind': 'casing', 'driftIn': drift(7.0 * IN, 6.184 * IN, 'casing') / IN},
        {'odIn': 13.375, 'idIn': 12.415, 'kind': 'casing', 'driftIn': drift(13.375 * IN, 12.415 * IN, 'casing') / IN},
        {'odIn': 20.0, 'idIn': 19.124, 'kind': 'casing', 'driftIn': drift(20.0 * IN, 19.124 * IN, 'casing') / IN},
        {'odIn': 2.875, 'idIn': 2.441, 'kind': 'tubing', 'driftIn': drift(2.875 * IN, 2.441 * IN, 'tubing') / IN},
        {'odIn': 3.5, 'idIn': 2.992, 'kind': 'tubing', 'driftIn': drift(3.5 * IN, 2.992 * IN, 'tubing') / IN},
    ]

    write('completion_cases.json', {
        'description': '3-1/2" completion in the D6 golden 9-5/8" casing + '
                       '7" liner on the slant well; oracle_completion.py',
        'warnMarginM': WARN_MARGIN,
        'program': {'strings': CASING_STRINGS},
        'stack': {'hangerMdM': HANGER_MD, 'components': COMPONENTS},
        'packerMdM': packer_md,
        'tdMdM': TD_MD,
        'driftTable': drift_table,
        'results': {
            'bottomMdM': bottom,
            'profile': profile,
            'stackRows': [{'name': r['name'], 'topMdM': r['topMdM'],
                           'bottomMdM': r['bottomMdM']} for r in rows],
            'clearance': cl,
            'throughBore': {'rows': tb_rows, 'minIdM': tb_min,
                            'controlling': tb_ctrl},
            'volumes': vols,
            'spaceOut': space_cases,
        },
    })


if __name__ == '__main__':
    main()
