#!/usr/bin/env python3
"""Stdlib oracle for the partial-penetration goldens
(test-data/welltest/partial-penetration-goldens.json).

Two things are written here, and they are different in kind.

1. `series`: an INDEPENDENT calculation of the pseudo-skin, sharing no
   formula with the engine. A well open over [z1, z2] of a slab of
   thickness h with sealed top and base is a uniform-flux line source; the
   cosine series of the slab's Green function gives the extra pressure drop
   over fully penetrating radial flow, and averaging it over the open
   interval gives

       s = 2 / (pi^2 b^2) * sum_{n>=1} K0(n pi rD) / n^2
                                * (sin(n pi z2D) - sin(n pi z1D))^2

   with b = hp/h, rD = (rw/h) sqrt(kv/kh). K0 is integrated from its
   integral representation K0(x) = int_0^inf exp(-x cosh t) dt by Simpson's
   rule, so no Bessel routine is shared with anything either.

   Papatzacos (1987) is an approximation for an INFINITE-CONDUCTIVITY well;
   this series is the UNIFORM-FLUX well with the pressure averaged over the
   interval. The two are different inner boundary conditions for the same
   geometry and agree to a few tenths of a skin unit, which is the band the
   gate holds the engine to. A wrong anisotropy exponent, kh/kv for kv/kh,
   or A and B exchanged moves the engine by several skin units and out of
   the band.

2. `papatzacos` and `brons_marting`: the published closed forms typed out
   longhand a second time. These pin the engine's arithmetic to twelve
   digits. They are a typing check, not an independent derivation.

No published worked example of either correlation could be read when this
was written (the SPE papers and the texts that tabulate them are behind
paywalls), so the independent series stands in for one. The Papatzacos
formula itself was read from a lecture slide that reproduces it with its
symbol definitions and cites SPE-13956-PA.

Regenerate:  python3 tools/validation/welltest/oracle_partial_penetration.py
"""
import json, math, os

def k0(x):
    """K0 from its integral representation, Simpson's rule."""
    upper = math.acosh(1.0 + 40.0 / x)      # exp(-x cosh t) < e^-40 * e^-x beyond this
    n = 160                                  # the integrand decays doubly exponentially; 120 already reaches 1e-14
    step = upper / n
    total = 0.0
    for i in range(n + 1):
        w = 1 if i in (0, n) else (4 if i % 2 else 2)
        total += w * math.exp(-x * math.cosh(i * step))
    return total * step / 3.0

def series(h, hp, h1, rw, kvkh):
    b = hp / h
    rD = rw / h * math.sqrt(kvkh)
    z1 = h1 / h
    z2 = z1 + b
    total = 0.0
    n = 1
    while n * math.pi * rD <= 40.0:
        d = math.sin(n * math.pi * z2) - math.sin(n * math.pi * z1)
        total += k0(n * math.pi * rD) / (n * n) * d * d
        n += 1
    return 2.0 / (math.pi ** 2 * b * b) * total

def papatzacos(h, hp, h1, rw, kvkh):
    hpD = hp / h
    rD = rw / h * math.sqrt(kvkh)
    h1D = h1 / h
    A = 1.0 / (h1D + hpD / 4.0)
    B = 1.0 / (h1D + 3.0 * hpD / 4.0)
    first = (1.0 / hpD - 1.0) * math.log(math.pi / (2.0 * rD))
    second = (1.0 / hpD) * math.log(hpD / (2.0 + hpD) * math.sqrt((A - 1.0) / (B - 1.0)))
    return first + second

def brons_marting(h, hp, rw, kvkh, centre):
    b = hp / h
    hs = h / 2.0 if centre else h
    hD = hs / rw * math.sqrt(1.0 / kvkh)
    G = 2.948 - 7.363 * b + 11.45 * b * b - 4.675 * b ** 3
    return (1.0 / b - 1.0) * (math.log(hD) - G)

