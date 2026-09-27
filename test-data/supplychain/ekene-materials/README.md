# Ekene materials register (synthetic)

SYNTHETIC teaching data for the Ekene field, Petrolord's fictional teaching
field (block EK-11). No real company, person, supplier or price appears. Used
by `engines/supplychain/inventory.js` (Supply Chain SC3), its jest gate and
the NextGen `materials` course, which all read this same file.

Written by `tools/validation/supplychain/make_inventory_fixtures.py` (stdlib
python, every figure typed by hand); re-running it reproduces the file byte
for byte. Wells follow `test-data/ekene-dynamic/field.json`.

| key | contents |
|---|---|
| `items` | 18 stock items: annual usage, unit cost, criticality scores 1 to 5 on four criteria, stock on hand, months since the last issue, monthly usage. |
| `policy` | the stated criticality weights and classes (V from 70, E from 44, D from 0; a safety score of 5 places an item in V), ABC cut-offs 80% and 95% (at or below), slow-moving bands (12, 24 and 36 months at 25%, 50% and 100%) and a 24-month excess cover limit. |
| `cases` | one stated case for each of eoq, quantityDiscount, safetyStock, poissonStock, insuranceSpares and leadTimeRisk. |

Planted situations (what the course teaches from):

- PSV-KIT scores the maximum 5 on safety, so it is class V whatever its
  weighted score (68, class E by score alone).
- MECH-SEAL scores exactly 70, the V minimum (at or above, so V); GASKET-RJ
  scores exactly 44, the E minimum.
- ABC at 80% and 95%: CEM-G is the item that crosses 80% (cumulative 83.5%),
  so it is B under the 'at-or-below' rule and A under 'include-crossing'.
- CEM-G has gone exactly 12 months without an issue (band slow, at the edge);
  GASKET-RJ exactly 24 (very slow); HEAT-TRC 40 months and no usage
  (obsolete, all stock excess).
- ORING-KIT holds 80 months of cover (excess well above 24 months).
- The ESP motor is the insurance spare: two failures a year across the pumped
  wells, a 150-day lead time, and one well off production while waiting.
