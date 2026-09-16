# FINDINGS: produced water treatment (FC7-0 and FC7-1, 2026-09-16)

Two waves, in one file on purpose. FC7-0 is below; **FC7-1 is the last
section, and it records three more defects the FC7 course foundation found
by exercising the engine FC7-0 had just repaired.** All three are classes
FC7-0 itself named, surviving in places FC7-0 did not look.

The repair wave before the NextGen Produced Water course, taken against
`engines/facilities/producedWater.js` at engines main `82ec6d4`, its oracle,
its golden and its jest suite, and the LIVE Suite studio that calls all of it.
The full defect list, with the inputs that expose each one, is the course
wave's recon (`/root/fc-wip-producedwater/FINDINGS.md`, 55 findings). This file
records what changed here, what was decided, and what was not repaired.

Fifty-five findings. **Twenty-seven were reachable by typing into a box in the
shipped Produced Water Treatment Studio and produced a wrong, unmoved or
non-finite number on a screen.** Ten of the engine's exports failed open, three
device inputs and one whole device distinction could not change any number at
all, and the studio's headline verdict on its own shipped defaults rested on a
liner bank the engine was running at 7.667 times its design flow.

**The measure of the gate is the planting battery.** Twenty-seven defects
planted in the engine alone and eight planted in the engine and the oracle
together, run one at a time against the suite:

| | engine alone | engine and oracle together | total |
| --- | --- | --- | --- |
| before FC7-0, LEFT THE SUITE GREEN | **16 of 27** | **6 of 8** | **22 of 35** |
| after FC7-0, left the suite green | **0 of 27** | **0 of 8** | **0 of 35** |

The battery, its exact substitutions and both runs are
`/root/fc-wip-producedwater/scratch/battery*.json` and `battery_*.txt`. The
suite went from 20 tests to 68.

---

## 1. The hydrocyclone told a designer to buy fewer liners

`gField = gFieldAtDesign * turndown * turndown` was unbounded above, and the
cut size falls as one over the square root of the field, so **every liner
REMOVED from the bank made the reported water cleaner, without limit**:

| liners | turndown | g field | cut um | TRAIN OUTLET |
| --- | --- | --- | --- | --- |
| 1 (a cleared box) | 153.34 | 23,514,452 | 0.51 | 0.0155 ppm |
| 5 | 30.67 | 940,578 | 1.14 | 0.170 ppm |
| **20 (shipped)** | **7.67** | **58,786** | **2.28** | **1.219 ppm, MEETS, margin 27.78** |
| 153 (design flow) | 1.00 | 1,005 | 6.32 | 13.051 ppm |

The whole studio headline sat on the third row. The liner count box had a
fallback of 1, so **clearing it gave one liner at 23.5 million g and an outlet
78 times better than the shipped case**.

Three things were wrong at once: the field had no ceiling, the above-1.3x
branch warned about shear while its own numbers improved, and the three
constants that set the entire scale (`designFlowPerLinerM3S`, `gFieldAtDesign`
and a bare `/ 100` on a "residence-scaled" axial velocity) were unsourced,
unreachable and invisible.

**DECISION: the liner geometry is stated, so the cut can be marched.** The
`/ 100` is gone. The liner is a tube of `linerDiameterM` by `linerLengthM`; the
residence time is its volume over the flow through it; the inlet spreads the
droplets over the cross-section BY AREA, so the median droplet starts at the
half-area radius R/sqrt(2); it is captured when it reaches the oil core at
`coreRadiusFraction` of the radius; and the cut size is the droplet whose
radial Stokes migration in the field just crosses that gap in the residence
time. Every one of those is an input or a declared constant, and the oracle
marches the trajectory and then checks the criterion itself with a Monte Carlo
over starting radii uniform by area: **at the reported cut size the captured
fraction comes out 0.500455 against the one half it must be.** The half-area
radius is a derived criterion now and not a constant.

**DECISION: the field stops rising at the top of the operating envelope, the
overload is a penalty, and past twice design the module refuses.** The field is
`gFieldAtDesign * min(turndown, 1.3)^2`, because past the envelope the inlet
slot chokes and the extra energy goes into pressure drop and shear; above 1.3
the cut carries `sqrt(turndown / 1.3)` as an inlet-shear penalty, so the net
cut grows in direct proportion to the overload. The reported field can no
longer exceed 1690 g. Above 2.0 times design the module **refuses and says how
many liners the flow needs**: the shipped 20-liner case now returns

> these 20 liners each carry 4.600e-3 m3/s, 7.67 times their 0.0006 m3/s design
> flow: this module holds a liner bank to 2 times design, because past it the
> pressure drop and the inlet shear decide the answer and this model does not
> carry them. 154 liners would run this flow at its design point

**The Suite default moved from 20 liners to 160**, which is turndown 0.958. A
test sweeps the bank downward and asserts that past the envelope fewer liners
are always WORSE, which is the FC4-class assertion this engine needed.

**The cut this ideal gives is finer than field de-oilers are customarily
credited with** (4.65 um at the new default against the 10 to 15 um usually
quoted), because it ignores re-entrainment, the reject split and the shear the
liner itself applies. No vendor performance curve exists in this repository.
**HELD FOR LITERATURE**, stated in `cutBasis` on every return and printed in
the studio.

## 2. Four devices trusted what a fifth refused, and the train gave a verdict anyway

`stokesRiseMS` refused an oil that cannot rise, by name. Given the identical
inputs, `apiSeparator`, `plateInterceptor`, `hydrocyclone` and `flotation` each
returned `d50cMicron: NaN` with **no `error` key**, because each inverted the
same Stokes group through the square root of a negative number, and the API
separator returned a confident velocity warning beside it. All four also
accepted a MISSING viscosity and returned the same NaN.

`treatmentTrain` then hit `if (!dev || !(dev.d50cMicron > 0))`, pushed a stage
error, `continue`d, and returned `meetsSpec` and `marginPpm` computed over
whatever did run, with no count, no flag and no top-level error. **Clearing the
plate area box in the shipped studio dropped the CPI and the studio still
printed 1.220 ppm, 99.76 percent removal and MEETS with a 27.78 ppm margin.**
Clearing three boxes left two of three stages dead and reported 0.022 ppm and
99.996 percent.

