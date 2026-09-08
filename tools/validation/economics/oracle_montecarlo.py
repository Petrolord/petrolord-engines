#!/usr/bin/env python3
"""Independent oracle for the Economics Monte Carlo layer
(engines/economics/montecarlo.ts, the Suite's epe-mc.ts). Emits the
committed goldens to test-data/economics/goldens/montecarlo_cases.json.

INDEPENDENCE DISCIPLINE. The layer is a sampler over the deterministic
cash flow engine, so the oracle is a sampler over the INDEPENDENT cash
flow oracle (oracle_cashflow.py): every iteration's NPV, IRR and payback
come from that file, never from the TypeScript. The parts that must agree
bit for bit are replicated from their stated formulas and the statement
is made here:

  mulberry32     replicated in uint32 arithmetic (every intermediate
                 masked to 32 bits, Math.imul as a 32-bit product) and
                 divided by 4294967296. The uniform stream is BIT-IDENTICAL
                 to the JavaScript generator for the same seed.

  randomNormal   Box-Muller as the engine states it: u and v redrawn
                 while exactly zero, sqrt(-2 ln u) cos(2 pi v). Python's
                 libm and V8's may differ in the last ulp of log and cos,
                 so transformed draws are gated at 1e-12 relative, not
                 bit for bit; the uniform stream underneath is exact.

  marginals      normal: mean + sd x. lognormal: moment-matched
                 mu = ln(m^2 / sqrt(m^2 + sd^2)), sigma = sqrt(ln(1 +
                 sd^2 / m^2)), exp(mu + sigma x). triangular: inverse CDF
                 at Phi(x) with Phi from Abramowitz and Stegun 7.1.26 erf.
                 uniform: min + Phi(x) (max - min).

  correlation    Gaussian copula: a lower-triangular Cholesky factor L of
                 the correlation matrix, x = L z with z the standard
                 normals drawn IN paramOrder for the variable inputs only
                 (constants draw nothing), one z per variable per sample,
                 n normals before any marginal is applied.

  truncation     a normal or lognormal outside its finite min or max
                 rejects the WHOLE sample and redraws, at most 10 times,
                 each rejection counted.

  price decks    a sampled absolute oil or gas price under a per-year
                 deck is applied as a scale, sample / reference, where the
                 reference is the flat config price or, failing that, the
                 first deck value.

  summaries      computed here from the sample: petroleum-convention
                 percentiles (P90 is the 10th percentile of value, P10 the
                 90th, read as sorted[min(floor(p n), n - 1)]), population
                 standard deviation and its standard error, P(NPV > 0),
                 the running-mean convergence trace every floor(n / 20)
                 iterations, per-year fan bands on nominal annual and
                 cumulative net cash flow, and the tornado: for each
                 varied input, the median NPV of the max(15, floor(n / 10))
                 lowest-input samples against the highest-input samples,
                 ranked by swing. The exported per-iteration sample is
                 re-derived into the same percentiles so the golden proves
                 an auditor can rebuild the headline numbers from the rows.

Units as in oracle_cashflow.py: money USD, prices USD/bbl and USD/Mscf,
scales dimensionless multipliers, irr percent, payback years.

stdlib only. Regenerate:
    python3 tools/validation/economics/oracle_montecarlo.py
"""
import json
import math
import os
import sys

sys.dont_write_bytecode = True  # keep __pycache__ out of the worktree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle_cashflow as cf  # noqa: E402

M32 = 0xFFFFFFFF


def imul(a, b):
    return (a * b) & M32


def mulberry32(seed):
    """Bit-identical replica of the engine's seeded generator in uint32
    arithmetic; the JavaScript int32 views differ only in sign
    interpretation, never in bits."""
    state = [seed & M32]

    def draw():
        a = (state[0] + 0x6D2B79F5) & M32
        state[0] = a
        t = imul(a ^ (a >> 15), a | 1)
        t = ((t + imul(t ^ (t >> 7), t | 61)) ^ t) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296.0
    return draw


