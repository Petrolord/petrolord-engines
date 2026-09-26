# Ekene joint venture (synthetic)

SYNTHETIC teaching data for the Ekene field (ours), written by
`tools/validation/economics/make_jv_fixtures.py`. No real company, contract,
budget, price or regulator decision. Used by the EC9 engine
`engines/economics/jointVenture.js`, its gate
`__tests__/economics.jointVenture.test.js` and the NextGen course "Joint
Ventures, Operating Agreements & Cost Recovery".

The licence is the Ekene shallow water licence (the terrain of the EC7 Ekene
Alpha case, about 8,000 bopd at 75 US$/bbl). Money is US$ in whole dollars.
Every contract rate, tolerance, scale, multiple and share below is a term of
the synthetic contract, stated in the fixture: the engine holds no default
for any of them.

## Parties

| id | name | participating (beneficial) | paying while NOC is carried |
|---|---|---|---|
| EKO | Ekene Operator (synthetic), operator | 40% | 50% |
| PA | Partner A (synthetic) | 25% | 31.25% |
| PB | Partner B (synthetic) | 15% | 18.75% |
| NOC | State participant (synthetic) | 20% | 0% |

NOC is carried 100% through exploration and appraisal, pro rata by the other
three (EKO 10, PA 6.25, PB 3.75 points).

## Planted situations (the gate asserts each one)

- Cash calls 2027: the difference of a month adjusts the call two months
  later; no cash call in a month whose forecast is below 500,000; a credit
  larger than a forecast share is carried (negativeCall "carry").
  January over-call 400,000 credited in March; February under-call 500,000
  due in April, a zero month with no call, so it waits; May (forecast
  400,000) is below the threshold and its actual 448,000 is billed in arrears
  in June; the July over-call 1,200,000 exceeds the September forecast
  shares, so September's call is 0 and 200,000 of credit is carried to
  October; June and September are called exactly.
- Budget 2027: geology and geophysics overruns by exactly the 10% item
  tolerance (inside); exploration drilling overruns beyond it; an
  unbudgeted 250,000 survey sits inside a 500,000 allowance; the budget
  overrun of 5,950,000 is beyond the lower of 5% (3,800,000) and 3,000,000.
- Overhead 2031: a marginal scale by category (bands in the Norwegian
  pattern, synthetic US$ figures), 2,000,000 of excluded operating cost, and
  a flat 0.625% corporate charge on the total.
- Default: PB pays 250,000 of its 2,250,000 share of the 12,000,000 March
  call due 2027-03-01 and cures on 2027-04-15 (45 days at a stated 8.25% on
  a 360-day year: 20,625); suspension after 5 working days is triggered,
  forfeiture 3 months after the 2027-03-10 notice is not.
- Carry recovery: NOC's carried cost (20% of 82,000,000 and 60,000,000) is
  recovered from at most 50% of its share of the entitlement from 2030 with
  a stated 8% compound uplift (recovered in 2033); under PIA s.85(4) with no
  uplift and the whole share available it is recovered in 2031; a stated cap
  of 25,000,000 writes off the rest.
- Back-in: NOC backs in from 20% to 40% under PIA s.85(4); exploration,
  bonus, interest and markup are excluded, the refund of 98,000,000 comes from
  half of NOC's new share of entitlement and is recovered in 2034.
- Sole risk: PB declines the 18,000,000 Ekene-4 sidetrack; the consenting
  parties recover 400% of PB's 2,700,000 share out of PB's share of the
  sidetrack's net value; PB's interest reverts inside 2035.
- PSC (a synthetic PSC variant of the same field): royalty 12.5%, cost oil
  limit 60% of gross (the s.311(2)(a)(iii) ceiling, as the stated contract
  figure), contractor profit share 60%, tax 30% on the contractor's profit
  oil, an opening pool of 142,000,000; the pool is recovered in 2036.
