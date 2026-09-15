#!/usr/bin/env python3
"""Independent oracle for the Economics capital portfolio optimizer
(engines/economics/portfolio.js). Emits committed goldens to
test-data/economics/goldens/portfolio_cases.json.

INDEPENDENCE DISCIPLINE. This file is written from the METHOD STATEMENTS the
engine documents (the ProspectRiskEngine risking convention, the 0/1
knapsack, the normal approximation with an average pairwise correlation)
and NOT by transcribing the JavaScript:

  risked EMV        EMV = pos * npv_p50 minus (1 minus pos) * fail_cost, pos
                    the chance of success in [0, 1] (1 when missing or null;
                    since EC5-6 a pos that is present must be a number or a
                    numeric string inside [0, 1], and a blank, non-numeric or
                    out-of-range pos is REFUSED, see refusal below), fail_cost
                    the expected loss on failure, >= 0 (default 0; a negative
                    entry is 0). A missing NPV is 0.

  success spread    the success-case standard deviation is the explicit
                    npv_stddev when it is a positive number; otherwise
                    (P10 minus P90) / 2.5631 when P10 > P90, 2.5631 being
                    twice the 90 percent normal quantile; otherwise 0.

  mixture moments   with probability pos the project is normal(npv_p50, sd)
                    and otherwise a point mass at minus fail_cost, so
                    mean = pos mu minus (1 minus pos) c and
                    E[X^2] = pos (sd^2 + mu^2) + (1 minus pos) c^2,
                    variance = E[X^2] minus mean^2. Exact.

  portfolio risk    (EC5-0, owner decision 2026-09-14.) Closed form for the
                    mean and spread, under one average pairwise correlation
                    rho (clamped to [0, 1], a non-numeric entry is 0):
                    mean = sum mean_i,
                    Var = sum var_i + rho ((sum sd_i)^2 minus sum var_i),
                    and the independent spread sqrt(sum var_i) beside it.
                    P(NPV < 0), P90 and P10 are a SEEDED MONTE CARLO of a
                    one-factor Gaussian copula: rng = mulberry32(seed) (an
                    integer seed taken unsigned, anything else the default
                    20260829; iterations an integer >= 1, anything else
                    10000). Each iteration draws, in this fixed order, two
                    standard normals F1, F2 and then, per project in array
                    order, e1 and e2 (every normal is drawn whether or not
                    it is used), with z1 = sqrt(rho) F1 + sqrt(1 minus rho)
                    e1 and z2 likewise from F2 and e2. The project succeeds
                    when Phi(z1) < pos and is then worth npv_p50 + sd z2;
                    otherwise it is worth minus fail_cost. The portfolio
                    value is the sum. probLoss = count(value < 0) /
                    iterations; P90 = the simple-statistics quantile at 0.1
                    (the LOW case, exceedance convention); P10 = the
                    quantile at 0.9. An empty selection is 0, 0, 0.

  sampler replica   the goldens' risk blocks are that Monte Carlo REPLAYED
                    here bit for bit: mulberry32 in uint32 (imported from
                    oracle_screening.py), Box-Muller as
                    sqrt(-2 ln u) cos(2 pi v) with the same "redraw while
                    exactly 0" loops, Phi through the Abramowitz and Stegun
                    7.1.26 erf written out (the engine's normalCDF), and
                    oracle_screening.py's simple-statistics quantile. The
                    project parameters are rebuilt in float arithmetic as
                    the engine evaluates them. Python's log, cos and exp are
                    the C library's while V8 carries its own ports, so a
                    last-ulp difference is possible: the gate compares
                    probLoss EXACTLY (it is a count ratio) and P90 / P10
                    within 1e-9 scaled. A replica is not validation, so:

  risk method       the METHOD is validated independently of the replica in
                    the riskMethod section, against answers that owe nothing
                    to sampling: (1) independent binary projects with no
                    success spread at rho 0 by exact enumeration of all 2^n
                    outcomes; (2) pos 1 normal projects, a normal sum with
                    the moment variance (the copula correlates z2 at exactly
                    rho), P(loss) = Phi(minus mean / sd) through math.erf;
                    (3) rho 1, where z1 = F1 for every project, so the
                    outcomes are comonotone in one uniform U = Phi(F1) and
                    the distribution is exact by intervals of U; (4) a
                    success / failure mixture with spreads at rho 0 by
                    enumerating success sets, each a normal or a point; (5)
                    binary projects at 0 < rho < 1 by conditioning on F1
                    (given F1 the projects are independent with success
                    probability Phi((Phi^-1(pos) minus sqrt(rho) F1) /
                    sqrt(1 minus rho))) and Simpson integration over F1. Each
                    case asserts |mc minus exact| <= 4 standard errors
                    (sqrt(p (1 minus p) / n) for a probability; for a
                    continuous quantile sqrt(p (1 minus p) / n) / f(q)). For
                    a DISCRETE distribution the Monte Carlo P90 must EQUAL
                    the exact 10th-percentile outcome (and P10 the 90th)
                    whenever neither the cumulative probability at that
                    outcome nor the one just below it is within 0.01 of the
                    level, where sampling could not tip it. The normal
                    approximation the engine used to report is carried on
                    each case as information (normalApprox), so the size of
                    the old error is on the record.

  knapsack          the 0/1 knapsack maximising summed risked EMV under the
                    capex limit is solved by BRUTE FORCE over every subset of
                    the positive-EMV projects (2^n subsets, n <= 16), where
                    the engine runs a dynamic programme. Projects with EMV
                    <= 0 are never forced in (leaving capital unspent is
                    always allowed), so they are simply not candidates. A
                    negative limit is 0. The golden lists EVERY subset that
                    attains the optimum, so a tie is a tie and not a hidden
                    convention.

  quantisation      the engine's documented rule: when the limit and every
                    candidate capex are integers and the limit is at most
                    5000, the grid is 1 $MM and the knapsack is exact;
                    otherwise the grid is limit / 2000 per cell, each project
                    weighs max(1, round(capex / cell)) cells (round half up,
                    as JavaScript rounds), a project heavier than the whole
                    grid is skipped, and a set is feasible when its cell
                    weights sum to at most round(limit / cell). The oracle
                    solves BOTH problems by brute force, the EXACT one
                    (sum of actual capex <= limit) and the QUANTISED one the
                    engine actually solves, and the golden carries both with
                    the gap and a flag saying whether quantisation changed
                    the chosen set. A free project (capex 0) weighs one cell
                    on the grid, which the exact problem does not charge:
                    see the freeProject cases and FINDINGS-decision.md.
                    Every optimal set carries overLimit (its capex > the
                    clamped limit) and overLimitBy (max(0, capex minus
                    limit)), which the engine now reports for the set it
                    chose (EC5-0; D3 is flagged, not prevented).

  refusal           (EC5-0, widened by EC5-6 and EC5-7, owner decisions
                    2026-09-15.) The optimizer checks every project in array
                    order, capex first and then pos, and refuses the first
                    failure with a PortfolioInputError naming the project
                    (name, else id, else its index; "A project with no name
                    or id" when a lone project has neither). capex must be a
                    finite number of 0 or more: missing or null ("has no
                    capex"), blank ("has a blank capex"), not a finite number
                    ("has a capex that is not a finite number (<value>)"),
                    below 0 ("has a negative capex (<n>)"), each ending
                    "; capex must be 0 or more". pos, when present, must be a
                    number in [0, 1]: blank ("has a blank pos"), not a number
                    ("has a pos that is not a number (<value>)"), outside
                    ("has a pos outside 0 to 1 (<n>)"), each ending "; pos
                    must be a number from 0 to 1". A string value is shown
                    in double quotes. A numeric string is a number (the
                    ECMAScript decimal literal grammar, Infinity included; a
                    boolean is not a number). projectEmv, projectMoments and
                    portfolioRiskMetrics refuse an invalid pos the same way
                    (the risk summary by index in the selection).

  frontier          on the quantised grid: for each budget b of cells from 0,
                    best(b) is the largest EMV of a set weighing at most b;
                    the frontier lists every b at which best(b) rises, with
                    the EMV and the ACTUAL capex of the sets attaining it
                    (all of them, since at a tie the engine may report any).
                    best(0) = 0 with the empty set, so every frontier begins
                    at (0, 0).

  arithmetic        EMVs, capex sums, means and variances are exact
                    fractions.Fraction values of the binary inputs the
                    engine receives (Fraction(float) is exact), emitted as
                    full-precision floats. Square roots and the normal CDF
                    are double precision.

  seeded cases      the random project sets are generated by mulberry32
                    (the generator in lib/stats/stats.js) replicated in
                    uint32 arithmetic (Math.imul as a masked 32-bit product,
                    every step masked to 32 bits, then divided by
                    4294967296; the port is oracle_screening.py's, the same
                    one the sampler replica uses). Seeds are stated on each case and the
                    projects themselves are written into the golden, so the
                    gate never needs the generator.

All money is USD millions ($MM), the engine's documented unit; the rawDollars
case feeds dollars deliberately to exercise the quantised grid, and its EMV is
in whatever unit its NPVs were typed in (the engine never converts).

stdlib only. Regenerate (deterministic, byte identical):
    python3 tools/validation/economics/oracle_portfolio.py
"""
import json
import math
import os
import re
import sys
from fractions import Fraction as F
from statistics import NormalDist

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from oracle_screening import mulberry32, ss_quantile_sorted  # noqa: E402  (bit-for-bit ports, reused)

