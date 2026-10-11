"""Independent oracle for engines/qi/prospectTrap.js (QI course gate E2-B, 2026-10-11).

The engine finds a prospect's trap from a picked point (nearest mapped node,
then a climb to the local crest), runs the closure engine's priority flood
(lib/gridding/closure.js) for the spill point, the closure and its GRV, reads
an attribute map at the depth nodes, keeps the anomaly patches that reach the
closure, measures conformance and the implied contact
(qi/prospectAssessment.js), holds the contact at the spill and applies the
map-edge rule. This oracle rebuilds every number by its own route and shares
no code with the engine or with tools/validation/mapping/oracle_closure.py:

- nearest node and the crest climb by brute force over all nodes and the
  8-neighbourhood (steepest ascent, the highest neighbour);
- the spill by UNION-FIND over the nodes in decreasing elevation (the engine
  floods from the crest with a max-heap): the spill elevation is the value of
  the node whose arrival first joins the crest's component to a node on the
  edge of the mapped area (grid edge or a null 4-neighbour); that node is the
  spill point, and the trap is limited by the map edge when it is itself an
  edge node. The closure at a contact L is the 4-connected component of
  {z > L} that holds the crest, found by breadth-first search, and its GRV
  the explicit sum of (z - L) x cell area. Merges are the arrivals before the
  spill that join the crest's component to another culmination;
- the attribute read at each depth node by its own bilinear weights on the
  attribute grid's frame (null outside the frame or with a null corner;
  only the weighted corners count, as the grid convention says);
- the anomaly patches by BREADTH-FIRST search (the engine uses a stack);
- conformance from the prospectAssessment definitions: the downdip edge read
  at the midpoints to lower nodes outside the anomaly, its mean (the implied
  contact) and sample SD, 1 - SD / relief clipped to 0..1, the share inside
  the closure at spill, the contact held at the spill;
- the recommendation from the documented decision table (two independent
  sources, conformance 0.7 and 0.3, half inside the closure, feasibility),
  then the edge rule: a trap limited by the map edge and filled to that spill
  does not mature.

Surfaces are rounded to float32 here, as the Suite's registry door hands them
over. No two 8-neighbours share a value and the spill elevation is unique on
the grid (asserted), so no tie rule decides a golden. Anchors asserted in main(): an analytic paraboloid's closure area and
GRV against pi R^2 and pi a R^4 / 2 on a fine grid; the union-find spill of a
plain dome equals its highest edge node; every sampled attribute sits away
from the threshold. Standard library only; writes
test-data/qi/goldens.prospectTrap.json byte-identically on every run.
"""
import json
import math
import os
import struct
from collections import deque

NULL = 1e30


def f32(v):
    return struct.unpack('f', struct.pack('f', v))[0]


def is_null(v):
    return v is None or not math.isfinite(v) or abs(v) >= 1e29


class Frame:
    def __init__(self, x0, y0, dx, dy, nx, ny, z):
        self.x0, self.y0, self.dx, self.dy, self.nx, self.ny = x0, y0, dx, dy, nx, ny
        self.z = z

    def xy(self, i):
        r, c = divmod(i, self.nx)
        return self.x0 + c * self.dx, self.y0 + r * self.dy

    def sample(self, x, y):
        fx, fy = (x - self.x0) / self.dx, (y - self.y0) / self.dy
        if fx < 0 or fy < 0 or fx > self.nx - 1 or fy > self.ny - 1:
            return None
        c0, r0 = int(math.floor(fx)), int(math.floor(fy))
        tx, ty = fx - c0, fy - r0
        acc = 0.0
        for dr, wr in ((0, 1 - ty), (1, ty)):
            for dc, wc in ((0, 1 - tx), (1, tx)):
                w = wr * wc
                if w == 0 and (dr or dc):
                    continue
                v = self.z[(r0 + dr) * self.nx + (c0 + dc)]
                if is_null(v):
                    return None
                acc += w * v
        return acc


def nbr4(i, nx, ny):
    r, c = divmod(i, nx)
    for rr, cc in ((r, c - 1), (r, c + 1), (r - 1, c), (r + 1, c)):
        if 0 <= rr < ny and 0 <= cc < nx:
            yield rr * nx + cc


def on_edge(F, i):
    r, c = divmod(i, F.nx)
    if r in (0, F.ny - 1) or c in (0, F.nx - 1):
        return True
    return any(is_null(F.z[j]) for j in nbr4(i, F.nx, F.ny))


