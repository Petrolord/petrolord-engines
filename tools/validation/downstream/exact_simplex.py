#!/usr/bin/env python3
"""An exact linear programme solver for the downstream oracles (MD2-0).

oracle_lp.py solves by vertex enumeration, which is independent of any pivot
rule but grows as C(m + 2n, n) and cannot reach a refinery plan of eight
variables and a dozen rows in reasonable time. This file solves larger
problems EXACTLY (fractions.Fraction throughout) and then PROVES the answer,
so that how it was found does not matter:

  - primal feasibility is checked on the ORIGINAL rows and bounds, exactly;
  - optimality is checked by an exact DUALITY CERTIFICATE: from the final
    basis the dual vector y solves B'y = c_B, and every reduced cost
    c_j - y.a_j must be non-negative (for a minimisation). A basis that
    passes both is optimal whatever the pivoting did to reach it.

A solve that cannot produce the certificate raises rather than returning a
number. The file is validated against oracle_lp.py's enumeration on every
case of lp_cases.json (`python3 exact_simplex.py --selftest`).

Problem form, the same as oracle_lp: minimise c'x (or maximise), rows
A x {<=, >=, =} b, lo <= x <= hi with hi None for no bound.

stdlib only.
"""

import json
import os
import sys
from fractions import Fraction as F


class Unbounded(Exception):
    pass


class Infeasible(Exception):
    pass


def _solve_square_T(B, rhs):
    """Solve B' y = rhs exactly (B given as a list of columns)."""
    m = len(B)
    # Row i of B' is basis column i, so equation i reads column_i . y = rhs_i.
    M = [[B[i][k] for k in range(m)] + [rhs[i]] for i in range(m)]
    for col in range(m):
        piv = next((r for r in range(col, m) if M[r][col] != 0), None)
        if piv is None:
            raise ValueError('singular basis')
        M[col], M[piv] = M[piv], M[col]
        p = M[col][col]
        M[col] = [v / p for v in M[col]]
        for r in range(m):
            if r != col and M[r][col] != 0:
                f = M[r][col]
                M[r] = [a - f * b for a, b in zip(M[r], M[col])]
    return [M[i][m] for i in range(m)]


