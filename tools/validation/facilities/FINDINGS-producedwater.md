# FINDINGS: produced water treatment (FC7-0, 2026-09-16)

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
