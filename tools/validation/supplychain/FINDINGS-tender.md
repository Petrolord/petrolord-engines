# FINDINGS: tender (oracle_tender.py, Supply Chain SC2, procurement, tendering and contracting)

Golden: `test-data/supplychain/goldens/tender_cases.json`, 145 cases (57 of
them refusals, every refusal message pinned in full), written by
`tools/validation/supplychain/oracle_tender.py`. Gate:
`__tests__/supplychain.tender.test.js` (180 tests) calls the engine on every
golden, checks the published worked examples against their printed figures,
checks the planted fixture situations and runs property tests. Negative
control: `negcontrol_tender.sh` (58/58 engine plants red, 7/7 oracle plants
caught). Timing: `timing_tender.js` (table below). Fixtures:
`test-data/supplychain/ekene-tender/`, written by `make_tender_fixtures.py`.
Full engines suite on the branch: 228 suites, 17,511 tests passed (on the foundation-findings branch).

The oracle is STDLIB ONLY (python 3.12: `fractions`, `decimal`, `math`). It
reads no JavaScript and takes a different road on every route (table in its
docstring): money, scores, content percentages, the life-cycle net present
cost and the Monte Carlo accumulators in exact Fractions; its own ranking by
selection with the 12-digit tie key by Decimal ROUND_HALF_UP; mulberry32 in
unsigned 32-bit integers; the triangular inverse CDF from the CDF's
definition; the wellCost duration forms and the AFE rollup re-derived; the
partner split as 100 less the sum of interests; the ALB standard deviation by
exact variance and Decimal square root. Figures printed inside a message are
replayed in doubles in the order the engine states (left-to-right sums),
because a message prints the double the engine holds; every numeric field is
compared against the exact value. A limit the user types (a tolerance, a
band) is read by the oracle as the decimal it was typed as (0.8 is 4/5); the
engine compares doubles, and the two agree except within one unit in the
last place of the limit, which the boundary table states.

## Sources (all read 2026-09-26)

Every legal or regulatory figure in the engine is cited below to the section
or schedule line it was read from; every figure that could not be sourced is
a required user input. Copies were fetched and converted to text with
`pdftotext -layout` (the SPDs from their .docx XML; the SPD combined-score
formula is an embedded image and was read directly) on 2026-09-26.

