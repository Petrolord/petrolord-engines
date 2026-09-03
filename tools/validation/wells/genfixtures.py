#!/usr/bin/env python3
"""Deterministic LAS fixture generator for the Well Data Manager (G1.0).

Writes the committed LAS files under test-data/wells/las/. Everything is
a fixed closed-form function of measured depth — no randomness, no
timestamps — so reruns are byte-identical and the fixtures can be
regenerated from source forever.

Cases (WellDataManager-PLAN.md G1.0):
  basic_20.las      LAS 2.0, unwrapped, metric, regular 0.5 m step,
                    scattered -999.25 nulls
  wrapped_12.las    LAS 1.2, WRAP YES (depth on its own line, values
                    wrapped), same curves as basic. Note the 1.2
                    convention this fixture deliberately encodes: string
                    values in the ~Well section (WELL/COMP/UWI) sit
                    AFTER the colon — LAS 2.0 moved them before it. The
                    JS parser must implement the same swap.
  feet_20.las       LAS 2.0, depth in F, DT in US/F — raw parse
                    fidelity; unit conversion is tested separately
  irregular_20.las  LAS 2.0, STEP 0.0, non-uniform depth increments
  nullheavy_20.las  LAS 2.0, NULL -9999.00, long null runs and one
                    fully-null curve
  quirks_20.las     LAS 2.0 with real-world header quirks: comment and
                    blank lines, ragged spacing, colons inside
                    descriptions, an empty ~Params section, CRLF line
                    endings
  las3_comma_30.las LAS 3.0, DLM COMMA: {F}/{E} numeric formats, a {S}
                    lithology column and a {DT} time column (skipped by
                    the parser), array channels RHOB[1]/RHOB[2], empty
                    fields as nulls, a quoted string containing the
                    delimiter, "| association" tails, ~Parameter AND
                    ~Log_Parameter, ~Core_* and ~Tops_* blocks after the
                    log data (ignored), comments inside the data
  las3_space_30.las LAS 3.0, DLM SPACE, numeric only, ~Log_Data titled
                    with an association, ragged spacing

  The two LAS 3.0 fixtures ALSO write their own goldens here (json +
  f32) straight from the arrays they were generated from: lasio 0.32
  misreads LAS 3.0 (ignores DLM, swallows the other data blocks), so
  oracle.py skips *_30.las and the generator is the independent
  reference for them.

Regenerate:  tools/validation/wells/.venv/bin/python \
                 tools/validation/wells/genfixtures.py
Then re-run oracle.py to refresh the goldens.
"""

import json
import math
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "wells", "las"))
GOLD = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "wells", "goldens"))

M_PER_FT = 0.3048


# ---- deterministic synthetic curves (functions of md in metres) --------

def gr(md):
    return 60.0 + 30.0 * math.sin(md / 15.0) + 12.0 * math.sin(md / 3.7)


def rhob(md):
    return 2.35 + 0.20 * math.sin(md / 22.0)


def nphi(md):
    return 0.25 + 0.10 * math.sin(md / 9.0)


def dt(md):
    # us/m in metric fixtures; the feet fixture converts to us/ft
    return 320.0 + 80.0 * math.sin(md / 18.0)


def fmt(v, width=10, prec=4):
    return f"{v:{width}.{prec}f}"


def data_row(values, prec=4):
    return " ".join(fmt(v, prec=prec) for v in values)


# ---- fixture builders ----------------------------------------------------

def metric_depths(strt=1500.0, stop=1650.0, step=0.5):
    n = int(round((stop - strt) / step)) + 1
    return [strt + i * step for i in range(n)]


def basic_samples(depths, null):
    """Curve matrix with deterministic null placement (GR every 37th
    sample offset 5; RHOB a solid null run at rows 40..48)."""
    rows = []
    for i, md in enumerate(depths):
        g = null if i % 37 == 5 else gr(md)
        r = null if 40 <= i <= 48 else rhob(md)
        rows.append((md, g, r, nphi(md), dt(md)))
    return rows


def write(path, text, newline="\n"):
    with open(path, "w", newline=newline) as f:
        f.write(text)
    print(f"wrote {os.path.relpath(path)}")


