#!/usr/bin/env python3
"""Oracle for engines/prospect/valuation.js (Risked Reserves Valuation T1,
2026-09-26). Stdlib only; never from the JS.

Lognormal through P90 and P10; P(V >= m); partial expectation
E[V ; V >= m]; commercial chance, EMV after the exploration well, break-even
Pg, the risked expectation curve and a portfolio of independent prospects.

The normal CDF and inverse come from statistics.NormalDist (not the JS
polynomial). Self-asserted anchors (fail loudly at generation):
  A1 the fitted lognormal returns P90 and P10 exactly.
  A2 the closed-form partial expectation equals a numerical integral of
     x f(x) from m to infinity (Simpson on ln x, 20,000 panels) to 1e-7
     relative.
  A3 with MEFS 0 the EMV is Pg u mean - Pg D - W and Pc = Pg.
  A4 the EMV at the break-even Pg is zero.

Run:  python3 tools/validation/prospect/oracle_valuation.py
"""

import json
import math
import os
from statistics import NormalDist

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD = os.path.normpath(os.path.join(HERE, "..", "..", "..", "test-data", "prospect", "goldens"))
N = NormalDist()
Z90 = N.inv_cdf(0.9)


def fit(p90, p10):
    sigma = (math.log(p10) - math.log(p90)) / (2 * Z90)
    mu = (math.log(p10) + math.log(p90)) / 2
    return mu, sigma, math.exp(mu + sigma * sigma / 2)


def exceed(mu, s, x):
    return 1.0 if x <= 0 else 1 - N.cdf((math.log(x) - mu) / s)


def partial(mu, s, mean, m):
    return mean if m <= 0 else mean * N.cdf(s - (math.log(m) - mu) / s)


def partial_numeric(mu, s, m):
    # integral of x f(x) dx over [m, inf) = integral over y = ln x of e^y phi((y - mu)/s)/s dy
    a = math.log(m)
    b = mu + 12 * s
    n = 20000
    h = (b - a) / n
    f = lambda y: math.exp(y) * math.exp(-0.5 * ((y - mu) / s) ** 2) / (s * math.sqrt(2 * math.pi))
    tot = f(a) + f(b)
    for i in range(1, n):
        tot += (4 if i % 2 else 2) * f(a + i * h)
    return tot * h / 3


def value(p):
    mu, s, mean = fit(p["p90"], p["p10"])
    pcomm = exceed(mu, s, p["mefs"])
    part = partial(mu, s, mean, p["mefs"])
    vid = p["unitValue"] * part - p["devCost"] * pcomm
    emv = p["pg"] * vid - p["wellCost"]
    be = p["wellCost"] / vid if vid > 0 else None
    return {
        "pg": p["pg"], "pc": p["pg"] * pcomm, "pCommercialGivenSuccess": pcomm,
        "mean": mean, "fittedP50": math.exp(mu), "mu": mu, "sigma": s,
        "swansonMean": 0.3 * p["p90"] + 0.4 * p["p50"] + 0.3 * p["p10"],
        "riskedMean": p["pg"] * mean,
        "meanIfCommercial": part / pcomm if pcomm > 0 else None,
        "npvIfCommercial": p["unitValue"] * part / pcomm - p["devCost"] if pcomm > 0 else None,
        "emv": emv, "breakEvenPg": be if be is not None and be <= 1 else None,
    }


def main():
    prospects = [
        {"name": "Ekene North", "pg": 0.32, "p90": 12.0, "p50": 30.0, "p10": 75.0, "mefs": 15.0, "unitValue": 8.5, "devCost": 120.0, "wellCost": 25.0},
        {"name": "Ekene Deep", "pg": 0.18, "p90": 40.0, "p50": 95.0, "p10": 230.0, "mefs": 60.0, "unitValue": 6.0, "devCost": 450.0, "wellCost": 60.0},
        {"name": "Small step-out", "pg": 0.65, "p90": 2.0, "p50": 4.0, "p10": 8.0, "mefs": 0.0, "unitValue": 10.0, "devCost": 15.0, "wellCost": 8.0},
    ]
    out = []
    for p in prospects:
        v = value(p)
        mu, s = v["mu"], v["sigma"]
        # A1
        assert abs(math.exp(mu + s * N.inv_cdf(0.1)) / p["p90"] - 1) < 1e-12
        assert abs(math.exp(mu + s * N.inv_cdf(0.9)) / p["p10"] - 1) < 1e-12
        # A2
        if p["mefs"] > 0:
            num = partial_numeric(mu, s, p["mefs"])
            assert abs(num / partial(mu, s, v["mean"], p["mefs"]) - 1) < 1e-7, ("A2", num)
        else:
            # A3
            assert abs(v["emv"] - (p["pg"] * p["unitValue"] * v["mean"] - p["pg"] * p["devCost"] - p["wellCost"])) < 1e-9
            assert v["pc"] == p["pg"]
        # A4
        if v["breakEvenPg"] is not None:
            q = dict(p, pg=v["breakEvenPg"])
            assert abs(value(q)["emv"]) < 1e-9
        curve = []
        lo = math.exp(mu + s * N.inv_cdf(0.01)); hi = math.exp(mu + s * N.inv_cdf(0.99))
        for k in range(60):
            x = lo * math.exp(k / 59 * math.log(hi / lo))
            curve.append({"volume": x, "exceedance": p["pg"] * exceed(mu, s, x)})
        out.append({"input": p, "expected": v, "curve": curve})
    pcs = [o["expected"]["pc"] for o in out]
    portfolio = {
        "count": 3, "riskedMean": sum(o["expected"]["riskedMean"] for o in out),
        "emv": sum(o["expected"]["emv"] for o in out), "expectedCommercial": sum(pcs),
        "pAtLeastOneCommercial": 1 - math.prod(1 - c for c in pcs),
    }
    os.makedirs(GOLD, exist_ok=True)
    with open(os.path.join(GOLD, "valuation_cases.json"), "w") as f:
        json.dump({"$comment": "Written by tools/validation/prospect/oracle_valuation.py; never edit by hand.",
                   "tolerance": 1e-6, "prospects": out, "portfolio": portfolio}, f, sort_keys=True, separators=(",", ":"))
    print("wrote", len(out), "prospects")


if __name__ == "__main__":
    main()
