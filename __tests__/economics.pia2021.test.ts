// Jest gate for the PIA 2021 / NTA 2025 DEFAULT path of
// engines/economics/cashflow.ts (engines 3.12.0, EC7 owner decision D1:
// correct by default, one documented legacy switch).
//
// Goldens: test-data/economics/goldens/pia2021_cases.json, from the
// independent stdlib oracle tools/validation/economics/oracle_pia2021.py,
// written from the gazetted texts (read 2026-09-26):
//   PIA   Petroleum Industry Act 2021, Official Gazette No. 142, 27 Aug 2021
//   NTA   Nigeria Tax Act 2025, Official Gazette No. 117, 26 Jun 2025
//   REGS  Petroleum Royalty Regulations 2022, S.I. 73, Gazette No. 205
//   FA23  Finance Act 2023 (s.9(b), s.26, s.30)
// Every describe block names the provision it gates. Tolerances: money
// max(0.01, 1e-9 x |expected|) USD; rates 1e-12; volumes 1e-6 bbl.

import fs from 'fs';
import path from 'path';
import {
  computeCashFlow, ENGINE_VERSION, PIA_LEGACY_PRE_AUDIT, PIA_NOTES,
  deriveOilRoyaltyRate, deriveGasRoyaltyRate, derivePriceRoyaltyRate, priceRoyaltyBenchmarks,
  deriveHctRate, computeProductionAllowance, capitalAllowanceFraction, statutoryTetRatePct,
  fiscalFrameworkForYear,
} from '../engines/economics/cashflow.ts';

const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
const GOLDEN = read('../test-data/economics/goldens/pia2021_cases.json');
const FIXTURE = read('../test-data/economics/fixtures/pia-worked-example.json');
const T = GOLDEN.tables;

const money = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(0.01, 1e-9 * Math.abs(expected)));
const rate = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12);
const byName = (n: string) => {
  const c = GOLDEN.cases.find((x: any) => x.name === n);
  if (!c) throw new Error(`golden case ${n} missing from pia2021_cases.json`);
  return c;
};
const run = (c: any) => computeCashFlow({ cfg: c.cfg, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows });

describe('engine version', () => {
  it('is 3.12.0', () => expect(ENGINE_VERSION).toBe('3.12.0'));
});

describe('royalty based on production: PIA 7th Sch para 10(2)-(4), REGS r.13 (tranche edge table)', () => {
  it.each(T.production_royalty.map((r: any) => [r.terrain, r.bopd, r.rate]))('%s at %d bopd', (ter: string, b: number, r: number) => {
    rate(deriveOilRoyaltyRate(ter, b), r);
  });
  it('holds the stated edges exactly: 5% at 5,000, 6.25% at 10,000 (onshore/shallow), 5% at 50,000 (deep)', () => {
    expect(deriveOilRoyaltyRate('onshore', 5000)).toBe(0.05);
    expect(deriveOilRoyaltyRate('shallow_water', 10000)).toBeCloseTo(0.0625, 15);
    expect(deriveOilRoyaltyRate('deep_offshore', 50000)).toBe(0.05);
    expect(deriveOilRoyaltyRate('deep_offshore', 60000)).toBeCloseTo((50000 * 0.05 + 10000 * 0.075) / 60000, 15);
  });
  it('is continuous across every edge', () => {
    for (const ter of ['onshore', 'shallow_water', 'deep_offshore']) {
      for (const e of [5000, 10000, 50000]) {
        expect(Math.abs(deriveOilRoyaltyRate(ter, e + 1e-6) - deriveOilRoyaltyRate(ter, e))).toBeLessThan(1e-9);
      }
    }
  });
});

describe('gas and NGL royalty: 5%, 2.5% utilised in-country (para 10(6); REGS r.16)', () => {
  it.each(T.gas_royalty.map((r: any) => [r.in_country_pct, r.rate]))('%d%% in-country', (s: number, r: number) => {
    for (const ter of ['onshore', 'shallow_water', 'deep_offshore', 'frontier']) rate(deriveGasRoyaltyRate(ter, s), r);
  });
});

