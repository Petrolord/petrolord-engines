# FINDINGS: prestack and prestack QC (E1a, 2026-10-11)

The first engines wave of the NextGen QI course extraction gate
(docs/scope/NextGen-QI-Course-PLAN.md section 3, gaps G1 and G2). It covers
`engines/qi/prestack.js` and `engines/qi/prestackQc.js` at engines main
`cc4c62d`.

**No engine defect found. No engine file changed.** Every function agrees
with the independent oracle to float noise, except residual moveout, which
is an estimator and is held to its designed truth (below).

## The gate

| file | what it is |
|---|---|
| `oracle_qi_prestack.py` | stdlib Python, no shared code; writes both goldens; asserts its anchors; refuses an empty sweep; byte-identical regeneration |
| `__tests__/qi.prestack.golden.test.js` | Dix, layered RMS, velocity on the grid, exact ray, Walden, bins, angle gather, partial stacks, usable angle; every assertion calls the engine |
| `__tests__/qi.prestackQc.golden.test.js` | NMO stretch, stretch mute, residual moveout (8 designed gathers), fold summary |
| `negcontrol_e1a.sh` | regeneration byte-identical; gate green on the shipped engines; 23 planted defects, 23 caught |

## Oracle method, function by function

| engine function | oracle route (different from the JS) | anchors | engine against oracle |
|---|---|---|---|
| `dixInterval` | forward substitution on Vrms^2 t = sum v^2 dt in exact rationals | two-layer earth 2000/3000 m/s: Vrms^2 = 6.5e6 exactly, Dix back to 3000 | 9e-13 m/s |
| `layeredRms` | rationals over the layers | as above | 1e-12 |
| `velocityOnGrid` | bisect for the segment, rational Dix per segment | | 5e-13 m/s (Vint); a table that starts at 0 ms is clamped to 1e-6 ms by the engine, at most 1e-9 relative |
| `rayTraceAngle` | Newton on the ray parameter with the analytic dx/dp (engine: bisection) | one layer tan(theta) = x / 2z; Fermat dT/dx = p by central difference; the small-offset slope p v | 4e-14 degrees over 70 rays on 4 earths, one with a slow target under a fast layer |
| `waldenAngle` | Walden (1991, Geophysical Prospecting 39, 915-942): the straight ray through a medium at Vrms, tan(theta_rms) = x / (Vrms t0), then Snell into the layer, sin(theta) = sin(theta_rms) Vint / Vrms. Algebraically the engine's sin(theta) = (Vint / Vrms) x / sqrt(x^2 + (Vrms t0)^2); the oracle goes through atan and sin | equals the exact ray in one homogeneous layer; shares its small-offset slope on a layered earth; within 1.5 degrees of the exact ray up to an offset equal to the target depth on every earth | under 1e-10 degrees |
| `binOffsets` | rational floor of x / w | boundaries 199.99999, 200, 31.4999, 31.5 on 10.5 m bins | exact |
| `angleGather` | angles by the oracle's Walden route, bins by bisect over the edges | no live sample within 1e-7 degrees of an edge (asserted), so an ulp cannot move a sample between bins | 1e-12 |
| `partialStack` | the mean of the RAW samples whose angle falls in [edges[from], edges[to]) (engine: fold-weighted bin means); cross-checked inside the oracle against the bin route | | 1e-12 |
| `usableAngle` | counting from the oracle's folds | four minimum folds give different answers | exact |
| `nmoStretch` | u / (1 + sqrt(1 + u)), u = (x / (v t0))^2 (Yilmaz 2001, section 3.2) | t0 = 1 s, v = x = 2000: sqrt(2) - 1 | 1e-13 |
| `stretchMuteOffset` | bisection on the oracle's stretch (engine: closed form) | the root's stretch is the limit to 1e-12 | 1e-8 m |
| `residualMoveout` | designed truth: Ricker events shifted analytically by dt = a x^2; the oracle's own estimate is a golden-section maximum of conventional semblance (Neidell and Taner 1971) or, where the waveform changes with offset, the straight-line explained energy (Sarkar, Castagna and Lamb 2002), both with cubic interpolation | every oracle estimate within 0.25 ms of the design (asserted); it is within 0.01 ms | see below |
| `foldSummary` | counting | an empty fold gives no far offset | exact |

## Residual moveout is an estimator, not a closed form

On the eight designed gathers (2 ms sampling, 16 offsets 100 to 2350 m,
30 Hz Ricker) the engine misses the design by at most 0.18 ms (the 8 ms
case, the correlation path, sub-sample peak by parabola): 0, -0.18, +0.13,
-0.07, 0, -0.09, 0.00, +0.005 ms. The gate holds it to 0.2 ms, a tenth of a
sample, of both the design and the oracle estimate, and checks the path:
one waveform across offset (including a polarity reversal) takes the
correlation path; two events with opposite AVO take AB semblance. This is a
limit of the method and is stated so here, not a defect. A course must not
grade a residual moveout at the six-decimal floor.

One planted change was benign by construction and is not in the battery:
scanning AB semblance at two samples instead of a quarter sample still
lands within 0.2 ms after the parabolic refinement, because the semblance
curve is smooth over that range.

## What the course can now grade from these engines

At the six-decimal floor (engine and oracle agree to 1e-8 or better):
the Dix interval velocity of a stated layer, the Walden angle at a stated
offset and time, the exact ray angle, the NMO stretch at an offset and the
stretch-mute offset, the fold of each offset or angle bin, a partial-stack
sample, and the usable angle at a stated minimum fold (an exact bin edge).
