"""Independent oracle for engines/qi/prospectAssessment.js (QI course gate
E1c, G8): anomaly conformance, the implied contact and its GRV, evidence
independence and the decision table.

Standard library only, no shared code (it does not import the mapping
oracle), never the JS loops, and with DIFFERENT algorithms from the closure
engine the JS sits on:

  spill elevation  Kruskal-style union-find: live nodes are added in
                   DESCENDING elevation, joining 4-neighbours already added;
                   the spill is the elevation of the node whose addition first
                   puts the crest in one set with a boundary node (an edge node
                   or one with a null 4-neighbour). The JS floods with a heap.
  closure          breadth-first search from the crest over the nodes strictly
                   above a contact, recomputed for every contact (the JS reads
                   a prefix of its flood order).
  GRV              explicit cell summation sum (z - contact) |dx dy| over that
                   closure.
  conformance      written from the module's definitions (Roden, Forrest and
                   Holeywell 2005): the downdip edge of the anomaly is read at
                   the midpoint of every pair (anomaly node, lower mapped
                   4-neighbour outside the anomaly), averaged per anomaly node;
                   its mean is the implied contact, its sample standard
                   deviation the edge scatter; conformance = 1 - scatter /
                   relief clipped to 0..1 (relief = crest - spill); the share of
                   the anomaly inside the closure at the spill; the GRV at the
                   implied contact held at the spill.
  evidence         grouped by response with a dictionary; independent = the
                   distinct responses holding at least one supporting item.
  decision table   the thresholds the module states (conformance 0.7 and 0.3,
                   two independent sources, the feasibility verdict, competing
                   explanations), as an ordered rule list.

Self-asserted anchors (generation fails loudly if any breaks):
  P1 a paraboloid dome z = -2000 - a r^2 on a fine grid: the GRV above the
     contact at radius R is within 1 percent of the cap volume pi a R^4 / 2;
     the spill is the highest boundary node (a single dome drains to the
     shallowest edge point).
  P2 a contact-bounded anomaly on that dome conforms (> 0.95) and implies its
     contact within one cell of relief; a patch across the flank does not
     (< 0.85) and its edge scatter is over five times larger.
  P3 a TILTED contact (the edge dips across the dome) lowers conformance in
     proportion to the tilt.
  P4 attributes from one response count once.

Every case list must be non-empty or the oracle refuses (exit 1).
Regeneration is byte-identical.

Usage: python3 -I tools/validation/qi/oracle_qi_prospect.py [dest.json]
"""
import json
import math
import os
import sys
from collections import deque

NULL = 1e30


def live(v):
    return v is not None and math.isfinite(v) and abs(v) < 1e29


def nbrs(i, nx, ny):
    r, c = divmod(i, nx)
    for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
        if 0 <= rr < ny and 0 <= cc < nx:
            yield rr * nx + cc


def on_boundary(z, nx, ny, i):
    r, c = divmod(i, nx)
    if r in (0, ny - 1) or c in (0, nx - 1):
        return True
    return any(not live(z[j]) for j in nbrs(i, nx, ny))


def spill_z(z, nx, ny, crest):
    parent = {}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    edge_root = 'EDGE'
    parent[edge_root] = edge_root
    for i in sorted((i for i in range(nx * ny) if live(z[i])), key=lambda i: (-z[i], i)):
        parent[i] = i
        if on_boundary(z, nx, ny, i):
            parent[find(i)] = find(edge_root)
        for j in nbrs(i, nx, ny):
            if j in parent:
                parent[find(i)] = find(j)
        if crest in parent and find(crest) == find(edge_root):
            return z[i]
    raise ValueError('never spills')


def closure(z, nx, ny, crest, contact):
    if not z[crest] > contact:
        return set()
    seen = {crest}
    q = deque([crest])
    while q:
        i = q.popleft()
        for j in nbrs(i, nx, ny):
            if j not in seen and live(z[j]) and z[j] > contact:
                seen.add(j)
                q.append(j)
    return seen


def grv(z, cells, contact, area):
    return math.fsum((z[i] - contact) * area for i in cells)


