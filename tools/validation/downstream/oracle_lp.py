#!/usr/bin/env python3
"""Oracle for lib/lp/simplex.js, the LP kernel under MD1 and MD2.

WHAT THIS FILE DOES, AND WHY IT IS INDEPENDENT

The engine is a two-phase dense tableau simplex in floating point. This file
does not run a simplex at all. It solves every problem by EXHAUSTIVE VERTEX
ENUMERATION IN EXACT RATIONAL ARITHMETIC (fractions.Fraction): every choice of
n linearly independent active constraints is solved by Gaussian elimination,
kept if it satisfies every constraint exactly, and the cheapest one is the
optimum. There is no pivot rule, no phase one, no tolerance and no tableau, so
nothing the engine could get wrong is shared with this file.

That works because every problem here is small (n <= 5, at most five
constraint rows), and because the feasible set always has a finite lower bound
on every variable, so it is a POINTED polyhedron: if it is non-empty it has a
vertex, and if the objective is bounded below an optimal vertex exists.

  - INFEASIBLE is exact: no candidate vertex is feasible.
  - UNBOUNDED is decided by adding a box x <= M on every unbounded variable at
    two sizes, M = 10^6 and 10^7. A bounded problem has the same optimum in
    both; an unbounded one moves with M.
  - SHADOW PRICES are the one-sided derivatives of the optimal objective with
    respect to each right-hand side, taken by RE-SOLVING at b_i + d and b_i - d
    exactly (d = 1/10^6). The optimal value is piecewise linear in b, so for d
    small enough these are the exact left and right derivatives, and any
    reported shadow price must lie between them. Where they differ the row is
    dual degenerate and every value in the interval is a correct price; the
    gate accepts the interval rather than guessing which one a simplex lands on.

A correct shadow price is dObjective/db_i in the problem's own sense: for a
minimisation it is the change in the minimum, for a maximisation the change in
the maximum. That is the definition the gate holds the engine to.

WHAT THE CASES ARE AIMED AT

A seeded random battery, plus hand-built cases for the shapes that break a
tableau simplex: rows whose right-hand side is NEGATIVE (the engine negates
them to normalise, which flips the meaning of the row's dual), rows whose
right-hand side goes negative only AFTER the lower-bound shift, redundant and
scaled-duplicate equality rows (an artificial left in the basis at zero), and
exactly degenerate vertices.

stdlib only. Writes test-data/downstream/goldens/lp_cases.json
"""

import itertools
import json
import os
import random
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'lp_cases.json')

INF = None  # an absent upper bound
BOX_SMALL = F(10) ** 6
BOX_LARGE = F(10) ** 7
DELTA = F(1, 10 ** 6)


def solve_square(rows, rhs):
    """Solve an n x n system exactly; None if singular."""
    n = len(rows)
    m = [list(r) + [v] for r, v in zip(rows, rhs)]
    for col in range(n):
        piv = next((r for r in range(col, n) if m[r][col] != 0), None)
        if piv is None:
            return None
        m[col], m[piv] = m[piv], m[col]
        p = m[col][col]
        m[col] = [v / p for v in m[col]]
        for r in range(n):
            if r != col and m[r][col] != 0:
                f = m[r][col]
                m[r] = [a - f * b for a, b in zip(m[r], m[col])]
    return [m[r][n] for r in range(n)]


def feasible(x, prob, box):
    for row, op, b in zip(prob['A'], prob['ops'], prob['b']):
        lhs = sum(a * v for a, v in zip(row, x))
        if op == '<=' and lhs > b:
            return False
        if op == '>=' and lhs < b:
            return False
        if op == '=' and lhs != b:
            return False
    for j, v in enumerate(x):
        if v < prob['lo'][j]:
            return False
        hi = prob['hi'][j]
        if hi is not None and v > hi:
            return False
        if hi is None and v > box:
            return False
    return True


def enumerate_optimum(prob, box):
    """Exact optimum over vertices; (status, value, optimal vertices)."""
    n = len(prob['c'])
    cands = []  # (coeffs, rhs, is_equality_row)
    for row, op, b in zip(prob['A'], prob['ops'], prob['b']):
        cands.append((row, b, op == '='))
    for j in range(n):
        e = [F(0)] * n
        e[j] = F(1)
        cands.append((e, prob['lo'][j], False))
        hi = prob['hi'][j]
        cands.append((e, hi if hi is not None else box, False))
    must = [i for i, c in enumerate(cands) if c[2]]
    free = [i for i, c in enumerate(cands) if not c[2]]
    best = None
    verts = []
    seen = set()
    # every vertex has n active constraints; equality rows are always active,
    # so choose the remainder from the rest (an equality row may also be
    # dependent on others, so allow choosing fewer from `must` too)
    pool = must + free
    for combo in itertools.combinations(pool, n):
        x = solve_square([cands[i][0] for i in combo], [cands[i][1] for i in combo])
        if x is None or not feasible(x, prob, box):
            continue
        key = tuple(x)
        if key in seen:
            continue
        seen.add(key)
        val = sum(c * v for c, v in zip(prob['cmin'], x))
        if best is None or val < best:
            best = val
            verts = [x]
        elif val == best:
            verts.append(x)
    if best is None:
        return 'infeasible', None, []
    return 'optimal', best, verts


