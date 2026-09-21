# RECON: heat transfer (FC6-0 reconnaissance, 2026-09-16)

Reconnaissance only. Nothing in the engine, the oracle or the golden is
changed by this commit. It records what the gate can and cannot catch today,
measured by planting, so the FC6-0 repair has a baseline it did not have to
re-measure. The full defect list, with the inputs that expose each one, is
the course wave's recon: `/root/fc-wip-heattransfer/RECON.md` and
`FINDINGS.md`, 44 findings, 21 of them reachable by typing into a box in the
shipped Suite studio.

Subject: `engines/facilities/heatTransfer.js`,
`test-data/facilities/goldens/heattransfer_cases.json`,
`tools/validation/facilities/oracle_heattransfer.py`,
`__tests__/facilities.heattransfer.test.js`, at engines main `82ec6d4`.

Baseline: **19 tests, 19 passing.** The worktree was restored and re-verified
at 19 of 19 after every planting round.

## What the gate cannot catch

**Forty-two defects planted in the ENGINE ALONE. Twenty-nine went red.
THIRTEEN left the suite 19 of 19 GREEN:**

- Sieder-Tate exponent 0.14 to 0.25
- laminar Nusselt 3.66 to 4.36
- transition floor Re 2300 to 2100
- bundle constant K 0.249 to 0.300
- bundle exponent n1 2.207 to 2.30
- the bundle-diameter exponent INVERTED, `(N/K)^(1/n1)` to `(N/K)^n1`
- the tube surface area losing its PI
- the shell clearance added twice
- the hot-day `dutyFraction` SQUARED
- the N-shell P1 conversion exponent `1/n` to `n` (the R != 1 branch)
- `overallU` default `kWallBtuHrFtF` 26 to 30
- `airCooler` default `staticPressureInH2O` 0.6 to 0.9
- `airCooler` default `motorEfficiency` 0.92 to 0.80

The whole bundle-geometry fit is unvalidated: the suite checks only that a
bigger area gives more tubes and a wider bundle, which an inverted exponent
still does.

**Ten defects planted in the ENGINE AND THE ORACLE TOGETHER. Eight left the
suite 19 of 19 GREEN,** which is the test for whether an oracle route is an
independent derivation or a transcription:

| planted in both files | result |
|---|---|
| `overallU` wall factor 2 to 2.2 | GREEN |
| `overallU` inside film and fouling lose the do/di ratio | GREEN |
| Dittus-Boelter 0.023 to 0.027 | GREEN |
| Dittus-Boelter Reynolds exponent 0.8 to 0.85 | GREEN |
| Dittus-Boelter Prandtl exponent 0.4 to 0.35 | GREEN |
| tube viscosity conversion moved the same physical amount in both | GREEN |
| air cp 0.24 to 0.26 | GREEN |
| fan constant 6356 to 6300 | GREEN |
| the air cooler's LOG MEAN replaced by the ARITHMETIC MEAN | GREEN |
| air density base 14.7 to 15.2 | red, and what caught it was `expect(airDensityLbFt3(60)).toBeCloseTo(0.0764, 3)`, a literal typed into the test |

Changing the oracle's Btu-to-W conversion ALONE takes the suite to 2 failed,
17 passed. The harness can tell the two files apart, so the eight greens are
the oracle agreeing with itself. `oracle_heattransfer.py` calls its `u`,
`tubeFilm` and `airCooler` routes an "SI re-derivation"; a formula restated
in SI and converted back is algebraically a no-op, not a second derivation.

## What the oracle computes nothing for

Six whole exports have no golden row and no oracle route: `capacityRate`,
`energyBalance`, `lmtdGroups`, `areaRequired`, `tubeCount` and
`ntuFromEffectiveness`. So does the entire `airCooler.hotDay` block, which is
the Suite studio's headline number on two screens and is 10.15 percent wrong
at the app's own defaults.

Returned values no golden carries: `lmtdCorrectionF.shellPasses`, `.warning`
and the whole N > 1 conversion; all five members of `overallU.resistances`,
plus `controlling` and `foulingPenaltyPct`; `tubeSideFilm.regime`,
`.warning`, `.siederTate`, the laminar `hBtuHrFt2F` and the transition
refusal; every field of `tubeCount`; `effectivenessFromNtu` for `parallel`
and `shell1`; every field of `ntuFromEffectiveness` and both of its ceiling
messages; `airCooler.airOutF`, `.airLbHr`, `.motorHp`, and every field of
`hotDay`.

`effectivenessFromNtu` for `parallel` and `shell1` is checked only against
its own inverse, an identity that holds for any mutually inverse pair
whether or not either is right, plus one ordering assertion.

## What the golden is made of

**Eighteen rows. Zero are published data.** Every row is a round-number
condition invented in the oracle's `main()`. The module's prose names Bowman,
Dittus-Boelter, Sieder-Tate, Kern, TEMA and HTRI, and no golden row comes
from any of them. Twelve rows sit on a genuinely independent route (`lmtd`
by numerical integration of the driving force, `fCorrection` by the
effectiveness-NTU identity, `epsNtu` by an RK4 shooting march of the
exchanger ODEs), six sit on a transcription.

One of the three `lmtd` rows, (400, 380, 100, 120), has equal end approaches,
so the engine takes its `Math.abs(dt1 - dt2) < 1e-9` shortcut and the
logarithm is never evaluated. Two rows carry the log-mean route, not three.

## One route that is correct and unchecked

The N-shell P to P1 conversion is RIGHT. Marching N identical 1-2 shells at
the P1 it produces recovers the stated overall P to 1.9e-16 or better at
(P, R, N) of (0.6, 1, 2), (0.75, 1, 3), (0.7, 0.5, 2), (0.45, 1.5, 2),
(0.8, 0.6, 3), (0.3, 2.5, 2), (0.55, 0.8, 4) and (0.9, 0.3, 3), and the
whole-unit area equals the sum of the shells to 4.3e-16. The R = 1 branch is
exercised by the suite; the R != 1 branch is not, which is why inverting its
exponent is green. The repair should record this as a route already proved
rather than re-derive it.
