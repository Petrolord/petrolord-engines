#!/usr/bin/env python3
"""Independent stdlib oracle for the MBAL injection terms (MBAL-U2-002).

No published worked example of a material balance WITH injection could be
read for this round (the textbook examples that have one are paywalled; the
open lecture notes reproduce Ahmed's equation without numbers). So the gate
rests on three things computed here, from the formula as printed, by code
that shares nothing with the engine:

  1. A hand calculation on the PUBLISHED Ahmed REH 4th ed. Example 11-1 data
     (combination drive, N = 10 MMSTB given) with stated injection volumes
     added: the net withdrawal F, the back-calculated influx We and the drive
     indices including the two injection indices.
  2. An exact synthetic oil tank under water and gas injection, built from a
     known N with the MBE written out here; the engine must recover N.
  3. The same for a gas tank under gas injection (cycling), recovering G.

The formula (Ahmed, Reservoir Engineering Handbook 4th ed., Ch. 11, the
general MBE; the injection terms are the "pore volume occupied by the
injected gas and water", Ginj*Bginj + Winj*Bw):

  F  = Np[Bo + (Rp - Rs)Bg] + Wp*Bw - Winj*Bw - Ginj*Bginj
     = Np[Bt + (Rp - Rsi)Bg] + Wp*Bw - Winj*Bw - Ginj*Bginj
  F  = N*(Eo + m*Eg + Efw) + We
  Eo = Bt - Bti;  Eg = Bti*(Bg/Bgi - 1);  Efw = (1+m)*Bti*(Swi*cw + cf)/(1 - Swi)*dp
  gas: Gp*Bg + Wp*Bw - Winj*Bw - Ginj*Bg = G*(Bg - Bgi + Bgi*(Swi*cw + cf)/(1 - Swi)*dp) + We

Run:  python3 oracle.py > injection-golden.json
"""
import json

out = {"source": __doc__.strip().split("\n\n")[0], "cases": {}}

# ---- 1. Ahmed Example 11-1 with injection added --------------------------
# Given data typed verbatim in ../ahmed-ex-11-1-combination.json.
N, m = 1.0e7, 0.25
pi, p = 3000.0, 2800.0
Np, Gp, Wp = 1.0e6, 1.1e9, 5.0e4
Swi, cw, cf = 0.20, 1.5e-6, 1.0e-6
Boi, Rsi, Bgi = 1.58, 1040.0, 0.00080
Bo, Rs, Bg, Bw = 1.48, 850.0, 0.00092, 1.0
Winj, Ginj = 1.0e5, 1.0e8          # stated additions, STB and scf
Bti = Boi
Bt = Bo + (Rsi - Rs) * Bg
Rp = Gp / Np
A = Np * (Bt + (Rp - Rsi) * Bg)                  # hydrocarbon voidage
F_gross = A + Wp * Bw
F_net = F_gross - Winj * Bw - Ginj * Bg
Eo = Bt - Bti
Eg = Bti * (Bg / Bgi - 1.0)
Efw = (1.0 + m) * Bti * (Swi * cw + cf) / (1.0 - Swi) * (pi - p)
Et = Eo + m * Eg + Efw
We = F_net - N * Et
We_no_injection = F_gross - N * Et
idx = {
    "ddi": N * Eo / A,
    "gdi": N * m * Eg / A,
    "cdi": N * Efw / A,
    "wdi": (We - Wp * Bw) / A,
    "winj_di": Winj * Bw / A,
    "ginj_di": Ginj * Bg / A,
}
idx["sum"] = sum(idx.values())
out["cases"]["ahmed_11_1_with_injection"] = {
    "added": {"Winj_stb": Winj, "Ginj_scf": Ginj},
    "Bt": Bt, "A_rb": A, "F_gross_rb": F_gross, "F_net_rb": F_net,
    "winj_bw_rb": Winj * Bw, "ginj_bg_rb": Ginj * Bg,
    "Eo": Eo, "Eg": Eg, "Efw": Efw, "Et": Et,
    "We_rb": We, "We_without_injection_rb": We_no_injection,
    "indices": idx,
}

