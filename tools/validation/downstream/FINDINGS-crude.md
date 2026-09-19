# FINDINGS: crude assay, product blending and the LP kernel (MD1-0, 2026-09-19)

The first validation wave of MD-0, taken before the NextGen course MD1 Crude
Assay & Blending is written. It covers `engines/downstream/crudeAssay.js`,
`engines/downstream/productBlending.js` and `lib/lp/simplex.js` at engines
main `5cbdca5`, and the LIVE Suite layer that calls them
(`src/contexts/CrudeAssayContext.jsx`, `src/contexts/BlendOptimizerContext.jsx`
and their components).

These three had three self-consistency jest suites (`downstream.crudeAssay`,
`downstream.productBlending`, `lp.simplex`) and no golden and no oracle. Every one of those tests passed on every defect below. The plan of
record (Suite `docs/scope/NextGen-Remaining-Courses-PLAN.md` section 7) held
MD1 to MD5 on exactly this: identities catch an engine that contradicts
itself, never one that is wrong and consistent.

**Twenty-three findings: nineteen defects repaired, one hardening, three
HELD.** Of the nineteen defects:

- **wrong on screen at the apps' defaults, nothing typed (3):** B1 shadow
  prices, C1 T50 and Watson K, C2 the green stability tick;
- **reachable by typing into a box in the shipped apps (13):** L2, B2, B3,
  B4, B6, C3, C4, C5, C6, C7, C8, C9, C10;
- **fail open, returning an acceptable-looking answer where the input should
  have been refused (9):** L1, B2, B3, B4, C2, C3, C5, C6, C7;
- **kernel defects not yet shown to reach an app (1):** L1, whose reach into
  MD2's Refinery Planning Studio is checked in MD2-0.

## The gate

| file | what it is |
|---|---|
| `oracle_lp.py` | exact rational vertex enumeration; shadow prices as exact one-sided derivatives by re-solve. 181 cases (124 optimal, 44 infeasible, 13 unbounded; 62 optimal cases carry a negative rhs) |
| `oracle_productblending.py` | rows built from physical mass balances, solved by the same enumerator; properties from physical inventories; relief by exact re-solve with the limit moved. 9 cases, the first being the Suite's default pool |
| `oracle_crudeassay.py` | cargoes in barrels and pounds, Refutas inverted by bisection, yields by segment overlap, T50 by bisection, netback as a 100,000 bbl account |
| `__tests__/lp.simplex.golden.test.js` | 677 assertions, every one calls `solveLP` |
| `__tests__/downstream.productBlending.golden.test.js` | 62, every one calls `optimiseBlend` |
| `__tests__/downstream.crudeAssay.golden.test.js` | 38, every one calls the engine |
| `negcontrol_md1.sh` | the gate against main's unrepaired engines (RED), then 24 planted single-line defects (24 caught, 0 survivors) |

The battery's first run had ONE survivor: loosening the phase-one feasibility
threshold from 1e-7 to 0.1 left the gate green, because every infeasible case
missed by a whole unit. Two barely-infeasible cases (short by 0.05 and by
1e-6) were added to the oracle; the plant is now caught.

What the oracles cannot validate, and where it is pinned instead: the API
definition, the Refutas pair 14.534 / 10.975, the Watson form in degrees
Rankine, the CII bands 0.7 / 0.9 and the RVP index exponent 1.25. Each is
typed in the engine and in an oracle alike, so each is pinned against a
literal in a jest gate. Moving any of them is one of the 24 plants.

## The LP kernel

**L1. Phase one could leave an artificial in the basis at level zero, and phase
two then returned points that break the problem's own constraints as
"optimal".** A 100,000 problem fuzz returned 284 such points out of 31,252
optima; in the first, an equality row read -33 against -3. The same defect
made a column with a negative entry in that row look like a ray, and the exact
oracle found a bounded, feasible problem the engine called `unbounded`
(`x + y <= 2` with `y >= 2`, optimum 6). Repaired with the textbook step:
pivot every zero-level artificial out on any real column after phase one
(`driveOutArtificials`). The fuzz now returns 0 violations. A 20,000 problem
fuzz of blend-shaped problems found no instance in the blender, whose volume
row and positive costs keep it off this path; MD2's Refinery Planning Studio
maximises margin and has not been checked yet (MD2-0).

**L2. The shadow price of any row whose right-hand side was negative was
reported with the wrong sign.** `buildTableau` negates such a row to normalise
it and never told `readShadowPrices`. A negative rhs is ordinary here: the
shift to the origin turns a blend specification's 0 into `-A*lo` whenever a
component has a floor. 25 of the first 351 oracle assertions failed on it.
Repaired: the flip is recorded per row and undone on the dual.

**L3. `iterations` was always 0.** Now the real count.

**L4. HELD: the kernel's tolerances are absolute** (`EPS = 1e-9` on pivots,
1e-7 on the phase-one residual). They are right for the barrel-scale problems
the two apps pose and wrong for a problem scaled in millions. Not repaired
without a case that needs it; noted for MD2-0.

## Product Blending Optimizer

**B1. AT DEFAULTS: the shadow prices on screen were not prices.** The panel is
headed "What each constraint is costing" and says "the shadow price of a row:
what one unit of relief on it would save". The engine handed over each spec
ROW's dual, which is per unit of that row's right-hand side: `1/sum(d_i v_i)`
of a ppm, or of an index point for an index spec. At the default pool:

