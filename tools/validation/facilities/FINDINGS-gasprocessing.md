# FINDINGS: gas processing (FC4-0, 2026-09-16)

The repair wave before the NextGen Gas Treating & Dehydration course, taken
against `engines/facilities/gasProcessing.js` at engines main `4fa37e6`, over
`engines/production/gasProperties.js` and `engines/facilities/separatorSizing.js`.
The full defect list, with the inputs that expose each one, is the course
wave's recon (`/root/fc-wip-gasprocessing/FINDINGS.md`, 49 findings); this file
records what changed here and why.

Forty-nine findings. **Three were a confident wrong number on four screens at
the app's own shipped defaults**, twenty inputs across six functions returned a
wrong number with no warning, and five returned a NaN or an Infinity with no
`error` key, so every caller's `if (result.error)` guard passed and the studio
rendered a dash where a fault belonged. Twenty-one were reachable by typing into
a box in a shipped Suite studio. The one export outside the module's
error-carrying contract now carries it.

**The second finding is the one that mattered.** The strongest check this module
had could not fail. Eight defects were planted before the wave and five of them
left the suite at 12 of 12 passing, including the CORRECT Joule-Thomson formula.
Twenty-three defects are planted in the controls now and **all twenty-three are
caught**.

## The one that was wrong on valid input

**The Joule-Thomson coefficient divided by z.** The relation is

    mu_JT = (1/Cp) [ T (dV/dT)_P - V ],   V = z R T / P
    T (dV/dT)_P = V + (R T^2 / P) (dz/dT)_P
    =>  mu_JT = (R T^2 / (Cp P)) (dz/dT)_P

and there is no z in the denominator. The engine carried one, **and so did the
docstring above it**, so it read as settled rather than as a typo and a repair
had to correct both. The error is exactly a factor of 1/z: zero in the
ideal-gas limit and growing with pressure, which is the shape that hides it,
because it is smallest exactly where a sanity check is easiest. Verified
against two routes that share nothing with the engine's rearrangement: a
numerical `T dV/dT - V` on a molar volume formed from an independently solved
z, and `-(dH/dP)_T / Cp` from the isothermal enthalpy departure. Both agree to
every printed digit and both equal the engine times z.

| psia | degF | z | engine before | correct | engine/correct | 1/z |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 100 | 0.9973 | 0.052107 | 0.051964 | 1.00276 | 1.002756 |
| 600 | 100 | 0.9196 | 0.060853 | 0.055960 | 1.08742 | 1.087420 |
| 1000 | 100 | 0.8710 | 0.065765 | 0.057283 | 1.14807 | 1.148070 |
| 1000 | 60 | 0.8289 | 0.086119 | 0.071386 | 1.20640 | 1.206400 |
| 2500 | 100 | 0.7899 | 0.047072 | 0.037184 | 1.26591 | 1.265914 |

On the Dew Point tab's shipped defaults, all four numbers on the tab were
wrong: the coefficient 6.6 degF per 100 psi instead of 5.7, the cooling
27.3 degF instead of 24.0, the downstream temperature 72.7 instead of 76.0 and
the water the cold gas can hold 31.5 lb/MMscf instead of 35.1. **It was
anti-conservative in the direction that matters**: a dew point skid is bought
for its cooling, and a coefficient 15 percent high sells a depression it does
not deliver. `flowlineThermal.js` takes `jtCoeffFPerPsi` as a TYPED user input
and never computes one, so this is also the number a human carries between two
apps by hand.

## The march was first order, and always short

A second, smaller wrong number, found while building the gate for the first.
`jtDrop` evaluated the coefficient at each interval's midpoint PRESSURE but at
the temperature the interval started with, which is midpoint in P and plain
Euler in T, so the whole march was first order and carried a one-directional
bias. Against a 20000-step march of itself it **understated the cooling by 3119
ppm on a 1000 to 600 psia drop, 4816 ppm on 1000 to 400 and 6775 ppm on 850 to
300**, and the error halved only when the step count doubled, so 20 steps could
not be rescued by any affordable increase. Taking the half-step temperature as
well as the half-step pressure makes it second order at the same step count and
two evaluations per interval: the same 20 steps now land within 1e-5 of the
converged answer on every published case. **The convergence gate that proves it
would have failed on the old march**, and is one of the planted controls.