def header_20(strt, stop, step, unit, null, uwi, extra_curve_unit="US/M"):
    return f"""~Version ---------------------------------------------------
VERS.   2.0 : CWLS LOG ASCII STANDARD - VERSION 2.0
WRAP.   NO  : ONE LINE PER DEPTH STEP
~Well ------------------------------------------------------
STRT.{unit} {fmt(strt)} : START DEPTH
STOP.{unit} {fmt(stop)} : STOP DEPTH
STEP.{unit} {fmt(step)} : STEP
NULL.   {null} : NULL VALUE
COMP.   PETROLORD : COMPANY
WELL.   KETA G1-1 : WELL
FLD .   KETA : FIELD
LOC .   ONSHORE GHANA : LOCATION
SRVC.   PETROLORD STUDIO : SERVICE COMPANY
DATE.   2026-07-12 : LOG DATE
UWI .   {uwi} : UNIQUE WELL ID
~Curve Information -----------------------------------------
DEPT.{unit}    : 1  DEPTH
GR  .GAPI  : 2  GAMMA RAY
RHOB.G/C3  : 3  BULK DENSITY
NPHI.V/V   : 4  NEUTRON POROSITY
DT  .{extra_curve_unit}  : 5  SONIC TRANSIT TIME
~Params ----------------------------------------------------
KB  .M  31.2000 : KELLY BUSHING ELEVATION
~Other -----------------------------------------------------
Synthetic deterministic fixture - tools/validation/wells/genfixtures.py
~ASCII -----------------------------------------------------
"""


def gen_basic():
    null = -999.25
    depths = metric_depths()
    rows = basic_samples(depths, null)
    body = "\n".join(data_row(r) for r in rows) + "\n"
    write(os.path.join(OUT, "basic_20.las"),
          header_20(1500.0, 1650.0, 0.5, "M", "-999.25", "KETA-G1-BASIC") + body)


def gen_wrapped():
    null = -999.25
    depths = metric_depths(1500.0, 1580.0, 0.5)
    rows = basic_samples(depths, null)
    head = f"""~Version ---------------------------------------------------
VERS.   1.2 : CWLS LOG ASCII STANDARD - VERSION 1.2
WRAP.   YES : MULTIPLE LINES PER DEPTH STEP
~Well ------------------------------------------------------
STRT.M {fmt(1500.0)} : START DEPTH
STOP.M {fmt(1580.0)} : STOP DEPTH
STEP.M {fmt(0.5)} : STEP
NULL.   -999.25 : NULL VALUE
COMP.   COMPANY : PETROLORD
WELL.   WELL : KETA G1-2
UWI .   UNIQUE WELL ID : KETA-G1-WRAPPED
~Curve Information -----------------------------------------
DEPT.M     : 1  DEPTH
GR  .GAPI  : 2  GAMMA RAY
RHOB.G/C3  : 3  BULK DENSITY
NPHI.V/V   : 4  NEUTRON POROSITY
DT  .US/M  : 5  SONIC TRANSIT TIME
~ASCII -----------------------------------------------------
"""
    # wrapped: depth on its own line, then curve values two per line
    lines = []
    for md, g, r, n, d in rows:
        lines.append(fmt(md))
        lines.append(f"{fmt(g)} {fmt(r)}")
        lines.append(f"{fmt(n)} {fmt(d)}")
    write(os.path.join(OUT, "wrapped_12.las"), head + "\n".join(lines) + "\n")


def gen_feet():
    null = -999.25
    strt_ft, stop_ft, step_ft = 4900.0, 5200.0, 2.0
    n = int(round((stop_ft - strt_ft) / step_ft)) + 1
    rows = []
    for i in range(n):
        md_ft = strt_ft + i * step_ft
        md_m = md_ft * M_PER_FT           # curves remain functions of metres
        g = null if i % 29 == 3 else gr(md_m)
        rows.append((md_ft, g, rhob(md_m), nphi(md_m), dt(md_m) * M_PER_FT))
    body = "\n".join(data_row(r) for r in rows) + "\n"
    write(os.path.join(OUT, "feet_20.las"),
          header_20(strt_ft, stop_ft, step_ft, "F", "-999.25",
                    "KETA-G1-FEET", extra_curve_unit="US/F") + body)