| # | text | edition / date | URL | used for |
|---|---|---|---|---|
| 1 | World Bank, Procurement Regulations for IPF Borrowers | Seventh Edition, September 2025 (current; the 6th, February 2025, was also fetched and is superseded) | https://thedocs.worldbank.org/en/doc/c84273d1b230aeb2b0b8134de5dc8cd7-0290012025/original/Procurement-Regulations-7th-Edition-Sep-2025.pdf | para 5.50 (Rated Criteria weighting matrix, US$10 million high-value line), 5.52 and 5.53 (domestic preference, not implemented), 5.69 and 5.70 (Most Advantageous Bid), 6.28, 6.29 (one and two envelopes), 6.37, Annex X paras 2.3, 3.1 to 3.9, 4.5, 4.8, 4.10 |
| 2 | World Bank, Revisions of the Procurement Regulations, Seventh Edition | September 2025 | https://thedocs.worldbank.org/en/doc/e3eabf1f044cca90dd6d1728976e2a4b-0290012025/original/Regulations-Summary-of-Revisions-Sep-2025.pdf | what changed in the 7th edition (local labour participation, para 5.54); none of the evaluation rules used here changed |
| 3 | World Bank, Procurement Guidance: Evaluating Bids and Proposals (including use of Rated Criteria) | February 2025 (file dated 4 Feb 2025) | https://thedocs.worldbank.org/en/doc/9dcb7971706bf29b2732779c39922b77-0290012025/original/Evaluating-Bids-and-Proposals-with-Rated-Criteria-Feb-4-2025.pdf | comparative scoring and the worked examples: Figures IX to XII, Annex 2 (minimum quality threshold), Annex 3 (comparative scoring) |
| 4 | World Bank, SPD Request for Bids, Works, two-envelope (without SEA/SH disqualification) | September 2025 | https://thedocs.worldbank.org/en/doc/d551a159591a349925720198f734af85-0290012025/original/SPD-RFB-Works-without-SEASH-disqualification-2Envelope-Sept-2025.docx | ITB 34.1 (a missing or non-conforming item priced at the AVERAGE price quoted by substantially responsive bidders, else the Employer's best estimate), ITB 35.1 (arithmetic correction), Section III time for completion adjustment, combined evaluation B = Clow/C x X x 100 + T/Thigh x (1 - X) x 100 |
| 5 | World Bank, SPD Request for Bids, Goods, two-envelope | February 2025 | https://thedocs.worldbank.org/en/doc/91e2b715142f30d08e3f4d10c725c50b-0290012025/original/SPD-Request-for-Bids-GOODS-Two-Envelope-Feb-2025.docx | the same ITB 34.1 average rule and ITB 35.1(a)(b) for goods; delivery-schedule and life-cycle factors; the 0 to 4 example scoring scale; the weighting ranges repeated in Section III |
| 6 | World Bank, Procurement Guidance: Abnormally Low Bids and Proposals | Second Edition, July 2016 (published 1 Feb 2016) | https://thedocs.worldbank.org/en/doc/780841478724671583-0290022017/original/ProcurementGuidanceidentificationandtreatmentofAbnormallyLowBidsandProposals.pdf | Stage 1: fewer than five responsive bids, 'absolute' (20% or more below the Borrower's cost estimate); five or more, 'relative' (more than one standard deviation below the average); never rejected without clarification; Annex I Examples 1 and 2 |
| 7 | Nigeria, Public Procurement Act 2007 (Act No. 14) | Official Gazette No. 65, Vol. 94, Lagos, 19 June 2007, A 203 to A 249 | https://ncdmb.gov.ng/images/Downloads/Public-Procurement-Act-2007.pdf (the BPP link https://www.bpp.gov.ng/wp-content/uploads/2019/01/Public-Procurement-Act-2007pdf.pdf returned an HTML page, not the PDF, on 2026-09-26) | s.16(15), (17); s.24(3) (lowest evaluated responsive bid); s.31(1), (4), (7), (10), (13), (14) (examination, arithmetic errors, major and minor deviations, minor deviations quantified in money); s.32(1) to (6) (evaluation steps, omissions quantified); s.33; s.34 (domestic preference left to Bureau regulations, not read, not implemented); s.48 (separate envelopes); s.49 to s.51 (criteria, weights, prices compared only for proposals at or above the threshold) |
| 8 | Nigeria, Nigerian Oil and Gas Industry Content Development Act 2010 (Act No. 2) | commenced 22 April 2010; NCDMB-hosted copy (pages marked "(c) 2016 NCDMB PROPRIETARY"), cross-checked for s.14, s.16 and every Schedule line used against the FAOLEX copy | https://ncdmb.gov.ng/nc-act.pdf and https://faolex.fao.org/docs/pdf/nig169358.pdf | s.3(2); s.11(1) to (4) and the Schedule (minimum Nigerian content and measured unit per item); s.14 (bids within 1% at the commercial stage); s.16 (10 percent margin for an indigenous company with capacity); s.106 definitions |
| 9 | Kiiver, P. and Kodym, J., "Price-quality ratios in value-for-money awards", Journal of Public Procurement 15(3), 275 to 290 | Fall 2015 | https://www.ippa.org/images/JOPP/vol15/issue-3/Article_1_Kiiver_Kodym.pdf | the price-scoring families (lowest-bid ratio; linear, zero to the highest bid; average-price methods) and Table 1 (lowest-bid ratio worked example) |
| 10 | Chen, T. H., "An economic approach to public procurement", Journal of Public Procurement 8(3), 407 to 430 | 2008 | https://ippa.org/IPPC3/JoPP%208(3)/IPPC_Ar5_Economics_Chen.pdf | Score = 50 x L / P and its ranking-paradox worked example (p. 409) |