This is the FC1 `separation` defect ("a verdict that used to fail open",
already a merged lesson) in a second engine. **When two halves of one module
disagree, the trusting half is the bug.**

All four refuse now, each naming the input and its value, and one table-driven
test runs the identical bad fluid through all five exports at once and reports
every one that answers. `treatmentTrain` returns `complete`, `stagesRun`,
`stagesSkipped`, `skippedStages` and a `verdictWithheldReason`, and
**withholds `meetsSpec` and `marginPpm` entirely** when any stage did not run.
A failed stage carries nothing but its name and its cause: it used to spread
the raw device, so a stage that did not run could still show a confident
process warning. The Suite paints the row, refuses to print MEETS and shows
the reason.

## 3. What flotation models, decided

`attachFraction = 1 - exp(-k t)` was **exactly 1.000000000000 across gas ratios
from 0.001 to 3 and bubbles from 20 to 1500 micron**, because the rate constant
ran from 0.21 to 631 per second against residence times of hundreds of seconds.
So the bubble count, the rate constant, the collision efficiency and the
residence time had no effect on the cut size whatsoever, the "Gas ratio" box
was decorative, and **induced and dissolved gas flotation were numerically the
same device** behind two menu entries, a live selector, a live box and a
catalogue entry that sold both. What actually set the cut was

    effectiveRise = (cellVolumeM3 / (flowM3S * residenceS)) / residenceS

which is identically `1 / (nCells * residenceS)`, units of 1/s fed into an
inversion that wants m/s, with a hidden metre in it. At the SAME total volume,
the SAME flow and the SAME residence time of 347.83 s the cut was **135.82 um
for 1 x 32 m3, 67.91 um for 4 x 8 m3 and 33.95 um for 16 x 2 m3**.

**DECISION: the attachment kinetics sets the cut, and it is a grade efficiency
rather than a single number.** The alternative was to delete the dead kinetics
and call the device an equivalent-gravity cut, which would have left the bubble
size and the gas rate decorative for good and kept IGF and DAF identical. The
kinetics is the standard flotation model and it is the one that makes the
inputs bite:

- the gas is fed to EACH cell at `gasRatio` times the water flow and rises
  through the cell's plan area, so `vg = gasRatio * Q / (V / cellDepthM)`;
  `cellDepthM` is a new input and it is the metre that used to be hidden
- the bubble rises at the **full drag balance** with the Schiller-Naumann drag
  coefficient, solved by damped iteration in the new `terminalRiseMS`. A 300
  micron bubble sits at Reynolds 20; the old code used Stokes there, at
  Reynolds 43 by its own numbers, and on a hardcoded 1.2 kg/m3 air density that
  no caller could pass. The gas density is an input now
- the swarm's holdup is `vg / vBubble`, and a holdup past 20 percent warns,
  because a swarm of independent bubbles is no longer what is in the cell
- a droplet is captured by **INTERCEPTION**, efficiency `A (d/db)^2`, so the
  first-order rate constant is `k(d) = (3/2) A eps vg d^2 / db^3`, in which the
  bubble rise velocity cancels between the holdup and the flux
- the cut size is the droplet for which `k(d) tau = ln 2`

Every input now moves the answer, and `sharpness` comes out of the same law
rather than the module's one default: the capture rate goes as d squared, so
the grade curve is an exponential in `(d/d50c)^2` and the reduced-efficiency
family with **m = 2 is DERIVED**, not chosen. The filter is the same.

**The one number with no derivation is the attachment efficiency, and it is a
calibration.** `attachmentEfficiency: 0.01` is chosen so that a cell at this
module's own defaults cuts in the ten-to-twenty micron range induced gas
flotation is customarily credited with. It is an input, it is in
`DECLARED_CONSTANTS`, the gate pins it by literal, and the code says in as many
words that it is the one number here with no derivation at all. Nothing
downstream may present it as published.

**IGF and DAF are different devices now**, on the two boxes that make them
different and nothing else: at the studio's presets the induced cell cuts at
18.6 um and the dissolved cell, on 80 micron bubbles at a three percent gas
rate, cuts at 6.6 um. The app's hidden 80 micron hardcode for DAF is gone and
both presets are one-click buttons on two live boxes.

**IDENTITY, in place of the fourfold arrangement bug:** at equal total gas and
equal total volume, `1 x 32`, `2 x 16`, `4 x 8` and `16 x 2` now agree to 1e-12,
and a test asserts it. The cell count still moves the answer when the gas ratio
is held instead, and it should: four cells at a ratio use four times the gas of
one. The return reports `gasFlowPerCellM3S` and `totalGasFlowM3S` so that
reason is on the screen rather than inferred.

## 4. What the media filter models, decided

It computed its removal **twice, by two routes that disagreed**: depth
filtration said 73.83 percent at the app's default filter where the cut-size
route said 84.82 percent on the same water, 83.78 against 91.25 at 30 m/hr, and
the other way round at 3 m/hr. `treatmentTrain` read only `d50cMicron`, which
was `5 * (loadingMHr / 10) ** 0.5`, a function of the loading rate alone, and
the golden carried only `removalFraction`, `lambdaPerM` and `loadingMHr`. So
**the gate validated the half the train threw away**, the bed depth moved the
train's stage removal by exactly nothing from 0.1 m to 10 m, and the declared
grain size `mediaMicron = 800` was read nowhere at all.

**DECISION: depth filtration is the physics, and the cut size is an inversion
of it rather than a second opinion.** Capture in a packed bed is by
interception, so the filter coefficient of a droplet d on a grain dc goes as
`d^2 / dc^3`; lambda is declared at a reference droplet, a reference grain and
a reference loading and falls with loading rate; penetration is
`exp(-lambda L)`; and the cut size is the droplet the bed removes half of,
`lambda(d50c) L = ln 2`.

- **`removalFraction` is gone from the return**, and a test asserts it is gone,
  so the two-route defect cannot come back without failing
