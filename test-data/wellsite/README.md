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

## Lag (WS3)

`lag-goldens.json` is written by `oracle_lag.py`. Common well: 12.25 in
open hole to 10,000 ft, 5 in drillpipe the full length, 6 x 12 in triplex
at 97 percent (0.016 179 6 m3 per stroke).

Annular capacity pi/4 x (0.311 15^2 minus 0.127^2) = 0.063 370 m2 per
metre (0.121 49 bbl/ft, the textbook (12.25^2 minus 5^2)/1029.4 =
0.121 491). Annular volume at 10,000 ft (3048 m) is 193.152 m3, lag
strokes 193.152 / 0.016 179 6 = 11,938.0, that is 1.193 80 strokes per
foot of bit depth.

G1, constant 60 spm: lag time 11,938.0 / 60 = 198.97 min, so a sample
cut at 10,000 ft at T0 arrives at T0 + 198.97 min. Lagged depth while
drilling ahead at 50 ft/hr from 10,000 ft at T0 with the pumps steady,
at T0 + 240 min (bit at 10,200 ft): solve 60 x (240 minus T) = 1.193 80 x
(10,000 + 0.833 33 T), T = 40.36 min after T0, lagged depth 10,033.6 ft.
The engine solves it by bisection; the test allows 0.05 ft.

G2, rate change during the lag: 60 spm for 60 min (3,600 strokes) then
40 spm. Remaining 8,338.0 strokes at 40 spm take 208.45 min, arrival
T0 + 268.45 min. The readout "lag time at the current rate" after the
change is 11,938.0 / 40 = 298.45 min and must differ from the arrival:
that difference is why lag is counted in strokes.

G3, connection then restart: 60 spm for 30 min (1,800 strokes), pumps
off from T0 + 30 to T0 + 40, 60 spm again. Remaining 10,138.0 strokes take
168.97 min, arrival T0 + 208.97 min. During the shutdown the strokes
remaining are 10,138.0 and the lag time is undefined (null) with the
note that the pumps are off.

G4, casing shoe and BHA: 13.375 in 72 lb/ft casing (ID 12.347 in,
0.313 614 m) to 3,000 ft, 12.25 in hole from 3,000 to 10,000 ft, 600 ft
of 8 in collars at the bit, 5 in drillpipe above. Cased annulus 0.064 579
m2/m x 914.4 m = 59.051 m3; open hole around drillpipe 0.063 370 x
1950.72 m = 123.617 m3; around the collars 0.043 608 x 182.88 m = 7.975
m3; total 190.644 m3, 11,782.96 strokes. This proves the cased flag, the
shoe cut and the BHA cut survive the trip through wellVolumes.