OUT = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'test-data', 'economics',
                                    'goldens', 'portfolio_cases.json'))

SPREAD_DIVISOR = F(2.5631)
DEFAULT_SEED = 20260829
DEFAULT_ITERATIONS = 10000
GOLDEN_OPTS = {'seed': DEFAULT_SEED, 'iterations': 2000}
M32 = 0xFFFFFFFF
STD = NormalDist()


def out(x):
    if isinstance(x, bool) or x is None or isinstance(x, str):
        return x
    if isinstance(x, F):
        return float(x)
    if isinstance(x, (int, float)):
        return x
    if isinstance(x, dict):
        return {k: out(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [out(v) for v in x]
    raise TypeError(type(x))


class Refused(Exception):
    """The PortfolioInputError the engine must throw, with its message."""


JS_DECIMAL = re.compile(r'^[+-]?(Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)$')


def js_numeric(raw):
    """Number(raw) for a number or a string, None when that is NaN (a blank
    string is handled by the caller). A boolean or any other type is NaN."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return None if (isinstance(raw, float) and raw != raw) else raw
    if isinstance(raw, str):
        t = raw.strip()
        if not JS_DECIMAL.match(t):
            return None
        return float(t.replace('Infinity', 'inf')) if 'Infinity' in t else (int(t) if re.match(r'^[+-]?\d+$', t) else float(t))
    return None


def js_num_text(n):
    """How a template string prints a number."""
    if isinstance(n, float) and math.isinf(n):
        return 'Infinity' if n > 0 else '-Infinity'
    return str(int(n)) if float(n).is_integer() else repr(float(n))


def shown(raw):
    return '"%s"' % raw if isinstance(raw, str) else (('true' if raw else 'false') if isinstance(raw, bool) else js_num_text(raw))


def who(p, index=None):
    label = p.get('name', p.get('id', index))
    if label is None:
        return 'A project with no name or id'
    return 'Project "%s"' % label


def strict_pos(p, index=None):
    """The EC5-6 method statement for pos."""
    raw = p.get('pos')
    if raw is None:
        return F(1)
    rule = 'pos must be a number from 0 to 1'
    if isinstance(raw, str) and raw.strip() == '':
        raise Refused('%s has a blank pos; %s' % (who(p, index), rule))
    n = js_numeric(raw)
    if n is None:
        raise Refused('%s has a pos that is not a number (%s); %s' % (who(p, index), shown(raw), rule))
    if not (0 <= n <= 1):
        raise Refused('%s has a pos outside 0 to 1 (%s); %s' % (who(p, index), js_num_text(n), rule))
    return F(n)


def strict_capex(p, index=None):
    """The EC5-7 method statement for capex."""
    raw = p.get('capex')
    rule = 'capex must be 0 or more'
    if raw is None:
        raise Refused('%s has no capex; %s' % (who(p, index), rule))
    if isinstance(raw, str) and raw.strip() == '':
        raise Refused('%s has a blank capex; %s' % (who(p, index), rule))
    n = js_numeric(raw)
    if n is None or math.isinf(n):
        raise Refused('%s has a capex that is not a finite number (%s); %s' % (who(p, index), shown(raw), rule))
    if n < 0:
        raise Refused('%s has a negative capex (%s); %s' % (who(p, index), js_num_text(n), rule))
    return F(n)


def num(v):
    """A numeric field as an exact Fraction, or None when it is not a number."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, F):
        return v
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v):
            return None
        return F(v)
    return None


# ---------------------------------------------------------------------
# Project-level quantities.
# ---------------------------------------------------------------------

def pos_of(p):
    return strict_pos(p)


def fail_cost_of(p):
    v = num(p.get('fail_cost', 0))
    return max(F(0), v) if v is not None else F(0)


def npv_of(p):
    v = num(p.get('npv_p50', 0))
    return v if v is not None else F(0)


def emv(p):
    pos = pos_of(p)
    return pos * npv_of(p) - (1 - pos) * fail_cost_of(p)


def success_sd(p):
    sd = num(p.get('npv_stddev'))
    if sd is not None and sd > 0:
        return sd
    p10, p90 = num(p.get('npv_p10')), num(p.get('npv_p90'))
    if p10 is not None and p90 is not None and p10 > p90:
        return (p10 - p90) / SPREAD_DIVISOR
    return F(0)


def moments(p):
    pos, c, mu = pos_of(p), fail_cost_of(p), npv_of(p)
    sd = success_sd(p)
    mean = pos * mu - (1 - pos) * c
    second = pos * (sd * sd + mu * mu) + (1 - pos) * c * c
    return mean, max(F(0), second - mean * mean)


def phi(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def rho_of(v):
    r = num(v)
    if r is None:
        return F(0)
    return min(F(1), max(F(0), r))


def closed_form(selected, correlation=0):
    rho = rho_of(correlation)
    mean = F(0)
    var_sum = F(0)
    sd_sum = 0.0
    for p in selected:
        m, v = moments(p)
        mean += m
        var_sum += v
        sd_sum += math.sqrt(float(v))
    cross = max(0.0, sd_sum * sd_sum - float(var_sum))
    variance = float(var_sum) + float(rho) * cross
    sd = math.sqrt(max(0.0, variance))
    return rho, mean, sd, math.sqrt(float(var_sum))


# ---------------------------------------------------------------------
# The Monte Carlo sampler, replayed bit for bit.
# ---------------------------------------------------------------------

def js_erf(x):
    """Abramowitz and Stegun 7.1.26, evaluated in the engine's order."""
    sign = -1.0 if x < 0 else 1.0
    ax = abs(x)
    t = 1.0 / (1.0 + 0.3275911 * ax)
    y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) \
        * t * math.exp(-ax * ax)
    return sign * y


def js_normal_cdf(x):
    return 0.5 * (1.0 + js_erf(x / math.sqrt(2.0)))


def box_muller(rng):
    u = 0.0
    v = 0.0
    while u == 0:
        u = rng()
    while v == 0:
        v = rng()
    return math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)