def conformance(z, nx, ny, dx, dy, mask, crest):
    area = abs(dx * dy)
    sz = spill_z(z, nx, ny, crest)
    inside_set = closure(z, nx, ny, crest, sz)
    relief = z[crest] - sz
    nodes = [i for i in range(nx * ny) if mask[i] > 0 and live(z[i])]
    if not nodes:
        raise ValueError('no anomaly')
    edge = []
    for i in nodes:
        mids = [(z[i] + z[j]) / 2 for j in nbrs(i, nx, ny) if not mask[j] > 0 and live(z[j]) and z[j] < z[i]]
        if mids:
            edge.append(math.fsum(mids) / len(mids))
    n = len(edge)
    mean = math.fsum(edge) / n if n else None
    sd = math.sqrt(math.fsum((v - mean) ** 2 for v in edge) / (n - 1)) if n > 1 else None
    conf = min(1.0, max(0.0, 1 - sd / relief)) if sd is not None and relief > 0 else None
    held = max(mean, sz) if mean is not None else None
    return {
        'edgeNodes': n, 'impliedContactZ': mean, 'edgeSdM': sd, 'reliefM': relief, 'conformance': conf,
        'insideClosure': sum(1 for i in nodes if i in inside_set) / len(nodes), 'anomalyNodes': len(nodes),
        'impliedVsSpillM': mean - sz if mean is not None else None,
        'grvAtImpliedM3': grv(z, closure(z, nx, ny, crest, held), held, area) if held is not None else None,
        'grvAtSpillM3': grv(z, inside_set, sz, area), 'spillZ': sz,
    }


SOURCES = ('full_stack', 'near_stack', 'far_stack', 'avo', 'elastic_inversion', 'frequency', 'well', 'other')


def evidence(items):
    groups = {}
    order = []
    for it in items:
        s = it['source'] if it['source'] in SOURCES else 'other'
        if s not in groups:
            groups[s] = []
            order.append(s)
        groups[s].append(it)
    supporting = [it for it in items if it.get('supports', True) is not False]
    indep = {s for s in order if any(it.get('supports', True) is not False for it in groups[s])}
    return {'independent': len(indep), 'supporting': len(supporting),
            'groups': [{'source': s, 'items': [it['name'] for it in groups[s]]} for s in order],
            'shared': [{'source': s, 'items': [it['name'] for it in groups[s]]} for s in order if len(groups[s]) > 1]}


def decide(a):
    present, conf, ins = a['anomalyPresent'], a.get('conformance'), a.get('insideClosure')
    indep, feas, comp = a.get('independent', 0), a.get('feasibility', ''), a.get('competing', [])
    visible = feas in ('feasible', 'conditional')
    has_conf = conf is not None
    rules = [
        (not present and feas == 'feasible', ('downgrade', 'against')),
        (not present, ('retain', 'neutral')),
        (any(c['status'] == 'likely' for c in comp) and has_conf and conf < 0.3, ('downgrade', 'against')),
        (any(c['status'] == 'likely' for c in comp), ('investigate', 'neutral')),
        (has_conf and conf < 0.3, ('investigate', 'neutral')),
    ]
    for cond, res in rules:
        if cond:
            return res
    shortfalls = [ins is not None and ins < 0.5, not has_conf or conf < 0.7, indep < 2,
                  any(c['status'] == 'open' for c in comp), not visible]
    return ('investigate', 'supports') if any(shortfalls) else ('mature', 'supports')


# --- grids -------------------------------------------------------------------

