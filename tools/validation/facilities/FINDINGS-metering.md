# FINDINGS: metering, control valves and storage (FC8-0, 2026-09-16)

The repair wave before the NextGen Metering, Control Valves and Storage
course, taken against `engines/facilities/metering.js`,
`controlValve.js` and `storageTank.js` at engines main `06ad75b`, over
their two goldens, two oracles and two jest suites, and over the three
LIVE Suite studios that call them. THE RECON THAT ORDERED THIS WORK IS
THE SECOND HALF OF THIS FILE, unchanged: 64 findings, 29 LIVE, 13 fail
open, 10 held for literature. This first half records what changed and
why.

Twenty-nine findings were reachable by typing into a box in a shipped
studio. Thirteen of them failed OPEN: a wrong answer, an unmoved answer
or a non-finite one with no `error` key, so every caller's guard passed
and the studio printed a figure or a dash where a fault belonged. One was
a safety number that might have been twenty four times too small.

## THE ONE THAT IS NOT REPAIRED, AND WHY

**The emergency vent capacity is WITHHELD.** `fireVenting` computed

    scfhAir = 1107 * Q / (L * sqrt(M * tempR)) * Math.sqrt(1)

Three things are wrong on the face of that line without needing any
standard. The `* Math.sqrt(1)` is dead, and it is where a temperature
RATIO was clearly meant to go. 1107 is a field-unit packaged constant
with a reference temperature already folded into it, so it cannot coexist
with a free absolute temperature in the same denominator: the value of
the relation would then depend on whether the temperature were written in
Rankine or in Kelvin, which no physical relation does. And `tempR` was an
input no screen exposed, defaulting to 560 R and moving the headline
answer by 29 percent across 400 to 800 R.

If the customary packaged form `1107 Q / (L sqrt(M))` is the right one,
the line **under-stated the required vent by sqrt(560), which is 23.7
times**: the studio's own default tank showed 1,678,956 scfh of air where
the packaged form gives 39.7 million.

The API 2000 air-equivalence relation is not in this repository. It
cannot be reconstructed from memory, and it must not be chosen by
whichever form makes the number look reasonable. An emergency vent sized
twenty four times too small is precisely the failure the module's own
header says destroys tanks, and a number that might be wrong in that
direction is worse than no number, because a figure on a screen gets
bought.

So the duty is computed and returned, with its band, and the vent
capacity is `null` with `ventWithheld: true` and a named reason that
says which standard is missing, what was wrong with the line that was
there, how large the discrepancy is, and where to get the answer
instead. The Storage Tank studio prints "withheld" with that reason
beside it, and the help guide says the same. **Recorded as WITHHELD, not
repaired.** The duty above it is ready for the relation the moment
somebody puts API 2000 in the repository with a clause number.

Ten items are HELD FOR LITERATURE on the same principle, recorded and
exposed as stated limits, never graded and never cited to an invented
source: the air-equivalence relation above, API 650's minimum shell
plate thickness band table, the one-foot method's diameter limit, the
fire case's wetted-area ceiling, the API 2000 thermal venting table
above the capacity where it stops being proportional, the ISO 5167 or
AGA 3 straight-run column for two elbows out of plane, the published
Reynolds floor of the Reader-Harris/Gallagher correlation, the ISA
Reynolds number factor FR with the valve style modifier fd, the API MPMS
temperature and pressure correction tables, and the style table's own FL
and xT values with the sigma thresholds. Each one is named where it is
used. Every module header now carries a WHAT THIS PACKAGE DOES NOT CARRY
list.

## THE SCREEN THAT COULD NOT FIRE

**A liquid sizing with no vapour pressure is now refused.** The
cavitation index was

    sigma = pvPsia > 0 ? (p1Psia - pvPsia) / dpStated : Infinity

with `pvPsia` defaulting to zero. An infinite index takes the last branch
of the regime ladder, so **every liquid service at every pressure drop
reported `regime: 'stable'` with `warning: null`**, and the Suite's
`num(inputs.liquid.pvPsia, 0)` meant that CLEARING THE Pv BOX supplied
exactly that default. The studio printed Sigma "n/a" beside Regime
"stable" in green. The whole cavitation screen, which the module header
calls the point of the module, was switched off by an empty box.

Every liquid has a vapour pressure at its flowing temperature, so there
is no legitimate case to preserve. The engine refuses and says why, the
studio passes the box through with no fallback, and no finite input can
now produce an infinite index.

Two smaller route repairs in the same class. The index is computed on the
drop the valve ACTUALLY USES rather than the stated drop, so a choked
service no longer reports an index belonging to a pressure drop the valve
cannot take. And the recovery factor and terminal ratio overrides are
bounded to the fractions they are: `flOverride: 5` used to give an
allowable drop of 4881 psi on a 200 psia inlet, which is more drop than
the system has pressure.

## THE VERDICT OVER CHECKS THAT DID NOT RUN

`travelCheck` returned `pass: true` HAVING PERFORMED ZERO CHECKS. Every
warning was guarded on a non-null travel except the maximum one, so a
missing minimum flow skipped the near-seat rangeability check silently
and the studio printed **Verdict: WORKABLE** in green. This is FC1's
fail-open droplet verdict and FC7's skipped-device verdict in a third
engine.

It now counts. `checksRun`, `checksSkipped`, `checksPerformed` and
`checksPossible` come back with the answer, `pass` is WITHHELD as null
whenever any of the three flows is missing, and `passWithheldReason`
names which checks did not run and what is therefore not known. The
studio prints "NO VERDICT" with the count beside it.

And one null used to mean two different things, with the alarming reading
winning: `maxTravelPct === null` meant either "this Cv is beyond the
valve" or "you gave me no maximum flow", and the warning pushed was "the
maximum flow needs more Cv than the valve is rated for: it will not pass
the design case". A box the user had simply not filled in printed that in
red. `minState`, `normalState` and `maxState` now carry `ok`,
`beyond the valve` or `not given`, and the studio renders the three
differently.

## THE BAND THAT COULD NOT SEE ITS OWN QUANTITY

`noiseIndication` computed a stream power and then banded the service on
the pressure ratio alone. **A 1 scfh bleed at a ratio of 12 read "severe"
with the multistage-trim warning, and a valve passing 100 MMscfh at a
ratio of 1.9 read "low" with no warning at all.** The power moved
nothing and was never displayed. Three separate defects planted in the
function all left the suite green, which is why nobody noticed: it had no
oracle route and no golden row.