def js_success_sd(p):
    """successStdDev in the engine's float arithmetic."""
    sd = num(p.get('npv_stddev'))
    if sd is not None and sd > 0:
        return float(sd)
    p10, p90 = num(p.get('npv_p10')), num(p.get('npv_p90'))
    if p10 is not None and p90 is not None and p10 > p90:
        return (float(p10) - float(p90)) / 2.5631
    return 0.0


def run_options(opts):
    opts = opts or {}
    seed = opts.get('seed', DEFAULT_SEED)
    iters = opts.get('iterations', DEFAULT_ITERATIONS)

    def is_int(v):
        return not isinstance(v, bool) and (isinstance(v, int) or (isinstance(v, float) and v.is_integer()))
    seed = int(seed) & M32 if is_int(seed) else DEFAULT_SEED
    iters = int(iters) if is_int(iters) and iters >= 1 else DEFAULT_ITERATIONS
    return seed, iters


def sample_values(selected, rho, seed, iters):
    """The sorted portfolio values of the replayed Monte Carlo."""
    params = [(float(pos_of(p)), float(fail_cost_of(p)), float(npv_of(p)), js_success_sd(p)) for p in selected]
    r = float(rho)
    a = math.sqrt(r)
    b = math.sqrt(1.0 - r)
    rng = mulberry32(seed)
    values = []
    for _ in range(iters):
        f1 = box_muller(rng)
        f2 = box_muller(rng)
        total = 0.0
        for pos, fail, mu, sd in params:
            e1 = box_muller(rng)
            e2 = box_muller(rng)
            z1 = a * f1 + b * e1
            z2 = a * f2 + b * e2
            total += (mu + sd * z2) if js_normal_cdf(z1) < pos else -fail
        values.append(total)
    values.sort()
    return values


def risk(selected, correlation=0, opts=None):
    rho, mean, sd, indep = closed_form(selected, correlation)
    seed, iters = run_options(opts)
    rec = {'emv': mean, 'stdDev': sd, 'correlation': rho, 'independentStdDev': indep,
           'seed': seed, 'iterations': iters, 'method': 'monte-carlo'}
    if not selected:
        rec.update({'probLoss': 0.0, 'p90': 0.0, 'p10': 0.0})
        return rec
    values = sample_values(selected, rho, seed, iters)
    losses = sum(1 for v in values if v < 0)
    rec.update({'probLoss': losses / iters, 'lossCount': losses,
                'p90': ss_quantile_sorted(values, 0.1), 'p10': ss_quantile_sorted(values, 0.9)})
    return rec


# ---------------------------------------------------------------------
# Knapsack by brute force, exact and on the engine's grid.
# ---------------------------------------------------------------------

def js_round(x):
    """JavaScript Math.round: half rounds toward positive infinity."""
    return math.floor(x + 0.5)


def capex_of(p):
    return strict_capex(p)


def is_integer(v):
    return v is not None and v.denominator == 1


def grid(limit, candidates):
    all_int = is_integer(limit) and all(is_integer(capex_of(p)) for p in candidates)
    if all_int and limit <= 5000:
        resolution = 1.0
    else:
        resolution = max(1e-9, float(limit) / 2000)
    cells = js_round(float(limit) / resolution)
    return resolution, cells


def subsets(items):
    n = len(items)
    for mask in range(1 << n):
        yield [items[i] for i in range(n) if mask >> i & 1]


def set_record(sel, rho, limit, opts):
    ids = [p['id'] for p in sel]
    capex = sum((capex_of(p) for p in sel), F(0))
    return {
        'ids': ids,
        'capex': capex,
        'overLimit': capex > limit,
        'overLimitBy': max(F(0), capex - limit),
        'emv': sum((emv(p) for p in sel), F(0)),
        'npvSuccess': sum((npv_of(p) for p in sel), F(0)),
        'risk': risk(sel, rho, opts),
    }


def optimize(projects, capex_limit, correlation=0, opts=None):
    lim = num(capex_limit)
    limit = max(F(0), lim) if lim is not None else F(0)
    # Only projects with a strictly positive risked EMV can ever improve a
    # maximum, so they are the only candidates; the engine's own candidate
    # filter (capex > 0 or EMV > 0) is wider but never changes an optimum.
    positive = [p for p in projects if emv(p) > 0]
    grid_candidates = [p for p in projects if capex_of(p) > 0 or emv(p) > 0]
    resolution, cells = grid(limit, grid_candidates)
    weights = {p['id']: max(1, js_round(float(capex_of(p)) / resolution)) for p in positive}
    on_grid = [p for p in positive if weights[p['id']] <= cells]

    # Exact problem.
    exact_best = F(0)
    exact_sets = []
    for sel in subsets(positive):
        c = sum((capex_of(p) for p in sel), F(0))
        if c > limit:
            continue
        e = sum((emv(p) for p in sel), F(0))
        if e > exact_best:
            exact_best, exact_sets = e, [sel]
        elif e == exact_best:
            exact_sets.append(sel)

    # Quantised problem and its frontier.
    quant_best = F(0)
    quant_sets = []
    by_weight = {}
    for sel in subsets(on_grid):
        w = sum(weights[p['id']] for p in sel)
        if w > cells:
            continue
        e = sum((emv(p) for p in sel), F(0))
        if e > quant_best:
            quant_best, quant_sets = e, [sel]
        elif e == quant_best:
            quant_sets.append(sel)
        by_weight.setdefault(w, []).append((e, sel))
    frontier = []
    last = F(-1)
    for w in range(cells + 1):
        here = by_weight.get(w, [])
        best_here = max((e for e, _ in here), default=F(-1))
        if best_here > last:
            caps = sorted({sum((capex_of(p) for p in sel), F(0)) for e, sel in here if e == best_here})
            frontier.append({'weight': w, 'emv': best_here, 'capexCandidates': caps})
            last = best_here

    exact_recs = sorted((set_record(s, correlation, limit, opts) for s in exact_sets), key=lambda r: r['ids'])
    quant_recs = sorted((set_record(s, correlation, limit, opts) for s in quant_sets), key=lambda r: r['ids'])
    changed = {tuple(r['ids']) for r in exact_recs} != {tuple(r['ids']) for r in quant_recs}
    return {
        'limit': limit, 'resolution': resolution, 'cells': cells,
        'weights': {p['id']: weights[p['id']] for p in positive},
        'exact': {'optimalEmv': exact_best, 'optimalSets': exact_recs},
        'quantized': {'optimalEmv': quant_best, 'optimalSets': quant_recs, 'frontier': frontier},
        'quantizationGap': quant_best - exact_best,
        'setChanged': changed,
    }


# ---------------------------------------------------------------------
# Seeded project sets.
# ---------------------------------------------------------------------