Could not access: Fuentes-Bargues and González-Gaya (2013), "Analysis of the
Scoring Formula of Economic Criteria in Public Works Procurement",
International Journal of Economic Behavior and Organization 1(1) (the
publisher's PDF sits behind a verification page). It is the survey that would
have given a published average-price formula; see decision 5.

### Every figure in the engine and where it comes from

| figure | value | source |
|---|---|---|
| Rated Criteria weighting ranges | a 50 to 80%, b 60 to 100%, c 10 to 40%, d 20 to 30% | WB Reg (7th) para 5.50 a to d; Annex X Figure 1 |
| high value | estimated cost at or above US$10 million | WB Reg para 5.50 note; Annex X Figure 1 note |
| arithmetic rule | unit rate prevails over the line total unless the decimal point is obviously misplaced; subtotals prevail over the total | WB SPD ITB 35.1(a)(b) (Works and Goods); PPA 2007 s.31(4) permits the correction |
| omission rule 'average' | average price quoted by the substantially responsive bidders, else the Employer's best estimate | WB SPD ITB 34.1 (Works and Goods) |
| schedule adjustment | a stated rate per week beyond the minimum period, no credit for earlier completion, beyond the maximum rejected | WB SPD Works Section III (the rate is a BDS blank: a user input) |
| life-cycle cost | net present cost over the stated years at the stated rate | WB Reg Annex X 3.7, 3.8 (years and rate are RFB blanks: user inputs) |
| combined score | B = Clow/C x X x 100 + T/Thigh x (1 - X) x 100 | WB SPD Works Section III |
| ALB absolute | 20% or more below the Borrower's cost estimate, fewer than five responsive bids | WB ALB Guidance (2016) Stage 1 |
| ALB relative | more than one standard deviation below the average, five or more responsive bids; population SD | WB ALB Guidance Stage 1; population SD confirmed by Annex I Example 1 (315,975) |
| s.14 price margin | 1% | NOGICD Act 2010 s.14 |
| s.14 content lead | 5% (its reading is a required input) | NOGICD Act 2010 s.14 |
| s.16 margin | 10 percent | NOGICD Act 2010 s.16 |
| Schedule percentages and units | 45 lines (`NC_SCHEDULE`) | NOGICD Act 2010 Schedule: MATERIALS AND PROCUREMENT (all 12 lines), WELL AND DRILLING SERVICES/PETROLEUM TECHNOLOGY (24 lines), EXPLORATION, SUBSURFACE, PETROLEUM ENGINEERING AND SEISMIC (9 lines) |

Required user inputs (no default, refused when missing): the technical pass
mark, the criterion weights and maximum scores, the technical weight of the
combined score, the price and technical scoring methods, the omission rule,
the schedule rate and limits, the life-cycle years and discount rate, the
should-cost band, the ALB cost estimate below five bids, the s.14 lead
reading (`ncLeadBasis`), any Nigerian content target for an item the
Schedule does not list (with its stated source), the Monte Carlo seed.

## Fixtures (synthetic, ours)

Two Ekene tenders (`test-data/supplychain/ekene-tender/README.md` lists the
planted situations): EK-11/WS/2027-01, coiled tubing cleanout and matrix acid
stimulation on Ekene-3 and Ekene-5 (6 bids; combined award at technical
weight 0.7, inside the para 5.50 cell b range 0.6 to 1.0 for a high-risk
contract under US$10 million), and EK-11/MS/2027-02, casing, gate valves,
cement, baryte and inspection (5 bids; lowest evaluated cost with a five-year
valve maintenance life-cycle cost). Bidders are codes named "(synthetic)".
Wells and depths follow `test-data/ekene-dynamic/field.json`.

## Published worked examples (goldens, printed figures beside)

| source | what it prints | exact (engine and oracle) | note |
|---|---|---|---|
| WB Guidance Figure IX | Company A weighted score 190 | 190 | agrees |
| WB Guidance Figures X to XII (technical 80%, cost 20%; E rejected as an ALB) | A 63.33 / 16.92 / 80.25; B 66.66 / 17.60 / 84.26; C 68.33 (Fig. X), 68.34 (Fig. XII) / 20.00 / 88.34; D 80.00 / 18.34 / 98.34; ranking D, C, B, A | A 63.3333 / 16.9231 / 80.2564; B 66.6667 / 17.6000 / 84.2667; C 68.3333 / 20 / 88.3333; D 80 / 18.3333 / 98.3333 | ranking agrees. Printed figures are truncated in places (79.16, 63.33, 80.25) and rounded up in others (18.34, 98.34, 68.34 in Fig. XII against 68.33 in Fig. X); each is within 0.01 of the exact figure and none is it. |
| WB Guidance Annex 2 (minimum quality threshold 80) | totals A 59, B 82, C 91; A rejected, C first | A 59, B 77, C 91; A and B below 80 | **Erratum in the Guidance**: B's printed criterion scores 12 + 11 + 54 sum to 77, not 82, so on its printed scores B also fails the threshold. The outcome the Guidance states (C first) is unchanged. |
| WB Guidance Annex 3 (technical 40%, financial 60%) | A 40 + 54.37 = 94.37; B 31.66 + 60 = 91.66; A wins | A 94.375; B 91.6667 | truncated to 2 decimals; ranking agrees |
| WB ALB Guidance Annex I Example 1 (16 bids, relative) | average 1,664,426; SD 315,975; limit 1,348,452; the lowest three bids in the risk zone | 1,664,426.375; population SD 315,974.537; limit 1,348,451.838; bids 1, 2, 3 flagged | agrees (rounded); the sample SD (326,337) would give 1,338,089, so the Guidance uses the population SD |
| WB ALB Guidance Annex I Example 2 (4 bids, absolute) | Bid 1 (85,862,863) more than 20% below the estimate 150,003,863 | Bid 1 42.76% below, flagged; Bid 2 23.0% below, also flagged | the Guidance names only the preferred lowest bid; Example 1 puts every bid past the limit in the zone, and the engine flags every such bid |
| Kiiver and Kodym (2015) Table 1 | 100, 67, 50 | 100, 66.6667, 50 | 67 is rounded. Their "under linear conditions it would receive 75 points" draws the line between A's 100 and C's 50; the engine's 'linear' method gives the highest bid 0 (the family their text describes), so B scores 50 on it. |
| Chen (2008) p. 409 | 50 x L / P: A 50, B 40, C 25; A declared invalid: B 50, C 31.25 (gap 15 to 18.75) | identical | the ranking paradox of relative price scores, exactly |

## Lead decisions (2026-09-26), applied in 20988b0

1. Omission pricing: `omissionRule` defaults to 'average' (WB SPD ITB 34.1,
   cited). 'highest' stays available; its reason, basis and the refusal
   message say the cited texts do not use it. The course teaches and grades
   the cited rule only.
2. Mean-deviation price scoring: DROPPED from the engine, oracle, goldens and
   tests (unsourced). `priceMethod` is 'lowest-ratio' or 'linear', both cited;
   'mean-deviation' is now refused (golden `rank-refuse-mean-deviation-dropped`).
3. s.14: the readings are stated verbatim in every s.14 reason and in
   `section14.readings`; `ncLeadBasis` stays a required input with no default.
   The course presents both readings side by side as an open question of the
   Act, and any graded field states its basis.
4. P-labels follow lib/conventions/percentile.js; the contractTypes basis
   states that for a cost P90 is the LOW cost and P10 the HIGH cost.
5. The 2010 Schedule only, stated with its date in every Nigerian content
   target source and basis ("Act No. 2, commenced 22 April 2010 ... as
   enacted in 2010 (later Board targets are not included)").

## Decisions and refinements of the lead's scope (as first reported)

1. **Omission pricing: the current texts say AVERAGE; the lead's scope said
   HIGHEST.** WB SPD ITB 34.1 (Works Sep 2025, Goods Feb 2025) prices a
   missing item at "the average price of the item or component quoted by
   substantially responsive Bidders", else the Employer's best estimate. No
   current text read uses the highest price. The engine has no default:
   `omissionRule` is 'average' (cited) or 'highest' (a stated alternative,
   labelled as an option the cited texts do not use). The materials fixture is built so
   the rule decides the lowest evaluated cost (average: MS4; highest: MS2).
   Lead decision taken: default 'average'; 'highest' kept, labelled.
2. **Which bids price an omission:** the other bids still substantially
   responsive at that point (bids rejected at the commercial stage and bids
   beyond the maximum completion time are removed first). A bid never prices
   its own omission.
3. **Arithmetic correction:** discrepancy when |quantity x unit rate - quoted
   amount| > tolerance, default 0.005 (half a cent; an engine convention, not
   a legal figure). ITB 35.1(c), words against figures, is not computed and
   is taught as a concept.
4. **Schedule adjustment base:** the SPD gives a rate per week beyond the
   minimum period without saying of what; the engine applies it to the
   corrected price less the unconditional discount and says so in the reason.
5. **Commercial scoring methods:** 'lowest-ratio' is the World Bank's (SPD
   formula; Reg Annex X 3.9; Guidance Figure XI). 'linear' (100 x (Cmax - C)
   / (Cmax - Cmin), all 100 when every price is equal) is the family Kiiver
   and Kodym describe. **'mean-deviation' (max(0, 100 x (1 - |C - Cmean| /
   Cmean))) has no published formula I could read**: Kiiver and Kodym and
   Chen describe average-price methods and warn against them, neither prints
   a formula, and the survey that does was not accessible. The formula is
   ours. Lead decision taken: dropped.
6. **Technical score:** 'relative' is the SPD's T/Thigh x 100 (the Guidance's
   comparative scoring); 'absolute' uses the percentage as scored. The
   technical percentage is sum of weight x score / maxScore with weights
   summing to 100 (refused otherwise, to 1e-9), so Annex 2's points and
   Figure IX's 0 to 4 scale go through the same function.
