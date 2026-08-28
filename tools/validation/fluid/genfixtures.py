"""Regenerate the committed PR78 goldens from the independent oracle (FS2).

    python3 tools/validation/fluid/genfixtures.py
    # writes test-data/fluid/goldens.json

The BIP table below is a deliberate second transcription of Monograph 20
Table 4-2: the JS gate asserts buildBipMatrix() reproduces `bipMatrix`
exactly, so a typo on either side fails loudly. Component constants are
NOT re-transcribed - the oracle reads componentReference.json.
"""

from __future__ import annotations

import json
import os

import oracle

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(
    HERE, "..", "..", "..",
    "test-data", "fluid", "goldens.json",
)

ORDER = ["N2", "CO2", "H2S", "C1", "C2", "C3", "iC4", "nC4", "iC5", "nC5", "nC6"]

# Whitson & Brule Monograph 20 Table 4-2 (non-HC pairs), HC-HC zero.
BIP_PAIRS = {
    ("N2", "CO2"): 0.0, ("N2", "H2S"): 0.130, ("N2", "C1"): 0.025,
    ("N2", "C2"): 0.010, ("N2", "C3"): 0.090, ("N2", "iC4"): 0.095,
    ("N2", "nC4"): 0.095, ("N2", "iC5"): 0.100, ("N2", "nC5"): 0.100,
    ("N2", "nC6"): 0.100,
    ("CO2", "H2S"): 0.135, ("CO2", "C1"): 0.105, ("CO2", "C2"): 0.130,
    ("CO2", "C3"): 0.125, ("CO2", "iC4"): 0.120, ("CO2", "nC4"): 0.115,
    ("CO2", "iC5"): 0.115, ("CO2", "nC5"): 0.115, ("CO2", "nC6"): 0.115,
    ("H2S", "C1"): 0.070, ("H2S", "C2"): 0.085, ("H2S", "C3"): 0.080,
    ("H2S", "iC4"): 0.075, ("H2S", "nC4"): 0.075, ("H2S", "iC5"): 0.070,
    ("H2S", "nC5"): 0.070, ("H2S", "nC6"): 0.055,
}


def bip_matrix(keys: list[str]) -> list[list[float]]:
    def kij(a: str, b: str) -> float:
        if a == b:
            return 0.0
        return BIP_PAIRS.get((a, b), BIP_PAIRS.get((b, a), 0.0))
    return [[kij(a, b) for b in keys] for a in keys]


MIXTURES = [
    {
        "name": "lean-gas",
        "keys": ["N2", "CO2", "C1", "C2", "C3"],
        "x": [0.02, 0.02, 0.85, 0.07, 0.04],
    },
    {
        "name": "binary-c1nc4",
        "keys": ["C1", "nC4"],
        "x": [0.35, 0.65],
    },
    {
        "name": "full-11",
        "keys": ORDER,
        "x": [0.003, 0.012, 0.005, 0.62, 0.09, 0.055, 0.016, 0.03, 0.013, 0.017, 0.139],
    },
]

T_F = [60.0, 150.0, 250.0]
P_PSIA = [14.696, 500.0, 2000.0, 5000.0]
# extra points chosen to land in the three-root window (root-selection gate)
EXTRA = {"binary-c1nc4": [(100.0, 60.0), (100.0, 100.0), (100.0, 200.0)]}

PSAT_TR = [0.60, 0.70, 0.85, 0.95]

# ---------------------------------------------------------------------------
# FS4: characterization grid, characterized fluids (single C7+ pseudo),
# envelope temperatures, and the transport section built on flash states.

CHAR_GRID = [(mw, sg) for mw in (110.0, 150.0, 200.0, 250.0) for sg in (0.75, 0.82, 0.88)]
CHAR_MEASURED_TB = {"mw": 150.0, "sg": 0.80, "tb": 1000.0}

CHAR_FLUIDS = [
    {
        "name": "char-oil",
        "keys": ["CO2", "C1", "C2", "C3", "nC4", "nC6"],
        "plus": {"mw": 190.0, "sg": 0.84},
        "x": [0.02, 0.40, 0.07, 0.06, 0.05, 0.06, 0.34],
        "envTF": [120.0, 200.0, 280.0],
        "flashTP": [(200.0, 1000.0), (200.0, 3000.0), (280.0, 6000.0)],
    },
    {
        "name": "char-condensate",
        "keys": ["N2", "C1", "C2", "C3", "nC5"],
        "plus": {"mw": 140.0, "sg": 0.78},
        "x": [0.02, 0.75, 0.08, 0.05, 0.04, 0.06],
        "envTF": [100.0, 200.0],
        "flashTP": [(150.0, 2000.0), (150.0, 5000.0)],
    },
]

