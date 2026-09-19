# FINDINGS: consequence (oracle_consequence.py, HSE H4)

Engine: `engines/hse/consequence.js`. Golden:
`test-data/hse/goldens/consequence_cases.json`, written by
`oracle_consequence.py` (Python 3.12 in the venv `/root/hseenv`, numpy and
scipy 1.18; it never calls the JavaScript). Gate:
`__tests__/hse.consequence.test.js`, where every golden is called through the
engine. Negative controls: `negcontrol_consequence.sh`.

## 1. Sources actually read

| key | document | what it fixes here |
|---|---|---|
| YB | TNO Yellow Book, CPR 14E, 3rd ed., 2nd revised print (2005), publications.tno.nl | gas and liquid outflow (2.22 to 2.26, 2.194 to 2.197); Mackay and Matsugu (3.13, 3.24, 3.25); pool diameter (6.64, 6.65); Babrauskas Table 6.5 and eq. 6.66; Burgess 6.67; Thomas with wind 6.12 to 6.14; tilt 6.68 to 6.70; SEP 6.19, 6.20, 6.71; Bagster 6.29; q = SEP F tau (6.4); Appendix 6.1 view factors and Table 6.A.1; TNT equivalence 5.1; worked examples 2.6.2.1, 2.6.4.1, 6.6.2, 6.6.3 |
| PB | TNO Purple Book, CPR 18E (1999), publicatiereeksgevaarlijkestoffen.nl (PGS 3) | Table 5.1 (probit vs P); toxic probit 5.3 and Table 5.2; heat probit 5.4; Appendix 6.B (CO plume and probit) |
| OSD | UK HSE SPC/Tech/OSD/30 (Wayback copy of hse.gov.uk; the live URL now 404s) | thermal probits Table 17; Tsao and Perry fatality Table 18; Lees (2005) toxic probits in ppm Table 2; HSC overpressure probit Equation 4 |
| ALOHA | NOAA TM NOS OR&R 43, ALOHA Technical Documentation (2013) | continuous Gaussian plume with ground reflection (4.3); Briggs rural coefficients, Table 13 |
| KG | Guzas and Earls (2010), Steel and Composite Structures 10(5) eq. 5; also Dlubal's formula page and arXiv 2102.06574 eq. 11, which print the same constants | Kinney and Graham (1985) free-air overpressure: 808, 4.5, 0.048, 0.32, 1.35 |
| CBU | "Analysis of mathematical relations for ..." CBU International Conference 2020, Prague (semanticscholar pdf) | a printed table of Kinney-Graham values (secondary) |
| CCOHS | CCOHS OSH Answers, converting mg/m3 to ppm | 24.45 L/mol at 25 C and 760 torr |

Not obtained, so NOTHING here claims to reproduce them: Crowl and Louvar,
CCPS CPQRA, the TNO Green Book (the PGS 1 file is gone from the public
bucket), Kinney and Graham's book, UFC 3-340-02, Kingery and Bulmash
ARBRL-TR-02555, Hanna, Briggs and Hosker (1982).

## 2. Corrections to the brief

1. **"Eisenberg Y = -14.9 + 2.56 ln(t q^(4/3) / 1e4)"**: correct, with q in
   W/m2 and t in s. It is identical to OSD/30's Y = -14.9 + 2.56 ln V with V
   in (kW/m2)^(4/3) s, because (1000 I)^(4/3) = 1e4 I^(4/3). A test asserts
   the identity to 1e-13. **Not every "TNO" heat probit is Eisenberg,
   though.** The Purple Book's -36.38 + 2.56 ln(Q^(4/3) t) (W/m2) is Tsao and
   Perry: -12.8 - 2.56 ln(1e4) = -36.378. Tsao and Perry sits 2.1 probit
   units above Eisenberg. At the Eisenberg 50 percent dose it gives about 98
   percent. The presets are named by origin (`eisenberg`, `tsao-perry`,
   `lees`, `purple-book`) so the two cannot be confused.
