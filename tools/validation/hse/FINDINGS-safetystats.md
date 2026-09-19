# FINDINGS: safetyStats (oracle_safetystats.py, HSE H1)

Golden: `test-data/hse/goldens/safetyStats_cases.json`, 321 cases (22 of
them refusals), written by `tools/validation/hse/oracle_safetystats.py`.
Gate: `__tests__/hse.safetyStats.test.js` (353 tests) calls the engine on
every case. Negative control: `tools/validation/hse/negcontrol_safetystats.sh`.

The oracle is NOT stdlib: it needs scipy and mpmath (run here with scipy
1.18.1, mpmath 1.4.1 in a venv). That is deliberate: the brief asked for
scipy as the reference for the special functions, and mpmath at 50 digits
is the arbiter that scipy itself must agree with (to 1e-11 for quantiles,
1e-12 for P, Q and ln Gamma) before a golden is written.

## Sources, and which goldens are published

| golden | kind | source |
|---|---|---|
| `bls-trir-abc-company` 7 cases, 400,000 h, rate 3.5 | published | BLS, "How to compute a firm's incidence rate" (bls.gov/iif/overview/compute-nonfatal-incidence-rates.htm), read 2026-09-19: "(7 x 200,000) / 400,000 = 3.5" |
| `bls-dart-abc-company` 3 DART cases, rate 1.5 | published | same page: "(3 x 200,000) / 400,000 = 1.5" |
| `iogp-far-2024` 32 fatalities, 4,158,877 thousand h, FAR 0.77 | published | IOGP Safety performance indicators, 2024 data: section 1.2 (32 fatalities, FAR 0.77), Table 38A (hours) |
| `iogp-far-2023` 27, 3,291,382 thousand h, FAR 0.82 | published | same, section 1.2 and Table 38A |
| `iogp-far-2024-as-incidence-rate` | published | the same figure through `incidenceRate` with base 1e8 |
| `iogp-trir-2024` 3,071 recordables, 3,795 million h, TRIR 0.81 | published | same, sections 2.5 and 1.3. The hours are printed to the nearest million, so only the printed 2 decimals are checked against the report |
| `iogp-far-five-year-*` | published inputs, oracle value | IOGP rule (section 3.5 box): sum of fatalities 2020-2024 over sum of hours / 1e8. Inputs from Table 5 (14, 20, 33, 27, 32) and Table 38A; the pooled value, 0.8261, appears in the report only on a chart |
| `iogp-fir-2024` | oracle | 21 fatal incidents (section 1.2); no FIR printed in the text |
| every other case | oracle | constructed; values computed by the oracle |

Published checks are two-sided: the engine must match the oracle to 1e-12
AND round to the printed figure at its printed precision.

Definitions confirmed against the primary text, not from memory:

- 200,000 = 100 employees x 40 h/week x 50 weeks (BLS page, verbatim).
- IOGP: FAR per 100 million hours; TRIR = (fatalities + LWDC + RWDC + MTC)
  per million hours; LTIR = (fatalities + LWDC) per million hours
  (2024 report, definitions box). Five-year rolling average = sum of
  incidents over sum of hours (section 3.5 box).
- API RP 754 PSE rate = Tier n PSE count / total work hours x 200,000 or
  x 1,000,000, "consistent with the basis for calculating the Company's
  occupational injury rate"; aggregation by summing counts and hours
  (API Guide to Reporting Process Safety Events, 2022, section 3.3 and
  NOTE 2). **Erratum in the guide**: its Tier 2 per-1,000,000 line reads
  "Total Tier 1 PSE Count". The engine uses the Tier 2 count for Tier 2,
  which is plainly the intent.
- The Garwood interval, the conditional test and the u-chart were not
  re-read from a primary document during this work; they are stated from
  the standard statistical literature, and the oracle computes them from
  that statement independently (scipy chi2, binom, binomtest).

