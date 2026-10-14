/**
 * v3.12.2: variable operating cost rates. Opex used to come only from the
 * OPEX file as fixed dollars by year, so a lower forecast (a 1P scenario, a
 * refreshed profile, the Monte Carlo or tornado production multiplier) kept
 * the old lifting cost. The Ekene kit bakes US$4 per barrel of oil and water
 * into its OPEX file (600,000 fixed, 100,000 more while Ekene-11 flows).
 *
 * Gates (every one CALLS computeCashFlow or runEpeMonteCarlo):
 *  (a) rates off: the goldens are untouched (economics.cashflow.test.ts and
 *      the rest run unchanged; here, a rate of 0 equals no rate at all);
 *  (b) a file holding fixed + US$4/bbl liquid explicitly equals a fixed-only
 *      file plus opex_variable_usd_per_bbl_liquid 4, on every line, under
 *      JV, PSC and the default PIA path (cost recovery, HCT and CIT bases,
 *      NDDC, economic limit), at 100% and 60% working interest;
 *  (c) the production multiplier moves opex: 80% of the volumes gives 80%
 *      of the variable opex, equal to an explicit file rebuilt from the
 *      scaled volumes; the Monte Carlo opex multiplier scales the variable
 *      part too, so a seeded run on fixed + rate equals the same seeded run
 *      on the explicit file;
 *  (d) the CAPEX/OPEX column checks read every row's headers.
 * Negative control (run by hand, 2026-10-14): without the merge of the
 * variable part into the yearly opex, (b) and (c) fail; without the Monte
 * Carlo opex_variable_scale line, the seeded equality in (c) fails.
 */
import { computeCashFlow } from '../engines/economics/cashflow.ts';
import { runEpeMonteCarlo } from '../engines/economics/montecarlo.ts';

const YEARS = Array.from({ length: 16 }, (_, i) => 2026 + i);
// four producers in decline plus a new well from 2027, Ekene style
const prodRows = YEARS.map((year, i) => ({
  year,
  w1_oil_bbl: 40000 * 0.88 ** i, w1_water_bbl: 3000 + 400 * i, w1_gas_mscf: 16000 * 0.88 ** i,
  w2_oil_bbl: 30000 * 0.86 ** i, w2_water_bbl: 6000 + 500 * i, w2_gas_mscf: 12000 * 0.86 ** i,
  w11_oil_bbl: i === 0 ? 0 : 105000 * 0.8 ** (i - 1), w11_water_bbl: 0, w11_gas_mscf: i === 0 ? 0 : 42000 * 0.8 ** (i - 1),
}));
const liquids = (r) => r.w1_oil_bbl + r.w1_water_bbl + r.w2_oil_bbl + r.w2_water_bbl + r.w11_oil_bbl + r.w11_water_bbl;
const fixed = (r) => 600000 + (r.w11_oil_bbl > 0 ? 100000 : 0);
const explicitOpex = (rows) => rows.map((r) => ({ year: r.year, total_opex_usd: fixed(r) + 4 * liquids(r) }));
const fixedOpex = prodRows.map((r) => ({ year: r.year, total_opex_usd: fixed(r) }));
const capexRows = [{ year: 2027, cost_usd: 12400000 }];

const BASE = {
  oil_price_usd_bbl: 75, gas_price_usd_mscf: 0, condensate_price_usd_bbl: 0,
  discount_rate_pct: 10, inflation_rate_pct: 2, base_year: 2026,
  oil_price_escalator_pct: 2, gas_price_escalator_pct: 0, condensate_price_escalator_pct: 0,
  opex_escalator_pct: 2.5, capex_escalator_pct: 0, present_value_basis: 'real',
  apply_economic_limit: true, abandonment_cost_usd: 6800000,
};
const REGIMES = {
  JV: { fiscal_regime: 'JV', jv_working_interest_pct: 100, jv_royalty_pct: 10, jv_tax_rate_pct: 30 },
  'JV 60%': { fiscal_regime: 'JV', jv_working_interest_pct: 60, jv_royalty_pct: 10, jv_tax_rate_pct: 30 },
  PSC: { fiscal_regime: 'PSC', psc_working_interest_pct: 100, psc_royalty_pct: 10, psc_cost_oil_cap_pct: 80, psc_contractor_profit_share_pct: 50, psc_tax_rate_pct: 50 },
  PIA: { fiscal_regime: 'PIA', pia_terrain: 'shallow_water', pia_license_type: 'PML', pia_lease_status: 'converted', pia_water_depth_m: 35 },
  'PIA 60%': { fiscal_regime: 'PIA', pia_terrain: 'shallow_water', pia_license_type: 'PML', pia_lease_status: 'converted', pia_water_depth_m: 35, pia_working_interest_pct: 60 },
};
const LINES = ['opex', 'royalty', 'tax', 'net_cash_flow', 'discounted_cash_flow', 'hct_tax', 'cit_tax', 'nddc', 'hcdt', 'cpr_costs_claimed'];

