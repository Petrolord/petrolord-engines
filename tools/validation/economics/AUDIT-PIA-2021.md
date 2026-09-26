# EC7 audit: the PIA 2021 fiscal computation in petrolord-engines against the gazetted texts

Audit date: 2026-09-26. Auditor: EC7 audit agent (catalogue programme wave 1, EC7 steps 1 and 2).
Engines revision audited: `origin/main` f50251d (engine `ENGINE_VERSION = '3.11.0'`).
Scope: `engines/economics/cashflow.ts`, `fiscalRegime.js`, `fiscalTemplates.js`, `fiscalConventions.js`,
`test-data/economics/fixtures/pia-worked-example.json`, Suite `docs/scope/EPE.md` (main).
No engine code was changed. Every engine value quoted below was read from the source at the line cited, and
every behavioural claim marked "probe" was produced by calling the engine (a throwaway jest probe, not committed;
its output is reproduced in section 6).

## 1. Texts read (version, where, when)

| id | text | version read | where | read on | sha256 of the file read |
|---|---|---|---|---|---|
| PIA | Petroleum Industry Act, 2021 (Act No. 6) | Official Gazette No. 142, Vol. 108, Lagos 27 August 2021, Government Notice No. 134, pages A121-A370; commencement 16 August 2021 | NUPRC searchable copy https://ngfcp.nuprc.gov.ng/wp-content/uploads/2022/09/Petroleum-Industry-Act-2021-pdf-searchable.pdf (text layer); the image scan at https://www.petroleumindustrybill.com/wp-content/uploads/2021/09/Official-Gazette-of-the-Petroleum-Industry-Act-2021.pdf was also downloaded as the same gazette | 2026-09-26 | 5d158ca8a16f00b2697eedfae26fbaccc7941b7814441438617377db4b76db2e |
| NTA | Nigeria Tax Act, 2025 (Act No. 7) | Official Gazette No. 117, Vol. 112, Lagos 26 June 2025, Government Notice No. 26, pages A385-A597 | https://irs.gm.gov.ng/docs/national/NIGERIA_TAX_ACT_2025.pdf | 2026-09-26 | e13ea10a605079e6da827ad29a40cd0ab426b4ef1c2fab4fee48263048782848 |
| REGS | Petroleum Royalty Regulations, 2022 (S.I. No. 73 of 2022, made under PIA s.304(2)) | Official Gazette No. 205, Vol. 109, Lagos 22 November 2022, pages B3193-B3219 | NUPRC gazetted-regulations page https://www.nuprc.gov.ng/laws/regulations/gazetted, file https://www.nuprc.gov.ng/upload/nuprc_laws/Nigerian_Upstream_Petroleum_Royalty_Regulations_2022_d367e902a641eb1f93711ff6.pdf | 2026-09-26 | 40bb5761b0a2278d0ebe8555e0775957989005ce7cf7b18a218f4b58a1814333 |

Secondary sources used only where no primary text was reachable (each row that relies on one says so):
- Finance Act 2023 TET rate: EY tax alert "Nigeria: Highlights of Finance Act 2023" https://www.ey.com/en_gl/technical/tax-alerts/nigeria---highlights-of-finance-act-2023 and Forvis Mazars "Finance Act 2023: key amendments" (read 2026-09-26). The Finance Act 2023 gazette itself was not found online.
- NDDC levy: Niger-Delta Development Commission (Establishment, etc.) Act 2000 s.14(2)(b) as quoted in Mondaq/Lexology "NDDC v Nigerian LNG" and the 2017 amendment commentary (read 2026-09-26); a copy of the 2000 Act exists at https://www.chr.up.ac.za/images/researchunits/bhr/files/extractive_industries_database/nigeria/laws/Niger-Delta%20Development%20Commission.pdf but was not fetched in this pass.
- NTA effective date 1 January 2026: State House statement "New tax laws will commence on January 1, 2026 as planned" https://statehouse.gov.ng/new-tax-laws-will-commence-on-january-1-2026-as-planned/ and Arise TV 27 December 2025 (the National Assembly ordered the Acts re-gazetted with Certified True Copies after allegations that the signed text differs from the passed text). The gazette copy read here prints "[26th June, 2025]" as its commencement note. **The re-gazetted Certified True Copy was not found; every NTA row below is against the June 2025 gazette and must be re-checked against the CTC if one is published.**
- The CITA (Cap. C21) text, including the two-thirds capital allowance restriction, was NOT fetched (the Act is repealed from 1 January 2026 by NTA s.196(c)).

Structural facts from the texts that frame everything below:
- NTA s.197(1) deletes PIA Chapter 4 Parts I-X (ss.258-302, the hydrocarbon tax and CIT application), the Fifth and Sixth Schedules and Seventh Schedule paragraphs 6, 9, 10, 11 and 12. The same provisions are re-enacted in NTA Chapter 3 Part I (ss.65-89), First Schedule Part II, Sixth Schedule and Seventh Schedule Part III. PIA Chapter 3 (host communities, s.240 HCDT) is untouched.
- PIA s.303(1) and NTA s.87(1): the PIA fiscal terms do not apply to OML/OPL holders who have not signed a conversion contract; those stay on petroleum profits tax (NTA Chapter 3 Part II, ss.90-101) and the old royalty table (NTA Seventh Schedule Part IV). The engine's PIA regime models converted and new-acreage terms only.

