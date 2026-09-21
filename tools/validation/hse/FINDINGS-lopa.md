# FINDINGS: lopa (oracle_lopa.py, HSE H3)

Engine: `engines/hse/lopa.js`. Golden: `test-data/hse/goldens/lopa_cases.json`
(written by `oracle_lopa.py`, stdlib only, never calls the JavaScript).
Gate: `__tests__/hse.lopa.test.js` (95 tests since 2026-09-21; 91 when the controls below were run); every golden is called
through the engine. Negative controls: `negcontrol_lopa.sh`.

## 1. What was checked against a source, and what the brief had right

| item | source checked | verdict |
|---|---|---|
| Annex B tCE, tGE, tG2E; 1oo1, 1oo2, 2oo2, 2oo3, 1oo3 PFD; beta / betaD placement | Lundteigen & Rausand, "Chapter 8. PFD formulas in IEC 61508" (NTNU RAMS slides for *Reliability of Safety-Critical Systems*, Wiley 2014); 61508 Association, Dolan (2024), "SIL Calculations: Practical Guidance in the use of IEC 61508-6:2010" | both state the same equations; implemented as stated |
| the brief's simplified forms (1oo1 = lDU T/2 [+ lDD MTTR]; 1oo2 = ((1-b) lDU)^2 T^2/3 + b lDU T/2; 2oo3 = ((1-b) lDU)^2 T^2 + b lDU T/2; 2oo2 = lDU T) | derived from the above with lDD = 0, MRT = 0, and independently by integrating the time-dependent unavailability (route B) | **all four correct.** They are exactly Annex B at lDD = 0 and MRT = 0 (the suite gates them as identities) |
| low-demand SIL bands: SIL n is 10^-(n+1) <= PFDavg < 10^-n, or 10^n < RRF <= 10^(n+1) | the IEC 61508-1 Table 2 rows as printed in the 61508 Association slide | the brief's decades are right; the exact-decade convention is the standard's own (section 3) |
| LOPA arithmetic f = IEF x modifiers x product of IPL PFDs, RRF = f / TMEL | CCPS (2001) method | straightforward; the CCPS worked example itself was NOT reproduced (section 5) |

One correction to the brief's framing: "Route 2H" is an IEC 61508-2 route
(7.4.4.3). IEC 61511-1:2016 states its own minimum-HFT requirement in
clause 11.4. Either way the architectural-constraint check is **left out**.
The HFT requirement is a normative table in a licensed standard, and I found
no public primary statement of it to check against. The engine header says
so.

**Choice: the full Annex B form**, not the simplified TR84 one. The
simplified forms are its special case, so one implementation covers both and
the gates cover both. Also, every published worked example I could verify
(Dolan) uses the full form with DD, MTTR and MRT. Optional proof test
coverage (Annex B.3.2.5 as the 61508 Association states it) is included
because it reproduces four more published rows.

## 2. Published goldens (61508 Association worked SIF, Dolan 2024)

The failure rates are the slide's own; it cites SINTEF PDS and vendor
certificates. They are the slide's example values, not data this repo
recommends. T1 = 1 year = 8760 h. The table reproduces ONLY with MRT = MTTR.
The valve row prints 1.05E-03 with MRT = 120 h and would print 1.02E-03 with
MRT = 0. The goldens therefore set MRT = MTTR, as the slide evidently did.

| id | arch | printed | route A (engine) | status |
|---|---|---|---|---|
| dolan-pt-2oo3 | 2oo3 | 2.36E-04 | 2.357644e-04 | PUBLISHED |
| dolan-ai-2oo3 | 2oo3 | 6.97E-07 | 6.966788e-07 | PUBLISHED |
| dolan-cpu-1oo2 | 1oo2 | 5.34E-07 | 5.339537e-07 | PUBLISHED |
| dolan-do-1oo2 | 1oo2 | 6.68E-07 | 6.684590e-07 | PUBLISHED |
| dolan-valve-1oo2 | 1oo2 | 1.05E-03 | 1.048768e-03 | PUBLISHED |
| dolan-sif-total | sum | 1.29E-03, RRF 777 | 1.286431e-03, RRF 777.3 | PUBLISHED |
| dolan-pt-2oo3-beta15 | 2oo3 | 3.44E-04 | 3.440858e-04 | PUBLISHED (beta x 1.5 per Annex D) |
| dolan-valve-1oo2-ptc85 | 1oo2 | 2.71E-03 | 2.713783e-03 | PUBLISHED + INFERRED T2 |
| dolan-pt-2oo3-ptc90 | 2oo3 | 6.76E-04 | 6.760604e-04 | PUBLISHED + INFERRED T2 and beta |
| dolan-cpu-1oo2-ptc98 | 1oo2 | 6.12E-07 | 6.115828e-07 | PUBLISHED + INFERRED T2 |
| dolan-do-1oo2-ptc98 | 1oo2 | 7.76E-07 | 7.764169e-07 | PUBLISHED + INFERRED T2 |