describe('royalty by price: para 11, REGS r.15 and Schedule', () => {
  it.each(T.benchmarks.map((r: any) => [r.base, r.year, r.levels]))('%s benchmarks %d', (base: any, y: number, lv: number[]) => {
    const b = priceRoyaltyBenchmarks(y, base);
    expect([b.low, b.mid, b.high]).toEqual(lv);
  });
  it('matches the REGS Schedule low and high columns for 2021-2026', () => {
    const low = [50, 51, 52.02, 53.06, 54.12, 55.2];
    const high = [150, 153, 156.06, 159.18, 162.36, 165.61];
    for (let i = 0; i < 6; i++) {
      const b = priceRoyaltyBenchmarks(2021 + i);
      expect(b.low).toBe(low[i]);
      expect(b.high).toBe(high[i]);
    }
  });
  it('applies the 2% rule to the middle level (104.04 in 2023, not the table\'s 104.00)', () => {
    expect(priceRoyaltyBenchmarks(2023).mid).toBe(104.04);
  });
  it.each(T.price_royalty.map((r: any) => [r.base, r.year, r.terrain, r.price, r.rate]))('%s %d %s at %d', (base: any, y: number, ter: string, p: number, r: number) => {
    rate(derivePriceRoyaltyRate(p, y, ter, base), r);
  });
  it('reproduces the Act\'s own example on the act_2020 base: 2.5% at 75 USD in 2020', () => {
    expect(T.act_example.rate).toBeCloseTo(0.025, 15);
    rate(derivePriceRoyaltyRate(75, 2020, 'onshore', 'act_2020'), T.act_example.rate);
  });
});

describe('hydrocarbon tax rate: PIA ss.260(3), 267, 94(1); NTA ss.65, 72', () => {
  it.each(T.hct_rate.map((r: any, i: number) => [i, r]))('row %d', (_i: number, r: any) => {
    const c = r.cfg;
    rate(deriveHctRate(c.pia_terrain, c.pia_license_type, c.pia_marginal_field_pre_2021, null, r.framework,
      c.pia_deep_offshore_hct_interpretation, null, c.pia_lease_status, c.pia_new_pml_hct_rate_pct), r.rate);
  });
});

describe('production allowance: PIA 6th Sch para 1; NTA 6th Sch para 1', () => {
  it.each(T.production_allowance.map((r: any, i: number) => [i, r]))('row %d', (_i: number, r: any) => {
    const out = computeProductionAllowance(r.cfg, r.bbl, r.price, r.prior, r.framework);
    money(out.allowance, r.allowance);
    expect(out.below_cap_bbl).toBeCloseTo(r.below_cap_bbl, 6);
    expect(out.after_cap_bbl).toBeCloseTo(r.after_cap_bbl, 6);
  });
});

describe('capital allowance: PIA 5th Sch para 17; NTA 1st Sch Pt II para 14', () => {
  it.each(T.capital_allowance.map((r: any) => [r.framework, r.year_of_life, r.fraction]))('%s year %d', (fw: any, i: number, f: number) => {
    rate(capitalAllowanceFraction(i, fw), f);
  });
});

describe('tertiary education tax: FA23 s.26', () => {
  it.each(T.tet.map((r: any) => [r.year, r.rate_pct]))('%d', (y: number, p: number) => expect(statutoryTetRatePct(y)).toBe(p));
});

describe('framework per year of assessment (NTA from 1 January 2026)', () => {
  it('auto reads the year; overrides force it', () => {
    expect(fiscalFrameworkForYear({}, 2025)).toBe('pia_only');
    expect(fiscalFrameworkForYear({}, 2026)).toBe('nta_2025');
    expect(fiscalFrameworkForYear({ pia_under_nta_2025_override: 'force_pia' }, 2030)).toBe('pia_only');
    expect(fiscalFrameworkForYear({ pia_under_nta_2025_override: 'force_nta' }, 2022)).toBe('nta_2025');
  });
});

const ROW_MONEY = ['gross_revenue', 'liquids_production_royalty', 'gas_royalty', 'price_royalty', 'royalty', 'production_royalty',
  'hcdt', 'nddc', 'cpr_cap', 'cpr_costs_claimed', 'cpr_deferred_to_next', 'hct_assessable_profit', 'production_allowance',
  'hct_chargeable_profit', 'hct_tax', 'cit_assessable_profit', 'cit_allowance_claimed', 'cit_chargeable_profit', 'cit_tax',
  'tet_tax', 'dev_levy_tax', 'tax', 'net_cash_flow', 'depreciation', 'opex', 'capex'];
