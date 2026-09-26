#!/usr/bin/env python3
"""Independent oracle for the PIA 2021 / NTA 2025 fiscal ledger (the default
path of engines/economics/cashflow.ts since engines 3.12.0, EC7). Emits
test-data/economics/goldens/pia2021_cases.json.

INDEPENDENCE DISCIPLINE (owner decision EC7-D1, 2026-09-26). Every rate,
band, threshold and cap in this file was typed from the gazetted texts, read
2026-09-26, NOT from cashflow.ts, its header, EPE.md or oracle_cashflow.py:

  PIA   Petroleum Industry Act 2021 (Act No. 6), Official Gazette No. 142,
        Vol. 108, 27 August 2021 (NUPRC searchable copy, sha256 5d158ca8...).
  NTA   Nigeria Tax Act 2025 (Act No. 7), Official Gazette No. 117, Vol. 112,
        26 June 2025 (sha256 e13ea10a...), effective 1 January 2026; the
        re-gazetted Certified True Copy ordered in December 2025 was not read.
  REGS  Petroleum Royalty Regulations 2022 (S.I. No. 73), Official Gazette
        No. 205, Vol. 109, 22 November 2022 (sha256 40bb5761...).
  FA23  Finance Act 2023 (sha256 92647892...): s.26 (TETFund Act s.1(2),
        2.5% -> 3%), s.9(b) (CITA Second Schedule para 24(7): capital
        allowance limited to 66 2/3% of assessable profit, gas companies
        exempt), s.30 (effective 1 May 2023).

The formulas are written the way the texts write them (royalty as a sum over
tranches; the benchmarks as a year-by-year table), which is deliberately not
the shape of the engine's code.

Where the texts leave a step open, the ORACLE states its own convention
(O1-O9). The engine must agree with each; a disagreement is a red gate:
  O1  Annual model: the royalty daily rate is the year's crude oil plus
      condensate over the calendar days of the year (REGS r.12(2) works per
      month over producing days).
  O2  Costs shared by crude oil and gas (opex, decommissioning contribution,
      capital allowance, HCDT, NDDC) enter the hydrocarbon tax at the share of
      crude-plus-condensate revenue in gross revenue.
  O3  CPR claim order: the carried pool and the year's operating costs
      before the year's capital allowance.
  O4  A hydrocarbon tax or CIT chargeable profit below zero is carried to
      later years like a loss (s.265 / NTA s.70 carry losses; the texts do not
      say what happens to allowances larger than the profit).
  O5  NDDC levy base: the year's opex plus capex (NDDC Act s.14(2)(b), "total
      annual budget"; secondary source); a fixed sum replaces it when given.
  O6  Capital allowance by the law of each year of assessment: PIA years
      20/20/20/20/19 (PIA Fifth Schedule para 17), NTA years 20 (NTA First
      Schedule Part II para 14), counted from the year of spend.
  O7  The realised price is the fiscal price (Seventh Schedule para 8 not
      modelled); no additional tax at fiscal price.
  O8  Benchmark rounding: each year's benchmark is the previous year's
      rounded benchmark times 1.02, rounded half up to whole cents.
  O9  Government take: (revenue - opex - capex - pre-take NCF) over
      (revenue - opex - capex), undiscounted, nominal (fiscalConventions).

stdlib only. Regenerate:
    python3 tools/validation/economics/oracle_pia2021.py
"""
import json
import math
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
OUT = os.path.join(ROOT, 'test-data', 'economics', 'goldens', 'pia2021_cases.json')

# ---------------------------------------------------------------------------
# Texts, as tables
# ---------------------------------------------------------------------------
# PIA Seventh Schedule para 10(2)-(4); NTA Seventh Schedule para 6(2)(b)-(d);
# REGS r.13. Each tranche: (upper bound in bopd or None, rate).
PRODUCTION_ROYALTY_TRANCHES = {
    'onshore': [(5000, 0.05), (10000, 0.075), (None, 0.15)],
    'shallow_water': [(5000, 0.05), (10000, 0.075), (None, 0.125)],
    'deep_offshore': [(50000, 0.05), (None, 0.075)],
    'frontier': [(None, 0.075)],
}
GAS_ROYALTY = 0.05              # para 10(6), REGS r.16(5)
GAS_ROYALTY_IN_COUNTRY = 0.025  # para 10(6), REGS r.16(1)
PRICE_LEVELS = (50.0, 100.0, 150.0)   # para 11(1)(a)-(c)
PRICE_RATES = (0.0, 0.05, 0.10)
HCDT_RATE = 0.03                # PIA s.240(2)
CPR_LIMIT = 0.65                # PIA / NTA Sixth Schedule para 2(1)
PA_CONVERTED = 2.50             # Sixth Schedule para 1(1)
PA_NEW = 8.00                   # para 1(2)
PA_NEW_AFTER_CAP = 4.00         # para 1(2) "thereafter"
PA_PRICE_SHARE = 0.20
PA_CAPS = {'onshore': 50e6, 'shallow_water': 100e6, 'deep_offshore': 500e6, 'frontier': 500e6}
NTA_PA_TERRAINS = ('onshore', 'shallow_water')   # NTA Sixth Schedule para 1(2)(a),(b)
CA_PIA = (0.20, 0.20, 0.20, 0.20, 0.19)          # PIA Fifth Schedule para 17(1)
CA_NTA = (0.20, 0.20, 0.20, 0.20, 0.20)          # NTA First Schedule Part II para 14(1)
CIT_RATE = 0.30                 # NTA s.56(b)
DEV_LEVY = 0.04                 # NTA s.59(1)
CITA_CAP = 2.0 / 3.0            # CITA 2nd Sch para 24(7) as substituted by FA23 s.9(b)
NTA_FIRST = 2026
MIN_ETR = 0.15                  # NTA s.57(1)


