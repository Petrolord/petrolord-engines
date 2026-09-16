# FINDINGS: corrosion and integrity (FC9-0, 2026-09-16)

The repair wave before the NextGen Corrosion & Integrity course, taken against
`engines/facilities/corrosion.js` at engines main `82ec6d4`, over its golden
`test-data/facilities/goldens/corrosion_cases.json`, its oracle
`tools/validation/facilities/oracle_corrosion.py`, its jest suite, and the LIVE
Suite layer that calls all of it. The full defect list with the inputs that
expose each one is the course wave's recon (`/root/fc-wip-corrosion/FINDINGS.md`,
55 findings); this file records what changed here and why.

Fifty-five findings. **Thirty-five are reachable today by typing into a box in
the shipped Corrosion & Integrity Studio**, six of them wrong or unexplained at
the app's own defaults with nothing typed. **Seventeen FAIL OPEN**: the engine or
the app returns an acceptable-looking answer where it should have refused, or
hands an absent input its least-limiting value. Ten are held for literature.

**One finding was not a tolerance question and is not repaired. It is
WITHDRAWN.** See the next section.

**The gate was the second whole finding.** Thirteen of fifty defects planted in
the engine alone left the suite 19 of 19 green, and **fifteen of seventeen
planted in the engine AND the oracle together left it green with the oracle
catching none of the seventeen.** The battery now stands at **zero of seventy
green engine-only and zero of twenty-five green paired.**

## The withdrawal

`sourServiceRegion` is gone. It drew severity regions 1, 2 and 3 from

    x = log10(pH2S / 0.0035)
    severity = x - (pH - 3.5)
    severity < 1 -> Region 1;  < 2.5 -> Region 2;  else Region 3

under the comment "Boundaries follow the shape of the ISO 15156-2 region
diagram", which concedes in its own words that it is a shape and not the
boundary. The Suite printed that under a card headed "Sour service (MR0175 /
ISO 15156)" and served three named material guidance strings off it, by region:
"Most carbon steels qualified to MR0175 are acceptable with hardness control",
"Carbon steel needs hardness and heat-treatment control; qualify weldments
explicitly", and "Severe: qualified CRA or fully qualified low-alloy steel with
documented testing. Do not extrapolate a Region 1 qualification here."

Four measurements settle what it was worth. Moving the pH pivot from 3.5 to 4.5
left the suite 19 of 19 green. Widening the Region 1 boundary from 1 to 2 left
it 19 of 19 green. A missing pH made `severity` NaN, failed both `<`
comparisons, fell through to `else region = 3`, and returned the hardest
material recommendation in the file from an input that was never supplied. And
at pH 4.5 the expression only reaches Region 3 at 20 bar of H2S.

**An invented curve carrying a standard's name and telling an engineer what
steel to buy is not something to improve.** It has been removed, and nothing
replaces it: no region, no material guidance, no substitute boundary, and no
reconstruction of the standard from memory. What survives is
`sourServiceScreen`, which compares the H2S partial pressure against a
threshold, reports the comparison in both bar and psia, and carries
`regionProvided: false` and `materialGuidanceProvided: false` so a caller
cannot mistake the absence for a missing field. The standard's names appear
nowhere in a returned string and the gate asserts that, including that the three
guidance strings are absent from the source file.

**The threshold value itself is HELD.** `SOUR_THRESHOLD_BAR` stays at 0.0035
because changing a live number without a source would repeat the mistake in the
other direction. Its comment claimed "0.05 psia", which it is not: 0.0035 bar is
0.050763208302526355 psia, and 0.05 psia is 0.0034474 bar, 1.5 percent lower.
The engine now exports `SOUR_THRESHOLD_PSIA` derived exactly and prints both
numbers in its note, the Suite hint prints the derived psia instead of a rounded
0.05, and the gate asserts the threshold in psia is NOT 0.05.

It is never graded. The course teaches the withdrawal as the lesson.

## The six that were wrong or silent at the app's own defaults

The studio's shipped defaults are 140 F, 725 psig, 3 mol% CO2, 0.1 mol% H2S,
pH 4.5, 10 ft/s in a 6 inch line, 56 lb/ft3, 1 cp, water wet, a 90 percent
inhibitor at 95 percent availability, a 0.125 in allowance and a 20 year design
life. Nothing typed.