7. **Pass mark:** a bid passes at or above it (Guidance Annex 2 "scoring below
   this threshold will be rejected"; PPA s.51(2) "at or above the threshold").
   Only passing bids have their commercial envelope opened (WB Reg 6.29; PPA
   s.48(4), (5), s.51(2)); the gate checks `evaluateTender` never reads a
   failed bid's prices.
8. **Ties:** equal to 12 significant digits; tie-break lower evaluated cost,
   then earlier receipt, then bidder id (the lead's rule; no text read states
   one), printed on every row it decides (`tieBrokenBy`).
9. **s.14 of the NOGICD Act, three readings stated.** (a) "within 1 % of each
   other at commercial stage": the group is every bid with 100 x (C - Cmin)
   <= 1 x Cmin; any two bids in it are then within 1% of each other measured
   on the lower of the two. (b) "its closest competitor": the next-highest
   Nigerian content in the group. (c) "at least 5% higher": points or
   relative is not stated in the Act, so the engine has no default
   (`ncLeadBasis` 'points' or 'relative'). The materials fixture is built so
   the reading decides the award (points: MS4 stands, lead 4.54 points;
   relative: MS2 is selected, 7.96% higher). A shared highest content means
   no single bid leads and the lowest stands. s.14 applies only at the
   commercial stage of a lowest-evaluated-cost award; with a combined award
   the engine refuses and says to state content as a rated criterion.
   Lead decision: confirm (a) and (b), and which reading of (c) the course
   presents first (no NCDMB text read settles it). Lead decision taken:
   both readings side by side, basis stated on every graded field.
10. **s.16** protects an indigenous company with capacity from exclusion
    solely on price within 10 percent (100 x (C - Cmin) <= 10 x Cmin,
    inclusive); it never selects a bid. "Indigenous" and "capacity" are
    caller flags.
11. **Nigerian content measure:** content = 100 x Nigerian / total in the
    Schedule line's unit; another unit is refused naming the unit required.
    The Act has no rule for adding man-hours to tonnes: overall content is
    100 x sum Nigerian / sum total when all items share one unit, else the
    weighted mean of item contents with the bid's stated weights (the
    fixture uses each bid's spend per item). An item meets its minimum at or
    above it.
12. **The Schedule transcribed:** 45 lines, three sections. Omitted on
    purpose: lines printed with two units ("Petro physical Interpretation
    Services 75% Volume/Man-hour", "Pollution Control 90% Man-hour/Spend") and
    the gazetted text's own duplicates ("Pollution Control" twice, 45% Spend
    and 90% Man-hour/Spend; "Drilling rigs (Land)" twice, 70% both;
    "Equipment brokerage services" twice, 75% both). This is the 2010 Act's
    Schedule; s.11(2) lets the Board set a level for an unlisted item, and no
    later Board target was read, so such a target enters as a user-stated
    target with its source.
13. **Contract types:** the plan is the modes unless `plan` is given; an
    overrun is an iteration whose contractor cost exceeds the planned cost;
    companyPays + contractorAbsorbs = expectedOverrun exactly (lump sum: 0 to
    the company; cost plus 12%: 1.12 of it; day rate in between). A margin of
    exactly 0 is not a loss. With a wellCost programme, days = the programme's
    productive days (one `evaluateProgram` call) x (1 + NPT fraction), which
    is wellCost's own stretch rule.
14. **Percentile labels on a cost:** lib/conventions/percentile.js defines P90
    as "a 90% probability the actual quantity meets or exceeds this value",
    so for a COST the engine's P90 is the LOW cost (10th percentile) and P10
    the high cost, the reverse of the habit of many cost engineers. The engine
    follows the Suite convention and prints the definition
    (`percentileDefinition`). Lead decision taken: keep, state it in the
    basis, teach the reversal.
15. **Should-cost** is built entirely by the imported engines
    (`drilling/wellCost.js` evaluateProgram and afeCosts, contingency
    included; `economics/afe.js` calculatePartnerCosts for the net share). Its
    screening band is a stated input. The World Bank's own test is
    `abnormallyLow` (cited above); the engine's reason says a potential ALB is
    clarified with the bidder and never rejected automatically.
16. **Not implemented, taught as concept only:** domestic preference (WB Reg
    5.52: 15% goods, 7.5% works, Bank-financed international competitive
    procurement; PPA s.34(4) leaves Nigerian margins to Bureau regulations,
    not read), words against figures, the Board's approval steps (NOGICD s.17
    to s.24 and the US$1,000,000 threshold), the 1% Nigerian Content
    Development Fund deduction (s.104), BAFO and negotiations, lots.