Inferences, listed because the text does not print them:
- **T2 = 10 years** in the PTC table. The slide does not state T2. Ten years
  reproduces all four PTC rows to the printed three figures, which is strong
  evidence but not proof.
- **The PTC transmitter row prints beta 10%, but only 15% reproduces its
  value** (4.74e-4 at 10%, 6.76e-4 at 15%). That table is headed
  "Considering PTC and beta MooN multiplications", so 15% (the x1.5 value)
  is what was computed and the printed 10% is a slip in the source.
- Left out: the A I/P row of the x1.5 table. It prints beta 3% / betaD 2%
  but reproduces only with betaD = 1.5%, which looks like a rounded print.
  Too ambiguous to use.

Gate: the engine, rounded to three significant figures, equals the printed
value, and the engine equals route A to 1e-12 relative.

## 3. Band convention and the decade snap

SIL n holds 10^-(n+1) <= PFDavg < 10^-n. An exact decade belongs to the
higher-PFD (lower-SIL) band:
- PFDavg 1e-2 is SIL 1, and 1e-1 is not SIL rated.
- RRF exactly 100 is SIL 1, and exactly 10 is below SIL 1.
- RRF exactly 1 needs no SIF.
- RRF exactly 1e4 is SIL 3, not beyond it.

The engine snaps any value within 1e-9 relative of a decade onto that decade
(`DECADE_SNAP`). This matters in practice. In IEEE double,
0.1 x 0.1 x 0.1 / 1e-5 is 100.00000000000001, so without the snap an exact
RRF of 100 would be banded SIL 2. The boundary goldens were CHOSEN so that
the double lands just above the decade, and a test asserts this stays true.
The oracle decides every boundary in exact rationals with no snap at all.

The engine reports explicit states, never clipped numbers:
- `NO_SIF_REQUIRED`
- `RISK_REDUCTION_BELOW_SIL1` (1 < RRF <= 10), with the required PFD
- `SIL1` to `SIL3`
- `BEYOND_SIL3_REDESIGN`, with the required PFD intact. `pfdInSil4Band`
  says whether that PFD lies in the SIL 4 band or beyond it.

An achieved PFDavg below 1e-5 is `BELOW_SIL4_TABLE_FLOOR`, and the claim is
limited to SIL 4. A required SIL is always reported together with the
required PFDavg. The golden `sif-just-short` shows why both are needed: a
SIL 2 SIF at 5e-3, against a required 3.33e-3, is in the right band and
still misses the TMEL.

## 4. Route B: where the simplified form departs from the time-dependent result

Route B averages the exact unavailability over the renewal period by
Simpson quadrature. Its model:
- exponential failures;
- DD as a renewal process at lambda MTTR / (1 + lambda MTTR);
- MRT carried into the next interval;
- beta-factor common cause as a separate component;
- koon voting evaluated by binomial.

This is how the simplified equations are derived, not a restatement of them.

**Annex B is never below route B** in any of the 28 PFD cases, and the
suite gates that (engine >= route B). Where it departs, and why:

| source of departure | Annex B | exact (to first order) | effect |
|---|---|---|---|
| linearisation, 1oo1 | lT/2 | lT/2 - (lT)^2/6 | +lT/3 relative |
| linearisation, koon | T^2/3, T^2, T^3/4 | minus O(lT) | up to 1.25 lT relative (2oo3) |
| DD cross terms, 1oo2 (a = lDU T, d = lDD MTTR) | a^2/3 + (5/3) a d + 2 d^2 | a^2/3 + a d + d^2 | equivalent-down-time convention; conservative |
| MRT, 1oo2 (per lambda^2) | T^2/3 + (5/3) T MRT + 2 MRT^2 | T^2/3 + T MRT + MRT^2 | conservative |
| PTC cross term (per lcov lunc) | (2/3) T1 T2 | T1 T2 / 2 + T1^2 / 6 | conservative when T2 >= T1 |
| 2oo2 with common cause | lDU T (no beta) | (2 - beta) lDU T / 2 | conservative by 2 / (2 - beta) |