def seeded_projects(seed, n, capex_lo, capex_hi, decimals=0):
    """Projects from mulberry32(seed): capex uniform in [capex_lo, capex_hi]
    at the stated decimals, NPV a multiple of capex, pos in [0.15, 1], a
    fail cost that is a share of capex, and P10 / P90 around the P50."""
    rng = mulberry32(seed)
    ps = []
    scale = 10 ** decimals
    for i in range(n):
        capex = math.floor((capex_lo + rng() * (capex_hi - capex_lo)) * scale + 0.5) / scale
        npv = round(capex * (0.4 + 2.2 * rng()), 1)
        pos = round(0.15 + 0.85 * rng(), 2)
        fail = round(capex * (0.2 + 0.6 * rng()), 1)
        p10 = round(npv * (1.3 + 0.5 * rng()), 1)
        p90 = round(npv * (0.3 + 0.4 * rng()), 1)
        ps.append({'id': 'S%d_%02d' % (seed, i + 1), 'name': 'Seed %d project %d' % (seed, i + 1),
                   'capex': capex, 'npv_p50': npv, 'pos': pos, 'fail_cost': fail,
                   'npv_p10': p10, 'npv_p90': p90})
    return ps


# ---------------------------------------------------------------------
# Cases.
# ---------------------------------------------------------------------

def P(name, capex, npv, **extra):
    d = {'id': name, 'name': name, 'capex': capex, 'npv_p50': npv}
    d.update(extra)
    return d


CLASSIC = [P('A', 100, 60), P('B', 200, 100), P('C', 300, 120), P('D', 150, 90)]
RISK_A = {'npv_p50': 100, 'npv_p10': 160, 'npv_p90': 40, 'pos': 1}
RISK_B = {'npv_p50': 80, 'npv_p10': 130, 'npv_p90': 30, 'pos': 1}


def emv_cases():
    cases = []

    def add(cid, desc, p):
        cases.append({'id': cid, 'description': desc, 'project': p, 'expected': {'emv': emv(p)}})

    add('unrisked', 'Suite: pos and fail_cost absent; EMV is the NPV (250).', P('a', 100, 250))
    add('risked', 'Suite: 0.3 * 300 minus 0.7 * 50 = 55.', P('a', 100, 300, pos=0.3, fail_cost=50))
    add('posOneBoundary', 'pos exactly 1 is accepted; EMV is the NPV.', P('a', 10, 80, pos=1, fail_cost=30))
    add('nullPosIsDefault', 'EC5-6: a null pos is the documented default 1, like a missing one.', P('a', 10, 80, pos=None, fail_cost=30))
    add('numericStringPos', 'EC5-6: a numeric string pos is a number: " 0.3 " on 300 / 50 gives 55.', P('a', 100, 300, pos=' 0.3 ', fail_cost=50))
    add('negativeFailCostIsZero', 'A negative fail cost is 0.', P('a', 10, 80, pos=0.5, fail_cost=-30))
    add('missingNpvIsZero', 'No NPV at all; EMV is minus (1 minus pos) times the fail cost.', {'id': 'a', 'capex': 10, 'pos': 0.25, 'fail_cost': 8})
    add('posZero', 'pos 0; EMV is exactly minus the fail cost.', P('a', 10, 80, pos=0, fail_cost=30))
    return cases


def emv_refusal_cases():
    """EC5-6: a present pos that is blank, non-numeric or outside 0..1 is
    refused by projectEmv (and projectMoments) naming the project."""
    cases = []

    def add(cid, desc, p):
        try:
            emv(p)
        except Refused as e:
            cases.append({'id': cid, 'description': desc, 'project': p,
                          'expected': {'throws': 'PortfolioInputError', 'message': str(e)}})
            return
        raise AssertionError('expected a refusal: %s' % cid)

    add('blankPosRefused', 'EC5-6: a blank pos used to read as 0, so the project was a certain failure (EMV minus the fail cost).',
        P('Wildcat', 10, 300, pos='', fail_cost=50))
    add('whitespacePosRefused', 'A pos of spaces is blank too.', P('Wildcat', 10, 300, pos='   ', fail_cost=50))
    add('nonNumericPosRefused', 'EC5-6: "n/a" used to read as the default 1, a certain success.', P('a', 10, 80, pos='n/a', fail_cost=30))
    add('posAboveOneRefused', 'EC5-6: pos 1.4 used to be clamped to 1.', P('a', 10, 80, pos=1.4, fail_cost=30))
    add('posBelowZeroRefused', 'EC5-6: pos -0.2 used to be clamped to 0.', P('a', 10, 80, pos=-0.2, fail_cost=30))
    add('percentTypedAsPosRefused', 'A chance typed as a percentage (30) is outside 0 to 1.', P('Appraisal', 10, 80, pos=30, fail_cost=30))
    add('infinityStringPosRefused', 'The string "Infinity" is a number outside 0 to 1.', P('a', 10, 80, pos='Infinity'))
    add('booleanPosRefused', 'A boolean pos is not a number.', P('a', 10, 80, pos=True))
    add('unnamedProjectRefused', 'A project with no name or id is described as such.', {'capex': 10, 'npv_p50': 80, 'pos': 'abc'})
    add('idNamesTheProject', 'With no name the id names the project.', {'id': 'P-7', 'capex': 10, 'npv_p50': 80, 'pos': '0.5x'})
    return cases


def risk_refusal_cases():
    """EC5-6 in the risk summary: the first invalid pos, by name, else id,
    else its index in the selection."""
    cases = []
    for cid, desc, selected in [
        ('blankPosByIndex', 'The second selected project (index 1) has a blank pos.',
         [{'npv_p50': 100, 'pos': 0.5, 'fail_cost': 20}, {'npv_p50': 50, 'pos': ''}]),
        ('outOfRangeByName', 'A named project with pos 2.', [{'name': 'Deep', 'npv_p50': 400, 'pos': 2}]),
    ]:
        msg = None
        for i, p in enumerate(selected):
            try:
                strict_pos(p, i)
            except Refused as e:
                msg = str(e)
                break
        assert msg is not None, cid
        cases.append({'id': cid, 'description': desc, 'selected': selected,
                      'expected': {'throws': 'PortfolioInputError', 'message': msg}})
    return cases


def sd_cases():
    cases = []

    def add(cid, desc, p):
        cases.append({'id': cid, 'description': desc, 'project': p, 'expected': {'sd': success_sd(p)}})

    add('explicitStddev', 'Suite: npv_stddev 40 wins over the percentiles.', {'npv_stddev': 40, 'npv_p10': 200, 'npv_p90': 50})
    add('percentileFallback', 'Suite: (200 minus 50) / 2.5631.', {'npv_p10': 200, 'npv_p90': 50})
    add('neither', 'Suite: nothing entered; 0.', {})
    add('invertedPercentiles', 'P10 below P90 is not a spread; 0.', {'npv_p10': 50, 'npv_p90': 200})
    add('equalPercentiles', 'P10 equal to P90; 0.', {'npv_p10': 50, 'npv_p90': 50})
    add('zeroStddevFallsBack', 'npv_stddev 0 is not positive, so the percentiles are used.', {'npv_stddev': 0, 'npv_p10': 200, 'npv_p90': 50})
    add('negativeStddevFallsBack', 'A negative npv_stddev is ignored in favour of the percentiles.', {'npv_stddev': -5, 'npv_p10': 120, 'npv_p90': 20})
    return cases


