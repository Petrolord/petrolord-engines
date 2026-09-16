# FINDINGS: line hydraulics (FC2-0, 2026-09-16)

The repair wave before the NextGen Line Sizing & Hydraulics course, taken
against `engines/facilities/lineHydraulics.js` at main `709172f`, with
`engines/production/chokePerformance.js`. The full defect list, with the
inputs that expose each one, is the course wave's `FINDINGS.md`
(`tools/course-waves/linesizing/FINDINGS.md` in petrolord-nextgen); this file
records what changed here and why.

Twenty inputs returned a number they should not have. Ten returned a
confident wrong one and ten returned a NaN or an Infinity **with no `error`
key**, so every caller's `if (result.error)` guard passed and the non-finite
value propagated. All twenty are now named refusals, and the one input that
was physically meaningful and merely mishandled is computed correctly.

## Computed correctly rather than refused

**The outlet-pressure bracket.** `gasOutletPressure` bracketed its bisection
at `[14.7, p1]`. Every published form is driven by `p1^2 - es p2^2`, so the
outlet a line approaches as its rate falls to nothing is `p1 / sqrt(es)`, not
`p1`. The bracket was wrong in both directions:

- on a **descent** `es < 1` and that ceiling is ABOVE the inlet, because the
  column recovers more head than the friction spends. The answer was outside
  the bracket and the search converged on the top of its own bracket, so an
  8 in line 25 mi long down 3000 ft returned the inlet with `dpPsi: 0`,
  10 to 50 psi low, and the Suite's gas traverse marched it;
- on an **ascent** the ceiling is BELOW the inlet, and the loop read the
  forms' refusal above it as "still too much flow" and walked its LOWER bound
  up through it. The same line up 3000 ft returned the inlet with a zero drop
  for any rate it could carry to the ceiling: 75 psi low at 1e6 scfd. This
  half was not in the original findings and is the commoner case.

The bisection itself was exact all along. On the engine's own 0.0375
coefficient the closed-form inverse and the repaired bisection agree to
between 0 and 3.2e-16 on nine cases spanning both signs of elevation. The
bracket now ends at the ceiling, a refusal at the midpoint is read as "the
outlet is above the ceiling" (search down), and a line whose static column
alone spends the inlet is refused by name. A descent now returns a NEGATIVE
`dpPsi`, which is the honest reading: the line arrives higher than it left.

## Refused by name

Each of these is physically meaningless rather than merely awkward, so the
engine refuses instead of computing: a negative resistance sum (fittings gave
pressure back), a negative absolute roughness (19.3 percent low on both `f`
and the pressure drop), an elevation change longer than the line (the Suite's
own `multiphaseLine` already refused this and the engine underneath did not),
a transmission efficiency outside `(0, 1]` in either direction, General Flow
at zero viscosity (1.6 percent high and plausible, which is worse than
absurd), a negative corrosion allowance (a negative required wall), a
negative swept volume (pigging time the catcher does not have), a liquid
traverse with no inlet pressure or one that marches to zero absolute, and the
ten unguarded gas and wall inputs that returned NaN or Infinity silently
(`lengthMi` 0 and negative, `idIn` negative, `zAvg` 0, `tAvgR` 0, `sg` 0,
`jointFactor` 0, `tempDerate` 0, and `sweptLiquidBbl`'s bore and length,
which were handed straight to `lineVolumeBbl`'s NaN contract while the one
guarded input made the other two look checked).

`liquidLineTraverse` refuses WITH its evidence: the stations it could stand
behind, `diedAtFt`, and the unphysical `diedAtPsia` the arithmetic produced.
Zero absolute is the bound this module can stand behind; a liquid has
cavitated at its own vapour pressure well above it, and that is fluid
knowledge this module does not hold.

## One barrel for the package

`lineHydraulics` carried the barrel exactly as `(42 * 231) / 1728` and
`chokePerformance` carried it truncated as `5.614583`, a ratio of
1.0000000593692, inside the single chain the Pipeline & Line Sizing Studio
composes. Both are now `CUFT_PER_BBL` from `lib/units/fieldUnits.js`, and the
EXACT value is the one kept: it is exact by definition, and both modules'
Python oracles already worked from the SI barrel 0.158987294928 m3, which is
that number to the last bit. The goldens said which half was right before
anyone asked, and the choke gates that hid it at 1e-6 are now at 1e-12.

**Not changed, and recorded rather than fixed:** `production/plungerLift.js`,
`production/espPump.js`, `fluid/separator.js` and
`welltest/models/modelCatalog.js` still carry the truncated barrel. They are
not in this chain and moving them moves other shipped courses' goldens.

## Goldens

`linehydraulics_cases.json` 37 cases -> 45. **No pre-existing case moved**: no
valid-input arithmetic changed anywhere in this repair. The new block is
`outlet`, eight cases inverted IN CLOSED FORM by the SI oracle (including
General Flow, whose friction factor is fixed by the rate alone, so the
direction the engine iterates closes in one step there), covering both signs
of elevation and the two brackets that were wrong.

## Deliberately not repaired

- **`erosionalC` resolves an unknown service id to the first row** under its
  own label, where `fittingK`, `roughnessOf` and `gradeYield` return NaN and
  `scheduleRow` returns null. It belongs to the RP 14E table that two other
  studios read; changing it is a decision for that table.
- **`maopPsig` over-rates a line whenever the caller omits the corrosion
  allowance**, by the ratio of the gross wall to the net: 1.156 times on the
  wall the findings measured, 1.5 times on a 0.375 in wall carrying the same
  0.125 in allowance. Both calls are legal and each is correct for what it
  was asked. A guard cannot fix a question that was fully formed and wrong.
- **Neither iteration reports convergence.** They converge everywhere both
  oracles have looked (1.5e-13 worst case) and no wrong number follows.
- **Colebrook is evaluated past its published roughness range** and the band
  from Re 2100 to 4000 is computed on the turbulent branch under the label
  `transitional`. Both are taught as limits; neither is a repair.
- **`liquidLineTraverse` still has no `sumK` parameter**, so a line sized with
  its fittings and then marched loses them. That is a signature change rather
  than a guard.
- **The named rounded constants stay**: cp 6.7197e-4, gc 32.174 and the
  elevation coefficient 0.0375 are the published field forms and the goldens
  pin them. They are the whole of the residual 1.5e-6 to 3.9e-5 against an SI
  oracle, and they are causes rather than tolerance problems.
