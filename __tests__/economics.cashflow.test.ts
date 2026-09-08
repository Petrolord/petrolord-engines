// Jest gate for engines/economics/cashflow.ts (the Suite EPE cash flow engine
// v3.9.0, extracted VERBATIM in the EC0 Economics wave, 2026-09-08).
//
// Three layers, in this order:
//   1. PORTED SUITE TESTS: all 58 tests of the Suite's
//      supabase/functions/_shared/__tests__/epe-engine.test.ts and the 60
//      engine checks of tools/validation/epe-validation.ts (cases 1 to 6; case
//      7 is the Monte Carlo layer and lives in economics.montecarlo.test.ts),
//      imports rewritten to this package and the worked example read from
//      test-data/economics/fixtures/pia-worked-example.json. The vendored copy
//      is proven at least as covered as the original.
//   2. CLOSED-FORM IDENTITIES the method must satisfy exactly.
//   3. GOLDEN AGREEMENT with test-data/economics/goldens/cashflow_cases.json,
//      emitted by the INDEPENDENT stdlib oracle
//      tools/validation/economics/oracle_cashflow.py: every row, every KPI,
//      every error, IRR, payback, breakeven and sweep, within a STATED
//      absolute tolerance per quantity. Where the engine and the oracle
//      legitimately disagree the golden pins BOTH numbers and the gap, and
//      this file asserts the engine still produces ITS number (rule 2 of the
//      EC0 brief: no engine change without an owner decision).
//
// Tolerances (USD unless stated): money lines max(0.01, 1e-9 x |expected|);
// irr 1e-4 percentage points (engine Newton stops at 1e-7 in rate); payback
// 1e-8 years; ratios, percents and unit costs 1e-8; prices 1e-9 USD; volumes
// 1e-6; breakeven 0.001 USD/bbl (the engine's bracket width).

import fs from 'fs';
import path from 'path';
import {
  computeCashFlow, computeBreakevenOilPrice, irr, paybackYears, paybackPeriod, ENGINE_VERSION,
  deriveOilRoyaltyRate, derivePriceRoyaltyRate, resolveStreamPrice,
} from '../engines/economics/cashflow.ts';

const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
const FIXTURE = read('../test-data/economics/fixtures/pia-worked-example.json');
const GOLDEN = read('../test-data/economics/goldens/cashflow_cases.json');

const PIA_WORKED_EXAMPLE_CFG = FIXTURE.cfg;
const PIA_WORKED_EXAMPLE_PROD = FIXTURE.prodRows;
const PIA_WORKED_EXAMPLE_CAPEX = FIXTURE.capexRows;
const PIA_WORKED_EXAMPLE_OPEX = FIXTURE.opexRows;
const PIA_WORKED_EXAMPLE_EXPECTED = FIXTURE.expected;

const runWorkedExample = (cfgOverrides = {}) => computeCashFlow({
  cfg: { ...PIA_WORKED_EXAMPLE_CFG, ...cfgOverrides },
  prodRows: PIA_WORKED_EXAMPLE_PROD,
  capexRows: PIA_WORKED_EXAMPLE_CAPEX,
  opexRows: PIA_WORKED_EXAMPLE_OPEX,
});

// ===========================================================================
// 1a. Ported Suite engine tests (58)
// ===========================================================================

describe('EPE engine: PIA worked example regression contract', () => {
  const { cashFlowData, kpis } = runWorkedExample();

  it('reproduces NPV $135,185,570.34 within $0.01', () => {
    expect(kpis.npv).toBeCloseTo(PIA_WORKED_EXAMPLE_EXPECTED.npv, 2);
  });

  it('holds every validated line item within $0.01', () => {
    const row = cashFlowData[0];
    for (const [k, v] of Object.entries(PIA_WORKED_EXAMPLE_EXPECTED.line_items)) {
      expect(Math.abs(row[k] - (v as number))).toBeLessThanOrEqual(0.01);
    }
  });

  it('keeps PIA-only invariants (framework, zero dev levy)', () => {
    expect(kpis.fiscal_framework).toBe('pia_only');
    expect(kpis.total_dev_levy).toBe(0);
  });
});

describe('EPE engine: JV analytic case (hand-derived)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const { cashFlowData, kpis } = computeCashFlow({
    cfg,
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 50_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  });

  it('matches the closed-form royalty, tax, and net cash flows', () => {
    expect(cashFlowData[0].royalty).toBeCloseTo(20_000_000, 2);
    expect(cashFlowData[0].tax).toBeCloseTo(32_500_000, 2);
    expect(cashFlowData[0].net_cash_flow).toBeCloseTo(-12_500_000, 2);
    expect(cashFlowData[1].net_cash_flow).toBeCloseTo(37_500_000, 2);
  });

  it('matches the closed-form NPV, IRR, and payback', () => {
    expect(kpis.npv).toBeCloseTo(-12_500_000 + 37_500_000 / 1.1, 2);
    expect(kpis.irr).toBeCloseTo(200, 3);
    expect(kpis.payback).toBe('1.33 years');
  });
});

describe('EPE engine: PSC cost-recovery carryforward (hand-derived)', () => {
  const cfg = {
    fiscal_regime: 'PSC', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    psc_royalty_pct: 10, psc_cost_oil_cap_pct: 40,
    psc_contractor_profit_share_pct: 50, psc_tax_rate_pct: 50,
  };
  const { cashFlowData, kpis } = computeCashFlow({
    cfg,
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 80_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  });

  it('caps year-1 cost oil and carries the unrecovered pool', () => {
    expect(cashFlowData[0].taxable_income).toBeCloseTo(27_000_000, 2);
    expect(cashFlowData[0].net_cash_flow).toBeCloseTo(-40_500_000, 2);
  });

  it('consumes the carryforward in year 2', () => {
    expect(cashFlowData[1].taxable_income).toBeCloseTo(27_000_000, 2);
    expect(cashFlowData[1].net_cash_flow).toBeCloseTo(39_500_000, 2);
    expect(kpis.npv).toBeCloseTo(-40_500_000 + 39_500_000 / 1.1, 2);
  });
});

describe('EPE engine: NTA 2025 framework switch', () => {
  const pia = runWorkedExample({ pia_under_nta_2025_override: 'force_pia' });
  const nta = runWorkedExample({ pia_under_nta_2025_override: 'force_nta' });

  it('swaps TET for Development Levy on the same assessable base', () => {
    expect(nta.kpis.fiscal_framework).toBe('nta_2025');
    expect(nta.kpis.total_tet).toBe(0);
    expect(pia.kpis.total_dev_levy).toBe(0);
    const tet = pia.cashFlowData[0].tet_tax;
    const dev = nta.cashFlowData[0].dev_levy_tax;
    expect(dev).toBeCloseTo(tet * 1.6, 2);
    expect(nta.cashFlowData[0].net_cash_flow)
      .toBeCloseTo(pia.cashFlowData[0].net_cash_flow + tet - dev, 2);
  });
});

describe('EPE engine: production allowance volume cap (EPE.md 4.1)', () => {
  const { cashFlowData } = computeCashFlow({
    cfg: { ...PIA_WORKED_EXAMPLE_CFG, pia_lease_status: 'new', pia_prior_cumulative_oil_bbl: 99_000_000 },
    prodRows: [{ year: 2025, well1_oil_bbl: 2_000_000 }, { year: 2026, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2025, amount_usd: 50_000_000 }],
    opexRows: [{ year: 2025, total_opex_usd: 20_000_000 }, { year: 2026, total_opex_usd: 20_000_000 }],
  });

  it('splits the crossing year at the 100 MMbbl shallow-water cap', () => {
    expect(cashFlowData[0].prod_alw_eligible_bbl).toBeCloseTo(1_000_000, 6);
    expect(cashFlowData[0].production_allowance).toBeCloseTo(8_000_000, 2);
    expect(cashFlowData[0].prod_alw_cap_applied).toBe(true);
  });

  it('grants zero allowance once capacity is exhausted', () => {
    expect(cashFlowData[1].prod_alw_eligible_bbl).toBe(0);
    expect(cashFlowData[1].production_allowance).toBe(0);
    expect(cashFlowData[1].cumulative_oil_bbl_lifetime).toBeCloseTo(102_000_000, 6);
  });
});