- the bed depth moves the cut by a factor of 10 over 0.1 to 10 m, and the grain
  size by a factor of 8 over 400 to 1600 um. Both used to move it by zero
- the oracle marches the bed layer by layer AND bisects on the droplet whose
  MARCHED removal is exactly one half, which is an independent route to the
  inversion rather than a restatement of it
- **the depth-filtration number did not move at all.** 73.83 percent at 6 m2
  and 88.80 percent at 16 m2, before and after, to every digit. What moved is
  the cut size, from 11.75 to 14.38 um at 6 m2: the discarded half was replaced
  by an inversion of the half that was kept

The declared triple (3.5 per m at a 20 micron droplet, 800 micron media and
10 m/hr) is ONE calibration of this module with no published source.
**The reference droplet and the reference grain are new declared constants**
and are pinned.

## 5. The medians, and the grid they were measured on

Three separate defects in one Stat.

**The coarsest droplet reported as the median of the cleanest water.**
`applyDevice` left the outlet bins UN-normalised when the survival fell below
1e-12, so their sum was about 3e-13, `medianOfBins`'s accumulator never reached
0.5 and it returned `bins[bins.length - 1].dMicron`. On 30 um inlet water a
0.001 um cut removed 99.99999999997 percent and reported an outlet median of
**470.85 um, fifteen times coarser than the inlet**. `applyDevice` now
normalises by the actual surviving volume, reports `survivingVolume` and
`outletNormalised`, and **refuses to report a median for numerical dust** with
a warning that says so.

**The median was quantised to the bin grid.** Outlet concentrations of 1.6e-1,
2.0e-2, 1.3e-3, 1.6e-4, 2.0e-5 and 1.6e-7 ppm all reported the same 7.061 um,
because one step of the module's 60-bin log grid is 6.5 percent of a diameter
at sigma 0.7. `medianOfBins` interpolates in LOG diameter across the bin the
median falls in now, using bin edges `dropletBins` reports for the purpose, and
a test asserts the medians fall monotonically as the cut tightens.

**The inlet and outlet medians were computed two different ways.**
`inletMedianMicron` was the raw typed d50 and `outletMedianMicron` was
`medianOfBins`, whose value for the UNTREATED inlet was **28.632 um against a
typed 30**, so the studio showed the median falling for a train that had
removed nothing. Interpolated, the bin median of the untreated inlet is
**30.000000 um on 30, 60, 120 and 600 bins**, which is the identity it should
always have satisfied: the volume median of a log-normal is its own d50. The
train reports `inletMedianMicron` from the bins the same way it reports the
outlet one, keeps `inletD50Micron` as typed beside it, and carries a
`medianBasis` line saying the two are comparable.

## 6. The validation sweep

Every input the engine accepted and should not now has its own guard naming the
input and its value. **One refusal sentence for several unrelated faults is
itself a defect** (FC3-0), so there is no shared sentence. The ones a user
could reach by typing:

- **a short-circuit factor of 0**, which gave a cut size of exactly zero, which
  the train's own `d50cMicron > 0` guard then read as a broken device and
  **silently deleted from the train**; -2, which gave NaN and was skipped the
  same way; and **1e9, which gave a cut size of 4,959,508 um, a five-metre
  droplet**, with no refusal. All three are refused, and a factor outside the
  customary 1.3 to 1.8 warns
- **TDS clamped silently at both ends**: 300,000, 400,000 and 1,000,000 ppm all
  returned 0.8380 cp and 1198.06 kg/m3 identical to twelve digits, and a
  negative TDS was read as fresh water. Refused now, with the band and the
  value named
- **`waterDensityKgM3` and `oilDensityKgM3` had no guard of any kind** while
  their neighbour refused: 861.16 kg/m3 at 201 C, **Infinity at API -131.5**
  and **-2013.88 kg/m3 at API -200**, a negative density the Suite then printed
  a 3027 kg/m3 density difference from. Both carry the module's error contract
  now. **This is a breaking change for callers**: they return `{ rhoKgM3 }`,
  and `src/contexts/ProducedWaterContext.jsx` is updated in the same wave
- **a spec of 0, negative or NaN** made the verdict vanish to a dash that the
  studio painted RED. The verdict is withheld with a stated reason now, and the
  studio prints the reason
- **sigma accepted anywhere**: 0.1 gave 57.28 ppm out and 6 gave 227.11 on the
  same device. Refused above 2, warned outside the customary 0.5 to 1.0
- **`nBins` and `spanSigma` moved the answer invisibly.** Both are reported
  back, both are validated, and `truncatedTailFraction` is reported so the
  volume the normalisation absorbs is visible. The gate checks it against
  `2 Phi(-spanSigma)` analytically, which is what makes the bin span visible to
  the gate at all: it used to move from 4 to 3 with the suite fully green
- **`treatmentTrain` threw `TypeError: devices is not iterable`** for a
  non-array. Refused by name, and the Suite wraps all four derived blocks
- **the hydrocyclone's `gField > 0` refusal was unreachable** behind guards
  that already forced a positive flow, and the only way to trip it,
  `gFieldAtDesign: 0`, made it report "no flow through the liners" at full
  flow. It is reachable, it names the field, and a test asserts the message
  does NOT mention flow
- **`gradeEfficiency` returned 0 for invalid input**, so the absence of a
  device was indistinguishable from a device that caught nothing. It returns
  NaN, and `applyDevice` refuses a non-positive cut by name
- **a device with a one-metre cut size was accepted in silence.** The train now
  warns when a device cuts coarser than the largest droplet in the water
  reaching it, which is derived from the distribution rather than from a
  constant

## 7. Stokes, and the Reynolds number nothing checked

Stokes was applied everywhere with no Reynolds check. **The golden's own API
separator rows sat at Re 1.85 and 1.37 and its 100 um Stokes row at Re 1.08**,
all outside creeping flow, and the engine returned "cut sizes" of 188.1 and
271.5 um for those basins and said nothing.

`stokesRiseMS` reports `reynolds` and warns above the stated limit of 1; every
device reports `cutReynolds` for its own cut droplet and warns the same way;
and the golden now carries rows on BOTH sides of the band, with the warning
itself as the golden value. The out-of-band rows are kept on purpose, because a
gate that only ever sees cases inside a band cannot tell that the band is being
policed.