ENVELOPE_TF_FULL11 = [40.0, 120.0, 200.0, 280.0]

# ---------------------------------------------------------------------------
# FS6: separator trains. Stages as (T_F, P_psia) high->low; the oracle
# appends the stock tank. char-oil reservoir (200 F, 3500 psia) sits above
# its 2897.8 psia bubble point so the Bo block engages; the condensate at
# (150 F, 2000) is inside the two-phase region and pins the Bo-null path;
# lean-gas pins the no-stock-tank-liquid path.

SEPARATOR_JOBS = [
    {"fluid": "char-oil", "train": "two-stage",
     "stagesF": [(90.0, 500.0), (75.0, 100.0)], "resTP": (200.0, 3500.0)},
    {"fluid": "char-oil", "train": "three-stage",
     "stagesF": [(100.0, 1000.0), (80.0, 300.0), (70.0, 50.0)], "resTP": (200.0, 3500.0)},
    {"fluid": "char-condensate", "train": "one-stage",
     "stagesF": [(80.0, 800.0)], "resTP": (150.0, 5000.0)},
    {"fluid": "char-condensate", "train": "two-phase-res",
     "stagesF": [(80.0, 800.0)], "resTP": (150.0, 2000.0)},
    {"fluid": "lean-gas", "train": "one-stage",
     "stagesF": [(90.0, 500.0)], "resTP": None},
]


def char_mixture(fluid):
    """comps + full BIP matrix with the pseudo appended last, mirroring the
    engine convention: C1 pair from Chueh-Prausnitz, non-HC pairs reuse the
    nC6 column, other HC pairs zero."""
    keys = fluid["keys"]
    comps = [oracle.COMPONENTS[k] for k in keys]
    bip = bip_matrix(keys)
    ch = oracle.characterize(fluid["plus"]["mw"], fluid["plus"]["sg"])
    pseudo = {
        "mw": ch["mw"], "tcR": ch["tcR"], "pcPsia": ch["pcPsia"], "omega": ch["omega"],
        "vcFt3PerLbmol": ch["vcFt3PerLbmol"], "parachor": ch["parachor"], "shift": ch["shift"],
    }
    row = []
    for k in keys:
        if k == "C1":
            row.append(ch["bipC1"])
        elif k in ("N2", "CO2", "H2S"):
            row.append(BIP_PAIRS.get((k, "nC6"), BIP_PAIRS.get(("nC6", k), 0.0)))
        else:
            row.append(0.0)
    full = [r[:] + [row[i]] for i, r in enumerate(bip)]
    full.append(row + [0.0])
    return comps + [pseudo], full