const ROW_RATES = ['royalty_liquids_bopd', 'royalty_rate_liquids', 'royalty_rate_gas', 'price_royalty_rate_oil',
  'price_royalty_rate_condensate', 'hct_rate', 'tet_rate_pct'];
const KPI_MONEY = ['npv', 'total_royalties', 'total_hct', 'total_cit', 'total_tet', 'total_dev_levy', 'total_hcdt',
  'total_nddc', 'total_production_allowance'];

describe('full ledgers against the oracle (Ekene synthetic cases and the re-frozen worked example)', () => {
  describe.each(GOLDEN.cases.map((c: any) => [c.name, c]))('%s', (_n: string, c: any) => {
    const { cashFlowData, kpis } = run(c);
    const exp = c.expected;
    it('has the oracle\'s years and frameworks', () => {
      expect(cashFlowData.map((r: any) => r.year)).toEqual(exp.rows.map((r: any) => r.year));
      expect(cashFlowData.map((r: any) => r.fiscal_framework)).toEqual(exp.rows.map((r: any) => r.fiscal_framework));
      expect(kpis.fiscal_framework).toBe(exp.kpis.fiscal_framework);
      if (exp.kpis.nta_first_year !== undefined) expect(kpis.nta_first_year).toBe(exp.kpis.nta_first_year);
    });
    it('matches every money line of every row', () => {
      exp.rows.forEach((er: any, i: number) => {
        for (const k of ROW_MONEY) money(cashFlowData[i][k] ?? 0, er[k]);
        money(cashFlowData[i].min_etr_topup ?? 0, er.min_etr_topup ?? 0);
      });
    });
    it('matches every rate and daily rate of every row', () => {
      exp.rows.forEach((er: any, i: number) => {
        for (const k of ROW_RATES) expect(Math.abs(cashFlowData[i][k] - er[k])).toBeLessThanOrEqual(1e-9);
        expect(cashFlowData[i].prod_alw_below_cap_bbl).toBeCloseTo(er.prod_alw_below_cap_bbl, 6);
        expect(cashFlowData[i].prod_alw_after_cap_bbl).toBeCloseTo(er.prod_alw_after_cap_bbl, 6);
      });
    });
    it('matches the KPIs', () => {
      for (const k of KPI_MONEY) money(kpis[k], exp.kpis[k]);
      if (exp.kpis.government_take_pct === null) expect(kpis.government_take_pct).toBeNull();
      else expect(kpis.government_take_pct).toBeCloseTo(exp.kpis.government_take_pct, 8);
      money(kpis.cpr_forfeited_at_cessation ?? 0, exp.kpis.cpr_forfeited_at_cessation ?? 0);
      money(kpis.cit_allowance_unused_at_cessation ?? 0, exp.kpis.cit_allowance_unused_at_cessation ?? 0);
    });
    it('states its notes and is not legacy', () => {
      expect(kpis.pia_legacy_pre_audit).toBeUndefined();
      expect(Array.isArray(kpis.pia_notes)).toBe(true);
      expect(kpis.pia_notes).toContain(PIA_NOTES.fiscalPrice);
    });
  });
});