The pressure ratio still sets the band, and the stream power now CAPS AND
FLOORS it, because a trickle cannot be loud however hard it is throttled
and a thousand kilowatts is not quiet however gently. Both sets of
thresholds are the engine's stated screen and say so. The power, the mass
flow and the band the ratio alone would have given are all returned and
displayed, and the function refuses an outlet pressure of zero and a
missing gas gravity or temperature rather than answering cheerfully with
an Infinity or a NaN.

## THE TWO ROUTES THAT NEVER MET

`transmitterUncertaintyPct` computed a differential uncertainty from a
reading and a span; `orificeUncertainty` took a TYPED figure and could
not accept a reading or a span at all. At the Flow Metering studio's own
defaults the transmitter said 0.15 percent and the budget used 0.5
percent, **in adjacent cards on the same screen**. Worse, the budget put
the discharge coefficient at 64.687 percent of the variance and the
differential at 16.172 percent, while the module header said the
transmitter "contributes far more than the plate bore ever does", the
engine's own note said improving anything else was wasted effort about
the Cd, and the app's body copy said "A more precisely bored plate buys
nothing when the differential transmitter dominates the budget".

The budget now takes the reading, the span and the transmitter accuracy
and DERIVES the differential term, reporting
`differentialUncertaintySource` so a reader can see where it came from.
The typed figure is still accepted when no reading and span are given.
The three claims are corrected in the engine header, the engine note and
the app copy: which term leads is a result, it depends on where the run
sits in its span, and the studio shows the runner-up and its share
beside the leader. A dead heat now says it is one instead of naming a
winner and telling the user to spend money on it.

## A DIFFERENTIAL TURNDOWN IS NOT A FLOW TURNDOWN

`transmitterUncertaintyPct` returned `turndown = spanInH2O / dpInH2O` and
warned above 3 with the sentence "An orifice run has a usable turndown of
about three to one because of exactly this". Flow through an orifice goes
as the SQUARE ROOT of the differential, so a differential turndown of 3
is a flow turndown of 1.73, and the three-to-one flow rule is a
differential turndown of NINE. **The warning fired about five times too
early** and its sentence conflated the two quantities, and the Suite
compounded it with a tile labelled "Turndown ... to 1" above a paragraph
repeating the flow rule.

Both turndowns are now returned by name, with both limits, and the rule
is applied to the flow one. The studio shows two tiles and the help guide
says the two are constantly swapped. The square-root law itself is proved
in the suite through the flow equation rather than asserted in a
sentence: four times the differential gives 1.9958 times the flow.

## THE TABLE THAT NO PUBLISHED TABLE LOOKS LIKE

`straightRunDiameters`'s `twoElbowsDifferentPlanes` column returned 34,
50, 75, 65, 60, 80 upstream diameters at beta 0.2, 0.4, 0.5, 0.6, 0.67
and 0.75. **It fell by 15 diameters as beta rose from 0.5 to 0.6 and then
rose by 20.** A published straight-run requirement rises with beta; this
one cannot be right, and it cannot be repaired without the table.

That fitting is WITHHELD by name, at all six of its own breakpoints, and
the Suite renders the refusal where it used to render 75 diameters. Two
elbows out of plane is the worst common upstream arrangement, so the
refusal says to take the requirement from the standard or fit a flow
conditioner. The four remaining columns are labelled as this engine's
stated table data, because none of them is cited to a document here
either, and the suite asserts every one of them rises monotonically in
beta across twelve betas: the property the withheld column violated.

Nothing is answered above beta 0.75 now either. The table used to fall
through to its last row and return 44 diameters at beta 0.95, where the
flange-tap correlation the whole module rests on stops being published.

## THE REST OF THE THIRTEEN FAIL-OPENS

| export | what it did | what it does |
| --- | --- | --- |
| `evaporativeLosses` | standing loss of MINUS 29,008 lb/yr at 30 psia TVP, Infinity at exactly 14.7, and a total still printing positive at 466.8 short tons/yr | refuses a true vapour pressure at or above the STATED atmospheric pressure, and says a product that boils at ambient is not a fixed-roof tank problem |
| `evaporativeLosses` | `turnoversPerYear` moved the total 0.000000 percent over 1 to 500 turnovers and was echoed back in the result | the input is GONE, with a note saying AP-42's Kn is not carried here and the turnover effect is the stated `workingTurnoverFactor` |
| `movementVenting` | no error path of ANY kind, returning negative venting that `normalVenting` added into its totals | refuses a negative rate by name, and `normalVenting` propagates it |
| `tankCapacity` | accepted a negative fill and printed "Working -20,143 bbl" | refuses it: a tank does not hold less than nothing |
| `lossControl` | NaN with no error for a missing efficiency, and a silent clamp of an impossible 150 percent | refuses both, and says that leaving it out is not the same as saying zero |
| `fireVenting` | any environment factor, so 5 multiplied the duty fivefold | bounded to 0 to 1, because it is a credit |
| `thermalVenting` | any latitude factor, and a proportional rate extrapolated to any capacity | bounded, and a tank above the stated proportional limit is warned rather than silently extrapolated. The studio's own 80,574 bbl default is flagged |
| `sizeOrifice` | returned beta 0.05 and a bore BESIDE its own error, because a refused flow mapped to NaN and every comparison against NaN is false | every error path returns an error and nothing else, proved by a plant that removes all four guards |
| `noiseIndication` | an infinite ratio and power at p2 = 0, and a NaN power with a "moderate" band on a missing gravity | refuses both by name |
| `travelCheck` | see above | see above |
| `liquidValve` | see above | see above |
| `expansibility` | a bare NaN with no beta guard and no check that the differential was below the static pressure | guarded, and the real case is named in `orificeFlow`: a differential above the static pressure used to be reported as "a positive pipe Reynolds number is needed" |
| `orificeUncertainty` | named a dominant term on a photo finish and told the user improving anything else was wasted effort | reports the runner-up, its share, and whether the lead is clear |

## THE STUDIOS

Two hidden persisted inputs had no field anywhere, came back from every
saved study, and moved the answer. Valve `fp` divides into every required
Cv, a 50 percent swing across its range; tank `latitudeFactor` scales
thermal inbreathing linearly, a 75 percent swing on the number the app
labels the governing vacuum case. **A persisted input nobody can see is
not a setting, it is a trap.** Both are exposed as fields with hints. The
minimum plate thickness is exposed too, because the studio showed
"minimum plate thickness" as a governing reason with no number attached
to the phrase.

**The tank defaults contradicted themselves before anyone touched them.**
A 40 ft shell at a 38 ft design liquid level is 2 ft of vapour space; the
losses block defaulted `vapourSpaceHeightFt` to 12 and nothing linked
them, so the standing loss shown was 17,276 lb/yr where the tank as drawn
implies 4,854, a factor of 3.56, with the saturation factor moving from
0.512 to 0.863. The vapour space is now DERIVED from the shell height
less the design liquid level, displayed as a derived quantity, and the
studio refuses when the level reaches the shell top.

