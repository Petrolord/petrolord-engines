// engines/economics/cashflow.ts
//
// MOVED in the EC0 Economics engine extraction wave (2026-09-08) from the
// Suite's supabase/functions/_shared/epe-engine.ts, VERBATIM: the 1740 lines
// below are byte for byte the Suite file at ENGINE_VERSION 3.9.0, with no
// behaviour change. This file has no imports, so nothing was repointed. The
// Suite path is now a re-export shim of this file (written by the EC0
// coordinator), so the Suite's edge functions, its jest gates and the NextGen
// academy (git subtree) all run this one copy. Independent stdlib oracle:
// tools/validation/economics/oracle_cashflow.py; committed goldens:
// test-data/economics/goldens/cashflow_cases.json; jest gate:
// __tests__/economics.cashflow.test.ts. Discounting here is YEAR-END from
// the valuation year (mid-year is an option) on a real or nominal basis;
// the screening engine (./screening.js) discounts mid-year. Original header
// follows unchanged.
//
// supabase/functions/_shared/epe-engine.ts
//
// PETROLORD EPE CASH FLOW ENGINE — Shared compute library (v3.9, 2026-08-21)
//
// v3.9 changes (Wave F fiscal depth, docs/scope/EPE-Industry-Audit.md):
//   - PSC profit-oil tranches (psc_profit_split_mode='tranches' with
//     psc_profit_tranches: [{from_cum_mmbbl, contractor_share_pct}], applied
//     on cumulative liquids) and Investment Tax Credit (psc_itc_pct of that
//     year's capex, credited against PSC tax with carryforward of unused
//     credit). Flat split stays the default and is byte-identical.
//   - Minimum effective tax rate top-up (pia_apply_minimum_etr, default
//     off): per-year top-up when PIA taxes fall short of
//     pia_minimum_etr_pct x CIT assessable profit. DELIBERATE PROJECT-LEVEL
//     APPROXIMATION of NTA 2025 s.57 (real min-ETR is company-level with
//     NGN turnover thresholds); the KPI reports the top-up separately so
//     reviewers can strip it.
//   - Decommissioning sinking fund (abandonment_funding_mode='sinking_fund'):
//     equal annual contributions from abandonment_fund_start_year (default:
//     first modeled year) through the abandonment year; contributions are
//     tax-deductible in the regime bases (PIA s.233-style treatment) and the
//     end-of-life spend is paid from the fund (no second cash hit). Lump-sum
//     post-tax remains the default.
//   - Depreciation controls: jv_psc_depr_years (default 10, now
//     configurable) and depreciation_method 'nigeria_ppt' preset
//     (20/20/20/20/19 with the statutory 1% retention held until disposal —
//     the retained 1% is deliberately never claimed in-model).
//   - NGN mirrors: cfg.fx_ngn_per_usd stamps kpis.fx_ngn_per_usd and
//     npv_ngn / total_revenue_ngn / total_tax_ngn (flat FX, v1).
//
// v3.8 changes (Wave D reporting, docs/scope/EPE-Industry-Audit.md):
//   - kpis.npv_profile: NPV at a standard discount-rate vector (0/5/8/10/
//     12/15/20% plus the applied rate), on the run's PV basis and
//     discounting convention — the classic NPV-vs-rate exhibit.
//   - kpis.government_take_pct_discounted: take share on present-value
//     terms (PV of pre-take value minus PV of contractor NCF, over PV of
//     pre-take value), same basis/exponents as the NPV.
//
// v3.7 changes (Wave C risk workbench, docs/scope/EPE-Industry-Audit.md):
//   - Schedule delay (cfg.schedule_shift_years, integer, default 0): shifts
//     production AND opex years by N (opex follows production); capex stays
//     on its committed schedule and depreciation/allowances still start from
//     the spend year. This is the "first oil delay" convention: a delay
//     costs value because spend precedes shifted revenue.
//
// v3.6 changes (Wave B equity + price realism, docs/scope/EPE-Industry-Audit.md):
//   - Working interest on PSC and PIA (psc_working_interest_pct /
//     pia_working_interest_pct, default 100): fiscal math runs at 100% field
//     level first (royalty rate tiers, price-royalty thresholds, production
//     allowance volume caps and CPR caps are all field-level constructs),
//     then every monetary line item AND the entitlement volumes are scaled to
//     the working-interest share. JV keeps its existing in-regime WI.
//   - Per-year price decks (cfg.price_deck: [{year, oil|gas|condensate}]):
//     a deck entry overrides flat+escalator for its stream. Step-hold between
//     entries, first value before the first entry, last value escalated by
//     the stream escalator beyond the last entry. Per-stream differentials
//     (oil_price_differential_usd_bbl etc.) are added after resolution, and
//     resolved prices honor optional *_price_scale multipliers so tornado/MC
//     sweeps remain meaningful with decks. Realized prices floor at 0.
//   - Mid-year discounting (cfg.discounting_convention: 'end_year' default |
//     'mid_year'): mid-year adds 0.5 to every discount exponent.
//   - Valuation date (cfg.valuation_year, default base_year) as the
//     discounting reference, and cfg.treat_prior_as_sunk: pre-valuation
//     years stay modeled (fiscal state accrues through them) but are
//     excluded from NPV/IRR/payback and KPI totals, reported separately as
//     kpis.sunk_net_cash_flow.
//   - computeBreakevenOilPrice() returns null when an oil deck is present
//     (bisection on the flat price would be meaningless).
//   Defaults reproduce v3.5 byte-identically (PIA worked example unchanged).
//
// v3.5 changes (Wave A correctness round, docs/scope/EPE-Industry-Audit.md):
//   - Tax-loss carryforward (JV taxable income; PIA HCT and CIT chargeable
//     profits): a negative year banks its loss and offsets the next positive
//     year, per CITA/PIA loss-relief practice. Config kill-switch
//     cfg.apply_loss_carryforward === false restores the old clamp-at-zero
//     behavior for reproducing historical runs. PSC needs no loss pool: its
//     tax base (contractor profit oil) is structurally non-negative and cost
//     losses already ride the cost-recovery pool. TET / Development Levy stay
//     on assessable profit without loss relief (deliberate; education-tax
//     style levies do not enjoy loss carryforward).
//   - PIA HCT base narrowed to crude + condensate: PIA 2021 charges HCT on
//     crude oil and condensate profits only (upstream gas profits are
//     CIT-only). Directly attributable oil royalties (production royalty on
//     liquids + price royalty) are deducted in full; shared costs (claimed
//     opex, HCDT, capital allowance) are apportioned by liquids' revenue
//     share. Escape hatch cfg.pia_hct_include_gas_revenue === true restores
//     the old whole-revenue base. Oil-only cases are byte-identical.
//   - irr(): Newton now falls back to bisection when unconverged and returns
//     null when no sign change brackets a root (the old code returned the
//     last Newton iterate however wrong).
//   - Cost ingestion: a row with two different populated cost aliases (e.g.
//     amount_usd AND cost_usd) now fails loudly instead of silently taking
//     the first non-zero column.
//   - Economic limit test now nets royalty out of the revenue-vs-opex check
//     (net operating income convention).
//   - kpis.engine_version stamps every result for run provenance.
//
// v3.3 changes (ingestion hardening):
//   - Case-insensitive header normalization for all uploaded CSV rows
//   - Production accepts bare oil_bbl/gas_mscf/condensate_bbl/water_bbl (and
//     total_* rollups) in addition to the per-well *_oil_bbl convention
//   - CAPEX accepts cost_usd/capex_usd/value_usd aliases and a *_usd fallback
//   - computeCashFlow() throws a validation error (instead of emitting a $0
//     run) when uploaded rows have no recognizable columns, no usable dates,
//     or a price is unset for a stream with nonzero volumes
//
// v3.4 changes (Petroleum Economics Studio capability round, 2026-08-16):
//   - Economic limit test (cfg.apply_economic_limit): trailing years whose
//     escalated revenue no longer covers inflated opex are trimmed before the
//     fiscal loop; KPI economic_limit_year reports the last economic year
//   - Abandonment cost (cfg.abandonment_cost_usd / cfg.abandonment_year):
//     lump-sum post-tax outflow in the chosen year (defaults to the final
//     modeled year); deliberately NOT tax-deducted, NOT depreciated, and
//     excluded from PSC cost recovery / PIA CPR (regime-specific decom-fund
//     deductibility is future, literature-gated work)
//   - Decision KPI bundle: total volumes + BOE (6:1 gas), unit technical
//     cost, opex/boe, government take %, PV(capex) + DPI, numeric payback and
//     discounted payback
//   - computeBreakevenOilPrice(): bisection on the flat oil price to NPV = 0
//
// v3.2 changes (B2.5 — NTA 2025 fiscal framework):
//   - determineFiscalFramework(): date-trigger + per-config override switch
//     between PIA-only and NTA-2025 fiscal frameworks
//   - deriveHctRate() extended for NTA-era deep offshore (three legal
//     interpretations: conservative_zero / aggressive_pml_30 / custom)
//   - applyPIA() splits TET vs Development Levy by framework (TET 2.5% under
//     PIA-only, Dev Levy 4% under NTA — same assessable-profit base, either-or)
//   - Production allowance volume caps for NEW leases (PIA Sixth Schedule):
//     50M onshore / 100M shallow / 500M deep, with mid-year split
//   - CPR cessation forfeiture diagnostic (final-year unrecovered costs flagged)
//   - PIAState extended with cumulative_oil_bbl_lifetime
//
// REGRESSION CONTRACT (preserved from v3.1):
//   Pre-2026 PIA cases with override='auto' produce byte-identical output to v3
//   (PIA worked example NPV 135,185,570.34 unchanged)
//
// NEW CONTRACT:
//   NTA-era cases (year >= 2026 OR override='force_nta') apply Dev Levy 4%
//   instead of TET 2.5%, with the volume-cap and CPR-forfeiture behavior.

// Stamped into kpis.engine_version on every run (Wave A provenance).
export const ENGINE_VERSION = '3.9.0';

// ============================================================================
// TYPES
// ============================================================================

export interface AnnualVolumes {
  year: number;
  oil_bbl: number;
  gas_mscf: number;
  condensate_bbl: number;
  water_bbl: number;
}

export interface RegimeInputs {
  gross_revenue: number;
  capex: number;
  opex: number;
  depreciation: number;
  cumulative_unrecovered_cost: number;
}

export interface RegimeOutputs {
  royalty: number;
  taxable_income: number;
  tax: number;
  net_cash_flow: number;
  cumulative_unrecovered_cost_after: number;
}

export type FiscalFramework = 'pia_only' | 'nta_2025';
export type DeepOffshoreInterpretation = 'conservative_zero' | 'aggressive_pml_30' | 'custom';