def random_normal(rng):
    u = 0.0
    v = 0.0
    while u == 0:
        u = rng()
    while v == 0:
        v = rng()
    return math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)


def erf(x):
    sign = -1 if x < 0 else 1
    ax = abs(x)
    t = 1 / (1 + 0.3275911 * ax)
    y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * math.exp(-ax * ax)
    return sign * y


def normal_cdf(x):
    return 0.5 * (1 + erf(x / math.sqrt(2)))


def tri_inv_cdf(u, a, c, b):
    if a == b:
        return a
    if u <= (c - a) / (b - a):
        return a + math.sqrt(u * (b - a) * (c - a))
    return b - math.sqrt((1 - u) * (b - a) * (b - c))


def cholesky(m):
    n = len(m)
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = sum(L[i][k] * L[j][k] for k in range(j))
            if i == j:
                L[i][j] = math.sqrt(max(m[i][i] - s, 0.0))
            else:
                L[i][j] = 0.0 if L[j][j] == 0 else (1.0 / L[j][j]) * (m[i][j] - s)
    return L


SPREAD = {'triangular', 'normal', 'lognormal', 'uniform'}


def fnum(v):
    """Number(v) for the distribution fields: None -> NaN semantics."""
    if v is None:
        return float('nan')
    try:
        return float(v)
    except (TypeError, ValueError):
        return float('nan')


def is_variable(d):
    if not d or d.get('type') not in SPREAD:
        return False
    if d['type'] in ('triangular', 'uniform'):
        return fnum(d.get('max')) > fnum(d.get('min'))
    return fnum(d.get('stdDev')) > 0


def marginal(d, x):
    t = d['type']
    if t == 'normal':
        return fnum(d['mean']) + fnum(d['stdDev']) * x
    if t == 'lognormal':
        m, sd = fnum(d['mean']), fnum(d['stdDev'])
        mu = math.log(m * m / math.sqrt(m * m + sd * sd))
        sigma = math.sqrt(math.log(1 + sd * sd / (m * m)))
        return math.exp(mu + sigma * x)
    if t == 'triangular':
        return tri_inv_cdf(normal_cdf(x), fnum(d['min']), fnum(d['mode']), fnum(d['max']))
    if t == 'uniform':
        return fnum(d['min']) + normal_cdf(x) * (fnum(d['max']) - fnum(d['min']))
    raise ValueError(t)


def correlated_sampler(inputs, order, correlations, rng):
    keys = [p for p in order if is_variable(inputs.get(p))]
    n = len(keys)
    C = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    for c in correlations or []:
        rho = fnum(c.get('rho'))
        if math.isfinite(rho) and -1 < rho < 1 and c['a'] in keys and c['b'] in keys and c['a'] != c['b']:
            ia, ib = keys.index(c['a']), keys.index(c['b'])
            C[ia][ib] = C[ib][ia] = rho
    L = cholesky(C)

    def sample():
        z = [random_normal(rng) for _ in range(n)]
        values = {}
        truncated = []
        for r in range(n):
            x = sum(L[r][c] * z[c] for c in range(r + 1))
            d = inputs[keys[r]]
            val = marginal(d, x)
            if d['type'] in ('normal', 'lognormal'):
                lo, hi = fnum(d.get('min')), fnum(d.get('max'))
                if (math.isfinite(lo) and val < lo) or (math.isfinite(hi) and val > hi):
                    truncated.append(keys[r])
            values[keys[r]] = val
        return values, truncated
    return keys, sample


MC_KEYS = ['oil_price', 'gas_price', 'capex_scale', 'opex_scale', 'production_scale']


def scale_prod(rows, s):
    if s == 1:
        return rows
    out = []
    for r in rows:
        o = dict(r)
        for k in r:
            nk = cf.norm_key(k)
            if any(nk.endswith(suf) or nk in bare for _, suf, bare in cf.STREAMS):
                o[k] = cf.num_or_zero(r[k]) * s if cf.num(r[k]) is not None else float('nan')
        out.append(o)
    return out