# ---- 2. Synthetic oil tank under water and gas injection ------------------
N_truth = 5.0e7
pi2, Pb2 = 4000.0, 2000.0
Swi2, cw2, cf2 = 0.20, 3.0e-6, 4.0e-6
Rsi2, Bw2, Bg2 = 600.0, 1.02, 0.00075        # Bg of the injected gas, RB/scf
press = [4000.0, 3900.0, 3820.0, 3760.0, 3720.0, 3690.0, 3670.0]
Nps   = [0.0, 0.4e6, 0.9e6, 1.5e6, 2.2e6, 3.0e6, 3.9e6]
Wps   = [0.0, 0.0, 1.0e4, 5.0e4, 1.2e5, 2.5e5, 4.0e5]
Ginjs = [0.0, 0.0, 5.0e7, 1.5e8, 3.0e8, 5.0e8, 7.0e8]
Boi2 = 1.30
rows = []
for k, pk in enumerate(press):
    Bo_k = Boi2 * (1.0 + 1.0e-5 * (pi2 - pk))
    dp = pi2 - pk
    Eo_k = Bo_k - Boi2
    Efw_k = Boi2 * (Swi2 * cw2 + cf2) / (1.0 - Swi2) * dp
    Et_k = Eo_k + Efw_k
    # F_net = N*Et  =>  Np*Bo + Wp*Bw - Winj*Bw - Ginj*Bg = N*Et
    Winj_k = (Nps[k] * Bo_k + Wps[k] * Bw2 - Ginjs[k] * Bg2 - N_truth * Et_k) / Bw2 if k else 0.0
    rows.append({
        "timestep_index": k, "pressure_psia": pk,
        "cum_oil_stb": Nps[k], "cum_gas_scf": Nps[k] * Rsi2, "cum_water_stb": Wps[k],
        "cum_water_inj_stb": Winj_k, "cum_gas_inj_scf": Ginjs[k],
        "bo_rb_stb": Bo_k, "rs_scf_stb": Rsi2, "bg_rb_scf": Bg2, "bw_rb_stb": Bw2,
        "Et": Et_k,
    })
assert all(r["cum_water_inj_stb"] >= 0 for r in rows)
out["cases"]["synthetic_oil_injection"] = {
    "N_truth_stb": N_truth,
    "case": {"pi": pi2, "Pb": Pb2, "Swi": Swi2, "cw": cw2, "cf": cf2},
    "rows": rows,
}

# ---- 3. Synthetic gas tank under gas injection (cycling) ------------------
G_truth = 1.0e11                      # scf
pi3 = 5000.0
Swi3, cw3, cf3 = 0.25, 3.0e-6, 5.0e-6
press3 = [5000.0, 4800.0, 4650.0, 4520.0, 4420.0, 4340.0]
Gps    = [0.0, 6.0e9, 1.3e10, 2.0e10, 2.8e10, 3.6e10]
Wps3   = [0.0, 0.0, 2.0e3, 6.0e3, 1.2e4, 2.0e4]
Bgi3 = 0.62                           # RB/Mscf
rows3 = []
for k, pk in enumerate(press3):
    Bg_mscf = Bgi3 * (pi3 / pk) ** 1.05
    Bg_scf = Bg_mscf / 1000.0
    dp = pi3 - pk
    Et_k = (Bg_scf - Bgi3 / 1000.0) + (Bgi3 / 1000.0) * (Swi3 * cw3 + cf3) / (1.0 - Swi3) * dp
    # Gp*Bg + Wp*Bw - Ginj*Bg = G*Et
    Ginj_k = (Gps[k] * Bg_scf + Wps3[k] * 1.0 - G_truth * Et_k) / Bg_scf if k else 0.0
    rows3.append({
        "timestep_index": k, "pressure_psia": pk,
        "cum_gas_scf": Gps[k], "cum_water_stb": Wps3[k], "cum_gas_inj_scf": Ginj_k,
        "bg_rb_mscf": Bg_mscf, "bw_rb_stb": 1.0, "Et": Et_k,
    })
assert all(r["cum_gas_inj_scf"] >= 0 for r in rows3)
out["cases"]["synthetic_gas_cycling"] = {
    "G_truth_scf": G_truth,
    "case": {"pi": pi3, "Swi": Swi3, "cw": cw3, "cf": cf3},
    "rows": rows3,
}

print(json.dumps(out, indent=2))