**The Control Valve studio's "Body velocity limit" card advertised a
check it could not perform.** It computed an API RP 14E erosional
velocity and never computed an actual velocity, because the valve has no
flow area, so nothing was ever compared and the copy's claim that a valve
can erode its own body could not be detected. It also applied a two-phase
continuous-service C factor to a single-phase liquid without saying so.
The card now takes an outlet bore, computes the in-situ velocity of the
maximum case through it, compares the two, prints the percentage of the
limit and warns when it is exceeded, and the C factor is a stated choice
from the published presets.

Also: travel printed to one decimal, matching the engine warnings the
tiles sit beside, which the engine carries four dedicated tests about.
The sizing result's own warning rendered, because `sizeOrifice`'s "beta
above 0.6" warning was attached to a number in one card while only the
other card's warning was displayed. The recommended characteristic
rendered in words rather than an identifier, with a warning when it
disagrees with the trim selected. The two identically labelled "Vapour
MW" fields resolved, because the fire case no longer needs one. Short
tons said out loud. Every derived block in all three contexts wrapped in
a try/catch, so a throw shows a message rather than a blank studio. And
the silent defaults removed from the boxes that move an answer, so an
empty numeric box is no longer the same input as a typed one.

## THE GATE

**Before: 25 of 64 defects planted in these three engines left both
suites 40 of 40 GREEN**, including the entire AP-42 evaporative loss
chain in five different ways, the entire API 2000 thermal venting chain
in three, the 1107 emergency vent constant doubled, dropping
sqrt(tempR), the minimum plate thickness, the barrel changed from 42 to
55 gallons, and the whole of the noise indication. **And 8 of 13 planted
in an engine and its oracle together survived**, because a golden
regenerated from a changed oracle agrees with a changed engine; the five
that were caught were all caught by a literal typed into the test, never
by a golden.

Seven of the ten storage tank exports had NO oracle route and NO golden
row at all, and three of the ten control valve exports had none, which is
exactly where the defects were.

**After: 0 green.** 54 of the original 64 still patch and all 54 are red.
The other 10 no longer patch because the code is gone or restructured,
and because PATCH-FAILED is not the same as caught, all 10 are
re-expressed against the repaired source: 31 adapted plants, all red.
Three are unplantable by removal, which is the strongest outcome
available: the 1107 constant and its sqrt(tempR) went with the withheld
vent, and `permanentLoss`'s 0.61 default went because the coefficient is
required. The shared battery is 0 green of 8 adapted plants, and one of
the original thirteen is now impossible to plant in both files at all,
because the oracle contains no 1360 to change.

Goldens: **67 rows in 9 groups before, 129 rows in 22 groups after.** The
two suites go from 40 tests to 96.

### Which routes are real, measured rather than described

Five golden groups were transcriptions: `cd`, `liquid`, `gas`,
`gasMarch` and `boundary` reproduced 51 of their 53 rows BIT FOR BIT, at
exactly 0.000 percent of tolerances as tight as 1e-12. Two independent
arithmetics do not land on the same IEEE double. Both suites now print a
MARGIN REPORT on every run, so a route that has collapsed onto a
transcription shows as 0.000 percent and cannot hide.

| route | what it checks | what it cannot |
| --- | --- | --- |
| orifice mass flow | the 32.174, 144 and 0.0361273 packagings, entirely in SI | the published coefficients |
| uncertainty | the root-sum-square, against a 200,000-sample Monte Carlo | nothing: it is a different method |
| shell thickness | the 2.6 field constant, re-derived from rho g H D over 2 S in SI | the one-foot offset, which is recovered from the engine and pinned by literal |
| evaporative loss | the 10.731 field gas constant, from the SI gas constant and a molar mass in kg/mol | the empirical 0.053 and the shape of Ke, both pinned by recovery and literal |
| gas Cv | THE 1360 PACKAGING, through moles, cubic metres, bar and a metric Kv. This is the route the docstring used to claim and did not contain | the style table's xT |
| choking boundary | the boundary LOCATED FROM THE ENGINE'S OWN Cv OUTPUTS, never from its choked flag | nothing, now that the predicate is no longer transcribed |
| equal-percentage travel | a round trip: a travel gives a Cv, the engine must give the travel back | the rangeability default, pinned by literal |
| noise | 379.49 cubic feet per pound mole and the 287 J/(kg K) of air, both from the SI gas constant | the bands, pinned by literal |
| Reader-Harris Cd, liquid Cv | the assembly and the floating-point arithmetic, in 60-digit decimal, AND the suite now requires a last-bit disagreement so the routes cannot silently collapse back together | the published coefficients, pinned by literal |
| fire duty | nothing: it is a transcription and the margin report says 0.000 percent | the constants, which are pinned by the BAND-EDGE CONTINUITY property instead |
| capacity, movement venting | the assembly. The SI barrel is 42 gallons by definition, so it is the module's own packaging carried through exact conversions | the 42 gallons, which is pinned by literal |

Three new property checks do work no value comparison can:

 - **the fire band edges.** Four power laws that have to join up at 200,
   1000 and 2800 square feet cannot be moved one at a time. The old gate
   was `expect(q).toBeGreaterThan(prev * 0.5)`, which tolerates a
   factor-of-two discontinuity, and that is exactly why a 0.500 exponent
   in place of 0.566 went green. The join is now asserted within 1
   percent at each of the three edges, and it currently holds to 0.07.
 - **the monotonic straight-run columns**, which is the property the
   withheld column violated.
 - **the Cv definition.** A 2 percent factor planted in the engine and
   the oracle together survived everything, because the liquid form has
   no packaging constant to compare: `Q sqrt(SG/dP)` IS the definition of
   Cv. So the definition is the test. One US gallon a minute of water at
   one psi must give a Cv of exactly 1.

### The constant register, and what a literal is worth

Some numbers here have no publication in this repository, so no route can
validate them: the style table's sixteen FL and xT values, the sigma
thresholds of 2 and 3, the authority thresholds, the noise bands, the
Reader-Harris coefficients, the expansibility coefficients, the AP-42
coefficients, the API 650 allowables and the thermal venting factors.

They are pinned by LITERAL in the suites, in a block that says in its own
comment exactly what that is worth: **it detects silent change and
nothing more, it does not validate anything against a publication, and
the values must never be regenerated from the engine.** Where a constant
can be isolated from the engine rather than pinned by value it is: the
leading Reader-Harris coefficient is read off at vanishing beta and
infinite Reynolds number, the one-foot offset is recovered from the slope
of two thicknesses, the saturation coefficient and the 365 days are
recovered from a loss result, the recovery factor is recovered from the
allowable drop, and the Rankine offset is recovered from two sizings at
different temperatures. Those recoveries are what make the shared plants
red.

