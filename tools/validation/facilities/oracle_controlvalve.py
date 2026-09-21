#!/usr/bin/env python3
"""Independent oracle for engines/facilities/controlValve.js.

WHAT EACH ROUTE CHECKS, AND WHAT IT CANNOT. Written out per route
because the honest answer is different for each, and because the two
claims that used to stand at the top of this file described routes the
file did not contain:

 - `liquid`: the liquid Cv in ARBITRARY-PRECISION DECIMAL, with the
   terms grouped differently from the module. This checks the assembly
   and the floating-point arithmetic. IT DOES NOT CHECK A PACKAGING
   CONSTANT, BECAUSE THE LIQUID FORM HAS NONE: Cv is DEFINED as the US
   gallons per minute of water at 60 F that pass at one psi of drop, so
   Q sqrt(SG/dP) is the definition rather than a unit conversion, and
   there is nothing in it to re-derive. This file used to claim it
   re-derived "the ISA liquid and gas constants (1 and 1360) by
   dimensional re-derivation in SI"; for the liquid 1 that claim was
   meaningless and for 1360 there was no such route. The 1360 route now
   exists, below, and this sentence is what replaces the liquid half of
   the claim.

 - `gasSi`: THE 1360 PACKAGING, GENUINELY RE-DERIVED. The gas form is
   the liquid definition applied to a gas at its inlet density, so the
   route goes: scfh to moles per hour through the molar volume formed
   from the SI gas constant at the 14.696 psia and 519.67 R base;
   moles to an actual volumetric rate at inlet through the real gas
   law in SI; an SI density and the density of water at 60 F to a
   specific gravity at flowing conditions; a metric Kv from cubic
   metres per hour and bar; and Kv back to Cv through the published
   0.865. Nothing on that path is the module's expression. The residual
   against the module is about 0.25 percent, which is the rounding
   inside 1360 plus the choice of water density: a real disagreement
   between two arithmetics, and far smaller than any plausible error
   in the constant.

 - `boundary`: the choking boundary. The bisection here used to call a
   predicate that RESTATED the module's own inequality, so the route
   was an independent root find on a transcribed predicate. It now
   records the closed-form boundary only, and THE SUITE LOCATES IT FROM
   THE MODULE'S Cv OUTPUTS ALONE, by finding the outlet pressure below
   which the required Cv stops changing. The module's `choked` flag is
   never read while locating it.

 - `gasMarch`: the expansion factor marched across and past the
   terminal ratio. A STRUCTURAL route, not an independent computation:
   it checks that Y falls LINEARLY in x with a constant slope, reaches
   exactly two thirds at the terminal ratio and then stops moving. Those
   three properties pin the divisor 3 and the floor without either file
   having a source for them.

 - `travel`: the equal-percentage characteristic inverted. Given a
   travel, the characteristic gives a Cv, and the module's
   travel-from-Cv must return the travel it started from. A round trip,
   not a restatement. Genuinely independent.

 - `authority` and `noise`: new routes for two exports that had none.
   The noise route re-derives the 379.49 cubic feet per pound mole from
   the SI gas constant and the standard base, and the stream power from
   the specific gas constant of air formed out of the SI gas constant
   and the molar mass, so both of those packagings are checked. The
   BANDS are this engine's stated screen and no route can validate
   them; the suite pins them by literal and carries a row per band.

 - `travelStates`: conditions that exercise every state and every
   warning branch of the travel check, including the two that one null
   used to conflate.

stdlib only. Writes test-data/facilities/goldens/controlvalve_cases.json
"""

import json
import math
import os
from decimal import Decimal, getcontext

getcontext().prec = 60

PSI_TO_PA = 6894.757293168
FT3_TO_M3 = 0.028316846592
LB_TO_KG = 0.45359237
R_SI = 8.314462618           # J / (mol K)
M_AIR_KG = 0.0289625         # kg / mol, the module's 28.9625 lb/lbmol
RHO_WATER_60F = 999.0165     # kg / m3
GPM_TO_M3H = 0.227124708
KV_PER_CV = 0.865            # the published metric-to-imperial coefficient
# molar volume at the 14.696 psia, 519.67 R base, from the SI gas constant
V_MOLAR_BASE_M3 = R_SI * (519.67 / 1.8) / (14.696 * PSI_TO_PA)


def ff(pv, pc):
    return 0.96 - 0.28 * math.sqrt(pv / pc)


# ------------------------------------------------------------------ #
# liquid, in high-precision decimal
# ------------------------------------------------------------------ #

