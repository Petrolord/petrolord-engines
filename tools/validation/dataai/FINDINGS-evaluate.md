# FINDINGS: evaluate (oracle_evaluate.py, Data & AI D5, applied AI evaluation)

Golden: `test-data/dataai/goldens/evaluate_cases.json`, 282 cases (107 of
them refusals, every refusal message pinned in full), written by
`tools/validation/dataai/oracle_evaluate.py`. Second witness:
`test-data/dataai/pins/evaluate_pins.json`, 2,382 pins and 20 recorded
skips, written by `tools/validation/dataai/pin_evaluate.py` (numpy 2.5.3,
scikit-learn 1.9.1 from `/root/daienv`). Gate:
`__tests__/dataai.evaluate.test.js` (2,707 tests) calls the engine on every
golden and every pin, plus property tests, the fixture checks and the caps.
Negative control: `negcontrol_evaluate.sh` (68/68 engine plants red, 6/6 oracle plants caught: 5 red and 1 stopped). Timing:
`timing_evaluate.mjs` (table below). Fixtures:
`test-data/dataai/ekene-docs/`, written by `make_evaluate_fixtures.py`.

No language model runs anywhere in this engine, its fixtures or its gates.
Every graded number is deterministic.

The oracle is STDLIB ONLY (python 3.12: `fractions`, `decimal` at 50
digits, `collections`). It reads no JavaScript and takes a different road
on every route (table in its docstring): tokens by a character loop over
code points, where the engine splits with a regular expression; BM25 and
TF-IDF in Decimal with `ln` and `sqrt`, dense per document, where the
engine walks postings lists in float; the 12-digit tie key by Decimal
quantize; every retrieval metric, the extraction tallies, kappa and the
whole calibration table in exact Fractions (the Murphy identity closes to
exactly 0 and the oracle asserts it before writing); SQuAD normalisation and
the claim grammar by hand-written character scanners, where the engine
uses regular expressions; mulberry32 in 32-bit integers with the draw index
(k n) >> 32 and exact replicate means.

**Ambiguity guard.** The oracle refuses to write a case where a double
could take a different branch from the exact value: a score within 1e-14
(relative) of a 12-digit rounding boundary when another score shares the
key or the alternative key; a bootstrap quantile index whose wholeness
differs between float and exact arithmetic; a probability within 1e-12 of
a bin edge it does not equal. One rule is taken from the double on purpose:
the sign of a paired-bootstrap replicate whose exact value is within 1e-9
of 0 (the engine counts `v <= 0` on its double, so `shareAtOrBelowZero` is
defined on the double; the oracle replays the double sum only for those
replicates).

## Sources

- Robertson, S. and Zaragoza, H. (2009) The Probabilistic Relevance
  Framework: BM25 and Beyond. Foundations and Trends in Information
  Retrieval 3(4), 333-389 (Okapi BM25, k1, b, the k3 query-frequency term).
- Apache Lucene `BM25Similarity` (idf = ln(1 + (N - df + 0.5) / (df + 0.5)),
  the non-negative idf; Lucene 8 dropped the (k1 + 1) numerator factor).
- scikit-learn 1.9.1 `TfidfVectorizer` / `TfidfTransformer` documentation
  (smooth idf ln((1 + n) / (1 + df)) + 1, l2 rows, sublinear_tf 1 + ln tf).
- Manning, C. D., Raghavan, P. and Schutze, H. (2008) Introduction to
  Information Retrieval, Cambridge University Press, chapter 8 (precision
  and recall at k, MAP, MRR).
- Jarvelin, K. and Kekalainen, J. (2002) Cumulated gain-based evaluation of
  IR techniques. ACM TOIS 20(4), 422-446 (DCG, nDCG, the log2 discount).
- Burges, C. et al. (2005) Learning to rank using gradient descent, ICML
  (the 2^g - 1 gain).
- trec_eval (the NIST TREC evaluation tool): relevance level 1 by default,
  P@k divides by k, AP divides by every relevant judged document, queries
  without a relevant document are dropped unless asked.
