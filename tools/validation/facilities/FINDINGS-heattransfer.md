# FINDINGS: heat transfer (FC6-0, 2026-09-16)

The repair wave before the NextGen Heat Exchange & Cooling course, taken
against `engines/facilities/heatTransfer.js` at engines main `82ec6d4`, over
its oracle, its golden, its jest suite and the LIVE Suite studio that calls
all of it (`/dashboard/apps/facilities/heat-exchanger-sizer`). The full
defect list, with the inputs that expose each one, is the course wave's recon
(`tools/validation/facilities/RECON-heattransfer.md` and
`/root/fc-wip-heattransfer/FINDINGS.md`, 44 findings); this file records what
changed here and why.

Forty-four findings. **Twenty-one were reachable by typing into a box in the
shipped studio, and three were wrong at the studio's own defaults with
nothing typed at all.** Two of those three were the same disease in two
places: a number the module asserted alongside another number that
contradicts it.

**The gate is the second half of the story and it is the larger half.** The
recon planted forty-two defects in the engine one at a time and **thirteen
left the suite 19 of 19 GREEN**, including inverting the bundle-diameter
exponent, dropping the pi out of the tube surface area and squaring the
hot-day duty fraction. It then planted ten in the engine AND the oracle
together and **eight left it green**, including replacing the air cooler's
log mean with an arithmetic mean, because three of the six oracle routes were
the engine's own expressions written in SI and converted back. **Fifty-six
defects are planted in the controls now and all fifty-six are caught.**

## The one that was wrong at the app's own defaults

**`airCooler.hotDay` held the process outlet temperature FIXED and scaled
the duty by the ratio of two log means.** Those two things cannot both be
true: if the duty falls, the outlet rises. The engine's own comment said
"Same air mass and same UA", and then recomputed the log mean at the DESIGN
outlet temperature.

Its own numbers contradicted each other on the tab's shipped defaults. The
hot-day duty of 16.231 MMBtu/hr at the same 2,777,778 lb/hr of air implies an
air rise of **24.35 F**, and the engine reported 30. It reported a process
outlet of 150 F, which needs the FULL 20 MMBtu/hr.

What a machine actually holds on a hot afternoon is the SURFACE and the AIR
MASS. Those fix UA and both capacity rates, so they fix NTU and the capacity
ratio, so they fix the effectiveness **whatever the arrangement is**, which
is why this rating needs no cross-flow F and is unaffected by the one F this
module cannot source. The duty then follows from the inlet temperature
difference alone, and the new process outlet and the new air rise come out
with it.

| check ambient | engine before | rated now | error before | outlet now |
| --- | --- | --- | --- | --- |
| 100 | 0.9378 | 0.9677 | -3.1 pct | 153.2 F |
| 105 | 0.8750 | 0.9355 | -6.5 pct | 156.5 F |
| **110 (the tab default)** | **0.8116** | **0.9032** | **-10.1 pct** | **159.7 F** |
| 120 | 0.6819 | 0.8387 | -18.7 pct | 166.1 F |
| 130 | 0.5458 | 0.7742 | -29.5 pct | 172.6 F |
| 149 | 0.1926 | 0.6516 | -70.4 pct | 184.8 F |

The panel printed "Capacity retained 81 %" in emerald with a paragraph
explaining that this is the number that limits the plant in August, and the
Summary rail repeated it on all three tabs. It was **anti-conservative in the
direction that matters** at every ambient: a bay is bought for its summer
duty, and a capacity 10 percent low sells surface nobody needs while a
capacity that is wrong at all sells confidence nobody should have.

The same block reported **167 percent "Capacity retained"** at a 40 F check
ambient and rendered it emerald, because the accent rule was
`dutyFraction < 0.85 ? amber : emerald`. The rated answer there is 135
percent, it is labelled `colder than design`, and the return says plainly
that it is a capability rather than a delivered duty, because a plant holding
its outlet throttles air instead.