# h, hp, h1, rw, kv/kh; position: edge (h1 = 0 or the interval at the base) or centre
CASES = [
    ("top fifth, isotropic", 100.0, 20.0, 0.0, 0.25, 1.0, "edge"),
    ("top fifth, kv/kh 0.1", 100.0, 20.0, 0.0, 0.25, 0.1, "edge"),
    ("top half, isotropic", 100.0, 50.0, 0.0, 0.25, 1.0, "edge"),
    ("centred half, isotropic", 100.0, 50.0, 25.0, 0.25, 1.0, "centre"),
    ("centred fifth, kv/kh 0.1", 100.0, 20.0, 40.0, 0.25, 0.1, "centre"),
    ("sample well, top third, kv/kh 0.1", 45.0, 15.0, 0.0, 0.354, 0.1, "edge"),
    ("centred fifth, kv/kh 0.01", 150.0, 30.0, 60.0, 0.3, 0.01, "centre"),
    ("top four fifths, isotropic", 100.0, 80.0, 0.0, 0.25, 1.0, "edge"),
    ("top sixth, kv/kh 0.5", 60.0, 10.0, 0.0, 0.3, 0.5, "edge"),
    ("base quarter, kv/kh 0.2", 80.0, 20.0, 60.0, 0.35, 0.2, "edge"),
    ("off-centre quarter, kv/kh 0.3", 120.0, 30.0, 20.0, 0.3, 0.3, None),
]

def build():
    rows = []
    for name, h, hp, h1, rw, kvkh, position in CASES:
        row = {
            "name": name, "h": h, "hp": hp, "h1": h1, "rw": rw, "kvkh": kvkh,
            "position": position,
            "series": round(series(h, hp, h1, rw, kvkh), 6),
            "papatzacos": papatzacos(h, hp, h1, rw, kvkh),
        }
        if position:
            row["bronsMarting"] = brons_marting(h, hp, rw, kvkh, position == "centre")
        rows.append(row)
    # ct = cf + So co + Sw cw + Sg cg, longhand
    ct = [
        {"cf": 4e-6, "so": 0.75, "co": 1.2e-5, "sw": 0.25, "cw": 3e-6,
         "ct": 4e-6 + 0.75 * 1.2e-5 + 0.25 * 3e-6},
        {"cf": 3.5e-6, "so": 0.6, "co": 1.5e-5, "sw": 0.3, "cw": 3.2e-6, "sg": 0.1, "cg": 2.4e-4,
         "ct": 3.5e-6 + 0.6 * 1.5e-5 + 0.3 * 3.2e-6 + 0.1 * 2.4e-4},
        {"cf": 5e-6, "sw": 0.2, "cw": 3e-6, "sg": 0.8, "cg": 1.9e-4,
         "ct": 5e-6 + 0.2 * 3e-6 + 0.8 * 1.9e-4},
    ]
    # flow summary: 450 STB/D for 36 hr, shut in 72 hr; then a three-rate test
    flow = [
        {"history": [{"t": 0, "q": 450}, {"t": 36, "q": 0}], "endTime": 108.0,
         "volumes": [450 * 36 / 24.0, 0.0], "durations": [36.0, 72.0], "total": 450 * 36 / 24.0},
        {"history": [{"t": 0, "q": 200}, {"t": 12, "q": 400}, {"t": 24, "q": 600}, {"t": 30, "q": 0}], "endTime": None,
         "volumes": [200 * 12 / 24.0, 400 * 12 / 24.0, 600 * 6 / 24.0, None],
         "durations": [12.0, 12.0, 6.0, None], "total": None},
    ]
    return {
        "source": "tools/validation/welltest/oracle_partial_penetration.py",
        "seriesNote": "uniform-flux line source in a sealed slab, pressure averaged over the open interval; K0 by Simpson integration of its integral representation",
        "pseudoSkin": rows, "totalCompressibility": ct, "flowSummary": flow,
    }

if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "..", "..", "test-data", "welltest", "partial-penetration-goldens.json")
    with open(out, "w") as f:
        json.dump(build(), f, indent=1)
        f.write("\n")
    print("wrote", os.path.normpath(out))