1. **The inhibitor warning could not fire.** The guard was
   `avail < 1 && eff > 0.9`, the default efficiency is exactly 90, and
   `0.9 > 0.9` is false. The studio computed 85.5 percent effective protection
   against a 90 percent datasheet figure, printed it in EMERALD because the
   accent was `r.warning ? amber : emerald`, and said nothing. 90 percent at 50
   percent availability gives 45.0 percent and was equally silent. The one
   lesson the module exists to teach was switched off at its own defaults. It
   now fires on the EFFECTIVE shortfall at any efficiency, states the effective
   figure and the metal-loss ratio, and returns `inhibitorShortfallPp`.
2. **The protective-film claim was 21 C out.** The docstring said "the published
   scale factor above 60 C" and the help guide said "Below about 60 degrees
   Celsius the rate rises with temperature". At the app's own fCO2 of 1.3442 bar
   the factor is exactly 1.0 at 55, 60, 70 and 80 C and first drops at 81 C.
   Between 60 and 80 the studio's own panel hint read "no protective film at
   this temperature" while the help guide on the same screen said there was one.
   The onset is where `2400/T = 6.7 + 0.6 log10 fCO2`, it MOVES with fugacity,
   and nothing anywhere said so. `scaleOnsetTC` computes it, `corrosionRate`
   returns it, and both the panel hint and the help guide now state the computed
   number. **What temperature the PUBLISHED correlation turns at is held.**
3. **There was no summary.** `screen` returned seven fields and reconciled none
   of them. It now returns a BINDING CONSTRAINT.
4. **The sour threshold did not match its own label.** See the withdrawal.
5. **Fugacity and partial pressure sat side by side unexplained.** The rate is
   driven by CO2 FUGACITY; the film ratio and the H2S threshold use PARTIAL
   PRESSURES; and no fugacity correction is applied to H2S at all. The panel
   printed "CO2 fugacity 1.344 bar, partial pressure 1.53 bar" and never said
   why. The engine now returns `ph2sFugacityApplied: false` and the hint states
   which quantity drives what.
6. **mm/yr on a screen of field units.** Every input is F, psig, mol%, ft/s, in,
   lb/ft3, cp, inches of allowance; every rate was mm/yr, with mpy appearing
   once as a hint under one Stat. mpy is now printed beside mm/yr on the rate,
   the uninhibited rate, the summary rail, the sweep and the remaining life.

## The seventeen that failed open

A refusal is now a refusal. Sixteen input sets are in the golden's `refusals`
block and the gate asserts every one refuses with a message that names the
input, and REFUSES ITSELF rather than passing when the module answers.