def moments_cases():
    cases = []

    def add(cid, desc, p):
        m, v = moments(p)
        cases.append({'id': cid, 'description': desc, 'project': p, 'expected': {'mean': m, 'variance': v}})

    add('mixture', 'Suite: pos 0.5, success N(100, 20), failure -40: mean 30, variance 5100.', {'npv_p50': 100, 'npv_stddev': 20, 'pos': 0.5, 'fail_cost': 40})
    add('sure', 'Suite: a sure project with no spread has zero variance.', {'npv_p50': 100})
    add('percentileRisked', 'pos 0.6 with P10 / P90 spread and a fail cost.', {'npv_p50': 120, 'npv_p10': 200, 'npv_p90': 60, 'pos': 0.6, 'fail_cost': 35})
    add('failureOnly', 'pos 0: a point mass at minus the fail cost; zero variance.', {'npv_p50': 120, 'npv_stddev': 30, 'pos': 0, 'fail_cost': 35})
    add('binaryNoSpread', 'pos 0.5 with no success spread: variance is the Bernoulli spread ((mu + c)^2 / 4).', {'npv_p50': 60, 'pos': 0.5, 'fail_cost': 20})
    return cases


def risk_cases():
    cases = []

    def add(cid, desc, selected, correlation=0, raw=None, opts=None, engine_defaults=False):
        opts = dict(GOLDEN_OPTS) if opts is None else opts
        rec = {'id': cid, 'description': desc, 'selected': selected,
               'correlation': raw if raw is not None else correlation,
               'riskOptions': opts,
               'expected': risk(selected, correlation, opts)}
        if engine_defaults:
            # The gate calls the engine with NO options, so this pins the
            # engine's defaults to the stated seed and iterations.
            rec['useEngineDefaults'] = True
        cases.append(rec)

    wildcat = {'npv_p50': 300, 'pos': 0.3, 'fail_cost': 50}
    three_mixed = [wildcat, {'npv_p50': 400, 'pos': 0.25, 'fail_cost': 60}, {'npv_p50': 250, 'pos': 0.4, 'fail_cost': 45}]
    engine_defaults = {'seed': DEFAULT_SEED, 'iterations': DEFAULT_ITERATIONS}
    add('defaultsSingleWildcat', 'EC5-0: one wildcat (pos 0.3, NPV 300, fail 50) at the ENGINE DEFAULT seed and iterations, called with no options. True P(loss) 0.7; the normal approximation said 0.366 with a P90 below the worst outcome.',
        [wildcat], 0, opts=engine_defaults, engine_defaults=True)
    add('defaultsThreeMixed', 'EC5-0: three risked projects (0.3 / 300 / 50, 0.25 / 400 / 60, 0.4 / 250 / 45) at the engine defaults, called with no options. The normal approximation put P90 at -193.46, below the worst case of -155.',
        three_mixed, 0, opts=engine_defaults, engine_defaults=True)
    add('otherSeed', 'The three risked projects at seed 7 and 2000 iterations: a different stream, the same closed-form mean and spread.', three_mixed, 0.3, opts={'seed': 7, 'iterations': 2000})
    add('seedFallback', 'A non-integer seed (1.5) falls back to the default seed.', three_mixed, 0, opts={'seed': 1.5, 'iterations': 2000})
    add('iterationsFallback', 'Iterations 0 is clamped to the default 10000.', [wildcat], 0, opts={'seed': 99, 'iterations': 0})

    a = {'npv_p50': 100, 'npv_stddev': 20, 'pos': 0.5, 'fail_cost': 40}
    b = {'npv_p50': 50, 'npv_stddev': 10}
    add('suiteIndependent', 'Suite: means 30 + 50 = 80, variances 5100 + 100, P(loss) = Phi(minus 80 / sqrt 5200).', [a, b])
    add('deterministicProfit', 'Suite: a sure profitable project has zero loss probability.', [{'npv_p50': 10}])
    add('deterministicLoss', 'A sure loss with zero spread has loss probability 1.', [{'npv_p50': -10}])
    add('empty', 'No projects: everything 0.', [])
    add('expectedLoss', 'A portfolio whose mean is negative with spread: P(loss) above one half.', [{'npv_p50': 40, 'npv_stddev': 30, 'pos': 0.3, 'fail_cost': 50}, b])
    for r in (0, 0.25, 0.5, 0.6, 0.75, 0.8, 1):
        add('correlation_%s' % str(r).replace('.', 'p'), 'Suite E5 pair (100 / 160 / 40 and 80 / 130 / 30) at rho %s.' % r, [RISK_A, RISK_B], r)
    add('clampAbove', 'Suite: rho 5 is clamped to 1.', [RISK_A, RISK_B], 5)
    add('clampBelow', 'Suite: rho -3 is clamped to 0.', [RISK_A, RISK_B], -3)
    add('nanIsZero', 'Suite: a non-numeric rho is 0 (the gate passes NaN for the string).', [RISK_A, RISK_B], 'NaN', raw='NaN')
    add('singleProject', 'Suite: one project has nothing to correlate with; rho 0.9 changes nothing.', [RISK_A], 0.9)
    add('threeRisked', 'Three risked projects with mixed spreads at rho 0.35.',
        [{'npv_p50': 100, 'npv_stddev': 20, 'pos': 0.5, 'fail_cost': 40},
         {'npv_p50': 120, 'npv_p10': 200, 'npv_p90': 60, 'pos': 0.6, 'fail_cost': 35},
         {'npv_p50': 50, 'npv_stddev': 10}], 0.35)
    return cases


