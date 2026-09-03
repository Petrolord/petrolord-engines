# Well Data Manager — LAS validation fixtures & goldens (Phase G1.0)

Committed test data for the LAS parser (`engine/lasParse.js`, Phase
G1.2). Generated deterministically — reruns are byte-identical — by:

```
tools/validation/wells/.venv/bin/python tools/validation/wells/genfixtures.py   # also writes the *_30 goldens
tools/validation/wells/.venv/bin/python tools/validation/wells/oracle.py        # lasio goldens for 1.2/2.0
```

(one-time env setup: `python3 -m venv tools/validation/wells/.venv &&
tools/validation/wells/.venv/bin/pip install -r
tools/validation/wells/requirements.txt`)

`las/` holds the input fixtures; `goldens/` holds what **lasio** (the
independent reference parser) extracts from them. The JS engine must
match the goldens bit-for-bit: curve samples are little-endian float32
(`<name>.<CURVE>.f32`) with LAS nulls stored as NaN — the comparator
treats NaN==NaN and otherwise requires identical bits. `<name>.json`
carries version/wrap/null/well-info and per-curve metadata including
`null_count` and a float64 `sum_finite_f64` checksum.

| Fixture | Encodes |
|---|---|
| `basic_20.las` | LAS 2.0, unwrapped, metric, regular 0.5 m step, scattered −999.25 nulls |
| `wrapped_12.las` | LAS 1.2, WRAP YES (depth on its own line, wrapped values) — **and the 1.2 rule that ~Well string values (WELL/COMP/UWI) sit AFTER the colon**; the parser must implement that swap |
| `feet_20.las` | Depth in F, DT in US/F — raw parse fidelity; unit conversion is a separate import-layer concern with its own tests |
| `irregular_20.las` | STEP 0.0 with non-uniform depth increments (the depth vector is data, not arithmetic) |
| `nullheavy_20.las` | Alternative NULL −9999.00, a 71-sample null run, one fully-null curve |
| `quirks_20.las` | Real-world header abuse: comment/blank lines, ragged spacing, colons and quotes inside descriptions, API-code column, empty ~Params, CRLF line endings |
| `las3_comma_30.las` | **LAS 3.0**, DLM COMMA: {F}/{E} numeric formats, a {S} lithology column and a {DT} time column (the parser skips both and names them in `skippedCurves`), array channels RHOB[1]/RHOB[2], empty fields as nulls, a quoted string containing the delimiter, `| association` tails, ~Parameter and ~Log_Parameter, ~Core_* and ~Tops_* blocks after the log data (ignored, named in `ignoredSections`), a comment inside the data |
| `las3_space_30.las` | **LAS 3.0**, DLM SPACE, numeric only, ~Log_Data titled with an association, ragged spacing |

Curves are closed-form functions of measured depth (see
`genfixtures.py`) so any golden value can be independently recomputed —
the G1.0 acceptance run verifies GR against the formula through the
4-decimal ASCII rounding.

Domain conventions (WellDataManager-PLAN.md): internal units are SI;
`feet_20` exists precisely so import-layer ft→m conversion is tested
against known raw values.

**LAS 3.0 (2026-09-03).** Supported for the log data: DLM SPACE/COMMA/TAB,
one row per depth step, `~Log_Definition`/`~Log_Parameter`/`~Log_Data`
(or the 2.0 names), `{FORMAT}` and `| association` tails, empty fields
as nulls, quoted strings. Text columns ({S}, {D}, {DT}, {T}, or undeclared
non-numeric) are skipped and reported; every other `*_Definition/*_Data`
pair (Core, Tops, Inclinometry, ...) is ignored and reported. The
`*_30` goldens are NOT lasio's: lasio 0.32 misreads LAS 3.0 (it ignores
DLM and swallows the other data blocks), so `genfixtures.py` writes those
goldens directly from the closed-form arrays it generated the files from
(`"oracle"` field in the JSON says so) and `oracle.py` skips `*_30.las`.
The independence rule holds: the goldens never come from the JS parser.