describe('regression contract (EPE.md section 7, re-frozen 2026-09-26)', () => {
  it('default path: the worked example inputs give NPV 141,236,909.83 (oracle_pia2021)', () => {
    const c = byName('worked_example_inputs_default');
    const { kpis } = run(c);
    expect(c.expected.kpis.npv).toBeCloseTo(141236909.83, 2);
    money(kpis.npv, c.expected.kpis.npv);
  });
  it('legacy switch: the frozen fixture still gives NPV 135,185,570.34 and every line item', () => {
    expect(FIXTURE.cfg.pia_legacy_pre_audit).toBe(true);
    const { cashFlowData, kpis } = computeCashFlow({ cfg: FIXTURE.cfg, prodRows: FIXTURE.prodRows, capexRows: FIXTURE.capexRows, opexRows: FIXTURE.opexRows });
    expect(kpis.npv).toBeCloseTo(135185570.34, 2);
    for (const [k, v] of Object.entries(FIXTURE.expected.line_items)) money(cashFlowData[0][k], v as number);
    expect(kpis.pia_legacy_pre_audit).toBe(true);
    expect(kpis.pia_notes).toBeUndefined();
  });
  it('the switch is the only difference: the same fixture without it is a different ledger', () => {
    const cfg = { ...FIXTURE.cfg, pia_legacy_pre_audit: false };
    const { cashFlowData } = computeCashFlow({ cfg, prodRows: FIXTURE.prodRows, capexRows: FIXTURE.capexRows, opexRows: FIXTURE.opexRows });
    money(cashFlowData[0].production_royalty, 1460000000 * 0.1125);
  });
  it('exports the legacy helpers unchanged (the old deep offshore step and marginal terrain)', () => {
    expect(PIA_LEGACY_PRE_AUDIT.deriveOilRoyaltyRate('deep_offshore', 60000)).toBe(0.075);
    expect(PIA_LEGACY_PRE_AUDIT.deriveGasRoyaltyRate('onshore')).toBe(0.07);
    expect(PIA_LEGACY_PRE_AUDIT.deriveOilRoyaltyRate('marginal_field', 8000)).toBeCloseTo(0.059375, 12);
  });
});

describe('refusals state their exact conditions', () => {
  const base = byName('ekene_alpha_shallow_converted_nta');
  const runWith = (over: any) => () => computeCashFlow({ cfg: { ...base.cfg, ...over }, prodRows: base.prodRows, capexRows: base.capexRows, opexRows: base.opexRows });
  it('marginal_field is not a terrain', () => {
    expect(runWith({ pia_terrain: 'marginal_field' })).toThrow('pia_terrain "marginal_field" is not a terrain under the Petroleum Industry Act 2021');
  });
  it('a new-acreage PML onshore or in shallow water needs a stated 15 or 30', () => {
    expect(runWith({ pia_lease_status: 'new' })).toThrow('needs pia_new_pml_hct_rate_pct set to 15 or 30; got null');
    expect(runWith({ pia_lease_status: 'new', pia_new_pml_hct_rate_pct: 20 })).toThrow('set to 15 or 30; got 20');
  });
  it('a deep offshore NTA year needs a stated interpretation', () => {
    expect(runWith({ pia_terrain: 'deep_offshore' })).toThrow('A deep offshore year under the Nigeria Tax Act 2025 needs pia_deep_offshore_hct_interpretation');
  });
  it('the capital allowance life is fixed at five years', () => {
    expect(runWith({ pia_capex_recovery_years: 7 })).toThrow('pia_capex_recovery_years is 7, but the PIA Fifth Schedule para 17(1)');
  });
  it('an NTA-year decommissioning contribution needs the escrow condition stated', () => {
    const s = byName('ekene_sinking_fund_nta_escrow_met');
    const cfg = { ...s.cfg };
    delete cfg.pia_decom_escrow_condition_met;
    expect(() => computeCashFlow({ cfg, prodRows: s.prodRows, capexRows: s.capexRows, opexRows: s.opexRows }))
      .toThrow('2026 is a year under the Nigeria Tax Act 2025 and carries a decommissioning fund contribution, so pia_decom_escrow_condition_met must be true or false');
  });
  it('bad option strings are named', () => {
    expect(runWith({ pia_price_royalty_base: 'act' })).toThrow('pia_price_royalty_base must be "regulations_2021" or "act_2020"; got "act".');
    expect(runWith({ pia_nddc_levy_base: 'capex' })).toThrow('pia_nddc_levy_base must be "total_budget" or "opex"; got "capex".');
    expect(runWith({ pia_gas_in_country_share_pct: 120 })).toThrow('pia_gas_in_country_share_pct must be a number from 0 to 100; got 120.');
    expect(runWith({ pia_under_nta_2025_override: 'nta' })).toThrow('pia_under_nta_2025_override must be "auto", "force_pia" or "force_nta"; got "nta".');
    expect(runWith({ pia_legacy_pre_audit: 'yes' })).toThrow('pia_legacy_pre_audit must be true or false; got "yes".');
    expect(runWith({ pia_license_type: 'OML' })).toThrow('pia_license_type must be "PML" or "PPL"; got "OML".');
  });
});

