#!/usr/bin/env python3
"""Oracle for engines/earthmodeling/volumes.js zoneVolumesWithContacts
(Earth Modeling T1, 2026-09-26). Stdlib only; never from the JS.

Each node's interval [top, base] (m, positive down) is cut by the GOC and
OWC: gas = overlap with [-inf, GOC], oil = overlap with [GOC, OWC], water
the rest. HCPV sums gas and oil columns; STOIIP = oil HCPV / Bo, GIIP =
gas HCPV / Bg.

Self-asserted anchors (fail loudly at generation):
  A1 no contacts: every column is oil and the totals equal the plain
     thickness sums (the zoneVolumes behaviour).
  A2 cone dome (top = 1800 + 0.1 r, 50 m thick), GOC 1830, OWC 1880:
     the grid sums of gas and oil bulk volume agree within 1% with a
     radial integral of the same geometry, 2 pi r * overlap(r) dr, with
     20,000 steps (independent of the grid).
  A3 per-block contacts: a block with a shallower OWC holds less oil.

Run:  python3 tools/validation/earthmodel/oracle_contacts.py
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "earthmodel"))


def overlap(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def node_columns(zt, zb, goc, owc):
    hc_bottom = zb if owc is None else min(zb, owc)
    gas = 0.0 if goc is None else max(0.0, min(hc_bottom, goc) - zt)
    oil_top = zt if goc is None else max(zt, goc)
    oil = max(0.0, hc_bottom - oil_top)
    return max(0.0, zb - zt), gas, oil


def volumes(spec, top, base, labels, ntg, phi, sw, goc, owc, bo, bg):
    cell = spec["dx"] * spec["dy"]
    out = {}
    for j in range(len(top)):
        lab = str(labels[j]) if labels else "0"
        g = goc.get(lab) if isinstance(goc, dict) else goc
        w = owc.get(lab) if isinstance(owc, dict) else owc
        t, gt, ot = node_columns(top[j], base[j], g, w)
        for key in (lab, "total"):
            b = out.setdefault(key, {k: 0.0 for k in ("bulk_m3", "net_m3", "pore_m3", "hcpv_m3", "gas_hcpv_m3", "oil_hcpv_m3", "gas_bulk_m3", "oil_bulk_m3")})
            b.setdefault("cells", 0)
            b["cells"] += 1
            b["bulk_m3"] += t * cell
            b["gas_bulk_m3"] += gt * cell
            b["oil_bulk_m3"] += ot * cell
            b["net_m3"] += t * cell * ntg[j]
            b["pore_m3"] += t * cell * ntg[j] * phi[j]
            f = cell * ntg[j] * phi[j] * (1 - sw[j])
            b["gas_hcpv_m3"] += gt * f
            b["oil_hcpv_m3"] += ot * f
            b["hcpv_m3"] += (gt + ot) * f
    for b in out.values():
        b["stoiip_m3"] = b["oil_hcpv_m3"] / bo if bo else None
        b["giip_m3"] = b["gas_hcpv_m3"] / bg if bg else None
    return out


def main():
    spec = {"x0": -1500.0, "y0": -1500.0, "dx": 25.0, "dy": 25.0, "nx": 121, "ny": 121}
    top, base, labels = [], [], []
    for r in range(spec["ny"]):
        for c in range(spec["nx"]):
            x = spec["x0"] + c * spec["dx"]
            y = spec["y0"] + r * spec["dy"]
            zt = 1800.0 + 0.1 * math.hypot(x, y)
            top.append(zt)
            base.append(zt + 50.0)
            labels.append(1 if x > 0 else 0)
    n = len(top)
    ntg = [0.8] * n
    phi = [0.25] * n
    sw = [0.3] * n

    none = volumes(spec, top, base, None, ntg, phi, sw, None, None, None, None)
    assert abs(none["total"]["oil_bulk_m3"] - none["total"]["bulk_m3"]) < 1e-6 * none["total"]["bulk_m3"], "A1"
    assert none["total"]["gas_bulk_m3"] == 0.0, "A1"

    split = volumes(spec, top, base, None, ntg, phi, sw, 1830.0, 1880.0, 1.25, 0.005)
    steps = 20000
    rmax = 1500.0
    gas_a = oil_a = 0.0
    for k in range(steps):
        r = (k + 0.5) * rmax / steps
        zt = 1800.0 + 0.1 * r
        _, g, o = node_columns(zt, zt + 50.0, 1830.0, 1880.0)
        dA = 2 * math.pi * r * (rmax / steps)
        gas_a += g * dA
        oil_a += o * dA
    assert abs(split["total"]["gas_bulk_m3"] / gas_a - 1) < 0.01, ("A2 gas", split["total"]["gas_bulk_m3"], gas_a)
    assert abs(split["total"]["oil_bulk_m3"] / oil_a - 1) < 0.01, ("A2 oil", split["total"]["oil_bulk_m3"], oil_a)

    per_block = volumes(spec, top, base, labels, ntg, phi, sw, None, {"0": 1880.0, "1": 1850.0}, 1.25, None)
    assert per_block["1"]["oil_hcpv_m3"] < per_block["0"]["oil_hcpv_m3"], "A3"

    # the golden carries the inputs of three cases and the expected totals
    cases = [
        {"name": "no_contacts", "fluids": {}, "labels": False, "expected": none},
        {"name": "goc_owc_fvf", "fluids": {"goc": 1830.0, "owc": 1880.0, "bo": 1.25, "bg": 0.005}, "labels": False, "expected": split},
        {"name": "owc_by_block", "fluids": {"owc": {"0": 1880.0, "1": 1850.0}, "bo": 1.25}, "labels": True, "expected": per_block},
    ]
    out = {"$comment": "Written by tools/validation/earthmodel/oracle_contacts.py; never edit by hand.",
           "tolerance": 1e-9, "spec": spec, "top": top, "base": base, "labels": labels,
           "ntg": 0.8, "phi": 0.25, "sw": 0.3, "radial": {"gas_bulk_m3": gas_a, "oil_bulk_m3": oil_a}, "cases": cases}
    with open(os.path.join(GOLD, "contacts_cases.json"), "w") as f:
        json.dump(out, f, sort_keys=True, separators=(",", ":"))
    print("wrote", len(cases), "contact cases")


if __name__ == "__main__":
    main()
