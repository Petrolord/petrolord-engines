#!/usr/bin/env python3
"""Independent oracle for the FDP Accelerator engines
(engines/economics/fdp/*.js): the FDP screening case on the MID-YEAR
discounting convention, cost roll-ups, scenario economics, subsurface
volumetrics, well and facilities sizing, HSE and risk indices, the schedule
(critical path, duration, milestones) and the plan completeness and
validation checks. Emits test-data/economics/goldens/fdp_cases.json.

INDEPENDENCE DISCIPLINE. Written from the METHOD STATEMENTS the modules
document (and the screening engine's stated conventions), not by
transcribing the JavaScript. Where the two must agree they reach the number
by different roads:

  NPV            the FDP case is rebuilt here from its definition (year one
                 carries the capex and no production; producing years carry
                 kbpd x 1000 x 365 barrels at the year's price, a fixed opex
                 and a per-barrel variable opex; royalty on gross revenue,
                 tax on the positive part of net revenue less opex less the
                 in-year capex), then discounted MID-YEAR at t + 0.5 as the
                 screening engine documents (D1 convention). The oracle
                 never calls the engine and never calls the screening
                 engine it delegates to.

  IRR            the engine runs Newton from 10 percent with a clamp to
                 [-99 percent, 1000 percent]. The oracle brackets every sign
                 change of NPV(r) on a 20000-point grid over (-0.99, 10]
                 and bisects each to machine precision; when the root lies
                 beyond the engine's clamp the oracle solves in log space
                 out to 1e30 and reports the true root, and the golden pins
                 the engine's clamped number beside it as a DISAGREEMENT.
                 costCalculations.calculateIRR is a bisection on [0, 2^k]
                 with 100 halvings; the oracle solves the same root by
                 Brent's method from a fine scan, and reproduces the
                 documented cap (2^20 x 100 percent) where NPV never
                 crosses zero within it.

  payback        closed form from the definition: the first period whose
                 cumulative cash is non negative, entered at i plus the
                 shortfall carried in over that period's cash.

  CPM            the module's calculateCPM says "Critical Path Method" and
                 passes the caller's float through. The oracle computes a
                 REAL critical path from durations and dependencies TWICE:
                 a forward pass in Kahn topological order with an iterative
                 backward pass in reverse order, and a memoised recursive
                 longest-path forward pass with a recursive backward pass.
                 Both must agree before anything is emitted. The engine's
                 passthrough is ALSO computed here (it is what the engine
                 returns and the test must pin it) and every activity where
                 the passthrough and the real CPM disagree on criticality is
                 listed as a DISAGREEMENT.

  rounding       Math.round is floor(x + 0.5); Math.ceil is the ceiling;
                 both are written out here rather than borrowed from
                 Python's banker's rounding. JS truthiness on inputs
                 (parseFloat(x) || default, Number(x) || 0,
                 Number.isFinite(Number(x))) is modelled explicitly by the
                 js_* helpers because it decides which default a blank
                 field takes, and that is a number a user reads.

  dates          calculateConceptSchedule adds 24 or 36 months with the JS
                 setMonth rule (the day of month is kept and overflows into
                 the next month). The oracle adds the months on the
                 calendar and applies the overflow rule with date
                 arithmetic. Timezone assumption: UTC, as for every date
                 golden in this package.

UNITS. Money in $MM unless stated (drilling cost is USD; risk costImpact is
$MM). Rates in kbpd and $/bbl. Percent inputs are 0 to 100. OOIP in STB
from acres and feet. Days are whole days.

stdlib only. Regenerate:
    python3 tools/validation/economics/oracle_fdp.py
"""
import json
import math
import os
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'fdp_cases.json')

NAN = float('nan')

# ---------------------------------------------------------------------
# JS semantics helpers (written from the ECMAScript definitions).
# ---------------------------------------------------------------------


def js_round(x):
    """Math.round: the integer closest to x, ties toward +infinity."""
    if x != x or math.isinf(x):
        return x
    return float(math.floor(x + 0.5))


def js_ceil(x):
    if x != x or math.isinf(x):
        return x
    return float(math.ceil(x))


def js_parse_float(v):
    """parseFloat: numbers as they are; the longest numeric prefix of a
    string; NaN otherwise (booleans and None are NaN)."""
    if isinstance(v, bool):
        return NAN
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        best = None
        for n in range(len(s), 0, -1):
            head = s[:n]
            if head.lower() in ('infinity', '+infinity', '-infinity'):
                return float(head.lower().replace('infinity', 'inf'))
            try:
                if head.lower().endswith(('e', 'e+', 'e-', '.', '+', '-')) and n > 1:
                    continue
                if 'x' in head.lower() or '_' in head:
                    continue
                best = float(head)
                break
            except ValueError:
                continue
        return NAN if best is None else best
    return NAN


def js_number(v):
    """Number(): None is 0, blank string is 0, booleans 0/1, non numeric NaN."""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        if v.strip() == '':
            return 0.0
        try:
            return float(v.strip())
        except ValueError:
            return NAN
    return NAN


def truthy(x):
    """JS truthiness for the values these engines see."""
    if x is None or x is False:
        return False
    if isinstance(x, (int, float)):
        return not (x == 0 or x != x)
    if isinstance(x, str):
        return x != ''
    return True


def or_default(x, default):
    """`x || default`."""
    return x if truthy(x) else default


def pf_or(v, default):
    """`parseFloat(v) || default`."""
    x = js_parse_float(v)
    return x if truthy(x) else default


def num_or0(v):
    """`Number(v) || 0`."""
    x = js_number(v)
    return x if truthy(x) else 0.0


def finite_number_or(v, default):
    """`Number.isFinite(Number(v)) ? Number(v) : default`; undefined is a
    missing key."""
    if v == '__undefined__':
        return default
    x = js_number(v)
    return x if math.isfinite(x) else default


def clean(x):
    """NaN and infinities cannot be written to JSON; they become None and
    the case carries a note saying which."""
    if isinstance(x, float) and (x != x or math.isinf(x)):
        return None
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, list):
        return [clean(v) for v in x]
    return x


# ---------------------------------------------------------------------
# The FDP screening case, mid-year convention.
# ---------------------------------------------------------------------

DEFAULT_FISCAL = {'royaltyRate': 12.5, 'taxRate': 30.0, 'discountRate': 10.0, 'variableOpexPerBbl': 5.0}


def npv_at(flows, r):
    """Mid-year NPV of a list of period cash flows at rate r (fraction)."""
    return sum(f / (1.0 + r) ** (t + 0.5) for t, f in enumerate(flows))


def bracket_roots(f, lo, hi, n):
    """Every sign change of f on a grid of n points in [lo, hi], each then
    bisected to machine precision. Returns the roots in ascending order."""
    roots = []
    xs = [lo + (hi - lo) * k / n for k in range(n + 1)]
    prev_x, prev_f = xs[0], f(xs[0])
    for x in xs[1:]:
        fx = f(x)
        if prev_f == 0:
            roots.append(prev_x)
        elif (prev_f < 0) != (fx < 0) and fx == fx and prev_f == prev_f:
            a, b, fa = prev_x, x, prev_f
            for _ in range(200):
                m = 0.5 * (a + b)
                fm = f(m)
                if fm == 0:
                    a = b = m
                    break
                if (fm < 0) == (fa < 0):
                    a, fa = m, fm
                else:
                    b = m
                if b - a <= 1e-16 * max(1.0, abs(a)):
                    break
            roots.append(0.5 * (a + b))
        prev_x, prev_f = x, fx
    return roots


def irr_engine_convention(flows):
    """The screening engine's IRR field, EC6-1.

    Before: 0 when the cash flow never changes sign, otherwise wherever the
    clamped Newton search stopped, which on several of these cases was the
    1000 percent clamp itself. Now: a rate is reported only when it is a
    single root inside the band the engine searches (-99 to 1000 percent),
    and `status` says which of the other things happened.

    Returns irr (percent, None when there is none to report), status, exists
    (a sign change is present), roots (every root in the band, percent),
    beyondClamp (the only root is above the clamp) and noRoot (the NPV never
    crosses zero anywhere the engine can look)."""
    has_neg = any(f < 0 for f in flows)
    has_pos = any(f > 0 for f in flows)
    out = {'irr': None, 'status': 'no-sign-change', 'exists': False, 'roots': None,
           'beyondClamp': False, 'noRoot': False}
    if not (has_neg and has_pos):
        return out
    out['exists'] = True
    f = lambda r: npv_at(flows, r)
    roots = bracket_roots(f, -0.99, 10.0, 20000)
    if len(roots) == 1:
        out.update({'irr': roots[0] * 100.0, 'status': 'ok', 'roots': [roots[0] * 100.0]})
        return out
    if len(roots) > 1:
        # A flow that changes sign more than once has more than one rate
        # that zeroes it, and none of them is "the" return.
        out.update({'irr': None, 'status': 'multiple-roots', 'roots': [r * 100.0 for r in roots]})
        return out
    # No root inside the clamp: solve in log(1 + r) out to 1e12 (a rate of
    # 1e14 percent; the mid-year power stays finite there for 25 periods).
    g = lambda u: f(math.exp(u) - 1.0)
    ulo, uhi = math.log(11.0), math.log(1e12)
    if (g(ulo) < 0) == (g(uhi) < 0):
        out.update({'irr': None, 'status': 'no-root', 'noRoot': True})
        return out
    for _ in range(400):
        um = 0.5 * (ulo + uhi)
        if (g(um) < 0) == (g(ulo) < 0):
            ulo = um
        else:
            uhi = um
    true_root = (math.exp(0.5 * (ulo + uhi)) - 1.0) * 100.0
    out.update({'irr': None, 'status': 'above-clamp', 'roots': [true_root], 'beyondClamp': True})
    return out


def brent(f, a, b, fa, fb, tol=1e-15, maxit=300):
    """Brent's method on a bracket [a, b] with f(a) f(b) < 0."""
    if abs(fa) < abs(fb):
        a, b, fa, fb = b, a, fb, fa
    c, fc, mflag, d = a, fa, True, 0.0
    for _ in range(maxit):
        if fb == 0 or abs(b - a) < tol * max(1.0, abs(b)):
            return b
        if fa != fc and fb != fc:
            s = (a * fb * fc / ((fa - fb) * (fa - fc)) + b * fa * fc / ((fb - fa) * (fb - fc))
                 + c * fa * fb / ((fc - fa) * (fc - fb)))
        else:
            s = b - fb * (b - a) / (fb - fa)
        cond = ((s - (3 * a + b) / 4) * (s - b) >= 0 or (mflag and abs(s - b) >= abs(b - c) / 2)
                or (not mflag and abs(s - b) >= abs(c - d) / 2)
                or (mflag and abs(b - c) < tol) or (not mflag and abs(c - d) < tol))
        if cond:
            s = 0.5 * (a + b)
            mflag = True
        else:
            mflag = False
        fs = f(s)
        d, c, fc = c, b, fb
        if (fa < 0) != (fs < 0):
            b, fb = s, fs
        else:
            a, fa = s, fs
        if abs(fa) < abs(fb):
            a, b, fa, fb = b, a, fb, fa
    return b


def cost_calculations_irr(net_flows):
    """costCalculations.calculateIRR as its docstring defines it: null when
    the flows never change sign or NPV(0) is not positive; otherwise the
    rate at which the mid-year NPV is zero, searched upward by doubling from
    100 percent and capped at 2^20 (100 percent x 2^20) when it never
    crosses. Percent."""
    if not any(f < 0 for f in net_flows) or not any(f > 0 for f in net_flows):
        return None
    f = lambda r: npv_at(net_flows, r)
    if f(0.0) <= 0:
        return None
    hi = 1.0
    k = 0
    while k < 20 and f(hi) > 0:
        hi *= 2.0
        k += 1
    if f(hi) > 0:
        return hi * 100.0
    # Brent on [0, hi]; scan first so a multi-root bracket picks the same
    # sign change bisection would (the first from the left).
    roots = bracket_roots(f, 0.0, hi, 4000)
    if roots:
        return roots[0] * 100.0
    return brent(f, 0.0, hi, f(0.0), f(hi)) * 100.0