## The other one: U computed at a tube count the same screen contradicted

This one lived in the Suite, at `HeatExchangerContext.jsx:159`, which
hard-coded `nTubes: 200` into the tube-side film while the card beside it
printed 92 tubes. **200 was not a box anywhere in the studio.**

| tubes assumed | Reynolds | hi | U dirty | area ft2 | tubes printed |
| --- | --- | --- | --- | --- | --- |
| 200 (shipped) | 16,299 | 247.26 | 73.853 | 286.3 | **92** |
| 92 | 35,433 | 460.20 | 88.678 | 238.4 | 76 |
| 76 | 42,893 | 536.20 | 91.708 | 230.6 | 74 |
| **74 (settled)** | **44,052** | **547.76** | **92.110** | **229.5** | **74** |

**The area was 24.7 percent high, U 19.8 percent low, and the Reynolds
number on the panel 37 percent of the self-consistent one.** The map is a
contraction, so plain iteration settles: from a seed of one tube per pass the
default case runs 2, 60, 72, 74 and stops, and the studio prints the trail.

Two engine changes were needed to make the loop closable at all.
`tubeSideFilm` used `Math.max(1, nTubes / passes)`, which floored silently,
so one tube in four passes returned exactly the same Reynolds number as four
tubes in four passes; it now refuses a count that cannot be divided EQUALLY
into the passes. And `tubeCount` now rounds the count UP to a multiple of the
pass count, because a multi-pass bundle puts the same number of tubes in
every pass and a count that does not divide could not be fed back into the
film. That moves two golden rows: 637 tubes to 638 at two passes and 230 to
232 at four.

## Outlets that moved the wrong way, and a cross test that knew nothing

`energyBalance` returned `{ qBtuHr: -550000, thOut: 320, tcOut: 93.13 }` for
a hot outlet of 320 F against a 300 F hot inlet, **with no error key**,
because the cross guard `hOut < tcIn || cOut > thIn` cannot fire when both
temperatures move AWAY from the cross. The Driving force card printed "Duty
-0.55 MMBtu/hr", "Cold outlet 93.1 F" and "LMTD 213.4 F" (the log mean is
perfectly finite there, because both end differences are positive) and the
Summary rail repeated the negative duty on all three tabs. Only the Surface
card errored, with "area needs a positive duty, U, LMTD and F", which names
four quantities and not the box that is wrong.

Three separate repairs, because **one refusal sentence for several unrelated
faults is itself a defect** (FC3-0): an outlet is checked against the inlet
it came from, a stated duty of zero or less is refused explicitly instead of
falling through to the outlet branch, and a stated outlet beside a stated
duty is CHECKED against it rather than silently discarded.

**And the cross test now matches the arrangement.** It was the
counter-current test whatever the caller said, and `energyBalance` did not
take an arrangement at all, so between about 4.07 and 5.5 MMBtu/hr on the
studio's own streams a duty no parallel exchanger can deliver passed the
balance and was caught two functions later by `lmtd` with the generic
"temperature cross: one end of the exchanger has no driving force". The
balance's own carefully worded refusal never fired for the case it was
written for. **Two functions disagreed and the trusting half was the bug**,
which is this programme's rule and is why the repair went into
`energyBalance` rather than into the message `lmtd` prints.

## A capital letter was a 40 percent error

`arrangement` was matched with `===` against one lowercase string in three
functions, and everything else fell through to counter-current.

| given | `effectivenessFromNtu` | `lmtd` |
| --- | --- | --- |
| `'parallel'` | 0.568604 | 78.173 |
| `'Parallel'` | **0.732649** (counter) | **109.696** (counter) |
| `'crossflow'`, `''`, `null` | 0.732649 | 109.696 |

Not reachable from the Selects, which emit lowercase. Reachable from any
saved study, because `inputsFromPayload` spreads the stored strings in
without validating them. Case and surrounding space no longer matter, and an
unknown string is REFUSED in all four functions that take one rather than
being answered as something else.