export interface PIAConfig {
  pia_terrain: string;
  pia_license_type: string;
  pia_lease_status: string;
  pia_water_depth_m: number | null;
  pia_marginal_field_pre_2021: boolean;
  pia_hct_rate_override_pct: number | null;
  pia_cit_rate_pct: number;
  pia_tet_rate_pct: number;
  pia_nddc_levy_pct_of_opex: number;
  pia_nddc_levy_fixed_usd: number | null;
  pia_prior_year_opex_usd: number | null;
  pia_capex_recovery_years: number;
  pia_cpr_limit_pct: number;
  pia_production_allowance_per_bbl_converted: number;
  pia_production_allowance_per_bbl_new: number;
  pia_production_allowance_pct_of_price: number;
  // B2.5 additions
  pia_under_nta_2025_override?: 'auto' | 'force_pia' | 'force_nta';
  pia_deep_offshore_hct_interpretation?: DeepOffshoreInterpretation;
  pia_deep_offshore_hct_custom_rate_pct?: number | null;
  pia_development_levy_rate_pct?: number;
  pia_apply_minimum_etr?: boolean;
  pia_minimum_etr_pct?: number;
  pia_new_lease_prod_alw_cap_onshore_bbl?: number;
  pia_new_lease_prod_alw_cap_shallow_bbl?: number;
  pia_new_lease_prod_alw_cap_deep_bbl?: number;
  pia_prior_cumulative_oil_bbl?: number;
  // v3.5 (Wave A)
  apply_loss_carryforward?: boolean;          // default true; false = old clamp
  pia_hct_include_gas_revenue?: boolean;      // default false; true = old whole-revenue HCT base
}

export interface PIAState {
  cpr_carryforward: number;
  prior_year_opex_usd: number;
  cumulative_oil_bbl_lifetime: number;  // B2.5: tracks vol-cap progress
  // v3.5 (Wave A): tax-loss pools, one per tax (separate bases)
  hct_loss_carryforward: number;
  cit_loss_carryforward: number;
}

export interface PIAInputs {
  year: number;
  oil_bbl: number;
  gas_mscf: number;
  condensate_bbl: number;
  fiscal_oil_price_usd_bbl: number;
  gross_revenue: number;
  oil_and_cond_revenue: number;
  capex_inflated: number;
  opex_inflated: number;
  capital_allowance_this_year: number;
  nddc_levy: number;
}

export interface PIAOutputs {
  production_royalty: number;
  price_royalty: number;
  total_royalties: number;
  hcdt: number;
  nddc: number;
  hct_assessable_profit: number;
  production_allowance: number;
  hct_chargeable_profit: number;
  hct_tax: number;
  cit_assessable_profit: number;
  cit_chargeable_profit: number;
  cit_tax: number;
  tet_tax: number;           // 0 under NTA
  dev_levy_tax: number;      // 0 under PIA-only — B2.5 NEW field
  total_tax: number;
  cpr_cap: number;
  cpr_costs_claimed: number;
  cpr_deferred_to_next: number;
  net_cash_flow: number;
  // B2.5 diagnostic fields
  fiscal_framework: FiscalFramework;
  prod_alw_cap_applied: boolean;
  prod_alw_eligible_bbl: number;
  // v3.5 (Wave A) loss-relief diagnostics
  hct_loss_offset_used: number;
  cit_loss_offset_used: number;
  hct_loss_carryforward: number;
  cit_loss_carryforward: number;
}

export interface ComputeInput {
  cfg: any;
  prodRows: any[];
  capexRows: any[];
  opexRows: any[];
}

export interface ComputeOutput {
  cashFlowData: any[];
  kpis: any;
}

// ============================================================================
// FRAMEWORK DETERMINATION (B2.5)
// ============================================================================

export function determineFiscalFramework(cfg: any): FiscalFramework {
  const override = cfg.pia_under_nta_2025_override ?? 'auto';
  if (override === 'force_pia') return 'pia_only';
  if (override === 'force_nta') return 'nta_2025';
  // 'auto' — date trigger
  const baseYear = cfg.base_year ?? 2027;
  return baseYear >= 2026 ? 'nta_2025' : 'pia_only';
}

// ============================================================================
// HEADER NORMALIZATION & ALIASING (v3.3)
// ============================================================================

const normalizeKey = (k: string) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');

// Lowercase/trim every key so uploaded headers match case-insensitively.
export function normalizeRows(rows: any[]): any[] {
  return (rows || []).map(row => {
    const out: any = {};
    for (const k of Object.keys(row)) out[normalizeKey(k)] = row[k];
    return out;
  });
}

// Per volume stream: the per-well suffix convention plus accepted bare aliases.
const VOLUME_STREAMS: Array<{ field: keyof Omit<AnnualVolumes, 'year'>; suffix: string; bare: string[] }> = [
  { field: 'oil_bbl',        suffix: '_oil_bbl',        bare: ['oil_bbl', 'oil_volume_bbl', 'oil_prod_bbl'] },
  { field: 'gas_mscf',       suffix: '_gas_mscf',       bare: ['gas_mscf', 'gas_volume_mscf', 'gas_prod_mscf'] },
  { field: 'condensate_bbl', suffix: '_condensate_bbl', bare: ['condensate_bbl', 'cond_bbl'] },
  { field: 'water_bbl',      suffix: '_water_bbl',      bare: ['water_bbl', 'water_prod_bbl'] },
];

// Column-name recognizer shared with the MC engine's production_scale
// perturbation so scaled columns stay in sync with what the engine reads.
export function isVolumeColumn(key: string): boolean {
  const k = normalizeKey(key);
  return VOLUME_STREAMS.some(s => k.endsWith(s.suffix) || s.bare.includes(k));
}

// Pick the columns to sum for one stream: per-well suffix columns win
// (excluding total_* rollups to avoid double counting); otherwise the first
// bare alias present; otherwise the total_* rollup alone.
function pickStreamCols(keys: string[], stream: { suffix: string; bare: string[] }): string[] {
  const perWell = keys.filter(k => k.endsWith(stream.suffix) && !k.startsWith('total_'));
  if (perWell.length > 0) return perWell;
  const bare = stream.bare.find(b => keys.includes(b));
  if (bare) return [bare];
  const total = `total${stream.suffix}`;
  if (keys.includes(total)) return [total];
  return [];
}

// Which columns each stream would read from these rows (normalized names).
// Used by computeCashFlow's ingestion validation to fail loudly.
export function pickVolumeColumns(prodRows: any[]): Record<string, string[]> {
  const out: Record<string, string[]> = { oil_bbl: [], gas_mscf: [], condensate_bbl: [], water_bbl: [] };
  if (!prodRows || prodRows.length === 0) return out;
  const keys = Object.keys(normalizeRows([prodRows[0]])[0]);
  for (const stream of VOLUME_STREAMS) out[stream.field] = pickStreamCols(keys, stream);
  return out;
}

const CAPEX_USD_COLS = ['amount_usd', 'cost_usd', 'capex_usd', 'total_capex_usd', 'value_usd'];
const OPEX_USD_COLS = ['total_opex_usd', 'opex_usd', 'cost_usd', 'amount_usd'];

// Which USD columns a cost file exposes (preferred aliases + *_usd fallback).
export function pickUsdColumns(rows: any[], preferredCols: string[], fallbackPattern?: RegExp): string[] {
  if (!rows || rows.length === 0) return [];
  const keys = Object.keys(normalizeRows([rows[0]])[0]);
  const preferred = keys.filter(k => preferredCols.includes(k));
  if (preferred.length > 0) return preferred;
  if (fallbackPattern) return keys.filter(k => fallbackPattern.test(k) && !k.startsWith('total_'));
  return [];
}

export function pickCapexColumns(rows: any[]): string[] {
  return pickUsdColumns(rows, CAPEX_USD_COLS, /_usd$/);
}

export function pickOpexColumns(rows: any[]): string[] {
  return pickUsdColumns(rows, OPEX_USD_COLS, /_usd$/);
}

// ============================================================================
// PRICE DECKS (v3.6, Wave B)
// ============================================================================

export type PriceStream = 'oil' | 'gas' | 'condensate';

// Accepted deck row value keys per stream: full config-style names plus the
// short aliases the Run Console deck editor writes.
const DECK_KEYS: Record<PriceStream, string[]> = {
  oil: ['oil', 'oil_price_usd_bbl'],
  gas: ['gas', 'gas_price_usd_mscf'],
  condensate: ['condensate', 'cond', 'condensate_price_usd_bbl'],
};

// Parse cfg.price_deck into per-stream sorted {year, value} entries. Tolerant
// of string numbers and rows that only price some streams. Shared with the
// MC and batch engines so sweep logic agrees with what the engine reads.
export function parsePriceDeck(cfg: any): Record<PriceStream, Array<{ year: number; value: number }>> {
  const out: Record<PriceStream, Array<{ year: number; value: number }>> = { oil: [], gas: [], condensate: [] };
  const deck = cfg?.price_deck;
  if (!Array.isArray(deck)) return out;
  for (const raw of deck) {
    if (!raw || typeof raw !== 'object') continue;
    const year = parseInt(String(raw.year));
    if (!Number.isFinite(year)) continue;
    for (const stream of Object.keys(DECK_KEYS) as PriceStream[]) {
      for (const key of DECK_KEYS[stream]) {
        const v = Number(raw[key]);
        if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '' && Number.isFinite(v)) {
          out[stream].push({ year, value: v });
          break;
        }
      }
    }
  }
  for (const stream of Object.keys(out) as PriceStream[]) {
    out[stream].sort((a, b) => a.year - b.year);
  }
  return out;
}

// Resolved price for one stream in one year. Deck rules: step-hold between
// entries, first value before the first entry, last value escalated by the
// stream escalator beyond the last entry; no deck -> flat base escalated
// from base_year. Differential is added after resolution and the optional
// scale multiplier (tornado/MC hook) applies last; result floors at 0.
export function resolveStreamPrice(
  entries: Array<{ year: number; value: number }>,
  flatBase: number,
  escalator: number,
  baseYear: number,
  year: number,
  differential = 0,
  scale = 1,
): number {
  let base: number;
  if (entries.length === 0) {
    base = flatBase * Math.pow(1 + escalator, year - baseYear);
  } else if (year <= entries[0].year) {
    base = entries[0].value;
  } else {
    let e = entries[0];
    for (const entry of entries) {
      if (entry.year <= year) e = entry; else break;
    }
    base = e.year === entries[entries.length - 1].year && year > e.year
      ? e.value * Math.pow(1 + escalator, year - e.year)
      : e.value;
  }
  return Math.max(0, (base + differential) * scale);
}

// ============================================================================
// VOLUME / COST AGGREGATION
// ============================================================================

function resolveRowYear(row: any, baseYear: number): number | null {
  let year: number;
  if (row.year !== undefined && row.year !== null) year = parseInt(String(row.year));
  else if (row.date) year = new Date(row.date).getUTCFullYear();
  else if (row.month_index !== undefined && row.month_index !== null) {
    year = baseYear + Math.floor((parseInt(String(row.month_index)) - 1) / 12);
  } else return null;
  return Number.isFinite(year) ? year : null;
}