| what | before | after |
| --- | --- | --- |
| a blank temperature | `tC` NaN made the fugacity NaN, `!(fco2Bar > 0)` is TRUE for NaN, so the engine took the **no-CO2 branch**: rate 0, "negligible" in emerald, life "unbounded", "MEETS", and the sentence "no CO2: this model has nothing to predict" printed under a CO2 box still reading 3 | `{ error: 'a finite temperature is required' }` |
| a blank CO2 box | fell back to 0, a positive assertion of zero CO2, same emerald zero | refuses; a TYPED zero takes the no-CO2 branch, which now withholds the category and the life and says a rate of zero means the model does not apply rather than that the line is not corroding |
| a blank velocity or line ID | `dwmMassTransferRate` returned **Infinity**, so `1/(1/vr + 1/Infinity)` equalled `vr` exactly, `controlling` read "reaction kinetics" from an input never supplied, and the rate came out **3.6061 against 0.7545, 4.78 times**, with 0.88 yr of life instead of 4.21 | returns **NaN, not Infinity**, and `corrosionRate` refuses. The gate asserts `not.toBe(Infinity)` explicitly |
| a blank density or viscosity | `wallShearStressPa` correctly errored, `screen` put the error object in a field and returned normally, the caller's `if (out.error)` saw nothing, and the summary rail simply omitted the wall shear row | `screen` computes the shear FIRST, because the rate now depends on it, and an unavailable shear is `{ error: 'screening incomplete: ...' }` |
| a 90 percent inhibitor at any availability | no warning | warns on the effective shortfall |
| 60 ft/s | 362 Pa, `filmRisk: 'high'`, "most inhibitor films are stripped at this shear", and then the datasheet efficiency applied anyway: **1.897 mm/yr and 1.674 yr against 13.080 mm/yr and 0.243 yr, a factor of 6.90** | the inhibitor credit is REMOVED, `rateWithFilmCreditMmYr` is reported beside it, and the binding constraint names the shear |
| 300 mol% CO2 | accepted: pco2 153.0 bar inside a 51.0 bar total, rate 5.68, category "severe", nothing complained | the fraction range and the partial-pressure sum against the total are both enforced |
| 500 percent water cut | `waterWettingFactor: 5`, the rate five times the water-wet answer | refused |
| `'OILWET'`, `'oilwet'`, `'oil-wet'` | exact case-sensitive match fell through to water wet | matched case and punctuation insensitively; an unknown string refuses |
| a typed 100 percent efficiency | silently clamped to 99.9, so 100 at 95 reported 94.905 percent effective | clamped to 0..100 and every clamp NAMED in `clamps`; 100 at 95 is 95, with a note that the arithmetic is the input and not a prediction |
| a missing pH | `severity` NaN fell through to Region 3 and a hard material recommendation | the region is withdrawn, and a non-finite pH refuses |
| a zero or blank CO2 in `corrosionRegime` | `{ regime: 'unknown', ratio: null }` with NO note, while the panel printed `{g.note}` unconditionally, so the card rendered an empty paragraph | both unknown branches carry a note |
| -500 F | below absolute zero and finite garbage came back: coefficient 2212.27, reaction rate 8.32e+56, rate 2.80e-113, category "negligible" | refused, and the low-level helpers return NaN rather than garbage |
| an oil-wet regime | `uninhibitedMmYr: 0`, `rateMmYr: 0`, **`effectiveInhibitionPct: 0`** with a 90 percent inhibitor specified, and `remainingYears: Infinity` printed as "unbounded / MEETS" | `effectiveInhibitionPct: null`, the category and the life WITHHELD, and a note that the rate is zero by assumption and that the assumption is the largest single lever in the model |
| 0 to 10 mol% H2S | the rate did not move by one bit across four orders of magnitude while the engine said on another tab that "a CO2-only model no longer describes this surface", and the studio printed 0.755 mm/yr, "high" in orange and 4.21 years with no visual difference from a case the model does describe | the sulphide regime WITHHOLDS the category and the life and keeps the rate as a stated upper bound; the mixed regime is marked `rateIsUpperBound` and stays graded |
| a zero rate of any origin | `Infinity` years with an emerald "MEETS" verdict, reachable from four paths | `remainingYears: null`, `unbounded: true`, `meetsDesignLife: null`, and a note saying to find out why the rate is zero first |
| pH 2.0 versus pH 4.0 | both **1.3417538787620145 mm/yr, identical to sixteen figures**, because `phFactor` returned 1 for any pH at or below its reference of 4, while the sour region on the same screen moved 3, 2, 2, 1 across the same span | `phFactor` returns `{ factor, phReference }` or REFUSES below the reference, and `phReference` is in the result so the app can print it |

## pH, and why a refusal beats a 1

Two decades of hydrogen-ion activity moved the headline number by exactly zero.
One input, two routes, and the route that decided the headline was the one that
ignored it. **A more acid water is not a less corrosive one**, so a factor of 1
was the least-limiting answer to a question the module cannot answer.

The published behaviour below the reference is HELD, so the repair is a refusal
and not a guess. At and above the reference the factor is unchanged and the rate
is now strictly monotonic from pH 4.0 to pH 9.0, falling by a factor of 316. The
reference pH of 4 is itself held, and it was invisible and unchangeable before:
`corrosionRate` called `phFactor({ ph })` and never passed a reference, so the
default was always used, never returned and never printed.

One consequence to state plainly: **pH 4.0 is the boundary**, where the factor
is 1 by definition rather than by a clamp, and everything below it now refuses
where it used to answer.

## The gate that could not fail, and what replaced it

`__tests__/facilities.corrosion.test.js` passed 19 of 19 while every one of the
findings above was live.

### Engine-only: 13 of 50 planted defects left it green

The sour threshold moved by a factor of TEN. The sour pH pivot. The Region 1
boundary. The H2S to CO2 carbonate boundary moved tenfold. Both film-risk
thresholds, each driving a coloured word and a warning paragraph a user acts on.
The Reynolds 4000 switch. The laminar factor 16 to 64. The inhibitor clamp. A
`rateCategory` band. And **three mutilations of `screen` itself**, including
computing pH2S as the TOTAL pressure with the mole fraction dropped entirely,
feeding the FUGACITY where the partial pressure belongs, and taking the category
from the UNINHIBITED rate.

Six of the thirteen lived in the sour-service and film-regime geometry, which
had no golden row at all. Three were `screen`, which had no golden row at all.

### Paired: 15 of 17 left it green, and the oracle caught none of the 17

Every published de Waard-Milliams constant. Every scale-factor constant. The pH
slope. Both Blasius constants. The Reynolds switch. **The wall shear stress
halved.** The two reds came from literals typed by hand into the jest file, not
from the golden.