def payback_from_cumulative(ncfs, cums, never):
    """First period with cumulative >= 0, entered part way: i + |cum[i-1]| /
    ncf[i] when that period's cash is positive, else i. `never` is the value
    when it never happens."""
    for i, c in enumerate(cums):
        if c >= 0:
            if i == 0:
                return 0.0
            prev = cums[i - 1]
            curr = ncfs[i]
            return i + abs(prev) / curr if curr > 0 else float(i)
    return never


def fdp_case(capexMM, annualOpexMM, productionKbpd, pricesUsd, fiscal=None):
    """runFdpCase: the full engine result rebuilt from its definition."""
    terms = dict(DEFAULT_FISCAL)
    terms.update(fiscal or {})
    d = terms['discountRate'] / 100.0
    n = len(productionKbpd)
    life = n + 1
    rows = []
    cum = 0.0
    tot = {'totalRevenue': 0.0, 'totalCapex': 0.0, 'totalOpex': 0.0, 'totalTax': 0.0,
           'totalRoyalty': 0.0, 'totalGovTake': 0.0}
    for i in range(life):
        if i == 0:
            kbpd, price, fixed, capex = 0.0, 0.0, 0.0, float(capexMM)
        else:
            kbpd = num_or0(productionKbpd[i - 1])
            price = num_or0(pricesUsd[i - 1]) if i - 1 < len(pricesUsd) else 0.0
            fixed = float(annualOpexMM)
            capex = 0.0
        annual_bbl = kbpd * 1000.0 * 365.0
        var = (annual_bbl * terms['variableOpexPerBbl']) / 1e6 if i > 0 else 0.0
        revenue = (annual_bbl * price) / 1e6
        royalty = revenue * (terms['royaltyRate'] / 100.0)
        net = revenue - royalty
        opex = fixed + var
        depreciation = capex  # one-year straight line = in-year expensing
        taxable = net - opex - depreciation
        tax = taxable * (terms['taxRate'] / 100.0) if taxable > 0 else 0.0
        ncf = net - (capex + opex) - tax
        cum += ncf
        tot['totalRevenue'] += revenue
        tot['totalCapex'] += capex
        tot['totalOpex'] += opex
        tot['totalTax'] += tax
        tot['totalRoyalty'] += royalty
        tot['totalGovTake'] += royalty + tax
        rows.append({'year': i, 'grossRevenue': revenue, 'royalty': royalty, 'capex': capex,
                     'opex': opex, 'abex': 0.0, 'tax': tax, 'depreciation': depreciation,
                     'pscUnrecoveredCost': 0.0, 'ncf': ncf, 'cumulativeNCF': cum,
                     'govTake': royalty + tax})
    flows = [r['ncf'] for r in rows]
    npv = npv_at(flows, d)
    ir = irr_engine_convention(flows)
    irr, exists, roots, clamped, no_root = ir['irr'], ir['exists'], ir['roots'], ir['beyondClamp'], ir['noRoot']
    irr_status = ir['status']
    cums = [r['cumulativeNCF'] for r in rows]
    payback = payback_from_cumulative(flows, cums, float(life))
    pays_back = any(c >= 0 for c in cums)
    metrics = {'npv': npv, 'irr': irr, 'irrStatus': irr_status, 'payback': payback, 'maxExposure': min(cums)}
    metrics.update(tot)
    # costCalculations view of the same case. EC6-1: calculateCashFlows used
    # to pad a short price deck with 70 $/bbl (`?? 70`) where runFdpCase
    # reads a missing price as 0, so the same profile gave two different
    # NPVs depending on the door you came in by. A deck that does not cover
    # the profile is refused now, and `priceDeckRefused` records it.
    deck_complete = all(i < len(pricesUsd) and pricesUsd[i] is not None for i in range(n))
    cc_src, cc_flows, cc_cums = rows, flows, cums
    rate = d
    cc_rows = [{'year': i, 'revenue': r['grossRevenue'], 'royalty': r['royalty'], 'tax': r['tax'],
                'capex': r['capex'], 'opex': r['opex'], 'netCashFlow': r['ncf'],
                'cumulativeCashFlow': r['cumulativeNCF'],
                'discountedCashFlow': r['ncf'] / (1.0 + rate) ** (i + 0.5)}
               for i, r in enumerate(cc_src)]
    cc = {'rows': cc_rows if deck_complete else None,
          'npv': sum(x['discountedCashFlow'] for x in cc_rows) if deck_complete else None,
          'irr': cost_calculations_irr(cc_flows) if deck_complete else None,
          'paybackPeriod': payback_from_cumulative(cc_flows, cc_cums, None) if deck_complete else None,
          'priceDeckRefused': not deck_complete}
    return {'cashflow': rows, 'metrics': metrics, 'paybackYears': payback if pays_back else None,
            'irrExists': exists, 'irrRootsPercent': roots, 'irrBeyondEngineClamp': clamped,
            'irrNoRoot': no_root, 'costCalculations': cc}


# ---------------------------------------------------------------------
# Scenario economics.
# ---------------------------------------------------------------------

PLATEAU_YEARS, DECLINE, PROFILE_YEARS = 3, 0.9, 20


def concept_profile(concept):
    peak = require_number((concept or {}).get('peakProduction'), 'the concept peak production rate', True)
    return [peak if y <= PLATEAU_YEARS else peak * DECLINE ** (y - PLATEAU_YEARS)
            for y in range(1, PROFILE_YEARS + 1)]


class Refused(Exception):
    """What the engine's FdpInputError stands for in the oracle."""

    def __init__(self, message):
        super().__init__(message)
        self.message = message


def is_blank(v):
    return v is None or (isinstance(v, str) and v.strip() == '')


def require_number(v, field, non_negative=False):
    """EC6-0: a figure that is absent or unreadable is refused by name. A
    zero someone typed is a value."""
    if is_blank(v):
        raise Refused('%s is missing' % field)
    try:
        n = float(v) if not isinstance(v, bool) else float('nan')
    except (TypeError, ValueError):
        raise Refused('%s is not a number: %s' % (field, v))
    if n != n or n in (float('inf'), float('-inf')):
        raise Refused('%s is not a number: %s' % (field, v))
    if non_negative and n < 0:
        raise Refused('%s may not be negative: %s' % (field, js_number_text(n)))
    return n


def js_number_text(n):
    return ('%d' % n) if float(n).is_integer() else repr(n)


CAPEX_PARTS = [('drillingCapex', 'the drilling capex'),
               ('facilitiesCapex', 'the facilities capex'),
               ('subseaCapex', 'the subsea capex')]


def concept_capex(concept):
    """EC6-0: the concept form collects drilling, facilities and subsea
    capex. The engine used to read `concept.capex`, a field no form has
    ever written, and priced every scenario at the 100 fallback."""
    concept = concept or {}
    if not is_blank(concept.get('capex')):
        return require_number(concept.get('capex'), 'the concept capex', True)
    given = [(k, label) for k, label in CAPEX_PARTS if not is_blank(concept.get(k))]
    if not given:
        raise Refused('the concept carries no capex: enter a drilling, facilities or subsea capex')
    return sum(require_number(concept.get(k), label, True) for k, label in given)


def run_scenario(scenario, concept):
    scenario = scenario or {}
    concept = concept or {}
    given = concept.get('productionProfileKbpd')
    prod = list(given) if given else concept_profile(concept)
    price = require_number(scenario.get('oilPrice'), 'the scenario oil price', True)
    capex = concept_capex(concept)
    opex = require_number(concept.get('opex'), 'the concept annual operating cost', True)
    fiscal = {
        'discountRate': DEFAULT_FISCAL['discountRate'] if is_blank(scenario.get('discountRate')) else require_number(scenario.get('discountRate'), 'the scenario discount rate'),
        'royaltyRate': DEFAULT_FISCAL['royaltyRate'] if is_blank(scenario.get('royaltyRate')) else require_number(scenario.get('royaltyRate'), 'the scenario royalty rate'),
        'taxRate': DEFAULT_FISCAL['taxRate'] if is_blank(scenario.get('taxRate')) else require_number(scenario.get('taxRate'), 'the scenario tax rate'),
    }
    res = fdp_case(capex, opex, prod, [price] * len(prod), fiscal)
    return {'productionKbpd': prod, 'resolved': {'capexMM': capex,
                                                 'annualOpexMM': opex,
                                                 'oilPrice': price, **fiscal},
            'npv': res['metrics']['npv'], 'irr': res['metrics']['irr'],
            'payback': res['paybackYears'], 'totalTax': res['metrics']['totalTax'],
            'irrExists': res['irrExists'], 'irrRootsPercent': res['irrRootsPercent'],
            'irrBeyondEngineClamp': res['irrBeyondEngineClamp'], 'irrNoRoot': res['irrNoRoot']}


def screening_npv(oil_bbl, price, opex_fixed, opex_var, capex, terms):
    """NPV of one prebuilt screening case, $MM. The same per-year definition
    fdp_case uses, but over arrays, because the sensitivity sweep scales the
    arrays rather than the case arguments: scaling production there does NOT
    scale the variable operating cost that production implies."""
    d = terms['discountRate'] / 100.0
    npv = 0.0
    for i in range(len(oil_bbl)):
        revenue = (oil_bbl[i] * price[i]) / 1e6
        royalty = revenue * (terms['royaltyRate'] / 100.0)
        net = revenue - royalty
        opex = opex_fixed[i] + opex_var[i]
        taxable = net - opex - capex[i]
        tax = taxable * (terms['taxRate'] / 100.0) if taxable > 0 else 0.0
        ncf = net - (capex[i] + opex) - tax
        npv += ncf / (1.0 + d) ** (i + 0.5)
    return npv


def fdp_sensitivity(capexMM, annualOpexMM, productionKbpd, pricesUsd, fiscal=None):
    """runFdpSensitivity: NPV at minus and plus 30 percent on each of oil
    price, capex, opex and production, against the base case."""
    terms = dict(DEFAULT_FISCAL)
    terms.update(fiscal or {})
    n = len(productionKbpd)
    life = n + 1
    oil = [0.0] * life
    price = [0.0] * life
    opex_fixed = [0.0] * life
    opex_var = [0.0] * life
    capex = [0.0] * life
    capex[0] = float(capexMM)
    for i in range(n):
        annual_bbl = num_or0(productionKbpd[i]) * 1000.0 * 365.0
        oil[i + 1] = annual_bbl
        price[i + 1] = num_or0(pricesUsd[i]) if i < len(pricesUsd) else 0.0
        opex_fixed[i + 1] = float(annualOpexMM)
        opex_var[i + 1] = (annual_bbl * terms['variableOpexPerBbl']) / 1e6
    base = screening_npv(oil, price, opex_fixed, opex_var, capex, terms)

    def scaled(which, k):
        # EC6-1: production carries the variable operating cost it implies.
        return screening_npv(
            [v * k for v in oil] if which == 'Production' else oil,
            [v * k for v in price] if which == 'Oil Price' else price,
            [v * k for v in opex_fixed] if which == 'OPEX' else opex_fixed,
            [v * k for v in opex_var] if which == 'Production' else opex_var,
            [v * k for v in capex] if which == 'CAPEX' else capex,
            terms)

    return [{'name': name, 'lowParamNPV': scaled(name, 0.7), 'highParamNPV': scaled(name, 1.3),
             'baseNPV': base} for name in ['Oil Price', 'CAPEX', 'OPEX', 'Production']]


