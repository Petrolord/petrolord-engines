#!/usr/bin/env python3
"""Stdlib oracle for the WS0 wellsite goldens (depth, pumps).

Independent of the JS: minimum curvature is written out longhand here for
the two-station build section, the datum shifts are plain arithmetic and
the pump displacements are the textbook geometry. Run through
genfixtures.py to (re)write test-data/wellsite/ws0-goldens.json byte for
byte.
"""
import json, math

M_PER_FT = 0.3048
M_PER_IN = 0.0254
M3_PER_BBL = 0.158987294928

def triplex(d_in, l_in, eff):
    d = d_in * M_PER_IN; l = l_in * M_PER_IN
    theo = 3 * math.pi / 4 * d * d * l
    return {"theoreticalM3PerStroke": theo, "m3PerStroke": theo * eff, "bblPerStroke": theo * eff / M3_PER_BBL,
            "fieldBblPerStroke": 0.000243 * d_in * d_in * l_in * eff}

def duplex(d_in, l_in, rod_in, eff):
    d = d_in * M_PER_IN; l = l_in * M_PER_IN; r = rod_in * M_PER_IN
    theo = 2 * l * (2 * math.pi / 4 * d * d - math.pi / 4 * r * r)
    return {"theoreticalM3PerStroke": theo, "m3PerStroke": theo * eff, "bblPerStroke": theo * eff / M3_PER_BBL,
            "fieldBblPerStroke": 0.000162 * (2 * d_in * d_in - rod_in * rod_in) * l_in * eff}

def tvd_build(md_from, md_to, inc_to_deg, md):
    """TVD increment through a build from vertical (inc 0) to inc_to at md_to, evaluated at md (partial arc)."""
    frac = (md - md_from) / (md_to - md_from)
    inc = math.radians(inc_to_deg * frac)          # attitude along the arc is linear in MD
    beta = inc                                       # dogleg from vertical equals the inclination reached
    rf = 1.0 if beta < 1e-12 else (2 / beta) * math.tan(beta / 2)
    return ((md - md_from) / 2) * (1 + math.cos(inc)) * rf

def build():
    kb, gl = 25.0, 4.0
    # vertical well: 3000 ft MD below GL
    md_kb = 3000 * M_PER_FT + (kb - gl)
    vertical = {"entry": {"value": 3000, "unit": "ft", "reference": "MD", "datum": "GL", "kind": "bit_depth"},
                "kbElevM": kb, "glElevM": gl,
                "expected": {"mdM": md_kb, "tvdM": md_kb, "tvdssM": md_kb - kb, "displayFtRt": md_kb / M_PER_FT}}
    # deviated: vertical to 1400, build to 30 deg at 1750 (azimuth 90)
    tvd_1600 = 1400 + tvd_build(1400, 1750, 30, 1600)
    tvd_1750 = 1400 + tvd_build(1400, 1750, 30, 1750)
    tvd_1900 = tvd_1750 + 150 * math.cos(math.radians(30))
    deviated = {"stations": [{"md": 0, "inc": 0, "azi": 0}, {"md": 1400, "inc": 0, "azi": 0}, {"md": 1750, "inc": 30, "azi": 90}],
                "kbElevM": kb,
                "expected": {"tvdAt1600": tvd_1600, "tvdAt1750": tvd_1750, "tvdAt1900Extrapolated": tvd_1900,
                             "mdOfTvd1600": None}}
    pumps = {"triplex_6x12_97": triplex(6, 12, 0.97), "duplex_7p25x14_rod2p5_90": duplex(7.25, 14, 2.5, 0.90)}
    return {"vertical": vertical, "deviated": deviated, "pumps": pumps}

if __name__ == "__main__":
    print(json.dumps(build(), indent=2, sort_keys=True))
