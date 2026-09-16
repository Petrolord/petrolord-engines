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