**And the gap between Stokes and the real drag balance is now asserted to be
REAL.** At Re 8.5e-6 the two agree to 4.9e-5; at Re 1.08 they differ by 14.4
percent and at Re 4.35 by 33.7 percent. A test requires the in-band rows to
agree within one percent and the out-of-band rows to differ by more than ten,
so if anyone ever tidies one route onto the other the gap collapses to machine
epsilon and the gate fails. **Identical to twelve decimals is the weaker
result**, because it is what two copies of one calculation produce.

## 8. The oracle: what is validated, what is pinned, and what is neither

Before FC7-0 the oracle had **no route at all** for `plateInterceptor`,
`hydrocyclone`, `flotation`, `treatmentTrain`, `medianOfBins` or
`oilDensityKgM3`, and five of its six golden groups were transcriptions of the
engine, proved by planting the same defect in both files and regenerating.

Every route now says in its own docstring what it checks and what it cannot.
The three routes that were already genuinely independent are kept untouched in
substance: the binned quadrature against a Monte Carlo of the same truncated
log-normal, the A&S series against the C library's `erf`, and the bed marched
layer by layer against the closed exponential.

**The new independent routes:**

| route | how it is independent |
| --- | --- |
| creeping-flow rise | the FORCE BALANCE solved numerically, with `Cd = 24/Re` and the two force expressions typed and **the 18 never typed at all**. Bending the engine's 18 to 20 is caught even when the same bend is attempted in the oracle, because there is no locus for it here |
| terminal rise | bisection on the Schiller-Naumann force residual, against the engine's damped iteration |
| basin and plate cut | a droplet's TRAJECTORY marched through the geometry and bisected on the size that just clears, with the rise velocity from the force balance. The Hazen `overflow * F` result is a consequence. The plate route marches two different channel heights and asserts the answer does not depend on which, which is reported in the golden as `channelHeightIndependence` (2.2e-14) |
| hydrocyclone cut | the radial migration marched, with the field re-derived through the TANGENTIAL VELOCITY rather than the flow ratio, plus a Monte Carlo over starting radii uniform by area that puts the captured fraction at the reported cut at 0.500455 |
| flotation cut | the kinetics assembled from its PARTS in a different order (bubble number, swept area, rise velocity, interception, attachment), the attachment ODE marched by Euler, and the size bisected out of it |
| filter cut | the bed marched and the droplet whose marched removal is one half bisected out |
| the whole train | **PARTICLE TRACKING**: 400,000 droplets each carrying a surviving weight through every stage, with no binning anywhere, which validates the coupling, the outlet concentration, every stage and BOTH medians |

**The identities, which need no source at all:** half the volume removed at the
cut size; the volume median of a log-normal bin set equal to its own d50; the
truncated tail equal to `2 Phi(-spanSigma)`; and the flotation cell-count
invariance at equal total gas.

**The pins.** The Vogel triple, the salinity multiplier, the brine density
slope, the crude thermal expansion, the plate efficiency factor, the sharpness,
the liner geometry and field, the attachment efficiency and the filter's
reference triple have no publication in this repository. They are all in one
frozen `DECLARED_CONSTANTS`, the engine reads every one of them from there
rather than inlining it, the **oracle holds its own second copy**, and the jest
suite pins all of them against literals typed by hand in the test file with an
exact key-set match, so adding or removing one fails until the pin is updated.
**That is a pin and not a validation**, it says so in the code and in the test,
and it is the mechanism by which six of the eight engine-and-oracle-together
defects are now caught. What it buys is that moving one of those numbers is a
reviewed act instead of a silent one.

The one published check that existed, `toBeCloseTo(0.890, 2)` for water at
25 C, is kept and is still the only number in the property fits that comes from
outside this module.

**Golden inventory: 21 rows in 6 groups before, 65 rows in 13 groups after.**
New groups: `binGrid`, `oilDensity` (the function is CALLED now, not fed back
in as data), `rise`, `bubbleRise`, `plateInterceptor`, `hydrocyclone`,
`flotation` and `train`. Warnings are golden values for the first time:
`expectVelocityWarning`, `expectStarvedWarning`, `expectOverloadWarning`,
`expectResidenceWarning`, `expectHoldupWarning` and
`expectBreakthroughWarning`, each straddled by rows on both sides.
**At least one row per device states NONE of that device's defaults**, so a
default is never the only thing a case exercises, which is the FC4-0 lesson.

**Measured margins, so the next wave knows how much room it has.** The
comparison gap as a fraction of its tolerance: the removal rows 0.5 to 29
percent of 2e-3 absolute; the train's outlet 69 percent of 5e-3 and its medians
45 percent of 4e-3, which is Monte Carlo precision at 400,000 samples and is
not slack; the flotation cut 17 percent of 5e-5 and the filter cut 22 percent
of 1e-4, both Euler truncation; the basin, plate and cyclone cuts 1e-13 against
1e-9, because two exact routes to one answer should agree to rounding; and the
cdf rows against an ABSOLUTE 1.5e-7, which is the A&S series' own published
accuracy rather than a relative tolerance that was checking the wrong thing on
a tail probability of 2e-6.

**Every gate refuses rather than passing when it cannot do its job.** The
`gate()` helper throws if a golden group is missing or has shrunk below the
count the gate needs, and names every case it failed on with both values and
the gap. **Every family carries a NEGATIVE CONTROL that is asserted to fire**
and to name a case: on the constants pin, the property fits, the bin span, the
removal integral, the rise velocity, the basin cut, the cyclone field exponent,
the flotation attachment term, the filter cut and the train outlet, plus the
Stokes gap held between bounds. One of them records a real fact about its own
subject: the cyclone control fails on four of five rows and not five, because
turndown exactly 1.000 is the one case a wrong field exponent cannot move.

## 9. Movement

The property fits did not move at all: the viscosity, the brine density and the
oil density are bit-identical before and after. Neither did the API basin or
the plate pack, whose physics was already right.

