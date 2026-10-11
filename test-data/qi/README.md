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
