# FINDINGS: flare gas to value, LPG and CNG (MD4-0, 2026-09-19)

The fourth validation wave of MD-0, before the NextGen course MD4 Flare Gas
to Value & LPG/CNG (`gasvalue`). It covers `engines/downstream/flareToValue.js`
and `engines/downstream/lpgCng.js` at engines main `13f0936`, and the LIVE
Suite layer (`FlareToValueContext`, `LpgCngContext` and their panels).

**Nineteen findings: eighteen repaired, one constant tightened; four items
HELD.** Four are wrong on screen at the page defaults: C1, V1, Y1, B1.
Fail open (a number where there should be a refusal or no number): C1, V1,
Y1, B1, A1, A2, K1, K2, K3, L2, L3, L4, L5, L6, L7, L9.

## C1. AT DEFAULTS: the cascade counted only the gas above the vehicle's target

`cascadeFills` took a bank's deliverable gas to be what it held ABOVE THE
VEHICLE TARGET. That is not a cascade. A cascade's low bank exists to be
drawn below the target: the vehicle equalises with it first, reaching the
bank's own pressure, and the mid and high banks take it the rest of the way.
Under the old model a bank below the target could never deliver anything,
which contradicted the engine's own header ("a bank can only push gas into a
vehicle while its pressure EXCEEDS the vehicle's").

At the LPG & CNG Rollout Studio's defaults (three 1.5 m3 banks at 250 bar,
a 0.08 m3 vehicle from 20 to 200 bar, gas SG 0.6, 15 C):

| | fills before recharge | cascade efficiency | left in the banks |
|---|---|---|---|
| main | 10 | 13.9 percent | 849 kg "stranded below target" |
| repaired, and the oracle | **33** | **45.8 percent** | 542.7 kg (Low 63.0, Mid 127.0, High 200.2 bar) |

The engine now equalises each vehicle bank by bank (lowest first, the common
pressure found on the conserved mass), stops at the first vehicle it cannot
bring to its target, reports how far that vehicle would get (195.6 bar at
the defaults) and conserves the gas exactly: stored = delivered + left in the
banks. `strandedBelowTargetKg` and `partialFillAvailableKg` are replaced by
`leftInBanksKg` and `nextVehicleReachesBar`, because the quantities they
named do not exist in a real cascade. Both engine and oracle are
ISOTHERMAL: the heat of a fast fill is not modelled, so the count is a
ceiling in that one respect, and the note says so.

## The gate

| file | what it is |
|---|---|
| `oracle_flaretovalue.py` | the gas in EXACT RATIONALS carried in kg and m3 (the engine works in lb and gal); molar masses rebuilt from IUPAC atomic weights; 379.49 scf/lbmol DERIVED from the CODATA gas constant (379.484, inside 5e-5); the flare by 40 CFR 98.233(n) by moles, CROSS-CHECKED by the rule's own volumetric route (W-36, 0.0526 and 0.0192 kg/ft3) to its printed precision; route, credit and comparison ledgers; 5 gases, 3 gas refusals, 3 flares, 4 routes, 4 credit cases, the first of each the Suite default |
| `oracle_lpgcng.py` | DAK by BISECTION on reduced density (the engine uses Newton) with HALL-YARBOROUGH as a plausibility check (agrees to 0.4 percent at every storage state used); the cascade as a MASS LEDGER solved by false position (the engine bisects), with conservation asserted; Erlang C by the exact factorial form in rationals on the floored positions; ledgers for the blend, both storage bases, the vaporizer, the floats and the conversion |
| `__tests__/downstream.gasvalue.golden.test.js` | 90 assertions, every one calls the engine |
| `negcontrol_md4.sh` | main's engines turn the gate red; 31 planted defects, 31 caught |

The battery's first run had THREE survivors, each a missing or blunt
assertion rather than a weak repair: the "missing liquid density" plant
removed the refusal but JavaScript's division by null made Infinity, which
rounded to null anyway, so the plant now restores the old partial sum
itself; the credit case's tested prices had only one price above the
breakeven, so "first in the order typed" and "lowest" agreed, and the case
now tests 60, 5, 15, 45, 30; and the blank-fraction refusal was matched on a
word that a second, later refusal also used, so it is matched on its own
sentence now. All three are caught.

## Flare Gas to Value