def optimize_cases():
    cases = []

    def add(cid, desc, projects, limit, correlation=0, note=None):
        opts = dict(GOLDEN_OPTS)
        rec = {'id': cid, 'description': desc, 'projects': projects, 'capexLimit': limit,
               'correlation': correlation, 'riskOptions': opts,
               'expected': optimize(projects, limit, correlation, opts)}
        if note:
            rec['note'] = note
        cases.append(rec)

    add('classic450', 'Suite: A(100, 60) B(200, 100) C(300, 120) D(150, 90) at 450: A + B + D, capex 450, EMV 250.', CLASSIC, 450)
    add('riskedVsSure', 'Suite: X (npv 300, pos 0.2, fail 50: EMV 20) loses to sure Y (50) at the same capex.',
        [P('X', 100, 300, pos=0.2, fail_cost=50), P('Y', 100, 50)], 100)
    add('negativeNeverForced', 'Suite: a negative-EMV project is never taken even with capital to spare.',
        [P('bad', 50, -20), P('good', 50, 30)], 200)
    add('rawDollars', 'Suite: the classic set typed in dollars (capex times 1e6, limit 450e6); the grid quantises to 225000 per cell and the same set wins.',
        [dict(p, capex=p['capex'] * 1e6) for p in CLASSIC], 450e6)
    add('threadedCorrelation_0', 'Suite E5: two projects at limit 20, rho 0.', [P('1', 10, 100, npv_p10=160, npv_p90=40, pos=1), P('2', 10, 80, npv_p10=130, npv_p90=30, pos=1)], 20, 0)
    add('threadedCorrelation_0p7', 'Suite E5: the same at rho 0.7; same set, same EMV, wider spread.', [P('1', 10, 100, npv_p10=160, npv_p90=40, pos=1), P('2', 10, 80, npv_p10=130, npv_p90=30, pos=1)], 20, 0.7)
    add('tieIdenticalProjects', 'Tie: two identical projects and room for one; either set is optimal.',
        [P('twinA', 100, 50), P('twinB', 100, 50)], 100)
    add('tieDifferentComposition', 'Tie: {A} at capex 100 and {B, C} at capex 100 both reach EMV 80.',
        [P('A', 100, 80), P('B', 40, 40), P('C', 60, 40)], 100)
    add('zeroEmvExcluded', 'A project whose risked EMV is exactly 0 (pos 0.5, npv 40, fail 40) is never taken.',
        [P('zero', 30, 40, pos=0.5, fail_cost=40), P('good', 50, 30)], 500)
    add('negativeEmvHugeBudget', 'A negative risked EMV stays out however large the budget.',
        [P('neg', 20, 100, pos=0.1, fail_cost=60), P('good', 50, 30), P('better', 70, 45)], 10000)
    add('limitBelowEveryProject', 'Every project costs more than the limit: the empty portfolio, EMV 0, frontier (0, 0).',
        [P('A', 50, 60), P('B', 80, 100)], 30)
    add('limitZero', 'Limit 0: nothing fits.', CLASSIC, 0)
    add('limitNegative', 'A negative limit is 0.', CLASSIC, -100)
    add('exactFit', 'The optimum uses the whole budget exactly (A + B + D = 450 at limit 450 is already that; here B + C = 500 at 500).',
        [P('A', 100, 60), P('B', 200, 130), P('C', 300, 170), P('D', 150, 90)], 500)
    add('freeProjectZeroLimit', 'A free project (capex 0) with positive EMV at limit 0: the exact problem takes it; the grid charges it one cell it does not have.',
        [P('free', 0, 10)], 0, note='disagreement: see FINDINGS-decision.md, free project on the grid')
    add('freeProjectTightLimit', 'A free project beside A(100, 60) at limit 100: exact takes both (70); the grid weighs the free project one cell and must drop something.',
        [P('free', 0, 10), P('A', 100, 60)], 100, note='disagreement: see FINDINGS-decision.md, free project on the grid')
    add('freeProjectSlack', 'The same free project with one cell of slack (limit 101): both problems take both.',
        [P('free', 0, 10), P('A', 100, 60)], 101)
    add('gridOvershoot', 'Limit 6000 (grid 3 per cell): A(4000) weighs 1333 cells and B(2002) 667, so A + B fits the grid at 2000 cells although its capex is 6002; the exact optimum is A + C at 5995.',
        [P('A', 4000, 500), P('B', 2002, 300), P('C', 1995, 280)], 6000,
        note='disagreement: see FINDINGS-decision.md, grid overshoot; the engine reports a portfolio 2 $MM over the limit')
    add('gridUndershoot', 'Limit 6000 (grid 3 per cell): three projects of 1499 and one of 1502 total 5999 and fit exactly, but each rounds up to 500 or 501 cells (2001 > 2000), so the grid must drop one.',
        [P('W', 1499, 200), P('X', 1499, 210), P('Y', 1499, 220), P('Z', 1502, 230)], 6000,
        note='disagreement: see FINDINGS-decision.md, grid undershoot; the engine leaves a feasible project out')
    add('nonIntegerLimit', 'The classic set at limit 450.5: the grid is 0.22525 per cell and A + B + D still wins.', CLASSIC, 450.5)
    add('mixedRiskedRho0p3', 'Five risked projects with spreads at rho 0.3, exact grid.',
        [P('R1', 120, 200, pos=0.4, fail_cost=60, npv_p10=320, npv_p90=110),
         P('R2', 80, 90, pos=0.9, fail_cost=20, npv_p10=140, npv_p90=50),
         P('R3', 200, 260, pos=0.55, fail_cost=90, npv_stddev=70),
         P('R4', 60, 40, pos=1),
         P('R5', 150, 300, pos=0.25, fail_cost=120, npv_p10=450, npv_p90=180)], 330, 0.3)
    add('seeded6', 'mulberry32 seed 6001: six integer-capex projects, limit 320, exact grid.', seeded_projects(6001, 6, 40, 200), 320)
    add('seeded10decimal', 'mulberry32 seed 1002: ten one-decimal capex projects, limit 500.5, quantised grid of 0.25025.', seeded_projects(1002, 10, 20, 180, 1), 500.5, 0.2)
    add('seeded16large', 'mulberry32 seed 1601: sixteen integer projects with capex 100 to 900, limit 7200 (above 5000, so the grid is 3.6 per cell).', seeded_projects(1601, 16, 100, 900), 7200, 0.15)
    add('seeded16exact', 'mulberry32 seed 1602: sixteen integer projects with capex 10 to 200, limit 900, exact grid.', seeded_projects(1602, 16, 10, 200), 900)
    add('numericStrings', 'EC5-6 and EC5-7: capex and pos typed as numeric strings are numbers; the classic set with A at "0.9" and B at " 200 ".',
        [P('A', '100', 60, pos='0.9'), P('B', ' 200 ', 100), P('C', 300, 120), P('D', 150, 90, pos=None)], 450)
    return cases


def refusal_cases():
    """The refusal method statement: every project in array order, capex then
    pos, and the first failure is named (name, else id, else index)."""
    cases = []

    def add(cid, desc, projects, limit):
        msg = None
        for i, p in enumerate(projects):
            try:
                strict_capex(p, i)
                strict_pos(p, i)
            except Refused as e:
                msg = str(e)
                break
        assert msg is not None, cid
        label = '"%s"' % msg.split('"')[1] if msg.startswith('Project "') else msg.split(' has ')[0]
        cases.append({'id': cid, 'description': desc, 'projects': projects, 'capexLimit': limit,
                      'expected': {'throws': 'PortfolioInputError', 'message': msg,
                                   'messageIncludes': [label]}})

    add('negativeCapexRefused', 'EC5-0: B carries capex -150; the optimizer refuses it by name instead of letting the frontier axis go negative.',
        [P('A', 100, 60), P('B', -150, 100), P('C', 300, 120)], 450)
    add('negativeCapexUnnamed', 'A negative capex on a project with no name or id is named by its index (1).',
        [{'capex': 50, 'npv_p50': 20}, {'capex': -0.5, 'npv_p50': 10}], 100)
    add('nonNumericCapexRefused', 'EC5-7: capex "abc" used to count as 0, so the project was funded for free.',
        [P('A', 100, 60), P('B', 'abc', 100), P('C', 300, 120)], 450)
    add('blankCapexRefused', 'EC5-7: a blank capex is refused.', [P('A', 100, 60), P('Blank', '', 100)], 450)
    add('missingCapexRefused', 'EC5-7: a project with no capex at all is refused.', [P('A', 100, 60), {'id': 'NoCapex', 'npv_p50': 40}], 450)
    add('nullCapexRefused', 'EC5-7: a null capex is refused like a missing one.', [P('Null', None, 40)], 450)
    add('infiniteCapexRefused', 'EC5-7: the string "Infinity" is not a finite capex.', [P('Inf', 'Infinity', 40)], 450)
    add('blankPosRefusedInOptimize', 'EC5-6: a blank pos in the optimizer is refused by name (it used to read the project as a certain failure, so it was never chosen).',
        [P('Sure', 100, 60), P('Wildcat', 100, 300, pos='', fail_cost=50)], 200)
    add('posOutOfRangeInOptimize', 'EC5-6: pos 1.2 in the optimizer is refused (it used to be clamped to 1).', [P('Over', 100, 60, pos=1.2)], 200)
    add('firstBadProjectNamed', 'Array order: A has a bad pos and comes before B with a negative capex, so A is named.',
        [P('A', 100, 60, pos='x'), P('B', -1, 10)], 200)
    add('capexCheckedBeforePos', 'One project with a bad capex and a blank pos: the capex is reported.',
        [P('Both', 'abc', 60, pos='')], 200)
    return cases


# ---------------------------------------------------------------------
# The risk METHOD against answers that owe nothing to sampling.
# ---------------------------------------------------------------------

def old_normal_approx(selected, correlation):
    """What the engine reported before EC5-0 (information only)."""
    _, mean, sd, _ = closed_form(selected, correlation)
    m = float(mean)
    pl = phi(-m / sd) if sd > 0 else (1.0 if m < 0 else 0.0)
    return {'probLoss': pl, 'p90': m - 1.2816 * sd, 'p10': m + 1.2816 * sd}


