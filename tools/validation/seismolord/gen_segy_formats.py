"""Seismolord U2-009 oracle: SEG-Y files in the integer sample formats and
in little-endian byte order, written AND read back by segyio (the
development-time oracle, never a runtime dependency), with the values
segyio decodes committed as goldens.

Run: <venv with segyio 1.9>/bin/python tools/validation/seismolord/gen_segy_formats.py
Writes test-data/seismolord/segy_formats/*.sgy and goldens.json.
"""
from __future__ import annotations

import json
import os

import numpy as np
import segyio

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "seismolord", "segy_formats"))

N_IL, N_XL, NS, DT_US = 3, 4, 24, 4000

# (name, format code, endian, numpy dtype of the stored values, amplitude)
CASES = [
    ("fmt1_ibm_le", 1, "little", np.float32, 1.0),
    ("fmt2_int32_be", 2, "big", np.int32, 2_000_000.0),
    ("fmt3_int16_be", 3, "big", np.int16, 30000.0),
    ("fmt3_int16_le", 3, "little", np.int16, 30000.0),
    ("fmt5_ieee_le", 5, "little", np.float32, 1.0),
    ("fmt8_int8_be", 8, "big", np.int8, 120.0),
    ("fmt11_uint16_be", 11, "big", np.uint16, 30000.0),
    ("fmt16_uint8_be", 16, "big", np.uint8, 120.0),
]


def trace_values(i: int, j: int, amp: float, dtype) -> np.ndarray:
    t = np.arange(NS, dtype=np.float64)
    v = amp * np.sin(0.4 * t + 0.7 * i + 0.3 * j) * np.exp(-0.02 * t)
    if np.issubdtype(dtype, np.unsignedinteger):
        v = np.abs(v)
    if np.issubdtype(dtype, np.integer):
        return np.round(v).astype(dtype)
    return v.astype(np.float32)


def write_case(name: str, fmt: int, endian: str, dtype, amp: float) -> dict:
    path = os.path.join(OUT, f"{name}.sgy")
    spec = segyio.spec()
    spec.iline, spec.xline = 189, 193
    spec.format = fmt
    spec.sorting = 2
    spec.samples = list(range(NS))
    spec.ilines = list(range(101, 101 + N_IL))
    spec.xlines = list(range(201, 201 + N_XL))
    spec.endian = endian
    with segyio.create(path, spec) as f:
        f.bin.update(hdt=DT_US, hns=NS, format=fmt)
        tr = 0
        for i, il in enumerate(spec.ilines):
            for j, xl in enumerate(spec.xlines):
                f.header[tr] = {
                    segyio.su.iline: il, segyio.su.xline: xl,
                    segyio.su.cdpx: 500000 + j * 25, segyio.su.cdpy: 6000000 + i * 25,
                    segyio.su.scalco: 1, segyio.su.ns: NS, segyio.su.dt: DT_US,
                }
                f.trace[tr] = trace_values(i, j, amp, dtype)
                tr += 1
    # the oracle: what segyio reads back (as float32, its own decode)
    with segyio.open(path, "r", iline=189, xline=193, endian=endian) as f:
        traces = [np.asarray(f.trace[k], dtype=np.float64).tolist() for k in range(f.tracecount)]
        fmt_read = int(f.bin[segyio.BinField.Format])
    return {
        "file": f"{name}.sgy", "format": fmt, "format_read": fmt_read, "endian": endian,
        "n_il": N_IL, "n_xl": N_XL, "ns": NS, "dt_us": DT_US,
        "ilines": list(range(101, 101 + N_IL)), "xlines": list(range(201, 201 + N_XL)),
        "size": os.path.getsize(path), "traces": traces,
    }


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    out = {"generator": "tools/validation/seismolord/gen_segy_formats.py", "segyio": "1.9.14", "cases": []}
    for c in CASES:
        out["cases"].append(write_case(*c))
    with open(os.path.join(OUT, "goldens.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)
    print(f"wrote {len(out['cases'])} files to {OUT}")


if __name__ == "__main__":
    main()
