# FINDINGS: carbon footprint, abatement and energy efficiency (MD5-0, 2026-09-19)

The fifth validation wave of MD-0, before the NextGen course MD5 Carbon &
Energy Efficiency (`carbon`). It covers `engines/downstream/carbonAbatement.js`
and `engines/downstream/energyEfficiency.js` at engines main `13f0936`, and
the LIVE Suite layer (`CarbonAbatementContext`, `EnergyEfficiencyContext` and
their panels).

**Twenty-four findings: twenty-one repaired in the engines (C10 among them,
a convention stated where the course must teach it), three reach only the
Suite pages (fixed in the Suite PR). Four constants PINNED, four items
HELD.** The worst is the one
the page opens with:

## C1. AT DEFAULTS: a blank flare destruction efficiency was 100 percent destruction

The Carbon Studio asks for the flare's destruction efficiency and leaves the
box empty on purpose ("the flare's destruction efficiency IS the answer for a
flare, and it is contested, so it is asked for rather than assumed"). The
page turned the empty box into `null`, and the engine read `null` through
`num(v, 1)` as 1. So the page computed the flare at its best case, with the
box it said was required still empty:

| flare, page defaults (45,000 kmol/yr, 1.4 C/kmol) | CO2 t | CH4 t | tCO2e (AR6 fossil CH4 29.8) |
|---|---|---|---|
| before, box blank | 2,772.567 | 0 | 2,772.567 |
| after, box blank | refused: "A destruction efficiency is required" | | |
| after, 0.98 entered | 2,717.116 | 20.214 | 3,319.498 |

At 98 percent the escaped methane alone is 602 tCO2e, a fifth of the flare.
A blank or null is now missing; an argument LEFT OUT of the call still takes
the stated default of complete combustion (burners), so a caller who means 1
can say so.

## C7. AT DEFAULTS: the curve said the target was met on tonnes that do not exist

The page's default curve claims 9,000 t a year from flare gas recovery
against a flare that (at C1's best case) emitted 2,772.6 t. The engine
flagged the over-claim and then, in the same result, said `meetsTarget: true`
(15,300 t abated against a 30 percent target of 9,999.7 t). Now
`meetsTarget` is `null` while any source is over-claimed, and a new
`targetBasis` says why ("not assessed: claims exceed what a source emits");
where measures only interact it stays a verdict and is labelled an upper
bound.

## C12. AT DEFAULTS: the target and the path were built on a partial inventory

As the page opens, the methane line (no GWP set) and the electricity line (no
factor) are blocked, so the inventory total is combustion and flaring only
(33,332.4 t before C1). The page took 30 percent of THAT as the target and
used it as the path baseline, and when nothing computed it used a baseline of
`0`. The engine now refuses a baseline that is not positive
(`decarbonisationPath`); the Suite page says the target and path rest on a
partial inventory while it is not reportable.

## The gate

| file | what it is |
|---|---|
| `oracle_carbonabatement.py` | combustion by MASS in exact rationals (kg of carbon times the CO2/C and CH4/C mass ratios, molar masses BUILT from the IUPAC conventional atomic weights); the inventory as a LEDGER; the abatement cost LEVELISED from a year-by-year PV ledger, where the engine uses a capital recovery factor; the curve by explicit rank; the path as a year ledger. 4 combustion cases, 6 combustion refusals, the page inventory as it opens and filled on AR6 and AR5, the four page measures, the curve with and without the over-claim, the path with and without an unscheduled measure, 5 abatement refusals |
| `oracle_energyefficiency.py` | a SPECIES LEDGER whose mass balance must close (fuel + air in = flue gas out); excess air by BISECTION on the full flue gas, where the engine solves a closed form; efficiency as a loss ledger and the tuning saving as a DUTY ledger; the steam trap as an ISENTROPIC NOZZLE (throat pressure, density and sound speed), where the engine uses the collapsed choked-flux formula; pinch targets by the LARGEST HEAT DEFICIT above any shifted temperature, with no cascade; a levelised PV ledger for the cost per tonne |
| `__tests__/downstream.carbon.golden.test.js` | 81 assertions, every one calls the engine |
| `negcontrol_md5.sh` | main's engines turn the gate red; 34 planted defects (16 carbon, 18 energy: logic flips, two loosened tolerances, moved constants and defaults, blanks read as 0, 1 or a full year), 34 caught |

The battery's first run had no survivors.

## Carbon: the other findings

**C2. An errored line vanished from the inventory,** which then reported
itself reportable. `emissionLine` without a factor returns an error, and
`buildInventory` filtered errored lines out before counting anything. They
are now blocked lines with their reason, and the error keeps its label.

**C3. A line on any scope but 1 and 2 was dropped from the totals,** and the
inventory stayed reportable (a scope arriving as the text "2" was dropped
too). Text scopes are now read as numbers; any other scope is a blocked line.

**C4. A negative abatement was accepted** and flipped the sign of the cost
per tonne, so a costly measure that ADDS emissions came out as "pays for
itself". Refused.

**C5. A blank capital cost was free.** Read as 0 it moves the measure to the
cheap end of the curve. A blank capital cost is now refused ("Enter 0 if it
needs none"); blank running savings or costs are taken as 0 and NAMED in
`assumedZero`, as `throughputEconomics` does since MD3-1. Omitted from the
call, all three keep the stated 0.

**C6. A blank discount rate was 0** (straight-line annualisation, which
moves capital-heavy measures down the curve), and a rate typed as a
percentage (10 for ten percent) gave a capital recovery factor of about 10.
A measure with capital now needs a rate; a rate must be a fraction in
(-1, 1).

**C8. A measure with no start year or no abatement was silently left out of
the path.** It is now listed in `unscheduledMeasures` with the reason.

**C9. An intensity did not say its inventory was not reportable.** It now
carries `reportable` and `notReportableBecause`.

**C10. The GWP set holds one methane value where AR6 gives two** (fossil
29.8, non-fossil 27.0). GHG Protocol guidance applies the non-fossil value to
combustion methane BECAUSE combustion CO2 is usually estimated as if every
carbon atom oxidised. This engine does not do that: carbon that escapes a
burner or a flare is counted as methane and NOT as CO2, so the oxidation CO2
is counted nowhere else, and the fossil value is the consistent one for
vented, fugitive and unburned fossil methane alike. Stated in a new
`methaneNote` on the set and in the combustion note. No values shipped.

**C11 (Suite). The page gave a source it could not compute an emission of
0,** so every claim against it was an over-claim, and it counted a source's
CO2 but not its methane. Fixed in the Suite PR (CO2e including the methane;
a source that did not compute is left out).

**C13 (Suite). The page read blank capital, savings, cost and rate as 0
before the engine saw them.** Fixed in the Suite PR (the page passes what it
has).

## Energy efficiency: the findings

**E1. The cost per tonne handed to the Carbon Studio set a one-off cost
against ONE year.** `priceSaving` returned (implementation cost less one
year's value) over one year's tonnes, which is the exact error the Carbon
Studio's own `abatementCost` refuses ("Comparing a one-off capital cost
against a recurring saving makes every measure look expensive"). On the
engine test's own case (250,000 to save 12,000 GJ a year at 8 per GJ,
56 kg/GJ, 10 years at 10 percent):

| | cost per tCO2e |
|---|---|
| before | +229.17 (costs money) |
| after, levelised | -82.31 (pays for itself) |

It now calls `carbonAbatement.abatementCost`, needs `lifeYears` and
`discountRate` for any non-zero cost, and says so in `costPerTonneNote`. The
engine test asserted the defect and was updated (said in the test). The
Suite page does not display this figure, so it reached no user; a course
would have taught it.

**E2. A blank target oxygen skipped the safe-floor check.** `excessAirSaving`
compared the target with the floor only when the target was a number; left
blank, a target efficiency computed at 0.5 percent oxygen against a floor of
2 was accepted (13,917.6 GJ a year). The target oxygen is now required.

**E3. A steam trap's boiler was 100 percent efficient by default.**
`steamTrapLoss` read a missing or blank boiler efficiency as 1, while
`condensateReturnValue` beside it refuses without one. At the page's steam
figures that understated a trap's fuel by 15 percent (697.7 against 781.9 GJ
a year at 0.85, with E4's exponent). Fuel and carbon are now absent, with
`fuelNote`, until an efficiency in (0, 1] is given.

**E4. The trap's isentropic exponent defaulted to 1.3,** the SUPERHEATED
value, and the page never exposed it. A trap usually passes saturated steam
(about 1.135 dry). At the page's trap (3 mm, 11 bar a, 5.6 kg/m3, Cd 0.7)
that is 29.500 against 28.100 kg/h per trap, 5.0 percent, 490 t a year over
the page's 40 traps. It is now required, with both values in the refusal.

**E5. A threshold problem reported a pinch at the end of its cascade.** The
engine's own comment said it would not, but it took the first zero of the
cascade, which for a zero hot utility is the top and for a zero cold utility
the bottom. The page's own four streams at a 10 C approach (a threshold
problem, cold utility 0) reported a "pinch" at 30 / 20 C. Only an interior
zero is a pinch now.

**E6. A negative heat capacity flowrate was accepted** and read as its
magnitude. Refused.

**E7. An intensity with a stream missing was compared with the peer.** With
purchased power blank the page's intensity falls from 720 to 640 MJ/t, and
the engine reported the plant 8.6 percent BETTER than a 700 MJ/t peer.
`versusPeer` and `gapMJPerTonne` are now null until every stream is counted,
with `peerNote`. A non-positive peer is not compared either.

**E8. Argon was carried as nitrogen, so the flue gas lost mass.** The dry
flue gas mass put all of air's non-oxygen part at the molar mass of N2
(28.014), where air's own molar mass (28.9647) needs 28.161 for it. On the
page fuel at 3 percent oxygen the flue gas was 310.369 kg per kmol of fuel
against the 311.522 that fuel plus air weighs: a 0.4 percent mass-balance
hole. The engine now carries "atmospheric nitrogen" at the molar mass that
closes air's balance (`ATMOSPHERIC_N2_MOLAR_MASS`, derived from the two air
constants) and splits the flue nitrogen into air and fuel shares. The oracle
closes fuel + air = flue gas exactly; the engine now closes to 1e-6. The
effect on efficiency is small (LHV at 3 percent: 88.8722 to 88.8427) and
exactly the size a four-decimal course would grade. CO2 now uses 44.009
(as `MW_CO2` in the carbon engine) and SO2 64.058 (S 32.06), both from the
same atomic weights.

**E9. A saving, its price and its emission factor could be on different
heating value bases.** A gigajoule on LHV is about ten percent more fuel than
one on HHV, and IPCC default factors are on net calorific value (LHV).
`priceSaving` now takes `energyBasis`, `fuelCostBasis` and
`emissionFactorBasis`, refuses when two declared bases differ, and says when
none is declared.

**E10. Blank hours a year were a full year** in both steam functions. A
blank is now refused; omitted, 8,760 is still the stated default.

**E11 (Suite). The page read a blank boiler efficiency as 1 and blank hours
as 8,760** before the engine saw them, and offered no box for the steam
exponent (E4). Fixed in the Suite PR.

## Canonical modules

No NPV or Monte Carlo is implemented. The abatement cost annualises capital
with a capital recovery factor, which is the closed-form annuity, not an
NPV; the oracle proves it equal to PV(costs) / PV(tonnes) from a year-by-year
ledger for every page measure. E1 routes the energy engine's cost per tonne
through that same `abatementCost` rather than a second formula. DECISION:
keep the capital recovery factor (the standard levelised-cost construction of
a marginal abatement cost curve) rather than route a whole cash flow through
`screening.calculateEconomics`, whose royalty, tax and depreciation have no
meaning for an abatement measure.

## Checked and sound

The atom balance conserves carbon; the scopes sum; the curve orders cheapest
first with no-cost measures last and its steps tile the axis; the capital
recovery factor equals the PV ledger to 1e-7 at every page measure; the
closed-form excess air equals the bisection to 1e-7; the HHV/LHV moisture
treatment is right on each basis; the tuning saving is the ratio of the
efficiencies (1.7488 percent at the page heater, 6 to 3 percent oxygen,
where the percentage-point shortcut says 1.5537); the choked-flux formula
equals the isentropic nozzle; the Problem Table cascade equals the largest
deficit at 10, 20 and 30 C (the page streams at 20 C: 107.5 kW hot, 40 kW
cold, pinch 90 / 70 C); condensate and intensity close as ledgers.

## Constants, and where each was checked

| constant | value | status |
|---|---|---|
| GWP100 | none shipped (a declared input) | VALIDATED as inputs: AR5 CH4 28 / 30 fossil, N2O 265; AR6 CH4 27.0 / 29.8 fossil, N2O 273. Source reached: GHG Protocol, "IPCC Global Warming Potential Values" v2.0, 7 Aug 2024 (from AR6 WG1 ch.7 7.6.1.1 and AR5 WG1 ch.8), 100-year |
| `MW_CO2`, `MW_CH4`, `MW_C` | 44.009, 16.043, 12.011 | VALIDATED: IUPAC conventional atomic weights C 12.011, O 15.999, H 1.008 (CIAAW 2024 table reached; intervals C [12.0096, 12.0116], O [15.99903, 15.99977], H [1.00784, 1.00811]) |
| latent heat of water at 25 C | 2,442 kJ/kg | VALIDATED: CODATA dHf H2O gas -241.826, liquid -285.830 kJ/mol (NIST WebBook reached): 44.004 kJ/mol, 2,442.6 kJ/kg |
| H2 LHV / HHV | 241.8 / 285.8 MJ/kmol | VALIDATED against the same CODATA values |
| CH4 HHV | 890.8 MJ/kmol | within the NIST WebBook range (Pittam and Pilcher 1972: 890.7 +/- 0.4) |
| O2 in dry air, air molar mass | 0.20946, 28.9647 | PINNED NOT VALIDATED against a primary source: reached only Engineering ToolBox, which gives exactly these; US Standard Atmosphere 1976 quotes 0.209476 and 28.9644 (not reached) |
| other heating values (C2H6, C3H8, C4H10, CH4 LHV) | as `FUEL_REFERENCE` | PINNED NOT VALIDATED: ISO 6976 not reachable. The methane pair is internally off: HHV - LHV = 88.2 against 2 x 44.004 = 88.0 (ethane 0.09, butane 0.18 high). Labelled typical; the fuel analysis governs |
| flue gas cp 1.10, vapour cp 1.95, water cp 4.19 | typical | PINNED NOT VALIDATED; labelled typical with ranges |
| isentropic exponent of steam | now required | 1.3 superheated and 1.135 dry saturated (Zeuner) quoted from memory; no source reached, so no default |

No emission factor is shipped by either engine or page. The goldens use a
synthetic 56 kg/GJ and a synthetic 0.43 t/MWh and say so.

## HELD

- **H1. Which assessment report the course and page recommend.** The engine
  ships no GWPs by design. AR5 is what UNFCCC reporting has required and AR6
  is what the GHG Protocol now recommends; which one a Nigerian operator
  files on is a regulatory reading, so the course teaches both and the choice
  of a recommended default is the owner's.
- **H2. Correcting the methane heating value pair** (88.2 against 88.0).
  Without ISO 6976 in hand there is no citation to correct it to.
- **H3. All escaped carbon is counted as methane.** The engine's stated and
  conservative assumption. The API Compendium method uses the gas's own
  methane content; changing that changes the method and is a decision for
  the owner, so the course teaches it as the assumption it is.
- **H4. Combustion N2O is not computed.** Only CO2 and escaped methane come
  out of the atom balance; N2O needs an emission factor line, which the page
  allows.
