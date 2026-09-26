# FINDINGS: jointVenture (oracle_jointventure.py, Economics EC9, joint ventures, operating agreements and cost recovery)

Engine: `engines/economics/jointVenture.js` (the brief allowed another name; it
is `jointVenture.js`). Golden: `test-data/economics/goldens/jointventure_cases.json`,
153 cases (78 of them refusals, every refusal message pinned in full),
written by `tools/validation/economics/oracle_jointventure.py`. Gate:
`__tests__/economics.jointVenture.test.js` (187 tests) calls the engine on
every golden, checks the published figures against their printed values
(World Bank Briefing Note 8, IMF FARI Figure 5 and Tables 12 and 13, the
Norwegian Accounting Agreement scale and 0.65 %, the Norwegian JOA budget
tolerances and 1000 % entry, PIA 2021 s.85(4)), checks the planted fixture
situations and the wiring, runs property and boundary tests, and pins the
reason strings the course will quote. Negative control:
`negcontrol_jointventure.sh` (47/47 engine plants red, 7/7 oracle plants
caught). Timing: `timing_jointventure.js` (table below). Fixtures:
`test-data/economics/ekene-jv/`, written by `make_jv_fixtures.py`. Full
engines suite on the branch after `npm ci`: 231 suites passed, 17,977 tests
passed (1 skipped and 1 todo, both outside this wave).

The oracle is STDLIB ONLY (python 3: `fractions`, `decimal`, `datetime`,
`calendar`, `math`). It reads no JavaScript and imports nothing from the
engines, and it takes a different road: money as exact Fractions of the
input doubles; interests as a cost-bearing table built carry by carry; cash
calls on a CUMULATIVE ledger (the adjustment due in month t is every called
month's difference up to t - lag less every adjustment already applied,
where the engine walks month by month with a pending amount); overhead by
first finding the band that holds the base; payout years for premiums and
refunds with no uplift a second time from cumulative availability (the
oracle stops if the two roads disagree); dates, weekdays and month ends from
`datetime` and `calendar`; the PSC order straight from the World Bank and
IMF texts with a limit on gross applied to gross (the engine converts it to
a fraction of revenue after royalty for applyPSC); NPV as an exact Fraction
sum.

No new NPV, Monte Carlo or cost pool: the engine imports `applyPSC` and
`npv` from `engines/economics/cashflow.ts` and `calculatePartnerCosts` from
`engines/economics/afe.js` (every split of a joint account amount between
parties goes through it); nothing here samples.

Print rule (course content): money inside a reason prints rounded to the
cent, half away from zero, trailing zeros dropped (`7267760.62`); every
numeric field keeps full precision; percentages and rates print as the
shortest round-trip decimal. The oracle refuses to write a golden when an
exact money figure lies within 1e-6 of a half-cent tie (the engine's double
could fall either side), so a fixture that would print ambiguously is
changed, never papered over. The fixtures keep money in whole dollars and
the paying interests at 50, 31.25, 18.75 and 0 so the splits are exact in
binary.

## Sources (all read 2026-09-26)

Every legal or regulatory figure in the engine is cited to the section it
was read from; every contractual rate, percentage, multiple, share,
tolerance and scale is a required user input with no default. Copies were
fetched and converted with `pdftotext -layout`; copies are kept in
`/root/cat-wip-joa/sources/`. Licensed model contracts and accounting
procedures (AIPN model JOA, COPAS, AAPL forms) were not used or quoted: the
premium recovery from production is taught by concept.

