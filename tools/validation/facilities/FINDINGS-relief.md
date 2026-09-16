# FINDINGS: relief and flare (FC5-0, 2026-09-16)

The repair wave before the NextGen Relief & Flare Systems course, taken against
`engines/facilities/relief.js` at engines main `82ec6d4`, over its golden, its
oracle, its jest suite and the LIVE Suite studio that calls all of it
(`/dashboard/apps/facilities/relief-blowdown-sizer`). The full defect list with
the inputs that expose each one is the course wave's recon
(`/root/fc-wip-relief/FINDINGS.md`, 43 findings); this file records what
changed here and why.

Forty-three findings. **Twenty-six were reachable by typing into a box in the
shipped studio and producing a wrong or non-finite number on a screen.** Twelve
engine inputs failed OPEN (a wrong number with no warning), six failed SILENT
(a NaN or an Infinity with no `error` key, so every caller's `if (r.error)`
guard passed), two failed CLOSED, and one of those two was an UNBOUNDED LOOP.
Ten were in the Suite composition layer and are routed to that repository's own
pull request.

**The gate could not catch seven of them.** Twenty defects planted one at a time
in the engine left the shipped suite 15 of 15 GREEN in seven cases, including an
inverted division inside the knockout drum's own length equation. Five of the
oracle's routes were TRANSCRIPTIONS of the engine, proved by planting the same
defect in both files and regenerating the golden. Thirty defects are planted in
the controls now and **twenty-eight of thirty are caught**; the two that are not
are the two expressions this package shares with its oracle on purpose, and
they are named below.

## The three that printed a confident wrong number on a live screen

### 1. A depressuring time of ZERO, reported as a pass

`blowdown` marched with a fixed step. When the first step would have removed
more mass than the vessel held, it hit `if (dm >= mass) break;` with `time`
still 0, the `time >= maxS` refusal was false, and it returned

    { timeS: 0, stations: [start, start], finalTR: t0R }

with **no `error` key and the vessel still at its start pressure**. The panel
printed `0.0 min` in emerald under the hint "inside the customary 15 minutes",
the summary rail printed `Blowdown 0.0 min`, and the shipped suite's
monotonic-pressure assertion passed on `[start, start]`. The smallest orifice
that does it at the default step: **4 in at 5 ft3, 5.5 in at 10 ft3, 12.5 in at
50 ft3, 17 in at 100 ft3, and 38 in at the app's own 500 ft3 default.**

This is the wave's worst finding not because the number is wrong but because
**the output read as reassurance**: a depressuring study is run to answer
"inside fifteen minutes?", and the failure mode answered yes.

The step is now SUBDIVIDED so that no step removes more than 5 percent of the
inventory, and the march is midpoint rather than Euler. The two cases above now
return 0.168 s and 0.186 s, with the end pressure actually reached. Both are
golden rows.

### 2. The knockout drum's holdup box could not move the answer beside it

`areaVapor = areaTotal * (1 - f)` and `fallFt = diameterFt * (1 - f)`, so

    L = (Q / (A (1-f))) (D (1-f) / Ud)

and the factor cancelled exactly. Measured on the app's own drum over holdup 0
to 0.99: the required length was **10.557084391 ft at every value, total spread
8.9e-16 ft**, and the L/D printed beside it never moved, while the vapour
velocity on the same row moved from 3.955 to 39.550 ft/s. The input was also
ambiguous: `liquidFraction` was used once as an AREA fraction and once as a
DEPTH fraction, and the two cancelled.

**The convention is now decided and stated: `liquidFraction` is the LIQUID
LEVEL as a fraction of the diameter, which is what a level instrument reads.**
The vapour cross-section is the exact circular segment above it, and the fall
distance is the vapour depth D(1 - f). The engine now returns `liquidDepthFt`,
`liquidAreaFraction`, `areaVaporFt2` and `fallFt` so the convention is visible
rather than inferred.

The old answer was **5 percent high at a tenth full, 28 percent low at
three-quarters full, and exactly right at half full**, which is the one case
anyone would check it on. On the app's own drum the sweep is now 10.495, 9.964,
9.784, 10.495, 13.420, 20.165 ft at holdups 0, 0.1, 0.25, 0.5, 0.75, 0.9,
against a flat 10.557 before.

### 3. A hidden 0.975 on the caller's discharge coefficient

