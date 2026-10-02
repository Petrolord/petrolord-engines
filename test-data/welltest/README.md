# Well test engine fixtures

`goldens.json` is the WT1 to WT9 oracle output (regenerated Suite-side from
`tools/validation/welltest/` in petrolord-suite).

## Partial penetration, total compressibility, flow summary

`partial-penetration-goldens.json` is written by
`tools/validation/welltest/oracle_partial_penetration.py` (stdlib only,
about a minute and a half).

`pseudoSkin[].series` is the independent value the gate holds
`papatzacosPseudoSkin` to: a uniform-flux line source over the open interval
of a slab with sealed top and base, the extra pressure drop over fully
penetrating radial flow averaged over the interval,

    s = 2 / (pi^2 b^2) * sum_n K0(n pi rD) / n^2 * (sin(n pi z2D) - sin(n pi z1D))^2

with K0 integrated numerically from its integral representation. Papatzacos
(1987) approximates the infinite-conductivity well, so the engine is held to
a band (0.6 skin units and 10 percent), not to a digit. Across the eleven
cases the largest difference is 0.50 skin units (2 percent, a centred fifth
of the pay at kv/kh 0.01).

`pseudoSkin[].papatzacos` and `.bronsMarting` are the two published closed
forms typed out a second time in Python. They pin the arithmetic to 1e-11
and are a typing check only.

No published worked example of either correlation could be read when the
gate was written; the series stands in for one. The negative control
(`welltest.partialPenetration.test.js`) shows that kh/kv for kv/kh, a
missing square root on the anisotropy, and A exchanged with B each leave
the band on every case where the mistake changes the value.

`totalCompressibility` and `flowSummary` are longhand arithmetic for
`ct = cf + So co + Sw cw + Sg cg` and for the volume of a period,
`q * duration / 24`.