const expectSameRuns = (a, b) => {
  expect(a.kpis.npv).toBeCloseTo(b.kpis.npv, 4);
  expect(a.kpis.total_opex).toBeCloseTo(b.kpis.total_opex, 4);
  expect(a.kpis.total_tax).toBeCloseTo(b.kpis.total_tax, 4);
  expect(a.kpis.economic_limit_year).toBe(b.kpis.economic_limit_year);
  expect(a.kpis.irr ?? null).toEqual(b.kpis.irr ?? null);
  expect(a.cashFlowData.length).toBe(b.cashFlowData.length);
  a.cashFlowData.forEach((r, i) => {
    for (const k of LINES) {
      if (typeof r[k] === 'number' || typeof b.cashFlowData[i][k] === 'number') expect(r[k] ?? 0).toBeCloseTo(b.cashFlowData[i][k] ?? 0, 4);
    }
  });
};

describe('variable opex rates (3.12.2)', () => {
  it('(a) a rate of zero is the same as no rate, and adds no line', () => {
    const cfg = { ...BASE, ...REGIMES.PIA };
    const off = computeCashFlow({ cfg, prodRows, capexRows, opexRows: explicitOpex(prodRows) });
    const zero = computeCashFlow({ cfg: { ...cfg, opex_variable_usd_per_bbl_liquid: 0, opex_variable_usd_per_bbl_oil: null }, prodRows, capexRows, opexRows: explicitOpex(prodRows) });
    expectSameRuns(zero, off);
    expect(off.cashFlowData.every((r) => r.opex_variable === undefined)).toBe(true);
    expect(off.kpis.total_opex_variable).toBeUndefined();
  });

  it.each(Object.keys(REGIMES))('(b) fixed file + US$4/bbl liquid equals the explicit file on every line: %s', (name) => {
    const cfg = { ...BASE, ...REGIMES[name] };
    const explicit = computeCashFlow({ cfg, prodRows, capexRows, opexRows: explicitOpex(prodRows) });
    const rated = computeCashFlow({ cfg: { ...cfg, opex_variable_usd_per_bbl_liquid: 4 }, prodRows, capexRows, opexRows: fixedOpex });
    expectSameRuns(rated, explicit);
    // the variable part is reported on its own line, inflated like the file opex, at the share
    const wi = name.includes('60%') ? 0.6 : 1;
    rated.cashFlowData.forEach((r) => {
      const p = prodRows.find((x) => x.year === r.year);
      expect(r.opex_variable).toBeCloseTo(4 * liquids(p) * 1.025 ** (r.year - 2026) * wi, 4);
    });
    expect(rated.kpis.total_opex_variable).toBeGreaterThan(0);
  });

  it('(b) oil, water and gas rates add up the same as one liquid rate where they describe the same cost', () => {
    const cfg = { ...BASE, ...REGIMES.JV };
    const one = computeCashFlow({ cfg: { ...cfg, opex_variable_usd_per_bbl_liquid: 4 }, prodRows, capexRows, opexRows: fixedOpex });
    const split = computeCashFlow({ cfg: { ...cfg, opex_variable_usd_per_bbl_oil: 4, opex_variable_usd_per_bbl_water: 4 }, prodRows, capexRows, opexRows: fixedOpex });
    expectSameRuns(split, one);
    const gas = computeCashFlow({ cfg: { ...cfg, opex_variable_usd_per_mscf_gas: 0.5 }, prodRows, capexRows, opexRows: fixedOpex });
    const g2027 = prodRows[1].w1_gas_mscf + prodRows[1].w2_gas_mscf + prodRows[1].w11_gas_mscf;
    expect(gas.cashFlowData.find((r) => r.year === 2027).opex_variable).toBeCloseTo(0.5 * g2027 * 1.025, 4);
  });

  it('(c) the production multiplier now moves opex', () => {
    const cfg = { ...BASE, ...REGIMES.PIA, apply_economic_limit: false };
    const scaled = prodRows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'year' ? v : v * 0.8])));
    const full = computeCashFlow({ cfg: { ...cfg, opex_variable_usd_per_bbl_liquid: 4 }, prodRows, capexRows, opexRows: fixedOpex });
    const low = computeCashFlow({ cfg: { ...cfg, opex_variable_usd_per_bbl_liquid: 4 }, prodRows: scaled, capexRows, opexRows: fixedOpex });
    expect(low.kpis.total_opex_variable).toBeCloseTo(0.8 * full.kpis.total_opex_variable, 4);
    const rebuilt = computeCashFlow({ cfg, prodRows: scaled, capexRows, opexRows: explicitOpex(scaled) });
    expectSameRuns(low, rebuilt);
  });

  it('(c) the Monte Carlo opex multiplier scales the variable part too (seeded run equals the explicit file)', () => {
    const cfg = { ...BASE, ...REGIMES.PIA };
    const mcConfig = { iterations: 200, seed: 20261014, variables: { opex_scale: { type: 'triangular', min: 0.9, mode: 1.1, max: 1.5 } } };
    const explicit = runEpeMonteCarlo({ cfg, prodRows, capexRows, opexRows: explicitOpex(prodRows), mcConfig });
    const rated = runEpeMonteCarlo({ cfg: { ...cfg, opex_variable_usd_per_bbl_liquid: 4 }, prodRows, capexRows, opexRows: fixedOpex, mcConfig });
    expect(rated.npv.mean).toBeCloseTo(explicit.npv.mean, 3);
    expect(rated.npv.p90).toBeCloseTo(explicit.npv.p90, 3);
    expect(rated.npv.p10).toBeCloseTo(explicit.npv.p10, 3);
  });

  it('(c) the Monte Carlo production multiplier reaches the variable opex through the volumes', () => {
    const cfg = { ...BASE, ...REGIMES.PIA };
    const mcConfig = { iterations: 200, seed: 7, variables: { production_scale: { type: 'triangular', min: 0.6, mode: 0.8, max: 1.0 } } };
    const baked = runEpeMonteCarlo({ cfg, prodRows, capexRows, opexRows: explicitOpex(prodRows), mcConfig });
    const rated = runEpeMonteCarlo({ cfg: { ...cfg, opex_variable_usd_per_bbl_liquid: 4 }, prodRows, capexRows, opexRows: fixedOpex, mcConfig });
    // lower volumes lift fewer barrels, so the rated case keeps more value than the baked-in file
    expect(rated.npv.mean).toBeGreaterThan(baked.npv.mean);
  });

  it('(d) cost files with different headers pass the column check', () => {
    const cfg = { ...BASE, ...REGIMES.JV };
    const capexMixed = [{ year: 2027, category: 'Drilling', note: 'x' }, { year: 2027, cost_usd: 12400000 }];
    expect(() => computeCashFlow({ cfg, prodRows, capexRows: [{ year: 2027, cost_usd: 12400000 }], opexRows: [{ year: 2026, label: 'a' }, ...fixedOpex] })).not.toThrow();
    expect(() => computeCashFlow({ cfg, prodRows, capexRows: capexMixed, opexRows: fixedOpex })).not.toThrow();
    expect(() => computeCashFlow({ cfg, prodRows, capexRows, opexRows: [{ year: 2026, label: 'a' }] })).toThrow(/OPEX file: no cost column recognized/);
  });
});