def dome(nx, ny, dx, a, cx, cy, top=-2000.0, ex=1.0):
    return [top - a * (((i % nx) * dx - cx) ** 2 / ex + ((i // nx) * dx - cy) ** 2) for i in range(nx * ny)]


def crest_of(z):
    return max((i for i in range(len(z)) if live(z[i])), key=lambda i: (z[i], -i))


def main():
    dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'test-data', 'qi', 'goldens.prospectAssessment.json')

    # P1 on a fine paraboloid
    nx = ny = 161
    dx = 12.5
    a = 0.0004
    z = dome(nx, ny, dx, a, 80 * dx, 80 * dx)
    c = crest_of(z)
    R = 500.0
    contact = -2000 - a * R * R
    cap = math.pi * a * R ** 4 / 2
    assert abs(grv(z, closure(z, nx, ny, c, contact), contact, dx * dx) - cap) / cap < 0.01
    sz = spill_z(z, nx, ny, c)
    assert sz == max(z[i] for i in range(nx * ny) if on_boundary(z, nx, ny, i))

    cases = []
    # the gated cases on an 81 x 81, 25 m grid
    nx = ny = 81
    dx = 25.0
    spec = {'x0': 0, 'y0': 0, 'dx': dx, 'dy': dx, 'nx': nx, 'ny': ny}
    cx = cy = 40 * dx
    zd = dome(nx, ny, dx, a, cx, cy)
    cd = crest_of(zd)
    flat = [1 if v >= contact else 0 for v in zd]
    off = [1 if ((i % nx) * dx - (cx + 450)) ** 2 + ((i // nx) * dx - cy) ** 2 <= 300 ** 2 else 0 for i in range(nx * ny)]

    def tilted(t):
        return [1 if zd[i] >= contact + t * ((i % nx) * dx - cx) else 0 for i in range(nx * ny)]
    # an elliptic dome cut by a saddle, with a null hole and a deeper neighbour
    ze = dome(nx, ny, dx, 0.0003, 30 * dx, 40 * dx, ex=2.0)
    for i in range(nx * ny):
        x, y = (i % nx) * dx, (i // nx) * dx
        ze[i] = max(ze[i], -2060 - 0.0005 * ((x - 62 * dx) ** 2 + (y - 40 * dx) ** 2))
        ze[i] = round(ze[i], 6)
    for r in range(36, 39):
        for cc in range(10, 13):
            ze[r * nx + cc] = NULL
    ce = crest_of(ze)
    ell = [1 if live(ze[i]) and ze[i] >= -2075 and (i % nx) < 45 else 0 for i in range(nx * ny)]

    for name, zz, mask, crest in (('dome_flat_contact', zd, flat, cd), ('dome_flank_patch', zd, off, cd),
                                  ('dome_tilted_0.05', zd, tilted(0.05), cd), ('dome_tilted_0.15', zd, tilted(0.15), cd),
                                  ('ellipse_saddle_hole', ze, ell, ce)):
        r = conformance(zz, nx, ny, dx, dx, mask, crest)
        cases.append({'name': name, 'z': [v if live(v) else None for v in zz], 'mask': mask, 'crest': crest, 'out': r})

    by = {k['name']: k['out'] for k in cases}
    # P2 and P3
    assert by['dome_flat_contact']['conformance'] > 0.95
    assert abs(by['dome_flat_contact']['impliedContactZ'] - contact) < a * 2 * R * dx
    assert by['dome_flat_contact']['insideClosure'] == 1
    assert by['dome_flank_patch']['conformance'] < 0.85
    assert by['dome_flank_patch']['edgeSdM'] > 5 * by['dome_flat_contact']['edgeSdM']
    assert by['dome_flat_contact']['conformance'] > by['dome_tilted_0.05']['conformance'] > by['dome_tilted_0.15']['conformance']

    # P4 and the evidence cases
    ev_cases = []
    for items in ([{'name': 'RMS amplitude', 'source': 'full_stack'}, {'name': 'Low impedance', 'source': 'full_stack'}],
                  [{'name': 'RMS', 'source': 'full_stack'}, {'name': 'Class III AVO', 'source': 'avo'},
                   {'name': 'Shows', 'source': 'well', 'supports': False}],
                  [{'name': 'Far bright', 'source': 'far_stack'}, {'name': 'CSEM', 'source': 'csem'},
                   {'name': 'Seep', 'source': 'other'}, {'name': 'Vp/Vs low', 'source': 'elastic_inversion'},
                   {'name': 'Fluid factor', 'source': 'avo', 'supports': False}, {'name': 'Intercept', 'source': 'avo'}],
                  [{'name': 'Shows', 'source': 'well', 'supports': False}]):
        ev_cases.append({'items': items, 'out': evidence(items)})
    assert ev_cases[0]['out']['independent'] == 1

    # the decision table on the measured conformance and on edge values
    dt_cases = []
    base = {'anomalyPresent': True, 'conformance': 0.9, 'insideClosure': 1, 'independent': 2, 'feasibility': 'feasible',
            'competing': [{'name': 'tuning', 'status': 'ruled-out'}]}
    overs = [{}, {'independent': 1}, {'conformance': 0.7}, {'conformance': 0.6999}, {'conformance': 0.3}, {'conformance': 0.2999},
             {'insideClosure': 0.5}, {'insideClosure': 0.4999}, {'conformance': None},
             {'competing': [{'name': 'fizz', 'status': 'open'}]},
             {'competing': [{'name': 'lithology', 'status': 'likely'}]},
             {'competing': [{'name': 'lithology', 'status': 'likely'}], 'conformance': 0.2},
             {'feasibility': 'conditional'}, {'feasibility': 'not-feasible'}, {'feasibility': ''},
             {'anomalyPresent': False}, {'anomalyPresent': False, 'feasibility': 'conditional'},
             {'anomalyPresent': False, 'feasibility': ''},
             {'conformance': by['dome_flat_contact']['conformance'], 'insideClosure': by['dome_flat_contact']['insideClosure']},
             {'conformance': by['dome_flank_patch']['conformance'], 'insideClosure': by['dome_flank_patch']['insideClosure']}]
    for o in overs:
        a_ = {**base, **o}
        rec, sup = decide(a_)
        dt_cases.append({'input': a_, 'recommendation': rec, 'seismicSupport': sup})

    for nm, lst in (('conformance', cases), ('evidence', ev_cases), ('decision', dt_cases)):
        if not lst:
            print('REFUSED: empty case list', nm)
            sys.exit(1)
    golden = {'spec': spec, 'conformance': cases, 'evidence': ev_cases, 'decision': dt_cases,
              'paraboloid': {'a': a, 'R': R, 'contact': contact, 'capM3': math.pi * a * R ** 4 / 2}}
    with open(dest, 'w') as fh:
        json.dump(golden, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors P1-P4 ok;', len(cases), 'conformance,', len(ev_cases), 'evidence,', len(dt_cases),
          'decision; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