| quantity | before | after | ratio | cause |
| --- | --- | --- | --- | --- |
| CPI cut, 2 m2 x 40 plates | 102.6716 um | 102.6716 um | 1 | unchanged |
| API basin cut, 12 x 2 x 1.2 m | 192.0809 um | 192.0809 um | 1 | unchanged |
| hydrocyclone, 20 liners | 2.2844 um at 58,786 g | **REFUSED** | -- | 7.667 times design flow |
| hydrocyclone, 160 liners | 6.4614 um at 919 g | 4.6493 um at 919 g | 0.7196 | the `/ 100` axial fudge replaced by stated geometry |
| flotation, 4 x 8 m3, 0.3 / 300 um | 67.9109 um | 15.2003 um | 0.2238 | a model that bites |
| flotation, 4 x 8 m3, 0.03 / 80 um | 67.9109 um | 6.6192 um | 0.0975 | DAF stops being IGF |
| filter cut, 6 m2 x 0.9 m | 11.7478 um | 14.3807 um | 1.2241 | the cut inverted from the depth filtration |
| filter removal at 20 um, 6 m2 | 73.83 % | 73.83 % | 1 | unchanged: it was the half being kept |
| inlet bin median, d50 30 um | 28.6322 um | 30.000000 um | 1.0478 | interpolation |

**The shipped Suite case**, 50,000 bwpd of 500 ppm at 120 F and 35,000 ppm TDS,
32 API, inlet d50 30 um at sigma 0.7, CPI then hydrocyclone then walnut shell:

| | before | after |
| --- | --- | --- |
| liners / filter bed area | 20 / 6 m2 | **160 / 16 m2** |
| liner turndown, field | 7.667 x, 58,786 g | 0.958 x, 919 g |
| filter loading | 55.2 m/hr, over its own 25 m/hr warning | 20.7 m/hr, inside it |
| outlet | 1.2188 ppm | 6.5387 ppm |
| overall removal | 99.756 % | 98.692 % |
| droplet median | 30 typed to 5.858 measured | 30.000 to 7.323, both measured |
| verdict | MEETS, margin 27.78 ppm | MEETS, margin 22.46 ppm |

The new answer is 5.4 times worse and it is the one the equipment supports.
**Run the new engine on the OLD shipped defaults and it gives no verdict at
all**, because the hydrocyclone refuses and the train will not rule on a train
that did not run.

## 10. HELD FOR LITERATURE

Stated as limits in the engine, surfaced in the studio, and **never graded**.
No citation was invented and no regulator's number was guessed.

- **The discharge limit.** The studio's spec box defaulted to 29 with a hint
  reading "29 ppm monthly average is the common offshore limit", and no source
  for it exists anywhere in the repo. The engine states no limit of its own
  (a test asserts `DECLARED_CONSTANTS` carries no spec-like key at all) and the
  hint now says the figure is the user's own permit or regulation.
- **The oil-in-water basis.** The number is customarily written in mg/l, which
  at the app's own brine density is 28.63 ppm by mass against 29 mg/l, a 1.3
  percent difference sitting under a pass-or-fail verdict. This one has a clean
  answer and it is now stated rather than hedged: the removal is a fraction of
  the OIL, so it is dimensionless, and the outlet comes back on whatever basis
  the inlet was given on. `CONCENTRATION_BASIS` says so and the train returns
  it. Converting a limit written in mg/l is the caller's step.
- **API 421's horizontal velocity limit.** The engine warned above a bare
  0.015 m/s. The standard's limit is customarily the LESSER of a fixed velocity
  and a multiple of the design droplet's rise velocity, and the second half is
  absent. `API_421.velocityRuleComplete` is `false` on every return that
  carries the check, with a note saying which half is missing and why, and a
  test asserts no return ever claims the whole rule.
- **The dissolved and soluble oil floor.** No device here removes dissolved
  oil, and the train would report 0.47 ppm or 2e-5 ppm and a MEETS. The
  existence of the floor is stated on every train return
  (`DISSOLVED_OIL_NOTE`, printed in the studio) and `dissolvedOilFloorPpm` is
  an OPTIONAL caller input that is applied as a floor when supplied, with
  `dispersedOutletOiwPpm` reported beside it. **No value is invented.**
- **The device shape and scale constants.** Sharpness 3, the plate pack's 0.7,
  the liner's 1000 g, 0.0006 m3/s, 0.7 m and half-radius core, flotation's
  attachment efficiency and interception coefficient, the filter's 3.5 and its
  reference triple, and the customary bands. All declared, all pinned, none
  validated, and the code and the test both say so.
- **The de-oiler cut itself.** The ideal capture this model computes is finer
  than field de-oilers are customarily credited with. Recorded in section 1 and
  stated in `cutBasis`.

## 11. What is NOT repaired, and why

- **`mediaMicron`'s exponent.** The interception law gives lambda as the inverse
  CUBE of the grain size, which is a strong dependence, and this repository
  carries no bed data to check it against. The input bites and the derivation is
  written down; the exponent is HELD.
- **The CPI's own default in the Suite** (2 m2 over 40 plates) leaves the
  primary stage removing 9 percent at 50,000 bwpd. That is a real statement
  about a rougher rather than a defect, the number did not move in this wave,
  and it was left alone.
- **`logNormalCdf`, `gradeEfficiency` and `medianOfBins` keep a bare-number
  contract.** They are leaves with nowhere to put an error key; each is
  documented as a leaf and returns NaN rather than a number that could pass for
  an answer, and their in-module callers turn the NaN into a named refusal.
- **The NextGen course.** The teaching digest is built after this lands, from
  the repaired engine. **No number in this file, in the recon or in the engine
  source may reach a lesson, a panel or a bank question**, and the conditions
  the golden uses are listed below so the course wave can steer clear of them
  in both directions.

## 12. Conditions this gate occupies, for the course wave to avoid

CAPSTONE CONDITIONS ARE OFF LIMITS as engine test conditions, in both
directions: FC4's repair took a capstone's exact conditions for a golden row
and the golden handed back a graded answer. There is no FC7 capstone yet, so
this is recorded rather than checked, and the wave that writes one must check
its `fields.json` against this list.