The oracle's 95 percent Garwood limits agree with the commonly tabulated
values (N=0: 0, 3.689; N=1: 0.0253, 5.572; N=2: 0.242, 7.225; N=3: 0.619,
8.767; N=5: 1.623, 11.668; N=10: 4.795, 18.390, as in Gehrels 1986). Those
figures were recalled, not transcribed from a document in hand, so they
are NOT carried as published goldens; they are a sanity check only.

## Agreement achieved (worst case over all goldens)

| function | tolerance gated | worst relative error seen |
|---|---|---|
| single, pooled, rolling rates, u-chart | 1e-12 | 0 (u-chart 1.4e-16) |
| logGamma | 1e-10 (1e-14 absolute at 0) | 2.0e-15 |
| regularizedGammaP / Q | 1e-10 | 3.1e-13 / 4.2e-13 (a = 500.5, 1000) |
| chiSquareQuantile / Upper | 1e-10 | 2.7e-14 / 1.2e-14 (df 1 to 2001, p 1e-10 to 0.995, q to 1e-12) |
| rateConfidenceInterval | 1e-10 | 6.6e-15 |
| compareRates | 1e-10 | 6.7e-13 (n = 5,835 events) |

## Judgement calls

1. **No default base.** `base` is required on every rate, and a missing
   base is refused by name, because OSHA TRIR (200,000) and IOGP TRIR
   (1,000,000) share a name and differ by a factor of five. FAR is the one
   function with a fixed base (1e8), because FAR has one definition.
2. **Sum then divide.** Pooled and rolling rates are sum(counts) x base /
   sum(hours), the IOGP five-year rule and API 754 NOTE 2. The mean of
   period rates is returned beside it as `meanOfPeriodRates`, labelled. On
   the IOGP 2020-2024 data it is 0.8332 against the true 0.8261; on the
   constructed 12-month case whose last window contains a 1,200-hour month
   with one event, the mean is 19.8 against a pooled 7.23 per 200,000 h.
3. **A month with no hours** contributes nothing to the pooled rate, has no
   rate of its own (null, never 0), and is left out of the mean of rates
   (`periodsWithoutHours` says how many). A window with no hours has a
   null rate and a `reason`. Events in a month with no hours are refused as
   bad data.
4. **Garwood interval**, central (alpha/2 per tail), lower limit 0 at
   N = 0. The upper limit is solved on the upper tail at alpha/2 directly,
   not as chi2(1 - alpha/2), because 1 - 0.025 is not exactly 0.975 in
   floating point; `chiSquareQuantileUpper` exists for that reason.
5. **Chi-square quantile.** Wilson-Hilferty start (the Numerical Recipes
   power-law start for shape <= 1), safeguarded Halley iterations inside a
   bisection bracket, solving on whichever tail is smaller. P and Q by the
   Numerical Recipes series and modified-Lentz continued fraction, ln Gamma
   by Lanczos (g = 7, n = 9).
6. **Comparing two rates: the conditional exact binomial test**
   (Przyborowski and Wilenski 1940): given n = N1 + N2, N1 ~ Bin(n, p0)
   with p0 = hours1 / (hours1 + hours2). Two-sided p-value by the CENTRAL
   rule (twice the smaller tail, capped at 1), and the rate-ratio interval
   from the Clopper-Pearson limits of p, RR = p / (1 - p) x hours2 / hours1.
   Central was chosen over R's and scipy's "minlike" rule because it is the
   test the Clopper-Pearson interval inverts, so p < alpha exactly when the
   interval excludes 1 (Fay 2010, R Journal 2(1)). The oracle asserts that
   property on its own numbers and the gate asserts it on the engine's. A
   reader comparing with R `poisson.test` will see a different p-value on
   some inputs; that is this choice, not a defect. Capped at 1,000,000
   total events (the tails are direct O(n) sums).
7. **Rate ratio with no events in group 2** is unbounded: `rateRatio` and
   `rateRatioUpper` are null with `upperUnbounded: true` and a `reason`,
   never Infinity. Both groups empty is refused.