## Every exposed coefficient, and two things that were unbounded

The studio exposes eleven of these as plain `type="number"` boxes with no
bounds, and `fmt` renders a non-finite value as two dashes, which is exactly
what an untouched box shows. Each one now has its own guard naming the input
and its value:

| typed | returned before | now |
| --- | --- | --- |
| `foulingOut -0.01` | U dirty **393.63** against a clean 98.80, penalty **-298.4 pct** | refused, naming -0.01 |
| `kWallBtuHrFtF 0` | U 0, `controlling: 'wall'`, penalty NaN | refused |
| `kWallBtuHrFtF -26` | wall resistance negative, U dirty 159.15 | refused |
| `fanEfficiency 0` | **Infinity** bhp | refused |
| `fanEfficiency -0.65` | -96.5 bhp | refused |
| `fanEfficiency 5` | 12.55 bhp, accepted | refused |
| `motorEfficiency 3` | a motor drawing less than its shaft | refused |
| `staticPressureInH2O -0.6` | -96.5 bhp | refused |
| a blank ambient or process outlet | "temperature cross", a cross the user did not create | the box named |
| `cr 1.4`, `cr -0.1`, any NaN | a bare **NaN** with no error key | an object with an error key |
| `mLbHr 0`, `cpBtuLbF 0` | a bare **NaN** | an object with an error key |

`shellPasses` was unbounded and silently rounded. **2.4 and 2.6 became 2 and
3, which differ by 6.6 percent on F**, and 1000 shells returned F = 0.999998,
so any duty a real exchanger cannot reach became reachable by typing a bigger
number. It is a whole number between 1 and `DECLARED_BOUNDS.maxShellPasses`
now, and that bound is a **design limit declared by this module, not a
published one**, which the refusal says.

`capacityRate` and `effectivenessFromNtu` returned bare numbers and now
return objects. **Those are breaking changes for callers.** `airDensityLbFt3`
keeps a bare-number contract on purpose, documented in one line: it is a leaf
correlation with nowhere to put an error key, and its one caller turns the
NaN into a named refusal, exactly as `waterSatPsia` does since FC4-0.

## The controlling resistance rested on a two percent margin

The module's stated purpose is a U "assembled from its parts so the
controlling resistance is visible instead of buried", and the studio printed
**the single winning word and none of the five numbers**. At the shipped
defaults the verdict rested on `outsideFilm 0.005000` against
`insideFilm 0.004892`, a 2.2 percent gap, **decided on the film the tube-count
defect above shows was wrong**. At the self-consistent 74 tubes the inside
film falls to 0.002209 and the margin becomes 126 percent, so the shipped
answer was right for the wrong reason.

All five resistances are returned with their share of the total and printed
on the card. `controlling` now carries `runnerUp`, `controllingMarginPct` and
`controllingClear` against a declared 10 percent, with a note that says to
treat two near-equal terms as jointly controlling rather than acting on the
word. The declared margin is this module's reporting threshold and not a
published one, and it says so.

`tubeCount` returns `areaMarginPct`, because `actualAreaFt2` is a whole
number of tubes and is therefore always at or above the requirement, and the
overshoot was never stated: 289.03 against 286.29 ft2 at the old defaults.

## The air density belonged to neither machine

The density was taken at the MEAN of the inlet and the outlet air, which is
neither draft type's fan inlet:

| basis | density lb/ft3 | ACFM | fan bhp |
| --- | --- | --- | --- |
| forced draft, fan on ambient air at 95 F | 0.0715244 | 647,280 | **94.00** |
| **engine before, mean at 110 F** | 0.0696411 | 664,784 | **96.55** |
| induced draft, fan on 125 F air | 0.0678544 | 682,289 | **99.09** |