| # | text | edition / date | URL | sha256 (first 16) | used for |
|---|---|---|---|---|---|
| 1 | Norway, Ministry of Petroleum and Energy, Agreement concerning petroleum activities: Special provisions, Attachment A Joint Operating Agreement, Attachment B Accounting Agreement | unofficial English translation; the PDF is dated 27 February 2007 (document properties); CITED FROM the Wayback Machine capture of 26 May 2024 (capture 20240526033840). The live regjeringen.no copy exists at the URL given but was not machine-readable on 2026-09-26 (a bot check answered HTTP 403) | cited copy: https://web.archive.org/web/20240526033840/https://www.regjeringen.no/globalassets/upload/oed/vedlegg/konsesjonsverk/k-verk-vedlegg-1-2-eng.pdf (live: https://www.regjeringen.no/globalassets/upload/oed/vedlegg/konsesjonsverk/k-verk-vedlegg-1-2-eng.pdf) | 66b626cd3216a118 | JOA Art. 8.1 (contribution by Participating interest), Art. 9.1 to 9.5 (default: advance by the non-defaulting Parties in accordance with their Participating interest; penal interest; loss of vote and data after five (5) working days from the demand; assignment may be demanded after three (3) months; compensation at most book value less unpaid contributions; pro rata apportionment), Art. 12.5 (a budget item or AFE by up to 10%; a budget by no more than the lower of 5% or NOK 75 million; NOK 3 million outside the budgets), Art. 18.1 to 18.14 (sole risk; 18.6 participation in proportion to Participating interest; 18.12 entry at "one thousand (1000) % of their proportionate share of the costs", apportioned to the initial participants by their interest in the project), Art. 19.6 (no later entry into a sole risk development). Accounting Agreement Art. 1.2.1 (monthly advances; "The difference between the monthly cash advances and the actual payments ... shall be stated, and the next request for advances shall be adjusted accordingly"; excess refunded or transferred; no cash call below NOK 5 million a month; billing in arrears when no call), Art. 1.2.2 (interest from and including the due date to, but excluding, the value date, at the reference rate plus three percentage points; "proportionally distributed to the Parties financing the default"), Art. 2.2.2 (per cent rates and limits: exploration 0 to 300 MNOK 2.5%; operating 0 to 1000 MNOK 2.7%, 1000 to 2500 MNOK 1.0%; development 0 to 1000 MNOK 2.5%, 1000 to 2000 MNOK 1.0%, 2000 to 3500 MNOK 0.5%; stated exclusions; CPI indexed from 15 July 2004), Art. 2.2.3 (0.65 % of the annual costs for exploration, operation and development) |
| 2 | Petroleum Industry Act 2021 (Act No. 6) | Official Gazette No. 142, Vol. 108, 27 August 2021 (the EC7 copy, `/root/cat-wip-pia/sources/pia_nuprc.txt`) | https://ngfcp.nuprc.gov.ng/wp-content/uploads/2022/09/Petroleum-Industry-Act-2021-pdf-searchable.pdf | 5d158ca8a16f00b2 | s.85(2)(a) (the production sharing contract: the risk-bearing party recovers costs from a share of production), s.85(4)(a) to (g) (the carried interest provision: Government through NNPC Limited may participate up to 60%; from any time; refunds fully its proportionate share of the unrecovered proven costs from the date of its participation, relating to development and production and not including bonuses and penalties, interest, premium or markups on cost; no upfront payment by Government; expert determination; refund in cash or kind from future share of production or entitlements), s.54(8) (outstanding JV cash call debts; concept), s.65 (incorporated joint venture companies; concept), s.311(2)(a)(iii) (renegotiated PSCs: a cost oil limit of not more than 60% of the total oil production; a minimum 55% haircut on disputed amounts; concept) |
| 3 | World Bank, Petroleum Sector Briefing Note No. 8, Contracts for Petroleum Development, Part 2 (Cambodia series; contacts Bun Veasna and Masami Kojima) | November 2007; Public Disclosure Authorized; World Bank copyright, free public document | https://documents1.worldbank.org/curated/en/385151468239358014/pdf/419580ENGLISH01d0Gas0Note801PUBLIC1.pdf | f481c64c02f38697 | the two-barrel illustration and Figure 2: gross 100, royalty 10% paid first, cost oil limit 60% of gross revenue (60), costs 25 recovered in full, profit oil 65 split 40 contractor / 60 government (26 / 39), income tax 30% on taxable income 100 - 10 - 25 - 39 = 26 (7.8); contractor 43, government 57 (Figure 2 prints 43.2 and 56.8) |
| 4 | IMF, Oana Luca and Diego Mesa Puyo, Fiscal Analysis of Resource Industries (FARI) Methodology, Technical Notes and Manuals TNM/16/01 | February 2016; IMF publication, free access; the direct download returned 403, so the Wayback capture of 12 October 2025 was read | https://www.imf.org/external/pubs/ft/tnm/2016/tnm1601.pdf | dd87b60d5b2c4821 | Figure 5 (one USD100 barrel under a PSC: cost oil 50, profit oil 30 government / 20 contractor, income tax 6, government 36; the CIT base is cost petroleum + profit petroleum - allowable deductions, the deductions assumed equal to the cost recovery), Table 11 (PSC/DROP regime: royalty 0, cost recovery ceiling 80%, SOC participation 10% from development), Table 12 (cost petroleum by year, USD million), Table 13 (DROP profit petroleum sharing, the government share per year) |
| 5 | IMF, Benninger, Devlin, Camero Godinez and Vernon-Lin, Cash Flow Analysis of Fiscal Regimes for Extractive Industries, WP/24/89 | April 2024; IMF copyright; read from the Wayback capture of 14 August 2025 | https://www.imf.org/-/media/files/publications/wp/2024/english/wpiea2024089-print-pdf.pdf | 7ba4578c323ec8ec | concept only: the cost oil limit is "as is more common" calculated after royalties; a carried interest is a loan repaid, usually with interest, from the state's share of production; no worked schedule |
| 6 | Republic of Kenya, Model Production Sharing Contract (Participation Agreement schedule) | 2015 model (file name dated 21 January 2015) | https://nationaloil.co.ke/pdf/Model_PSC_2015_-_210115.pdf | 6bf199baf2b1fec3 | corroboration of the cash call and default design (Participation Agreement Art. 6): cash call on twenty (20) days' notice with a three-month estimate; an excess advance reduces "the next succeeding cash advance" or is refunded within fifteen (15) days on request; Art. 6.7 late payment interest at LIBOR plus a blank margin "compounded monthly and calculated from the due date", and "A payment not received within seventy-two (72) hours of the due date shall accrue interest from the due date" (the source of `interestMethod: 'monthly-compound'` and `graceHours`); no vote after five (5) days of default; forfeiture may be declared after ninety (90) days, the share vesting rateably in the non-defaulting parties; sole risk re-entry after recovery of a blank per cent of the sole risk cost |
| 7 | Tanzania, Model Production Sharing Agreement 2013 (TPDC) | 2013; resourcecontracts.org copy read from the Wayback capture of 23 May 2024 | resourcecontracts.org (Tanzania MPSA 2013) | b43aef492cdb19c9 | concept only: Art. 12 cost recovery at most 50% of production net of royalty, unlimited carry-forward; Art. 10(b)(iii) a contractor loan to TPDC of an unpaid amount at LIBOR plus 1%, recovered from TPDC's cost oil; Accounting Procedure 2.5(b) overhead at most 1% of Contract Expenses before the Development Licence |
| 8 | OpenOil, Oil Contracts: How to read and understand them | version 1, November 2012, Creative Commons | openoil.net (read from the Wayback capture of 15 October 2016) | 4423b6851ce118ea | not used: no cost recovery schedule; its state participation example prints 0.25 x 49 = 11.75 (the product is 12.25), so it is not a gate |

The research found NO public text that prints a worked schedule for a carry
recovered with interest, for a non-consent premium recovered from
production, for a cash call over/under reconciliation, for a default cover
or for an overhead scale applied to figures. Those goldens are therefore
oracle goldens from the stated clause arithmetic of the Norwegian JOA and
Accounting Agreement and PIA s.85(4), with the Norwegian scale and
percentages applied to stated figures as printed-rule cases (the cases
whose `note` names the article). The PSC cost recovery has two public
printed worked examples (sources 3 and 4) and both are gates.

## The lead's PSC check: cashflow.ts's PSC path against published worked examples

EPE.md section 5 records that "Literature byte-verification of JV/PSC
against published worked examples ... remains open". Three published PSC
examples now run through `applyPSC` of `engines/economics/cashflow.ts`
(through `pscCostRecovery`, which calls it once a year with the pool
threaded, and directly in the gate):

| case | source | printed | engine |
|---|---|---|---|
| `psc-wb-bn8-2007` | World Bank Briefing Note 8 (2007), limit 60% of gross, royalty first | royalty 10, cost oil 25, profit oil 65, 26 / 39, tax 7.8, contractor 43 (43.2), government 57 (56.8) | 10, 25, 65, 26 / 39, 7.8, 43.2, 56.8 (exact to 1e-12) |
| `psc-fari-figure-5` | IMF FARI TNM/16/01 Figure 5 | cost oil 50, profit oil 30 / 20, tax 6, government 36 | 50, 30 / 20, 6, 36 (exact) |
| `psc-fari-table-12` | IMF FARI Tables 12 and 13, 11 years | ceiling, cost petroleum, closing balance, profit petroleum, the DROP split, the contractor / SOC split | every line within the printed precision: cost lines within 1.5 (each is a sum of at most three printed whole numbers of an unrounded model; the largest difference is 1.0), the profit split within 1.5 + 0.5% of profit petroleum (the government share is printed as a whole per cent; the largest difference is 1.56 on 514) |

Result: NO DEFECT. The cost pool arithmetic of `applyPSC` (royalty on gross;
the limit on revenue after royalty; cost recovered = min(pool + capex +
opex, limit); the rest carried; profit oil = revenue after royalty - cost
recovered) reproduces the IMF schedule year by year, including the carry of
250 through years 1 and 2 and the binding ceilings of years 3 and 4 (299
and 264 carried). `cashflow.ts` was not changed. Two stated readings, for the
lead and for EPE.md:

1. **Limit base.** `applyPSC` takes the limit as a fraction of revenue after
   royalty (the IMF WP/24/89 "more common" form and FARI Table 12). The
   World Bank note states it on gross revenue. `pscCostRecovery` takes
   `costOilLimitBase` as a required input and, for "gross", passes
   costOilLimitPct / (100 - royaltyPct) of revenue after royalty, the same
   amount; the WB case proves it. The PIA s.311(2)(a)(iii) ceiling is worded
   on "total oil production".