**Y1. AT DEFAULTS: the LPG route yielded 3.6 times the propane-plus in the
gas.** The page's LPG and condensate route defaulted to 0.02 t/Mscf. The
default gas holds 0.00558 t of propane and heavier per Mscf (5.58 kg, from
the composition). The route's margin, value per Mscf and place in the bid
table all rested on liquids that are not there. `characteriseGas` now
reports `kgPerMscf` and `c3PlusKgPerMscf`, every route template carries a
`yieldBasis` (CNG and mini LNG on gas mass, LPG on propane and heavier, gas
to power on the heating value in MWh), and `routeEconomics` refuses a yield
above the ceiling, naming both. A zero or negative yield is refused too. The
Suite default becomes 0.0045 t/Mscf (80 percent of the ceiling; decision
D3).

**B1. AT DEFAULTS: a route nobody had screened was crowned "best on value".**
The page opens with every requirement limit unset, so every route is "not
fully screened", and `compareRoutes` still drew its best from them: the
table printed "best on value" in green against CNG. The best is now drawn
only from routes that PASS; the leader among routes not fully screened is
returned apart as `leaderNotFullyScreened`, and the ranking note says no
route passes yet.

**A1. The flare's methane was every unburned carbon, and the gas's CO2 was
burned.** Main computed CO2 = eta x (all carbon) and CH4 = (1 - eta) x (all
carbon) as methane. 40 CFR 98.233(n) defines the flare by the METHANE mole
fraction for CH4 and passes the gas's CO2 through unburned: CH4 = V X_CH4
(1 - eta_D), CO2 = V X_CO2 + V eta_C sum(Y_j R_j). At the page's gas (78
percent methane, 1.30 carbon per mole, 2 percent CO2), 10 MMscfd, 350 days,
98 percent destruction, GWP 29.8:

| | CO2 t/yr | CH4 t/yr | CO2e t/yr | methane share |
|---|---|---|---|---|
| main | 234,554.8 | 1,745.0 | 286,555.5 | 18.1 percent |
| repaired | 234,628.5 | **1,047.0** | **265,828.9** | 11.7 percent |

The methane was 67 percent high. Unburned ethane and heavier are not
methane and carry no GWP here, and the result says so in `basis`. The rule
separates the COMBUSTION efficiency (sets the CO2) from the DESTRUCTION
efficiency (sets the CH4); the engine takes an optional
`flareCombustionEfficiency` and, without one, uses the destruction
efficiency and names it (`combustionEfficiencyNote`; decision D1).

**A2. The whole flare was credited to a plant that recovers part of it.**
Gas the plant does not recover is still flared, but the abatement took the
whole flare as avoided. With the default CNG recovery of 0.9 and a declared
counterfactual (product 150,000, displaced 180,000 t/yr), main gave 316,555
t/yr; repaired, 0.9 x 265,828.9 - 150,000 + 180,000 = **269,246 t/yr**.
`abatement` takes `recoveryFraction` and gives no abatement without one in
(0, 1], saying why (`blockedBy`).

**K1. The credit price "needed" was the first tested price that cleared, in
the order typed.** Prices typed 60, 15, 30 reported 60. It is now the
breakeven in closed form, (hurdle - margin) / tonnes, with the lowest tested
clearing price beside it.

**K2. A project that adds emissions sold negative credits,** a cost that
grew with the credit price. Refused: there is nothing to issue.

**K3. No margin for the route read as "does not clear the hurdle at any
credit price tested".** It is unknown, and now says so. A blank hurdle read
as 0; blank is now missing (omitted keeps the stated 0).

**E1. Blank operating costs were 0 without a word.** They are still taken as
zero and named in `assumedZero`, the MD3 rule. A blank on-stream figure read
as 350; blank is missing now, and more than 366 is refused (omitted keeps
350). On the page, the variable operating cost had NO input at all: every
route's economics rested on a hidden number (fixed in the Suite PR).

**G1. A missing liquid density made the liquids content a partial sum,**
and the richness verdict was read from it, while a missing heating value
made the heating value missing. Both are missing now.

**G2. A hydrocarbon typed without a carbon number burned to nothing.** It is
taken from the reference by code, and refused if the code is unknown. A
negative mole fraction is refused. An analysis that does not sum to one is
still scaled, and the result now says so (`normalisationNote`).

## LPG & CNG Rollout Studio

**V1. AT DEFAULTS: the vaporizer's "warm the liquid" term was negative.**
The page passed n-butane's ATMOSPHERIC boiling point (-0.5 C) for a liquid
entering at 25 C, so the first term was 500 x 2.5 x (-0.5 - 25) = -8.85 kW
and the duty came out at 50.3 kW, below the 55.5 kW the boil alone needs. A
liquid above its boiling point is not liquid: the boiling point that matters
is the one at the vaporizer's pressure. The engine refuses a liquid entering
above the boiling point it is given, and a vapour leaving below it. The page
takes the boiling point as an input with no default (the duty is then a
floor, named). The existing test that asserted the negative term was
asserting the defect, and now asserts the refusal.