def gen_irregular():
    null = -999.25
    incs = [0.3, 0.5, 0.7]                # cycling non-uniform increments
    depths = [1500.0]
    while depths[-1] < 1560.0:
        depths.append(round(depths[-1] + incs[(len(depths) - 1) % 3], 4))
    rows = basic_samples(depths, null)
    body = "\n".join(data_row(r) for r in rows) + "\n"
    write(os.path.join(OUT, "irregular_20.las"),
          header_20(depths[0], depths[-1], 0.0, "M", "-999.25", "KETA-G1-IRREG") + body)


def gen_nullheavy():
    null = -9999.00
    depths = metric_depths(1500.0, 1600.0, 0.5)
    rows = []
    for i, md in enumerate(depths):
        g = null if 20 <= i <= 90 else gr(md)      # long null run
        rows.append((md, g, rhob(md), null, dt(md)))  # NPHI fully null
    body = "\n".join(data_row(r) for r in rows) + "\n"
    write(os.path.join(OUT, "nullheavy_20.las"),
          header_20(1500.0, 1600.0, 0.5, "M", "-9999.00", "KETA-G1-NULLS") + body)


def gen_quirks():
    null = -999.25
    depths = metric_depths(1500.0, 1540.0, 0.5)
    rows = basic_samples(depths, null)
    head = """# Exported by a legacy vendor tool - expect rough edges below
~Version
 VERS.                2.0   :   CWLS LOG ASCII STANDARD - VERSION 2.0

 WRAP.                 NO   :   ONE LINE PER DEPTH STEP
~Well Information Block
#MNEM.UNIT       DATA                    DESCRIPTION
#---------      ------------            -----------------------------
 STRT.M          1500.0000               :START DEPTH
 STOP.M          1540.0000               :STOP DEPTH
 STEP.M          0.5000                  :STEP
 NULL.           -999.25                 :NULL VALUE
 WELL.           KETA G1-3: THE "QUIRKY" ONE :WELL NAME
 UWI .           KETA-G1-QUIRKS          :UNIQUE WELL ID

~Curve Information Block
#MNEM.UNIT      API CODE                DESCRIPTION
 DEPT.M                                  :DEPTH (BOREHOLE)
 GR  .GAPI      45 310 01 00            :GAMMA RAY: TOTAL
 RHOB.G/C3      45 350 01 00            :BULK DENSITY
 NPHI.V/V                               :NEUTRON POROSITY: SANDSTONE MATRIX
 DT  .US/M                              :SONIC: DELTA-T

~Parameter Information Block
~Other Information
   Free text with   ragged   spacing and a URL http://example.com
~A  DEPT      GR        RHOB      NPHI      DT
"""
    body = "\n".join(data_row(r) for r in rows) + "\n"
    write(os.path.join(OUT, "quirks_20.las"), head + body, newline="\r\n")




# ---- LAS 3.0 fixtures (generator is the oracle; see module docstring) ----

def a34h(md):
    return 10.0 + 5.0 * math.sin(md / 11.0)


def p40h(md):
    return 12.0 + 6.0 * math.sin(md / 13.0)


def _f32_from_text(tok):
    """What a parser must store for an ASCII token: the decimal parsed to
    the nearest double, then rounded to float32 (Number() + Float32Array
    in JS; float() + astype(<f4) in numpy)."""
    return np.float32(float(tok))


def _write_golden(name, version, wrap, null, well, columns):
    """columns: list of (mnemonic, unit, descr, tokens) for NUMERIC curves
    only, tokens being the exact ASCII strings written to the file ('' or
    the null token meaning NaN). Emits the oracle.py schema plus an
    'oracle' marker."""
    curves = []
    for mnem, unit, descr, toks in columns:
        vals = np.array([np.nan if (t == "" or float(t) == null) else _f32_from_text(t) for t in toks], dtype="<f4")
        finite = vals[np.isfinite(vals)]
        curves.append({
            "mnemonic": mnem, "unit": unit, "descr": descr,
            "n_samples": int(vals.size),
            "null_count": int(np.count_nonzero(~np.isfinite(vals))),
            "first_finite": float(finite[0]) if finite.size else None,
            "last_finite": float(finite[-1]) if finite.size else None,
            "sum_finite_f64": float(np.sum(finite.astype(np.float64))) if finite.size else None,
        })
        vals.tofile(os.path.join(GOLD, f"{name}.{mnem}.f32"))
    meta = {
        "fixture": f"{name}.las", "version": version, "wrap": wrap, "null_value": null,
        "well": well, "depth_unit": columns[0][1], "curves": curves,
        "oracle": "genfixtures.py closed-form arrays (lasio 0.32 misreads LAS 3.0)",
    }
    with open(os.path.join(GOLD, f"{name}.json"), "w", newline="\n") as f:
        json.dump(meta, f, indent=2, sort_keys=True)
        f.write("\n")