def binary_params(selected):
    for p in selected:
        assert success_sd(p) == 0, 'binary cases carry no success spread'
    return [(float(pos_of(p)), float(npv_of(p)), -float(fail_cost_of(p))) for p in selected]


def dist_independent(selected):
    """Exact outcome distribution of independent binary projects (2^n)."""
    ps = binary_params(selected)
    dist = {}
    for mask in range(1 << len(ps)):
        prob = F(1)
        total = F(0)
        for i, (pos, win, lose) in enumerate(ps):
            if mask >> i & 1:
                prob *= F(pos)
                total += F(win)
            else:
                prob *= 1 - F(pos)
                total += F(lose)
        dist[total] = dist.get(total, F(0)) + prob
    return {float(k): float(v) for k, v in dist.items() if v > 0}


def dist_comonotone(selected):
    """rho 1: z1 = F1 for every project, so project i succeeds iff U < pos_i
    for one uniform U. Exact by the intervals between the sorted pos."""
    ps = binary_params(selected)
    cuts = sorted({0.0, 1.0} | {pos for pos, _, _ in ps})
    dist = {}
    for lo, hi in zip(cuts, cuts[1:]):
        u = (lo + hi) / 2
        total = F(0)
        for pos, win, lose in ps:
            total += F(win) if u < pos else F(lose)
        dist[float(total)] = dist.get(float(total), 0.0) + (hi - lo)
    return {k: v for k, v in dist.items() if v > 0}


def dist_copula(selected, rho, n_int=4000, span=10.0):
    """0 < rho < 1: condition on F1; the projects are then independent with
    success probability Phi((Phi^-1(pos) minus sqrt(rho) F1) / sqrt(1 minus rho)).
    Composite Simpson over F1 in [-span, span] against the normal density."""
    ps = binary_params(selected)
    a, b = math.sqrt(rho), math.sqrt(1 - rho)
    thresholds = [STD.inv_cdf(pos) if 0 < pos < 1 else (math.inf if pos >= 1 else -math.inf) for pos, _, _ in ps]
    h = 2 * span / n_int
    dist = {}
    for k in range(n_int + 1):
        f = -span + k * h
        wgt = (1 if k in (0, n_int) else (4 if k % 2 else 2)) * h / 3 * STD.pdf(f)
        cond = [phi((t - a * f) / b) for t in thresholds]
        for mask in range(1 << len(ps)):
            prob = wgt
            total = 0.0
            for i, (pos, win, lose) in enumerate(ps):
                if mask >> i & 1:
                    prob *= cond[i]
                    total += win
                else:
                    prob *= 1 - cond[i]
                    total += lose
            dist[total] = dist.get(total, 0.0) + prob
    return dist


def discrete_quantile(dist, level):
    """Smallest outcome whose cumulative probability reaches the level, with
    the cumulative probabilities at it and just below it."""
    cum = 0.0
    for x in sorted(dist):
        below = cum
        cum += dist[x]
        if cum >= level - 1e-12:
            return x, cum, below
    raise AssertionError('distribution does not reach %s' % level)


def continuous_quantile(cdf, level, lo, hi):
    for _ in range(200):
        mid = (lo + hi) / 2
        if cdf(mid) < level:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def cdf_independent_mixture(selected):
    """rho 0, any projects: enumerate success sets; given the set the value is
    normal (sum of success means, sum of success variances) or a point."""
    parts = []
    for mask in range(1 << len(selected)):
        prob, mean, var = 1.0, 0.0, 0.0
        for i, p in enumerate(selected):
            pos = float(pos_of(p))
            if mask >> i & 1:
                prob *= pos
                mean += float(npv_of(p))
                var += float(success_sd(p)) ** 2
            else:
                prob *= 1 - pos
                mean -= float(fail_cost_of(p))
        if prob > 0:
            parts.append((prob, mean, math.sqrt(var)))
    assert all(sd > 0 for _, _, sd in parts), 'continuous cases carry no atoms'
    return lambda x: sum(w * phi((x - m) / s) for w, m, s in parts)


def cdf_normal_pos1(selected, correlation):
    """pos 1 everywhere: z2 correlates at exactly rho, so the sum is normal with
    the moment variance."""
    for p in selected:
        assert pos_of(p) == 1
    _, mean, sd, _ = closed_form(selected, correlation)
    return lambda x: phi((x - float(mean)) / sd)