def solve(prob):
    s1, v1, x1 = enumerate_optimum(prob, BOX_SMALL)
    if s1 == 'infeasible':
        return {'status': 'infeasible'}
    s2, v2, _ = enumerate_optimum(prob, BOX_LARGE)
    if v1 != v2:
        return {'status': 'unbounded'}
    sign = -1 if prob['maximize'] else 1
    return {'status': 'optimal', 'objective': sign * v1, 'vertices': x1}


def with_b(prob, i, db):
    q = dict(prob)
    q['b'] = [v + (db if k == i else 0) for k, v in enumerate(prob['b'])]
    return q


def shadow_interval(prob, base_obj):
    """Exact one-sided derivatives of the optimal value in each b_i."""
    out = []
    for i in range(len(prob['b'])):
        up = solve(with_b(prob, i, DELTA))
        dn = solve(with_b(prob, i, -DELTA))
        right = (up['objective'] - base_obj) / DELTA if up['status'] == 'optimal' else None
        left = (base_obj - dn['objective']) / DELTA if dn['status'] == 'optimal' else None
        out.append({'left': None if left is None else float(left),
                    'right': None if right is None else float(right)})
    return out


def make(name, c, A, b, ops, lo=None, hi=None, maximize=False, why=''):
    n = len(c)
    lo = lo if lo is not None else [0] * n
    hi = hi if hi is not None else [INF] * n
    prob = {
        'c': [F(v) for v in c],
        'cmin': [F(-v) if maximize else F(v) for v in c],
        'A': [[F(v) for v in r] for r in A],
        'b': [F(v) for v in b],
        'ops': list(ops),
        'lo': [F(v) for v in lo],
        'hi': [None if v is INF else F(v) for v in hi],
        'maximize': maximize,
    }
    res = solve(prob)
    case = {
        'name': name,
        'why': why,
        'input': {
            'c': [float(v) for v in c], 'A': [[float(v) for v in r] for r in A],
            'b': [float(v) for v in b], 'ops': list(ops),
            'lo': [float(v) for v in lo],
            'hi': [None if v is INF else float(v) for v in hi],
            'maximize': maximize,
        },
        'status': res['status'],
    }
    if res['status'] == 'optimal':
        verts = res['vertices']
        case['objective'] = float(res['objective'])
        case['xUnique'] = len(verts) == 1
        case['x'] = [float(v) for v in verts[0]] if len(verts) == 1 else None
        case['shadow'] = shadow_interval(prob, res['objective'])
    return case