export function extractAnnualVolumes(prodRows: any[], baseYear: number): AnnualVolumes[] {
  if (!prodRows || prodRows.length === 0) return [];
  const rows = normalizeRows(prodRows);
  const keys = Object.keys(rows[0]);
  const streamCols = VOLUME_STREAMS.map(s => ({ field: s.field, cols: pickStreamCols(keys, s) }));

  const annual = new Map<number, AnnualVolumes>();
  for (const row of rows) {
    const year = resolveRowYear(row, baseYear);
    if (year === null) continue;

    if (!annual.has(year)) annual.set(year, { year, oil_bbl: 0, gas_mscf: 0, condensate_bbl: 0, water_bbl: 0 });
    const a = annual.get(year)!;
    for (const { field, cols } of streamCols) {
      a[field] += cols.reduce((s, c) => s + (Number(row[c]) || 0), 0);
    }
  }
  return Array.from(annual.values()).sort((a, b) => a.year - b.year);
}

export function extractAnnualCapex(capexRows: any[], baseYear: number): Map<number, number> {
  return aggregateAnnualUsd(capexRows, baseYear, CAPEX_USD_COLS, /_usd$/, 'CAPEX file');
}

export function extractAnnualOpex(opexRows: any[], baseYear: number): Map<number, number> {
  return aggregateAnnualUsd(opexRows, baseYear, OPEX_USD_COLS, /_usd$/, 'OPEX file');
}

function aggregateAnnualUsd(rawRows: any[], baseYear: number, preferredCols: string[], fallbackPattern?: RegExp, fileLabel = 'Cost file'): Map<number, number> {
  const m = new Map<number, number>();
  if (!rawRows || rawRows.length === 0) return m;
  for (const row of normalizeRows(rawRows)) {
    const year = resolveRowYear(row, baseYear);
    if (year === null) continue;
    // v3.5 (Wave A finding 1.5): two different populated cost aliases on one
    // row are ambiguous — the old first-non-zero pick silently dropped the
    // rest. Duplicated identical values (a file exporting the same amount
    // under two names) stay accepted; differing values fail loudly.
    const populated = preferredCols.filter(c => {
      const v = Number(row[c]);
      return row[c] !== undefined && row[c] !== null && Number.isFinite(v) && v !== 0;
    });
    const distinct = new Set(populated.map(c => Number(row[c])));
    if (distinct.size > 1) {
      throw new Error(
        `Ingestion validation failed: ${fileLabel}: a row has multiple cost columns populated with different values ` +
        `(${populated.join(', ')}). Keep exactly one cost column per row so the amount is unambiguous.`
      );
    }
    let amt = populated.length > 0 ? Number(row[populated[0]]) : 0;
    if (amt === 0 && fallbackPattern) {
      amt = Object.keys(row)
        .filter(k => fallbackPattern.test(k) && !preferredCols.includes(k) && !k.startsWith('total_'))
        .reduce((s, k) => s + (Number(row[k]) || 0), 0);
    }
    m.set(year, (m.get(year) || 0) + amt);
  }
  return m;
}

// ============================================================================
// JV / PSC REGIMES (unchanged)
// ============================================================================

// v3.5 (Wave A finding 1.2): a loss year banks its loss and offsets the next
// positive taxable year instead of being clamped away. `lossCarryforwardIn`
// is the pool brought forward; the returned `loss_carryforward_after` is
// threaded by computeCashFlow. `applyLossRelief` false restores the old
// clamp-at-zero behavior (cfg.apply_loss_carryforward === false).
export function applyJV(
  inputs: RegimeInputs,
  workingInterest: number,
  royaltyRate: number,
  taxRate: number,
  lossCarryforwardIn = 0,
  applyLossRelief = true,
): RegimeOutputs & { loss_carryforward_after: number; loss_offset_used: number } {
  const wi = workingInterest;
  const gross = inputs.gross_revenue * wi;
  const royalty = gross * royaltyRate;
  const opex = inputs.opex * wi;
  const capex = inputs.capex * wi;
  const depr = inputs.depreciation * wi;
  const taxable = gross - royalty - opex - depr;
  let lossPool = applyLossRelief ? lossCarryforwardIn : 0;
  let lossOffset = 0;
  let chargeable = taxable;
  if (applyLossRelief) {
    if (taxable < 0) {
      lossPool += -taxable;
      chargeable = 0;
    } else {
      lossOffset = Math.min(lossPool, taxable);
      lossPool -= lossOffset;
      chargeable = taxable - lossOffset;
    }
  }
  const tax = Math.max(0, chargeable * taxRate);
  const net = gross - royalty - opex - capex - tax;
  return {
    royalty, taxable_income: taxable, tax, net_cash_flow: net,
    cumulative_unrecovered_cost_after: 0,
    loss_carryforward_after: applyLossRelief ? lossPool : 0,
    loss_offset_used: lossOffset,
  };
}

// v3.9 (Wave F): optional tranche split and Investment Tax Credit.
// `trancheShare` (when provided) replaces the flat contractor share; `itc`
// is this year's credit (itcPct x capex) plus any carried unused credit,
// applied against the tax line; unused credit is returned for carryforward.
export function applyPSC(
  inputs: RegimeInputs,
  royaltyRate: number,
  costOilCapPct: number,
  contractorProfitShare: number,
  taxRate: number,
  itcAvailable = 0,
): RegimeOutputs & { itc_used: number; itc_carryforward_after: number } {
  const gross = inputs.gross_revenue;
  const royalty = gross * royaltyRate;
  const revenueAfterRoyalty = gross - royalty;
  const recoverableThisYear = inputs.cumulative_unrecovered_cost + inputs.capex + inputs.opex;
  const costOilCap = revenueAfterRoyalty * costOilCapPct;
  const costRecovery = Math.min(recoverableThisYear, costOilCap);
  const carryForward = recoverableThisYear - costRecovery;
  const profitOil = revenueAfterRoyalty - costRecovery;
  const contractorProfitOil = profitOil * contractorProfitShare;
  const taxBeforeCredit = Math.max(0, contractorProfitOil * taxRate);
  const itcUsed = Math.min(itcAvailable, taxBeforeCredit);
  const tax = taxBeforeCredit - itcUsed;
  const net = costRecovery + contractorProfitOil - tax - inputs.capex - inputs.opex;
  return {
    royalty, taxable_income: contractorProfitOil, tax, net_cash_flow: net,
    cumulative_unrecovered_cost_after: carryForward,
    itc_used: itcUsed,
    itc_carryforward_after: itcAvailable - itcUsed,
  };
}

// Contractor profit share for the year from a cumulative-liquids tranche
// table: [{from_cum_mmbbl, contractor_share_pct}] sorted ascending; the
// tranche whose from_cum_mmbbl is the highest at or below the cumulative
// liquids AT THE START of the year applies for the whole year (annual-model
// simplification; document mid-year crossings as a known approximation).
export function pscTrancheShare(tranches: any[], cumLiquidsBbl: number): number | null {
  if (!Array.isArray(tranches) || tranches.length === 0) return null;
  const rows = tranches
    .map((t) => ({ from: Number(t.from_cum_mmbbl), share: Number(t.contractor_share_pct) }))
    .filter((t) => Number.isFinite(t.from) && Number.isFinite(t.share))
    .sort((a, b) => a.from - b.from);
  if (rows.length === 0) return null;
  let share = rows[0].share;
  const cumMM = cumLiquidsBbl / 1_000_000;
  for (const t of rows) {
    if (t.from <= cumMM) share = t.share; else break;
  }
  return share / 100;
}

// ============================================================================
// PIA RATE DERIVATION
// ============================================================================

// B2.5: extended for NTA-era deep offshore interpretation
export function deriveHctRate(
  terrain: string,
  licenseType: string,
  marginalPre2021: boolean,
  override: number | null,
  framework: FiscalFramework = 'pia_only',
  deepOffshoreInterpretation: DeepOffshoreInterpretation = 'conservative_zero',
  deepOffshoreCustomRatePct: number | null = null,
): number {
  if (override !== null && override !== undefined) return override / 100;

  // Frontier basin: HCT exempt under both PIA and NTA
  if (terrain === 'frontier') return 0;

  // Deep offshore: PIA exempt; NTA ambiguous
  if (terrain === 'deep_offshore') {
    if (framework === 'pia_only') return 0;
    // NTA-era: legal ambiguity per Olaniwun Ajayi (Oct 2025), Fortrose (Jan 2026)
    switch (deepOffshoreInterpretation) {
      case 'conservative_zero': return 0;
      case 'aggressive_pml_30': return 0.30;
      case 'custom':
        return (deepOffshoreCustomRatePct ?? 0) / 100;
      default:
        return 0;
    }
  }

  // Onshore + shallow water + marginal — unchanged between PIA and NTA
  if (marginalPre2021) return 0.15;
  if (licenseType === 'PPL') return 0.15;
  if (licenseType === 'PML') {
    if (terrain === 'onshore' || terrain === 'shallow_water' || terrain === 'marginal_field') return 0.30;
  }
  return 0.30;
}

export function deriveOilRoyaltyRate(terrain: string, oilBopd: number): number {
  switch (terrain) {
    case 'onshore':       return 0.150;
    case 'shallow_water': return 0.125;
    case 'deep_offshore': return oilBopd > 50000 ? 0.075 : 0.050;
    case 'frontier':      return 0.075;
    case 'marginal_field': {
      if (oilBopd <= 5000) return 0.050;
      if (oilBopd <= 10000) return (5000 * 0.050 + (oilBopd - 5000) * 0.075) / oilBopd;
      const blendedFirst10k = (5000 * 0.050 + 5000 * 0.075) / 10000;
      return (10000 * blendedFirst10k + (oilBopd - 10000) * 0.150) / oilBopd;
    }
    default: return 0.150;
  }
}

export function deriveGasRoyaltyRate(terrain: string): number {
  if (terrain === 'deep_offshore' || terrain === 'frontier') return 0.05;
  return 0.07;
}

export function derivePriceRoyaltyRate(fiscalPrice: number, year: number, terrain: string): number {
  if (terrain === 'frontier') return 0;
  const yearsFrom2021 = year - 2021;
  const escFactor = Math.pow(1.02, yearsFrom2021);
  const lowAnchor = 50 * escFactor;
  const midAnchor = 100 * escFactor;
  const highAnchor = 150 * escFactor;
  if (fiscalPrice <= lowAnchor) return 0;
  if (fiscalPrice >= highAnchor) return 0.10;
  if (fiscalPrice <= midAnchor) {
    const fraction = (fiscalPrice - lowAnchor) / (midAnchor - lowAnchor);
    return 0 + fraction * 0.05;
  }
  const fraction = (fiscalPrice - midAnchor) / (highAnchor - midAnchor);
  return 0.05 + fraction * 0.05;
}

