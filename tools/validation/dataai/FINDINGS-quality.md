# FINDINGS: quality (oracle_quality.py, Data & AI D1)

Golden: `test-data/dataai/goldens/quality_cases.json`, 406 cases (48 of
them refusals; 8 published NIST/SEMATECH anchors carrying 124 printed
figures), written by `tools/validation/dataai/oracle_quality.py`.
Second witness: `test-data/dataai/pins/quality_pins.json`, 348 pins
written by `tools/validation/dataai/pin_quality.py` (numpy 2.5.3, scipy
1.18.1, statsmodels 0.15.0, pandas 3.0.6, from `/root/daienv`).
Gate: `__tests__/dataai.quality.test.js` (913 tests) calls the engine on
every golden, every printed figure and every pin, plus property tests.
Negative control: `tools/validation/dataai/negcontrol_quality.sh`.

The oracle is STDLIB ONLY (python 3.12: `fractions`, `statistics`,
`math`, `unicodedata`, `random`). It reads no JavaScript and takes a
different road from the engine on every route (the table is in its
docstring): exact Fractions for means, medians, MADs, quantiles,
covariances and chart recursions; `statistics.quantiles` as a built-in
cross-check that stops the oracle if R6 or R7 quartiles disagree; the
Abramowitz and Stegun 26.7.3/26.7.4 closed-form t distribution (integer
df) and closed-form chi-square survival functions, both inverted by
bisection, where the engine uses a continued-fraction incomplete beta and
the safetyStats Halley inversion. Regeneration of the golden and the pins
is byte-identical (sha256 checked).

## Sources, and which goldens are published

All read 2026-09-23 at itl.nist.gov/div898/handbook (NIST/SEMATECH
e-Handbook of Statistical Methods).

| golden | printed figures | section |
|---|---|---|
| `nist-6.3.2.2-individuals-flowrate` | xbar 50.81, MRbar 1.8778, UCL 55.8041, LCL 45.8159, the nine moving ranges | 6.3.2.2 Individuals Control Charts |
| `nist-6.3.2.4-ewma` | UCL 52.5884, LCL 47.4115, EWMA_0 = 50 and all 20 EWMA values (2 dp) | 6.3.2.4 EWMA Control Charts |
| `nist-6.3.2.3-cusum-tabular` | x - 325, S_hi, S_lo and the cumulative sum for all 20 groups; first signal at group 14 | 6.3.2.3 CUSUM Control Charts, tabular form |
| `nist-1.3.5.17.1-grubbs-max` | G = 2.4687, one-sided critical value 2.032 at alpha 0.05, reject | 1.3.5.17.1 Grubbs' Test (uranium isotope data, Tietjen and Moore) |
| `nist-1.3.5.17-zscore-uranium` | largest \|z\| = G = 2.4687 | 1.3.5.17 and 1.3.5.17.1 |
| `nist-7.2.6.2-p90-R6/R7/R8` | 95.1981, 95.1957, 95.1972 | 7.2.6.2 Percentiles (silicon wafer resistivities) |

Definitions taken from the primary text, not from memory: the z-score on
the sample mean and sample SD, and the modified z-score
M = 0.6745 (x - median) / MAD with the 3.5 label (1.3.5.17); MAD as the
raw median of |x - median| and the sample SD with n - 1 (1.3.5.6);
d2 = 1.128 for n = 2 (6.3.2.2); D4 = 3.267, D3 = 0 for n = 2 (6.3.2.1
table); EWMA_0 = the historical mean or target and the asymptotic
variance lambda / (2 - lambda) s^2 (6.3.2.4); the tabular CUSUM
recursions with S(0) = 0 and "exceeds h" (6.3.2.3); the R6, R7 and R8
percentile rules (7.2.6.2); Grubbs' G and critical region (1.3.5.17.1).

Everything else in the golden is `"source": "oracle"`: constructed
oilfield-flavoured inputs (Ekene-style well names, a bulk density
series, daily rates, a porosity-density cloud), values computed by the
oracle.

## Agreement achieved

Engine against the stdlib oracle, worst relative error over all goldens
(gate: 1e-12 relative, 1e-10 for the special functions, absolute floor
1e-12):