def hand_cases():
    cs = []
    cs.append(make('textbook min, >= and <= rows', [1, 2], [[1, 1], [1, 0]], [4, 3], ['>=', '<='],
                   why='x=3, y=1; duals 2 and -1'))
    cs.append(make('>= row with a negative right-hand side, binding', [0, -1], [[1, -1], [1, 0]], [-2, 3], ['>=', '<='],
                   why='the engine negates the row to normalise it; the dual must follow the ORIGINAL row'))
    cs.append(make('<= row with a negative right-hand side, binding', [-1, 0], [[-1, 1], [0, 1]], [-2, 5], ['<=', '<='],
                   why='maximise x with y - x <= -2; the row binds only through the bound on x, so its price is zero while the bound carries the value', hi=[10, INF]))
    cs.append(make('= row with a negative right-hand side', [1, 1], [[1, -1], [0, 1]], [-2, 3], ['=', '>='],
                   why='the equality dual must keep the sign of the row as written'))
    cs.append(make('blend shape: <= spec row, component floor shifts rhs negative', [10, 5],
                   [[1, 1], [-20, 30]], [100, 0], ['=', '<='], lo=[50, 0],
                   why='the rhs is 0 as written and -A*lo after the shift, so the engine flips a row the caller never flipped'))
    cs.append(make('blend shape: >= spec row, component floor shifts rhs negative', [10, 5],
                   [[1, 1], [20, -30]], [100, 0], ['=', '>='], lo=[50, 0],
                   why='the same spec written as a minimum'))
    cs.append(make('redundant equality rows', [1, -1], [[1, 1], [1, 1], [1, 0]], [10, 10, 20], ['=', '=', '<='],
                   why='an artificial stays basic at zero after phase one'))
    cs.append(make('scaled duplicate equality rows', [-1, 0, 0], [[1, 1, 1], [2, 2, 2], [0, 1, -1]], [5, 10, 0],
                   ['=', '=', '='], hi=[3, INF, INF], why='rank-deficient equality block'))
    cs.append(make('degenerate vertex, three rows through one point', [-1, -1],
                   [[1, 0], [0, 1], [1, 1]], [2, 2, 4], ['<=', '<=', '<='],
                   why='the optimum sits on three constraints in two dimensions, so the duals are an interval'))
    cs.append(make('maximise, textbook', [3, 5], [[1, 0], [0, 2], [3, 2]], [4, 12, 18], ['<=', '<=', '<='],
                   maximize=True, why='Hillier and Lieberman Wyndor shape: x=2, y=6, z=36, duals 0, 1.5, 1'))
    cs.append(make('maximise with a >= row', [1, 1], [[1, 2], [1, 0]], [2, 3], ['>=', '<='],
                   hi=[INF, 4], maximize=True, why='a binding upper bound and a slack >= row'))
    cs.append(make('infeasible', [1, 1], [[1, 1], [1, 1]], [5, 3], ['>=', '<='],
                   why='the rows contradict'))
    cs.append(make('infeasible through bounds', [1], [[1]], [10], ['>='], hi=[4],
                   why='a row that no value inside the bounds can meet'))
    cs.append(make('infeasible by a twentieth', [1, 1], [[1, 1]], [10.05], ['>='], hi=[5, 5],
                   why='phase one ends with 0.05 left in its artificials; a loose feasibility test calls this solvable'))
    cs.append(make('infeasible by a millionth', [1, 1], [[1, 1]], [10.000001], ['>='], hi=[5, 5],
                   why='the smallest miss the engine is asked to see, ten times its 1e-7 feasibility threshold'))
    cs.append(make('unbounded', [-1, 0], [[1, -1]], [1], ['>='],
                   why='x grows without limit'))
    cs.append(make('bounded only by an upper bound', [-2, -1], [[1, 1]], [10], ['<='], hi=[4, INF],
                   why='a bound, not a row, stops the objective'))
    cs.append(make('fuzz-found: an equality row broken at the returned optimum', [7, 1, -5, -4],
                   [[3, -5, -2, -4], [-3, -3, 3, -5]], [5, -3], ['<=', '='], lo=[0, 3, 0, 3], hi=[INF, 12, 7, 9],
                   why='the engine returned x = (0, 3, 7, 9), where the equality row reads -33 against -3'))
    cs.append(make('fuzz-found: a <= row broken at the returned optimum', [1, -2, 8, 6, -5],
                   [[-5, 3, -5, -5, 2], [0, 4, -1, -4, 0], [6, -2, 0, 2, -3], [5, -3, 6, -4, 4]],
                   [-1, 11, 14, -10], ['<=', '<=', '=', '<='], lo=[3, 2, 0, 3, 0], hi=[INF, 3, 8, 10, INF],
                   why='found by the same 100k fuzz; an artificial left basic at zero after phase one goes positive in phase two'))
    cs.append(make('false unbounded: a bounded problem with a degenerate >= row', [-3, 3], [[-4, -4], [-1, 0]], [-8, 14],
                   ['>=', '<='], lo=[0, 2], hi=[INF, 8],
                   why='x + y <= 2 with y >= 2 pins x = 0; the engine reported unbounded'))
    cs.append(make('lower bounds lift the origin', [1, 1], [[1, 1]], [3], ['>='], lo=[2, 2],
                   why='the bound already satisfies the row, which prices at zero'))
    return cs


def random_cases(seed=20260919, count=160):
    rng = random.Random(seed)
    out = []
    while len(out) < count:
        n = rng.randint(2, 5)
        m = rng.randint(1, 5)
        c = [rng.randint(-6, 9) for _ in range(n)]
        A = [[rng.randint(-5, 6) for _ in range(n)] for _ in range(m)]
        ops = [rng.choice(['<=', '<=', '>=', '=']) for _ in range(m)]
        b = [rng.randint(-12, 20) for _ in range(m)]
        lo = [rng.choice([0, 0, 0, 1, 2, 3]) for _ in range(n)]
        hi = [rng.choice([INF, INF, lo[j] + rng.randint(1, 10)]) for j in range(n)]
        maximize = rng.random() < 0.25
        case = make(f'random {len(out) + 1}', c, A, b, ops, lo=lo, hi=hi, maximize=maximize,
                    why='seeded battery')
        # keep the battery mostly on optima, where the duals are exercised;
        # a quarter of the non-optimal draws are kept for the status checks
        if case['status'] != 'optimal' and rng.random() > 0.25:
            continue
        out.append(case)
    return out


def main():
    cases = hand_cases() + random_cases()
    by = {}
    for c in cases:
        by[c['status']] = by.get(c['status'], 0) + 1
    neg_binding = sum(1 for c in cases if c['status'] == 'optimal' and any(
        b < 0 for b in c['input']['b']))
    doc = {
        'provenance': {
            'oracle': 'tools/validation/downstream/oracle_lp.py',
            'method': 'exact rational vertex enumeration; shadow prices as exact one-sided derivatives by re-solve',
            'engine': 'lib/lp/simplex.js',
            'published': 'none: an LP optimum is a mathematical fact of the problem, so no literature value is needed or claimed',
        },
        'counts': {**by, 'optimalWithANegativeRhs': neg_binding, 'total': len(cases)},
        'cases': cases,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print(json.dumps(doc['counts']))


if __name__ == '__main__':
    main()
