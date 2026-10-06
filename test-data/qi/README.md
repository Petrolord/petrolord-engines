# QI goldens

## Seismic QC (A5, 2026-10-06)

`goldens.seismicQc.json` is written by `tools/validation/qi/oracle_seismic_qc.py`. Standard library only; regeneration is byte-identical.

- **What it checks:** the analytic Ricker amplitude spectrum, A(f) proportional to f^2 exp(-f^2 / fp^2).
  - The peak is at fp.
  - The -6 dB and -20 dB band edges are bisection roots of x^2 exp(1 - x^2) = level. As fractions of fp: -6 dB at 0.4824 and 1.6354; -20 dB at 0.1955 and 2.2113.
  - The power centroid is 1.0638 fp, checked by numerical integration.
- **Not from the oracle:** the signal-to-noise and footprint gates use designed truths on seeded synthetic traces and slices, set in the jest gate itself.