## The gate that could not fail

`__tests__/facilities.gasprocessing.test.js` passed 12 of 12 while the
coefficient was wrong by 1/z, and **went on passing 12 of 12 when the correct
formula was substituted**. The Joule-Thomson chain had no golden row, no oracle
route and no check but a band of 5 to 9 degF per 100 psi, and both 6.576 and
5.728 sit inside it. That band is kept, labelled as the sanity range it is, and
the test now asserts that BOTH the right answer and the wrong one sit inside
it, so nobody mistakes it for a check again.

**Three of the five oracle routes were transcriptions of the engine.** The TEG,
amine and contactor routes carried the same constants (1100, 8.34, 69.9,
28.9625, 10.7316, 14.65, 520, 379.49, 18.01528) and the same expression shapes.
The TEG and amine routes' claimed "SI re-derivation" was a multiply by
0.45359237 followed by a divide by 0.45359237 on the same expression, proven
bit-identical; the contactor route was entirely in field units while the
docstring above it said SI.

Every route now **says in its own docstring what it checks and what it cannot**,
because the honest answer is not the same for all of them:

| route | what it checks | what it cannot |
| --- | --- | --- |
| water saturation | the vapour-pressure fit, by ANTOINE against the engine's MAGNUS | the molecular weight of water |
| Kremser | the closed form, against the stage cascade solved as a LINEAR SYSTEM | nothing: it is fully independent |
| Joule-Thomson | the whole relation, by numerical `T dV/dT - V` in SI on a bisection-solved z, five-point stencil | the DAK and Sutton coefficients |
| molar quantities | `LBMOL_SCF`, derived here from the SI gas constant and the standard base | -- |
| TEG and amine balances | every unit packaging: the gallon, the Btu, the hour, Btu/(lb.degF) to J/(kg.K), by going through kg, m3 and WATTS and coming back | the balance itself, which is a definition in any language |
| contactor | the molar volume, the standard-to-actual conversion assembled from the gas law rather than the engine's shortcut, the gas density from molar mass, and the liquid density default | the molecular weight of air |

**The two routes that were already genuinely independent were not touched.**
Water content (Antoine against Magnus, worst gap 0.638 percent against a 1
percent tolerance) and Kremser (a linear-system cascade agreeing to 1.1e-16)
both discriminate, and a test now asserts the water gap stays a REAL
disagreement between 1e-4 and 1e-2: if anyone ever "tidies" the oracle onto
Magnus the gap collapses to machine epsilon and that test fails. It is one of
the planted controls. **Identical to twelve decimals is a weaker result than
agreeing to six**, because it is what two copies of one calculation produce.

## What no route can check, and what was done about it

Some numbers in this module have no publication in this repository to check
them against: the 1100 Btu per lb of water carried out of the still overhead,
the 8.34 lb per gallon of water, the amine table's molecular weights, solution
gravities, loadings and duties, the Magnus coefficients and the customary
bands. Three things were done, in this order:

1. **The ones that are derivable are derived.** `LBMOL_SCF` from the package's
   gas constant and one standard base; the contactor's liquid density from the
   module's one glycol density and the exact gallon; the Btu to psia.ft3
   packaging from the international-table Btu and the exact foot.
2. **The ones that are design choices became inputs.** The water overhead and
   the contactor liquid density, both with their current values as defaults,
   and a published golden case that states NONE of the defaults so that moving
   one moves a published number.
3. **The rest are in `DECLARED_CONSTANTS` and the gate pins them by value.**
   The oracle holds its own second copy of each. **That is a pin and not a
   validation**, it says so in the code and in the test, and nothing in the
   course may present it as one. What it buys is that changing one of them is a
   reviewed act instead of a silent one: three of the five defects that used to
   leave the suite green were changes to numbers on this list, and all three
   now fail.