- Rajpurkar, P. et al. (2016) SQuAD: 100,000+ questions for machine
  comprehension of text, EMNLP; Rajpurkar, P., Jia, R. and Liang, P. (2018)
  Know what you don't know: unanswerable questions for SQuAD, ACL; the
  SQuAD 2.0 evaluation script (`normalize_answer`, `compute_exact`,
  `compute_f1`). The oracle is written from the described steps; the script
  is not copied.
- Cohen, J. (1960) A coefficient of agreement for nominal scales.
  Educational and Psychological Measurement 20(1), 37-46; Cohen, J. (1968)
  Weighted kappa. Psychological Bulletin 70(4), 213-220.
- Brier, G. W. (1950) Verification of forecasts expressed in terms of
  probability. Monthly Weather Review 78(1), 1-3; Murphy, A. H. (1973) A new
  vector partition of the probability score. Journal of Applied Meteorology
  12, 595-600; Stephenson, D. B., Coelho, C. A. S. and Jolliffe, I. T.
  (2008) Two extra components in the Brier score decomposition. Weather and
  Forecasting 23(4), 752-757 (the within-bin variance and covariance that
  make the decomposition exact).
- Guo, C., Pleiss, G., Sun, Y. and Weinberger, K. Q. (2017) On calibration
  of modern neural networks, ICML (ECE, MCE, reliability diagrams).
- Efron, B. and Tibshirani, R. J. (1993) An Introduction to the Bootstrap,
  Chapman and Hall (the percentile interval); Koehn, P. (2004) Statistical
  significance tests for machine translation evaluation, EMNLP (the paired
  bootstrap over test items).
- numpy `histogram` documentation (half-open bins, the last closed): the
  edge rule the lead chose.

