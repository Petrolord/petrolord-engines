#!/usr/bin/env python3
"""Stdlib oracle for the U2-004 lag check goldens (test-data/wellsite/lagcheck-goldens.json).

Independent of the JS and written in FIELD units the way a mudlogger works
it on paper: capacities in bbl/ft are D^2 / 1029.4 (inches), volumes are
capacity times feet, strokes are barrels over the pump output in bbl/stk.
The JS works in SI from pi/4 D^2 L; the two agree to the rounding of the
1029.4 constant (exactly 1029.4 = 4 x 9702 / (pi x 12), see CONST below,
which is used unrounded so the comparison is tight).

Well: 9 5/8 in casing (ID 8.681 in) to 6,000 ft, 8 1/2 in open hole to the
bit at 10,000 ft, 5 in drillpipe (ID 4.276 in) with 600 ft of 6 1/2 in
collars (ID 2 13/16 in). Pump: 6 x 12 in triplex at 97 percent.

Case L1 (carbide check, washed-out hole): the hole between the shoe and the
bit is 20 percent over gauge by volume. Carbide dropped at a connection is
detected after `total` strokes.
Case L2 (short lag): the count is 150 strokes fewer than gauge would give.
"""
import json, math, os

CONST = 4 * 9702 / (math.pi * 12)   # 1029.4...: bbl/ft = D^2 / CONST with D in inches (1 bbl = 9702 in3)
BBL_M3 = 0.158987294928
FT = 0.3048
IN = 0.0254

def cap(d_in):            # bbl per ft of a cylinder
    return d_in * d_in / CONST

def ann(dh_in, dp_in):    # bbl per ft of an annulus
    return (dh_in * dh_in - dp_in * dp_in) / CONST

def build():
    out_bbl = 3 * (math.pi / 4) * 6 * 6 * 12 * 0.97 / 9702.0      # triplex, in3 to bbl
    shoe, bit, dc_len = 6000.0, 10000.0, 600.0
    dp_len = bit - dc_len
    string_bbl = cap(4.276) * dp_len + cap(2.8125) * dc_len
    down = string_bbl / out_bbl
    ann_cased = ann(8.681, 5.0) * shoe
    ann_oh_dp = ann(8.5, 5.0) * (bit - shoe - dc_len)
    ann_oh_dc = ann(8.5, 6.5) * dc_len
    ann_bbl = ann_cased + ann_oh_dp + ann_oh_dc
    calc_lag = ann_bbl / out_bbl
    gauge_oh_bbl = cap(8.5) * (bit - shoe)

    washout = 0.20
    excess_bbl = washout * gauge_oh_bbl
    measured = calc_lag + excess_bbl / out_bbl
    total = down + measured
    d_eq_in = 8.5 * math.sqrt(1 + washout)
    # the corrected annulus recomputed from the equivalent diameter must give the measured lag
    ann_corr = ann_cased + ann(d_eq_in, 5.0) * (bit - shoe - dc_len) + ann(d_eq_in, 6.5) * dc_len
    assert abs(ann_corr / out_bbl - measured) < 1e-6

    # the two classic mistakes, for the negative controls
    wrong_no_down = ((total - calc_lag) * out_bbl) / gauge_oh_bbl          # down strokes not subtracted
    wrong_annulus_base = excess_bbl / (ann_oh_dp + ann_oh_dc)              # excess over the annulus, not the hole

    short_total = down + calc_lag - 150.0
    return {
        "_source": "tools/validation/wellsite/oracle_lagcheck.py (stdlib, field units; the hand-derived whole-well case. The published INTEQ cases are in the test itself)",
        "pump": {"type": "triplex", "linerIn": 6, "strokeIn": 12, "efficiency": 0.97, "bblPerStroke": out_bbl, "m3PerStroke": out_bbl * BBL_M3},
        "well": {"shoeFt": shoe, "bitFt": bit, "casingIdIn": 8.681, "holeIn": 8.5, "dpOdIn": 5.0, "dpIdIn": 4.276, "dcOdIn": 6.5, "dcIdIn": 2.8125, "dcLenFt": dc_len},
        "stringBbl": string_bbl, "downStrokes": down,
        "annulusBbl": ann_bbl, "calculatedLagStrokes": calc_lag, "gaugeOpenHoleBbl": gauge_oh_bbl,
        "L1": {"washoutFraction": washout, "excessBbl": excess_bbl, "measuredLagStrokes": measured, "totalStrokes": total,
               "equivalentDiameterIn": d_eq_in, "diameterFactor": math.sqrt(1 + washout),
               "wrongNoDownStrokes": wrong_no_down, "wrongAnnulusBase": wrong_annulus_base},
        "L2": {"totalStrokes": short_total, "differenceStrokes": -150.0, "excessBbl": -150.0 * out_bbl},
    }

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    dst = os.path.normpath(os.path.join(here, "..", "..", "..", "test-data", "wellsite", "lagcheck-goldens.json"))
    with open(dst, "w") as f:
        json.dump(build(), f, indent=2, sort_keys=True)
        f.write("\n")
    print("wrote", dst)
