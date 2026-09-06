# Wellsite engine fixtures

`ws0-goldens.json` is written by `tools/validation/wellsite/genfixtures.py`
from `oracle_ws0.py` (stdlib only, byte-identical regeneration). The
oracle is independent of the JS: the datum shifts are plain arithmetic,
the build-section TVD is the partial minimum-curvature increment written
out longhand for a build from vertical (dogleg equals the inclination
reached, ratio factor 2/b tan(b/2)), and the pump displacements are the
textbook cylinder geometry.

## Depth (WS0)

Vertical well, KB 25 m and GL 4 m above MSL. An entry of 3000 ft MD below
GL is 914.4 m plus the 21 m between GL and KB, 935.4 m MD below KB; TVD
is the same on a vertical well; subsea depth is 935.4 minus 25, 910.4 m.
Displayed in ft from RT (RT equals KB unless the well says otherwise)
that is 3068.90 ft.

Deviated well, stations (0, 0, 0), (1400, 0, 0), (1750, 30, 90). At
1600 m MD the attitude is 17.143 deg (linear along the arc), the partial
increment is 100 x (1 + cos 17.143) x RF with RF = 1.007518, so TVD is
1597.029 m. At the station, 175 x (1 + cos 30) x 1.023 495 gives
1734.225 m. At 1900 m MD, beyond the last station, the engine
extrapolates along the last attitude: 1734.225 + 150 x cos 30 =
1864.129 m, and says so.

The two-crossing case (toe-up lateral, inclination 100 deg) and the
never-reached case are constructed inside the test; both must refuse with
an instruction to enter MD.

## Pumps (WS0)

6 x 12 in triplex at 97 percent: one cylinder is pi/4 x 0.1524^2 x 0.3048
= 0.005 560 0 m3, three cylinders 0.016 680, times 0.97 gives
0.016 179 6 m3 per stroke (0.101 77 bbl). The field formula
0.000 243 x D^2 x L x eff gives 0.101 83 bbl; the 0.06 percent gap is the
rounded constant, and the test allows 0.1 percent between them.

7.25 x 14 in duplex, 2.5 in rods, 90 percent: 2 x L x (2 x pi/4 x D^2
minus pi/4 x d^2) x 0.9 = 0.032 068 5 m3 per stroke (0.2017 bbl).

## Description abbreviations (WS1)

`description-goldens.json` is hand-derived: an abbreviation is a rendering
rule, not a calculation, so there is no numeric oracle. The sample is a
two-component cuttings description (60 percent sandstone, 40 percent
shale). Under the Petrolord default profile the attribute order is
lithology, percent, colour, hardness, grain size, sorting, rounding,
texture, cement, accessories, fossils, porosity, porosity type, and the
abbreviations follow the common mudlogging lists (lt gy, f-m gr, mod srt,
sbang-sbrnd, calc cmt, tr pyr, fr vis por, dk gy, frm, fis). The
narrative is the same record in full words. The operator profile
overrides three tables and the format (percent as a suffix, components
joined by a slash); every term it does not define is rendered from the
default and reported as a fallback, which is the list committed here.
