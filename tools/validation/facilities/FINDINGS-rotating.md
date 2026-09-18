# FINDINGS: rotating equipment (FC3-0, 2026-09-16)

The repair wave before the NextGen Rotating Equipment course, taken against
`engines/facilities/pumps.js` and `engines/facilities/compression.js` at main
`709172f`, over `engines/production/gasProperties.js`. The full defect list,
with the inputs that expose each one, is the course wave's `FINDINGS.md`
(`tools/course-waves/rotating/FINDINGS.md` in petrolord-nextgen); this file
records what changed here and why.

Forty-nine findings. **Eleven returned a confident wrong number** and
**eighteen inputs across twelve functions returned a NaN or an Infinity with
no `error` key**, so every caller's `if (result.error)` guard passed and the
non-finite value propagated. Nine of the eleven were reachable by typing into
a box in a shipped Suite studio. All of them are now named refusals or named
values; the three bare-number functions that have nowhere to put an error key
hold a **documented NaN contract** instead, and never return Infinity or a
plausible number.

## The two that were wrong on valid input

**A compressor train broke the discharge limit it was staged against.**
`stageCount` chose the count by testing every trial stage from `tSuctionF`,
while `compressorTrain` ran stage 1 from `tSuctionF` and every later stage
from `interstageCoolToF`. Whenever the intercooler approach sat above the
suction temperature, the later stages were hotter than the count had been
chosen for: on one duty the final stage ran **73.3 degF above the stated
limit**, on a return whose own `governedBy` read `discharge temperature`, with
no warning. The Compressor Station Designer's default state has the approach
above the suction (110 degF against 100 degF), so this was reachable from an
app opened and not touched. `stageCount` now takes the approach and tests each
trial count at the inlet that count's stages will really have.

**The hot-stage warning fired on a hardcoded 300 degF.** `maxDischargeF` was
never consulted, so a train staged against a stated 200 degF broke it by 38
degF in silence while a train run at 400 degF was warned at 310 for nothing.
The one field that could have caught the staging defect was measured against a
different threshold from the one the user set. 300 degF is still the default,
and the default remains a customary figure with no publication behind it here.

## One constant, one owner

**The gas constant.** `compression.js` declared `R_UNIVERSAL_FT_LBF = 1545.349`
privately while importing `suttonPseudoCriticals`, `dakZ` and `toRankine` from
`gasProperties.js`, which declares the same constant as `R_UNIVERSAL = 10.7316`
psia.ft3/(lbmol.degR), or 1545.3504 in these units. Two values of one constant,
one import apart, on the same gas: a ratio of **0.999999094056597**, and
nothing downstream could tell which of the two it was holding. The private copy
is gone, along with the private `MW_AIR` and the three inline `459.67`s.

Note for the record: the owner's 10.7316 is itself a rounding, 2.135e-6 above
the 2019 SI derivation, and the private 1545.349 was marginally closer to it.
**Consistency was chosen over proximity**, because the package's gas engines,
its separator sizing and its shipped courses all grade against the owner's
value, and a second opinion held privately by one module is the defect
whatever its sign. Moving `gasProperties.R_UNIVERSAL` onto the SI derivation is
a separate, package-wide decision that would move every gas course.

**The standard base.** `LBMOL_SCF = 379.49` belongs to the 14.696 psia,
519.67 degR base; `actualInletCfm` in the same file worked from 14.7 psia and
520 degR, **3.4 parts in ten thousand away**. The same MMscfd was one molar
quantity when it became a mass flow and a different one when it became an inlet
volume. The 60 degF base is now declared once and the molar volume derived from
it and from the package's gas constant, so 379.49 is no longer quoted: it was a
rounding of that derivation with no independent provenance.

**The two power packagings.** `0.7457` kW/hp against the derived
0.7456998715822702 (every `motorInputKw` 1.722e-7 high) and `2544.43` Btu/hp-hr
against the derived 2544.433577644024 (every `thermalEfficiencyPct` 1.406e-6
high). Both are roundings of quantities that are **exact by definition**, so
both are now derived in `lib/units/fieldUnits.js`, exactly as the barrel was in
FC2-0.

## Two halves of one module that disagreed

- `fitPumpCurve` warned that a rising point set is not a centrifugal head curve
  and `dutyPoint` returned a duty flow and head off it anyway. **The trusting
  half was the bug**: the fit now publishes `droops`, it travels through
  `combineParallel` and `combineSeries`, and `dutyPoint` refuses on it.
- `pumpPower` bounded the pump efficiency to (0, 1] and divided by an
  unbounded motor efficiency one line later. At 5 it reported a motor drawing a
  fifth of what its shaft delivers; at 0, Infinity with no error key.
- `separatorSizing.js` exports `DAK_TPR_MIN`, `DAK_TPR_MAX` and `DAK_PPR_MAX`
  and refuses outside them by name; `compression.js` called the same `dakZ` and
  never checked, returning `z = 0.2235` at Tpr 0.848 and `z = 2.865` at Ppr
  35.8 with no error and a full set of horsepowers. `dakZ` reports
  `converged: true` in both. The window is now **imported from the module that
  declares and documents it**, not restated.