def tet_rate(year):
    """TETFund Act s.1(2): 3% from FA23 (effective 1 May 2023, whole 2023 row), 2.5% before."""
    return 0.03 if year >= 2023 else 0.025


def framework(cfg, year):
    ov = cfg.get('pia_under_nta_2025_override', 'auto')
    if ov == 'force_pia':
        return 'pia_only'
    if ov == 'force_nta':
        return 'nta_2025'
    return 'nta_2025' if year >= NTA_FIRST else 'pia_only'


def round_cents(x):
    return math.floor(x * 100 + 0.5) / 100


def benchmarks(year, base='regulations_2021'):
    """REGS Schedule (2021 = 50/100/150, +2% every 1 January from 2022) or the
    Act's para 11(1) (2020 = 50/100/150, +2% from 1 January 2021)."""
    start = 2021 if base == 'regulations_2021' else 2020
    table = {start: PRICE_LEVELS}
    y = start
    while y < year:
        prev = table[y]
        y += 1
        table[y] = tuple(round_cents(v * 1.02) for v in prev)
    return table[max(start, year)]


def production_royalty_rate(terrain, bopd):
    tranches = PRODUCTION_ROYALTY_TRANCHES[terrain]
    if bopd <= 0:
        return tranches[0][1]
    paid, lower = 0.0, 0.0
    for upper, rate in tranches:
        top = bopd if upper is None else min(bopd, upper)
        if top > lower:
            paid += (top - lower) * rate
        if upper is None or bopd <= upper:
            break
        lower = upper
    return paid / bopd


def gas_royalty_rate(in_country_pct):
    s = in_country_pct / 100.0
    return GAS_ROYALTY * (1 - s) + GAS_ROYALTY_IN_COUNTRY * s


def price_royalty_rate(price, year, terrain, base='regulations_2021'):
    if terrain == 'frontier':          # para 11(2)
        return 0.0
    lo, mid, hi = benchmarks(year, base)
    if price <= lo:
        return PRICE_RATES[0]
    if price >= hi:
        return PRICE_RATES[2]
    if price <= mid:
        return PRICE_RATES[0] + (PRICE_RATES[1] - PRICE_RATES[0]) * (price - lo) / (mid - lo)
    return PRICE_RATES[1] + (PRICE_RATES[2] - PRICE_RATES[1]) * (price - mid) / (hi - mid)


def hct_rate(cfg, fw):
    t = cfg['pia_terrain']
    if cfg.get('pia_hct_rate_override_pct') is not None:
        return cfg['pia_hct_rate_override_pct'] / 100.0
    if t == 'frontier':                  # s.260(3); NTA 65(4)
        return 0.0
    if t == 'deep_offshore':
        if fw == 'pia_only':             # s.260(3)
            return 0.0
        interp = cfg['pia_deep_offshore_hct_interpretation']   # NTA 65(1) vs 72: stated input
        return {'conservative_zero': 0.0, 'aggressive_pml_30': 0.30}.get(interp) if interp != 'custom' \
            else cfg['pia_deep_offshore_hct_custom_rate_pct'] / 100.0
    if cfg.get('pia_marginal_field_pre_2021'):   # s.94(1) -> s.267(b)
        return 0.15
    if cfg['pia_license_type'] == 'PPL':          # s.267(b)
        return 0.15
    if cfg.get('pia_lease_status', 'converted') == 'converted':   # s.267(a)
        return 0.30
    return cfg['pia_new_pml_hct_rate_pct'] / 100.0   # stated input


def production_allowance(cfg, bbl, price, prior, fw):
    if bbl <= 0:
        return 0.0, 0.0, 0.0
    if cfg.get('pia_lease_status', 'converted') == 'converted':
        return bbl * min(PA_CONVERTED, PA_PRICE_SHARE * price), bbl, 0.0
    t = cfg['pia_terrain']
    if fw == 'nta_2025' and t not in NTA_PA_TERRAINS:
        return 0.0, 0.0, 0.0
    room = max(0.0, PA_CAPS[t] - prior)
    below = min(bbl, room)
    after = bbl - below
    return below * min(PA_NEW, PA_PRICE_SHARE * price) + after * min(PA_NEW_AFTER_CAP, PA_PRICE_SHARE * price), below, after