Measured departures (engine / route B - 1):

| case | departure |
|---|---|
| Dolan rows | +0.05% to +0.48% |
| PTC rows | up to +2.9% (the valve, whose uncovered part runs 10 years) |
| DU-only at lT = 0.0175, 1oo1 | +0.58% |
| DU-only at lT = 0.0175, 1oo2 beta 0 | +1.3% |
| DU-only at lT = 0.0175, 2oo3 beta 0 | +2.2% |
| DU-only at lT = 0.0175, 1oo3 beta 0 | +2.1% |
| DD- and MRT-heavy 1oo2 | +1.75% |
| `1oo2-mrt-ne-mttr` | +1.07% |
| 2oo2 at beta 0 | +1.17% |
| 2oo2 against route B with beta 0.1 | +6.4% (1.752e-2 against 1.646e-2) |
| `1oo1-long-interval` (lT = 0.438) | +15.1% |

The last row is why the engine warns above lT = 0.1 and refuses outright
once the linearised value reaches 1.

**Which goldens carry the rare-event warning (2026-09-21).** Three do, and
a gate (`the rare-event warning fires on exactly the goldens FINDINGS-lopa
section 4 lists`) holds the list to this table:

| golden | product the engine tests | value | route B departure |
|---|---|---|---|
| `1oo1-long-interval` | lDU x T1 | 0.438 | +15.1% |
| `dolan-valve-1oo2-ptc85` | lDU x T2 (PTC 0.85, T2 = 10 y) | 0.184 | +2.9% |
| `1oo3-full-ptc` | lDU x T2 (PTC 0.9, T2 = 10 y) | 0.2628 | +0.69% |

Until this note only the first was documented. The other two warn because,
with PTC < 1, the engine forms the product with the lifetime T2 and the
WHOLE lambdaDU. Only the uncovered share (1 - PTC) lambdaDU actually runs
for T2: that product is 0.0276 for the valve and 0.0263 for the 1oo3 row,
both inside the rare-event range, and route B agrees with Annex B to 2.9%
and 0.69%. On these two rows the warning is conservative: it fires where
the linearisation error is small. The PFDavg values are unaffected (the
warning is text), and the published valve row still reproduces its printed
2.71E-03. Whether the PTC product should use (1 - PTC) lDU T2 + PTC lDU T1
is an owner question (section 7, item 7); changing it would change which
results carry a warning, so it is left as it is.

Tolerances:
- engine vs route A: 1e-12 relative (route A is exact rationals).
- engine vs printed: equal at three significant figures.
- engine vs route B: engine >= route B x (1 - 1e-9) in every case. For
  DU-only rows with MRT = 0 and PTC = 1, also |engine / route B - 1| <=
  1.5 lDU T1. That is the first-order bound derived above; the largest
  coefficient is 1.25, for 2oo3.
- longest proof test interval: 1e-9 relative. The golden
  `maxT-refused-floor` (lambdaDD x MTTR = 2) is a refusal: the floor
  reaches a PFDavg of 1 before any interval is added, and the engine must
  refuse with the field that carries the floor, as pfdAvgSubsystem refuses
  any PFDavg of 1 or more. Until 2026-09-21 the search skipped that
  refusal and returned UNACHIEVABLE with a floor above 1 (or, with
  lambdaDU = 0, INTERVAL_INDEPENDENT with a PFDavg above 1). The oracle
  decides the refusal from the exact floor coefficient; no finite answer
  moved. The oracle solves the exact
  polynomial in T1, by the quadratic formula or, for 1oo3, by bisection on
  the exact cubic. The engine bisects the formula itself.

## 5. What is ORACLE-DERIVED, and what was not reproduced

The CCPS (2001) continuing example (hexane surge tank) was NOT reproduced.
I had no legitimately accessible copy of the book to check its worksheet
numbers against, and secondary summaries disagree on the details. No golden
claims to be that example. The 13 LOPA goldens are ORACLE-DERIVED scenarios
that follow the CCPS method with illustrative numbers. All 18 non-Dolan PFD
goldens use illustrative failure rates, and each case's `source` says so.

## 6. Negative controls (negcontrol_lopa.sh, run 2026-09-19)