- water: (25 C, 0), (50 C, 35000), (60 C, 150000), (90 C, 80000), (5 C, 0),
  (48.889 C, 35000), (100 C, 300000) ppm TDS
- oil: 32 API at 48.889 C, 25 at 25, 40 at 90, 15 at 60, 8 at 15.56, 55 at 20
- droplets: d50 30 at sigma 0.7, 15 at 0.9, 50 at 0.6, 12 at 0.9, 25 at 0.6;
  cuts 10, 12, 15, 20, 30, 60 um at sharpness 2, 3 and 4
- basins: 0.005 / 12 x 2 x 1.2, 0.004 / 8 x 1.5 x 1.0, 0.09 / 12 x 2 x 1.2,
  0.03 / 20 x 2.5 x 0.75 m3/s and m
- plate packs: 0.005 / 2 m2 x 40, 0.09 / 2 x 40, 0.02 / 1.5 x 60
- liners: 0.012 / 20, 0.09201 / 160, 0.004 / 20, 0.018 / 20, 0.03 / 40
- flotation: 0.09201 / 4 x 8 m3 at 0.2 and 300, the same at 0.03 and 80,
  0.05 / 4 x 8, 1.0 / 4 x 8, 0.05 / 1 x 20 at 0.5 and 600
- filters: 0.05 / 6 m2, 0.09201 / 16 x 0.9, 0.09 / 4 x 1.2,
  0.05 / 16 x 3.0 at 1200 um and 4.2, 0.09201 / 16 x 0.1
- trains: 500 ppm at d50 30 sigma 0.7 through cuts 100 / 4.6 / 11.2 and
  12 / 12 / 12, and 2000 ppm at d50 12 sigma 0.9 through 60 / 18

---

# FC7-1: the three defects the FC7 course foundation found in the REPAIRED engine

FC7-0 drove this battery from 22 of 35 green to 0 of 35. The course
foundation then exercised the repaired engine to build the digest its 78
lessons quote, and found three more. All three are the classes FC7-0
itself named, surviving in places FC7-0 did not look, which is why they
are recorded here rather than in a new file: **a wave that removes a
defect class is not finished until the class is gone from the module.**

| | plants | left the suite GREEN |
| --- | --- | --- |
| FC7-0's own 35, before FC7-0 | 35 | **22** |
| FC7-0's own 35, after FC7-0 | 35 | **0** |
| the same 35 plus FC7-1's 24 and one harness self-test, after FC7-1 | **60** | **0** |

The battery and its runner are checked in this time, at
`tools/validation/facilities/batteries/battery_producedwater_fc71.{py,json}`,
and it was run STRICTLY SERIALLY under an exclusive lock on the worktree. It
carries all 35 of FC7-0's plants, re-run against the repaired source, plus 24
of FC7-1's own and one harness self-test: **60 cases, 0 GREEN.**
**THREE** harness defects are closed in the runner, all of which pushed
the reading the same way by inflating the number of plants that appeared
to survive. Two were reported to this wave: `plant.sh` scored a plant
that BROKE PARSING as green, because no `Tests:` line read as no
failures, and two concurrent batteries on one worktree produced seven
bogus greens that were all red when re-run serially. The third was
published while this wave was open, in engines PR #205, which hardened
the shell runner and gated it against itself: a suite that FAILED TO LOAD
left the other suite's clean `Tests:` line, so a runner reading one
summary line and not the other could not tell a passing gate from half a
gate. This runner requires BOTH summary lines, no `Test suite failed to
run` anywhere in the output, the expected suite count, and a FLOOR on the
number of tests; it VERIFIES the restore before and after every plant;
and it takes an exclusive lock so a second copy refuses to start. A plant
it cannot read is HARNESS-BROKEN, is never scored in either direction,
and makes the run exit non-zero. **It carries H1, a deliberate
parse-breaking plant whose EXPECTED verdict is that refusal**, so the fix
is not a promise: a runner that scored H1 green would fail its own run.
It is a Python runner rather than a copy of `plant.sh` because this
battery is a sixty-case JSON table with per-case oracle regeneration, and
it is held to the same bar.

Golden inventory: **65 rows in 13 groups before, 77 rows in 14 groups
after.** The suite went from 68 tests to 78.

## 1. The media filter kept a silent clamp, and below it the bed area moved nothing

`Math.max(loadingMHr, 1)` sat inside the loading factor. Below 1 m/hr
the bed area moved the answer by EXACTLY NOTHING:

| flow m3/s | bed area m2 | loading m/hr | lambda per m | cut micron |
| --- | --- | --- | --- | --- |
| 0.001 | 20 | 0.18 | 11.067972 | 5.275789 |
| 0.001 | 200 | 0.018 | 11.067972 | 5.275789 |
| 0.001 | 600 | 0.006 | 11.067972 | 5.275789 |
| 0.001 | 2000 | 0.0018 | 11.067972 | 5.275789 |

To every digit, on a hundredfold range of bed area. At the module's own
default bed depth of 0.9 m the cut is 5.275789 micron; the foundation
measured 5.005053 micron because it took the same four conditions at a
1.0 m bed, and the flatness is the same either way. It is reachable by
typing a low rate into a polishing bed: 1 m/hr through the shipped
studio's own 16 m2 bed is a flow of about 2400 bwpd.

This is the class FC7-0 refused everywhere else - the TDS clamp became a
named refusal for exactly this reason - and the class FC7-0 repaired IN
THIS DEVICE when it made the bed depth bite. **The clamp was in the
oracle too**, at the same value, so the two files agreed about a bed
area that could not move the answer.

**DECISION: REFUSE below a declared floor, by name. The clamp is gone,
so wherever this module answers the bed area bites.** The alternative
was to extend the declared law downward, which is arithmetic rather than
a statement about a bed: the loading exponent is the ONLY velocity
dependence in this model - the interception derivation behind lambda
carries none at all, interception being a geometric mechanism - and it
is declared at ONE loading, 10 m/hr, with no published source here. A
decade under that rate the declared law is already claiming 3.162 times
the only coefficient there is any calibration for, and a tenth of a
percent of it would claim 100 times. **HELD FOR LITERATURE: what a bed
really does far below its design rate needs bed data this repository
does not carry, so a refusal is what this module can honestly say.** No
citation was invented and the exponent itself stays held, as in FC7-0.