## Boundary table (per rule)

| rule | at the boundary | golden or fixture |
|---|---|---|
| arithmetic discrepancy | a gap EQUAL to the tolerance is not corrected | `arith-gap-equal-to-tolerance-not-corrected` |
| technical pass mark | a score EQUAL to the pass mark passes | fixture WS5 at 70 |
| weights | must sum to 100 within 1e-9 | `tech-refuse-weights-99` |
| completion time | EQUAL to maxWeeks is responsive; beyond is rejected; at or before minWeeks no adjustment and no credit | `ec-schedule-boundaries` |
| high value | EQUAL to US$10 million is high value | `band-c-low-risk-high-value-at-10m` |
| weighting range | both ends inside | `band-a-edge-inside-0.5` |
| ties | equal to 12 significant digits is a tie | `ec-tie-at-12-digits` |
| content minimum | content EQUAL to the minimum meets it | fixture WS1 pumping 95%; `nc-user-target-and-exact-minimum` |
| s.14 group | EXACTLY 1% above the lowest is in; one unit more is out | `s14-group-edge-1pct-in`, `s14-group-edge-just-out` |
| s.14 lead, points | EXACTLY 5 points applies s.14 | `s14-lead-exactly-5-points` |
| s.14 lead, relative | EXACTLY 5% above the runner-up (84 against 80) applies s.14 | `s14-lead-4-points-relative-exactly-5pct` |
| s.14 shared top | not engaged; the lowest stands | `s14-tied-highest-content` |
| s.16 margin | EXACTLY 10 percent above the lowest is protected | `s16-exactly-10pct` |
| should-cost band | a ratio EQUAL to either limit is inside; compared in doubles | `should-cost-band-edges` |
| ALB absolute | EXACTLY 20% below is flagged ("20% or more") | `alb-absolute-exactly-20pct` |
| ALB relative | a price EQUAL to mean - SD is not flagged ("more than one standard deviation below") | `alb-relative-at-the-limit-not-flagged` |
| ALB approach | 4 responsive bids: absolute; 5 or more: relative | the two Annex I examples |
| contract margin | a margin of exactly 0 is not a loss | `ct-constant-everything-zero-margin-is-not-a-loss` |
| overrun | cost EQUAL to the planned cost is not an overrun | `ct-constant-everything-zero-margin-is-not-a-loss` |