Thirteen negative controls prove each new check fires and print the case
they name, including one that shows the OLD factor-of-two band gate
accepting the exponent the new one rejects.

### What the control on the controls caught in this wave's own work

A defect planted in the ORACLE ALONE, with the golden regenerated, must
go red. Ten of eleven do. The eleventh was mine: changing the Btu to
joule conversion in the fire duty route left the suite green, because the
route multiplied the band constants into SI and divided them straight
back out again. The conversion cancels exactly. That is the same
decoration FC4 found in the TEG and amine routes, and shipping it inside
a repair that exists to remove such things would have been the worst kind
of miss. It is gone, and so is the same pattern in the saturation
coefficient. **A route that says SI and multiplies by a constant and then
divides by it is not a unit check.** The one remaining green is the Monte
Carlo seed, which is green by design; cutting the sample count from
200,000 to 2,000 goes red, so the tolerance is not so loose that the
method is decorative.

---

# FC8 `metering` FINDINGS: Metering, Control Valves and Storage

Subject: `engines/facilities/metering.js`, `engines/facilities/controlValve.js`,
`engines/facilities/storageTank.js`, their goldens
`test-data/facilities/goldens/tanksmetering_cases.json` and
`controlvalve_cases.json`, their oracles
`tools/validation/facilities/oracle_tanksmetering.py` and
`oracle_controlvalve.py`, their jest suites
`__tests__/facilities.tanksmetering.test.js` and
`facilities.controlvalve.test.js`, and the three LIVE Suite studios that
call them.

Engines canonical `82ec6d4`. Every figure below came from running the
engine, the oracle or the suite, never from reading the source.

> THIS FILE IS PROVENANCE, NOT TEACHING TRUTH. It is a repair brief. No
> writer may quote it, and no number in it may reach a lesson, a panel or
> a bank question. The teaching digest is built after FC8-0 lands, from
> the repaired engines.

A finding is **LIVE** when it is reachable today by typing into a box in
one of the three shipped studios AND produces a wrong, unmoved or
non-finite number on a screen.

**64 findings. 29 are LIVE. 13 FAIL OPEN. 3 are CRITICAL or HIGH and
wrong at a studio's own shipped defaults.**

| class | count | of which LIVE |
|---|---|---|
| A FAILS OPEN | 13 | 5 |
| B AN INERT OR DECORATIVE INPUT | 8 | 4 |
| C TWO ROUTES THAT DISAGREE | 6 | 4 |
| D A SUMMARY THAT DEGENERATES OR IS ABSENT | 7 | 5 |
| E AN UNGUARDED CORRELATION OR STANDARD | 9 | 3 |
| F A CONSTANT OR LABEL WITH NO PROVENANCE | 7 | 1 |
| G A UNIT OR CONVENTION MISMATCH | 4 | 3 |
| H THE SUITE LAYER, remaining | 10 | 4 |
| **total** | **64** | **29** |

By file: 18 in `metering.js`, 14 in `controlValve.js`, 15 in
`storageTank.js`, 17 in the three Suite studios.

Ten findings are HELD FOR LITERATURE: A11, E1, E2, E3, E6, E7, E8, E9,
F1 and H4. They are recorded, must be exposed as stated limits, and must
never be graded. No citation is invented anywhere in this file.

The five that matter most, in order:

1. **F1. The emergency vent conversion divides by the square root of an
   absolute temperature as well as the molecular weight, with a dead
   `* Math.sqrt(1)` beside it.** If the customary `1107 Q / (L sqrt(M))`
   is the relation, the required vent is under-stated by a factor of 23.7
   and the default tank's 1.68 million scfh should be 39.7 million. An
   undersized emergency vent is the failure the module's own header says
   destroys tanks.
2. **A1. The valve cavitation screen is switched off by an empty box.**
   At `pvPsia = 0`, which is both the engine default and what the Suite
   supplies when the Pv field is cleared, sigma is Infinity and every
   liquid service at every pressure drop reports `regime: 'stable'` in
   green with no warning.
3. **A2 and D1. `travelCheck` passes on checks it did not run, and its
   one null means two different things.** A missing minimum flow skips
   the near-seat rangeability check and the studio prints
   "Verdict: WORKABLE"; a missing maximum flow prints "it will not pass
   the design case".
4. **A3. A volatile product returns a negative annual emission.** At
   30 psia true vapour pressure the standing loss is minus 29,008 lb/yr,
   the total is still positive at 466.8 tons/yr, and nothing errors.
5. **The gate cannot see most of this.** 25 of 64 defects planted in the
   engines alone left both suites 40 of 40 green, including the entire
   AP-42 loss chain, the entire API 2000 thermal venting chain, the
   emergency vent conversion, the barrel-to-cubic-foot constant and the
   whole of the noise indication. Seven of the ten storage tank exports
   have no oracle route and no golden row at all. Measured in RECON.md
   section H.

The gate's own blindness is measured separately, in section H of RECON.md,
because it is a property of the goldens rather than a defect in a file.


## A. FAILS OPEN

**A1. CRITICAL, LIVE, FAILS OPEN. The valve cavitation index can never
fire at the engine's own default vapour pressure.** `controlValve.js`
computes `sigma = pvPsia > 0 ? (p1Psia - pvPsia) / dpStated : Infinity`,
and `pvPsia` defaults to `0`. An infinite sigma takes the last branch of
the regime ladder, so the answer is `regime: 'stable'` for every liquid
service at every pressure drop, with `warning: null`. In the Suite,
`ValveStudioContext.jsx` reads the vapour pressure through
`num(inputs.liquid.pvPsia, 0)`, so CLEARING THE Pv BOX supplies exactly
that default. Inputs: 500 gpm, 200 to 150 psia, sg 0.85, globe cage,
Pv box empty. The engine returns `sigma: Infinity`, `regime: 'stable'`,
no warning, and the studio prints Sigma "n/a" beside Regime "stable" in
GREEN. The whole cavitation screen, which the module header calls the
point of the module, is switched off by an empty box. Should REFUSE a
liquid sizing with no stated vapour pressure, or withhold sigma and the
regime and say the screen did not run.

