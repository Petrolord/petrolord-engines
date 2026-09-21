# FINDINGS: qra (oracle_qra.py, HSE H5)

Engine: `engines/hse/qra.js`. Golden: `test-data/hse/goldens/qra_cases.json`,
written by `oracle_qra.py`. The oracle runs on Python 3.12 in the venv
`/root/hseenv` with numpy 2.5.3 and scipy 1.18.1. It never calls the
JavaScript. For the pool fire transect it imports the H4 oracle's own
transcriptions of Thomas, Raj and Mudan from `oracle_consequence.py`, and
does not run that oracle's `main()`. Gate: `__tests__/hse.qra.test.js`, 171
tests, and every golden in it is called through the engine. Negative controls:
`negcontrol_qra.sh`.

## 1. Sources actually read

| key | document, and where it was read | what it fixes here |
|---|---|---|
| PB | TNO Purple Book, CPR 18E (1999), PGS 3 pdf (content.publicatiereeksgevaarlijkestoffen.nl). The figure and equation images were rendered and read as pages. | IR eqs. 6.1, 6.2; societal risk 6.3 to 6.6 ("N or more"); toxic grid point 6.8 to 6.12; Fd 6.7, 6.13; Appendix 6.A (Pci above 1); **Appendix 6.B worked IR**; Figures 5.2 to 5.5 (PE, FE,in, FE,out); Table 5.3 (0.93 / 0.99 indoors); section 5.2.3 notes 3 to 5 (20 s cap, 35 kW/m2, clothing 0.14); section 5.2.2 note 3 (30 min cap); Table 4.5 (direct ignition); section 4.8 (flash fire 0.6, explosion 0.4); section 6.3 (IR contours 1e-4 to 1e-8); Figure 6.8 caption (F < 1e-3 N^-2 for N >= 10) |
| R2P2 | UK HSE, *Reducing risks, protecting people* (2001). The live hse.gov.uk URL returns 404, so it was read from the full copy on cambridgesafety.co.uk. | paras 128 to 136 (1e-3 workers, 1e-4 public, 1e-6 for both, and the societal point of 50 deaths at 1 in 5000); the para 128 box of industry and public rates; Appendix 3 paras 13 to 20 (VPF about GBP 1 000 000 in 2001, CPF = cost / fatalities prevented, 6 percent discounting with 4 percent uprating of benefits, bias to safety); Appendix 3 paras 3 to 5 (Edwards v NCB, gross disproportion) |
| CBA | UK HSE, *Cost Benefit Analysis (CBA) checklist*. The live URL returns 404, so it was read from the Wayback Machine `id_` copy of hse.gov.uk/risk/theory/alarpcheck.htm. | the test "costs divided by benefits are greater than the disproportion factor" (read from the image alt text); DFs "from upwards of 1"; harm values (2003 Q3), with fatality GBP 1,336,800 (x2 for cancer); discounting of benefits at no more than 1.5 percent and of costs at no less than 3.5 percent (2003); **the worked explosion example** |
| BEVI | *Besluit externe veiligheid inrichtingen*, read from wetten.overheid.nl BWBR0016767, version of 2016-01-01, marked "Regeling vervallen per 01-01-2024" | art. 1 definitions (plaatsgebonden risico, groepsrisico); arts. 6 to 8 (PR limit and target value 1e-6); art. 13(1)(b), the group risk comparison points 1e-5 at 10 or more deaths, 1e-7 at 100, 1e-9 at 1000 ("ten hoogste", at most) |

Not obtained, so NOTHING here claims to reproduce them: CCPS CPQRA, Crowl
and Louvar, the TNO Green Book, HSE RR703 and the SRTAG societal risk papers,
R2P2's reference 32 (the FN extrapolation), and the Omgevingswet / Bkl
values that replaced Bevi in 2024.

## 2. Corrections to the brief