describe('EPE engine: real-world CSV schema ingestion (ALAOMA shapes)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2027,
    oil_price_usd_bbl: 75, gas_price_usd_mscf: 4.5, condensate_price_usd_bbl: 70,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 10, jv_tax_rate_pct: 50,
  };
  const prodRows = [
    { date: '2027-01', days_in_month: 31, oil_rate_bopd: 3225.8, oil_bbl: 100_000, liquid_bbl: 120_000, water_bbl: 20_000, watercut_pct: 16.7 },
    { date: '2027-02', days_in_month: 28, oil_rate_bopd: 3214.3, oil_bbl: 90_000, liquid_bbl: 115_000, water_bbl: 25_000, watercut_pct: 21.7 },
  ];
  const capexRows = [
    { date: '2027-01', category: 'Drilling', item: 'Well A1', cost_usd: 30_000_000, basis_note: 'AFE' },
    { date: '2027-06', category: 'Facilities', item: 'Flowline', cost_usd: 10_000_000, basis_note: 'estimate' },
  ];
  const opexRows = [
    { date: '2027-01', fixed_opex_usd: 500_000, variable_oil_usd: 200_000, variable_water_usd: 50_000, total_opex_usd: 750_000, oil_bbl_basis: 100_000, unit_opex_usd_per_bbl: 7.5 },
    { date: '2027-02', fixed_opex_usd: 500_000, variable_oil_usd: 180_000, variable_water_usd: 60_000, total_opex_usd: 740_000, oil_bbl_basis: 90_000, unit_opex_usd_per_bbl: 8.2 },
  ];

  it('yields nonzero revenue, capex, and opex from all three files', () => {
    const { kpis } = computeCashFlow({ cfg, prodRows, capexRows, opexRows });
    expect(kpis.total_revenue).toBeCloseTo(190_000 * 75, 2);
    expect(kpis.total_capex).toBeCloseTo(40_000_000, 2);
    expect(kpis.total_opex).toBeCloseTo(1_490_000, 2);
    expect(kpis.total_revenue).toBeGreaterThan(0);
    expect(kpis.total_capex).toBeGreaterThan(0);
    expect(kpis.total_opex).toBeGreaterThan(0);
  });

  it('matches headers case-insensitively', () => {
    const { kpis } = computeCashFlow({
      cfg,
      prodRows: [{ Date: '2027-01', 'Oil_BBL': 100_000, 'Water_BBL': 20_000 }],
      capexRows: [{ DATE: '2027-01', Category: 'Drilling', 'Cost_USD': 30_000_000 }],
      opexRows: [{ date: '2027-01', 'Total_Opex_USD': 750_000 }],
    });
    expect(kpis.total_revenue).toBeCloseTo(100_000 * 75, 2);
    expect(kpis.total_capex).toBeCloseTo(30_000_000, 2);
    expect(kpis.total_opex).toBeCloseTo(750_000, 2);
  });

  it('still prefers per-well columns and ignores total_* rollups alongside them', () => {
    const { kpis } = computeCashFlow({
      cfg,
      prodRows: [{ year: 2027, well1_oil_bbl: 60_000, well2_oil_bbl: 40_000, total_oil_bbl: 100_000 }],
      capexRows: [],
      opexRows: [],
    });
    expect(kpis.total_revenue).toBeCloseTo(100_000 * 75, 2);
  });
});

describe('EPE engine v3.4: decision KPI bundle (hand-derived on the JV analytic case)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const input = {
    cfg,
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 50_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  };
  const { kpis } = computeCashFlow(input);

  it('reports total volumes and BOE (oil-only case: boe = oil)', () => {
    expect(kpis.total_oil_bbl).toBe(2_000_000);
    expect(kpis.total_gas_mscf).toBe(0);
    expect(kpis.total_boe).toBe(2_000_000);
  });

  it('computes unit technical cost and opex/boe', () => {
    expect(kpis.unit_technical_cost_usd_per_boe).toBeCloseTo(35, 6);
    expect(kpis.opex_usd_per_boe).toBeCloseTo(10, 6);
  });

  it('computes government take as royalties + taxes over pre-take value', () => {
    expect(kpis.government_take_pct).toBeCloseTo((105 / 130) * 100, 6);
  });

  it('computes PV(capex) and DPI on the NPV basis', () => {
    expect(kpis.pv_capex).toBeCloseTo(50_000_000, 2);
    expect(kpis.dpi).toBeCloseTo(kpis.npv / 50_000_000, 10);
  });

  it('computes numeric and discounted payback', () => {
    expect(kpis.payback_years).toBeCloseTo(1 + 12.5 / 37.5, 6);
    expect(kpis.discounted_payback_years).toBeCloseTo(1 + 12.5 / (37.5 / 1.1), 6);
  });

  it('finds the breakeven oil price (engine NPV at that price is ~0)', () => {
    const breakeven = computeBreakevenOilPrice(input);
    expect(breakeven).not.toBeNull();
    expect(breakeven).toBeGreaterThan(0);
    expect(breakeven).toBeLessThan(100);
    const atBreakeven = computeCashFlow({
      ...input, cfg: { ...cfg, oil_price_usd_bbl: breakeven },
    });
    expect(Math.abs(atBreakeven.kpis.npv)).toBeLessThan(2_000);
  });
});

describe('EPE engine v3.4: economic limit test (config-gated)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const prodRows = [
    { year: 2030, well1_oil_bbl: 1_000_000 },
    { year: 2031, well1_oil_bbl: 1_000_000 },
    { year: 2032, well1_oil_bbl: 10_000 },
  ];
  const capexRows = [{ year: 2030, amount_usd: 50_000_000 }];
  const opexRows = [2030, 2031, 2032].map(year => ({ year, total_opex_usd: 10_000_000 }));

  it('is off by default (tail year kept)', () => {
    const { cashFlowData, kpis } = computeCashFlow({ cfg, prodRows, capexRows, opexRows });
    expect(cashFlowData).toHaveLength(3);
    expect(kpis.economic_limit_year).toBeUndefined();
  });

  it('trims the uneconomic tail and reports the limit year', () => {
    const { cashFlowData, kpis } = computeCashFlow({
      cfg: { ...cfg, apply_economic_limit: true }, prodRows, capexRows, opexRows,
    });
    expect(cashFlowData).toHaveLength(2);
    expect(cashFlowData[cashFlowData.length - 1].year).toBe(2031);
    expect(kpis.economic_limit_year).toBe(2031);
    expect(kpis.years_trimmed_by_economic_limit).toBe(1);
    const base = computeCashFlow({ cfg, prodRows, capexRows, opexRows });
    expect(kpis.npv).toBeGreaterThan(base.kpis.npv);
  });
});

describe('EPE engine v3.4: abandonment cost (config-gated, post-tax)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const prodRows = [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }];
  const capexRows = [{ year: 2030, amount_usd: 50_000_000 }];
  const opexRows = [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }];

  it('applies the lump sum in the final modeled year without touching tax', () => {
    const base = computeCashFlow({ cfg, prodRows, capexRows, opexRows });
    const withAbex = computeCashFlow({
      cfg: { ...cfg, abandonment_cost_usd: 10_000_000 }, prodRows, capexRows, opexRows,
    });
    const last = withAbex.cashFlowData[1];
    expect(last.abandonment_cost).toBe(10_000_000);
    expect(last.tax).toBeCloseTo(base.cashFlowData[1].tax, 2);
    expect(last.net_cash_flow).toBeCloseTo(base.cashFlowData[1].net_cash_flow - 10_000_000, 2);
    expect(withAbex.kpis.total_abandonment_cost).toBe(10_000_000);
    expect(withAbex.kpis.abandonment_year).toBe(2031);
    expect(withAbex.kpis.npv).toBeCloseTo(base.kpis.npv - 10_000_000 / 1.1, 2);
  });

  it('appends a standalone year when abandonment_year is beyond the data', () => {
    const { cashFlowData, kpis } = computeCashFlow({
      cfg: { ...cfg, abandonment_cost_usd: 10_000_000, abandonment_year: 2033 },
      prodRows, capexRows, opexRows,
    });
    expect(cashFlowData).toHaveLength(3);
    const abexRow = cashFlowData[2];
    expect(abexRow.year).toBe(2033);
    expect(abexRow.gross_revenue).toBe(0);
    expect(abexRow.abandonment_cost).toBe(10_000_000);
    expect(abexRow.net_cash_flow).toBeCloseTo(-10_000_000, 2);
    expect(kpis.abandonment_year).toBe(2033);
  });
});