2. **"Critical pressure ratio from gamma"**: correct. It is reused from
   `relief.js`. The YB's own test is P0/Pa >= ((g+1)/2)^(g/(g-1)), so a ratio
   EXACTLY at the critical value is choked. The subsonic psi equals 1 there,
   so the regime flag flips with no jump in flow. The test builds an
   upstream pressure whose ratio is the critical ratio bit for bit and
   checks both properties.
3. **"Ground-level centreline concentration"**: the implemented form is the
   general reflected plume at any (y, z). The PB worked case is at z = h =
   1 m, not at ground level. Ground level on the centreline is the special
   case Q / (pi sy sz u) exp(-h^2 / 2 sz^2).
4. **"Kingery-Bulmash polynomial fits as given in UFC 3-340-02"**: UFC
   3-340-02 prints Kingery-Bulmash as CURVES (Figure 2-7 and following). The
   polynomial coefficients are in ARBRL-TR-02555 and Swisdak (1994), and I
   did not obtain either. Kinney and Graham's closed form is implemented
   instead, as the brief allows.
5. **"TNO Green Book / CCPS overpressure and toxic probits"**: neither book
   was available. The toxic presets are the Purple Book's Table 5.2 (mg/m3,
   min) and Lees (2005) as OSD/30 Table 2 prints them (ppm, min). The
   overpressure preset is the HSC road-and-rail probit from OSD/30. The
   lung-haemorrhage and eardrum probits often quoted from the Green Book
   (for example -77.1 + 6.91 ln p) are NOT included, because I could not read
   their source.
6. **"Wayne's transmissivity"**: not sourced. The YB's own closed form is
   Bagster (1989), tau = 2.02 (pw x)^-0.09, and it is implemented with the
   YB's stated validity range (section 5).
7. **Mackay and Matsugu vs the "simple mass-transfer form in Crowl and
   Louvar"**: I picked Mackay and Matsugu, because the YB prints it in SI
   with its constant (0.004786 m^0.33/s^0.22) and a default Sc of 0.8. The
   Crowl and Louvar form was not available to check.

## 3. Goldens by source

PUBLISHED means the engine reproduces a value printed in a source listed in
section 1. The tolerance is stated per case. Everything else is
ORACLE-DERIVED: illustrative inputs through the oracle's own transcription.