def calendar_days(y):
    return 366 if (y % 4 == 0 and y % 100 != 0) or y % 400 == 0 else 365


# ---------------------------------------------------------------------------
# The ledger
# ---------------------------------------------------------------------------
def ledger(cfg, prod, capex_rows, opex_rows):
    base = cfg['base_year']
    infl = cfg.get('inflation_rate_pct', 0) / 100.0
    esc = {k: cfg.get(k, 0) / 100.0 for k in ('oil_price_escalator_pct', 'gas_price_escalator_pct',
                                                'condensate_price_escalator_pct', 'opex_escalator_pct', 'capex_escalator_pct')}
    wi = cfg.get('pia_working_interest_pct', 100) / 100.0
    pr_base = cfg.get('pia_price_royalty_base', 'regulations_2021')
    vols = {r['year']: r for r in prod}
    capex = {r['year']: r['amount_usd'] for r in capex_rows}
    opex = {r['year']: r['total_opex_usd'] for r in opex_rows}
    years = sorted(set(vols) | set(capex) | set(opex))

    # O6: capital allowance by the law of each year of assessment.
    allowance = {}
    capex_infl = {}
    for y0, amt in capex.items():
        a = amt * (1 + esc['capex_escalator_pct']) ** (y0 - base)
        capex_infl[y0] = a
        for i in range(5):
            y = y0 + i
            sched = CA_NTA if framework(cfg, y) == 'nta_2025' else CA_PIA
            allowance[y] = allowance.get(y, 0.0) + a * sched[i]

    # decommissioning sinking fund (equal contributions start..abandonment)
    fund = {}
    if cfg.get('abandonment_funding_mode') == 'sinking_fund' and cfg.get('abandonment_cost_usd'):
        ab_year = cfg.get('abandonment_year') or years[-1]
        start = cfg.get('abandonment_fund_start_year') or years[0]
        fy = [y for y in years if start <= y <= ab_year]
        for y in fy:
            fund[y] = cfg['abandonment_cost_usd'] / len(fy) / wi

    carry = hct_loss = cit_loss = cit_allow = 0.0
    prior_opex = cfg.get('pia_prior_year_opex_usd', 0) or 0
    cum = cfg.get('pia_prior_cumulative_oil_bbl', 0) or 0
    rows = []
    for y in years:
        t = y - base
        fw = framework(cfg, y)
        v = vols.get(y, {})
        oil, gas, cond = v.get('oil_bbl', 0), v.get('gas_mscf', 0), v.get('condensate_bbl', 0)
        po = cfg['oil_price_usd_bbl'] * (1 + esc['oil_price_escalator_pct']) ** t
        pg = cfg.get('gas_price_usd_mscf', 0) * (1 + esc['gas_price_escalator_pct']) ** t
        pc = cfg.get('condensate_price_usd_bbl', 0) * (1 + esc['condensate_price_escalator_pct']) ** t
        ox = opex.get(y, 0) * (1 + esc['opex_escalator_pct']) ** t
        cx = capex_infl.get(y, 0)
        ca = allowance.get(y, 0.0)
        oil_rev, gas_rev, cond_rev = oil * po, gas * pg, cond * pc
        liq_rev = oil_rev + cond_rev
        gross = liq_rev + gas_rev
        liq_bbl = oil + cond

        # royalties
        bopd = liq_bbl / calendar_days(y)                                     # O1
        r_liq = production_royalty_rate(cfg['pia_terrain'], bopd)
        r_gas = gas_royalty_rate(cfg.get('pia_gas_in_country_share_pct', 0))
        pr_oil = price_royalty_rate(po, y, cfg['pia_terrain'], pr_base)
        pr_cond = price_royalty_rate(pc, y, cfg['pia_terrain'], pr_base)
        liq_roy = liq_rev * r_liq
        gas_roy = gas_rev * r_gas
        price_roy = oil_rev * pr_oil + cond_rev * pr_cond
        royalty = liq_roy + gas_roy + price_roy

        hcdt = HCDT_RATE * prior_opex if prior_opex > 0 else 0.0
        if cfg.get('pia_nddc_levy_fixed_usd') is not None:
            nddc = cfg['pia_nddc_levy_fixed_usd']
        else:
            nddc_base = (ox + cx) if cfg.get('pia_nddc_levy_base', 'total_budget') == 'total_budget' else ox   # O5
            nddc = nddc_base * cfg.get('pia_nddc_levy_pct', 3) / 100.0

        contrib = fund.get(y, 0.0)
        decom_ded = contrib if contrib > 0 and (fw == 'pia_only' or cfg.get('pia_decom_escrow_condition_met') is True) else 0.0

        share = liq_rev / gross if gross > 0 else 0.0                        # O2
        cap = CPR_LIMIT * liq_rev
        op_costs = share * (ox + decom_ded)
        ca_costs = share * ca
        pool = carry + op_costs + ca_costs
        claimed = min(pool, cap)
        deferred = pool - claimed
        op_claimed = min(carry + op_costs, claimed)                          # O3
        ca_claimed = claimed - op_claimed
        carry = deferred

        hct_ap = liq_rev - liq_roy - price_roy - op_claimed - share * (hcdt + nddc)
        pa, pa_below, pa_after = production_allowance(cfg, liq_bbl, po, cum, fw)
        hct_cp = hct_ap - ca_claimed - pa
        if hct_cp < 0:                                                        # O4
            hct_loss += -hct_cp
            hct_base = 0.0
        else:
            use = min(hct_loss, hct_cp)
            hct_loss -= use
            hct_base = hct_cp - use
        h_rate = hct_rate(cfg, fw)
        hct = hct_base * h_rate

        cit_ap = gross - royalty - ox - hcdt - nddc - decom_ded
        avail = ca + cit_allow
        restricted = fw == 'pia_only' and not cfg.get('pia_cit_company_gas_operations')
        cit_ca = min(avail, max(0.0, cit_ap * CITA_CAP)) if restricted else avail
        cit_allow = avail - cit_ca
        cit_cp = cit_ap - cit_ca
        if cit_cp < 0:
            cit_loss += -cit_cp
            cit_base = 0.0
        else:
            use = min(cit_loss, cit_cp)
            cit_loss -= use
            cit_base = cit_cp - use
        cit = cit_base * CIT_RATE
        if fw == 'pia_only':
            tet_pct = cfg['pia_tet_rate_pct'] if cfg.get('pia_tet_rate_pct') is not None else tet_rate(y) * 100
            tet = max(0.0, cit_ap * tet_pct / 100.0)
            levy = 0.0
        else:
            tet_pct, tet = 0.0, 0.0
            levy = max(0.0, cit_ap * DEV_LEVY)
        tax = hct + cit + tet + levy
        topup = 0.0
        if cfg.get('pia_apply_minimum_etr') and fw == 'nta_2025':
            floor = max(0.0, cit_ap * cfg.get('pia_minimum_etr_pct', MIN_ETR * 100) / 100.0)   # the case may state another rate
            if tax < floor:
                topup = floor - tax
        tax += topup
        ncf = gross - royalty - ox - hcdt - nddc - tax - cx - contrib

        prior_opex = ox
        cum += liq_bbl
        money = dict(gross_revenue=gross, liquids_production_royalty=liq_roy, gas_royalty=gas_roy,
                     price_royalty=price_roy, royalty=royalty, production_royalty=liq_roy + gas_roy,
                     hcdt=hcdt, nddc=nddc, cpr_cap=cap, cpr_costs_claimed=claimed, cpr_deferred_to_next=deferred,
                     hct_assessable_profit=hct_ap, production_allowance=pa, hct_chargeable_profit=hct_cp,
                     hct_tax=hct, cit_assessable_profit=cit_ap, cit_allowance_claimed=cit_ca,
                     cit_chargeable_profit=cit_cp, cit_tax=cit, tet_tax=tet, dev_levy_tax=levy,
                     tax=tax, net_cash_flow=ncf, depreciation=ca, opex=ox, capex=cx)
        if topup > 0:
            money['min_etr_topup'] = topup
        row = {k: val * wi for k, val in money.items()}
        row.update(year=y, fiscal_framework=fw, royalty_liquids_bopd=bopd, royalty_rate_liquids=r_liq,
                   royalty_rate_gas=r_gas, price_royalty_rate_oil=pr_oil, price_royalty_rate_condensate=pr_cond,
                   hct_rate=h_rate, tet_rate_pct=tet_pct, prod_alw_below_cap_bbl=pa_below, prod_alw_after_cap_bbl=pa_after)
        rows.append(row)

    # KPIs
    n = cfg['discount_rate_pct'] / 100.0
    basis = cfg.get('present_value_basis', 'real')
    r = (1 + n) / (1 + infl) - 1 if basis == 'real' else n
    npv = 0.0
    for row in rows:
        t = row['year'] - base
        cf = row['net_cash_flow'] / (1 + infl) ** t if basis == 'real' else row['net_cash_flow']
        npv += cf / (1 + r) ** t
    rev = sum(x['gross_revenue'] for x in rows)
    pre = rev - sum(x['capex'] for x in rows) - sum(x['opex'] for x in rows) - (cfg.get('abandonment_cost_usd') or 0)
    ncf_total = sum(x['net_cash_flow'] for x in rows)
    fws = sorted(set(x['fiscal_framework'] for x in rows), key=lambda f: f != 'pia_only')
    k = dict(npv=npv,
             total_royalties=sum(x['royalty'] for x in rows), total_hct=sum(x['hct_tax'] for x in rows),
             total_cit=sum(x['cit_tax'] for x in rows), total_tet=sum(x['tet_tax'] for x in rows),
             total_dev_levy=sum(x['dev_levy_tax'] for x in rows), total_hcdt=sum(x['hcdt'] for x in rows),
             total_nddc=sum(x['nddc'] for x in rows),
             total_production_allowance=sum(x['production_allowance'] for x in rows),
             government_take_pct=(pre - ncf_total) / pre * 100 if pre > 0 else None,   # O9
             fiscal_framework=fws[0] if len(fws) == 1 else 'pia_only_then_nta_2025')
    if len(fws) > 1:
        k['nta_first_year'] = min(x['year'] for x in rows if x['fiscal_framework'] == 'nta_2025')
    if carry > 0:
        k['cpr_forfeited_at_cessation'] = carry * wi          # Sixth Schedule para 2(2)(c)
    if cit_allow > 0:
        k['cit_allowance_unused_at_cessation'] = cit_allow * wi
    return {'rows': rows, 'kpis': k}


