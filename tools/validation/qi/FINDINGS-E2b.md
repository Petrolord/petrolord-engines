# FINDINGS: property calibration and prospect trap (E2, part B, 2026-10-11)

The fourth wave of the NextGen QI course extraction gate (gap G7, second
half): `engines/qi/propertyCalibration.js` (the calibration and left-out
check of QI Studio's Properties tab, including the widened porosity band of
Suite #987) and `engines/qi/prospectTrap.js` (the trap and anomaly of the
Prospects tab), both moved verbatim from the Suite.

**No engine defect. No engine line changed after the move.**

## The gate

| file | what it is |
|---|---|
| `oracle_qi_property_calibration.py` | stdlib; the upscale by prefix sums of finite samples and counts (half window rounded half up as JavaScript does; half-even is a caught plant); the mode filter by counters; least squares in exact rationals; the 80 percent Student t from the closed form for integer degrees of freedom (Abramowitz and Stegun 26.7.3, 26.7.4) inverted by bisection (the engine bisects the incomplete beta); the band t sqrt(s^2 (1 + 1/n + leverage) + sExtra^2); leave-one-out with the pooled RMS of the OTHER wells, sExtra = sqrt(rms^2 - s^2), coverage, bias, RMS and a centred Pearson in rationals; Gaussian facies with an explicit 2x2 inverse (the engine uses Cholesky), KDE with Scott's factor n^(-1/(d+4)); the posterior tables rebuilt from their specification and checked against the exact posterior. Anchors: t at nu = 1, 2, 5, 10, 30, 120 against printed tables (exact at 1 and 2), the normal limit at nu = 4000; an exact line with s = 0; hand values; a 1D KDE integrating to 1. Margins: coverage samples at least 8e-7 from a band edge, the chosen facies at least 3.6e-3 ahead of the runner-up |
| `oracle_qi_prospect_trap.py` | stdlib, does not import the mapping oracle; nearest node and crest climb by brute force over all live nodes and the 8 neighbours; the spill by UNION-FIND over decreasing elevation (the engine floods with a heap), the edge limit and merges; closures by breadth-first search over {z > contact} with GRV by explicit cell sums; the attribute read by its own bilinear weights on its own (offset, different cell) frame; patches by breadth-first components (the engine uses a stack); conformance, the contact held at the spill and the decision table with the map-edge rule. Float32 surfaces as the Suite's reader hands them; no tie decides a golden (asserted). Anchors: a fine paraboloid's area and GRV within 1 percent of pi R^2 and pi a R^4 / 2; a plain dome spills at its highest edge node |
| `__tests__/qi.propertyCalibration.golden.test.js`, `qi.prospectTrap.golden.test.js` | every assertion calls the shipped engine |
| `negcontrol_e2b.sh` | 31 planted defects (17 property, 14 trap), all caught; both goldens regenerate byte for byte |

## Observations

1. The posterior tables are approximations by design: against the exact
   posterior they read within 4.7e-6 (1D Gaussian), 3.2e-6 (1D KDE) and
   1.9e-3 (2D). A capstone posterior must be graded on `faciesPosterior`
   (exact), or carry a tolerance above the table error.
2. With the true AI the band still widens slightly (sExtra 1.2e-4 against s
   6.9e-4): left-out residuals exceed the in-sample scatter, as expected.

## What the course can grade from these engines

The transform, its 80 percent interval at a stated AI with one well left out
and the widened band (Q10 and Q90), left-out coverage, bias and correlation;
facies posteriors (exact path); the crest from a picked point, crest and spill
depths, the closure column height, area and GRV at spill, anomaly nodes,
conformance and the implied contact held at the spill.
