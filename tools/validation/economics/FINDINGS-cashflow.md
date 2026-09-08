# FINDINGS: Economics cash flow engine and Monte Carlo layer (EC0, agent A)

Engine under test: `engines/economics/cashflow.ts` (the Suite's
`supabase/functions/_shared/epe-engine.ts`, ENGINE_VERSION 3.9.0, moved
verbatim 2026-09-08) and `engines/economics/montecarlo.ts` (the Suite's
`epe-mc.ts`, verbatim, one import repointed to `./cashflow.ts`).

Oracles: `tools/validation/economics/oracle_cashflow.py` and
`oracle_montecarlo.py`, python3 stdlib, written from the engine header,
`docs/scope/EPE.md` and the harness derivations, not from the TypeScript.
Goldens: `test-data/economics/goldens/cashflow_cases.json` (74 cases, 8
ingestion errors, 15 IRR vectors, 6 breakeven cases, 4 sweeps, 10 pinned
disagreements) and `montecarlo_cases.json` (7 cases plus primitive pins),
both byte-identical on rerun. Gates: `__tests__/economics.cashflow.test.ts`
(the 58 Suite engine tests, the 60 harness checks of
`tools/validation/epe-validation.ts` cases 1 to 6, 9 closed-form
identities, and the golden agreement) and
`__tests__/economics.montecarlo.test.ts` (the anti-drift gate against
`lib/stats/stats.js`, the 13 Suite MC tests, the 7 harness case-7 checks,
and the golden agreement).

Discounting convention (brief rule 9): cashflow.ts discounts YEAR-END from
the valuation year (default the base year), adding 0.5 to every exponent
under `discounting_convention: 'mid_year'`. On the real basis the nominal
cash flow is deflated by (1 + inflation) ^ (year - base_year) and
discounted at the Fisher real rate (1 + nominal) / (1 + inflation) - 1; on
the nominal basis it is discounted at the nominal rate. The oracle
implements exactly that and the identity tests prove it two ways (real
with zero inflation equals nominal; real NPV equals the nominal flows
discounted at the nominal rate). The screening engine (`screening.js`)
discounts mid-year and is not comparable.

No engine behaviour was changed. Every disagreement below is recorded with
both numbers; the golden pins the engine's number as published and the
jest gate asserts the engine still produces it.

## 1. Disagreements between the engine and the oracle

### 1.1 The NPV profile's "applied rate" point misses the headline NPV on a real basis

Method statement (engine header, v3.8): `kpis.npv_profile` is "NPV at a
standard discount-rate vector (0/5/8/10/12/15/20 percent plus the applied
rate) ... the applied rate is included so the curve always passes through
the headline NPV."

What the engine does: it labels the applied point with the rate ROUNDED to
two decimals (`Math.round(rate * 10000) / 100`) and evaluates the NPV at
the rounded rate. With 10 percent nominal and 3 percent inflation the
Fisher real rate is 6.796116504854366 percent; the profile point sits at
6.8 percent and does not pass through the headline NPV. The oracle
evaluates the applied point at the exact rate, which is the headline NPV
by construction. Eight golden cases carry the gap (engine minus oracle,
USD):

| case | engine (6.8 percent) | oracle (6.7961 percent, = headline NPV) | gap |
|---|---|---|---|
| multiyear_pia_real | 203,209,583.79 | 203,250,580.21 | -40,996.42 |
| multiyear_pia_midyear_real | 196,633,975.59 | 196,677,221.27 | -43,245.68 |
| elt_pia_multiyear | 203,209,583.79 | 203,250,580.21 | -40,996.42 |
| multiyear_jv_real | 88,086,010.81 | 88,104,639.00 | -18,628.18 |
| pia_loss_relief | -5,480,342.37 | -5,475,212.04 | -5,130.33 |
| pia_loss_relief_killswitch | -8,768,306.08 | -8,763,295.32 | -5,010.77 |
| pia_cpr_carry_two_years | -86,633,142.54 | -86,629,207.06 | -3,935.48 |
| allowance_cap_midyear | 2,405,993.72 | 2,406,447.46 | -453.74 |

Who is right: the header's own statement. The point should be evaluated at
the exact applied rate (the label can still be rounded for display). The
seven standard-rate points agree to the cent in every case. Single-year
cases at t = 0 show no gap because the NPV there is rate independent, so
the Suite's regression contract never saw this. Owner decision.

### 1.2 IRR on a profile with more than one root

