# QI goldens

## Seismic QC (A5, 2026-10-06)

`goldens.seismicQc.json` is written by `tools/validation/qi/oracle_seismic_qc.py`. Standard library only; regeneration is byte-identical.

- **What it checks:** the analytic Ricker amplitude spectrum, A(f) proportional to f^2 exp(-f^2 / fp^2).
  - The peak is at fp.
  - The -6 dB and -20 dB band edges are bisection roots of x^2 exp(1 - x^2) = level. As fractions of fp: -6 dB at 0.4824 and 1.6354; -20 dB at 0.1955 and 2.2113.
  - The power centroid is 1.0638 fp, checked by numerical integration.
- **Not from the oracle:** the signal-to-noise and footprint gates use designed truths on seeded synthetic traces and slices, set in the jest gate itself.

## AVO and wavelets (E1b, 2026-10-11)

`goldens.qiAvo.json` and `goldens.qiWavelets.json` are written by
`tools/validation/qi/oracle_qi_avo.py` and `oracle_qi_wavelets.py`
(standard library only, byte-identical on regeneration, anchors asserted,
an empty case list refused). Gates: `__tests__/qi.avo.golden.test.js` and
`__tests__/qi.wavelets.golden.test.js`; every assertion calls the engine.
Negative controls: `tools/validation/qi/negcontrol_e1b.sh` (29 planted
defects, all caught; it also checks the byte-identical regeneration).

**Oracle routes, different from the engine's:**

- Reflectivity: exact Zoeppritz as the 4x4 Aki-Richards scattering system,
  complex Gaussian elimination; cross-checked against the rockphysics
  oracle's closed form on the four classic cases (1e-12).
- `akiRichards`: d R / d eps of exact Zoeppritz at zero contrast (layers
  mean (1 -/+ eps c / 2), central differences, Richardson), 1e-10.
- `shueyTerms`: A = L(0), B the sin^2 slope of the limit at zero, C from
  30 degrees; agreement 1e-11 (A), 1e-9 (B, C, limited by the oracle's
  differentiation). Also pinned to the bruges-checked A, B, C of the classic
  cases in `test-data/rockphysics/goldens.json`.
- `fitShuey`: Householder QR on sqrt(w)-scaled rows (the engine eliminates
  normal equations), noisy exact-Zoeppritz amplitudes, two and three terms,
  weights, a gap.
- `contrastsFromAB`: the Shuey A, Shuey B and Gardner system solved in exact
  rationals; Smith-Gidlow fluid factor.
- `backgroundTrend`: principal eigenvector from the quadratic formula,
  confirmed by golden-section minimisation of perpendicular distances (the
  engine uses the half-angle atan2); too few points give no trend.
- `offTrend`: foot of the perpendicular, signed negative below the line.
- `resampleWavelet`: exact rational linear interpolation (intervals as typed
  decimals).
- `alignWavelet`, `compareWavelets`: cross-correlation by the DFT of
  zero-padded wavelets; each golden lag beats the runner-up by over 1e-9.

**Findings: no engine defect.** Conventions documented, engine unchanged:

1. AVO class boundaries differ from the rockphysics engine and oracle: QI
   puts A = +band in class I and B = 0 (with A <= -band) in class IV;
   rockphysics puts them in II and III. The gate pins the QI convention. A
   capstone must not grade a class on a boundary.
2. `alignWavelet` with `maxLag: 0` returns lag -0 (equal to 0, prints and
   serialises as 0).
3. Exact ties go to the most negative lag (pinned by a designed integer
   tie).
4. Resampling is linear about the centre sample, not sinc; checked as
   shipped.

## Prestack and prestack QC (E1a, 2026-10-11; QI course gaps G1 and G2)

`goldens.prestack.json` and `goldens.prestackQc.json` are written by `tools/validation/qi/oracle_qi_prestack.py`. Standard library only, no shared code; regeneration is byte-identical (checked by `tools/validation/qi/negcontrol_e1a.sh`). The gates are `__tests__/qi.prestack.golden.test.js` and `__tests__/qi.prestackQc.golden.test.js`; every assertion calls the engine.

