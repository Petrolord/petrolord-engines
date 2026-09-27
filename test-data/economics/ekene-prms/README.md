# Ekene reserves and resources (synthetic)

SYNTHETIC teaching data for the Ekene field (ours), written by
`tools/validation/economics/make_prms_fixtures.py`. No real company, field,
licence, price, cost, reserves figure or regulator decision. Used by the EC11
engine `engines/economics/prms.js`, its gate `__tests__/economics.prms.test.js`
and the NextGen course "Reserves & Resources under SPE-PRMS 2018".

Every figure is a stated input of the synthetic case: the engine holds no
default for any classification fact, chance, correlation, seed, price, cost,
royalty or tax rate. The royalty (15%), tax (30%), prices and costs are
synthetic figures chosen for teaching, not the PIA 2021 or NTA 2025 rates.

## Projects on the Ekene lease (operator Ekene Operator (synthetic), 70%)

| id | project | class the engine gives | sub-class | what decides it |
|---|---|---|---|---|
| EKN-1 | Ekene Main waterflood | Reserves | on-production | every commerciality criterion met; producing; developed producing |
| EKN-2 | Ekene infill wells | Reserves | approved-for-development | investment decision taken; undeveloped |
| EKN-3 | Ekene East gas | Contingent Resources | development-on-hold | no market, no facilities, no appropriations, starts in 6 years; a significant gas discovery under PIA 2021 s.78(8)(b), 3 years retained; Pd 50% |
| EKN-4 | Ekene North appraisal | Contingent Resources | development-pending | no mature plan, no appropriations, no approvals yet; Pd 65% |
| EKN-5 | Ekene West tight sand | Contingent Resources | development-unclarified | recovery needs technology under development; economically not viable; Pd 20% |
| EKN-6 | Ekene Deep prospect | Prospective Resources | prospect | Pg 25% (the EC10 farm-out prospect), Pd 80%: Pc 20% |
| EKN-7 | Ekene Shallow lead | Prospective Resources | lead | Pg 15%, Pd 70%: Pc 10.5% |
| EKN-8 | Ekene Main residual oil | Discovered Unrecoverable | none | no recovery project applies |

## Economic limit (EKN-1)

Effective 1 January 2027; low, best and high technical forecasts 2027 to 2041
(whole barrels a year: 2,250,000 x 0.80^t, 3,000,000 x 0.85^t and
3,600,000 x 0.88^t; gas 0.8 Mscf a barrel). Oil 65 and gas 2.5 US$ a unit
flat; opex 30,000,000 a year; a 15,000,000 workover campaign in 2027;
abandonment 40,000,000 at the economic limit; royalty 15% (a royalty
interest); tax 30% with five-year straight-line allowances and loss carry
forward; working interest 70%; the lease expires in 2040 with no renewal
expected; net entitlement basis; 10% discount rate; 6 Mscf a BOE.

## Aggregation

Reserves at the field level: EKN-1 (triangular through 8.89, 16.65 and 24.99
MMbbl, its economic-limit gross oil for the low, best and high cases),
EKN-2 (lognormal, mean 6, standard deviation 1.8) and the Ekene Upper sand
(normal, mean 4, standard deviation 0.8), with stated pairwise correlations
0.5, 0.2 and 0.2; seed 20271112, 20,000 iterations. Contingent Resources
(MMboe, risked by the stated chance of commerciality): EKN-3, EKN-4 and EKN-5,
uniform correlation 0.3; seed 20271113.

## Reconciliation

Ekene field Reserves from 1 January 2027 to 1 January 2028 (MMbbl): opening
15.2 / 21 / 27.5; production 1.1; revisions +0.3 / -0.2 / -0.6; EKN-2
transferred from Contingent Resources 3.4 / 5.1 / 6.9; improved recovery
0.5 / 0.8 / 1.2; stated closing 18.3 / 25.6 / 33.9 (tolerance 0.001).
