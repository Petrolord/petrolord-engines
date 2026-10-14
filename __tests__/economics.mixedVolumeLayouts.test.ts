/**
 * v3.12.1: a production slot can hold files with different headers. The
 * Edge Function concatenates every production file of a run, so a per-well
 * CSV (ekene_1_oil_bbl, ...) can sit beside a received profile with bare
 * oil_bbl rows (Forecast Scenario Hub, Decline Curve Analysis, Waterflood,
 * Simulation, Well Spacing). Before 3.12.1 the stream columns were picked
 * from the FIRST row's headers only, so one file was silently dropped (Ekene
 * demo account, 2026-10-14: the Ekene-11 profile vanished while its capex
 * counted, NPV -$12.1M instead of $1.98M).
 *
 * Gate: the same volumes as one per-well file and split into a per-well file
 * plus a bare-column file give identical annual volumes, cash flows and KPIs
 * from computeCashFlow, in both row orders. Negative control: with the old
 * first-row pick the split case loses a file and the gate fails.
 */
import { computeCashFlow, extractAnnualVolumes, pickVolumeColumns } from '../engines/economics/cashflow.ts';

const CFG = {
  oil_price_usd_bbl: 75, gas_price_usd_mscf: 3, condensate_price_usd_bbl: 0,
  discount_rate_pct: 10, inflation_rate_pct: 0, base_year: 2026,
  fiscal_regime: 'JV', jv_working_interest_pct: 100, jv_royalty_pct: 10, jv_tax_rate_pct: 30,
  oil_price_escalator_pct: 0, gas_price_escalator_pct: 0, condensate_price_escalator_pct: 0,
  opex_escalator_pct: 0, capex_escalator_pct: 0, present_value_basis: 'real',
  apply_economic_limit: true, abandonment_cost_usd: 2000000,
};
const YEARS = Array.from({ length: 12 }, (_, i) => 2026 + i);
const field = YEARS.map((year, i) => ({
  year,
  well_a_oil_bbl: 60000 * 0.85 ** i, well_b_oil_bbl: 45000 * 0.82 ** i,
  well_a_gas_mscf: 24000 * 0.85 ** i, well_b_gas_mscf: 18000 * 0.82 ** i,
  well_a_water_bbl: 5000 + 900 * i, well_b_water_bbl: 3000 + 700 * i,
}));
// the new well: first oil 2027, as a received profile carries it
const newWell = YEARS.slice(1).map((year, i) => ({ year, oil_bbl: 110000 * 0.7 ** i, gas_mscf: 44000 * 0.7 ** i }));
const merged = field.map((r) => {
  const n = newWell.find((x) => x.year === r.year);
  return { ...r, well_n_oil_bbl: n ? n.oil_bbl : 0, well_n_gas_mscf: n ? n.gas_mscf : 0 };
});
const capexRows = [{ year: 2027, cost_usd: 12000000 }];
const opexRows = YEARS.map((year) => ({ year, total_opex_usd: 900000 }));
const run = (prodRows) => computeCashFlow({ cfg: CFG, prodRows, capexRows, opexRows });

describe('production files with different headers', () => {
  const one = run(merged);

  it.each([
    ['per-well file first', [...field, ...newWell]],
    ['received profile first', [...newWell, ...field]],
  ])('the split case equals the single file (%s)', (_label, rows) => {
    expect(extractAnnualVolumes(rows, 2026)).toEqual(extractAnnualVolumes(merged, 2026));
    const split = run(rows);
    expect(split.kpis.npv).toBeCloseTo(one.kpis.npv, 6);
    expect(split.kpis.total_revenue).toBeCloseTo(one.kpis.total_revenue, 6);
    expect(split.kpis.economic_limit_year).toBe(one.kpis.economic_limit_year);
    expect(split.cashFlowData.length).toBe(one.cashFlowData.length);
    split.cashFlowData.forEach((r, i) => {
      expect(r.year).toBe(one.cashFlowData[i].year);
      expect(r.oil_bbl).toBeCloseTo(one.cashFlowData[i].oil_bbl, 6);
      expect(r.net_cash_flow).toBeCloseTo(one.cashFlowData[i].net_cash_flow, 6);
    });
  });

  it('the new well is worth something: dropping it would move the NPV (the gate can discriminate)', () => {
    expect(Math.abs(run(field).kpis.npv - one.kpis.npv)).toBeGreaterThan(1e6);
  });

  it('the validation sees the columns of every file', () => {
    const cols = pickVolumeColumns([...newWell, ...field]);
    expect(cols.oil_bbl.sort()).toEqual(['oil_bbl', 'well_a_oil_bbl', 'well_b_oil_bbl']);
  });

  it('a file with no readable volume column still fails loudly', () => {
    expect(() => run([{ year: 2026, barrels: 100 }])).toThrow(/no oil\/gas\/condensate volume columns recognized/);
  });
});