Baseline: 91 passed. Each row plants one defect, runs the suite, and
restores. At the end the golden is restored byte-identical and the suite
passes 91 again.

| kind | plant | result |
|---|---|---|
| ENGINE | 1oo1 loses the /2 | RED, 8 failed |
| ENGINE | down time T/(j+1) -> T/j everywhere | RED, 37 failed |
| ENGINE | tGE uses T/2 instead of T/3 | RED, 23 failed |
| ENGINE | (1-beta) dropped from the independent rate | RED, 26 failed |
| ENGINE | 2oo3 multiplicity 6 -> 3 | RED, 9 failed |
| ENGINE | MRT dropped from the DU down time | RED, 19 failed |
| ENGINE | CCF DD term uses MRT instead of MTTR | RED, 1 failed (**GREEN on the first run**, see below) |
| ENGINE | proof test coverage ignored | RED, 5 failed |
| ENGINE | decade snap removed (exact float equality) | RED, 2 failed |
| ENGINE | mis-band: an exact decade goes to the higher SIL | RED, 16 failed |
| ENGINE | f == TMEL demands a SIF (<= read as <) | RED, 2 failed |
| ENGINE | beyond SIL 3 clipped into the band table | RED, 7 failed |
| ENGINE | independence flag ignored | RED, 2 failed |
| ENGINE | duplicate IPL accepted | RED, 1 failed |
| ORACLE | route A down time T/(j+1) -> T/j | RED, 35 failed |
| ORACLE | route B average inflated 2% | RED, 24 failed |
| ORACLE | band: an exact RRF decade put in the higher SIL | RED, 7 failed |
| ORACLE | successive failure rate (n-j) -> (n-j+1) | RED, 33 failed |
| SHARED | the `auditable: false` credit exclusion removed in BOTH | GREEN (expected: specification, not mathematics) |

The first run found two real gaps, both now repaired:
1. **MRT vs MTTR was indistinguishable.** Every golden with DD failures had
   MRT = MTTR, because the Dolan example uses MRT = MTTR. Swapping them in
   the CCF DD term went uncaught. Two goldens with MRT (168 h) different
   from MTTR (8 h) were added (`1oo2-mrt-ne-mttr`, `1oo1-mrt-ne-mttr`).
2. **The oracle's band lookup was an unbounded loop.** A planted oracle
   band defect made it spin forever instead of failing. It is now bounded
   and raises an error when a value falls through the table.

## 7. Doubts, for the owner

1. **T2 = 10 years and the PTC transmitter's beta are inferred** from
   reproduction, not from print (section 2).
2. **Route B's DD and MRT model is my own construction** (steady-state DD
   per channel, MRT carried additively into the next interval). It agrees
   with Annex B to first order where it should, and it sits below Annex B
   where the equivalent-down-time convention is known to be conservative.
   A multiphase Markov model would be a stronger second route for
   DD-dominated redundant subsystems.
3. **The IPL credit rules are specification, not mathematics.** An IPL is
   credited only when `independent` is exactly `true`; `auditable: false`
   withholds credit; duplicate names are refused. No independent route
   validates these choices. The SHARED control shows the auditable rule can
   be removed from both files with the suite still green. The behaviour
   tests pin them as the engine's contract.
4. **The SIF PFD is the series sum of its subsystem PFDs** (Annex
   B.3.2.1), as in the Dolan example. The sum ignores a small overlap term.
5. **Out of scope by design:** the architectural constraint (HFT) check,
   and high-demand / PFH mode (section 1).
6. **DECADE_SNAP = 1e-9 is a chosen tolerance.** An RRF deliberately
   entered as 100.0000001 (1e-9 relative above 100) would be read as
   exactly 100.
7. **The rare-event warning under PTC < 1** uses lambdaDU x T2 for the
   whole lambdaDU (section 4). It over-fires on two PTC goldens. Text only;
   left for an owner decision.

## 8. One band wording (2026-09-21)

`lopaScenario` stated the band in RRF terms ("SIL n: 10^n < RRF <=
10^(n+1)"), `silFromPfdAvg` in PFD terms with the exact-decade rule, and
`pfdAvgSubsystem` in PFD terms without it. They are one rule, and all three
now print the exported `BAND_CONVENTION`, which gives both forms, the
1e-9 snap and the exact-decade rule. Text only: no band decision moved, and
a gate asserts all three carry the same string.
