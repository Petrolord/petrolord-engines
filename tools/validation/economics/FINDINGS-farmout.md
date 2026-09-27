# FINDINGS: farmout (oracle_farmout.py, Economics EC10, farm-ins, farm-outs and asset valuation)

Engine: `engines/economics/farmout.js`. Golden: `test-data/economics/goldens/farmout_cases.json`, 124 cases (61 refusals, every message pinned), written by `tools/validation/economics/oracle_farmout.py`. Gate: `__tests__/economics.farmout.test.js` (152 tests) calls the engine on every golden, checks the published figures (Penn State EME 801 Table 6.1 and its EMV working; AOI Regulations 2024 reg. 19 rates and days), the fixture wiring (the deal's assignor fees are the fixture's consent fee; the risk positions are the engine's own deal payoffs) and planted situations, proves the canonical engines are called (source imports; developmentCarry against jointVenture.carryRecovery, backInRight against jointVenture.backIn, riskSharing against portfolio.portfolioRiskMetrics), runs property and boundary tests and pins the course strings. Negative control: `negcontrol_farmout.sh`, 31/31 engine plants red, 6/6 oracle plants caught, 0 skipped. Timing: `timing_farmout.js`. Fixtures: `test-data/economics/ekene-farmout/` (make_farmout_fixtures.py). Full engines suite after `npm ci`: 232 suites, 18,132 tests passed (1 skipped, 1 todo, outside this wave).

The oracle is stdlib only (fractions, decimal, datetime, math), reads no JavaScript, imports nothing from the engines, and takes a different road: Fractions throughout; the cost split as a dollar ledger (the gross cost cut into promoted segment and excess, each with its own payer table); EMV straight from the payoffs (no tree); interest x value (no applyJV); NPV as an exact Fraction sum; the break-even promote by 200 exact bisections; Bayes on Fractions; the chance of a loss exactly by enumerating every success/failure combination (normal CDF for a stated spread), against which the gate holds the engine's seeded Monte Carlo in a 5-sigma binomial band (and its low/high cases where the discrete distribution puts them 0.02 clear of a cumulative boundary); datetime day counts. For the development carry and back-in the witness is the EC9 oracle, imported, on the post-deal interests this oracle builds.

No new NPV, EMV, VOI, Monte Carlo or carry arithmetic: applyJV and npv (cashflow.ts), rollback, evpi, evii (decisionTree.js), portfolioRiskMetrics (portfolio.js), calculatePartnerCosts (afe.js), carryRecovery and backIn (jointVenture.js). The gate refuses Math.random, Math.pow or ** in the engine source.

Print rule: money in reasons rounded to the cent, a computed percentage, probability or ratio to 6 decimal places, both half away from zero with trailing zeros dropped; stated inputs print as given; fields keep full precision. The oracle stops within 1e-6 of a rounding tie. (EC9 printed shortest round-trip; the break-even and posterior quotients carry order-of-operation noise in their last digits.)

## Sources (all read 2026-09-27)

Copies kept outside the repo with the course wave kit (PIA with the EC7 kit). Licensed forms (AIPN model farmout, AAPL, CAPL) not used or quoted.

| # | text | edition / date | URL | sha256 (16) | used for |
|---|---|---|---|---|---|
| 1 | Petroleum Industry Act 2021 (Act No. 6) | Gazette No. 142 Vol. 108, 27 Aug 2021 | https://ngfcp.nuprc.gov.ng/wp-content/uploads/2022/09/Petroleum-Industry-Act-2021-pdf-searchable.pdf | 5d158ca8a16f00b2 | s.94(8)(b) farm-out defined; s.94(4)(b),(5) marginal field farm-out (Commission consent, farmee FDP); s.95(1)-(15) Minister's consent, change of control above 50% is an assignment, 60 days, fee a percentage of transaction value not tax deductible (s.95(12)), disclosure (s.95(13)), PEL needs the Commission's consent (s.95(15)); s.233(10) farm-out D&A plan (concept); s.264(f), s.302(12)(c) fees for assigning rights not deductible |
| 2 | Nigerian Upstream Petroleum (Assignment of Interests) Regulations, 2024 | S.I. No. 67 of 2024, made 13 Mar 2024, Gazette No. 61 Vol. 111, 9 Apr 2024 (file named "2023") | https://www.nuprc.gov.ng/upload/nuprc_laws/Nigerian_Upstream_Petroleum_Assignment_of_Interest_Regulations_2023_c66f0732c3436c05396b2258.pdf | af705aca5707b7ad | reg. 3, 4; reg. 16-18 (PEL: Commission's consent, 60 days); reg. 19(2) seven per cent = 2% processing + 5% premium, intra group 2%; 19(3) value of the transaction; 19(5) not tax deductible; 19(7)-(9) 90 days, 30 more, 0.01%/day straight line for 90 days then consent deemed withdrawn; reg. 24 interpretation (Petroleum Agreement includes farm-in agreements; the gazette prints Interpretation as reg. 24 in both the arrangement and the body) |
| 3 | HMRC Oil Taxation Manual (OGL v3.0) | OT30020 2019-08-08, OT30021 2021-02-02, OT30022 2023-07-19, OT30023 2021-02-02, OT30048 2019-05-01, OT30081 2019-05-01, OT30131 2019-04-02, OT18320 2019-01-23, OT18360 2019-01-23 | https://www.gov.uk/hmrc-internal-manuals/oil-taxation-manual/ot30021 (and siblings) | ot30021 5a6712149a249bf2, ot18360 68a35945c48dd12f | farm in vs earn in, work programme as consideration, cash reimbursement of sunk costs (OT30021, OT30081); farmer in bears both shares (OT30048); development carry recovered from the farmer out's production usually with simple interest (OT30022, OT18360); forms of consideration (OT18320); subordinated interests valued with probability (OT30131) |
| 4 | Penn State EME 801, Lesson 6 "Expected Monetary Value and Value at Risk" | online course page, CC BY-NC-SA 4.0 | https://courses.ems.psu.edu/eme801/node/578 | 191c65725eb41d52 | Table 6.1 (drill yourself -250,000 / 500,000; farm out 0 / 50,000), P(dry) 0.65, EMV 12,500 and 17,500, VaR: the published golden (deal-psu-eme801, risk-psu, interest-psu-10pct). Numbers used as a cited check only; the licence is non-commercial, so the course does not quote its prose (lead decision 2026-09-27). |

Not used: ATO MT 2012/1 (403 from this machine), World Bank WPS4724 (403), SEC EDGAR farmout exhibits (contracts, not worked examples). No public text prints a farm-in schedule or a break-even promote: those goldens come from the stated deal arithmetic in the oracle.

## Published example

Sole farmor; well 250,000 in both outcomes; producer worth 750,000 at 100% before the well; farming out, the partner pays the whole well and the farmor keeps 1/15. Engine: drill alone -250,000 / 500,000, EMV 12,500; farm out 0 / 50,000, EMV 17,500; farm out chosen. The driller's side (not printed): 450,000 / -250,000, EMV -5,000; 17,500 - 5,000 = 12,500. VaR: drilling loses 250,000 with 65% chance (MC 0.65 within 0.01, 50,000 draws, seed 7). The page calls the table both 6.1 and 10.1 (source slip).

## Figures in the engine

2% processing, 5% premium (reg. 19(2)); intra group 2% (reg. 19(2) proviso); PEL fee not set by reg. 19(2), refused under basis "nuprc-2024-r19" (reg. 16; PIA s.95(15)); 90 days (19(7)); 30 days (19(8)); 0.01%/day for 90 days then withdrawn (19(9)); not tax deductible (19(5); PIA s.95(12), s.264(f), s.302(12)(c)); change of control above 50% (PIA s.95(3),(14), reported). Every deal term: stated input, no default.

## Decisions and readings

1. Promote points = share of gross cost paid minus the interest held after the event (cumulative); ratio = paid / held. Negative promote refused; heads-up allowed; the farminee never pays more than the farmor's own pre-deal share.
2. Carry = farminee pays - held interest x gross cost. Under farmor-side overrun it falls with the excess and is reported as computed.
3. Caps: gross-cost (promote up to the cap, excess by a stated rule: post-deal interests or farmor side), carry-amount (carry held at the cap, farmor pays the rest), none. Equal to the cap = "exactly" (inside).
4. Vesting per-event (farm in) or all-events (earn in), HMRC OT30021. Payments count for completed events; every event's split is reported as the obligation.
5. Consideration = carry + bonus + reimbursement. Equivalent WI = farminee outlay (share + bonus + reimbursement) / gross cost of completed events; promote-adjusted ratio = that / vested interest (ours, stated).
6. Valuation timing: success-case value = 100% NPV of the development excluding the earning well; well costs, bonus, reimbursement and fees at the valuation date, undiscounted.
7. WI scaling = applyJV with no royalty, tax, cost or loss relief, year by year before npv when flows are stated.
8. EMV by rollback (decisionTree.js); farmor: drill alone / farm out / walk away (0); farminee: farm in / decline (0); ties reported with the tree's band.
9. Transfer identity reported (transfer.difference) and property-tested.
10. Break-even promote = the largest share paid with farminee EMV >= 0, exact on piecewise-linear segments (breakpoints: earned interest, farmor interest, carry-cap kinks). Statuses: solved, negative-without-promote, positive-at-farmor-share.
11. Break-even chance p* = -dry / (success - dry) when signs differ; never-negative / never-positive otherwise.
12. VOI via evpi/evii (likelihood form); voi.js not called (legacy posterior-typed form that delegates to them).
13. Risk via portfolioRiskMetrics (lib/stats mulberry32; p90 low, p10 high per percentile.js); montecarlo.ts not called (EPE cash-flow MC). Work cap iterations x holdings <= 500,000.
14. screening.js / breakeven.js not called (mid-year screening NPV and a price bisection); the break-evens are exact linear solves on EMV.
15. Price for an interest: value per percent = 100% figure / 100, risked (EMV of the 100% position) or success case, valueBasis stated; transaction metrics are ratios of stated inputs, reported only; no ratio when value per percent <= 0.
16. Consent fee: days from notification to payment: <= 90 on time, 91-120 grace, 121-210 surcharged (days - 120), >= 211 deemed withdrawn. Value of the transaction is a stated input (lead decision 2026-09-27: the course teaches reg. 19(3)'s definition and states the input).
17. developmentCarry / backInRight call jointVenture.js on the post-deal interests; its refusals keep their wording with the field renamed.

## Boundary table

| rule | at the boundary | one past | golden |
|---|---|---|---|
| gross-cost cap | "exactly", excess 0 | "exceeded", excess by rule | earn-cap-gross-exactly / -exceeded-post |
| carry-amount cap | "exactly", whole promote paid | held at the cap | earn-cap-carry-exactly / -exceeded; fixture appraisal well |
| carry cap 0 | own share only | | earn-cap-carry-zero |
| promote at break-even | farminee EMV 0, "a tie between farm in, decline" | +0.5 points: decline | deal-promote-exactly-break-even / -just-above |
| break-even at farmor's share | solved at that share | positive-at-farmor-share | deal-break-even-at-farmor-share, deal-positive-at-farmor-share |
| no promote breaks even | negative heads-up | | deal-negative-without-promote |
| dry hole (0%) | EMV = dry position; farmor walks away | | deal-ekene-dry-hole |
| certain success | EMV = success position | | deal-ekene-certain |
| cash bonus 0 | stated and said | | deal-ekene-bonus-zero |
| vesting | all done: whole interest | one short (all-events): nothing | earn-ekene-drill-to-earn(-done) |
| promote 0 | allowed | below 0 refused | earn-heads-up, earn-refuse-negative-promote |
| earn the farmor's whole interest | allowed | above refused; dev carry needs the farmor to keep one | earn-all-of-farmor, devcarry-refuse-earn-all |
| fee day 90 / 120 / 210 | on time / grace / 90 surcharge days | 91 grace / 121 one day / 211 withdrawn | fee-day-* |
| uninformative signal | EVII 0 | | info-uninformative |
| carry recovered exactly | payout that year | | devcarry-recovered-exactly |

## Caps and timing

20 parties, 20 events, 100 years, 10 signals, 10 positions of 50 holdings, 200,000 draws with iterations x holdings <= 500,000, 10 reserve categories. Timing (ms): dealValue 4-22; earningObligation (20 events) 3; informationValue (10 signals) 5; riskSharing 20,000 draws x 3 holdings 629, at the work cap 3,426 (portfolioRiskMetrics runs about 5-7 microseconds a holding draw; before the cap 10 x 50 holdings at 200,000 draws took 469 s); developmentCarry 5; consentFee and interestValue under 1.

## Negative control (31/31 engine red, 6/6 oracle caught; 33/33 after the negative-carry fix; 35/35 after the printed-bound fix)

Lead's defects: promote on the wrong base (points on the event's own interest; ratio over the farmor's retained interest), carry cap ignored (carry-amount; gross-cost), cash bonus double-counted (farminee positions; consideration), EMV without dry-hole cost (farminee; farmor alone; 100% position), break-even promote solved on the farmor's EMV, NPV-per-percent on unrisked value (price basis; risked figure), WI scaling applied twice (stated NPV; cash flows; priced interest). Also: overrun rules swapped, all-events vesting per event, cap exactly read as exceeded, farmor keeps its whole interest, assignor fees dropped, break-even chance wrong side, VOI likelihoods swapped, MC seed ignored, MC work cap ignored, intra group premium charged, day 90 late, surcharge 0.1%/day, day 210 withdrawn, unknown keys ignored, money float noise, unit agreement dropped. Oracle plants: excess by farmor side, bonus left out, bisection wrong half, dry-hole posterior, premium 4%, unknown keys ignored (STOP).

## Refusals (61, all pinned in the goldens) and reasons

The golden file carries every message. The gate pins, for example:

- "break-even promote: FIN's EMV is 0 when it pays 35.594574% of the well for 30% (a promote of 5.594574 points)"
- "vesting \"all-events\": 1 of 2 events completed; nothing vests"
- "paid 121 days after the notification: 1 day after the 90 + 30 days; surcharge 0.01% of 392000 x 1 day = 39.2 (reg. 19(9), straight line)"
- "iterations must be at most 166666 for 3 holdings in all (iterations x holdings at most 500000); got 200000"

## Lead decisions (2026-09-27)

1. This file was committed by the lead with the owner's approval (the wave agent could not create it).
2. Simple-interest uplift on a development carry (OT18360): added to jointVenture.carryRecovery in a follow-up PR; no existing value moves.
3. Penn State EME 801: numbers used as a cited check; prose not quoted (non-commercial licence).
4. Consent fee "value of the transaction": a stated input; the course teaches reg. 19(3)'s definition.

## Negative carry refused (fix/farmout-negative-carry, 2026-09-27)

Found by the EC10 course writers: under a gross-cost cap with overrunRule "farmor-side", a share paid below the farminee's held share of the whole gross cost gave a NEGATIVE carry and a negative consideration with no refusal (earn-cap-gross-exceeded-farmor-side at a share of 30 gave a carry of -2400000). The engine already refused a negative promote; it now also refuses a negative carry.

- Rule: an event's carry (what the farminee pays minus its held interest, cumulative over the events, of that event's gross cost) must be at or above 0. Only the farmor-side overrun rule can make it negative (under the post-deal rule the carry is the promote on the promoted cost, and under a carry-amount cap it is the lesser of the promote and a cap of 0 or more), so the check runs there and is exact: refused when share paid x promoted cost < held share x gross cost. A carry of exactly 0 is allowed.
- Where: earningObligation (every event, field `events[i].farmineePaysPct`) and dealValue / informationValue (the stated deal on the success well cost, then the dry-hole cost, field `deal.farmineePaysPct`).
- Message (names the share paid, the held share of the gross cost and the resulting carry): `events[0].farmineePaysPct must be at or above 36, the share at which the carry is 0 when the farmor side pays the excess: paying 30% of the promoted 40000000 (12000000) against its held 30% of the gross cost 48000000 (14400000) leaves a carry of -2400000; got 30`. The minimum share prints to 6 places (31.363636 on the Ekene deal).
- Goldens: 8 added (133 cases, 67 refusals): earn-carry-zero-farmor-side and deal-carry-zero-farmor-side (the boundary, carry exactly 0 at a share of 36), earn-refuse-negative-carry-one-below and deal-refuse-negative-carry-one-below (35), earn-refuse-negative-carry-probe (the writers' probe, 30), earn-refuse-negative-carry-second-event (a drill-to-earn second event, held 30% cumulative), deal-refuse-negative-carry-ekene and info-refuse-negative-carry (31 on the Ekene deal with a farmor-side cap). No existing golden value moved: all 125 earlier cases are byte-identical after regeneration (checked by id).
- Gate: 162 tests (a boundary test pins the message and asserts no carry below 0 in any golden). Negative control: two plants added, "negative carry accepted" and "a carry of exactly 0 refused".
- Not changed: the break-even promote search still spans shares from the earned interest up to the farmor's interest, so under a farmor-side cap its breakpoint table can include shares that would now be refused as a stated deal (deal-ekene-farmor-side lists 30, below its minimum of 31.363636). Its solved value lies above the minimum in every golden. Starting the search at the minimum share would move existing golden values, so it is left for the lead to decide.

## Printed bounds are accepted when stated back (fix/farmout-min-share-print, 2026-09-27)

Found by the EC10 Professional audit: the negative-carry refusal printed "must be at or above 31.363636", but stating 31.363636 back was refused ("leaves a carry of -0.16; got 31.363636"), because the exact minimum is 30 x 46/44 = 31.3636...36... and the print rule rounded it to the NEAREST sixth decimal, which here is below it.

- Rule: every minimum or maximum a farmout.js refusal prints is the 6-decimal figure nearest the exact bound on the ACCEPTED side (up for a minimum, down for a maximum), then checked against the refusal's own rule (and moved one step when the double of the printed figure would still be refused, or one step nearer when the nearer figure's double is accepted), so typing the printed figure back passes that rule. When the printed figure differs from the exact bound the message says "(rounded up at the sixth decimal so that it is accepted)" or "(rounded down ...)".
- Bounds covered: the negative-carry minimum share (`events[i].farmineePaysPct`, `deal.farmineePaysPct`), the promote-of-0 minimum share (the held interest), and the maximum earned interest (the farmor's interest less what was earned). The other printed limits are stated inputs or integers (the farmor's interest, the iterations cap, which is already floored).
- Goldens: 7 added (140 cases, 71 refusals): earn-refuse-promote-ceiling-refused (held 0.1 + 1.03, whose double lies above 1.13: 1.13 itself is refused, so the minimum prints 1.130001; this is the case the rule check exists for), deal-negative-carry-printed-minimum-accepted (31.363637 accepted), deal-refuse-negative-carry-one-print-step-below (31.363636 refused, carry -0.16), earn-promote-printed-minimum-accepted and earn-refuse-promote-below-inexact-held (held 10.1 + 20.2: minimum printed 30.3, rounded up; 30.299999 refused), earn-earned-printed-maximum-accepted and earn-refuse-earned-above-inexact-rest (70 less 50.1: the maximum prints 19.9, whose double is the exact bound, and 19.9 is accepted). Moved: only the message text of deal-refuse-negative-carry-ekene and info-refuse-negative-carry (31.363636 became "31.363637 (rounded up at the sixth decimal so that it is accepted)"); every other field of every earlier golden, and every other earlier golden, is byte-identical to main's (133 cases compared by id).
- Gate: 169 tests; a property test takes every refusal on farmineePaysPct or earnedPct that prints a bound, states that bound back through the engine, and requires that rule to pass. Negative control: two plants added, "printed minimum rounded to nearest" and "printed bound only rounded, never checked against the rule".

## Open

ATO MT 2012/1 might supply a published farm-in schedule if it can be fetched from elsewhere.