def _well_items(strt, stop, step, unit, null, well, uwi):
    return {
        "STRT": {"unit": unit, "value": strt, "descr": "START DEPTH"},
        "STOP": {"unit": unit, "value": stop, "descr": "STOP DEPTH"},
        "STEP": {"unit": unit, "value": step, "descr": "STEP"},
        "WELL": {"unit": "", "value": well, "descr": "WELL"},
        "UWI": {"unit": "", "value": uwi, "descr": "UNIQUE WELL ID"},
        "COMP": {"unit": "", "value": "PETROLORD TEST", "descr": "COMPANY"},
        "FLD": {"unit": "", "value": "KETA", "descr": "FIELD"},
        "DATE": {"unit": "", "value": "2026-09-03 12:30:00", "descr": "LOG DATE"},
    }


def gen_las3_comma():
    null = -999.25
    depths = metric_depths(1500.0, 1509.5, 0.5)          # 20 samples
    liths = ["SAND", "SHALE", "SH,ALE", "SAND"]
    dept_t, gr_t, a34_t, p40_t, r1_t, r2_t, lith_t, time_t = [], [], [], [], [], [], [], []
    for i, md in enumerate(depths):
        dept_t.append(f"{md:.4f}")
        gr_t.append(f"{null:.2f}" if i % 7 == 3 else f"{gr(md):.4f}")
        a34_t.append("" if i == 9 else f"{a34h(md):.4f}")            # empty field = null
        p40_t.append(f"{p40h(md):.4E}")                               # {E} format
        r1_t.append(f"{rhob(md):.4f}")
        r2_t.append("" if i == 5 else f"{rhob(md) + 0.01:.4f}")
        lith_t.append(liths[i % 4])
        time_t.append(f"2026-01-01 00:{i:02d}:00")
    head = """~Version
 VERS.                3.0 : CWLS LOG ASCII STANDARD - VERSION 3.0
 WRAP.                 NO : ONE LINE PER DEPTH STEP
 DLM.               COMMA : DELIMITING CHARACTER (SPACE TAB OR COMMA)
~Well
 STRT.M            1500.0000 : START DEPTH
 STOP.M            1509.5000 : STOP DEPTH
 STEP.M               0.5000 : STEP
 NULL.              -999.25  : NULL VALUE
 COMP.        PETROLORD TEST : COMPANY
 WELL.             KETA L3-1 : WELL
 FLD.                   KETA : FIELD
 DATE.   2026-09-03 12:30:00 : LOG DATE {DT}
 UWI.             0123456789 : UNIQUE WELL ID
~Parameter
 RUN.                      1 : RUN NUMBER {I}
~Log_Parameter
 MATR.             SANDSTONE : NEUTRON MATRIX {S}
 BS.IN                  8.50 : BIT SIZE {F}
~Log_Definition
 DEPT.M                      : DEPTH {F}
 GR.GAPI          45 310 01  : GAMMA RAY {F} | Log_Data
 A34H.OHMM                   : ARRAY RESISTIVITY 34IN {F}
 P40H.OHMM                   : PHASE RESISTIVITY 40IN {E}
 LITH.                       : LITHOLOGY CODE {S}
 TIME.                       : TIME STAMP {DT}
 RHOB[1].G/C3                : BULK DENSITY PASS 1 {F}
 RHOB[2].G/C3                : BULK DENSITY PASS 2 {F}
~Log_Data | Log_Definition
# depth,GR,A34H,P40H,LITH,TIME,RHOB[1],RHOB[2]
"""
    rows = []
    for i in range(len(depths)):
        lith = f'"{lith_t[i]}"' if "," in lith_t[i] or i == 0 else lith_t[i]
        rows.append(",".join([dept_t[i], gr_t[i], a34_t[i], p40_t[i], lith, time_t[i], r1_t[i], r2_t[i]]))
    tail = """~Core_Definition
 CDEP.M                      : CORE DEPTH {F}
 CPOR.%                      : CORE POROSITY {F}
~Core_Data | Core_Definition
1500.2000,21.5
1501.7000,18.0
~Tops_Definition
 TOPT.                       : TOP NAME {S}
 TOPD.M                      : TOP DEPTH {F}
~Tops_Data | Tops_Definition
"Top Sand A",1500.4
"""
    write(os.path.join(OUT, "las3_comma_30.las"), head + "\n".join(rows) + "\n" + tail)
    _write_golden("las3_comma_30", 3.0, "NO", null,
                  _well_items(1500.0, 1509.5, 0.5, "M", null, "KETA L3-1", "0123456789"),
                  [("DEPT", "M", "DEPTH", dept_t), ("GR", "GAPI", "GAMMA RAY", gr_t),
                   ("A34H", "OHMM", "ARRAY RESISTIVITY 34IN", a34_t), ("P40H", "OHMM", "PHASE RESISTIVITY 40IN", p40_t),
                   ("RHOB[1]", "G/C3", "BULK DENSITY PASS 1", r1_t), ("RHOB[2]", "G/C3", "BULK DENSITY PASS 2", r2_t)])


