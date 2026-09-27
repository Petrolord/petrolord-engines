# FINDINGS: marineLogistics (oracle_marine.py, Supply Chain SC4, offshore and marine logistics)

Engine: `engines/supplychain/marineLogistics.js` (five functions: `voyagePlan`, `fleetSize`, `fleetVariability`, `deckPlan`, `shoreBase`; plus `ACCEPTED_KEYS`, `DEFAULTS`, `ACTIVITIES`). Golden: `test-data/supplychain/goldens/marine_cases.json`, 163 cases (79 refusals, every message pinned; 18 cases carry printed figures from five published sources), written by `tools/validation/supplychain/oracle_marine.py`. Gate: `__tests__/supplychain.marine.test.js` (212 tests) calls the engine on every golden, checks the published figures, proves the canonical imports (lib/stats `mulberry32`, `triInvCDF`, `basicStats`; lib/conventions `EXCEEDANCE_DEFINITION`; no Math.random, no own PRNG, no NPV), runs engine-against-engine property tests (Little's law on every shore base result, M/D/1 = half of M/M/1, the berth target search, weather scaling only the stated activities, fixed-factor Monte Carlo = fleetSize, exceedance order of every percentile set), the boundary rows below, the copy rule over every output string, unit agreement, no hidden defaults (dropping any one required top-level input is refused by name), unknown keys at every level, the fixture labels and the caps. Negative control: `negcontrol_marine.sh`, 54/54 engine plants red, 8/8 oracle plants caught, 0 skipped (run on head 22bd023). Timing: `timing_marine.mjs` (plain node). Fixtures: `test-data/supplychain/ekene-marine/` (`make_marine_fixtures.py`, synthetic Ekene offshore cluster). Full engines suite after `npm ci`: 234 suites, 18,553 tests passed (1 skipped, 1 todo, outside this wave).

The oracle is stdlib only (fractions, decimal, math, json), reads no JavaScript and imports nothing from the engines. It takes a different road: every stated figure is read as the decimal it was typed as and carried as an exact Fraction, so capacity checks, rounded-up counts and the binding constraint are decided exactly (the engine decides them on 12 significant digits of its doubles); the M/M/c delay probability is the direct sum of Adan and Resing eq. (5.1) (the engine uses the Erlang B recursion (11.3) and remark 11.3.2); M/D/1 is the Pollaczek-Khinchin mean value formula (eqs 7.14 to 7.16) where the engine applies the Cosmetatos formula, which reduces to it at c = 1; first-fit decreasing is coded from the "one open bin at a time" description, the engine from the "first bin that fits" description; the Monte Carlo replays mulberry32 in unsigned 32-bit integers and the triangular inverse CDF from its definition, then sizes the fleet per iteration on exact Fractions of the drawn doubles, with percentiles by integer index and means as exact sums. The oracle stops (exit 2) if a rounding decision falls within 1e-9 of a whole number without being one. The only double-arithmetic replay is the steady-state bound printed by `shoreBase`, whose printed figure is defined by the engine's own double test.

No new Monte Carlo or NPV code: sampling is lib/stats (`mulberry32`, `triInvCDF`, `basicStats`), percentile labels and the definition sentence are lib/conventions/percentile.js. Nothing is discounted.

Print rule: money in reasons to the cent, a computed quantity to 6 decimal places (half away from zero, trailing zeros dropped), stated inputs as typed; a printed bound is the 6-decimal figure nearest the exact bound on the accepted side, checked with the refusal's own rule, with "(rounded down at the sixth decimal so that it is accepted)" when it differs (farmout.js precedent).

## Sources (all read 2026-09-27)

Copies in `/root/cat-wip-marine/sources/`.

| # | text | edition / date | URL | licence | sha256 (16) | used for |
|---|---|---|---|---|---|---|
| 1 | I. Adan and J. Resing, Queueing Systems (lecture notes, TU Eindhoven) | 26 March 2015 | https://www.win.tue.nl/~iadan/queueing.pdf | no licence printed; formulas and figures cited, prose not quoted | f1a6a2882c6cc19b | ch. 5 (eqs 5.1 to 5.3), Tables 5.1 and 5.2 (goldens); s. 3.4 Little's law; s. 7.6 eqs 7.14 to 7.16 (Pollaczek-Khinchin); s. 11.3 recursion (11.3) and remark 11.3.2 |
| 2 | V. B. Iversen, Teletraffic Engineering Handbook (ITU-D SG 2/16 and ITC) | draft 20 June 2001 | https://www.itu.int/ITU-D/study_groups/SGP_1998-2002/SG2/StudyQuestions/Question_16/RapporteursGroupDocs/teletraffic.pdf | ITU document, no licence printed; numbers cited | f205c11399f67587 | s. 12.2.1 Erlang's C; Example 12.3.1 (W = 0.075 s and 0.199 s, total 0.274 s) |
| 3 | B. Liu, T. P. Pantelidis, S. Tam and J. Y. J. Chow, An EV charging station access equilibrium model with M/D/C queueing | arXiv 2102.05851v2 (11 Feb 2021; PDF 3 Sep 2021) | https://arxiv.org/abs/2102.05851 | CC BY 4.0 | fa41bfc9b70e2f5b | eq. (2), the Cosmetatos (1975, INFOR 13, 328-331) M/D/c approximation via Barcelo et al. (1996); no closed form for M/D/c mean delay |
| 4 | I. Skoko, Z. Lusic, Z. Sanchez-Varela and Z. Boko, Optimization Model for Selection of the Offshore Fleet Structure, J. Mar. Sci. Eng. 12(2), 263 | 1 Feb 2024 | https://doi.org/10.3390/jmse12020263 | CC BY 4.0 | e94a40e568ae1e52 | Table 1 (0.5 t/h = USD 10,440/day, 0.03 t/h = USD 626.4/day at USD 870/t); Table 4 (10 and 11 kn = 240 and 264 NM/day; usable 85%); Tables 5 and 7 (AHTS fuel USD 80,847.36) |
| 5 | B. Aas, O. Halskau and S. W. Wallace, The role of supply vessels in offshore logistics, Maritime Economics & Logistics 11(3), 302-325 | 2009 (accepted manuscript) | https://eprints.lancs.ac.uk/id/eprint/45409/ | publisher copyright; concept only | 1d72cae6328c2eee | deck cargo in m2 (deck bands), no stacking of containers or baskets, segregated bulk tanks, economical speed 11 to 13 kn, weather limits, deck and bulk together in good weather, crew change every fourth week |
| 6 | Wikipedia, First-fit-decreasing bin packing | revision 1317275412 (17 Oct 2025) | https://en.wikipedia.org/wiki/First-fit-decreasing_bin_packing | CC BY-SA 4.0 | 262c1e6630071a13 (wikitext) | FFD description; capacity 60 and 61 example (Coffman, Garey and Johnson 1978); Huang and Lu (2021) Ex. 5.1; Dosa (2007) tight example |

Not used: Fagerholt and Lindstad (2000), Halvorsen-Weare et al. (2012), Maisiuk and Gribkovskaia (2014) and the Springer offshore chapters (paywalled or blocked here). No openly readable offshore paper prints a deterministic fleet-sizing example with inputs and a vessel count (Maisiuk and Gribkovskaia is simulation; Skoko et al. is an LP on logged days). IMCA and GOMO not used.

## Published examples (goldens)

- Adan and Resing Table 5.1 (c = 1, 2, 5, 10, 20; mu = 1, rho = 0.9): PiW 0.9, 0.852632, 0.762493, 0.668732, 0.550769 (printed 0.90, 0.85, 0.76, 0.67, 0.55); E(W) 9, 4.263158, 1.524986, 0.668732, 0.275385 (printed 9.00, 4.26, 1.53, 0.67, 0.28). The printed 1.53 at c = 5 is not the two-decimal rounding of the exact 1.524986 (1.52); the golden holds it within 0.0051 and the gate pins both facts.
- Adan and Resing Table 5.2: E(W) 9.00, 9.26, 9.50, 9.64, 9.74 within 0.005; E(L) 9, 19, 51, 105, 214 within 0.5.
- Iversen Example 12.3.1: W1 = 0.0746972 (printed 0.075), W2 = 0.199005 (printed 0.199), sum 0.274 at three decimals.
- Skoko Tables 1 and 4: 120 NM each way at 10 kn is 24 h of sailing; sailing fuel USD 10,440 and port fuel USD 626.4 for a day each, exactly.
- Skoko Tables 5 and 7: 0.60 d navigation at 11 kn (79.2 NM each way), 7.00 d maritime activities as field time at 0.5 t/h, 2.40 d in port at 0.03 t/h and USD 870/t give 92.928 t and USD 80,847.36. The PSV figure of USD 186,274.10 is not reproducible from the rounded Table 5 days (they give USD 186,214.10), so it is not used.
- Wikipedia FFD: capacity 60 packs {44,8,8}, {24,24,6,6}, {22,21,17}; capacity 61 packs {44,17}, {24,24,8}, {22,21,8,6}, {6} (FFD is not monotone in capacity; the lower bound is still 3); Huang and Lu at capacity 75 packs four bins as printed; Dosa's example scaled to capacity 400 with epsilon 4 uses 8 bins where the optimum is 6 (8 = 11/9 x 6 + 6/9), bin contents as printed.

## Figures in the engine

None of the domain figures is a default. The engine holds only caps and the tie rule (12 significant digits): installations 50, products 20; item lines 500, units 2,000, quantity per line 1,000, deck voyages 500; berths 100; weather factor 1 to 10; iterations 200,000, and iterations x voyage sets 2,000,000.

## Decisions and readings

1. Units are NM, knots, hours (or days where the name says days), m2, t and m3. Sailing hours = total distance / speed.
2. One stated weather factor (1 to 10) multiplies the time of the stated activities (sailing, port, field). The list of activities is required, and fuel follows time.
3. Fuel = hours x stated burn per activity; cost = tonnes x stated price. There is no speed-cube law.
4. Constraints are checked in the order deck area (x usable fraction), deck load, deadweight, then each tank in product order. Deadweight load = deck weight + bulk m3 x stated density. Cargo deadweight is the user's net figure. Every product needs a stated tank (0 allowed); a load on a zero tank is refused by name.
5. The binding constraint is the highest utilisation, ties to the first in order. Capacity checks are inclusive, at 12 significant digits.
6. Routes are milk-run (every installation once, n + 1 stated legs) or dedicated (out and back). A distance given in a mode that does not read it is refused.
7. Fleet sizing, as a stated rule: voyages = max(demand/capacity, minimum visits), rounded `up` or `none`; vessel-days = voyages x voyage days; vessels rounded `up`, `nearest` (halves up) or `none`. When demand and minimum visits are equal, demand is named as the driver; with neither, the driver is "no demand". The shortfall is reported, and so is a voyage longer than the available days.
8. Available days (at most the period) are stated; the crew-change and maintenance allowance is the user's.
9. The deck plan is an area bound with no stacking and no shape check. FFD sorts by area, then heavier first, then item id, then unit number; `first-fit` keeps the booked order. Overflow is named per unit with one of three reasons. Lower bound = max of ceil(area / usable area) and ceil(weight / deck load).
10. The shore base runs on the working-hour clock. Service = fixed hours + lift and bulk hours, summed or the maximum when `concurrent` is true (no default).
11. M/M/c uses Erlang C. M/D/c uses Cosmetatos, labelled as an approximation, with no delay probability. A steady state needs rho strictly below 1; otherwise the refusal prints the largest accepted arrivals.
12. The berth target is the fewest berths, from floor(a) + 1 up to 100, whose mean wait is at or below the target (inclusive). If none meets it, that is reported.
13. Monte Carlo: weather and then demand factors are drawn, each only when it varies; the demand factor scales all demand; each iteration is sized exactly as fleetSize; short means strictly above planned vessels x available days; P90 is the 10th percentile (low) and P10 the 90th (high).

## Boundary table

| rule | at the boundary | one past | golden |
|---|---|---|---|
| capacity | load = capacity feasible | 1 t over overloaded | voyage-at-capacity-feasible / voyage-one-over-deck-load |
| decimal sums | 0.1 + 0.2 fits 0.3 | | voyage-decimal-sum-at-capacity, deck-decimal-footprints-fill-exactly |
| binding tie | deck area named | | voyage-binding-tie-goes-to-deck-area |
| voyages up | exactly 3 is 3 (2.1/0.7 = 3.0000000000000004 is 3) | 300.001/100 is 4 | fleet-demand-exactly-three-voyages, fleet-decimal-ratio-2-1-over-0-7-is-three / fleet-demand-just-over-three-voyages |
| demand vs minimum visits | equal: demand named | minimum visits named | fleet-min-visits-equal-demand-names-demand / fleet-min-visits-drive |
| vessels nearest | 1.5 rounds to 2 | 1.416667 rounds to 1, shortfall reported | fleet-vessels-nearest-half-rounds-up / fleet-vessels-nearest-short |
| vessels up | exactly 2 x available gives 2, utilisation 1 | | fleet-vessel-days-exactly-two-vessels |
| available days | = period accepted | 7.5 > 7 refused | fleet-available-equals-period / fleet-refuse-available-above-period |
| MC short | at capacity not short | one vessel fewer always short | variability-at-capacity-is-not-short / variability-one-vessel-short-always |
| iterations x sets | 181,818 x 11 accepted (gate) | 181,819 refused | variability-refuse-draws-cap |
| deck fit | exact fill inclusive | over deck load is overflow | deck-exact-fit-inclusive / deck-item-heavier-than-deck-load |
| steady state | rho 0.9995 accepted | rho 1 refused, prints 19.999999 | base-just-below-saturation / base-refuse-saturated-exactly |
| printed bound | 26.666666 accepted | 26.666667 refused | base-refuse-saturated-thirds |
| berth target | wait = target met | target 0 unreachable, reported | base-target-met-exactly-by-current / base-target-zero-unreachable |
| weather factor | 1 accepted | 0.9 and 10.5 refused | ekene-voyage-calm / voyage-refuse-weather-below-one, -above-cap |
| usable fraction | 1 accepted | 0 and 1.1 refused | voyage-refuse-usable-fraction-zero, -above-one |

## Caps and timing

Node 18.19.1, milliseconds, one run each: voyagePlan 4 installations 4.0, 50 installations 3.1; fleetSize 4 installations 2.0, 50 installations 2.6; fleetVariability 4 sets x 20,000 iterations 174, 4 x 200,000 1,288, 50 x 20,000 1,061, 50 x 40,000 2,050; deckPlan 61 units 1.9, 610 units / 20 voyages 7.8, 2,000 units / 500 voyages 92; shoreBase with target search 0.7, 100 berths search to the cap 0.12. Before the draws cap, 50 sets x 200,000 iterations took 14.5 s, which is why iterations x voyage sets is capped at 2,000,000.

## Negative control (54/54 engine red, 8/8 oracle caught, 0 skipped)

Engine plants:
- Voyage time and fuel: weather on every activity, weather ignored, knots read as km/h, return leg dropped, dedicated voyage one way, every activity burning at the sailing rate, price per thousand tonnes.
- Capacity: usable fraction ignored (voyage and deck), deadweight without bulk, m3 counted as tonnes, binding tie to the last, load at capacity counted as overloaded, zero tank accepted.
- Fleet sizing: voyages rounded to nearest, counts rounded up without the 12-digit key, minimum visits ignored (fleetSize and Monte Carlo), a demand/visits tie named as minimum visits, nearest halves rounded down, vessels divided by the period, shortfall never reported, available days above the period accepted.
- Queueing: Erlang B recursion one step too far, wait without 1 - rho, Cosmetatos correction dropped, M/D/c answered as M/M/c, concurrent service summed, 24-hour clock, rho = 1 accepted, berth target strict, printed bound not moved to the accepted side.
- Deck plan: FFD ascending, FFD tie lighter first, deck load ignored, last fit, deck fit exclusive.
- Monte Carlo: draw order swapped, P90 and P10 swapped, seed ignored, short at equality, demand factor ignored, weather on every activity, draws cap ignored.
- Inputs and wording: unknown keys ignored, unknown product ids ignored, missing tank read as 0, milk-run distance ignored, weather cap 12, and five wording plants.

Oracle plants: Erlang C sum to c, binding tie to the last, weather on every activity, FFD ascending, unknown keys ignored, M/D/1 without the half, P90 read at the 90th percentile, minimum visits ignored.

## Decisions for the lead

1. No open offshore paper prints a deterministic fleet-sizing example with a vessel count. Fleet sizing is validated through its published parts (Skoko) plus the oracle and boundary goldens, and the rule is taught as stated.
2. M/D/c uses the Cosmetatos approximation (cited through CC BY arXiv 2102.05851), labelled approximate, with no delay probability.
3. The shore base runs on the working-hour clock; night holding and berth-specific cranes are out of scope.
4. The deck plan is an area bound. `first-fit` is kept as a teaching contrast: on the Ekene deck it strands a 35.1 m2 casing bundle where FFD leaves 16.5 m2 of small units.
5. Usable deck fraction is a required input (Ekene 0.75; Skoko uses 85% on capacity). Deadweight is the user's net figure; there is no stowage factor.
6. The Monte Carlo varies one common weather factor and one common demand factor, drawn in that order.
7. Next steps: the Suite app "Marine Logistics Planner" and the NextGen `marine` course. Aas et al. taught by concept only; Wikipedia is CC BY-SA (cite, do not paste); Skoko and arXiv are CC BY 4.0.

## Lead decisions (2026-09-27)

1. All seven defaults above are accepted. A printed fleet-sizing golden can be added later without an engine change if the owner supplies a source.
2. Adan and Resing and Iversen print no licence: figures and formulas are cited, prose is never quoted. The Table 5.1 c = 5 figure (printed 1.53, exact 1.524986) is taught as a printed slip.
3. The Skoko PSV total is left out because the rounded table days do not reproduce it; the course says so.
4. This file was committed by the lead with the owner's approval (the wave agent could not create it).