**A2. HIGH, LIVE, FAILS OPEN. `travelCheck` reports `pass: true` after
performing zero checks.** `travelFor` returns `null` for any Cv that is
not positive, and every warning is guarded on a non-null travel except
the maximum one. So a missing minimum flow skips the near-seat
rangeability check silently. Inputs: the Control Valve studio at its
defaults with the Min (gpm) box cleared. The Minimum case returns
`{error: 'no flow stated'}`, `cvOf('Minimum')` returns NaN,
`minTravelPct` is null, no near-seat warning is pushed, and the studio
prints **Verdict: WORKABLE** in green. Measured directly:
`travelCheck({cvRequiredNormal: 45, cvRequiredMax: 75, cvRated: 100})`
returns `minTravelPct: null` with the near-seat check absent. This is
FC1's fail-open droplet verdict and FC7's skipped-device verdict in a
third engine: a verdict computed over checks that did not run. Should
return a count of checks performed and withhold `pass` when any of the
three flows is missing.

**A3. HIGH, LIVE, FAILS OPEN. `evaporativeLosses` returns a negative
annual emission for a volatile product, and an infinite one at exactly
atmospheric pressure.** The vapour space expansion factor is
`ke = dT/T + max(0, Pva*(dT/T) - ventSetting) / (atmosphericPsia - Pva)`
with `atmosphericPsia = 14.7` and no guard that `Pva < 14.7`. Inputs: the
Storage Tank studio's own default tank (120 ft, 12 ft vapour space,
65 MW, 20 F swing, 500,000 bbl/yr) with the True vapour pressure box set
to 30 psia, which is an ordinary summer butane or a light natural
gasoline. Returns `expansionFactorKe: -0.0343`, `standingLossLbYr:
-29,008`, and because the working loss is unaffected the total is still
POSITIVE at 466.8 tons/yr, so the studio prints a plausible headline
above a negative standing loss with no error. At Pva exactly 14.7 the
factor is Infinity and the studio prints "--". Should refuse a true
vapour pressure at or above the stated atmospheric pressure and say that
a product that boils at ambient is not a fixed-roof tank problem.

**A4. MEDIUM, FAILS OPEN. `lossControl` returns NaN with no error when
the efficiency is missing, and silently swallows an impossible one.**
`Math.min(Math.max(undefined, 0), 100)` is NaN, so
`lossControl({uncontrolledLbYr: 1e5})` returns
`savedLbYr: NaN, remainingLbYr: NaN` and the customary-range note as
though it had answered. A typed 150 percent is clamped to 100 with no
flag. Engine level only: the Suite supplies `num(..., 0)`.

**A5. MEDIUM, FAILS OPEN. `movementVenting` has no guard of any kind and
returns negative venting.** It is the only export in the three modules
with no error path at all.
`movementVenting({fillBblPerHr: -500, drawBblPerHr: -800})` returns
`outbreathingScfh: -2807.3, inbreathingScfh: -4491.7`, and
`normalVenting` adds those straight into its totals.

**A6. MEDIUM, LIVE, FAILS OPEN. `tankCapacity` accepts a negative fill
height.** `fillHeightFt: -10` on the default tank returns
`workingBbl: -20,143`, which the studio prints as "Working -20,143 bbl".
`Math.min(fillHeightFt, heightFt)` caps the top and never the bottom.

**A7. MEDIUM, FAILS OPEN. `noiseIndication` divides by the outlet
pressure with no guard, and answers cheerfully on missing gas
properties.** `p2Psia: 0` gives `pressureRatio: Infinity`,
`streamPowerKw: Infinity`, `band: 'severe'` and the multistage-trim
warning, with no error. Omitting `gasSg` or `tF` gives
`streamPowerKw: NaN` with `band: 'moderate'` and no error, because the
band is computed from the pressure ratio before the stream power is
touched.

**A8. MEDIUM, FAILS OPEN. `flOverride` and `xtOverride` are accepted
without an upper bound.** A recovery factor is a fraction by
construction. `liquidValve({..., flOverride: 5})` returns
`dpAllowablePsi: 4881` on a 200 psia inlet, which is a larger pressure
drop than the system has pressure, and the service is then reported
unchoked for any outlet.

**A9. MEDIUM, FAILS OPEN. `sizeOrifice` returns a bore alongside its own
error.** `at()` maps a refused `orificeFlow` to NaN, and `NaN < target`
is false, so both bracket guards pass and the bisection walks to the low
bracket. `sizeOrifice({pipeIdIn: 6.065, targetMassLbHr: 50000,
dpInH2O: 0, ...})` returns
`{beta: 0.05, orificeIdIn: 0.30325, error: 'flow needs a positive
differential, density and viscosity'}`. A caller that reads `.beta`
before `.error` sizes a plate from nothing. The Suite happens to check
`.error` first.

**A10. MEDIUM, FAILS OPEN. `expansibility` returns a bare number or a
bare NaN rather than an error object, and nothing that calls it checks.**
It has no beta guard at all and no check that the differential is below
the static pressure. `expansibility({beta: 0.5, dpPsi: 600,
p1Psia: 500, k: 1.3})` returns NaN, because a negative pressure ratio
raised to a fractional power is not a number.

**A11. MEDIUM, FAILS OPEN. `fireVenting` accepts any environment factor
and has no upper wetted-area bound.** `environmentFactor: 5` is taken at
face value and multiplies the duty; the factor exists to take a credit
for drainage or insulation and cannot exceed one.
`fireVenting({wettedFt2: 100000})` returns 264 MMBtu/hr with no warning
that the standard's relations and the fire case itself stop applying to a
tank that large. The cap is HELD FOR LITERATURE.

**A12. MEDIUM, LIVE, FAILS OPEN. Clearing a box is treated as agreeing
with a number, in all three studios.** Each context's `num(v, fallback)`
supplies a silent default: valve `pvPsia` to 0 (which is A1), valve `fp`
to 1, valve `z` to 1, valve `k` to 1.4 in the engine and 1.28 in the app,
tank `latitudeFactor` to 1, tank `controlEfficiencyPct` to 0, meter `k`
to 1.3, meter `dpUncertaintyPct` to 0.5. An empty numeric box should not
be the same input as a typed one.

**A13. LOW, FAILS OPEN. `turbineVolume` accepts any meter factor.**
`turbineVolume({pulses: 1e6, kFactorPulsesPerBbl: 1000,
meterFactor: 100})` returns `grossBbl: 100,000` from 1,000 indicated
barrels. A meter factor from a proving run lives within about one percent
of unity, and a value outside that band is a proving failure rather than
a volume.


## B. AN INERT OR DECORATIVE INPUT

**B1. HIGH. `turnoversPerYear` moves nothing and is echoed back as
though it had.** Swept 1, 12, 36, 100 and 500 turnovers on the default
tank: `totalLossLbYr` is 65,401.53 at every one of them, a span of
0.000000 percent. AP-42's turnover factor Kn is the reason the input
exists and it is never computed; `workingTurnoverFactor` is a separate
parameter defaulting to 1. The engine returns `turnoversPerYear` in its
result object, so any app that displays it shows a number that did no
work. Either compute Kn from it or take it out.

