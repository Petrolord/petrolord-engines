# FINDINGS: PIA 2021 / NTA 2025 compliance repair (EC7, engines 3.12.0)

Branch `fix/pia-2021-compliance`, 2026-09-26, PR #262. It follows the audit in
`AUDIT-PIA-2021.md` (engines PR #260, merged). That audit has 66 rows: 31
MATCH, 25 MISMATCH, 4 AMBIGUOUS, 1 NOT IN TEXT and 5 NOT COMPUTED, and 4
rows also rest on a text that was not accessible (CITA, Finance Act 2023,
NDDC Act). Section 8 of the audit lists the decisions that are resolved
below.

Note on the negative control: the commit message of `8834bae` says "31
plants". The correct count is **30 plants, 30 RED**.

## 1. Texts read (all on 2026-09-26)

| text | edition | URL | sha256 |
|---|---|---|---|
| Petroleum Industry Act 2021 (Act No. 6) | Official Gazette No. 142, Vol. 108, 27 Aug 2021 (commencement 16 Aug 2021) | https://ngfcp.nuprc.gov.ng/wp-content/uploads/2022/09/Petroleum-Industry-Act-2021-pdf-searchable.pdf | 5d158ca8a16f00b2697eedfae26fbaccc7941b7814441438617377db4b76db2e |
| Nigeria Tax Act 2025 (Act No. 7) | Official Gazette No. 117, Vol. 112, 26 Jun 2025, effective 1 Jan 2026 (State House statement). The National Assembly ordered re-gazetting in Dec 2025; no Certified True Copy was read | https://irs.gm.gov.ng/docs/national/NIGERIA_TAX_ACT_2025.pdf | e13ea10a605079e6da827ad29a40cd0ab426b4ef1c2fab4fee48263048782848 |
| Petroleum Royalty Regulations 2022 (S.I. No. 73) | Official Gazette No. 205, Vol. 109, 22 Nov 2022 | https://www.nuprc.gov.ng/upload/nuprc_laws/Nigerian_Upstream_Petroleum_Royalty_Regulations_2022_d367e902a641eb1f93711ff6.pdf | 40bb5761b0a2278d0ebe8555e0775957989005ce7cf7b18a218f4b58a1814333 |
| Finance Act 2023 | "Final Signed by PMB", published by the Budget Office on 7 Jun 2023. The file is a scan, read page by page | https://budgetoffice.gov.ng/index.php/finance-act-2023/finance-act-2023-2/download | 9264789296e39bdd104480dec3e28a5c7170dbca97887f8b24586d0416baf11b |

Secondary sources only:

- Finance Act 2021 TET rate of 2.5%: EY and Forvis Mazars Finance Act alerts.
- NDDC Act 2000 s.14(2)(b), "3% of total annual budget": Mondaq and Lexology, "NDDC v NLNG".
- NTA effective date and re-gazetting: statehouse.gov.ng and Arise TV (27 Dec 2025).

## 2. Decisions

- **D1 (owner): correct by default.** One documented input,
  `pia_legacy_pre_audit: true`, reproduces every pre-audit (3.11.0) result
  exactly. The regression reference is re-frozen on the new independent
  oracle, and the old NPV is kept as the legacy-switch golden.
- **D2:** the live `cashflow` Expert lessons must be re-cut in a separate
  NextGen PR (section 7 lists them).
- **D3:** teach and compute the June 2025 NTA gazette. The version and the
  re-gazetting note are printed in `kpis.pia_notes` wherever an NTA year
  appears.
- **D4:** the default price-royalty base is the Regulations (2021 base).
  - The Act's 2020 base is available as `pia_price_royalty_base: 'act_2020'`.
  - The conflict is stated in `pia_notes`.
  - The course never grades the base year.
- **D5:** the two ambiguous hydrocarbon tax rates are stated inputs with no
  default, and a run without them is refused.
  - `pia_new_pml_hct_rate_pct` must be 15 or 30.
  - `pia_deep_offshore_hct_interpretation` is required in NTA years.
- **D6:** the CPR revenue base is crude plus condensate.
- **D7 (resolved on the primary text):** TETFund Act s.1(2) was amended by
  FA23 s.26 from 2.5% to 3%, effective 1 May 2023 (FA23 s.30).
  - The engine applies 3% from the 2023 row, the whole year, which is stated.
  - Before 2023 it applies 2.5% (Finance Act 2021, secondary source).
- **D8 (resolved on the primary text):** FA23 s.9(b) substitutes CITA Second
  Schedule para 24(7).
  - Capital allowance is capped at 66 2/3% of assessable profit.
  - Upstream and midstream gas companies are exempt; the new input
    `pia_cit_company_gas_operations` turns the exemption on.
  - The engine applies the cap only in PIA years; the NTA has no such cap.
  - The wording in force before 1 May 2023 was not read. The engine applies
    the same restriction to those years and says so in `pia_notes` as an
    engine assumption.
  - The CITA consolidation itself was not fetched; NTA s.196(c) repealed it.

## 3. Repairs (the default path) and their gates

| # | repair | text | negcontrol plants (all RED) |
|---|---|---|---|
| 1 | Weighted royalty tranches for every onshore and shallow field (5 / 7.5 / terrain rate) and for deep offshore (5% to 50,000 bopd, 7.5% above). The daily rate is crude plus condensate over calendar days. `marginal_field` is refused as a terrain | PIA 7th Sch 10(2)-(4); NTA 7th Sch 6(2); REGS r.12, r.13 | step, flat, 7.0%, crude-only, 365 days |
| 2 | Gas and NGL royalty 5%; 2.5% on `pia_gas_in_country_share_pct` | 10(6); REGS r.16 | 7%/5%, share ignored |
| 3 | Production allowance of 4 USD/bbl (or 20%) after the new-lease cap; none for deep offshore or frontier in NTA years | PIA 6th Sch 1(2); NTA 6th Sch 1(2) | both |
| 4 | CPR on crude plus condensate revenue, hydrocarbon tax only. CIT deducts full opex and its own allowance. Decommissioning contributions sit inside the CPR | 6th Sch 2; s.266(2); s.263(1)(e) | three plants |
| 5 | NDDC deducted in the HCT base, charged on the total annual budget (opex + capex). `pia_nddc_levy_base: 'opex'` is available as an option | s.263(1)(f),(h); NTA 68(1)(f),(h); NDDC Act s.14(2)(b) | both |
| 6 | Framework chosen per year of assessment; `pia_only_then_nta_2025` and `nta_first_year` reported | NTA commencement, s.197 | one |
| 7 | CITA two-thirds cap only in PIA years; gas-company exemption | FA23 s.9(b) | one |
| 8 | Capital allowance 20/20/20/20/19 in PIA years and 20% in NTA years. A recovery life other than 5 is refused | PIA 5th Sch 5(2), 17(1); NTA 1st Sch Pt II 4(2), 14(1); Pt I para 23 by analogy | one |
| 9 | TET 3% from 2023 and 2.5% before, unless a rate is supplied; a differing supplied rate is named in `pia_notes` | FA23 s.26, s.30 | one |
| 10 | NTA decommissioning deduction only if `pia_decom_escrow_condition_met` is true; a missing boolean is refused | NTA s.86 | one |
| 11 | Price-royalty benchmarks follow the Regulations Schedule, rounded to cents year by year. Each stream is priced at its own price. The Schedule's inconsistent 100 USD column is stated | 7th Sch 11; REGS r.15, Schedule | three plants |
| 12 | "Nigeria - PIA (2021)" template re-based (types `pia_2021`, `pia_cumulative_production`, `costRecoveryBase`). `LEGACY_PRE_AUDIT_PIA_TEMPLATE` is exported | 7th Sch 10(3), 10(6), 11, 14(4); s.260(3) | three plants |
| D5 | Stated HCT inputs with no default | s.267 / NTA 72; NTA 65(1) | two plants |
| ETR | Minimum ETR top-up only in NTA years | NTA s.57 | one |
| D1 | Legacy switch honoured | | one |
| HCT | Marginal flag gives 15% (s.94(1)) | | one |

**Negative control.** `negcontrol_pia2021.sh` plants 30 defects and all 30
go RED; the baseline is 603 passed. One earlier plant charged template gas
at the oil rate. It was invisible below 50,000 bopd, where both rates are
5%, so it was replaced by two plants that drop the gas royalty and the
price royalty.

**Legacy proof.** All 82 cashflow goldens and 6 Monte Carlo goldens were
regenerated with the flag on every PIA case. They differ from the old
goldens only by the flag and the `engine_version` string (143 diffs).

**Gates.**

- `__tests__/economics.pia2021.test.ts` has 603 tests.
- The full engines jest run has 226 suites: 17,324 passed, 1 skipped, 1 todo, 0 failed.

**Oracle.** `oracle_pia2021.py` is stdlib only and built as tables typed from
the texts; it never reads the engine or its documentation.

- It emits 19 ledgers and unit tables:
  - tranche edges at 1, 4999, 5000, 5001, 7500, 9999, 10000, 10001, 20000, 49999, 50000, 50001, 60000 and 120000 bopd;
  - benchmarks for 2019-2030 on both bases, plus the Act's own example (2.5% at 75 USD in 2020);
  - HCT, production allowance, capital allowance and TET.
- It also states its own conventions, O1-O9: the annual daily rate, the
  liquids-share cost split, the CPR claim order, negative chargeable profit
  carried, the NDDC base, the capital allowance law per year, the realised
  price used as the fiscal price, year-by-year cent rounding, and the
  government-take definition.

## 4. Regression contract (EPE.md section 7, re-frozen)

- **Default path:** the worked example inputs (case `worked_example_inputs_default` in `pia2021_cases.json`) give **NPV 141,236,909.83**.
- **Legacy switch:** the fixture `pia-worked-example.json`, which carries `pia_legacy_pre_audit: true`, gives **NPV 135,185,570.34** and every line item.

| worked example, 2025 | legacy | default | repair |
|---|---|---|---|
| production royalty | 182,500,000.00 | 164,250,000.00 | 1 (11.25% at 50,000 bopd, shallow water) |
| price royalty | 34,905,145.76 | 34,908,351.81 | 11 (54.12 rounded) |
| total royalty | 217,405,145.76 | 199,158,351.81 | |
| HCT assessable | 1,054,994,854.24 | 1,058,241,648.19 | 1, 5 |
| HCT chargeable | 949,369,854.24 | 952,616,648.19 | |
| HCT | 284,810,956.27 | 285,784,994.46 | |
| CIT assessable | 1,039,994,854.24 | 1,058,241,648.19 | 1 |
| CIT | 293,998,456.27 | 299,472,494.46 | |
| TET | 25,999,871.36 | 31,747,249.45 | 9 |
| total tax | 604,809,283.90 | 617,004,738.36 | |
| NCF = NPV | 135,185,570.34 | 141,236,909.83 | |

## 5. Before and after on the Ekene synthetic cases

The legacy runs use the Suite column defaults: TET 2.5, NDDC 3% of opex,
CPR 65, production allowance 2.5 / 8 / 20, recovery life 5, and the
conservative deep offshore reading.

| case | NPV legacy | NPV default | royalties legacy | royalties default | HCT legacy | HCT default | take % |
|---|---|---|---|---|---|---|---|
| ekene_alpha_shallow_converted_nta | 178,057,958 | 200,453,046 | 158,808,670 | 79,273,733 | 183,893,656 | 204,770,584 | 69.99 / 66.56 |
| ekene_onshore_across_2026 | 136,175,778 | 154,831,974 | 132,020,972 | 56,329,470 | 130,243,545 | 151,240,996 | 70.38 / 66.70 |
| ekene_deep_new_60k_aggressive | 1,109,520,314 | 574,288,797 | 457,955,397 | 355,321,629 | 0 | 607,899,513 | 51.84 / 73.58 |
| ekene_deep_new_60k_conservative | 1,109,520,314 | 1,101,777,817 | 457,955,397 | 355,321,629 | 0 | 0 | 51.84 / 52.08 |
| ekene_nag_gas_in_country_half | 35,440,443 | 37,773,079 | 12,600,000 | 6,750,000 | 0 | 0 | 53.49 / 50.70 |
| ekene_onshore_new_cap_crossing | 68,055,181 | 125,907,594 | 69,021,305 | 31,242,422 | 77,573,609 | 41,303,637 | 76.79 / 57.46 |
| ekene_condensate_price_royalty_regs | 121,451,173 | 127,235,503 | 91,636,873 | 69,663,506 | 121,908,938 | 127,690,948 | 74.32 / 73.10 |
| ekene_condensate_price_royalty_act | 121,451,173 | 127,589,093 | 91,636,873 | 68,707,858 | 121,908,938 | 127,977,643 | 74.32 / 73.03 |
| ekene_cpr_binding_forfeiture | -139,749,300 | -128,264,726 | 26,014,709 | 12,515,096 | 8,575,587 | 10,195,471 | n/a |
| ekene_sinking_fund_nta_escrow_met | 49,624,478 | 60,203,141 | 56,426,709 | 26,895,024 | 64,968,387 | 72,882,893 | 77.51 / 73.10 |
| ekene_sinking_fund_nta_escrow_not_met | 49,624,478 | 42,695,703 | 56,426,709 | 26,895,024 | 64,968,387 | 81,882,893 | 77.51 / 80.40 |
| ekene_sinking_fund_pia_years | 20,081,827 | 26,902,438 | 40,897,196 | 20,066,298 | 44,175,841 | 49,615,111 | 85.43 / 81.01 |
| ekene_min_etr_nta_only | -12,629,941 | 31,782,370 | 50,637,495 | 26,169,951 | 68,853,751 | 75,384,015 | 104.19 / 87.21 |
| ekene_alpha_wi_50 | 89,028,979 | 100,226,523 | 79,404,335 | 39,636,866 | 91,946,828 | 102,385,292 | 69.99 / 66.56 |
| ekene_marginal_shallow_flag | 148,060,924 | 155,741,317 | 78,254,071 | 61,147,418 | 59,249,389 | 61,275,387 | 65.37 / 63.57 |
| ekene_frontier | 162,405,000 | 160,623,000 | 32,850,000 | 32,850,000 | 0 | 0 | 48.93 / 49.49 |
| ekene_nddc_opex_base | 28,786,854 | 36,215,900 | 40,130,388 | 19,310,138 | 53,405,884 | 59,381,959 | 82.95 / 78.91 |
| ekene_force_pia_2027 | 125,146,276 | 138,112,339 | 92,980,424 | 43,099,123 | 120,584,401 | 134,378,791 | 68.73 / 65.68 |

## 6. Suite consequences

**Engine and deployment**

- Re-vendor `cashflow.ts`, `fiscalRegime.js` and `fiscalTemplates.js`.
- `supabase/functions/_shared/epe-engine.ts` re-exports the engine, so the
  owner must run `supabase functions deploy` for `epe-cash-flow-engine`,
  `epe-cash-flow-engine-batch` and the Monte Carlo function (`epe-mc.ts`).

**Saved configs that will now be refused**

- `pia_terrain = 'marginal_field'`.
- A new-lease PML onshore or in shallow water without `pia_new_pml_hct_rate_pct`.
- `pia_capex_recovery_years` other than 5.
- An NTA-year sinking fund without `pia_decom_escrow_condition_met`.
- A licence type other than PML or PPL.

**Held migration on `epe_run_configs`**

- Add columns `pia_legacy_pre_audit`, `pia_new_pml_hct_rate_pct`,
  `pia_gas_in_country_share_pct`, `pia_price_royalty_base`,
  `pia_nddc_levy_base`, `pia_nddc_levy_pct`,
  `pia_production_allowance_per_bbl_new_after_cap`,
  `pia_cit_company_gas_operations` and `pia_decom_escrow_condition_met`.
- Change the `pia_tet_rate_pct` default from 2.5 to NULL.
- Drop the default on `pia_deep_offshore_hct_interpretation` (D5).
- Stamp past runs with the legacy flag if they must reproduce.
- Log the migration in `MIGRATIONS.md`.

**UI and documentation**

- Run Console controls for the new inputs.
- `EpeResultsViewer` must handle `pia_only_then_nta_2025`, `nta_first_year`,
  `pia_notes` and the new row columns (`liquids_production_royalty`,
  `gas_royalty` and the rates).
- `docs/scope/EPE.md` sections 3.1, 5, 6.7 and 7 take the contract in section 4 above.

**Tests to move to the flag or to the new goldens**

- `supabase/functions/_shared/__tests__/epe-engine.test.ts`
- `supabase/functions/_shared/__tests__/epe-mc.test.ts`
- `tools/validation/epe-validation.ts`, and its fixture `tools/validation/fixtures/epe-pia-worked-example.ts`, which lacks the flag
- `src/pages/apps/epe/__tests__/economicsDefects.test.js`
- `tools/demo-dataset/__tests__/domain.economics.test.js`

**Ekene demo kit**

- `tools/demo-dataset/domains/economics/model.mjs` models a shallow-water
  converted PML from 2026, so every PIA figure moves and the kit must be
  regenerated.

**Fiscal Regime Designer**

- The editor, TemplateSelector and their tests must render the new template
  types.

**Unchanged**

- `src/utils/processSafety/__tests__/qraStudy.test.js` uses `npv` only.

## 7. NextGen consequences (re-vendor, then the D2 re-cuts)

**`cashflow` course**

- `cashflowLab.js` imports the golden cases. They carry the legacy flag, so
  replays keep their numbers.
- It also imports the rate helpers, which are now the compliant ones. Either
  switch the lab to `PIA_LEGACY_PRE_AUDIT` or re-cut it.
- Graded Expert fields that move on the default path:
  - `pia_2032_price_royalty_usd`
  - `pia_2032_prod_alw_eligible_bbl`
  - `pia_2031_cpr_deferred_usd`
  - `pia_total_hct_usd`
  - `pia_2033_dev_levy_usd`
  - `pia_npv_real_usd`
- Expert lessons to re-cut:
  - m02 l01-l04: l01 teaches the deep offshore step as correct.
  - m03 l01-l05: NDDC is taught as not in HCT; CPR on gross revenue and on CIT; allowance zero after the cap; the two-thirds carry is called "what the Act does".
  - m04 l01-l05: TET at 2.5%; one framework per ledger; min ETR in PIA years.
  - m05 l01, l03 and l05.
  - m06 l01-l03.
- Beginner and Intermediate lessons that mention the PIA need a wording
  check only.
- Expert bank questions to re-derive (keyword scan of the 2026-09-08 seed):
  - m01 ords 1, 2, 3, 7
  - m02 ords 1-14
  - m03 ords 1-15
  - m04 ords 1-7 and 9-15
  - m05 ords 1, 3, 8, 10
  - m06 ords 1, 3-9, 11-15
  - final exam: 32 of 42 (ords 1-11, 13, 14, 16, 17, 20, 22, 23, 25-27, 29-31, 34-39, 41, 42)

**`fiscal` course**

- `fiscalLab.js` imports `fiscalTemplates`, so the re-based template changes
  its cash flows and every six-template comparison.
- Graded Expert fields to re-derive; only those that read the PIA template
  move:
  - `cmp_top_npv_musd`
  - `cmp_psc_effective_tax_rate_pct`
  - `cmp_psc_price_sweep_at_60_pct`
  - `cmp_psc_capex_loss_last_tenth_musd`
  - `cmp_psc_capex_loss_eight_point_musd`
  - `cmp_con_price_climb_pct_points`
- Lessons naming the template: the files returned by `grep -rl "PIA (2021)\|Nigeria"`.
  Intermediate m01 and m03 use its OLD tiers as the worked tier example;
  those tiers survive in the engine goldens as `LEGACY_PIA_REGIME`.
- Bank questions that name Nigeria or the PIA:
  - Beginner: m01 3, 14; m03 9, 13; m05 4, 13; m06 14; final 2, 6, 16, 33, 34, 42.
  - Intermediate: m01 1, 5, 6, 11, 12; m03 8, 9, 11, 14; m04 13; m06 15; final 7, 9, 24, 40.
  - Advanced: m01 6; m02 4; m03 8; m04 4, 5, 11; m05 1, 2, 8; m06 5, 11-15; final 32-34, 42.
- The payback insight on the default project now names five year-3 regimes;
  it named four before.

**`qra` course**

- `qraLab.js` and `tools/course-waves/qra/*` use `npv` only. Prove them
  unchanged with prove_prior_courses.

**New `pia` course**

- Uses the default path.

## 8. Open items

- The Regulations Schedule prints the 100 USD column as 102 / 104 / 106 /
  108 / 110, which breaks its own 2% rule. The engine follows the rule and
  states this in `pia_notes`.
- The NTA re-gazetted Certified True Copy was not found (D3).
- The Finance Act 2021 rate (TET 2.5% before 2023) and the NDDC Act base
  rest on secondary sources.
- Not computed, and concept-only for the course:
  - the associated vs non-associated gas split;
  - the fiscal-price top-up (s.268, NTA s.73);
  - exploration and appraisal expensing;
  - the acquisition allowance;
  - PSC terms under 7th Sch para 14 inside the cash flow engine;
  - the NTA s.85 gas credit;
  - the statutory minimum ETR test.
- The Suite re-vendor PR, the held migration and the NextGen re-cuts listed
  above have not started.