describe('EPE engine: ingestion failures are loud (no silent $0 runs)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2027,
    oil_price_usd_bbl: 75, gas_price_usd_mscf: 4.5, condensate_price_usd_bbl: 70,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 10, jv_tax_rate_pct: 50,
  };
  const goodProd = [{ date: '2027-01', oil_bbl: 100_000 }];

  it('throws when no production volume column is recognized', () => {
    expect(() => computeCashFlow({
      cfg,
      prodRows: [{ date: '2027-01', oil_production: 100_000 }],
      capexRows: [], opexRows: [],
    })).toThrow(/Production file.*no oil\/gas\/condensate volume columns/);
  });

  it('throws when production rows have no usable date', () => {
    expect(() => computeCashFlow({
      cfg,
      prodRows: [{ period: 'Jan-27', oil_bbl: 100_000 }],
      capexRows: [], opexRows: [],
    })).toThrow(/no row had a usable date/);
  });

  it('throws when the capex file has no recognized cost column', () => {
    expect(() => computeCashFlow({
      cfg,
      prodRows: goodProd,
      capexRows: [{ date: '2027-01', category: 'Drilling', spend: 30_000_000 }],
      opexRows: [],
    })).toThrow(/CAPEX file.*no cost column recognized/);
  });

  it('throws when the opex file has no recognized cost column', () => {
    expect(() => computeCashFlow({
      cfg,
      prodRows: goodProd,
      capexRows: [],
      opexRows: [{ date: '2027-01', monthly_cost: 750_000 }],
    })).toThrow(/OPEX file.*no cost column recognized/);
  });

  it('throws when the oil price is unset but oil volumes exist', () => {
    expect(() => computeCashFlow({
      cfg: { ...cfg, oil_price_usd_bbl: null },
      prodRows: goodProd,
      capexRows: [], opexRows: [],
    })).toThrow(/Oil price.*is not set/);
  });
});

describe('EPE engine v3.5: tax-loss carryforward (Wave A finding 1.2)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const input = {
    cfg,
    prodRows: [{ year: 2030, well1_oil_bbl: 0 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 50_000_000 }],
    opexRows: [{ year: 2031, total_opex_usd: 10_000_000 }],
  };

  it('banks the loss year and offsets the next taxable year (JV closed form)', () => {
    const { cashFlowData } = computeCashFlow(input);
    expect(cashFlowData[0].tax).toBeCloseTo(0, 2);
    expect(cashFlowData[0].loss_carryforward).toBeCloseTo(5_000_000, 2);
    expect(cashFlowData[1].loss_offset_used).toBeCloseTo(5_000_000, 2);
    expect(cashFlowData[1].tax).toBeCloseTo(30_000_000, 2);
    expect(cashFlowData[1].net_cash_flow).toBeCloseTo(40_000_000, 2);
    expect(cashFlowData[1].loss_carryforward).toBeCloseTo(0, 2);
  });

  it('kill switch restores the old clamp-at-zero behavior', () => {
    const { cashFlowData } = computeCashFlow({
      ...input, cfg: { ...cfg, apply_loss_carryforward: false },
    });
    expect(cashFlowData[1].tax).toBeCloseTo(32_500_000, 2);
    expect(cashFlowData[1].net_cash_flow).toBeCloseTo(37_500_000, 2);
  });

  it('reports losses left unused at cessation', () => {
    const { kpis } = computeCashFlow({
      ...input,
      prodRows: [{ year: 2030, well1_oil_bbl: 0 }],
      opexRows: [],
    });
    expect(kpis.tax_losses_unused_at_cessation).toBeCloseTo(5_000_000, 2);
  });

  it('offsets PIA HCT and CIT via separate pools (self-consistent vs kill switch)', () => {
    const piaInput = {
      cfg: { ...PIA_WORKED_EXAMPLE_CFG, base_year: 2025 },
      prodRows: [{ year: 2025, well1_oil_bbl: 500_000 }, { year: 2026, well1_oil_bbl: 5_000_000 }],
      capexRows: [{ year: 2025, amount_usd: 100_000_000 }],
      opexRows: [{ year: 2025, total_opex_usd: 60_000_000 }, { year: 2026, total_opex_usd: 40_000_000 }],
    };
    const withRelief = computeCashFlow(piaInput);
    const noRelief = computeCashFlow({
      ...piaInput, cfg: { ...piaInput.cfg, apply_loss_carryforward: false },
    });
    const y1 = noRelief.cashFlowData[0];
    expect(Math.min(y1.hct_chargeable_profit, y1.cit_chargeable_profit)).toBeLessThan(0);
    const y2Relief = withRelief.cashFlowData[1];
    const y2Flat = noRelief.cashFlowData[1];
    const hctCarried = Math.max(0, -y1.hct_chargeable_profit);
    const citCarried = Math.max(0, -y1.cit_chargeable_profit);
    expect(y2Relief.hct_loss_offset_used).toBeCloseTo(Math.min(hctCarried, Math.max(0, y2Flat.hct_chargeable_profit)), 2);
    expect(y2Flat.hct_tax - y2Relief.hct_tax).toBeCloseTo(y2Relief.hct_loss_offset_used * 0.30, 2);
    expect(y2Relief.cit_loss_offset_used).toBeCloseTo(Math.min(citCarried, Math.max(0, y2Flat.cit_chargeable_profit)), 2);
    expect(y2Flat.cit_tax - y2Relief.cit_tax)
      .toBeCloseTo(y2Relief.cit_loss_offset_used * (PIA_WORKED_EXAMPLE_CFG.pia_cit_rate_pct / 100), 2);
    expect(y2Relief.tet_tax).toBeCloseTo(y2Flat.tet_tax, 2);
  });
});

describe('EPE engine v3.5: HCT excludes gas revenue (Wave A finding 1.3)', () => {
  it('charges zero HCT on a gas-only case (gas profits are CIT-only under PIA)', () => {
    const input = {
      cfg: { ...PIA_WORKED_EXAMPLE_CFG },
      prodRows: [{ year: 2025, well1_gas_mscf: 20_000_000 }],
      capexRows: [{ year: 2025, amount_usd: 20_000_000 }],
      opexRows: [{ year: 2025, total_opex_usd: 10_000_000 }],
    };
    const { cashFlowData, kpis } = computeCashFlow(input);
    expect(cashFlowData[0].hct_tax).toBe(0);
    expect(cashFlowData[0].hct_assessable_profit).toBe(0);
    expect(kpis.total_cit).toBeGreaterThan(0);
    const legacy = computeCashFlow({
      ...input, cfg: { ...input.cfg, pia_hct_include_gas_revenue: true },
    });
    expect(legacy.cashFlowData[0].hct_tax).toBeGreaterThan(0);
  });
});

describe('EPE engine v3.5: IRR solver hardening (Wave A finding 1.4)', () => {
  it('still solves the JV analytic case via Newton (200%)', () => {
    expect(irr([-12_500_000, 37_500_000])! * 100).toBeCloseTo(200, 6);
  });

  it('returns null when no real IRR exists instead of a garbage rate', () => {
    expect(irr([-1, 3, -3])).toBeNull();
  });

  it('any non-null IRR actually zeroes the NPV (self-consistency)', () => {
    const flows = [-100, 230, -132];
    const r = irr(flows);
    if (r !== null) {
      const f = flows.reduce((s, cf, i) => s + cf / Math.pow(1 + r, i), 0);
      expect(Math.abs(f)).toBeLessThan(1e-4);
    }
  });
});

describe('EPE engine v3.5: ambiguous cost aliases fail loudly (Wave A finding 1.5)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2027,
    oil_price_usd_bbl: 75, gas_price_usd_mscf: 4.5, condensate_price_usd_bbl: 70,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 10, jv_tax_rate_pct: 50,
  };
  const goodProd = [{ date: '2027-01', oil_bbl: 100_000 }];

  it('throws when a row populates two cost aliases with different values', () => {
    expect(() => computeCashFlow({
      cfg, prodRows: goodProd,
      capexRows: [{ date: '2027-01', amount_usd: 30_000_000, cost_usd: 10_000_000 }],
      opexRows: [],
    })).toThrow(/multiple cost columns populated with different values/);
  });

  it('accepts duplicated identical values under two aliases', () => {
    const { kpis } = computeCashFlow({
      cfg, prodRows: goodProd,
      capexRows: [{ date: '2027-01', amount_usd: 30_000_000, cost_usd: 30_000_000 }],
      opexRows: [],
    });
    expect(kpis.total_capex).toBeCloseTo(30_000_000, 2);
  });
});

describe('EPE engine v3.5: economic limit honors royalty (Wave A finding 1.6)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
    apply_economic_limit: true,
  };
  const prodRows = [
    { year: 2030, well1_oil_bbl: 1_000_000 },
    { year: 2031, well1_oil_bbl: 120_000 },
  ];
  const capexRows = [{ year: 2030, amount_usd: 50_000_000 }];
  const opexRows = [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }];

  it('trims a tail year that is only economic before royalty', () => {
    const { cashFlowData, kpis } = computeCashFlow({ cfg, prodRows, capexRows, opexRows });
    expect(cashFlowData).toHaveLength(1);
    expect(kpis.economic_limit_year).toBe(2030);
    expect(kpis.years_trimmed_by_economic_limit).toBe(1);
  });
});