## One standard base, one glycol density, one water density

**The standard base.** `LBMOL_SCF = 379.49` was typed with a comment naming
14.65 psia, which is a base it does not belong to: measured from the module's
own gas constant and Rankine offset, 379.49 scf/lbmol lands at 14.695751 psia
at 60 degF, 1.003123 times the 14.65 named. The contactor then converted
standard to actual volume at a THIRD base, 14.65 psia over 520 degR: the
measured group is 0.028173077 against the 0.028279006 psia per degR the pound
mole implies, a factor of 0.996254, **0.189 percent on a diameter**
(the two published contactor cases move by 1.001887). The same
MMscfd was one molar quantity when it became a water content and a different
one when it became a column volume. The base is declared once now and the molar
volume derived from it, exactly as `compression.js` does since FC3-0; 379.49 is
a rounding of that derivation, 1.0000169391883849 times it, with no independent
provenance.

**The glycol density.** Two in one file: a typed 69.9 lb/ft3 inside the
contactor and 9.3 lb/gal as the default of `tegLbPerGal`, which is 69.568831
lb/ft3. A factor of 1.004760, one import apart, on the same fluid. lb/gal is
kept as the spelling because it is how a glycol datasheet quotes it and because
it was already a typed input's door; the contactor's default is derived from it
through the exact gallon.

**The water density.** 8.34 lb/gal is a customary rounding, 1.000338 times the
999.016 kg/m3 of water at 60 degF, which is 8.337193 lb/gal. **It is kept and
the gap recorded**, not silently closed: it is what the amine circulation
charts this balance is read against are drawn with, and moving it moves every
shipped amine number in the platform. The same reasoning FC3-0 applied to the
gas constant.

**The gas constant is NOT moved.** `R_UNIVERSAL = 10.7316` is itself a rounding,
2.1349e-6 above the SI derivation 10.731577088819062, and that ratio is exactly
the residual every molar and real-gas comparison in the new gate carries. The
gate does not merely tolerate it: one test asserts the residual **equals** the
rounding to twelve digits, so the named cause is itself a gate. Moving R is a
package-wide decision that would move every gas course.

## The three the module hid while criticising its predecessor

The header criticised the predecessor app for hiding 4 gal per lb, 750 Btu per
gal and 15 percent BTEX inside constants, and then hid **1100 Btu per lb of
water overhead, 69.9 lb per ft3 of liquid and 8.34 lb per gallon of water**.
Two of the three are inputs now and the third is a named export with its
provenance stated. The comment that named "latent ~970 plus sensible to the
still" described a split that **was not in the code**: only the folded 1100
existed and the split could not be recovered from outside. The comment says
what the code does now.

## What `leanTegWtPct` is for

It was range-checked, refused outside 90 to 100, and then never read: the
package run at 99.0 and at 90.001 returned every field bit-identical. **A
validated input that moves nothing is worse than an absent one**, because the
validation asserts that it matters, and a user could ask for a 0.1 lb/MMscf
cryogenic outlet on 90.001 weight percent glycol and get a confident answer.

The temptation was to make it set the achievable outlet spec. That is a chart,
the equilibrium dew point of gas over lean glycol, **and this repository does
not carry it**; inventing one would be putting an unsourced model on top of a
typed one, which is the mistake FC3-0 refused on the impeller trim. So the
input now does the thing that IS computable from it with no chart at all: the
**loop water balance**. A gallon of lean glycol at w weight percent carries
`rho (1 - w/100)` lb of water before it absorbs anything, and comes back rich
at a strength the package reports as `richTegWtPct`. The outlet spec stays a
typed design input and `outletSpecBasis` says so in the return, instead of the
validation implying otherwise. A loop whose rich glycol falls below the 90
weight percent this module will not even accept as a LEAN strength now warns,
against the module's own stated bound rather than an invented one.

## The contactor was sizing an amine column against glycol