def nearest(F, x, y):
    best = None
    for i, v in enumerate(F.z):
        if is_null(v):
            continue
        px, py = F.xy(i)
        d = (px - x) ** 2 + (py - y) ** 2
        if best is None or d < best[0]:
            best = (d, i)
    return best[1] if best else -1


def climb(F, i):
    while True:
        r, c = divmod(i, F.nx)
        cand = [(rr * F.nx + cc) for rr in range(r - 1, r + 2) for cc in range(c - 1, c + 2)
                if 0 <= rr < F.ny and 0 <= cc < F.nx and not is_null(F.z[rr * F.nx + cc])]
        top = max(cand, key=lambda j: F.z[j])
        if F.z[top] <= F.z[i]:
            return i
        i = top


def spill_by_union_find(F, seed):
    n = len(F.z)
    parent = list(range(n))
    edge = [False] * n

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    live = sorted((i for i in range(n) if not is_null(F.z[i])), key=lambda i: -F.z[i])
    added = [False] * n
    merges = 0
    seeded = False
    for v in live:
        added[v] = True
        edge[v] = on_edge(F, v)
        roots = {find(j) for j in nbr4(v, F.nx, F.ny) if added[j]}
        crest_root = find(seed) if seeded else None
        joins_crest = seeded and crest_root in roots
        others = [rt for rt in roots if rt != crest_root]
        for rt in roots:
            edge[v] = edge[v] or edge[rt]
            parent[rt] = v
        if v == seed:
            seeded = True
            assert not roots, 'the seed must be a local crest'
        if seeded and (v == seed or joins_crest):
            if edge[find(seed)]:
                return {'spillNode': v, 'spillZ': F.z[v], 'limitedByEdge': on_edge(F, v), 'merges': merges}
            if joins_crest and others:
                merges += 1
    raise AssertionError('the flood never reached the edge')


def component_above(F, seed, level):
    seen = {seed}
    q = deque([seed])
    while q:
        i = q.popleft()
        for j in nbr4(i, F.nx, F.ny):
            if j not in seen and not is_null(F.z[j]) and F.z[j] > level:
                seen.add(j)
                q.append(j)
    return seen


def grv(F, nodes, level):
    return sum(F.z[i] - level for i in nodes) * abs(F.dx * F.dy)


def anomaly_mask(F, A, threshold, sense, margin):
    mask = [0] * len(F.z)
    for i, zv in enumerate(F.z):
        if is_null(zv):
            continue
        v = A.sample(*F.xy(i))
        if v is None:
            continue
        margin[0] = min(margin[0], abs(v - threshold))
        if (v <= threshold) if sense == 'low' else (v >= threshold):
            mask[i] = 1
    return mask


def patches_touching(F, mask, inside):
    out = [0] * len(mask)
    seen = [False] * len(mask)
    for s in range(len(mask)):
        if not mask[s] or seen[s]:
            continue
        comp, q = [], deque([s])
        seen[s] = True
        while q:
            i = q.popleft()
            comp.append(i)
            for j in nbr4(i, F.nx, F.ny):
                if mask[j] and not seen[j]:
                    seen[j] = True
                    q.append(j)
        if any(inside[i] for i in comp):
            for i in comp:
                out[i] = 1
    return out


SOURCES = {'full_stack', 'near_stack', 'far_stack', 'avo', 'elastic_inversion', 'frequency', 'well', 'other'}


def decide(anomaly, conformance, inside, independent, feasibility, competing):
    detectable = feasibility in ('feasible', 'conditional')
    if not anomaly:
        return 'downgrade' if feasibility == 'feasible' else 'retain'
    if any(c['status'] == 'likely' for c in competing):
        return 'downgrade' if conformance is not None and conformance < 0.3 else 'investigate'
    if conformance is not None and conformance < 0.3:
        return 'investigate'
    blockers = (inside is not None and inside < 0.5) or conformance is None or conformance < 0.7 or independent < 2 \
        or any(c['status'] == 'open' for c in competing) or not detectable
    return 'investigate' if blockers else 'mature'