Method statement (engine header, v3.5): "irr(): Newton now falls back to
bisection when unconverged and returns null when no sign change brackets a
root." Nothing is said about which root is reported when the cash flows
change sign more than once.

The oracle reports the root nearest zero on the positive side (the
hurdle-rate region an IRR is compared against), scanning a 0.001 grid
upward from zero and bisecting the first bracket to 1e-13, then downward
if nothing is found above zero. The engine reports whichever root Newton
reaches from a 10 percent start. Two constructed profiles pin the
difference (both numbers zero the NPV to 1e-6 of the largest flow):

| flows | engine IRR | oracle IRR | all roots |
|---|---|---|---|
| [-100, 208, -108.12] | 5.9999999999995654 percent | 2.0000000000029106 percent | 2 and 6 percent |
| [-100, 340, -382.4, 142.4] | 7.350889359324948 percent | 0.0000000000000029 percent | 0, 7.35 and 32.65 percent |

On the golden's production-shaped cases the two agree under the oracle
convention: `elt_off_tail_kept` (flows -12.5M, +37.5M, -9M) has roots at
-73.04 and +173.04 percent and `abandonment_appended_year` (-12.5M,
+37.5M, -10M) at -70.42 and +170.42 percent; both engine and oracle report
the positive one. The point for the owner: any profile with a terminal
negative flow (abandonment, or an uneconomic tail kept because the
economic limit is off) has two IRRs, and the engine reports one of them
with no flag that the number is ambiguous. On [-100, 230, -132] (roots at
10 and 20 percent) both report 10 percent.

### 1.3 Degenerate Monte Carlo standard deviation is 3.3e-7, not 0

