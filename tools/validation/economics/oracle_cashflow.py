#!/usr/bin/env python3
"""Independent oracle for the Economics cash flow engine
(engines/economics/cashflow.ts, the Suite's EPE engine v3.9.0). Emits the
committed goldens to test-data/economics/goldens/cashflow_cases.json.

INDEPENDENCE DISCIPLINE. This file is written from the METHOD STATEMENTS
the engine documents in its header and in the Suite's docs/scope/EPE.md
(sections 3, 3b to 3g, 5, 6 and 7), from the hand derivations in the
Suite's validation harness (tools/validation/epe-validation.ts) and from
the published rules those statements cite (PIA 2021 Seventh Schedule
royalties, Sixth Schedule production allowance, CITA capital allowance
restriction, NTA 2025 Development Levy). It was NOT written by transcribing
the TypeScript. Where the engine iterates, this file solves differently:

  IRR         the engine runs Newton from 10 percent and falls back to
              bisection. The oracle SCANS the bracket [-0.99, 10] on a
              0.001 grid for the first sign change of NPV(r) and BISECTS
              that bracket to a width of 1e-13. No derivative is used.
              On a multiple-root profile the oracle reports the SMALLEST
              root; the engine reports whichever root Newton reaches.

  breakeven   the engine bisects the flat oil price to a 0.001 USD/bbl
              bracket and returns its midpoint. The oracle bisects the
              same price to a 1e-9 bracket, so the engine's answer is the
              oracle's to within 0.0005 USD/bbl by construction.

  NPV         year-end discounting from the valuation year (mid-year adds
              0.5 to the exponent) on a real or nominal basis. The real
              discount rate is the Fisher relation (1 + nominal) / (1 +
              inflation) - 1 and the real cash flow deflates by
              (1 + inflation) ^ (year - base_year). Summed in year order.

  cash flows  every fiscal line is computed from the method statement in
              its own function, one per regime, with the state that
              carries between years (PSC unrecovered pool, PSC ITC, PIA
              CPR carryforward, PIA prior-year opex, PIA lifetime liquids,
              the three tax-loss pools) threaded explicitly.

  summaries   every KPI the engine reports is computed here, including
              government take (nominal and discounted), unit technical
              cost, opex per boe, PV capex, DPI, numeric and discounted
              payback, the NPV profile, the NGN mirrors and the
              diagnostics (economic limit year, CPR forfeiture, unused
              losses, sunk cash flow). A summary the oracle never computed
              is a summary nobody checked.

Where the engine and the oracle legitimately disagree, the golden carries
BOTH numbers under `disagreements`, with the method statement that decides
it, and the engine's published number is what the jest gate pins for the
engine. See tools/validation/economics/FINDINGS-cashflow.md.

Units: money USD, oil and condensate bbl, gas Mscf, percent inputs 0 to 100,
rates in the output as percent where the engine reports percent (irr,
government take, discount_rate_applied_pct) and as fractions nowhere.

stdlib only. Regenerate:
    python3 tools/validation/economics/oracle_cashflow.py
"""
import json
import math
import os
import re

ENGINE_VERSION = '3.9.0'
GAS_MSCF_PER_BOE = 6.0


# ---------------------------------------------------------------------
# Row ingestion (EPE.md section 3.2, v3.3 ingestion rules)
# ---------------------------------------------------------------------

def norm_key(k):
    return re.sub(r'[\s-]+', '_', str(k).strip().lower())


def norm_rows(rows):
    return [{norm_key(k): v for k, v in r.items()} for r in (rows or [])]