| spec | shown | one unit of relief, re-solved |
|---|---|---|
| Sulfur max | $0.072 | $55.01 per ppm |
| RVP max | $0.267 | $578.91 per psi |

off by factors of about 760 and 2,170, with the sign reversed (the app's
`Math.abs` hid that). Repaired: the envelope theorem gives
`dCost/dLimit = rowDual * sum(d_i v_i) * dIndex/dLimit`, reported as money
saved per unit of the property, positive when relief saves money, with the raw
`rowPrice` kept alongside. The oracle reaches the same numbers by re-solving.

**B2. A typed maximum of zero was an unlimited supply.** `cap > 0 ? cap :
Infinity`. The default pool with butane set to 0 still blended 69 bbl of it.
Now: absent is unlimited, a typed number is that number, zero is none.

**B3. A blank cost was free.** Engine `num(c.cost, 0)` and app `num(c.cost, 0)`
together. Clearing isomerate's cost dropped the recipe from $86,123 to $60,317
by filling its tank. Now refused, naming the component.

**B4. A stream with no density was blended on mass as if it were water.**
`basisWeight` fell back to SG 1, and the sulfur spec came back met and
binding. In the app the path ran through a different invention:
`sg: num(c.sg, num(c.density, 0.8))`. Now the mass spec is skipped with the
reason stated, and the app passes what the user typed.

**B5. HARDENING, not a demonstrated defect: binding was an absolute 1e-7.**
Tight on an octane of 91 and loose relative to nothing on a 35,000 ppm sulfur
limit. Main's engine was run on every golden case and never misjudged a
binding spec (the LP lands within 1e-11 of the limit), so this is not counted
as a finding that reached anyone. It is relative to the limit now
(`BINDING_TOLERANCE`), and pinned.

**B6. A negative availability or a floor above its ceiling** was clamped or
fell through to a generic infeasible. Now refused, naming the component.

## Crude Assay & Blending studio

**C1. AT DEFAULTS: T50 and Watson K.** The app took T50 as the first grid
temperature at or above 50 percent. At the default pair that is 690 F; the
blended curve crosses 50 percent at 617.14 F, so Watson K read 12.00 against
11.75. It is now `temperatureAtVolumePercent` on the engine's curve.

**C2. AT DEFAULTS: a green tick on no evidence.** Without SARA the stability
screen falls back to a gravity-contrast rule of thumb (a 15 degree spread and
a lightest crude above 35 API). Not seeing that combination returned
`stable: true`, drawn as a green tick, at the default pair. The rule can raise
a flag and cannot clear one: it now returns `stable: null` unless flagged.

**C3. A crude with no API passed that screen as stable** (NaN failed both
comparisons). Now `basis: 'none'`, `stable: null`.

**C4. The uncertain CII band came back `stable: false`** beside a message
saying "Uncertain". Now `null`, with `band`.

**C5. A blank sulfur (or TAN, nitrogen, nickel, vanadium) was a zero.** The
file's own header says "a sulfur content nobody supplied is not zero sulfur";
`massProperty` read it as zero anyway whenever another crude had a value.
At the default pair, clearing the medium sour crude's sulfur dropped the
blend from 1.005 to 0.087 wt%, measured on main's engine. Now null, with the crude named in `missing`.

**C6. No gravity, a mixed volume and mass basis, and negative shares** were
dropped, zeroed or clamped. Now refused with a sentence each.

**C7. The distillation curve was clamped flat outside its measured points.**
Flat clamping is extrapolation: a curve ending at 85 percent at 900 F reported
85 percent at 1000 F, so a 900 to 1000 F slice came out empty and its barrels
went to the residue. Now the curve answers outside its range only where it
says so itself (below a first point at 0, above a last point at 100) and a
cut with a bound elsewhere has no yield, named in `unknownCuts`.

**C8. Three copies of the interpolation disagreed.** The engine returned 0
below a curve's first point; the app's blended curve (`CrudeAssayContext`)
and its chart (`BlendResults`) returned that point's value. The blended curve
now lives in the engine (`blendDistillationCurves`) and both call it.

**C9. An inverted cut reported a yield of 0** instead of none.

**C10. Netback took blank costs as zero without saying so and accepted losses
over 100 percent.** Blank costs are still zero, a legitimate question, but
are now named in `assumedZero`; losses outside 0 to 100 are refused.

**C11. `d86ToTbp` dropped a difference it could not convert** and reported
the partial curve with `error: null`. Now listed in `skipped`, and the note
states that the coefficients must be the degrees F form (the Daubert 1994
table that API Procedure 3A1.1 now carries uses F).

**C12. HELD: the Refutas index is blended on mass fraction, which is the classic Refutas
formulation. ASTM D7152 blends on volume.** The engine says so and names its
basis. Which one the course teaches is a course decision, not a defect.

**C13. HELD: Watson K on T50** is a screening basis (the strict one is the mean average
boiling point) and is labelled as such on screen. Unchanged.

## What this wave does not claim

No published assay, blend or specification appears anywhere in this repository,
and none is quoted from memory. Every golden is synthetic and every pool is
labelled illustrative. What the gate proves is that the engines compute
correctly what they say they compute: exactly for the LP, to physical
inventories for the properties, to a re-solve for every sensitivity.