| golden | printed | engine | tolerance | note |
|---|---|---|---|---|
| YB 2.6.4.1 acrylonitrile, level 11.12 m | 58.44 kg/s | 58.4296 | 5e-4 rel | level printed to 2 dp |
| YB 2.6.2.1 hydrogen, t = 0 | 15.31 kg/s | 15.3118 | 2 dp | **gamma not printed; 1.405 inferred** (1.40 gives 15.29) |
| YB 6.6.3 pool diameter | 42.445 m, 1415 m2 | 42.4457 | 1e-3 m | printed truncated |
| YB 6.6.3 uc, u*, L/D, L | 3.06866, 1.62937, 1.101938, 46.7725 | 3.06875, 1.62933, 1.102004, 46.7753 | 1e-4 rel | |
| YB 6.6.3 Re, tan/cos, tilt | 2.824e7, 1.94315, 50.8286 deg | 2.8247e7, 1.943154, 50.82870 | 1e-3, 1e-5, 1e-5 | |
| YB 6.6.3 SEP Mudan, SEPmax, SEPact | 21e3, 25.24e4, 6.6e4 | 20736, 252422, 66484 | 2%, 1e-3, 1% | |
| YB 6.6.3 Fv, Fh, Fmax (computed a, b) | 0.091915, 0.029146, 0.0964 | 0.0919238, 0.0291518, 0.0964355 | 2e-4, 3e-4, 1e-3 rel | |
| YB 6.6.3 q at 100 m, tau 0.71474 | 4.581e3 W/m2 | 4582.5 | 1e-3 rel | |
| YB 6.6.3 view factor (printed a, b, tilt) | 0.091915, 0.029146 | 0.0919158, 0.0291472 | 2e-6 abs | |
| YB 6.6.2 jet view factor, step 29 | 0.02665, 0.00934 | 0.0266498, 0.0093416 | 5e-6 abs | |
| YB Table 6.A.1 (Raj), 303 cells | 1e3 F | same | +-1 in the last digit | 2 cells are misprints (section 4) |
| PB Appendix 6.B CO plume | 21.3 g/m3 | 21.26 | 1 dp | sigmas as printed (28.8, 10.3 m) |
| PB Appendix 6.B CO probit | Pr 5.97, P 0.835 | 5.9677, 0.8334 | 2 dp; 0.002 abs | the PB reads P off Table 5.1 |
| PB Table 5.1, 97 of 99 cells | Y to 2 dp | same | 2 dp | 0.12 and 0.88 sit on a rounding edge (within 0.006) |
| OSD Table 17 lethal doses, Eisenberg, Tsao-Perry, Lees | 960/2380, 420/1046, 828/2670 | 958/2377, 422/1046, 829/2669 | 0.5% | TNO row excluded (section 4) |
| OSD Table 18, 18 cells | percent | same | 1 percentage point | 3 cells differ by 0.6 to 0.8 (rounding) |
| OSD Table 2 (Lees), 13 substances x 4 | LC1, LC50 at 5 and 30 min | same | 1% or 1 ppm | all 52 reproduce |
| OSD Eq. 4 HSC, 1/50/95% | 2.4, 13.1, 43.5 psig | 2.41, 13.15, 43.70 | 1% | 95% row is 0.45% off |
| CBU 2020 Kinney column, 5 values | 29.24, 19.63, 9.066, 38.71, 174.87 kPa | 29.238, 19.627, 9.066, 38.708, 174.870 | 5e-4 rel | the paper PRINTS 800 and 0.049, but its column follows 808 and 0.048 |
| CCOHS 24.45 | ppm x MW / 24.45 | R T / P = 24.465 L/mol | 0.1% | 5 substances |
| ALOHA Table 13 | coefficient table | BRIGGS_RURAL | exact | |
| YB Table 6.5 | Babrauskas coefficients | POOL_FIRE_FUELS | exact | |

ORACLE-DERIVED: liquid and gas discharge beyond the two YB cases (including
a subsonic case, a case just below and one just above the critical ratio,
and a raised ambient pressure); bund and stated-thickness pools;
evaporation; 42 sigma points (6 classes x 7 distances); 7 plume cases and 5
distance-to-concentration cases (two roots, NOT_REACHED,
BEYOND_SEARCH_RANGE); Thomas still-air and with wind (below and above uc);
tilt; 7 view factors across tilt toward, tilt away and near-overhang;
Bagster; TNT; Kinney-Graham at 7 Z values and 4 inversions; thermal, toxic
and overpressure probits; 35 refusals.

## 4. Errata found in the sources

1. **YB 6.6.3 Froude number.** It prints Fr10 = 0.0545. In fact 5^2 /
   (9.80665 x 42.445) = 0.06006, and the printed tan/cos (1.94315) and tilt
   (50.8286 deg) follow only from 0.06006. The elongation step 7 (D'/D =
   1.3398) does use 0.0545. The engine does not implement elongation.
2. **YB 6.6.3 kinematic viscosity.** It uses 7.5133e-6 m2/s "for air at 15
   C". Air at 15 C is about 1.48e-5. The golden uses the printed value
   because the printed tilt depends on it. Re enters only as Re^0.117, so
   the effect is about 8 percent on the tilt parameter.
