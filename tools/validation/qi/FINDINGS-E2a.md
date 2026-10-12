# FINDINGS: AVO at the wells, inversion QC, angle wavelets (E2, part A, 2026-10-11)

The fourth wave of the NextGen QI course extraction gate (Suite
`docs/scope/NextGen-QI-Course-PLAN.md` section 3, gap G7). It covers the
QI Studio maths moved verbatim into the engines: `engines/qi/avoWells.js`,
`engines/qi/inversionQc.js`, `engines/qi/angleWavelets.js` and
`engines/seismolord/wellWavelet.js`.

**No engine defect. No engine line changed after the move**, so QI Studio
parity holds byte for byte (the Suite pins it on recorded Ekene kit cases in
`src/pages/apps/QIStudio/__tests__/qiEngineParity.test.js`).

## The gate

| file | what it is |
|---|---|
| `oracle_qi_avo_wells.py` | stdlib; the pooled scale as the vertex of the exact misfit parabola E(s) (Fractions at s = 0, 1, 2, asserted to be the minimum); residual as the vector length; classes on the QI band convention; 4 cases (scatter with an error well and a missing observation, polarity reversed, a class that differs, nothing observed) |
| `oracle_qi_inversion_qc.py` | stdlib; the convolutional model (centred derivative of ln AI, centred wavelet) as a DENSE operator G = W D, checked against the direct definition to 1e-12; hold-fill and coverage from their definitions; the scale from the exact misfit parabola (recovers a planted 3.7e4 to 0.2 percent under noise); `halfWindowFor` with halves rounded up (Python's half-even would differ); the low pass by prefix sums; the blind table on injected estimates with known scores (one-pass Welford Pearson, relative AI error), the blind call passing the well's own name as `exclude`, the default 8 Hz and an explicit 10 Hz low cut |
| `oracle_qi_angle_wavelets.py` | stdlib; Fatti et al. (1994) coded from the paper and anchored to a separate Aki-Richards (1980) within 5 eps^2 at eps 1e-3 and 1e-4; the damped Wiener wavelet by CHOLESKY (the engine eliminates), Float32 storage emulated with `struct`, a planted Ricker recovered to 1e-5 noise-free, Float32 nulls mid-trace, a 44-row log refused by the 2m floor; alignment by zero-padded DFT cross-correlation (the engine sums each lag), the energy-kept average, the synthetic correlation by two-pass Pearson; 4 wells over 3 angles (one flat and refused, one shifted and aligned at lag -1, one with a log gap), one well alone, no usable well |
| `__tests__/qi.avoWells.golden.test.js`, `qi.inversionQc.golden.test.js`, `qi.angleWavelets.golden.test.js` | every assertion calls the shipped engine; closed forms at 1e-11 to 1e-13; values downstream of the Float32 wavelet at 2e-7 (wavelet) and 1e-6 of scale |
| `negcontrol_e2a.sh` | 25 planted one-line defects across the four files, all caught; the three goldens regenerate byte for byte |

## Observations (kept for parity, pinned in the gate, not endorsed)

1. **Decided 2026-10-12 (owner): fixed.** A well flagged with an error used to
   enter the pooled AVO scale when it carried an observed and a modelled A.
   It now stays out, and `compareAtWells` lists it in `excluded` with its
   reason.
2. **Decided 2026-10-12 (owner): fixed.** Only A was checked, so an observed B
   of null counted as 0 and pulled the scale toward zero (a NaN B made it
   NaN). A well now enters only with finite A and B, modelled and observed;
   one without them is listed in `excluded`. In QI Studio the A and B volumes
   share their null mask and a modelling error carries no modelled values, so
   real runs give the same scale as before (the Suite parity on the Ekene
   wells shows it).
3. The hold-fill in `waveletScale` cannot affect the result: the coverage mask
   (half + 1 samples either side) is exactly the operator's support.
4. `extractWellWavelet` treats only `Math.fround(1e30)` as dead, not a float64
   1e30. QI Studio's path sends nulls as JSON null (NaN), so it is safe.

## What the course can grade from these engines

The one scale that ties AVO volumes to the modelled A and B over the wells,
each well's residual and class agreement; the wavelet scale at the wells and
the blind-well table (correlation and AI error) for a stated inverter; the
Fatti angle reflectivity of a log set; the angle wavelets' synthetic
correlations.