The cause is arithmetic, not carelessness. **A CONSTANT TYPED IN TWO FILES
CANNOT BE VALIDATED BY COMPARING THE TWO FILES.** The oracle's `vm_direct`,
`scale_factor` and `ph_factor` were the engine's expressions character for
character; `fugacity` and `vr_natural` were the same constants with the log base
changed, so only a base slip could show; and **`shear_darcy` was algebraically
the engine's own line**, forming `f_darcy = 4 f_fanning` and then
`(f_darcy/8) rho U^2`, which is `0.5 f_fanning rho U^2`. The oracle's docstring
called that an independent re-derivation and the jest header repeated the claim.
Both were wrong.

### The work is now split three ways, and the file says which is which

**1. Genuinely independent routes.** Each must agree with the engine, and each
reaches the number a different way.

| route | independent because | cannot check |
| --- | --- | --- |
| the series combination | solved by 400 rounds of BISECTION on `1/CR` rather than formed as a reciprocal, and the gate also asserts the residual identity `1/CR - 1/Vr - 1/Vm = 0` | nothing: it is fully independent |
| the inhibitor time-average | rebuilt as an explicit 8760 HOUR duty cycle, which rounds to whole hours, so the agreement is 1e-4 rather than 1e-15 and that looseness IS the independence | nothing |
| the wall shear | reached through a MOMENTUM BALANCE: Darcy-Weisbach gives a pressure drop over a stated 100 m, and `dP (pi d^2/4) = tau (pi d L)` gives `tau = dP d/(4L)`. Both numbers are in the golden and the gate checks the FORCE BALANCE as an identity, so the 0.5 against 0.25 against `f_darcy/8` packaging is held by physics rather than by a transcription | 0.046, -0.2, 16, the Re 4000 switch |
| the protective-film onset | found by BISECTION on the oracle's own unclamped scale expression and cross-checked against the closed form `2400/(6.7 + 0.6 log10 f)` | 2400, 0.6, 6.7 |
| the remaining life | reached by MARCHING the wall loss forward in 1e-3 year steps until the allowance is consumed, rather than by dividing. Held to an ABSOLUTE tolerance of one step, which the gate states | nothing |
| the allowance shortfall | formed as a DEFICIT OF YEARS times the rate rather than as the engine's subtraction of two allowances | nothing |
| the H2S to CO2 ratio | formed from MOLE FRACTIONS, `y_H2S / y_CO2`, which needs no pressure at all. `P y1/(P y2) = y1/y2` whatever P is | 1/500, 1/20 |
| the sour comparison | done entirely in PSIA against the engine doing it in bar | 0.0035 |

**The mole-fraction ratio route is the one that earns its keep.** It is what
catches a `screen` that computes pH2S as the total pressure, and a `screen` that
feeds a fugacity where a partial pressure belongs. Both of those were green
before and neither could ever have been caught by a transcription of the
engine's own ratio.

**2. Constant-free invariants.** Properties, not numbers to be sourced: the pH
factor is exactly 1 at its reference; exactly one decade per two pH units,
whatever the slope is claimed to be; the mass-transfer term is exactly linear in
fCO2 and exactly a power law in U and in d, tested by a scale-free doubling
ratio; the scale factor is exactly 1 at the onset, clamped below it and below 1
above it; the series residual; and the pipe force balance.

**3. Pins.** Every held constant is MEASURED OUT OF THE ENGINE'S OWN BEHAVIOUR
and compared with a literal typed in the gate, which is a THIRD location.
Measuring rather than exporting is deliberate: it proves the engine actually
uses the number.

| constant | how the gate measures it |
| --- | --- |
| 0.0031, 1.4 | `log10(a)/P` is linear in `1/T`, so two temperatures solve for both |
| the 250 bar cap | located by comparing 300, 250 and 249 bar |
| 4.93, 1119, 0.58 | `log10 Vr` is linear in `1/T` and in `log10 f`, so three points solve for all three |
| 2.45, 0.8, 0.2 | the doubling ratios of `Vm` in U and in d, and `Vm(1,1,1)` |
| 2400, 0.6, 6.7 | the same slope pair on `log10 Fscale`, measured at 140 to 190 C where the factor is unclamped |
| -0.5 | the slope between pH 5 and pH 7 |
| 0.046, -0.2, 16 | the friction factor at Re 2e5 and 8e5 gives the exponent and the coefficient; `f Re` at Re 1500 gives the laminar constant |
| Re 4000 | BISECTED on the branch name the engine returns |
| 100 Pa, 50 Pa | the velocity producing each shear is bisected, and the risk word is read either side of it |
| 0.0035 bar and its psia value | the screen is read either side of the threshold; and the psia value is asserted NOT to be 0.05 |
| 1/500, 1/20 | the regime word is read either side of each boundary |
| 0.1, 0.5, 1.0 mm/yr | the category word is read either side of each band |