**Licences.** The stop list is scikit-learn's `ENGLISH_STOP_WORDS`
(`sklearn/feature_extraction/_stop_words.py`, scikit-learn 1.9.1, SPDX
BSD-3-Clause; the file says the list is taken from the Glasgow Information
Retrieval Group list,
http://ir.dcs.gla.ac.uk/resources/linguistic_utils/stop_words). It is
embedded in `evaluate.js` with its source and licence named in the comment
above it, and typed again in the oracle (a gate checks 318 words).
BSD-3-Clause permits redistribution of the list with the notice. No public
dataset is used: every document, judgment, answer, label and probability is
ours and synthetic.

## Fixtures (synthetic, ours)

`test-data/dataai/ekene-docs/` (README there), written by
`make_evaluate_fixtures.py`, byte-identical on re-run:

| file | size | contents |
|---|---|---|
| corpus.json | 60 passages | end of well summaries (6), geology (3), PVT (3), pressure surveys (7), production notes (14), injection (4), daily drilling reports (6), HSE (7, plus an exact duplicate), facilities (5), core (2), decline (2) |
| queries.json | 24 queries, 183 judged pairs | graded 0-3, pooled from both systems' top 5 plus assessor additions; a reference short answer each; a second annotator on every judged pair; Q24 has no relevant passage |
| systems.json | 2 x 24 answers | A: BM25 top 5, careful writer; B: TF-IDF top 5, sloppier writer; planted defects listed in the README |
| extraction.json | 30 records x 6 fields | labels and both systems' predictions |
| calibration.json | 200 rows | a relevance classifier's probability (logistic on the BM25 score, 2 dp) against judged grade >= 2 |

Sizing (the lead suggested 60 / 24 / 30 / 200; kept): 60 passages keep
every score printable in a lesson and still give eleven document types for
lexical traps (Q14 "Is Ekene-5 producing water?" retrieves nothing
relevant by BM25, because the answers say "no water" and "water free"); 24
queries give a per-query bootstrap over 23 included queries (one excluded
by the no-relevant rule, on purpose); 30 records x 6 fields = 180 cells,
enough for every outcome class in both systems; 200 calibration rows put 3
to 39 rows in each of 10 bins.

Consistency with the Ekene field: every overlapping figure is READ from
`test-data/ekene-dynamic/*.json` (well tops and the 1560 m TVD contact,
first-oil dates and rates, monthly rates, water cuts from the surveillance
rows, pressure surveys and cumulative oil from `mbal.json`, the flood
surveys, injection rates and wellhead pressures, PVT, SCAL, decline
parameters and EUR) and printed at the stated rounding; the drilling
figures follow the Suite demo dataset frame (KB 25 m, water depth 35 m, TD
2250 m MD, the 13.375 in shoe at 1450 m, the 9.625 in shoe at 1800 m, a 7 in
liner to TD, the Oboro gas-water contact at 1935 m MD). A gate checks the
pressure at flood start, STOIIP, first oil and the well tops against the
dynamic package.

Headline figures the course can key (engine, defaults unless stated):

| figure | A (BM25) | B (TF-IDF) |
|---|---|---|
| MAP@5 (23 included queries) | 0.600278 | 0.593007 |
| mean nDCG@5 | 0.762753 | 0.764137 |
| MRR@5 | 0.880435 | 0.923913 |
| claims supported / claims | 47 / 49 | 30 / 41 |
| SQuAD exact match (24 short answers) | 20 | 13 |
| extraction micro accuracy (180 cells) | 0.972222 | 0.916667 |

Kappa between the annotators on 183 pairs: unweighted 0.579841, linear
0.675940, quadratic 0.771549. Calibration (10 bins): Brier 0.168382, ECE
0.2093, MCE 0.723333, log loss 0.503184 with 5 probabilities clipped.

## Agreement achieved

Engine against the stdlib oracle: every golden passes at relative 1e-10
with an absolute floor of 1e-12; ids, rankings, counts, labels, booleans
and messages exactly, and every result has exactly the oracle's top-level
fields (basis aside).

Library witness against the oracle, worst relative disagreement (printed by
`pin_evaluate.py`): TF-IDF (idf_, rows, cosine) 6.2e-16; BM25 on
CountVectorizer counts 4.4e-16; ndcg_score 2e-16; average_precision_score
1.3e-16; cohen_kappa_score 1.6e-16; brier_score_loss 1.3e-16; log_loss 0;
numpy.histogram bin counts 0; calibration_curve 0. Tolerance per pin:
max(1e-10, 10 x the disagreement rounded up to a power of ten).

The 20 skips, each a documented convention difference:

| cases | library | why |
|---|---|---|
| met-short-ranking, met-empty-ranking, Q10 in the five evaluateRetrieval cases | ndcg_score | the ranking has fewer than k documents; scikit-learn scores a full array, so unranked judged documents would fill ranks the engine leaves empty |
| kappa-undefined | cohen_kappa_score | one shared label: scikit-learn returns nan, the engine null with the reason |
| cal-ekene-10/5/15/1, cal-edges, cal-perfect, cal-eps | log_loss | a probability of 0 or 1 is clipped: scikit-learn at float64 machine epsilon, ml.js at eps = 1e-15 |
| cal-ekene-10/5/15, cal-edges, cal-eps | calibration_curve | probabilities on interior edges: see decision 12 |

## Decisions (conventions the oracle cannot check), and refinements of the lead's scope

1. **Tokeniser.** Only ASCII A-Z is lowercased (refined from "lowercase":
   JavaScript `toLowerCase` and Python `lower` disagree on some non-ASCII
   letters, and an accented letter is a separator anyway because it is
   outside [a-z0-9]). Split on runs outside [a-z0-9]: "1.25" gives "1" and
   "25", "Ekene-3" gives "ekene" and "3"; single-character tokens are KEPT
   (scikit-learn's default pattern drops them; the pins use
   `token_pattern=[a-z0-9]+`). No stemming.
2. **Stop list OFF by default.** scikit-learn's list removes words that
   carry meaning in oilfield text: well, top, bottom, fire, system, per,
   thick, thin, the number words one to twelve, fifteen, twenty, forty,
   fifty, sixty, hundred, first and third, and part, side, full, empty,
   found, back, front, move, name, interest, call, bill, mill, amount. The
   query "the well top" loses every token.
3. **TF-IDF** is scikit-learn's default; a document with no token is a zero
   vector (norm 0) and never ranks.
4. **BM25.** (refined) A repeated query word counts once: Okapi's k3 query
   term factor with k3 = 0, stated in the basis, so "oil oil rate" ranks as
   "oil rate". The (k1 + 1) numerator is kept (Robertson and Zaragoza);
   Lucene 8 and later drop it, which scales every score and leaves every
   order. dl is the token count after the stop list; avgdl is over every
   document, empty ones included. A corpus with no token at all is refused
   (avgdl 0).
5. **Ranking.** (refined) Only documents with a score above 0 are ranked,
   so a list can be shorter than k. A tie is two scores equal to 12
   significant digits, compared as `Number(score.toPrecision(12))`: a key
   is transitive, where a relative tolerance is not (a ~ b and b ~ c without
   a ~ c breaks a sort). Ties go to the id ascending by UTF-16 code units.
   The result reports the tied groups within the top k, and `tieAtCutoff`
   when the k-th and (k + 1)-th documents tie (the cut is then decided by
   the id alone). EKD-058 is an exact copy of EKD-046, so Q10 shows the rule
   with every method.
6. **Metrics at k.** Relevant means grade >= relevantGrade, default 1 (the
   trec_eval default). P@k divides by k even when fewer are ranked. RR and
   AP are cut at k. AP divides by every relevant judged document
   (trec_eval), so a relevant document below the cut lowers AP. nDCG's
   ideal ranking uses every judged grade for the query, not only the
   retrieved ones, and the gain uses every grade (relevantGrade does not
   apply to nDCG). Unjudged documents count as grade 0 and are counted
   (`unjudgedRetrieved`): unjudged is not the same as irrelevant.
7. **No relevant document.** Excluded from every mean by default and listed
   with the reason (trec_eval); `noRelevant: 'zero'` keeps the query with
   each undefined metric at 0. A query with no document at relevantGrade 2
   can still have an nDCG (a grade 1 gives it gain); it is excluded all the
   same, so every mean runs over the same queries.
8. **SQuAD answers.** normalize_answer as published: lowercase, drop ASCII
   punctuation, drop a, an, the, collapse whitespace. So "45.0 percent"
   normalises to "450 percent" and does NOT match "45 percent", and
   "Ekene-3" becomes "ekene3" and does not match "Ekene 3": the course
   teaches both. The engine's whitespace is JavaScript's `\s` and its
   article boundary is ASCII; both agree with the Python script on ASCII
   text. When either side has no token, F1 is 1 if both are empty and 0
   otherwise (SQuAD 2.0), so a correct abstention scores 1.
9. **Extraction.** The four outcomes the lead set; a cell where both sides
   are empty is `correct` with `empty: true` (counted in `correctEmpty`).
   (refined) precision and recall over filled cells are reported beside
   accuracy, because accuracy is inflated by correctly empty cells (73 of
   180 for system A). A number field accepts a number or a string of digits
   with comma thousands groups and a decimal part ("3,038" reads as 3038;
   "150 bopd" is wrong, with the reason). The tolerance is inclusive:
   |p - l| <= max(absTol, relTol x |label|). A labelled record with no
   prediction scores as all empty; a prediction for an unlabelled id is
   refused. Text fields match by normalised exact match; mean token F1 per
   text field is reported. (refined) The lead asked for micro and macro
   accuracy: both are reported, but because every labelled record is
   scored on every field each field has the same count, so macro accuracy
   equals micro by construction (the negative control found this). Micro
   and macro F1 on filled cells are added, which do differ (system A 0.966824
   and 0.942735); a field never filled on either side has F1 null and is
   left out of the macro.
10. **Groundedness** (the deterministic hallucination check). Claims are
    quoted spans, ISO dates and numbers, extracted in that order; a number
    glued to a letter, or joined by - _ / to an alphanumeric, is part of an
    identifier (Ekene-3, EK1-P, EKD-010) and not a claim; "45%" is 45; each
    occurrence is a claim. (refined) A claim is supported only by a passage
    that is BOTH cited and retrieved: a citation that was not retrieved is
    flagged and supports nothing. Each unsupported claim's reason says
    whether the figure is in a retrieved passage the answer does not cite
    (a citation error), in a cited passage that was not retrieved, only in
    other passages, or nowhere in the corpus (a fabrication). numericRelTol
    defaults to 0 (equal values); 0.002 lets "2,100 psia" stand for 2,096.
    Stated limits the course teaches: grounded is not correct (system B's
    Q05 date is supported by the passage it cites, which is about another
    well); "the end of 2025" is the number 2025, not the date 2025-12-01; a
    number can match by coincidence ("5 bbl" is found in "5 months").
11. **Kappa.** Labels in the order given, else the distinct ratings sorted
    (numbers ascending, strings by code units). (refined) Weighted kappa on
    string ratings requires `labels` in order: scikit-learn sorts strings
    alphabetically and would weight "high" < "low" < "mid". A label nobody
    used still sets the weight positions. Undefined (both raters gave every
    item one single label) returns null with the reason, where scikit-learn
    returns nan.
12. **Calibration bins.** The lead's rule: p is in bin i when i/M <= p <
    (i+1)/M, the last bin closed, with the edges as JavaScript and Python
    compute i / M in double precision (so 0.3 is the edge i = 3, M = 10,
    and opens bin 3). Evidence found: scikit-learn 1.9.1
    `calibration_curve` does the opposite. It builds edges with
    `np.linspace(0, 1, M + 1)` (the fourth edge is 0.30000000000000004) and
    assigns by `np.searchsorted(edges[1:-1], p)` with side 'left', so an
    edge value falls into the LOWER bin: on the Ekene calibration set 17 of
    200 rows (p = 0.1, 0.2, 0.3, 0.4, 0.6) sit in a different bin. ECE
    happens to be equal on this set (every bin is over-confident, so the
    pooled gaps add up the same); the table, MCE and REL differ. The engine
    keeps the lead's rule; the bin counts are pinned to `numpy.histogram`
    with the explicit edges i / M, and `calibration_curve` is pinned only
    where no probability is on an edge.
13. **Calibration scores.** ECE and MCE over non-empty bins (Guo et al.
    2017). The Murphy decomposition carries the within-bin variance WBV and
    covariance WBC (Stephenson, Coelho and Jolliffe 2008), so Brier = REL -
    RES + UNC + WBV - WBC exactly; the engine reports `closure` (below
    1e-15 on every case, exactly 0 in the oracle). Log loss is
    `engines/dataai/ml.js` `logLoss`, imported; `eps` passes through.
14. **Bootstrap.** One mulberry32(seed) stream, replicate by replicate,
    index floor(u n). Percentile interval by lib/stats quantile (the
    simple-statistics rule, as forecast.js). (refined) `level` is one of
    0.8, 0.9, 0.95, 0.99: (1 - level) / 2 in float is 0.025000000000000022
    for 0.95, which moves the quantile index off a whole number, so the
    tails are rounded to 12 decimals; the fixed list also keeps every label
    a well-formed ordinal (2.5th, 97.5th, 0.5th, 99.5th). The interval is a
    percentile of a statistic, so it is labelled with
    `parameterPercentileLabel` ("2.5th percentile of the bootstrap mean"),
    never P10, P50 or P90 (lib/conventions/percentile.js keeps those for
    outcomes). standardError divides by nBoot - 1. The paired bootstrap is
    exactly the bootstrap of the per-query differences with the same seed
    (a gate checks equality); `paired: false` resamples a and b
    independently, which ignores that both systems answered the same
    queries and gives a wider interval (a gate checks it on the Ekene
    systems). `shareAtOrBelowZero` is the share of replicates where A does
    not beat B; it is not a p-value and the basis does not call it one.

## Boundary table (per rule)

| rule | at the boundary | so |
|---|---|---|
| ranked | score > 0 | a document matching no query term is never ranked |
| tie | equal 12-digit keys | tied; the id ascending decides |
| relevant | grade >= relevantGrade | a grade equal to the threshold is relevant |
| P@k | fewer than k ranked | still divides by k |
| RR, AP | relevant at rank k + 1 | not counted |
| no relevant | no judged document at the threshold | excluded (default) |
| nDCG | ideal DCG 0 | null with the reason |
| number match (extraction) | \|p - l\| = tolerance | correct (inclusive) |
| number match (claims) | \|c - v\| = relTol x \|v\| | supported (inclusive); relTol 0 means equal |
| empty | null, absent, blank string | empty; "the" is NOT empty (it normalises to nothing but is a value) |
| comma groups | exactly three digits, not followed by a digit | "12,1234" reads as 12 and 1234 |
| minus sign | after a non-alphanumeric character | "-2" is negative; "Ekene-2" is an identifier |
| date | YYYY-MM-DD not touching a letter or digit | "2023-01-01x" is read as numbers |
| calibration bin | p = i / M | opens bin i (scikit-learn: closes bin i - 1) |
| last bin | p = 1 | in bin M - 1 |
| kappa | expected disagreement 0 | null with the reason |
| share at or below zero | a replicate exactly 0 | counted |

## Caps (proposed for the app) and timing

Engine caps: 5,000 documents of at most 20,000 characters, 1,000 queries,
k up to 1,000, 5,000 records x 50 fields, 5,000 answers, 100,000
calibration rows or rating pairs, 100 bins, 50 kappa labels, 10,000
bootstrap values x 100,000 replicates. Proposed app limits: a corpus of up
to 2,000 passages (a 24-query run then takes about 0.2 to 0.4 s here), 200 queries
per evaluation, bootstrap replicates 2,000 by default and 10,000 at most.

`node tools/validation/dataai/timing_evaluate.mjs`, node v18.19.1, one run:

| documents | words per document | retrieve BM25, 24 queries | retrieve TF-IDF, 24 queries | retrieve BM25, 1,000 queries | tfidfVectors | rankBm25, 1 query |
|---|---|---|---|---|---|---|
| 60 | 33 | 12 | 23 | 133 | 7 | 2 |
| 1000 | 33 | 94 | 185 | 1215 | 51 | 24 |
| 5000 | 33 | 369 | 634 | 7469 | 159 | 80 |
| 5000 | 660 | 1220 | 1263 | 10858 | 1286 | 1039 |

Milliseconds. checkAnswers: 1000 answers over 5000 documents 1520 ms. calibration 100,000 rows x 100 bins 50 ms; cohenKappa 100,000 pairs 32 ms. bootstrap 1000 values x 2000 replicates: mean 25 ms, paired 23 ms. bootstrap 10000 values x 2000 replicates: mean 220 ms, paired 219 ms. bootstrap 10000 values x 10000 replicates: mean 999 ms, paired 1035 ms. scoreExtraction 5000 records x 6 fields 224 ms.

## Negative control

`negcontrol_evaluate.sh`, run 2026-09-25 on the committed engine: every plant changes one line; the count is the failing tests.

| engine plant | result | failing |
|---|---|---|
| no lowercasing | RED | 1967 failed |
| digits split off (letters only) | RED | 2060 failed |
| stop list always on | RED | 1763 failed |
| stop list without 'well' | RED | 245 failed |
| BM25 Robertson idf without the 1 + | RED | 708 failed |
| BM25 score without (k1 + 1) | RED | 690 failed |
| BM25 b and 1 - b swapped | RED | 691 failed |
| avgdl over N + 1 | RED | 702 failed |
| repeated query words counted | RED | 57 failed |
| document length before the stop list | RED | 234 failed |
| idf not smoothed | RED | 1419 failed |
| idf without the + 1 | RED | 1420 failed |
| document vectors not normalised | RED | 1180 failed |
| sublinear tf ignored | RED | 272 failed |
| sublinear tf as ln(1 + tf) | RED | 272 failed |
| query vector not normalised | RED | 670 failed |
| ties to the id DESCENDING | RED | 19 failed |
| ties at 6 significant digits | RED | 3 failed |
| zero-score documents ranked | RED | 37 failed |
| tie at the cutoff never reported | RED | 10 failed |
| P@k over the documents ranked | RED | 6 failed |
| DCG discount log2(i + 2) | RED | 125 failed |
| ideal DCG from the ranked documents only | RED | 92 failed |
| AP over min(k, relevant) | RED | 5 failed |
| relevant strictly above the grade | RED | 38 failed |
| exponential gain 2^g (no - 1) | RED | 22 failed |
| no-relevant query kept in the means by default | RED | 7 failed |
| articles kept | RED | 9 failed |
| punctuation kept | RED | 35 failed |
| F1 on token sets, not multisets | RED | 1 failed |
| two empty answers score F1 0 | RED | 3 failed |
| numeric tolerance exclusive | RED | 2 failed |
| relTol on the prediction | RED | 1 failed |
| both empty scored missed | RED | 6 failed |
| unsupported scored wrong | RED | 3 failed |
| macro F1 is the micro F1 | RED | 3 failed |
| extraction F1 null counted as 0 in the macro | RED | 1 failed |
| numeric strings with thousands commas unread | RED | 2 failed |
| identifier numbers counted as claims | RED | 5 failed |
| any corpus passage supports a claim | RED | 13 failed |
| unretrieved citations support claims | RED | 4 failed |
| numeric match strict (equal values unsupported) | RED | 11 failed |
| dates not read (split into numbers) | RED | 7 failed |
| quotes matched as character substrings | RED | 1 failed |
| minus sign ignored | RED | 1 failed |
| comma groups of more than three digits | RED | 1 failed |
| linear weights quadratic | RED | 4 failed |
| expected counts over n - 1 | RED | 19 failed |
| numeric labels sorted as strings | RED | 2 failed |
| edge value in the lower bin (scikit-learn rule) | RED | 30 failed |
| last bin open at 1 | RED | 83 failed |
| ECE unweighted over bins | RED | 6 failed |
| WBC without the factor 2 | RED | 7 failed |
| resolution about 0.5 | RED | 8 failed |
| Brier over N - 1 | RED | 15 failed |
| eps not passed to ml.js logLoss | RED | 2 failed |
| bootstrap draw floor(u (n - 1)) | RED | 8 failed |
| interval tails at 1 - level, not half | RED | 13 failed |
| paired draws a and b separately | RED | 5 failed |
| standard error with divisor nBoot | RED | 10 failed |
| share strictly below zero | RED | 2 failed |
| a fresh stream per replicate | RED | 8 failed |
| k refusal in other words | RED | 4 failed |
| kappa undefined note in other words | RED | 1 failed |
| groundedness reason drops 'cited but not retrieved' | RED | 3 failed |
| excluded-query reason in other words | RED | 7 failed |
| plain-number reason in other words | RED | 1 failed |
| '1 ratings' (no singular) | RED | 1 failed |

| oracle plant (golden regenerated) | result | failing |
|---|---|---|
| oracle BM25 idf without the 1 + | RED | 22 failed |
| oracle DCG discount log2(i + 2) | RED | 19 failed |
| oracle linear kappa quadratic | RED | 2 failed |
| oracle WBC without the factor 2 | STOP | the oracle refused to write (Murphy identity assert) |
| oracle bootstrap draws from n - 1 | RED | 7 failed |
| oracle SQuAD keeps articles | RED | 9 failed |

Two plants went green on the first run and each led to a fix before this run: "ties at 6 significant digits" (no golden had two scores that agree to 6 digits and differ by 12; `bm25-near-tie` added) and "macro accuracy is the micro" (true by construction, because every labelled record is scored on every field; micro and macro F1 on filled cells were added, which differ, and the basis now says the two accuracies are equal).

## Open questions for the lead

1. relevantGrade defaults to 1 (trec_eval). With the Ekene grades (1 =
   related) a course may prefer 2; it is one constant.
2. The claim grammar reads "the end of 2025" as the number 2025, so system
   A loses one claim on Q13. Kept as a teaching example of how a
   deterministic check reads text; a year-only date form could be added.
3. The lead's bin rule differs from scikit-learn's at the edges
   (decision 12). Kept; the course should say so where learners compare
   with scikit-learn.