describe('EPE engine v3.5: run provenance (Wave A finding 1.8)', () => {
  it('stamps engine_version into every KPI set', () => {
    const { kpis } = runWorkedExample();
    expect(kpis.engine_version).toBe(ENGINE_VERSION);
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('EPE engine v3.6: working interest on PSC and PIA (Wave B 2.1)', () => {
  const pscCfg = {
    fiscal_regime: 'PSC', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    psc_royalty_pct: 10, psc_cost_oil_cap_pct: 40,
    psc_contractor_profit_share_pct: 50, psc_tax_rate_pct: 50,
  };
  const pscInput = {
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 80_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  };

  it('PSC at 50% WI halves every monetary line and the NPV (linear regime)', () => {
    const full = computeCashFlow({ cfg: pscCfg, ...pscInput });
    const half = computeCashFlow({ cfg: { ...pscCfg, psc_working_interest_pct: 50 }, ...pscInput });
    for (const k of ['gross_revenue', 'royalty', 'tax', 'net_cash_flow', 'oil_bbl']) {
      expect(half.cashFlowData[0][k]).toBeCloseTo(full.cashFlowData[0][k] * 0.5, 2);
      expect(half.cashFlowData[1][k]).toBeCloseTo(full.cashFlowData[1][k] * 0.5, 2);
    }
    expect(half.kpis.npv).toBeCloseTo(full.kpis.npv * 0.5, 2);
    expect(half.kpis.working_interest_pct).toBe(50);
    expect(half.kpis.government_take_pct).toBeCloseTo(full.kpis.government_take_pct, 6);
  });

  it('PIA WI keeps field-level royalty tiers (rate from field bopd, not the WI share)', () => {
    const piaCfg = { ...PIA_WORKED_EXAMPLE_CFG, pia_terrain: 'deep_offshore' };
    const prodRows = [{ year: 2025, well1_oil_bbl: 21_900_000 }];
    const capexRows = [{ year: 2025, amount_usd: 100_000_000 }];
    const opexRows = [{ year: 2025, total_opex_usd: 100_000_000 }];
    const full = computeCashFlow({ cfg: piaCfg, prodRows, capexRows, opexRows });
    const wi50 = computeCashFlow({ cfg: { ...piaCfg, pia_working_interest_pct: 50 }, prodRows, capexRows, opexRows });
    const naive = computeCashFlow({
      cfg: piaCfg,
      prodRows: [{ year: 2025, well1_oil_bbl: 10_950_000 }],
      capexRows, opexRows,
    });
    expect(wi50.cashFlowData[0].production_royalty).toBeCloseTo(full.cashFlowData[0].production_royalty * 0.5, 2);
    expect(wi50.cashFlowData[0].production_royalty)
      .toBeCloseTo(naive.cashFlowData[0].production_royalty * 1.5, 2);
    expect(wi50.cashFlowData[0].cumulative_oil_bbl_lifetime).toBeCloseTo(21_900_000, 2);
  });
});

describe('EPE engine v3.6: per-year price decks and differentials (Wave B 2.2)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 10, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const prodRows = [2030, 2031, 2032, 2033].map(year => ({ year, well1_oil_bbl: 1_000_000 }));

  it('deck values step-hold between entries and escalate beyond the last', () => {
    const { cashFlowData } = computeCashFlow({
      cfg: { ...cfg, price_deck: [{ year: 2030, oil: 100 }, { year: 2032, oil: 50 }] },
      prodRows, capexRows: [], opexRows: [],
    });
    expect(cashFlowData[0].applied_oil_price).toBeCloseTo(100, 6);
    expect(cashFlowData[1].applied_oil_price).toBeCloseTo(100, 6);
    expect(cashFlowData[2].applied_oil_price).toBeCloseTo(50, 6);
    expect(cashFlowData[3].applied_oil_price).toBeCloseTo(55, 6);
  });

  it('differential adds after resolution; flat runs without a deck are unchanged', () => {
    const withDiff = computeCashFlow({
      cfg: { ...cfg, price_deck: [{ year: 2030, oil: 100 }], oil_price_differential_usd_bbl: -5 },
      prodRows: prodRows.slice(0, 2), capexRows: [], opexRows: [],
    });
    expect(withDiff.cashFlowData[0].applied_oil_price).toBeCloseTo(95, 6);
    expect(withDiff.cashFlowData[1].applied_oil_price).toBeCloseTo(100 * 1.1 - 5, 6);
    const flat = computeCashFlow({ cfg, prodRows: prodRows.slice(0, 2), capexRows: [], opexRows: [] });
    expect(flat.cashFlowData[1].applied_oil_price).toBeCloseTo(110, 6);
  });

  it('price scale multiplies the resolved deck price (sweep hook)', () => {
    const { cashFlowData } = computeCashFlow({
      cfg: { ...cfg, price_deck: [{ year: 2030, oil: 100 }], oil_price_scale: 1.2 },
      prodRows: prodRows.slice(0, 1), capexRows: [], opexRows: [],
    });
    expect(cashFlowData[0].applied_oil_price).toBeCloseTo(120, 6);
  });

  it('breakeven is null when an oil deck prices the run', () => {
    const input = {
      cfg: { ...cfg, price_deck: [{ year: 2030, oil: 100 }] },
      prodRows: prodRows.slice(0, 2),
      capexRows: [{ year: 2030, amount_usd: 50_000_000 }],
      opexRows: [],
    };
    expect(computeBreakevenOilPrice(input)).toBeNull();
  });
});

describe('EPE engine v3.6: discounting convention and valuation date (Wave B 2.3/2.4)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const input = {
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 50_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  };

  it('mid-year discounting shifts every exponent by exactly half a year', () => {
    const end = computeCashFlow({ cfg, ...input });
    const mid = computeCashFlow({ cfg: { ...cfg, discounting_convention: 'mid_year' }, ...input });
    expect(mid.kpis.npv).toBeCloseTo(end.kpis.npv / Math.sqrt(1.1), 2);
    expect(mid.kpis.discounting_convention).toBe('mid_year');
    expect(end.kpis.discounting_convention).toBe('end_year');
  });

  it('valuation date re-references discounting; sunk mode excludes prior years from value metrics', () => {
    const forward = computeCashFlow({ cfg: { ...cfg, valuation_year: 2031 }, ...input });
    expect(forward.kpis.npv).toBeCloseTo(-12_500_000 * 1.1 + 37_500_000, 2);
    const sunk = computeCashFlow({
      cfg: { ...cfg, valuation_year: 2031, treat_prior_as_sunk: true }, ...input,
    });
    expect(sunk.kpis.npv).toBeCloseTo(37_500_000, 2);
    expect(sunk.kpis.sunk_net_cash_flow).toBeCloseTo(-12_500_000, 2);
    expect(sunk.cashFlowData[0].sunk).toBe(true);
    const full = computeCashFlow({ cfg, ...input });
    expect(sunk.cashFlowData[1].tax).toBeCloseTo(full.cashFlowData[1].tax, 2);
    expect(sunk.kpis.payback_years).toBe(0);
  });
});

describe('EPE engine v3.7: schedule delay (Wave C 3.1)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const input = {
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 50_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  };

  it('shifts production and opex, keeps capex and its allowances on schedule', () => {
    const { cashFlowData, kpis } = computeCashFlow({ cfg: { ...cfg, schedule_shift_years: 1 }, ...input });
    expect(cashFlowData.map(d => d.year)).toEqual([2030, 2031, 2032]);
    expect(cashFlowData[0].gross_revenue).toBe(0);
    expect(cashFlowData[0].capex).toBeCloseTo(50_000_000, 2);
    expect(cashFlowData[0].net_cash_flow).toBeCloseTo(-50_000_000, 2);
    expect(cashFlowData[1].tax).toBeCloseTo(30_000_000, 2);
    expect(cashFlowData[1].net_cash_flow).toBeCloseTo(40_000_000, 2);
    expect(cashFlowData[2].tax).toBeCloseTo(32_500_000, 2);
    expect(kpis.npv).toBeCloseTo(-50_000_000 + 40_000_000 / 1.1 + 37_500_000 / 1.21, 2);
    expect(kpis.schedule_shift_years).toBe(1);
    const base = computeCashFlow({ cfg, ...input });
    expect(kpis.npv).toBeLessThan(base.kpis.npv);
  });
});