**B2. MEDIUM, LIVE. `pcPsia` is inert in the app's own default case.**
The critical pressure enters only through FF, which enters only through
the allowable drop, which is only used when the service is choked. Swept
200 to 5,000 psia on the default valve service the required Cv is
65.1920240520265 at every value, a span of 0.000000 percent, and the
allowable drop moves by 0.09 percent. The studio gives it a live box with
no hint that it bites only near choking.

**B3. MEDIUM. The `fd` column of `VALVE_STYLES` is read by nothing.**
Eight styles carry an `fd` between 0.10 and 0.99. `fd` is the valve style
modifier that the standard's Reynolds number factor and its noise
prediction need, and neither exists in this module. It is a published
table value with no consumer.

**B4. MEDIUM, LIVE. The computed stream power of a noise service moves
no verdict and is never displayed.** See C3.

**B5. MEDIUM. `orificeFlow` contains an empty range check.**
`if (beta < 0.1 || beta > 0.75) { }` has nothing in it but a comment. The
range is re-tested in the warning at the bottom of the same function, so
this is dead code rather than a hole, but it reads as a check.

**B6. LOW. `dischargeCoefficient` returns a dead field.** `unusedM2` is
computed from a hardcoded `2 * 0.47 / (1 - beta)` that the equation does
not use, and is returned to every caller under that name. It is a
half-finished flange-tap term.

**B7. HIGH, LIVE. The Control Valve studio persists an `fp` with no
input field anywhere.** `defaultInputs().valve.fp` is `'1'`, it is
serialized into every saved study, it is passed to both `liquidValve` and
`gasValve`, and it divides directly into every required Cv: swept 0.5 to
1 the Cv moves 50 percent. There is no `fp` field in `ValvePanels.jsx`,
`fields.jsx` or the app page, so a study restored with any other value
silently resizes every valve. Confirmed by grep across all three
component trees.

**B8. HIGH, LIVE. The Storage Tank studio persists a `latitudeFactor`
with no input field anywhere.** Same shape as B7. It scales thermal
inbreathing linearly: swept 0.5 to 2 the inbreathing moves 75 percent, on
the number the app labels the governing vacuum case.


## C. TWO ROUTES THAT DISAGREE

**C1. HIGH, LIVE. The metering uncertainty budget and the transmitter
calculation never meet, and the app's copy asserts the wrong one wins.**
`transmitterUncertaintyPct` computes a differential-pressure uncertainty
from a reading and a span; `orificeUncertainty` takes a typed
`dpUncertaintyPct` and does not accept a reading or a span at all. At the
Flow Metering studio's own defaults (100 inH2O on a 200 inH2O span) the
transmitter route gives 0.15 percent and the budget uses the typed 0.5
percent. The two are displayed in adjacent cards. Worse, the budget at
those defaults puts the DISCHARGE COEFFICIENT at 64.687 percent of the
variance and the differential at 16.172 percent, while the module header
says "the differential-pressure transmitter at the bottom of its range
contributes far more than the plate bore ever does", the engine's own
note says "improving anything else first is wasted effort" about the Cd,
and the app's body copy under the chart says "A more precisely bored
plate buys nothing when the differential transmitter dominates the
budget". The trusting half is the app copy; the arithmetic is what it is.
Either the transmitter feeds the budget or the claim comes out.

**C2. MEDIUM. `normalVenting` decides the governing case twice, by two
expressions that disagree at the tie.** `governing` uses
`out > in ? pressure : vacuum`; `warning` fires on `in > out`. At
`out === in` the result is `governing: 'vacuum (inbreathing)'` with
`warning: null`. Reproduced with
`normalVenting({nominalBbl: 10000, highVolatility: true})`: out 10,000,
in 10,000, governing vacuum, warning null. One predicate, computed once.

**C3. MEDIUM, LIVE. `noiseIndication` computes the stream power and then
bands the service on the pressure ratio alone.** The docstring says
"sound power scales with the stream power and the pressure ratio". The
band does not see the power. A 1 scfh bleed at a ratio of 12 returns
`streamPowerKw: 0.00139` and `band: 'severe'` with the multistage-trim
warning; a valve passing 100 MMscfh at a ratio of 1.9 returns
`streamPowerKw: 35,801` and `band: 'low'` with no warning at all. Three
separate defects planted in this function all left the suite green, which
is why nobody noticed. The app displays the ratio and the band and never
the power.

**C4. MEDIUM, LIVE. `characteristicFor` and `travelCheck` speak
different vocabularies.** `characteristicFor` returns
`'equal percentage'` or `'linear'`; `travelCheck` tests
`characteristic === 'linear'` and treats everything else as equal
percentage. Feeding the recommendation straight to the check works for
linear by luck and for equal percentage by accident, and any unrecognised
string is silently equal percentage:
`travelCheck({..., characteristic: 'quickOpening'})` returns
equal-percentage travels with no error.

**C5. MEDIUM, LIVE. The Control Valve studio shows a recommended
characteristic it never applies.** `authority.recommendation` is rendered
in the Authority card; the travel calculation uses the separate
`inputs.valve.characteristic` dropdown. Nothing on screen reconciles them
and nothing warns when they disagree.

**C6. LOW. The sigma printed beside a choked case is not the sigma of the
flow that is passing.** `sigma` is computed on `dpStated` while the Cv is
computed on `dpUsed`. When the service is choked those are different
pressure drops, so the cavitation index reported belongs to a drop the
valve cannot use.


## D. A SUMMARY THAT DEGENERATES OR IS ABSENT

**D1. HIGH, LIVE. `travelCheck` collapses two different meanings into
one null, and the alarming one wins.** `maxTravelPct === null` means
either "this Cv is beyond the valve" or "you gave me no maximum flow",
and the warning pushed is "the maximum flow needs more Cv than the valve
is rated for: it will not pass the design case".
`travelCheck({cvRated: 100})` with nothing else returns exactly that
warning. The studio prints "beyond the valve" in red for a box the user
simply has not filled in.

**D2. MEDIUM. `shellCourses` returns no summary at all.** No governing
course, no thickest course, no total plate weight, no statement of the
minimum thickness in force, no count of courses the water test governs.
`TankPanels.jsx` derives `anyTestGoverned` itself with a `.some()`.

**D3. MEDIUM, LIVE. The Storage Tank studio never compares the emergency
vent to the normal vent, and never sizes a vent.** Both numbers are on
the same page, the engine's note says the fire case is "normally an order
of magnitude above normal venting", and nothing computes the ratio. At
the app's defaults it is 33 times, and that number is a consequence of
A3's suspect conversion rather than a validated result. No required vent
area, count or setting is produced anywhere.