2. **Tax base (lead decision 2026-09-26: KEEP, stated).** The `pscCostRecovery` basis.tax reads "income tax is charged on the contractor's profit oil share, as FARI TNM/16/01 and World Bank Note 8 assume (applyPSC in engines/economics/cashflow.ts)". `applyPSC` taxes the contractor's profit oil. That is the
   FARI assumption printed under Figure 5 (deductions equal to the cost
   recovery) and it agrees with the World Bank example, where the costs are
   recovered in full. In a year where the cost limit binds, a regime that
   deducts all costs for income tax (the World Bank note says "there are no
   limits on deductible expenses") would tax less. No public text prints such
   a year with its tax, so this is recorded as a reading; no
   defect is proven.

Proposed EPE.md section 5 line (for the Suite, not changed by this PR): "PSC
math: cost pool, limit, carry-forward and profit oil split traced to
published worked examples: World Bank Petroleum Sector Briefing Note 8
(2007) and IMF FARI TNM/16/01 (2016) Figure 5 and Tables 12 and 13, at the
printed precision, in petrolord-engines `economics.jointVenture.test.js`.
JV math (applyJV) remains analytically validated only: no public worked
example was found."

### Every figure in the engine and where it comes from

| figure | value | source |
|---|---|---|
| Government participation ceiling (basis "pia-s85-4") | 60% | PIA s.85(4)(a) |
| refundable costs (basis "pia-s85-4") | development and production only; bonuses, penalties, interest, premium and markups excluded; exploration is not development or production | PIA s.85(4)(c) |
| uplift under basis "pia-s85-4" | none (refused otherwise) | PIA s.85(4)(c) |
| upfront refund under basis "pia-s85-4" | refused; refund from future entitlement | PIA s.85(4)(d) and (f) |
| renegotiated PSC cost oil limit | reported in the basis only (the contract's limit is a stated input) | PIA s.311(2)(a)(iii) |
| carry share, carriers, uplift type and rate, multiple, recovery share, cap | REQUIRED inputs, no defaults | the contract states them |
| reconciliation lag, negative call rule, no-call threshold | REQUIRED (threshold optional, stated) | Accounting Agreement Art. 1.2.1 prints NOK 5 million and "the next request"; the contract states them |
| item and budget tolerances, unbudgeted allowance | REQUIRED inputs | JOA Art. 12.5 prints 10%, the lower of 5% or NOK 75 million, NOK 3 million |
| overhead bands, rates, rate above the last band, exclusions | REQUIRED inputs | Accounting Agreement Art. 2.2.2 and 2.2.3 print the Norwegian scale and 0.65 % |
| default interest rate and day basis (365 or 360) | REQUIRED inputs | Accounting Agreement Art. 1.2.2 prints the reference rate plus three percentage points |
| default interest method (`simple` or `monthly-compound`) and `graceHours` (0 allowed) | REQUIRED inputs (lead decision 2026-09-26) | Kenya Model PSC 2015 Participation Agreement Art. 6.7 prints monthly compounding and 72 hours; the Norwegian text is read as simple with no grace |
| suspension and forfeiture triggers | optional stated `{ after, unit, from }` | JOA Art. 9.2 and 9.3 print five working days and three months; Kenya Model PSC five days and ninety days |
| premium multiple | REQUIRED, at or above 100 | JOA Art. 18.12 prints 1000% for entry; recovery multiples are licensed-form concepts |
| PSC royalty, limit and its base, profit share (per year where stated), tax, opening pool | REQUIRED inputs | the contract states them |

## Fixtures (synthetic, ours)

`test-data/economics/ekene-jv/ekene-jv.json` and its README: the Ekene
shallow water licence (the terrain of the EC7 Ekene Alpha case), four
synthetic partners EKO 40% (operator), PA 25%, PB 15%, NOC 20% carried 100%
pro rata through exploration and appraisal (paying 50, 31.25, 18.75, 0);
2027 cash calls (lag 2, threshold 500,000, carry), the 2027 budget, 2031
overhead, PB's March 2027 default, the carry recovery (8% compound, 50% of
the share, and a PIA s.85(4) variant), NOC's back-in from 20% to 40%, PB's
non-consent to the Ekene-4 sidetrack at 400%, and a synthetic PSC variant of
the field. The README lists every planted situation and the gate asserts
each one. No real company, contract or regulator decision.

## Decisions and readings (engine choices, each stated in a basis string)

1. **Function set.** `participatingInterests`, `cashCalls`,
   `budgetControl`, `overhead`, `defaultCover`, `carryRecovery`, `backIn`,
   `nonConsent`, `pscCostRecovery`. `ACCEPTED_KEYS` refuses an unknown key at
   every level ("<path> is not an accepted key; the accepted keys of <path>
   are ..."); keys that are party ids or category names are checked by the
   function that reads them.
2. **Beneficial vs paying.** Beneficial interest = participating interest
   (the share of production); paying interest moves under a carry. Carriers
   "pro-rata" share a carry in proportion to their participating interests
   among the parties no carry names as carried.
3. **Cash calls.** The difference of a called month (forecast share - actual
   share) adjusts the call `reconciliationLagMonths` later (the Norwegian
   text says "the next request"; the lag is stated because the next request
   is often issued before the month closes). A month below the threshold has
   no call; its actual share is billed in arrears the next month and any
   adjustment due waits for the next call.
4. **Default.** Interest method and grace are required (lead decision
   2026-09-26). "simple": unpaid x rate x days / dayBasis. "monthly-compound":
   unpaid x ((1 + rate / 12)^m x (1 + rate x d / dayBasis) - 1), m the whole
   months from the due date (month ends kept as for the triggers), d the
   remaining days. Grace: days x 24 hours from the due date; a default cured
   at or within the grace carries no interest; one cured later carries
   interest from the due date, as the Kenya text prints ("shall accrue
   interest from the due date"). The lead wrote "applied before interest
   starts": the engine follows the printed Kenya clause; a grace that also
   delays the start of interest is a one-line change if the lead prefers it.
   Cover by paying interest among the non-defaulting parties
   (a carried party pays none; the Norwegian text says "Participating
   interest", which is the same outside a carry). Simple interest from and
   including the due date to, but excluding, the cure (value) date.
   Consequences are reported as stated and apply when the default is open
   after the whole trigger date. Forfeiture is reported as available with the
   pro rata interests (JOA Art. 9.4); the compensation is not computed.
5. **Carry recovery.** The uplift accrues on the opening balance; a year's
   new carried cost earns none in its own year; recovery from the same
   year's entitlement at the year end; a stated cap writes off the rest.
6. **Back-in.** The other parties give up interest in proportion to their
   own; the refund is received in proportion to the interest given up.
   Under basis "pia-s85-4" the refund comes from future entitlement with no
   uplift.
7. **Non-consent.** The premium base is the non-consenting party's
   proportionate share of the operation's cost (cost x its participating
   interest); recovery from its share of max(0, gross value - deductions);
   reversion inside the period in which the premium is recovered.
8. **PSC.** `applyPSC` does the arithmetic; the engine threads the pool,
   converts a limit stated on gross, takes a per-year contractor share when a
   year states one (a DROP or R-factor scale is computed outside), and splits
   the contractor entitlement and the costs by participating interest.

Not computed (concept only): the cover by acquiring the defaulter's
petroleum; the assignment compensation; interest on cash balances
(Accounting Agreement Art. 1.2.3); the CPI indexation of the Norwegian bands;
the expert determination of s.85(4)(e); the s.311 haircut; sole risk
development under JOA Art. 19; the DROP and R-factor share computations.

## Boundary table (per rule)

| rule | boundary | behaviour | golden |
|---|---|---|---|
| no-call threshold | forecast equal to `noCallBelow` | called (a forecast below is not) | `cc-threshold-exactly` |
| zero-call month | forecast 0, no threshold | called; the call is the adjustment alone | `cc-zero-call-month` |
| negative call | adjustment above the forecast share | "refund": a negative call; "carry": call 0, the rest carried | `cc-zero-call-month-refund`, `cc-ekene-2027` |
| reconciliation | difference of month t | adjusts month t + lag | `cc-ekene-2027`, `cc-ekene-2027-lag1` |
| budget item | overrun of exactly the tolerance | inside ("by up to"); 0.5 more is beyond | `budget-item-at-tolerance`, `budget-item-one-over` |
| budget total | overrun equal to the allowed amount | inside | `budget-norway-pct-holds` |
| unbudgeted allowance | total equal to the allowance | inside | `budget-ekene-2027` (inside), `budget-ekene-allowance-short` (1 below) |
| overhead band | base exactly at a band's upTo | that band only; the next band and above get 0 | `overhead-band-edge-exact` |
| default interest | cured on the due date | 0 days, 0 interest | `default-cured-on-due-date` |
| grace | cured exactly graceHours after the due date (72 hours, 3 days) | inside: no interest; 96 hours: interest from the due date (4 days); a 71.5-hour grace with 72 elapsed: interest | `default-grace-last-hour`, `default-grace-exceeded`, `default-grace-fractional-hours` |
| monthly compounding | cure on a month anniversary | whole months only, 0 remaining days | `default-monthly-compound-whole-months`; from 31 January: `default-monthly-compound-month-end` (2 months, then 15 days from 31 March) |
| default consequence | cured on the trigger date | not triggered; a day later it is | `default-cured-on-trigger-day`, `default-cured-day-after-trigger` |
| forfeiture (uncured) | asOf equal to the trigger date | not triggered; a day later it is | `default-forfeiture-last-day`, `default-forfeiture-day-after` |
| working days | holidays and a weekend inside the count | Monday to Friday less the stated holidays | `default-working-days-holiday` (5 working days from 2027-12-22 end 2028-01-03) |
| months | 3 months from 31 January | 30 April (the month end) | `default-months-end-of-month` |
| paid share | paid equal to the share | refused: not a default | `default-refuse-paid-in-full` |
| carry recovered exactly | available equal to the balance | recovered that year; payout year that year; the next year the whole share is the carried party's | `carry-recovered-exactly`; one short: `carry-one-short` |
| carry cap | cumulative recovery reaches the cap | the rest written off that year | `carry-ekene-capped`, `carry-cap-exactly-cost` |
| premium on the last barrel | share equal to the balance | reversion from the next period (the non-consenting party receives 0 that year, its whole share next year) | `nc-premium-last-barrel` |
| premium inside a period | share above the balance | the rest of that period's share is the non-consenting party's | `nc-premium-reverts-mid-year` |
| net value | deductions above gross value | 0, nothing recovered, never negative | `nc-two-nonconsenting-deductions-exceed` |
| PIA participation | target 60 | accepted; 61 refused | `backin-pia-at-60`, `backin-refuse-pia-61` |
| PSC limit on gross | limit above 100 - royalty | refused | `psc-refuse-gross-limit` |

## Caps and timing

Caps: 20 parties, 100 years, 600 months, 200 budget items or cost
categories, 20 bands. A run of `timing_jointventure.js` on 2026-09-26
(milliseconds, one run, machine dependent):

| case | size | ms |
|---|---|---|
| cashCalls, 20 parties | 120 months | 32.30 |
| cashCalls, 20 parties | 600 months | 152.28 |
| carryRecovery compound, 20 parties, NPV | 30 years | 8.94 |
| pscCostRecovery, 20 parties, NPV | 30 years | 7.38 |
| nonConsent, 10 non-consenting | 30 years | 3.37 |
| carryRecovery compound, 20 parties, NPV | 100 years | 20.04 |
| pscCostRecovery, 20 parties, NPV | 100 years | 26.07 |
| nonConsent, 10 non-consenting | 100 years | 3.86 |
| budgetControl | 200 items | 2.37 |
| defaultCover, 19 defaulters, working days | 20 parties | 14.49 |
| Ekene fixture cash calls | 12 months | 1.51 |

## Negative control

`tools/validation/economics/negcontrol_jointventure.sh`, run 2026-09-26 on
the branch (it edits the working tree and restores it; nothing was staged
while it ran). The lead's named defects are the first eleven plants.

```
=== baseline ===
Tests:       187 passed, 187 total
=== ENGINE plants (all must be RED) ===
RED   [ENGINE] paying and beneficial interest swapped (entitlement split by paying interest) -- 10 failed -- goldens: the engine agrees with the oracle › carry-ekene-compound
RED   [ENGINE] paying and beneficial interest swapped (cash calls on beneficial interest) -- 6 failed -- goldens: the engine agrees with the oracle › cc-ekene-2027
RED   [ENGINE] carry recovered without the stated uplift -- 9 failed -- goldens: the engine agrees with the oracle › carry-ekene-compound
RED   [ENGINE] over/under-call not carried to a later call -- 10 failed -- goldens: the engine agrees with the oracle › cc-ekene-2027
RED   [ENGINE] overhead base wrong (exclusions ignored) -- 3 failed -- goldens: the engine agrees with the oracle › overhead-ekene-2031
RED   [ENGINE] overhead base wrong (whole base at each band rate) -- 7 failed -- goldens: the engine agrees with the oracle › overhead-ekene-2031
RED   [ENGINE] default cover not pro rata (equal shares) -- 19 failed -- goldens: the engine agrees with the oracle › default-ekene-march
RED   [ENGINE] default cover not pro rata (the defaulter left in the base) -- 21 failed -- goldens: the engine agrees with the oracle › default-ekene-march
RED   [ENGINE] premium multiple applied to the whole cost -- 8 failed -- goldens: the engine agrees with the oracle › nc-ekene-sidetrack
RED   [ENGINE] premium multiple applied to the consenting parties' cost -- 8 failed -- goldens: the engine agrees with the oracle › nc-ekene-sidetrack
RED   [ENGINE] reversion one period late (the whole share taken in the payout year) -- 13 failed -- goldens: the engine agrees with the oracle › carry-ekene-compound
RED   [ENGINE] carry pro rata over every party (carried party included) -- 36 failed -- goldens: the engine agrees with the oracle › int-ekene
RED   [ENGINE] reconciliation one month early -- 12 failed -- goldens: the engine agrees with the oracle › cc-ekene-2027
RED   [ENGINE] negative call refunded under 'carry' -- 6 failed -- goldens: the engine agrees with the oracle › cc-ekene-2027
RED   [ENGINE] threshold strict (a forecast at the threshold not called) -- 2 failed -- goldens: the engine agrees with the oracle › cc-threshold-exactly
RED   [ENGINE] budget item tolerance strict -- 6 failed -- goldens: the engine agrees with the oracle › budget-ekene-2027
RED   [ENGINE] budget tolerance the higher of pct and amount -- 7 failed -- goldens: the engine agrees with the oracle › budget-ekene-2027
RED   [ENGINE] default interest counts the value date -- 24 failed -- goldens: the engine agrees with the oracle › default-ekene-march
RED   [ENGINE] working days count weekends -- 17 failed -- goldens: the engine agrees with the oracle › default-ekene-march
RED   [ENGINE] working days ignore holidays -- 2 failed -- goldens: the engine agrees with the oracle › default-working-days-holiday
RED   [ENGINE] months overflow past the month end -- 2 failed -- goldens: the engine agrees with the oracle › default-months-end-of-month
RED   [ENGINE] consequence applies on the trigger date itself -- 4 failed -- goldens: the engine agrees with the oracle › default-cured-on-trigger-day
RED   [ENGINE] forfeited interest apportioned over every party -- 4 failed -- goldens: the engine agrees with the oracle › default-ekene-uncured
RED   [ENGINE] carried cost on the paying interest -- 14 failed -- goldens: the engine agrees with the oracle › carry-ekene-compound
RED   [ENGINE] recovery share ignores recoverFromPct -- 10 failed -- goldens: the engine agrees with the oracle › carry-ekene-compound
RED   [ENGINE] uplift on the year's new cost too -- 8 failed -- goldens: the engine agrees with the oracle › carry-ekene-compound
RED   [ENGINE] PIA uplift allowed -- 2 failed -- goldens: the engine agrees with the oracle › carry-refuse-pia-uplift
RED   [ENGINE] PIA participation cap 65 -- 2 failed -- goldens: the engine agrees with the oracle › backin-refuse-pia-61
RED   [ENGINE] PIA refund includes exploration -- 5 failed -- goldens: the engine agrees with the oracle › backin-ekene-pia
RED   [ENGINE] back-in reduction in equal points -- 4 failed -- goldens: the engine agrees with the oracle › backin-ekene-pia
RED   [ENGINE] back-in refund on the target interest -- 6 failed -- goldens: the engine agrees with the oracle › backin-ekene-pia
RED   [ENGINE] non-consent: deductions not taken off -- 3 failed -- goldens: the engine agrees with the oracle › nc-ekene-sidetrack
RED   [ENGINE] buy-in apportioned on the participating interest over 100 -- 2 failed -- goldens: the engine agrees with the oracle › nc-ekene-buy-in-norway-1000
RED   [ENGINE] PSC gross limit passed on revenue after royalty -- 3 failed -- goldens: the engine agrees with the oracle › psc-ekene
RED   [ENGINE] PSC entitlement split on 100 - share -- 5 failed -- goldens: the engine agrees with the oracle › psc-ekene
RED   [ENGINE] NPV discounted one year early -- 6 failed -- goldens: the engine agrees with the oracle › carry-ekene-compound
RED   [ENGINE] monthly compounding computed as simple -- 4 failed -- goldens: the engine agrees with the oracle › default-ekene-monthly-compound-kenya
RED   [ENGINE] monthly rate taken as the annual rate -- 4 failed -- goldens: the engine agrees with the oracle › default-ekene-monthly-compound-kenya
RED   [ENGINE] remaining days after the whole months dropped -- 3 failed -- goldens: the engine agrees with the oracle › default-ekene-monthly-compound-kenya
RED   [ENGINE] grace boundary strict (72 hours exceeds a 72-hour grace) -- 3 failed -- goldens: the engine agrees with the oracle › default-cured-on-due-date
RED   [ENGINE] grace ignored -- 3 failed -- goldens: the engine agrees with the oracle › default-cured-on-due-date
RED   [ENGINE] interest starts after the grace -- 3 failed -- goldens: the engine agrees with the oracle › default-grace-exceeded
RED   [ENGINE] graceHours defaults to 0 -- 2 failed -- goldens: the engine agrees with the oracle › default-refuse-no-grace
RED   [ENGINE] unknown keys ignored -- 12 failed -- goldens: the engine agrees with the oracle › int-refuse-unknown-key
RED   [ENGINE] message: money printed with float noise -- 22 failed -- goldens: the engine agrees with the oracle › default-ekene-march
RED   [ENGINE] message: unit agreement dropped -- 6 failed -- goldens: the engine agrees with the oracle › cc-ekene-2027-lag1
RED   [ENGINE] message: PIA uplift refusal loses its section -- 2 failed -- goldens: the engine agrees with the oracle › carry-refuse-pia-uplift
=== ORACLE plants (RED or STOP: the control on the controls) ===
RED   [ORACLE] oracle adjustment one month late -- 7 failed -- goldens: the engine agrees with the oracle › cc-ekene-2027
RED   [ORACLE] oracle band charges the whole lower band only -- 5 failed -- goldens: the engine agrees with the oracle › overhead-ekene-2031
RED   [ORACLE] oracle gross limit on revenue after royalty -- 2 failed -- goldens: the engine agrees with the oracle › psc-ekene
RED   [ORACLE] oracle premium on the whole cost -- 5 failed -- goldens: the engine agrees with the oracle › nc-ekene-sidetrack
STOP  [ORACLE] oracle carry pro rata over every party -- the oracle refused to write a golden
STOP  [ORACLE] oracle interest counts the value date -- the oracle refused to write a golden
STOP  [ORACLE] oracle unknown keys ignored -- the oracle refused to write a golden
engine plants red: 47/47
oracle plants caught: 7/7
```

## Refusal and reason strings (course content)

Every string below is pinned by a golden (the refusals in full).

### Refusals (78 distinct)

- `asOf must be on or after the due date 2027-03-01; got "2027-02-01"`
- `baseYear must be an integer at or above 1; got nothing`
- `basis must be one of "pia-s85-4", "contract"; got nothing`
- `budgetTolerance must be an object { pct, amount } (amount optional; no default); got nothing`
- `budgetTolerance.amt is not an accepted key; the accepted keys of budgetTolerance are pct, amount`
- `carried must be the carried party of one of the carries (NOC); got "PA"`
- `carries must be an array with the carry to recover; got nothing`
- `carries must be leaving at least one party that is not carried; got ["A","B"]`
- `carries[0].carried must be the id of a party (EKO, PA, PB, NOC); got "XYZ"`
- `carries[0].carriedPct must be a number above 0 and at most 100; got 0`
- `carries[0].carriers must be "pro-rata" or an object of carrier shares in per cent (no default); got nothing`
- `carries[0].carriers must sum to 100; got a sum of 90`
- `carries[1].carriers.NOC is a carried party and cannot carry another`
- `carry is not an accepted key; the accepted keys at the top level are parties, carries`
- `consenting must be leaving at least one non-consenting party (every party consents: a joint operation); got ["EKO","PA","PB","NOC"]`
- `consenting[1] must be an id not already listed; got "EKO"`
- `costOilLimitBase must be one of "after-royalty", "gross"; got "net"`
- `costOilLimitPct must be at or below the revenue left after royalty, 87.5% of gross, when costOilLimitBase is "gross"; got 90`
- `costRecoveryLimitPct is not an accepted key; the accepted keys at the top level are years, royaltyPct, costOilLimitPct, costOilLimitBase, contractorProfitSharePct, taxRatePct, openingCostPool, parties, discountRate, baseYear`
- `costs[0].kind must be one of "exploration", "development", "production", "bonus", "penalty", "interest", "premium", "markup"; got "appraisal"`
- `defaulters must be leaving at least one non-defaulting party with a paying interest above 0; got ["EKO","PA","PB"]`
- `defaulters[0].curedOn must be a date from the due date 2027-03-01 to asOf 2027-05-31; got "2027-02-28"`
- `defaulters[0].paid must be below the party's share of the call 2250000 (a party that paid its share is not in default); got 2250000`
- `dueDate must be a real date 'YYYY-MM-DD'; got "2027-02-30"`
- `excluded.drilling is not a cost category; the categories are operating`
- `excluded.operating must be at or below the cost of the category 10; got 11`
- `interest must be an object { annualRatePct, dayBasis, interestMethod, graceHours } (no default rate or method); got nothing`
- `interest.annualRatePct must be a finite number at or above 0; got nothing`
- `interest.compounding is not an accepted key; the accepted keys of interest are annualRatePct, dayBasis, interestMethod, graceHours`
- `interest.dayBasis must be 365 or 360; got 366`
- `interest.graceHours must be a finite number of hours at or above 0, stated (0 when the contract gives no grace; the engine holds no default); got -1`
- `interest.graceHours must be a finite number of hours at or above 0, stated (0 when the contract gives no grace; the engine holds no default); got nothing`
- `interest.interestMethod must be one of "simple", "monthly-compound"; got "compound"`
- `interest.interestMethod must be one of "simple", "monthly-compound"; got nothing`
- `itemTolerancePct must be a finite number at or above 0; got nothing`
- `items[1].item must be a name no other item has; got "x"`
- `lag is not an accepted key; the accepted keys at the top level are parties, carries, months, reconciliationLagMonths, negativeCall, noCallBelow`
- `mode must be one of "recover-from-production", "buy-in"; got "penalty"`
- `months[0].actual must be a finite number at or above 0; got -1`
- `months[0].budget is not an accepted key; the accepted keys of months[0] are month, forecast, actual`
- `months[0].month must be a month 'YYYY-MM'; got "2027-1"`
- `months[1].month must be 2027-02, the month after 2027-01 (the months are consecutive); got "2027-03"`
- `negativeCall must be one of "refund", "carry"; got "net"`
- `openingCostPool must be a finite number at or above 0; got nothing`
- `operation.date is not an accepted key; the accepted keys of operation are name, cost`
- `parties must have participatingPct summing to 100; got a sum of 90`
- `parties[0].participatingPct must be a number above 0 and at most 100; got 0`
- `parties[0].wi is not an accepted key; the accepted keys of parties[0] are id, name, participatingPct`
- `parties[1].id must be an id no other party has; got "A"`
- `premiumMultiplePct must be a number at or above 100 (a stated contract figure; 100 recovers the cost alone); got 50`
- `premiumMultiplePct must be a number at or above 100 (a stated contract figure; 100 recovers the cost alone); got nothing`
- `rate is not an accepted key; the accepted keys at the top level are costs, excluded, scale`
- `reconciliationLagMonths must be an integer at or above 1; got 0`
- `reconciliationLagMonths must be an integer at or above 1; got nothing`
- `recoverFromPct must be a number above 0 and at most 100; got 0`
- `refund is not an accepted key; the accepted keys at the top level are parties, backInParty, targetPct, costs, basis, refundableKinds, refundForm, recoverFromPct, years`
- `refundForm must be "from-future-entitlement" under basis "pia-s85-4": no upfront payment by the Government (s.85(4)(d)); the refund is in cash or in kind from future production or entitlements (s.85(4)(f)); got "upfront"`
- `refundableKinds must be an array of cost kinds stated under basis "contract" (exploration, development, production, bonus, penalty, interest, premium, markup; no default); got nothing`
- `refundableKinds must be left out under basis "pia-s85-4" (development and production, s.85(4)(c)); got ["exploration"]`
- `royaltyPct must be a number from 0 up to, but excluding, 100; got 100`
- `scale.drilling is not a cost category; the categories are operating`
- `scale.operating must be an object { bands, abovePct } (no default rate); got nothing`
- `scale.operating.abovePct must be a number from 0 to 100; got nothing`
- `scale.operating.bands[0].rate is not an accepted key; the accepted keys of scale.operating.bands[0] are upTo, pct`
- `scale.operating.bands[1].upTo must be above the previous band's upTo 100; got 100`
- `scale.operating.flat is not an accepted key; the accepted keys of scale.operating are bands, abovePct`
- `suspension.unit must be one of "calendar-days", "working-days", "months"; got "business-days"`
- `targetPct must be above the back-in party's current interest 20; got 20`
- `targetPct must be at most 60 under basis "pia-s85-4" (the right to participate up to 60%, PIA s.85(4)(a)); got 61`
- `uplift must be an object { type } with type "none", "compound" or "multiple" (no default); got nothing`
- `uplift.multiplePct must be a number at or above 100 (100 recovers the cost alone); got 90`
- `uplift.rate is not an accepted key; the accepted keys of uplift are type, ratePctPerYear, multiplePct`
- `uplift.ratePctPerYear must be left out when type is "none"; got 5`
- `uplift.type must be "none" under basis "pia-s85-4": the refund excludes interest, premium or markups on cost (PIA s.85(4)(c)); got "compound"`
- `years must be left out when mode is "buy-in"; got [{"year":2031,"grossValue":30000000,"deductions":10000000},{"year":2032,"grossValue":26000000,"deductions":9000000},{"year":2033,"grossValue":22000000,"deductions":8000000},{"year":2034,"grossValue":19000000,"deductions":7000000},{"year":2035,"grossValue":16000000,"deductions":6000000},{"year":2036,"grossValue":14000000,"deductions":6000000}]`
- `years must be left out when refundForm is "upfront"; got [{"year":2030,"entitlement":96000000},{"year":2031,"entitlement":112000000},{"year":2032,"entitlement":104000000},{"year":2033,"entitlement":94000000},{"year":2034,"entitlement":86000000},{"year":2035,"entitlement":78000000},{"year":2036,"entitlement":70000000}]`
- `years[0].contractorProfitSharePct must be a number from 0 to 100; got 120`
- `years[1].year must be 2028, the year after 2027 (years are consecutive); got 2029`

### Reasons (from the fixture and boundary goldens)

**int-ekene**

- `NOC: 100% of its 20% cost share is carried (20 points), paid by EKO 10, PA 6.25, PB 3.75 (pro rata to their participating interests); its share of production stays 20%`

**cc-ekene-2027**

- `2027-03: the over-call of 400000 in 2027-01 (forecast 4000000, actual 3600000) is credited against this cash call, 2 months later`
- `2027-04: no cash call: the forecast 0 is below the stated threshold 500000; the actual is billed in arrears in the next month`
- `2027-04: the under-call of 500000 in 2027-02 (forecast 6000000, actual 6500000) is added to the next cash call (none is made this month), 2 months later`
- `2027-05: the actual of 2027-04, 0, made without a cash call, is billed in arrears`
- `2027-05: no cash call: the forecast 400000 is below the stated threshold 500000; the actual is billed in arrears in the next month`
- `2027-05: the over-call of 800000 in 2027-03 (forecast 12000000, actual 11200000) is credited against the next cash call (none is made this month), 2 months later`
- `2027-05: 500000 owed from 2027-04 is added to the next cash call (none is made this month)`
- `2027-06: the actual of 2027-05, 448000, made without a cash call, is billed in arrears`
- `2027-06: a credit of 300000 held from 2027-05 is applied to this cash call`
- `2027-08: 2027-06 was called exactly (forecast = actual = 9000000); no adjustment`
- `2027-09: the over-call of 1200000 in 2027-07 (forecast 15000000, actual 13800000) is credited against this cash call, 2 months later`
- `2027-09: the adjustment exceeds the forecast share of EKO, PA, PB: the call is 0 and the rest of the credit is carried to the next cash call`
- `2027-10: the under-call of 104000 in 2027-08 (forecast 3000000, actual 3104000) is added to this cash call, 2 months later`
- `2027-10: a credit of 200000 held from 2027-09 is applied to this cash call`
- `2027-11: 2027-09 was called exactly (forecast = actual = 1000000); no adjustment`
- `2027-12: the under-call of 400000 in 2027-10 (forecast 8000000, actual 8400000) is added to this cash call, 2 months later`

**budget-ekene-2027**

- `geology and geophysics: 6600000 against 6000000 approved is an overrun of 600000, inside the item tolerance of 10% (limit 6600000)`
- `exploration drilling: 53500000 against 48000000 approved is an overrun of 5500000, beyond the item tolerance of 10% (limit 52800000)`
- `operations support: 8300000 against 8000000 approved is an overrun of 300000, inside the item tolerance of 10% (limit 8800000)`
- `general and administration: 4100000 against 4000000 approved is an overrun of 100000, inside the item tolerance of 10% (limit 4400000)`
- `environmental baseline survey: 250000 spent with no approved budget, inside the unbudgeted allowance 500000 with the other unbudgeted items (250000 in all)`
- `the budget: 81950000 against 76000000 approved, an overrun of 5950000; the allowed overrun is the lower of 5% of the approved total (3800000) and 3000000: 3000000; beyond the budget tolerance`

**overhead-ekene-2031**

- `exploration: base 5000000; 2.5% of 5000000 = 125000`
- `operating: base 58000000 (cost 60000000 less exclusions 2000000); 2.75% of 50000000 + 1% of 8000000 = 1455000`
- `development: base 150000000; 2.5% of 50000000 + 1% of 50000000 + 0.5% of 50000000 = 2000000`

**overhead-norway-development-4000**

- `development: base 4000; 2.5% of 1000 + 1% of 1000 + 0.5% of 1500 + 0% of 500 above 3500 = 42.5`

**default-ekene-march**

- `the unpaid 2000000 is advanced by EKO 1230769.23, PA 769230.77, in proportion to their paying interests among the non-defaulting parties`
- `PB: share of the call 2250000, paid 250000, unpaid 2000000; interest 2000000 x 8.25% x 45 days / 360 = 20625 (from 2027-03-01 to the cure on 2027-04-15, the last date excluded)`
- `PB: the suspension of its rights (as the contract states) starts after 5 working days from 2027-03-01, that is after 2027-03-08: triggered, the default being open after 2027-03-08`
- `PB: the right to demand the assignment of its interest (forfeiture, as the contract states) arises after 3 months from 2027-03-10, that is after 2027-06-10: not triggered, the default being cured on 2027-04-15`

**default-ekene-uncured**

- `the unpaid 2000000 is advanced by EKO 1230769.23, PA 769230.77, in proportion to their paying interests among the non-defaulting parties`
- `PB: share of the call 2250000, paid 250000, unpaid 2000000; interest 2000000 x 8.25% x 122 days / 360 = 55916.67 (from 2027-03-01 to asOf 2027-07-01, the default still open, the last date excluded)`
- `PB: the suspension of its rights (as the contract states) starts after 5 working days from 2027-03-01, that is after 2027-03-08: triggered, the default being open after 2027-03-08`
- `PB: the right to demand the assignment of its interest (forfeiture, as the contract states) arises after 3 months from 2027-03-10, that is after 2027-06-10: triggered, the default being open after 2027-06-10`
- `if the assignment of PB is demanded, the interest is apportioned pro rata: EKO 47.05882352941177%, PA 29.41176470588235%, NOC 23.529411764705884%; the compensation (at most the book value less unpaid contributions) is not computed`

**default-ekene-monthly-compound-kenya**

- `the unpaid 2000000 is advanced by EKO 1230769.23, PA 769230.77, in proportion to their paying interests among the non-defaulting parties`
- `PB: share of the call 2250000, paid 250000, unpaid 2000000; interest 2000000 x ((1 + 8.25% / 12)^1 x (1 + 8.25% x 14 days / 360) - 1), 1 whole month and 14 days = 20210.78 (from 2027-03-01 to the cure on 2027-04-15, the last date excluded); the stated grace of 72 hours is exceeded, so interest runs from the due date`
- `PB: the suspension of its rights (as the contract states) starts after 5 working days from 2027-03-01, that is after 2027-03-08: triggered, the default being open after 2027-03-08`
- `PB: the right to demand the assignment of its interest (forfeiture, as the contract states) arises after 3 months from 2027-03-10, that is after 2027-06-10: not triggered, the default being cured on 2027-04-15`

**default-grace-last-hour**

- `the unpaid 2000000 is advanced by EKO 1230769.23, PA 769230.77, in proportion to their paying interests among the non-defaulting parties`
- `PB: share of the call 2250000, paid 250000, unpaid 2000000; no interest: 3 days (72 hours, from 2027-03-01 to the cure on 2027-03-04, the last date excluded) are within the stated grace of 72 hours`
- `PB: the suspension of its rights (as the contract states) starts after 5 working days from 2027-03-01, that is after 2027-03-08: not triggered, the default being cured on 2027-03-04`
- `PB: the right to demand the assignment of its interest (forfeiture, as the contract states) arises after 3 months from 2027-03-10, that is after 2027-06-10: not triggered, the default being cured on 2027-03-04`

**default-grace-exceeded**

- `the unpaid 2000000 is advanced by EKO 1230769.23, PA 769230.77, in proportion to their paying interests among the non-defaulting parties`
- `PB: share of the call 2250000, paid 250000, unpaid 2000000; interest 2000000 x 8.25% x 4 days / 360 = 1833.33 (from 2027-03-01 to the cure on 2027-03-05, the last date excluded); the stated grace of 72 hours is exceeded, so interest runs from the due date`
- `PB: the suspension of its rights (as the contract states) starts after 5 working days from 2027-03-01, that is after 2027-03-08: not triggered, the default being cured on 2027-03-05`
- `PB: the right to demand the assignment of its interest (forfeiture, as the contract states) arises after 3 months from 2027-03-10, that is after 2027-06-10: not triggered, the default being cured on 2027-03-05`

**carry-ekene-compound**

- `2027: 0 recovered of 16400000 due; 16400000 carried to 2028`
- `2028: 8% a year on the opening balance 16400000 adds 1312000`
- `2028: 0 recovered of 29712000 due; 29712000 carried to 2029`
- `2029: 8% a year on the opening balance 29712000 adds 2376960`
- `2029: 0 recovered of 32088960 due; 32088960 carried to 2030`
- `2030: 8% a year on the opening balance 32088960 adds 2567116.8`
- `2030: 9600000 recovered of 34656076.8 due; 25056076.8 carried to 2031`
- `2031: 8% a year on the opening balance 25056076.8 adds 2004486.14`
- `2031: 11200000 recovered of 27060562.94 due; 15860562.94 carried to 2032`
- `2032: 8% a year on the opening balance 15860562.94 adds 1268845.04`
- `2032: 10400000 recovered of 17129407.98 due; 6729407.98 carried to 2033`
- `2033: 8% a year on the opening balance 6729407.98 adds 538352.64`
- `2033: the balance 7267760.62 is recovered with 7267760.62 of the 9400000 available; the carried party receives 11532239.38 of its share 18800000`

**carry-ekene-capped**

- `2027: 0 recovered of 16400000 due; 16400000 carried to 2028`
- `2028: 8% a year on the opening balance 16400000 adds 1312000`
- `2028: 0 recovered of 29712000 due; 29712000 carried to 2029`
- `2029: 8% a year on the opening balance 29712000 adds 2376960`
- `2029: 0 recovered of 32088960 due; 32088960 carried to 2030`
- `2030: 8% a year on the opening balance 32088960 adds 2567116.8`
- `2030: 9600000 recovered of 34656076.8 due; 25056076.8 carried to 2031`
- `2031: 8% a year on the opening balance 25056076.8 adds 2004486.14`
- `2031: 11200000 recovered of 27060562.94 due; 15860562.94 carried to 2032`
- `2032: 8% a year on the opening balance 15860562.94 adds 1268845.04`
- `2032: the stated cap 25000000 is reached with 4200000 recovered this year; the rest, 12929407.98, is written off`

**carry-recovered-exactly**

- `2027: 0 recovered of 200 due; 200 carried to 2028`
- `2028: the balance 200 is recovered exactly by the 200 available; the carried party receives 0 of its share 200`

**backin-ekene-pia**

- `NOC backs in from 20% to 40%: the others keep 60 / 80 of their interests; refund 20% x refundable costs 490000000 = 98000000 (156000000 excluded)`
- `exploration wells Ekene-1 and Ekene-2: 136000000 (exploration) is not refundable (PIA s.85(4)(c): development and production costs only, no bonuses, penalties, interest, premium or markups)`
- `signature bonus: 10000000 (bonus) is not refundable (PIA s.85(4)(c): development and production costs only, no bonuses, penalties, interest, premium or markups)`
- `interest on partner loans: 8000000 (interest) is not refundable (PIA s.85(4)(c): development and production costs only, no bonuses, penalties, interest, premium or markups)`
- `operator markup on shared services: 2000000 (markup) is not refundable (PIA s.85(4)(c): development and production costs only, no bonuses, penalties, interest, premium or markups)`
- `2030: 19200000 recovered of 98000000 due; 78800000 carried to 2031`
- `2031: 22400000 recovered of 78800000 due; 56400000 carried to 2032`
- `2032: 20800000 recovered of 56400000 due; 35600000 carried to 2033`
- `2033: 18800000 recovered of 35600000 due; 16800000 carried to 2034`
- `2034: the balance 16800000 is recovered with 16800000 of the 17200000 available; the back-in party receives 17600000 of its share 34400000`

**nc-ekene-sidetrack**

- `Ekene-4 sidetrack: cost 18000000 paid by the consenting parties EKO 47.05882352941177%, PA 29.41176470588235%, NOC 23.529411764705884% (in proportion to their participating interests)`
- `PB 2031: 3000000 recovered of 10800000 due; 7800000 carried to 2032`
- `PB 2032: 2550000 recovered of 7800000 due; 5250000 carried to 2033`
- `PB 2033: 2100000 recovered of 5250000 due; 3150000 carried to 2034`
- `PB 2034: 1800000 recovered of 3150000 due; 1350000 carried to 2035`
- `PB 2035: the balance 1350000 is recovered with 1350000 of the 1500000 available; the non-consenting party receives 150000 of its share 1500000`

**nc-ekene-buy-in-norway-1000**

- `Ekene-4 sidetrack: cost 18000000 paid by the consenting parties EKO 47.05882352941177%, PA 29.41176470588235%, NOC 23.529411764705884% (in proportion to their participating interests)`
- `PB: to enter it pays 1000% of its share 2700000 = 27000000, apportioned to the consenting parties in their shares`

**nc-premium-last-barrel**

- `well: cost 1000 paid by the consenting parties A 62.5%, B 37.5% (in proportion to their participating interests)`
- `C 2030: 200 recovered of 600 due; 400 carried to 2031`
- `C 2031: the balance 400 is recovered exactly by the 400 available; the non-consenting party receives 0 of its share 400`

**nc-two-nonconsenting-deductions-exceed**

- `well: cost 1000 paid by the consenting parties A 100% (in proportion to their participating interests)`
- `B 2030: 0 recovered of 300 due; 300 carried to 2031`
- `B 2031: the balance 300 is recovered with 300 of the 1200 available; the non-consenting party receives 900 of its share 1200`
- `C 2030: 0 recovered of 200 due; 200 carried to 2031`
- `C 2031: the balance 200 is recovered with 200 of the 800 available; the non-consenting party receives 600 of its share 800`
- `2030: deductions 150 exceed the gross value 100: no net value, nothing recovered`

**psc-ekene**

- `2029: recoverable 422000000 is above the cost oil limit 0; 422000000 carried to 2030`
- `2030: recoverable 532000000 is above the cost oil limit 131400000; 400600000 carried to 2031`
- `2031: recoverable 431600000 is above the cost oil limit 118260000; 313340000 carried to 2032`
- `2032: recoverable 335340000 is above the cost oil limit 106434000; 228906000 carried to 2033`
- `2033: recoverable 251906000 is above the cost oil limit 95790600; 156115400 carried to 2034`
- `2034: recoverable 180115400 is above the cost oil limit 86211600; 93903800 carried to 2035`
- `2035: recoverable 118903800 is above the cost oil limit 77590200; 41313600 carried to 2036`

## Lead decisions (2026-09-26), applied

1. **Default interest.** `interest.interestMethod` ('simple' or
   'monthly-compound') and `interest.graceHours` (0 allowed) are required,
   with exact refusals; goldens for both methods and the grace boundary;
   seven negative-control plants for them (all red).
2. **PSC tax base.** Kept, and stated in the `pscCostRecovery` basis
   (above). No cashflow.ts change.
3. **EPE.md line.** Left in this file (the PSC section above); the lead takes
   it to a Suite docs PR.
4. **Norwegian agreement.** Cited from the Wayback capture with its date and
   URL; the live regjeringen.no copy exists but was not machine-readable on
   the date read (source 1).

## Open question for the lead

1. **Grace start.** The engine applies the Kenya clause as printed: within
   the grace no interest, beyond it interest from the due date. If the course
   should instead start interest only after the grace, say so (one line in
   the engine, one in the oracle, a new golden).