# ---------------------------------------------------------------------
# Concepts.
# ---------------------------------------------------------------------


def concept_cost(c):
    total_capex = pf_or(c.get('drillingCapex'), 0.0) + pf_or(c.get('facilitiesCapex'), 0.0) + pf_or(c.get('subseaCapex'), 0.0)
    annual = pf_or(c.get('opex'), 0.0)
    life = pf_or(c.get('lifeOfField'), 20.0)
    total_opex = annual * life
    return {'totalCapex': total_capex, 'totalOpex': total_opex, 'totalLifecycleCost': total_capex + total_opex}


def add_months_js(d, months):
    """Date.setMonth semantics: keep the day of month, overflow forward."""
    total = d.month - 1 + months
    y = d.year + total // 12
    m = total % 12 + 1
    return date(y, m, 1) + timedelta(days=d.day - 1)


def concept_schedule(c, today=None):
    """EC6-0: the date arithmetic runs on the local calendar and a concept
    with no start date is refused rather than dated from the clock."""
    s = c.get('startDate')
    try:
        start = date.fromisoformat(s)
    except (TypeError, ValueError):
        start = None
    if start is None and today is not None:
        try:
            start = date.fromisoformat(today)
        except (TypeError, ValueError):
            start = None
    if start is None:
        return {'throws': 'FdpInputError',
                'message': 'the concept has no start date: enter one, or pass today to date the schedule from'}
    offset = 36 if c.get('facilityType') == 'FPSO' else 24
    first_oil = add_months_js(start, offset)
    return {'fidDate': start.isoformat(), 'firstOilDate': first_oil.isoformat(), 'durationMonths': offset}


RF_MULT = {'Water Injection': 1.15, 'Gas Injection': 1.10, 'Natural Depletion': 0.85, 'ESP': 1.05}


def reserves_impact(c, sub):
    base = ((sub or {}).get('reserves') or {}).get('p50') or 0
    base = base if truthy(base) else 0.0
    mult = RF_MULT.get(c.get('driveMechanism'), 1.0)
    return {'recoverableReserves': base * mult, 'rfMultiplier': mult}


# ---------------------------------------------------------------------
# Subsurface.
# ---------------------------------------------------------------------


def ooip(area, h, phi, sw, bo=1.2):
    if not truthy(bo):
        return 0.0
    return 7758.0 * area * h * phi * (1.0 - sw) / bo


def recovery_factor(o, rec):
    return 0.0 if not truthy(o) else rec / o


def gradient(v1, d1, v2, d2):
    return 0.0 if d2 == d1 else (v2 - v1) / (d2 - d1)


RESERVES_UNITS = {'Oil': 'MMbbl', 'Gas': 'Bcf', 'Condensate': 'MMbbl'}

PERCENTILE_NOTE = ('Each column is the arithmetic sum of that column within one fluid. '
                   'A sum of P90s is not the P90 of the sum: add low cases only if every '
                   'reservoir disappoints together. Aggregate the distributions to get a '
                   'portfolio P90.')


def aggregate_reserves(rs):
    """EC6-0: totals per fluid, in that fluid's own unit. The engine used to
    add oil in MMbbl to gas in Bcf and call the sum MMbbl of oil."""
    by_fluid = {}
    for i, r in enumerate(rs or []):
        fluid = (r or {}).get('fluid')
        if fluid not in RESERVES_UNITS:
            name = (r or {}).get('name') or 'row %d' % (i + 1)
            raise Refused('%s: fluid type is missing or unknown (%s); expected one of %s'
                          % (name, 'undefined' if fluid is None else fluid, ', '.join(RESERVES_UNITS)))
        t = by_fluid.setdefault(fluid, {'fluid': fluid, 'units': RESERVES_UNITS[fluid], 'count': 0,
                                        'p90Sum': 0.0, 'p50Sum': 0.0, 'p10Sum': 0.0, 'recoverableSum': 0.0})
        t['count'] += 1
        t['p90Sum'] += pf_or(r.get('p90'), 0.0)
        t['p50Sum'] += pf_or(r.get('p50'), 0.0)
        t['p10Sum'] += pf_or(r.get('p10'), 0.0)
        t['recoverableSum'] += pf_or(r.get('recoverable'), 0.0)
    fluids = [f for f in RESERVES_UNITS if f in by_fluid]
    return {'byFluid': by_fluid, 'fluids': fluids,
            'percentileNote': PERCENTILE_NOTE if fluids else 'No reservoirs entered.'}


def reserves_p50(agg, fluid='Oil'):
    return (agg.get('byFluid', {}).get(fluid) or {}).get('p50Sum', 0.0) or 0.0


def plan_reserves_p50(state, fluid='Oil'):
    """EC6-0: the plan's P50 comes from the reserves TABLE (reserves.breakdown),
    falling back to the summary an example carries. The engine used to read
    reserves.p50, which nothing has ever written."""
    reserves = _get(state, 'subsurface', 'reserves') or {}
    rows = reserves.get('breakdown')
    if isinstance(rows, list) and rows:
        try:
            return reserves_p50(aggregate_reserves(rows), fluid)
        except Refused:
            return 0.0
    summary = reserves.get('summary') or {}
    return pf_or(summary.get('p50'), 0.0) or pf_or(reserves.get('p50'), 0.0) or 0.0


# ---------------------------------------------------------------------
# Wells.
# ---------------------------------------------------------------------


def drilling_time(md, well_type, complexity='Medium'):
    rop = {'High': 250.0, 'Low': 600.0}.get(complexity, 400.0)
    if well_type == 'Horizontal':
        rop *= 0.7
    if well_type == 'Deviated':
        rop *= 0.85
    return js_ceil(js_number(md) / rop + 10.0)


def drilling_cost(days, rig_rate, services=0.0):
    est = services if services > 0 else days * rig_rate * 1.5
    return days * rig_rate + est


def well_count(reserves, eur):
    return 0.0 if not truthy(eur) else js_ceil(reserves / eur)


def wells_by_type(wells):
    out = {}
    for w in wells:
        t = or_default(w.get('type'), 'Other')
        out[t] = out.get(t, 0) + 1
    return out


def total_drilling_cost(wells):
    return sum(pf_or(w.get('cost'), 0.0) for w in wells)


# ---------------------------------------------------------------------
# Facilities.
# ---------------------------------------------------------------------


def facility_capacity(f):
    base = pf_or(f.get('nameplateCapacity'), 100000.0)
    return {'oilCapacity': base, 'gasCapacity': base * 1.5, 'waterHandling': base * 0.8,
            'effectiveCapacity': base * 0.85}


FAC_BASE = {'FPSO': (1200.0, 50.0), 'Platform': (800.0, 30.0), 'Subsea Tie-back': (300.0, 15.0)}


def facility_cost(f):
    capex, opex = FAC_BASE.get(f.get('type'), (500.0, 25.0))
    size = pf_or(f.get('nameplateCapacity'), 50000.0) / 50000.0
    # EC6-1: capex scales by the 0.7 power of size and opex by the 0.6, and
    # decommissioning is 15 percent of the capex the facility actually
    # carries. It used to be 15 percent of the UNSCALED base, so a 150,000
    # bbl/d FPSO decommissioned for the same 180 $MM as a 50,000 one.
    sized_capex = capex * size ** 0.7
    return {'capex': sized_capex, 'opex': opex * size ** 0.6, 'decommissioning': sized_capex * 0.15}


def flow_assurance(f, fluid):
    score, risks = 0, []
    if f.get('type') == 'Subsea Tie-back':
        score += 3
        risks.append({'type': 'Hydrates', 'severity': 'High', 'mitigation': 'MEG Injection'})
        risks.append({'type': 'Wax', 'severity': 'Medium', 'mitigation': 'Insulation'})
    api = None if fluid is None else fluid.get('api', '__undefined__')
    # `api < 25` in JS: undefined is false, null is 0 (true), a numeric string converts.
    if api is not None and api != '__undefined__':
        a = js_number(api)
        if a == a and a < 25:
            score += 2
            risks.append({'type': 'Viscosity', 'severity': 'Medium', 'mitigation': 'Heating'})
    elif api is None and fluid is not None:
        score += 2
        risks.append({'type': 'Viscosity', 'severity': 'Medium', 'mitigation': 'Heating'})
    h2s = 0.0 if fluid is None else or_default(fluid.get('h2s'), 0.0)
    if js_number(h2s) > 0:
        score += 4
        risks.append({'type': 'Corrosion', 'severity': 'High', 'mitigation': 'CRA Materials'})
    level = 'High' if score > 5 else 'Medium' if score > 2 else 'Low'
    return {'score': score, 'level': level, 'risks': risks}


def bottlenecks(f, peak):
    cap = facility_capacity(f)
    out = []
    def gt(a, b):
        return a is not None and js_number(a) > b
    if gt(peak.get('oil'), cap['oilCapacity']):
        out.append('Oil Separation Capacity Exceeded')
    if gt(peak.get('gas'), cap['gasCapacity']):
        out.append('Gas Compression Limits')
    if gt(peak.get('water'), cap['waterHandling']):
        out.append('Produced Water Treatment Constraint')
    return out


# ---------------------------------------------------------------------
# HSE.
# ---------------------------------------------------------------------


def scored(r):
    """EC6-1: the score of one risk, or None when a factor is missing.

    Before, a missing factor was read as a zero here and as NaN in the risk
    module, and NaN failed every band comparison, so an unscored risk was
    counted as Low on both sides and the portfolio health went UP the less
    of the register had been filled in."""
    p = parse_float_or_none(r.get('probability'))
    i = parse_float_or_none(r.get('impact'))
    if p is None or i is None:
        return None
    return p * i


def parse_float_or_none(v):
    if v is None or (isinstance(v, str) and v.strip() == ''):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float('inf'), float('-inf')):
        return None
    return f


def hse_score(r):
    return scored(r) or 0.0


def risk_matrix(risks):
    """EC6-1: banded on the register's scale (20 / 12 / 6), the one scale in
    the module. This used to band on 15 and 8, so a score of 12 read High on
    the register and Medium here."""
    m = {'low': 0, 'medium': 0, 'high': 0, 'critical': 0, 'unscored': 0, 'total': len(risks)}
    for r in risks:
        s = scored(r)
        if s is None:
            m['unscored'] += 1
            continue
        m[risk_level(s).lower()] += 1
    return m


def total_risk_score(risks):
    return float(sum(scored(r) or 0.0 for r in risks))


def by_key(risks, key, default):
    out = {}
    for r in risks:
        k = or_default(r.get(key), default)
        out[k] = out.get(k, 0) + 1
    return out


def compliance_score(checklist):
    if not checklist:
        return 0.0
    done = sum(1 for c in checklist if c.get('status') == 'Compliant')
    return js_round(done / len(checklist) * 100.0)


# ---------------------------------------------------------------------
# Risk management.
# ---------------------------------------------------------------------


def risk_score_strict(r):
    """probability * impact with JS coercion: a missing factor is NaN."""
    p, i = r.get('probability', '__undefined__'), r.get('impact', '__undefined__')
    pv = NAN if p == '__undefined__' else js_number(p)
    iv = NAN if i == '__undefined__' else js_number(i)
    return pv * iv


def risk_level(score):
    if score >= 20:
        return 'Critical'
    if score >= 12:
        return 'High'
    if score >= 6:
        return 'Medium'
    return 'Low'


PROB_FACTORS = {1: 0.05, 2: 0.20, 3: 0.40, 4: 0.60, 5: 0.85}


def consolidated_score(risks):
    """EC6-1: the sum of the SCORED risks. It used to multiply without
    coercion, so one risk missing a factor made the whole register NaN."""
    if not risks:
        return 0.0
    return sum(scored(r) or 0.0 for r in risks)