**L1. The conversion case's efficiency ratio defaulted to 1,** omitted or
blank, while the refusal beside it said "neither is assumed". It is required
when the consumption is derived.

**L2. The bottling queue rounded working positions to the nearest whole
one** (14.55 working ran on 15) and floored at one (0.4 working ran on 1).
It now runs on the positions wholly working, the floor, and refuses fewer
than one.

**L3. A blank lead time or safety stock was 0,** so the reorder point fell to
an empty vessel and every delivery "fitted". Blank is missing now; the
reorder point and the fit are absent and named.

**L4. The fill ratio had no basis.** Codes state the limit two ways: a
liquid-volume ratio (0.85 of the vessel) or a filling density on water
capacity by weight (NFPA 58 style, 0.42). Read as a volume, 0.42 on the
default 100 m3 vessel gives 23.25 t where the filling density means 41.96 t.
`fillRatioBasis` is now explicit (`liquid_volume` or `water_capacity_mass`),
returned, and an unknown basis is refused.

**L5. A cycle stage with no duration was dropped** and the fleet sized on
the rest; emptying "At the customer" cut the cylinder fleet from 66,000 to
10,560 and the page printed it. Refused now, naming the stage.

**L6. Blank boxes took the stated defaults:** gas SG 0.6, temperature 15 C,
shift 8 h, availability 1. Blank is missing now; omitted keeps the stated
default.

**L7. Pressures had no stated basis.** The engine reads bar ABSOLUTE; the
page said "bar". A CNG station's suction is usually quoted gauge: the default
4 bar suction read as 4 bar(a) needs 65.07 kW where 4 bar(g) (5 bar(a)) needs
60.80 kW. Every CNG result now returns `pressureBasis`, and the page labels
bar(a).

**L8. A queue refusal inside dispensing** (2.5 dispensers) came back under
an error-free result. Passed up now; an overloaded forecourt is still an
answer.

**L9. A blank LPG volume fraction** poisoned every blend property to null
under an error-free result. Refused.

**T1. `cngCompression` typed 836.6 scf/kmol.** It is 379.49 / 0.45359237 =
836.62 (2.4e-5). Computed now.

## Checked and sound