def analyse(F, A, prospect, feasibility, margin):
    seed = None
    if prospect.get('crestX') is not None:
        seed = climb(F, nearest(F, prospect['crestX'], prospect['crestY']))
    else:
        seed = max((i for i in range(len(F.z)) if not is_null(F.z[i])), key=lambda i: F.z[i])
    sp = spill_by_union_find(F, seed)
    spz = sp['spillZ']
    assert sum(1 for v in F.z if v == spz) == 1, 'the spill elevation must be unique on the grid'
    closure = component_above(F, seed, spz)
    cell = abs(F.dx * F.dy)
    cx, cy = F.xy(seed)
    sx, sy = F.xy(sp['spillNode'])
    trap = {'crest': {'x': cx, 'y': cy, 'depthM': -F.z[seed]}, 'spill': {'x': sx, 'y': sy, 'depthM': -spz},
            'columnM': F.z[seed] - spz, 'areaKm2': len(closure) * cell / 1e6, 'grvSpillM3': grv(F, closure, spz),
            'limitedByEdge': sp['limitedByEdge'], 'merges': sp['merges']}
    anomaly = None
    if A is not None and prospect.get('anomaly'):
        inside = [1 if i in closure else 0 for i in range(len(F.z))]
        mask = patches_touching(F, anomaly_mask(F, A, prospect['anomaly']['threshold'], prospect['anomaly'].get('sense', 'high'), margin), inside)
        if any(mask):
            nodes = [i for i in range(len(F.z)) if mask[i] and not is_null(F.z[i])]
            edge = []
            for i in nodes:
                mids = [(F.z[i] + F.z[j]) / 2 for j in nbr4(i, F.nx, F.ny) if not mask[j] and not is_null(F.z[j]) and F.z[j] < F.z[i]]
                if mids:
                    edge.append(sum(mids) / len(mids))
            mean = sum(edge) / len(edge) if edge else None
            sd = math.sqrt(sum((v - mean) ** 2 for v in edge) / (len(edge) - 1)) if len(edge) > 1 else None
            relief = F.z[seed] - spz
            conf = min(1.0, max(0.0, 1 - sd / relief)) if sd is not None and relief > 0 else None
            held = max(mean, spz) if mean is not None else None
            vs = mean - spz if mean is not None else None
            anomaly = {'nodes': len(nodes), 'areaKm2': len(nodes) * cell / 1e6, 'conformance': conf, 'edgeSdM': sd,
                       'insideClosure': sum(inside[i] for i in nodes) / len(nodes),
                       'impliedContactDepthM': -held if held is not None else None,
                       'edgeBelowSpillM': -vs if vs is not None and vs < 0 else 0,
                       'impliedAboveSpillM': vs,
                       'grvImpliedM3': grv(F, component_above(F, seed, held), held) if held is not None else None}
    srcs = {(e['source'] if e['source'] in SOURCES else 'other') for e in prospect.get('evidence', []) if e.get('supports') is not False}
    rec = decide(anomaly is not None, anomaly['conformance'] if anomaly else None, anomaly['insideClosure'] if anomaly else None,
                 len(srcs), feasibility, prospect.get('competing', []))
    held_at_investigate = False
    if trap['limitedByEdge']:
        filled = not (anomaly and anomaly['impliedAboveSpillM'] > 0)
        if filled and rec == 'mature':
            rec = 'investigate'
            held_at_investigate = True
    return {'seed': seed, 'trap': trap, 'anomaly': anomaly, 'independent': len(srcs), 'recommendation': rec,
            'edgeReason': trap['limitedByEdge'], 'heldAtInvestigate': held_at_investigate,
            'belowSpillReason': bool(anomaly and anomaly['edgeBelowSpillM'] > 0)}


# ---- surfaces ---------------------------------------------------------------

def grid(nx, ny, x0, y0, d, fn, nulls=lambda r, c: False):
    out = []
    for r in range(ny):
        for c in range(nx):
            out.append(NULL if nulls(r, c) else f32(fn(x0 + c * d, y0 + r * d, r, c)))
    # no two 8-neighbours share a value, so the climb and the flood order never meet a tie that matters
    for r in range(ny):
        for c in range(nx):
            v = out[r * nx + c]
            for dr, dc in ((0, 1), (1, -1), (1, 0), (1, 1)):
                rr, cc = r + dr, c + dc
                if 0 <= rr < ny and 0 <= cc < nx and not is_null(v):
                    assert out[rr * nx + cc] != v, 'neighbouring nodes share a value'
    return out