def unscored_count(risks):
    return sum(1 for r in risks if scored(r) is None)


def risk_exposure(risks):
    total = 0.0
    for r in risks:
        p = r.get('probability')
        key = None
        if isinstance(p, (int, float)) and not isinstance(p, bool) and float(p).is_integer():
            key = int(p)
        elif isinstance(p, str) and p.strip().isdigit() and p == p.strip() and str(int(p)) == p:
            key = int(p)
        prob = PROB_FACTORS.get(key, 0.0)
        cost = pf_or(r.get('costImpact'), 0.0)
        total += prob * cost
    return total


def by_level(risks):
    levels = {'Critical': 0, 'High': 0, 'Medium': 0, 'Low': 0, 'Unscored': 0}
    for r in risks:
        s = scored(r)
        if s is None:
            levels['Unscored'] += 1
            continue
        levels[risk_level(s)] += 1
    return levels


def portfolio_health(risks):
    """EC6-1: over the scored risks only. An unscored risk used to count as
    Low, which improved the score."""
    lv = by_level(risks)
    total = len(risks) - lv['Unscored']
    if total <= 0:
        return 100.0
    penalty = lv['Critical'] * 10 + lv['High'] * 5 + lv['Medium'] * 2
    return js_round(max(0.0, 100.0 - (penalty / total) * 10.0))


# ---------------------------------------------------------------------
# Schedule: duration, CPM (two passes), milestones.
# ---------------------------------------------------------------------


def js_date_ms(s):
    """new Date('YYYY-MM-DD').getTime(): UTC midnight; NaN when absent or
    unparsable (only the date-only form is used by these cases)."""
    if not isinstance(s, str):
        return NAN
    try:
        d = date.fromisoformat(s)
    except ValueError:
        return NAN
    return (d - date(1970, 1, 1)).days * 86400000.0


def project_duration(acts):
    """EC6-0: whole CALENDAR days from the earliest start to the latest end,
    and None (not NaN) when any activity has no readable start or end. The
    old engine subtracted timestamps, so a span across a daylight-saving
    change counted one day fewer west of Greenwich than it did in UTC."""
    if not acts:
        return 0.0
    ends = [js_date_ms(a.get('endDate')) for a in acts]
    starts = [js_date_ms(a.get('startDate')) for a in acts]
    if any(x != x for x in ends + starts):
        return None
    return (max(ends) - min(starts)) / 86400000.0


def cpm_passthrough(acts):
    """What calculateCPM returns: the caller's float, or 0; critical when
    the float is exactly 0 or absent."""
    out = []
    for a in acts:
        fl = a.get('float', '__undefined__')
        is_critical = (fl == '__undefined__') or (isinstance(fl, (int, float)) and not isinstance(fl, bool) and fl == 0)
        # `a.float || 0`: a truthy value passes through UNCHANGED, so a
        # string '0' stays a string (it is truthy in JS) and is not critical.
        out.append({'id': a['id'], 'isCritical': bool(is_critical),
                    'float': 0.0 if fl == '__undefined__' or not truthy(fl) else (float(fl) if isinstance(fl, (int, float)) else fl)})
    return out


def cpm_kahn(acts):
    """Pass A: forward by Kahn topological order, backward iteratively in
    reverse of that order."""
    ids = [a['id'] for a in acts]
    dur = {a['id']: float(a.get('duration') or 0) for a in acts}
    preds = {a['id']: list(a.get('dependencies') or []) for a in acts}
    succs = {i: [] for i in ids}
    for i in ids:
        for p in preds[i]:
            succs[p].append(i)
    indeg = {i: len(preds[i]) for i in ids}
    order = [i for i in ids if indeg[i] == 0]
    k = 0
    while k < len(order):
        for s in succs[order[k]]:
            indeg[s] -= 1
            if indeg[s] == 0:
                order.append(s)
        k += 1
    if len(order) != len(ids):
        raise ValueError('cycle in schedule')
    es, ef = {}, {}
    for i in order:
        es[i] = max([ef[p] for p in preds[i]], default=0.0)
        ef[i] = es[i] + dur[i]
    end = max(ef.values())
    lf, ls = {}, {}
    for i in reversed(order):
        lf[i] = min([ls[s] for s in succs[i]], default=end)
        ls[i] = lf[i] - dur[i]
    return {i: {'es': es[i], 'ef': ef[i], 'ls': ls[i], 'lf': lf[i], 'float': ls[i] - es[i]} for i in ids}, end


def cpm_recursive(acts):
    """Pass B: memoised recursive longest path for the early dates and a
    memoised recursive walk over successors for the late dates."""
    import sys
    sys.setrecursionlimit(10000)
    ids = [a['id'] for a in acts]
    dur = {a['id']: float(a.get('duration') or 0) for a in acts}
    preds = {a['id']: list(a.get('dependencies') or []) for a in acts}
    succs = {i: [] for i in ids}
    for i in ids:
        for p in preds[i]:
            succs[p].append(i)
    memo_es, memo_lf = {}, {}

    def es(i):
        if i not in memo_es:
            memo_es[i] = max([es(p) + dur[p] for p in preds[i]], default=0.0)
        return memo_es[i]

    end = max(es(i) + dur[i] for i in ids)

    def lf(i):
        if i not in memo_lf:
            memo_lf[i] = min([lf(s) - dur[s] for s in succs[i]], default=end)
        return memo_lf[i]

    return {i: {'es': es(i), 'ef': es(i) + dur[i], 'ls': lf(i) - dur[i], 'lf': lf(i),
                'float': lf(i) - dur[i] - es(i)} for i in ids}, end


def critical_paths(acts, table):
    """Every start-to-finish chain of zero-float activities, in id order."""
    ids = [a['id'] for a in acts]
    preds = {a['id']: list(a.get('dependencies') or []) for a in acts}
    succs = {i: [] for i in ids}
    for i in ids:
        for p in preds[i]:
            succs[p].append(i)
    crit = [i for i in ids if abs(table[i]['float']) < 1e-9]
    paths = []

    def walk(i, path):
        nxt = [s for s in succs[i] if s in crit and abs(table[s]['es'] - table[i]['ef']) < 1e-9]
        if not nxt:
            paths.append(path)
            return
        for s in nxt:
            walk(s, path + [s])

    for i in crit:
        if not any(p in crit and abs(table[p]['ef'] - table[i]['es']) < 1e-9 for p in preds[i]):
            walk(i, [i])
    return crit, paths


def cpm_reference(acts):
    a, end_a = cpm_kahn(acts)
    b, end_b = cpm_recursive(acts)
    assert end_a == end_b, 'the two CPM passes disagree on the project end'
    for i in a:
        for k in a[i]:
            assert abs(a[i][k] - b[i][k]) < 1e-9, 'the two CPM passes disagree on %s.%s' % (i, k)
    crit, paths = critical_paths(acts, a)
    return {'projectDurationDays': end_a, 'activities': [{'id': i, **a[i], 'isCritical': i in crit} for i in a],
            'criticalActivities': crit, 'criticalPaths': paths, 'passesAgree': True}


def milestones(acts):
    out = []
    for a in acts:
        d = a.get('duration', '__undefined__')
        zero = isinstance(d, (int, float)) and not isinstance(d, bool) and d == 0
        if a.get('type') == 'Milestone' or zero:
            out.append(a['id'])
    return out


# ---------------------------------------------------------------------
# Plan completeness and validation, cost roll-ups.
# ---------------------------------------------------------------------


def _get(state, *path):
    cur = state
    for p in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def _len(x):
    return len(x) if isinstance(x, list) else 0


def completeness(state):
    npv = _get(state, 'economics', 'npv')
    npv = npv if truthy(npv) else 0
    checks = [
        ('Field Data', truthy(_get(state, 'fieldData', 'fieldName')) and truthy(_get(state, 'fieldData', 'country'))),
        ('Subsurface', plan_reserves_p50(state) > 0 or plan_reserves_p50(state, 'Gas') > 0),
        ('Concepts', _len(_get(state, 'concepts', 'list')) > 0),
        ('Wells', _len(_get(state, 'wells', 'list')) > 0),
        ('Facilities', _len(_get(state, 'facilities', 'list')) > 0),
        ('Schedule', _len(_get(state, 'schedule', 'activities')) > 0),
        ('Economics', npv != 0),
        ('HSE', _len(_get(state, 'hseData', 'hazards')) > 0),
        ('Risks', _len(_get(state, 'risks')) > 0),
    ]
    done = sum(1 for _, v in checks if v)
    return {'score': js_round(done / len(checks) * 100.0),
            'breakdown': [{'module': m, 'valid': bool(v)} for m, v in checks]}


def validate(state):
    errors, warnings = [], []
    if not truthy(_get(state, 'fieldData', 'fieldName')):
        errors.append('Project name is missing.')
    if plan_reserves_p50(state) <= 0 and plan_reserves_p50(state, 'Gas') <= 0:
        errors.append('Reserves (P50) not estimated.')
    if _len(_get(state, 'wells', 'list')) == 0:
        warnings.append('No wells defined in the drilling program.')
    if _len(_get(state, 'facilities', 'list')) == 0:
        warnings.append('No facilities concepts selected.')
    if _len(_get(state, 'costs', 'items')) == 0:
        warnings.append('Cost breakdown is empty.')
    if or_default(_get(state, 'economics', 'capex'), 0) <= 0:
        errors.append('Total CAPEX is zero or missing.')
    return {'isValid': not errors, 'errors': errors, 'warnings': warnings}


def cost_rollups(items):
    if items is None:
        return {'totalCAPEX': 0.0, 'totalOPEX': 0.0, 'byPhase': None}
    capex = sum(pf_or(i.get('amount'), 0.0) for i in items if i.get('type') == 'CAPEX')
    opex = sum(pf_or(i.get('amount'), 0.0) for i in items if i.get('type') == 'OPEX')
    phases = {}
    for i in items:
        ph = or_default(i.get('phase'), 'Unassigned')
        phases[ph] = phases.get(ph, 0.0) + pf_or(i.get('amount'), 0.0)
    return {'totalCAPEX': capex, 'totalOPEX': opex, 'byPhase': phases}


# ---------------------------------------------------------------------
# The worked example data (src/services/fdp/exampleData.js), verbatim
# values, with the schedule laid out from a FIXED date so it is a golden.
# ---------------------------------------------------------------------