- The `pumps.js` header stated the NPSH rule as "the larger of 3 ft and 1.35
  times NPSHr" where the code is `Math.max(3, 0.35 * npshrFt)`. **The code was
  right**; the header described a ratio rule as if it were a margin rule and
  would have had a reader demanding nearly four times the margin applied.

## One refusal sentence for four unrelated faults

`stageCount` returned "no practical stage count keeps the discharge temperature
under the limit: intercool harder, or check k and the suction temperature" for
a polytropic efficiency of 0, an efficiency of 1.5, a suction below absolute
zero and a limit below absolute zero. **Failing closed with the wrong reason is
worse than a bare refusal**: it sent a user who typed 1.5 off to intercool.
Each of those now has its own guard, naming the input and the value. The
sentence that remains fires only on the case it was written for, and it carries
its evidence: the coolest discharge twelve equal stages reach, the limit, and
the inlet it was measured from.

`compressionStage`'s "a stage needs a positive rate, suction pressure, gas
gravity, k above 1 and a ratio above 1" covered five inputs, and the one that
reached it from `maxRatioPerStage: 1` had four of the five correct.

## The gate that could not fail

`__tests__/facilities.compression.test.js` asserted that the polytropic and
isentropic power routes agree to 1e-12 and called it "the strongest available
check that neither is transcribed wrong". With `e = (k-1)/(k eta_p)` and
`kExp = (k-1)/k`, **`e * eta_p == kExp` exactly**, so the two routes are one
expression and the assertion could not fail for any input at all. It is kept,
labelled as the shape property it is and proved on the exponents each case
uses, and **the real check is now a numerical quadrature of `int(v dp)` along
the polytropic path, with a negative control that moves the exponent a tenth of
a percent and must break the comparison.**

`dutyPoint` ran a fixed 200 bisections and returned the midpoint whatever had
happened; `fitPumpCurve` reported `rSquared`, which measures the fit and not
the solve. Both now report their own numerics. `dutyPoint`'s `converged` is
deliberately made of the residual as well as the bracket, because a bracket on
a sign change always collapses and a flag made only of the bracket could never
be false: a curve that goes non-finite inside the bracket is the case that
fails it, and it is the negative control.

`fitPumpCurve` also reported `rSquared: 1` for three identical heads, where
`sst` is zero and the quantity is undefined; a horizontal line that explains
nothing was reported as a perfect fit beside a droop warning saying the
opposite. Undefined is `null`.

## Movement

**Nine of the 63 published compression golden fields moved, and not one of them
by an unexplained amount.** Every one is a named constant:

| field | ratio | cause |
| --- | --- | --- |
| `headPolyFtLbfLbm` (3 cases) | 1.0000009059442236 | the gas constant, 10.7316 x 144 over 1545.349 |
| `massLbHr` (3 cases) | 1.0000169391883849 | the standard base, 379.49 over the derived 379.48357185628737 |
| `gasHp` (3 cases) | 1.0000178451479544 | the product of the two |

`tDischargeF`, `zAvg`, `ratio` and every staging field are bit for bit
unchanged, and **the ten published pump goldens did not move at all**: the
kilowatt packaging is not among their fields. Both files regenerate byte for
byte from `tools/validation/facilities/oracle_compression.py` and
`oracle_pumps.py`.

Held for literature and taught as limits rather than repaired: the Hydraulic
Institute viscosity factors, the impeller-trim shortfall model, the operating
region bands, the NPSH margin rule, the machine screening thresholds and the
300 degF discharge default. None has a publication in this repository, and the
trim's power leg is therefore left as the ideal cube: de-rating it would be
inventing a second unsourced model on top of the first. The efficiency the
return implies is **computed and reported** as `impliedEfficiencyRatio`
instead, because the defect was that a reader who divided the returned power
into the returned head and flow got a number the module never mentioned.

## Owner copy rule sweep, 2026-09-18

Every user-facing string in `engines/facilities/` was parsed out of the source (Babel AST, every string and template literal) and checked for dashes, the `, not ` contrastive the course gate `gate_copy_rule.py` enforces, `is not A, it is B` and `and not`. The strings below were rewritten; meaning is kept, and no number, key or branch moved. Every golden regenerates byte for byte and the tests that pinned the old wording now pin the new.

| file | string | before | after |
|---|---|---|---|
| `compression.js` | hot-stage warning | the valves and the lube oil become the limit, not the thermodynamics | at this temperature the valves and the lube oil set the limit, ahead of the thermodynamics |
| `pumps.js` | viscosity correction warning, B above 40 | this service needs a positive-displacement pump or vendor viscous test data, not a corrected centrifugal curve | B above 40 is outside the published correlation, so a corrected centrifugal curve cannot be used here: this service needs a positive-displacement pump or vendor viscous test data |