def gen_las3_space():
    null = -999.25
    depths = metric_depths(1500.0, 1509.5, 0.5)
    cols = {"DEPT": [], "GR": [], "RHOB": [], "NPHI": [], "DT": []}
    for i, md in enumerate(depths):
        cols["DEPT"].append(f"{md:.4f}")
        cols["GR"].append(f"{null:.2f}" if i % 5 == 2 else f"{gr(md):.4f}")
        cols["RHOB"].append(f"{rhob(md):.4f}")
        cols["NPHI"].append(f"{nphi(md):.4f}")
        cols["DT"].append(f"{dt(md):.4f}")
    head = """~Version
 VERS.   3.0 : CWLS LOG ASCII STANDARD - VERSION 3.0
 WRAP.    NO : ONE LINE PER DEPTH STEP
 DLM.  SPACE : DELIMITING CHARACTER
~Well
 STRT.M   1500.0000 : START DEPTH
 STOP.M   1509.5000 : STOP DEPTH
 STEP.M      0.5000 : STEP
 NULL.      -999.25 : NULL VALUE
 COMP. PETROLORD TEST : COMPANY
 WELL.    KETA L3-2 : WELL
 FLD.          KETA : FIELD
 DATE. 2026-09-03 12:30:00 : LOG DATE {DT}
 UWI.    0123456790 : UNIQUE WELL ID
~Log_Parameter
 MATR.    SANDSTONE : NEUTRON MATRIX {S}
~Log_Definition
 DEPT.M     : DEPTH {F}
 GR.GAPI    : GAMMA RAY {F}
 RHOB.G/C3  : BULK DENSITY {F}
 NPHI.V/V   : NEUTRON POROSITY {F}
 DT.US/M    : SONIC {F}
~Log_Data | Log_Definition
"""
    rows = []
    for i in range(len(depths)):
        sep = "   " if i % 3 else " "
        rows.append(sep.join(cols[k][i] for k in ["DEPT", "GR", "RHOB", "NPHI", "DT"]))
    write(os.path.join(OUT, "las3_space_30.las"), head + "\n".join(rows) + "\n")
    _write_golden("las3_space_30", 3.0, "NO", null,
                  _well_items(1500.0, 1509.5, 0.5, "M", null, "KETA L3-2", "0123456790"),
                  [("DEPT", "M", "DEPTH", cols["DEPT"]), ("GR", "GAPI", "GAMMA RAY", cols["GR"]),
                   ("RHOB", "G/C3", "BULK DENSITY", cols["RHOB"]), ("NPHI", "V/V", "NEUTRON POROSITY", cols["NPHI"]),
                   ("DT", "US/M", "SONIC", cols["DT"])])


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(GOLD, exist_ok=True)
    gen_basic()
    gen_wrapped()
    gen_feet()
    gen_irregular()
    gen_nullheavy()
    gen_quirks()
    gen_las3_comma()
    gen_las3_space()


if __name__ == "__main__":
    main()
