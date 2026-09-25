# Ekene documents (synthetic)

SYNTHETIC teaching data for the Ekene field, Petrolord's fictional teaching
field (block EK-11). No real company, person, well or incident appears. Used
by `engines/dataai/evaluate.js` (Data & AI D5), its jest gate, the AI
Evaluation Studio Suite app and the NextGen `appliedai` course, which all read
these same files.

Written by `tools/validation/dataai/make_evaluate_fixtures.py` (stdlib
python); re-running it reproduces the files byte for byte. Every figure that
overlaps the existing Ekene data (rates, pressures, PVT, SCAL, the flood,
well tops) is read from `test-data/ekene-dynamic/*.json` at the stated
rounding. No language model wrote or scores any of this: the answers are
hand-written fixture text.

| file | contents |
|---|---|
| `corpus.json` | 60 passages EKD-001..EKD-060 (id, type, well, date, title, text). EKD-058 is an exact copy of EKD-046, so rankings tie on it. The engine indexes `text` only. |
| `queries.json` | 24 queries Q01..Q24 with a short reference answer, graded judgments 0-3 (3 answers, 2 relevant, 1 related, 0 judged not relevant; 183 judged pairs, pooled from both systems' top 5) and a second annotator's grades on the same pairs. Q24 has no relevant passage. |
| `systems.json` | Two fixed systems. A: BM25 (k1 1.2, b 0.75) top 5; B: TF-IDF top 5. Per query: the retrieved ids, an answer text with citations, and a short answer. |
| `extraction.json` | Six fields (well, date, event, oil_rate_bopd, water_cut_pct, reservoir_pressure_psia), 30 labelled records (one per source passage), and the two systems' predictions. |
| `calibration.json` | 200 (query, passage) rows: a relevance classifier's probability and the outcome (judged grade 2 or 3). |

Planted defects (what the course teaches from):

- System A: an oil column figure from a passage it neither cited nor
  retrieved (Q06); "the end of 2025" read as the number 2025 (Q13); no answer
  where retrieval failed (Q14, correct abstention on Q24). Extraction: a
  missed 0 water cut, another well's water cut, a wellhead pressure as the
  reservoir pressure, "near-miss" against "near miss".
- System B: a rounded figure (2,100 for 2,096), a unit change (12.1 million
  stb), figures from an uncited or unretrieved passage, a wrong date that is
  still "supported" because the cited passage contains it (Q05: grounded is
  not the same as correct), a citation that was not retrieved (Q15), an
  unknown citation (EKD-061), and a fabricated event (Q24). Extraction:
  "Ekene 3" against "Ekene-3", "150 bopd" in a number field, two records not
  returned, values from the wrong well.
