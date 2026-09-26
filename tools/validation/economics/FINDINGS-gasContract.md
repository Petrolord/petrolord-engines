# FINDINGS: gasContract (oracle_gascontract.py, Economics EC8, gas sales agreements)

Engine: `engines/economics/gasContract.js` (the brief allowed another name; it
is `gasContract.js`). Golden: `test-data/economics/goldens/gascontract_cases.json`,
185 cases (84 of them refusals, every refusal message pinned in full),
written by `tools/validation/economics/oracle_gascontract.py`. Gate:
`__tests__/economics.gasContract.test.js` (219 tests) calls the engine on
every golden, checks the published figures against their printed values,
checks the planted fixture situations and the wiring, and runs property tests.
Negative control: `negcontrol_gascontract.sh` (56/56 engine plants red, 6/6 oracle plants caught). Timing:
`timing_gascontract.js` (table below). Fixtures: `test-data/economics/ekene-gsa/`,
written by `make_gsa_fixtures.py`. Full engines suite on the branch: 230 suites passed, 17,774 tests passed (after `npm ci` in the worktree). Before `npm ci` the worktree had no node_modules and 9 suites (7 CRS, 2 downstream copy-rule) could not resolve `proj4` and `@babel/parser`; a clean checkout of origin/main run the same way failed the same 9 suites with the same messages (9 failed, 2 tests failed, 218 passed), so that was environment only. CI on the PR is green.

The oracle is STDLIB ONLY (python 3: `fractions`, `decimal`, `math`,
`datetime`). It reads no JavaScript and takes a different road: quantities
and money as exact Fractions of the input doubles; the take-or-pay year as the
Model GSA formulas evaluated as written over a dated ledger of entries
(deficiency year, last year, quantity); the 4-decimal rule on Decimal digits;
the gas royalty rate re-derived from the PIA Seventh Schedule para 10(6)
without importing `cashflow.ts`; NPV as an exact Fraction sum. Figures printed
inside a message are the double nearest the exact value; the one figure the
engine prints from a chain of doubles (the negative-price refusal) is replayed
in doubles in the engine's stated order. The fixtures keep quantities whole so
that printed quantities agree exactly.

No new NPV or Monte Carlo: the engine imports `npv`, `deriveGasRoyaltyRate`
and `calendarDays` from `engines/economics/cashflow.ts`; nothing here samples.

## Sources (all read 2026-09-26)

Every legal or regulatory figure in the engine is cited to the section or
schedule it was read from; every figure that could not be read from a public
text is a required user input. Copies were fetched and converted with
`pdftotext -layout` (the HMRC pages through the GOV.UK content API) on
2026-09-26; copies are kept in `/root/cat-wip-gsa/sources/`. Licensed model
contracts (AIPN) were not used or quoted. The Commonwealth model GSA is
published under Creative Commons Attribution 4.0 and may be quoted with
attribution.