// B2.5: extended for volume cap (PIA Sixth Schedule, NEW leases only)
//
// Per Q3(a) — mid-year split: if production crosses the cap mid-year, allowance
// is computed on the eligible bbl only (up to cap), zero on the rest.
//
// Returns: { allowance, eligible_bbl, cap_applied }
export function computeProductionAllowance(
  cfg: PIAConfig,
  oilAndCondBbl: number,
  fiscalPrice: number,
  priorCumulativeOil: number = 0,
): { allowance: number; eligible_bbl: number; cap_applied: boolean } {
  if (oilAndCondBbl <= 0) return { allowance: 0, eligible_bbl: 0, cap_applied: false };

  const pctCap = (cfg.pia_production_allowance_pct_of_price / 100) * fiscalPrice;
  const fixed = cfg.pia_lease_status === 'new'
    ? cfg.pia_production_allowance_per_bbl_new
    : cfg.pia_production_allowance_per_bbl_converted;
  const perBbl = Math.min(pctCap, fixed);

  // CONVERTED leases: no volume cap (Sixth Schedule applies only to new leases)
  if (cfg.pia_lease_status !== 'new') {
    return { allowance: perBbl * oilAndCondBbl, eligible_bbl: oilAndCondBbl, cap_applied: false };
  }

  // NEW lease: apply terrain-specific volume cap
  let terrainCap = 50_000_000;  // default to onshore
  switch (cfg.pia_terrain) {
    case 'onshore':
      terrainCap = cfg.pia_new_lease_prod_alw_cap_onshore_bbl ?? 50_000_000;
      break;
    case 'shallow_water':
    case 'marginal_field':
      terrainCap = cfg.pia_new_lease_prod_alw_cap_shallow_bbl ?? 100_000_000;
      break;
    case 'deep_offshore':
    case 'frontier':
      terrainCap = cfg.pia_new_lease_prod_alw_cap_deep_bbl ?? 500_000_000;
      break;
  }

  const remainingCapacity = Math.max(0, terrainCap - priorCumulativeOil);
  if (remainingCapacity === 0) {
    return { allowance: 0, eligible_bbl: 0, cap_applied: true };
  }
  if (oilAndCondBbl <= remainingCapacity) {
    // Entire year's production is below cap
    return { allowance: perBbl * oilAndCondBbl, eligible_bbl: oilAndCondBbl, cap_applied: false };
  }
  // Mid-year crossing: split
  return {
    allowance: perBbl * remainingCapacity,
    eligible_bbl: remainingCapacity,
    cap_applied: true,
  };
}

// ============================================================================
// PIA REGIME (B2.5 framework-aware)
// ============================================================================

export function applyPIA(
  inputs: PIAInputs,
  cfg: PIAConfig,
  state: PIAState,
  framework: FiscalFramework = 'pia_only',
): { output: PIAOutputs; newState: PIAState } {
  const oilBopd = inputs.oil_bbl / 365;
  const grossRev = inputs.gross_revenue;

  const oilCondRevenue = inputs.oil_and_cond_revenue;
  const gasRevenue = grossRev - oilCondRevenue;

  // Royalties (unchanged between PIA and NTA — NTA preserved PIA Seventh Schedule)
  const oilProdRoyaltyRate = deriveOilRoyaltyRate(cfg.pia_terrain, oilBopd);
  const gasProdRoyaltyRate = deriveGasRoyaltyRate(cfg.pia_terrain);
  const productionRoyalty = oilCondRevenue * oilProdRoyaltyRate + gasRevenue * gasProdRoyaltyRate;

  const priceRoyaltyRate = derivePriceRoyaltyRate(inputs.fiscal_oil_price_usd_bbl, inputs.year, cfg.pia_terrain);
  const priceRoyalty = oilCondRevenue * priceRoyaltyRate;

  const totalRoyalties = productionRoyalty + priceRoyalty;

  // HCDT (3% of prior year opex) and NDDC (fixed or percentage)
  const hcdt = state.prior_year_opex_usd > 0 ? 0.03 * state.prior_year_opex_usd : 0;
  const nddc = inputs.nddc_levy;

  // CPR (Cost Price Ratio) — cap costs at limit % of gross revenue
  const cprCap = grossRev * (cfg.pia_cpr_limit_pct / 100);
  const recoverableThisYear = state.cpr_carryforward + inputs.opex_inflated + inputs.capital_allowance_this_year;
  const cprClaimed = Math.min(recoverableThisYear, cprCap);
  const cprDeferred = recoverableThisYear - cprClaimed;
  const opexClaimed = Math.min(inputs.opex_inflated + state.cpr_carryforward, cprClaimed);
  const capAllowClaimed = cprClaimed - opexClaimed;

  // HCT computation
  //
  // v3.5 (Wave A finding 1.3): PIA charges HCT on crude oil and condensate
  // profits only — upstream gas profits are CIT-only. The HCT base is
  // liquids revenue less directly attributable oil royalties (liquids
  // production royalty + price royalty), less the liquids revenue-share of
  // costs that are not directly attributable (claimed opex, HCDT, capital
  // allowance). cfg.pia_hct_include_gas_revenue === true restores the old
  // whole-revenue base. Oil-only cases are numerically identical either way.
  const includeGasInHct = cfg.pia_hct_include_gas_revenue === true;
  const oilShare = includeGasInHct ? 1 : (grossRev > 0 ? oilCondRevenue / grossRev : 0);
  const hctRevenueBase = includeGasInHct ? grossRev : oilCondRevenue;
  const hctRoyalties = includeGasInHct
    ? totalRoyalties
    : oilCondRevenue * oilProdRoyaltyRate + priceRoyalty;
  const hctAssessableProfit = hctRevenueBase - hctRoyalties - opexClaimed * oilShare - hcdt * oilShare;

  // B2.5: Production allowance now cap-aware (Item C)
  const prodAlwResult = computeProductionAllowance(
    cfg,
    inputs.oil_bbl + inputs.condensate_bbl,
    inputs.fiscal_oil_price_usd_bbl,
    state.cumulative_oil_bbl_lifetime,
  );
  const productionAllowance = prodAlwResult.allowance;

  const hctChargeableProfit = hctAssessableProfit - capAllowClaimed * oilShare - productionAllowance;

  // B2.5: HCT rate now framework-aware (deep offshore interpretation matters)
  const hctRate = deriveHctRate(
    cfg.pia_terrain,
    cfg.pia_license_type,
    cfg.pia_marginal_field_pre_2021,
    cfg.pia_hct_rate_override_pct,
    framework,
    cfg.pia_deep_offshore_hct_interpretation ?? 'conservative_zero',
    cfg.pia_deep_offshore_hct_custom_rate_pct ?? null,
  );

  // v3.5 (Wave A finding 1.2): loss relief — a negative chargeable year banks
  // its loss; a positive year offsets the brought-forward pool. Separate
  // pools per tax (HCT and CIT have different bases).
  const applyLossRelief = cfg.apply_loss_carryforward !== false;
  let hctLossPool = applyLossRelief ? state.hct_loss_carryforward : 0;
  let hctLossOffset = 0;
  let hctTaxBase = hctChargeableProfit;
  if (applyLossRelief) {
    if (hctChargeableProfit < 0) {
      hctLossPool += -hctChargeableProfit;
      hctTaxBase = 0;
    } else {
      hctLossOffset = Math.min(hctLossPool, hctChargeableProfit);
      hctLossPool -= hctLossOffset;
      hctTaxBase = hctChargeableProfit - hctLossOffset;
    }
  }
  const hctTax = Math.max(0, hctTaxBase * hctRate);

  // CIT computation (base unchanged: CIT applies to oil AND gas profits)
  const citAssessableProfit = grossRev - totalRoyalties - opexClaimed - hcdt - nddc;
  const citCapAllowCap = Math.max(0, citAssessableProfit * 2 / 3);
  const citCapAllowClaimed = Math.min(capAllowClaimed, citCapAllowCap);
  const citChargeableProfit = citAssessableProfit - citCapAllowClaimed;
  let citLossPool = applyLossRelief ? state.cit_loss_carryforward : 0;
  let citLossOffset = 0;
  let citTaxBase = citChargeableProfit;
  if (applyLossRelief) {
    if (citChargeableProfit < 0) {
      citLossPool += -citChargeableProfit;
      citTaxBase = 0;
    } else {
      citLossOffset = Math.min(citLossPool, citChargeableProfit);
      citLossPool -= citLossOffset;
      citTaxBase = citChargeableProfit - citLossOffset;
    }
  }
  const citTax = Math.max(0, citTaxBase * (cfg.pia_cit_rate_pct / 100));

  // B2.5: TET vs Development Levy — framework-dependent (Items A2, B)
  // Same assessable-profit base (cit_assessable_profit), only rate differs
  let tetTax = 0;
  let devLevyTax = 0;
  if (framework === 'pia_only') {
    tetTax = Math.max(0, citAssessableProfit * (cfg.pia_tet_rate_pct / 100));
  } else {
    // NTA: Development Levy 4% per Section 59
    const devLevyRate = (cfg.pia_development_levy_rate_pct ?? 4.0) / 100;
    devLevyTax = Math.max(0, citAssessableProfit * devLevyRate);
  }

  const totalTax = hctTax + citTax + tetTax + devLevyTax;

  const netCashFlow =
    grossRev - totalRoyalties - inputs.opex_inflated - hcdt - nddc
    - hctTax - citTax - tetTax - devLevyTax
    - inputs.capex_inflated;

  return {
    output: {
      production_royalty: productionRoyalty,
      price_royalty: priceRoyalty,
      total_royalties: totalRoyalties,
      hcdt,
      nddc,
      hct_assessable_profit: hctAssessableProfit,
      production_allowance: productionAllowance,
      hct_chargeable_profit: hctChargeableProfit,
      hct_tax: hctTax,
      cit_assessable_profit: citAssessableProfit,
      cit_chargeable_profit: citChargeableProfit,
      cit_tax: citTax,
      tet_tax: tetTax,
      dev_levy_tax: devLevyTax,
      total_tax: totalTax,
      cpr_cap: cprCap,
      cpr_costs_claimed: cprClaimed,
      cpr_deferred_to_next: cprDeferred,
      net_cash_flow: netCashFlow,
      fiscal_framework: framework,
      prod_alw_cap_applied: prodAlwResult.cap_applied,
      prod_alw_eligible_bbl: prodAlwResult.eligible_bbl,
      hct_loss_offset_used: hctLossOffset,
      cit_loss_offset_used: citLossOffset,
      hct_loss_carryforward: hctLossPool,
      cit_loss_carryforward: citLossPool,
    },
    newState: {
      cpr_carryforward: cprDeferred,
      prior_year_opex_usd: inputs.opex_inflated,
      // B2.5: accumulate oil for volume-cap tracking
      cumulative_oil_bbl_lifetime: state.cumulative_oil_bbl_lifetime + inputs.oil_bbl + inputs.condensate_bbl,
      hct_loss_carryforward: hctLossPool,
      cit_loss_carryforward: citLossPool,
    },
  };
}

// ============================================================================
// FINANCIAL METRICS (unchanged)
// ============================================================================