EXAMPLE_COSTS = [
    {'id': 'ex-001', 'name': 'Mob/Demob', 'category': 'Drilling', 'type': 'CAPEX', 'amount': 2.5, 'phase': 'Mobilization'},
    {'id': 'ex-002', 'name': 'Rig Daily Rate (30d)', 'category': 'Drilling', 'type': 'CAPEX', 'amount': 7.5, 'phase': 'Execution'},
    {'id': 'ex-003', 'name': 'Tangibles (Casing)', 'category': 'Drilling', 'type': 'CAPEX', 'amount': 3.2, 'phase': 'Execution'},
    {'id': 'ex-004', 'name': 'Cementing Services', 'category': 'Drilling', 'type': 'CAPEX', 'amount': 1.1, 'phase': 'Execution'},
    {'id': 'ex-005', 'name': 'EPC Contract - Topsides', 'category': 'Fabrication', 'type': 'CAPEX', 'amount': 450, 'phase': 'Construction'},
    {'id': 'ex-006', 'name': 'Subsea Umbilicals', 'category': 'Installation', 'type': 'CAPEX', 'amount': 85, 'phase': 'Installation'},
    {'id': 'ex-007', 'name': 'PMT Team', 'category': 'Management', 'type': 'CAPEX', 'amount': 25, 'phase': 'All'},
    {'id': 'ex-008', 'name': 'Logistics & Support', 'category': 'Support', 'type': 'OPEX', 'amount': 0.5, 'phase': 'Execution'},
]
EXAMPLE_WELLS = [
    {'id': 'wp-101', 'name': 'P-01', 'type': 'Producer', 'trajectory': 'Horizontal', 'tvd': 8500, 'md': 12400, 'status': 'Planned'},
    {'id': 'wp-102', 'name': 'P-02', 'type': 'Producer', 'trajectory': 'Horizontal', 'tvd': 8550, 'md': 12600, 'status': 'Planned'},
    {'id': 'wp-103', 'name': 'I-01', 'type': 'Injector', 'trajectory': 'Deviated', 'tvd': 8800, 'md': 10200, 'status': 'Planned'},
]
EXAMPLE_FACILITIES = [
    {'id': 'bench-001', 'name': 'FPSO - Generic Large', 'type': 'FPSO', 'nameplateCapacity': 150000, 'gasCapacity': 200, 'waterCapacity': 120000, 'capex': 1500, 'opex': 65},
    {'id': 'bench-002', 'name': 'Platform - Shallow Water', 'type': 'Platform', 'nameplateCapacity': 50000, 'gasCapacity': 50, 'waterCapacity': 30000, 'capex': 600, 'opex': 25},
    {'id': 'bench-003', 'name': 'Subsea Tie-back System', 'type': 'Subsea Tie-back', 'nameplateCapacity': 30000, 'gasCapacity': 20, 'waterCapacity': 10000, 'capex': 350, 'opex': 15},
]
EXAMPLE_HSE = [
    {'name': 'High Pressure Zone Drilling', 'type': 'Safety', 'probability': 4, 'impact': 5, 'status': 'Mitigated'},
    {'name': 'Chemical Spill Potential', 'type': 'Environmental', 'probability': 2, 'impact': 4, 'status': 'Assessed'},
    {'name': 'Noise Pollution for Local Village', 'type': 'Community', 'probability': 5, 'impact': 3, 'status': 'Identified'},
]
EXAMPLE_RESERVOIRS = [
    {'id': 'r1', 'name': 'Reservoir A', 'p10': 120, 'p50': 85, 'p90': 60, 'fluid': 'Oil', 'rf': 0.35},
    {'id': 'r2', 'name': 'Reservoir B', 'p10': 45, 'p50': 30, 'p90': 15, 'fluid': 'Gas', 'rf': 0.65},
]
EXAMPLE_FROM = date(2026, 1, 1)


def example_schedule(frm=EXAMPLE_FROM):
    add = lambda n: (frm + timedelta(days=n)).isoformat()
    return [
        {'id': 'act-1', 'name': 'Project Sanction', 'type': 'Milestone', 'start': add(0), 'end': add(0), 'duration': 0, 'progress': 100, 'dependencies': []},
        {'id': 'act-2', 'name': 'Detailed Engineering', 'type': 'Engineering', 'start': add(1), 'end': add(60), 'duration': 60, 'progress': 45, 'dependencies': ['act-1']},
        {'id': 'act-3', 'name': 'Procurement - Long Lead', 'type': 'Procurement', 'start': add(30), 'end': add(120), 'duration': 90, 'progress': 20, 'dependencies': ['act-1']},
        {'id': 'act-4', 'name': 'Fabrication - Topsides', 'type': 'Fabrication', 'start': add(121), 'end': add(300), 'duration': 180, 'progress': 0, 'dependencies': ['act-3']},
        {'id': 'act-5', 'name': 'Drilling Campaign', 'type': 'Drilling', 'start': add(150), 'end': add(400), 'duration': 250, 'progress': 0, 'dependencies': ['act-2']},
        {'id': 'act-6', 'name': 'Installation & HUC', 'type': 'Installation', 'start': add(301), 'end': add(360), 'duration': 60, 'progress': 0, 'dependencies': ['act-4']},
        {'id': 'act-7', 'name': 'First Oil', 'type': 'Milestone', 'start': add(401), 'end': add(401), 'duration': 0, 'progress': 0, 'dependencies': ['act-5', 'act-6']},
    ]


# ---------------------------------------------------------------------
# Cases.
# ---------------------------------------------------------------------

PROFILE = [10, 25, 45, 50, 48, 42, 35, 30, 25, 20]
PRICES = [75] * 10

# ---------------------------------------------------------------------
# ENGINE NUMBERS RECORDED AS DISAGREEMENTS (brief rule 2). The screening
# engine's IRR is a Newton iteration from 10 percent clamped to
# [-99, 1000] percent. On every case below Newton walks to the upper clamp
# and the engine REPORTS 1000 PERCENT: for a project whose only IRR is
# NEGATIVE (never pays back), for one whose NPV never crosses zero at any
# rate, and for two whose true IRR is above the clamp. The engine keeps its
# published behaviour; the golden carries its number here, labelled, beside
# the oracle's, and the gate pins both and the gap. See FINDINGS-fdp.md.
# ---------------------------------------------------------------------
# EC6-1: there are no IRR disagreements left to pin here either.
#
# Four cases in this file and one scenario used to carry one: the engine ran
# a clamped Newton search from 10 percent and reported the rate it stopped
# at, so a case whose only root is -36.67 percent, and a case with no root at
# all, both showed an IRR of exactly 1000.0 percent, and on a scenario card
# that 1000 was coloured green for clearing the 15 percent hurdle. The engine
# now reports a rate only when it is a single root inside the band it
# searches, and `irrStatus` carries the reason when there is none.
ENGINE_REPORTED = {}
ENGINE_REPORTED_SCENARIO = {}


def fdp_cases():
    cases = []

    def add(name, capex, opex, prod, prices, fiscal=None, note=None):
        r = fdp_case(capex, opex, prod, prices, fiscal)
        c = {'name': name, 'inputs': {'capexMM': capex, 'annualOpexMM': opex, 'productionKbpd': prod,
                                      'pricesUsd': prices, 'fiscal': fiscal or {}}, 'expected': r}
        if name in ENGINE_REPORTED:
            r['engineReported'] = ENGINE_REPORTED[name]
        if note:
            c['note'] = note
        cases.append(c)

    add('suite test base: 800 capex, 60 opex, 10 year profile at 75', 800, 60, PROFILE, PRICES)
    add('suite test: no fiscal terms', 800, 60, PROFILE, PRICES, {'royaltyRate': 0, 'taxRate': 0})
    add('suite test: never pays back (100000 capex)', 100000, 60, PROFILE, PRICES)
    for capex in [200, 400, 1600, 3200]:
        add('sweep capex %d' % capex, capex, 60, PROFILE, PRICES)
    for price in [40, 55, 95, 120]:
        add('sweep flat price %d' % price, 800, 60, PROFILE, [price] * 10)
    for dr in [0, 5, 15, 20]:
        add('sweep discount %d' % dr, 800, 60, PROFILE, PRICES, {'discountRate': dr})
    for roy, tax in [(0, 30), (20, 30), (12.5, 0), (12.5, 85), (30, 85)]:
        add('sweep royalty %s tax %s' % (roy, tax), 800, 60, PROFILE, PRICES, {'royaltyRate': roy, 'taxRate': tax})
    add('sweep variable opex 15 per bbl', 800, 60, PROFILE, PRICES, {'variableOpexPerBbl': 15})
    add('rising price deck', 800, 60, PROFILE, [50, 55, 60, 65, 70, 75, 80, 85, 90, 95])
    add('single producing year', 100, 10, [30], [80])
    # EC6-1 renamed these three. Their names asserted the retired conventions
    # (an IRR of 0 reported for a cash flow that never changes sign, and the
    # project life reported as a payback), which the engine no longer does and
    # the goldens themselves no longer record. A case name is quoted verbatim
    # by anything that reads the goldens, so a stale one teaches the defect.
    add('zero production every year: no sign change, so no rate and no payback', 800, 60, [0, 0, 0, 0, 0], [75] * 5,
        note='no sign change: irr null with irrStatus no-sign-change; paybackYears null')
    add('zero capex: all positive, no IRR exists', 0, 10, [20, 20, 20], [75, 75, 75],
        note='no sign change: engine irr null, costCalculations irr null, payback 0')
    add('opex above revenue every year: negative everywhere', 800, 2000, PROFILE, PRICES,
        note='no positive flow: irr null with irrStatus no-sign-change; maxExposure is the whole loss')
    add('tax floor: loss years pay no tax', 800, 700, [10, 40, 60, 60, 20, 5], [75] * 6)
    add('string and null production entries coerce through Number', 300, 20, ['25', None, 30, 'x', 40], [75] * 5,
        note='Number("25") is 25, Number(null) is 0, Number("x") is NaN and becomes 0')
    add('price deck shorter than the profile: missing prices are 0', 300, 20, [20, 20, 20, 20], [75, 75])
    add('tiny capex, large single year: IRR beyond the engine clamp', 1, 0, [10], [75],
        note='true mid-year IRR is far above 1000 percent; the engine clamps Newton to 1000 percent')
    add('high IRR above the clamp: three fat years on 20 capex', 20, 5, [30, 30, 30], [75] * 3,
        note='true mid-year IRR above 1000 percent; the engine clamps')
    add('negative fiscal edge: royalty 100 percent', 800, 60, PROFILE, PRICES, {'royaltyRate': 100})
    add('late payback in the final year', 1350, 60, PROFILE, PRICES)
    add('long life 25 years with decline', 1200, 80, [60 * 0.92 ** k for k in range(25)], [70] * 25)
    return cases


def scenario_cases():
    concept = {'drillingCapex': 300, 'facilitiesCapex': 400, 'subseaCapex': 100, 'opex': 60, 'peakProduction': 50}
    cases = []

    def add(name, scenario, conc, note=None):
        c = {'name': name, 'inputs': {'scenario': scenario, 'concept': conc}, 'expected': run_scenario(scenario, conc)}
        if name in ENGINE_REPORTED_SCENARIO:
            c['expected']['engineReported'] = ENGINE_REPORTED_SCENARIO[name]
        if note:
            c['note'] = note
        cases.append(c)

    add('suite test: 75 at 10 percent', {'oilPrice': 75, 'discountRate': 10}, concept)
    add('suite test: 95 at 10 percent', {'oilPrice': 95, 'discountRate': 10}, concept)
    add('suite test: 55 at 10 percent', {'oilPrice': 55, 'discountRate': 10}, concept)
    add('suite test: 15 percent', {'oilPrice': 75, 'discountRate': 15}, concept)
    add('suite test: 5 percent', {'oilPrice': 75, 'discountRate': 5}, concept)
    add('the three capex fields are added', {'oilPrice': 70, 'discountRate': 10},
        {'drillingCapex': 400, 'facilitiesCapex': 1200, 'subseaCapex': 300, 'opex': 60, 'peakProduction': 50},
        note='EC6-0: 400 + 1200 + 300 = 1900. On the old fallback of 100 this concept showed '
             'NPV 3507.6 and IRR 676.4 percent; on its own capex it is 1791.4 and 30.0 percent.')
    add('a total capex field is taken as the total', {'oilPrice': 70, 'discountRate': 10},
        {'capex': 1900, 'opex': 60, 'peakProduction': 50},
        note='the same case entered as one figure: identical to the sum of the three fields')
    add('only one capex field is entered', {'oilPrice': 75}, {'facilitiesCapex': 800, 'opex': 60, 'peakProduction': 50})
    add('string fields parse', {'oilPrice': '80', 'discountRate': '8', 'royaltyRate': '10', 'taxRate': '25'},
        {'capex': '1000', 'opex': '50', 'peakProduction': '40'})
    add('blank rate strings take the stated default', {'oilPrice': 75, 'royaltyRate': '', 'taxRate': ''}, concept,
        note='EC6-0: a blank fiscal field is absent, so it takes DEFAULT_FISCAL. It used to be '
             'read as a zero rate, which put NPV 5928.2 on a case with no royalty and no tax.')
    add('null rates take the stated default', {'oilPrice': 75, 'royaltyRate': None, 'taxRate': None}, concept)
    add('a zero capex a user actually typed is honoured', {'oilPrice': 75},
        {'drillingCapex': 0, 'facilitiesCapex': 0, 'subseaCapex': 0, 'opex': 0, 'peakProduction': 10},
        note='EC6-0: 0 is a value. It used to be replaced by the 100 default, so a zero could not be entered.')
    add('a zero oil price a user actually typed is honoured', {'oilPrice': 0}, concept,
        note='EC6-0: it used to become 70 while the card printed "$0/bbl".')
    add('explicit production profile overrides the concept shape', {'oilPrice': 75},
        {'capex': 500, 'opex': 30, 'productionProfileKbpd': [10, 20, 30, 20, 10]})
    add('empty production profile falls back to the concept shape', {'oilPrice': 75},
        {'capex': 500, 'opex': 30, 'productionProfileKbpd': [], 'peakProduction': 25})
    add('example FPSO concept at 70', {'oilPrice': 70, 'discountRate': 10}, {'capex': 1500, 'opex': 65, 'peakProduction': 150})
    add('example subsea tie-back at 70', {'oilPrice': 70, 'discountRate': 10}, {'capex': 350, 'opex': 15, 'peakProduction': 30})
    add('price so low the scenario never pays back', {'oilPrice': 12}, concept)
    add('zero discount rate', {'oilPrice': 75, 'discountRate': 0}, concept)
    return cases