`contactorDiameter` typed 69.9 lb/ft3 of TEG as its liquid, and
`GasProcessingContext` called that ONE function for both the dehydration and
the sweetening columns, so the AMINE contactor was sized against GLYCOL: on the
app's own MDEA defaults the diameter came out **1.94 percent small**. The
module's own `AMINES` table has carried `sgSolution` for each amine all along
and the sizing never read it. The liquid density is an input now, and
`amineSolutionLbPerFt3(amineId)` exists for the sweetening caller to pass.
**The Suite change is required and is not in this repository.**

## The fails-open and fails-silent sweep

Every input the engine accepted and should not now has its own guard, naming
the input and its value. **One refusal sentence for several unrelated faults is
itself a defect** (FC3-0), so there is no shared sentence: `tegPackage` carries
sixteen separate guards and refusals, `aminePackage` thirteen, `zAtState`
eight, `contactorDiameter` nine on top of those, `jtDrop` six and
`saturatedWaterContent` four. Each refusal carries its evidence, in the FC2-0
shape: a march that dies returns `diedAtStep`, `diedAtPsia` and `diedAtF`, a
z-factor refusal returns `ppr`, `tpr` and the state they were taken at, and an
impossible Kremser spec returns the `ceiling` that makes it impossible.

The ones a user could reach by typing: a reboiler below the absorber returning
**-0.32 MMBtu/hr on screen with no warning**; a negative circulation ratio
(-5.52 gpm of glycol); a negative reflux ratio, which SUBTRACTS from the
overhead the still has to boil; a BTEX absorbed fraction of 5; a negative
outlet spec removing more water than the gas carries; 150 weight percent amine
(111.7 gpm) and **-45 weight percent (-372 gpm and a regenerator making
heat)**; a negative lean loading; a negative duty per gallon; a temperature
below absolute zero; and, on the silent side, a circulation ratio or a solution
strength of exactly zero giving Infinity with no `error` key, and a cleared
temperature box giving NaN for z, density, velocity and diameter with the hint
line reading "Souders-Brown at z = --".

**`kremserFractionRemoved` now carries the module's contract.** It was the only
export outside it, returning a bare number, so a zero in the stages box came
back as NaN and no `if (r.error)` downstream could see anything. **This is a
breaking change for callers**, and the two known ones are
`src/contexts/GasProcessingContext.jsx` in the Suite and the FC4 capstone
generator, both of which must read `.fractionRemoved`.

`waterSatPsia` keeps a bare-number NaN contract on purpose, documented in one
line: it is a leaf correlation with nowhere to put an error key, and its one
caller turns the NaN into a named refusal.

## The z-factor window, and the flag that was discarded

Both consumers called `dakZ(...).z` and threw the convergence flag away. The
worse of the two was the Joule-Thomson coefficient: **above a gas gravity of
5.08 Sutton's pseudo-critical PRESSURE is negative**, `dakZ` takes its
non-positive-Ppr branch and returns z = 1, so the coefficient came back EXACTLY
ZERO, which reads as "this gas does not cool"; at 5.07 it came back NEGATIVE
with z reported as 38.5, which says the gas HEATS on expansion. **`dakZ` reports
`converged: true` for both**, so carrying the flag catches neither: the
pseudo-criticals have to be checked before the correlation is called, and the
correlation has to be checked against its window. Both are done in one exported
`zAtState`, and the window is **imported from `separatorSizing.js`**, which
declares and documents it, rather than restated -- the same one-owner rule as
the constants above, and what `compression.js` does.

**Recorded against the recon:** its 20000 psia example is not a fails-open.
Ppr there is 29.85 against the DAK_PPR_MAX of 30, so z = 2.48 is the
correlation being used inside the band it was fitted to; the refusal starts at
20104 psia on that gas. The 60000 psia example (Ppr 89.5, z = 11.00) is real
and is refused.

## The water fit's band