`aFt2 = cd (pi/4)(d/12)^2` already carried `cd`, and the mass flow was then
`c * 0.975 * p * ...`. Recovered by asking the engine for its own first-step
mass loss: **44493.543481 lb/hr against 45636.041333 for the closed form at the
stated cd, a ratio of 0.97496501**. The studio's box says "Discharge
coefficient", the user types 0.85, and the march ran 0.829. The 0.975 is a
relief valve's certified Kd and has no business inside a blowdown orifice. On
the app's own defaults the time was **275.0 s against 268.1 s, 2.6 percent
long**, and the fifteen-minute verdict is read off that number.

## The gate that could not fail

Baseline before this wave: **15 tests, 15 passing.** Twenty defects planted in
the engine alone; thirteen went red and **seven left the suite 15 of 15 green**:

| planted in the engine alone | before FC5-0 | now |
| --- | --- | --- |
| `liquidKv` 342.75 -> 340 | GREEN | red: the liquid golden |
| `steamKn` 0.1906 -> 0.19 | GREEN | red: the steam golden |
| `blowdown` drops the hidden 0.975 | GREEN | red: the blowdown golden |
| drum fall distance loses `(1 - f)` | GREEN | red: the drum golden AND the holdup-moves-the-answer test |
| drum length `v * fall / ud` -> `v * fall * ud` | GREEN | red: both, as above |
| vertical wetted area halved | GREEN | red: the wetted golden |
| blowdown temperature exponent `k-1` -> `k` | GREEN | red: the blowdown golden |

Two of the seven were a published case that could not discriminate rather than
a missing case, and the fix was cases, not tolerances:

- **`liquidKv`'s 342.75** is worth about 2e-5 at the Reynolds numbers the three
  golden liquid rows sat at, and only bites below about Re 900, where no row
  was. The golden now carries a row at **Re 92** (200 gpm of a 5000 cP crude),
  where that term is 23 percent of the Kv denominator and a move to 340 is
  1.9e-3 against a 3e-4 tolerance. A test asserts that row keeps existing, so
  nobody can tidy it away without the tidy failing.
- **`steamKn`'s 0.1906** had ONE golden row with Napier active, at 2014.7 psia,
  where a 0.3 percent change in the constant lands at 1.8e-3 against a 2e-3
  tolerance. The golden now carries **3100 psia**, near the top of the published
  range, where the same change is 4.6e-3 against a 5e-4 tolerance, and a row at
  **1550 psia**, inside the band where the correction makes the valve BIGGER.

## Five oracle routes were transcriptions, and are not any more

A route whose oracle is an independent derivation goes red when the engine
moves, because two derivations disagree. A route whose oracle is a
transcription cannot, because there is only one derivation. Planting the same
defect in both files and regenerating the golden proved five:

| route | the transcription | the independent derivation now |
| --- | --- | --- |
| point-source radiation | `4 pi R^2` typed in both; 4 pi -> 4.4 pi in the engine's TWO directions and the oracle left the suite 15 of 15 GREEN | the sphere's area by QUADRATURE of `R^2 sin(theta)` over the solid angle, and the setback by BISECTION on that same quadrature, so the inverse is checked against the model rather than against itself |
| droplet settling | the same fixed-point iteration, the same `1.15`, the same drag law | BISECTION on the force residual (form drag against buoyant weight) in SI, which DERIVES the 4/3 the code had rounded to 1.15 |
| the drum | no route at all | SIMPSON quadrature of the segment area integral, and the length as a transit time against a fall time, in SI |
| liquid Reynolds | `2800` typed in both | `rho u D / mu` in SI with `D = sqrt(4A/pi)`, which derives 2800 to 1.1e-4 |
| horizontal wetted area | the engine's own `r theta L` wrapped in a ft-m-ft round trip that is algebraically a no-op | POLYLINE SUMMATION round the real circle with Richardson extrapolation, and the VERTICAL branch too |
| subcritical gas | the F2 closed form typed in both | the subcritical nozzle flux integrated from the isentropic expansion, so F2 is checked rather than restated |
| the critical ratio | not checked at all | the ARGMAX of the nozzle flux over the throat ratio, by golden-section search |
| the blowdown march | no route at all | **the march is separable and is solved IN CLOSED FORM in SI**: `dm/dt = -B m^((k+1)/2)`, so the time, the `(k-1)` isentropic exponent and the absence of any hidden coefficient are all checked at once |

Three whole exports had no golden row and no oracle route before this wave
(`blowdown`, `koDrumHorizontal`, and the VERTICAL branch of `wettedAreaFt2`),
and `fireReliefLoad` and `distanceForIntensity` were checked only against the
engine itself, the second by round-tripping the model against its own inverse,
which is an identity. All five have real routes now.

## What the oracle still does NOT cover, and what was done about it