describe('notes: the conflicts and assumptions are stated', () => {
  it('the TET note names an explicit rate that differs from the statute', () => {
    const c = byName('ekene_onshore_across_2026');
    const { kpis } = computeCashFlow({ cfg: { ...c.cfg, pia_tet_rate_pct: 2.5 }, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows });
    expect(kpis.pia_notes).toContain('pia_tet_rate_pct 2.5 was used for 2024, 2025. The statutory tertiary education tax is 3% from 2023 (Tertiary Education Trust Fund Act s.1(2) as amended by Finance Act 2023 s.26) and 2.5% before; leave pia_tet_rate_pct unset to apply it.');
  });
  it('the price royalty base conflict, the NTA version and the pre-2026 restriction are stated where they apply', () => {
    const { kpis } = run(byName('ekene_onshore_across_2026'));
    expect(kpis.pia_notes).toEqual(expect.arrayContaining([PIA_NOTES.priceRoyaltyBaseRegulations, PIA_NOTES.ntaVersion, PIA_NOTES.citRestrictionPre2026]));
    const act = run(byName('ekene_condensate_price_royalty_act')).kpis;
    expect(act.pia_notes).toContain(PIA_NOTES.priceRoyaltyBaseAct);
  });
});

describe('repair 12: the "Nigeria - PIA (2021)" sandbox template is re-based on the Act', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { fiscalTemplates, LEGACY_PRE_AUDIT_PIA_TEMPLATE } = require('../engines/economics/fiscalTemplates.js');
  const { calculateCashFlowForRegime } = require('../engines/economics/fiscalRegime.js');
  const FG = read('../test-data/economics/goldens/fiscal_cases.json');
  const tpl = fiscalTemplates.find((t: any) => t.name === 'Nigeria - PIA (2021)').regime;
  it('carries the Seventh Schedule para 14(4) cost limit and profit oil scale, CIT 30, no HCT', () => {
    expect(tpl.costRecoveryLimit).toBe(70);
    expect(tpl.costRecoveryBase).toBe('liquids_gross');
    expect(tpl.profitSplit.tiers.map((t: any) => [t.upToMMbbl, t.governmentPct]))
      .toEqual([[50, 5], [100, 10], [350, 15], [750, 25], [1500, 35], [null, 45]]);
    expect(tpl.tax).toEqual({ cit: 30, rrt: 0, minTax: 0 });
    expect(tpl.royalty).toMatchObject({ type: 'pia_2021', terrain: 'deep_offshore', firstCalendarYear: 2027 });
  });
  it('the sandbox ledger matches the fiscal oracle on both projects', () => {
    for (const id of ['template_nigeria___pia__2021_default_project', 'template_nigeria___pia__2021_test_project']) {
      const c = FG.cashflow.find((x: any) => x.id === id);
      const rows = calculateCashFlowForRegime(c.regime, c.project, c.capexMultiplier, c.priceMultiplier);
      rows.forEach((r: any, i: number) => {
        for (const k of ['royalty', 'costRecovered', 'tax', 'contractorNCF', 'governmentTake']) {
          expect(Math.abs(r[k] - c.expected.cashflow[i][k])).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(c.expected.cashflow[i][k])));
        }
      });
    }
  });
  it('keeps the pre-audit template out of the list and exported for past comparisons', () => {
    expect(fiscalTemplates.map((t: any) => t.name)).not.toContain(LEGACY_PRE_AUDIT_PIA_TEMPLATE.name);
    expect(LEGACY_PRE_AUDIT_PIA_TEMPLATE.regime.costRecoveryLimit).toBe(80);
  });
  it('refuses a cumulative-production table whose last band is bounded', () => {
    const bad = { ...tpl, name: 'Bad', profitSplit: { type: 'pia_cumulative_production', tiers: [{ upToMMbbl: 50, governmentPct: 5 }] } };
    const c = FG.cashflow.find((x: any) => x.id === 'template_nigeria___pia__2021_default_project');
    expect(() => calculateCashFlowForRegime(bad, c.project)).toThrow('Fiscal regime "Bad": a pia_cumulative_production table needs bands in ascending upToMMbbl with the last upToMMbbl null.');
  });
});