Status legend: **MATCH** the engine value or formula equals the text. **MISMATCH** it does not. **NOT IN TEXT** the engine carries a value the texts do not contain. **TEXT NOT ACCESSIBLE** the governing primary text was not read. **AMBIGUOUS** the text supports more than one reading and the engine takes one (stated in the row). **NOT COMPUTED** a provision the texts contain and the engine does not compute (section 3 lists the rest).

## 2. Line-by-line audit

### 2.1 Royalty (PIA Seventh Schedule paras 6-11; NTA Seventh Schedule para 6; REGS rr.12-16)

| id | provision | engine value or formula (file:line) | text value (section, paraphrase) | status |
|---|---|---|---|---|
| R01 | Onshore production royalty | 15.0% flat at every rate (cashflow.ts:726) | 15% (PIA 7th Sch para 10(2)(a); NTA 7th Sch 6(2)(b)(i)) | MATCH (base rate); see R06 for the small-field tranche |
| R02 | Shallow water (to 200 m) | 12.5% flat (cashflow.ts:727) | 12.5% up to 200 m (para 10(2)(b); NTA 6(2)(b)(ii)) | MATCH (base rate); see R06 |
| R03 | Deep offshore base rate | 7.5% when field bopd > 50,000 (cashflow.ts:728) | 7.5% beyond 200 m (para 10(2)(c)) | MATCH (base rate); see R05 |
| R04 | Frontier basins | 7.5% flat (cashflow.ts:729) | 7.5%, no sliding scale (para 10(2)(d); REGS r.13(3)) | MATCH |
| R05 | Deep offshore small-field concession | whole year's volume at 5% if bopd <= 50,000, else whole volume at 7.5% (a step) (cashflow.ts:728) | 5% on production up to 50,000 bopd and "the share of the production above 50,000 bopd" at 7.5% (para 10(3); NTA 6(2)(c)); REGS r.13(1)(b): "a weighted average rate of 5% of 50,000bopd plus 7.5% of the incremental daily production above 50,000bopd divided by the total production per day" | **MISMATCH**. Probe: 60,000 bopd gives 0.075000; the Regulations give 0.054167 |
| R06 | Onshore and shallow water small-field tranche | applied ONLY when `pia_terrain === 'marginal_field'` (cashflow.ts:730-735); onshore and shallow water are flat 15% / 12.5% at any rate | "Royalties for onshore fields and shallow water fields, including marginal fields" with production not more than 10,000 bopd: first 5,000 bopd 5%, next 5,000 bopd 7.5%; above 10,000 bopd the share over 10,000 at the terrain rate (para 10(4); NTA 6(2)(d)); REGS r.13(2)(a)-(d) spells out the weighted average for onshore > 10,000 bopd (5/7.5/15) and shallow water > 10,000 bopd (5/7.5/12.5) | **MISMATCH**. Probe: onshore 8,000 bopd gives 0.150000; the Regulations give 0.059375. Shallow water 50,000 bopd (the worked example) gives 0.125000; the Regulations give 0.112500 |
| R07 | "Marginal field" treated as a terrain | `marginal_field` blends 5/7.5 then 15% above 10,000 bopd whatever the water depth (cashflow.ts:734) | the Act has no marginal-field terrain; a marginal field is onshore or shallow water and above 10,000 bopd pays 15% onshore or 12.5% shallow (REGS r.13(2)(c),(d)); producing marginal fields convert to PMLs (PIA s.94(1)) | **MISMATCH** (NOT IN TEXT as a terrain). Probe: 20,000 bopd gives 0.106250; shallow water under the Regulations gives 0.093750 |
| R08 | Rate basis for the tiers | annual oil barrels / 365, crude only (cashflow.ts:829) | monthly: the month's production divided by the days oil was produced, rounded to whole barrels (REGS r.12(2)); crude plus condensate together (REGS r.12(1)(b)) | **MISMATCH** (annual-model approximation; the condensate exclusion is a defect on any liquids-rich field) |
| R09 | Gas and NGL production royalty | 7% onshore, shallow water and marginal; 5% deep offshore and frontier (cashflow.ts:740-743) | 5% of chargeable volume; 2.5% for gas produced and utilised in-country (PIA 7th Sch para 10(6); NTA 6(2)(f)); REGS r.16: 2.5% in-country, 5% export, NGL 5% | **MISMATCH**. The 7% / 5% pair is the royalty for UNCONVERTED leases (NTA 7th Sch Part IV para 7(3)(c): onshore 7%, offshore 5%), not the PIA rate |
| R10 | Condensate is crude for royalty | royalty rate and price royalty charged on oil + condensate revenue (cashflow.ts:838-841) | condensates treated as crude oil, NGLs as natural gas (para 6; PIA s.260(4)) | MATCH |
| R11 | Price royalty shape | 0 at or below the low anchor, linear to 5% at the mid anchor, linear to 10% at the high anchor, 10% above (cashflow.ts:751-759) | below 50 USD 0%, at 100 USD 5%, above 150 USD 10%, linear between (para 11(1); NTA 6(3)(a)) | MATCH |
| R12 | Price royalty anchor escalation | anchors x 1.02^(year - 2021): 50/100/150 in 2021 (cashflow.ts:747-750) | Act: the levels "shall apply to the year 2020, and at the beginning of 2021 and of each succeeding calendar year" rise by 2%, with the example "if in 2020 the price is US $75 per barrel, the royalty by price shall be 2.5%" (para 11(1); NTA 6(3)(a) identical). REGS Schedule: benchmarks escalate "every 1st January, commencing 1st January 2022", table 2021 = 50.00 / 100.00 / 150.00 | **AMBIGUOUS** (the Regulations and the Act disagree by one year). The engine follows the Regulations. On the Act's own example the engine returns 0.026500 (probe), not 0.025 |
| R13 | Benchmark rounding and the Schedule table | compounded, unrounded (2025: 54.1216 / 108.2432 / 162.3648) | REGS Schedule: "rounded to entire US $ cents"; table for 2025: 54.12 / 108.00 / 162.36. The mid column (100, 102, 104, 106, 108, 110) is linear and does not follow its own 2% compounding rule | **MISMATCH** (rounding, small). The published table's mid column is internally inconsistent; lead decision on which to follow |
| R14 | Price royalty by terrain | applies to onshore, shallow, deep offshore; 0 for frontier (cashflow.ts:746) | "for onshore, shallow water and deep offshore"; no royalty by price for frontier acreages (para 11(1),(2)) | MATCH |
| R15 | Price used for the condensate price royalty | the oil price is the fiscal price for oil AND condensate (cashflow.ts:840; FINDINGS-cashflow 2.6) | "based on the fiscal oil price for crude oil or for condensates" (REGS r.15(2)) | **MISMATCH** (minor) |
| R16 | Terrain from water depth | terrain is a string input; `pia_water_depth_m` is carried in config but never read | shallow water up to 200 m, deep offshore beyond 200 m (para 10(2)) | NOT COMPUTED (the string can contradict the depth; the fixture carries 100 m) |
| R17 | Field straddling two terrains | not modelled | weighted average by terrain production (para 10(7); REGS r.14(5),(6)) | NOT COMPUTED |