`waterSatPsia` guarded to 100 degC while its own docstring claimed 60 degC and
the refusal message quoted a third figure. **At the guard's own upper edge the
fit puts the vapour pressure of water at 15.095051 psia where the DEFINITION of
the normal boiling point fixes 14.695949**, so it read 1.027157 times the
defining value and said nothing. The Magnus coefficients (Alduchov & Eskridge
1996) are published over -40 to +50 degC with a stated maximum error of 0.384
percent; measured against the Antoine fit the oracle uses, the gap runs 0.12
percent at 30 degC, 0.45 at 50, 0.77 at 60, 1.63 at 80 and 2.70 at 100.

**The guard narrows to the band the docstring always claimed, -45 to 60 degC**,
and a note fires beyond the coefficients' own published 50. 60 degC is 140 degF,
which is a real contactor inlet and is kept working; 200 degF, which the gas
temperature box accepts, is now refused with the band and the value named. This
is a LIVE behaviour change: a number that used to appear now does not.

## Movement

**Twenty-two of the 103 published golden fields that exist in both the old file
and the new one moved, and not one of them by an unexplained amount. Eighty-one
are unchanged**, six of the eighty-one agreeing to within 1 to 5 units in the
last place rather than bit for bit, which is the oracle's different arithmetic
order and not a change in the answer.

| fields | ratio | cause |
| --- | --- | --- |
| `lbPerMMscf` (4), `btexLbDay` (2), `acidMolesDay` (2), amine `circGpm` (2), amine `reboilerMMBtuHr` (2) | 1.000019074156 | the standard base: 379.49 over the 379.4827616866225 the oracle now DERIVES from the SI gas constant |
| contactor `diameterFt` (2) | 1.001887 | the contactor's own base, 14.65 psia over 520 degR replaced by 14.696 over 519.67, to the half power through the volume and the quarter through the area |
| contactor `vAllowFtS` (2) | 0.999998873 | the gas density, through the oracle's move onto the SI gas constant |
| every TEG balance field, every Kremser field, every `z` | 1 | unchanged |

The engine's own molar quantities move by a slightly different ratio,
**1.0000169391883849**, because the engine derives `LBMOL_SCF` from the
package's `R_UNIVERSAL = 10.7316` where the oracle derives it from SI. The
difference between the two ratios IS that constant's rounding, and one test
asserts exactly that.

Three published cases were ADDED rather than moved, so that a default is never
the only thing a case exercises: a TEG case that states a non-default 1250
Btu/lb overhead, a contactor case that states an AMINE solution density, and
two contactor cases that supply neither a z nor a liquid density, which is the
branch the live Suite runs and which no published case reached before. A fourth
new block, `tegDefaults`, states none of the module's defaults at all. The two
original contactor cases are pinned at the 69.9 lb/ft3 the contactor used to
type, so their movement is the base and nothing else.

## The capstone

`/root/fc-wip-gasprocessing/fc4_capstone.mjs` was run three ways: the original
generator against a pristine checkout of engines `4fa37e6` (which is
byte-identical to the NextGen vendored copy, md5 2552c187), the adapted
generator against the same pristine engine, and the adapted generator against
this branch. **The adaptation is one line** -- `kremserFractionRemoved` now
returns an object -- and it is written to fall through on the old engine, so
the first two runs are byte-identical, which is what makes the third a
comparison rather than a guess.

**The run is observable in both directions.** The generator writes to stdout and
the harness redirects, so a crash leaves an EMPTY file and a non-zero exit
rather than a stale one; that was demonstrated by pointing `FC4_ENGINES` at a
path that does not exist and confirming 0 bytes and exit 1. On FC3-0 a control
run crashed and silently left the old file in place, and briefly reported
"identical" for a run that never happened.

