# FINDINGS: terminals, depots and fuel supply (MD3-0, 2026-09-19)

The third validation wave of MD-0, before the NextGen course MD3 Terminals,
Depots & Fuel Supply. It covers `engines/downstream/terminalDepot.js` and
`engines/downstream/fuelPricing.js` at engines main `a1d8c9f`, and the LIVE
Suite layer (`TerminalDepotContext`, `FuelPricingContext` and their panels).

**Fourteen findings: twelve repaired, two HELD.** The worst is not in an
engine at all, and no engine test could have found it:

## T1. AT DEFAULTS, AND AT EVERY INPUT: the Terminal & Depot reconciliation could never show a gap

The Suite page had no opening-stock input. It set

    opening = closing dip - receipts + deliveries + known losses

and handed that to `reconcileStock`, which computes

    expected closing = opening + receipts - deliveries - known losses

which is the closing dip again. **The unaccounted figure was zero by
construction for every tank, every day and every input**, and the page
reported the terminal balanced. The page's own help guide says "A tool that
silently balanced would be worse than useless: gain and loss is what the
operator is judged on". It was that tool. The page now takes the opening
stock (yesterday's closing dip) as an input, and the engine refuses to close
a day without one (T2).

## The gate

| file | what it is |
|---|---|
| `oracle_terminaldepot.py` | strapping tables built from TANK GEOMETRY (a vertical cylinder is linear in height, so interpolation must return the geometry exactly); Erlang C by the EXACT FACTORIAL FORM in rational arithmetic, where the engine uses the Erlang B recursion; queue length by LITTLE'S LAW; the day as a ledger |
| `oracle_fuelpricing.py` | the landed cost as a CARGO INVOICE over outturn litres; insurance on CIF by FIXED-POINT ITERATION, where the engine now uses a closed form; the FX breakeven in CLOSED FORM, where the engine bisects; the fleet by INTEGER SEARCH, where the engine takes a ceiling; the station queue by the exact Erlang C |
| `__tests__/downstream.supply.golden.test.js` | 38 assertions, every one calls the engine |
| `negcontrol_md3.sh` | main's engines turn the gate red; 18 planted defects, 18 caught |

The battery's first run had THREE survivors, each a missing assertion rather
than a weak repair: no golden water cut the table could not convert; the
gate checked the emissions of a loss with no density but never its weight;
and it checked that a blank driver cost was named but not that its amount
was absent rather than 0. All three are asserted now.

What is pinned and not validated: the ASTM D1250 / API MPMS 11.1 FORM of the
volume correction (the coefficients are a published table this package does
not ship, so the cases use synthetic ones and assert the constant-free
invariants: VCF exactly 1 at 15 C and below 1 above it).

## Terminal & Depot

**T2. A missing opening stock was 0,** so the whole tank read as a gain.
Refused now.

**T3. A dip below the first strapping entry read that entry's volume.**
Refused now unless the entry is the empty tank. A negative dip is refused.

**T4. A water cut the table could not convert counted as no water,** and
water above the product dip was clamped to an empty tank. Both refused.

**T5. Zero bays were solved as one,** and 2.5 bays as 3. Refused now.

**T6. The tank farm netted heel across tanks,** so a tank below its heel
lent "pumpable" stock to another. Pumpable stock and ullage are tank by tank.

**T7. A loss with no density weighed nothing,** so a supplied emission factor
produced ZERO emissions. Now no tonnes and no emissions, and the note says
why. The page also defaulted a missing density to an invented 800 kg/m3;
it now passes what the tank carries.

## Fuel pricing

**F1. A percentage charge could bite on a base not yet formed.** Every base
starts at FOB, so an insurance line quoted on CIF (the usual marine quote)
was charged on FOB: on the default cargo at 0.15 percent, 38,850 against
40,464.70. It is now solved in closed form, CIF = (C&F + other insurance) /
(1 - the CIF rates), and a freight-stage charge on C&F or CIF is refused. The
page's template fixes insurance on C&F, so this was not reachable from the
page; it was reachable from any caller, and a course would teach it.

**F2. A charge with an unknown stage was dropped** from the walk without a
word. Refused now.

**F3. A blank trucking cost box (driver, maintenance, tyres, tolls,
overhead) was 0** and the lane reported complete. Blank is now missing and
named; a value left out of the call entirely still takes its stated default.

## Checked and sound

The ocean loss is divided rather than added (the cost per litre sold is the
invoice over the outturn litres); the pump build-up's waterfall reconciles to
its price; the FX breakeven bisection lands where the closed form puts it;
the rack's Erlang C matches the exact factorial form to 1e-10; the station
correctly reports that the page's default peak hour (240 transactions against
six nozzles serving 160) is beyond the forecourt, and that a full 45,000
litre load cannot discharge at the default reorder level.

## HELD

- **H1.** Charges levied at discharge (jetty, storage) are applied to the
  bill-of-lading quantity. Whether a terminal bills on the bill of lading or
  on the outturn is a contract term; the engine does not know it and the
  course must say so.
- **H2.** The VCF coefficient tables and any published rate stay unshipped,
  by the package's rule.

## MD3-1 (2026-09-19): found by the NextGen course foundation

- **T8. `rackQueue` accepted a load time of 0 minutes:** 60/0 is Infinity,
  which passed the positive-rate check and reported a perfect rack. Refused.
- **T9. `throughputEconomics` read a blank throughput or fee as 0** (a
  margin of minus the fixed cost for a terminal nobody described). Both are
  required now; a blank cost or loss is taken as zero and named in
  `assumedZero`. **`tankFarmCover` read 0 turns a year with no throughput**
  while reading days of cover as unknown; both are unknown now.
- **T10. The engine's own VCF test typed a coefficient that reads as a
  published table value.** This package ships no coefficient table, so the
  tests use a synthetic K0 of 600.
- **Oracle:** `oracle_terminaldepot.py` now exports `day_ledger()` and
  `farm_cover()` so a course oracle check can call them rather than copy
  lines out of `main()`. The golden is byte-identical.

Gate: four new assertions; three new plants in `negcontrol_md3.sh` (21 in
all, all caught).

## MD3-2 (2026-09-19): found by the supply course extension round

- **F4. `landedCost` read a blank ocean loss as zero loss** and reported the
  build-up complete, understating the cost per litre sold. A blank ('' or
  null) is now a missing rate (the total is a FLOOR); omitted from the call it
  still takes the stated 0. A loss of 100 percent or more is refused. The
  Suite page always supplies a value, so the page was not exposed.