1. **There is no "UK HSE R2P2 societal line".** R2P2 para 136 gives a single
   POINT: "the risk of an accident causing the death of 50 people or more in a
   single event should be regarded as intolerable if the frequency is
   estimated to be more than one in five thousand per annum". It defers
   extrapolation to other N to its reference 32 ("See reference ... for a
   discussion of techniques available for extrapolating this criterion").
   - The preset `r2p2-para-136` is that one point.
   - The slope -1 line through it is common practice, but it is not in R2P2.
     It is not a preset. A caller who wants it supplies `{ constantC: 0.01,
     exponentAlpha: 1 }` as their own criterion.
2. **The Dutch group risk value is an orientation value, and Bevi is
   repealed.**
   - Bevi art. 13 asks for the group risk to be COMPARED with 1e-5 / 1e-7 /
     1e-9 ("oriëntatiewaarde"). It is not a limit.
   - The only Bevi limit ("grenswaarde") is the place-bound risk of 1e-6 for
     vulnerable objects.
   - Bevi was repealed on 1 January 2024. The values are historical, and
     their successors in the Bkl were not read.
   - The PB Figure 6.8 caption prints the same line as a "recommended limit
     for establishments": F < 1e-3 N^-2 for N >= 10.
   - The preset `vrom-establishments` cites both sources. A test checks that
     the three Bevi points lie on the PB line.
3. **The PB indoor and outdoor factors are for SOCIETAL risk, not IR.** PB
   5.1 defines PE, the probability of death used for the IR, for a person
   "outdoors and ... unprotected". FE,in and FE,out are "to be used in the
   calculation of the Societal Risk". So the brief's "vulnerability
   indoor/outdoor factors" do not come from a source when applied to IRPA.
   - `individualRiskPerAnnum` accepts a vulnerability factor supplied by the
     caller, default 1, and says so in its basis.
   - The PB fractions are `pbFatalityFractions`, which is used for Fd.
4. **"benefit = delta PLL x VPF x years" is the undiscounted checklist
   form.** The checklist counts injuries and ill health as well (its example
   includes permanent, serious and slight injuries), so `otherHarms` is an
   input. Neither R2P2 nor the checklist says to discount by default.
5. **The two HSE sources disagree on discounting.**
   - R2P2 (2001): 6 percent real, with benefits uprated 4 percent a year.
   - The checklist (2003): benefits at no more than 1.5 percent, costs at no
     less than 3.5 percent.
   - All three rates are inputs, and each defaults to 0 (undiscounted).
6. **VPF has two published values**: about GBP 1 000 000 (2001, R2P2) and
   GBP 1,336,800 (2003 Q3, checklist). Both are exported as illustrative data
   only (`HSE_ILLUSTRATIVE_VALUES`). VPF has no default.
7. **DF.** The checklist says "DFs that may be considered gross vary from
   upwards of 1", and its example says "a DF of more than 10 is unlikely".
   A DF below 1 is refused. The checklist fixes the test itself as costs /
   benefits > DF (strictly greater).
8. **Aversion-weighted risk integral.** No source read defines one, so it is
   dropped. The expected value sum f N is implemented. It equals the area
   under the F-N curve, and route B checks that identity.
9. **Worked examples.** The PB has an IR worked example (Appendix 6.B), which
   is a golden. It has NO worked F-N or societal risk example. CCPS was not
   available.
10. **NPV.** The canonical discounting in the engines repo is
    `engines/economics/cashflow.ts` `npv(flows, rate, baseYear, firstYear)`,
    the EPE cash flow engine, which discounts at year end. `screening.js`
    `calculateEconomics` (the npvCalculations.js lineage) needs an oil-field
    input deck, so it does not fit a safety measure's cost stream.
    `costBenefit` computes every present value through `npv`, and a test
    asserts the result equals `npv(...)` called directly.
11. **FAR** = PLL x 1e8 / exposed hours is right. The base is imported from
    safetyStats `RATE_BASES.FAR_100M`. `fatalAccidentRate` takes whole
    counts only, so it cannot take a fractional PLL. The gate therefore
    asserts that a whole PLL gives exactly the value `fatalAccidentRate`
    gives.

## 3. Goldens by source

PUBLISHED (21 cases): the engine reproduces a value printed in a source in
section 1.

| golden | printed | engine | tolerance |
|---|---|---|---|
| PB App. 6.B centreline C | 21.3 g/m3 | 21.2606 | 0.5% |
| PB App. 6.B Pr, Pcl | 5.97, 0.835 | 5.9658, 0.83293 | 0.1%, 0.3% |
| PB App. 6.B PI | 72 m | 71.883 | rounds to 72 |
| PB App. 6.B ECW, Pci, Pd | 86.2 m, 0.456, 0.381 | 86.301, 0.45657, 0.38029 | 0.2% |
| PB App. 6.B dIR | 7.0e-9 per yr | 6.9974e-9 | 2 significant figures |
| PB App. 6.B each step from its printed predecessor | 86.2, 0.456, 0.381, 7.0e-9, PM Pphi 0.0368 | 86.228, 0.45604, 0.38076, 7.0104e-9, 0.036816 | printed digits |
| PB App. 6.B step 6 through `locationIndividualRisk` | 7.0e-9 | 7.0104e-9 | 2 significant figures |
| PB Table 4.5, 12 interior cells | table | same | exact |
| R2P2 para 128 box: 4 worker rates (1 in 12 984, 21 438, 14 564, 388 565) | "well below the upper limit" | TOLERABLE (workers) | band |
| R2P2 para 128 box: public gas risk, 1 in 1 510 000 | "below the limit of what is often regarded as broadly acceptable" | BROADLY_ACCEPTABLE | band |
| R2P2 App. 3 para 13 margin | a 1 in 100 000 reduction is worth about GBP 10 | 10 | 1e-12 |
| CBA checklist example | 6684, 2072, 512, 15; total 9,283; up to about 93,000 at DF 10 | 6684, 2072, 512.5, 15; 9283.5; 92,835 | GBP 1; 1% |
| Bevi art. 13(1)(b) against PB Figure 6.8 | 1e-5, 1e-7, 1e-9 | 1e-3 / N^2 | 1e-12 |

The published constants are gated as literals: PB Table 5.3 (0.93, 0.99),
35 kW/m2, 0.3 and 0.1 barg, 20 s, the 0.6 / 0.4 split, the R2P2 thresholds,
and the VPF figures.

ORACLE-DERIVED (everything else):
- 4 event trees plus 2 builder cases, with route B in exact rationals;
- 12 Table 4.5 band-edge cells (my closed-band reading);
- 2 LSIR cases, each with a Monte Carlo sanity check;
- 2 IRPA, 1 PLL and 2 FAR cases;
- 6 F-N curves (mixed, compliant, all N = 0, the R2P2 touch, the R2P2
  exceedance, touching a line);
- 6 criterion comparisons;
- 10 ALARP boundary cases;
- 4 CBA cases (the 2003 rates, the R2P2 6 / 4 percent, a grossly
  disproportionate measure, cost exactly DF x benefit);
- 13 PB fraction cases (the rules applied; the PB prints no numeric example);
- 1 chlorine grid point, where the 30 minute cap applies;
- 2 thermal transects, 2 pool fire transects (still air, and wind with
  overhang), and 1 LSIR transect with contours;
- 54 refusals, each checked by field name (8 of them the fail-opens of
  section 9).

## 4. Errata and inconsistencies found in the sources

1. **PB Appendix 6.B step 4** says "Calculation of the probability of death,
   Pd, at the point (100, 200)". The grid point is (200, 300) everywhere
   else.
2. **PB Appendix 6.B uses R = 361 m.** sqrt(200^2 + 300^2) = 360.555. The
   golden uses 361, as printed.
3. **PB Appendix 6.B is internally rounded.**
   - The full chain gives Pd = 0.3803. Rounded to three decimals that is
     0.380, not the printed 0.381.
   - The printed 0.381 follows only from the rounded ECW of 86.2. From there
     the steps give Pci = 0.45604 and then Pd = 0.835 x 0.456.
   - Both routes are gated: stepwise from the printed values, and as a chain.
4. **PB eqs. 6.11 and 6.12** print "Pd × Pcl × Pci" and "Fd × Fcl × Pci".
   The first × stands for "=".
5. **PB 6.2.3 contradicts itself.** Its introduction says "the cumulative
   frequency of having more than N deaths". Eq. 6.6 and section 6.3 say
   "N_S,M,phi,i is greater than or equal to N" and "N or more". The engine
   follows the equation.
6. **PB 5.2.3 note 4 does not cover 35 kW/m2 exactly.** The text gives
   FE,in = 1 "if the heat radiation exceeds 35 kW m-2" and 0 "if ... less
   than 35", so exactly 35 is undefined. Figure 5.4 prints "Q >= 35 kW/m2".
   The engine follows the figure, and a 35 000 W/m2 case is gated.
7. **PB Figure 6.8 is numbered twice**: the IR contour figure and the FN
   figure carry the same number.
8. **The CBA checklist table prints GBP "207,2000"** for a permanently
   incapacitating injury. Its own worked example uses 207,200.
9. **The CBA checklist example rounds.** The serious-injury line is
   100 x 20,500 x 1e-5 x 25 = 512.5 and is printed 512. The total is 9,283.5
   and is printed 9,283. The limit is printed "GBP 93,000 (GBP 9300 x 10)"
   against a computed 92,835.
   - Consequence: at exactly the printed GBP 93,000 the measure is, by 165,
     GROSSLY_DISPROPORTIONATE.
   - The golden records this verdict. It is an artefact of the rounding, and
     the checklist meant "in the region of".
10. **Two HSE discounting conventions** (section 2, item 5).

## 5. Judgement calls

- **Boundary convention: a threshold value belongs to the lower band.** An
  individual risk exactly at 1e-3 is TOLERABLE, exactly at 1e-6 is
  BROADLY_ACCEPTABLE, a cost exactly DF x benefit is NOT grossly
  disproportionate, and an F-N curve exactly on the line TOUCHES it but does
  not exceed it. This is how every source read words it:
  - R2P2 para 136: "more than one in five thousand";
  - Bevi: "ten hoogste" (at most);
  - the checklist: "costs / benefits > DF".

  The PB Figure 6.8 caption, "F < 1e-3 N^-2", reads the other way at
  equality. The result states which boundary was touched (`atBoundary`,
  `AT_LINE`, `TOUCHES`).

  R2P2's App. 3 para 20 "bias on the side of health and safety" argues for
  the opposite convention. I chose to follow the wording of the thresholds.
  The owner may want to flip it, and each flip is one line, gated by
  negative controls 4 and 5.
- **BOUNDARY_SNAP = 1e-9 relative.** A computed value within 1e-9 of a
  threshold counts as equal to it. Without the snap, 1e-4 x 10 =
  0.0010000000000000002 would be UNACCEPTABLE. The same rule is used in lopa.js.
- **BRANCH_SUM_TOLERANCE = 1e-9 absolute.** 0.7 + 0.2 + 0.1 =
  0.9999999999999999 must pass, and 0.4000001 must not.
- **Evaluating F-N exceedance at the corners is exact, not an
  approximation.** F(N) = sum f over N_i >= N is constant on each step
  (N_(k-1), N_k], and a line C / N^alpha falls with N. So the largest ratio F /
  line on a step is at N_k, which the curve attains. When nMax is finite and
  falls inside a step, nMax is evaluated too.
  - Route B, a 200 001-point log grid, never exceeds the corner maximum and
    comes within 1e-3 of it.
  - For each exceeding step the engine reports the N range where F is above
    the line: from max(N_(k-1), (C/F)^(1/alpha), nMin) to N_k.
- **N need not be a whole number** (PB 6.3: "not necessarily a whole
  number"). Scenarios with N = 0 are kept out of the curve, and their
  frequency is reported.
- **Exposure caps are applied, not refused.** The PB caps exposure at 20 s
  for fires and 30 min for toxic clouds. Each result states the time
  actually used.
- **PB Table 4.5 band edges.** The printed middle band is "10 - 100 kg/s"
  (and "1000 - 10,000 kg"), which I read as closed at both ends. Those cells
  are labelled ORACLE-DERIVED.
- **The flame envelope of a pool fire transect.** A point at or inside
  D/2, or under the overhang of a tilted flame (where the H4 view factor
  refuses), takes P = 1 from PB Figure 5.4 ("in flame envelope"). Counting
  the overhang as inside the envelope is my reading.
- **Toxic PI.** The engine integrates by composite Simpson on 4000 intervals
  of its OWN plume and probit, out to the 1 percent half width, which it
  finds by bisection on the probit. It agrees with the oracle's scipy quad
  of the analytic probit to better than 1e-6 relative; the observed
  difference is about 1e-8. A Pci above 1 is kept with a warning, as PB
  Appendix 6.A argues.
- **Contour crossings** are interpolated linearly in log10(IR) between
  bracketing transect points. Where one side is 0 the interpolation is
  linear in IR. This is a single rule, which the SHARED control confirms.
- **Cost-benefit timing** is year end. Capital is spent at t = 0, and the
  annual cost and benefit fall at t = 1..n. `lifetimeYears` must be a whole
  number. CPF (ICAF) = PV cost / (delta PLL x n), where n counts the
  fatalities prevented undiscounted (R2P2 App. 3 para 15).
- **IRPA occupancy.** A location's occupancy above 1 is refused, and so is a
  sum above 1 across locations. Hours convert at 8760 per year (lopa.js
  HOURS_PER_YEAR). The sum refusal names the field the caller typed
  (2026-09-21, from the H1 course build): all fractions gives "the
  occupancy fractions sum to ...", all hours gives "the hoursPerYr values
  sum to N hours, more than the 8760 hours in a year", and a mix names both.
  It used to speak of occupancy fractions to a caller who had given hours.
  Message only; the threshold and every IRPA are unchanged.

## 6. Dropped scope, and why

| item | why |
|---|---|
| an aversion-weighted risk integral, sum f N^alpha | no source read defines it |
| an R2P2 F-N line (a slope through the point) | R2P2 gives one point and defers to its ref. 32, which was not read; a caller line serves instead |
| a full grid and wind-rose QRA | the caller supplies scenario frequencies (fS PM Pphi Pi) and Pd; `toxicPlumeGridPointRisk` does one LOC, weather class and sector, as PB 6.2.5 does |
| PB delayed ignition over time (App. 4.A, P = Ppresent (1 - e^-wt)) and BLEVE probabilities (0.7, 1.0) as tree presets | readable, but no worked example; the delayed ignition probability is an input to the builder |
| HSE or CCPS F-N worked examples | none available (section 1) |
| the Bkl (Omgevingswet) values that succeeded Bevi | not read |
| injury and ill-health valuation tables | the checklist values are 2003 and table-bound; they are inputs through `otherHarms` |

## 7. Oracle routes and tolerances

| quantity | route A | route B | tolerance |
|---|---|---|---|
| event tree | float product along each path | exact `Fraction` of the decimal inputs; the outcome frequencies must sum to f0 | 1e-12 relative |
| F-N curve | brute force at each corner | brute force on a grid of N; the area under F equals sum f N | 1e-12 |
| F-N against a line | corners | the sup of F / line on a 200 001-point log grid | the grid never exceeds the corner maximum and comes within 1e-3 of it |
| LSIR | sum of f Pd | Monte Carlo, 2e6 samples, seed 20260919, within 4 standard errors (a sanity check, not a golden) | 1e-12 |
| toxic grid point | scipy quad of the analytic probit Y0 - b n y^2 / (2 sy^2) to the analytic half width | the engine's Simpson over its own H4 plume | 1e-6 (observed about 1e-8) |
| discounting | explicit year-by-year sum | the closed-form growing annuity | 1e-12 and 1e-11 |
| pool fire transect | the H4 oracle's Thomas, Raj and Mudan, SEP from YB 6.19, then Eisenberg | none here (the H4 oracle has route B for the view factor) | 1e-10 for flux; 2e-7 for probability (the A&S erf) |
| ALARP, the CBA test, PB fractions, Table 4.5 | single rules | the boundary cases | exact |

## 8. Negative controls (negcontrol_qra.sh)

Run 2026-09-19, and re-run in full on 2026-09-20 after the fail-open fixes
(section 9) with 15 rows added. The baseline is 171 passed. Each row plants
one defect, runs the suite and restores the files. At the end the golden, the
engine and the suite were all restored byte-identical, the oracle regenerated
the golden byte-identical (it is seeded), and the suite passed 171 again.

57 rows: 53 RED, 4 GREEN, 0 unexplained. Every GREEN is expected and named
below.

| kind | plant | result |
|---|---|---|
| ENGINE | F-N non-cumulative (each N carries only its own frequency) | RED, 11 failed |
| ENGINE | IRPA: occupancy ignored | RED, 2 |
| ENGINE | PLL uses f / N | RED, 1 |
| ENGINE | ALARP upper boundary flipped (exactly 1e-3 counted unacceptable) | RED, 3 |
| ENGINE | ALARP lower boundary flipped (exactly 1e-6 counted tolerable) | RED, 2 |
| ENGINE | CBA: DF applied to the benefit side twice | RED, 2 |
| ENGINE | event tree: branch sum not checked | RED, 4 |
| ENGINE | FAR base 1e6 instead of 1e8 | RED, 3 |
| ENGINE | F-N criterion lookup uses N > instead of N >= | RED, 1 |
| ENGINE | boundary snap removed | RED, 2 |
| ENGINE | occupancy sum above 1 not refused | RED, 1 |
| ENGINE | event tree leaf frequency without f0 | RED, 6 |
| ENGINE | PB vapour cloud split swapped | RED, 2 |
| ENGINE | PB Table 4.5 middle band open at the top | RED, 4 |
| ENGINE | IRPA hours over 8766 | RED, 1 |
| ENGINE | toxic Pci without the number of sectors | RED, 3 |
| ENGINE | toxic ECW = PI x Pcl | RED, 3 |
| ENGINE | toxic 30 minute cap removed | RED, 1 |
| ENGINE | fire 20 s cap removed | RED, 2 |
| ENGINE | fire Q > 35 instead of >= | RED, 1 |
| ENGINE | fire clothing factor 0.14 dropped | RED, 2 |
| ENGINE | toxic indoor factor 0.1 dropped | RED, 2 |
| ENGINE | explosion > 0.3 barg read as >= | RED, 1 |
| ENGINE | CBA benefits discounted at the cost rate | RED, 2 |
| ENGINE | CBA benefit uprating ignored | RED, 1 |
| ENGINE | CBA benefits discounted from year 0 | RED, 3 |
| ENGINE | contour interpolation linear, not log | RED, 1 |
| ENGINE | flame envelope P = 0 instead of 1 | RED, 2 |
| ORACLE | F-N brute force N > | RED, 10 |
| ORACLE | toxic Pci pi R instead of 2 pi R | RED, 2 |
| ORACLE | discounting from t - 1 | RED, 2 |
| ORACLE | thermal dose I instead of I^(4/3) | RED, 4 |
| ORACLE | FAR base 1e6 | RED, 1 |
| ORACLE | contour interpolation linear | RED, 1 |
| SHARED | Pci with pi R in both (caught by PB App. 6.B) | RED, 1 |
| SHARED | ECW = PI x Pcl in both (caught by PB App. 6.B) | RED, 1 |
| SHARED | F-N N > in both (caught by the engine's own fnCurve and the R2P2 touch case) | RED, 9 |
| SHARED | DF twice in both (caught by the checklist's 93,000) | RED, 2 |
| SHARED | FAR base 1e6 in both (caught by the bit-for-bit safetyStats check) | RED, 2 |
| SHARED | VROM C 1e-3 -> 1e-2 in both (caught by the Bevi art. 13 points) | RED, 1 |
| SHARED | clothing factor 0.14 -> 1 in both (single transcription) | GREEN (not caught) |
| SHARED | contour interpolation linear in both (single rule) | GREEN (not caught) |
| ENGINE | fail-open: `ownPreset` reverted to a prototype-walking truthiness test (all four presets at once) | RED, 8 |
| ENGINE | fail-open: ALARP preset unchecked ('constructor' returned BROADLY_ACCEPTABLE) | RED, 3 |
| ENGINE | fail-open: F-N criterion preset unchecked ('valueOf' returned BELOW, i.e. compliant) | RED, 3 |
| ENGINE | fail-open: PB Table 4.5 substance unchecked (a result with no probability) | RED, 3 |
| ENGINE | fail-open: PB Table 5.3 period unchecked ('toString' gave a NaN Fd) | RED, 3 |
| ENGINE | fail-open: event tree totals back on an object literal | RED, 4 |
| TOL | LSIR out by 1e-9 relative, at the shipped RTOL of 1e-12 | RED, 2 |
| TOL | the SAME 1e-9 perturbation, with the suite RTOL loosened to 1e-6 | GREEN (by design) |
| TOL | toxic PI out by 1e-5 relative, at the route tolerance of 1e-6 | RED, 2 |
| TOL | the SAME 1e-5 perturbation, with BOTH toxic tolerances loosened to 1e-3 | GREEN (by design) |
| TOL | CBA present value out by 1e-3 relative, against the checklist's GBP 1 | RED, 7 |
| TOL | the SAME 1e-3 perturbation, with the checklist tolerance loosened to GBP 1000 | RED, 7 (see below) |
| TOL | PB App. 6.B contribution out by 1 percent, against 2 printed significant figures | RED, 3 |
| TOL | branch-sum tolerance loosened from 1e-9 to 1e-3 | RED, 1 |
| TOL | boundary snap loosened from 1e-9 to 1e-2 | RED, 4 |

- All 34 ENGINE plants and all 6 ORACLE plants go red, including the 6 that
  revert a fail-open fix from section 9.
- Six SHARED plants are caught by a published value or a second route.
- **The two SHARED GREEN rows are the honest limit**, unchanged. Only my
  transcription stands behind the PB fraction factors (0.1, 0.14, 0.025,
  Table 5.3), because the PB prints no numeric example for them. The contour
  interpolation is a presentation rule that I chose.

**On the TOLERANCE rows.** A logic flip is easy to catch; a tolerance that is
simply too slack catches nothing and looks identical to a passing gate. These
rows are therefore in pairs: a small perturbation, then the SAME perturbation
with the tolerance that should have caught it loosened. Two pairs behave as
designed, which is what shows those numbers are load-bearing rather than
decorative.

The CBA pair does NOT, and that is the more interesting result. Loosening the
published checklist tolerance from GBP 1 to GBP 1000 still leaves the plant
red, because **seven independent assertions cover that present value**: the
checklist worked example, the R2P2 footnote at 1e-12, the DF boundary
verdict, three route-B closed-form annuity comparisons at 1e-11, and the
identity against `cashflow.ts` `npv`, which is an exact `toBe` with no
tolerance to loosen at all. No single tolerance is load-bearing there because
no single tolerance stands alone.

One honest note on how that row was arrived at: the first version of the
toxic pair loosened only one of the two places the suite spends the 1e-6
tolerance, and the other one caught the plant. The row was widened to cover
both, and it then went GREEN as designed. The mismatch was in my plant, not
in the gate.

## 9. Fail-opens found and closed

Hunted for deliberately on 2026-09-20, after the engine was already written
and passing 156 tests. Every one of these was found by probing the engine
with inputs it was never given in the goldens, not by reading the code.

**All six are the same defect.** A preset is looked up as `table[key]`, which
walks the prototype chain. `'constructor'`, `'toString'`, `'valueOf'`,
`'hasOwnProperty'` and `'__proto__'` are therefore "found" in every object
literal, and the truthy function they return walks straight through a
`if (!row) return refuse(...)` guard. The engine then reads undefined
coefficients off a function and, because `NaN` comparisons are all false,
falls through to the SAFE side of every threshold. A typo in a preset name
is enough.

| # | call | what it returned before | what it returns now |
|---|---|---|---|
| 1 | `alarpBand({ individualRiskPerYr: 1e-2, thresholds: 'constructor' })` | `band: 'BROADLY_ACCEPTABLE'`, `alarpDemonstrationRequired: false`, `thresholds: {}` in the basis. A risk of 1 in 100 per year, ten times the R2P2 worker limit, declared broadly acceptable with no ALARP demonstration required. | refuses `thresholds` |
| 2 | `fnCriterionComparison({ ..., criterion: 'valueOf' })` | `state: 'BELOW'`, `maxRatio: 0`, `checks: []`, `criterion: {}`. A societal risk curve declared compliant against a criterion that does not exist. | refuses `criterion` |
| 3 | `pbDirectIgnitionProbability({ ..., substance: 'constructor' })` | `{ band: 'medium', basis: {...} }` with **no `probability` field at all**. A caller reading `.probability` gets `undefined`, and `undefined * frequency` is `NaN`. | refuses `substance` |
| 4 | `pbFatalityFractions({ effect: 'toxic', probabilityOfDeath: 0.5, period: 'toString' })` | `fractionIndoors` set to a function and `fractionOfDeaths: NaN`, with a `basis` that still cites PB Table 5.3. | refuses `period` |
| 5 | `eventTree(...)` with a branch named `constructor` | `outcomeTotalsPerYr.constructor` was the **string** `"function Object() { [native code] }0.5"`: the frequency concatenated onto the inherited constructor instead of being added to it. | a plain numeric key |
| 6 | `eventTree(...)` with a branch named `__proto__` | the outcome was **silently missing** from `outcomeTotalsPerYr`. Its frequency vanished, and the totals no longer summed to f0, with no refusal and no warning. | a plain numeric key |

Closed by one helper and one accumulator:

- `ownPreset(table, key)` is `Object.prototype.hasOwnProperty.call`, and every
  preset lookup in the file goes through it: `TOLERABILITY_PRESETS`,
  `FN_CRITERIA`, `PB_DIRECT_IGNITION_STATIONARY` and `PB_FRACTION_INDOORS`.
  The `period in PB_FRACTION_INDOORS` test had the same hole (`in` also walks
  the chain) and went the same way.
- `eventTree` accumulates into a `Map` and returns `Object.fromEntries`,
  which defines own properties, so no outcome name can reach the prototype.

Gated by 8 new refusal cases in the golden (54 refusals, up from 46) and a
4-case parameterised test on event tree outcome names. Six new ENGINE rows in
the battery revert each fix and all six go red (section 8).

**The same pattern is live in a MERGED engine, and is NOT fixed here.**
`engines/hse/exposure.js` (H2) has two exploitable copies:

- line 128, `NOISE_CRITERIA[criterion]` behind `if (!preset)`;
- line 361, `NIOSH_NRR_DERATING[protectorType]` behind
  `if (factor === undefined)`, after which `factor * nrrDb` is `NaN` and
  `Math.max(0, NaN)` is `NaN`.

Two more lookups are safe only by accident, because a later check catches the
undefined field: `consequence.js` line 597 `POOL_FIRE_FUELS[fuel]` (saved by
`!positive(mInf)`) and line 363 `BRIGGS_RURAL[cls]` (the class is validated
against a list first). This is for the lead: it is a change to merged H2 and
H4 engines with their own goldens, so it belongs in its own pull request, not
in H5.

## 10. What this engine does not re-grade

H5 consumes consequence results. It does not recompute them.

- The live NextGen courses **FC1 and FC5** grade point-source flare and pool
  radiation and setbacks, in `engines/facilities/relief.js`
  (`radiationIntensity`, `distanceForIntensity`, `RADIATION_LEVELS`) and
  `engines/facilities/spacing.js` (`flareSetbackM`, `poolFireSetbackM`).
- **H4** (`engines/hse/consequence.js`) owns the source terms, the Gaussian
  plume, the solid flame and every probit.

`qra.js` exports none of those names, and a test asserts it. Two further
tests assert that the transects ARE the H4 functions bit for bit
(`thermalFatalityTransect` against `thermalProbit`, `poolFireFatalityTransect`
against `poolFireSolidFlame`), so the reuse claim is gated rather than
asserted in a comment. The FAR base is likewise checked bit for bit against
`safetyStats.fatalAccidentRate`.

What H5 adds on top of H4 is the risk bookkeeping H4 has no view of: event
tree frequencies, the summation of f x Pd into an individual risk, occupancy,
PLL, the F-N curve, the criterion comparison, ALARP banding and the
cost-benefit test.

## 11. Doubts, for the owner

1. **Which way a boundary falls** (section 5). Every source read supports
   "at the threshold is not above it", but R2P2's bias to safety could argue
   the other way, and the PB caption uses "<".
2. **Bevi is repealed.** The `vrom-establishments` preset is historical. Its
   Omgevingswet successor was not read.
3. **An `.ts` import from a `.js` engine is new in this repo.** `qra.js`
   imports `npv` from `economics/cashflow.ts`. Jest (babel preset-typescript)
   handles it, and the Suite already consumes cashflow.ts via a shim. Any
   consumer bundler that does not handle `.ts` would need a check. The
   alternative, restating `npv`, is forbidden by the conventions.
4. **The HSE harm values are 2003 figures.** None is embedded as a default.
   Current HSE figures were not found on a live page.
5. **The PB App. 6.B concentration uses printed sigmas** (28.8, 10.3 m). The
   PB derives them from its own u* model, which is not implemented, so the
   golden takes them as printed. The same holds in H4.
6. **The pool fire transect probabilities rest on H4.** A transect is only as
   good as the solid flame model, which carries the H4 doubts: single-route
   SEP forms, and Bagster refused outside its band, so the transmissivity
   along a transect must be fixed.