def scenario_refusal_cases():
    """EC6-0: what the engine now refuses instead of substituting a default."""
    out = []
    for name, scenario, conc in [
        ('a concept with no capex at all', {'oilPrice': 75}, {'opex': 60, 'peakProduction': 50}),
        ('a scenario with no oil price', {}, {'capex': 800, 'opex': 60, 'peakProduction': 50}),
        ('a blank oil price', {'oilPrice': ''}, {'capex': 800, 'opex': 60, 'peakProduction': 50}),
        ('a concept with no operating cost', {'oilPrice': 75}, {'capex': 800, 'peakProduction': 50}),
        ('a concept with no peak rate', {'oilPrice': 75}, {'capex': 800, 'opex': 60}),
        ('a negative capex', {'oilPrice': 75}, {'drillingCapex': -500, 'opex': 60, 'peakProduction': 50}),
        ('a negative oil price', {'oilPrice': -5}, {'capex': 800, 'opex': 60, 'peakProduction': 50}),
        ('a non numeric discount rate', {'oilPrice': 75, 'discountRate': 'abc'}, {'capex': 800, 'opex': 60, 'peakProduction': 50}),
        ('a non numeric royalty rate', {'oilPrice': 75, 'royaltyRate': 'x'}, {'capex': 800, 'opex': 60, 'peakProduction': 50}),
        ('a non numeric capex', {'oilPrice': 75}, {'capex': 'lots', 'opex': 60, 'peakProduction': 50}),
    ]:
        try:
            run_scenario(scenario, conc)
        except Refused as e:
            out.append({'name': name, 'inputs': {'scenario': scenario, 'concept': conc},
                        'expected': {'refused': True, 'message': e.message}})
            continue
        raise AssertionError('expected a refusal for: %s' % name)
    return out


def sensitivity_cases():
    """EC6-0: the screening sweep the Economics tab now draws, in place of a
    tornado whose five bars were literals around "Base Case ($245MM)"."""
    out = []
    for name, args in [
        ('800 capex, 60 opex, 50 kbpd flat ten years at 70',
         (800, 60, [50] * 10, [70] * 10, None)),
        ('the example FPSO concept profile at 70',
         (1500, 65, concept_profile({'peakProduction': 150}), [70] * 20, None)),
        ('a marginal case: 900 capex at 45',
         (900, 40, [20] * 15, [45] * 15, None)),
        ('no royalty and no tax',
         (500, 25, [30] * 8, [65] * 8, {'royaltyRate': 0, 'taxRate': 0})),
    ]:
        out.append({'name': name,
                    'inputs': {'capexMM': args[0], 'annualOpexMM': args[1], 'productionKbpd': args[2],
                               'pricesUsd': args[3], 'fiscal': args[4]},
                    'expected': fdp_sensitivity(*args)})
    return out


def concept_cases():
    cases = []
    for name, c, sub in [
        ('full concept', {'drillingCapex': 300, 'facilitiesCapex': 800, 'subseaCapex': 150, 'opex': 45, 'lifeOfField': 25,
                          'startDate': '2026-03-15', 'facilityType': 'FPSO', 'driveMechanism': 'Water Injection'},
         {'reserves': {'p50': 115}}),
        ('platform, default life', {'drillingCapex': '120', 'facilitiesCapex': '400', 'opex': '20', 'startDate': '2026-01-31',
                                    'facilityType': 'Platform', 'driveMechanism': 'Gas Injection'}, {'reserves': {'p50': 60}}),
        ('leap day start, FPSO', {'opex': 10, 'startDate': '2024-02-29', 'facilityType': 'FPSO', 'driveMechanism': 'Natural Depletion'},
         {'reserves': {'p50': 40}}),
        ('leap day start, 24 months lands on Mar 1', {'startDate': '2024-02-29', 'driveMechanism': 'ESP'}, {'reserves': {'p50': 10}}),
        ('month end overflow: Jan 31 plus 24 months', {'startDate': '2025-01-31'}, None),
        ('Oct 31 plus 24 months', {'startDate': '2025-10-31', 'driveMechanism': 'Unknown'}, {'reserves': {}}),
        ('blank fields', {'drillingCapex': '', 'opex': 'abc', 'lifeOfField': 0, 'startDate': '2026-06-30'}, {}),
        ('invalid start date is refused', {'startDate': 'not a date'}, {'reserves': {'p50': 5}}),
        ('no start date at all is refused', {'facilityType': 'FPSO'}, {'reserves': {'p50': 5}}),
    ]:
        exp = {'cost': concept_cost(c), 'schedule': concept_schedule(c), 'reserves': reserves_impact(c, sub)}
        cases.append({'name': name, 'inputs': {'concept': c, 'subsurfaceData': sub}, 'expected': exp})
    return cases


def subsurface_cases():
    cases = []
    for name, args in [
        ('textbook: 640 acres, 50 ft, 0.22, Sw 0.25, Bo 1.2', (640, 50, 0.22, 0.25, 1.2)),
        ('default Bo', (1000, 30, 0.18, 0.35)),
        ('zero Bo returns 0', (1000, 30, 0.18, 0.35, 0)),
        ('zero porosity', (1000, 30, 0, 0.35, 1.1)),
        ('Sw of 1 gives no oil', (1000, 30, 0.2, 1.0, 1.1)),
        ('example zone: 42 acres, 120 ft, 0.24, Sw 0.20, Bo 1.25', (42, 120, 0.24, 0.20, 1.25)),
    ]:
        o = ooip(*args)
        rec = recovery_factor(o, o * 0.35)
        cases.append({'name': name, 'inputs': {'area': args[0], 'thickness': args[1], 'porosity': args[2],
                                               'saturation': args[3], 'formationVolumeFactor': args[4] if len(args) > 4 else '__default__'},
                      'expected': {'ooip': o, 'recoverable_at_35pct': o * 0.35, 'recoveryFactor_of_that': rec}})
    rf_cases = [
        {'name': 'recovery factor 115 of 330', 'inputs': {'ooip': 330, 'recoverable': 115}, 'expected': recovery_factor(330, 115)},
        {'name': 'recovery factor with zero ooip is 0', 'inputs': {'ooip': 0, 'recoverable': 115}, 'expected': recovery_factor(0, 115)},
        {'name': 'recovery factor with null ooip is 0', 'inputs': {'ooip': None, 'recoverable': 115}, 'expected': 0.0},
    ]
    grad = [
        {'name': 'pressure gradient 3825 psi at 8500 ft from 14.7 at 0', 'inputs': [14.7, 0, 3825, 8500], 'expected': gradient(14.7, 0, 3825, 8500)},
        {'name': 'equal depths give 0', 'inputs': [100, 5000, 200, 5000], 'expected': 0.0},
        {'name': 'temperature 60 F at 0 to 200 F at 8500', 'inputs': [60, 0, 200, 8500], 'expected': gradient(60, 0, 200, 8500)},
        {'name': 'reversed depths give the negative', 'inputs': [200, 8500, 60, 0], 'expected': gradient(200, 8500, 60, 0)},
    ]
    strings_and_blanks = [{'name': 'S1', 'fluid': 'Oil', 'p10': '10', 'p50': '', 'p90': None, 'recoverable': 'abc'},
                          {'name': 'S2', 'fluid': 'Oil', 'p10': 5, 'p50': 4.5, 'p90': 3, 'recoverable': 2}]
    three_fluids = [{'name': 'A', 'fluid': 'Oil', 'p90': 60, 'p50': 85, 'p10': 120},
                    {'name': 'B', 'fluid': 'Gas', 'p90': 15, 'p50': 30, 'p10': 45},
                    {'name': 'C', 'fluid': 'Condensate', 'p90': 2, 'p50': 4, 'p10': 7},
                    {'name': 'D', 'fluid': 'Oil', 'p90': 10, 'p50': 20, 'p10': 35}]
    agg = [
        {'name': 'example breakdown: 85 MMbbl of oil and 30 Bcf of gas stay apart',
         'inputs': EXAMPLE_RESERVOIRS, 'expected': aggregate_reserves(EXAMPLE_RESERVOIRS),
         'note': 'EC6-0: the engine used to report "Total (P50) 115" and the summary called that 115 MMbbl of oil.'},
        {'name': 'strings and blanks', 'inputs': strings_and_blanks, 'expected': aggregate_reserves(strings_and_blanks)},
        {'name': 'three fluids, two oil rows', 'inputs': three_fluids, 'expected': aggregate_reserves(three_fluids)},
        {'name': 'empty list', 'inputs': [], 'expected': aggregate_reserves([])},
    ]
    agg_refusals = []
    for name, rows in [
        ('a row with no fluid type', [{'name': 'Reservoir A', 'p50': 10}]),
        ('a row with an unknown fluid type', [{'name': 'Reservoir A', 'fluid': 'Brine', 'p50': 10}]),
        ('an unnamed row is refused by its position', [{'fluid': 'Oil', 'p50': 1}, {'p50': 2}]),
    ]:
        try:
            aggregate_reserves(rows)
        except Refused as e:
            agg_refusals.append({'name': name, 'inputs': rows, 'expected': {'refused': True, 'message': e.message}})
            continue
        raise AssertionError('expected a refusal for: %s' % name)
    return {'ooip': cases, 'recoveryFactor': rf_cases, 'gradients': grad, 'aggregateReserves': agg,
            'aggregateReservesRefusals': agg_refusals,
            'riskScore': [{'inputs': [p, i], 'expected': float(p * i)} for p in range(1, 6) for i in range(1, 6)]}