`filterMinLoadingMHr` is declared, pinned, reported on every return as
`loadingFloorMHr`, and the refusal names the loading, the floor, the
loading the coefficient is declared at, and the bed that would run this
flow at the floor, the way the cyclone's overload refusal names the
liners the flow wants:

> a loading of 0.180 m/hr is below the 1 m/hr floor this module answers
> above: the filter coefficient is DECLARED at 10 m/hr, its loading
> exponent is the only velocity dependence in this model, and at the
> floor the declared law is already claiming 3.162 times the one
> coefficient there is any calibration for. 3.600 m2 of bed would run
> this flow at the floor. What a bed really does far below its design
> rate needs bed data this module does not carry

The floor's value is one decade below the declared reference loading.
**That is a stated choice and not a measurement, and that it coincides
with the number the old clamp used is a coincidence and not the reason**
- which has one useful consequence: the old clamp is now unreachable by
construction, because there is no band left in which a clamp at the
floor could flatten anything.

**The gate could not have seen it.** Every filter row FC7-0 carried sat
at 11.25 m/hr or above, so a clamp anywhere below 11 m/hr moved no
golden value at all. Three rows now sit BETWEEN the floor and the
reference loading, at 3.0, 1.8 and 1.08 m/hr, marched by the oracle's
own layer-by-layer bed and bisected, and a new `mediaFilterFloor` group
carries the four flat conditions above plus the floor straddled to three
parts in a thousand (3.61 m2 loads at 0.99723 m/hr and must refuse, 3.6
m2 loads at exactly 1.0 and must answer). That group is labelled a
POLICY gate in the test, because below the floor there is no physics for
an oracle to check - that is the point of the floor.

The band the model could not previously express also carries an
IDENTITY, which needs no source: the cut goes as one over the FOURTH
root of the loading rate, the declared exponent of 0.5 carried through
the ln 2 inversion's own square root. It is asserted across the band.

## 2. The one device threshold that was not declared

`residenceS < 60` was inlined in the flotation warning sentence: the
only device threshold in the module outside `DECLARED_CONSTANTS`,
against this module's own stated doctrine that every number which is a
choice rather than a derivation lives there. The grid's two floors,
`nBins < 10` and `spanSigma < 3`, were bare in the same way, and the
ORACLE was deciding three golden warnings on bare numbers typed at the
comparison itself.

**REPAIRED.** `flotationResidenceWarnS`, `minNBins` and `minSpanSigma`
are declared, pinned and read. The oracle's second copy gains
`flotationResidenceWarnS`, `filterMinLoadingMHr`, `starvedTurndown`,
`gasHoldupWarn` and `filterBreakthroughLoadingMHr`, so every threshold
it decides a golden warning or a golden refusal on comes out of its own
declared copy. **It is a choice and it says so**: a minute of contact is
a round figure and no flotation residence data in this repository sets
it. The warning quotes the threshold it judged against and the return
carries `residenceWarnS`, so a reader is never told about a band they
cannot see.

**The gate could not have seen it either, and the battery proved it on
the repair itself.** The first FC7-1 run left ONE plant green: the grid's
`nBins` floor re-inlined at 25, which nothing exercised, because the only
grid cases in the suite were 4 or 5 bins (refused) and 30 or more
(accepted). A straddle built from the declared value closed it and the
battery went to zero. **That is what a battery is for: it caught a hole
in FC7-1's own repair before FC7-1 was committed.**

The nearest flotation rows
either side of 60 s were 32 s and 347.8 s, so the threshold could be
moved anywhere in a ten-fold range with every golden value identical.
Two rows now straddle it to within a second, 59.0 s and 61.0 s, on a
lean enough gas rate that the residence warning is the only one in play;
a test builds both cases FROM the declared value, so an engine that
inlines any other number fails whatever the pin says; and a source scan
over the engine with the comments stripped asserts none of the four
inlined forms can come back beside the declared one. The comments quote
all four on purpose: that is where the record of the defect lives.

## 3. The quantised median had a silent way back

`medianOfBins` interpolated when a bin carried edges and **fell back to
the bare `b.dMicron` midpoint when it did not**, which is a silent path
back to the quantised median FC7-0 had just removed. The same 60-bin
untreated inlet answers **30.000000 micron with edges and 28.632164
micron without**, and nothing on the return said which route had run.

**REPAIRED, by closing the path.** The bins are checked UP FRONT and
the function returns NaN if any bin lacks usable edges, so the answer
cannot depend on where in a bad grid the median happened to land. It is
a LEAF with nowhere to put an error key, so NaN is the refusal, as
FC7-0's leaf contract states; no in-module caller can reach it, because
every bin set here comes from `dropletBins`, which always carries edges,
and `applyDevice` spreads them through. It is the EXTERNAL caller's
path, and a caller who hands over midpoints alone now gets NaN rather
than a number 4.6 percent light that could pass for an answer.

**And the gate now discriminates the two routes rather than just liking
both.** A gate that only compares the median to its own d50 passes
either way: at 60 bins the identity holds to 3e-9 interpolated and
misses by 4.56 percent quantised, and "close to 30" covers both. The
oracle carries `midpointMedianMicron` for every `binGrid` row, built
from its own erf cdf - **the wrong answer, computed on purpose** - and
the gate refuses any row where the two routes are within one percent of
each other, so it can never claim a discrimination it is not making. The
measured gaps are 1.73, 4.56, 5.67, 6.18 and 8.91 percent.

## 4. The negative controls, and what each one printed

Every repair carries one, and every one was PROVED to fire and to name
its case:

- **the clamp comes back.** A clamp at the floor's own value fires on
  nothing, because the floor made it unreachable, so the control bends
  it ABOVE the floor and then must fire on exactly the three rows FC7-1
  added and none of the five FC7-0 carried. It printed
  `mediaFilter: 3 of 8 cases failed` and named
  `mediaFilter[5] the cut of a 0.9 m bed at 3.00 m/hr`. **A control that
  fired on all eight would have been telling us the new rows were not
  the ones doing the work.**