def solve(c, A, b, ops, lo=None, hi=None, maximize=False):
    """Exact optimum. Returns dict(status, objective, x, certified=True)."""
    n = len(c)
    c = [F(v) for v in c]
    A = [[F(v) for v in r] for r in A]
    b = [F(v) for v in b]
    lo = [F(0)] * n if lo is None else [F(v) for v in lo]
    hi = [None] * n if hi is None else [None if v is None else F(v) for v in hi]
    cmin = [-v for v in c] if maximize else list(c)

    # shift to y = x - lo >= 0; upper bounds become rows
    rows = []
    for r, op, rhs in zip(A, ops, b):
        rows.append((list(r), op, rhs - sum(a * l for a, l in zip(r, lo))))
    for j in range(n):
        if hi[j] is not None:
            if hi[j] < lo[j]:
                return {'status': 'infeasible'}
            e = [F(0)] * n
            e[j] = F(1)
            rows.append((e, '<=', hi[j] - lo[j]))
    # normalise rhs >= 0
    norm = []
    for r, op, rhs in rows:
        if rhs < 0:
            r = [-v for v in r]
            rhs = -rhs
            op = {'<=': '>=', '>=': '<=', '=': '='}[op]
        norm.append((r, op, rhs))
    m = len(norm)
    # columns: n structural, then one slack/surplus per inequality, then artificials
    cols = []          # each column as a list of m entries
    kinds = []         # 'x', 's', 'a'
    for j in range(n):
        cols.append([norm[i][0][j] for i in range(m)])
        kinds.append('x')
    basis = [None] * m
    for i, (_, op, _) in enumerate(norm):
        if op != '=':
            col = [F(0)] * m
            col[i] = F(1) if op == '<=' else F(-1)
            cols.append(col)
            kinds.append('s')
            if op == '<=':
                basis[i] = len(cols) - 1
    for i in range(m):
        if basis[i] is None:
            col = [F(0)] * m
            col[i] = F(1)
            cols.append(col)
            kinds.append('a')
            basis[i] = len(cols) - 1
    N = len(cols)
    rhs = [norm[i][2] for i in range(m)]

    # tableau T[i][j] = (B^-1 A)[i][j], beta = B^-1 b, kept by pivoting
    T = [[cols[j][i] for j in range(N)] for i in range(m)]
    beta = list(rhs)

    def pivot(r, k):
        p = T[r][k]
        T[r] = [v / p for v in T[r]]
        beta[r] /= p
        for i in range(m):
            if i != r and T[i][k] != 0:
                f = T[i][k]
                T[i] = [a - f * bb for a, bb in zip(T[i], T[r])]
                beta[i] -= f * beta[r]
        basis[r] = k

    def run(cost, allowed):
        for _ in range(100000):
            entering = None
            for j in range(N):
                if not allowed[j] or j in basis:
                    continue
                red = cost[j] - sum(cost[basis[i]] * T[i][j] for i in range(m))
                if red < 0:
                    entering = j
                    break
            if entering is None:
                return
            best = None
            leave = None
            for i in range(m):
                if T[i][entering] > 0:
                    ratio = beta[i] / T[i][entering]
                    if best is None or ratio < best or (ratio == best and basis[i] < basis[leave]):
                        best, leave = ratio, i
            if leave is None:
                raise Unbounded()
            pivot(leave, entering)
        raise RuntimeError('iteration limit')

    art = [kinds[j] == 'a' for j in range(N)]
    run([F(1) if art[j] else F(0) for j in range(N)], [True] * N)
    if sum(beta[i] for i in range(m) if art[basis[i]]) > 0:
        return {'status': 'infeasible'}
    for i in range(m):
        if art[basis[i]]:
            k = next((j for j in range(N) if not art[j] and T[i][j] != 0), None)
            if k is not None:
                pivot(i, k)
    cost = [cmin[j] if j < n else F(0) for j in range(N)]
    try:
        run(cost, [not a for a in art])
    except Unbounded:
        return {'status': 'unbounded'}

    y = [F(0)] * N
    for i in range(m):
        y[basis[i]] = beta[i]
    x = [y[j] + lo[j] for j in range(n)]

    # ---- the certificate, on the ORIGINAL problem ----
    for r, op, bb in zip(A, ops, b):
        lhs = sum(a * v for a, v in zip(r, x))
        ok = lhs <= bb if op == '<=' else lhs >= bb if op == '>=' else lhs == bb
        if not ok:
            raise AssertionError('certificate: a row is violated')
    for j in range(n):
        if x[j] < lo[j] or (hi[j] is not None and x[j] > hi[j]):
            raise AssertionError('certificate: a bound is violated')
    if any(art[basis[i]] and beta[i] != 0 for i in range(m)):
        raise AssertionError('certificate: an artificial is non-zero')
    Bcols = [cols[basis[i]] for i in range(m)]
    cB = [cost[basis[i]] for i in range(m)]
    dual = _solve_square_T(Bcols, cB)
    for j in range(N):
        if art[j]:
            continue
        red = cost[j] - sum(dual[i] * cols[j][i] for i in range(m))
        if red < 0:
            raise AssertionError('certificate: a negative reduced cost, not optimal')
    obj = sum(cv * xv for cv, xv in zip(c, x))
    return {'status': 'optimal', 'objective': obj, 'x': x, 'certified': True}


def selftest():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, '..', '..', '..', 'test-data', 'downstream', 'goldens', 'lp_cases.json')
    G = json.load(open(path))
    bad = 0
    for case in G['cases']:
        i = case['input']
        r = solve(i['c'], i['A'], i['b'], i['ops'], i['lo'], i['hi'], i['maximize'])
        if r['status'] != case['status'] or (
                r['status'] == 'optimal' and abs(float(r['objective']) - case['objective']) > 1e-9 * max(1, abs(case['objective']))):
            bad += 1
            print('DISAGREES', case['name'], r['status'], case['status'])
    print(f'exact_simplex vs vertex enumeration: {len(G["cases"]) - bad} of {len(G["cases"])} agree')
    return bad == 0


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(0 if selftest() else 1)