| tier | field | ratio | cause |
| --- | --- | --- | --- |
| Associate | `inletLbMMscf` | 1.0000169391883849 | the standard base |
| Associate | `waterLbDay`, `circGpm`, `circGpd` | 1.0000183090 | the same base, amplified by inlet/(inlet - outlet) = 66.844/61.844 because the outlet spec is a fixed 5 |
| Associate | `sensiblePerGal` | 1 | unchanged: it carries no molar quantity, which is why it is the graded duty field |
| Associate | `btexTonsYear` | 1.0000169391883849 | the standard base |
| Professional | `fractionRemoved`, `stagesNeeded` | 1 | unchanged, bit for bit |
| Professional | `acidMolesDay`, `circGpm`, `reboilerMMBtuHr`, `circGpmRetuned` | 1.0000169391883849 | the standard base |
| Expert | `dzdT` | 1 | unchanged, bit for bit |
| Expert | `waterInLbMMscf` | 1.0000169391883849 | the standard base |
| Expert | `muFPerPsi` | 0.849613614 | z(980 psia, 91 degF, 0.69) = 0.8496141188, times 0.9999994059569968 for the exact Btu packaging. The product reproduces the ratio to the last printed digit. |
| Expert | `dropF` | 0.868375812 | two causes: 0.863906862 from the `/z` removal across the march, and 1.005172953 from the march becoming second order. Measured separately by running the repaired coefficient through the old integrator. |
| Expert | `t2F` | 49.667 -> 55.108 degF | the same two causes; a ratio is meaningless on a temperature |
| Expert | `waterOutLbMMscf` | 1.221552090 | the 5.44 degF warmer separator inlet through the Magnus exponential, times the standard base |

**Four of the six Expert fields were expected to move and did.** So did eleven
fields on the other two tiers, and **one of those is a finding rather than a
fact**: the Expert capstone was deliberately ordered so that `dzdT` and
`waterInLbMMscf` came first as the two that do NOT move. `dzdT` holds. **The
inlet water content DOES move**, by the standard base, because it is a molar
quantity and the base was one of the repairs. Nothing else moved that is not on
this table, and every ratio on it has a constant behind it.

## The controls

Twenty-three defects planted one at a time, the gate run against each, the
engine restored between. **Twenty-three of twenty-three caught**, including all
five that used to leave the suite green:

| control | before FC4-0 | now |
| --- | --- | --- |
| the correct Joule-Thomson formula (now: the `/z` put back) | 12 of 12 PASS | 5 tests fail |
| contactor liquid density 69.9 -> 62.4 | 12 of 12 PASS | 2 tests fail |
| TEG water overhead 1100 -> 1400 | 12 of 12 PASS | 2 tests fail |
| amine water density 8.34 -> 9.00 | 12 of 12 PASS | 3 tests fail |
| `acidMolesDay` x 1.5 | 12 of 12 PASS | 1 test fails |

and, added by this wave: the overhead moved in the engine AND in the oracle's
own copy together (caught by the pin), `LBMOL_SCF` back to 379.49, the glycol
density moved, the BTEX molecular weight moved, the contactor's 14.65/520 base
put back, the march reverted to first order, `leanTegWtPct` made inert again,
`kremserFractionRemoved` returned to a bare number, each removed guard, and
**the oracle's water route "tidied" onto Magnus**, which is the F-O1 disease
itself and is now a failing test.

## What is NOT repaired, and why

- **The McKetta-Wehe real-gas correction** above about 1000 psia. Held for
  literature, warned about, and the warning boundary is now read from both
  sides.
- **8.34 lb/gal, 1100 Btu/lb, the amine table, the customary bands and the
  Souders-Brown K defaults.** No publication in this repository. Pinned, not
  validated, and said so.
- **`btexMw` defaulting to 92**, which is toluene standing for a four-compound
  cut. It is an input, the default is documented as one compound standing for
  four, and choosing a better number needs a field composition.
- **`R_UNIVERSAL = 10.7316`.** See above: consistency over proximity, exactly
  as FC3-0 decided.
- **The Suite composition layer.** `GasProcessingContext` must pass the amine
  solution density on the sweetening tab, must read `.fractionRemoved`, must
  surface the new refusals instead of rendering `--`, and should print
  `muMeanFPerPsi` where it prints an inlet coefficient beside a marched
  temperature. A separate agent owns that repository.
