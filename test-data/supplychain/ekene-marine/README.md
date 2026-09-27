# Ekene offshore cluster supply (synthetic)

SYNTHETIC teaching data for the Ekene field, Petrolord's fictional teaching
field (block EK-11), here given a fictional offshore cluster supplied from a
fictional supply base. No real company, vessel, port, installation or
contract appears: every name ends "(synthetic)". Used by
`engines/supplychain/marineLogistics.js` (Supply Chain SC4), its jest gate,
the Marine Logistics Planner app and the NextGen `marine` course, which all
read this same file.

Written by `tools/validation/supplychain/make_marine_fixtures.py` (stdlib
python, every figure typed by hand); re-running it reproduces the file byte
for byte. Vessel figures sit inside the ranges the cited sources print (Aas,
Halskau and Wallace 2009: economical speed 11 to 13 knots, deck areas over
526 m2; Skoko et al. 2024: sailing fuel 0.5 t/h, port 0.03 t/h, fuel at
USD 870 a tonne). The weather factor, the usable deck fraction and the
available days are stated planning inputs of this example, nothing more.

| key | contents |
|---|---|
| `products` | six bulk products with a stated density each (diesel, water, mud, brine, cement, barite) |
| `vessels.psv`, `vessels.ahts` | one PSV and one AHTS: speed, clear deck area and its usable fraction, deck load, cargo deadweight, a tank per product, fuel burn by activity |
| `installations` | four installations (production platform, jack-up drilling unit, wellhead platform, FPSO): distance from the base, field hours a visit, minimum visits a week, weekly demand, and the cargo of one planned voyage |
| `milkRun` | the stops in the order sailed and the leg distances in nautical miles |
| `portHours`, `weather`, `fuelPricePerT`, `period` | base hours a voyage; factor 1.2 on sailing and field time; USD 870 a tonne; a 7-day week with 6.5 days available a vessel |
| `variability` | triangular weather factor (1, 1.2, 1.6) and demand factor (0.85, 1, 1.3), two planned vessels, 20,000 iterations, seed 20260927 |
| `deck`, `deckItems` | the PSV's clear deck (800 m2, 75% usable, 2,000 t) and one voyage of deck cargo in the order booked, smallest first: chemical IBCs, skips, containers, baskets, mud tanks, casing bundles |
| `shoreBase` | two berths, 3.2 arrivals a day over a 24-hour working day, service of 2 fixed hours with 60 lifts at 12 an hour alongside 900 m3 of bulk at 150 m3 an hour |

Planted situations (what the course teaches from):

- One PSV milk run with the voyage cargo is feasible with deck area binding
  at 90%; doubling the deck cargo overloads deck area only.
- Fleet sizing for a week: on the PSV milk run the deck area drives the
  voyage count (3.1 voyages of demand, so 4) above the minimum visits (3), and
  two vessels are needed; on dedicated voyages every installation is driven
  by its minimum visits.
- One voyage of deck cargo (615.7296 m2 against 600 m2 usable) does not fit
  on the PSV deck. First-fit decreasing fills 599.2296 m2 and leaves eleven
  small units (16.5 m2) as named overflow; first fit in the booked order
  (smallest first) fills only 580.6296 m2 and leaves a casing bundle
  (35.1 m2) behind. Two voyages carry it all.
- The supply base runs at a berth utilisation of 0.533 with two berths; one
  berth is refused as saturated. M/D/c waits less than M/M/c at the same
  load.