Listing this is the point. Anything here is UNVALIDATED and must never be
graded in a course.

| not covered | why | what was done |
| --- | --- | --- |
| the Kv fit's `0.9935, 2.878, 342.75` | an empirical fit; no route in this package can derive it. Planted in BOTH files it is still GREEN | SHARED on purpose and said so in both headers; the golden's Re 92 row discriminates ENGINE-side drift |
| the sphere-drag correlation `24/Re + 3/sqrt(Re) + 0.34` and the `240` low-Re cap | the same | the same: shared, stated, and planted in both it is GREEN |
| the API 526 orifice table | a published table | checked as BEHAVIOUR in the suite (ladder, boundaries, the over-T refusal), never derived |
| `Kb`, `Kw`, `KSH` | published CHARTS and TABLES | typed inputs by design, with their references named and their literature gates ARMED |
| the `RADIATION_LEVELS` labels | customary values, unsourced wording | HELD FOR LITERATURE; harmonised with `spacing.js` and gated for equality; never graded |
| `21000`, `34500`, `0.82` | the SI/USC pair meeting checks the unit packaging, not the pool-fire physics | stated here; the pairing is what the golden proves |
| the `1500` psia Napier threshold and the `3200` psia limit | published boundaries | pinned as behaviour, with the 1580.31 psia crossing now derived and exported |
| `z` held constant through a blowdown, and choked flow throughout | model decisions | stated in the docstring; the engine now WARNS with the pressure below which the choked assumption stops holding |
| the 25 ft wetted-height limit | the truncation depends on plot elevation | still the caller's job, still surfaced as a note |
| whether API 521 prints `1.15` or the exact `4/3` | no copy of the standard here | the engine evaluates the BALANCE, which is the derivation both forms come from, and says so; the 0.41 percent is recorded, not attributed |

## The fails-open and fails-silent sweep

Every function in this module now returns either a finite result or an object
carrying `error`. A parametrised test walks eighteen wrecked calls and asserts
both halves of that contract: an `error` key, and no non-finite number anywhere
in the returned object.

| was | is |
| --- | --- |
| `Kd`, `Kb`, `Kc`, `Kw`, `KSH` unvalidated: `Kd = -0.5` gave an area of **-4.784993 in2**, `Kd = 2` gave 1.196248 in2 and selected orifice J although no certified valve has a coefficient above 1 | one rule everywhere: a certified coefficient is a fraction of an ideal, `0 < K <= 1`, refused BY NAME |
| `kd`, `kb`, `kc` of 0 or null returned `areaIn2: Infinity` with no error, in all three of gas, liquid and steam; the studio printed "Required area --" beside "Selection Infinity x T" | the same rule, refused before the division |
| `envFactor: 0` returned a fire duty of ZERO and `-1` a negative one | `0 < F <= 1` |
| `adequateDrainage: 'false'` is truthy, and bought the 1.6429 drainage credit | a real boolean is required |
| `fractionRadiated: 1.5` let a flare radiate more than it releases, `transmissivity: 2` doubled the intensity | both are fractions, `0 < x <= 1`, in BOTH directions of the model |
| `distanceForIntensity` validated two of its four inputs while its twin validated four: `fractionRadiated: 0` returned **a safe distance of 0 m**, `transmissivity: -1` returned NaN | the same four checks in both |
| `liquidArea` silently discarded a negative viscosity and returned an inviscid area | refused |
| `liquidKv` returned up to **1.0065**, so a viscosity correction UNDERSIZED the valve by 0.65 percent; the shipped suite PINNED that with `toBeCloseTo(1 / 0.9935, 3)` | clamped at 1.0, with `liquidKvUnclamped` kept so the asymptote stays inspectable and the test asserts WHY the clamp exists |
| `wettedAreaFt2` matched `orientation` with `===` against one lowercase string and fell through to HORIZONTAL: `'Vertical'` was **628.32 ft2 against 157.08, a factor of 4**, and orifice K against orifice H through the chain | matched case-insensitively and trimmed; an unrecognised orientation REFUSES |
| a missing level gave `areaFt2: NaN` in both orientations, and `fireHeatInput` then refused one step later naming a quantity the user never typed | the level is validated where it is typed |
| a NEGATIVE level returned **-94.25 ft2** in the vertical branch, three lines below the clamp the horizontal branch used | refused in both |
| `koDrumHorizontal` accepted `liquidFraction: null` because `null >= 0` is true, and refused -0.5 with "must be below 1" | `Number.isFinite` and a message that names the real range |
| `blowdown` with a negative `cd` returned `timeS: 967.6` and `finalTR: NaN` | refused |
| **`blowdown` with `dtS <= 0` never returned**: `time += dtS` never advanced, so the `time < maxS` exit could not fire. A live call was left spinning past 150 s of CPU before it was killed by PID | refused, and a step budget behind that |
| `selectOrifice(Infinity)` returned `multipleOfT: Infinity` beside its error | refused |
| `selectOrifice(26.0001)` printed "required area 26.00 in2 exceeds a T orifice (26 in2)", which reads as a contradiction because `toFixed(2)` rounded away the evidence | prints the figure that made the statement true |
| two fixed-point iterations returned no convergence flag, and the settling loop broke having stored the NEW drag coefficient beside a velocity computed from the OLD one | both return `converged`, `iterations` and `residual`; the settling velocity is recomputed from the coefficient that is returned |
| `steamKn` steps at 1500 psia and the correction makes the valve BIGGER up to 1580.31 psia, with nothing saying so | `NAPIER_UNITY_PSIA` is derived and exported, and `steamArea` warns inside the band |
| two engines in one package exported `RADIATION_LEVELS` with the same four values and FOUR DIFFERENT labels, one set of which a merged NextGen course already teaches | `relief.js` adopts the `spacing.js` wording, and a test asserts the two tables stay equal |