def method_cases():
    cases = []
    worst = {'z': 0.0}

    def check(label, mc, exact, se):
        z = abs(mc - exact) / se if se > 0 else (0.0 if mc == exact else math.inf)
        worst['z'] = max(worst['z'], z)
        if not z <= 4:
            raise AssertionError('%s: Monte Carlo %r vs exact %r is %.2f standard errors' % (label, mc, exact, z))
        return z

    def add(cid, desc, selected, correlation, kind, exact_dist=None, cdf=None):
        opts = {'seed': DEFAULT_SEED, 'iterations': DEFAULT_ITERATIONS}
        seed, n = run_options(opts)
        mc = risk(selected, correlation, opts)
        rec = {'id': cid, 'description': desc, 'selected': selected, 'correlation': correlation,
               'riskOptions': opts, 'kind': kind, 'mc': {k: mc[k] for k in ('probLoss', 'lossCount', 'p90', 'p10', 'seed', 'iterations')},
               'normalApprox': old_normal_approx(selected, correlation)}
        if exact_dist is not None:
            pl = sum(v for x, v in exact_dist.items() if x < 0)
            se = math.sqrt(pl * (1 - pl) / n)
            rec['exact'] = {'probLoss': pl, 'worstOutcome': min(exact_dist)}
            rec['probLossSE'] = se
            rec['probLossZ'] = check(cid + ' probLoss', mc['probLoss'], pl, se)
            for key, level in (('p90', 0.1), ('p10', 0.9)):
                x, at, below = discrete_quantile(exact_dist, level)
                clear = abs(at - level) > 0.01 and abs(below - level) > 0.01
                rec['exact'][key] = {'outcome': x, 'cumulativeAt': at, 'cumulativeBelow': below, 'checked': clear}
                if clear and mc[key] != x:
                    raise AssertionError('%s %s: Monte Carlo %r vs exact outcome %r' % (cid, key, mc[key], x))
        else:
            _, mean, sd, _ = closed_form(selected, correlation)
            lo, hi = float(mean) - 20 * sd, float(mean) + 20 * sd
            pl = cdf(0.0)
            se = math.sqrt(pl * (1 - pl) / n)
            rec['exact'] = {'probLoss': pl}
            rec['probLossSE'] = se
            rec['probLossZ'] = check(cid + ' probLoss', mc['probLoss'], pl, se)
            for key, level in (('p90', 0.1), ('p10', 0.9)):
                q = continuous_quantile(cdf, level, lo, hi)
                dh = 1e-4 * sd
                dens = (cdf(q + dh) - cdf(q - dh)) / (2 * dh)
                qse = math.sqrt(level * (1 - level) / n) / dens
                rec['exact'][key] = q
                rec['exact'][key + 'SE'] = qse
                rec['exact'][key + 'Z'] = check('%s %s' % (cid, key), mc[key], q, qse)
        cases.append(rec)

    wc = {'npv_p50': 300, 'pos': 0.3, 'fail_cost': 50}
    three = [wc, {'npv_p50': 400, 'pos': 0.25, 'fail_cost': 60}, {'npv_p50': 250, 'pos': 0.4, 'fail_cost': 45}]
    add('singleWildcat', 'One wildcat, pos 0.3, NPV 300, fail 50: exact P(loss) 0.7, P90 -50 (the worst outcome), P10 300.',
        [wc], 0, 'independent-binary', dist_independent([wc]))
    for n in (2, 3, 6, 8):
        add('identical%d' % n, '%d independent identical 0.3 / 300 / 50 wildcats, exact binomial enumeration.' % n,
            [dict(wc) for _ in range(n)], 0, 'independent-binary', dist_independent([wc] * n))
    add('threeMixed', 'Three independent risked projects 0.3 / 300 / 50, 0.25 / 400 / 60, 0.4 / 250 / 45; worst case -155.',
        three, 0, 'independent-binary', dist_independent(three))
    add('normalPairIndependent', 'Two pos 1 normal projects (100, 160 / 40 and 80, 130 / 30) at rho 0: a normal sum, P(loss) = Phi(-mean / sd).',
        [RISK_A, RISK_B], 0, 'pos1-normal', cdf=cdf_normal_pos1([RISK_A, RISK_B], 0))
    add('normalPairCorrelated', 'The same pair at rho 0.8: z2 correlates at exactly rho, so the sum is normal with the moment variance.',
        [RISK_A, RISK_B], 0.8, 'pos1-normal', cdf=cdf_normal_pos1([RISK_A, RISK_B], 0.8))
    wide = [{'npv_p50': 20, 'npv_stddev': 30, 'pos': 1}, {'npv_p50': 10, 'npv_stddev': 25, 'pos': 1}, {'npv_p50': 15, 'npv_stddev': 20}]
    add('normalThreeCorrelated', 'Three pos 1 normal projects with a real loss chance (means 20, 10, 15; spreads 30, 25, 20) at rho 0.5.',
        wide, 0.5, 'pos1-normal', cdf=cdf_normal_pos1(wide, 0.5))
    mix = [{'npv_p50': 100, 'npv_stddev': 20, 'pos': 0.5, 'fail_cost': 40}, {'npv_p50': 50, 'npv_stddev': 10}]
    add('mixtureWithSpread', 'Suite pair: pos 0.5 N(100, 20) or -40, beside a sure N(50, 10), rho 0; exact P(loss) = 0.5 Phi(-1) + 0.5 Phi(-150 / sqrt 500).',
        mix, 0, 'independent-mixture', cdf=cdf_independent_mixture(mix))
    add('comonotoneIdentical3', 'rho 1, three identical 0.3 / 300 / 50: they all succeed or all fail, P(loss) = 1 minus pos = 0.7.',
        [dict(wc) for _ in range(3)], 1, 'comonotone', dist_comonotone([wc] * 3))
    add('comonotoneMixed', 'rho 1, the three mixed projects: nested success sets by U = Phi(F1) against pos 0.25, 0.3, 0.4.',
        three, 1, 'comonotone', dist_comonotone(three))
    add('copulaIdentical3', 'rho 0.5, three identical 0.3 / 300 / 50: exact by conditioning on F1 and Simpson integration.',
        [dict(wc) for _ in range(3)], 0.5, 'copula-binary', dist_copula([wc] * 3, 0.5))
    add('copulaThreeMixed', 'rho 0.35, the three mixed projects, by conditioning on F1.',
        three, 0.35, 'copula-binary', dist_copula(three, 0.35))
    return cases, worst['z']


def main():
    method, worst_z = method_cases()
    golden = {
        'description': (
            'Economics capital portfolio goldens: risked EMV, success-case spread, exact success / '
            'failure mixture moments, the portfolio risk summary (closed-form mean and spread with an '
            'average pairwise correlation; P(loss), P90 and P10 from the EC5-0 seeded one-factor Gaussian '
            'copula Monte Carlo, replayed bit for bit in riskMetrics and optimize, so the gate compares '
            'probLoss exactly and P90 / P10 within 1e-9 scaled, at the riskOptions seed and iterations '
            'stated on each case), the riskMethod section validating that Monte Carlo against exact '
            'answers within 4 standard errors (normalApprox carries what the engine reported before), '
            'the optimizeRefusals section (a capex that is not a finite number of 0 or more, or a present pos that '
            'is blank, non-numeric or outside 0 to 1, is refused by project; EC5-0, EC5-6, EC5-7), the '
            'projectEmvRefusals and riskMetricsRefusals sections (the same pos rule), overLimit / overLimitBy on every '
            'optimal set, and the 0/1 knapsack over the capex limit with its efficient frontier. '
            'Independent stdlib oracle (tools/validation/economics/oracle_portfolio.py): the knapsack is '
            'solved by brute force over every subset, both EXACTLY (sum of capex within the limit) and on '
            'the engine\'s documented QUANTISED grid, and every optimize case carries both answers, the '
            'gap between them and whether quantisation changed the chosen set; every optimal set is '
            'listed so ties are explicit; the frontier is on the grid with every capex a tied set could '
            'report. All money is USD millions ($MM) except rawDollars, which is typed in dollars '
            'on purpose. pos is 0 to 1; correlation is 0 to 1; a correlation given as the string NaN '
            'means the gate passes NaN. Every case in the Suite\'s '
            'src/utils/__tests__/portfolioOptimizer.test.js is here, plus seeded random sets (mulberry32, '
            'seed on the case), ties, a zero-EMV and a negative-EMV project, free projects, and limits '
            'below every project.'
        ),
        'projectEmv': emv_cases(),
        'projectEmvRefusals': emv_refusal_cases(),
        'riskMetricsRefusals': risk_refusal_cases(),
        'successStdDev': sd_cases(),
        'projectMoments': moments_cases(),
        'riskMetrics': risk_cases(),
        'optimize': optimize_cases(),
        'optimizeRefusals': refusal_cases(),
        'riskMethod': method,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(out(golden), f, indent=1, sort_keys=True)
        f.write('\n')
    counts = {k: len(v) for k, v in golden.items() if isinstance(v, list)}
    print('wrote %s: %s (total %d)' % (OUT, counts, sum(counts.values())))
    for c in golden['optimize']:
        e = c['expected']
        print('  %-26s res %-10g cells %5d exact %-12g quant %-12g gap %-10g changed %s sets %d/%d' % (
            c['id'], e['resolution'], e['cells'], float(e['exact']['optimalEmv']),
            float(e['quantized']['optimalEmv']), float(e['quantizationGap']), e['setChanged'],
            len(e['exact']['optimalSets']), len(e['quantized']['optimalSets'])))
    print('riskMethod (seed %d, %d iterations): Monte Carlo against exact' % (DEFAULT_SEED, DEFAULT_ITERATIONS))
    for c in method:
        ex, mc, na = c['exact'], c['mc'], c['normalApprox']
        q90 = ex['p90']['outcome'] if isinstance(ex['p90'], dict) else ex['p90']
        q10 = ex['p10']['outcome'] if isinstance(ex['p10'], dict) else ex['p10']
        print('  %-22s P(loss) mc %.4f exact %.6f (%.2f se; old normal %.6f)  P90 mc %-10.4f exact %-10.4f (old %.2f)  P10 mc %-10.4f exact %.4f' % (
            c['id'], mc['probLoss'], ex['probLoss'], c['probLossZ'], na['probLoss'], mc['p90'], q90, na['p90'], mc['p10'], q10))
    print('largest Monte Carlo gap to an exact answer: %.3f standard errors (gate: 4)' % worst_z)
    print('(the replication gap, engine against this replica, is measured and printed by the jest gate)')


if __name__ == '__main__':
    main()
