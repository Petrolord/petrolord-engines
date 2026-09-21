# RECON: corrosion and integrity (FC9-0 pre-repair, 2026-09-16)

The reconnaissance pass before the NextGen Corrosion & Integrity course,
taken against `engines/facilities/corrosion.js` at engines main `82ec6d4`,
its golden `test-data/facilities/goldens/corrosion_cases.json`, its oracle
`tools/validation/facilities/oracle_corrosion.py`, its suite
`__tests__/facilities.corrosion.test.js`, and the LIVE Suite studio at
`/dashboard/apps/facilities/corrosion-rate-predictor`.

**Nothing was repaired in this pass.** The full defect list, with the
inputs that expose each one, is the course wave's recon:
`/root/fc-wip-corrosion/RECON.md` and `/root/fc-wip-corrosion/FINDINGS.md`,
**55 findings, 35 of them LIVE, 17 of them FAILING OPEN, and 10 HELD FOR
LITERATURE**. That recon is provenance and is not teaching truth.

## The gate, measured

Baseline 19 of 19 passing, restored and re-verified after every round.

- **13 of 50 defects planted in the ENGINE ALONE left the suite 19 of 19
  GREEN**, including `SOUR_THRESHOLD_BAR` moved by a factor of ten, the
  sour-region pH pivot, the Region 1 boundary, both `filmRisk` thresholds,
  the H2S to CO2 carbonate boundary, the laminar friction factor, the
  Re 4000 regime switch, a `rateCategory` band, and three separate
  mutilations of `screen` including computing the H2S partial pressure as
  the TOTAL pressure with the mole fraction dropped.
- **15 of 17 defects planted in the ENGINE AND THE ORACLE TOGETHER left
  the suite green, and the oracle caught NONE of the seventeen.** Every
  published de Waard-Milliams constant, every scale-factor constant, the
  pH slope, both Blasius constants and the wall shear stress HALVED all go
  green. The two reds came from literals typed by hand into the jest file.
- The oracle-only control (bisection target `1/vr + 1/vm` changed to
  `1/vr + 2/vm`) goes RED, so the harness can tell the two files apart.

## Why: the oracle is a transcription

`vm_direct`, `scale_factor` and `ph_factor` are the engine's expressions
character for character. `fugacity` and `vr_natural` are the same constants
with the log base changed. **`shear_darcy` is algebraically the engine's
own line**: it forms `f_darcy = 4 * f_fanning` and then `(f_darcy / 8) rho
u^2`, which is `0.5 f_fanning rho u^2`. The oracle docstring and the jest
header both call that an independent re-derivation.

Genuinely independent, and the only two: the 300-round bisection on
`1/CR`, and the 8760-hour inhibitor duty cycle.

## What the oracle does not compute

**Five whole exports and the exported constant have no oracle route and no
golden row:** `sourServiceRegion`, `corrosionRegime`, `remainingLife`,
`rateCategory`, `screen`, `SOUR_THRESHOLD_BAR`. That is the entire Sour
Service tab, the entire Integrity tab and every field of the app's single
entry point. Six of the thirteen engine-only greens live there.

Also uncovered: `corrosionRate.controlling`, `.waterWettingFactor`,
`.effectiveInhibitionPct`, `.warning` and the no-CO2 `note` branch;
`wallShearStressPa.fanningFriction`, `.filmRisk` and `.warning`;
`dwmMassTransferRate`'s `Infinity` return; the `scaleFactor` and `phFactor`
clamps; and `co2Fugacity.pco2Bar`, which is written into the golden and
then never asserted.

## The golden

**Ten rows, five `cases` and five `inhibitor`. ZERO are published
measurements.** Every row is a round-number condition invented in the
oracle's `main()`. Rows that do not exercise the branch they name: 3 of 5
have `scaleFactor` pinned at exactly 1.0 by the clamp; 2 of 5 have
`phFactor` exactly 1.0 at or below the reference pH; 3 of 5 run at
0 percent efficiency so the inhibitor arithmetic is the identity; all 5 are
turbulent, so the laminar branch and the Re 4000 switch have no row; all 5
are mass-transfer controlled, so `controlling === 'reaction kinetics'` has
no row; none sets `flowRegime` or `waterCutFrac`; none is above the 250 bar
cap; and every row's `fco2Bar` is between 0.94 and 1.64 bar.

## The five LIVE defects the repair must lead with

1. **Two decades of acidity move the rate by exactly zero.** `phFactor`
   returns 1 at or below its reference of 4, so pH 2.0, 3.0, 3.5 and 4.0
   all return 1.3417538787620145 mm/yr at the app's defaults, while the
   sour region for the same sweep moves 3, 2, 2, 1. The reference pH
   appears nowhere in the UI.
2. **A blank Temperature box returns a rate of zero and blames CO2.** NaN
   fails `!(fco2Bar > 0)`, so the engine takes the no-CO2 branch: rate 0,
   category "negligible" in emerald, remaining life "unbounded", and a
   message about CO2 under a CO2 box that still reads 3 mol%.
3. **The inhibitor warning cannot fire at the app's own default
   efficiency.** The guard is `eff > 0.9` and the default is 90 percent, so
   85.5 percent effective protection against a 90 percent datasheet figure
   is printed in emerald with no warning. The one lesson the module exists
   to teach is switched off at its own defaults.
4. **The wall-shear warning has no effect on the rate it warns about.** At
   60 ft/s the engine returns 362 Pa and "most inhibitor films are
   stripped", and then applies the datasheet efficiency anyway: 1.897 mm/yr
   and 1.67 years of life against 13.080 mm/yr and 0.243 years if its own
   warning is believed, 6.90 times.
5. **The MR0175 / ISO 15156 region is an invented linear fit wearing the
   standard's name**, `severity = log10(pH2S / 0.0035) - (pH - 3.5)` with
   break points at 1 and 2.5, and named material guidance handed out on it.
   Moving the pivot and the Region 1 boundary both leave the suite green.

## HELD FOR LITERATURE

Recorded, to be exposed as a stated limit, never graded, and no citation is
invented here: every de Waard-Milliams constant and its band; **whether
the protective-scale factor multiplies the reaction term or the combined
rate** (the engine applies it after the combination, and the two differ
materially whenever mass transfer controls, which it does at the defaults
and in all five golden rows); the pH slope, its reference and what happens
below it; the 250 bar fugacity cap; the MR0175 / ISO 15156 boundaries and
the material guidance strings; the exact sour threshold (0.0035 bar is
0.050763 psia, and 0.05 psi is 0.0034474 bar); the 1/500 and 1/20 film
ratios; the 100 Pa and 50 Pa shear thresholds; the `rateCategory` bands
0.1, 0.5 and 1.0 mm/yr; the Blasius constants and the Re 4000 switch; and
an erosional-velocity, pitting, SSC or HIC criterion, none of which the
module has.

## Target for FC9-0

Zero green in the re-run planting battery. It stands today at 13 of 50
engine-only and 15 of 17 paired. The ordered repair plan is RECON.md
section 8.