| function | worst relative error |
|---|---|
| completeness | 0 |
| coverage | 0 |
| cumulativeCheck | 0 |
| cusumChart | 6.1e-13 |
| duplicateIdentifiers | 0 |
| ewmaChart | 3.7e-16 |
| frozenRuns | 0 |
| grubbsTest | 5.8e-14 |
| hampel | 3.5e-15 |
| indexCheck | 0 |
| individualsChart | 1.7e-16 |
| iqrFences | 2.6e-15 |
| levenshtein | 0 |
| mahalanobis | 3.8e-14 |
| modifiedZScores | 2.6e-14 |
| phaseSumCheck | 0 |
| rangeCheck | 0 |
| rateCheck | 0 |
| regularizedBeta | 2.2e-14 |
| sampleQuantile | 2.5e-16 |
| scorecard | 1.1e-16 |
| studentTUpperQuantile | 5.1e-11 |
| waterCutCheck | 0 |
| zScores | 1.1e-13 |

Stdlib oracle against the libraries (printed by `pin_quality.py`): worst
5.1e-11 on the t quantile (at q = 1e-6, where the closed-form tail
1 - A(t) loses digits to cancellation; inside the 1e-10 gate), 6.1e-14 on
the Grubbs critical value, 1.4e-14 on the incomplete beta, 2e-15 or
better on quantiles, z, MAD, Mahalanobis and the individuals chart.

## Printed-figure errata found while anchoring

1. **Grubbs G (1.3.5.17.1)**: G = 2.468765; NIST prints 2.4687, which is
   truncated (rounded it is 2.4688). The published check allows one unit
   in the last place for this figure and for the matching max \|z\|.
2. **EWMA LCL (6.3.2.4)**: NIST rounds sqrt(0.3/1.7) to 0.4201 before
   multiplying; unrounded the LCL is 47.411568 and prints 47.4116, not the
   47.4115 shown. One unit in the last place is allowed; the UCL 52.5884
   agrees either way.
3. **CUSUM table (6.3.2.3)**: the printed "325 - k - x" column has a sign
   typo at groups 9 and 12 (0.54 and 0.47 where the arithmetic gives
   -0.5425 and -0.4675; S_lo in the same rows follows the negative
   values). That column is not an engine output and is not checked. Two
   printed S_hi values sit on rounding ties (14.445, 19.035), so the CUSUM
   figures are checked to half a unit in the last place.
4. **CUSUM design (6.3.2.3)**: the page designs k and h from alpha =
   0.0027, beta = 0.01, delta = 1 with k = delta sigma / 2 and
   h = (2 / delta^2) ln((1 - beta) / alpha) k, then uses h = 4.1959. The
   printed formula gives h = 3.749; with alpha / 2 it gives 4.1896.
   Neither is 4.1959, so the engine has NO alpha/beta design helper: k and
   h are inputs, and the table is reproduced from the printed k and h.

## Judgement calls (conventions the oracle cannot check)

1. **Missing** is null, undefined or NaN; +/-Infinity is refused as
   invalid, never treated as missing. Outlier functions skip missing
   values and report at the ORIGINAL index; the control charts refuse a
   series with gaps (a moving range across a gap is not a moving range).