# ---------------------------------------------------------------------------
# Cases (Ekene synthetic PIA cases: ours, labelled synthetic; design values
# from the Ekene demo field: 75 USD/bbl, shallow water at 35 m, converted
# PML, first NTA year 2026)
# ---------------------------------------------------------------------------
FIXTURE = json.load(open(os.path.join(ROOT, 'test-data', 'economics', 'fixtures', 'pia-worked-example.json')))


def worked_example_default():
    cfg = {k: v for k, v in FIXTURE['cfg'].items() if k not in ('pia_legacy_pre_audit', 'pia_tet_rate_pct')}
    prod = [{'year': 2025, 'oil_bbl': 18_250_000}]
    return cfg, prod, [{'year': 2025, 'amount_usd': 300_000_000}], [{'year': 2025, 'total_opex_usd': 182_500_000}]


EKENE = {
    'fiscal_regime': 'PIA', 'base_year': 2026, 'discount_rate_pct': 10, 'inflation_rate_pct': 0,
    'present_value_basis': 'nominal',
    'oil_price_usd_bbl': 75, 'gas_price_usd_mscf': 3, 'condensate_price_usd_bbl': 70,
    'oil_price_escalator_pct': 0, 'gas_price_escalator_pct': 0, 'condensate_price_escalator_pct': 0,
    'opex_escalator_pct': 0, 'capex_escalator_pct': 0,
    'pia_terrain': 'shallow_water', 'pia_license_type': 'PML', 'pia_lease_status': 'converted',
    'pia_water_depth_m': 35, 'pia_marginal_field_pre_2021': False,
    'pia_prior_year_opex_usd': 0, 'pia_prior_cumulative_oil_bbl': 0,
}


