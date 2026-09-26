# Ekene gas sales agreements (synthetic)

SYNTHETIC teaching data for the Ekene field (ours), written by
`tools/validation/economics/make_gsa_fixtures.py`. No real company, plant,
contract, price series or regulator allocation. Used by the EC8 engine
`engines/economics/gasContract.js`, its gate `__tests__/economics.gasContract.test.js`
and the NextGen course "Gas Commercialisation & Gas Sales Agreements".

The seller is the Ekene licence's gas, onshore (the terrain of the EC7 Ekene
onshore cases). The Ekene oil field's own associated gas volumes are not used:
the quantities below are contract quantities only.

## domestic-power.json: the Ekene Power Plant (synthetic), 2027 to 2034

- DCQ 21,000 MMBtu per day (20 MMscf per day at a stated 1,050 Btu/scf gross),
  MaxDCQ 110%, take-or-pay 80% of the Adjusted ACQ, make-up 3 contract years
  after the deficiency year, taken only after the year's Adjusted ACQ
  (Commonwealth model GSA Article 12.7.1), unrecovered make-up forfeited at
  the end of the term. No carry-forward.
- Price: the power sector price, which is the domestic base price (PIA
  s.167(5)). The fixture holds the reported 2026 figure, US$2.18 per MMBtu
  (effective 1 April 2026), flat for every year as a stated planning
  assumption; the Authority re-determines it each year.
- Seller shortfall liquidated damages at a stated 1.25 US$ per MMBtu.
- Planted: 2027 force majeure 42,000 and seller shortfall 6,300; 2028 plant
  outage, deficiency 688,800 paid; 2029 make-up 210,000; 2030 taken exactly
  the Adjusted ACQ, so no make-up; 2031 make-up 268,800 in the last year of
  the period and 210,000 expires; 2032 take-or-pay exactly met; 2033
  deficiency 357,000; 2034 make-up 105,000 and 252,000 forfeited.
- January 2027 day by day: zero nomination on the 5th; whole-day force
  majeure on the 12th and 13th; seller shortfall 6,300 on the 20th; a
  nomination of 24,150 above the MaxDCQ 23,100 on the 25th; maintenance
  10,500 on the 28th; a buyer-caused shortfall on the 30th.
- The 2028 Domestic Gas Delivery Obligation (synthetic allocation 6,825,000
  MMBtu): 5,460,000 delivered, 688,800 excused because the purchaser could
  not accept (s.110(10)(b)), 676,200 penalised at US$3.50 per MMBtu.
- Royalty: onshore, all gas utilised in-country (2.5%).

## export-feed.json: the Ekene Export Feed Buyer (synthetic), 2027 to 2036

- DCQ 63,000 MMBtu per day (60 MMscf per day at 1,050 Btu/scf), MaxDCQ 105%,
  take-or-pay 90%, make-up 5 years taken only after the year's take-or-pay
  quantity (ESMAP 1993 para 6.59), refunded at the last year's take-or-pay
  price at the end of the term; carry-forward of takes above the take-or-pay
  quantity for 3 years, at most 50% of a year's deficiency (ESMAP paras 6.61
  and 6.62). Make-up gas at 10% of the contract price.
- Price: 0.5 + 0.12 x the oil index averaged over 6 months ending 1 month
  before the priced month, reset quarterly, with an S-curve at 55 and 90
  US$/bbl and half the slope outside; 4-decimal rounding (Commonwealth model
  GSA Article 15.4); reopeners reported in 2031 and 2035. The oil index is a
  deterministic synthetic curve, not market data. The annual contract price and
  the take-or-pay price are the annual averages of the monthly prices.
- Planted: 2029 train outage, deficiency 6,438,500 of which a carry-forward
  credit of 3,219,250 (50%) is drawn from 2027 and 2028 surpluses; 2030 buyer
  force majeure 1,260,000; carry-forward expiring unused in 2031, 2034 and
  2036; the 2036 end of term refunds 457,950 of 2035 make-up.
- Royalty: onshore, exported (5%).