The oracle writes its own copy of every held constant into the golden's
`heldConstants` block and the gate cross-pins that against the same literals, so
**moving a constant in the engine and in the oracle together now fails the pin**
even before any measurement runs.

### Fifty-one negative controls, every one proved to fire

A recipe that cannot fail is not a check, so each one is run against a
deliberately wrong implementation and must reject it. The controls are grouped
and every one prints the case it names:

- **sixteen** run a measurement recipe against a stub with the constant moved:
  0.0031 to 0.0035, 1.4 to 1.6, 4.93 to 5.10, 1119 to 1200, 0.58 to 0.65, 2.45
  to 2.80, the U exponent 0.8 to 0.9, the d exponent 0.2 to 0.3, 2400 to 2600,
  0.6 to 0.7, 6.7 to 7.0, the pH slope -0.5 to -0.8, Blasius 0.046 to 0.079 and
  -0.2 to -0.25, the laminar 16 to 64, and the switch 4000 to 2100;
- **eight** break a form: the decade law with the slope moved, fCO2 entering as
  a square root, the combination replaced by a minimum and by an arithmetic
  mean, the wall shear halved, the force balance's perimeter factor 4 read as 8,
  the onset's closed form rearranged with the wrong sign, and **the 60 C claim
  asserted as if it were the onset**;
- **ten** assert a wrong value through the same comparison the real pin uses:
  pH2S taken as the total pressure, the fugacity fed where the partial pressure
  belongs, the category taken from the uninhibited rate, the sour threshold by a
  factor of ten and read as exactly 0.05 psia, the low band 0.1 to 0.5, the film
  thresholds 100 to 200 and 50 to 20, the carbonate boundary 1/500 to 1/50, and
  the shortfall forced to zero;
- **seventeen** assert the OLD fails-open behaviour and must fail: the no-CO2
  branch reached by a NaN fugacity, the Infinity mass-transfer answer, the
  swallowed `shear.error`, the inert pH below the reference, the `eff > 0.9`
  guard silent at the app default, the datasheet efficiency applied through a
  stripped film, the graded rate in the sulphide regime, the unbounded passing
  life from a zero rate, the 300 mol% CO2, the 500 percent water cut, the
  case-sensitive regime match, the silent 99.9 clamp, the finite garbage below
  absolute zero, Region 3 from a missing pH, the empty note on the unknown
  regime, the fabricated 0 percent inhibition on an oil-wet line, and a `screen`
  with no binding constraint.

### The harness itself had the same disease

`plant.sh` grepped for `^Tests:` and called anything without the word "failed"
green. A plant that broke parsing produced no `Tests:` line, or
`Tests: 0 total`, and was counted as GREEN. It reported five such greens in the
first re-run. **A harness that cannot run the suite must not report green**: it
now reports BROKEN with the reason, and the corrected run found those five were
all red. Two more bogus greens came from two batteries running concurrently and
racing on the same worktree; they are red when run serially. Both are recorded
because the same class of mistake is what this whole wave is about.

### Before and after

| battery | before FC9-0 | after |
| --- | --- | --- |
| engine only | **13 of 50 GREEN** | **0 of 70 green.** 70 of 70 caught |
| engine and oracle together | **15 of 17 GREEN**, oracle caught 0 of 17 | **0 of 25 green.** 24 fail tests; 1, the pH reference moved in both, makes the oracle REFUSE to generate a golden at all, which is a detection and not a pass |
| gate size | 19 tests | 48 tests, 51 negative controls |

Four of the original fifty engine plants **no longer have a target**, because
they moved constants inside the withdrawn sour-region expression. That is the
correct outcome of a withdrawal: the surface is gone, so the defect cannot be
planted. Four replacements were written against what survives, so the count is
comparable: the threshold comparison inverted, the bar to psia conversion
truncated to 14.5038, `regionProvided` flipped back on, and the decades taken in
natural logs. Twenty more were added against the repairs themselves, so no
repair in this wave is held by nothing.

## The golden is synthetic, and it says so