def decline(first_year, n, oil0, gas_per_bbl=0.0, cond_frac=0.0, d=0.12):
    out = []
    for i in range(n):
        oil = round(oil0 * (1 - d) ** i)
        out.append({'year': first_year + i, 'oil_bbl': oil, 'gas_mscf': round(oil * gas_per_bbl), 'condensate_bbl': round(oil * cond_frac)})
    return out


def flat_opex(first_year, n, amount):
    return [{'year': first_year + i, 'total_opex_usd': amount} for i in range(n)]


def build_cases():
    C = []

    def add(name, note, cfg, prod, capex, opex):
        C.append({'name': name, 'note': note, 'cfg': cfg, 'prodRows': prod, 'capexRows': capex, 'opexRows': opex,
                  'expected': ledger(cfg, prod, capex, opex)})

    add('worked_example_inputs_default',
        'The frozen worked example inputs (fixture) on the DEFAULT path with the TET rate left to the statute: '
        'shallow water 50,000 bopd weighted 5/7.5/12.5 (REGS r.13(2)(d)) = 11.25%, NDDC in the HCT base, TET 3% (FA23 s.26), '
        'capital allowance 20% in year one, CPR on liquids revenue. The default-path regression reference.',
        *worked_example_default())

    # 1. Ekene Alpha: shallow water converted PML, about 8,000 bopd falling, associated gas sold, all NTA years.
    add('ekene_alpha_shallow_converted_nta',
        'Ekene synthetic: shallow water (35 m) converted PML inside the small-field tranche (about 8,000 bopd falling), '
        'gas at 3 USD/Mscf, condensate 4%, 2026-2032 all under the NTA: levy 4%, no CITA restriction, 20% capital allowance.',
        dict(EKENE), decline(2026, 7, 2_920_000, gas_per_bbl=0.8, cond_frac=0.04),
        [{'year': 2026, 'amount_usd': 120_000_000}, {'year': 2027, 'amount_usd': 30_000_000}], flat_opex(2026, 7, 24_000_000))

    # 2. Onshore converted PML across 1 January 2026 (per-year framework).
    cfg = dict(EKENE, base_year=2024, pia_terrain='onshore', gas_price_usd_mscf=0)
    add('ekene_onshore_across_2026',
        'Ekene synthetic onshore converted PML 2024-2028 at about 7,000 bopd: 2024-2025 under the PIA (TET 3%, CITA two-thirds, '
        '20/20 capital allowance), 2026 onward under the NTA (levy, no restriction, 20%); one ledger, the framework read per year.',
        cfg, decline(2024, 5, 2_555_000, cond_frac=0.0, d=0.10),
        [{'year': 2024, 'amount_usd': 90_000_000}], flat_opex(2024, 5, 20_000_000))

    # 3. Deep offshore new PML at 60,000 bopd, 2025 PIA then NTA (aggressive reading).
    deep = dict(EKENE, base_year=2025, pia_terrain='deep_offshore', pia_lease_status='new', gas_price_usd_mscf=0,
                pia_deep_offshore_hct_interpretation='aggressive_pml_30', pia_water_depth_m=1200)
    prod = [{'year': 2025 + i, 'oil_bbl': 21_900_000, 'gas_mscf': 0, 'condensate_bbl': 0} for i in range(3)]
    add('ekene_deep_new_60k_aggressive',
        'Ekene synthetic deep offshore new PML at 60,000 bopd (weighted 5% on 50,000, 7.5% above: REGS r.13(1)); 2025 under the PIA: '
        'no HCT (s.260(3)); 2026-2027 under the NTA read "aggressive_pml_30": HCT 30% and NO production allowance (NTA Sixth Schedule 1(2)).',
        deep, prod, [{'year': 2025, 'amount_usd': 1_500_000_000}], flat_opex(2025, 3, 200_000_000))
    add('ekene_deep_new_60k_conservative',
        'The same deep offshore field read "conservative_zero" under the NTA.',
        dict(deep, pia_deep_offshore_hct_interpretation='conservative_zero'), prod,
        [{'year': 2025, 'amount_usd': 1_500_000_000}], flat_opex(2025, 3, 200_000_000))

    # 4. Non-associated gas field, half the gas sold in-country.
    gcfg = dict(EKENE, oil_price_usd_bbl=75, pia_gas_in_country_share_pct=50)
    add('ekene_nag_gas_in_country_half',
        'Ekene synthetic gas field in shallow water: 20 Bscf a year at 3 USD/Mscf, half utilised in-country (royalty 2.5%), half at 5%; '
        'no crude oil so no HCT, a CPR cap of zero and CIT on the whole profit.',
        gcfg, [{'year': 2026 + i, 'oil_bbl': 0, 'gas_mscf': 20_000_000, 'condensate_bbl': 0} for i in range(3)],
        [{'year': 2026, 'amount_usd': 60_000_000}], flat_opex(2026, 3, 8_000_000))

    # 5. New onshore lease crossing the 50 MMbbl allowance cap; stated 15% HCT.
    ncfg = dict(EKENE, pia_terrain='onshore', pia_lease_status='new', pia_new_pml_hct_rate_pct=15,
                pia_prior_cumulative_oil_bbl=49_000_000, gas_price_usd_mscf=0)
    add('ekene_onshore_new_cap_crossing',
        'Ekene synthetic new onshore PML with 49 MMbbl produced before 2026: 2026 crosses 50 MMbbl, the barrels below earn '
        'min(8, 20% of price), the rest min(4, 20% of price) (Sixth Schedule 1(2)(a)); HCT at the stated 15%.',
        ncfg, [{'year': 2026, 'oil_bbl': 3_000_000, 'gas_mscf': 0, 'condensate_bbl': 0},
               {'year': 2027, 'oil_bbl': 2_500_000, 'gas_mscf': 0, 'condensate_bbl': 0}],
        [{'year': 2026, 'amount_usd': 40_000_000}], flat_opex(2026, 2, 30_000_000))

    # 6. Condensate at its own price, both price royalty bases.
    ccfg = dict(EKENE, base_year=2025, oil_price_usd_bbl=95, condensate_price_usd_bbl=88, gas_price_usd_mscf=0)
    cprod = [{'year': 2025, 'oil_bbl': 5_000_000, 'gas_mscf': 0, 'condensate_bbl': 1_000_000}]
    add('ekene_condensate_price_royalty_regs',
        'Crude at 95 and condensate at 88 USD/bbl in 2025: each pays royalty by price at its own price (REGS r.15(2)), '
        'benchmarks 54.12 / 108.24 / 162.36 (Regulations base, 2021).',
        ccfg, cprod, [{'year': 2025, 'amount_usd': 50_000_000}], flat_opex(2025, 1, 40_000_000))
    add('ekene_condensate_price_royalty_act',
        'The same year on the Act\'s base (2020): benchmarks 55.20 / 110.41 / 165.61.',
        dict(ccfg, pia_price_royalty_base='act_2020'), cprod, [{'year': 2025, 'amount_usd': 50_000_000}], flat_opex(2025, 1, 40_000_000))

    # 7. CPR binding, carry and forfeiture; CITA restriction binding.
    bcfg = dict(EKENE, base_year=2024, gas_price_usd_mscf=0)
    add('ekene_cpr_binding_forfeiture',
        'Ekene synthetic shallow water field with heavy costs on thin revenue: the 65% CPR binds on the HCT base only, carries, '
        'and is forfeited at cessation; the CIT base deducts full opex; the CITA two-thirds limit binds in 2024-2025.',
        bcfg, [{'year': 2024 + i, 'oil_bbl': 1_000_000 - 200_000 * i, 'gas_mscf': 0, 'condensate_bbl': 0} for i in range(3)],
        [{'year': 2024, 'amount_usd': 150_000_000}], flat_opex(2024, 3, 40_000_000))

    # 8. Sinking fund under the NTA, escrow condition met / not met.
    scfg = dict(EKENE, gas_price_usd_mscf=0, abandonment_cost_usd=30_000_000, abandonment_funding_mode='sinking_fund')
    sprod = decline(2026, 3, 2_000_000)
    add('ekene_sinking_fund_nta_escrow_met',
        'NTA years with a decommissioning fund: deductible for HCT (inside the CPR) and CIT because the escrow condition is met (NTA s.86).',
        dict(scfg, pia_decom_escrow_condition_met=True), sprod, [{'year': 2026, 'amount_usd': 60_000_000}], flat_opex(2026, 3, 15_000_000))
    add('ekene_sinking_fund_nta_escrow_not_met',
        'The same fund with the escrow condition not met: no deduction (NTA s.86), the cash still goes out.',
        dict(scfg, pia_decom_escrow_condition_met=False), sprod, [{'year': 2026, 'amount_usd': 60_000_000}], flat_opex(2026, 3, 15_000_000))
    add('ekene_sinking_fund_pia_years',
        'A fund in PIA years (2024-2025): deductible without condition (PIA s.263(1)(e), s.302(11)(b)(i)).',
        dict(scfg, base_year=2024), decline(2024, 2, 2_000_000), [{'year': 2024, 'amount_usd': 60_000_000}], flat_opex(2024, 2, 15_000_000))

    # 9. Minimum ETR only in NTA years.
    add('ekene_min_etr_nta_only',
        'Minimum ETR switched on at 85% (to force a top-up): the 2025 PIA year pays none, the 2026 NTA year pays the top-up (NTA s.57).',
        dict(EKENE, base_year=2025, pia_apply_minimum_etr=True, pia_minimum_etr_pct=85, gas_price_usd_mscf=0),
        decline(2025, 2, 2_500_000), [{'year': 2025, 'amount_usd': 50_000_000}], flat_opex(2025, 2, 20_000_000))

    # 10. Working interest 50.
    add('ekene_alpha_wi_50',
        'Ekene Alpha at a 50% working interest: every money line halves, tranches and caps stay field-level.',
        dict(EKENE, pia_working_interest_pct=50), decline(2026, 7, 2_920_000, gas_per_bbl=0.8, cond_frac=0.04),
        [{'year': 2026, 'amount_usd': 120_000_000}, {'year': 2027, 'amount_usd': 30_000_000}], flat_opex(2026, 7, 24_000_000))

    # 11. Marginal field flag in shallow water (15% HCT), frontier, NDDC opex base, force_pia.
    add('ekene_marginal_shallow_flag',
        'A producing marginal field converted under s.94(1), in shallow water at about 20,000 bopd: royalty weighted 5/7.5/12.5, HCT 15%.',
        dict(EKENE, pia_marginal_field_pre_2021=True, gas_price_usd_mscf=0), [{'year': 2026, 'oil_bbl': 7_300_000, 'gas_mscf': 0, 'condensate_bbl': 0}],
        [{'year': 2026, 'amount_usd': 80_000_000}], flat_opex(2026, 1, 40_000_000))
    add('ekene_frontier',
        'Frontier acreage: royalty 7.5% flat, no royalty by price, no HCT (s.260(3); para 11(2)).',
        dict(EKENE, pia_terrain='frontier', oil_price_usd_bbl=120, gas_price_usd_mscf=0),
        [{'year': 2026, 'oil_bbl': 3_650_000, 'gas_mscf': 0, 'condensate_bbl': 0}], [{'year': 2026, 'amount_usd': 90_000_000}],
        flat_opex(2026, 1, 30_000_000))
    add('ekene_nddc_opex_base',
        'NDDC on the stated opex base instead of the total annual budget.',
        dict(EKENE, pia_nddc_levy_base='opex', gas_price_usd_mscf=0), decline(2026, 2, 2_000_000),
        [{'year': 2026, 'amount_usd': 60_000_000}], flat_opex(2026, 2, 15_000_000))
    add('ekene_force_pia_2027',
        'A 2027 ledger forced to the PIA terms: TET 3%, CITA two-thirds, 20/20/20/20/19 allowance.',
        dict(EKENE, base_year=2027, pia_under_nta_2025_override='force_pia', gas_price_usd_mscf=0), decline(2027, 6, 2_000_000),
        [{'year': 2027, 'amount_usd': 60_000_000}], flat_opex(2027, 6, 15_000_000))
    return C