**5.4 percent across the two real choices**, and the engine returned one
number and named no draft type. `draftType` is an input now, defaulting to
`forced`, the fan inlet temperature is returned, and an unnamed value is
refused rather than averaged. `barometricPsia` is an input too, because the
duty of this machine is set by air density and 14.7 psia was hard-wired, so
there was no elevation anywhere in it.

**This is a LIVE number change**: the Air Cooler tab's fan power falls from
96.5 to 94.0 bhp on its own defaults, and the motor power from 104.9 to
102.2 hp.

## The two `overallU` exports

`engines/facilities/heatTransfer.js` and
`engines/production/flowlineThermal.js` both exported `overallU`, with
different signatures, **different reference areas** (the facilities one to
the OUTSIDE tube surface, the flowline one to a stated bore) and different
error contracts. A U is meaningless without saying which area it is referred
to, and the two were never interchangeable.

The facilities export is **renamed `overallUOutside`** and carries
`referenceArea: 'outside tube surface (do)'`; `flowlineThermal.js` keeps the
name `overallU` for its bore-referred coefficient and already reported
`referenceIdIn`. Nothing in either repository imported both. The one caller
of the facilities export, `src/contexts/HeatExchangerContext.jsx`, moves with
this wave; `src/utils/production/flowAssurance.js` calls the flowline one and
is untouched. **A reader who has a U in hand can now tell which it is from
the name alone and from the return.**

## What no route can check, and what was done about it

Six things in this module have no publication in this repository to check
them against. They are in the exported `HELD_FOR_LITERATURE` table, the
returns that depend on them say so, **no citation was invented for any of
them**, and none of them is graded:

- **`BUNDLE_K`.** Eight layout/pass pairs whose source is not recorded. The
  45 and 90 degree rows carried here are **byte-identical in all four pass
  counts**, so the Layout box does nothing between those two, while 30
  against 45 moves the bundle by 8.9 percent. `tubeCount` returns a
  `layoutNote` saying exactly that when the layout is 45 or 90, and the gate
  asserts the two rows are equal, so this is a recorded finding rather than a
  claim that the input is live.
- **The Dittus-Boelter validity band.** Not established here. Re and Pr are
  returned on every call with a `correlation` block whose `validityBand` is
  explicitly `null` and whose note says why, so a caller can check them
  against the source they trust. Pr 0.5 and Pr 3110 used to be accepted in
  silence; they are still accepted, and they are no longer silent.
- **The cooling exponent.** The Prandtl exponent was the heating one in every
  call and nothing let a caller say the tube fluid was being cooled. At the
  studio's own default Prandtl of 15.12 the two forms differ by **31.2
  percent on hi**, so this is not a detail to shrug at. `service` is an input
  now and `'cooling'` is **REFUSED**: answering it with the heating exponent
  would be a confident wrong number, and inventing the cooling exponent here
  would be worse. The Suite's tube side is the cold stream, which is being
  heated, so nothing live is blocked, and the panel now says so.
- **The Sieder-Tate exponent** and its band.
- **The cross-flow F.** The air cooler is a cross-flow machine rated on the
  COUNTER-CURRENT log mean with F silently 1, inside a module whose headline
  is that F is computed rather than typed. The finding is the silence. The
  return now carries `fCorrection: null` and a note saying the area is a
  counter-current-basis area and a real bay needs more surface. The hot-day
  rating deliberately does not depend on it.
- **`kWallBtuHrFtF = 26`, which names no material**, and the three
  air-cooler defaults, which name no machine.

The fitted constants are in `DECLARED_CONSTANTS` and the gate pins them **by
literal**. **That is a pin and not a validation**: pinning 0.023 does not make
0.023 right, it makes changing it a reviewed act instead of a silent one. It
says so in the engine, in the oracle and in the test, and nothing in the F6
course may present it as one. What it buys is measurable: five of the
thirteen defects that used to leave the suite green were moves of numbers on
that list, and all five now fail.

**Two of the module's constants are measured rather than pinned**, because
they are roundings of derivations:

- `cpToLbFtHr = 2.4191` against the 2.4190883105022247 the oracle derives
  from the exact pound, foot and hour: a **4.83 ppm** rounding.
- `gasConstantPsiaFt3LbmolR = 10.7316` against the 10.73157708901629 derived
  from the SI gas constant: a **2.13 ppm** rounding.

Neither is moved (moving either would move every shipped number in the
platform, exactly as FC3-0 and FC4-0 decided about the same constant) and
the gate asserts that the residual each one causes downstream **equals** it,
so the named cause is itself a gate. The tube-film check is the strongest
form of this: the engine's Re is the oracle's divided by that rounding and
its Pr is the oracle's times it, so the film coefficients must differ by
exactly `kappa^(n - m)` through the two Dittus-Boelter exponents. **Move
either exponent in the engine AND the oracle together and that identity
breaks**, which is how two of the paired plants that used to pass now fail.

And one constant is measured that nobody had measured: **the fan constant
6356 implies a water density of 62.3033 lb/ft3**, which is water at roughly
80 F. 33000 ft.lbf/min per hp, over 6356, over 12 in/ft. The oracle's fan
route goes through PASCALS with that density and no 6356 in it at all, and
the gate asserts the implied figure, so moving 6356 in both files still
fails. **That is a measurement, not a citation**, and it is recorded as one.

## The oracle: what each route checks and what it cannot

Three of the six routes were transcriptions. The oracle's own docstring
called them "SI re-derivation", and a formula restated in SI and converted
back is a multiply followed by a divide on the same expression. Every route
now states in its own docstring what it checks and what it cannot, because
the honest answer is not the same for all of them:

| route | checks | cannot check |
| --- | --- | --- |
| LMTD | the log mean, by INTEGRATING the driving force it is the closed form of, which never evaluates a logarithm | nothing |
| eps counter | the closed form, by an RK4 march with a LINEAR shot in place of 200 bisections | nothing |
| eps parallel | the closed form, by an RK4 initial-value march (no shot: both streams enter at the same end) | nothing |
| eps 1-2 shell | the closed form, by an RK4 march of the THREE-STREAM shell/pass-A/pass-B system with the tube fluid's turn-around as a boundary condition | nothing |
| F correction | Bowman, by `F = NTU_counter / NTU_1-2` with the 1-2 NTU INVERTED FROM THAT MARCH | nothing |
| N-shell F | the P to P1 conversion, by marching N shells in SERIES COUNTER-CURRENT and recovering the whole-unit P | nothing |
| U | the resistance stack, built on each term's OWN area and referred to the outside only at the end, with the wall term by SIMPSON QUADRATURE rather than a logarithm | nothing |
| tube film | Re by `4 mdot / (pi d mu)`, which forms no flow area at all; Pr; every unit conversion derived from the SI definitions rather than typed | the fitted 0.023, 0.8, 0.4 and 0.14 |
| tube count | the bundle fit, by BISECTING on the diameter for `(D_b/do)^n1 = N/K` rather than raising `(N/K)` to the reciprocal power | the eight BUNDLE_K pairs |
| air cooler | the log mean by integration, the air balance and the density in SI, and the fan power from a pressure rise in PASCALS, which MEASURES the water density 6356 is written against | the air cp 0.24 |
| hot day | the rated duty, by solving `q = UA x LMTD` at fixed UA by bisection: the OTHER classical method, not eps-NTU | nothing |
| balances | every unit packaging, by going through kg, m, J and WATTS and coming back | the balance itself, which is a definition in any language |

The three routes that were already genuinely independent (the log-mean
integration, the F identity and the counter-flow march) are kept and
strengthened rather than replaced.

**The N-shell conversion was proved CORRECT by the recon and checked by
nobody**, which is why inverting its `1/n` exponent left the suite green. It
gets seven golden rows, five of them at R not equal to 1, which is the branch
the shipped suite never reached at all. **A route already proved right still
needs a row, or the next edit breaks it silently.**