**D4. MEDIUM, LIVE. The studio shows "minimum plate thickness" as a
governing reason with no number attached to the phrase.** Course 5 of the
default tank is governed by it. The user cannot see what the minimum is,
where it came from, or that it depends on the tank diameter (see E7).

**D5. MEDIUM, LIVE. `orificeUncertainty`'s `dominant` is a ranking of
six numbers with no tie handling and no statement of how close the
runners-up are.** At the app's defaults the top two are 0.5 and 0.25
contribution percent, which is a real gap, but the function will name a
dominant term on a photo finish and its note will tell the user that
improving anything else is wasted effort. The app renders it as a single
amber headline.

**D6. LOW. `sizeOrifice` reports a bore to four decimals with no
statement that a plate is bored to a stock size.** The default sizing
returns 3.6840623908785197 in at beta 0.6074, above the 0.6 the engine's
own warning calls the point where uncertainty and straight-run
requirements rise, and the app prints the bore in green as the answer
with the warning rendered in a different card.

**D7. LOW, LIVE. The Control Valve studio prints travel to whole percent
beside engine warnings that print one decimal.** The engine carries a
comment and four jest tests dedicated to the fact that a valve 9.7
percent open must not print "10 percent open" under a flag that only
fires below 10. `ValvePanels.jsx` renders `fmt(travel.minTravelPct, 0)`.
The collision the engine fixed is back on the screen: a red "10 %" tile
beside a warning that says 9.7.


## E. AN UNGUARDED CORRELATION OR STANDARD

**E1. HIGH, LIVE, HELD FOR LITERATURE. The `twoElbowsDifferentPlanes`
straight-run column is non-monotonic in beta.** Swept across its own
breakpoints it returns 34, 50, 75, 65, 60, 80 upstream diameters for beta
0.2, 0.4, 0.5, 0.6, 0.67, 0.75. A published straight-run requirement
does not fall by 15 diameters as beta rises from 0.5 to 0.6 and then rise
by 20. The function's own note calls these "published table values, not a
calculation" and names no standard. The Suite exposes the fitting as a
dropdown and prints the result as "Upstream straight run ... diameters".
Repairing this needs the table.

**E2. MEDIUM, HELD FOR LITERATURE. `straightRunDiameters` answers
outside its own table.** `beta: 0.95` returns 44 diameters with no
warning, by falling through to the last row. The flange-tap correlation
this module is built on is published to beta 0.75.

**E3. MEDIUM, LIVE, HELD FOR LITERATURE. The Suite's Cd-against-Reynolds
chart is drawn below the correlation's published Reynolds floor.**
`MeterStudioContext.jsx` sweeps `10 ** 3.5` to `10 ** 7.5`. At Re 3,162
and the default beta the engine returns Cd 0.6348 and the chart plots it
as a valid point on a curve captioned as proof that the published
equation is worth computing. The exact floor is HELD.

**E4. MEDIUM. The discharge coefficient is computed at any Reynolds
number the viscosity produces.** Swept 0.005 to 50 cP on the default run,
Cd moves 13.6 percent and reaches 0.6967 at 50 cP, far outside the band
the correlation is published for, with no warning.

**E5. MEDIUM. `orificeFlow` misdiagnoses a differential larger than the
static pressure.** Inputs `p1Psia: 50, dpInH2O: 2000` give a negative
pressure ratio, a NaN expansibility with no error, a NaN mass flow, a NaN
Reynolds number, and the user is finally told "a positive pipe Reynolds
number is needed". The real problem is that the differential exceeds the
line pressure and it should be named.

**E6. MEDIUM, HELD FOR LITERATURE. `liquidValve` applies no Reynolds
number factor.** The module takes no viscosity at all, so a heavy crude
or a low-flow trim is sized as fully turbulent with no statement that it
is. The standard's FR curve is the repair and it is not in the repo.

**E7. HIGH, LIVE, HELD FOR LITERATURE. The minimum shell plate thickness
is a single hardcoded 0.1875 in for every tank diameter.** It governs
course 5 of the app's own 120 ft default tank, and it still governs the
top course of a 200 ft tank. API 650's minimum shell plate thickness is
banded by diameter and 3/16 in is the smallest band. Planting
0.1875 to 0.3125 left the suite green. The band table is HELD; the
repair must at minimum make the floor an explicit, stated,
diameter-aware input rather than one number for every tank.

**E8. MEDIUM, HELD FOR LITERATURE. The one-foot method has no diameter
limit.** It is offered for any tank the user types, including sizes for
which the standard requires the variable-design-point method instead.

**E9. MEDIUM, HELD FOR LITERATURE. Thermal venting is linear in capacity
with no band.** `inScfh = nominalBbl * 1.0 * latitudeFactor`. The app's
default tank is 80,574 bbl, which is four times the capacity at which the
published inbreathing table stops being proportional, and the result
85,066 scfh is the number the studio calls the governing vacuum case.
Planting 1.0 to 0.5 scfh per barrel left the suite green.


## F. A CONSTANT OR A STANDARD'S LABEL WITH NO PROVENANCE

**F1. CRITICAL, LIVE, HELD FOR LITERATURE. The emergency vent conversion
divides by the square root of an absolute temperature as well as the
square root of the molecular weight, and has a dead `* Math.sqrt(1)`
beside it.** The line is
`(1107 * qBtuHr) / (latentBtuLb * Math.sqrt(molecularWeight * tempR)) * Math.sqrt(1)`.
Two things are wrong on the face of it, without needing the standard.
First, 1107 is a field-unit packaging with a reference temperature
already folded into it, and a packaged constant cannot coexist with a
free absolute temperature in the denominator, because the relation's
value would then depend on whether T were measured in Rankine or Kelvin.
Second, `tempR` defaults to 560 R, is NOT exposed by the Storage Tank
studio, and moves the headline emergency vent by 29 percent across 400 to
800 R. The stray `Math.sqrt(1)` is where a temperature RATIO was clearly
meant to go. If the relation is the customary
`1107 Q / (L sqrt(M))`, the engine under-states the required vent by
sqrt(560) = 23.7 times: the default tank's 1,678,956 scfh air would be
39.7 million. An undersized emergency vent is the failure the module's
own header says destroys tanks. THE FORMULA ITSELF IS HELD FOR
LITERATURE and must not be guessed; what is not held is that the current
line cannot be right in its present form.