def liquid_cv(q, p1, p2, sg, pv, pc, fl):
    """The liquid form in 60-digit decimal, grouped differently.

    Checks the assembly and the arithmetic. There is no packaging
    constant here to check: see the module docstring.
    """
    dq = Decimal(repr(q))
    dp1 = Decimal(repr(p1))
    dp2 = Decimal(repr(p2))
    dsg = Decimal(repr(sg))
    dpv = Decimal(repr(pv))
    dpc = Decimal(repr(pc))
    dfl = Decimal(repr(fl))
    dff = Decimal("0.96") - Decimal("0.28") * (dpv / dpc).sqrt()
    dp_stated = dp1 - dp2
    dp_allow = dfl * dfl * (dp1 - dff * dpv)
    choked = dp_stated >= dp_allow
    dp_used = dp_allow if choked else dp_stated
    # grouped as (rate over the square root of the drop) times the
    # square root of the gravity, rather than sg/dp under one root
    cv = dq / dp_used.sqrt() * dsg.sqrt()
    sigma = (dp1 - dpv) / dp_used
    return {
        "qGpm": q, "p1Psia": p1, "p2Psia": p2, "sg": sg,
        "pvPsia": pv, "pcPsia": pc, "fl": fl,
        "ff": float(dff),
        "dpStatedPsi": float(dp_stated),
        "dpAllowablePsi": float(dp_allow),
        "dpUsedPsi": float(dp_used),
        "choked": choked,
        "flashing": p2 <= pv,
        "sigma": float(sigma),
        "cv": float(cv),
    }


def choking_boundary(p1, sg, pv, pc, fl, q=500.0):
    """The closed-form boundary only.

    The SUITE locates this from the module's Cv outputs, without
    reading the module's own choked flag.
    """
    dp_allow = fl * fl * (p1 - ff(pv, pc) * pv)
    return {
        "p1Psia": p1, "sg": sg, "pvPsia": pv, "pcPsia": pc, "fl": fl,
        "qGpm": q,
        "p2BoundaryPsia": p1 - dp_allow,
        "dpBoundaryPsi": dp_allow,
        "dpAllowablePsi": dp_allow,
    }


# ------------------------------------------------------------------ #
# gas
# ------------------------------------------------------------------ #

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
            "xChoked": x_choked,
            # the slope of Y against x below choking: dY/dx = -1/(3 Fk xT)
            "slopePerX": -1.0 / (3 * fk * xt),
            "yAtChoked": 2.0 / 3.0,
            "rows": rows}


def gas_cv(q, p1, p2, sg, t_f, z, k, xt):
    """x, the terminal ratio, Y and the choked flag, structurally."""
    fk = k / 1.4
    x = (p1 - p2) / p1
    x_ch = fk * xt
    x_used = min(x, x_ch)
    y = 1 - x_used / (3 * fk * xt)
    t_r = t_f + 459.67
    return {
        "qScfh": q, "p1Psia": p1, "p2Psia": p2, "gasSg": sg,
        "tF": t_f, "z": z, "k": k, "xt": xt,
        "x": x, "xChoked": x_ch, "y": y, "xUsed": x_used,
        "choked": x >= x_ch,
    }


def gas_cv_si(q_scfh, p1, p2, sg, t_f, z, k, xt):
    """THE 1360 PACKAGING, re-derived through SI and a metric Kv.

    scfh -> mol/hr through the SI molar volume at base
         -> m3/hr at inlet through the real gas law in SI
         -> Kv from m3/hr and bar with an SI specific gravity
         -> Cv through the published 0.865
    """
    m_kg_mol = M_AIR_KG * sg
    t_k = (t_f + 459.67) / 1.8
    p1_pa = p1 * PSI_TO_PA
    fk = k / 1.4
    x = (p1 - p2) / p1
    x_ch = fk * xt
    x_used = min(x, x_ch)
    y = 1 - x_used / (3 * fk * xt)
    n_dot_mol_hr = q_scfh * FT3_TO_M3 / V_MOLAR_BASE_M3
    v_dot_m3_hr = n_dot_mol_hr * z * R_SI * t_k / p1_pa
    rho_kgm3 = p1_pa * m_kg_mol / (z * R_SI * t_k)
    sg_flowing = rho_kgm3 / RHO_WATER_60F
    dp_bar = x_used * p1 * PSI_TO_PA / 1e5
    kv = v_dot_m3_hr * math.sqrt(sg_flowing / dp_bar) / y
    return {
        "qScfh": q_scfh, "p1Psia": p1, "p2Psia": p2, "gasSg": sg,
        "tF": t_f, "z": z, "k": k, "xt": xt,
        "cv": kv / KV_PER_CV,
        "route": "scfh to mol/hr to m3/hr at inlet to Kv to Cv",
    }


