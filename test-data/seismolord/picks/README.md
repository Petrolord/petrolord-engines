# Seismolord horizon and fault-stick import fixtures

Dialect fixtures for the tolerant readers in
`engines/seismolord/horizonImport.js` and `engines/seismolord/faultImport.js`,
gated by `__tests__/seismolord.importreaders.test.js`. Fault-stick fixtures
live beside this folder in `../faults/`.

## Survey

The hand-written fixtures sit on one small survey so the tests can land them
on a lattice and check exact cells:

- inlines 1000 to 1010 step 2 (6 lines), crosslines 2000 to 2007 step 1 (8)
- origin X 456000, Y 6780000; one inline step is +25 m in Y, one crossline
  step is +12.5 m in X
- z is TWT in ms, positive down; 4 ms samples
- horizon truth: z = base + 4 * inline index + 2 * crossline index, base 1500
  (Top, H1, H_A) or 1620 (Base, H2, H_B)

## Horizon fixtures (this folder)

| File | Layout | Points |
|---|---|---|
| `charisma3d_petrel.txt` | Petrel Charisma 3D interpretation lines, `INLINE : il XLINE : xl x y z`, fixed width | 12, one horizon |
| `charisma3d_tester_variants.txt` | the marker forms testers' files carry: `INLINE:1006`, `INLINE: 1006`, `INLINE- 1006 2006` (no XLINE marker), `INLINE - 1008 XLINE - 2004`, `INLINE-1008 XLINE-2005`, tab-separated, lower case, `INLINE :1010`, bare `INLINE 1010 XLINE 2006`, `INLINE -1010`; two comment lines and an `Inline Xline X Y Z` header | 10 (3 lines skipped) |
| `charisma3d_named_multi.txt` | leading horizon-name column, two horizons with interleaved rows | Top_Reservoir 8, Base_Reservoir 6 |
| `charisma3d_bad_rows.txt` | 9 good rows and 3 bad: line 4 z is `n/a` (column 9), line 8 has no crossline number (reads 2 numbers after it, column 9), line 9 stops after x (column 8) | 9, 3 rejects |
| `iesx3d_petrel_two_horizons.txt` | IESX card image (3d_ci7m), two `PROFILE` blocks closed by `EOD`, ` I <inline>` marker; one H2 row carries MAXFLOAT z written with `%9.2f`, overflowing its field the way OpendTect's writer does | H1_TWT 6, H2_TWT 3, 1 null |
| `iesx3d_opendtect_segment_excerpt.dat` | first 20 records of a REAL OpendTect IESX export (see provenance): `EOD` prefixing each row and tab-indented echo lines | Segment 20 |
| `earthvision_scattered.dat` | EarthVision `# Type: scattered data` with `# Field:` headers, x y z column row | 12 |
| `cps3_scattered_points.dat` | CPS-3 points: `FFASCI` (null 1.0E+30), `FFATTR`, `->` segments | 8, 1 null |
| `generic_named_horizons.csv` | CSV with header `Horizon,Inline,Crossline,Easting,Northing,TWT (ms)` | H_A 4, H_B 3 |
| `opendtect_multi_named_ilxl_excerpt.dat` | REAL OpendTect multi-horizon export excerpt: commented header `# "Inline" "Crossline" "Z"` that does not list the leading name column | F3_Demo_2_FS6 6, F3_Demo_4_Truncation 5 |

## Fault-stick fixtures (`../faults/`)

| File | Layout | Result |
|---|---|---|
| `charisma_faultsticks_petrel.txt` | Petrel Charisma fault sticks, `INLINE- il xl x y z name stick` | Fault_A sticks 3+3, Fault_B 2+2 (10 points) |
| `charisma_faultsticks_tester_variants.txt` | `INLINE -  1002`, `INLINE-1002`, tab-separated, `INLINE : 1006 XLINE : 2002`, `INLINE:1006 XLINE:2003`, quoted name with a space (`"Main Fault"`), a comment and a header row | Fault_A 3+3, Main Fault 3 (9 points) |
| `charisma_faultsticks_resqpy_zero_lines.txt` | resqpy's writer: tab-separated, inline and crossline written as 0 | F1 3+3, located by X/Y |
| `charisma_faultsticks_bad_rows.txt` | line 4 z is `----` (column 6), line 7 ends without a stick number (column 7), line 8 stops after x (column 5) | 8 points, 3 rejects |
| `iesx_faultsticks.txt` | IESX fault sticks: `PROFILE <fault>` blocks (fault_gf.ifdf), stick index in columns 33-35; Fault_A rows carry the 3D inline marker, Fault_B rows are 47-character XY-only rows | Fault_A 3+3, Fault_B 2+2 |
| `generic_faultsticks.csv` | CSV header `Fault Name,Stick,X,Y,TWT(ms)`, stick 2 filed before stick 1 | F_North 3+3, F_South 2+2 |
| `generic_faultsticks_blankline.dat` | bare `x y z`, a blank line ends each stick | 3+2+3 |

## Provenance

- The hand-written fixtures were typed to the published layouts: Petrel's
  Charisma 3D interpretation and Charisma fault-stick ASCII (the same
  columns seismiqb, resqpy and softwareunderground/subsurface read), the
  IESX card-image columns from OpendTect's writer
  (`src/uiEarthModel/uiexphorizon.cc`, `writeGF`) and DUG Insight's IESX
  fault import notes (x in columns 1-16, y 17-32, stick index 33-35, z
  39-47), EarthVision's `# Field:` header convention and CPS-3's
  `FFASCI`/`FFATTR`/`->` point layout. No Petrel-written IESX FAULT file was
  available: `iesx_faultsticks.txt` follows those documented columns, and
  the header's `TYPE 1  3` is illustrative (the reader does not use it).
- `iesx3d_opendtect_segment_excerpt.dat` (first 42 lines of
  `data/OdT/3d_horizon/Segment_IESX.dat`) and
  `opendtect_multi_named_ilxl_excerpt.dat` (lines 1-8 and 3022-3028 of
  `data/OdT/3d_horizon/F3_Multi-H2-H4_ILXL_Single-line-header.dat`) come
  from github.com/softwareunderground/gio. That folder's LICENCE puts the
  files under CC0 (public domain): horizons tracked by Matt Hall on the F3
  Demo volume in OpendTect.