## Caps and timing

Caps (refused above, the cap named in the message): 100 bids, 50 criteria,
5,000 bill lines a bid, 200 content items, 100 life-cycle years, 200,000
Monte Carlo iterations.

`npx jest --testMatch '<rootDir>/tools/validation/supplychain/timing_tender.js'`,
node v18.19.1, one run, milliseconds (machine dependent):

| bids | lines a bid | evaluateTender combined | evaluateTender lowest cost |
|---|---|---|---|
| 6 | 6 | 11.2 | 1.7 |
| 20 | 100 | 34.6 | 17.8 |
| 100 | 100 | 90.0 | 66.5 |
| 100 | 1000 | 772.1 | 715.4 |

| iterations | contractTypes, wellCost programme | contractTypes, triangular days |
|---|---|---|
| 2,000 | 47 | 32 |
| 20,000 | 284 | 281 |
| 200,000 | 2,766 | 2,636 |

(Before the one-call programme change, the programme route ran
evaluateProgram every iteration: 7.6 s at 20,000.) A course panel is
comfortable at 20,000 iterations and 100 bids of 100 lines.

## Negative control

`tools/validation/supplychain/negcontrol_tender.sh`, run on 20988b0
(baseline 175 passed): **54/54 engine plants red, 7/7 oracle plants caught
(all red), 0 skipped.** Each line: the plant, the failures, the first
failing test.