# ------------------------------------------------------------------ #
# travel
# ------------------------------------------------------------------ #

def eq_pct_roundtrip(cv_rated, rangeability, travels):
    """Given a travel, compute Cv from the equal-percentage law; the
    module must return that travel from that Cv."""
    out = []
    for h in travels:
        cv = cv_rated * rangeability ** (h - 1.0)
        out.append({"travelFraction": h, "cv": cv})
    return {"cvRated": cv_rated, "rangeability": rangeability, "points": out}


def travel_states():
    """One row per state and per warning branch of the travel check.

    `expectStates` and `expectWarnings` are what the check must report.
    The point of these rows is the pair at the end: a maximum flow that
    is BEYOND THE VALVE and a maximum flow that was NOT GIVEN used to
    produce the same null and the same alarming warning.
    """

    def cv_at(travel_pct, rated=100.0, r=50.0):
        return rated * r ** (travel_pct / 100.0 - 1.0)

    return [
        {"label": "all three inside the band",
         "cvRequiredMin": cv_at(25), "cvRequiredNormal": cv_at(50),
         "cvRequiredMax": cv_at(75), "cvRated": 100.0,
         "expectStates": ["ok", "ok", "ok"],
         "expectChecksPerformed": 3, "expectPass": True,
         "expectWarningCount": 0},
        {"label": "maximum beyond the valve",
         "cvRequiredMin": 5.0, "cvRequiredNormal": 60.0,
         "cvRequiredMax": 150.0, "cvRated": 100.0,
         "expectStates": ["ok", "ok", "beyond the valve"],
         "expectChecksPerformed": 3, "expectPass": False,
         "expectWarningCount": 2},
        {"label": "maximum not given",
         "cvRequiredMin": cv_at(25), "cvRequiredNormal": cv_at(50),
         "cvRequiredMax": None, "cvRated": 100.0,
         "expectStates": ["ok", "ok", "not given"],
         "expectChecksPerformed": 2, "expectPass": None,
         "expectWarningCount": 0},
        {"label": "minimum not given: the near-seat check cannot run",
         "cvRequiredMin": None, "cvRequiredNormal": cv_at(50),
         "cvRequiredMax": cv_at(70), "cvRated": 100.0,
         "expectStates": ["not given", "ok", "ok"],
         "expectChecksPerformed": 2, "expectPass": None,
         "expectWarningCount": 0},
        {"label": "nothing but a rated Cv",
         "cvRequiredMin": None, "cvRequiredNormal": None,
         "cvRequiredMax": None, "cvRated": 100.0,
         "expectStates": ["not given", "not given", "not given"],
         "expectChecksPerformed": 0, "expectPass": None,
         "expectWarningCount": 0},
        {"label": "near the seat at minimum",
         "cvRequiredMin": cv_at(6), "cvRequiredNormal": cv_at(50),
         "cvRequiredMax": cv_at(70), "cvRated": 100.0,
         "expectStates": ["ok", "ok", "ok"],
         "expectChecksPerformed": 3, "expectPass": False,
         "expectWarningCount": 1},
        {"label": "no margin at maximum",
         "cvRequiredMin": cv_at(30), "cvRequiredNormal": cv_at(50),
         "cvRequiredMax": cv_at(95), "cvRated": 100.0,
         "expectStates": ["ok", "ok", "ok"],
         "expectChecksPerformed": 3, "expectPass": False,
         "expectWarningCount": 1},
        {"label": "normal outside the 20 to 80 band, low",
         "cvRequiredMin": cv_at(12), "cvRequiredNormal": cv_at(15),
         "cvRequiredMax": cv_at(50), "cvRated": 100.0,
         "expectStates": ["ok", "ok", "ok"],
         "expectChecksPerformed": 3, "expectPass": False,
         "expectWarningCount": 1},
        {"label": "the whole range beyond the valve",
         "cvRequiredMin": 120.0, "cvRequiredNormal": 150.0,
         "cvRequiredMax": 200.0, "cvRated": 100.0,
         "expectStates": ["beyond the valve", "beyond the valve", "beyond the valve"],
         "expectChecksPerformed": 3, "expectPass": False,
         "expectWarningCount": 3},
    ]


# ------------------------------------------------------------------ #
# authority and noise
# ------------------------------------------------------------------ #

def authority_rows():
    """Every verdict label, with the ratio computed independently."""
    rows = []
    for dp_valve, dp_total, verdict in [
        (60.0, 100.0, "good"),
        (50.0, 100.0, "good"),
        (40.0, 100.0, "acceptable"),
        (25.0, 100.0, "acceptable"),
        (10.0, 100.0, "poor"),
        (3.0, 90.0, "poor"),
    ]:
        rows.append({
            "dpValvePsi": dp_valve, "dpSystemTotalPsi": dp_total,
            "authority": dp_valve / dp_total,
            "verdict": verdict,
            # the published selection rule, so the pair is checked together
            "characteristic": "linear" if dp_valve / dp_total >= 0.5 else "equalPercentage",
        })
    return rows