export function npv(cashFlows: number[], discountRate: number, baseYear: number, firstYear: number): number {
  let total = 0;
  for (let i = 0; i < cashFlows.length; i++) {
    const yearOffset = (firstYear + i) - baseYear;
    total += cashFlows[i] / Math.pow(1 + discountRate, yearOffset);
  }
  return total;
}

export function irr(cashFlows: number[]): number | null {
  const hasNeg = cashFlows.some(cf => cf < 0);
  const hasPos = cashFlows.some(cf => cf > 0);
  if (!hasNeg || !hasPos) return null;

  const npvAt = (rate: number): number => {
    let f = 0;
    for (let i = 0; i < cashFlows.length; i++) f += cashFlows[i] / Math.pow(1 + rate, i);
    return f;
  };

  // Fast path: Newton from 10%, as before. Only a CONVERGED Newton result is
  // trusted; the old code returned the last iterate even when it never
  // converged (v3.5, Wave A finding 1.4).
  let r = 0.10;
  for (let iter = 0; iter < 100; iter++) {
    let f = 0, df = 0;
    for (let i = 0; i < cashFlows.length; i++) {
      const factor = Math.pow(1 + r, i);
      f += cashFlows[i] / factor;
      df -= i * cashFlows[i] / (factor * (1 + r));
    }
    if (Math.abs(df) < 1e-12) break;
    const r_new = r - f / df;
    if (Math.abs(r_new - r) < 1e-7) return r_new;
    r = r_new;
    if (r < -0.99) r = -0.99;
    if (r > 10) r = 10;
  }

  // Fallback: bisection on [-0.99, 10]. NPV(r) is continuous; without a sign
  // change in the bracket there is no IRR to report, so return null rather
  // than a number the cash flows do not support.
  let lo = -0.99, hi = 10;
  let fLo = npvAt(lo), fHi = npvAt(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let iter = 0; iter < 200 && hi - lo > 1e-9; iter++) {
    const mid = (lo + hi) / 2;
    const fMid = npvAt(mid);
    if (fMid === 0) return mid;
    if (fLo * fMid < 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}

// v3.4: numeric companion to paybackPeriod() — null means never paid back.
export function paybackYears(cashFlows: number[]): number | null {
  let cumulative = 0;
  for (let i = 0; i < cashFlows.length; i++) {
    const prev = cumulative;
    cumulative += cashFlows[i];
    if (prev < 0 && cumulative >= 0) return i + (-prev / cashFlows[i]);
  }
  return cumulative >= 0 ? 0 : null;
}

export function paybackPeriod(cashFlows: number[]): string {
  let cumulative = 0;
  for (let i = 0; i < cashFlows.length; i++) {
    const prev = cumulative;
    cumulative += cashFlows[i];
    if (prev < 0 && cumulative >= 0) {
      const fraction = -prev / cashFlows[i];
      return (i + fraction).toFixed(2) + ' years';
    }
  }
  return cumulative >= 0 ? 'Year 0' : 'Beyond project life';
}

// ============================================================================
// INGESTION VALIDATION (v3.3)
// ============================================================================
//
// A run whose uploads were silently dropped used to come back as a "successful"
// $0-revenue result. Fail loudly instead, naming the headers we saw so the
// user can fix the file (or we can add an alias).

const seenHeaders = (rows: any[]) =>
  rows.length > 0 ? Object.keys(normalizeRows([rows[0]])[0]).join(', ') : '(none)';

function validateIngestion({ cfg, prodRows, capexRows, opexRows, annualVols, annualCapex, annualOpex }: {
  cfg: any;
  prodRows: any[];
  capexRows: any[];
  opexRows: any[];
  annualVols: AnnualVolumes[];
  annualCapex: Map<number, number>;
  annualOpex: Map<number, number>;
}): void {
  const issues: string[] = [];

  const volCols = pickVolumeColumns(prodRows);
  const hasHydrocarbonCols =
    volCols.oil_bbl.length > 0 || volCols.gas_mscf.length > 0 || volCols.condensate_bbl.length > 0;
  if (!hasHydrocarbonCols) {
    issues.push(
      `Production file: no oil/gas/condensate volume columns recognized. ` +
      `Headers found: ${seenHeaders(prodRows)}. Expected per-well columns ending in ` +
      `_oil_bbl / _gas_mscf / _condensate_bbl, or bare oil_bbl / gas_mscf / condensate_bbl.`
    );
  } else if (annualVols.length === 0) {
    issues.push(
      `Production file: no row had a usable date. Provide a "year", "date" ` +
      `(YYYY-MM or YYYY-MM-DD), or "month_index" column.`
    );
  }

  if (capexRows.length > 0) {
    if (pickCapexColumns(capexRows).length === 0) {
      issues.push(
        `CAPEX file: no cost column recognized. Headers found: ${seenHeaders(capexRows)}. ` +
        `Expected one of ${CAPEX_USD_COLS.join(' / ')} (or any *_usd column).`
      );
    } else if (annualCapex.size === 0) {
      issues.push(`CAPEX file: no row had a usable date (need "year", "date", or "month_index").`);
    }
  }

  if (opexRows.length > 0) {
    if (pickOpexColumns(opexRows).length === 0) {
      issues.push(
        `OPEX file: no cost column recognized. Headers found: ${seenHeaders(opexRows)}. ` +
        `Expected one of ${OPEX_USD_COLS.join(' / ')} (or any *_usd column).`
      );
    } else if (annualOpex.size === 0) {
      issues.push(`OPEX file: no row had a usable date (need "year", "date", or "month_index").`);
    }
  }

  // Prices: a null/unset price for a stream with nonzero volumes silently
  // zeroed (or NaN-poisoned) revenue. Require it explicitly.
  const totals = annualVols.reduce(
    (t, v) => ({ oil: t.oil + v.oil_bbl, gas: t.gas + v.gas_mscf, cond: t.cond + v.condensate_bbl }),
    { oil: 0, gas: 0, cond: 0 }
  );
  const priceUnset = (raw: any) =>
    raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw));
  // v3.6: a per-year deck entry for the stream also satisfies the requirement.
  const deck = parsePriceDeck(cfg);
  if (totals.oil > 0 && priceUnset(cfg.oil_price_usd_bbl) && deck.oil.length === 0) {
    issues.push(`Oil price (oil_price_usd_bbl) is not set but the production data has oil volumes.`);
  }
  if (totals.gas > 0 && priceUnset(cfg.gas_price_usd_mscf) && deck.gas.length === 0) {
    issues.push(`Gas price (gas_price_usd_mscf) is not set but the production data has gas volumes.`);
  }
  if (totals.cond > 0 && priceUnset(cfg.condensate_price_usd_bbl) && deck.condensate.length === 0) {
    issues.push(`Condensate price (condensate_price_usd_bbl) is not set but the production data has condensate volumes.`);
  }

  if (issues.length > 0) {
    throw new Error(`Ingestion validation failed: ${issues.join(' | ')}`);
  }
}

// ============================================================================
// MAIN COMPUTE FUNCTION (B2.5 framework-aware)
// ============================================================================