**`effectivenessFromNtu` for parallel and shell1 was checked only against its
own inverse**, an identity that holds for any mutually inverse pair whether
either one is right, plus one ordering assertion. Both now meet an ODE march,
and `ntuFromEffectiveness` is checked against an inversion OF that march
rather than against the engine's own algebra.

## Analytic limits, in place of published data

**Every golden row is synthetic and the file says so.** This repository
carries no published heat exchanger case to take a row from, and inventing a
citation would be worse than saying so. What stands in for published data is
route independence, the constant pins, and a block of ANALYTIC LIMITS, which
are known truths that need no citation and which discriminate:

- **A thin cylindrical wall is a flat plate**, `R = t / k`. This is the limit
  that FIXES the factor 2 in `(do ln(do/di)) / (2 kw)`, and it is what caught
  the last paired plant standing: moving that 2 to 2.2 in the engine and in
  the oracle together leaves the two files agreeing with each other, and
  neither agrees with the plate limit. Checked at four bore/conductivity
  pairs and two stretches.
- **The log mean is strictly below the arithmetic mean at unequal ends** and
  equal to it at equal ends. The recon's worst paired plant was exactly this
  substitution in both files.
- **F tends to 1 as P tends to 0**, at every R.
- **The parallel ceiling `1/(1+Cr)` and the 1-2 ceiling
  `2/(1+Cr+sqrt(1+Cr^2))`** are reached at high NTU and reported as
  `ceiling`.
- **At Cr = 0 all three arrangements collapse onto `1 - exp(-NTU)`.**
- **Counter-current flow has NO ceiling.** The studio's help text said "each
  arrangement has a hard ceiling on effectiveness that no amount of area
  beats", and counter-current is the Rating tab's DEFAULT. It returns an NTU
  at an effectiveness of 0.99999 and never refuses. `ceiling` is `null` for
  it, and both the engine and the help text now say so.
- **Self-consistency**, which is where three of the worst defects lived:
  `Q = U A F dTlm` at the LMTD the engine itself reports, the five
  resistances adding to the total, the air the cooler asks for carrying the
  duty at the rise it reports, and the hot-day duty agreeing with the
  hot-day outlet AND the hot-day air rise.

## Movement

The golden goes from **18 rows across 6 sections to 75 rows across 19**.

**Where the engine's answer did not change, it did not change.** Every
`lmtd`, `fCorrection` and `epsNtu` row is bit-identical or within 1 to 4
units in the last place, and so are the air cooler's `lmtdF`, `areaFt2` and
`airLbHr`. The `u` and `tubeFilm` rows move by 1e-8 to 2e-7 and **that is the
ORACLE improving, not the engine**: the wall quadrature replaces a closed
form and the derived conversions replace typed ones (`1.730735` for
`1.730734666`). The engine's U and film numbers are unchanged to the last
bit.

What genuinely moved, and why:

| field | ratio | cause |
| --- | --- | --- |
| `airCooler.airDensityLbFt3` (forced) | 1.027045 | the fan inlet is ambient air, not the mean |
| `airCooler.acfm`, `.fanBhp`, `.motorHp` (forced) | 0.973667 | the same, through the density |
| `airCooler` the same three (induced) | 1.026329 | the fan inlet is the heated air leaving the bundle |
| `hotDay.dutyFraction` at the tab default | 1.112825 | the hot day is RATED rather than scaled |
| `hotDay.qBtuHr` | 1.112825 | the same |
| `hotDay.processOutF`, `.airRiseF` | new | the two numbers the old block asserted and could not produce |
| `tubeCount.nTubes` at 2000 ft2 / 2 passes | 638 for 637 | the count is a multiple of the pass count now |
| `tubeCount.nTubes` at 1200 ft2 / 4 passes | 232 for 230 | the same |
| everything else in the golden | 1 | unchanged |

**And in the LIVE Suite studio, on its own shipped defaults:**