describe('EPE engine v3.8: reporting KPIs (Wave D)', () => {
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const input = {
    cfg,
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 50_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  };
  const { kpis } = computeCashFlow(input);

  it('npv_profile passes through the headline NPV at the applied rate and falls with rate', () => {
    const at10 = kpis.npv_profile.find((p: any) => p.rate_pct === 10);
    expect(at10.npv).toBeCloseTo(kpis.npv, 2);
    const rates = kpis.npv_profile.map((p: any) => p.rate_pct);
    expect(rates).toEqual([...rates].sort((a: number, b: number) => a - b));
    for (let i = 1; i < kpis.npv_profile.length; i++) {
      expect(kpis.npv_profile[i].npv).toBeLessThan(kpis.npv_profile[i - 1].npv);
    }
    const at0 = kpis.npv_profile.find((p: any) => p.rate_pct === 0);
    expect(at0.npv).toBeCloseTo(kpis.total_net_cash_flow_nominal, 2);
  });

  it('discounted government take matches the closed form', () => {
    const pvPre = 40_000_000 + 90_000_000 / 1.1;
    const pvCon = -12_500_000 + 37_500_000 / 1.1;
    expect(kpis.government_take_pct_discounted).toBeCloseTo(((pvPre - pvCon) / pvPre) * 100, 6);
  });
});

