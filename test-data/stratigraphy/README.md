# Stratigraphy engine fixtures (ST2)

`wheeler-synthetic.json`: three wells along a 2 km section, a proximal to
distal clinoform with one depositional sequence bounded below by a
subaerial unconformity (SU at W1 and W2, its correlative conformity CC at
W3) and containing a maximum regressive surface (MRS) and a maximum
flooding surface (MFS). Ages are assigned, not measured. There is no
numerical method to cross-check here: the age-depth model is linear
interpolation between dated surfaces, and the Wheeler transform is that
model applied per well, so the expected cells were derived by hand and
committed (the G3.0 rationale for analytic goldens).

Derivation, W1 (surfaces at 1500 / 1520 / 1600 / 1680 / 1720 m with ages
0 / 5 / 8 / 10 (hiatus to 14) / 16 Ma):

| Cell | Depth | Age | Rate | Tract |
|---|---|---|---|---|
| Seabed to MFS-1 | 1500 to 1520 (20 m) | 0 to 5 Ma | 4 m/Ma | none: a formation top above an MFS bounds no single tract (HST plus whatever sits above) |
| MFS-1 to MRS-1 | 1520 to 1600 (80 m) | 5 to 8 Ma | 26.67 m/Ma | TST (lower MRS, upper MFS) |
| MRS-1 to SB-1 | 1600 to 1680 (80 m) | 8 to 10 Ma | 40 m/Ma | LST (lower SU, upper MRS) |
| hiatus at SB-1 | 1680 | 10 to 14 Ma | none | the 4 Ma the unconformity removed |
| SB-1 to Base | 1680 to 1720 (40 m) | 14 to 16 Ma | 20 m/Ma | none (formation top below) |

W2 differs in the hiatus (10 to 12 Ma) and the thicknesses; W3 carries the
correlative conformity, so it has no hiatus and the 10 to 16 Ma cell is
one continuous deposition cell. The age axis therefore runs 0 to 16 Ma
with boundaries at 0, 5, 8, 10, 12, 14, 16. The chart's only non-obvious
rule is that a hiatus cell wins over the deposition cells that touch it at
the same age (`cellAt`).