def two_domes(x, y, r, c):
    xr, yr = x - 500000, y - 6000000
    return (-2400 + 0.12 * xr + 450 * math.exp(-((xr - 1000) ** 2 + (yr - 1250) ** 2) / 600 ** 2)
            + 220 * math.exp(-((xr - 1850) ** 2 + (yr - 1300) ** 2) / 200 ** 2) + 0.0571 * c + 0.0229 * r)


def edge_dome(x, y, r, c):
    xr, yr = x - 500000, y - 6000000
    return -2000 - 0.0004 * ((xr - 1000) ** 2 + (yr - 500) ** 2) + 0.0131 * c + 0.0077 * r


def main():
    margin = [math.inf]
    # anchor 1: a fine paraboloid z = -2000 - a r^2 (distinct values by a tiny tilt): closure above -2100 is a disc of R = 500 m
    a = 0.0004
    nx = 161
    P = Frame(0.0, 0.0, 12.5, 12.5, nx, nx, [(-2000 - a * ((c * 12.5 - 1000) ** 2 + (r * 12.5 - 1000) ** 2) + 1e-7 * (r * nx + c)) for r in range(nx) for c in range(nx)])
    top = max(range(len(P.z)), key=lambda i: P.z[i])
    disc = component_above(P, top, -2100)
    assert abs(len(disc) * 12.5 ** 2 / (math.pi * 500 ** 2) - 1) < 0.01
    assert abs(grv(P, disc, -2100) / (math.pi * a * 500 ** 4 / 2) - 1) < 0.01
    # anchor 2: a plain dome spills at its highest edge node, limited by the edge
    sp = spill_by_union_find(P, top)
    edge_max = max((i for i in range(len(P.z)) if on_edge(P, i)), key=lambda i: P.z[i])
    assert sp['spillNode'] == edge_max and sp['limitedByEdge'] and sp['merges'] == 0

    cases = []
    # T1: a dome and a smaller culmination on a regional rise to the east; the spill is an interior saddle
    T1 = grid(61, 51, 500000.0, 6000000.0, 50.0, two_domes)
    F1 = Frame(500000.0, 6000000.0, 50.0, 50.0, 61, 51, T1)
    # the attribute on its own frame (40 m, offset), bright above -2050 m in the structure, plus a corner patch off it
    def bright1(x, y, r, c):
        z = two_domes(x, y, 0, 0)
        if x - 500000 < 300 and y - 6000000 < 300:
            return 1.2 + 0.001 * c
        return (1.0 if z >= -2050 else 0.1) + 0.0003 * c + 0.0002 * r
    A1v = [f32(bright1(499963.0 + c * 40.0, 5999971.0 + r * 40.0, r, c)) for r in range(70) for c in range(80)]
    A1 = Frame(499963.0, 5999971.0, 40.0, 40.0, 80, 70, A1v)
    pick1 = {'crestX': 500000 + 1075.0, 'crestY': 6000000 + 1190.0}
    ev2 = [{'name': 'RMS amplitude', 'source': 'full_stack'}, {'name': 'Class III AVO', 'source': 'avo'}]
    specs = [
        ('T1 two culminations, interior spill, conforming anomaly', 'T1', 'A1', dict(pick1, anomaly={'threshold': 0.5, 'sense': 'high'}, evidence=ev2, competing=[{'name': 'Tuning', 'status': 'ruled-out'}]), 'feasible'),
        ('T1 the same anomaly read low, one source, a likely competitor', 'T1', 'A1', dict(pick1, anomaly={'threshold': 0.5, 'sense': 'low'}, evidence=ev2[:1] + [{'name': 'Low impedance', 'source': 'full_stack'}], competing=[{'name': 'Lithology', 'status': 'likely'}]), 'conditional'),
        ('T1 picked on the eastern culmination', 'T1', 'A1', {'crestX': 500000 + 1830.0, 'crestY': 6000000 + 1320.0, 'anomaly': {'threshold': 0.5}, 'evidence': ev2}, 'feasible'),
    ]
    # T2: a dome cut by the south edge, with a null patch; anomalies filled past the spill and short of it
    nul = lambda r, c: 30 <= r <= 33 and 50 <= c <= 54
    T2 = grid(61, 41, 500000.0, 6000000.0, 50.0, edge_dome, nul)
    F2 = Frame(500000.0, 6000000.0, 50.0, 50.0, 61, 41, T2)
    sp2 = spill_by_union_find(F2, max((i for i in range(len(T2)) if not is_null(T2[i])), key=lambda i: T2[i]))
    spz2 = sp2['spillZ']
    def bright2(level):
        return [f32((1.0 if edge_dome(500010.0 + c * 45.0, 5999990.0 + r * 45.0, 0, 0) >= level else 0.1) + 0.0004 * c) for r in range(48) for c in range(70)]
    A2a = Frame(500010.0, 5999990.0, 45.0, 45.0, 70, 48, bright2(spz2 - 25))
    A2b = Frame(500010.0, 5999990.0, 45.0, 45.0, 70, 48, bright2(spz2 + 40))
    specs += [
        ('T2 edge spill, anomaly filled past it: contact held, not mature', 'T2', 'A2a', {'crestX': 500000 + 990.0, 'crestY': 6000000 + 520.0, 'anomaly': {'threshold': 0.5}, 'evidence': ev2, 'competing': [{'name': 'Tuning', 'status': 'ruled-out'}]}, 'feasible'),
        ('T2 edge spill, contact above it: matures with the edge said', 'T2', 'A2b', {'crestX': 500000 + 990.0, 'crestY': 6000000 + 520.0, 'anomaly': {'threshold': 0.5}, 'evidence': ev2}, 'feasible'),
        ('T2 no attribute, feasible: downgrade', 'T2', None, {}, 'feasible'),
        ('T2 no attribute, not feasible: retain', 'T2', None, {}, 'not-feasible'),
    ]
    frames = {'T1': F1, 'T2': F2, 'A1': A1, 'A2a': A2a, 'A2b': A2b}
    for name, fk, ak, prospect, feas in specs:
        r = analyse(frames[fk], frames[ak] if ak else None, prospect, feas, margin)
        cases.append({'name': name, 'surface': fk, 'attr': ak, 'prospect': prospect, 'feasibility': feas, **r})
    assert cases and all(c['trap']['columnM'] > 0 for c in cases)
    c0 = cases[0]
    assert not c0['trap']['limitedByEdge'] and c0['trap']['merges'] >= 1 and c0['anomaly'] and c0['recommendation'] == 'mature', c0
    assert cases[3]['heldAtInvestigate'] and cases[3]['belowSpillReason'] and cases[4]['recommendation'] == 'mature'
    assert margin[0] > 1e-4, margin
    # helpers on T1
    helpers = {'nearest': [], 'climb': [], 'mask': None}
    for x, y in ((500000 + 1075.0, 6000000 + 1190.0), (499000.0, 5999000.0), (500000 + 2990.0, 6000000 + 2480.0), (500000 + 1812.0, 6000000 + 1337.0)):
        helpers['nearest'].append({'x': x, 'y': y, 'node': nearest(F1, x, y)})
    for x, y in ((500000 + 2610.0, 6000000 + 1580.0), (500000 + 2480.0, 6000000 + 1530.0)):  # inside and beside the null patch of T2
        helpers['nearest'].append({'surface': 'T2', 'x': x, 'y': y, 'node': nearest(F2, x, y)})
    assert all(not is_null(F2.z[h['node']]) for h in helpers['nearest'] if h.get('surface') == 'T2')
    for s in (0, 30 * 61 + 5, 26 * 61 + 33, 25 * 61 + 40, 50 * 61 + 60, 10 * 61 + 30):
        helpers['climb'].append({'start': s, 'crest': climb(F1, s)})
    m = anomaly_mask(F1, A1, 0.5, 'high', margin)
    ins = [0] * len(T1)
    ins[cases[0]['seed']] = 1
    helpers['mask'] = {'count': sum(m), 'kept': sum(patches_touching(F1, m, ins)), 'corner': m[0]}
    assert helpers['mask']['kept'] < helpers['mask']['count'] and helpers['mask']['corner'] == 1
    assert len({h['crest'] for h in helpers['climb']}) >= 2
    surfaces = {k: {'x0': f.x0, 'y0': f.y0, 'dx': f.dx, 'dy': f.dy, 'nx': f.nx, 'ny': f.ny, 'z': f.z} for k, f in frames.items()}
    out = {'surfaces': surfaces, 'cases': cases, 'helpers': helpers}
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', '..', '..', 'test-data', 'qi', 'goldens.prospectTrap.json')
    with open(dest, 'w') as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors ok; threshold margin', margin[0], '; cases', [(c['name'][:2], c['recommendation'], c['trap']['merges'], c['trap']['limitedByEdge']) for c in cases], '; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