```
RED   [ENGINE] weights need not sum to 100 -- 2 failed -- first: tech-refuse-weights-99
RED   [ENGINE] weights ignored (every criterion 20) -- 16 failed -- first: ws-technical
RED   [ENGINE] score not divided by its maxScore (fixed scale 4) -- 2 failed -- first: wb-guidance-annex-2
RED   [ENGINE] pass mark exclusive -- 5 failed -- first: ws-technical
RED   [ENGINE] every commercial envelope opened -- 10 failed -- first: ws-tender-combined
RED   [ENGINE] quoted total always governs -- 8 failed -- first: ws-arith-WS2
RED   [ENGINE] arithmetic tolerance inclusive -- 1 failed -- first: arith-gap-equal-to-tolerance-not-corrected
RED   [ENGINE] average rule priced at the highest -- 10 failed -- first: ws-evaluated-average
RED   [ENGINE] highest rule priced at the lowest -- 5 failed -- first: ws-evaluated-highest
RED   [ENGINE] rejected bids price omissions -- 1 failed -- first: ec-rejected-bid-prices-no-omission
RED   [ENGINE] credit for early completion -- 1 failed -- first: ec-schedule-boundaries
RED   [ENGINE] maxWeeks exclusive -- 1 failed -- first: ec-schedule-boundaries
RED   [ENGINE] discount not deducted -- 5 failed -- first: ws-evaluated-average
RED   [ENGINE] residual value not credited -- 1 failed -- first: ec-life-cycle-residual
RED   [ENGINE] life cycle discounted from year 0 -- 7 failed -- first: ms-evaluated-average
RED   [ENGINE] cost tie-break reversed -- 1 failed -- first: rank-tie-broken-by-lower-cost
RED   [ENGINE] receipt tie-break reversed -- 2 failed -- first: ec-tie-to-receipt-then-id
RED   [ENGINE] id tie-break reversed -- 4 failed -- first: ec-schedule-boundaries
RED   [ENGINE] ties compared exactly (no 12-digit key) -- 1 failed -- first: ec-tie-at-12-digits
RED   [ENGINE] lowest-ratio inverted -- 19 failed -- first: ws-rank-combined
RED   [ENGINE] linear over Cmax -- 2 failed -- first: ws-rank-linear
RED   [ENGINE] relative technical score not normalised -- 12 failed -- first: ws-rank-combined
RED   [ENGINE] technical and commercial weights swapped -- 15 failed -- first: ws-rank-combined
RED   [ENGINE] high value strictly above 10 million -- 1 failed -- first: band-c-low-risk-high-value-at-10m
RED   [ENGINE] content measure not checked -- 1 failed -- first: nc-refuse-measure-mismatch
RED   [ENGINE] content share of Nigerian over foreign -- 3 failed -- first: ws-nigerian-content
RED   [ENGINE] minimum met only strictly above -- 3 failed -- first: ws-nigerian-content
RED   [ENGINE] mixed measures summed without weights -- 2 failed -- first: ms-nigerian-content
RED   [ENGINE] Schedule: coiled tubing 70 not 75 -- 2 failed -- first: ws-nigerian-content
RED   [ENGINE] Schedule: valves by tonnage -- 3 failed -- first: ms-nigerian-content
RED   [ENGINE] s.14 lead 6 -- 3 failed -- first: s14-group-edge-1pct-in
RED   [ENGINE] s.14 group within 2% -- 1 failed -- first: s14-group-edge-just-out
RED   [ENGINE] s.16 margin 15 percent -- 1 failed -- first: s16-exactly-10pct
RED   [ENGINE] s.14 relative lead over the leader -- 1 failed -- first: s14-lead-4-points-relative-exactly-5pct
RED   [ENGINE] s.14 shared top content ignored -- 1 failed -- first: s14-tied-highest-content
RED   [ENGINE] draw order swapped -- 1 failed -- first: ws-contract-types
RED   [ENGINE] fee charged twice -- 3 failed -- first: ws-contract-types
RED   [ENGINE] overrun split against a zero planned margin -- 3 failed -- first: ws-contract-types
RED   [ENGINE] P90 and P10 swapped -- 3 failed -- first: ws-contract-types
RED   [ENGINE] plan 10 percent above the mode -- 2 failed -- first: ws-contract-types
RED   [ENGINE] a zero margin counted as a loss -- 1 failed -- first: ct-constant-everything-zero-margin-is-not-a-loss
RED   [ENGINE] band limits outside the band -- 1 failed -- first: should-cost-band-edges
RED   [ENGINE] contingency dropped from the estimate -- 3 failed -- first: ws-should-cost
RED   [ENGINE] ALB absolute strictly more than 20% -- 1 failed -- first: alb-absolute-exactly-20pct
RED   [ENGINE] ALB relative at the limit flagged -- 1 failed -- first: alb-relative-at-the-limit-not-flagged
RED   [ENGINE] ALB relative from 4 bids -- 3 failed -- first: wb-alb-annex-i-example-2-absolute
RED   [ENGINE] ALB limit two standard deviations -- 3 failed -- first: wb-alb-annex-i-example-1-relative
RED   [ENGINE] ALB reason drops 'never rejected automatically' -- 3 failed -- first: wb-alb-annex-i-example-1-relative
RED   [ENGINE] s.14 reason in other words -- 6 failed -- first: ms-preference-average-relative
RED   [ENGINE] pass-mark reason in other words -- 11 failed -- first: ws-technical
RED   [ENGINE] omission refusal drops 'not from the cited texts' -- 1 failed -- first: ec-refuse-omission-rule-lowest
RED   [ENGINE] omission default is the highest -- 2 failed -- first: ws-evaluated-default-rule-is-average
RED   [ENGINE] s.14 readings dropped from the reason -- 16 failed -- first: ms-preference-average-points
RED   [ENGINE] cost P-label reversal dropped from the basis -- 1 failed -- first: lead decisions: every s.14 reason states the readings, and the cost P-label reversal is in the basis
RED   [ORACLE] oracle pass mark exclusive -- 4 failed -- first: ws-technical
RED   [ORACLE] oracle average rule as the highest -- 9 failed -- first: ws-evaluated-average
RED   [ORACLE] oracle s.14 lead 6 points -- 2 failed -- first: s14-group-edge-1pct-in
RED   [ORACLE] oracle id tie-break reversed -- 4 failed -- first: ec-schedule-boundaries
RED   [ORACLE] oracle measure not checked -- 1 failed -- first: nc-refuse-measure-mismatch
RED   [ORACLE] oracle ALB sample standard deviation -- 2 failed -- first: wb-alb-annex-i-example-1-relative
RED   [ORACLE] oracle s.14 group within 2% -- 1 failed -- first: s14-group-edge-just-out
```