`gpmC3Plus` from composition and liquid density (matches the kg and m3
route to 1e-6); the heating value on moles; the capex power law (MD2-0's);
`screenRoute`'s three states; the LPG blend's bases (density on volume,
latent heat on mass, molar mass on moles); real gas mass m = PVM/(ZRT) and
its ideal comparison; the unit bridge into the Facilities compression engine
(its thermodynamics are FC3-0's); Little's law for both floats; the
conversion case's energy equivalence and undiscounted payback.

**Canonical modules rule:** neither engine discounts. `routeEconomics` hands
a year-0 and recurring cash flow on, and `conversionEconomics` reports
undiscounted simple payback only. No NPV or Monte Carlo was found, so none
was routed.

## PINNED, NOT VALIDATED

- The component heating values and liquid densities (GPA 2145 is not in this
  repository; the engine labels them typical and the cases pass them in),
  and the typical LPG densities and latent heats.
- The DAK and Sutton coefficients (the 1975 and 1985 papers are not in this
  repository; they are the package's method spec, as in the production
  oracles). Hall-Yarborough agreeing to 0.4 percent is plausibility, not
  validation.
- The FORM of 40 CFR 98.233(n) equations W-19 and W-20: the equations are
  images on the page reached (law.cornell.edu, 2026-09-19); the form used is
  the one their variable definitions fix. The W-36 densities were read as
  text.
- Water at 15 C, 999.1 kg/m3, for a filling density on water capacity.

## HELD (owner)

- **H1.** Default flare efficiencies. 40 CFR 98.233(n)(1) gives tiered
  defaults (98/96.5, 95/93.5, 92/90.5 destruction/combustion). They are a
  US rule; whether a Nigerian flare study should default to any tier (or to
  the NUPRC flare regulations' basis) is a regulation reading with money on
  it. The engine and page keep both efficiencies as inputs with no default.
- **H2.** The unlit flare fraction (Z_U in the rule): gas sent to an unlit
  flare is vented, all methane. Not modelled; the course must say so.
- **H3.** Filling-density and fill-ratio values by code (NFPA 58, EN or
  NUPRC practice) stay unshipped: the limit is a safety code value.
- **H4.** GWP values and credit prices stay case inputs.

## Decisions taken (owner delegated)

- **D1.** Without a combustion efficiency, the destruction efficiency stands
  in for it, named. Refusing would block every study for a figure most
  operators do not have; the difference is 1.5 points of the hydrocarbon
  CO2 under the rule.
- **D2.** The abatement requires a recovery fraction rather than assuming 1:
  a whole-flare credit is the overstatement the app exists to stop.
- **D3.** The Suite LPG route default becomes 0.0045 t/Mscf, 80 percent of
  what the default gas holds, since a default above the ceiling would be
  refused.
- **D4.** The cascade reports a vehicle that cannot reach target as the
  stop, with the banks as they stood after the last whole fill.
- **D5.** Omitted-from-the-call keeps each stated default; blank ('' or
  null) is missing. This keeps every existing caller's behaviour and closes
  the page's blank boxes, as MD3 did.

## MD45-1 (2026-09-19): found by the NextGen course foundation (`gasvalue`)

The course recon (F-R1 to F-R4) found no wrong number on a graded path; it
found coverage and copy gaps. All repaired, no golden number moved.

- **F-R1. Four oracle ledgers were inline in `main()`.** `oracle_flaretovalue.py`
  now exports `net_abatement()`; `oracle_lpgcng.py` exports `storage()` (both
  fill-ratio bases), `vaporizer()` (the three terms and the margin) and
  `conversion()` (energy equivalence, saving, payback). `main()` calls them
  and both goldens regenerate byte-identical (apart from the constants block
  below), so a course oracle check can call them instead of transcribing.
- **F-R3. Three engine strings broke the owner copy rule** ("X, not Y"):
  `characteriseGas` ghvNote, `lpgBlendProperties` note and the
  `vaporizerDuty` floor note. Reworded: "A heating value missing on any
  component leaves the mixture value missing too. No partial average is
  reported."; "... reported as missing for the blend. It is never averaged
  over the components that have it."; "... It is a floor: the full duty is at
  least this." A sweep of every string literal and template in both engines
  (em dash, en dash, the contrastive) now finds none, and the golden test
  runs that sweep. The course digest quotes the old ghvNote and floor note
  verbatim and must be rebuilt on this engine.
- **F-R4. The flare molar masses and the richness edges were inline.**
  Exported as `FLARE_MOLAR_MASS` ({ CO2: 44.009, CH4: 16.043 }, IUPAC 2024
  built, the carbon engine's MW_CO2 and MW_CH4) and `RICHNESS_GPM`
  ({ rich: 2.5, moderate: 1 } gal C3+/Mscf); `abatement` and
  `characteriseGas` read them. The oracle carries both and the golden test
  checks the engine against them (an all-CO2 and an all-methane flare give
  the molar masses back; a methane-propane sweep crosses both edges).
- **44.009 against the table's 44.010, explained, not changed.**
  `GAS_COMPONENT_REFERENCE` lists CO2 at 44.010 lb/lbmol, the tabulated
  (GPA-style, older atomic weights: 44.0095) value used for the gas's mass
  and liquids, while the flare's tonnes are weighed at FLARE_MOLAR_MASS. The
  two differ by 2.3e-5 relative; changing the table would move the route
  ceilings the course grades against for no physical gain. Stated in the
  engine beside the constant.

Gate: 12 new assertions in `downstream.gasvalue.golden.test.js`;
`negcontrol_md4.sh` part 1 now runs against the pinned pre-repair engines
(5c0cb97 and f0aef14; `origin/main` goes green once a repair merges) and
part 3 plants 8 reversals of these repairs. 39 planted, 39 caught, both
part 1 runs red (three MD4-0 anchors that read the inline 44.009 and
16.043 now read FLARE_MOLAR_MASS).

## Prototype-chain lookups (2026-09-21, repo-wide sweep)

A table read as `TABLE[key]` walks the prototype chain, so `'constructor'`,
`'toString'`, `'valueOf'`, `'hasOwnProperty'` and `'__proto__'` are found in
every object literal. Every such read in this module now checks own
properties only; valid keys behave exactly as before and no golden moved.
Gate: `__tests__/prototypeChainLookups.test.js` (red on the unrepaired code).

- EXPLOITABLE (safe side). `yieldCeiling` with an inherited yield unit returned NaN, so `routeEconomics` never refused a yield above what the gas holds. It now treats the name as any unknown unit. `screenRoute` reads requirement values by own key.
