# Well Data Manager — LAS validation fixtures & goldens (Phase G1.0)

Committed test data for the LAS parser (`engine/lasParse.js`, Phase
G1.2). Generated deterministically — reruns are byte-identical — by:

```
tools/validation/wells/.venv/bin/python tools/validation/wells/genfixtures.py
tools/validation/wells/.venv/bin/python tools/validation/wells/oracle.py
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

Curves are closed-form functions of measured depth (see
`genfixtures.py`) so any golden value can be independently recomputed —
the G1.0 acceptance run verifies GR against the formula through the
4-decimal ASCII rounding.

Domain conventions (WellDataManager-PLAN.md): internal units are SI;
`feet_20` exists precisely so import-layer ft→m conversion is tested
against known raw values. LAS 3.0 is out of v1 scope and must be
rejected with a clear message, not half-parsed.