## Movement: what changes on a live screen

Measured by running both engines, not read off the diff.

| screen | before | after | ratio |
| --- | --- | --- | --- |
| Blowdown, app defaults: time to end pressure | 275.0 s | 268.15 s | 0.975082 (the hidden Kd) |
| Blowdown, final temperature | 338.372 R | 338.412 R | 1.000119 (the exact landing) |
| Blowdown, 500 ft3 with a 38 in orifice | **0.0 min, "inside the customary 15"** | 0.186 s | -- |
| KO drum, app defaults: dropout velocity | 2.99703 ft/s | 3.01481 ft/s | 1.005930 (4/3 against 1.15, and the exact micron and centipoise) |
| KO drum, required length (engine alone) | 10.5571 ft | 9.7839 ft | 0.926761 (the segment geometry at 25 percent holdup) |
| KO drum, L/D | 1.3196 | 1.2276 | 0.930266 (with the Suite's standard-base repair as well) |
| KO drum, holdup 0 to 0.9 | flat 10.5571 ft | 10.495 to 20.165 ft | the box works |
| Liquid PSV at 1 cP: Kv | 1.003789 | 1.0 | 0.996225 |
| Liquid PSV at 1 cP: required area | 1.275441 in2 | 1.280274 in2 | 1.003789 (it was undersized) |
| Gas, steam and fire areas at the app's defaults | unchanged, bit for bit | | |

Nothing else moved. The gas, steam and fire chains are untouched arithmetic;
what changed there is which inputs are refused.

## The controls

`tools/validation/facilities/negcontrol_relief.sh` is the file that produced
every claim above about what the gate catches. It plants one defect, runs the
suite, records which test named it, and restores between rows.

- **23 of 23 ENGINE-only plants RED**, including all seven that used to leave
  the suite green, and including the removed guards (the coefficient ceiling,
  the time-step guard, the substep cap, the terminal landing).
- **5 of 5 ORACLE-only plants RED.** This is the control on the controls: the
  harness can tell the two files apart, so agreement is a result and not a
  tautology.
- **2 SHARED plants GREEN, and that is the finding**: the Kv fit's 342.75 and
  the drag correlation's 0.34, planted in both files at once, are not caught by
  anything. Neither can be derived here. Both are named in the oracle's header
  table, in the suite's header, and in the row above.

## What is NOT repaired, and why

- **The Kv fit and the drag correlation.** Held for literature, shared with the
  oracle on purpose, stated in three places.
- **`z` as a constant through the blowdown.** A real depressuring solves z along
  the path; this march does not, and the docstring says so. The oracle makes the
  same assumption deliberately, so the golden checks the march and not the
  thermodynamics.
- **Heads ignored in the wetted area.** Standard screening practice, and
  conservative for the shell term. Unchanged.
- **The 25 ft truncation.** Still the caller's job, because it depends on plot
  elevation.
- **The Suite composition layer**, ten findings including a `parseFloat` that
  launders inputs the engine deliberately refuses (a typed thousands separator
  costs a factor of 1000 and prints orifice D where the answer is L), a fire tab
  that drops the Kd, Kb and Kc the gas tab honours, a drum that uses 14.65 psia
  and 520 R while the package uses 14.696 and 519.67, and a help guide that
  asserts a number the user can change. Those are repaired in the Petrolord
  Suite repository's own pull request, against this engine.