# ---------------------------------------------------------------------------
# Unit tables
# ---------------------------------------------------------------------------
BOPD_EDGES = [1, 4999, 5000, 5001, 7500, 9999, 10000, 10001, 20000, 49999, 50000, 50001, 60000, 120000]


def unit_tables():
    t = {}
    t['production_royalty'] = [{'terrain': ter, 'bopd': b, 'rate': production_royalty_rate(ter, b)}
                               for ter in PRODUCTION_ROYALTY_TRANCHES for b in BOPD_EDGES]
    t['benchmarks'] = [{'year': y, 'base': base, 'levels': list(benchmarks(y, base))}
                       for base in ('regulations_2021', 'act_2020') for y in range(2019, 2031)]
    grid = []
    for base in ('regulations_2021', 'act_2020'):
        for y in (2020, 2021, 2022, 2025, 2026, 2030):
            lo, mid, hi = benchmarks(y, base)
            for p in (45.0, lo, lo + 0.01, 75.0, 80.0, mid, 125.0, hi, hi - 0.01, 200.0):
                for ter in ('shallow_water', 'frontier'):
                    grid.append({'price': p, 'year': y, 'terrain': ter, 'base': base, 'rate': price_royalty_rate(p, y, ter, base)})
    t['price_royalty'] = grid
    t['act_example'] = {'price': 75.0, 'year': 2020, 'base': 'act_2020', 'rate': price_royalty_rate(75.0, 2020, 'onshore', 'act_2020'),
                        'text': 'PIA Seventh Schedule para 11(1): "if in 2020 the price is US $75 per barrel, the royalty by price shall be 2.5%"'}
    t['gas_royalty'] = [{'in_country_pct': s, 'rate': gas_royalty_rate(s)} for s in (0, 25, 50, 100)]
    hct = []
    for ter in ('onshore', 'shallow_water', 'deep_offshore', 'frontier'):
        for fw in ('pia_only', 'nta_2025'):
            for lic, lease, marg, newrate in (('PML', 'converted', False, None), ('PPL', 'converted', False, None),
                                               ('PML', 'converted', True, None), ('PML', 'new', False, 15), ('PML', 'new', False, 30)):
                for interp in ('conservative_zero', 'aggressive_pml_30'):
                    cfg = {'pia_terrain': ter, 'pia_license_type': lic, 'pia_lease_status': lease, 'pia_marginal_field_pre_2021': marg,
                           'pia_new_pml_hct_rate_pct': newrate, 'pia_deep_offshore_hct_interpretation': interp}
                    hct.append({'cfg': cfg, 'framework': fw, 'rate': hct_rate(cfg, fw)})
    t['hct_rate'] = hct
    pa = []
    for ter in ('onshore', 'shallow_water', 'deep_offshore', 'frontier'):
        for lease in ('converted', 'new'):
            for fw in ('pia_only', 'nta_2025'):
                for price, prior in ((80.0, 0.0), (10.0, 0.0), (80.0, PA_CAPS[ter] - 400_000), (80.0, PA_CAPS[ter] + 1)):
                    cfg = {'pia_terrain': ter, 'pia_lease_status': lease}
                    a, below, after = production_allowance(cfg, 1_000_000, price, prior, fw)
                    pa.append({'cfg': cfg, 'framework': fw, 'bbl': 1_000_000, 'price': price, 'prior': prior,
                               'allowance': a, 'below_cap_bbl': below, 'after_cap_bbl': after})
    t['production_allowance'] = pa
    t['capital_allowance'] = [{'year_of_life': i, 'framework': fw, 'fraction': (CA_NTA if fw == 'nta_2025' else CA_PIA)[i] if i < 5 else 0.0}
                              for fw in ('pia_only', 'nta_2025') for i in range(6)]
    t['tet'] = [{'year': y, 'rate_pct': tet_rate(y) * 100} for y in range(2021, 2026)]
    return t


def main():
    golden = {
        'description': 'Goldens for the PIA 2021 / NTA 2025 default path of engines/economics/cashflow.ts (engines 3.12.0), '
                       'from the independent stdlib oracle tools/validation/economics/oracle_pia2021.py written from the gazetted texts '
                       '(PIA 2021 Gazette No. 142 of 27 Aug 2021; NTA 2025 Gazette No. 117 of 26 Jun 2025; Petroleum Royalty Regulations 2022 '
                       'S.I. 73; Finance Act 2023; read 2026-09-26). Ekene cases are synthetic (ours).',
        'units': 'money USD, volumes bbl and Mscf, rates as fractions, *_pct as percent',
        'cases': build_cases(),
        'tables': unit_tables(),
    }
    with open(OUT, 'w') as f:
        json.dump(golden, f, indent=1, sort_keys=True, allow_nan=False)
        f.write('\n')
    print('wrote %s: %d cases' % (OUT, len(golden['cases'])))
    for c in golden['cases']:
        print('  %-42s npv %18.2f  take %s  fw %s' % (c['name'], c['expected']['kpis']['npv'],
              c['expected']['kpis']['government_take_pct'], c['expected']['kpis']['fiscal_framework']))


if __name__ == '__main__':
    main()
