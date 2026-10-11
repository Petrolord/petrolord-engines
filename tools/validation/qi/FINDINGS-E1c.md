# FINDINGS: QI course gate E1c (2026-10-11)

The third wave of the NextGen QI course extraction gate (plan of record
`docs/scope/NextGen-QI-Course-PLAN.md` in the Suite, gaps G5, G6 and G8).
It covers `engines/qi/lfm.js`, the rest of `engines/qi/seismicQc.js` and
`engines/qi/prospectAssessment.js` at engines main `cc4c62d`.

**No engine defect.** Every function agrees with its independent oracle to
float noise (1e-10 relative or better; most to 1e-12). One convention is
documented (C1), one estimator property is recorded for the course authors
(C2), one doc comment is corrected (D1). No number QI Studio displays
changes: the only engine edit is a comment.

## The gate

| file | what it is |
|---|---|
| `oracle_qi_lfm.py` | stdlib; the horizon map as a KNOT TABLE evaluated by bisect (slope-one extensions outside the horizons); `sampleAt` in EXACT RATIONALS; IDW with explicit weights summed by `math.fsum`; the fill rule; the blind-well score by the two-pass centred correlation. Anchors L1 (a dipping layered earth is reproduced exactly with horizons and smeared without), L2 (closed-form IDW of constant wells, p = 1, 2, 3), L3 (an estimate 1.05 times the truth scores 5 percent, corr 1), L4 (identity map). |
| `oracle_qi_seismic_qc2.py` | stdlib; Harris (1978) Tukey window; a DIRECT O(N n) DFT (the engine uses a radix-2 FFT); the bin estimators the module header defines (parabolic peak with its vertex amplitude derived independently, first crossing below the level with linear interpolation, power centroid); every bin -6 dB edge cross-checked within one bin of the CONTINUOUS transform (DTFT and bisection); the Hatton, Worthington and Makin (1986) coherency S/N c / (1 - c), anchored on seeded traces against the REALISED S/N (within 30 percent; with no lag search on dipping traces it falls below 1); the footprint periodogram by direct DFT with the line removed in centred form. |
| `oracle_qi_prospect.py` | stdlib, does not import the mapping oracle; spill by a UNION-FIND over descending elevation (the closure engine floods with a heap); closures by breadth-first search per contact (the engine reads a flood prefix); GRV by explicit cell sums; the edge, implied contact, scatter, conformance and inside share from their definitions; evidence grouping; the decision table as an ordered rule list. Anchors P1 (paraboloid cap within 1 percent on a 12.5 m grid; the spill is the shallowest boundary node), P2 (a contact-bounded anomaly conforms above 0.95 and implies its contact within a cell; a flank patch does not, with five times the scatter), P3 (conformance falls monotonically with a tilted contact), P4 (one response counts once). |
| `__tests__/qi.lfm.golden.test.js`, `qi.seismicQc2.golden.test.js`, `qi.prospectAssessment.golden.test.js` | 58 tests; every assertion calls the shipped engine (the prospect gate on the shipped closure engine's `spillAnalysis`). |
| `negcontrol_e1c.sh` | 31 one-line planted defects across the three engines and 3 byte-identical regenerations: all caught. |

Cases: 65 horizon maps, 22 log samples, 6 LFM traces on four wells with
gaps, dipping horizons, a well at the trace, a well left out, powers 1 to 3
and constant time; 5 scores; 4 single-trace spectra (taper 0.1, 0.25, nulls,
no taper), one six-trace patch, the C1 case; 4 S/N cases (S/N 1, 4, 16,
dip, nulls, no lag search); 4 footprint slices; 5 conformance grids
(paraboloid with a flat contact, a flank patch, two tilted contacts, an
elliptic dome with a saddle, a deeper neighbour and a null hole); 4
evidence sets; 20 decision rows including every threshold edge.

The battery's first run had four survivors, each a blind case rather than a
weak engine: two were equivalent mutants on the cases then in the golden (a
read one past the log is missing either way; a taper width on n rather than
n - 1 only moves when alpha (n - 1) / 2 is not whole), one was a
two-sample score the cases never reached, and one planted a null energy too
small to see. The goldens now carry a sample a hundredth of a step from a
node, a two-sample and a three-sample score, and the C1 case gated at its
on-sample convention; the null plant reads a null as zero. All caught.

## C1. Convention: the taper ends on a sample

The engine's Tukey window uses W = floor(alpha (n - 1) / 2); Harris's
window uses W = alpha (n - 1) / 2. They are the same whenever
alpha (n - 1) / 2 is whole, which every gated spectrum is. For n = 300 and
alpha 0.1 (W 14.95 against 14) the -6 dB edges move by 0.044 Hz at most and
the centroid by 0.002 Hz (bin 0.49 Hz). The gate pins the engine to its own
convention at 1e-9 in that case and bounds the difference from Harris. Not
changed: changing it would move QC spectra QI Studio has shown.

## C2. Recorded for the course: a band edge is the FIRST crossing

The -6 and -20 dB edges are where the amplitude first falls below the level
either side of the peak bin, as the module header says. On a single trace
over sparse reflectivity the spectrum is notched, so an edge can sit at a
notch: in the C1 case the -20 dB low edge is 20.5 Hz with Harris's window
and 16.2 Hz with the engine's, from a taper change of one sample. The
average spectrum of a trace patch is far steadier. The QI capstone should
grade the -6 dB low edge and the centroid of the AVERAGE spectrum of the
supplied patch (as the plan already says), with the case traces given as
data, at the house floor.

## D1. Doc comment: how lfmTrace fills uncovered samples

The JSDoc said samples no well covers "hold the nearest covered value".
The code fills the samples before the first covered one with its value and
holds the last covered value through every later gap (inside a gap it does
not take the nearer side). The comment now says what the code does; the
code is unchanged.

## Not covered here

`amplitudeSpectrum` against the analytic Ricker stays in
`oracle_seismic_qc.py` (unchanged). `assessProspect`'s reason sentences are
copy, not graded; the gate checks the recommendation and the seismic
support. The footprint period is reported on the padded transform's bin
grid (N / k), so a 6-line stripe reads 5.95 on a 48-line profile: a
property of the estimator, pinned by the golden.