def num(v):
    """JavaScript Number() semantics for the values a CSV row can carry:
    None and '' are not numbers, numeric strings are, NaN is not."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    s = str(v).strip()
    if s == '':
        return 0.0  # Number('') === 0
    try:
        f = float(s)
    except ValueError:
        return None
    return f if math.isfinite(f) else None


def num_or_zero(v):
    f = num(v)
    return 0.0 if f is None else f


STREAMS = [
    ('oil_bbl', '_oil_bbl', ['oil_bbl', 'oil_volume_bbl', 'oil_prod_bbl']),
    ('gas_mscf', '_gas_mscf', ['gas_mscf', 'gas_volume_mscf', 'gas_prod_mscf']),
    ('condensate_bbl', '_condensate_bbl', ['condensate_bbl', 'cond_bbl']),
    ('water_bbl', '_water_bbl', ['water_bbl', 'water_prod_bbl']),
]
CAPEX_COLS = ['amount_usd', 'cost_usd', 'capex_usd', 'total_capex_usd', 'value_usd']
OPEX_COLS = ['total_opex_usd', 'opex_usd', 'cost_usd', 'amount_usd']


def stream_columns(keys, suffix, bare):
    """Per-well suffix columns win (total_* rollups excluded to avoid double
    counting); else the first bare alias present; else the total_ rollup."""
    per_well = [k for k in keys if k.endswith(suffix) and not k.startswith('total_')]
    if per_well:
        return per_well
    for b in bare:
        if b in keys:
            return [b]
    if 'total' + suffix in keys:
        return ['total' + suffix]
    return []


def volume_columns(prod_rows):
    out = {f: [] for f, _, _ in STREAMS}
    if not prod_rows:
        return out
    keys = list(norm_rows([prod_rows[0]])[0].keys())
    for f, suffix, bare in STREAMS:
        out[f] = stream_columns(keys, suffix, bare)
    return out


def usd_columns(rows, preferred):
    if not rows:
        return []
    keys = list(norm_rows([rows[0]])[0].keys())
    pref = [k for k in keys if k in preferred]
    if pref:
        return pref
    return [k for k in keys if k.endswith('_usd') and not k.startswith('total_')]


def row_year(row, base_year):
    if row.get('year') is not None:
        try:
            return int(float(str(row['year']).strip()))
        except ValueError:
            return None
    if row.get('date'):
        m = re.match(r'\s*(\d{4})', str(row['date']))
        return int(m.group(1)) if m else None
    if row.get('month_index') is not None:
        try:
            mi = int(float(str(row['month_index'])))
        except ValueError:
            return None
        return base_year + (mi - 1) // 12
    return None


def annual_volumes(prod_rows, base_year):
    rows = norm_rows(prod_rows)
    if not rows:
        return []
    cols = volume_columns(prod_rows)
    by_year = {}
    for r in rows:
        y = row_year(r, base_year)
        if y is None:
            continue
        a = by_year.setdefault(y, {'year': y, 'oil_bbl': 0.0, 'gas_mscf': 0.0, 'condensate_bbl': 0.0, 'water_bbl': 0.0})
        for f in cols:
            a[f] += sum(num_or_zero(r.get(c)) for c in cols[f])
    return [by_year[y] for y in sorted(by_year)]


def annual_usd(rows, base_year, preferred, label):
    out = {}
    for r in norm_rows(rows):
        y = row_year(r, base_year)
        if y is None:
            continue
        populated = []
        for c in preferred:
            if c in r and r[c] is not None:
                f = num(r[c])
                if f is not None and f != 0:
                    populated.append(c)
        if len({num(r[c]) for c in populated}) > 1:
            raise ValueError(
                'Ingestion validation failed: %s: a row has multiple cost columns populated with different values (%s). '
                'Keep exactly one cost column per row so the amount is unambiguous.' % (label, ', '.join(populated)))
        amt = num(r[populated[0]]) if populated else 0.0
        if amt == 0:
            amt = sum(num_or_zero(r[k]) for k in r
                      if k.endswith('_usd') and k not in preferred and not k.startswith('total_'))
        out[y] = out.get(y, 0.0) + amt
    return out


# ---------------------------------------------------------------------
# Prices (v3.6 decks, escalators, differentials, scale hooks)
# ---------------------------------------------------------------------

DECK_KEYS = {'oil': ['oil', 'oil_price_usd_bbl'], 'gas': ['gas', 'gas_price_usd_mscf'],
             'condensate': ['condensate', 'cond', 'condensate_price_usd_bbl']}


def parse_deck(cfg):
    out = {'oil': [], 'gas': [], 'condensate': []}
    deck = cfg.get('price_deck')
    if not isinstance(deck, list):
        return out
    for raw in deck:
        if not isinstance(raw, dict):
            continue
        try:
            year = int(float(str(raw.get('year'))))
        except (TypeError, ValueError):
            continue
        for stream, keys in DECK_KEYS.items():
            for k in keys:
                v = raw.get(k)
                if v is None or v == '':
                    continue
                f = num(v)
                if f is not None:
                    out[stream].append((year, f))
                    break
    for s in out:
        out[s].sort(key=lambda e: e[0])
    return out


def stream_price(entries, flat, esc, base_year, year, diff=0.0, scale=1.0):
    """Step-hold between deck entries, first value before the first entry,
    last value escalated beyond the last entry; no deck: flat escalated from
    base_year. Differential after resolution, scale last, floor at 0."""
    if not entries:
        base = flat * (1 + esc) ** (year - base_year)
    elif year <= entries[0][0]:
        base = entries[0][1]
    else:
        held = entries[0]
        for e in entries:
            if e[0] <= year:
                held = e
            else:
                break
        if held[0] == entries[-1][0] and year > held[0]:
            base = held[1] * (1 + esc) ** (year - held[0])
        else:
            base = held[1]
    return max(0.0, (base + diff) * scale)


# ---------------------------------------------------------------------
# PIA 2021 rate schedules (Seventh Schedule royalties, HCT rates)
# ---------------------------------------------------------------------

def framework_of(cfg):
    ov = cfg.get('pia_under_nta_2025_override') or 'auto'
    if ov == 'force_pia':
        return 'pia_only'
    if ov == 'force_nta':
        return 'nta_2025'
    return 'nta_2025' if (cfg.get('base_year') if cfg.get('base_year') is not None else 2027) >= 2026 else 'pia_only'


def oil_royalty_rate(terrain, bopd):
    """Production royalty by terrain and daily rate. Marginal fields blend
    5 percent on the first 5,000 bopd, 7.5 percent on the next 5,000 and 15
    percent above 10,000 (volume-weighted average rate on the whole)."""
    if terrain == 'onshore':
        return 0.15
    if terrain == 'shallow_water':
        return 0.125
    if terrain == 'deep_offshore':
        return 0.075 if bopd > 50000 else 0.05
    if terrain == 'frontier':
        return 0.075
    if terrain == 'marginal_field':
        if bopd <= 5000:
            return 0.05
        if bopd <= 10000:
            return (5000 * 0.05 + (bopd - 5000) * 0.075) / bopd
        return (5000 * 0.05 + 5000 * 0.075 + (bopd - 10000) * 0.15) / bopd
    return 0.15


def gas_royalty_rate(terrain):
    return 0.05 if terrain in ('deep_offshore', 'frontier') else 0.07


def price_royalty_rate(price, year, terrain):
    """Price-based royalty: 0 at or below the 50 USD anchor, linear to 5
    percent at 100 and to 10 percent at 150, every anchor escalated 2
    percent a year from 2021. Frontier is exempt."""
    if terrain == 'frontier':
        return 0.0
    esc = 1.02 ** (year - 2021)
    lo, mid, hi = 50 * esc, 100 * esc, 150 * esc
    if price <= lo:
        return 0.0
    if price >= hi:
        return 0.10
    if price <= mid:
        return 0.05 * (price - lo) / (mid - lo)
    return 0.05 + 0.05 * (price - mid) / (hi - mid)


def hct_rate(cfg, framework):
    ov = cfg.get('pia_hct_rate_override_pct')
    if ov is not None:
        return ov / 100.0
    terrain = cfg.get('pia_terrain')
    if terrain == 'frontier':
        return 0.0
    if terrain == 'deep_offshore':
        if framework == 'pia_only':
            return 0.0
        interp = cfg.get('pia_deep_offshore_hct_interpretation') or 'conservative_zero'
        if interp == 'aggressive_pml_30':
            return 0.30
        if interp == 'custom':
            return (cfg.get('pia_deep_offshore_hct_custom_rate_pct') or 0) / 100.0
        return 0.0
    if cfg.get('pia_marginal_field_pre_2021'):
        return 0.15
    if cfg.get('pia_license_type') == 'PPL':
        return 0.15
    return 0.30


def production_allowance(cfg, liquids_bbl, price, prior_cum):
    """Per-bbl allowance is the lesser of the fixed USD/bbl for the lease
    status and the percent-of-price ceiling. New leases carry the Sixth
    Schedule lifetime volume cap by terrain; a year that crosses the cap
    earns the allowance on the eligible barrels only."""
    if liquids_bbl <= 0:
        return 0.0, 0.0, False
    per_bbl = min(cfg['pia_production_allowance_pct_of_price'] / 100.0 * price,
                  cfg['pia_production_allowance_per_bbl_new'] if cfg.get('pia_lease_status') == 'new'
                  else cfg['pia_production_allowance_per_bbl_converted'])
    if cfg.get('pia_lease_status') != 'new':
        return per_bbl * liquids_bbl, liquids_bbl, False
    terrain = cfg.get('pia_terrain')
    if terrain == 'onshore':
        cap = cfg.get('pia_new_lease_prod_alw_cap_onshore_bbl', 50_000_000)
    elif terrain in ('shallow_water', 'marginal_field'):
        cap = cfg.get('pia_new_lease_prod_alw_cap_shallow_bbl', 100_000_000)
    elif terrain in ('deep_offshore', 'frontier'):
        cap = cfg.get('pia_new_lease_prod_alw_cap_deep_bbl', 500_000_000)
    else:
        cap = 50_000_000
    if cap is None:
        cap = {'onshore': 50_000_000, 'shallow_water': 100_000_000, 'marginal_field': 100_000_000}.get(terrain, 500_000_000)
    room = max(0.0, cap - prior_cum)
    if room == 0:
        return 0.0, 0.0, True
    if liquids_bbl <= room:
        return per_bbl * liquids_bbl, liquids_bbl, False
    return per_bbl * room, room, True


def loss_relief(pool, chargeable, on):
    """A negative year banks its loss; a positive year offsets the pool.
    Returns (tax base, offset used, pool after)."""
    if not on:
        return chargeable, 0.0, 0.0
    if chargeable < 0:
        return 0.0, 0.0, pool - chargeable
    used = min(pool, chargeable)
    return chargeable - used, used, pool - used


# ---------------------------------------------------------------------
# Regimes
# ---------------------------------------------------------------------

def fiscal_jv(gross, capex, opex, depr, wi, roy, tax_rate, loss_pool, relief_on):
    g, o, c, d = gross * wi, opex * wi, capex * wi, depr * wi
    royalty = g * roy
    taxable = g - royalty - o - d
    base, used, pool = loss_relief(loss_pool, taxable, relief_on)
    tax = max(0.0, base * tax_rate)
    return {'royalty': royalty, 'taxable_income': taxable, 'tax': tax,
            'net_cash_flow': g - royalty - o - c - tax,
            'loss_offset_used': used, 'loss_carryforward': pool}


def fiscal_psc(gross, capex, opex, carry, roy, cap_pct, share, tax_rate, itc_avail):
    royalty = gross * roy
    after_roy = gross - royalty
    recoverable = carry + capex + opex
    recovery = min(recoverable, after_roy * cap_pct)
    profit_oil = after_roy - recovery
    contractor = profit_oil * share
    tax0 = max(0.0, contractor * tax_rate)
    itc_used = min(itc_avail, tax0)
    tax = tax0 - itc_used
    return {'royalty': royalty, 'taxable_income': contractor, 'tax': tax,
            'net_cash_flow': recovery + contractor - tax - capex - opex,
            'carry_after': recoverable - recovery,
            'itc_used': itc_used, 'itc_carry_after': itc_avail - itc_used}


def tranche_share(tranches, cum_bbl):
    if not isinstance(tranches, list) or not tranches:
        return None
    rows = []
    for t in tranches:
        try:
            rows.append((float(t['from_cum_mmbbl']), float(t['contractor_share_pct'])))
        except (KeyError, TypeError, ValueError):
            pass
    if not rows:
        return None
    rows.sort()
    share = rows[0][1]
    for frm, s in rows:
        if frm <= cum_bbl / 1e6:
            share = s
        else:
            break
    return share / 100.0


def fiscal_pia(year, vols, price, gross, liq_rev, capex, opex, cap_allow, nddc, cfg, st, framework):
    terrain = cfg.get('pia_terrain')
    bopd = vols['oil_bbl'] / 365.0
    gas_rev = gross - liq_rev
    oil_rr = oil_royalty_rate(terrain, bopd)
    prod_roy = liq_rev * oil_rr + gas_rev * gas_royalty_rate(terrain)
    price_roy = liq_rev * price_royalty_rate(price, year, terrain)
    total_roy = prod_roy + price_roy

    hcdt = 0.03 * st['prior_opex'] if st['prior_opex'] > 0 else 0.0

    # Cost price ratio: opex (and the carried pool) claim before capital
    # allowance, everything above the cap defers to next year.
    cpr_cap = gross * cfg['pia_cpr_limit_pct'] / 100.0
    pool = st['cpr_carry'] + opex + cap_allow
    claimed = min(pool, cpr_cap)
    deferred = pool - claimed
    opex_claimed = min(opex + st['cpr_carry'], claimed)
    ca_claimed = claimed - opex_claimed

    # HCT on crude and condensate profits only: liquids revenue less the
    # liquids production royalty and the price royalty in full, less the
    # liquids revenue share of the shared deductions.
    gas_in_hct = cfg.get('pia_hct_include_gas_revenue') is True
    share = 1.0 if gas_in_hct else (liq_rev / gross if gross > 0 else 0.0)
    hct_assessable = ((gross if gas_in_hct else liq_rev)
                      - (total_roy if gas_in_hct else liq_rev * oil_rr + price_roy)
                      - opex_claimed * share - hcdt * share)
    allowance, eligible, capped = production_allowance(
        cfg, vols['oil_bbl'] + vols['condensate_bbl'], price, st['cum_liquids'])
    hct_chargeable = hct_assessable - ca_claimed * share - allowance
    relief_on = cfg.get('apply_loss_carryforward') is not False
    hct_base, hct_used, hct_pool = loss_relief(st['hct_loss'], hct_chargeable, relief_on)
    hct_tax = max(0.0, hct_base * hct_rate(cfg, framework))

    # CIT on all profits; capital allowance restricted to two thirds of the
    # assessable profit (CITA capital allowance restriction).
    cit_assessable = gross - total_roy - opex_claimed - hcdt - nddc
    cit_ca = min(ca_claimed, max(0.0, cit_assessable * 2 / 3))
    cit_chargeable = cit_assessable - cit_ca
    cit_base, cit_used, cit_pool = loss_relief(st['cit_loss'], cit_chargeable, relief_on)
    cit_tax = max(0.0, cit_base * cfg['pia_cit_rate_pct'] / 100.0)

    # TET under PIA-only, Development Levy under NTA: same assessable base,
    # no loss relief on either.
    tet = dev = 0.0
    if framework == 'pia_only':
        tet = max(0.0, cit_assessable * cfg['pia_tet_rate_pct'] / 100.0)
    else:
        dev_rate = cfg.get('pia_development_levy_rate_pct')
        dev = max(0.0, cit_assessable * (4.0 if dev_rate is None else dev_rate) / 100.0)
    total_tax = hct_tax + cit_tax + tet + dev
    net = gross - total_roy - opex - hcdt - nddc - total_tax - capex

    row = {
        'production_royalty': prod_roy, 'price_royalty': price_roy, 'royalty': total_roy,
        'hcdt': hcdt, 'nddc': nddc,
        'hct_assessable_profit': hct_assessable, 'production_allowance': allowance,
        'hct_chargeable_profit': hct_chargeable, 'hct_tax': hct_tax,
        'cit_assessable_profit': cit_assessable, 'cit_chargeable_profit': cit_chargeable, 'cit_tax': cit_tax,
        'tet_tax': tet, 'dev_levy_tax': dev, 'tax': total_tax,
        'taxable_income': hct_chargeable + cit_chargeable,
        'cpr_cap': cpr_cap, 'cpr_costs_claimed': claimed, 'cpr_deferred_to_next': deferred,
        'net_cash_flow': net,
        'fiscal_framework': framework,
        'prod_alw_cap_applied': capped, 'prod_alw_eligible_bbl': eligible,
        'hct_loss_offset_used': hct_used, 'cit_loss_offset_used': cit_used,
        'hct_loss_carryforward': hct_pool, 'cit_loss_carryforward': cit_pool,
    }
    new_state = {'cpr_carry': deferred, 'prior_opex': opex,
                 'cum_liquids': st['cum_liquids'] + vols['oil_bbl'] + vols['condensate_bbl'],
                 'hct_loss': hct_pool, 'cit_loss': cit_pool}
    return row, new_state


# ---------------------------------------------------------------------
# Financial metrics
# ---------------------------------------------------------------------

def npv_of(flows, rate):
    return sum(cf / (1 + rate) ** i for i, cf in enumerate(flows))


def _first_root(flows, a, b, step, f_a):
    """First sign change of NPV(r) walking from a towards b in `step`
    increments (negative step walks down), bisected to 1e-13."""
    n = int(round(abs(b - a) / abs(step)))
    for k in range(1, n + 1):
        r = a + k * step
        f = npv_of(flows, r)
        if f == 0:
            return r
        if (f_a < 0) != (f < 0):
            lo, hi = (r - step, r) if step > 0 else (r, r - step)
            f_lo = npv_of(flows, lo)
            while hi - lo > 1e-13:
                m = (lo + hi) / 2
                fm = npv_of(flows, m)
                if fm == 0:
                    return m
                if (f_lo < 0) != (fm < 0):
                    hi = m
                else:
                    lo, f_lo = m, fm
            return (lo + hi) / 2
        f_a = f
    return None


def irr_of(flows):
    """Root of NPV(r) = 0 NEAREST ZERO, positive side first: a 0.001 grid
    scan upward from 0 to 10 for the first sign change, else downward from
    0 to -0.99, each bracket bisected to 1e-13. The hurdle-rate comparison
    an IRR exists for lives near the origin, so on a profile with several
    roots (two sign changes in the flows) the root nearest zero on the
    positive side is the one reported; the engine's Newton from 10 percent
    reports whichever root it converges to, which the golden pins where the
    two differ. None without a sign change in the flows or in the bracket."""
    if not any(cf < 0 for cf in flows) or not any(cf > 0 for cf in flows):
        return None
    f0 = npv_of(flows, 0.0)
    if f0 == 0:
        return 0.0
    up = _first_root(flows, 0.0, 10.0, 0.001, f0)
    if up is not None:
        return up
    return _first_root(flows, 0.0, -0.99, -0.001, f0)


def payback_of(flows):
    cum = 0.0
    for i, cf in enumerate(flows):
        prev = cum
        cum += cf
        if prev < 0 <= cum:
            return i + (-prev / cf)
    return 0.0 if cum >= 0 else None


def payback_label(flows):
    """A crossing year reports its fractional year; no crossing reports
    'Year 0' when the cumulative never went negative, else beyond life."""
    p = payback_of(flows)
    if p is None:
        return 'Beyond project life'
    if p == 0:
        return 'Year 0'
    return '%.2f years' % p


# ---------------------------------------------------------------------
# The cash flow model
# ---------------------------------------------------------------------

def pct(cfg, key, default=0.0):
    v = cfg.get(key)
    if v is None:
        return default
    f = num(v)
    return default if f is None else f


def compute(cfg, prod_rows, capex_rows, opex_rows):
    if not prod_rows:
        raise ValueError('No production data found. Upload and process a CSV first.')
    framework = framework_of(cfg)
    base_year = cfg.get('base_year') or 2027
    infl = pct(cfg, 'inflation_rate_pct') / 100.0
    esc_default = pct(cfg, 'inflation_rate_pct')
    oil_esc = pct(cfg, 'oil_price_escalator_pct', esc_default) / 100.0
    gas_esc = pct(cfg, 'gas_price_escalator_pct', esc_default) / 100.0
    cond_esc = pct(cfg, 'condensate_price_escalator_pct', esc_default) / 100.0
    opex_esc = pct(cfg, 'opex_escalator_pct', esc_default) / 100.0
    capex_esc = pct(cfg, 'capex_escalator_pct', 0.0) / 100.0

    basis = cfg.get('present_value_basis') or 'real'
    nominal_rate = num_or_zero(cfg.get('discount_rate_pct')) / 100.0
    real_rate = (1 + nominal_rate) / (1 + infl) - 1
    disc = real_rate if basis == 'real' else nominal_rate
    mid_year = cfg.get('discounting_convention') == 'mid_year'
    vy = num(cfg.get('valuation_year')) if cfg.get('valuation_year') not in (None, '') else None
    valuation_year = int(vy) if vy is not None and vy > 0 else base_year
    sunk_cutoff = valuation_year if cfg.get('treat_prior_as_sunk') is True else None

    def dexp(year):
        return (year - valuation_year) + (0.5 if mid_year else 0.0)

    deck = parse_deck(cfg)
    diffs = (pct(cfg, 'oil_price_differential_usd_bbl'), pct(cfg, 'gas_price_differential_usd_mscf'),
             pct(cfg, 'condensate_price_differential_usd_bbl'))
    scales = tuple(pct(cfg, k, 1.0) or 1.0 for k in ('oil_price_scale', 'gas_price_scale', 'condensate_price_scale'))
    flat = (num_or_zero(cfg.get('oil_price_usd_bbl')), num_or_zero(cfg.get('gas_price_usd_mscf')),
            num_or_zero(cfg.get('condensate_price_usd_bbl')))

    def prices(year):
        return (stream_price(deck['oil'], flat[0], oil_esc, base_year, year, diffs[0], scales[0]),
                stream_price(deck['gas'], flat[1], gas_esc, base_year, year, diffs[1], scales[1]),
                stream_price(deck['condensate'], flat[2], cond_esc, base_year, year, diffs[2], scales[2]))

    regime = cfg.get('fiscal_regime')
    if regime == 'PIA':
        wi = max(0.0, min(1.0, pct(cfg, 'pia_working_interest_pct', 100.0) / 100.0))
    elif regime == 'PSC':
        wi = max(0.0, min(1.0, pct(cfg, 'psc_working_interest_pct', 100.0) / 100.0))
    else:
        wi = 1.0

    vols = annual_volumes(prod_rows, base_year)
    capex = annual_usd(capex_rows, base_year, CAPEX_COLS, 'CAPEX file')
    opex = annual_usd(opex_rows, base_year, OPEX_COLS, 'OPEX file')

    shift = cfg.get('schedule_shift_years')
    shift = int(float(shift)) if shift not in (None, '') else 0
    if shift:
        for v in vols:
            v['year'] += shift
        opex = {y + shift: a for y, a in opex.items()}

    validate(cfg, prod_rows, capex_rows, opex_rows, vols, capex, opex, deck)

    years = sorted(set([v['year'] for v in vols] + list(capex) + list(opex)))
    vol_by_year = {v['year']: v for v in vols}
    zero = {'oil_bbl': 0.0, 'gas_mscf': 0.0, 'condensate_bbl': 0.0, 'water_bbl': 0.0}

    def opex_in(year):
        return opex.get(year, 0.0) * (1 + opex_esc) ** (year - base_year)

    # Economic limit: trailing years whose net operating income (revenue less
    # the regime's royalty burden less escalated opex) is negative are trimmed.
    elt_year = None
    trimmed = 0
    if cfg.get('apply_economic_limit') is True:
        def noi(year):
            v = vol_by_year.get(year)
            rev = roy = 0.0
            if v:
                po, pg, pc = prices(year)
                liq = v['oil_bbl'] * po + v['condensate_bbl'] * pc
                gas = v['gas_mscf'] * pg
                rev = liq + gas
                if regime == 'PIA':
                    t = cfg.get('pia_terrain')
                    roy = liq * (oil_royalty_rate(t, v['oil_bbl'] / 365.0) + price_royalty_rate(po, year, t)) + gas * gas_royalty_rate(t)
                elif regime == 'PSC':
                    roy = rev * pct(cfg, 'psc_royalty_pct') / 100.0
                else:
                    roy = rev * pct(cfg, 'jv_royalty_pct') / 100.0
            return rev - roy - opex_in(year)
        while len(years) > 1 and noi(years[-1]) < 0:
            years.pop()
            trimmed += 1
        elt_year = years[-1]

    abex = num_or_zero(cfg.get('abandonment_cost_usd'))
    abex_year = None
    if abex > 0 and years:
        req = num(cfg.get('abandonment_year')) if cfg.get('abandonment_year') not in (None, '') else None
        abex_year = int(req) if req is not None and req > 0 else years[-1]
        if abex_year not in years:
            years = sorted(years + [abex_year])
    sinking = cfg.get('abandonment_funding_mode') == 'sinking_fund' and abex > 0 and abex_year is not None
    fund = {}
    if sinking:
        req = num(cfg.get('abandonment_fund_start_year')) if cfg.get('abandonment_fund_start_year') not in (None, '') else None
        start = min(int(req), abex_year) if req is not None and req > 0 else years[0]
        fund_years = [y for y in years if start <= y <= abex_year]
        for y in fund_years:
            fund[y] = abex / max(1, len(fund_years))

    # Depreciation / capital allowance schedules from the capex year.
    is_pia = regime == 'PIA'
    if is_pia:
        life = cfg.get('pia_capex_recovery_years') or 5
    else:
        life = max(1, int(round(pct(cfg, 'jv_psc_depr_years', 10.0) or 10.0)))
    ppt = cfg.get('depreciation_method') == 'nigeria_ppt' and not is_pia
    depr = {}
    capex_in = {}
    for y, amt in capex.items():
        inflated = amt * (1 + capex_esc) ** (y - base_year)
        capex_in[y] = inflated
        if ppt:
            for i, p in enumerate([0.20, 0.20, 0.20, 0.20, 0.19]):
                depr[y + i] = depr.get(y + i, 0.0) + inflated * p
        else:
            for yy in range(y, y + life):
                depr[yy] = depr.get(yy, 0.0) + inflated / life

    rows = []
    cum_nom = cum_real = 0.0
    psc_carry = psc_itc = 0.0
    psc_cum = pct(cfg, 'psc_prior_cumulative_liquids_bbl', 0.0)
    jv_loss = 0.0
    relief_on = cfg.get('apply_loss_carryforward') is not False
    pia_state = {'cpr_carry': 0.0, 'prior_opex': pct(cfg, 'pia_prior_year_opex_usd', 0.0),
                 'cum_liquids': pct(cfg, 'pia_prior_cumulative_oil_bbl', 0.0), 'hct_loss': 0.0, 'cit_loss': 0.0}

    for year in years:
        t = year - base_year
        v = vol_by_year.get(year, zero)
        cx = capex_in.get(year, 0.0)
        ox = opex_in(year)
        dp = depr.get(year, 0.0)
        po, pg, pc = prices(year)
        oil_rev, gas_rev, cond_rev = v['oil_bbl'] * po, v['gas_mscf'] * pg, v['condensate_bbl'] * pc
        gross = oil_rev + gas_rev + cond_rev
        liq_rev = oil_rev + cond_rev
        row = {'year': year, 'gross_revenue': gross, 'revenue': gross, 'opex': ox, 'capex': cx, 'depreciation': dp,
               'oil_bbl': v['oil_bbl'], 'gas_mscf': v['gas_mscf'], 'condensate_bbl': v['condensate_bbl'],
               'applied_oil_price': po, 'applied_gas_price': pg, 'applied_cond_price': pc}
        contrib = fund.get(year, 0.0)

        if regime == 'PIA':
            fixed = cfg.get('pia_nddc_levy_fixed_usd')
            nddc = num_or_zero(fixed) if fixed is not None else ox * pct(cfg, 'pia_nddc_levy_pct_of_opex', 3.0) / 100.0
            pia, pia_state = fiscal_pia(year, v, po, gross, liq_rev, cx, ox, dp, nddc, cfg, pia_state, framework)
            if contrib > 0:
                # Sinking-fund contribution deducts in the HCT base (liquids
                # share) and the CIT base outside the CPR machinery; the saving
                # cannot exceed the tax actually charged. Levy bases unaffected.
                share = liq_rev / gross if gross > 0 else 0.0
                eff_hct = pia['hct_tax'] / pia['hct_chargeable_profit'] if pia['hct_chargeable_profit'] > 0 and pia['hct_tax'] > 0 else 0.0
                hct_saving = min(pia['hct_tax'], contrib * share * eff_hct) if pia['hct_chargeable_profit'] > 0 else 0.0
                cit_saving = min(pia['cit_tax'], contrib * pct(cfg, 'pia_cit_rate_pct', 30.0) / 100.0)
                pia['hct_tax'] -= hct_saving
                pia['cit_tax'] -= cit_saving
                pia['tax'] -= hct_saving + cit_saving
                pia['net_cash_flow'] += hct_saving + cit_saving - contrib
                row['decom_fund_contribution'] = contrib
                row['decom_fund_tax_relief'] = hct_saving + cit_saving
            if cfg.get('pia_apply_minimum_etr') is True:
                etr = (pct(cfg, 'pia_minimum_etr_pct', 15.0) or 15.0) / 100.0
                floor = max(0.0, pia['cit_assessable_profit'] * etr)
                paid = pia['hct_tax'] + pia['cit_tax'] + pia['tet_tax'] + pia['dev_levy_tax']
                if paid < floor:
                    pia['tax'] += floor - paid
                    pia['net_cash_flow'] -= floor - paid
                    row['min_etr_topup'] = floor - paid
            row.update(pia)
            row['cumulative_oil_bbl_lifetime'] = pia_state['cum_liquids']
            net = pia['net_cash_flow']
        elif regime == 'PSC':
            share = None
            if cfg.get('psc_profit_split_mode') == 'tranches':
                share = tranche_share(cfg.get('psc_profit_tranches'), psc_cum)
            if share is None:
                share = num_or_zero(cfg.get('psc_contractor_profit_share_pct')) / 100.0
            itc_year = pct(cfg, 'psc_itc_pct', 0.0) / 100.0 * cx
            out = fiscal_psc(gross, cx, ox + contrib, psc_carry, num_or_zero(cfg.get('psc_royalty_pct')) / 100.0,
                             num_or_zero(cfg.get('psc_cost_oil_cap_pct')) / 100.0, share,
                             num_or_zero(cfg.get('psc_tax_rate_pct')) / 100.0, psc_itc + itc_year)
            psc_carry, psc_itc = out['carry_after'], out['itc_carry_after']
            psc_cum += v['oil_bbl'] + v['condensate_bbl']
            row.update({k: out[k] for k in ('royalty', 'taxable_income', 'tax', 'net_cash_flow')})
            row['psc_contractor_share_pct'] = share * 100
            if itc_year > 0 or out['itc_used'] > 0:
                row['psc_itc_used'] = out['itc_used']
                row['psc_itc_carryforward'] = out['itc_carry_after']
            if contrib > 0:
                row['decom_fund_contribution'] = contrib
            net = out['net_cash_flow']
        else:
            out = fiscal_jv(gross, cx, ox + contrib, dp, num_or_zero(cfg.get('jv_working_interest_pct')) / 100.0,
                            num_or_zero(cfg.get('jv_royalty_pct')) / 100.0, num_or_zero(cfg.get('jv_tax_rate_pct')) / 100.0,
                            jv_loss, relief_on)
            jv_loss = out['loss_carryforward']
            row.update(out)
            if contrib > 0:
                row['decom_fund_contribution'] = contrib
            net = out['net_cash_flow']

        if wi != 1:
            for k in WI_KEYS:
                if k in row and isinstance(row[k], (int, float)) and not isinstance(row[k], bool):
                    row[k] *= wi
            net *= wi
            row['working_interest_pct'] = wi * 100
        if abex_year is not None and year == abex_year:
            if sinking:
                row['abandonment_cost_funded'] = abex
            else:
                net -= abex
                row['abandonment_cost'] = abex
                row['net_cash_flow'] = net
        row['netCashFlow'] = row['net_cash_flow']
        real_cf = net / (1 + infl) ** t
        cum_nom += net
        cum_real += real_cf
        row['real_net_cash_flow'] = real_cf
        row['discounted_cash_flow'] = (real_cf if basis == 'real' else net) / (1 + disc) ** dexp(year)
        row['cumulative_cash_flow'] = cum_real if basis == 'real' else cum_nom
        row['cumulative_nominal'] = cum_nom
        row['cumulative_real'] = cum_real
        if sunk_cutoff is not None and year < sunk_cutoff:
            row['sunk'] = True
        rows.append(row)

    forfeited = 0.0
    if regime == 'PIA' and pia_state['cpr_carry'] > 0 and rows:
        forfeited = pia_state['cpr_carry'] * wi
        rows[-1]['cpr_forfeited_at_cessation'] = forfeited
    unused_losses = (pia_state['hct_loss'] + pia_state['cit_loss'] if regime == 'PIA'
                     else (0.0 if regime == 'PSC' else jv_loss)) * wi

    ev = [r for r in rows if not r.get('sunk')]
    flows = [r['net_cash_flow'] for r in ev]
    npv = sum(r['discounted_cash_flow'] for r in ev)
    irr = irr_of(flows)
    tot = lambda k: sum(r.get(k, 0.0) or 0.0 for r in ev)
    k = {
        'engine_version': ENGINE_VERSION, 'npv': npv, 'irr': irr * 100 if irr is not None else None,
        'payback': payback_label(flows), 'pv_basis': basis, 'discount_rate_applied_pct': disc * 100,
        'fiscal_regime': regime, 'fiscal_framework': framework,
        'discounting_convention': 'mid_year' if mid_year else 'end_year',
        'total_revenue': tot('gross_revenue'), 'total_capex': tot('capex'), 'total_opex': tot('opex'),
        'total_tax': tot('tax'), 'total_net_cash_flow_nominal': tot('net_cash_flow'),
        'total_net_cash_flow_real': tot('real_net_cash_flow'),
        'total_net_cash_flow': tot('real_net_cash_flow') if basis == 'real' else tot('net_cash_flow'),
    }
    if valuation_year != base_year or sunk_cutoff is not None:
        k['valuation_year'] = valuation_year
    if sunk_cutoff is not None:
        k['sunk_net_cash_flow'] = sum(r['net_cash_flow'] for r in rows if r.get('sunk'))
    if wi != 1:
        k['working_interest_pct'] = wi * 100
    elif regime == 'JV':
        k['working_interest_pct'] = pct(cfg, 'jv_working_interest_pct', 100.0)
    oil_t, gas_t, cond_t = tot('oil_bbl'), tot('gas_mscf'), tot('condensate_bbl')
    boe = oil_t + cond_t + gas_t / GAS_MSCF_PER_BOE
    abex_total = abex if abex_year is not None else 0.0
    k.update({'total_oil_bbl': oil_t, 'total_gas_mscf': gas_t, 'total_condensate_bbl': cond_t, 'total_boe': boe})
    if abex_total > 0:
        k['total_abandonment_cost'] = abex_total
        k['abandonment_year'] = abex_year
    if cfg.get('apply_economic_limit') is True:
        k['economic_limit_year'] = elt_year
        k['years_trimmed_by_economic_limit'] = trimmed
    if unused_losses > 0:
        k['tax_losses_unused_at_cessation'] = unused_losses
    if shift:
        k['schedule_shift_years'] = shift
    topup = tot('min_etr_topup')
    if topup > 0:
        k['total_min_etr_topup'] = topup
    contribs = tot('decom_fund_contribution')
    if contribs > 0:
        k['total_decom_fund_contributions'] = contribs
        k['abandonment_funding_mode'] = 'sinking_fund'
    fx = num(cfg.get('fx_ngn_per_usd'))
    if fx is not None and fx > 0:
        k['fx_ngn_per_usd'] = fx
        k['npv_ngn'] = npv * fx
        k['total_revenue_ngn'] = k['total_revenue'] * fx
        k['total_tax_ngn'] = k['total_tax'] * fx
        k['total_net_cash_flow_ngn'] = k['total_net_cash_flow'] * fx
    k['unit_technical_cost_usd_per_boe'] = (k['total_capex'] + k['total_opex'] + abex_total) / boe if boe > 0 else None
    k['opex_usd_per_boe'] = k['total_opex'] / boe if boe > 0 else None
    pre_take = k['total_revenue'] - k['total_capex'] - k['total_opex'] - abex_total
    k['government_take_pct'] = (pre_take - k['total_net_cash_flow_nominal']) / pre_take * 100 if pre_take > 0 else None

    def pv(nominal, year):
        on_basis = nominal / (1 + infl) ** (year - base_year) if basis == 'real' else nominal
        return on_basis / (1 + disc) ** dexp(year)
    pv_pre = sum(pv(r['gross_revenue'] - r['capex'] - r['opex'] - r.get('abandonment_cost', 0.0), r['year']) for r in ev)
    pv_con = sum(r['discounted_cash_flow'] for r in ev)
    k['government_take_pct_discounted'] = (pv_pre - pv_con) / pv_pre * 100 if pv_pre > 0 else None

    def npv_at(rate_pct):
        r = rate_pct / 100.0
        return sum((row['net_cash_flow'] / (1 + infl) ** (row['year'] - base_year) if basis == 'real' else row['net_cash_flow'])
                   / (1 + r) ** dexp(row['year']) for row in ev)
    # Standard rate vector plus the applied rate, which by the method
    # statement makes the profile pass through the headline NPV.
    profile_rates = sorted(set([0, 5, 8, 10, 12, 15, 20] + [disc * 100]))
    k['npv_profile'] = [{'rate_pct': rp, 'npv': npv_at(rp)} for rp in profile_rates]
    pv_capex = sum(pv(r['capex'], r['year']) for r in ev)
    k['pv_capex'] = pv_capex
    k['dpi'] = npv / pv_capex if pv_capex > 0 else None
    k['payback_years'] = payback_of(flows)
    k['discounted_payback_years'] = payback_of([r['discounted_cash_flow'] for r in ev])
    if regime == 'PIA':
        for kk, src in (('total_royalties', 'royalty'), ('total_hct', 'hct_tax'), ('total_cit', 'cit_tax'),
                        ('total_tet', 'tet_tax'), ('total_dev_levy', 'dev_levy_tax'), ('total_hcdt', 'hcdt'),
                        ('total_nddc', 'nddc'), ('total_production_allowance', 'production_allowance')):
            k[kk] = tot(src)
        if forfeited > 0:
            k['cpr_forfeited_at_cessation'] = forfeited
    return {'cashFlowData': rows, 'kpis': k}


WI_KEYS = [
    'gross_revenue', 'revenue', 'opex', 'capex', 'depreciation', 'oil_bbl', 'gas_mscf', 'condensate_bbl',
    'royalty', 'production_royalty', 'price_royalty', 'hcdt', 'nddc',
    'hct_assessable_profit', 'production_allowance', 'hct_chargeable_profit', 'hct_tax',
    'cit_assessable_profit', 'cit_chargeable_profit', 'cit_tax', 'tet_tax', 'dev_levy_tax', 'tax', 'taxable_income',
    'cpr_cap', 'cpr_costs_claimed', 'cpr_deferred_to_next', 'hct_loss_offset_used', 'cit_loss_offset_used',
    'hct_loss_carryforward', 'cit_loss_carryforward', 'min_etr_topup', 'decom_fund_contribution',
    'decom_fund_tax_relief', 'psc_itc_used', 'psc_itc_carryforward', 'net_cash_flow',
]


def validate(cfg, prod_rows, capex_rows, opex_rows, vols, capex, opex, deck):
    issues = []
    cols = volume_columns(prod_rows)
    headers = lambda rows: ', '.join(norm_rows([rows[0]])[0].keys()) if rows else '(none)'
    if not (cols['oil_bbl'] or cols['gas_mscf'] or cols['condensate_bbl']):
        issues.append('Production file: no oil/gas/condensate volume columns recognized. Headers found: %s. '
                      'Expected per-well columns ending in _oil_bbl / _gas_mscf / _condensate_bbl, or bare oil_bbl / gas_mscf / condensate_bbl.' % headers(prod_rows))
    elif not vols:
        issues.append('Production file: no row had a usable date. Provide a "year", "date" (YYYY-MM or YYYY-MM-DD), or "month_index" column.')
    if capex_rows:
        if not usd_columns(capex_rows, CAPEX_COLS):
            issues.append('CAPEX file: no cost column recognized. Headers found: %s. Expected one of %s (or any *_usd column).' % (headers(capex_rows), ' / '.join(CAPEX_COLS)))
        elif not capex:
            issues.append('CAPEX file: no row had a usable date (need "year", "date", or "month_index").')
    if opex_rows:
        if not usd_columns(opex_rows, OPEX_COLS):
            issues.append('OPEX file: no cost column recognized. Headers found: %s. Expected one of %s (or any *_usd column).' % (headers(opex_rows), ' / '.join(OPEX_COLS)))
        elif not opex:
            issues.append('OPEX file: no row had a usable date (need "year", "date", or "month_index").')
    tot = {k: sum(v[k] for v in vols) for k in ('oil_bbl', 'gas_mscf', 'condensate_bbl')}
    unset = lambda v: v is None or v == '' or num(v) is None
    if tot['oil_bbl'] > 0 and unset(cfg.get('oil_price_usd_bbl')) and not deck['oil']:
        issues.append('Oil price (oil_price_usd_bbl) is not set but the production data has oil volumes.')
    if tot['gas_mscf'] > 0 and unset(cfg.get('gas_price_usd_mscf')) and not deck['gas']:
        issues.append('Gas price (gas_price_usd_mscf) is not set but the production data has gas volumes.')
    if tot['condensate_bbl'] > 0 and unset(cfg.get('condensate_price_usd_bbl')) and not deck['condensate']:
        issues.append('Condensate price (condensate_price_usd_bbl) is not set but the production data has condensate volumes.')
    if issues:
        raise ValueError('Ingestion validation failed: ' + ' | '.join(issues))


def breakeven_oil_price(cfg, prod, capex, opex, lo=0.5, hi=500.0):
    """Flat oil price at which NPV = 0, bisected to a 1e-9 bracket. None with
    an oil deck, or when NPV(lo) >= 0 or NPV(hi) < 0."""
    if parse_deck(cfg)['oil']:
        return None
    f = lambda p: compute({**cfg, 'oil_price_usd_bbl': p}, prod, capex, opex)['kpis']['npv']
    a, b = lo, hi
    if f(a) >= 0 or f(b) < 0:
        return None
    while b - a > 1e-9:
        m = (a + b) / 2
        if f(m) < 0:
            a = m
        else:
            b = m
    return (a + b) / 2


# ---------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
FIXTURE = json.load(open(os.path.join(ROOT, 'test-data', 'economics', 'fixtures', 'pia-worked-example.json')))
PIA_CFG = FIXTURE['cfg']
PIA_PROD, PIA_CAPEX, PIA_OPEX = FIXTURE['prodRows'], FIXTURE['capexRows'], FIXTURE['opexRows']

JV_CFG = {
    'fiscal_regime': 'JV', 'base_year': 2030,
    'oil_price_usd_bbl': 100, 'gas_price_usd_mscf': 0, 'condensate_price_usd_bbl': 0,
    'discount_rate_pct': 10, 'inflation_rate_pct': 0,
    'oil_price_escalator_pct': 0, 'gas_price_escalator_pct': 0, 'condensate_price_escalator_pct': 0,
    'opex_escalator_pct': 0, 'capex_escalator_pct': 0, 'present_value_basis': 'nominal',
    'jv_working_interest_pct': 100, 'jv_royalty_pct': 20, 'jv_tax_rate_pct': 50,
}
JV_PROD = [{'year': 2030, 'well1_oil_bbl': 1_000_000}, {'year': 2031, 'well1_oil_bbl': 1_000_000}]
JV_CAPEX = [{'year': 2030, 'amount_usd': 50_000_000}]
JV_OPEX = [{'year': 2030, 'total_opex_usd': 10_000_000}, {'year': 2031, 'total_opex_usd': 10_000_000}]

PSC_CFG = {**JV_CFG, 'fiscal_regime': 'PSC', 'psc_royalty_pct': 10, 'psc_cost_oil_cap_pct': 40,
           'psc_contractor_profit_share_pct': 50, 'psc_tax_rate_pct': 50}
for _k in ('jv_working_interest_pct', 'jv_royalty_pct', 'jv_tax_rate_pct'):
    PSC_CFG.pop(_k)
PSC_CAPEX = [{'year': 2030, 'amount_usd': 80_000_000}]

ALAOMA_CFG = {**JV_CFG, 'base_year': 2027, 'oil_price_usd_bbl': 75, 'gas_price_usd_mscf': 4.5,
              'condensate_price_usd_bbl': 70, 'jv_royalty_pct': 10}
ALAOMA_PROD = [
    {'date': '2027-01', 'days_in_month': 31, 'oil_rate_bopd': 3225.8, 'oil_bbl': 100_000, 'liquid_bbl': 120_000, 'water_bbl': 20_000, 'watercut_pct': 16.7},
    {'date': '2027-02', 'days_in_month': 28, 'oil_rate_bopd': 3214.3, 'oil_bbl': 90_000, 'liquid_bbl': 115_000, 'water_bbl': 25_000, 'watercut_pct': 21.7},
]
ALAOMA_CAPEX = [
    {'date': '2027-01', 'category': 'Drilling', 'item': 'Well A1', 'cost_usd': 30_000_000, 'basis_note': 'AFE'},
    {'date': '2027-06', 'category': 'Facilities', 'item': 'Flowline', 'cost_usd': 10_000_000, 'basis_note': 'estimate'},
]
ALAOMA_OPEX = [
    {'date': '2027-01', 'fixed_opex_usd': 500_000, 'variable_oil_usd': 200_000, 'variable_water_usd': 50_000, 'total_opex_usd': 750_000, 'oil_bbl_basis': 100_000, 'unit_opex_usd_per_bbl': 7.5},
    {'date': '2027-02', 'fixed_opex_usd': 500_000, 'variable_oil_usd': 180_000, 'variable_water_usd': 60_000, 'total_opex_usd': 740_000, 'oil_bbl_basis': 90_000, 'unit_opex_usd_per_bbl': 8.2},
]

# A six-year declining field with oil, gas and condensate, 3 percent
# inflation, 2 percent price escalators, 4 percent opex escalator, 1 percent
# capex escalator, PIA shallow-water converted lease, base year 2025 so the
# framework is PIA-only. Real basis by default.
MULTI_PROD = [{'year': 2025 + i, 'w1_oil_bbl': 6_000_000 * 0.8 ** i, 'w1_gas_mscf': 9_000_000 * 0.85 ** i,
               'w1_condensate_bbl': 400_000 * 0.8 ** i} for i in range(6)]
MULTI_CAPEX = [{'year': 2025, 'amount_usd': 400_000_000}, {'year': 2026, 'amount_usd': 120_000_000}]
MULTI_OPEX = [{'year': 2025 + i, 'total_opex_usd': 90_000_000 - 8_000_000 * i} for i in range(6)]
MULTI_CFG = {**PIA_CFG, 'inflation_rate_pct': 3, 'oil_price_escalator_pct': 2, 'gas_price_escalator_pct': 2,
             'condensate_price_escalator_pct': 2, 'opex_escalator_pct': 4, 'capex_escalator_pct': 1,
             'pia_nddc_levy_fixed_usd': None, 'pia_prior_year_opex_usd': 0}


def case(name, cfg, prod, capex, opex, note=''):
    return {'name': name, 'note': note, 'cfg': cfg, 'prodRows': prod, 'capexRows': capex, 'opexRows': opex,
            'expected': compute(cfg, prod, capex, opex)}


def error_case(name, cfg, prod, capex, opex, contains):
    try:
        compute(cfg, prod, capex, opex)
    except ValueError as e:
        assert contains in str(e), (name, str(e))
        return {'name': name, 'cfg': cfg, 'prodRows': prod, 'capexRows': capex, 'opexRows': opex,
                'error_contains': contains, 'oracle_message': str(e)}
    raise AssertionError('expected %s to fail' % name)


def build():
    cases = [
        case('pia_worked_example', PIA_CFG, PIA_PROD, PIA_CAPEX, PIA_OPEX,
             'Published PIA 2021 worked example; NPV 135,185,570.34 USD (EPE.md section 7 regression contract).'),
        case('jv_analytic_decision_kpis', JV_CFG, JV_PROD, JV_CAPEX, JV_OPEX,
             'Hand-derived JV: royalty 20M, tax 32.5M, net -12.5M then +37.5M, NPV 21,590,909.09, IRR 200 percent, payback 1.33 years, UTC 35, opex/boe 10, take 105/130.'),
        case('psc_carryforward', PSC_CFG, JV_PROD, PSC_CAPEX, JV_OPEX,
             'Hand-derived PSC: 36M cost oil cap binds, 54M carried, year 2 consumes 36M of it; contractor profit oil 27M both years.'),
        case('nta_switch_force_pia', {**PIA_CFG, 'pia_under_nta_2025_override': 'force_pia'}, PIA_PROD, PIA_CAPEX, PIA_OPEX,
             'Worked example under force_pia: TET 2.5 percent, zero dev levy.'),
        case('nta_switch_force_nta', {**PIA_CFG, 'pia_under_nta_2025_override': 'force_nta'}, PIA_PROD, PIA_CAPEX, PIA_OPEX,
             'Worked example under force_nta: Development Levy 4 percent on the same assessable base, zero TET; dev levy = 1.6 x TET.'),
        case('nta_auto_by_base_year', {**PIA_CFG, 'base_year': 2026}, [{'year': 2026, 'well1_oil_bbl': 18_250_000}],
             [{'year': 2026, 'amount_usd': 300_000_000}], [{'year': 2026, 'total_opex_usd': 182_500_000}],
             'Same volumes in 2026 with override auto: the date trigger selects nta_2025 (price royalty anchors escalate one more year).'),
        case('allowance_cap_midyear', {**PIA_CFG, 'pia_lease_status': 'new', 'pia_prior_cumulative_oil_bbl': 99_000_000},
             [{'year': 2025, 'well1_oil_bbl': 2_000_000}, {'year': 2026, 'well1_oil_bbl': 1_000_000}],
             [{'year': 2025, 'amount_usd': 50_000_000}],
             [{'year': 2025, 'total_opex_usd': 20_000_000}, {'year': 2026, 'total_opex_usd': 20_000_000}],
             'New shallow-water lease at 99 MMbbl crosses the 100 MMbbl cap: 1 MMbbl eligible at 8 USD/bbl, then zero.'),
        case('cpr_forfeiture', dict(PIA_CFG), [{'year': 2025, 'well1_oil_bbl': 1_000_000}],
             [{'year': 2025, 'amount_usd': 100_000_000}], [{'year': 2025, 'total_opex_usd': 40_000_000}],
             'CPR cap 52M on 80M gross, 60M recoverable, 8M deferred and forfeited at cessation.'),
        case('elt_off_tail_kept', JV_CFG, JV_PROD + [{'year': 2032, 'well1_oil_bbl': 10_000}], JV_CAPEX,
             JV_OPEX + [{'year': 2032, 'total_opex_usd': 10_000_000}], 'Economic limit off by default: the 2032 tail (1M revenue vs 10M opex) is kept.'),
        case('elt_tail_trimmed', {**JV_CFG, 'apply_economic_limit': True}, JV_PROD + [{'year': 2032, 'well1_oil_bbl': 10_000}], JV_CAPEX,
             JV_OPEX + [{'year': 2032, 'total_opex_usd': 10_000_000}], 'Economic limit on: 2032 trimmed, limit year 2031.'),
        case('elt_royalty_tail', {**JV_CFG, 'apply_economic_limit': True},
             [{'year': 2030, 'well1_oil_bbl': 1_000_000}, {'year': 2031, 'well1_oil_bbl': 120_000}], JV_CAPEX, JV_OPEX,
             'Tail year 12M revenue, 9.6M after 20 percent royalty, below 10M opex: trimmed on net operating income.'),
        case('elt_pia_multiyear', {**MULTI_CFG, 'apply_economic_limit': True},
             MULTI_PROD + [{'year': 2031, 'w1_oil_bbl': 100_000, 'w1_gas_mscf': 200_000, 'w1_condensate_bbl': 5_000}],
             MULTI_CAPEX, MULTI_OPEX + [{'year': 2031, 'total_opex_usd': 40_000_000}],
             'PIA economic limit: the 2031 tail fails the royalty-netted test under escalated prices and opex.'),
        case('abandonment_final_year', {**JV_CFG, 'abandonment_cost_usd': 10_000_000}, JV_PROD, JV_CAPEX, JV_OPEX,
             'Post-tax 10M lump sum in the final modeled year, tax unchanged, NPV falls by 10M/1.1.'),
        case('abandonment_appended_year', {**JV_CFG, 'abandonment_cost_usd': 10_000_000, 'abandonment_year': 2033}, JV_PROD, JV_CAPEX, JV_OPEX,
             'Abandonment year beyond the data appends a zero-revenue 2033 row carrying the outflow.'),
        case('jv_loss_carryforward', JV_CFG, [{'year': 2030, 'well1_oil_bbl': 0}, {'year': 2031, 'well1_oil_bbl': 1_000_000}],
             JV_CAPEX, [{'year': 2031, 'total_opex_usd': 10_000_000}],
             'Loss year banks 5M (depreciation with no revenue), offsets year 2: tax 30M, net 40M.'),
        case('jv_loss_carryforward_killswitch', {**JV_CFG, 'apply_loss_carryforward': False},
             [{'year': 2030, 'well1_oil_bbl': 0}, {'year': 2031, 'well1_oil_bbl': 1_000_000}], JV_CAPEX, [{'year': 2031, 'total_opex_usd': 10_000_000}],
             'Kill switch: clamp at zero, year 2 tax 32.5M.'),
        case('jv_loss_unused_at_cessation', JV_CFG, [{'year': 2030, 'well1_oil_bbl': 0}], JV_CAPEX, [],
             'Single loss year: 5M of losses reported unused at cessation; no IRR, no payback, take null.'),
        case('pia_loss_relief', {**PIA_CFG, 'base_year': 2025}, [{'year': 2025, 'well1_oil_bbl': 500_000}, {'year': 2026, 'well1_oil_bbl': 5_000_000}],
             [{'year': 2025, 'amount_usd': 100_000_000}], [{'year': 2025, 'total_opex_usd': 60_000_000}, {'year': 2026, 'total_opex_usd': 40_000_000}],
             'PIA loss year on both HCT and CIT bases, separate pools offset year 2; TET base untouched.'),
        case('pia_loss_relief_killswitch', {**PIA_CFG, 'base_year': 2025, 'apply_loss_carryforward': False},
             [{'year': 2025, 'well1_oil_bbl': 500_000}, {'year': 2026, 'well1_oil_bbl': 5_000_000}],
             [{'year': 2025, 'amount_usd': 100_000_000}], [{'year': 2025, 'total_opex_usd': 60_000_000}, {'year': 2026, 'total_opex_usd': 40_000_000}],
             'Same PIA case with the clamp: year 2 pays the full HCT and CIT.'),
        case('alaoma_csv_ingestion', ALAOMA_CFG, ALAOMA_PROD, ALAOMA_CAPEX, ALAOMA_OPEX,
             'Bare oil_bbl, cost_usd capex, YYYY-MM dates, extra unpriced columns: revenue 190,000 x 75, capex 40M, opex 1.49M.'),
        case('case_insensitive_headers', ALAOMA_CFG, [{'Date': '2027-01', 'Oil_BBL': 100_000, 'Water_BBL': 20_000}],
             [{'DATE': '2027-01', 'Category': 'Drilling', 'Cost_USD': 30_000_000}], [{'date': '2027-01', 'Total_Opex_USD': 750_000}],
             'Headers normalized case-insensitively.'),
        case('per_well_beats_total_rollup', ALAOMA_CFG, [{'year': 2027, 'well1_oil_bbl': 60_000, 'well2_oil_bbl': 40_000, 'total_oil_bbl': 100_000}], [], [],
             'Per-well columns summed, total_oil_bbl ignored: 100,000 bbl, not 200,000.'),
        case('duplicate_identical_aliases', ALAOMA_CFG, [{'date': '2027-01', 'oil_bbl': 100_000}],
             [{'date': '2027-01', 'amount_usd': 30_000_000, 'cost_usd': 30_000_000}], [],
             'Two aliases with the same value are accepted once: capex 30M.'),
        case('usd_fallback_parts', ALAOMA_CFG, [{'date': '2027-01', 'oil_bbl': 100_000}],
             [{'date': '2027-01', 'drilling_usd': 20_000_000, 'facilities_usd': 5_000_000, 'total_usd': 99}],
             [{'date': '2027-01', 'fixed_usd': 400_000, 'variable_usd': 100_000}],
             'No preferred cost alias: the *_usd parts sum (total_ prefixed columns excluded): capex 25M, opex 0.5M.'),
        case('month_index_rows', ALAOMA_CFG, [{'month_index': m, 'oil_bbl': 10_000} for m in range(1, 25)],
             [{'month_index': 1, 'amount_usd': 5_000_000}], [{'month_index': 13, 'total_opex_usd': 1_000_000}],
             'month_index maps 1 to 12 onto base_year and 13 to 24 onto the next year.'),
        case('pia_gas_only_hct_zero', dict(PIA_CFG), [{'year': 2025, 'well1_gas_mscf': 20_000_000}],
             [{'year': 2025, 'amount_usd': 20_000_000}], [{'year': 2025, 'total_opex_usd': 10_000_000}],
             'Gas-only PIA: HCT base zero, CIT still charged.'),
        case('pia_gas_only_legacy_hct', {**PIA_CFG, 'pia_hct_include_gas_revenue': True}, [{'year': 2025, 'well1_gas_mscf': 20_000_000}],
             [{'year': 2025, 'amount_usd': 20_000_000}], [{'year': 2025, 'total_opex_usd': 10_000_000}],
             'Escape hatch: whole-revenue HCT base charges HCT on gas.'),
        case('pia_mixed_streams_hct_apportioned', dict(PIA_CFG),
             [{'year': 2025, 'w_oil_bbl': 5_000_000, 'w_gas_mscf': 30_000_000, 'w_condensate_bbl': 300_000}],
             [{'year': 2025, 'amount_usd': 200_000_000}], [{'year': 2025, 'total_opex_usd': 100_000_000}],
             'Oil, gas and condensate together: shared deductions apportioned by liquids revenue share in the HCT base.'),
        case('psc_wi_50', {**PSC_CFG, 'psc_working_interest_pct': 50}, JV_PROD, PSC_CAPEX, JV_OPEX,
             'PSC at 50 percent WI: every monetary line and the entitlement volumes halve; take percent invariant.'),
        case('pia_deep_offshore_full', {**PIA_CFG, 'pia_terrain': 'deep_offshore'}, [{'year': 2025, 'well1_oil_bbl': 21_900_000}],
             [{'year': 2025, 'amount_usd': 100_000_000}], [{'year': 2025, 'total_opex_usd': 100_000_000}],
             'Deep offshore 60,000 bopd: 7.5 percent tier, HCT exempt under PIA-only.'),
        case('pia_deep_offshore_wi_50', {**PIA_CFG, 'pia_terrain': 'deep_offshore', 'pia_working_interest_pct': 50}, [{'year': 2025, 'well1_oil_bbl': 21_900_000}],
             [{'year': 2025, 'amount_usd': 100_000_000}], [{'year': 2025, 'total_opex_usd': 100_000_000}],
             'Field-level 7.5 percent tier survives a 50 percent WI; lifetime cumulative stays field-level.'),
        case('pia_deep_offshore_naive_30k', {**PIA_CFG, 'pia_terrain': 'deep_offshore'}, [{'year': 2025, 'well1_oil_bbl': 10_950_000}],
             [{'year': 2025, 'amount_usd': 100_000_000}], [{'year': 2025, 'total_opex_usd': 100_000_000}],
             'Half the volumes at 100 percent WI sit in the 5 percent tier (the naive pre-scaling error).'),
        case('pia_deep_offshore_nta_aggressive', {**PIA_CFG, 'pia_terrain': 'deep_offshore', 'pia_under_nta_2025_override': 'force_nta',
                                                   'pia_deep_offshore_hct_interpretation': 'aggressive_pml_30'},
             [{'year': 2025, 'well1_oil_bbl': 21_900_000}], [{'year': 2025, 'amount_usd': 100_000_000}], [{'year': 2025, 'total_opex_usd': 100_000_000}],
             'NTA-era deep offshore under the aggressive interpretation: HCT 30 percent.'),
        case('pia_deep_offshore_nta_custom', {**PIA_CFG, 'pia_terrain': 'deep_offshore', 'pia_under_nta_2025_override': 'force_nta',
                                               'pia_deep_offshore_hct_interpretation': 'custom', 'pia_deep_offshore_hct_custom_rate_pct': 12.5},
             [{'year': 2025, 'well1_oil_bbl': 21_900_000}], [{'year': 2025, 'amount_usd': 100_000_000}], [{'year': 2025, 'total_opex_usd': 100_000_000}],
             'NTA-era deep offshore custom HCT rate 12.5 percent.'),
        case('pia_marginal_field_blend', {**PIA_CFG, 'pia_terrain': 'marginal_field', 'pia_marginal_field_pre_2021': True},
             [{'year': 2025, 'well1_oil_bbl': 2_920_000}], [{'year': 2025, 'amount_usd': 30_000_000}], [{'year': 2025, 'total_opex_usd': 20_000_000}],
             'Marginal field at 8,000 bopd: blended royalty (5,000 at 5 percent, 3,000 at 7.5 percent); HCT 15 percent pre-2021 marginal.'),
        case('pia_frontier_exempt', {**PIA_CFG, 'pia_terrain': 'frontier', 'pia_license_type': 'PPL'},
             [{'year': 2025, 'well1_oil_bbl': 3_650_000}], [{'year': 2025, 'amount_usd': 50_000_000}], [{'year': 2025, 'total_opex_usd': 30_000_000}],
             'Frontier: 7.5 percent production royalty, no price royalty, HCT exempt.'),
        case('pia_onshore_new_lease', {**PIA_CFG, 'pia_terrain': 'onshore', 'pia_lease_status': 'new', 'pia_nddc_levy_fixed_usd': None},
             [{'year': 2025, 'well1_oil_bbl': 3_650_000}], [{'year': 2025, 'amount_usd': 50_000_000}], [{'year': 2025, 'total_opex_usd': 30_000_000}],
             'Onshore new lease: 15 percent royalty, 8 USD/bbl allowance, NDDC at 3 percent of opex.'),
        case('pia_high_price_royalty_tiers', {**PIA_CFG, 'oil_price_usd_bbl': 140}, PIA_PROD, PIA_CAPEX, PIA_OPEX,
             'Price royalty in the upper tier (between the 100 and 150 anchors escalated to 2025).'),
        case('pia_price_royalty_ceiling', {**PIA_CFG, 'oil_price_usd_bbl': 200}, PIA_PROD, PIA_CAPEX, PIA_OPEX,
             'Price royalty at the 10 percent ceiling.'),
        case('deck_step_hold', {**JV_CFG, 'oil_price_escalator_pct': 10, 'price_deck': [{'year': 2030, 'oil': 100}, {'year': 2032, 'oil': 50}]},
             [{'year': y, 'well1_oil_bbl': 1_000_000} for y in (2030, 2031, 2032, 2033)], [], [],
             'Deck 100 (2030) then 50 (2032): 100, 100 held, 50, 55 escalated beyond the last entry.'),
        case('deck_differential', {**JV_CFG, 'oil_price_escalator_pct': 10, 'price_deck': [{'year': 2030, 'oil': 100}], 'oil_price_differential_usd_bbl': -5},
             [{'year': y, 'well1_oil_bbl': 1_000_000} for y in (2030, 2031)], [], [],
             'Differential -5 after deck resolution: 95 then 105.'),
        case('deck_scale', {**JV_CFG, 'oil_price_escalator_pct': 10, 'price_deck': [{'year': 2030, 'oil': 100}], 'oil_price_scale': 1.2},
             [{'year': 2030, 'well1_oil_bbl': 1_000_000}], [], [], 'Scale 1.2 multiplies the resolved deck price: 120.'),
        case('deck_before_first_entry', {**JV_CFG, 'price_deck': [{'year': 2031, 'oil_price_usd_bbl': '90'}, {'year': 2032, 'oil': 70}]},
             [{'year': y, 'well1_oil_bbl': 1_000_000} for y in (2030, 2031, 2032)], [], [],
             'Year before the first deck entry takes the first value (90 as a string); long config-style key accepted.'),
        case('flat_escalator', {**JV_CFG, 'oil_price_escalator_pct': 10}, [{'year': y, 'well1_oil_bbl': 1_000_000} for y in (2030, 2031)], [], [],
             'No deck: 100 then 110.'),
        case('escalator_defaults_to_inflation', {**JV_CFG, 'inflation_rate_pct': 5, 'oil_price_escalator_pct': None, 'opex_escalator_pct': None},
             JV_PROD, JV_CAPEX, JV_OPEX,
             'Unset oil and opex escalators fall back to the inflation rate; capex escalator stays 0; nominal basis.'),
        case('mid_year_discounting', {**JV_CFG, 'discounting_convention': 'mid_year'}, JV_PROD, JV_CAPEX, JV_OPEX,
             'Mid-year: every exponent shifts by 0.5, NPV = end-year NPV / sqrt(1.1).'),
        case('valuation_year_forward', {**JV_CFG, 'valuation_year': 2031}, JV_PROD, JV_CAPEX, JV_OPEX,
             'Valuation 2031: 2030 flow compounds forward by 1.1.'),
        case('valuation_year_sunk', {**JV_CFG, 'valuation_year': 2031, 'treat_prior_as_sunk': True}, JV_PROD, JV_CAPEX, JV_OPEX,
             'Sunk: 2030 excluded from value metrics (reported as sunk_net_cash_flow), fiscal state still accrues.'),
        case('schedule_shift_1', {**JV_CFG, 'schedule_shift_years': 1}, JV_PROD, JV_CAPEX, JV_OPEX,
             'First-oil delay: capex 2030 alone, production and opex in 2031 and 2032, loss relief carries the 2030 depreciation.'),
        case('psc_tranches', {**PSC_CFG, 'psc_profit_split_mode': 'tranches',
                              'psc_profit_tranches': [{'from_cum_mmbbl': 0, 'contractor_share_pct': 60}, {'from_cum_mmbbl': 1, 'contractor_share_pct': 40}]},
             JV_PROD, PSC_CAPEX, JV_OPEX, 'Tranche share on start-of-year cumulative liquids: 60 then 40 percent.'),
        case('psc_itc', {**PSC_CFG, 'psc_itc_pct': 50}, JV_PROD, PSC_CAPEX, JV_OPEX,
             'ITC 40M on 80M capex: 13.5M used each year, 13M carried unused.'),
        case('psc_tranches_prior_cumulative', {**PSC_CFG, 'psc_profit_split_mode': 'tranches', 'psc_prior_cumulative_liquids_bbl': 1_500_000,
                                                 'psc_profit_tranches': [{'from_cum_mmbbl': 0, 'contractor_share_pct': 60}, {'from_cum_mmbbl': 1, 'contractor_share_pct': 40}, {'from_cum_mmbbl': 2, 'contractor_share_pct': 30}]},
             JV_PROD, PSC_CAPEX, JV_OPEX, 'Brownfield tranche start at 1.5 MMbbl: 40 then 30 percent.'),
        case('min_etr_85', {**PIA_CFG, 'pia_apply_minimum_etr': True, 'pia_minimum_etr_pct': 85}, PIA_PROD, PIA_CAPEX, PIA_OPEX,
             'Minimum ETR floor binds: top-up = 85 percent of CIT assessable profit less taxes paid.'),
        case('min_etr_not_binding', {**PIA_CFG, 'pia_apply_minimum_etr': True, 'pia_minimum_etr_pct': 15}, PIA_PROD, PIA_CAPEX, PIA_OPEX,
             'Minimum ETR at 15 percent does not bind on the worked example: no top-up line.'),
        case('jv_sinking_fund', {**JV_CFG, 'abandonment_cost_usd': 10_000_000, 'abandonment_funding_mode': 'sinking_fund'}, JV_PROD, JV_CAPEX, JV_OPEX,
             'Sinking fund 5M a year in the opex lane, tax falls 2.5M, the final spend is paid from the fund.'),
        case('psc_sinking_fund', {**PSC_CFG, 'abandonment_cost_usd': 10_000_000, 'abandonment_funding_mode': 'sinking_fund', 'abandonment_fund_start_year': 2031},
             JV_PROD, PSC_CAPEX, JV_OPEX, 'PSC sinking fund from 2031: one 10M contribution rides the recoverable cost lane.'),
        case('pia_sinking_fund', {**PIA_CFG, 'abandonment_cost_usd': 30_000_000, 'abandonment_funding_mode': 'sinking_fund'}, PIA_PROD, PIA_CAPEX, PIA_OPEX,
             'PIA sinking fund on the worked example: contribution relieves HCT (liquids share) and CIT at their rates, levies untouched.'),
        case('pia_sinking_fund_wi_50', {**PIA_CFG, 'abandonment_cost_usd': 30_000_000, 'abandonment_funding_mode': 'sinking_fund', 'pia_working_interest_pct': 50},
             PIA_PROD, PIA_CAPEX, PIA_OPEX,
             'Sinking fund at 50 percent WI: the contribution is WI-scaled with the other monetary lines while abandonment_cost_funded stays the full amount (see FINDINGS).'),
        case('jv_abandonment_wi_60', {**JV_CFG, 'jv_working_interest_pct': 60, 'abandonment_cost_usd': 10_000_000}, JV_PROD, JV_CAPEX, JV_OPEX,
             'Lump-sum abandonment at 60 percent JV WI: the lump sum is applied unscaled after the WI share (entered as the user share).'),
        case('psc_abandonment_wi_50', {**PSC_CFG, 'psc_working_interest_pct': 50, 'abandonment_cost_usd': 10_000_000}, JV_PROD, PSC_CAPEX, JV_OPEX,
             'Lump-sum abandonment at 50 percent PSC WI: unscaled after the WI share.'),
        case('jv_depr_5y', {**JV_CFG, 'jv_psc_depr_years': 5}, JV_PROD, JV_CAPEX, JV_OPEX, 'Five-year straight line: 10M a year, year-1 tax 30M.'),
        case('jv_nigeria_ppt', {**JV_CFG, 'depreciation_method': 'nigeria_ppt'}, JV_PROD, JV_CAPEX, JV_OPEX,
             'PPT schedule 20/20/20/20/19 from the capex year: 10M in each of the first two years.'),
        case('jv_ngn_fx', {**JV_CFG, 'fx_ngn_per_usd': 1500}, JV_PROD, JV_CAPEX, JV_OPEX, 'Flat FX 1500 stamps the NGN mirrors.'),
        case('jv_wi_60', {**JV_CFG, 'jv_working_interest_pct': 60}, JV_PROD, JV_CAPEX, JV_OPEX, 'JV at 60 percent WI scales inside the regime.'),
        case('multiyear_pia_real', MULTI_CFG, MULTI_PROD, MULTI_CAPEX, MULTI_OPEX,
             'Six-year declining PIA field, three streams, 3 percent inflation, escalators, real basis: Fisher real rate 6.7961 percent.'),
        case('multiyear_pia_nominal', {**MULTI_CFG, 'present_value_basis': 'nominal'}, MULTI_PROD, MULTI_CAPEX, MULTI_OPEX,
             'Same field on the nominal basis at 10 percent.'),
        case('multiyear_pia_midyear_real', {**MULTI_CFG, 'discounting_convention': 'mid_year'}, MULTI_PROD, MULTI_CAPEX, MULTI_OPEX,
             'Same field, real basis, mid-year exponents.'),
        case('multiyear_jv_real', {**JV_CFG, 'inflation_rate_pct': 3, 'present_value_basis': 'real', 'opex_escalator_pct': 3, 'oil_price_escalator_pct': 2},
             [{'year': 2030 + i, 'well1_oil_bbl': 1_500_000 * 0.85 ** i} for i in range(8)],
             [{'year': 2030, 'amount_usd': 120_000_000}, {'year': 2031, 'amount_usd': 30_000_000}],
             [{'year': 2030 + i, 'total_opex_usd': 15_000_000} for i in range(8)],
             'Eight-year declining JV on the real basis with escalators.'),
        case('zero_rates_capex_only', JV_CFG, [{'year': 2030, 'well1_oil_bbl': 0}, {'year': 2031, 'well1_oil_bbl': 0}], JV_CAPEX, JV_OPEX,
             'Zero production: negative cash flow everywhere, IRR null, payback beyond life, take and unit costs null.'),
        case('single_year_positive', JV_CFG, [{'year': 2030, 'well1_oil_bbl': 1_000_000}], [], [{'year': 2030, 'total_opex_usd': 10_000_000}],
             'Single positive year: payback Year 0, IRR null (no negative flow), DPI null (no capex).'),
        case('pia_prior_year_opex_zero', {**PIA_CFG, 'pia_prior_year_opex_usd': 0}, PIA_PROD, PIA_CAPEX, PIA_OPEX,
             'No prior-year opex: HCDT zero in the first year.'),
        case('pia_hct_override', {**PIA_CFG, 'pia_hct_rate_override_pct': 20}, PIA_PROD, PIA_CAPEX, PIA_OPEX, 'HCT rate override 20 percent.'),
        case('pia_ppl_license', {**PIA_CFG, 'pia_license_type': 'PPL'}, PIA_PROD, PIA_CAPEX, PIA_OPEX, 'PPL licence: HCT 15 percent.'),
        case('pia_cpr_carry_two_years', {**PIA_CFG, 'pia_cpr_limit_pct': 30},
             [{'year': 2025, 'well1_oil_bbl': 2_000_000}, {'year': 2026, 'well1_oil_bbl': 2_000_000}, {'year': 2027, 'well1_oil_bbl': 2_000_000}],
             [{'year': 2025, 'amount_usd': 200_000_000}], [{'year': 2025 + i, 'total_opex_usd': 30_000_000} for i in range(3)],
             'CPR cap 30 percent binds for three years: the deferred pool carries and is claimed opex-first before capital allowance.'),
    ]
    errors = [
        error_case('no_volume_columns', ALAOMA_CFG, [{'date': '2027-01', 'oil_production': 100_000}], [], [], 'no oil/gas/condensate volume columns'),
        error_case('no_usable_date', ALAOMA_CFG, [{'period': 'Jan-27', 'oil_bbl': 100_000}], [], [], 'no row had a usable date'),
        error_case('capex_no_cost_column', ALAOMA_CFG, [{'date': '2027-01', 'oil_bbl': 100_000}], [{'date': '2027-01', 'category': 'Drilling', 'spend': 30_000_000}], [], 'CAPEX file: no cost column recognized'),
        error_case('opex_no_cost_column', ALAOMA_CFG, [{'date': '2027-01', 'oil_bbl': 100_000}], [], [{'date': '2027-01', 'monthly_cost': 750_000}], 'OPEX file: no cost column recognized'),
        error_case('oil_price_unset', {**ALAOMA_CFG, 'oil_price_usd_bbl': None}, [{'date': '2027-01', 'oil_bbl': 100_000}], [], [], 'Oil price (oil_price_usd_bbl) is not set'),
        error_case('gas_price_unset', {**ALAOMA_CFG, 'gas_price_usd_mscf': ''}, [{'date': '2027-01', 'gas_mscf': 100_000}], [], [], 'Gas price (gas_price_usd_mscf) is not set'),
        error_case('ambiguous_cost_aliases', ALAOMA_CFG, [{'date': '2027-01', 'oil_bbl': 100_000}], [{'date': '2027-01', 'amount_usd': 30_000_000, 'cost_usd': 10_000_000}], [], 'multiple cost columns populated with different values'),
        error_case('no_production_rows', ALAOMA_CFG, [], [], [], 'No production data found'),
    ]
    irr_cases = []
    for name, flows in [
        ('jv_analytic', [-12_500_000, 37_500_000]),
        ('no_real_root', [-1, 3, -3]),
        ('two_roots_10_and_20', [-100, 230, -132]),
        ('all_positive', [5, 5, 5]),
        ('all_negative', [-5, -5]),
        ('conventional_five_year', [-1000, 300, 300, 300, 300, 300]),
        ('late_payout', [-1000, 0, 0, 0, 0, 2500]),
        ('tiny_return', [-1000, 1001]),
        ('loss_making', [-1000, 500, 400]),
        ('sign_change_late', [100, -300, 250]),
        ('two_roots_2_and_6', [-100, 208, -108.12]),
        ('two_roots_5_and_50', [-100, 255, -157.5]),
        ('two_roots_minus73_and_173', [-12_500_000, 37_500_000, -9_000_000]),
        ('three_roots_0_7_33', [-100, 340, -382.4, 142.4]),
        ('three_roots_10_20_40', [-100, 370, -454, 184.8]),
    ]:
        r = irr_of(flows)
        entry = {'name': name, 'flows': flows, 'irr_pct': r * 100 if r is not None else None,
                 'payback_years': payback_of(flows), 'payback': payback_label(flows)}
        if name in IRR_ENGINE_PINS:
            entry['disagreement'] = {'engine_irr_pct': IRR_ENGINE_PINS[name], 'oracle_irr_pct': entry['irr_pct'],
                                     'method_statement': IRR_METHOD_NOTE}
        irr_cases.append(entry)
    breakeven = [
        {'name': 'jv_analytic', 'cfg': JV_CFG, 'prodRows': JV_PROD, 'capexRows': JV_CAPEX, 'opexRows': JV_OPEX},
        {'name': 'pia_worked_example', 'cfg': PIA_CFG, 'prodRows': PIA_PROD, 'capexRows': PIA_CAPEX, 'opexRows': PIA_OPEX},
        {'name': 'multiyear_pia_real', 'cfg': MULTI_CFG, 'prodRows': MULTI_PROD, 'capexRows': MULTI_CAPEX, 'opexRows': MULTI_OPEX},
        {'name': 'deck_present_null', 'cfg': {**JV_CFG, 'price_deck': [{'year': 2030, 'oil': 100}]}, 'prodRows': JV_PROD, 'capexRows': JV_CAPEX, 'opexRows': []},
        {'name': 'never_breaks_even_null', 'cfg': JV_CFG, 'prodRows': [{'year': 2030, 'well1_oil_bbl': 10}], 'capexRows': JV_CAPEX, 'opexRows': JV_OPEX},
        {'name': 'positive_at_floor_null', 'cfg': JV_CFG, 'prodRows': JV_PROD, 'capexRows': [], 'opexRows': []},
    ]
    for b in breakeven:
        b['breakeven_usd_bbl'] = breakeven_oil_price(b['cfg'], b['prodRows'], b['capexRows'], b['opexRows'])
        if b['breakeven_usd_bbl'] is not None:
            b['npv_at_breakeven'] = compute({**b['cfg'], 'oil_price_usd_bbl': b['breakeven_usd_bbl']}, b['prodRows'], b['capexRows'], b['opexRows'])['kpis']['npv']

    KPI_SWEEP = ('npv', 'irr', 'payback_years', 'discounted_payback_years', 'government_take_pct', 'government_take_pct_discounted',
                 'total_tax', 'total_revenue', 'unit_technical_cost_usd_per_boe', 'dpi')

    def point(label, value, cfg, prod, capex, opex, extra=()):
        kp = compute(cfg, prod, capex, opex)['kpis']
        return {label: value, 'inputs': {'cfg': cfg, 'prodRows': prod, 'capexRows': capex, 'opexRows': opex},
                'kpis': {k: kp.get(k) for k in KPI_SWEEP + tuple(extra)}}

    jv8_cfg = {**JV_CFG, 'inflation_rate_pct': 3, 'present_value_basis': 'real', 'opex_escalator_pct': 3, 'oil_price_escalator_pct': 2}
    jv8_prod = [{'year': 2030 + i, 'well1_oil_bbl': 1_500_000 * 0.85 ** i} for i in range(8)]
    jv8_capex = [{'year': 2030, 'amount_usd': 120_000_000}, {'year': 2031, 'amount_usd': 30_000_000}]
    jv8_opex = [{'year': 2030 + i, 'total_opex_usd': 15_000_000} for i in range(8)]
    sweeps = {
        'oil_price_pia_worked_example': {
            'note': 'Flat oil price 40 to 120 USD/bbl in steps of 10 on the PIA worked example; every point carries its inputs and the KPI subset.',
            'points': [point('oil_price_usd_bbl', p, {**PIA_CFG, 'oil_price_usd_bbl': p}, PIA_PROD, PIA_CAPEX, PIA_OPEX) for p in range(40, 121, 10)]},
        'oil_price_multiyear_pia_real': {
            'note': 'Flat oil price 40 to 120 on the six-year PIA field, real basis; price royalty tiers and the CPR cap move with price.',
            'points': [point('oil_price_usd_bbl', p, {**MULTI_CFG, 'oil_price_usd_bbl': p}, MULTI_PROD, MULTI_CAPEX, MULTI_OPEX) for p in range(40, 121, 10)]},
        'discount_rate_multiyear_jv_real': {
            'note': 'Nominal discount rate 0 to 20 percent in steps of 2 on the eight-year JV field (real basis, 3 percent inflation).',
            'points': [point('discount_rate_pct', d, {**jv8_cfg, 'discount_rate_pct': d}, jv8_prod, jv8_capex, jv8_opex) for d in range(0, 21, 2)]},
        'decline_rate_multiyear_pia': {
            'note': 'Annual decline 5 to 40 percent on a ten-year PIA oil field (nominal basis, economic limit on) so the limit and the CPR cap engage at different lives.',
            'points': [point('decline_pct', dec, {**MULTI_CFG, 'present_value_basis': 'nominal', 'apply_economic_limit': True},
                             [{'year': 2025 + i, 'w1_oil_bbl': 5_000_000 * (1 - dec / 100.0) ** i} for i in range(10)], MULTI_CAPEX,
                             [{'year': 2025 + i, 'total_opex_usd': 80_000_000} for i in range(10)],
                             extra=('economic_limit_year', 'years_trimmed_by_economic_limit')) for dec in (5, 10, 20, 30, 40)]},
    }

    return {
        'description': (
            'Economics cash flow goldens for engines/economics/cashflow.ts (the Suite EPE engine v3.9.0, extracted EC0 2026-09-08). '
            'Emitted by the independent stdlib oracle tools/validation/economics/oracle_cashflow.py, written from the engine header, '
            'docs/scope/EPE.md and the harness derivations, never from the TypeScript: IRR by a 0.001 bracket scan and bisection to 1e-13 '
            '(smallest root) against the engine Newton-then-bisection; breakeven oil price bisected to 1e-9 USD/bbl against the engine 0.001 '
            'bracket midpoint; every fiscal line and every KPI recomputed. Units: money USD (NGN mirrors where fx_ngn_per_usd is set), oil and '
            'condensate bbl, gas Mscf, boe at 6 Mscf per bbl, percent inputs 0 to 100, irr and government take in percent, discount_rate_applied_pct '
            'in percent, payback in years. Discounting is YEAR-END from the valuation year (0.5 added under mid_year) on the real basis '
            '(Fisher real rate, cash flows deflated by (1 + inflation) ^ (year - base_year)) or the nominal basis. `cases` carry full '
            'cashFlowData rows and kpis; `errors` carry the ingestion failures the engine must throw with a substring of the message; '
            '`irr` carries flow vectors with the oracle IRR (percent) and payback; `breakeven` carries the exact breakeven price and the '
            'NPV there; `sweeps` carry KPI curves. `disagreements` lists every quantity where the engine and the oracle legitimately '
            'differ, with both numbers and the method statement that decides it (see FINDINGS-cashflow.md).'
        ),
        'engine_version': ENGINE_VERSION,
        'cases': cases,
        'errors': errors,
        'irr': irr_cases,
        'breakeven': breakeven,
        'sweeps': sweeps,
        'disagreements': disagreements(cases, irr_cases),
    }


# Engine IRR (percent) on multi-root profiles, read from a run of
# engines/economics/cashflow.ts irr() on the same flows (Newton from 10
# percent converges to the root nearest its start, not the root nearest
# zero). Pinned so the golden carries BOTH numbers.
IRR_ENGINE_PINS = {
    'two_roots_2_and_6': 5.9999999999995654,
    'three_roots_0_7_33': 7.350889359324948,
}
IRR_METHOD_NOTE = ('Engine header v3.5: "irr(): Newton now falls back to bisection when unconverged and returns null when no '
                   'sign change brackets a root." It does not say which root is reported when the profile has several. '
                   'The oracle reports the root nearest zero on the positive side (the hurdle-rate region); the engine reports '
                   'the root Newton reaches from 10 percent. Both zero the NPV; the choice is an owner decision.')


def disagreements(cases, irr_cases=()):
    """Quantities where the engine's published behaviour differs from the
    method statement the oracle implements. Each entry pins BOTH numbers. The
    engine numbers were read from a run of engines/economics/cashflow.ts on
    the same inputs and are pinned by the jest gate; the oracle numbers are
    computed here."""
    out = []
    # 1. npv_profile applied-rate point. The header says the applied rate is
    #    included "so the curve always passes through the headline NPV". The
    #    engine labels that point with the applied rate ROUNDED to two
    #    decimals and evaluates the NPV at the rounded rate, so on the real
    #    basis with 3 percent inflation (real rate 6.796116...) the point sits
    #    at 6.8 percent and misses the headline NPV. The oracle evaluates at
    #    the exact rate. Decided by the header's own statement: the point
    #    should pass through the headline NPV.
    for c in cases:
        name = c['name']
        k = c['expected']['kpis']
        exact = k['discount_rate_applied_pct']
        rounded = round(exact * 100) / 100.0
        if rounded == exact:
            continue
        # NPV at the rounded rate, on the same basis and exponents.
        cfg = c['cfg']
        infl = pct(cfg, 'inflation_rate_pct') / 100.0
        base_year = cfg.get('base_year') or 2027
        basis = cfg.get('present_value_basis') or 'real'
        mid = cfg.get('discounting_convention') == 'mid_year'
        vy = k.get('valuation_year', base_year)
        rows = [r for r in c['expected']['cashFlowData'] if not r.get('sunk')]
        at_rounded = sum((r['net_cash_flow'] / (1 + infl) ** (r['year'] - base_year) if basis == 'real' else r['net_cash_flow'])
                         / (1 + rounded / 100.0) ** ((r['year'] - vy) + (0.5 if mid else 0.0)) for r in rows)
        if abs(at_rounded - k['npv']) <= 0.01:
            continue  # a single year at t = 0 is rate-independent: no gap to record
        out.append({
            'case': name, 'quantity': 'kpis.npv_profile applied-rate point',
            'engine': {'rate_pct': rounded, 'npv': at_rounded},
            'oracle': {'rate_pct': exact, 'npv': k['npv']},
            'gap': at_rounded - k['npv'], 'gap_unit': 'USD',
            'method_statement': 'Engine header v3.8: "the applied rate is included so the curve always passes through the headline NPV". '
                                'The engine rounds the applied rate to two decimals before labelling and evaluating the point, so on a real '
                                'basis whose Fisher rate is not a round percentage the point misses the headline NPV by the gap recorded here.',
        })
    for e in irr_cases:
        if 'disagreement' in e:
            d = e['disagreement']
            out.append({'case': 'irr:' + e['name'], 'quantity': 'irr on a multi-root profile',
                        'engine': {'irr_pct': d['engine_irr_pct']}, 'oracle': {'irr_pct': d['oracle_irr_pct']},
                        'gap': d['engine_irr_pct'] - d['oracle_irr_pct'], 'gap_unit': 'percentage points',
                        'method_statement': d['method_statement']})
    return out


def main():
    golden = build()
    path = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'cashflow_cases.json')
    with open(path, 'w') as f:
        json.dump(golden, f, indent=1, sort_keys=True, allow_nan=False)
        f.write('\n')
    print('wrote %s: %d cases, %d errors, %d irr, %d breakeven, %d sweeps, %d disagreements' % (
        path, len(golden['cases']), len(golden['errors']), len(golden['irr']), len(golden['breakeven']),
        len(golden['sweeps']), len(golden['disagreements'])))


if __name__ == '__main__':
    main()
