#!/usr/bin/env python3
"""
Independent oracle for the gathering-network solver (Production P11).

DIFFERENT ROUTE, ON PURPOSE. The engine solves the network by NEWTON:
it assembles a Jacobian, solves a linear system, and takes a damped
step, moving every node's pressure at once. This oracle never forms a
Jacobian and never solves a linear system. It sweeps the nodes one at a
time and finds each node's pressure by BISECTION on that node's own
mass balance, holding its neighbours fixed, repeating the sweep until
nothing moves. Gauss-Seidel with a bracketed root find.

The two share no numerical machinery at all -- no derivatives, no
linear algebra, not even the same iteration structure -- so agreement
between them is evidence about the PHYSICS rather than about a shared
implementation. Bisection also cannot diverge, which makes it a
trustworthy referee for a method that can.

Stdlib only. Emits goldens to
test-data/production/goldens/network_cases.json.
"""

import json
import math
import os

MIN_P = 14.7


# ---------------------------------------------------------------------------
# Branch and well relations
# ---------------------------------------------------------------------------

def linear_branch(k):
    """q = k (p_in - p_out). The case with a closed form."""
    return lambda p_in, p_out: k * (p_in - p_out)


def turbulent_branch(k):
    """
    q = k sign(dp) sqrt(|dp|), the form pipe flow actually takes:
    pressure drop goes as the square of rate. Nonlinear, monotone,
    and smooth everywhere except at dp = 0 where it is still
    continuous.
    """
    def f(p_in, p_out):
        dp = p_in - p_out
        return math.copysign(k * math.sqrt(abs(dp)), dp)
    return f


def vogel_well(qmax, pr):
    """
    q = qmax (1 - 0.2 x - 0.8 x^2), x = p/pr. Vogel's curve, which is
    what a real solution-gas-drive inflow looks like, and monotone
    decreasing on 0 <= x <= 1 which is what makes the network well
    posed.
    """
    def f(p):
        x = min(max(p / pr, 0.0), 1.0)
        return max(0.0, qmax * (1.0 - 0.2 * x - 0.8 * x * x))
    return f


def linear_well(qmax, pr):
    return lambda p: max(0.0, qmax * (1.0 - p / pr))


# ---------------------------------------------------------------------------
# The network
# ---------------------------------------------------------------------------

class Network:
    def __init__(self, nodes, branches):
        self.nodes = nodes                      # {id: {'kind':..,'p':..}}
        self.branches = branches                # [{'id','from','to','f'}]
        self.unknowns = [i for i, n in nodes.items() if n['kind'] != 'sink']

    def net_into(self, node_id, p):
        """Mass balance residual at one node, given every pressure."""
        total = 0.0
        for b in self.branches:
            q = b['f'](p[b['from']], p[b['to']])
            if b['from'] == node_id:
                total -= q
            if b['to'] == node_id:
                total += q
        n = self.nodes[node_id]
        if n['kind'] == 'well':
            total += n['q'](p[node_id])
        return total

    def flows(self, p):
        return {b['id']: b['f'](p[b['from']], p[b['to']]) for b in self.branches}


def solve_gauss_seidel(net, tol=1e-10, max_sweeps=4000):
    """
    Sweep the unknown nodes, bisecting each one's pressure to zero its
    own residual with the others held where they are. No Jacobian, no
    linear solve, no step length to choose.

    The residual at a node is monotone DECREASING in that node's own
    pressure -- raising a node's pressure pushes more out of it and
    pulls less in, and reduces what a well at it makes -- so the root
    is unique and a bracket is guaranteed once one is found.
    """
    p = {i: (n['p'] if n['kind'] == 'sink' else 200.0) for i, n in net.nodes.items()}

    for sweep in range(max_sweeps):
        moved = 0.0
        for node_id in net.unknowns:
            lo, hi = MIN_P, 1.0e5
            f_lo = net.net_into(node_id, {**p, node_id: lo})
            f_hi = net.net_into(node_id, {**p, node_id: hi})
            if f_lo < 0:            # even at atmospheric it cannot take any more
                new = lo
            elif f_hi > 0:          # unbounded; should not happen on a real network
                new = hi
            else:
                for _ in range(200):
                    mid = 0.5 * (lo + hi)
                    if net.net_into(node_id, {**p, node_id: mid}) > 0:
                        lo = mid
                    else:
                        hi = mid
                    if hi - lo < 1e-12 * max(1.0, abs(mid)):
                        break
                new = 0.5 * (lo + hi)
            moved = max(moved, abs(new - p[node_id]))
            p[node_id] = new
        if moved < tol:
            return p, sweep + 1
    return p, max_sweeps


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

def case_linear_star():
    """Two wells on a header, one trunk to the separator."""
    nodes = {
        'w1': {'kind': 'well', 'q': linear_well(60000, 900)},
        'w2': {'kind': 'well', 'q': linear_well(40000, 700)},
        'h': {'kind': 'junction'},
        's': {'kind': 'sink', 'p': 150.0},
    }
    branches = [
        {'id': 'b1', 'from': 'w1', 'to': 'h', 'f': linear_branch(80)},
        {'id': 'b2', 'from': 'w2', 'to': 'h', 'f': linear_branch(120)},
        {'id': 'b3', 'from': 'h', 'to': 's', 'f': linear_branch(400)},
    ]
    return Network(nodes, branches), {
        'branches': {'b1': 80, 'b2': 120, 'b3': 400},
        'wells': {'w1': [60000, 900], 'w2': [40000, 700]},
    }