def main() -> None:
    out = {
        "_generator": "tools/validation/fluid/genfixtures.py (independent Python oracle)",
        "bipKeys": ORDER,
        "bipMatrix": bip_matrix(ORDER),
        "mixtures": [],
        "flash": [],
        "purePsat": [],
    }

    for m in MIXTURES:
        comps = [oracle.COMPONENTS[k] for k in m["keys"]]
        bip = bip_matrix(m["keys"])
        conds = [(t, p) for t in T_F for p in P_PSIA] + EXTRA.get(m["name"], [])
        states = []
        for t_f, p in conds:
            t_r = t_f + 459.67
            st = oracle.phase_state(comps, bip, m["x"], t_r, p)
            states.append({
                "tF": t_f,
                "pPsia": p,
                "roots": st["roots"],
                "z": st["z"],
                "lnPhi": st["lnPhi"],
                "molarVolume": st["molarVolume"],
                "density": st["density"],
            })
            print(f"{m['name']:14s} {t_f:6.1f} F {p:8.1f} psia  "
                  f"roots={len(st['roots'])}  z={st['z']:.6f}")
        out["mixtures"].append({**m, "states": states})

    for m in MIXTURES:
        comps = [oracle.COMPONENTS[k] for k in m["keys"]]
        bip = bip_matrix(m["keys"])
        conds = [(t, p) for t in T_F for p in P_PSIA] + EXTRA.get(m["name"], [])
        flashes = []
        for t_f, p in conds:
            t_r = t_f + 459.67
            res = oracle.flash_plain(comps, bip, m["x"], t_r, p)
            entry = {"tF": t_f, "pPsia": p, **res}
            if res["phases"] == 2:
                seal = oracle.flash_verify(comps, bip, res, t_r, p)
                if seal > 1e-6:
                    raise RuntimeError(
                        f"quadrature fugacity seal failed: {m['name']} {t_f}F/{p}psia -> {seal}")
                entry["fugacitySeal"] = seal
            flashes.append(entry)
            print(f"flash {m['name']:14s} {t_f:6.1f} F {p:8.1f} psia  "
                  f"phases={res['phases']}"
                  + (f"  beta={res['beta']:.6f}" if res["phases"] == 2 else ""))
        out["flash"].append({"name": m["name"], "keys": m["keys"], "x": m["x"], "states": flashes})

    # ---- FS4 sections ----------------------------------------------------
    out["characterization"] = []
    for mw, sg in CHAR_GRID:
        out["characterization"].append({"mw": mw, "sg": sg, **oracle.characterize(mw, sg)})
    m = CHAR_MEASURED_TB
    out["characterization"].append(
        {"mw": m["mw"], "sg": m["sg"], "tbInput": m["tb"],
         **oracle.characterize(m["mw"], m["sg"], m["tb"])})
    print(f"characterization: {len(out['characterization'])} points")

    out["envelopes"] = []
    full11 = next(mm for mm in MIXTURES if mm["name"] == "full-11")
    env_jobs = [(full11["name"], full11["keys"], [oracle.COMPONENTS[k] for k in full11["keys"]],
                 bip_matrix(full11["keys"]), full11["x"], ENVELOPE_TF_FULL11, None)]
    for fl in CHAR_FLUIDS:
        comps, bip = char_mixture(fl)
        env_jobs.append((fl["name"], fl["keys"], comps, bip, fl["x"], fl["envTF"], fl["plus"]))
    for name, keys, comps, bip, x, tfs, plus in env_jobs:
        states = []
        for t_f in tfs:
            bounds = oracle.stability_boundaries(comps, bip, x, t_f + 459.67)
            states.append({"tF": t_f, "boundaries": bounds})
            desc = ", ".join(f"{b['kind']}@{b['pPsia']:.2f}" for b in bounds) or "none"
            print(f"envelope {name:16s} {t_f:6.1f} F  {desc}")
        entry = {"name": name, "keys": keys, "x": x, "states": states}
        if plus:
            entry["plus"] = plus
        out["envelopes"].append(entry)

    out["flashC7"] = []
    for fl in CHAR_FLUIDS:
        comps, bip = char_mixture(fl)
        states = []
        for t_f, p in fl["flashTP"]:
            t_r = t_f + 459.67
            res = oracle.flash_plain(comps, bip, fl["x"], t_r, p)
            entry = {"tF": t_f, "pPsia": p, **res}
            if res["phases"] == 2:
                seal = oracle.flash_verify(comps, bip, res, t_r, p)
                if seal > 1e-6:
                    raise RuntimeError(
                        f"quadrature fugacity seal failed: {fl['name']} {t_f}F/{p}psia -> {seal}")
                entry["fugacitySeal"] = seal
            states.append(entry)
            print(f"flashC7 {fl['name']:16s} {t_f:6.1f} F {p:8.1f} psia  phases={res['phases']}"
                  + (f"  beta={res['beta']:.6f}" if res["phases"] == 2 else ""))
        out["flashC7"].append({"name": fl["name"], "keys": fl["keys"], "plus": fl["plus"],
                               "x": fl["x"], "states": states})

    out["transport"] = []
    transport_jobs = []
    for m2 in MIXTURES:
        comps = [oracle.COMPONENTS[k] for k in m2["keys"]]
        bip = bip_matrix(m2["keys"])
        src = next(f for f in out["flash"] if f["name"] == m2["name"])
        transport_jobs.append((m2["name"], comps, bip, src["states"]))
    for fl, entry in zip(CHAR_FLUIDS, out["flashC7"]):
        comps, bip = char_mixture(fl)
        transport_jobs.append((fl["name"], comps, bip, entry["states"]))
    for name, comps, bip, states in transport_jobs:
        rows = []
        for st in states:
            if st["phases"] != 2:
                continue
            t_r = st["tF"] + 459.67
            v_l = oracle.phase_state(comps, bip, st["x"], t_r, st["pPsia"])["molarVolume"]
            v_v = oracle.phase_state(comps, bip, st["y"], t_r, st["pPsia"])["molarVolume"]
            rows.append({
                "tF": st["tF"], "pPsia": st["pPsia"],
                "muL": oracle.lbc_viscosity(comps, st["x"], t_r, v_l),
                "muV": oracle.lbc_viscosity(comps, st["y"], t_r, v_v),
                "iftDynPerCm": oracle.weinaug_katz(comps, st["x"], st["y"], v_l, v_v),
            })
        if rows:
            out["transport"].append({"name": name, "states": rows})
            for r in rows:
                print(f"transport {name:16s} {r['tF']:6.1f} F {r['pPsia']:8.1f} psia  "
                      f"muL={r['muL']:.6f} muV={r['muV']:.6f} ift={r['iftDynPerCm']:.4f}")

    # ---- FS6: separator trains ------------------------------------------
    out["separator"] = []
    fluids = {}
    for m2 in MIXTURES:
        fluids[m2["name"]] = ([oracle.COMPONENTS[k] for k in m2["keys"]],
                              bip_matrix(m2["keys"]), m2["x"], m2["keys"], None)
    for fl in CHAR_FLUIDS:
        comps, bip = char_mixture(fl)
        fluids[fl["name"]] = (comps, bip, fl["x"], fl["keys"], fl["plus"])
    for job in SEPARATOR_JOBS:
        comps, bip, x, keys, plus = fluids[job["fluid"]]
        stages = [(t_f + 459.67, p) for t_f, p in job["stagesF"]]
        res_tp = None
        if job["resTP"]:
            res_tp = (job["resTP"][0] + 459.67, job["resTP"][1])
        res = oracle.separator_train(comps, bip, x, stages, res_tp)
        entry = {"fluid": job["fluid"], "train": job["train"], "keys": keys,
                 "x": x, "stagesF": job["stagesF"], "resTP": job["resTP"], **res}
        if plus:
            entry["plus"] = plus
        out["separator"].append(entry)
        tot = res["totals"]
        print(f"separator {job['fluid']:16s} {job['train']:12s}  "
              + (f"GOR={tot['totalGor']:.2f} scf/STB API={res['stockTank']['api']:.2f}"
                 if tot else "no stock-tank liquid")
              + (f"  Bo={res['bo']['multistage']:.4f}" if res["bo"] and res["bo"].get("multistage")
                 else ""))

    # ---- FS7: CCE + DL + composite black-oil table ----------------------
    # Grids are derived from the oracle's own saturation pressure and
    # committed to the golden so both sides run identical pressures.
    out["experiments"] = []
    exp_jobs = [
        {"fluid": "char-oil", "tF": 200.0, "dl": True,
         "sepF": [(90.0, 500.0), (75.0, 100.0)]},
        {"fluid": "char-condensate", "tF": 150.0, "dl": False, "sepF": None},
    ]
    for job in exp_jobs:
        comps, bip, x, keys, plus = fluids[job["fluid"]]
        t_r = job["tF"] + 459.67
        bounds = oracle.stability_boundaries(comps, bip, x, t_r)
        psat = bounds[-1]["pPsia"]
        cce_ps = [f * psat for f in (1.4, 1.25, 1.1, 1.05, 1.02,
                                     0.95, 0.85, 0.7, 0.55, 0.4, 0.25)
                  if f * psat > 14.696]
        cce = oracle.cce_expansion(comps, bip, x, t_r, psat, cce_ps)
        entry = {"fluid": job["fluid"], "keys": keys, "x": x, "tF": job["tF"],
                 "psatPsia": psat, "ccePressures": cce_ps, "cce": cce}
        if plus:
            entry["plus"] = plus
        print(f"experiments {job['fluid']:16s} psat={psat:.2f} psia  "
              f"cce rows={len(cce['rows'])}")
        if job["dl"]:
            dl_ps = [f * psat for f in (0.85, 0.7, 0.55, 0.4, 0.25, 0.12)
                     if f * psat > 2 * 14.696] + [14.696]
            undersat = [f * psat for f in (1.05, 1.15, 1.3)]
            sep_stages = [(tf + 459.67, p) for tf, p in job["sepF"]]
            entry["dlPressures"] = dl_ps
            entry["undersatPressures"] = undersat
            entry["sepStagesF"] = job["sepF"]
            entry["table"] = oracle.black_oil_table(
                comps, bip, x, t_r, sep_stages, psat, dl_ps, undersat)
            k = entry["table"]["kpis"]
            print(f"experiments {job['fluid']:16s} DL Bodb={k['bodb']:.4f} "
                  f"Rsdb={k['rsdb']:.2f}  table Bofb={k['bofb']:.4f} "
                  f"Rsfb={k['rsfb']:.2f} API={k['stoApi']:.2f}")
        out["experiments"].append(entry)

    for key in ORDER:
        comp = oracle.COMPONENTS[key]
        for tr in PSAT_TR:
            t_r = tr * comp["tcR"]
            psat = oracle.pure_psat_maxwell(comp, t_r)
            if psat is None:
                raise RuntimeError(f"Maxwell Psat failed for {key} at Tr={tr}")
            out["purePsat"].append({"key": key, "tR": t_r, "psatPsia": psat})
            print(f"psat {key:4s} Tr={tr:.2f}  {psat:.6f} psia")

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)
        fh.write("\n")
    print(f"\nwrote {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