| # | text | edition / date | URL | sha256 (first 16) | used for |
|---|---|---|---|---|---|
| 1 | Petroleum Industry Act 2021 (Act No. 6) | Official Gazette No. 142, Vol. 108, 27 August 2021 (the EC7 copy, `/root/cat-wip-pia/sources/pia_nuprc.txt`) | https://ngfcp.nuprc.gov.ng/wp-content/uploads/2022/09/Petroleum-Industry-Act-2021-pdf-searchable.pdf | 5d158ca8a16f00b2 | s.104 and s.105 (flaring: a fine by regulation, no rate in the Act); s.110 (DGDO: (1) allocation, (2) deemed fulfilment by voluntary contracts "equal to or higher", (8) US$3.50 per MMBtu not delivered, (9) adjustable by regulation, (10)(a) to (d) the excuses, (13) compensation, (14)(a) and (15) export consequences, (16) earlier contracts count); s.167 ((1) the domestic base price each year, (5) power at the base price, (6) commercial at the base price + US$0.50 per MMBtu, (7) gas distributors not above the commercial price, (8) transport added); s.168 ((2) floor US$0.90 per MMBtu, (3) ceiling the domestic base price, (4) transport added); s.173; Third Schedule (base price principles, three tiers); Fourth Schedule (CP = NRP x (1 + EPF) <= EPP, EPF = (CMPP - PRP) / PRP, NRP US$1/MMBtu, PRP US$250/MT for ammonia, urea, methanol and polypropylene, US$325/MT for low sulphur diesel (GTL)); Seventh Schedule para 10(6) (gas royalty, through `cashflow.ts`) |
| 2 | Domestic Gas Delivery Obligation Regulations 2022 (S.I. No. 74 of 2022) | Official Gazette No. 206, Vol. 109, Lagos 23 November 2022, pages B3221 to B3233; made and commenced 18 November 2022 | https://www.nuprc.gov.ng/upload/nuprc_laws/Upstream_Petroleum_Domestic_Gas_Delivery_Regulation_2022_03ec5aaa331c150184d83be9.pdf (listed at https://www.nuprc.gov.ng/laws/regulations/gazetted) | e68043a684ad7906 | r.6(1) US$3.50 per MMBtu not delivered; r.6(2) under a signed agreement the penalty is not less than that amount; r.6(3) and (4) the 90-day investigation (not computed); r.4 and r.5 the supply curve and allocation (concept); r.9 definitions (strategic sectors) |
| 3 | NMDPRA domestic base price 2026 (and 2025) | circular effective 1 April 2026, signed by the Authority's chief executive, AS REPORTED: base price and power price US$2.18/MMBtu, commercial US$2.68/MMBtu, gas based industries floor US$0.90 and ceiling US$2.18 (previously US$2.13 and US$2.63 from 1 April 2025). The regulator's own circular was NOT retrieved: the NMDPRA site is a script application with no fetchable document | BusinessDay, 31 March 2026: https://businessday.ng/energy/oilandgas/article/nigeria-raises-gas-price-for-power-companies-to-2-18-mmbtu/ ; Advocaat Law Practice through Legal 500, 7 April 2026: https://www.legal500.com/intelligence/nigeria/energy-and-natural-resources/the-nigerian-midstream-and-downstream-petroleum-regulatory-authority-nmdpra-establishes-2026-domestic-base-price-and-wholesale-pricing-framework-for-natural-gas-for-the-strategic-sectors | web pages | the base price is a REQUIRED input of `domesticPrice`; the reported figures are published goldens for the s.167 arithmetic and the fixture's stated planning assumption |
| 4 | Commonwealth Secretariat, Gas Sales Agreement, Contract 2 in the Commonwealth Model Contract Series | 2025, CC BY 4.0 | https://comsec-web-static.s3.eu-west-1.amazonaws.com/s3fs-public/2025-07/cw-model-contract_2_gas-sales-agreement_0.pdf | 01377cbc13be37ef | definitions: ACQ = sum of DCQ; Adjusted ACQ = sum DCQ - SMQ - FMQ - SFQ (- OFC); TOPQ = a stated % of the Adjusted ACQ; BADQ = TOPQ - AAQ (- excess gas); BASQ = AAQ - MUQ - AdjACQ; MUA and CFA as sums over prior contract years less taken and expired; SFQ = (PNQ - DTQ) - DAQ; MaxDCQ = a stated % of DCQ. Articles 12.5 (shortfall remedies), 12.6 (BDP = BADQ x TOPP, or (BADQ - CFCQ) x TOPP), 12.7 (make-up after the Adjusted ACQ, FIFO, expiry, end of term: forfeit, refund at the last TOPP, or extend), 12.8 (carry-forward, cap, FIFO), 15.1 (CP = BP x sum WF x Index(p) / Index(i), Index(p) the average of N months ending one month before the review month), 15.2.6 (TOPP: the average monthly CP, the last month's CP, or a % of it), 15.4 (5 decimals, final 4 decimals half up), 15.8 (index floor and ceiling) |
| 5 | ESMAP Report 152/93, Long-term Gas Contracts: Principles and Applications | January 1993 (World Bank / UNDP, public) | https://documents1.worldbank.org/curated/en/976211468767389099/pdf/multi-page.pdf | d6641df00b622f33 | paras 6.52 (daily availability, for example 140% of the daily quantity), 6.55 to 6.58 (minimum pay as prepayment; make-up rights usually lapse after 3 to 5 years; make-up gas free or at variable cost), 6.59 (make-up normally after the minimum-pay quantity for the year is taken), 6.61 and 6.62 (carry-forward of takes above the minimum pay, expiring, capped) |
| 6 | HMRC Oil Taxation Manual OT05435 and OT05402 | both updated 19 December 2019 (GOV.UK, Open Government Licence) | https://www.gov.uk/hmrc-internal-manuals/oil-taxation-manual/ot05435 and .../ot05402 | 096c728cc1d37fea; 9441a9ddb096a879 | OT05435: make-up in priority over the period's amount, or only after the period minimum; a time limit; FIFO or averaging of the prepaid value. OT05402: effective swing = swing factor / take-or-pay level, printed 150 / 90 = 1.66 and a factor of 6.6 |
| 7 | Energy Charter Secretariat, Putting a Price on Energy: International Pricing Mechanisms for Oil and Gas | 2007 | https://www.energycharter.org/fileadmin/DocumentsMedia/Thematic/Oil_and_Gas_Pricing_2007_en.pdf | 1031d9df8a573700 | Box 8 (netback formula; averaging and lag "to be defined"), Box 9 (price review), section 4.5.3.3 (P = A x JCC + B; heat-equivalence slope printed 0.172; Figure 51: A 0.1485, B 0.80, floor at 15 and cap at 30 US$/bbl) |
| 8 | OIES Paper NG 175, International Gas Contracts (A. Ason) | 2022 | https://www.oxfordenergy.org/wpcms/wp-content/uploads/2022/11/International-Gas-Contracts.pdf | e0f4b3fcc704554e | take-or-pay 70 to 95 per cent of ACQ; downward quantity tolerance up to 10 per cent; P = Po x [f x An]; PLNG = A x P(crude) + B; the US CSP = 1.15 x HH + Xy; force majeure relieves the take-or-pay obligation |
| 9 | CLDP and US DOE, Understanding Natural Gas and LNG Options | edition current as of October 2017 (US government, public) | https://www.energy.gov/ia/articles/understanding-natural-gas-and-lng-options-handbook-0 | 47dd9718e1355f43 | glossary: Take or Pay (the obligation is the ACQ less the seller's shortfall less the downward quantity tolerance), Carry Forward, DQT; the S-curve and the price reopener as concept |
| 10 | NIST Special Publication 811 | 2008 edition, Appendix B | https://www.nist.gov/pml/special-publication-811 | not downloaded | British thermal unit (International Table) = 1.055 056 E+03 J; the engine uses the exact defining value 1055.05585262 J |
| 11 | EIA, Energy conversion calculators | page read 2026-09-26 | https://www.eia.gov/energyexplained/units-and-calculators/energy-conversion-calculators.php | web page | 1 barrel of crude oil = 5,689,000 Btu (2026 US production estimate); used for the case `parity-eia-2026` |
| 12 | NUPRC, Gas Flaring, Venting and Methane Emissions (Prevention of Waste and Pollution) Regulations 2023 | the copy on the NUPRC gazetted page is UNNUMBERED AND UNDATED (Gazette No. 00, S.I. number and date blank, "MADE at Abuja this ... day of ..., 2023") | https://www.nuprc.gov.ng/upload/nuprc_laws/Gas_Flaring_Venting_and_Methane_Reg_2023_cd4e70a88c3295914a6466e9.pdf | 9a3a57b8fac5dbc7 | r.16(1) prints USD 3.50 per 1,000 standard cubic feet (28.317 standard cubic metres) for unauthorised flaring. NOT implemented (open question 2) |

### Every figure in the engine and where it comes from