def case_turbulent_tree():
    """
    Three wells, two headers in series, turbulent branches and Vogel
    inflows. Nothing here has a closed form.
    """
    nodes = {
        'w1': {'kind': 'well', 'q': vogel_well(4200, 2600)},
        'w2': {'kind': 'well', 'q': vogel_well(2900, 2200)},
        'w3': {'kind': 'well', 'q': vogel_well(5100, 3000)},
        'h1': {'kind': 'junction'},
        'h2': {'kind': 'junction'},
        's': {'kind': 'sink', 'p': 180.0},
    }
    branches = [
        {'id': 'b1', 'from': 'w1', 'to': 'h1', 'f': turbulent_branch(140)},
        {'id': 'b2', 'from': 'w2', 'to': 'h1', 'f': turbulent_branch(95)},
        {'id': 'b3', 'from': 'w3', 'to': 'h2', 'f': turbulent_branch(160)},
        {'id': 'b4', 'from': 'h1', 'to': 'h2', 'f': turbulent_branch(260)},
        {'id': 'b5', 'from': 'h2', 'to': 's', 'f': turbulent_branch(410)},
    ]
    return Network(nodes, branches), {
        'branches': {'b1': 140, 'b2': 95, 'b3': 160, 'b4': 260, 'b5': 410},
        'wells': {'w1': [4200, 2600], 'w2': [2900, 2200], 'w3': [5100, 3000]},
    }


def case_looped():
    """
    A loop: two parallel paths from the header to the separator. Loops
    are what make a network a network rather than a tree, and they are
    where a solver that quietly assumed a tree falls over.
    """
    nodes = {
        'w1': {'kind': 'well', 'q': vogel_well(6000, 2800)},
        'w2': {'kind': 'well', 'q': vogel_well(4500, 2400)},
        'h': {'kind': 'junction'},
        'm': {'kind': 'junction'},
        's': {'kind': 'sink', 'p': 200.0},
    }
    branches = [
        {'id': 'b1', 'from': 'w1', 'to': 'h', 'f': turbulent_branch(150)},
        {'id': 'b2', 'from': 'w2', 'to': 'h', 'f': turbulent_branch(130)},
        {'id': 'b3', 'from': 'h', 'to': 'm', 'f': turbulent_branch(300)},
        {'id': 'b4', 'from': 'h', 'to': 's', 'f': turbulent_branch(180)},
        {'id': 'b5', 'from': 'm', 'to': 's', 'f': turbulent_branch(220)},
    ]
    return Network(nodes, branches), {
        'branches': {'b1': 150, 'b2': 130, 'b3': 300, 'b4': 180, 'b5': 220},
        'wells': {'w1': [6000, 2800], 'w2': [4500, 2400]},
    }


def wells_fight():
    """
    The result the whole studio exists for, computed the slow honest
    way: solve the same header with one well, then two, then three, and
    watch each well's rate FALL as the others are added.

    Nothing about this is subtle once it is written down, and that is
    the point: it is invisible to any amount of single-well analysis,
    because every single-well study is run against a wellhead pressure
    somebody typed in.
    """
    specs = [(4200, 2600, 140), (2900, 2200, 95), (5100, 3000, 160)]
    out = []
    for count in (1, 2, 3):
        nodes = {'h': {'kind': 'junction'}, 's': {'kind': 'sink', 'p': 180.0}}
        branches = [{'id': 'trunk', 'from': 'h', 'to': 's', 'f': turbulent_branch(410)}]
        for i in range(count):
            qmax, pr, k = specs[i]
            nodes[f'w{i}'] = {'kind': 'well', 'q': vogel_well(qmax, pr)}
            branches.append(
                {'id': f'f{i}', 'from': f'w{i}', 'to': 'h', 'f': turbulent_branch(k)})
        net = Network(nodes, branches)
        p, _ = solve_gauss_seidel(net)
        out.append({
            'count': count,
            'headerPsia': p['h'],
            'wellRates': {f'w{i}': nodes[f'w{i}']['q'](p[f'w{i}']) for i in range(count)},
            'pressures': {k: v for k, v in p.items()},
        })
    return out


def main():
    cases = {}
    for name, builder in (
        ('linear_star', case_linear_star),
        ('turbulent_tree', case_turbulent_tree),
        ('looped', case_looped),
    ):
        net, spec = builder()
        p, sweeps = solve_gauss_seidel(net)
        flows = net.flows(p)
        produced = sum(
            n['q'](p[i]) for i, n in net.nodes.items() if n['kind'] == 'well')
        delivered = sum(
            q for b, q in ((b, flows[b['id']]) for b in net.branches)
            if net.nodes[b['to']]['kind'] == 'sink')
        cases[name] = {
            'spec': spec,
            'pressures': p,
            'flows': flows,
            'wellRates': {i: n['q'](p[i]) for i, n in net.nodes.items() if n['kind'] == 'well'},
            'sweeps': sweeps,
            'producedLbD': produced,
            'deliveredLbD': delivered,
            'conservationGap': produced - delivered,
        }
        print(f'{name}: {sweeps} sweeps, conservation gap '
              f'{produced - delivered:.3e} of {produced:.1f}')
        for k, v in sorted(p.items()):
            print(f'   {k:>6}  {v:10.4f} psia')

    fight = wells_fight()
    cases['wells_fight'] = fight
    print('\nwells fighting for the same header:')
    for row in fight:
        rates = ', '.join(f'{k}={v:.1f}' for k, v in sorted(row['wellRates'].items()))
        print(f'   {row["count"]} well(s): header {row["headerPsia"]:8.2f} psia   {rates}')

    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, '..', '..', '..', 'test-data', 'production',
                       'goldens', 'network_cases.json')
    out = os.path.normpath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w') as fh:
        json.dump(cases, fh, indent=1, sort_keys=True)
    print(f'\nwrote {out}')


if __name__ == '__main__':
    main()