def noise_rows():
    """Every band, with the mass flow and the stream power in SI.

    The 379.49 cubic feet per pound mole and the 287 J/(kg K) of air
    are both re-derived here from the SI gas constant, so this route
    checks both packagings. The bands themselves are the engine's
    stated screen and cannot be validated by anything.
    """
    rows = []
    cases = [
        # p1, p2, q scfh, sg, tF, expected band, why
        (120.0, 100.0, 1e5, 0.65, 100.0, "low", "ratio below 2"),
        (300.0, 110.0, 5e5, 0.65, 100.0, "moderate", "ratio between 2 and 4"),
        (600.0, 100.0, 1e6, 0.65, 100.0, "high", "ratio between 4 and 10"),
        (900.0, 60.0, 2e6, 0.65, 100.0, "severe", "ratio at or above 10"),
        # a bleed at a severe pressure ratio: the stream power holds the
        # band down, because a trickle cannot be loud
        (600.0, 50.0, 1.0, 0.65, 100.0, "low", "power below 1 kW holds it down"),
        # a very large flow at a mild ratio: the stream power raises it
        (200.0, 105.0, 1e8, 0.65, 100.0, "moderate", "power above 1000 kW raises it"),
    ]
    for p1, p2, q, sg, t_f, band, why in cases:
        t_k = (t_f + 459.67) / 1.8
        ratio = p1 / p2
        n_dot_mol_hr = q * FT3_TO_M3 / V_MOLAR_BASE_M3
        m_kg_hr = n_dot_mol_hr * M_AIR_KG * sg
        r_specific = R_SI / M_AIR_KG
        power_kw = (m_kg_hr / 3600.0) * r_specific * t_k * math.log(ratio) / 1000.0
        rows.append({
            "p1Psia": p1, "p2Psia": p2, "qScfh": q, "gasSg": sg, "tF": t_f,
            "pressureRatio": ratio,
            "massFlowLbHr": m_kg_hr / LB_TO_KG,
            "streamPowerKw": power_kw,
            "expectBand": band, "why": why,
        })
    return rows


def main():
    out = {}

    out["liquid"] = [
        liquid_cv(500.0, 200.0, 150.0, 0.85, 5.0, 3200.0, 0.90),   # unchoked
        liquid_cv(500.0, 200.0, 20.0, 0.85, 5.0, 3200.0, 0.90),    # choked
        liquid_cv(1200.0, 600.0, 400.0, 1.02, 0.5, 3200.0, 0.66),  # ball valve
        liquid_cv(300.0, 150.0, 60.0, 0.72, 25.0, 550.0, 0.97),    # volatile, anti-cav
        liquid_cv(420.0, 240.0, 205.0, 0.78, 8.0, 2900.0, 0.80),   # incipient
    ]

    out["boundary"] = [
        choking_boundary(200.0, 0.85, 5.0, 3200.0, 0.90),
        choking_boundary(600.0, 1.02, 0.5, 3200.0, 0.66),
    ]

    out["gasMarch"] = gas_march(300.0, 0.72, 1.28)

    out["gas"] = [
        gas_cv(500000.0, 300.0, 250.0, 0.65, 100.0, 0.95, 1.28, 0.72),
        gas_cv(500000.0, 300.0, 100.0, 0.65, 100.0, 0.95, 1.28, 0.72),
        gas_cv(2000000.0, 900.0, 700.0, 0.70, 120.0, 0.88, 1.26, 0.75),
    ]

    out["gasSi"] = [
        gas_cv_si(500000.0, 300.0, 250.0, 0.65, 100.0, 0.95, 1.28, 0.72),
        gas_cv_si(2000000.0, 900.0, 700.0, 0.70, 120.0, 0.88, 1.26, 0.75),
        gas_cv_si(750000.0, 450.0, 380.0, 0.60, 80.0, 0.92, 1.30, 0.55),
    ]

    out["travel"] = eq_pct_roundtrip(100.0, 50.0, [0.2, 0.4, 0.6, 0.8, 1.0])
    out["travelStates"] = travel_states()
    out["authority"] = authority_rows()
    out["noise"] = noise_rows()

    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.normpath(os.path.join(
        here, "..", "..", "..", "test-data", "facilities", "goldens",
        "controlvalve_cases.json"))
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print("wrote", dest)


if __name__ == "__main__":
    main()