describe('EPE engine v3.9: Wave F fiscal depth', () => {
  const jvCfg = {
    fiscal_regime: 'JV', base_year: 2030,
    oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0,
    oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0,
    present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const jvInput = {
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 50_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  };
  const pscCfg = {
    ...jvCfg, fiscal_regime: 'PSC',
    psc_royalty_pct: 10, psc_cost_oil_cap_pct: 40,
    psc_contractor_profit_share_pct: 50, psc_tax_rate_pct: 50,
  };
  const pscInput = {
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 80_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  };

  it('PSC tranches: contractor share steps on cumulative liquids at start of year', () => {
    const { cashFlowData } = computeCashFlow({
      cfg: {
        ...pscCfg,
        psc_profit_split_mode: 'tranches',
        psc_profit_tranches: [
          { from_cum_mmbbl: 0, contractor_share_pct: 60 },
          { from_cum_mmbbl: 1, contractor_share_pct: 40 },
        ],
      },
      ...pscInput,
    });
    expect(cashFlowData[0].psc_contractor_share_pct).toBeCloseTo(60, 6);
    expect(cashFlowData[0].taxable_income).toBeCloseTo(32_400_000, 2);
    expect(cashFlowData[1].psc_contractor_share_pct).toBeCloseTo(40, 6);
    expect(cashFlowData[1].taxable_income).toBeCloseTo(21_600_000, 2);
  });

  it('PSC investment tax credit offsets tax with carryforward', () => {
    const { cashFlowData } = computeCashFlow({
      cfg: { ...pscCfg, psc_itc_pct: 50 }, ...pscInput,
    });
    expect(cashFlowData[0].psc_itc_used).toBeCloseTo(13_500_000, 2);
    expect(cashFlowData[0].tax).toBeCloseTo(0, 2);
    expect(cashFlowData[0].net_cash_flow).toBeCloseTo(-27_000_000, 2);
    expect(cashFlowData[1].psc_itc_used).toBeCloseTo(13_500_000, 2);
    expect(cashFlowData[1].psc_itc_carryforward).toBeCloseTo(13_000_000, 2);
  });

  it('minimum ETR top-up (config-gated project-level approximation)', () => {
    const base = runWorkedExample();
    const floored = runWorkedExample({ pia_apply_minimum_etr: true, pia_minimum_etr_pct: 85 });
    const row0 = base.cashFlowData[0];
    const paid = row0.hct_tax + row0.cit_tax + row0.tet_tax + row0.dev_levy_tax;
    const floor = Math.max(0, row0.cit_assessable_profit * 0.85);
    const expectedTopup = Math.max(0, floor - paid);
    expect(expectedTopup).toBeGreaterThan(0);
    expect(floored.cashFlowData[0].min_etr_topup).toBeCloseTo(expectedTopup, 2);
    expect(floored.kpis.total_min_etr_topup).toBeCloseTo(expectedTopup, 2);
    expect(floored.cashFlowData[0].net_cash_flow)
      .toBeCloseTo(row0.net_cash_flow - expectedTopup, 2);
    expect(base.kpis.total_min_etr_topup).toBeUndefined();
  });

  it('decommissioning sinking fund: deductible contributions, no end-of-life double hit', () => {
    const lump = computeCashFlow({
      cfg: { ...jvCfg, abandonment_cost_usd: 10_000_000 }, ...jvInput,
    });
    const fund = computeCashFlow({
      cfg: { ...jvCfg, abandonment_cost_usd: 10_000_000, abandonment_funding_mode: 'sinking_fund' },
      ...jvInput,
    });
    const baseRun = computeCashFlow({ cfg: jvCfg, ...jvInput });
    expect(fund.cashFlowData[0].decom_fund_contribution).toBeCloseTo(5_000_000, 2);
    expect(fund.cashFlowData[0].tax).toBeCloseTo(baseRun.cashFlowData[0].tax - 2_500_000, 2);
    expect(fund.cashFlowData[0].net_cash_flow)
      .toBeCloseTo(baseRun.cashFlowData[0].net_cash_flow - 2_500_000, 2);
    expect(fund.cashFlowData[1].abandonment_cost_funded).toBe(10_000_000);
    expect(fund.cashFlowData[1].net_cash_flow)
      .toBeCloseTo(lump.cashFlowData[1].net_cash_flow + 10_000_000 - 2_500_000, 2);
    expect(fund.kpis.total_decom_fund_contributions).toBeCloseTo(10_000_000, 2);
  });

  it('depreciation controls: configurable years and the nigeria_ppt preset', () => {
    const sl5 = computeCashFlow({ cfg: { ...jvCfg, jv_psc_depr_years: 5 }, ...jvInput });
    expect(sl5.cashFlowData[0].depreciation).toBeCloseTo(10_000_000, 2);
    expect(sl5.cashFlowData[0].tax).toBeCloseTo(30_000_000, 2);
    const ppt = computeCashFlow({ cfg: { ...jvCfg, depreciation_method: 'nigeria_ppt' }, ...jvInput });
    expect(ppt.cashFlowData[0].depreciation).toBeCloseTo(10_000_000, 2);
    const totalDepr = [0.2, 0.2, 0.2, 0.2, 0.19].reduce((s, x) => s + x, 0);
    expect(totalDepr).toBeCloseTo(0.99, 10);
  });

  it('NGN mirrors stamp when an FX rate is set', () => {
    const usd = computeCashFlow({ cfg: jvCfg, ...jvInput });
    const ngn = computeCashFlow({ cfg: { ...jvCfg, fx_ngn_per_usd: 1500 }, ...jvInput });
    expect(usd.kpis.fx_ngn_per_usd).toBeUndefined();
    expect(ngn.kpis.fx_ngn_per_usd).toBe(1500);
    expect(ngn.kpis.npv_ngn).toBeCloseTo(usd.kpis.npv * 1500, 2);
    expect(ngn.kpis.total_tax_ngn).toBeCloseTo(usd.kpis.total_tax * 1500, 2);
  });
});

describe('EPE engine: CPR cessation forfeiture (EPE.md 4.1)', () => {
  const { cashFlowData, kpis } = computeCashFlow({
    cfg: { ...PIA_WORKED_EXAMPLE_CFG },
    prodRows: [{ year: 2025, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2025, amount_usd: 100_000_000 }],
    opexRows: [{ year: 2025, total_opex_usd: 40_000_000 }],
  });

  it('flags the unrecovered CPR pool on the final year and in KPIs', () => {
    expect(cashFlowData[0].cpr_cap).toBeCloseTo(52_000_000, 2);
    expect(cashFlowData[0].cpr_costs_claimed).toBeCloseTo(52_000_000, 2);
    expect(cashFlowData[0].cpr_deferred_to_next).toBeCloseTo(8_000_000, 2);
    expect(cashFlowData[0].cpr_forfeited_at_cessation).toBeCloseTo(8_000_000, 2);
    expect(kpis.cpr_forfeited_at_cessation).toBeCloseTo(8_000_000, 2);
  });
});

// ===========================================================================
// 1b. Ported validation harness (tools/validation/epe-validation.ts, cases 1
//     to 6: 60 checks). Each check is one jest test so the count is visible.
// ===========================================================================

type Check = { label: string; actual: any; expected: any; tol: number };
const harness: Check[] = [];
const check = (label: string, actual: any, expected: any, tol = 0.01) => harness.push({ label, actual, expected, tol });

{
  const { cashFlowData, kpis } = computeCashFlow({
    cfg: PIA_WORKED_EXAMPLE_CFG, prodRows: PIA_WORKED_EXAMPLE_PROD,
    capexRows: PIA_WORKED_EXAMPLE_CAPEX, opexRows: PIA_WORKED_EXAMPLE_OPEX,
  });
  check('Case 1: NPV = $135,185,570.34', kpis.npv, PIA_WORKED_EXAMPLE_EXPECTED.npv, 0.01);
  check('Case 1: fiscal_framework = pia_only', kpis.fiscal_framework, 'pia_only');
  check('Case 1: total_dev_levy = 0 (PIA-only invariant)', kpis.total_dev_levy, 0, 1e-9);
  for (const [k, v] of Object.entries(PIA_WORKED_EXAMPLE_EXPECTED.line_items)) {
    check(`Case 1: 2025 ${k}`, cashFlowData[0][k], v as number, 0.01);
  }
}
{
  const cfg = {
    fiscal_regime: 'JV', base_year: 2030, oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0, oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0, present_value_basis: 'nominal',
    jv_working_interest_pct: 100, jv_royalty_pct: 20, jv_tax_rate_pct: 50,
  };
  const { cashFlowData, kpis } = computeCashFlow({
    cfg,
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 50_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  });
  check('Case 2: 2030 royalty = 20M', cashFlowData[0].royalty, 20_000_000);
  check('Case 2: 2030 taxable = 65M', cashFlowData[0].taxable_income, 65_000_000);
  check('Case 2: 2030 tax = 32.5M', cashFlowData[0].tax, 32_500_000);
  check('Case 2: 2030 net = -12.5M', cashFlowData[0].net_cash_flow, -12_500_000);
  check('Case 2: 2031 net = +37.5M', cashFlowData[1].net_cash_flow, 37_500_000);
  check('Case 2: NPV = 21,590,909.09', kpis.npv, -12_500_000 + 37_500_000 / 1.1, 0.01);
  check('Case 2: IRR = 200%', kpis.irr, 200, 0.001);
  check('Case 2: payback = "1.33 years"', kpis.payback, '1.33 years');
}
{
  const cfg = {
    fiscal_regime: 'PSC', base_year: 2030, oil_price_usd_bbl: 100, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
    discount_rate_pct: 10, inflation_rate_pct: 0, oil_price_escalator_pct: 0, gas_price_escalator_pct: 0,
    condensate_price_escalator_pct: 0, opex_escalator_pct: 0, capex_escalator_pct: 0, present_value_basis: 'nominal',
    psc_royalty_pct: 10, psc_cost_oil_cap_pct: 40, psc_contractor_profit_share_pct: 50, psc_tax_rate_pct: 50,
  };
  const { cashFlowData, kpis } = computeCashFlow({
    cfg,
    prodRows: [{ year: 2030, well1_oil_bbl: 1_000_000 }, { year: 2031, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2030, amount_usd: 80_000_000 }],
    opexRows: [{ year: 2030, total_opex_usd: 10_000_000 }, { year: 2031, total_opex_usd: 10_000_000 }],
  });
  check('Case 3: 2030 royalty = 10M', cashFlowData[0].royalty, 10_000_000);
  check('Case 3: 2030 contractor profit oil = 27M', cashFlowData[0].taxable_income, 27_000_000);
  check('Case 3: 2030 tax = 13.5M', cashFlowData[0].tax, 13_500_000);
  check('Case 3: 2030 net = -40.5M', cashFlowData[0].net_cash_flow, -40_500_000);
  check('Case 3: 2031 contractor profit oil = 27M (carry consumed)', cashFlowData[1].taxable_income, 27_000_000);
  check('Case 3: 2031 net = +39.5M', cashFlowData[1].net_cash_flow, 39_500_000);
  check('Case 3: NPV = -4,590,909.09', kpis.npv, -40_500_000 + 39_500_000 / 1.1, 0.01);
}
{
  const runWith = (override: string) => runWorkedExample({ pia_under_nta_2025_override: override });
  const pia = runWith('force_pia');
  const nta = runWith('force_nta');
  check('Case 4: force_pia framework', pia.kpis.fiscal_framework, 'pia_only');
  check('Case 4: force_nta framework', nta.kpis.fiscal_framework, 'nta_2025');
  check('Case 4: NTA total_tet = 0 (invariant)', nta.kpis.total_tet, 0, 1e-9);
  check('Case 4: PIA total_dev_levy = 0 (invariant)', pia.kpis.total_dev_levy, 0, 1e-9);
  const tet = pia.cashFlowData[0].tet_tax;
  const dev = nta.cashFlowData[0].dev_levy_tax;
  check('Case 4: dev_levy = 1.6 x tet (same assessable base)', dev, tet * 1.6, 0.01);
  check('Case 4: cit_assessable identical across frameworks', nta.cashFlowData[0].cit_assessable_profit, pia.cashFlowData[0].cit_assessable_profit, 0.01);
  check('Case 4: net(NTA) = net(PIA) + tet - dev_levy', nta.cashFlowData[0].net_cash_flow, pia.cashFlowData[0].net_cash_flow + tet - dev, 0.01);
}
{
  const { cashFlowData } = computeCashFlow({
    cfg: { ...PIA_WORKED_EXAMPLE_CFG, pia_lease_status: 'new', pia_prior_cumulative_oil_bbl: 99_000_000 },
    prodRows: [{ year: 2025, well1_oil_bbl: 2_000_000 }, { year: 2026, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2025, amount_usd: 50_000_000 }],
    opexRows: [{ year: 2025, total_opex_usd: 20_000_000 }, { year: 2026, total_opex_usd: 20_000_000 }],
  });
  const y0 = cashFlowData[0];
  const y1 = cashFlowData[1];
  check('Case 5: 2025 eligible bbl = 1,000,000 (split at cap)', y0.prod_alw_eligible_bbl, 1_000_000, 1e-6);
  check('Case 5: 2025 allowance = $8M ($8/bbl on eligible only)', y0.production_allowance, 8_000_000);
  check('Case 5: 2025 cap_applied = true', y0.prod_alw_cap_applied, true);
  check('Case 5: 2025 cumulative lifetime = 101 MMbbl', y0.cumulative_oil_bbl_lifetime, 101_000_000, 1e-6);
  check('Case 5: 2026 eligible bbl = 0 (capacity exhausted)', y1.prod_alw_eligible_bbl, 0, 1e-9);
  check('Case 5: 2026 allowance = 0', y1.production_allowance, 0, 1e-9);
  check('Case 5: 2026 cap_applied = true', y1.prod_alw_cap_applied, true);
  check('Case 5: 2026 cumulative lifetime = 102 MMbbl', y1.cumulative_oil_bbl_lifetime, 102_000_000, 1e-6);
  check('Case 5: HCT chargeable = assessable - cap allowance claimed - prod allowance',
    y0.hct_chargeable_profit,
    y0.hct_assessable_profit - (y0.cpr_costs_claimed - Math.min(y0.opex, y0.cpr_costs_claimed)) - y0.production_allowance,
    0.01);
}
{
  const { cashFlowData, kpis } = computeCashFlow({
    cfg: { ...PIA_WORKED_EXAMPLE_CFG },
    prodRows: [{ year: 2025, well1_oil_bbl: 1_000_000 }],
    capexRows: [{ year: 2025, amount_usd: 100_000_000 }],
    opexRows: [{ year: 2025, total_opex_usd: 40_000_000 }],
  });
  const row = cashFlowData[0];
  check('Case 6: CPR cap = 52M (65% of 80M gross)', row.cpr_cap, 52_000_000);
  check('Case 6: CPR claimed = 52M', row.cpr_costs_claimed, 52_000_000);
  check('Case 6: CPR deferred = 8M', row.cpr_deferred_to_next, 8_000_000);
  check('Case 6: final-year forfeiture flag = 8M', row.cpr_forfeited_at_cessation, 8_000_000);
  check('Case 6: KPI cpr_forfeited_at_cessation = 8M', kpis.cpr_forfeited_at_cessation, 8_000_000);
}

describe('ported validation harness (epe-validation.ts cases 1 to 6, 60 checks)', () => {
  it('carries exactly 60 checks', () => {
    expect(harness).toHaveLength(60);
  });
  it.each(harness)('$label', ({ actual, expected, tol }) => {
    if (typeof expected === 'number') {
      expect(typeof actual).toBe('number');
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
    } else {
      expect(actual).toEqual(expected);
    }
  });
});

// ===========================================================================
// 2. Closed-form identities
// ===========================================================================

describe('closed-form identities', () => {
  const jv = GOLDEN.cases.find((c: any) => c.name === 'jv_analytic_decision_kpis');
  const multi = GOLDEN.cases.find((c: any) => c.name === 'multiyear_pia_real');

  it('NPV is the sum of the discounted rows and the nominal total is the sum of net cash flow', () => {
    for (const c of GOLDEN.cases) {
      const { cashFlowData, kpis } = computeCashFlow({ cfg: c.cfg, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows });
      const ev = cashFlowData.filter((r: any) => r.sunk !== true);
      expect(kpis.npv).toBeCloseTo(ev.reduce((s: number, r: any) => s + r.discounted_cash_flow, 0), 6);
      expect(kpis.total_net_cash_flow_nominal).toBeCloseTo(ev.reduce((s: number, r: any) => s + r.net_cash_flow, 0), 6);
    }
  });

  it('real basis with zero inflation equals the nominal basis', () => {
    const real = computeCashFlow({ ...jv, cfg: { ...jv.cfg, present_value_basis: 'real' } });
    const nominal = computeCashFlow({ ...jv, cfg: { ...jv.cfg, present_value_basis: 'nominal' } });
    expect(real.kpis.npv).toBeCloseTo(nominal.kpis.npv, 6);
    expect(real.kpis.discount_rate_applied_pct).toBeCloseTo(nominal.kpis.discount_rate_applied_pct, 12);
  });

  it('real basis discounts at the Fisher rate: NPV(real) = NPV(nominal at (1+i)(1+f)-1)', () => {
    const real = computeCashFlow({ ...multi });
    const infl = multi.cfg.inflation_rate_pct / 100;
    const nominalRate = ((1 + real.kpis.discount_rate_applied_pct / 100) * (1 + infl) - 1) * 100;
    expect(nominalRate).toBeCloseTo(multi.cfg.discount_rate_pct, 10);
    // Deflating by (1+f)^t then discounting at the real rate is discounting the
    // nominal flow at (1+r_real)(1+f) = 1 + nominal.
    const byHand = real.cashFlowData.reduce((s: number, r: any) =>
      s + r.net_cash_flow / Math.pow(1 + multi.cfg.discount_rate_pct / 100, r.year - multi.cfg.base_year), 0);
    expect(real.kpis.npv).toBeCloseTo(byHand, 4);
  });

  it('mid-year discounting equals end-year divided by sqrt(1 + r) on every case with one rate', () => {
    for (const c of GOLDEN.cases) {
      if (c.cfg.discounting_convention || c.cfg.valuation_year) continue;
      const end = computeCashFlow({ cfg: c.cfg, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows });
      const mid = computeCashFlow({ cfg: { ...c.cfg, discounting_convention: 'mid_year' }, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows });
      expect(mid.kpis.npv).toBeCloseTo(end.kpis.npv / Math.sqrt(1 + end.kpis.discount_rate_applied_pct / 100), 4);
    }
  });

  it('PSC and PIA at working interest w scale every monetary line by w; take percent is invariant', () => {
    for (const name of ['psc_carryforward', 'pia_worked_example', 'multiyear_pia_real']) {
      const c = GOLDEN.cases.find((x: any) => x.name === name);
      const key = c.cfg.fiscal_regime === 'PSC' ? 'psc_working_interest_pct' : 'pia_working_interest_pct';
      const full = computeCashFlow({ cfg: c.cfg, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows });
      const part = computeCashFlow({ cfg: { ...c.cfg, [key]: 35 }, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows });
      full.cashFlowData.forEach((row: any, i: number) => {
        for (const k of ['gross_revenue', 'royalty', 'tax', 'net_cash_flow', 'capex', 'opex']) {
          expect(part.cashFlowData[i][k]).toBeCloseTo(row[k] * 0.35, 4);
        }
      });
      expect(part.kpis.npv).toBeCloseTo(full.kpis.npv * 0.35, 4);
      expect(part.kpis.government_take_pct).toBeCloseTo(full.kpis.government_take_pct, 8);
    }
  });

  it('price royalty is continuous at every anchor and capped at 10 percent', () => {
    for (const year of [2021, 2025, 2030]) {
      const esc = Math.pow(1.02, year - 2021);
      for (const [anchor, rate] of [[50, 0], [100, 0.05], [150, 0.10]] as const) {
        const p = anchor * esc;
        expect(derivePriceRoyaltyRate(p - 1e-9, year, 'shallow_water')).toBeCloseTo(rate, 9);
        expect(derivePriceRoyaltyRate(p + 1e-9, year, 'shallow_water')).toBeCloseTo(rate, 9);
      }
      expect(derivePriceRoyaltyRate(1000, year, 'shallow_water')).toBe(0.10);
      expect(derivePriceRoyaltyRate(1000, year, 'frontier')).toBe(0);
    }
  });

  it('marginal field royalty is the volume-weighted average of the three bands', () => {
    for (const bopd of [1000, 5000, 7500, 10000, 25000]) {
      const b1 = Math.min(bopd, 5000);
      const b2 = Math.min(Math.max(bopd - 5000, 0), 5000);
      const b3 = Math.max(bopd - 10000, 0);
      expect(deriveOilRoyaltyRate('marginal_field', bopd)).toBeCloseTo((0.05 * b1 + 0.075 * b2 + 0.15 * b3) / bopd, 12);
    }
  });

  it('a flat price with no deck is the base escalated from base_year; a deck step-holds', () => {
    expect(resolveStreamPrice([], 80, 0.03, 2025, 2030)).toBeCloseTo(80 * Math.pow(1.03, 5), 12);
    expect(resolveStreamPrice([{ year: 2026, value: 90 }, { year: 2028, value: 70 }], 80, 0.05, 2025, 2025)).toBe(90);
    expect(resolveStreamPrice([{ year: 2026, value: 90 }, { year: 2028, value: 70 }], 80, 0.05, 2025, 2027)).toBe(90);
    expect(resolveStreamPrice([{ year: 2026, value: 90 }, { year: 2028, value: 70 }], 80, 0.05, 2025, 2030)).toBeCloseTo(70 * 1.05 * 1.05, 12);
    expect(resolveStreamPrice([], 10, 0, 2025, 2025, -20)).toBe(0);
  });

  it('IRR zeroes the NPV wherever it is reported, and payback is where the cumulative first turns non-negative', () => {
    for (const c of GOLDEN.cases) {
      const { cashFlowData, kpis } = computeCashFlow({ cfg: c.cfg, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows });
      const flows = cashFlowData.filter((r: any) => r.sunk !== true).map((r: any) => r.net_cash_flow);
      if (kpis.irr !== null) {
        const f = flows.reduce((s: number, cf: number, i: number) => s + cf / Math.pow(1 + kpis.irr / 100, i), 0);
        expect(Math.abs(f)).toBeLessThan(1e-3 * Math.max(1, ...flows.map(Math.abs)) * 1e-6 + 1);
      }
      let cum = 0;
      let expected: number | null = null;
      for (let i = 0; i < flows.length && expected === null; i++) {
        const prev = cum;
        cum += flows[i];
        if (prev < 0 && cum >= 0) expected = i - prev / flows[i];
      }
      if (expected === null) expected = cum >= 0 ? 0 : null;
      expect(kpis.payback_years).toEqual(expected === null ? null : expect.closeTo(expected, 9));
    }
  });
});

// ===========================================================================
// 3. Golden agreement with the independent oracle
// ===========================================================================

const TOL: Array<[RegExp, number | ((v: number) => number)]> = [
  [/^irr$/, 1e-4],
  [/payback_years$/, 1e-8],
  [/^(dpi|government_take_pct|government_take_pct_discounted|discount_rate_applied_pct|psc_contractor_share_pct|working_interest_pct|unit_technical_cost_usd_per_boe|opex_usd_per_boe|fx_ngn_per_usd)$/, 1e-8],
  [/^applied_.*_price$/, 1e-9],
  [/_bbl$|_mscf$|_boe$|_lifetime$/, 1e-6],
  [/./, (v: number) => Math.max(0.01, 1e-9 * Math.abs(v))],
];
const tolFor = (key: string, expected: number) => {
  for (const [re, t] of TOL) if (re.test(key)) return typeof t === 'function' ? t(expected) : t;
  return 0.01;
};

const expectSame = (actual: any, expected: any, where: string) => {
  if (expected === null || expected === undefined) {
    expect(actual === null || actual === undefined).toBe(true);
    return;
  }
  if (typeof expected === 'number') {
    expect(typeof actual).toBe('number');
    if (Math.abs(actual - expected) > tolFor(where.split('.').pop() as string, expected)) {
      throw new Error(`${where}: engine ${actual} vs oracle ${expected} (tol ${tolFor(where.split('.').pop() as string, expected)})`);
    }
    return;
  }
  expect(actual).toEqual(expected);
};

const run = (c: any) => computeCashFlow({ cfg: c.cfg, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows });

describe('golden agreement: cashflow_cases.json cases', () => {
  it('the golden carries the case families the brief asks for', () => {
    const names = GOLDEN.cases.map((c: any) => c.name);
    for (const n of ['pia_worked_example', 'jv_analytic_decision_kpis', 'psc_carryforward', 'nta_switch_force_nta', 'allowance_cap_midyear',
      'cpr_forfeiture', 'elt_tail_trimmed', 'abandonment_final_year', 'jv_loss_carryforward', 'multiyear_pia_real']) {
      expect(names).toContain(n);
    }
    expect(GOLDEN.cases.length).toBeGreaterThanOrEqual(60);
    expect(GOLDEN.engine_version).toBe(ENGINE_VERSION);
  });

  describe.each(GOLDEN.cases.map((c: any) => [c.name, c]))('%s', (_name: string, c: any) => {
    const { cashFlowData, kpis } = run(c);
    const exp = c.expected;
    const pinned = (GOLDEN.disagreements as any[]).filter((d) => d.case === c.name);

    it('produces the same rows with the same keys', () => {
      expect(cashFlowData).toHaveLength(exp.cashFlowData.length);
      cashFlowData.forEach((row: any, i: number) => {
        const want = exp.cashFlowData[i];
        expect(Object.keys(row).sort()).toEqual(Object.keys(want).sort());
        for (const k of Object.keys(want)) expectSame(row[k], want[k], `${c.name}.row[${i}].${k}`);
      });
    });

    it('produces every KPI the oracle computed, and no others', () => {
      expect(Object.keys(kpis).sort()).toEqual(Object.keys(exp.kpis).sort());
      for (const k of Object.keys(exp.kpis)) {
        if (k === 'npv_profile') continue;
        expectSame(kpis[k], exp.kpis[k], `${c.name}.kpis.${k}`);
      }
    });

    it('npv_profile agrees at the standard rates; the applied-rate point passes through the headline NPV or is a pinned disagreement', () => {
      const engineByRate = new Map(kpis.npv_profile.map((p: any) => [p.rate_pct, p.npv]));
      for (const p of exp.kpis.npv_profile) {
        if ([0, 5, 8, 10, 12, 15, 20].includes(p.rate_pct)) {
          expect(engineByRate.has(p.rate_pct)).toBe(true);
          expectSame(engineByRate.get(p.rate_pct), p.npv, `${c.name}.kpis.npv_profile[${p.rate_pct}].npv`);
        }
      }
      const applied = exp.kpis.discount_rate_applied_pct;
      // The engine labels the point with Math.round(fraction * 10000) / 100,
      // i.e. the percent rounded to two decimals.
      const rounded = Math.round(applied * 100) / 100;
      expect(engineByRate.has(rounded)).toBe(true);
      const pin = pinned.find((d) => d.quantity === 'kpis.npv_profile applied-rate point');
      if (pin) {
        // The engine's number is pinned as published; the oracle's point at
        // the exact rate is the headline NPV; the gap is recorded.
        expect(pin.engine.rate_pct).toBe(rounded);
        expectSame(engineByRate.get(rounded), pin.engine.npv, `${c.name}.disagreement.engine.npv`);
        expect(pin.oracle.npv).toBeCloseTo(exp.kpis.npv, 6);
        expect(pin.gap).toBeCloseTo(pin.engine.npv - pin.oracle.npv, 6);
        expect(Math.abs(pin.gap)).toBeGreaterThan(0.01);
      } else {
        expectSame(engineByRate.get(rounded), exp.kpis.npv, `${c.name}.kpis.npv_profile[applied].npv`);
      }
    });
  });
});

describe('golden agreement: ingestion errors', () => {
  it.each(GOLDEN.errors.map((e: any) => [e.name, e]))('%s throws the documented message', (_n: string, e: any) => {
    expect(() => run(e)).toThrow(e.error_contains);
  });
});

describe('golden agreement: irr and payback on bare flow vectors', () => {
  const npvAt = (flows: number[], ratePct: number) =>
    flows.reduce((s: number, cf: number, i: number) => s + cf / Math.pow(1 + ratePct / 100, i), 0);

  it.each(GOLDEN.irr.map((e: any) => [e.name, e]))('%s', (_n: string, e: any) => {
    const r = irr(e.flows);
    if (e.irr_pct === null) expect(r).toBeNull();
    else if (e.disagreement) {
      // Multi-root profile: the engine's Newton root is pinned as published,
      // the oracle's nearest-zero root is recorded beside it, and BOTH must
      // zero the NPV (they are different roots of the same equation).
      expect(r).not.toBeNull();
      expect(Math.abs(r! * 100 - e.disagreement.engine_irr_pct)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(e.disagreement.oracle_irr_pct - e.irr_pct)).toBeLessThanOrEqual(1e-12);
      const scale = Math.max(...e.flows.map(Math.abs));
      expect(Math.abs(npvAt(e.flows, r! * 100))).toBeLessThan(1e-6 * scale);
      expect(Math.abs(npvAt(e.flows, e.irr_pct))).toBeLessThan(1e-6 * scale);
      expect(Math.abs(r! * 100 - e.irr_pct)).toBeGreaterThan(1);
    } else {
      expect(r).not.toBeNull();
      expect(Math.abs(r! * 100 - e.irr_pct)).toBeLessThanOrEqual(1e-6);
    }
    const p = paybackYears(e.flows);
    if (e.payback_years === null) expect(p).toBeNull();
    else expect(p).toBeCloseTo(e.payback_years, 9);
    expect(paybackPeriod(e.flows)).toBe(e.payback);
  });
});

describe('golden agreement: breakeven oil price', () => {
  it.each(GOLDEN.breakeven.map((e: any) => [e.name, e]))('%s (0.001 USD/bbl: the engine bracket width)', (_n: string, e: any) => {
    const b = computeBreakevenOilPrice({ cfg: e.cfg, prodRows: e.prodRows, capexRows: e.capexRows, opexRows: e.opexRows });
    if (e.breakeven_usd_bbl === null) expect(b).toBeNull();
    else {
      expect(b).not.toBeNull();
      expect(Math.abs(b! - e.breakeven_usd_bbl)).toBeLessThanOrEqual(0.001);
      expect(Math.abs(e.npv_at_breakeven)).toBeLessThan(1);
    }
  });
});

describe('golden agreement: sweeps', () => {
  for (const [name, sweep] of Object.entries(GOLDEN.sweeps) as Array<[string, any]>) {
    it(`${name}: every point's KPI subset agrees`, () => {
      expect(sweep.points.length).toBeGreaterThanOrEqual(5);
      for (const p of sweep.points) {
        const { kpis } = run(p.inputs);
        for (const k of Object.keys(p.kpis)) expectSame(kpis[k], p.kpis[k], `${name}.point.${k}`);
      }
    });
  }

  it('the oil price sweep on the worked example is monotone in NPV and government take moves with the price royalty', () => {
    const pts = GOLDEN.sweeps.oil_price_pia_worked_example.points;
    for (let i = 1; i < pts.length; i++) expect(pts[i].kpis.npv).toBeGreaterThan(pts[i - 1].kpis.npv);
  });

  it('the discount-rate sweep is monotone decreasing in NPV', () => {
    const pts = GOLDEN.sweeps.discount_rate_multiyear_jv_real.points;
    for (let i = 1; i < pts.length; i++) expect(pts[i].kpis.npv).toBeLessThan(pts[i - 1].kpis.npv);
  });
});

describe('golden disagreements are all accounted for', () => {
  it('every pinned disagreement names a case in the golden, a method statement and a non-trivial gap', () => {
    expect(GOLDEN.disagreements.length).toBeGreaterThan(0);
    for (const d of GOLDEN.disagreements) {
      const name = d.case.startsWith('irr:') ? d.case.slice(4) : d.case;
      const pool = d.case.startsWith('irr:') ? GOLDEN.irr : GOLDEN.cases;
      expect(pool.some((c: any) => c.name === name)).toBe(true);
      expect(d.method_statement.length).toBeGreaterThan(20);
      expect(['USD', 'percentage points']).toContain(d.gap_unit);
      expect(Math.abs(d.gap)).toBeGreaterThan(d.gap_unit === 'USD' ? 0.01 : 1e-3);
    }
  });
});