- **Dix and layered RMS:** exact rationals (forward substitution on Vrms^2 t = sum v^2 dt). Anchor: the two-layer earth 2000 m/s over 3000 m/s, Vrms^2 = 6.5e6 exactly, Dix back to 3000.
- **Exact ray:** Newton on the ray parameter (the engine bisects). Anchors: tan(theta) = x / 2z in one layer; Fermat dT/dx = p; the small-offset slope p v.
- **Walden angle:** atan then Snell (the engine uses the hypotenuse); equals the exact ray in one layer and within 1.5 degrees of it to an offset equal to the target depth on three layered earths.
- **Binning, angle gather, partial stack, usable angle, velocity on the grid:** rational floor, bins by bisect, the partial stack straight from the raw samples. No live sample sits within 1e-7 degrees of a bin edge.
- **NMO stretch and the mute offset:** the rationalised closed form, and a bisection root.
- **Residual moveout:** gathers built analytically with a designed parabolic residual (0, 8, -6, 3 with dimming, polarity reversal flat and 5 ms, two events with opposite AVO flat and 4 ms). The gate holds the engine to 0.2 ms (a tenth of a sample) of the design and of the oracle's own continuous semblance estimate, and checks which path (correlation or AB semblance) the engine takes.
- Details and the negative-control tally: `tools/validation/qi/FINDINGS-E1a.md`.

## LFM, seismic QC on arbitrary traces, prospect assessment (E1c, 2026-10-11)

Written by stdlib oracles; regeneration is byte-identical (checked by `tools/validation/qi/negcontrol_e1c.sh`, which also plants 31 defects in the engines and requires each to turn the gates red). Findings: `tools/validation/qi/FINDINGS-E1c.md`.

- `goldens.lfm.json` (`oracle_qi_lfm.py`): the horizon map as a knot table, exact-rational log sampling, explicit IDW weights, the fill rule, the blind-well score. Gate `__tests__/qi.lfm.golden.test.js`.
- `goldens.seismicQc2.json` (`oracle_qi_seismic_qc2.py`): spectra of arbitrary traces by a direct DFT with Harris's Tukey window, the average spectrum of a trace patch, the bin estimators cross-checked against the continuous transform, the coherency S/N on seeded traces against the realised S/N, the footprint periodogram. Gate `__tests__/qi.seismicQc2.golden.test.js`.
- `goldens.prospectAssessment.json` (`oracle_qi_prospect.py`): spill by union-find, closures by breadth-first search, GRV by cell sums, conformance and the implied contact from their definitions, evidence independence, the decision table. Gate `__tests__/qi.prospectAssessment.golden.test.js`.

## QI Studio maths moved into the engines (E2, 2026-10-11)

`goldens.avoWells.json`, `goldens.inversionQc.json`, `goldens.angleWavelets.json`, `goldens.propertyCalibration.json` and `goldens.prospectTrap.json` are written by `tools/validation/qi/oracle_qi_avo_wells.py`, `oracle_qi_inversion_qc.py`, `oracle_qi_angle_wavelets.py`, `oracle_qi_property_calibration.py` and `oracle_qi_prospect_trap.py`. Standard library only; regeneration is byte-identical.

- **AVO at the wells:** the scale as the vertex of the exact misfit parabola; residual and classes.
- **Inversion QC:** the convolutional model as a dense operator, the wavelet scale, the half window (halves up), the low pass by prefix sums, the blind table on injected estimates.
- **Angle wavelets:** Fatti (1994) reflectivity anchored to Aki-Richards, the damped Wiener wavelet by Cholesky with Float32 storage, DFT alignment and the energy-kept average, the synthetic correlation.
- **Property calibration:** the transform in exact rationals, the closed-form Student t, the leave-one-out widening of #987, coverage, Gaussian and KDE posteriors and the posterior tables.
- **Prospect trap:** brute-force crest climb, the spill by union-find, closures by breadth-first search with explicit GRV sums, the anomaly read on its own frame, conformance, the held contact and the map-edge rule.
- **Negative controls:** `negcontrol_e2a.sh` (25 plants) and `negcontrol_e2b.sh` (31 plants), all caught. Findings: `tools/validation/qi/FINDINGS-E2a.md`, `FINDINGS-E2b.md`.