**Ten rows before, none of them published. One hundred and ten rows now, still
none of them published, and the golden carries a `provenance` block that says
so and says why.** There is no published de Waard-Milliams case, no MR0175 or
ISO 15156 clause and no corrosion rate-band table anywhere in this repository. A
number recalled from memory is not a published datum, so none is typed, and the
gate asserts `provenance.published === false` rather than letting a later reader
assume otherwise. Route independence and the pins carry the load instead, which
is exactly what the paired battery proves they now do.

Conditions are deliberately NOT round numbers. FC4's repair took a capstone's
exact conditions for a published golden row and the golden handed back a graded
answer. **There is no `fields.json` for this wave yet**, because FC9's course has
not been written, so no collision check was possible: the mitigation is that
every new row runs at conditions no capstone would choose (103.7 C, 62.4 bar,
1.00584 m/s, 312.5 bar), and **the FC9 capstone writer must check every one of
its conditions against this golden before a field lands.**

### The branches the old ten rows never reached

| branch | before | now |
| --- | --- | --- |
| an unclamped `scaleFactor` | 2 of 5 rows, 3 pinned at exactly 1.0 by the clamp | 7 of 17 |
| `phFactor` below 1 | 3 of 5, two rows exactly 1.0 at pH 4.0 and pH 3.8 | 16 of 17, and the pH 3.8 row moved to 4.2 because the module now refuses below the reference |
| the LAMINAR friction branch | none | 2 rows, plus 2 straddling Reynolds 3960 and 4040 |
| `controlling: 'reaction kinetics'` | none | 2 rows |
| `controlling: 'comparable'` | did not exist | 1 row, the two resistances within 0.5 percent |
| oil wet and intermittent | none | 1 each |
| above the 250 bar cap | none, the top row was 200 bar | 1 row at 312.5 bar |
| the fCO2 range | 0.94 to 1.64 bar, under 2x, so both `log10(fCO2)` terms barely moved | 0.0166 to 49.26 bar, **2972x** |
| `sourServiceScreen` | no row, no oracle route | 7 rows, above and below |
| `corrosionRegime` | no row, no oracle route | 9 rows at five different total pressures, all four regimes |
| `remainingLife` | no row, no oracle route | 5 rows plus a zero-rate row |
| `rateCategory` | no row, no oracle route | 12 rows, both sides of all three bands, plus NaN |
| `screen` | no row, no oracle route | 9 whole-screen rows, every field, three different binding constraints |
| the refusals | no row | 16 rows |
| the inhibitor clamps | no row | 3 rows |
| the film onset | did not exist | 7 fugacities, onset moving over 30 C |

`co2Fugacity.pco2Bar` was in the golden and never asserted by any test. It is
asserted now, and it is the number the whole H2S ratio is built on.

## Movement: what a live user will see change

Every one of these is a number or a word a user has been shown. None of them
moved by an unexplained amount.

| what | before | after | why |
| --- | --- | --- | --- |
| the rate at the app's own defaults | 0.7545236542623222 mm/yr | **unchanged**, bit for bit | the default case takes no repaired branch |
| the inhibitor row at the defaults | 85.5 percent in EMERALD, no warning | 85.5 percent in AMBER with a warning naming 1.45 times the metal loss | the `eff > 0.9` guard became an effective-shortfall guard |
| the rate at 60 ft/s | 1.8966 mm/yr | **13.0800 mm/yr, 6.90 times** | the shear verdict now removes the inhibitor credit it warned about |
| the remaining life at 60 ft/s | 1.674 yr | **0.2427 yr** | the same |
| the rate at pH 2.0, 3.0, 3.5 | 1.3417538787620145 mm/yr | **a refusal** | the pH correction is undefined below its reference |
| the rate with a blank pH box | 0.7545 mm/yr | **a refusal** | the 4.5 default is gone; a typed 4.0 gives 1.3418, which the blank box was understating by 43.8 percent |
| a blank temperature, CO2, velocity, ID, density or viscosity box | 0 mm/yr "negligible" in emerald with an unbounded life, or 3.6061 mm/yr | **a refusal naming the box** | seven fails-open guards |
| 1 mol% H2S | 0.755 mm/yr, "high" in orange, 4.21 yr | the same 0.755 as a STATED UPPER BOUND, **no category and no remaining life** | the sulphide regime withholds |
| an oil-wet study | 0 mm/yr, "negligible", 0 percent inhibition, "unbounded / MEETS" | 0 mm/yr with **no category, no life, null inhibition** and a note that the rate is zero by assumption | three repairs at once |
| a typed 100 percent efficiency at 95 availability | 94.905 percent effective | **95 percent** | the silent 99.9 ceiling is gone |
| the Sour Service tab | "Sour service (MR0175 / ISO 15156)", a region number, a region label and a named material recommendation | an H2S partial pressure in psia, above or below the threshold, the decades, and a plain statement that severity classification and material selection are not provided | **the withdrawal** |
| the sour threshold hint | "the threshold is 0.05 psia" | "0.0035 bar, which is 0.050763 psia" | the comment was 1.5 percent wrong |
| the scale factor hint | "no protective film at this temperature" at 70 C, against a help guide saying 60 C | the computed onset, 81 C at the app's own fugacity, and the statement that it moves with fCO2 | the docstring's 60 C was never the onset |
| the controlling word near equality | "mass transfer" or "reaction kinetics", flipping on float noise | "comparable" within 10 percent | a bare comparison had no margin |
| every rate | mm/yr only | mm/yr with mpy beside it | the screen is otherwise all field units |
| the summary rail | six independent rows | the same rows plus a BINDING CONSTRAINT, and a refusal banner when the rate is withheld | there was no summary |
| the velocity sweep | a smooth curve straight through the film-stripping shear | the same curve with the stripping velocity MARKED, a note explaining the step, and per-row refusals surfaced | the sweep never recomputed the shear |
| an oil-wet sweep | two flat zero lines under a paragraph about the rate rising with velocity | the same lines under a paragraph saying the regime is the reason | the paragraph was unconditional |

