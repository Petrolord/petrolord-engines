# FINDINGS: gasContract (oracle_gascontract.py, Economics EC8, gas sales agreements)

Engine: `engines/economics/gasContract.js` (the brief allowed another name; it
is `gasContract.js`). Golden: `test-data/economics/goldens/gascontract_cases.json`,
@@CASES@@ cases (@@REFUSALS@@ of them refusals, every refusal message pinned in full),
written by `tools/validation/economics/oracle_gascontract.py`. Gate:
`__tests__/economics.gasContract.test.js` (@@TESTS@@ tests) calls the engine on
every golden, checks the published figures against their printed values,
checks the planted fixture situations and the wiring, and runs property tests.
Negative control: `negcontrol_gascontract.sh` (@@NEG@@). Timing:
`timing_gascontract.js` (table below). Fixtures: `test-data/economics/ekene-gsa/`,
written by `make_gsa_fixtures.py`. Full engines suite on the branch: @@SUITE@@.

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

@@TIMING@@

## Negative control

@@NEGCONTROL@@

## Refusal and reason strings (course content)

@@STRINGS@@

## Open questions for the lead

1. **Domestic base price.** A required input. The regulator's circular was
   not retrievable; the 2026 and 2025 figures are cited from press and a law
   firm note. If the circular (or a gazetted domestic base price regulation)
   is obtained, its edition and date should replace source 3.
2. **Flare penalty.** Not implemented. The only current text found is an
   undated, unnumbered copy on the NUPRC gazetted page (US$3.50 per 1,000 scf,
   r.16(1)). Decide whether that copy counts as a current public text; if it
   does, a `flarePenalty` with that cited rate is a small follow-on.
3. **Readings 3, 4, 5 and 9** above are the engine's; the course should state
   them. Confirm or override.
4. **Recovery-order default.** None is set (all explicit). Confirm that the
   course teaches the Model GSA order as the reference and the others as
   variants.
