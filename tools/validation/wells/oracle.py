#!/usr/bin/env python3
"""LAS parsing oracle for the Well Data Manager (G1.0).

Parses every fixture in test-data/wells/las/ with lasio (the independent
reference implementation) and emits committed goldens that the JS engine
(engine/lasParse.js, G1.2) must match bit-for-bit:

  test-data/wells/goldens/<name>.json      version/wrap/null/well-info +
                                           per-curve metadata (mnemonic,
                                           unit, n_samples, null_count,
                                           first/last finite values)
  test-data/wells/goldens/<name>.<CURVE>.f32
                                           little-endian float32 samples;
                                           LAS nulls stored as NaN (lasio
                                           semantics). The jest comparator
                                           treats NaN==NaN and otherwise
                                           requires identical bits.

Determinism: output JSON is sorted and floats are emitted with repr()
round-trip precision; reruns are byte-identical for unchanged inputs.

Run:  tools/validation/wells/.venv/bin/python tools/validation/wells/oracle.py
"""

import json
import math
import os

import lasio
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LAS_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "wells", "las"))
GOLD_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "wells", "goldens"))


def jf(v):
    """JSON-safe float with round-trip precision (None for NaN)."""
    if v is None:
        return None
    f = float(v)
    return None if math.isnan(f) else f


def well_item(las, mnem):
    item = las.well[mnem] if mnem in las.well else None
    if item is None:
        return None
    return {"unit": item.unit or "", "value": item.value if not isinstance(item.value, float)
            else jf(item.value), "descr": (item.descr or "").strip()}


def process(path):
    name = os.path.splitext(os.path.basename(path))[0]
    las = lasio.read(path)

    curves = []
    for curve in las.curves:
        data32 = np.asarray(curve.data, dtype="<f4")
        finite = data32[np.isfinite(data32)]
        curves.append({
            "mnemonic": curve.mnemonic,
            "unit": curve.unit or "",
            "descr": (curve.descr or "").strip(),
            "n_samples": int(data32.size),
            "null_count": int(np.count_nonzero(~np.isfinite(data32))),
            "first_finite": jf(finite[0]) if finite.size else None,
            "last_finite": jf(finite[-1]) if finite.size else None,
            "sum_finite_f64": jf(np.sum(finite.astype(np.float64))) if finite.size else None,
        })
        data32.tofile(os.path.join(GOLD_DIR, f"{name}.{curve.mnemonic}.f32"))

    meta = {
        "fixture": os.path.basename(path),
        "version": jf(las.version["VERS"].value),
        "wrap": str(las.version["WRAP"].value).upper(),
        "null_value": jf(las.well["NULL"].value) if "NULL" in las.well else None,
        "well": {k: well_item(las, k) for k in
                 ["STRT", "STOP", "STEP", "WELL", "UWI", "COMP", "FLD", "LOC", "DATE"]
                 if k in las.well},
        "depth_unit": las.curves[0].unit or "",
        "curves": curves,
    }
    out = os.path.join(GOLD_DIR, f"{name}.json")
    with open(out, "w", newline="\n") as f:
        json.dump(meta, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"golden {os.path.relpath(out)} ({len(curves)} curves)")


def main():
    os.makedirs(GOLD_DIR, exist_ok=True)
    for fn in sorted(os.listdir(LAS_DIR)):
        if fn.lower().endswith(".las"):
            process(os.path.join(LAS_DIR, fn))


if __name__ == "__main__":
    main()