## What is HELD, recorded and never graded

Ten items. `HELD_FOR_LITERATURE` is exported, returned by `screen` in `limits`,
and printed in the studio behind a disclosure. No citation is invented for any of
them and no clause of any standard is quoted, inferred or reconstructed.

1. **Every de Waard-Milliams constant** and the published validity band of each:
   0.0031, 1.4, 4.93, 1119, 0.58, 2.45, the 0.8 velocity exponent, the 0.2
   diameter exponent. Pinned, not validated.
2. **THE MOST CONSEQUENTIAL ONE: whether the protective-scale factor multiplies
   the REACTION term or the COMBINED rate.** The engine forms
   `combined = 1/(1/vr + 1/vm)` FIRST and then multiplies by `fScale`, so it
   applies a protective-film correction to a mass-transfer-limited rate. That is
   a different physical claim from applying it to the reaction rate alone, and
   the two answers differ materially whenever mass transfer controls, **which it
   does at the app's defaults and in 14 of the 17 golden rows.** The engine now
   says exactly what it does and says the alternative is unresolved. Nothing
   downstream of the scale factor should be graded until it is read.
3. **The pH slope of -0.5, the reference pH of 4, and what the correlation does
   BELOW that reference.** The module refuses below it rather than returning 1.
4. **The 250 bar fugacity cap** and what the correlation does above it. The cap
   is now REPORTED (`pressureCapApplied`, `note`) instead of applied in silence,
   and a golden row sits above it.
5. **The H2S threshold of 0.0035 bar.** See the withdrawal.
6. **The H2S to CO2 ratios 1/500 and 1/20.**
7. **The 100 Pa film-stripping threshold and the 50 Pa moderate band.** Both
   drive a coloured word and a warning a user acts on, and the 100 Pa one now
   drives the RATE as well, so it matters more after this wave than before. The
   engine and the studio both say the number is not sourced.
8. **The rate category bands 0.1, 0.5 and 1.0 mm/yr**, which carry no source and
   are looser than the band set commonly cited for carbon steel in production
   service, so a label here may be optimistic by one or two steps. 0.12 mm/yr
   reads "moderate" and the app's own default of 0.755 reads "high". No regrading
   without the published table.
9. **The Blasius coefficients 0.046 and -0.2 and the Reynolds 4000 switch.** The
   switch is a genuine DISCONTINUITY, **2.19 times the wall shear across 0.1
   percent of velocity**, reachable with a viscous fluid in a small line at low
   rate. It is NOT smoothed, because smoothing it would be a third invented
   correlation: it is reported. `nearSwitch` is true within 10 percent of the
   switch and the return carries a note telling the reader to treat the number as
   a bracket. Two golden rows straddle it.
10. **An erosional-velocity criterion, a pitting criterion, and an SSC or HIC
    criterion**, none of which this module has.

## What is NOT repaired, and why

- **An inspection interval, a minimum thickness and a retirement thickness.**
  The app is titled "Corrosion & Integrity Studio", the help guide promised
  integrity and the tile advertised it, and `remainingLife` divides an allowance
  by a rate and stops. API 570, API 579 and B31.G appear nowhere in the engine,
  the app, the help guide or the golden. **Producing any of these means adopting
  a standard this module does not have, so it does not guess at one.** They are
  in `NOT_PROVIDED`, the studio lists them on the rate and integrity tabs, and
  the help guide now says to read the word integrity narrowly. This is the same
  decision as the withdrawal, taken before the fact rather than after it.