export function computeCashFlow(input: ComputeInput): ComputeOutput {
  const { cfg, prodRows, capexRows, opexRows } = input;

  if (!prodRows || prodRows.length === 0) {
    throw new Error('No production data found. Upload and process a CSV first.');
  }

  // B2.5: determine fiscal framework once per run
  const framework = determineFiscalFramework(cfg);

  const baseYear = cfg.base_year || 2027;
  const inflationRate = Number(cfg.inflation_rate_pct ?? 0) / 100;
  const oilEscalator  = Number(cfg.oil_price_escalator_pct       ?? cfg.inflation_rate_pct ?? 0) / 100;
  const gasEscalator  = Number(cfg.gas_price_escalator_pct       ?? cfg.inflation_rate_pct ?? 0) / 100;
  const condEscalator = Number(cfg.condensate_price_escalator_pct ?? cfg.inflation_rate_pct ?? 0) / 100;
  const opexEscalator = Number(cfg.opex_escalator_pct            ?? cfg.inflation_rate_pct ?? 0) / 100;
  const capexEscalator = Number(cfg.capex_escalator_pct          ?? 0) / 100;

  const pvBasis = (cfg.present_value_basis || 'real') as 'real' | 'nominal';
  const nominalDiscountRate = Number(cfg.discount_rate_pct) / 100;
  const realDiscountRate = (1 + nominalDiscountRate) / (1 + inflationRate) - 1;
  const discountForNPV = pvBasis === 'real' ? realDiscountRate : nominalDiscountRate;

  // ---- v3.6 (Wave B): discounting convention + valuation date ----
  const midYear = cfg.discounting_convention === 'mid_year';
  const valuationYearRaw = parseInt(String(cfg.valuation_year ?? ''));
  const valuationYear = Number.isFinite(valuationYearRaw) && valuationYearRaw > 0 ? valuationYearRaw : baseYear;
  const sunkCutoff = cfg.treat_prior_as_sunk === true ? valuationYear : null;
  // Discount exponent: years from the valuation date, +0.5 under mid-year.
  const dexp = (year: number) => (year - valuationYear) + (midYear ? 0.5 : 0);

  // ---- v3.6 (Wave B): price resolution (decks, differentials, scales) ----
  const priceDeck = parsePriceDeck(cfg);
  const oilDiff = Number(cfg.oil_price_differential_usd_bbl ?? 0) || 0;
  const gasDiff = Number(cfg.gas_price_differential_usd_mscf ?? 0) || 0;
  const condDiff = Number(cfg.condensate_price_differential_usd_bbl ?? 0) || 0;
  const oilScale = Number(cfg.oil_price_scale ?? 1) || 1;
  const gasScale = Number(cfg.gas_price_scale ?? 1) || 1;
  const condScale = Number(cfg.condensate_price_scale ?? 1) || 1;
  const oilPriceAt = (year: number) =>
    resolveStreamPrice(priceDeck.oil, Number(cfg.oil_price_usd_bbl) || 0, oilEscalator, baseYear, year, oilDiff, oilScale);
  const gasPriceAt = (year: number) =>
    resolveStreamPrice(priceDeck.gas, Number(cfg.gas_price_usd_mscf) || 0, gasEscalator, baseYear, year, gasDiff, gasScale);
  const condPriceAt = (year: number) =>
    resolveStreamPrice(priceDeck.condensate, Number(cfg.condensate_price_usd_bbl) || 0, condEscalator, baseYear, year, condDiff, condScale);

  // ---- v3.6 (Wave B): working interest for PSC / PIA ----
  // Fiscal math runs at 100% field level (rate tiers, thresholds and caps
  // are field-level constructs); monetary line items and entitlement volumes
  // are scaled to the WI share afterwards. JV scales inside applyJV.
  const wiRegime = cfg.fiscal_regime === 'PIA'
    ? Math.max(0, Math.min(1, Number(cfg.pia_working_interest_pct ?? 100) / 100))
    : cfg.fiscal_regime === 'PSC'
      ? Math.max(0, Math.min(1, Number(cfg.psc_working_interest_pct ?? 100) / 100))
      : 1;

  const annualVols = extractAnnualVolumes(prodRows, baseYear);
  const annualCapex = extractAnnualCapex(capexRows, baseYear);
  let annualOpex = extractAnnualOpex(opexRows, baseYear);

  // v3.7 (Wave C): first-oil delay. Production and opex shift together;
  // capex (and the allowances it seeds) stays on the committed schedule.
  const scheduleShift = parseInt(String(cfg.schedule_shift_years ?? '')) || 0;
  if (scheduleShift !== 0) {
    for (const v of annualVols) v.year += scheduleShift;
    annualOpex = new Map(Array.from(annualOpex.entries()).map(([y, amt]) => [y + scheduleShift, amt]));
  }

  validateIngestion({ cfg, prodRows, capexRows, opexRows, annualVols, annualCapex, annualOpex });

  const yearSet = new Set<number>([
    ...annualVols.map(v => v.year),
    ...annualCapex.keys(),
    ...annualOpex.keys()
  ]);
  const years = Array.from(yearSet).sort((a, b) => a - b);

  // ---- v3.4: economic limit test (config-gated, default off) ----
  // Trim trailing years whose escalated revenue no longer covers inflated
  // opex, before the fiscal loop, so royalties/taxes never accrue on an
  // uneconomic tail. Mid-life negative years that recover later are kept;
  // trailing capex-only years (revenue 0, opex 0) are kept.
  let economicLimitYear: number | null = null;
  let yearsTrimmedByLimit = 0;
  if (cfg.apply_economic_limit === true) {
    // v3.5 (Wave A finding 1.6): the limit test now uses net operating income
    // (revenue less the regime's royalty burden less opex), not bare revenue
    // less opex — a tail year whose margin only exists before royalty is not
    // economic to produce.
    const netOperatingIncome = (year: number): number => {
      const t = year - baseYear;
      const v = annualVols.find(vv => vv.year === year);
      let rev = 0;
      let royalty = 0;
      if (v) {
        const oilP = oilPriceAt(year);
        const gasP = gasPriceAt(year);
        const condP = condPriceAt(year);
        const oilCondRev = v.oil_bbl * oilP + v.condensate_bbl * condP;
        const gasRev = v.gas_mscf * gasP;
        rev = oilCondRev + gasRev;
        if (cfg.fiscal_regime === 'PIA') {
          const oilRoyRate = deriveOilRoyaltyRate(cfg.pia_terrain, v.oil_bbl / 365);
          const gasRoyRate = deriveGasRoyaltyRate(cfg.pia_terrain);
          const priceRoyRate = derivePriceRoyaltyRate(oilP, year, cfg.pia_terrain);
          royalty = oilCondRev * (oilRoyRate + priceRoyRate) + gasRev * gasRoyRate;
        } else if (cfg.fiscal_regime === 'PSC') {
          royalty = rev * (Number(cfg.psc_royalty_pct) || 0) / 100;
        } else {
          royalty = rev * (Number(cfg.jv_royalty_pct) || 0) / 100;
        }
      }
      const opex = (annualOpex.get(year) || 0) * Math.pow(1 + opexEscalator, t);
      return rev - royalty - opex;
    };
    while (years.length > 1 && netOperatingIncome(years[years.length - 1]) < 0) {
      years.pop();
      yearsTrimmedByLimit++;
    }
    economicLimitYear = years[years.length - 1];
  }

  // ---- v3.4: abandonment / decommissioning (config-gated, default off) ----
  // Lump sum entered in money-of-the-day for its year, applied as a post-tax
  // cash outflow in cfg.abandonment_year (default: final modeled year). See
  // the header note on the deliberate no-deduction treatment.
  const abandonmentCost = Number(cfg.abandonment_cost_usd) || 0;
  let abandonmentYear: number | null = null;
  if (abandonmentCost > 0 && years.length > 0) {
    const requested = parseInt(String(cfg.abandonment_year ?? ''));
    abandonmentYear = Number.isFinite(requested) && requested > 0 ? requested : years[years.length - 1];
    if (!years.includes(abandonmentYear)) {
      years.push(abandonmentYear);
      years.sort((a, b) => a - b);
    }
  }
  // v3.9 (Wave F): decommissioning sinking fund. Equal annual contributions
  // from the start year through the abandonment year; contributions deduct
  // in the regime tax bases and the final spend draws on the fund (no
  // second cash hit). Default stays the post-tax lump sum.
  const sinkingFund = cfg.abandonment_funding_mode === 'sinking_fund'
    && abandonmentCost > 0 && abandonmentYear !== null;
  const fundContribution = new Map<number, number>();
  if (sinkingFund) {
    const reqStart = parseInt(String(cfg.abandonment_fund_start_year ?? ''));
    const fundStart = Number.isFinite(reqStart) && reqStart > 0
      ? Math.min(reqStart, abandonmentYear!) : years[0];
    const fundYears = years.filter(y => y >= fundStart && y <= abandonmentYear!);
    const perYear = abandonmentCost / Math.max(1, fundYears.length);
    for (const y of fundYears) fundContribution.set(y, perYear);
  }

  const isPIA = cfg.fiscal_regime === 'PIA';
  // v3.9 (Wave F): JV/PSC life is configurable; 'nigeria_ppt' applies the
  // statutory PPT-era schedule 20/20/20/20/19 with the 1% retention held
  // until disposal (deliberately never claimed in-model).
  const deprMethod = cfg.depreciation_method === 'nigeria_ppt' && !isPIA ? 'nigeria_ppt' : 'straight_line';
  const DEPR_LIFE = isPIA
    ? (cfg.pia_capex_recovery_years || 5)
    : Math.max(1, Math.round(Number(cfg.jv_psc_depr_years ?? 10) || 10));
  const PPT_SCHEDULE = [0.20, 0.20, 0.20, 0.20, 0.19];

  const annualDepr = new Map<number, number>();
  const annualCapexInflated = new Map<number, number>();
  for (const [capexYear, capexAmount] of annualCapex.entries()) {
    const t = capexYear - baseYear;
    const inflatedCapex = capexAmount * Math.pow(1 + capexEscalator, t);
    annualCapexInflated.set(capexYear, inflatedCapex);
    if (deprMethod === 'nigeria_ppt') {
      PPT_SCHEDULE.forEach((pct, i) => {
        const y = capexYear + i;
        annualDepr.set(y, (annualDepr.get(y) || 0) + inflatedCapex * pct);
      });
    } else {
      const annualPortion = inflatedCapex / DEPR_LIFE;
      for (let y = capexYear; y < capexYear + DEPR_LIFE; y++) {
        annualDepr.set(y, (annualDepr.get(y) || 0) + annualPortion);
      }
    }
  }

  const cashFlowData: any[] = [];
  let cumCF_nominal = 0;
  let cumCF_real = 0;
  let pscCarryforward = 0;

  // B2.5: initialize PIA state with prior cumulative oil if specified
  let piaState: PIAState = {
    cpr_carryforward: 0,
    prior_year_opex_usd: Number(cfg.pia_prior_year_opex_usd ?? 0),
    cumulative_oil_bbl_lifetime: Number(cfg.pia_prior_cumulative_oil_bbl ?? 0),
    hct_loss_carryforward: 0,
    cit_loss_carryforward: 0,
  };
  let jvLossCarryforward = 0;
  const applyLossRelief = cfg.apply_loss_carryforward !== false;
  // v3.9 (Wave F): PSC tranche/ITC state
  let pscItcCarry = 0;
  let pscCumLiquidsBbl = Number(cfg.psc_prior_cumulative_liquids_bbl ?? 0) || 0;

  for (const year of years) {
    const t = year - baseYear;
    const v = annualVols.find(vv => vv.year === year) || { oil_bbl: 0, gas_mscf: 0, condensate_bbl: 0, water_bbl: 0 };
    const capexNominal = annualCapexInflated.get(year) || 0;
    const opexInflated = (annualOpex.get(year) || 0) * Math.pow(1 + opexEscalator, t);
    const depr = annualDepr.get(year) || 0;

    // validateIngestion() already required a price (flat or deck) wherever
    // volumes exist; unset flat prices on zero-volume streams resolve to 0 so
    // they can't NaN-poison gross revenue.
    const oilPrice = oilPriceAt(year);
    const gasPrice = gasPriceAt(year);
    const condPrice = condPriceAt(year);

    const oilRev = v.oil_bbl * oilPrice;
    const gasRev = v.gas_mscf * gasPrice;
    const condRev = v.condensate_bbl * condPrice;
    const grossRev = oilRev + gasRev + condRev;
    const oilAndCondRev = oilRev + condRev;

    let regOut: RegimeOutputs;
    const baseRow: any = {
      year,
      gross_revenue: grossRev,
      revenue: grossRev,
      opex: opexInflated,
      capex: capexNominal,
      depreciation: depr,
      oil_bbl: v.oil_bbl,
      gas_mscf: v.gas_mscf,
      condensate_bbl: v.condensate_bbl,
      applied_oil_price: oilPrice,
      applied_gas_price: gasPrice,
      applied_cond_price: condPrice,
    };

    if (cfg.fiscal_regime === 'PIA') {
      const nddcLevy = cfg.pia_nddc_levy_fixed_usd != null
        ? Number(cfg.pia_nddc_levy_fixed_usd)
        : opexInflated * (Number(cfg.pia_nddc_levy_pct_of_opex ?? 3) / 100);

      const capAllowThisYear = annualDepr.get(year) || 0;

      const piaInputs: PIAInputs = {
        year,
        oil_bbl: v.oil_bbl,
        gas_mscf: v.gas_mscf,
        condensate_bbl: v.condensate_bbl,
        fiscal_oil_price_usd_bbl: oilPrice,
        gross_revenue: grossRev,
        oil_and_cond_revenue: oilAndCondRev,
        capex_inflated: capexNominal,
        opex_inflated: opexInflated,
        capital_allowance_this_year: capAllowThisYear,
        nddc_levy: nddcLevy,
      };

      // B2.5: pass framework to applyPIA
      const { output: pia, newState } = applyPIA(piaInputs, cfg as unknown as PIAConfig, piaState, framework);
      piaState = newState;

      // v3.9 (Wave F): decommissioning fund contribution — deductible in the
      // HCT (liquids share) and CIT bases outside the CPR machinery, cash
      // out this year. Levy bases (HCDT/NDDC) deliberately unaffected.
      const decomContribution = fundContribution.get(year) || 0;
      if (decomContribution > 0) {
        const oilShareForFund = pia.hct_assessable_profit !== 0 || grossRev > 0
          ? (grossRev > 0 ? oilAndCondRev / grossRev : 0) : 0;
        const hctRelief = decomContribution * oilShareForFund * (pia.hct_chargeable_profit > 0 ? 1 : 0);
        const hctRateEff = pia.hct_chargeable_profit > 0 && pia.hct_tax > 0
          ? pia.hct_tax / Math.max(1e-9, pia.hct_chargeable_profit) : 0;
        const hctSaving = Math.min(pia.hct_tax, hctRelief * hctRateEff);
        const citRateEff = (Number(cfg.pia_cit_rate_pct ?? 30) / 100);
        const citSaving = Math.min(pia.cit_tax, decomContribution * citRateEff);
        pia.hct_tax -= hctSaving;
        pia.cit_tax -= citSaving;
        pia.total_tax -= hctSaving + citSaving;
        pia.net_cash_flow += hctSaving + citSaving - decomContribution;
        baseRow.decom_fund_contribution = decomContribution;
        baseRow.decom_fund_tax_relief = hctSaving + citSaving;
      }

      // v3.9 (Wave F): minimum effective tax rate top-up (config-gated,
      // PROJECT-LEVEL APPROXIMATION of NTA 2025 s.57 — the statutory test is
      // company-level with NGN turnover thresholds; reviewers can strip the
      // reported top-up line).
      if (cfg.pia_apply_minimum_etr === true) {
        const etr = (Number(cfg.pia_minimum_etr_pct ?? 15) || 15) / 100;
        const floor = Math.max(0, pia.cit_assessable_profit * etr);
        const paid = pia.hct_tax + pia.cit_tax + pia.tet_tax + pia.dev_levy_tax;
        if (paid < floor) {
          const topup = floor - paid;
          pia.total_tax += topup;
          pia.net_cash_flow -= topup;
          baseRow.min_etr_topup = topup;
        }
      }

      regOut = {
        royalty: pia.total_royalties,
        taxable_income: pia.hct_chargeable_profit + pia.cit_chargeable_profit,
        tax: pia.total_tax,
        net_cash_flow: pia.net_cash_flow,
        cumulative_unrecovered_cost_after: pia.cpr_deferred_to_next,
      };

      Object.assign(baseRow, {
        production_royalty: pia.production_royalty,
        price_royalty: pia.price_royalty,
        royalty: pia.total_royalties,
        hcdt: pia.hcdt,
        nddc: pia.nddc,
        hct_assessable_profit: pia.hct_assessable_profit,
        production_allowance: pia.production_allowance,
        hct_chargeable_profit: pia.hct_chargeable_profit,
        hct_tax: pia.hct_tax,
        cit_assessable_profit: pia.cit_assessable_profit,
        cit_chargeable_profit: pia.cit_chargeable_profit,
        cit_tax: pia.cit_tax,
        tet_tax: pia.tet_tax,
        dev_levy_tax: pia.dev_levy_tax,   // B2.5: NEW field
        tax: pia.total_tax,
        taxable_income: pia.hct_chargeable_profit + pia.cit_chargeable_profit,
        cpr_cap: pia.cpr_cap,
        cpr_costs_claimed: pia.cpr_costs_claimed,
        cpr_deferred_to_next: pia.cpr_deferred_to_next,
        net_cash_flow: pia.net_cash_flow,
        netCashFlow: pia.net_cash_flow,
        // B2.5 diagnostics
        fiscal_framework: pia.fiscal_framework,
        prod_alw_cap_applied: pia.prod_alw_cap_applied,
        prod_alw_eligible_bbl: pia.prod_alw_eligible_bbl,
        cumulative_oil_bbl_lifetime: piaState.cumulative_oil_bbl_lifetime,
        // v3.5 loss-relief diagnostics
        hct_loss_offset_used: pia.hct_loss_offset_used,
        cit_loss_offset_used: pia.cit_loss_offset_used,
        hct_loss_carryforward: pia.hct_loss_carryforward,
        cit_loss_carryforward: pia.cit_loss_carryforward,
      });

    } else if (cfg.fiscal_regime === 'PSC') {
      // v3.9 (Wave F): tranche share from cumulative liquids at the START of
      // the year (annual-model simplification); ITC = pct of this year's
      // capex, credited against tax with carryforward; decom contribution
      // rides the opex lane (recoverable cost + cash out).
      const decomContributionPsc = fundContribution.get(year) || 0;
      const trancheShare = cfg.psc_profit_split_mode === 'tranches'
        ? pscTrancheShare(cfg.psc_profit_tranches, pscCumLiquidsBbl) : null;
      const shareEff = trancheShare ?? (Number(cfg.psc_contractor_profit_share_pct) / 100);
      const itcThisYear = (Number(cfg.psc_itc_pct ?? 0) || 0) / 100 * capexNominal;
      const pscOut = applyPSC(
        { gross_revenue: grossRev, capex: capexNominal, opex: opexInflated + decomContributionPsc, depreciation: depr, cumulative_unrecovered_cost: pscCarryforward },
        Number(cfg.psc_royalty_pct) / 100,
        Number(cfg.psc_cost_oil_cap_pct) / 100,
        shareEff,
        Number(cfg.psc_tax_rate_pct) / 100,
        pscItcCarry + itcThisYear
      );
      pscCarryforward = pscOut.cumulative_unrecovered_cost_after;
      pscItcCarry = pscOut.itc_carryforward_after;
      pscCumLiquidsBbl += v.oil_bbl + v.condensate_bbl;
      regOut = pscOut;
      Object.assign(baseRow, {
        royalty: regOut.royalty,
        taxable_income: regOut.taxable_income,
        tax: regOut.tax,
        net_cash_flow: regOut.net_cash_flow,
        netCashFlow: regOut.net_cash_flow,
        psc_contractor_share_pct: shareEff * 100,
        ...(itcThisYear > 0 || pscOut.itc_used > 0
          ? { psc_itc_used: pscOut.itc_used, psc_itc_carryforward: pscOut.itc_carryforward_after } : {}),
        ...(decomContributionPsc > 0 ? { decom_fund_contribution: decomContributionPsc } : {}),
      });
    } else {
      const decomContributionJv = fundContribution.get(year) || 0;
      const jvOut = applyJV(
        { gross_revenue: grossRev, capex: capexNominal, opex: opexInflated + decomContributionJv, depreciation: depr, cumulative_unrecovered_cost: 0 },
        Number(cfg.jv_working_interest_pct) / 100,
        Number(cfg.jv_royalty_pct) / 100,
        Number(cfg.jv_tax_rate_pct) / 100,
        jvLossCarryforward,
        applyLossRelief,
      );
      jvLossCarryforward = jvOut.loss_carryforward_after;
      regOut = jvOut;
      Object.assign(baseRow, {
        royalty: regOut.royalty,
        taxable_income: regOut.taxable_income,
        tax: regOut.tax,
        net_cash_flow: regOut.net_cash_flow,
        netCashFlow: regOut.net_cash_flow,
        loss_offset_used: jvOut.loss_offset_used,
        loss_carryforward: jvOut.loss_carryforward_after,
        ...(decomContributionJv > 0 ? { decom_fund_contribution: decomContributionJv } : {}),
      });
    }

    // v3.6 (Wave B): scale PSC/PIA rows to the working-interest share. The
    // fiscal computation above ran at 100% field level; every monetary line
    // and the entitlement volumes now become the WI share. Field-level
    // diagnostics (applied prices, cumulative_oil_bbl_lifetime,
    // prod_alw_eligible_bbl) stay unscaled, as does the field-level pool
    // state threaded between years (pscCarryforward, piaState).
    if (wiRegime !== 1) {
      const WI_SCALED_KEYS = [
        'gross_revenue', 'revenue', 'opex', 'capex', 'depreciation',
        'oil_bbl', 'gas_mscf', 'condensate_bbl',
        'royalty', 'production_royalty', 'price_royalty', 'hcdt', 'nddc',
        'hct_assessable_profit', 'production_allowance', 'hct_chargeable_profit', 'hct_tax',
        'cit_assessable_profit', 'cit_chargeable_profit', 'cit_tax',
        'tet_tax', 'dev_levy_tax', 'tax', 'taxable_income',
        'cpr_cap', 'cpr_costs_claimed', 'cpr_deferred_to_next',
        'hct_loss_offset_used', 'cit_loss_offset_used',
        'hct_loss_carryforward', 'cit_loss_carryforward',
        'min_etr_topup', 'decom_fund_contribution', 'decom_fund_tax_relief',
        'psc_itc_used', 'psc_itc_carryforward',
        'net_cash_flow', 'netCashFlow',
      ];
      for (const k of WI_SCALED_KEYS) {
        if (typeof baseRow[k] === 'number') baseRow[k] *= wiRegime;
      }
      regOut.royalty *= wiRegime;
      regOut.taxable_income *= wiRegime;
      regOut.tax *= wiRegime;
      regOut.net_cash_flow *= wiRegime;
      baseRow.working_interest_pct = wiRegime * 100;
    }

    // v3.4: abandonment outflow lands after regime math (post-tax by design).
    // Entered as the user's own share, so applied after WI scaling. v3.9:
    // under a sinking fund the spend is paid FROM the fund (contributions
    // already hit cash), so no second outflow here.
    if (abandonmentYear !== null && year === abandonmentYear) {
      if (sinkingFund) {
        baseRow.abandonment_cost_funded = abandonmentCost;
      } else {
        regOut.net_cash_flow -= abandonmentCost;
        baseRow.abandonment_cost = abandonmentCost;
        baseRow.net_cash_flow = regOut.net_cash_flow;
        baseRow.netCashFlow = regOut.net_cash_flow;
      }
    }

    const deflator = Math.pow(1 + inflationRate, t);
    const realCF = regOut.net_cash_flow / deflator;
    cumCF_nominal += regOut.net_cash_flow;
    cumCF_real += realCF;

    Object.assign(baseRow, {
      real_net_cash_flow: realCF,
      discounted_cash_flow: (pvBasis === 'real' ? realCF : regOut.net_cash_flow) / Math.pow(1 + discountForNPV, dexp(year)),
      cumulative_cash_flow: pvBasis === 'real' ? cumCF_real : cumCF_nominal,
      cumulative_nominal: cumCF_nominal,
      cumulative_real: cumCF_real,
    });
    // v3.6: pre-valuation years stay modeled (fiscal state accrued above)
    // but are excluded from the value metrics when treated as sunk.
    if (sunkCutoff !== null && year < sunkCutoff) baseRow.sunk = true;

    cashFlowData.push(baseRow);
  }

  // B2.5: CPR cessation forfeiture diagnostic (Item D)
  let cprForfeited = 0;
  if (cfg.fiscal_regime === 'PIA' && piaState.cpr_carryforward > 0 && cashFlowData.length > 0) {
    cprForfeited = piaState.cpr_carryforward * wiRegime;  // v3.6: WI share
    const lastRow = cashFlowData[cashFlowData.length - 1];
    lastRow.cpr_forfeited_at_cessation = cprForfeited;
  }

  // v3.5: tax losses left unused at cessation (diagnostic, mirrors CPR
  // forfeiture); v3.6 reports the WI share for PSC/PIA.
  const unusedTaxLosses = (cfg.fiscal_regime === 'PIA'
    ? piaState.hct_loss_carryforward + piaState.cit_loss_carryforward
    : (cfg.fiscal_regime === 'PSC' ? 0 : jvLossCarryforward)) * wiRegime;

  // v3.6: value metrics run over the evaluated (non-sunk) rows; discounting
  // uses the valuation-date/mid-year exponent already baked into
  // discounted_cash_flow above.
  const evalRows = cashFlowData.filter(d => d.sunk !== true);
  const cfForIRR = evalRows.map(d => d.net_cash_flow);
  const cfForPayback = evalRows.map(d => d.net_cash_flow);
  const npvVal = evalRows.reduce((s, d) => s + d.discounted_cash_flow, 0);
  const irrVal = irr(cfForIRR);
  const paybackVal = paybackPeriod(cfForPayback);

  const kpis: any = {
    engine_version: ENGINE_VERSION,
    npv: npvVal,
    irr: irrVal !== null ? irrVal * 100 : null,
    payback: paybackVal,
    pv_basis: pvBasis,
    discount_rate_applied_pct: discountForNPV * 100,
    fiscal_regime: cfg.fiscal_regime,
    fiscal_framework: framework,  // B2.5: surface to KPIs for UI
    discounting_convention: midYear ? 'mid_year' : 'end_year',  // v3.6
    total_revenue: evalRows.reduce((s, d) => s + d.gross_revenue, 0),
    total_capex: evalRows.reduce((s, d) => s + d.capex, 0),
    total_opex: evalRows.reduce((s, d) => s + d.opex, 0),
    total_tax: evalRows.reduce((s, d) => s + (d.tax || 0), 0),
    total_net_cash_flow_nominal: evalRows.reduce((s, d) => s + d.net_cash_flow, 0),
    total_net_cash_flow_real: evalRows.reduce((s, d) => s + d.real_net_cash_flow, 0),
    total_net_cash_flow: evalRows.reduce((s, d) => s + (pvBasis === 'real' ? d.real_net_cash_flow : d.net_cash_flow), 0),
  };
  // v3.6 provenance / equity KPIs
  if (valuationYear !== baseYear || sunkCutoff !== null) kpis.valuation_year = valuationYear;
  if (sunkCutoff !== null) {
    kpis.sunk_net_cash_flow = cashFlowData.filter(d => d.sunk === true)
      .reduce((s, d) => s + d.net_cash_flow, 0);
  }
  if (wiRegime !== 1) kpis.working_interest_pct = wiRegime * 100;
  else if (cfg.fiscal_regime === 'JV') kpis.working_interest_pct = Number(cfg.jv_working_interest_pct ?? 100);

  // ---- v3.4: decision KPI bundle ----
  // BOE conversion uses the industry 6:1 gas energy-equivalence convention.
  const GAS_MSCF_PER_BOE = 6.0;
  const totalOilBbl = evalRows.reduce((s, d) => s + (d.oil_bbl || 0), 0);
  const totalGasMscf = evalRows.reduce((s, d) => s + (d.gas_mscf || 0), 0);
  const totalCondBbl = evalRows.reduce((s, d) => s + (d.condensate_bbl || 0), 0);
  const totalBoe = totalOilBbl + totalCondBbl + totalGasMscf / GAS_MSCF_PER_BOE;
  const totalAbandonment = abandonmentYear !== null ? abandonmentCost : 0;

  kpis.total_oil_bbl = totalOilBbl;
  kpis.total_gas_mscf = totalGasMscf;
  kpis.total_condensate_bbl = totalCondBbl;
  kpis.total_boe = totalBoe;
  if (totalAbandonment > 0) {
    kpis.total_abandonment_cost = totalAbandonment;
    kpis.abandonment_year = abandonmentYear;
  }
  if (cfg.apply_economic_limit === true) {
    kpis.economic_limit_year = economicLimitYear;
    kpis.years_trimmed_by_economic_limit = yearsTrimmedByLimit;
  }
  if (unusedTaxLosses > 0) {
    kpis.tax_losses_unused_at_cessation = unusedTaxLosses;
  }
  if (scheduleShift !== 0) kpis.schedule_shift_years = scheduleShift;  // v3.7
  // v3.9 (Wave F) diagnostics
  const totalMinEtrTopup = evalRows.reduce((s, d) => s + (d.min_etr_topup || 0), 0);
  if (totalMinEtrTopup > 0) kpis.total_min_etr_topup = totalMinEtrTopup;
  const totalFundContrib = evalRows.reduce((s, d) => s + (d.decom_fund_contribution || 0), 0);
  if (totalFundContrib > 0) {
    kpis.total_decom_fund_contributions = totalFundContrib;
    kpis.abandonment_funding_mode = 'sinking_fund';
  }
  const fxNgn = Number(cfg.fx_ngn_per_usd);
  if (Number.isFinite(fxNgn) && fxNgn > 0) {
    kpis.fx_ngn_per_usd = fxNgn;
    kpis.npv_ngn = npvVal * fxNgn;
    kpis.total_revenue_ngn = kpis.total_revenue * fxNgn;
    kpis.total_tax_ngn = kpis.total_tax * fxNgn;
    kpis.total_net_cash_flow_ngn = kpis.total_net_cash_flow * fxNgn;
  }

  // Unit costs on a BOE basis (null when there are no volumes to divide by)
  kpis.unit_technical_cost_usd_per_boe = totalBoe > 0
    ? (kpis.total_capex + kpis.total_opex + totalAbandonment) / totalBoe : null;
  kpis.opex_usd_per_boe = totalBoe > 0 ? kpis.total_opex / totalBoe : null;

  // Government take: share of pre-take value (revenue less capex, opex and
  // abandonment) captured by the state. Contractor NCF already nets out every
  // fiscal instrument in all three regimes, so the residual IS the take.
  const preTakeValue = kpis.total_revenue - kpis.total_capex - kpis.total_opex - totalAbandonment;
  kpis.government_take_pct = preTakeValue > 0
    ? ((preTakeValue - kpis.total_net_cash_flow_nominal) / preTakeValue) * 100 : null;

  // v3.8 (Wave D): discounted government take, on the same PV basis and
  // discount exponents as the NPV. Abandonment sits inside net_cash_flow
  // already; the pre-take PV subtracts it in its year.
  const pvOf = (nominal: number, year: number): number => {
    const t = year - baseYear;
    const onBasis = pvBasis === 'real' ? nominal / Math.pow(1 + inflationRate, t) : nominal;
    return onBasis / Math.pow(1 + discountForNPV, dexp(year));
  };
  const pvPreTake = evalRows.reduce((s, d) =>
    s + pvOf(d.gross_revenue - d.capex - d.opex - (d.abandonment_cost || 0), d.year), 0);
  const pvContractor = evalRows.reduce((s, d) => s + d.discounted_cash_flow, 0);
  kpis.government_take_pct_discounted = pvPreTake > 0
    ? ((pvPreTake - pvContractor) / pvPreTake) * 100 : null;

  // v3.8 (Wave D): NPV at a standard rate vector (the NPV-vs-discount-rate
  // profile). Same basis and exponents; the applied rate is included so the
  // curve always passes through the headline NPV.
  const profileRates = Array.from(new Set(
    [0, 5, 8, 10, 12, 15, 20, Math.round(discountForNPV * 10000) / 100]
  )).sort((a, b) => a - b);
  kpis.npv_profile = profileRates.map((ratePct) => {
    const r = ratePct / 100;
    const v = evalRows.reduce((s, d) => {
      const t = d.year - baseYear;
      const onBasis = pvBasis === 'real' ? d.net_cash_flow / Math.pow(1 + inflationRate, t) : d.net_cash_flow;
      return s + onBasis / Math.pow(1 + r, dexp(d.year));
    }, 0);
    return { rate_pct: ratePct, npv: v };
  });

  // DPI: NPV per present-value dollar of capex, on the same PV basis as NPV
  const pvCapex = evalRows.reduce((s, d) => {
    const t = d.year - baseYear;  // deflator stays anchored at base_year
    const capexOnBasis = pvBasis === 'real' ? d.capex / Math.pow(1 + inflationRate, t) : d.capex;
    return s + capexOnBasis / Math.pow(1 + discountForNPV, dexp(d.year));
  }, 0);
  kpis.pv_capex = pvCapex;
  kpis.dpi = pvCapex > 0 ? npvVal / pvCapex : null;

  kpis.payback_years = paybackYears(cfForPayback);
  kpis.discounted_payback_years = paybackYears(evalRows.map(d => d.discounted_cash_flow));

  if (cfg.fiscal_regime === 'PIA') {
    kpis.total_royalties = evalRows.reduce((s, d) => s + (d.royalty || 0), 0);
    kpis.total_hct = evalRows.reduce((s, d) => s + (d.hct_tax || 0), 0);
    kpis.total_cit = evalRows.reduce((s, d) => s + (d.cit_tax || 0), 0);
    kpis.total_tet = evalRows.reduce((s, d) => s + (d.tet_tax || 0), 0);
    kpis.total_dev_levy = evalRows.reduce((s, d) => s + (d.dev_levy_tax || 0), 0);  // B2.5: NEW
    kpis.total_hcdt = evalRows.reduce((s, d) => s + (d.hcdt || 0), 0);
    kpis.total_nddc = evalRows.reduce((s, d) => s + (d.nddc || 0), 0);
    kpis.total_production_allowance = evalRows.reduce((s, d) => s + (d.production_allowance || 0), 0);
    if (cprForfeited > 0) {
      kpis.cpr_forfeited_at_cessation = cprForfeited;  // B2.5: diagnostic
    }
  }

  return { cashFlowData, kpis };
}