- **the floor is deleted.** `mediaFilterFloor: 5 of 7 cases failed`,
  naming `mediaFilterFloor[0] at 0.180 m/hr the module answered 5.275789
  micron and the golden expects a refusal`.
- **the threshold is read as anything else.** The straddle rebuilt at
  twice the declared value printed `at 119.9 s, just under a threshold
  of 120 s, the residence warning was false`.
- **the midpoint fallback comes back.** `binGrid: 5 of 5 cases failed`,
  naming `binGrid[0] the bin median at 60 bins: engine 28.632164392
  against oracle 30, rel gap 4.55e-2 over 0.000001`.

## 5. Movement, and what a live user sees

**NO ANSWER THIS MODULE GIVES CHANGES VALUE.** Every loading rate at or
above 1 m/hr returns the same filter coefficient, the same cut and the
same removal it did after FC7-0, bit for bit; the flotation cut, rise,
holdup and residence are untouched, because the threshold moved is a
warning; and every median off a bin set this module builds is unchanged,
because those bins have always carried edges.

What changes is the SHAPE of three answers, not their value:

| | after FC7-0 | after FC7-1 |
| --- | --- | --- |
| a bed below 1 m/hr | a cut of 5.275789 um, flat over any area, and a verdict | REFUSED by name, the stage is skipped and the train withholds the verdict |
| a flotation cell under the threshold | "less than a minute of flotation residence (53.3 s)" | "53.3 s of flotation residence is under the 60 s this module warns below" |
| `medianOfBins` on midpoints alone | 28.632164 um, 4.6 percent light | NaN |

**What a live user sees.** The shipped Produced Water Treatment Studio
runs its bed at 20.7 m/hr, twenty times the floor, so the studio's own
default case is unchanged in every digit. The reachable change is a
FLOW below about 2400 bwpd through the studio's 16 m2 bed: that used to
print a flat 5.28 um cut and a confident train verdict, and now paints
the bed row with the refusal and withholds the verdict with its reason,
through the FC7-0 machinery the studio already has. **No app code change
is needed**: `PwtPanels.jsx` already renders `d.error` per stage and
`verdictWithheldReason` above the train. What the app needs is the
VENDORED copy, and that is a separate reviewed pass with its own pin, in
engines-merge order: `packages/engines` is pinned at the FC9-0 commit,
FC8-0's pass is the next one in line, and FC7-1 belongs to the one after.
Until it is vendored the live studio keeps the clamp.

## 5b. What the course wave must rebuild, measured rather than guessed

The FC7 teaching digest is built from this engine and this golden, so it
was rebuilt against FC7-1 into a scratch copy and diffed. **No teaching
VALUE moves.** `gate_claims.mjs` was run against the repaired engine:
**22 of 22 relational claims hold and all 5 of its negative controls
fire.** What the rebuild changes is counts and three table rows:

- `fc7_dump.mjs` REFUSES to run until its `GROUP_NOTE` table describes
  the new `mediaFilterFloor` group, which is the generator's own gate
  working: a golden group nobody has described is a group the digest
  would have printed without saying what it pins.
- `DECLARED_CONSTANTS` goes from 51 keys to 55, so the two sentences
  counting them move, and the four new keys may want rows in the
  generator's curated `DECLARED_ROWS`.
- the golden row and group counts move from 65 in 13 to 77 in 14, in
  Sections 13, 18 and 19; the `mediaFilter` group goes 5 to 8 and
  `flotation` 5 to 7; `expectResidenceWarning` goes from 5 rows with 1
  true to 7 with 2, and `expectBreakthroughWarning` from 5 rows to 8.
- the published-bed table gains three rows: 1.2 m2, 2 m2 and 4 m2, at
  3.00, 1.80 and 1.08 m/hr.
- the hardcoded battery sentence in `fc7_dump.mjs` ("Thirty five
  defects... 22 of those 35... 20 tests to 68") is now wrong twice over
  and needs the FC7-1 numbers.
- `fc7_dump.mjs` also carries its own inlined `r.residenceS < 60` for
  the flotation warning, which should read the declared constant.

**All eighteen graded capstone fields are identical to the last bit**,
re-derived by running `fc7_capstone.mjs` against this engine before and
after: `precision.json` is byte-identical too, and all 18 still classify
with 0 weak routes. Both graded beds load at 21.35 and 20.82 m/hr, more
than twenty times the floor, and the graded flotation cells sit at
730.8 s of residence against a 60 s warning that is only ever a warning.
The foundation should re-derive `fields.json` anyway, because a graded
value proved unchanged is worth more than a graded value assumed
unchanged, and it must rebuild the digest and re-pin before any lesson
is written.

## 6. What is NOT repaired here, and why

- **The media filter's grain exponent**, `attachmentEfficiency`, the
  dissolved oil floor's value, API 421's missing velocity half and the
  29 ppm discharge figure are all still HELD, exactly as FC7-0 left
  them. Nothing here invented a citation and the engine still states no
  discharge limit at all: the test that asserts `DECLARED_CONSTANTS`
  carries no spec-like key is untouched and still passes.
- **The band between the floor and the declared reference loading.**
  Between 1 and 10 m/hr the module claims up to 3.162 times the only
  coefficient it has a calibration for, and it does not warn there. The
  extrapolation is stated in the refusal wording and in the constant's
  own note, `loadingFloorMHr` is on every return, and the band is where
  the model's cases sit; adding a warning there would put one on a
  6.21 m/hr row the studio can reach today, which is a decision about
  live copy rather than about arithmetic. RECORDED, not repaired.
- **The `f > 0` line in `medianOfBins`** is an arithmetic guard on the
  interpolation's own divisor and is unreachable: the loop only reaches
  a bin while the accumulator is under one half. It is a guard and not a
  refusal, and it is one line rather than a branch that pretends to a
  case that cannot happen.
- **The wave directory's own copies.** `fc7_dump.mjs` in the course wave
  carries its own inlined 60 for the same warning. That file is the
  foundation's, not this repository's, and it is reported rather than
  edited from here.
