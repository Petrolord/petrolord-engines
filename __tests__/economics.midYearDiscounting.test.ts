/**
 * v3.12.3, owner decision 2026-10-14 (option A): the valuation date is 31
 * December of the valuation year. End-of-year cash in that year is
 * undiscounted (exponent year - V, unchanged); mid-year cash arrives half a
 * year before its year end, so its exponent is year - V - 0.5. Until 3.12.2
 * mid-year ADDED 0.5, which discounted mid-year cash more than year-end cash
 * for the same valuation date (Ekene: end-year 1,980,235; mid-year 1,888,080 before, 2,076,888 now).
 *
 * The case is the Ekene demonstration kit's field with Ekene-11
 * (dist-demo/ekene-demo-v4/12-economics, parsed as the Suite uploader parses
 * it, with the kit's Run Console settings: PIA shallow water 35 m, US$75,
 * gas 0, inflation 0, base and valuation 2026 with history sunk, economic
 * limit, abandonment 6.8 MM): test-data/economics/ekene-epe-case.json.
 * Every check calls computeCashFlow. NEGATIVE CONTROL: on the old exponent
 * (+0.5) the mid-year NPV is below the end-year NPV and the factor
 * invariant fails.
 */
import * as fs from 'fs';
import * as path from 'path';
import { computeCashFlow } from '../engines/economics/cashflow.ts';

const CASE = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/economics/ekene-epe-case.json'), 'utf8'));
const run = (convention: string) => computeCashFlow({ ...CASE, cfg: { ...CASE.cfg, discounting_convention: convention } });

describe('mid-year discounting on the Ekene case (3.12.3)', () => {
  const end = run('end_year');
  const mid = run('mid_year');
  const r = end.kpis.discount_rate_applied_pct / 100;

  it('end of year is unchanged: the kit NPV10 of 1,980,235 USD', () => {
    expect(end.kpis.npv).toBeCloseTo(1980235.4787, 3);
    expect(end.kpis.discounting_convention).toBe('end_year');
  });

  it('mid-year is worth more than end of year, by exactly (1 + r)^0.5', () => {
    expect(mid.kpis.discounting_convention).toBe('mid_year');
    expect(mid.kpis.npv).toBeGreaterThan(end.kpis.npv);
    expect(mid.kpis.npv).toBeCloseTo(end.kpis.npv * Math.sqrt(1 + r), 4);
  });

  it('every valued row: mid-year discount factor = end-year factor x (1 + r)^0.5; sunk rows are not valued', () => {
    const rows = end.cashFlowData.filter((x: any) => x.sunk !== true);
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      const m = mid.cashFlowData.find((x: any) => x.year === row.year);
      if (row.discounted_cash_flow === 0) { expect(m.discounted_cash_flow).toBe(0); continue; }
      const fEnd = row.discounted_cash_flow / row.real_net_cash_flow;
      const fMid = m.discounted_cash_flow / m.real_net_cash_flow;
      expect(fMid / fEnd).toBeCloseTo(Math.sqrt(1 + r), 12);
      // valuation 31 Dec 2026: 2026 end-of-year cash is undiscounted, mid-year cash compounds half a year
      if (row.year === 2026) { expect(fEnd).toBeCloseTo(1, 12); expect(fMid).toBeCloseTo(Math.sqrt(1 + r), 12); }
    }
    expect(end.cashFlowData.filter((x: any) => x.sunk === true).map((x: any) => x.year)).toEqual([2020, 2021, 2022, 2023, 2024, 2025]);
  });

  it('the NPV profile follows the same convention at every rate', () => {
    for (const p of mid.kpis.npv_profile) {
      const e = end.kpis.npv_profile.find((q: any) => q.rate_pct === p.rate_pct);
      expect(p.npv).toBeCloseTo(e.npv * Math.sqrt(1 + p.rate_pct / 100), 3);
    }
  });
});