// ============================================================================
// BREAKEVEN OIL PRICE (v3.4)
// ============================================================================
//
// Bisection on the flat oil price to NPV = 0, rerunning the full engine at
// each trial price so every fiscal nonlinearity (tax floors, CPR caps, price
// royalty tiers) is honored. NPV is piecewise linear in price, so bisection
// converges cleanly. Returns null when the project never breaks even below
// `hi`, or is NPV-positive even at `lo` (breakeven not meaningful).
export function computeBreakevenOilPrice(input: ComputeInput, lo = 0.5, hi = 500): number | null {
  // v3.6: with a per-year oil deck the flat price is not what prices oil, so
  // bisecting it would be meaningless — no single breakeven price exists.
  if (parsePriceDeck(input.cfg).oil.length > 0) return null;
  const npvAt = (p: number) =>
    computeCashFlow({ ...input, cfg: { ...input.cfg, oil_price_usd_bbl: p } }).kpis.npv;
  const fLo = npvAt(lo);
  const fHi = npvAt(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  if (fLo >= 0 || fHi < 0) return null;
  let a = lo, b = hi;
  for (let i = 0; i < 50 && b - a > 0.001; i++) {
    const mid = (a + b) / 2;
    if (npvAt(mid) < 0) a = mid; else b = mid;
  }
  return (a + b) / 2;
}