def well_cases():
    times = []
    for md in [5000, 8500, 12400, 12600, 10200, 0, '12400']:
        for wt in ['Vertical', 'Horizontal', 'Deviated']:
            for cx in ['Low', 'Medium', 'High', '__default__']:
                days = drilling_time(md, wt) if cx == '__default__' else drilling_time(md, wt, cx)
                times.append({'inputs': {'md': md, 'wellType': wt, 'complexity': cx},
                              'expected': {'days': days, 'cost_at_250k_default_services': drilling_cost(days, 250000)}})
    costs = [
        {'inputs': [30, 250000], 'expected': drilling_cost(30, 250000)},
        {'inputs': [30, 250000, 5000000], 'expected': drilling_cost(30, 250000, 5000000)},
        {'inputs': [30, 250000, 0], 'expected': drilling_cost(30, 250000, 0)},
        {'inputs': [30, 250000, -1], 'expected': drilling_cost(30, 250000, -1)},
        {'inputs': [0, 250000], 'expected': 0.0},
    ]
    counts = [
        {'inputs': [115, 12], 'expected': well_count(115, 12)},
        {'inputs': [115, 0], 'expected': 0.0},
        {'inputs': [115, None], 'expected': 0.0},
        {'inputs': [120, 12], 'expected': well_count(120, 12)},
        {'inputs': [0, 12], 'expected': 0.0},
        {'inputs': [0.1, 12], 'expected': 1.0},
    ]
    wells = EXAMPLE_WELLS + [{'id': 'x', 'cost': '1500000'}, {'id': 'y', 'type': 'Producer', 'cost': 2500000}, {'id': 'z', 'type': '', 'cost': 'abc'}]
    return {'drillingTime': times, 'drillingCost': costs, 'wellCount': counts,
            'aggregate': [{'inputs': wells, 'expected': {'byType': wells_by_type(wells), 'totalCost': total_drilling_cost(wells)}},
                          {'inputs': [], 'expected': {'byType': {}, 'totalCost': 0.0}}]}


def facility_cases():
    caps, costs, fa, bn = [], [], [], []
    for f in EXAMPLE_FACILITIES + [{'type': 'Onshore Plant', 'nameplateCapacity': ''}, {'type': 'FPSO', 'nameplateCapacity': '75000'}, {'type': 'Platform', 'nameplateCapacity': 0}, {'type': 'Subsea Tie-back', 'nameplateCapacity': 200000}]:
        caps.append({'inputs': f, 'expected': facility_capacity(f)})
        costs.append({'inputs': f, 'expected': facility_cost(f)})
    fluids = [None, {}, {'api': 35}, {'api': 20}, {'api': 20, 'h2s': 0}, {'api': 30, 'h2s': 50}, {'api': 18, 'h2s': 100}, {'api': None}, {'api': '22'}, {'h2s': '5'}]
    for f in [{'type': 'Subsea Tie-back'}, {'type': 'FPSO'}]:
        for fl in fluids:
            fa.append({'inputs': {'facility': f, 'fluidProperties': fl}, 'expected': flow_assurance(f, fl)})
    for f, peak in [
        (EXAMPLE_FACILITIES[0], {'oil': 160000, 'gas': 200000, 'water': 100000}),
        (EXAMPLE_FACILITIES[1], {'oil': 40000, 'gas': 80000, 'water': 50000}),
        (EXAMPLE_FACILITIES[2], {'oil': 30000, 'gas': 45000, 'water': 24000}),
        (EXAMPLE_FACILITIES[2], {'oil': 30001, 'gas': 45001, 'water': 24001}),
        ({'nameplateCapacity': None}, {'oil': 100001}),
        ({'nameplateCapacity': 50000}, {}),
    ]:
        bn.append({'inputs': {'facility': f, 'peakProduction': peak}, 'expected': bottlenecks(f, peak)})
    return {'capacity': caps, 'cost': costs, 'flowAssurance': fa, 'bottlenecks': bn}


def hse_cases():
    sets = {
        'example': EXAMPLE_HSE,
        'boundaries 15 and 8': [{'probability': 3, 'impact': 5, 'type': 'Safety'}, {'probability': 2, 'impact': 4, 'type': 'Safety'},
                                {'probability': 7, 'impact': 2, 'type': 'Health'}, {'probability': 1, 'impact': 7}],
        'missing factors': [{'probability': 4}, {'impact': 5}, {}],
        'empty': [],
        'every cell of the 5 by 5': [{'probability': p, 'impact': i, 'type': 'T%d' % p} for p in range(1, 6) for i in range(1, 6)],
    }
    out = []
    for name, rs in sets.items():
        out.append({'name': name, 'inputs': rs, 'expected': {'matrix': risk_matrix(rs), 'totalScore': total_risk_score(rs),
                                                             'byType': by_key(rs, 'type', 'Other')}})
    checklists = [
        ('all compliant', [{'status': 'Compliant'}] * 4),
        ('two of three', [{'status': 'Compliant'}, {'status': 'Compliant'}, {'status': 'Non-Compliant'}]),
        ('one of three rounds 33.33 to 33', [{'status': 'Compliant'}, {'status': 'Open'}, {}]),
        ('one of eight rounds 12.5 up to 13', [{'status': 'Compliant'}] + [{'status': 'Open'}] * 7),
        ('five of eight is 62.5, rounds to 63', [{'status': 'Compliant'}] * 5 + [{'status': 'Open'}] * 3),
        ('empty is 0', []),
        ('null is 0', None),
    ]
    comp = [{'name': n, 'inputs': c, 'expected': compliance_score(c)} for n, c in checklists]
    return {'sets': out, 'compliance': comp}


def risk_cases():
    sets = {
        'example HSE risks through the risk module': EXAMPLE_HSE,
        'mixed portfolio with cost impacts': [
            {'probability': 5, 'impact': 5, 'costImpact': 40, 'source': 'Drilling Module'},
            {'probability': 4, 'impact': 3, 'costImpact': 12.5, 'source': 'HSE Module'},
            {'probability': 2, 'impact': 3, 'costImpact': '8', 'source': 'Manual'},
            {'probability': 1, 'impact': 1, 'costImpact': 100, 'source': None},
            {'probability': 3, 'impact': 4, 'costImpact': None},
        ],
        'level boundaries 20, 12, 6': [{'probability': 4, 'impact': 5}, {'probability': 3, 'impact': 4}, {'probability': 2, 'impact': 3},
                                       {'probability': 1, 'impact': 5}, {'probability': 5, 'impact': 5}],
        'all critical: health floors at 0': [{'probability': 5, 'impact': 5, 'costImpact': 1}] * 3,
        'all low: health 100': [{'probability': 1, 'impact': 2}] * 4,
        'empty': [],
        'one medium: penalty 2 of 1 gives 80': [{'probability': 2, 'impact': 3}],
        'string probability keys the factor table': [{'probability': '3', 'impact': '4', 'costImpact': 10}],
        'fractional probability has no factor': [{'probability': 2.5, 'impact': 4, 'costImpact': 10}],
        'probability out of the 1 to 5 range': [{'probability': 6, 'impact': 4, 'costImpact': 10}, {'probability': 0, 'impact': 4, 'costImpact': 10}],
        # EC6-1 renamed this too: the consolidated score is the sum of the
        # SCORED risks now, so an unscored risk contributes nothing instead of
        # making the whole register NaN.
        'missing probability: the unscored risk contributes nothing': [{'impact': 4, 'costImpact': 10}, {'probability': 3, 'impact': 3}],
    }
    out = []
    for name, rs in sets.items():
        exp = {'consolidatedScore': consolidated_score(rs), 'exposure': risk_exposure(rs),
               'bySource': by_key(rs, 'source', 'Other'), 'byLevel': by_level(rs), 'health': portfolio_health(rs)}
        c = {'name': name, 'inputs': rs, 'expected': exp}
        if exp['consolidatedScore'] != exp['consolidatedScore']:
            # Unreachable since EC6-1: riskScore returns null for an unscored
            # risk and the consolidated score sums the scored ones. Kept as a
            # guard so a regression to the NaN behaviour is recorded rather
            # than emitted silently.
            c['note'] = 'REGRESSION: consolidatedScore is NaN again; EC6-1 made an unscored risk contribute nothing.'
        if by_level(rs)['Unscored']:
            c['note'] = ('%d risk(s) carry no probability or no impact: they are counted Unscored, '
                         'contribute nothing to the consolidated score and are left out of the health.'
                         % by_level(rs)['Unscored'])
        out.append(c)
    return out


def schedule_cases():
    ex = example_schedule()
    dated = [
        {'id': 'a', 'startDate': '2026-01-01', 'endDate': '2026-03-01', 'duration': 59, 'dependencies': [], 'type': 'Engineering'},
        {'id': 'b', 'startDate': '2026-03-02', 'endDate': '2026-06-30', 'duration': 120, 'dependencies': ['a'], 'type': 'Procurement'},
        {'id': 'c', 'startDate': '2026-03-02', 'endDate': '2026-05-01', 'duration': 60, 'dependencies': ['a'], 'type': 'Drilling'},
        {'id': 'd', 'startDate': '2026-07-01', 'endDate': '2026-07-01', 'duration': 0, 'dependencies': ['b', 'c'], 'type': 'Milestone'},
    ]
    with_floats = [
        {'id': 'p', 'float': 0, 'duration': 10, 'dependencies': []},
        {'id': 'q', 'float': 5, 'duration': 4, 'dependencies': ['p']},
        {'id': 'r', 'duration': 9, 'dependencies': ['p']},
        {'id': 's', 'float': None, 'duration': 0, 'dependencies': ['q', 'r'], 'type': 'Milestone'},
        {'id': 't', 'float': '0', 'duration': 3, 'dependencies': ['s']},
        {'id': 'u', 'float': -2, 'duration': 1, 'dependencies': ['s']},
    ]
    diamond = [
        {'id': 'A', 'duration': 3, 'dependencies': []},
        {'id': 'B', 'duration': 5, 'dependencies': ['A']},
        {'id': 'C', 'duration': 5, 'dependencies': ['A']},
        {'id': 'D', 'duration': 2, 'dependencies': ['B', 'C']},
    ]
    chain = [{'id': 'n%d' % k, 'duration': k + 1, 'dependencies': ['n%d' % (k - 1)] if k else []} for k in range(12)]
    parallel = [{'id': 'w%d' % k, 'duration': 7, 'dependencies': []} for k in range(4)]
    textbook = [
        {'id': 'A', 'duration': 3, 'dependencies': []},
        {'id': 'B', 'duration': 4, 'dependencies': ['A']},
        {'id': 'C', 'duration': 2, 'dependencies': ['A']},
        {'id': 'D', 'duration': 5, 'dependencies': ['B']},
        {'id': 'E', 'duration': 3, 'dependencies': ['C']},
        {'id': 'F', 'duration': 2, 'dependencies': ['D', 'E']},
    ]
    dangling = [{'id': 'a', 'duration': 2, 'dependencies': []}, {'id': 'b', 'duration': 3, 'dependencies': ['zz']}]
    cycle = [{'id': 'a', 'duration': 2, 'dependencies': ['c']}, {'id': 'b', 'duration': 3, 'dependencies': ['a']},
             {'id': 'c', 'duration': 1, 'dependencies': ['b']}]
    out = []
    for name, acts, note in [
        ('textbook network: the critical path is A-B-D-F at 14 days', textbook,
         'EC6-0: the engine used to mark all six activities critical at float 0. The method puts four '
         'days of float on C and on E.'),
        ('example schedule from 2026-01-01', ex, 'EC6-0: the engine used to mark every activity critical (it read back the caller\'s own float); the critical path is act-1, act-3, act-4, act-6, act-7 and act-2 and act-5 carry 20 days of float. calculateProjectDuration reads startDate and endDate, which the example does not carry, so it reports null.'),
        ('dated four activity plan', dated, None),
        ('the caller\'s own float fields are ignored: the method computes them', with_floats,
         'EC6-0 renamed this case. Every activity arrives carrying a float field (0, 5, absent, null, the string "0" and -2) and the engine reads none of them: it computes 0, 5, 0, 0, 0 and 2 from the network. The retired passthrough took the field at face value, so it called s and t non-critical when both sit on the only zero-float chain, and it reported u at -2 days of float, which no schedule can have.'),
        ('diamond with two equal critical paths (a tie)', diamond, 'both A-B-D and A-C-D are critical; the oracle lists both.'),
        ('twelve activity chain', chain, None),
        ('four independent activities, all critical', parallel, None),
        ('empty schedule', [], None),
    ]:
        exp = {'projectDuration': project_duration(acts), 'retiredPassthrough': cpm_passthrough(acts),
               'milestones': milestones(acts)}
        if acts:
            ref = cpm_reference(acts)
            exp['cpmReference'] = ref
            disagreeing = [p['id'] for p, r in zip(exp['retiredPassthrough'], ref['activities']) if p['isCritical'] != r['isCritical']]
            exp['criticalityDisagreements'] = disagreeing
        c = {'name': name, 'inputs': acts, 'expected': exp}
        if note:
            c['note'] = note
        out.append(c)
    for name, acts, message in [
        ('a dependency on an activity that is not in the schedule', dangling,
         'activity b depends on zz, which is not in the schedule'),
        ('a dependency cycle', cycle, 'the schedule has a dependency cycle through: a, b, c'),
        ('two activities with the same id', [{'id': 'a', 'duration': 1}, {'id': 'a', 'duration': 2}],
         'duplicate activity id: a'),
        ('an activity with no id', [{'duration': 1}], 'every activity needs an id'),
        ('a negative duration', [{'id': 'a', 'duration': -4}], 'activity a: duration may not be negative: -4'),
        ('an unreadable duration', [{'id': 'a', 'duration': 'two weeks'}],
         'activity a: duration is not a number: two weeks'),
    ]:
        out.append({'name': name, 'inputs': acts, 'expected': {'refused': True, 'message': message},
                    'note': 'EC6-0: the passthrough accepted every one of these.'})
    return out


