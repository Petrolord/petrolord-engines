# FINDINGS: prms (oracle_prms.py, Economics EC11, reserves and resources under SPE-PRMS 2018)

Engine: `engines/economics/prms.js`. Golden: `test-data/economics/goldens/prms_cases.json`, 140 cases (81 refusals, every message pinned), written by `tools/validation/economics/oracle_prms.py`. Gate: `__tests__/economics.prms.test.js` (172 tests) calls the engine on every golden, checks the published figures (AG 2011 Table 6.2; PRMS FAQ 3.3; the NUPRC 1 January 2026 gas total; SEC Regulation S-K Item 1202(a)(3)), the fixture wiring and planted situations, proves the canonical engines are called (source imports; the economic limit year, undiscounted net cash flow and NPV equal computeCashFlow's on the same stated case), runs property and boundary tests and pins the course strings. Negative control: `negcontrol_prms.sh`, 35/35 engine plants red, 6/6 oracle plants caught, 0 skipped (run on head d0957e1). Timing: `timing_prms.js`. Fixtures: `test-data/economics/ekene-prms/` (make_prms_fixtures.py). Full engines suite after `npm ci`: 233 suites, 18,341 tests passed (1 skipped, 1 todo, outside this wave).

The oracle is stdlib only (fractions, decimal, statistics, math), reads no JavaScript and imports nothing from the engines (formatting and refusal helpers from the EC9 oracle; mulberry32 and the simple-statistics quantile from the screening oracle, both bit-for-bit ports). It takes a different road: the PRMS 2.1 decision list written out as data; categories and reconciliations on exact Fractions; the economic limit as an annual ledger on Fractions per case (revenue, royalty, opex, capex, straight-line allowances, the loss pool, tax, ADR at the last kept year, NPV as an exact Fraction sum), with the trailing-year trim coded from the rule and the PRMS 3.1.3.1 peak read off the untrimmed ledger; the Monte Carlo replayed from the stated sampler recipe (mulberry32, Box-Muller, Cholesky, Gaussian copula, A&S erf, triangular inverse CDF, the triangular fit by bisection on the mode position, the simple-statistics quantile, the Kahan mean), with the exact mean (every aggregate) and the exact quantiles of a normal total (statistics.NormalDist) as a second witness held within 5 standard errors.

No new Monte Carlo, NPV or economic-limit arithmetic: computeCashFlow and applyJV (cashflow.ts); mulberry32, createCorrelatedSampler, cholesky, fitTriangularToPercentiles, triInvCDF, normalCDF, quantile, mean (lib/stats, the vendored lineage of ReservoirCalc Pro's MonteCarloEngine through the Suite's src/lib/monteCarlo.js); OUTCOME_LABELS, EXCEEDANCE_DEFINITION, outcomeOrderViolation (lib/conventions/percentile.js). engines/dca (arps, typeCurve, groupRollup, monteCarlo) and engines/mbal are not called: the engine takes stated technical forecasts and distributions, which a course or app may build with them. The Suite's src/utils/riskedReservesCalculations.js (inline NPV, Math.random) was neither used nor copied. The gate refuses Math.random, Math.pow, ** and randomNormal in the engine source.

Print rule: money in reasons rounded to the cent, a computed quantity or percentage to 6 decimal places, both half away from zero with trailing zeros dropped; stated inputs print as given; fields keep full precision. The oracle stops within 1e-6 of a rounding tie.

## Sources (all read 2026-09-27)

Copies kept outside the repo with the course wave kit. The PRMS Application Guidelines 2022 (OnePetro, paid) were not used.

| # | text | edition / date | URL | licence | sha256 (16) | used for |
|---|---|---|---|---|---|---|
| 1 | SPE-PRMS 2018 (SPE, WPC, AAPG, SPEE, SEG, SPWLA, EAGE) | June 2018; SPE distributes v1.03 by an email form | https://www.spe.org/industry/petroleum-resources-management-system-2018/ | CC BY-NC-ND 4.0 (stated on the SPE download page; commercial or derivative use via permissions@spe.org) | page c6493ee7b7a7e163 | taught by concept with section citations; never quoted |
| 1a | English text read from the SPE-hosted English-Chinese edition (Version 2023 V1.0, "Developed from PRMS 2018 V1.0", ISBN 978-1-61399-985-1) | Feb 2024 upload | https://www.spe.org/media/filer_public/b9/a1/b9a14c08-4116-49c9-aaf5-a2c47720f391/prms_2018_english-chinese_feb_2024.pdf | as 1 | da67c0e0e0710d23 | 1.1, 2.1.1 to 2.1.3.7, Tables 1 and 2, 2.2.0 to 2.2.2.11, 3.1.1 to 3.1.3.5, 3.2.9, 3.3.0 to 3.3.2, 4.2.5, 4.2.6 |
| 1b | PRMS errata 2019 to 2022 (v1.01 to v1.03), consolidated | May 2022 | https://www.spe.org/media/filer_public/e1/28/e1289d0e-2f5e-413d-8d8f-e79c30b13b6b/errata_2019_-_202011_consolidated_202205_final.pdf | as 1 | 185da097d801c033 | checked: no change to the sections used; glossary "economic" now reads a zero discount rate |
| 1c | PRMS 2018 key changes | 2018 | https://www.spe.org/media/filer_public/63/13/6313c8f3-d065-4b07-9f57-7f2507430780/prms2018keychanges.pdf | SPE | 6f652658c4a6dfc8 | context |
| 2 | SPE OGRC, PRMS FAQs | November 2022 (answers dated Oct 2022) | https://www.spe.org/en/industry/reserves/prms-faqs/ | (c) SPE, all rights reserved | 71aa4d77e0e37d70 | 3.3, 3.4 (1P = 0, 2P kept; example low 5, best 7), 4.3, 4.4, 6.9, 6.10; numbers as a cited check, prose not quoted |
| 3 | Guidelines for Application of the PRMS | November 2011 (superseded by the paid 2022 AG) | https://www.spe.org/industry/docs/PRMS_Guidelines_Nov2011.pdf | no licence printed; treated as copyright, numbers cited, prose not quoted | 3faa7e8d919ef3ba | 6.3 Table 6.2 (A and B: expectation 53.4 and 35.6, Proved 43.3 and 28.5 x10^9 m3; arithmetic 71.8, Fig. 6.5 prints 72; independent probabilistic Proved 77; error propagation for symmetric distributions), 6.3.4 (correlation matrices, concept), 6.4 (risked volumes) |
| 4 | 17 CFR 229.1202 (S-K Item 1202) and 229.1203 | eCFR current at 2026-09-01 | https://www.ecfr.gov/api/versioner/v1/full/2026-09-01/title-17.xml?part=229&section=229.1202 | US federal text, public domain | ce10d8b9ae96b1ee | 1202(a)(3) arithmetic sums; no probabilistic aggregation beyond field or property level; 1203(b) PUD changes (concept) |
| 5 | 17 CFR 210.4-10 (S-X Rule 4-10) | eCFR current at 2026-09-01 | https://www.ecfr.gov/api/versioner/v1/full/2026-09-01/title-17.xml?part=210&section=210.4-10 | public domain | a87e712adbdb71fb | (a)(22), (a)(24) (90% when probabilistic), (a)(22)(v) 12-month first-day-of-month price (concept) |
| 6 | Petroleum Industry Act 2021 (Act No. 6) | Gazette No. 142 Vol. 108, 27 Aug 2021 | https://ngfcp.nuprc.gov.ng/wp-content/uploads/2022/09/Petroleum-Industry-Act-2021-pdf-searchable.pdf | Nigerian federal law | 5d158ca8a16f00b2 | s.7(i), s.78(8), (9) at most 10 years, (13), (15), s.79(1) FDP within 2 years, s.318 definitions |
| 7 | Significant Crude Oil and Gas Discovery Regulations, 2023 | S.I. No. 37 of 2023, Gazette No. 111 Vol. 110, 20 June 2023 (made 24 May 2023) | https://www.nuprc.gov.ng/upload/nuprc_laws/Nigerian_Upstream_Significant_Crude_Oil_and_Gas_Recovery_Regulations_2023_d00669111fcd0e4ce060e86b.pdf | Nigerian subsidiary legislation | 72f0b83400813bc5 | regs 3, 4; reg. 6(3) retention approved for at least 5 years onshore and shallow water, 8 deep water; reg. 7(2), (3) |
| 8 | Acreage Management and Petroleum (Drilling and Production) Regulation, 2024 | posted copy prints placeholders (S.I. No. 00, Gazette No. 00), "made ... March 2024" | https://www.nuprc.gov.ng/upload/nuprc_laws/Acreage_Management_and_Petroleum_Drilling_Regulation_2024_0f9b5bfd8c31b64eb380c32a.pdf | as 7 | 9da025bbbd4a1a15 | reg. 78(1) "reserves" defined; reg. 31(4)(a) (concept only; gazette details unconfirmed) |
| 9 | Nigerian Upstream Petroleum (Commercial) Regulations, 2025 | S.I. No. 7 of 2025, Gazette No. 84 Vol. 112, 5 May 2025 | https://www.nuprc.gov.ng/upload/nuprc_laws/Nigerian_Upstream_Petroleum_Commerciala_Regulations_2025_9da8195c295fc31059c7b907.pdf | as 7 | 3bdd50309a308f24 | reg. 6 status report includes a statement of reserves situation (concept) |
| 10 | Fees and Rents Regulations, 2025 | 2025 (six months, extended 2026) | https://www.nuprc.gov.ng/upload/nuprc_laws/Nigerian_Upstream_Petroleum_Fees_and_Rents_Regulations_2025_50495dd4cd65fd5cc125bf78.pdf | as 7 | 5a708a30fc4a042f | Schedule item 84 reserve-booking review fee (context; not in the engine) |
| 11 | NUPRC media release, reserves as at 1 January 2026 | 1 April 2026 | https://www.nuprc.gov.ng/media/news/5fa3f1a3c8223aa7c4dc4a39 | government release | 95402c8204fffcaf | 2P AG 100.21 + NAG 114.98 = 215.19 Tcf (golden); oil and condensate 37.01 billion bbl (crude component renders truncated, not used); life indices 59 and 85 years (concept) |

Not found: a gazetted NUPRC reserves reporting regulation or booking guideline (none on the gazetted list read 2026-09-27); the NUPRC 2024 annual report PDFs returned 404; the errata v1.01 link (p.widencdn.net) serves a viewer page (the consolidated errata 1b covers v1.01 to v1.03).

## Published examples (goldens)

- AG 2011 Table 6.2 (agg-ag2011-table62-independent): blocks as normal distributions with the printed expectation and mean less Proved as the 90% half-width (the AG's symmetric error-propagation reading; a lognormal through the same figures gives 76.4). Engine: arithmetic 1P 71.8 (72 on Fig. 6.5); statistical P90 rounds to 77, within 0.05 of 89 - sqrt(10.1^2 + 7.1^2) = 76.654 (200,000 draws, seed 2011). At rho 0.999 it returns to 71.8 within 0.3.
- PRMS FAQ 3.3 (econ-faq33-low-fails, cat-faq33-incremental): low 5, best 7; low fails: 1P = 0, 2P = 7, P2 = 7.
- NUPRC 2026 (agg-nuprc-2026-gas-2p): 215.19 Tcf arithmetic, reportable above field level.
- SEC S-K 1202(a)(3) and PRMS 4.2.5.4: `reportable` = "arithmetic" above the field level.

## Figures in the engine

Five-year benchmark (PRMS 2.1.2.3, 2.1.3.6.4); retention at most 10 years (PIA s.78(9)); retention approval at least 5 years onshore/shallow, 8 deep water (S.I. 37 of 2023 reg. 6(3)); FDP within 2 years (PIA s.79(1)); standard normal 90th percentile 1.2815515655446004 (mpmath sqrt(2) erfinv(0.8) = 1.281551565544600467). Every classification fact, chance, correlation, seed, iteration count, price, cost, royalty, tax rate, allowance life, loss-relief choice, licence expiry, renewal expectation, reporting basis, discount rate and BOE factor is a required stated input.

## Decisions and readings

1. Class: undiscovered with a project: Prospective; no project: Discovered/Undiscovered Unrecoverable (2.1.1.2); discovered with a project: Reserves only when all seven criteria of 2.1.2.1 and the commitment are met with established technology, else Contingent with the blockers named. Criterion (4) read from the stated economic status.
2. Time-frame: met at 5 years or less, or when longer is stated as justified; 5 exactly is met.
3. Reserves sub-class derived from FID and production status and must match the stated one; Contingent and Prospective sub-classes stated, membership checked (2.1.3.5.6). Developed producing requires on production (Table 2).
4. Pc: Contingent Pd; Prospective Pg x Pd (2.1.3.3); Reserves carry none (refused).
5. Nigeria (optional, discovered only): declaration notes; a significant or no-interest declaration is refused on a project meeting every commerciality criterion (PIA s.318, s.78(8)(c)).
6. Categories: cumulative and incremental rebuild each other; no incremental terms for Prospective (2.2.2.4); P-labels from percentile.js.
7. Economic limit: canonical computeCashFlow (JV at 100%, stated royalty and tax, stated prices, zero escalation) with apply_economic_limit; the PRMS 3.1.3.1 peak (cumulative pre-tax, pre-ADR NCF including capex) read off the canonical untrimmed rows as a cross-check; where economic and they disagree, refused.
8. Economic test: undiscounted NCF after tax and ADR above 0 (3.1.2.1); exactly 0 is not economic. Best fails: no Reserves. Low fails: 1P = 0 (3.1.2.8; FAQ 3.3, 3.4). High failing while best passes: refused.
9. Licence: without expected renewal, production after the expiry is cut and reported beyondLicence (FAQ 4.4); capex after expiry refused.
10. Entitlement: applyJV; royalty interest deducted from volumes, a production-tax royalty deducts none (3.3.1.1, 3.3.1.2); cash at 100% and at WI.
11. BOE at a stated factor, supplementary (3.2.9.3); category order checked in BOE.
12. Aggregation: one class per call (4.2.6.1; FAQ 6.9); triangular / lognormal / normal stated, or a triangular fitted through stated low/best/high (refused if not exact or below 0); normal with low below 0 refused, chance below 0 reported; correlation uniform rho or every pair (missing pair refused); rho strictly in (-1, 1); PSD check; P90 = 0.1 quantile; risked mean = sum Pc x mean (AG 2011 6.4); arithmetic reportable above field level.
13. Reconciliation: headings are the engine's convention; production one quantity out of every Reserves category, refused for Contingent (3.1.3.5); closes when |stated - computed| <= tolerance per category; replacement ratio and life index when production > 0.

## Boundary table

| rule | at the boundary | one past | golden |
|---|---|---|---|
| time-frame | 5 years met | 6 Contingent (unless justified) | class-time-frame-5-met / -6-contingent / -8-justified |
| economic test | NCF exactly 0 not economic | above 0 economic | econ-exactly-zero-not-economic, econ-faq33-low-fails |
| limit trim | tail NOI exactly 0 kept | one barrel less cut | econ-tail-exactly-zero-kept / -one-below-cut |
| canonical vs PRMS limit | agree: result | late dip not offset: refused | econ-refuse-limit-disagrees |
| licence | expiry year kept | later years beyondLicence | econ-ekene (high) |
| retention s.78(9) | 10 inside | 11 ended | class-nigeria-retention-10 / -11 |
| FDP s.79(1) | 2 inside | 12 passed | class-nigeria-fdp-2, class-ekn-1 |
| Pg 0 | Pc 0 | | class-pg-zero |
| equal estimates | single value; constant | | cat-single-value, agg-constant-project |
| correlation | 0.999 accepted | 1 refused; -0.6 for 3 projects not PSD | agg-ag2011-table62-dependent, agg-refuse-rho-one, agg-refuse-psd |
| reconciliation | diff = tolerance closes | above does not | rec-difference-exactly-tolerance / -above-tolerance |

## Caps and timing

100 years, 50 projects, 200,000 iterations with iterations x projects <= 500,000 (draw quadratic in projects), 50 movements. Timing (ms): classify 8 projects 2; economicLimit Ekene 37 to 43; 3 x 100 years 237; aggregate Ekene reserves 345 to 382; 50 projects x 10,000 at rho 0.3 2,518 (11,694 at the former 2,000,000 cap); 2 x 200,000 2,698; reconcile 50 movements 3.

## Negative control (35/35 engine red, 6/6 oracle caught, 0 skipped)

The lead's named defects: P90 read as high (three plants), arithmetic sum reported as the probabilistic P90, incremental vs cumulative swapped (two plants), contingent counted as reserves (three), economic limit ignored (two), correlation ignored, reconciliation not closing (three). Also: 1P kept when the low case fails, economic at exactly 0, licence ignored, production tax deducted as a royalty interest, WI not applied, PRMS peak check dropped, Pc read as Pg, five-year benchmark exclusive, approved and justified swapped, retention limit 11, seed ignored, risked mean without Pc, statistical figures reportable above field level, non-PSD correlation accepted, missing pair taken as 0, a triangular fit below 0 accepted, production accepted in Contingent Resources, unknown keys ignored, money float noise, unit agreement dropped. Oracle: trim cuts a zero year (STOP), P90 at 0.9, production added, Pc = Pg, ADR left out, unknown keys ignored (STOP).

## Lead decisions (2026-09-27)

1. Economic limit rule mismatch between cashflow.ts (trailing negative-NOI trim, capex years kept) and PRMS 3.1.3.1 (cumulative peak): KEEP the refusal where they differ. The course teaches both rules; no graded field uses a disagreeing profile. Extending cashflow.ts with a peak-based rule is a separate owner decision (it would ripple to the Suite EPE app and the cashflow, fiscal and pia courses).
2. PRMS 2018 is CC BY-NC-ND 4.0: the course cites sections and never quotes; the owner may seek permission from SPE (permissions@spe.org).
3. AG 2011 Table 6.2 reproduced with normal marginals, stated as the AG's own symmetric error-propagation reading (a lognormal gives 76.4).
4. No gazetted NUPRC reserves reporting rule was found; the Nigerian content is PIA 2021 plus S.I. 37 of 2023 plus the published national totals.
5. This file was committed by the lead with the owner's approval (the wave agent could not create it).
