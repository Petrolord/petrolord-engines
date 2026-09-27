# FINDINGS: inventory (oracle_inventory.py, Supply Chain SC3, materials, spares and inventory management)

Engine: `engines/supplychain/inventory.js`. Golden: `test-data/supplychain/goldens/inventory_cases.json`, 169 cases (89 refusals, every message pinned), written by `tools/validation/supplychain/oracle_inventory.py`. Gate: `__tests__/supplychain.inventory.test.js` (216 tests) calls the engine on every golden, checks the printed figures of 19 published cases (Harris 1913; Caplice, MIT ESD.260J lectures 8, 11, 12 and 13; MIL-HDBK-338B 5.3.8.1) and pins the two printed slips as slips, checks the fixture wiring and planted situations, proves the canonical imports (source import lines; the lead-time draws replayed by hand through lib/stats equal the engine's), runs property, boundary and copy tests, checks that a printed maximum typed back is accepted, and that each required policy input left out is refused by name. Negative control: `negcontrol_inventory.sh`, 56/56 engine plants red, 7/7 oracle plants caught, 0 skipped (run on head 31aeeb9). Timing: `timing_inventory.js`. Fixtures: `test-data/supplychain/ekene-materials/` (make_inventory_fixtures.py). Full engines suite after `npm ci`: 234 suites, 18,557 tests passed (1 skipped, 1 todo, outside this wave).

Functions (9): `criticality`, `abcClassification`, `eoq`, `quantityDiscount`, `safetyStock`, `poissonStock`, `insuranceSpares`, `leadTimeRisk`, `slowMoving`; plus `ACCEPTED_KEYS` and `DEFAULTS` (caps and the 12-digit tie convention only; no domain default).

The oracle is stdlib only (fractions, decimal, math, json), reads no JavaScript and imports nothing from the engines. It takes a different road: every stated input as the exact rational of its double; square roots in Decimal at 60 digits; Phi from the Maclaurin series of erf in Decimal at 90 digits (the engine uses AS241 for the inverse and the regularised incomplete gamma for Phi); Phi^-1 and the fill-rate k by Decimal bisection to 1e-40; each Poisson probability by its own formula and the loss E[(X - s)+] as the direct partial expectation m - s + sum_{x<s} (s - x) p(x) (the engine recurses L(x+1) = L(x) - (1 - F(x))); the ABC ranking by insertion; discount candidates costed from the lot-cost definition on Fractions; the Monte Carlo replayed from the stated recipe (integer mulberry32, the triangular inverse CDF from its definition, floor-index percentiles, math.fsum means). It prints JavaScript-style and stops when an exact value lies within 1e-9 of a rounding tie.

No new Monte Carlo or NPV: mulberry32, triInvCDF, basicStats, mean (lib/stats); EXCEEDANCE_DEFINITION (lib/conventions/percentile.js); regularizedGammaQ (engines/hse/safetyStats.js) for Phi. Nothing is discounted, so cashflow npv is not imported (stated in the engine header). The gate refuses Math.random, randomNormal, createCorrelatedSampler, a local mulberry32 and any npv or discountRate in the engine source.

Print rule: money in reasons rounded to the cent, a computed quantity, factor or probability to 6 decimal places, both half away from zero with trailing zeros dropped; stated inputs print as given; numeric fields keep full precision; a printed maximum is the 6-decimal figure on the accepted side, checked against the refusal's own rule, with a note when it differs from the exact bound. Counts and measured figures agree with their units (1 month, 1 unit, 1 spare).

## Sources (all read 2026-09-27)

Copies kept outside the repo in `/root/cat-wip-materials/sources/`.

| # | text | edition / date | URL | licence | sha256 (16) | used for |
|---|---|---|---|---|---|---|
| 1 | F. W. Harris, "How Many Parts to Make at Once", Factory, The Magazine of Management 10(2) pp. 135-136, 152 | February 1913; read in the reprint Operations Research 38(6) Nov-Dec 1990 pp. 947-950 | http://userhome.brooklyn.cuny.edu/irudowsky/CIS10.31/articles/EOQModel-OriginalPaper.pdf | 1913 text public domain (US, pre-1929); the 1990 reprint's typesetting is (c) ORSA, so the text is cited and short figures quoted | e35603eced0ed4d1 | X = sqrt(240 M S / C) (reprint p. 948); lots 2,190 (M 1,000 a month, S $2, C $0.10; p. 948), 6,850 (Figure II, M 1,230, C $0.0135, S $2.15; p. 949), 48.5 "or, say, 49" (Figure III, M 30, C $5.65, S $1.85; p. 949); "four fold to warrant doubling" (p. 950) |
| 2 | C. Caplice, MIT ESD.260J Logistics Systems, Fall 2006, lecture 8 "Extensions to EOQ" | Oct 2006 (PDF created 23 Jul 2007) | https://ocw.mit.edu/courses/esd-260j-logistics-systems-fall-2006/pages/lecture-notes/ | MIT OpenCourseWare, CC BY-NC-SA 4.0 | c94b17784aa94fde | slide 3 (EOQ, TRC*); slide 9 (A 500, D 2,000, r 0.25, v 50: Q 400, 2,500 + 2,500 = 5,000); slides 11-12 (all-units algorithm; 2% at 500 data, no answer printed); slides 13-15 (incremental Fi, EOQi, printed table) |
| 2a | lecture 7 "Level demand, EOQ, sensitivity" | as 2 | as 2 | as 2 | 993304c0da666374 | context |
| 3 | lecture 11 "Probabilistic Demand" | as 2 | as 2 | as 2 | 33ddb6947f1ec82e | slide 4 (ABC classes arbitrary); slides 12-17 (s = xL + k sigmaL, P1, P2); slide 18 (D 13,000, L 2 weeks, RMSE 1,316, EOQ 228); slide 22 (G(k)); slide 23 (P2 = 1 - sigmaL G(k)/Q); slide 24 (CSL 601/423/330/217; IFR 513/348/252/148) |
| 4 | lecture 12 "More Probabilistic Demand" | as 2 | as 2 | as 2 | ffe9d2584425a995 | slide 3 (sigmaL 258, muL 500); slides 5-6 ((R, S): R 8 weeks, IFR 0.95, Q 2,000, 2,500, 577, G 0.1733, k 0.58, S 2,835) |
| 5 | lecture 13 "Special Cases, Probabilistic Demand" | as 2 | as 2 | as 2 | cfe0f8613b794689 | slide 10 (Poisson for slow movers); slides 11-12 (Poisson(0.8), IFR 0.90, E[US] 0.08, S = 2; P, F, L table); slide 13 (days of supply to find dead stock) |
| 5a | ESD.260J lecture-notes index page | read 2026-09-27 | as 2 | as 2 | cbdf8cf7c06008ae | licence, titles |
| 6 | MIL-HDBK-338B Electronic Reliability Design Handbook, 5.3.8, eq. 5.58, example 5.3.8.1, p. 5-27 | 1 October 1998 | page mirror read: https://reliabilityanalytics.com/reliability_engineering_library/MIL-HDBK-338B_Electronic_Reliability_Design_Handbook/MIL-HDBK-338B_Electronic_Reliability_Design_Handbook_pp_109.pdf (NAVSEA copy returned Access Denied) | US DoD handbook, public domain (distribution A) | 9de2ee2e13bea72c | R(t) = sum_{x<=r} (lambda t)^x e^(-lambda t)/x!; lamp example 0.001/h, 500 h, two spares: 0.986 |

Not used: Silver, Pyke and Thomas (4th ed., CRC 2017) and Nahmias are not publicly readable, so not read or cited. SMRP and ISO 14224 are licensed; the criticality criteria are the caller's stated policy (course may name ISO 14224 / NORSOK Z-008 by concept). Sherbrooke's METRIC (RAND RM-5078-PR, 1966; DTIC AD0645684) was sought for the one-for-one pipeline result; both hosts returned HTML error pages, so it is not cited.

## Published examples (goldens)

- Harris 1913 (harris-1913-example, -connector, -stud, -stud-say-49): D = 12 M, orderCost S, holdingRate 0.10 on C; engine 2190.890230, 6856.626965, 48.554321; printed 2,190, 6,850, 48.5 (three figures, truncated) and "say, 49" (nearest 1: 49).
- Caplice lecture 8 slide 9 (caplice-l8-eoq): 400, 2,500, 2,500, 5,000 exactly.
- Caplice lecture 8 slide 15 (caplice-l8-incremental): F 2,500 and 7,500; EOQ 400, 1,033 (band 1 infeasible), 1,789; at 1,789 the engine gives effective price 44.192286, purchase 88,384.57, ordering 558.97, holding 9,882.50, total 98,826.04 against 105,000 for band 0. The slide prints 44.19, 88,384, 559, 9,882, 98,825 (lines rounded; printed total 1.04 below).
- Caplice lecture 8 slide 12 (caplice-l8-all-units-2pct): data only; oracle computes 500 at 103,062.50 against 400 at 105,000.
- Caplice lecture 11 slide 24 CSL column: reproduced exactly with k read to 2 decimals and the level rounded to the nearest unit (601, 423, 330, 217); exact k gives 600.40, 424.52, 330.75, 217.21.
- Caplice lecture 11 slide 24 IFR column: exact fill-rate k gives 512.35, 339.18, 250.10, 147.44 against 513, 348, 252, 148; 348 is a slip (rule gives 339.18, k 1.3142), pinned as a discrepancy.
- Caplice lecture 12 slide 6 (caplice-l12-periodic-rs): sigma 577.10, G target 0.173279, k 0.583373 read as 0.58, S 2,834.72 held as 2,835.
- Caplice lecture 13 slides 11-12: S = 2 (L(2) = 0.058121 <= 0.08); P 0.449/0.359/0.144; F 0.809/0.953/0.991/0.999; L 0.80/0.25/0.06/0.01. Slide prints L(4) = 0.009 (and 0.0088, 0.00878); recursion gives 0.001619: slip, pinned.
- MIL-HDBK-338B 5.3.8.1 (mil-hdbk-338b-lamps, ins-mil-hdbk-mean): P(X <= 2) at mean 0.5 = 0.985612, printed 0.986.

## Figures in the engine

AS241 (Wichura 1988) coefficients; 12 significant digits for every comparison; caps 5,000 items, 20 criteria, 10 classes, 20 breaks, 10 bands, 6 decimals for the safety-factor table read, 200,000 iterations, Poisson mean 500, 1,000 spares. Every cost, demand, rate, service level and measure, cut-off, band, write-down, cover limit, weight, class minimum, override, rounding rule and multiple, safety-factor rounding and floor, lead time and spread, review period, days a year, failure rate, downtime cost, reorder point, seed and iteration count is a required stated input. No legal or regulatory figure.

## Decisions and readings

1. Criticality: weighted score = sum weight x score / scoreMax (weights add to 100, tolerance 1e-9); classes highest first, strictly falling minimums ending at 0; first class whose minimum is met (at or above, 12 digits); `topClassOnMaxScore` (required, [] for none) forces the first class on a maximum score, reported as `forcedBy`.
2. ABC: usage x unit cost, highest first, ties by id; required boundary rule 'at-or-below' (cumulative including the item) or 'include-crossing' (share before the item). No default cut-offs.
3. EOQ: sqrt(2AD/h), h stated directly or holdingRate x unitCost (exactly one). Harris's (CX + S)/2 carrying term: S drops out of the optimum; his "about 0.188 cents" is reproduced by neither reading (0.1826 or 0.1834), so not a golden. Rounding rule required; nearest takes halves upward; costs at the rounded quantity and at Q*, with the penalty.
4. Insurance spares: one-for-one pipeline, Poisson mean failures x leadTimeDays / daysPerYear; waiting unit = unit down at downtimeCostPerDay; holding on all n bought; cheapest n in 0..maxSpares, 12-digit tie to fewer; `atSearchLimit` flags an optimum on the limit. Published anchor: MIL-HDBK-338B eq. 5.58 and Caplice lecture 13 loss.
5. Quantity discounts: all-units candidates in-band EOQ or the band's first quantity when the EOQ falls below; incremental candidates only the in-band EOQ with A + Fi; rounded by the stated rule and costed at the rounded quantity in the band it lands in (`costedBand`); break quantities must be multiples of the rounding multiple; 12-digit tie to the smaller quantity.
6. Safety stock: P = L + R; sigma = sqrt(P sd_d^2 + d^2 sd_L^2); CSL k = Phi^-1; fill-rate k smallest with sigma G(k) <= Q(1 - level); required `safetyFactorRounding` (none or nearest 0..6 decimals) and `minimumSafetyFactor` (number or null); achieved service at the rounded level; fill rate with sigma 0 refused.
7. Poisson stock: mean demandRate x (L + R); cycle service = probability of no stockout over the protection period (smallest s with F(s) >= target); fill rate smallest s with E[(X - s)+] <= Q(1 - level); mean capped at 500, refusal prints the largest accepted leadTime on the accepted side.
8. Lead-time risk: lead time drawn first, then one demand rate held for the whole lead time; stockout when demand > reorder point (equal is met); P90 = low figure, the risk sits at P10 (stated); `reorderPointForService` = sorted draw at ceil(level x n) - 1.
9. Slow-moving: bands from 0 rising; last band reached (at or above); write-down = value x stated %; cover = onHand / monthlyUsage; excess strictly above the limit, all stock when no usage.
10. Refusal messages are course content: each names the field, states the exact condition, prints the value got; the oracle pins every one.

## Boundary table

| rule | at the boundary | one past | golden |
|---|---|---|---|
| criticality class | score = minimum: in the class | 69.99 below 70: next class | crit-at-cutoff-is-in, crit-just-below-cutoff, crit-ekene (MECH-SEAL 70, GASKET-RJ 44) |
| 12-digit key | 69.99999999999999 reads as 70: V | | crit-12-digit-key |
| override | maximum forces the top class | one below does not | crit-override-forces-top, crit-override-one-below-max |
| ABC at-or-below | cumulative exactly 80: A; exactly 95: B | above: next class | abc-cutoff-exact-at-or-below |
| ABC include-crossing | share before exactly 80: B; exactly 95: C | below: higher class | abc-cutoff-exact-include-crossing |
| rounding nearest | quotient exactly half: up | | eoq-q-exactly-half-of-multiple |
| rounding to 0 | refused | | eoq-refuse-rounds-to-zero |
| discount tie | equal totals: smaller quantity | | qd-tie-exact |
| safety factor floor | k below floor: held at floor | | ss-floor-at-zero, ss-negative-k-without-floor |
| Poisson cycle service | F(s) = target: met | 0.7358 just above F(1): next level | ps-level-exactly-met, ps-level-just-above |
| Poisson mean cap | 500 accepted | 502.5 refused; printed 166.666666 accepted | ps-mean-at-cap, ps-refuse-mean-above-cap, ps-printed-bound-accepted |
| insurance tie | equal totals: fewer spares | | ins-tie-takes-fewer |
| insurance search | optimum at maxSpares flagged | | ins-search-limit, ins-free-holding |
| stockout | demand = stock: met | 0.5 short: every draw | ltr-constant-demand-equal-to-stock, -above-stock |
| slow-moving band | 12 months: slow | 11.99: active | sm-boundaries |
| excess cover | 24 months: inside | 25: one unit excess | sm-boundaries |

## Caps and timing

Caps: 5,000 items, 20 criteria, 10 classes, 20 breaks, 10 bands, 200,000 iterations, Poisson mean 500, 1,000 spares. Timing (ms, node 18.19.1, one run): criticality / ABC / slow-moving at 18 items 1.8 / 1.4 / 1.4, 500 items 11 / 10 / 13, 5,000 items 58 / 91 / 91; quantityDiscount 20 breaks 1.3 (all-units), 0.7 (incremental); safetyStock fill rate 0.999 4.2; poissonStock mean 500 at 0.999999 1.5; insuranceSpares mean 500 over 1,000 spares 2.7; leadTimeRisk 2,000 / 20,000 / 200,000 iterations 12 / 105 / 1,200.

## Negative control (56/56 engine red, 7/7 oracle caught, 0 skipped)

Engine plants:
- criticality: weights ignored; not over scoreMax; minimum exclusive; no 12-digit key; override ignored; override one below max; weights need not sum to 100.
- ABC: share-before under at-or-below; cut-off exclusive; include-crossing inclusive; ranked lowest first; id tie-break reversed.
- EOQ: no factor 2; rate taken as the holding cost; nearest halves down; up taken as nearest; holding on the whole lot.
- discounts: break never a candidate; Fi not carried; incremental priced all-units; tie to the larger quantity.
- normal safety stock: lead-time variance dropped; review period dropped; z at 1 - level; fill target without (1 - level); k truncated; floor ignored; SS not scaled by sigma; AS241 coefficient off in the 9th digit; Phi off by 1e-7.
- Poisson: level strictly above; loss off by one; mean without review; fill limit at the level.
- insurance: downtime without days; holding on n - 1; tie to more; fill rate as F(n); mean without lead time.
- Monte Carlo: draw order swapped; stockout at equality; P90/P10 swapped; seed ignored; service reorder point one draw high.
- slow-moving: band exclusive; write-down not over 100; cover inclusive; no-usage never excess.
- messages and keys: unknown keys ignored (top level and lists); bound rounded to nearest; unit agreement dropped; money unrounded; class reason reworded; marginal-spare clause dropped; P-label reversal dropped.

Two plants were green on the first run (override one below max; tie to more spares); goldens crit-override-one-below-max and ins-tie-takes-fewer were added and both went red. Oracle plants (all RED): class minimum exclusive, Poisson loss off by one, fill target at the level, EOQ without factor 2, ABC ranked lowest first, MC draw order, unknown keys ignored.

## Decisions for the lead

1. Insurance-spares model is the stated one-for-one pipeline; no public text read prints a worked insurance-spares cost example, so those goldens come from the stated arithmetic anchored to the MIL-HDBK-338B Poisson figure. Default: keep and say so in the course.
2. Silver, Pyke & Thomas and Nahmias not used (not publicly readable); goldens come from Harris 1913, MIT OCW (CC BY-NC-SA 4.0) and MIL-HDBK-338B.
3. Two printed slips (Caplice lecture 11 IFR 95% prints 348 vs 339.18; lecture 13 L(4) 0.009 vs 0.0016) are pinned and taught as "printed alike is not equal".
4. Lead-time risk holds one demand rate for the whole lead time (perfect correlation within a lead time).
5. Lead-time variation enters sigma on the lead time only (review period fixed).
6. The Suite app must vendor engines/hse/safetyStats.js (for regularizedGammaQ) alongside inventory.js, lib/stats and percentile.js.
7. NextGen path_order for `materials` is for the course foundation to state.

## Lead decisions (2026-09-27)

1. All seven defaults above are accepted as they stand.
2. MIT OpenCourseWare is CC BY-NC-SA 4.0 and NextGen is a paid product: the course cites the Caplice figures with lecture and slide numbers and never reproduces slides or slide text.
3. The two printed slips are taught as slips, with the rule's own figure beside the printed one.
4. The one-for-one insurance-spares model is stated plainly in the course as the engine's model, with its anchor.
5. This file was committed by the lead with the owner's approval (the wave agent could not create it).