**F2. MEDIUM. The 0.6 low-volatility outbreathing factor, the 0.25
insulation credit and `latitudeFactor` have no source in the repo.** All
three are described as the standard's basis or "the customary one". All
three left the suite green when planted (0.6 to 0.9, 0.25 to 0.05, and
the 1 scfh/bbl of E9).

**F3. MEDIUM. The AP-42 loss coefficients are unsourced and unvalidated
end to end.** `10.731` (correct as the gas constant in psia ft3 per lbmol
per R), `0.053`, the 365-day multiplier, `tempSwingF = 20`,
`avgTempR = 530`, `ventSettingPsi = 0.03`, `workingTurnoverFactor = 1`,
`productFactor = 1`. Five separate defects planted across this chain all
left the suite green (see RECON.md section H).

**F4. MEDIUM. `designStressPsi = 23200` and `testStressPsi = 24900` are
shipped defaults with no material named.** They are plate allowables and
they set every thickness the studio prints. Planting 23200 to 26000 went
red, which is the one shell constant the golden does reach.

**F5. MEDIUM. The valve style table's FL and xT values have no source and
are shown to the user as fact.** The dropdown renders
"Globe, cage guided (FL 0.90, xT 0.75)". Planting globeCage's FL to 0.85
and its xT to 0.60 both left the suite green, so nothing in the repo
holds any of the sixteen numbers to anything.

**F6. MEDIUM. The sigma thresholds 2 and 3 are unsourced, drive a
four-way regime label and a colour on screen, and left the suite green
when moved to 1 and 1.5.** They are vendor and trim dependent by nature,
which is exactly why they need to be stated as the engine's choice.

**F7. LOW. `permanentLoss` defaults the discharge coefficient to a
constant 0.61** in a module whose whole point is that 0.61 is not a
constant. At the app's sized plate the two give 61.90 and 62.18 inH2O.
Planting the default 0.61 to 0.75 left the suite green, because the Suite
happens to pass the computed value.


## G. A UNIT OR CONVENTION MISMATCH

**G1. HIGH, LIVE. A differential turndown is reported and judged against
a flow turndown rule.** `transmitterUncertaintyPct` returns
`turndown = spanInH2O / dpInH2O` and warns above 3 with the sentence "An
orifice run has a usable turndown of about three to one because of
exactly this". Flow through an orifice goes as the square root of the
differential, so a differential turndown of 3 is a FLOW turndown of 1.73,
and the three-to-one flow rule corresponds to a differential turndown of
9. The warning therefore fires about five times too early, and the
sentence it fires with conflates the two. The Suite compounds it: the
Stat tile is labelled "Turndown ... to 1" with no qualifier, and the
paragraph under it repeats the three-to-one rule as though the tile above
were that quantity.

**G2. MEDIUM. `orificeFlow` returns `volumetricFt3Hr` at the flowing
density while the module header states its units as scfh.** The Suite
does not display it, so this is a label waiting for a caller.

**G3. MEDIUM, LIVE. The Storage Tank studio labels two different fields
"Vapour MW" in the same input column.** The venting block defaults to 90
and the losses block to 65 for the same product in the same tank, with no
explanation of why they differ, no cross-check, and identical labels.

**G4. LOW, LIVE. "tons/yr" is printed for a quantity divided by 2000.**
`totalLossTonsYr` and the controlled figure are short tons; the label
says tons. The same card mixes lb/yr and tons/yr in one row of four
tiles.


## H. THE SUITE LAYER, remaining items

**H1. HIGH, LIVE. The Storage Tank studio's default vapour space
contradicts its own default geometry.** The tank is 40 ft with a 38 ft
design liquid level, which leaves 2 ft of vapour space; the losses block
defaults `vapourSpaceHeightFt` to 12 and nothing links them. The standing
loss shown at the defaults is 17,276 lb/yr where the tank as drawn
implies 4,854, a factor of 3.56, and the saturation factor moves from
0.512 to 0.863. This is FC4's wrong-at-the-defaults class: the shipped
screen is internally inconsistent before the user touches anything.

**H2. HIGH, LIVE. The Control Valve studio's "Body velocity limit" card
advertises a check it cannot perform.** It computes an API RP 14E
erosional velocity and never computes an actual velocity, because the
valve has no flow area, so nothing is ever compared. The copy says "A
valve that sizes correctly on Cv can still erode its own body and
downstream pipe", which is true and which this card cannot detect. It
also applies a two-phase continuous-service C factor to a single-phase
liquid density at the liquid default.

**H3. MEDIUM, LIVE. Seven engine defaults set the Storage Tank answers
and the app never passes or shows them.** `turnoversPerYear`,
`avgTempR`, `ventSettingPsi`, `atmosphericPsia`, `workingTurnoverFactor`,
`productFactor` and the fire case's `tempR`. `tempR` alone moves the
headline emergency vent by 29 percent across 400 to 800 R.

**H4. MEDIUM, LIVE. `turbineVolume` is exported, tested, and called by
nothing.** The Flow Metering studio does not import it, so turbine
metering, the K factor and the meter factor are engine-only. The module
header names custody transfer as the subject and the engine returns no
net standard volume: no temperature correction, no pressure correction,
no CTL or CPL. HELD FOR LITERATURE for the correction tables.

**H5. MEDIUM. The Flow Metering chart caption claims a span the chart
does not show.** The caption says the coefficient "across the full beta
range it spans about seven percent" under a line drawn at a single beta.

**H6. MEDIUM. Every derived block in all three contexts is a bare
`useMemo` with no try/catch**, the same pattern FC7 recorded.

**H7. LOW. The metering engine's warning is rendered in the flow card
while the sized plate that triggers it is in the next card down.** At the
app's own defaults `sizeOrifice` returns beta 0.6074 with the "beta above
0.6" warning attached to the sizing result, and `FlowResults` renders
only `flow.warning`, so the sizing warning is dropped on the floor.
A NUMBER THE APP SHOWS WITHOUT THE WARNING THE ENGINE ATTACHED TO IT.

**H8. LOW. The engine and app copy are clean on the owner copy rule.**
Zero em dashes in all three engines and all three component trees,
checked by grep. Recorded so the repair does not go looking.

**H9. LOW. Vendoring is currently exact.** All nine files (three engines,
two goldens, two jest suites, two oracles) are byte-identical between
canonical `82ec6d4` and the Suite's `packages/engines`, verified with
`cmp`. The three `src/utils/facilities/engine/*.js` files are one-line
re-export shims. A repair will grow that closure; re-walk it rather than
assuming nine paths, and stage by explicit path because the Suite
worktree is shared.

**H10. LOW. The `sized` result's own `error` is checked before its
`beta`.** Recorded as the one place the Suite guards A9 correctly, so the
repair does not treat it as broken.