3. **YB 6.6.3 distances.** The inputs give x = 100 m "from centre of pool".
   Steps 9, 10 and 13 then say "50 m from the flame surface" but compute pw
   x with 100 m. Bagster's x is defined from the flame SURFACE. The engine
   uses X - D/2 when it computes tau, and the published golden takes tau as
   printed (0.71474, read from Hottel's charts).
4. **YB 6.6.2 jet flame.** Step 28b evaluates Bagster with exponent -0.08
   and gets 0.772. With -0.09 the value would be about 0.68, and pw x = 1.67e5
   is outside Bagster's range anyway. The text says 46.7 m and 49.8 m where
   the computation uses 139.57 m and 149.96 m. Step 17 uses Rw = 0.0062
   against the 0.00546 found in step 7. Step 29's view factor reproduces.
5. **YB Table 6.A.1.** Two Fmax cells do not follow from their own Fh and
   Fv:
   - (xr 1.2, hr 0.1): printed 210, but sqrt(44^2 + 196^2) = 201. The
     digits look transposed.
   - (xr 1.4, hr 0.2): printed 117, where 177 is correct.

   The 2005 print corrected Table 6.A.2 but not these cells. Both are gated
   as misprints.
6. **YB Table 2.8, t = 0.** It prints 60.915 kg/s at an 11.20 m level.
   Bernoulli (2.194) gives 58.64 kg/s. The same example's headline value at
   500 s (58.44 kg/s at 11.12 m) does reproduce, and that is the golden.
7. **YB pdf text extraction** drops the square roots in 6.A.14 and 6.A.15
   (A, B, C, D, F) and prints C as (1 + (b-1)^2 cos^2). The worked example
   (A = 4.2384, C = 3.07555) reproduces only with the square roots and with
   C = sqrt(1 + (b^2 - 1) cos^2 t), which is Mudan's form. A negative control
   plants the garbled C.
8. **OSD/30 Table 17, TNO row** (-15.3 + 3.02 ln V). Its printed lethal
   doses (389, 841) do not follow from its coefficients (384, 830; 1.3
   percent). I cannot tell which of the two is wrong, so the row is not a
   preset.
9. **OSD/30 Table 18** is introduced in the text as "the TNO probit
   function" but headed "Tsao & Perry". Its values follow Tsao and Perry.
10. **OSD/30 Equation 4**: 95 percent prints 43.5 psig (3.00 barg). The
    probit gives 43.7 psig (3.02 barg).
11. **ALOHA Table 13 note**: "an incorrect value of 0.00015 for sz2 was
    presented in Briggs (1973) and many later references". The note does not
    say which row. In ALOHA's table 0.0015 appears in the rural D row and the
    urban E and F rows, and only the rural set is implemented.
12. **CBU 2020 paper** prints Kinney-Graham with 800 and 0.049. Its
    computed column follows 808 and 0.048.

## 5. Judgement calls

- **Kinney-Graham Z range [0.05, 40] m/kg^(1/3).** The brief asks for a
  stated range with refusal outside it. I found no range printed for the
  Kinney-Graham fit itself. I adopted the span of the Kingery-Bulmash TNT
  compilation (free air 0.05 to 40), which the CBU paper quotes. This is a
  sourcing weakness.
  - The fit is analytic beyond 40 and decays as 0.827/Z.
  - Refusing there means the glass-breakage band (about Z 50 to 80) needs
    another method.
  - A surface burst is not modelled; the caller chooses the charge weight.
- **Bagster outside 1e4 < pw x < 1e5 N/m is refused, not extrapolated.** The
  YB says "not advised", and below about 2.5e3 the fit exceeds 1. The
  composite pool-fire function takes a given transmissivity instead. The
  distance-to-heat-flux search REQUIRES a fixed transmissivity, because a
  root search would walk out of Bagster's band.
- **View factor with the flame overhanging the target (1 + a sin t >= b) is
  refused.** Route B shows the closed form's Fv wrong there (by 0.0063 to
  0.070 in three probes), while Fh stays right. This refusal is my
  decision; the YB states no domain.
- **Solid-flame flux uses Fmax**, the vector sum (YB 6.A.18), that is, the
  most exposed target orientation. Fv and Fh are also returned.
- **The flame base radius is D/2.** Wind elongation of the base (YB 6.18) is
  not applied, which matches the YB's own step 12.
- **TNT blast energy is a required input, refused outside 4.0 to 5.0
  MJ/kg.** The YB cites 4.19 to 4.65 in use, and other texts use 4.68 to
  4.69. The refusal is there to catch unit slips such as kJ/kg.