def plan_cases():
    full = {'fieldData': {'fieldName': 'Example', 'country': 'Nigeria'},
            'subsurface': {'reserves': {'summary': {'p50': 0}, 'breakdown': EXAMPLE_RESERVOIRS}},
            'concepts': {'list': [{}]}, 'wells': {'list': EXAMPLE_WELLS}, 'facilities': {'list': EXAMPLE_FACILITIES},
            'schedule': {'activities': example_schedule()}, 'economics': {'npv': 512.3, 'capex': 574.3},
            'hseData': {'hazards': EXAMPLE_HSE}, 'risks': EXAMPLE_HSE, 'costs': {'items': EXAMPLE_COSTS}}
    states = [
        ('complete plan', full),
        ('empty state', {}),
        ('name but no country', {'fieldData': {'fieldName': 'X'}}),
        ('negative NPV still counts as economics done', {'economics': {'npv': -5, 'capex': 10}}),
        ('zero NPV does not', {'economics': {'npv': 0, 'capex': 10}}),
        ('four of nine rounds 44.44 to 44', {'fieldData': {'fieldName': 'X', 'country': 'Y'},
                                             'subsurface': {'reserves': {'breakdown': [{'name': 'R', 'fluid': 'Oil', 'p50': 1}]}},
                                             'concepts': {'list': [1]}, 'wells': {'list': [1]}}),
        ('five of nine rounds 55.56 to 56', {'fieldData': {'fieldName': 'X', 'country': 'Y'},
                                             'subsurface': {'reserves': {'breakdown': [{'name': 'R', 'fluid': 'Oil', 'p50': 1}]}},
                                             'concepts': {'list': [1]}, 'wells': {'list': [1]}, 'risks': [1]}),
        ('reserves negative fails the reserves error', {'fieldData': {'fieldName': 'X'},
                                                       'subsurface': {'reserves': {'breakdown': [{'name': 'R', 'fluid': 'Oil', 'p50': -3}]}},
                                                       'economics': {'capex': 1}}),
        ('a gas only plan passes the reserves check', {'fieldData': {'fieldName': 'X', 'country': 'Y'},
                                                      'subsurface': {'reserves': {'breakdown': [{'name': 'G', 'fluid': 'Gas', 'p50': 40}]}},
                                                      'economics': {'capex': 10, 'npv': 1}}),
        ('EC6-0: a full table with an empty summary now passes; it used to score 78 and fail',
         {'fieldData': {'fieldName': 'X', 'country': 'Y'},
          'subsurface': {'reserves': {'summary': {'p10': 0, 'p50': 0, 'p90': 0}, 'breakdown': EXAMPLE_RESERVOIRS}},
          'concepts': {'list': [1]}, 'wells': {'list': [1]}, 'facilities': {'list': [1]},
          'schedule': {'activities': [1]}, 'economics': {'npv': 1, 'capex': 1}, 'hseData': {'hazards': [1]}, 'risks': [1],
          'costs': {'items': [1]}}),
        ('a loaded example carries only the summary', {'fieldData': {'fieldName': 'X', 'country': 'Y'},
                                                       'subsurface': {'reserves': {'summary': {'p50': 115}, 'breakdown': []}},
                                                       'economics': {'capex': 1, 'npv': 1}}),
        ('an unreadable reserves table reads as no reserves', {'fieldData': {'fieldName': 'X', 'country': 'Y'},
                                                              'subsurface': {'reserves': {'breakdown': [{'name': 'R', 'p50': 99}]}},
                                                              'economics': {'capex': 1, 'npv': 1}}),
    ]
    return [{'name': n, 'inputs': s, 'expected': {'completeness': completeness(s), 'validation': validate(s)}} for n, s in states]


def cost_cases():
    items = [
        ('example costs', EXAMPLE_COSTS),
        ('strings, blanks and unassigned phases', [{'type': 'CAPEX', 'amount': '12.5'}, {'type': 'CAPEX', 'amount': ''}, {'type': 'OPEX', 'amount': 'abc', 'phase': ''},
                                                   {'type': 'OPEX', 'amount': 3, 'phase': 'Ops'}, {'type': 'Other', 'amount': 99, 'phase': 'Ops'}]),
        ('empty', []),
    ]
    out = [{'name': n, 'inputs': it, 'expected': cost_rollups(it)} for n, it in items]
    out.append({'name': 'null items: totals 0 (byPhase would throw, not called)', 'inputs': None, 'expected': cost_rollups(None)})
    return out


def example_end_to_end():
    """The worked example data through every module, as the app would."""
    costs = cost_rollups(EXAMPLE_COSTS)
    wells = []
    for w in EXAMPLE_WELLS:
        days = drilling_time(w['md'], w['trajectory'])
        wells.append({'id': w['id'], 'days': days, 'cost': drilling_cost(days, 250000)})
    facilities = []
    for f in EXAMPLE_FACILITIES:
        facilities.append({'id': f['id'], 'capacity': facility_capacity(f), 'cost': facility_cost(f),
                           'flowAssurance': flow_assurance(f, None),
                           'bottlenecks': bottlenecks(f, {'oil': 60000, 'gas': 90000, 'water': 50000})})
    hse = {'matrix': risk_matrix(EXAMPLE_HSE), 'totalScore': total_risk_score(EXAMPLE_HSE), 'byType': by_key(EXAMPLE_HSE, 'type', 'Other')}
    risk = {'consolidatedScore': consolidated_score(EXAMPLE_HSE), 'exposure': risk_exposure(EXAMPLE_HSE),
            'bySource': by_key(EXAMPLE_HSE, 'source', 'Other'), 'byLevel': by_level(EXAMPLE_HSE), 'health': portfolio_health(EXAMPLE_HSE)}
    reserves = aggregate_reserves(EXAMPLE_RESERVOIRS)
    z = {'area': 42, 'thickness': 120, 'porosity': 0.24, 'sw': 0.20, 'bo': 1.25}
    o = ooip(z['area'], z['thickness'], z['porosity'], z['sw'], z['bo'])
    sched = example_schedule()
    scen = run_scenario({'oilPrice': 70, 'discountRate': 10}, {'capex': 1500, 'opex': 65, 'peakProduction': 150})
    sens = fdp_sensitivity(1500, 65, concept_profile({'peakProduction': 150}), [70] * 20)
    return {
        'inputs': {'costs': EXAMPLE_COSTS, 'wells': EXAMPLE_WELLS, 'facilities': EXAMPLE_FACILITIES, 'hseRisks': EXAMPLE_HSE,
                   'reservoirs': EXAMPLE_RESERVOIRS, 'zone': z, 'schedule': sched, 'rigRate': 250000,
                   'peakProduction': {'oil': 60000, 'gas': 90000, 'water': 50000},
                   'scenario': {'oilPrice': 70, 'discountRate': 10}, 'concept': {'capex': 1500, 'opex': 65, 'peakProduction': 150}},
        'expected': {'costs': costs, 'wells': wells, 'wellsByType': wells_by_type(EXAMPLE_WELLS),
                     'totalDrillingCostFromCostField': total_drilling_cost(EXAMPLE_WELLS),
                     'facilities': facilities, 'hse': hse, 'risk': risk, 'reserves': reserves,
                     'ooip': o, 'recoveryFactor': recovery_factor(o, reserves_p50(reserves) * 1e6),
                     'wellCountAt12MMbbl': well_count(reserves_p50(reserves), 12),
                     'schedule': {'milestones': milestones(sched), 'projectDuration': project_duration(sched),
                                  'cpmReference': cpm_reference(sched), 'cpmPassthrough': cpm_passthrough(sched)},
                     'scenario': scen, 'sensitivity': sens},
        'note': 'exampleSchedule carries start and end, not startDate and endDate, so calculateProjectDuration '
                'has no dates to read and reports null (EC6-0; it used to be NaN and the app printed it). '
                'The example HSE risks have no costImpact, so exposure is 0. Reserves are per fluid: '
                '85 MMbbl of oil and 30 Bcf of gas, never 115 of anything.',
    }


def main():
    golden = {
        'description': (
            'FDP Accelerator goldens: the FDP screening case (runFdpCase, MID-YEAR discounting at t + 0.5, '
            'TaxRoyalty terms, one-year straight-line capex), the costCalculations view of it (rows with '
            'discountedCashFlow, NPV, bisection IRR with the 2^20 cap, payback or null), scenario economics with '
            'the concept plateau-and-decline profile and the JS defaulting rules, concept cost and schedule, '
            'subsurface volumetrics (OOIP in STB from acres and ft), well times and costs, facilities capacity '
            'and cost, HSE and risk indices, the schedule (calculateProjectDuration, calculateCPM passthrough '
            'beside a REAL two-pass critical path reference, milestones) and plan completeness and validation. '
            'Independent stdlib oracle tools/validation/economics/oracle_fdp.py. Units: money $MM unless a field '
            'says USD (drilling cost); rates kbpd and $/bbl; percent inputs 0 to 100; irr in percent; payback '
            'and durations in years or days as named. A null where a number is expected is NaN or Infinity in '
            'the engine and the case note says which. Timezone assumption UTC. DISAGREEMENTS are recorded in '
            'the case (irrBeyondEngineClamp, criticalityDisagreements) and pinned in the jest gate.'),
        'fdpCase': fdp_cases(),
        'scenario': scenario_cases(),
        'scenarioRefusals': scenario_refusal_cases(),
        'sensitivity': sensitivity_cases(),
        'concept': concept_cases(),
        'subsurface': subsurface_cases(),
        'wells': well_cases(),
        'facilities': facility_cases(),
        'hse': hse_cases(),
        'risk': risk_cases(),
        'schedule': schedule_cases(),
        'plan': plan_cases(),
        'costItems': cost_cases(),
        'example': example_end_to_end(),
    }
    names = {c['name'] for c in golden['fdpCase']}
    assert set(ENGINE_REPORTED) <= names, 'an engine pin names a case that does not exist'
    assert set(ENGINE_REPORTED_SCENARIO) <= {c['name'] for c in golden['scenario']}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as fh:
        json.dump(clean(golden), fh, indent=1, sort_keys=False)
        fh.write('\n')
    counts = {k: (len(v) if isinstance(v, list) else sum(len(x) for x in v.values()) if isinstance(v, dict) and k != 'example' else 1)
              for k, v in golden.items() if k != 'description'}
    print('wrote', OUT, counts)


if __name__ == '__main__':
    main()