## Foundation findings repair (2026-09-26, branch fix/tender-foundation-findings)

The SC2 course foundation found four wording and consistency defects; all
repaired before lessons, with no award or graded value changing (all 141
earlier goldens keep every non-message value; 16 change message text only).

1. Counts agree with their units: weeks ("1 week", "2 weeks") in every
   schedule reason, basis and exclusion, and percentage points in the s.14
   lead. The gate scans every golden output for "1 weeks", "1 percentage
   points", "1 bids", "1 prices", "1 iterations" and "1 years".
2. The uncited omission option reads "the 'highest' option, which the cited
   texts do not use" (it read as an "X, not Y" contrastive); the refusal says
   "an option the cited texts do not use". The gate scans every output for
   ", not " and for em and en dashes.
3. The s.14 reason when the runner-up has no Nigerian content states the 5%
   test once ("30% against 0% (LOW), a runner-up with no Nigerian content, at
   least 5% higher, so ...").
4. Shared highest content (and the runner-up) are decided on the engine's
   12-significant-digit tie key, as every other ranking in tender.js: 65 and
   65.00000000000001 share the highest content, so no single bid leads
   (golden `s14-shared-highest-at-12-digits`).

New goldens: `s14-shared-highest-at-12-digits`, `s14-lead-1-percentage-point`,
`ec-one-week-late`, `ec-one-week-beyond-minimum`. New negative-control plants:
exact-equality shared highest, week count without agreement, the zero
runner-up reason repeating itself, the highest option worded as a
contrastive; the two plants whose targets moved were re-aimed and re-run red.
Negative control on this branch: 58/58 engine plants red, 7/7 oracle plants
caught.

## Open questions for the lead

1. Later NCDMB targets: the engine carries the 2010 Schedule only; any
   Board-revised target must be read and cited first.