2. **Strict thresholds everywhere.** A value exactly on a limit is not
   flagged (\|z\| > 3, \|M\| > 3.5, outside the fences, CUSUM "exceeds h",
   Hampel's strict inequality, d^2 > cutoff). Goldens pin this where the
   arithmetic is exact in binary: `iqr-exactly-on-both-fences` (n = 9, R7
   quartiles are order statistics, fences -4 and 12 are data values),
   `cusum-exactly-on-h` (S_hi = 4.0 = h) and `hampel-on-the-threshold`.
   The Hampel case has one subtlety: the engine sees \|x - median\| equal
   to 1 x 1.4826 x 1 in floats, while the oracle, holding 1.4826 as an
   exact decimal, sees the float 1.4826 fall just short of it. Both say
   "not a spike"; the negative control shows the case still turns red
   when the petrophysics comparison becomes >=.
3. **Sample SD (n - 1)** for z-scores and Grubbs, as NIST defines them;
   population SD is an option for z. The result reports the ceiling for
   the CHOSEN SD, (n - 1) / sqrt(n) sample or sqrt(n - 1) population, and
   whether the threshold is reachable (ceiling > threshold, strict): at
   n = 10 with the sample SD no point can pass \|z\| > 3
   (`z-unreachable-at-n10`), which the modified z catches (`modz-at-n10`);
   with the population SD the ceiling at n = 10 is exactly 3. (Before the
   foundation repair the population ceiling was wrong; see the section
   below.)
4. **Modified z uses 0.6745 as printed**, not 1 / 1.4826 = 0.674490 (the
   7e-5 difference is caught by the gate). MAD = 0 is refused (MORE than
   half the present values equal the median; exactly half is not enough,
   see the zero-MAD wording repair below); no fallback is invented.
5. **Quantiles.** R6 (NIST default), R7 (Excel, R, numpy default) and R8,
   exactly as 7.2.6.2 states them, clamped to the extremes. Tukey fences
   default to R7 so a learner can reproduce them in a spreadsheet.
   `lib/stats` quantile was NOT reused for quartiles: its simple-statistics
   rule (inverse ECDF, averaging only at an even length) is none of R6,
   R7, R8. `lib/stats` median IS reused (the ordinary median for every n),
   as are its mean and SDs.
6. **Hampel** is the petrophysics conditioning semantics by import:
   `despikeHampel` makes the decision (window 2 x halfWindow + 1 truncated
   at the ends, missing values never enter a window, fewer than three
   present samples means not judged, 1.4826 x MAD, strict). The engine
   converts missing values to NaN before the call (Open question 1).
7. **Grubbs** is included, one-sided and two-sided, for ONE outlier; NIST
   points to the generalised ESD test for several, which is not built.
   `grubbs-rhob-two-spikes` shows the masking a second spike causes.
8. **Mahalanobis** uses the classical mean and the sample covariance
   (n - 1), cutoff `chiSquareQuantile(1 - alpha, p)` imported from
   `engines/hse/safetyStats.js`, alpha = 0.025 by default. Rows with a
   missing value are skipped and listed. A robust (MCD) covariance is out
   of scope and the basis says the estimate is classical.
9. **Individuals chart**: d2 = 1.128 and D4 = 3.267 as printed (the exact
   d2 is 2 / sqrt(pi) = 1.12838); centre and MRbar default to the data's
   own averages, either may be supplied as a standard.
10. **EWMA**: target and sigma are REQUIRED (NIST takes them from
    historical in-control data; estimating them from the monitored data
    would absorb the shift being looked for). Asymptotic limits by
    default, exact time-varying limits as an option.
11. **CUSUM**: `units` is required ('sigma' or 'data') so k = 0.5 can
    never be silently read in the wrong unit; no reset after a signal, as
    in the NIST table.
12. **Range limits are definitional only** (fractions in [0, 1], rates
    and cumulatives not negative, resistivity, density, slowness and
    caliper positive, temperatures not below absolute zero, per unit). No
    plausibility ranges for gamma ray, density and so on are shipped: they
    would be invented numbers; the caller supplies them. Units are never
    converted; an unlisted unit is refused.
13. **Index checks**: a duplicate is a value equal to ANY earlier value
    (so `[1, 2, 3, 2, 4]` is both a duplicate and a reversal at entry 3);
    the expected step defaults to the median of the steps in the stated
    direction; the step tolerance defaults to 1e-6 x the expected step.
14. **Water cut** is on a liquid basis, water / (oil + water); no check
    when there is no liquid.
15. **Petrolord defaults, stated in each basis and open to change**:
    phase-sum tolerance 0.5 percent of the TOTAL (not the sum); frozen-run
    minimum 5 samples at zero tolerance, each value compared with the
    run's FIRST value so a slow drift is not a frozen run.
16. **Identifiers**: NFKD, trim, upper case, keep A-Z and 0-9, strip
    leading zeros in each digit group; near duplicates are Levenshtein
    distance 1 (default) on the normalised forms AND the same digit
    sequence, so EKENE-1 and EKENE-2 (two real wells) are not near
    duplicates while EKNE-1 and EKENE-1 are. Pairs are reported under
    their strongest class only, in (i, j) order.
17. **Scorecard**: a dimension score is `score` or 1 - failed / checked;
    equal weights unless weights are given for every listed dimension,
    then normalised by their sum; weakest = lowest score, ties to the
    first listed. No grade bands (they would be invented numbers).
18. **Coverage**: a step between consecutive present samples covers the
    index between them when it is at most `maxStep` (inclusive); the
    stretch before the first and after the last present sample is a hole.
19. **Reason strings print the shortest round-trip decimal** (ECMAScript
    Number to String): every figure parses back to exactly the number in
    the flag or result it quotes, and every figure a reason quotes is a
    numeric field (see the foundation repair below).

## Foundation repair (fix/dataai-quality-foundation-findings, 2026-09-23)

The D1 course foundation found three engine defects after PR #248. All
three are fixed in one PR, before any lesson was written.

1. **Population-SD z ceiling.** `zScores({ sd: 'population' })` reported
   the SAMPLE ceiling (n - 1) / sqrt(n) as `maxPossibleAbsZ` and decided
   `thresholdReachable` from it. The population ceiling is sqrt(n - 1).
   Repro: nine zeros and a one, threshold 2.9: the engine said
   unreachable (ceiling 2.846) while flagging the one at z = 3. Now the
   ceiling follows the chosen SD and `basis.ceiling` names the form. The
   oracle does not copy either formula: it builds the extreme sample
   (n - 1 zeros and a one, the configuration that attains the largest
   \|z\|, Shiffler 1988), takes its z^2 in Fractions from the definition,
   checks it against both closed forms or stops, and decides
   reachability on exact squares. scipy's `zscore` on the same extreme
   sample is pinned as the second witness. Goldens that discriminate:
   `z-population-ceiling-reachable` (the repro), `z-sample-same-data-
   unreachable`, the exact-ceiling boundaries `z-population-on-the-
   ceiling-n10` (3), `z-population-on-the-ceiling-n5` (2),
   `z-sample-on-the-ceiling-n16` (15/4), `z-sample-on-the-ceiling-n4`
   (3/2), and just inside: `z-population-below-the-ceiling-n5` (1.9, over
   the sample ceiling 1.789) and `z-sample-below-the-ceiling-n16` (3.7).
   A property test checks, for n in {4, 5, 10, 16, 25} and both SDs, that
   `thresholdReachable` equals "the extreme value is flagged" just under
   and just over the ceiling.
2. **Reason figures rounded to 6 significant figures.** `fmt` printed
   `Number(x.toPrecision(6))`, so a cumulative of 1338506.2 printed as
   1338510 and the two figures in a `cumulative-decrease` reason
   (1338510, 1331010) disagreed with the `drop` field (7496.7). **Rule
   chosen: the shortest round-trip decimal** (ECMAScript Number to
   String): every printed figure parses back to exactly the double it
   quotes, whatever its magnitude. Fixed 6 decimals was rejected because
   it prints the default index step tolerance (1e-6 x a 0.5 step =
   5e-7) as 0.000001 and anything smaller as 0. Consequences: computed
   statistics print every digit their float carries (for example
   z = 2.9999999999999996); the application rounds for display from the
   numeric fields. Exponent form below 1e-6 and from 1e21 up
   (`1.5e-7`), as ECMAScript prints it. Every reason template in the
   file was audited (they all go through `fmt`; integers are indices,
   run lengths and edit counts). Where a reason quoted a figure that was
   in no field, the field was added: `cumulative-decrease` gains `value`
   and `previous`; `reversal` and `irregular-step` gain `value`,
   `previous`, `previousIndex`; `hampel` flags gain `median`, `deviation`
   and `threshold`; the Mahalanobis result gains `level` (1 - alpha).
   Gates: the oracle pins the exact reason text for completeness,
   coverage, range, rate, cumulative, frozen-run and the index
   missing/duplicate/reversal rules, laying numbers out by its own
   implementation of ECMA-262 Number::toString from Python's shortest
   digits (with fixed-point self-checks that stop it); new large-value
   goldens `cumulative-large-values`, `range-large-values`,
   `rate-large-values`, `frozen-large-value`, `coverage-large-index`,
   `index-large-depths`, `hampel-large-values-n2.5`; and a jest property
   that every figure in every reason of every golden output is EXACTLY
   (===) a numeric field of the flag, the result, its basis or a
   published constant (duplicate-identifier reasons, which quote
   identifiers containing digits, are pinned by their golden text only).
   Reasons for computed statistics (z, M, EWMA, CUSUM, Grubbs, d^2) are
   not pinned as text: the oracle's exact road and the engine's float
   road can differ in the last bit, and the round-trip text shows it.
   The property test covers them instead.
3. **Hampel `nSigma` not echoed.** The result now carries `halfWindow`
   and `nSigma`, and the basis carries `halfWindow`, `nSigma` and
   `madScale` (1.4826); the oracle emits them and every Hampel golden
   gates them.

Public output changes a course must re-cut against: every reason string
with a non-integer or 7+ digit figure (text only; rules, indices and
numeric fields unchanged); `zScores` with `sd: 'population'`
(`maxPossibleAbsZ` = sqrt(n - 1), `thresholdReachable`, basis `ceiling`
and `note`); new fields listed above. No flag decision changed: the fix
touches reporting, not which points are flagged.

The two carried open questions stay OPEN (not changed here): the
petrophysics `despikeHampel` null to 0 conversion (open question 1,
since audited as not live, see below) and the absolute pivot test in
`lib/linalg/solveDense` (open question 2).

## Zero-MAD wording repair (2026-09-23, fix/dataai-zero-mad-wording)

Found by the D1 Professional key-truth audit. The modified z refusal
said MAD = 0 when "at least half the present values equal the median".
That is necessary but not sufficient: `modifiedZScores` on
`[1, 5, 5, 9]` returns median 5 and MAD 2 (the deviations are
4, 0, 0, 4, whose median is 2), with exactly half on the median and no
refusal. The exact condition, for odd and even counts, is that MORE
than half the present values equal the median (odd n: at least
(n + 1) / 2; even n: at least n / 2 + 1). Proof sketch: the sorted
absolute deviations are non-negative, so their median is 0 exactly when
the middle one (odd n) or both middle ones (even n) are 0, which needs
more than n / 2 zeros; a zero deviation is a value on the median.
Checked exhaustively in the oracle's exact arithmetic for every series
of length 1 to 7 over a 4-value alphabet (21,844 series, 0 mismatches),
and on the engine at `[1, 5, 5, 9]` (MAD 2), `[1, 5, 5, 5, 9, 9]`
(MAD 2), `[5, 5, 5, 6, 7]` and `[1, 5, 5, 5, 5, 9]` (both refused).

- Engine message, old: `values have MAD = 0: at least half the present
  values equal the median, so the modified z-score is undefined`.
  New: `values have MAD = 0: more than half the present values equal the
  median, so the modified z-score is undefined`. The refusal DECISION
  was already right (it tests the computed MAD); only the text changed.
  The same gloss in the `despikeHampel` comment
  (`engines/petrophysics/conditioning.js`) is corrected; comment only.
- Oracle: `o_modz` now decides the refusal from its own exact MAD,
  asserts that decision equals the counting condition (more than half
  on the median), and returns the refusal text, which the golden pins
  (`expected.message`); the jest harness checks the engine prints it
  exactly. Other refusals still pin field only.
- New goldens: `modz-exactly-half-on-median-n4` `[1, 5, 5, 9]` (MAD 2,
  scored), `modz-exactly-half-on-median-n6` `[1, 5, 5, 5, 9, 9]`
  (MAD 2, scored), `modz-mad-zero-bare-majority-n5` `[5, 5, 5, 6, 7]`
  (refused), `modz-mad-zero-n-over-2-plus-1-n6` `[1, 5, 5, 5, 5, 9]`
  (refused); `modz-mad-zero` now carries the message. The two scored
  cases gain 6 second-witness pins (numpy median, scipy and statsmodels
  MAD = 2).
- Negative control: two engine plants (the old wording; refusing at
  "at least half" on the median) and three oracle plants (old wording;
  refusing at "at least half"; the cross-check stated as "at least
  half") in the tables below.

Course impact: any lesson, bank item or help text that glosses zero MAD
as "at least half equal the median" is wrong in the same way and must
say "more than half".

## Negative control (re-run 2026-09-23 after the foundation repair)

Baseline 903 passed. Every ENGINE plant went RED (41/41), then the files
were restored and the suite returned to 903 passed. Re-run after the
zero-MAD wording repair (same day): baseline 913 passed, ENGINE plants
43/43 RED, restored to 913 passed; the five zero-MAD rows are the last
rows of each table. The five plants for
the foundation repair and the three matching oracle plants are at the
end of each table. The first run found
two GREEN plants (phase-sum tolerance taken on the sum; Hampel on the
threshold counted as a spike); the goldens `phasesum-tolerance-on-the-total`
and `hampel-on-the-threshold` were added to close them, and the table
below is the re-run.

| plant (engine) | result |
|---|---|
| completeness: null fraction over present, not n | RED, 4 failed |
| coverage: a step equal to maxStep is a hole | RED, 4 failed |
| index: duplicates only when adjacent | RED, 2 failed |
| range: exclusive bound treated as inclusive | RED, 2 failed |
| rate: hours on 0 not read as shut in | RED, 2 failed |
| cumulative: meter tolerance ignored | RED, 1 failed |
| water cut on an oil basis | RED, 2 failed |
| phase sum tolerance relative to the sum, not the total | RED, 1 failed |
| frozen run compares with the previous value (lets a drift through) | RED, 1 failed |
| Levenshtein substitution costs 2 | RED, 5 failed |
| normalisation keeps leading zeros | RED, 7 failed |
| near duplicates ignore the digit rule | RED, 3 failed |
| quantile R7 computed as R6 | RED, 64 failed |
| z-score defaults to the population SD | RED, 36 failed |
| modified z scale 1/1.4826 instead of the printed 0.6745 | RED, 4 failed |
| modified z on a scaled MAD | RED, 13 failed |
| Tukey k = 2 by default | RED, 7 failed |
| a value on the fence is flagged | RED, 1 failed |
| Hampel window one sample wider | RED, 4 failed |
| Hampel (petrophysics): a point on the threshold is a spike | RED, 1 failed |
| incomplete beta continued fraction stops at 1e-6 | RED, 146 failed |
| Grubbs two-sided at alpha/N, not alpha/(2N) | RED, 27 failed |
| Grubbs t on N - 1 degrees of freedom | RED, 43 failed |
| Mahalanobis population covariance | RED, 12 failed |
| Mahalanobis cutoff on p + 1 degrees of freedom | RED, 10 failed |
| individuals d2 = 1.13 | RED, 5 failed |
| MR chart D4 = 3 | RED, 3 failed |
| individuals 2-sigma limits | RED, 5 failed |
| EWMA starts at the first observation | RED, 26 failed |
| EWMA variance factor lambda/2 instead of lambda/(2 - lambda) | RED, 8 failed |
| EWMA exact limits exponent t, not 2t | RED, 3 failed |
| CUSUM without the max(0, .) floor | RED, 27 failed |
| CUSUM signals AT h | RED, 2 failed |
| CUSUM sigma units ignored | RED, 3 failed |
| scorecard weights not normalised | RED, 6 failed |
| scorecard tie goes to the last listed | RED, 2 failed |
| z ceiling uses the sample form for the population SD too | RED, 12 failed |
| reason figures rounded to 6 significant figures | RED, 9 failed |
| reason figures rounded to 6 decimal places | RED, 3 failed |
| Hampel nSigma not echoed in the result | RED, 7 failed |
| Hampel nSigma not echoed in the basis | RED, 7 failed |
| zero-MAD refusal says at least half (the old wording) | RED, 3 failed |
| zero-MAD refused at least half on the median | RED, 8 failed |

| plant (oracle, golden regenerated) | result |
|---|---|
| oracle modified z scale 0.675 | RED, 4 failed |
| oracle CUSUM without the floor | RED, 4 failed |
| oracle R7 as R6 (statistics.quantiles cross-check) | STOP: the statistics.quantiles cross-check refused to write a golden |
| oracle Grubbs t on N - 1 df | RED, 14 failed |
| oracle z ceiling closed form sample-only | STOP: the ceiling cross-check refused to write a golden |
| oracle z ceiling from the sample variance for both SDs | STOP: the ceiling cross-check refused to write a golden |
| oracle number layout switches to exponent form one decade late | STOP: the layout self-check refused to write a golden |
| oracle zero-MAD refusal says at least half (the old wording) | RED, 3 failed |
| oracle refuses at least half on the median | RED, 2 failed |
| oracle cross-check states at least half | STOP: the zero-MAD counting cross-check refused to write a golden |

## What could not be verified

- Iglewicz and Hoaglin (1993), Hampel (1974), Grubbs (1969) and
  Montgomery were not read directly; their methods are taken as NIST
  states them (and, for Hampel, as the petrophysics engine implements
  it). The modified z, Hampel, Mahalanobis, completeness, validity,
  consistency, uniqueness and scorecard goldens are oracle-derived: no
  published worked example with printed numbers was found for them.
- The CUSUM h = 4.1959 on the NIST page cannot be derived from its own
  printed design formula (errata 4).
- The t quantile at q = 1e-6 agrees with scipy to 5e-11 only (limited by
  the oracle's closed form); smaller tails are not gated.

## Open questions for the lead

1. **`despikeHampel` turns null into 0. AUDITED 2026-09-23: NOT LIVE,
   engine unchanged.** It starts from `Float64Array.from(x)`, and
   `Float64Array.from([null])` is `[0]`, so a caller that passes null for
   a missing sample gets 0 at that position in the OUTPUT. (Correction to
   the earlier wording here: the null does not enter any window. The
   window reads the input `x`, where `Number.isFinite(null)` is false,
   so neighbouring decisions are unaffected; only the returned array
   carries the 0.) Direct call, windows 2 and 3 sigma:
   `[50, 52, null, 51, 400, 53, null, 50, 52, 51, 50]` returns
   `[50, 52, 0, 51, 53, 53, 0, 50, 52, 51, 50]`.

   Every caller was audited (engines, Suite main 113d4caf6, NextGen main
   and the `feat/d1-dataqc-course` branch):
   - engines: `engines/dataai/quality.js` `hampel` maps missing to NaN
     before the call and maps NaN back to null in `cleaned`. No other
     engine imports `conditioning.js` (the facilities "conditioning"
     hits are gas conditioning and matrix condition numbers).
   - Suite: the only production caller is Petrophysics Studio
     `components/ConditioningDialog.jsx` (Despike op), fed from
     `wellData.curves`. Every curve there is a typed array: the registry
     backend `downloadCurve` (`src/lib/wellsRegistry.js`) returns a
     `Float32Array` of the stored float32 bytes, LAS import
     (`welldata/lasImport.js` `prepareLogs`) writes nulls as NaN into a
     `Float32Array`, and the harness in-memory backend maps null to NaN
     into a `Float64Array`. A typed array cannot hold null. Repro through
     that path: a LAS 2.0 file with `NULL. -999.25` at two GR samples,
     `parseLas` then `prepareLogs` then `despikeHampel(gr.data, 2, 3)`
     returns NaN at both null samples (and 53 for the 400 spike), the
     same as the engine intends. The harness backend's curves were
     checked: all `Float64Array`, 0 null entries. The Data Quality Studio
     reaches it only through `quality.hampel`, covered above.
   - NextGen: vendors `conditioning.js` but nothing imports it. The live
     courses mention despiking only as prose (porepressure beginner m06
     l01, seismolord beginner m02 l04 describes the separate 3-point
     median in `seismolord/synthetics.js`, seismolord intermediate m05
     l02, welltest intermediate m01 l01, plus bank questions in the
     dc11, dc19 and rc7 migrations); none quotes a `despikeHampel`
     output. The D1 `dataqc` branch quotes Hampel figures through
     `quality.hampel`, which is unaffected.

   Contract for any future caller: pass NaN for a missing sample (or go
   through `quality.hampel`). If a caller ever needs to pass plain JS
   arrays with null, fix the engine then (seed `out` with NaN for
   non-finite inputs) with a golden and a negcontrol plant.
2. **`solveDense` singular test is absolute** (pivot below 1e-14). For
   Mahalanobis on variables with very small variance (below about 1e-7
   in the caller's units) a well-conditioned covariance could be refused
   as singular. Rescaling in the caller avoids it; a relative pivot test
   in `lib/linalg` would be the proper fix, not made here.
3. The Petrolord defaults in judgement call 15 and the Mahalanobis alpha
   0.025 are choices, not standards; the course should present them so.
4. Generalised ESD (several outliers) and a robust covariance for
   Mahalanobis are the natural additions if the course wants them.