- **The Reynolds 4000 discontinuity, and whether this module should compute a
  friction factor at all.** The line hydraulics module already owns a friction
  factor and a Reynolds number with a different correlation and a different
  switch, so the two will not agree. The engine now says so in
  `wallShearStressPa`'s docstring. Removing the duplicate is a cross-module
  decision and it is not this wave's.
- **The three Suite apps that take a corrosion allowance and do not know about
  each other.** This studio consumes an allowance to give a life, default
  0.125 in. Pipeline & Line Sizing ADDS its own, default 0.0625 in, to a Barlow
  pressure wall. Storage Tank & Venting ADDS its own to an API 650 shell course.
  **The wall this studio is eating is not the wall either of those sized**, and
  there is no link and no minimum thickness anywhere. Recorded, stated in the
  help guide, and deliberately NOT wired up in this PR: a link between three
  apps is a design decision, not a repair.
- **The second use of the standard's name in the Suite.**
  `src/components/fdp/modules/facilities/FlowAssuranceAnalysis.jsx` screens sour
  service against a named threshold through `engines/economics/fdp`. That is the
  DEFENSIBLE half, a threshold comparison with no invented region and no
  material guidance, so it is not withdrawn. It does carry its own copy of the
  threshold, and reconciling the two is a separate wave.
- **`corrosionRate.controlling` near equality** is now reported as "comparable"
  within 10 percent. The 10 percent is a REPORTING threshold and it is stated as
  one, not a physical claim.
- **`flowAssuranceExport.js`'s stray `corrosionRisk` column**, a second entirely
  separate corrosion number in the Suite with no importers at all. Left dead
  rather than resurrected, and recorded so a later wave does not mistake it for
  a feature.

## The Suite layer

Fourteen findings, and the studio's only test was a mount smoke test with no
numeric assertion anywhere. It now has fourteen tests that check the unit
conversion field by field, assert the shipped default numbers, and assert the
withdrawal is off the screen.

- **Blank means blank.** `ph: num(c.ph, 4.5)` was the worst of it. Five other
  fallbacks are gone with it and the two that remain, both inhibitor boxes, mean
  no inhibitor, which is the conservative reading.
- **`inputsFromPayload` coerces.** It used to spread any value from a saved study
  or an imported `.pld` straight into the input state, with `parseFloat`
  accepting `'5abc'` as 5 and `'1e999'` as Infinity, and the wetting regime
  passing through unvalidated. Every field is coerced by type, the regime is
  validated against the three the engine accepts, the swept velocity list is
  cleaned, and a section that is not an object falls back whole.
- **The velocity sweep runs the whole `screen`**, so it obeys the film-stripping
  rule the other tab states, and the stripping velocity is drawn on the chart.
- **`uninhibitedMpy` was computed and never displayed.** It is displayed. The
  sweep's per-row `category` was computed and never shown; the sweep now carries
  the shear and the film verdict instead, which is what the chart needed.
- **The water cut box** was hidden unless the regime was intermittent, so a study
  saved intermittent kept an invisible inert water cut. It is always visible and
  the hint says when it is used.
- **Three help-guide claims were wrong and one was right.** The sulphide ratio
  claim said "past about one to five hundred, iron sulphide governs", which is
  the ratio at which the ENGINE calls the film mixed and the CO2 rate an upper
  bound, so the help and the panel gave two different answers about the same
  number; the 60 C claim was 21 C out; and the integrity promise was one the
  studio cannot keep. All three corrected. **KEPT, because running the engine
  confirms it: a 95 percent inhibitor at 80 percent availability delivers
  exactly 76 percent protection, and 0.24 against 0.05 is 4.80 times the metal
  loss.** Both halves check out and the gate asserts both.
- **The tile description** in `master_apps` sells "the protective-scale
  correction above 60 C" and "MR0175 sour-service regions from H2S partial
  pressure and pH". Migration `20260916120000` corrects the description only;
  the slug carries entitlements and is untouched. Logged in MIGRATIONS.md, HELD
  for the owner.

## Vendoring

`engines/facilities/corrosion.js` imports nothing, so the closure is the engine,
the golden, the oracle and the jest suite, plus the Suite shim, the context, the
page, three component files and two migrations. **The repair adds no import**, so
the closure is unchanged and the Suite guard proves it by naming exactly those
paths and no others.