| on screen | before | now |
| --- | --- | --- |
| Tubes | 92 | **74** |
| Area required | 286 ft2 | **230 ft2** |
| U dirty | 73.9 | **92.1** |
| Tube-side Reynolds | 16,299 | **44,052** |
| hi | 247 | **548** |
| Bundle diameter | 10.9 in | **9.9 in** |
| Shell diameter | 13.4 in | **12.4 in** |
| Hot-day capacity retained | 81 % | **90 %** |
| Hot-day duty | 16.23 MMBtu/hr | **18.06 MMBtu/hr** |
| Fan power | 96.5 bhp | **94.0 bhp** |
| Motor power | 104.9 hp | **102.2 hp** |

## The Suite composition layer

`src/contexts/HeatExchangerContext.jsx` and the four files under
`src/components/heatexchanger/` are the whole Suite-side composition, and the
only thing that asserted anything about any of it was a page smoke test that
mounted the default case. A new
`src/contexts/__tests__/heatExchangerContext.test.jsx` carries twenty numeric
gates, each refusal asserted twice: that the studio refuses it by name, and
what it used to print instead.

Also repaired there:

- **`ntuTarget` is deleted.** It inverted the effectiveness that `rating` had
  computed from an NTU eleven lines earlier, so it equalled that NTU by
  construction; it ran on every keystroke and `grep` found it rendered
  nowhere.
- **`num()` is no longer `parseFloat`.** `'50000 lb/hr'` and `'80000abc'`
  parsed to numbers and gave full answers, and `'50,000'` parsed to 50 and
  reached the engine as a valid duty that then tripped the stream-cross
  refusal, so the studio blamed the physics for a typing problem. The boxes
  are `type="number"`, but a SAVED STUDY is not.
- **Every derived block is wrapped.** None of the six had a try/catch, so
  anything the engine threw would white-screen the tab rather than show a
  note.
- **The tube side is labelled.** It was always the cold stream, silently,
  beside boxes labelled "Tube fluid viscosity" with no statement of which
  stream they belonged to. That silence was also the only reason the
  always-heating Prandtl exponent happened to be right.
- **The shell count, the air outlet, the area per tube, the area margin and
  all five resistances** are printed. The engine returned them and the panels
  dropped them.
- **Four help-guide claims** are corrected: the ceiling counter-current does
  not have, the unattributed "twenty percent" (the engine attaches 20 percent
  to something else entirely, writing -1 for -2 inside the R = 1 branch),
  "built from its parts" beside a card that printed one word, and "the
  density of the air at that temperature" where the temperature was the mean
  of two and no draft type was named. A new section states the six held
  items plainly, in the studio, where a user reads them.
- **Three "X, not Y" contrastives** in live copy are rewritten, and the two
  em dashes in the source headers with them.

## The controls

Fifty-six defects planted one at a time, the gate run against each, the
sources restored between, and the clean baseline re-verified at the end.

| battery | before FC6-0 | now |
| --- | --- | --- |
| planted in the ENGINE alone | 42 planted, **13 GREEN** | 42 planted, **0 green** |
| planted in the ENGINE AND THE ORACLE together | 10 planted, **8 GREEN** | 14 planted, **0 green** |

The thirteen that used to pass: the Sieder-Tate exponent; the laminar
Nusselt; the transition floor; the bundle constant K; the bundle exponent n1;
**inverting the bundle-diameter exponent**; **dropping the pi out of the tube
surface area**; adding the shell clearance twice; **squaring the hot-day duty
fraction**; the N-shell conversion exponent; and the three defaults 26, 0.6
and 0.92. All thirteen fail now, and so does a fourth default, 0.65.

The eight paired plants that used to pass: the wall factor 2; the do/di ratio
on the inside terms; Dittus-Boelter's 0.023, its Reynolds exponent and its
Prandtl exponent; the viscosity conversion moved the same physical amount in
both; the air cp; the fan constant; and **the air cooler's log mean replaced
by an arithmetic mean**. All fail now. Four more paired plants were added and
also fail: the barometric base moved in both, the hot-day fraction squared in
both, the bundle exponent inverted in both, and the N-shell exponent inverted
in the engine with the oracle's march bent to match, which the oracle
**refuses** rather than laundering, because its NTU inversion checks that it
landed and will not return the edge of its own search window.

