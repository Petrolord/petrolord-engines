# Ekene tenders (synthetic)

SYNTHETIC teaching data for the Ekene field, Petrolord's fictional teaching
field (block EK-11). No real company, person, tender or price list appears:
bidders are codes (WS1..WS6, MS1..MS5) named "Bidder WSn (synthetic)". Used by
`engines/supplychain/tender.js` (Supply Chain SC2), its jest gate and the
NextGen `procurement` course, which all read these same files.

Written by `tools/validation/supplychain/make_tender_fixtures.py` (stdlib
python, every figure typed by hand); re-running it reproduces the files byte
for byte. Well names and depths follow `test-data/ekene-dynamic/field.json`.
The Nigerian content minimums are not in these files: each item names a line
of the Schedule to the Nigerian Oil and Gas Industry Content Development Act
2010 and the engine holds the percentage (`NC_SCHEDULE`).

| file | contents |
|---|---|
| `well-services.json` | EK-11/WS/2027-01, coiled tubing cleanout and matrix acid stimulation on Ekene-3 and Ekene-5. Six bids with technical scores on five weighted criteria (pass mark 70), priced bills of quantities, completion weeks, Nigerian content in man-hours for three Schedule lines, and the award basis (combined score, technical weight 0.7). Also `contracting` (the same scope as lump sum, day rate and cost plus 12 percent, duration from a wellCost activity program with a triangular NPT fraction) and `shouldCost` (the company estimate through wellCost and the AFE partner split). |
| `materials.json` | EK-11/MS/2027-02, casing, gate valves, cement, baryte and inspection. Five bids, three technical criteria (pass mark 60), delivery weeks, five years of valve maintenance evaluated as a life-cycle cost at 10 percent, Nigerian content by tonnage and by number (mixed units, so each bid's spend weights the items), and the award basis (lowest evaluated cost). |

Planted situations (what the course teaches from):

- Well services: WS6 is excluded before scoring (unsigned bid form); WS4, the
  cheapest bid, fails the pass mark and its price envelope is never opened;
  WS5 scores exactly the pass mark (70) and passes; WS2 has an arithmetic
  error (18 x 27,000 quoted as 468,000; the unit rate prevails) and a priced
  payment-terms deviation; WS5 typed its acid unit rate with the decimal
  point misplaced (13.8 for 1,380; the quoted amount governs); WS3 omits the
  nitrogen line (priced at the average of the other responsive bids); WS1
  offers an unconditional discount. The lowest evaluated cost (WS5) is not
  the most advantageous bid on the combined score (WS3).
- Materials: MS5 fails the pass mark; MS4 omits the inspection line, and the
  omission rule decides the lowest evaluated cost (the average rule gives
  MS4, the highest-price rule gives MS2); MS2 and MS4 are within 1 percent of
  each other, so section 14 of the Act is engaged, and the reading of "at
  least 5% higher" decides it (percentage points: MS4 stands; relative: MS2
  is selected); MS3, an indigenous company with capacity, sits within 10
  percent of the lowest (section 16).