### 2.2 Hydrocarbon tax (PIA ss.260-268, Fifth and Sixth Schedules; NTA ss.65-76, First Schedule Part II, Sixth Schedule)

| id | provision | engine value or formula (file:line) | text value | status |
|---|---|---|---|---|
| H01 | What HCT charges | liquids revenue (oil + condensate) only; gas excluded (cashflow.ts:866-872) | crude oil, field condensates and liquid NGLs from associated gas; not associated or non-associated gas (PIA s.260(1); NTA s.65(2)) | MATCH |
| H02 | Condensate from non-associated gas | all condensate is in the HCT base | condensates and NGLs from NAG fields or gas plants are OUTSIDE HCT (s.260(1)(b)(ii); NTA 65(2)(b)(ii)) | **MISMATCH** (the engine cannot tell AG from NAG condensate) |
| H03 | Costs of associated gas | shared costs apportioned to HCT by the liquids share of revenue (cashflow.ts:867, 872, 883) | costs of producing associated gas upstream of the measurement point are allocated to crude oil (100%), except wells producing only gas-cap gas, which go to CIT (s.260(2); NTA 65(3)) | **MISMATCH** (revenue-share apportionment is an engine approximation) |
| H04 | Deep offshore under PIA | HCT rate 0 (cashflow.ts:703) | HCT Part "shall not apply ... to deep offshore" (PIA s.260(3)) | MATCH |
| H05 | Frontier | HCT rate 0 under both frameworks (cashflow.ts:699) | not applicable to frontier acreage until reclassified (s.260(3); NTA 65(4)) | MATCH |
| H06 | 30% rate | PML onshore / shallow / marginal_field: 0.30 (cashflow.ts:718-721) | 30% for PMLs selected under s.93(6)(b) and (7)(b) (converted producing areas) onshore and shallow water (s.267(a); NTA 72(a)) | MATCH |
| H07 | 15% rate for PPLs | `licenseType === 'PPL'`: 0.15 (cashflow.ts:717) | 15% for onshore and shallow water and for PPLs selected under s.93(6)(a) and (7)(a) (s.267(b); NTA 72(b)) | MATCH |
| H08 | Producing marginal fields | `pia_marginal_field_pre_2021`: 0.15 (cashflow.ts:716) | a producing marginal field converts to a PML "with terms applicable under sections 267 (b), 302" (s.94(1)) | MATCH |
| H09 | New PMLs from new acreage | every PML that is not flagged marginal: 0.30, whatever `pia_lease_status` (cashflow.ts:718-721) | s.267(b) reads "15% of profit from crude oil for onshore and shallow water and for petroleum prospecting licences"; s.93(6)(a) gives converted PPL areas "fiscal terms as applicable under section 267 (b) ... for new acreage" | **AMBIGUOUS**. Whether a PML later granted out of a new-acreage PPL keeps 15% is not stated. The engine lets the user choose by the licence-type string; the default is 30% |
| H10 | Deep offshore under NTA | three user readings: 0 (default), 30%, custom (cashflow.ts:702-712) | NTA s.65(1) now lists "onshore, shallow water and deep offshore" and drops PIA s.260(3)'s deep-offshore exclusion (s.65(4) excludes only frontier), but s.72 prints rates only for onshore and shallow water | **AMBIGUOUS**. Exposing the readings as a stated user choice is the right design; the engine comment cites law-firm notes (Olaniwun Ajayi, Fortrose), which are secondary |
| H11 | Royalty deduction | liquids production royalty + price royalty deducted; gas royalty not (cashflow.ts:869-871) | "all royalties ... in respect of crude oil and associated gas" (s.263(1)(b); NTA 68(1)(b)) | **MISMATCH** (minor; associated-gas royalty is deductible, NAG royalty is not; same AG/NAG gap as H02) |
| H12 | HCDT deduction | 3% of prior-year opex, deducted at the liquids share (cashflow.ts:846, 872) | deductible for HCT and CIT (s.257(1); s.263(1)(h)) | MATCH (the liquids-share apportionment is an engine choice) |
| H13 | NDDC deduction | NDDC deducted from the CIT base only; NOT from the HCT base (cashflow.ts:872 vs 916; FINDINGS-cashflow 2.2) | s.263(1)(h): "any amount contributed to any fund, scheme or arrangement approved by the Commission pursuant to ... host communities development trusts ..., Environmental Remediation Fund, Niger Delta Development Commission and other similar contributions" is an allowable HCT deduction; s.263(1)(f) also allows levies (NTA 68(1)(f),(h) identical) | **MISMATCH** |
| H14 | HCT not deductible for CIT | CIT base does not deduct HCT (cashflow.ts:916) | s.302(5); NTA 78(3)(a) | MATCH |
| H15 | CIT/TET not deductible for HCT | HCT base deducts neither (cashflow.ts:872) | s.264(l); NTA 69(k) (adds development levy) | MATCH |
| H16 | Loss relief | indefinite carryforward, separate HCT and CIT pools, first available year (cashflow.ts:899-913) | losses deducted from the next period and so on until fully deducted; determined separately per tax class (s.265(1)-(3); NTA 70(1)-(3)) | MATCH. The election to defer a deduction (s.265(4)) is NOT COMPUTED |
| H17 | Capital allowance schedule | PIA: straight line over `pia_capex_recovery_years` (default 5), so 20% x 5 = 100% claimed, no retention; the `nigeria_ppt` 20/20/20/20/19 preset is disabled for PIA (cashflow.ts:1347-1368) | PIA 5th Sch para 17(1): 20/20/20/20/19 for plant, pipeline, building, drilling; para 5(2): 1% of initial cost retained until disposal. NTA 1st Sch Pt II para 14(1): 20% x 5; para 4(2): the 1% is a notional statistical entry that "shall not increase or reduce the amount of capital allowance claimable" | **MISMATCH** under PIA (1% over-claimed; the recovery life is a free input the Act fixes at 5). MATCH under NTA at the default of 5 |
| H18 | Exploration and first two appraisal wells | capitalised with everything else | 100% deductible in the year incurred; later exploration and appraisal in the pre-production period amortised (s.263(1)(d); 5th Sch 17(2); NTA 68(1)(d), 1st Sch Pt II 14(2)) | NOT COMPUTED |
| H19 | Acquisition cost of petroleum rights | none | 20% annual allowance, 1% retention under PIA (s.266(1)(c), s.302(9)); 20% until written off under NTA (s.71(1)(c), s.81(1)) | NOT COMPUTED |
| H20 | Production allowance, converted leases | min(`per_bbl_converted`, `pct_of_price` x price) on all liquids, no cap (cashflow.ts:776-785); fixture 2.5 USD and 20% | lower of US$2.50/bbl and 20% of the fiscal oil price for converted OMLs and their renewals (6th Sch para 1(1); NTA 6th Sch 1(1)) | MATCH (values are config inputs; the fixture carries the Act's values) |
| H21 | Production allowance, new leases, below the cap | min(`per_bbl_new`, 20% x price); cumulative caps 50 / 100 / 500 MMbbl onshore / shallow / deep and frontier (cashflow.ts:787-810) | lower of US$8.00 and 20% of fiscal oil price up to 50 / 100 / 500 million bbl from commencement of production, per field (6th Sch para 1(2)(a)-(c)) | MATCH |
| H22 | Production allowance, new leases, above the cap | 0 once the cap is reached (cashflow.ts:804-816) | "the lower of US $4.00 per barrel and 20% of the fiscal oil price thereafter" (6th Sch 1(2)(a)-(c); NTA 6th Sch 1(2)(a),(b)) | **MISMATCH**. Probe: 1 MMbbl at 80 USD after the onshore cap gives 0; the text gives 4,000,000 USD |
| H23 | Marginal field volume cap | `marginal_field` uses the shallow-water 100 MMbbl cap (cashflow.ts:794-796) | no marginal-field category in the Sixth Schedule; the terrain decides | NOT IN TEXT |
| H24 | Deep offshore / frontier allowance under NTA | 500 MMbbl cap kept under both frameworks | NTA 6th Sch para 1(2) lists only (a) onshore and (b) shallow water; the PIA's para 1(2)(c) for deep offshore and frontier is not re-enacted | **MISMATCH** (NTA only; bites only when a deep offshore HCT reading other than zero is chosen) |
| H25 | Allowance on condensate | applied to oil + condensate barrels (cashflow.ts:876) | allowances for crude oil also apply to condensates and liquid NGLs (6th Sch 1(4)) | MATCH (subject to H02) |
| H26 | Fiscal oil price | the realised oil price is used as the fiscal price everywhere | the Commission sets a fiscal oil price per field on an export-parity basis (7th Sch para 8) and HCT is topped up to the fiscal price value where sales fall below it (s.268; NTA s.73) | NOT COMPUTED |

### 2.3 Cost price ratio (PIA 6th Sch para 2; NTA 6th Sch para 2; PIA s.266(2))

| id | provision | engine value or formula (file:line) | text value | status |
|---|---|---|---|---|
| C01 | CPR limit | `pia_cpr_limit_pct` of gross revenue (cashflow.ts:850); fixture 65 | 65% of gross revenues determined at the measurement points (6th Sch 2(1)) | MATCH (config input; the fixture carries the Act's value) |
| C02 | Costs inside the CPR | opex + the year's capital allowance + carried pool; royalties, HCDT and NDDC outside (cashflow.ts:851) | all s.263 costs and Fifth Schedule allowances EXCEPT s.263(1)(a) rents, (b) royalties and (h) HCDT / NDDC / remediation contributions (6th Sch 2(1)) | MATCH for opex, allowances, royalties and levies. **MISMATCH** for decommissioning-fund contributions: s.263(1)(e) is inside the CPR, the engine relieves them outside it (cashflow.ts:1453-1471) |
| C03 | CPR revenue base | gross revenue INCLUDING gas (cashflow.ts:850) | "gross revenues determined at the measurement points" for costs "eligible for deduction under the hydrocarbon tax", a crude-oil tax | **AMBIGUOUS**. The natural reading is crude and condensate revenue; the engine's base inflates the cap on a gas-bearing field |
| C04 | Carryforward | deferred cost queues and is claimed under the next year's cap (cashflow.ts:851-855) | excess allowed in later years within the 65% limit, never more than actual cost (2(2)(a),(b)) | MATCH |
| C05 | Forfeiture at cessation | final-year unrecovered pool reported (cashflow.ts:1680-1681) | cost still above the limit when crude operations end is not deductible (2(2)(c)) | MATCH |
| C06 | Which tax the CPR limits | CPR-limited opex AND the CPR-limited capital allowance also feed the CIT base (cashflow.ts:916, 923) | the CPR applies to costs "eligible for deduction under the hydrocarbon tax" (6th Sch 2(1)); s.266(2) sits in the HCT Part; nothing in s.302 / NTA ss.78-82 applies it to CIT | **MISMATCH** |

### 2.4 Companies income tax, TET, Development Levy, minimum ETR

| id | provision | engine value or formula (file:line) | text value | status |
|---|---|---|---|---|
| T01 | CIT rate | `pia_cit_rate_pct` (cashflow.ts:943); fixture 30 | NTA s.56(b): 30% for any company other than a small company. CITA s.40 (PIA era) not read | MATCH (NTA); TEXT NOT ACCESSIBLE (CITA) |
| T02 | CIT deductions | royalties, opex, HCDT, NDDC (cashflow.ts:916) | rents and royalties on oil, condensate and gas; contributions for decommissioning, HCDT, environmental remediation (s.302(11); NTA 82(1)) | MATCH (general deductibility of NDDC rests on CITA / NTA s.20, not re-checked) |
| T03 | Two-thirds capital allowance restriction on CIT | cap at 2/3 of CIT assessable profit, carried forward, default ON in both frameworks (cashflow.ts:917-928) | not in the PIA: s.302(10)(a) sends upstream capital allowances to the Fifth Schedule, which has no restriction. Not in the NTA First Schedule Parts I or II (searched: no "two-thirds" or equivalent). The CITA rule it models was not read | **MISMATCH** under NTA (no restriction exists); TEXT NOT ACCESSIBLE under PIA (CITA). The cashflow course lesson says the carry "is what the Act does" |
| T04 | Tertiary education tax | `pia_tet_rate_pct` on CIT assessable profit (cashflow.ts:950); header, EPE.md and the fixture say 2.5% | TETFund Act as amended: 2.5% (Finance Act 2021), 3% for accounting periods ending on or after 1 July / 1 September 2023 (Finance Act 2023, secondary sources). The worked example is a 2025 year at 2.5% | **MISMATCH** (secondary source; the Finance Act 2023 text itself is TEXT NOT ACCESSIBLE). The rate is an input; the documented default and the frozen fixture are the defect |
| T05 | Development levy | 4% (default of `pia_development_levy_rate_pct`) on CIT assessable profit, NTA framework only (cashflow.ts:953-954) | 4% on the assessable profits of all companies chargeable under Chapters Two and Three, except small and non-resident companies; not on HCT assessable profits (NTA s.59(1),(4)) | MATCH |
| T06 | TET replaced by the levy | either-or by framework (cashflow.ts:947-955) | NTA s.197(5) deletes TETFund Act ss.1, 2 and 3(3) | MATCH |
| T07 | Framework switch date | ONE framework per run from `base_year` (>= 2026 is NTA; missing base year defaults to 2027) (cashflow.ts:353-360, 1177); a 2025-based ledger stays on PIA terms in 2026 and every later row | NTA takes effect 1 January 2026 (government statement; the gazette's own note reads 26 June 2025); from then the NTA terms (levy, deleted deep-offshore allowance, s.86 condition) apply to every year of assessment | **MISMATCH** (the framework should be read per row from the row's year). The live cashflow lesson "The date trigger" teaches the per-run behaviour |
| T08 | Minimum effective tax rate | if `pia_apply_minimum_etr`: top-up = max(0, 15% x CIT assessable profit - (HCT + CIT + TET + levy)), per project year (cashflow.ts:1478-1488) | a company whose ETR is below 15% pays the difference; applies only to MNE-group constituents and companies with turnover of N20,000,000,000 or more; ETR = "aggregate covered tax paid" / net profit before tax per the audited financial statements less 5% of depreciation and personnel cost (NTA s.57(1),(2),(4)). "Covered tax" is not defined in the gazette text read (s.57 also jumps from (2) to (4)) | **MISMATCH** (a stated project-level approximation: wrong denominator, no scope test, company-level test run per project). The denominator's "covered tax" is NOT IN TEXT |

### 2.5 Levies, decommissioning, working interest

| id | provision | engine value or formula (file:line) | text value | status |
|---|---|---|---|---|
| L01 | HCDT | 3% of the previous modelled year's opex, seeded by `pia_prior_year_opex_usd` (cashflow.ts:846, 1380) | "3% of its actual annual operating expenditure of the preceding financial year in the upstream petroleum operations affecting the host communities" (PIA s.240(2)) | MATCH |
| L02 | NDDC levy | fixed sum, or 3% (default of `pia_nddc_levy_pct_of_opex`) of the CURRENT year's opex (cashflow.ts:1429-1431) | 3% of the "total annual budget" of an oil producing company in the Niger Delta (NDDC Act 2000 s.14(2)(b), as amended 2017; secondary sources) | **MISMATCH** (base: a total budget includes capex). Secondary source only |
| D01 | Decommissioning fund, PIA | sinking-fund contributions deductible for HCT (liquids share) and CIT (cashflow.ts:1453-1471) | deductible for HCT (s.263(1)(e)) and CIT (s.302(11)(b)(i)); surplus returned to the lessee is taxed at end of life | MATCH (surplus taxation NOT COMPUTED; CPR scope is C02) |
| D02 | Decommissioning fund, NTA | same unconditional relief under NTA | "Notwithstanding section 233(1) of the Petroleum Industry Act, a provision made for decommissioning and abandonment fund shall not be deductible for tax purposes, except" at least 30% is deposited in escrow with a CBN-accredited Nigerian bank (NTA s.86) | **MISMATCH** (the condition is not an input) |
| W01 | Working interest | fiscal math at 100% field level, every money line and volume scaled to the share (cashflow.ts:1219-1220, 1612-1630) | JV apportionment by equity interest (s.273(4); NTA 77(4)); royalty tiers and allowance caps are field-level (7th Sch 10(1),(5); 6th Sch 1(2) "per field") | MATCH. Company-level consolidation across fields and terrains (s.272; NTA s.76) is NOT COMPUTED |

### 2.6 The regime sandbox and its "Nigeria - PIA (2021)" template

| id | provision | engine value (file:line) | text value | status |
|---|---|---|---|---|
| S01 | Template royalty | sliding by price: 7.5% from 0 USD, 10% from 50 USD (fiscalTemplates.js:136) | PIA royalty is production royalty by terrain and volume plus a separate 0-10% price royalty interpolated from escalated anchors (7th Sch 10, 11) | **MISMATCH** (NOT IN TEXT as a schedule) |
| S02 | Template cost recovery limit | 80% (fiscalTemplates.js:138) | PSC cost limit 70% of total oil production for new acreage, 60% for a PSC under a conversion contract (7th Sch para 14(4),(9)) | **MISMATCH** |
| S03 | Template profit split | R-factor tiers 60 / 40 / 30 at R 1.0 / 1.6 / 2.5 (fiscalTemplates.js:139) | minimum government profit oil by cumulative production per field: 5% to 50 MMbbl, 10% to 100, 15% to 350, 25% to 750, 35% to 1,500, 45% above (7th Sch 14(4); the gazette prints "(d) over 250 million barrels" where 350 is meant) | **MISMATCH** |
| S04 | Template tax | CIT 30, RRT 0, minTax 0 (fiscalTemplates.js:137) | a deepwater PSC under PIA pays CIT 30% and, per s.260(3), no HCT | MATCH (as far as it goes) |
| S05 | fiscalConventions.js | wording only (government take definitions, money format) | no statutory content | not applicable |

The `fiscal` course already tells learners that "a template named for a jurisdiction is a caricature in six numbers" and that the EPE engine is the single source of Nigerian fiscal truth. The template is harmless in that course, but the PIA course must not use it as PIA terms.

## 3. PIA / NTA fiscal provisions the engine does not compute

Rents and fees (7th Sch paras 1-5; Fees and Rents Regulations 2025); signature, renewal and production bonuses (s.258(2), non-deductible s.264(f)); royalty in kind vs cash and the 2.5% in-country gas rate (7th Sch 9; REGS r.16); weighted royalty for straddling fields (R17); terrain from water depth (R16); the fiscal oil and gas price and the additional tax at fiscal price (s.268, s.302(17); NTA ss.73, 84); associated vs non-associated gas split for HCT scope, cost allocation and royalty deduction (H02, H03, H11); exploration and first-two-appraisal-well expensing (H18); acquisition cost allowance (H19); balancing allowances and charges (5th Sch 7-8); pre-production cost amortisation (s.270; NTA s.74); the loss-deferral election (s.265(4)); consolidation across terrains and fields for HCT and CIT, and the contractor loss consolidation (s.272; NTA s.76); PSCs under the PIA (cost limit 70% / 60%, government minimum profit oil scale, HCT on the contractor's adjusted profit after profit oil, 7th Sch para 14); unconverted OMLs on petroleum profits tax and the old royalty table (NTA Part II ss.90-101; 7th Sch Part IV); deep offshore and inland basin PSCs under NTA Part III (ss.102-117); the NTA non-associated gas greenfield tax credit and gas production allowance (NTA s.85: 1.00 USD/Mscf or 30% of fiscal gas price, 10 years, three-year carry); gas pipeline and gas utilisation incentives (s.302(6); NTA s.80); integrated strategic projects (s.302(4); NTA s.79); decommissioning fund surplus taxation (s.263(1)(e)) and the NTA escrow condition (D02); frontier renewal on onshore terms (7th Sch 14(3)); conversion mechanics and relinquishment (ss.92-94); fiscal stabilisation (s.305; NTA s.88); interest and penalties on late tax or royalty (s.302(16); 7th Sch 12); the minimum ETR scope test and statutory denominator (T08); ring-fencing by stream company (s.302(3); NTA s.79(1)).

## 4. The existing validation

**pia-worked-example.json.** The fixture's own description says its expected line items "were derived from the byte-validated engine run", with inputs copied from a shared-database validation case (`epe_run_configs.id 53828290-...`, snapshot 2026-08-14). EPE.md section 3.1 and section 5 call it "byte-for-byte against the published PIA 2021 worked example (17 line items; max deviation $3,162 from price-royalty rate rounding)". No citation of that published example exists anywhere in either repository: not in EPE.md (first version 2026-06-07, commit d00f14a59), not in the Suite validation harness (commit f9a5de66c), not in the fixture, not in FINDINGS-cashflow.md. Its title, author, date and URL are unknown.

What the fixture itself shows:
- It is **not independent of the engine**: the expected values are engine output, and the regression contract (EPE.md sections 6.7 and 7) freezes the engine to itself at 0.01 USD.
- Its production royalty (182,500,000 = 12.5% of 1,460,000,000 at 50,000 bopd shallow water) does not follow Petroleum Royalty Regulations 2022 r.13(2)(d), which give 11.25% at that rate (164,250,000). Whatever document it matched either predates the Regulations (gazetted 22 November 2022) or applied the terrain rate flat.
- Its price royalty (34,905,145.76 at 80 USD in 2025) uses the Regulations' 2021 base year (R12). The recorded "$3,162 from price-royalty rate rounding" is consistent with a source that rounded the low anchor to 54.12 as the Regulations' Schedule does while compounding the mid anchor to 108.24; the Schedule's own mid anchor for 2025 is 108.00, which would move the royalty by about 158,000 USD.
- It deducts NDDC from the CIT base and not from the HCT base (H13), and uses TET at 2.5% in 2025 (T04).
- Its single year cannot exercise loss relief, CPR carryforward, the allowance cap, the NTA switch, the deep offshore tier, gas, or any tranche.

**oracle_cashflow.py** (tools/validation/economics) is stdlib and independent of the JS in code, but its rates and schedules are restated from the same engine documentation ("Seventh Schedule royalties, Sixth Schedule production allowance" per its header), so every R and H mismatch above is shared by the oracle. It proves the engine computes what the engine documentation says; it does not prove the documentation matches the Act.

**NTA validation** is synthetic, as EPE.md section 4.4 and section 5 say: the harness proves `force_nta` differs from `force_pia` only by TET to the levy on the same base. No regulator-published NTA-era example was found in this pass either.

**Conclusion.** The only external references the graded PIA content can rest on are the Act's own example (price royalty 2.5% at 75 USD in 2020, which the engine fails by one year because it follows the Regulations) and the Regulations' own examples (the benchmark table; the weighted-average formulas of r.13). A new independent golden set for the PIA course has to be built from the gazetted texts by a stdlib oracle written from the sections cited above, not from the engine's documentation.

## 5. Summary counts

66 audited rows (S05 is wording only and not counted).

| status | count | rows |
|---|---|---|
| MATCH | 31 | R01-R04, R10, R11, R14; H01, H04-H08, H12, H14-H16, H20, H21, H25; C01, C04, C05; T01, T02, T05, T06; L01, D01, W01; S04 |
| MISMATCH | 25 | R05-R09, R13, R15; H02, H03, H11, H13, H17, H22, H24; C02, C06; T03, T04, T07, T08; L02, D02; S01-S03 |
| AMBIGUOUS | 4 | R12, H09, H10, C03 |
| NOT IN TEXT | 1 | H23 (also the marginal-field terrain inside R07 and "covered tax" inside T08) |
| NOT COMPUTED (tabled) | 5 | R16, R17, H18, H19, H26 (section 3 lists the rest) |
| TEXT NOT ACCESSIBLE | 4 as a second status | T01 and T03 (CITA), T04 (Finance Act 2023), L02 (NDDC Act); each is judged on a secondary source or on the NTA |

Counting rule: one count per row. A row with any mismatch counts as MISMATCH (C02, H17, T03). R01-R03 count as MATCH for the base rate; their tranche defects are counted in R05 and R06. Of the 25 mismatches, 18 sit in `cashflow.ts` (the PIA/NTA cascade), 3 in `fiscalTemplates.js` (S01-S03), and 4 are documentation or default defects where the engine takes the value as an input (T04, L02's base, R13's rounding, T08's stated approximation). The table in section 2 is the record; the count is a reading aid.

## 6. Probe output (engine called, 2026-09-26, engines f50251d)

```
derivePriceRoyaltyRate(75, 2020, onshore)        = 0.026500   Act example says 0.025
derivePriceRoyaltyRate(80, 2025, shallow_water)  = 0.023908   Act base year 2020 would give 0.022458
deriveOilRoyaltyRate(deep_offshore, 60000)        = 0.075000   REGS r.13(1)(b): 0.054167
deriveOilRoyaltyRate(onshore, 8000)               = 0.150000   REGS r.13(2)(b): 0.059375
deriveOilRoyaltyRate(shallow_water, 8000)         = 0.125000   REGS r.13(2)(b): 0.059375
deriveOilRoyaltyRate(marginal_field, 20000)       = 0.106250   shallow water under REGS r.13(2)(d): 0.093750
deriveGasRoyaltyRate(onshore | shallow | deep)    = 0.07 | 0.07 | 0.05   text: 0.05 (0.025 in-country)
computeProductionAllowance(new onshore, 1 MMbbl, 80 USD, prior 60 MMbbl) = 0   text: 4,000,000
computeProductionAllowance(new deep_offshore, 1 MMbbl, 80 USD, prior 0)  = 8,000,000 (NTA deleted this allowance)
deriveHctRate: onshore PPL 0.15; shallow PML 0.30; deep PIA 0; deep NTA default 0; marginal flag 0.15
worked example rerun (cit_restricted_allowance_carryforward false): NPV 135,185,570.34, every frozen line reproduced
same case forced to NTA: TET 0, levy 41,599,794.17 on CIT assessable 1,039,994,854.24
```

## 7. Recommended repairs (engine PR, oracle + goldens + negative control, before any graded PIA content)

Each repair is behind a switch that reproduces the frozen worked example, the way `cit_restricted_allowance_carryforward` does, unless the lead decides otherwise (decision D1 below).

1. **Royalty tranches** (R05, R06, R07, R08): deep offshore weighted 5% / 7.5% around 50,000 bopd; onshore and shallow water weighted 5% / 7.5% / terrain rate for every field; marginal fields become a flag on onshore or shallow water, not a terrain; the daily rate counts crude plus condensate. Evidence: PIA 7th Sch 10(3),(4); REGS r.12(1)(b), r.13(1),(2). Goldens: the Regulations' own formulas at 3,000 / 8,000 / 10,000 / 50,000 / 60,000 bopd.
2. **Gas royalty** (R09): 5% of gas and NGL value, 2.5% for the stated in-country share (a new input, default 0 in-country). Evidence: 7th Sch 10(6); REGS r.16.
3. **Production allowance after the cap** (H22): 4 USD tier; and under NTA no deep offshore or frontier allowance (H24). Evidence: 6th Sch 1(2); NTA 6th Sch 1(2).
4. **CPR scope** (C06, C02): the CPR limits the HCT base only; CIT deducts full opex and its own capital allowance; decommissioning contributions sit inside the CPR. Evidence: 6th Sch 2(1); s.266(2); s.302.
5. **NDDC in the HCT base** (H13). Evidence: s.263(1)(f),(h); NTA 68(1)(f),(h).
6. **Framework per row** (T07): NTA terms from the 2026 row onward in auto mode. Evidence: NTA commencement (government statement), NTA s.197.
7. **Two-thirds restriction off under NTA** (T03), and a lead decision for PIA-era years.
8. **PIA capital allowances 20/20/20/20/19 with 1% retention** (H17) under the PIA framework; NTA keeps 20% x 5.
9. **TET default and documentation** (T04): 3% for accounting periods from 2023 (or state 2.5% as a user input with its date); fix the header, EPE.md and the course wording.
10. **NTA decommissioning escrow condition** (D02) as a stated input; default "condition met" would keep today's numbers.
11. **Price royalty benchmarks** (R12, R13): keep the Regulations' 2021 base year, add cent rounding, and state the Act/Regulation conflict as engine message text.
12. **Template rename** (S01-S03): rename "Nigeria - PIA (2021)" to a label that does not claim to be the Act, or re-base it on the Seventh Schedule para 14 PSC terms; affects the live `fiscal` course graded fields, so only with a fiscal re-cut.

Out of engine scope for the course capstone (teach as concept): AG / NAG distinctions (H02, H03, H11), fiscal price top-up (H26), exploration expensing (H18), acquisition allowance (H19), NAG greenfield credit (NTA s.85), PSC under PIA para 14, unconverted-lease PPT, consolidation, stabilisation, minimum ETR statutory test (T08 stays a labelled approximation).

## 8. Decisions needed from the lead

- **D1 Regression contract.** Repairs 1, 2, 4, 5 and 9 change the frozen worked example (production royalty alone falls from 182,500,000 to 164,250,000). EPE.md section 7 makes NPV 135,185,570.34 an invariant. Options: (a) legacy switch per repair, default OFF (worked example and every live graded field unchanged, the PIA course runs with the switches ON); (b) default ON and re-freeze the fixture with a new, text-derived oracle, which re-cuts the live `cashflow` Expert tier and the Suite EPE app. Recommendation: (a) now, (b) as an owner decision.
- **D2 The live cashflow course.** `cashflow` Expert m02 l01 "Terrain sets the rate" teaches the deep offshore step as correct and names the Regulations' weighted average "the mistake"; m03 l01 and l05 teach that NDDC is not an HCT deduction; m04 l01 and l02 teach TET at 2.5% under "the 2021 Act" and one framework per ledger; m03 l05 says the two-thirds carry "is what the Act does". These describe the engine truthfully but present engine behaviour as law. Either re-word them as engine behaviour (no graded field changes) or re-cut them after the repairs. The PIA course cannot reuse them by reference while they contradict it.
- **D3 NTA text version.** Is the June 2025 gazette the version to teach, pending a re-gazetted Certified True Copy? The course must print version and date either way.
- **D4 Price royalty base year.** Follow the Regulations (2021 base, current engine) and teach the Act's 2020 example as the conflict it is, or follow the Act.
- **D5 HCT rate for new PMLs from new-acreage PPLs** (H09) and **deep offshore HCT under NTA** (H10): keep both as stated user choices, taught as open questions, never graded on a single reading.
- **D6 CPR revenue base** (C03): crude and condensate revenue (recommended) or all gross revenue.
- **D7 TET 3%** (T04): accept the secondary sources, or require the Finance Act 2023 gazette before changing any default.
- **D8 PIA-era two-thirds restriction** (T03): needs the CITA text (repealed) or an owner ruling.