**The control on the controls passes.** Moving the oracle's Btu-to-W
conversion ALONE takes six tests red, so the harness can still tell the two
files apart, and the zeroes above are not a harness that has stopped looking.

A gate that cannot do its job refuses: the suite asserts the golden carries
every section it examines at its stated row count, and that the file totals
75 rows, so an oracle run that silently dropped a section fails here instead
of reporting a green suite over nothing.

## What is NOT repaired, and why

- **The six held-for-literature items above.** Recorded, exposed in the
  return, never graded, no citation invented.
- **The fitted constants and the eight bundle pairs.** Pinned, not validated,
  and said so in three places.
- **`cpToLbFtHr = 2.4191` and `gasConstantPsiaFt3LbmolR = 10.7316`.**
  Consistency over proximity, as FC3-0 and FC4-0 decided. The residual each
  causes is asserted to equal the rounding.
- **The shell-side film.** It stays an input. A rigorous shell-side
  coefficient needs stream analysis that belongs in a dedicated rating
  package, and the studio has always said so.
- **A hot stream on the tube side.** It needs the cooling exponent, which is
  held, so the studio labels the tube side as the cold stream and offers a
  typed hi instead of computing a film it cannot vouch for.

## For the writing wave

**Capstone conditions are off limits as engine test conditions, in both
directions.** FC4's repair took a capstone's exact conditions for a golden
row and the golden handed back a graded answer. No FC6 `fields.json` exists
yet, so the obligation runs the other way this time: **the conditions below
are now golden rows and a capstone must not reuse them.**

- LMTD: (300, 200, 100, 180), (250, 150, 80, 140), (400, 380, 100, 120),
  (420, 260, 90, 150), (300, 180, 100, 240), (500, 110, 100, 200).
- F: (P, R) of (0.4, 0.8), (0.3, 1.5), (0.5, 1.0), (0.25, 2.5), (0.6, 0.5);
  multi-shell (P, R, N) of (0.6, 1, 2), (0.75, 1, 3), (0.7, 0.5, 2),
  (0.45, 1.5, 2), (0.8, 0.6, 3), (0.3, 2.5, 2), (0.55, 0.8, 4).
- eps-NTU: (NTU, Cr) of (1, 0.5), (2, 0.8), (3, 1), (0.5, 0.25) counter;
  (1, 0.5), (2, 0.7), (0.5, 1) parallel; (1, 0.5), (2, 0.7), (3, 0.9)
  shell1; (1.5, 0) in all three.
- U: (200, 800, 0.75, 0.62), (1200, 300, 1.0, 0.834), (340, 1450, 0.875,
  0.732), and a defaults row at (250, 900, 0.75, 0.652).
- Tube film: (150000, 0.62, 0.5), (400000, 0.834, 1.2), the same first row
  with a 0.3 cp wall, and a laminar (2000, 0.62, 50).
- Bundle: 500 and 2000 ft2 at 0.75 in / 16 ft; 1200 ft2 at 1.0 in / 20 ft /
  4 passes; 860 ft2 at 45 and at 90 degrees.
- Air cooler: 20 MMBtu/hr 250-150 F at 95 F ambient, forced and induced;
  8 MMBtu/hr 180-120 F at 90 F; 14 MMBtu/hr 300-190 F at 100 F and 12.2
  psia; a defaults row at 11 MMBtu/hr 220-140 F at 88 F.
- Hot day: those design points checked at 110, 120, 130, 105 and 118 F.

**The digest is the teaching truth for this wave, once it exists.** RECON.md,
this file and the engine source are PROVENANCE, and no lesson may quote any
of them.