- **Burgess with Tb < Ta is refused.** The printed form would then shrink
  its denominator.
- **Briggs sigmas warn** outside 100 m to 10 km (the range these curves are
  commonly quoted for); they do not refuse. That range is from memory of
  Crowl and Louvar and Hanna et al., and not from a source read here.
- **ppm conversion uses R T / P** at the stated T and P (24.465 L/mol at 25
  C, 1 atm). CCOHS's 24.45 is its rounding, and it is gated at 0.1 percent.
- **Probabilities use the repo's canonical `lib/stats` `normalCDF`**
  (Abramowitz and Stegun 7.1.26, |error| <= 1.5e-7) rather than a new erf.
  Probability goldens are gated at 2e-7 absolute. Below P of about 1e-6 the
  RELATIVE error of that erf is large, which is irrelevant to lethality
  bands but worth knowing.
- **Reuse.** `criticalPressureRatio` comes from `relief.js`. The Thomas
  still-air flame height is now exported from `spacing.js` as
  `thomasFlameHeightM`, and `poolFireSetbackM` calls it with the same
  expression and defaults, so it is unchanged bit for bit (a test asserts
  equality, and the 581 facilities tests pass). `fireHeatInput` was read
  and not used: it is the API 521 heat input to a wetted vessel for relief
  sizing, not a consequence model.

## 6. Dropped scope, and why

| item | why |
|---|---|
| two-phase discharge | no public closed form read with a worked example; the YB two-phase models (2.5.3) are numerical |
| unconfined pool spreading | the YB spreading model (6.73 to 6.80, Cline) is a differential equation for a FED pool; only a stated-thickness pool (YB 6.65) is implemented |
| instantaneous puff | the puff sigmas (Slade/Turner as in Crowl and Louvar) were not in a source read; ALOHA's sigma_x (Beals) serves its own finite-duration hybrid, not a standard puff |
| urban Briggs set | ALOHA prints the urban sigma_z but uses the rural sigma_y for all roughness, so a sourced urban sigma_y was not available |
| jet fire (Chamberlain/Thornton, YB 6.5.3) | reproducible in principle (30 steps, one iterative root). Its only worked example (YB 6.6.2) carries at least four internal inconsistencies (section 4 item 4), so a golden could not tell a right engine from a wrong one. The view factor it ends with IS a golden. Recommended as a follow-up with an independent example. |
| Kingery-Bulmash | coefficients not obtained (section 2 item 4) |
| TNO multi-energy | the YB presents the blast charts graphically; no published curve fit was found |
| Green Book lung, eardrum and structural probits | source not read |

## 7. Oracle routes and tolerances

| quantity | route A (oracle transcription) | route B | tolerance |
|---|---|---|---|
| view factor | Mudan / Raj closed form | 400 x 400 Gauss-Legendre over the visible sheared-cylinder surface (N.(T-P) = X cos p - R, so the visible arc is independent of height) | A: 1e-10 rel; engine vs B: 1e-9 abs (observed ~1e-15) |
| gas discharge | YB 2.22 to 2.26 | isentropic nozzle flux maximised over throat pressure p >= Pa (scipy bounded) | A 1e-10; B 1e-9 (observed ~1e-16) |
| liquid discharge | YB 2.194 | Torricelli sqrt(2 g h) when the ullage is at ambient | 1e-10 |
| plume | ALOHA 4.3 | oracle: scipy dblquad of u C over y and z >= 0 = Q (to 1e-12); test: 96 x 96 Gauss-Legendre of the ENGINE'S plume, 4 cases | 1e-10; 1e-9; 1e-6 |
| distance to concentration, Kinney-Graham inverse | brentq, xtol 1e-13 | round trip through the forward model | 1e-9 rel |
| probit | scipy.stats.norm | printed PB Table 5.1 | 2e-7 abs (A and S erf) |
| evaporation, Bagster, Burgess, TNT, SEP, tilt, Thomas | single closed form | none | 1e-10 |

## 8. Negative controls (negcontrol_consequence.sh)

