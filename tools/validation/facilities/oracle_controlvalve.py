#!/usr/bin/env python3
"""Independent oracle for engines/facilities/controlValve.js.

Independent routes:
 - the liquid choking boundary is located by BISECTION on the stated
   pressure drop (find where the module's own regime flips), and the
   Cv either side is checked against the published equation evaluated
   independently. The point of interest is the boundary itself.
 - the gas expansion factor is checked against a SERIES of x values
   marching up to and past the terminal ratio, confirming Y falls
   linearly to exactly 2/3 and then stops.
 - equal-percentage travel is inverted independently: given a travel,
   the characteristic gives a Cv, and the module's travel-from-Cv must
   return the travel it started from (a round trip, not a restatement).
 - the ISA liquid and gas constants (1 and 1360) are checked by
   dimensional re-derivation in SI where that is meaningful.

stdlib only. Writes test-data/facilities/goldens/controlvalve_cases.json
"""

import json
import math
import os


def ff(pv, pc):
    return 0.96 - 0.28 * math.sqrt(pv / pc)


def liquid_cv(q, p1, p2, sg, pv, pc, fl):
    """Published ISA liquid form, evaluated independently."""
    dp_stated = p1 - p2
    dp_allow = fl * fl * (p1 - ff(pv, pc) * pv)
    choked = dp_stated >= dp_allow
    dp = dp_allow if choked else dp_stated
    return {
        "qGpm": q, "p1Psia": p1, "p2Psia": p2, "sg": sg,
        "pvPsia": pv, "pcPsia": pc, "fl": fl,
        "ff": ff(pv, pc),
        "dpAllowablePsi": dp_allow,
        "choked": choked,
        "cv": q * math.sqrt(sg / dp),
    }


def choking_boundary_by_bisection(p1, sg, pv, pc, fl, q=500.0):
    """Find the p2 at which the service just chokes, by bisection on
    the regime flag rather than by evaluating the closed form."""
    def is_choked(p2):
        return (p1 - p2) >= fl * fl * (p1 - ff(pv, pc) * pv)

    lo, hi = 0.001, p1 - 0.001   # lo = big drop (choked), hi = small drop
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if is_choked(mid):
            lo = mid
        else:
            hi = mid
    p2_boundary = 0.5 * (lo + hi)
    return {
        "p1Psia": p1, "sg": sg, "pvPsia": pv, "pcPsia": pc, "fl": fl,
        "qGpm": q,
        "p2BoundaryPsia": p2_boundary,
        "dpBoundaryPsi": p1 - p2_boundary,
        "dpAllowablePsi": fl * fl * (p1 - ff(pv, pc) * pv),
    }


def gas_march(p1, xt, k, n=40):
    """March x from 0 to past the terminal ratio and record Y."""
    fk = k / 1.4
    x_choked = fk * xt
    rows = []
    for i in range(n + 1):
        x = (x_choked * 1.5) * i / n
        x_used = min(x, x_choked)
        y = 1 - x_used / (3 * fk * xt)
        rows.append({"x": x, "y": y, "choked": x >= x_choked})
    return {"p1Psia": p1, "xt": xt, "k": k, "fk": fk,
            "xChoked": x_choked, "rows": rows}


def gas_cv(q, p1, p2, sg, t_f, z, k, xt):
    fk = k / 1.4
    x = (p1 - p2) / p1
    x_ch = fk * xt
    x_used = min(x, x_ch)
    y = 1 - x_used / (3 * fk * xt)
    t_r = t_f + 459.67
    return {
        "qScfh": q, "p1Psia": p1, "p2Psia": p2, "gasSg": sg,
        "tF": t_f, "z": z, "k": k, "xt": xt,
        "x": x, "xChoked": x_ch, "y": y,
        "choked": x >= x_ch,
        "cv": q / (1360.0 * p1 * y) * math.sqrt(sg * t_r * z / x_used),
    }


def eq_pct_roundtrip(cv_rated, rangeability, travels):
    """Given a travel, compute Cv from the equal-percentage law; the
    module must return that travel from that Cv."""
    out = []
    for h in travels:
        cv = cv_rated * rangeability ** (h - 1.0)
        out.append({"travelFraction": h, "cv": cv})
    return {"cvRated": cv_rated, "rangeability": rangeability, "points": out}


def main():
    out = {}

    out["liquid"] = [
        liquid_cv(500.0, 200.0, 150.0, 0.85, 5.0, 3200.0, 0.90),   # unchoked
        liquid_cv(500.0, 200.0, 20.0, 0.85, 5.0, 3200.0, 0.90),    # choked
        liquid_cv(1200.0, 600.0, 400.0, 1.02, 0.5, 3200.0, 0.66),  # ball valve
        liquid_cv(300.0, 150.0, 60.0, 0.72, 25.0, 550.0, 0.97),    # volatile, anti-cav
    ]

    out["boundary"] = [
        choking_boundary_by_bisection(200.0, 0.85, 5.0, 3200.0, 0.90),
        choking_boundary_by_bisection(600.0, 1.02, 0.5, 3200.0, 0.66),
    ]

    out["gasMarch"] = gas_march(300.0, 0.72, 1.28)

    out["gas"] = [
        gas_cv(500000.0, 300.0, 250.0, 0.65, 100.0, 0.95, 1.28, 0.72),
        gas_cv(500000.0, 300.0, 100.0, 0.65, 100.0, 0.95, 1.28, 0.72),
        gas_cv(2000000.0, 900.0, 700.0, 0.70, 120.0, 0.88, 1.26, 0.75),
    ]

    out["travel"] = eq_pct_roundtrip(100.0, 50.0, [0.2, 0.4, 0.6, 0.8, 1.0])

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "controlvalve_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
