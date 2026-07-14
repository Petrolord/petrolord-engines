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

Regenerate:  tools/validation/wells/.venv/bin/python \
                 tools/validation/wells/genfixtures.py
Then re-run oracle.py to refresh the goldens.
"""

import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "wells", "las"))

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


def main():
    os.makedirs(OUT, exist_ok=True)
    gen_basic()
    gen_wrapped()
    gen_feet()
    gen_irregular()
    gen_nullheavy()
    gen_quirks()


if __name__ == "__main__":
    main()
