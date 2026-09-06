#!/usr/bin/env python3
"""Stdlib oracle for the WS3 lag goldens (test-data/wellsite/lag-goldens.json).

Independent of the JS: annular capacities are pi/4 (D_hole^2 - D_pipe^2)
per metre, volumes are capacity times length per section, lag strokes are
annular volume over pump displacement, and time is the piecewise-constant
integration of the pump log written out by hand below. The README carries
the same numbers longhand.

Common well: 12.25 in open hole to 10,000 ft, 5 in drillpipe, 6 x 12 in
triplex at 97 percent (0.0161796 m3/stk).
"""
import json, math

FT = 0.3048
IN = 0.0254

def cap(d_hole_m, d_pipe_m):
    return math.pi / 4 * (d_hole_m * d_hole_m - d_pipe_m * d_pipe_m)

def triplex(d_in, l_in, eff):
    d = d_in * IN; l = l_in * IN
    return 3 * math.pi / 4 * d * d * l * eff

def build():
    m3s = triplex(6, 12, 0.97)
    hole = 12.25 * IN; dp = 5 * IN
    cap_oh = cap(hole, dp)
    bit = 10000 * FT
    vol = cap_oh * bit
    lag = vol / m3s
    lag_per_ft = lag / 10000.0

    # G1: constant 60 spm. Arrival of a sample cut at 10,000 ft at T0; lagged depth at T0 + 240 min
    # while drilling ahead at 50 ft/hr from 10,000 ft (bit at 10,200 ft at T0 + 240).
    g1_time = lag / 60.0
    # solve 60 (240 - T) = lag_per_ft (10000 + 0.833333 T)
    T = (60 * 240 - lag_per_ft * 10000) / (60 + lag_per_ft * (50 / 60.0))
    g1_lagged_ft = 10000 + (50 / 60.0) * T

    # G2: 60 spm for 60 min then 40 spm
    done = 60 * 60
    g2_time = 60 + (lag - done) / 40.0
    g2_readout_at_40 = lag / 40.0

    # G3: 60 spm for 30 min, pumps off 30 to 40, 60 spm from 40
    done3 = 60 * 30
    g3_time = 40 + (lag - done3) / 60.0
    g3_remaining_at_35 = lag - done3

    # G4: 13.375 in 72 lb/ft casing (ID 12.347 in) to 3000 ft, 12.25 in hole to 10,000 ft, 600 ft of 8 in collars, 5 in DP above
    cap_csg = cap(12.347 * IN, dp)
    cap_col = cap(hole, 8 * IN)
    v_csg = cap_csg * 3000 * FT
    v_oh_dp = cap_oh * (10000 - 3000 - 600) * FT
    v_col = cap_col * 600 * FT
    v4 = v_csg + v_oh_dp + v_col

    return {
        "m3PerStroke": m3s,
        "annulusCapM2PerM": cap_oh,
        "annulusVolumeM3_10000ft": vol,
        "lagStrokes_10000ft": lag,
        "lagStrokesPerFt": lag_per_ft,
        "G1": {"lagTimeMin": g1_time, "cutMinutesBeforeNow": T, "laggedDepthFt": g1_lagged_ft, "laggedDepthM": g1_lagged_ft * FT},
        "G2": {"arrivalMin": g2_time, "lagTimeAt40Min": g2_readout_at_40},
        "G3": {"arrivalMin": g3_time, "strokesRemainingAt35": g3_remaining_at_35},
        "G4": {"capCasedM2PerM": cap_csg, "capCollarsM2PerM": cap_col, "volCasedM3": v_csg, "volOpenHoleDpM3": v_oh_dp, "volCollarsM3": v_col,
               "annulusVolumeM3": v4, "lagStrokes": v4 / m3s},
    }

if __name__ == "__main__":
    print(json.dumps(build(), indent=2, sort_keys=True))
