# Ekene Deep farm-out (synthetic)

SYNTHETIC teaching data for the Ekene field (ours), written by
`tools/validation/economics/make_farmout_fixtures.py`. No real company, deal,
prospect, price or regulator decision. Used by the EC10 engine
`engines/economics/farmout.js`, its gate `__tests__/economics.farmout.test.js`
and the NextGen course "Farm-ins, Farm-outs & Asset Valuation".

Ekene Deep is a synthetic exploration prospect on the Ekene petroleum
prospecting licence (synthetic). Money is US$ in whole dollars. Every deal
term below (share paid, interest earned, cap, overrun rule, bonus,
reimbursement, uplift, likelihoods, correlation, seed) is a term of the
synthetic deal, stated in the fixture: the engine holds no default for any of
them. The consent fee rates are the gazetted ones (Nigerian Upstream Petroleum
(Assignment of Interests) Regulations, 2024, reg. 19(2)); the transaction
value they apply to is a synthetic stated amount.

## Parties

| id | name | interest before the farm-out |
|---|---|---|
| EKO | Ekene Operator (synthetic), the farmor | 70% |
| PA | Partner A (synthetic) | 30% |
| FIN | Farminee Energy (synthetic), the farminee | 0% |

## The prospect

- Chance of success 25%.
- Exploration well: 40,000,000 as a dry hole, 46,000,000 when it finds oil
  and is tested and suspended.
- Success case at 100%: the development's net cash flow after royalty and
  tax, 2029 to 2045 (three development years of spend, then a plateau of
  250,000,000 a year for two years and a 12% a year decline), discounted at
  10% to 2027 by the canonical npv: 271,250,337.04.

## The deal

FIN pays 40% of the exploration well to earn 30% of the licence from EKO
(a promote of 10 points, ratio 40 / 30), the promote applying to the first
44,000,000 of well cost (a gross-cost cap; the excess is paid by the post-deal
interests). FIN pays a cash bonus of 2,000,000 and reimburses 30% of EKO's
12,000,000 past costs (3,600,000). The value of the transaction stated for
the consent is 5,600,000 (bonus and reimbursement); the consent fee at 7% is
392,000, paid by EKO as assignor, 88 days after the notification.

## Planted situations (the gate asserts each one)

- Farming out beats drilling alone for EKO (EMV 19,833,033.70 against
  18,418,808.98), while FIN's EMV at 40 for 30 is -1,806,224.72: FIN declines.
  Its break-even promote is 35.594574% of the well for 30% (5.594574 points).
- The success well (46,000,000) exceeds the 44,000,000 cap; the dry hole
  (40,000,000) is below it.
- Drill-to-earn: the exploration well earns 20% for 40% of its cost with no
  cap; the appraisal well earns 15% more for 45% of its cost with a carry cap
  of 3,000,000, which its carry of 10% of 30,000,000 reaches exactly. With
  "all-events" vesting and one event completed, nothing vests; with both
  completed, 35% vests; with "per-event" vesting and one completed, 20%.
- The seismic signal (likelihoods 75 / 25 and 25 / 75) turns FIN's decision:
  farm in on the bright signal, decline on the dim one; the information is
  worth buying at 1,500,000 and not at 9,000,000.
- The farm-out lowers EKO's spread of outcomes and lifts its low case
  (riskSharing, seed 20271111, 20,000 draws).
- Development carry after the farm-in: FIN carries 50% of EKO's 40% share of
  the development cost, recovered with an 8% a year compound uplift from 50%
  of EKO's share of production; recovered in 2036.
- The stated price of 16,000,000 for 30% is about 2.03 times the risked value
  per percent: a ratio of stated inputs, reported only.