def scale_usd(rows, s):
    if s == 1:
        return rows
    out = []
    for r in rows:
        o = dict(r)
        for k in r:
            if str(k).strip().lower().endswith('_usd'):
                o[k] = cf.num_or_zero(r[k]) * s if cf.num(r[k]) is not None else float('nan')
        out.append(o)
    return out


def pmean(xs):
    return sum(xs) / len(xs)


def pstd(xs):
    if len(xs) < 2:
        return 0.0
    m = pmean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))


def pmedian(xs):
    s = sorted(xs)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 == 1 else (s[mid - 1] + s[mid]) / 2


def basic_stats(data):
    if not data:
        return {}
    s = sorted(data)
    n = len(s)
    q = lambda p: s[min(int(math.floor(p * n)), n - 1)]
    step = max(1, n // 100)
    cdf = [{'x': s[i], 'y': i / n * 100} for i in range(0, n, step)] + [{'x': s[-1], 'y': 100}]
    return {'p90': q(0.1), 'p50': q(0.5), 'p10': q(0.9), 'mean': pmean(s), 'min': s[0], 'max': s[-1], 'stdDev': pstd(s), 'cdf': cdf}


def tornado(samples, fraction=0.1):
    if len(samples) < 30:
        return []
    outputs = [s['targetVol'] for s in samples]
    base = pmedian(outputs)
    n = len(samples)
    k = max(15, int(math.floor(n * fraction)))
    swings = []
    for param in samples[0]['inputs']:
        vals = [s['inputs'][param] for s in samples]
        if not all(math.isfinite(v) for v in vals) or pstd(vals) == 0:
            continue
        ordered = sorted(samples, key=lambda s: s['inputs'][param])
        low = pmedian([s['targetVol'] for s in ordered[:k]])
        high = pmedian([s['targetVol'] for s in ordered[n - k:]])
        swings.append({'parameter': param, 'base': base, 'low': min(low, high), 'high': max(low, high),
                       'lowInputVol': low, 'highInputVol': high})
    swings.sort(key=lambda w: -(w['high'] - w['low']))
    return swings


def run_mc(cfg, prod, capex, opex, mc):
    iterations = max(100, min(5000, int(round(mc.get('iterations', 1000)))))
    seed = int(mc['seed'])
    rng = mulberry32(seed)
    inputs = {k: mc.get('variables', {})[k] for k in MC_KEYS if mc.get('variables', {}).get(k)}
    keys, sample = correlated_sampler(inputs, MC_KEYS, mc.get('correlations', []), rng)
    base = cf.compute(cfg, prod, capex, opex)
    years = [r['year'] for r in base['cashFlowData']]
    deck = cf.parse_deck(cfg)

    npvs, irrs, paybacks = [], [], []
    irr_null = pay_null = rejects = 0
    conv = []
    step = max(1, iterations // 20)
    fan_ncf = [[] for _ in years]
    fan_cum = [[] for _ in years]
    tsamples, rows = [], []
    for i in range(iterations):
        values, trunc = sample()
        retries = 0
        while trunc and retries < 10:
            rejects += 1
            values, trunc = sample()
            retries += 1
        icfg = dict(cfg)
        if 'oil_price' in values:
            if deck['oil']:
                ref = cf.num_or_zero(cfg.get('oil_price_usd_bbl')) or deck['oil'][0][1] or 1
                icfg['oil_price_scale'] = values['oil_price'] / ref
            else:
                icfg['oil_price_usd_bbl'] = values['oil_price']
        if 'gas_price' in values:
            if deck['gas']:
                ref = cf.num_or_zero(cfg.get('gas_price_usd_mscf')) or deck['gas'][0][1] or 1
                icfg['gas_price_scale'] = values['gas_price'] / ref
            else:
                icfg['gas_price_usd_mscf'] = values['gas_price']
        res = cf.compute(icfg, scale_prod(prod, values.get('production_scale', 1)),
                         scale_usd(capex, values.get('capex_scale', 1)), scale_usd(opex, values.get('opex_scale', 1)))
        k = res['kpis']
        npvs.append(k['npv'])
        if k['irr'] is None:
            irr_null += 1
        else:
            irrs.append(k['irr'])
        if k['payback_years'] is None:
            pay_null += 1
        else:
            paybacks.append(k['payback_years'])
        if (i + 1) % step == 0 or i == iterations - 1:
            conv.append({'n': i + 1, 'mean': pmean(npvs)})
        for y in range(len(years)):
            row = res['cashFlowData'][y] if y < len(res['cashFlowData']) else None
            fan_ncf[y].append(row['net_cash_flow'] if row else 0.0)
            fan_cum[y].append(row['cumulative_nominal'] if row else 0.0)
        tsamples.append({'targetVol': k['npv'], 'inputs': dict(values)})
        rows.append({'i': i + 1, 'inputs': dict(values), 'npv': k['npv'], 'irr': k['irr'], 'payback': k['payback_years']})

    def year_stats(series):
        out = []
        for y, year in enumerate(years):
            s = sorted(series[y])
            q = lambda p: s[min(int(math.floor(p * len(s))), len(s) - 1)]
            out.append({'year': year, 'p90': q(0.1), 'p50': q(0.5), 'p10': q(0.9), 'mean': pmean(s)})
        return out

    return {
        'iterations': iterations, 'seed': seed, 'varKeys': keys,
        'base': {'npv': base['kpis']['npv'], 'irr': base['kpis']['irr'], 'fiscal_framework': base['kpis']['fiscal_framework'],
                 'pv_basis': base['kpis']['pv_basis']},
        'npv': {**basic_stats(npvs), 'se': pstd(npvs) / math.sqrt(len(npvs))},
        'probNpvPositive': sum(1 for x in npvs if x > 0) / len(npvs),
        'irr': {**basic_stats(irrs), 'nullShare': irr_null / iterations},
        'payback': {**basic_stats(paybacks), 'neverShare': pay_null / iterations},
        'convergence': conv,
        'fan': {'ncf': year_stats(fan_ncf), 'cumulative': year_stats(fan_cum)},
        'tornado': tornado(tsamples),
        'diagnostics': {'truncationRejects': rejects},
        'samples': rows,
    }


def rederive(samples):
    """What an auditor does with the exported rows: rebuild the headline
    percentiles and the undefined-run shares from the sample itself."""
    npvs = sorted(r['npv'] for r in samples)
    n = len(npvs)
    q = lambda p: npvs[min(int(math.floor(p * n)), n - 1)]
    return {'p90': q(0.1), 'p50': q(0.5), 'p10': q(0.9),
            'irr_null_share': sum(1 for r in samples if r['irr'] is None) / n,
            'payback_never_share': sum(1 for r in samples if r['payback'] is None) / n,
            'prob_npv_positive': sum(1 for r in samples if r['npv'] > 0) / n}


def build():
    jv3_prod = [{'year': 2030 + i, 'well1_oil_bbl': 1_000_000 * 0.9 ** i} for i in range(3)]
    jv3_opex = [{'year': 2030 + i, 'total_opex_usd': 10_000_000} for i in range(3)]
    mixed_prod = [{'year': 2025, 'w_oil_bbl': 5_000_000, 'w_gas_mscf': 30_000_000, 'w_condensate_bbl': 300_000}]
    mixed_capex = [{'year': 2025, 'amount_usd': 200_000_000}]
    mixed_opex = [{'year': 2025, 'total_opex_usd': 100_000_000}]
    specs = [
        ('degenerate_constant', 'No uncertain variable: the sampler draws nothing, every iteration reproduces the deterministic NPV 135,185,570.34 exactly, stdDev 0, P(NPV > 0) = 1, empty tornado.',
         cf.PIA_CFG, cf.PIA_PROD, cf.PIA_CAPEX, cf.PIA_OPEX, {'iterations': 100, 'seed': 1, 'variables': {}}),
        ('iterations_clamp_low', 'A 3-iteration request clamps to 100 (the floor); otherwise the degenerate case.',
         cf.PIA_CFG, cf.PIA_PROD, cf.PIA_CAPEX, cf.PIA_OPEX, {'iterations': 3, 'seed': 1, 'variables': {}}),
        ('seeded_triangular_oil_price', 'Seeded reproducibility case: triangular oil price 60/80/110 on the PIA worked example, seed 42, 100 iterations; the full sample is exported so the percentiles can be re-derived.',
         cf.PIA_CFG, cf.PIA_PROD, cf.PIA_CAPEX, cf.PIA_OPEX,
         {'iterations': 100, 'seed': 42, 'variables': {'oil_price': {'type': 'triangular', 'min': 60, 'mode': 80, 'max': 110}}}),
        ('correlated_four_dists_jv', 'Three-year JV field, all four spread types with a truncated normal, two correlations through the Gaussian copula, seed 7: exercises the draw order, Cholesky, truncation retries, multi-year fan bands and a four-bar tornado.',
         cf.JV_CFG, jv3_prod, cf.JV_CAPEX, jv3_opex,
         {'iterations': 100, 'seed': 7, 'variables': {
             'oil_price': {'type': 'normal', 'mean': 100, 'stdDev': 15, 'min': 75, 'max': 125},
             'capex_scale': {'type': 'triangular', 'min': 0.8, 'mode': 1.0, 'max': 1.4},
             'opex_scale': {'type': 'uniform', 'min': 0.9, 'max': 1.15},
             'production_scale': {'type': 'lognormal', 'mean': 1.0, 'stdDev': 0.15}},
          'correlations': [{'a': 'oil_price', 'b': 'production_scale', 'rho': 0.5}, {'a': 'capex_scale', 'b': 'opex_scale', 'rho': 0.3}]}),
        ('deck_scaled_oil_price', 'Per-year oil deck 100 then 90 with a sampled absolute price 70/100/130: the sample applies as a scale on the deck against the flat reference 100.',
         {**cf.JV_CFG, 'price_deck': [{'year': 2030, 'oil': 100}, {'year': 2031, 'oil': 90}]}, cf.JV_PROD, cf.JV_CAPEX, cf.JV_OPEX,
         {'iterations': 100, 'seed': 3, 'variables': {'oil_price': {'type': 'triangular', 'min': 70, 'mode': 100, 'max': 130}}}),
        ('gas_and_oil_price_pia_mixed', 'PIA mixed streams with a normal gas price and a uniform oil price, seed 11: the second variable in paramOrder draws second.',
         cf.PIA_CFG, mixed_prod, mixed_capex, mixed_opex,
         {'iterations': 100, 'seed': 11, 'variables': {'oil_price': {'type': 'uniform', 'min': 60, 'max': 100},
                                                        'gas_price': {'type': 'normal', 'mean': 4.5, 'stdDev': 0.8}}}),
        ('constant_and_ignored_variables', 'A constant distribution and a zero-width triangular are not variables: varKeys holds only the real spread, and the constant does not consume the RNG stream.',
         cf.JV_CFG, cf.JV_PROD, cf.JV_CAPEX, cf.JV_OPEX,
         {'iterations': 100, 'seed': 5, 'variables': {'oil_price': {'type': 'constant', 'value': 100},
                                                       'capex_scale': {'type': 'triangular', 'min': 1.0, 'mode': 1.0, 'max': 1.0},
                                                       'opex_scale': {'type': 'triangular', 'min': 0.8, 'mode': 1.0, 'max': 1.3}}}),
    ]
    cases = []
    for name, note, cfg, prod, capex, opex, mc in specs:
        res = run_mc(cfg, prod, capex, opex, mc)
        cases.append({'name': name, 'note': note, 'cfg': cfg, 'prodRows': prod, 'capexRows': capex, 'opexRows': opex,
                      'mcConfig': mc, 'expected': res, 'rederived_from_samples': rederive(res['samples'])})

    # Primitive pins: the uniform stream (bit-identical), Box-Muller draws,
    # erf, Phi and the triangular inverse on fixed arguments.
    prims = {}
    for seed in (0, 1, 42, 123, 2 ** 31 - 1, 4294967295):
        rng = mulberry32(seed)
        prims['mulberry32_seed_%d' % seed] = [rng() for _ in range(64)]
    rng = mulberry32(42)
    prims['randomNormal_seed_42'] = [random_normal(rng) for _ in range(64)]
    prims['erf'] = {str(x): erf(x) for x in (-3, -1.5, -0.2, 0, 0.7, 1.9, 3.4)}
    prims['normalCDF'] = {str(x): normal_cdf(x) for x in (-3, -1.5, -0.2, 0, 0.7, 1.9, 3.4)}
    prims['triInvCDF_10_25_60'] = {str(u): tri_inv_cdf(u, 10, 25, 60) for u in (0.01, 0.3, 0.5, 0.77, 0.99)}
    prims['cholesky'] = cholesky([[1, 0.6, 0.2], [0.6, 1, -0.3], [0.2, -0.3, 1]])
    prims['marginals'] = [{'dist': d, 'x': x, 'value': marginal(d, x)}
                          for d in ({'type': 'normal', 'mean': 100, 'stdDev': 15}, {'type': 'lognormal', 'mean': 50, 'stdDev': 20},
                                    {'type': 'triangular', 'min': 10, 'mode': 25, 'max': 60}, {'type': 'uniform', 'min': 5, 'max': 9})
                          for x in (-2.5, -1, 0, 0.5, 2.2)]

    return {
        'description': (
            'Economics Monte Carlo goldens for engines/economics/montecarlo.ts (the Suite epe-mc.ts, extracted EC0 2026-09-08). Emitted by '
            'the independent stdlib oracle tools/validation/economics/oracle_montecarlo.py, which replicates mulberry32 bit for bit in uint32 '
            'arithmetic (divide by 4294967296), Box-Muller normals, the Gaussian-copula correlated sampler in paramOrder '
            '[oil_price, gas_price, capex_scale, opex_scale, production_scale], the truncation retry rule and the deck-as-scale price rule, and '
            'runs every iteration through the independent cash flow oracle (oracle_cashflow.py). Every reported summary is computed here: '
            'petroleum-convention percentiles (P90 low), population stdDev and standard error, P(NPV > 0), IRR and payback distributions with '
            'their undefined shares, the running-mean convergence trace, nominal fan bands and the decile tornado; `rederived_from_samples` '
            'rebuilds the headline percentiles from the exported rows. `primitives` pins the uniform stream and the transforms on fixed '
            'arguments. Units: money USD, prices USD/bbl and USD/Mscf, scales dimensionless, irr percent, payback years.'
        ),
        'cases': cases,
        'primitives': prims,
    }


def main():
    golden = build()
    path = os.path.join(cf.ROOT, 'test-data', 'economics', 'goldens', 'montecarlo_cases.json')
    with open(path, 'w') as f:
        json.dump(golden, f, indent=1, sort_keys=True, allow_nan=False)
        f.write('\n')
    print('wrote %s: %d cases' % (path, len(golden['cases'])))
    for c in golden['cases']:
        e = c['expected']
        print('  %-32s npv p90/p50/p10 %.2f / %.2f / %.2f  P(>0) %.2f  rejects %d  tornado %s' % (
            c['name'], e['npv']['p90'], e['npv']['p50'], e['npv']['p10'], e['probNpvPositive'],
            e['diagnostics']['truncationRejects'], [t['parameter'] for t in e['tornado']]))


if __name__ == '__main__':
    main()