Run 2026-09-19. Baseline: 206 passed. Each row plants one defect, runs the
suite and restores. At the end the golden is restored byte-identical, the
oracle regenerates it byte-identical, and the suite passes 206 again. The
two Table 5.1 oracle rows were re-run after the cell counts were pinned (the
first run caught them through the misprint list alone).

| kind | plant | result |
|---|---|---|
| ENGINE | plume: ground reflection (image source) dropped | RED, 14 failed |
| ENGINE | plume: 2 pi -> pi in the prefactor | RED, 14 failed |
| ENGINE | sigmas: class D takes the class E row (wrong stability column) | RED, 13 failed |
| ENGINE | sigmas: sz2 0.0015 -> 0.00015 for class D (the misprint ALOHA warns of) | RED, 13 failed |
| ENGINE | sigma_y: 1/sqrt(1 + sy2 x) dropped | RED, 54 failed |
| ENGINE | gas: critical pressure ratio inverted | RED, 4 failed |
| ENGINE | gas: exactly-critical counted as subsonic (<= read as <) | RED, 1 failed |
| ENGINE | gas: subsonic psi exponent 2/gamma -> 1/gamma | RED, 4 failed |
| ENGINE | liquid: 2 dropped from Bernoulli | RED, 5 failed |
| ENGINE | pool: bund overtopping check removed | RED, 1 failed |
| ENGINE | evaporation: wind exponent 0.78 -> 0.8 | RED, 3 failed |
| ENGINE | burning rate: diameter correction dropped | RED, 7 failed |
| ENGINE | Thomas wind: u* not clamped at 1 | RED, 1 failed |
| ENGINE | tilt: Re exponent 0.117 -> 0.17 | RED, 4 failed |
| ENGINE | SEP: 1 + 4 L/D -> 1 + 2 L/D | RED, 2 failed |
| ENGINE | view factor: sign of the tilt term in A flipped | RED, 8 failed |
| ENGINE | view factor: C uses (b - 1)^2 (the extraction-garbled print) | RED, 12 failed |
| ENGINE | view factor: overhang refusal removed | RED, 2 failed |
| ENGINE | solid flame: point source instead of the view factor | RED, 2 failed |
| ENGINE | transmissivity: exponent -0.09 -> -0.08 (the YB jet example's slip) | RED, 5 failed |
| ENGINE | transmissivity: Bagster range guard removed | RED, 3 failed |
| ENGINE | blast: W^(1/2) scaling instead of the cube root | RED, 9 failed |
| ENGINE | blast: 808 -> 800 and 0.048 -> 0.049 (the CBU paper's printed form) | RED, 16 failed |
| ENGINE | blast: Z range guard removed | RED, 2 failed |
| ENGINE | TNT: efficiency applied twice | RED, 2 failed |
| ENGINE | probit: ln -> log10 | RED, 12 failed |
| ENGINE | probit: P = Phi(Y) instead of Phi(Y - 5) | RED, 9 failed |
| ENGINE | thermal: I^(4/3) -> I | RED, 8 failed |
| ENGINE | thermal: kW/m2 presets fed W/m2 | RED, 7 failed |
| ENGINE | toxic: exponent n ignored | RED, 3 failed |
| ENGINE | conversion: molar volume at 0 C instead of the stated T | RED, 8 failed |
| ENGINE | overpressure probit: Pa fed where psig is due | RED, 1 failed |
| ORACLE | oracle plume: image source dropped | RED, 13 failed |
| ORACLE | oracle Briggs D sz1 0.06 -> 0.07 | RED, 13 failed |
| ORACLE | oracle Mudan: sign of the tilt term in A flipped | RED, 8 failed |
| ORACLE | oracle route B: surface normal loses its tilt component | RED, 7 failed |
| ORACLE | oracle nozzle: throat pressure allowed below ambient | RED, 3 failed |
| ORACLE | oracle Table 5.1 transcription slip 3.36 -> 3.63 | RED, 2 failed |
| ORACLE | oracle Kinney-Graham 1.35 -> 1.3 | RED, 16 failed |
| ORACLE | oracle probit inverse uses 1 - P | RED, 2 failed |
| SHARED | Mudan: sign of the tilt term in A flipped in both (route B must catch it) | RED, 8 failed |
| SHARED | plume: image source dropped in both (the mass-flux route must catch it) | RED, 9 failed |
| SHARED | Kinney-Graham 808 -> 800 in both (the CBU table must catch it) | RED, 5 failed |
| SHARED | Thomas wind 55 -> 50 in both (the YB example must catch it) | RED, 2 failed |
| SHARED | Lees chlorine a -8.29 -> -8.39 in both (OSD/30 Table 2 must catch it) | RED, 1 failed |
| SHARED | Mackay-Matsugu wind exponent 0.78 -> 0.8 in both (single route: expected GREEN) | GREEN (not caught) |
| SHARED | Bagster exponent -0.09 -> -0.08 in both (single route: expected GREEN) | GREEN (not caught) |
| SHARED | Burgess 0.001 -> 0.0011 in both (single route: expected GREEN) | GREEN (not caught) |

Reading the table:

- **All 32 ENGINE plants and all 8 ORACLE plants go red.** Those are the brief's six and 34 more.
- **The SHARED rows are the useful ones.** The same mistake is copied into BOTH
  files, and the question is whether something independent still catches it:
  - the Mudan sign flip is caught by route B, the numerical integration;
  - the dropped ground reflection is caught by the mass-flux integral;
  - Kinney-Graham 808 -> 800 is caught by the CBU table;
  - Thomas 55 -> 50 is caught by the YB worked example;
  - the Lees coefficient slip is caught by the OSD/30 LC columns.
- **Three single-route items stay GREEN: Mackay and Matsugu, Bagster and Burgess.**
  Only the transcription from the YB stands behind them. No public worked
  number was found to anchor any of the three, and this is stated as a doubt (section 10).

## 9. What this engine does not re-grade

The NextGen courses FC1 and FC5 already grade the point-source flare and
pool-fire radiation and setbacks. Those outputs stay where they are and are
NOT re-exposed here. A test asserts that `consequence.js` exports none of
them.

- `engines/facilities/relief.js`
  - `radiationIntensity`: K = tau F Q / (4 pi R^2)
  - `distanceForIntensity`
  - `RADIATION_LEVELS`, the API 521 customary 1.58, 4.73, 6.31 and 9.46 kW/m2
- `engines/facilities/spacing.js`
  - `flareSetbackM`
  - `poolFireSetbackM`: point-source radius from the centre, setback from
    the edge, and the Thomas flame height used only as a near-field flag
  - its `RADIATION_LEVELS` copy

This engine adds what those functions say they do not provide:
`poolFireSetbackM`'s own docstring states "No view factor and no
solid-flame surface emissive power are computed. A near-field design case
needs a solid-flame model." Only the Thomas still-air expression is shared,
by import.

## 10. Doubts, for the owner

1. **The hydrogen golden's gamma (1.405) is inferred**, not printed.
2. **The Kinney-Graham range is borrowed** from the Kingery-Bulmash
   compilation (section 5).
3. **The CBU Kinney-Graham table is a secondary source.** Its printed
   formula disagrees with its own column (section 4 item 12). I label it
   PUBLISHED because its numbers reproduce, not because the paper is
   authoritative.
4. **Single-route items** carry no second derivation. The SHARED negative
   controls show that a copied mistake in them goes unseen:
   - Mackay and Matsugu
   - Bagster
   - Burgess
   - TNT equivalence
   - the SEP forms
   - tilt
   - Thomas still-air

   Where a published worked value exists (the YB pool fire for Thomas with
   wind, SEP and tilt), that value is the catch.
5. **The YB example's own air viscosity** is half the physical value
   (section 4 item 2). The engine takes viscosity as an input and has no
   default.
6. **No Crowl and Louvar example is reproduced.** The book was not
   available, so any NextGen course grading against its worked examples
   needs those examples checked separately.