With no uncertain variable every one of 100 iterations returns the
deterministic NPV 135,185,570.34003878. The engine's `stdDev` is
3.2782554626464844e-7 USD and its `se` 3.28e-8, not 0: `mean` is a naive
left-to-right reduce, and a hundred additions of a 1.35e8 value round the
mean by a few 1e-8, which the deviation sum then picks up. The oracle
(compensated summation) reports exactly 0. Inside every stated tolerance
(the Suite's own test asked for 1e-6) and pinned as a bound, but a reader
who expects "no uncertainty in, zero spread out" sees a nonzero number.

## 2. Things the engine does that its header does not say

These are not disagreements: the oracle implements each one because the
harness derivations or the published rule behind the engine require it,
and the goldens pin the numbers. They are recorded because the header (and
`EPE.md`) is where a reviewer looks first.

2.1 CIT capital allowance is restricted to two thirds of the CIT assessable
profit (`min(capital allowance claimed, 2/3 x cit_assessable_profit)`),
the CITA restriction. The header never mentions it. It binds in
`cpr_forfeiture` (2025): 12,000,000 of allowance against a cap of
5,324,926.18, CIT chargeable 2,662,463.09. The 6,675,073.82 the cap
disallows is NOT carried forward in the CIT computation (CITA carries a
restricted allowance forward; the engine only carries the CPR pool). Owner
decision whether the CIT carryforward is wanted; the oracle mirrors the
published behaviour.

2.2 The NDDC levy is deducted from the CIT assessable profit but not from
the HCT assessable profit; the HCDT is deducted from both (liquids share in
HCT). In the worked example HCT assessable is 1,054,994,854.24 (excludes
the 15,000,000 NDDC) and CIT assessable 1,039,994,854.24 (includes it).
This is the published worked example's treatment, so it is correct by the
regression contract; it is undocumented.

2.3 Escalator defaults: `oil_price_escalator_pct`,
`gas_price_escalator_pct`, `condensate_price_escalator_pct` and
`opex_escalator_pct` default to `inflation_rate_pct` when unset;
`capex_escalator_pct` defaults to 0. `EPE.md` says only "separate
escalators". Pinned by `escalator_defaults_to_inflation`.

2.4 CPR claim order: opex and the carried-forward pool claim before the
year's capital allowance; capital allowance is what defers. Stated only in
the harness derivation for case 6.

2.5 HCDT is 3 percent of the PREVIOUS MODELED YEAR's inflated opex
(including a zero-opex abandonment-only year), seeded by
`pia_prior_year_opex_usd`; a zero seed means no HCDT in year one.

2.6 The price royalty and the production allowance use the OIL price as
the fiscal price for oil AND condensate revenue and barrels; the
condensate price sets revenue only.

2.7 `dpi` is NPV divided by PV(capex). The conventional profitability
index is PV(inflows) / PV(investment), which is this number plus one. The
code comment says "NPV per present-value dollar of capex"; the header says
only "PV(capex) + DPI". Naming, not arithmetic.

2.8 Sinking fund relief under PIA (header: "contributions are
tax-deductible in the regime bases"): the HCT saving is contribution x
liquids revenue share x EFFECTIVE HCT rate (hct_tax / hct_chargeable, so
after any loss offset), the CIT saving is contribution x CIT rate, each
capped at the tax actually charged, and no loss is ever banked when the
contribution exceeds the base. The TET and Development Levy bases are
untouched. Pinned by `pia_sinking_fund`.

2.9 Abandonment cost and working interest disagree between the two funding
modes. The lump sum is applied AFTER WI scaling as the user's own share
(`jv_abandonment_wi_60`: 10,000,000 charged against the 60 percent flows;
`psc_abandonment_wi_50`: 10,000,000 against the 50 percent flows). The
sinking-fund contribution sits in the WI-scaled keys, so at 50 percent WI
(`pia_sinking_fund_wi_50`) the fund collects 15,000,000 in total while
`abandonment_cost_funded` and `total_abandonment_cost` report 30,000,000,
and `unit_technical_cost_usd_per_boe` adds the full 30,000,000 over the
WI-share barrels. Under one mode `abandonment_cost_usd` is a share-level
number, under the other a field-level one. Owner decision.

2.10 `taxable_income` on a PIA row is `hct_chargeable_profit +
cit_chargeable_profit`, the sum of two different bases; a diagnostic with
no fiscal meaning.

2.11 The economic limit test keeps a trailing capex-only year (net
operating income 0 is not negative), never trims below one year, and
under PIA approximates the royalty burden with the production and price
royalty rates on liquids revenue and the gas rate on gas revenue.

2.12 `payback` is "Year 0" and `payback_years` is 0 whenever the
cumulative cash flow never goes negative (a single positive year, or a
sunk run whose evaluated flows are all positive), not only when it is
zero at year zero.

2.13 On the real basis the deflator is anchored at `base_year` while the
discount exponent is anchored at `valuation_year`; the two anchors differ
whenever a valuation year is set.

2.14 With a working interest below 100 on PSC or PIA the volume totals
(`total_oil_bbl`, `total_boe`) are entitlement (WI-share) barrels while
`cumulative_oil_bbl_lifetime` and `prod_alw_eligible_bbl` stay field
level, as the v3.6 header says; `kpis.total_abandonment_cost` is the
unscaled input.

2.15 Row years: an explicit `year` beats `date` beats `month_index`; the
first row's headers decide the volume columns for every row.

## 3. Monte Carlo layer notes

3.1 `mulberry32` in montecarlo.ts is written in int32 form and the one in
`lib/stats/stats.js` in uint32 form; the streams are bit-identical (the
anti-drift gate now checks the generator directly on nine seeds, which the
Suite's gate did not).

3.2 The oracle's uniform stream is bit-identical to the engine's (uint32
arithmetic, divide by 4294967296). The Box-Muller draws and the marginal
transforms agree to 1e-12 relative, not bit for bit: Python's libm and
V8's own log, cos and exp can differ in the last ulp. No sampled input in
any golden case changed a truncation decision or an order statistic.

3.3 `basicStats.mean` and `stdDev` in montecarlo.ts are naive sums; the
canonical `lib/stats/stats.js` uses simple-statistics' Kahan-compensated
sum. The anti-drift gate holds them to 1e-9, as the Suite's did.

3.4 The sampled absolute price under a per-year deck is applied as a
scale against the flat config price, falling back to the first deck value
and then to 1 when the flat price is unset. Pinned by
`deck_scaled_oil_price`.

3.5 `production_scale` scales every column the engine's `isVolumeColumn`
recognises, including water and `total_*` rollups; `capex_scale` and
`opex_scale` scale every column whose name ends in `_usd`.

## 4. What was not done, and why

Nothing in scope was skipped. Two limits of the oracle are stated rather
than hidden: the multi-root IRR convention (section 1.2) is a choice, made
explicit; and the sinking-fund relief (2.8) and the CIT allowance cap
(2.1) are implemented as the engine's published behaviour rather than as a
literature reading, because the regression contract in `EPE.md` section 7
freezes the worked example and no published PIA decommissioning or CITA
carryforward example was supplied. Both are owner decisions.