8. **u-chart** (Montgomery, u chart with variable sample size): exposure
   units n_i = hours_i / base, centre sum(c) / sum(n), limits
   ubar +/- 3 sqrt(ubar / n_i), lower floored at 0 and flagged
   `lclFloored`. A point signals only STRICTLY outside its limits; the
   golden `uchart-points-on-the-limits` puts two points exactly on 2 and 0
   and pins that neither signals. A period with zero hours is refused (drop
   it first); an all-zero chart is refused (zero-width limits). The
   Montgomery textbook example was NOT reproduced: its numbers could not
   be recalled reliably, so every u-chart golden is oracle-derived.
9. **Severity rate** is kept but deliberately thin: days lost x base /
   hours with the base required. There is no single standard (OSHA-style
   practice uses 200,000; ANSI Z16.1 used 1,000,000 and added scheduled
   time charges for deaths and permanent disabilities, which are NOT added
   here; IOGP's "LWDC severity" is days per case, a different quantity).
   The docstring says so, and no published golden exists for it.
10. **API RP 754**: rate only, tier (1 or 2) is an input, base must be
    200,000 or 1,000,000. The threshold-quantity tables are not embedded.

Dropped: nothing from the brief. The IOGP LTIR 0.24 could not be made a
published golden because the report prints the LTI count only as a 31:1
ratio to fatalities.

## Negative control (run 2026-09-19)

Baseline 353 passed. Every ENGINE plant went RED, then the engine was
restored and the suite returned to 353 passed.

| plant (engine) | failed tests |
|---|---|
| rolling window: mean of monthly rates instead of sum-then-divide | 3 |
| pooled: mean of period rates instead of sum-then-divide | 3 |
| Garwood upper df 2N+2 -> 2N | 19 |
| Garwood lower df 2N -> 2N+2 | 14 |
| Garwood upper at alpha, not alpha/2 | 19 |
| gamma inversion always on the lower tail | 16 |
| gamma series stops at 1e-6 | 110 |
| Lanczos coefficient truncated to 13 figures | 2 |
| compare: one tail, not doubled | 8 |
| compare: Clopper-Pearson lower at alpha, not alpha/2 | 8 |
| compare: expected proportion from the wrong group's hours | 8 |
| u-chart: 2 sigma limits | 5 |
| u-chart: lower limit not floored | 3 |
| u-chart: a point ON the limit signals | 2 |
| u-chart: centre as the mean of the u_i | 3 |
| FAR on a 1,000,000 base | 5 |
| a silent default base of 200,000 | 2 |
| events in a month with no hours accepted | 1 |
| API 754 base check removed | 2 |

| plant (oracle, golden regenerated) | result |
|---|---|
| rolling: mean of monthly rates | RED, 2 |
| u-chart 2.5 sigma | RED, 4 |
| Garwood upper df 2N+2 -> 2N in the mpmath arbiter only | STOP: the scipy-versus-mpmath cross-check refused to write a golden |
| compare: one tail, not doubled | RED, 8 |

Honest reading of the thin rows: the Lanczos truncation (a 1e-13
relative change) is caught only by the two ln Gamma cases at exactly 0
(Gamma(1), Gamma(2)), because the 1e-10 gate on P, Q and the quantiles is
looser than the damage. That is the gate the brief set; tightening to
1e-12 would catch more but leave little headroom at large shapes (worst
seen 4e-13).

## Doubts

- The IOGP TRIR golden uses hours printed to the nearest million, so it
  anchors the formula and the printed 0.81, not IOGP's unrounded rate.
- `compareRates` hours and counts are constructed, not from a published
  comparison.
- ln Gamma by Lanczos loses relative accuracy in the prefactor
  exp(a ln x - x - ln Gamma(a)) as the shape grows: 4e-13 at a = 1000.
  Counts in the tens of thousands would still be far inside 1e-10, but
  that regime is gated only up to df 2001 (N about 1000).