| figure | value | source |
|---|---|---|
| DGDO penalty | US$3.50 per MMBtu not delivered | PIA s.110(8); DGDO Regulations r.6(1) |
| DGDO penalty under a signed agreement | the agreement's rate, at least US$3.50 | PIA s.110(8) proviso read with r.6(2) (a reading, stated in the basis) |
| commercial sector price | domestic base price + US$0.50 per MMBtu | PIA s.167(6) |
| gas distributor ceiling | the commercial sector price | PIA s.167(7) |
| gas based industries floor | US$0.90 per MMBtu | PIA s.168(2) |
| gas based industries ceiling | the domestic base price | PIA s.168(3); Fourth Schedule (EPP) |
| NRP | US$1 per MMBtu for every listed end product | PIA Fourth Schedule |
| PRP | US$250/MT (ammonia, urea, methanol, polypropylene), US$325/MT (low sulphur diesel GTL) | PIA Fourth Schedule |
| gas royalty | 5%, 2.5% on gas utilised in-country | PIA Seventh Schedule para 10(6), imported from `cashflow.ts` |
| Btu (IT) | 1055.05585262 J | NIST SP 811 Appendix B (exact by definition) |
| cubic foot | 0.028316846592 m3 | (0.3048 m)^3, exact |
| domestic base price | REQUIRED INPUT | the Authority determines it each year (s.167(1)); no default |
| NRP and PRP override | optional `schedule { nrp, prp, source }`, source required | the Authority may change them by regulation (Fourth Schedule) |
| DGDO rate adjustment | optional `penaltyRate { value, source }`, source required | s.110(9) |
| TOP %, MaxDCQ %, make-up period, recovery order, end-of-term rule, carry-forward terms, every price, the seller shortfall rate | REQUIRED contract inputs, no defaults | the contract states them; the Model GSA leaves each as [## INSERT] |

## Fixtures (synthetic, ours)

`test-data/economics/ekene-gsa/domestic-power.json` (the Ekene Power Plant,
2027 to 2034, DCQ 21,000 MMBtu/d, TOP 80%, make-up 3 years after the Adjusted
ACQ, forfeit at the end, the power price = the domestic base price held at the
reported 2026 US$2.18 as a stated planning assumption, seller shortfall at a
stated 1.25; a January 2027 day by day; the 2028 DGDO) and `export-feed.json`
(the Ekene Export Feed Buyer, 2027 to 2036, DCQ 63,000 MMBtu/d, TOP 90%,
make-up 5 years after the TOPQ, refund at the end, carry-forward 3 years
capped at 50% of a deficiency, an oil-indexed S-curve price on a synthetic oil
index with a 6-month average, a 1-month lag, a quarterly reset, 4-decimal
rounding and two reopeners). The README lists every planted situation and the
gate asserts each one. Onshore terrain, as the EC7 Ekene onshore cases; the
Ekene oil field's associated gas volumes are not used.

## Published figures (goldens, printed values beside)

No freely available public text found on 2026-09-26 prints a multi-year
take-or-pay and make-up worked table (the texts that do are licensed, AIPN and
Roberts 2020, or paywalled, Energy Economics 2018). The ledger goldens are
therefore oracle goldens from the Model GSA clause arithmetic (source 4) with
the recovery orders of ESMAP and HMRC (sources 5 and 6). The printed figures
the gate checks:

| case | source | printed | engine |
|---|---|---|---|
| `cq-hmrc-ot05402-effective-swing` | HMRC OT05402 | 150 / 90 = 1.66; a factor of 6.6 | 1.6666666666666667 (the manual truncates: printed alike is not equal) |
| `price-ecs-figure-51` | ECS 2007 Figure 51 | A 0.1485, B 0.80, floor at 15, cap at 30, axis 2.50 to 5.50 | flat 3.0275 below 15, flat 5.255 above 30, linear between |
| `parity-ecs-0172` | ECS 2007 section 4.5.3.3 | 0.172 | 1 / 5.8 = 0.1724137931034483 (5.8 MMBtu per barrel, the conventional crude heat content; 1 / 0.172 = 5.814) |
| `parity-eia-2026` | EIA (source 11) | 5,689,000 Btu per barrel | 1 / 5.689 = 0.17577781683951485 |
| `price-oies-hub-csp` | OIES NG 175 | CSP = 1.15 x HH + Xy | 1.15 per unit of HH (Xy 2.25 is ours) |
| `dp-power-2026`, `dp-commercial-2026` | reported 2026 (source 3) | 2.18 and 2.68 | 2.18 and 2.68 |
| `dp-power-2025`, `dp-commercial-2025` | reported 2025 (source 3) | 2.13 and 2.63 | 2.13 and 2.63 |

## Lead decisions (2026-09-26), applied

1. **Domestic base price**: a REQUIRED input with no default. The figures are
   stated only in this form: US$2.18 per MMBtu (power) and US$2.68 per MMBtu
   (commercial), effective 1 April 2026, reported by BusinessDay (31 March
   2026) and by Advocaat Law Practice through Legal 500 (7 April 2026); the
   regulator's circular was not read. The lead also found only secondary
   reports (TheCable, Leadership, Business Post). The course may quote them
   only in this form and never grades them. The `domesticPrice` basis carries
   the same sentence.
2. **Flare penalty**: not implemented; concept only (no dated, numbered
   public text).
3. **Readings confirmed**, each verbatim in its basis string (pinned by the
   gate):
   - `dailyBalance` basis.reading: "seller shortfall measured against the quantity the seller made available"
   - `takeOrPay` basis.reading: "make-up right equals the deficiency actually paid after any carry-forward credit" and "a last-contract-year deficiency creates no make-up right (forfeit/refund applies to earlier years' make-up only)"
   - `gsaCashFlows` basis.royalty: "royalty is charged on delivered gas value and not on deficiency payments"
4. **Recovery order**: a REQUIRED input with no default. The `takeOrPay`
   basis names 'after-adjusted-acq' as the reference text's order
   (Commonwealth model GSA Article 12.7.1); 'after-top-quantity' and 'first'
   are variants the engine also computes.
5. **Not computed** (concept only): excess gas; over-delivery;
   off-specification gas; the index rate-of-change cap (model GSA Article 15.8
   Alternative 2); the outcome of a price review (reopeners are reported only);
   the DGDO Regulations' 90-day investigation rule (r.6(3) and (4)). Also not
   computed: pre-start gas, the model GSA's extend-the-term alternative and
   carry-forward Alternative 1, customer compensation (s.110(13)), the Third
   Schedule tier allocation, the flare penalty.

## Decisions and refinements of the lead's scope

1. **Function set.** `toEnergy`, `contractQuantities`, `dailyBalance`,
   `takeOrPay`, `priceSeries`, `energyParitySlope`, `domesticPrice`,
   `domesticGasObligation`, `gsaCashFlows`. Every one refuses an unknown key at
   every level (`ACCEPTED_KEYS`), as tender.js does.
2. **One refusal wording.** "<field> must <condition>; got <value>" (the value
   as JavaScript prints it, strings quoted, an absent value as "nothing"), or
   "<field> is not an accepted key; the accepted keys ... are ...". The gate
   checks the pattern on every refusal golden.
3. **Seller shortfall reading.** The Model GSA prints SFQ = (PNQ - DTQ) - DAQ
   for a day the seller did not make the nominated quantity available. The
   engine subtracts the quantity MADE AVAILABLE, so gas made available and not
   taken never counts as the seller's shortfall. Stated in the basis.
4. **Make-up entitlement.** The entry is the deficiency quantity actually
   paid for (BADQ less any carry-forward credit); the model's MUA formula sums
   BADQ. Stated.
5. **Last contract year.** A deficiency of the last year opens no make-up
   entry (the MUA sums prior years only), and the end-of-term rule (forfeit, or
   refund at the last year's take-or-pay price, Article 12.7.5 Alternatives 1
   and 2) applies to the earlier entries still open. Without this reading the
   refund would hand back the last year's own deficiency payment. Alternative 3
   (extend the term) is not modelled.
6. **Recovery orders, all explicit (no default).** 'after-adjusted-acq'
   (Model GSA 12.7.1), 'after-top-quantity' (ESMAP 6.59; HMRC "only when the
   minimum ... has been taken"), 'first' (HMRC "in priority over that period's
   contract amount"). In the annual reconciliation the year's make-up is the
   taken quantity above the threshold (the buyer designates make-up as soon as
   it may).
7. **Carry-forward.** Off unless stated. Applied to the deficiency (Model GSA
   12.8 Alternative 2), capped at a stated % of that deficiency; the surplus is
   measured above the Adjusted ACQ (Model GSA BASQ) or above the take-or-pay
   quantity (ESMAP 6.61), as stated. Alternative 1 (reduce next year's ACQ) is
   not modelled.
8. **Not modelled** (taught as concept): excess gas (EGQ, ERQ), over-delivery,
   off-specification and pre-start gas, the operational flexibility credit as
   an election (it enters as `permittedReduction`), the index change cap
   (Article 15.8 Alternative 2), the outcome of a price review (reopeners are
   reported only), the DGDO 90-day investigation (r.6(3)) and customer
   compensation (s.110(13)), the Third Schedule tier allocation.
9. **Royalty.** On the value of gas delivered (taken x contract price) at the
   canonical `deriveGasRoyaltyRate`; a deficiency payment is money for gas not
   produced and carries none here (the gas pays when it is made up). A reading,
   stated in the basis.
10. **Btu.** The International Table Btu. The Model GSA defines its Btu at
    59 F to 60 F (about 1054.80 J, 0.02% smaller); a contract on that Btu
    should state its heating value in those units.
11. **4-decimal rounding.** The price is normalised to 12 significant digits
    before its fifth decimal decides, so float noise cannot flip the digit;
    the gate pins 11.23459 to 11.2346, 11.23449 to 11.2345 and 100.00005 to
    100.0001.
12. **Printed money.** Reasons print the double the engine holds, so the
    export refund 457950 x 8.0813 prints 3700831.3350000004. Lessons should
    quote the numeric fields at 6 decimals.

## Boundary table (per rule)

| rule | boundary | at the boundary |
|---|---|---|
| deficiency | counted = TOPQ | no deficiency (met exactly: `top-exactly-met`, power 2032) |
| make-up, 'after-adjusted-acq' | taken = Adjusted ACQ | no make-up, strictly above only (power 2030) |
| make-up, 'after-top-quantity' | taken = TOPQ | no make-up, strictly above only |
| make-up expiry | the last year of the period (y + N) | usable in that year, then the rest expires at its end (`top-makeup-on-last-day-of-period`, power 2031); nothing is available in y + N + 1 (`top-makeup-one-year-late`) |
| make-up period 0 | any deficiency | paid, no make-up right |
| last contract year | a deficiency | paid, no make-up right |
| carry-forward surplus | counted = base | no surplus, strictly above only |
| carry-forward cap | credit = cap % of the deficiency | allowed (inclusive) |
| seller shortfall (day) | (PNQ - tolerance) - available = 0 | no shortfall (`daily-tolerance-covers-the-gap`) |
| MaxDCQ | nominated = MaxDCQ | properly nominated in full; above it the excess is not properly nominated |
| force majeure + maintenance | = DCQ | allowed; the day owes nothing either way; above DCQ refused |
| zero nomination | nominated 0 with an adjusted DCQ above 0 | the whole adjusted DCQ is a buyer shortfall |
| S-curve | X = lowKink or X = highKink | on the mid line (inclusive); the curve is continuous there |
| price floor or ceiling | raw = floor or ceiling | not labelled clamped (strict) |
| basket index floor or ceiling | index = floor or ceiling | unchanged (strict) |
| 4-decimal rounding | fifth decimal 5 | rounds up |
| escalation | each anniversary of baseMonth | steps (whole years) |
| gas distributor | negotiated = the commercial price | within the ceiling (inclusive) |
| gas based industries | formula = the base price, or = 0.90 | not held (strict); the ceiling applies before the floor |
| DGDO deemed fulfilment | voluntary contracts = obligation | deemed fulfilled (inclusive: s.110(2) "equal to or higher") |
| DGDO agreement rate | = 3.50 | the agreement's rate |
| DGDO excuses | stated above the undelivered quantity | applied only up to it, in the order (a) to (d) |
| period day count | the end date | excluded (a contract year that finishes on the following 1 January) |
| maxDcqPct | = 100 | allowed |

## Caps and timing

`timing_gascontract.js`, one run on the build host, 2026-09-26 (ms per call):

| case | size | ms |
|---|---|---|
| takeOrPay with carry-forward | 30 years | 3.66 |
| gsaCashFlows | 30 years | 1.20 |
| takeOrPay with carry-forward | 100 years | 11.38 |
| gsaCashFlows | 100 years | 2.34 |
| dailyBalance | 366 days | 5.12 |
| priceSeries oil-indexed S-curve | 1,188 months priced | 22.18 |
| priceSeries basket | 1,188 months priced | 29.13 |
| takeOrPay power fixture | 8 years | 0.56 |

Caps (`DEFAULTS`): 100 contract years, 400 days in a daily balance, 1,200 index months and 1,200 priced months, 10 basket indices. At every cap a call stays well under 100 ms.

## Negative control

Run on 2026-09-26 (`negcontrol_run2.txt` in the wave dir, then the one plant it missed rerun after a golden was added). Result: **56/56 engine plants red, 6/6 oracle plants caught.** Re-run after the lead decisions (`negcontrol_run3.txt`): 56/56 red, 6/6 caught, none skipped. The first run found two holes, both fixed before this run: the 12-digit normalisation of the 4-decimal rule is an equivalent mutation at realistic magnitudes (JavaScript `toFixed(12)` already absorbs the float noise), so that plant was replaced by the real defect of rounding to 5 decimals before the rule (golden 11.234346 gives 11.2343); and the singular 'contract year' had no golden with a one-year make-up period (added `top-makeup-period-one`).

```
RED   [ENGINE] TOP base: TOPQ on the ACQ (no adjustment) -- 7 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ENGINE] FM netting: force majeure not netted from the ACQ -- 7 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ENGINE] seller shortfall not netted from the ACQ -- 4 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ENGINE] permitted reduction not netted -- 2 failed -- goldens: the engine agrees with the oracle › top-force-majeure-and-shortfall
RED   [ENGINE] make-up order: Adjusted ACQ and TOPQ thresholds swapped -- 21 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ENGINE] make-up order: 'first' waits for the Adjusted ACQ -- 3 failed -- goldens: the engine agrees with the oracle › top-order-first
RED   [ENGINE] make-up drawn last in first out -- 7 failed -- goldens: the engine agrees with the oracle › top-export
RED   [ENGINE] expiry boundary: make-up period one year longer -- 12 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ENGINE] expiry boundary: make-up period one year shorter -- 17 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ENGINE] expiry test on a later year only -- 12 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ENGINE] last-year deficiency opens a make-up entry -- 6 failed -- goldens: the engine agrees with the oracle › top-end-of-term-refund
RED   [ENGINE] end-of-term refund at the contract price -- 1 failed -- goldens: the engine agrees with the oracle › top-end-of-term-refund
RED   [ENGINE] deficiency paid at the contract price -- 2 failed -- goldens: the engine agrees with the oracle › top-end-of-term-refund
RED   [ENGINE] make-up gas invoiced at the contract price -- 14 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ENGINE] shortfall damages added to the seller -- 4 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ENGINE] carry-forward cap ignored -- 5 failed -- goldens: the engine agrees with the oracle › top-export
RED   [ENGINE] carry-forward base swapped -- 8 failed -- goldens: the engine agrees with the oracle › top-export
RED   [ENGINE] carry-forward never expires -- 5 failed -- goldens: the engine agrees with the oracle › top-export
RED   [ENGINE] seller shortfall measured against the quantity taken -- 1 failed -- goldens: the engine agrees with the oracle › daily-available-not-taken
RED   [ENGINE] delivery tolerance ignored -- 2 failed -- goldens: the engine agrees with the oracle › daily-tolerance-covers-the-gap
RED   [ENGINE] nomination not capped at MaxDCQ -- 3 failed -- goldens: the engine agrees with the oracle › daily-power-january-2027
RED   [ENGINE] force majeure does not excuse the gap -- 2 failed -- goldens: the engine agrees with the oracle › daily-fm-part-day
RED   [ENGINE] buyer-caused day counted against the seller -- 3 failed -- goldens: the engine agrees with the oracle › daily-power-january-2027
RED   [ENGINE] price lag one month longer -- 22 failed -- goldens: the engine agrees with the oracle › price-export
RED   [ENGINE] averaging divides by one month too many -- 20 failed -- goldens: the engine agrees with the oracle › price-export
RED   [ENGINE] averaging window one month short -- 22 failed -- goldens: the engine agrees with the oracle › price-export
RED   [ENGINE] reset ignored (priced monthly) -- 6 failed -- goldens: the engine agrees with the oracle › price-export
RED   [ENGINE] S-curve kink: low segment keeps the mid slope -- 4 failed -- goldens: the engine agrees with the oracle › price-ecs-figure-51
RED   [ENGINE] S-curve kink: high segment not anchored at the kink -- 4 failed -- goldens: the engine agrees with the oracle › price-ecs-figure-51
RED   [ENGINE] S-curve kink: the low kink itself in the low segment -- 3 failed -- goldens: the engine agrees with the oracle › price-ecs-figure-51
RED   [ENGINE] price floor ignored -- 1 failed -- goldens: the engine agrees with the oracle › price-oil-floor-ceiling
RED   [ENGINE] rounding: fifth decimal 5 rounds down -- 2 failed -- goldens: the engine agrees with the oracle › price-round-model-4dp
RED   [ENGINE] rounding: rounded to 5 decimals before the 4-decimal rule -- 2 failed -- goldens: the engine agrees with the oracle › price-round-model-4dp
RED   [ENGINE] basket index floor ignored -- 1 failed -- goldens: the engine agrees with the oracle › price-cw-basket-index-floors
RED   [ENGINE] escalation steps monthly -- 1 failed -- goldens: the engine agrees with the oracle › price-escalated
RED   [ENGINE] day count: every year 365 days -- 3 failed -- goldens: the engine agrees with the oracle › cq-power-2028-leap
RED   [ENGINE] period end date counted -- 2 failed -- goldens: the engine agrees with the oracle › cq-period-full-year
RED   [ENGINE] effective swing inverted -- 4 failed -- goldens: the engine agrees with the oracle › cq-hmrc-ot05402-effective-swing
RED   [ENGINE] Btu at 59 F in place of the International Table Btu -- 8 failed -- goldens: the engine agrees with the oracle › energy-power-dcq
RED   [ENGINE] cubic foot rounded to 0.0283 -- 3 failed -- goldens: the engine agrees with the oracle › energy-mixed-sm3-btu
RED   [ENGINE] commercial adder 0.6 -- 7 failed -- goldens: the engine agrees with the oracle › dp-commercial-2026
RED   [ENGINE] gas based industries floor 0.95 -- 4 failed -- goldens: the engine agrees with the oracle › dp-gbi-urea-floor
RED   [ENGINE] GTL PRP 250 -- 2 failed -- goldens: the engine agrees with the oracle › dp-gbi-gtl-diesel
RED   [ENGINE] EPF over CMPP -- 9 failed -- goldens: the engine agrees with the oracle › dp-gbi-urea-inside
RED   [ENGINE] GBI floor applied before the ceiling -- 2 failed -- goldens: the engine agrees with the oracle › dp-gbi-urea-ceiling
RED   [ENGINE] DGDO penalty 3 -- 12 failed -- goldens: the engine agrees with the oracle › dgdo-power-2028
RED   [ENGINE] DGDO agreement rate below 3.50 accepted -- 2 failed -- goldens: the engine agrees with the oracle › dgdo-agreement-below
RED   [ENGINE] DGDO deemed fulfilment strictly above -- 2 failed -- goldens: the engine agrees with the oracle › dgdo-deemed-by-contracts
RED   [ENGINE] DGDO excuses not capped at the undelivered quantity -- 1 failed -- goldens: the engine agrees with the oracle › dgdo-all-excused
RED   [ENGINE] royalty ignores the in-country share -- 3 failed -- goldens: the engine agrees with the oracle › cf-power
RED   [ENGINE] royalty charged on deficiency payments -- 3 failed -- goldens: the engine agrees with the oracle › cf-power
RED   [ENGINE] NPV discounted one year early -- 3 failed -- goldens: the engine agrees with the oracle › cf-power
RED   [ENGINE] unknown keys ignored -- 22 failed -- goldens: the engine agrees with the oracle › energy-refuse-unknown-key
RED   [ENGINE] message: make-up expiry wording -- 10 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ENGINE] message: unit agreement dropped -- red after the golden top-makeup-period-one was added (rerun with the filter "unit agreement": 1/1 red)
RED   [ENGINE] message: domestic base price refusal -- 2 failed -- goldens: the engine agrees with the oracle › dp-refuse-no-dbp
RED   [ORACLE] oracle TOPQ on the ACQ -- 6 failed -- goldens: the engine agrees with the oracle › top-power
RED   [ORACLE] oracle make-up drawn newest first -- 6 failed -- goldens: the engine agrees with the oracle › top-export
RED   [ORACLE] oracle window ends at the priced month -- 10 failed -- goldens: the engine agrees with the oracle › price-export
RED   [ORACLE] oracle DGDO rate 3 -- 8 failed -- goldens: the engine agrees with the oracle › dgdo-power-2028
RED   [ORACLE] oracle royalty 5% in-country -- 2 failed -- goldens: the engine agrees with the oracle › cf-power
RED   [ORACLE] oracle unknown keys ignored -- 23 failed -- goldens: the engine agrees with the oracle › energy-refuse-unknown-key
```

## Refusal and reason strings (course content)

Every string below is pinned by a golden (the refusals in full). Figures print as the shortest round-trip decimal.

### Refusals (84 distinct)

- `carryForward.cap is not an accepted key; the accepted keys of carryForward are periodYears, base, capPct`
- `carryForward.capPct must be a number from 0 to 100; got 120`
- `carryForward.periodYears must be an integer at or above 1; got 0`
- `cmpp must be stated: the average current month end product price in US$ per tonne (Fourth Schedule); got nothing`
- `contract.extra is not an accepted key; the accepted keys of contract are years, topPct, makeUp, carryForward`
- `contract.makeUp.order must be one of "after-adjusted-acq", "after-top-quantity", "first"; got "lifo"`
- `days must be an array of at least 1 entry; got []`
- `days must be an integer at or above 1; got 365.5`
- `days must be stated, or replaced by year or by period; got nothing`
- `days must be the only day count stated; got days and year`
- `days[0].buyerCaused must be true or false when given; got "yes"`
- `days[0].date must be a date 'YYYY-MM-DD'; got "2027-3-1"`
- `days[0].forceMajeure must be a quantity that with maintenance 30 is at or below the DCQ 100; got 80`
- `days[0].forcemajeure is not an accepted key; the accepted keys of days[0] are date, nominated, available, taken, forceMajeure, maintenance, buyerCaused`
- `days[0].taken must be at or below the quantity made available 50; got 60`
- `days[1].date must be after the previous day 2027-03-02; got "2027-03-02"`
- `dbp is not an accepted key; the accepted keys at the top level are sector, domesticBasePrice, negotiatedPrice, product, cmpp, transportTariff, schedule`
- `dcq must be a finite number above 0; got 0`
- `discountRate must be a finite number above -1; got -1`
- `domesticBasePrice must be at or above the gas based industries floor US$0.90 per MMBtu (s.168(2)) for a gas based industry price, which is capped at the domestic base price (s.168(3)); got 0.8`
- `domesticBasePrice must be stated in US$ per MMBtu: the Authority determines it each year (PIA s.167(1)) and the engine holds no default; got nothing`
- `excused.pipelineOutage is not an accepted key; the accepted keys of excused are forceMajeure, purchaserCannotAccept, transportUnavailable, purchaserNonPayment`
- `formula must give a price at or above 0 in every month; got -13.3 for 2025-08`
- `formula.baseValues.gdp is not a weighted index; the accepted keys of formula.baseValues are fo, cpi`
- `formula.cap is not an accepted key; the accepted keys of formula are type, index, slope, constant, sCurve, floor, ceiling`
- `formula.ceiling must be at or above formula.floor 9; got 8`
- `formula.index must be the name of an index in months[].values (oil); got "brent"`
- `formula.sCurve.highKink must be above formula.sCurve.lowKink 90; got 50`
- `formula.sCurve.highkink is not an accepted key; the accepted keys of formula.sCurve are lowKink, highKink, lowSlope, highSlope`
- `formula.type must be one of "fixed", "escalated", "oil-indexed", "hub-indexed", "basket"; got "jcc-linked"`
- `formula.weights must sum to 1 (weights stated as decimals, CW GSA Article 15.1); got a sum of 1.1`
- `from must be a month at or after formula.baseMonth 2027-04; got "2027-01"`
- `heatingValue must be a finite number above 0; got 0`
- `heatingValueBasis must be one of "gross", "net"; got "higher"`
- `heatingvalue is not an accepted key; the accepted keys at the top level are quantity, quantityUnit, heatingValue, heatingValueUnit, heatingValueBasis, referenceConditions`
- `lagMonths must be an integer at or above 0; got -1`
- `makeUp must be an object { periodYears, order, endOfTerm } (no default); got nothing`
- `makeUp.endOfTerm must be one of "forfeit", "refund"; got "extend"`
- `makeUp.order must be one of "after-adjusted-acq", "after-top-quantity", "first"; got "fifo"`
- `makeUp.periodYears must be an integer at or above 0; got 1.5`
- `makeup is not an accepted key; the accepted keys at the top level are years, topPct, makeUp, carryForward`
- `maxDcqPct must be a number at or above 100 when given; got 90`
- `mmbtu is not an accepted key; the accepted keys at the top level are mmbtuPerBarrel`
- `mmbtuPerBarrel must be a finite number above 0; got 0`
- `months must cover the averaging window 2024-09 to 2025-02 for the price of 2025-03; got no value for 2024-09, 2024-10, 2024-11, 2024-12`
- `months[1].month must be 2025-02, the month after 2025-01 (the series is consecutive); got "2025-03"`
- `months[1].values must carry the same indices as months[0] (oil); got hh, oil`
- `negotiatedPrice must be given only for sector 'gas-distributor'; got 2`
- `negotiatedPrice must be stated for a gas distributor, which negotiates its price (PIA s.167(7)); got nothing`
- `notAKey is not an accepted key; the accepted keys at the top level are contract, royalty, discountRate, baseYear`
- `notAKey is not an accepted key; the accepted keys at the top level are dcq, days, year, period, maxDcqPct, topPct`
- `notAKey is not an accepted key; the accepted keys at the top level are dcq, maxDcqPct, deliveryTolerance, days`
- `notAKey is not an accepted key; the accepted keys at the top level are mmbtuPerBarrel`
- `notAKey is not an accepted key; the accepted keys at the top level are months, formula, from, to, averagingMonths, lagMonths, resetMonths, rounding, reopeners`
- `notAKey is not an accepted key; the accepted keys at the top level are obligation, delivered, voluntaryContracts, excused, agreementPenaltyRate, penaltyRate`
- `notAKey is not an accepted key; the accepted keys at the top level are quantity, quantityUnit, heatingValue, heatingValueUnit, heatingValueBasis, referenceConditions`
- `notAKey is not an accepted key; the accepted keys at the top level are sector, domesticBasePrice, negotiatedPrice, product, cmpp, transportTariff, schedule`
- `notAKey is not an accepted key; the accepted keys at the top level are years, topPct, makeUp, carryForward`
- `obligation must be a finite number at or above 0; got -1`
- `options must be an object of named inputs; got [1,2]`
- `penaltyRate must be left out when agreementPenaltyRate is stated (state one rate basis); got {"value":4,"source":"x"}`
- `penaltyRate.source must be a non-empty string; got nothing`
- `period.end must be a date after period.start 2028-01-01; got "2027-01-01"`
- `period.finish is not an accepted key; the accepted keys of period are start, end`
- `period.start must be a real date 'YYYY-MM-DD'; got "2027-02-30"`
- `product must be given only for sector 'gas-based-industry'; got "urea"`
- `product must be one of "ammonia", "urea", "methanol", "polypropylene", "low-sulphur-diesel-gtl"; got "fertiliser"`
- `quantity must be a finite number at or above 0; got -1`
- `quantityUnit must be one of "scf", "Mscf", "MMscf", "Sm3", "MSm3", "MMSm3"; got "bcf"`
- `referenceConditions must be a non-empty string; got "  "`
- `reopeners[0] must be a month 'YYYY-MM'; got "2031"`
- `rounding must be one of "none", "model-gsa-4dp"; got "4dp"`
- `royalty must be an object { terrain, inCountrySharePct } (no default terrain); got nothing`
- `royalty.terrain must be one of "onshore", "shallow_water", "deep_offshore", "frontier"; got "marginal_field"`
- `schedule.source must be a non-empty string; got ""`
- `sector must be one of "power", "commercial", "gas-distributor", "gas-based-industry"; got "industrial"`
- `to must be a month at or after from 2025-08; got "2025-07"`
- `topPct must be a number from 0 to 100; got 101`
- `topPct must be above 0 when maxDcqPct is stated (the effective swing divides by it); got 0`
- `years[0].acq must be at or above the reductions it carries (maintenance + force majeure + seller shortfall + permitted reduction = 110); got 100`
- `years[0].fm is not an accepted key; the accepted keys of years[0] are year, acq, maintenance, forceMajeure, sellerShortfall, permittedReduction, taken, contractPrice, topPrice, makeUpPrice, shortfallPrice`
- `years[0].shortfallPrice must be stated when sellerShortfall is above 0 (5); the engine holds no default rate; got nothing`
- `years[0].topPrice must be a finite number at or above 0; got nothing`
- `years[1].year must be 2028, the year after 2027 (contract years are consecutive); got 2029`

### Reasons (from the fixture and boundary goldens)

- 2027: seller shortfall 6300 reduces the Adjusted ACQ and is paid to the buyer at 1.25: 7875
- 2028: 5460000 counted against the take-or-pay quantity 6148800 leaves a deficiency of 688800; the deficiency payment is 688800 x 2.18 = 1501584; the buyer may make up 688800 in the 3 contract years after 2028, to the end of 2031
- 2029: make-up of 210000 taken from the make-up aggregate 688800 (make-up only after the Adjusted ACQ of the year is taken), first in first out: 210000 from 2028
- 2030: make-up aggregate 478800 available and none taken, because taken 7665000 does not exceed the Adjusted ACQ 7665000
- 2031: make-up of 268800 taken from the make-up aggregate 478800 (make-up only after the Adjusted ACQ of the year is taken), first in first out: 268800 from 2028
- 2031: make-up of 210000 from 2028 expired unrecovered at the end of 2031, the last year of its make-up period
- 2033: 5775000 counted against the take-or-pay quantity 6132000 leaves a deficiency of 357000; the deficiency payment is 357000 x 2.18 = 778260; the buyer may make up 357000 in the 3 contract years after 2033, to the end of 2036
- 2034: make-up of 105000 taken from the make-up aggregate 357000 (make-up only after the Adjusted ACQ of the year is taken), first in first out: 105000 from 2033
- 2034: the delivery period ends with make-up of 252000 unrecovered; the buyer forfeits it
- 2027: 22995000 counted exceeds the take-or-pay quantity 20695500 by 2299500, carried forward to the end of 2030
- 2028: 22366000 counted exceeds the take-or-pay quantity 20752200 by 1613800, carried forward to the end of 2031
- 2029: 14257000 counted against the take-or-pay quantity 20695500 leaves a deficiency of 6438500; a carry-forward credit of 3219250 (at most 50% of the deficiency, first in first out: 2299500 from 2027, 919750 from 2028) leaves 3219250; the deficiency payment is 3219250 x 9.80845 = 31575852.6625; the buyer may make up 3219250 in the 5 contract years after 2029, to the end of 2034
- 2030: make-up of 1823500 taken from the make-up aggregate 3219250 (make-up only after the take-or-pay quantity of the year is taken), first in first out: 1823500 from 2029
- 2031: make-up of 1395750 taken from the make-up aggregate 1395750 (make-up only after the take-or-pay quantity of the year is taken), first in first out: 1395750 from 2029
- 2031: 22519250 counted exceeds the take-or-pay quantity 20695500 by 1823750, carried forward to the end of 2034
- 2031: carry-forward of 694050 from 2028 expired unused at the end of 2031
- 2032: 19599000 counted against the take-or-pay quantity 20752200 leaves a deficiency of 1153200; a carry-forward credit of 576600 (at most 50% of the deficiency, first in first out: 576600 from 2031) leaves 576600; the deficiency payment is 576600 x 7.7569 = 4472628.54; the buyer may make up 576600 in the 5 contract years after 2032, to the end of 2037
- 2033: make-up of 576600 taken from the make-up aggregate 576600 (make-up only after the take-or-pay quantity of the year is taken), first in first out: 576600 from 2032
- 2033: 22878400 counted exceeds the take-or-pay quantity 20695500 by 2182900, carried forward to the end of 2036
- 2034: 22765000 counted exceeds the take-or-pay quantity 20695500 by 2069500, carried forward to the end of 2037
- 2034: carry-forward of 1247150 from 2031 expired unused at the end of 2034
- 2035: 18396000 counted against the take-or-pay quantity 20695500 leaves a deficiency of 2299500; a carry-forward credit of 1149750 (at most 50% of the deficiency, first in first out: 1149750 from 2033) leaves 1149750; the deficiency payment is 1149750 x 7.8983 = 9081070.425; the buyer may make up 1149750 in the 5 contract years after 2035, to the end of 2040
- 2036: make-up of 691800 taken from the make-up aggregate 1149750 (make-up only after the take-or-pay quantity of the year is taken), first in first out: 691800 from 2035
- 2036: carry-forward of 1033150 from 2033 expired unused at the end of 2036
- 2036: the delivery period ends with make-up of 457950 unrecovered; the seller refunds 457950 x 8.0813 = 3700831.3350000004
- 2027: 500 counted against the take-or-pay quantity 900 leaves a deficiency of 400; the deficiency payment is 400 x 3 = 1200; the delivery period ends with this year, so no make-up right arises
- 2027: 600 counted against the take-or-pay quantity 800 leaves a deficiency of 200; the deficiency payment is 200 x 3 = 600; the make-up period is 0 years, so no make-up right arises
- 2027: 600 counted against the take-or-pay quantity 800 leaves a deficiency of 200; the deficiency payment is 200 x 3 = 600; the buyer may make up 200 in the 2 contract years after 2027, to the end of 2029
- 2028: make-up of 200 taken from the make-up aggregate 200 (make-up taken in priority, before the year's own quantity), first in first out: 200 from 2027
- 2027: 1100 counted exceeds the Adjusted ACQ 1000 by 100, carried forward to the end of 2029
- 2029: carry-forward of 100 from 2027 expired unused at the end of 2029
- 2030: 700 counted against the take-or-pay quantity 800 leaves a deficiency of 100; the deficiency payment is 100 x 3 = 300; the delivery period ends with this year, so no make-up right arises
- 2027-01-01: taken 20790 is below the adjusted DCQ 21000: buyer shortfall 210
- 2027-01-03: taken 20950 is below the adjusted DCQ 21000: buyer shortfall 50
- 2027-01-05: zero nomination; the whole adjusted DCQ 21000 is a buyer shortfall for the day
- 2027-01-07: taken 20690 is below the adjusted DCQ 21000: buyer shortfall 310
- 2027-01-09: taken 20900 is below the adjusted DCQ 21000: buyer shortfall 100
- 2027-01-12: force majeure and maintenance cover the whole DCQ; no quantity is owed either way for the day
- 2027-01-13: force majeure and maintenance cover the whole DCQ; no quantity is owed either way for the day
- 2027-01-15: taken 20840 is below the adjusted DCQ 21000: buyer shortfall 160
- 2027-01-17: taken 20580 is below the adjusted DCQ 21000: buyer shortfall 420
- 2027-01-20: the seller made 15750 available against a properly nominated 22050: seller shortfall 6300
- 2027-01-21: taken 20740 is below the adjusted DCQ 21000: buyer shortfall 260
- 2027-01-23: taken 20900 is below the adjusted DCQ 21000: buyer shortfall 100
- 2027-01-25: nominated 24150 is above the MaxDCQ 23100; 1050 is not properly nominated
- 2027-01-27: taken 20790 is below the adjusted DCQ 21000: buyer shortfall 210
- 2027-01-30: 8400 of the properly nominated quantity was not made available for a cause on the buyer's side, so it is not a seller shortfall
- 2027-01-30: taken 12600 is below the adjusted DCQ 21000: buyer shortfall 8400
- 2027-01-31: taken 20950 is below the adjusted DCQ 21000: buyer shortfall 50
- 2027-03-01: 40 not made available is excused by the force majeure and maintenance quantities stated for the day
- 2027-03-01: the seller made 40 available against a properly nominated 100: seller shortfall 20
- 2027-03-01: nominated 150 is above the MaxDCQ 120; 30 is not properly nominated
- 2027-03-01: the seller made 0 available against a properly nominated 120: seller shortfall 120
- 2027-03-01: the seller made 94 available against a properly nominated 100 less the tolerance 5: seller shortfall 1
- 2027-03-01: taken 94 is below the adjusted DCQ 99: buyer shortfall 5
- delivered 5460000 against the obligation 6825000 leaves 1365000 undelivered
- 688800 is excused: the purchaser could not accept the allocated volumes (s.110(10)(b))
- 676200 is penalised at 3.5 per MMBtu: 2366700; the lessee may not supply new midstream gas export operations (s.110(14)(a)) and export supply approvals require prior compliance (s.110(15))
- voluntary contracts of 1000 are at or above the obligation 1000: the lessee is deemed to have fulfilled its obligation (s.110(2)(a))
- delivered 1000 meets the obligation 1000
- delivered 600 against the obligation 1000 leaves 400 undelivered
- 250 is excused: force majeure (s.110(10)(a))
- 150 is excused: the allocated gas could not be transported for reasons beyond the lessee's control (s.110(10)(c))
- the whole undelivered quantity is excused; no penalty
- negotiated price 2.9 exceeds the commercial sector price 2.68, which s.167(7) sets as the ceiling for gas distributors
- negotiated price 2.5 is at or below the commercial sector price 2.68
- the formula gives 1.8, inside the floor 0.9 and the domestic base price 2.18
- the formula gives 0.8, below the floor US$0.90 per MMBtu, so the price is held at 0.9 (s.168(2))
- the formula gives 2.4, above the domestic base price 2.18, so the price is held at 2.18 (s.168(3))

## Open questions for the lead

None open: the lead decided all four on 2026-09-26 (section above).
