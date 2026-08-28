# @petrolord/engines

Validated petroleum-engineering engines shared by **Petrolord Suite**
and **Petrolord NextGen** (NextGen-ROADMAP.md N1, extracted from
petrolord-suite 2026-07-14 at main `9da5197b4`).

Pure client-side math — no React, no Supabase, no network. Every
engine is validated against an independent stdlib-Python oracle with
committed goldens; the goldens ARE the API contract between this repo
and its consumers.

## Layout

- `engines/<domain>/` — the engine modules (named exports only):
  `seismolord`, `welldata` (LAS parse/import), `petrophysics`,
  `wellcorrelation`, `mapping`, `rockphysics`, `earthmodeling`,
  `porepressure`, `basin`, `dca` (decline-curve analysis: Arps
  fits/EUR/forecast, type curves, group roll-up, EUR Monte Carlo;
  goldens are published literature fixtures — SPEE REP #6 Table 1,
  CED P03-004, Ahmed REH Ch. 16 — rather than a Python oracle),
  `aquifer` (vEH / Fetkovich / Carter-Tracy water influx with finite-reD
  pD; golden = the Dake Exercise 9.2 server cross-validation history,
  regenerated Suite-side via tools/validation/gen-dake92-client-golden.ts),
  `scal` (Corey/tabular rel-perm + Buckley-Leverett/Welge fractional
  flow and displacement, Leverett J-function Pc with LM fitting;
  golden = Leverett 1941 via the Ahmed reproduction, embedded in the
  test suites), `waterflood` (VRR series/classification, surveillance
  analytics — Hall plots, Chan diagnostics, cross-correlation lags,
  injection recommendations — plus layered sweep and pattern
  forecasting).
  The `production` domain (2026-08-28) holds six families. Flow
  assurance thermal-hydraulics (P10), which contains no correlation at
  all: the overall heat transfer coefficient as series resistances
  including the classical buried-pipe shape factor acosh(2H/D)/(2 pi k),
  the steady-state exponential approach to ambient that an energy
  balance on a pipe element integrates to, and the lumped-capacitance
  cooldown that gives a no-touch time. Plus hydrate inhibition:
  Hammerschmidt and Nielsen-Bucklin computed side by side with the gap
  between them reported rather than resolved, since they agree when
  dilute and separate badly when not. Where the hydrate boundary IS
  stays with the consumer's fluid model. Wellhead
  limits (P8): the API RP 14E erosional velocity with its C factor as an
  INPUT rather than a baked-in 100 (RP 14E is explicit that its own
  values are conservative), fitting the Gilbert-family choke
  coefficients to a well's OWN test data by the log-linear least
  squares the power law admits -- the five published sets span a factor
  of twelve in their leading constant and are not interchangeable --
  and a labelled Hammerschmidt hydrate SCREENING on the Joule-Thomson
  cooling across a bean. The choke physics itself is deliberately NOT
  here: the Gilbert family and the single-phase gas choke are the
  consumer's already-validated nodal layer. Gas-well
  performance (P7): liquid loading by the Turner/Coleman droplet
  balance, DERIVED from drag against weight plus a critical Weber
  number rather than quoted, so the 1.593 constant falls out of Cd and
  We instead of being remembered; the critical rate profile down the
  whole string, because critical rate rises with pressure and it is the
  shoe that controls, not the wellhead; tubing sizing for a loading
  well; and plunger lift as a static force balance with the required
  gas-liquid ratio computed from the work the gas actually does, with
  the industry screening rule of thumb reported alongside as a labelled
  cross-check and never as the verdict. Sucker-rod
  pumping (P6): rod string mechanics with the fractions read as
  fractions and Archimedes buoyancy, the tapered-string natural
  frequency solved as an eigenvalue problem rather than read off a
  table, the DAMPED WAVE EQUATION itself in both directions (a
  finite-difference predictive march for design and the Gibbs harmonic
  solution for reading a measured dynamometer card), exact four-bar
  pumping-unit kinematics with the torque factor as ds/dtheta,
  counterbalancing, and the rod stress check against modified Goodman.
  API RP 11L's dimensionless GROUPS are reported because they are how
  the answer is read, but its published CHARTS are not reproduced from
  memory: the equation those charts solve is solved directly instead,
  and the charts stay a literature gate. ESP sizing
  (P5): stage curves fitted from vendor points or built as transparent
  reference MODELS with named parameters (never invented vendor curves),
  affinity scaling, intake stream and gas handling from a supplied
  black-oil PVT set, total dynamic head as the pressure the pump adds,
  staging and shaft power, operating diagnostics, and the electrical
  side (motor current, copper cable drop, surface voltage and kVA). And
  the gas-lift
  installation engines (P4): gas properties (Sutton pseudo-criticals,
  Wichert-Aziz, DAK z, real-gas static casing column), bellows-valve
  mechanics (nitrogen dome charge across the test-rack/valve temperature
  step, the IPO/PPO force balance, test-rack settings, spread,
  Thornhill-Craver port throughput) and the top-down design itself
  (valve spacing, per-valve settings, the unloading sequence and the
  deepest point of gas injection). The flowing production traverse it
  needs is passed in as a depth-pressure table, so the well's inflow and
  multiphase outflow stay with the consumer's validated nodal model.
- Cross-directory imports: `engines/* -> ../../lib/*`, plus ONE
  sanctioned cross-domain edge: `engines/waterflood/patternForecast.js
  -> ../scal/fractionalFlow.js` (Buckley-Leverett displacement is the
  shared physics between the two domains).
- `lib/` — shared math the engines depend on (`waveform.js`,
  `gridding/`, `welltest/` — Stehfest inversion, radial Laplace
  models, and Levenberg-Marquardt fitting used by the aquifer and scal
  engines; the full welltest domain extraction will build on these). Historic note (see cross-directory rule above):
  `engines/* -> ../../lib/*`.
- `test-data/<domain>/` — committed goldens (byte-identical
  regeneration required).
- `tools/validation/<domain>/` — the Python oracles + `genfixtures.py`
  generators that produce the goldens (stdlib-only except
  `wells/`, which needs a lasio venv — see its README).
- `__tests__/` — smoke suite: every module imports cleanly and
  per-domain anchors match the goldens. The FULL acceptance suites
  currently run in the Suite's CI against the vendored copy
  (consolidation into this repo is a follow-on).

## Consumption (git subtree)

Both consumers vendor this repo at `packages/engines/`:

    git subtree add  --prefix packages/engines git@github.com:Petrolord/petrolord-engines.git main --squash
    git subtree pull --prefix packages/engines git@github.com:Petrolord/petrolord-engines.git main --squash

**Never edit the vendored copy in a consumer.** Changes land here via
PR (jest green, goldens regenerated byte-identical when an engine's
behavior legitimately changes), then each consumer subtree-pulls.

In the Suite, the original engine paths
(`src/pages/apps/<App>/engine/*`, `src/lib/waveform.js`,
`src/lib/gridding/*`) are one-line re-export shims into the vendored
package, so app code and tests import exactly what they always did.

## TypeScript engines

`engines/mbal/` is the package's first TypeScript domain (the MBAL server
engine, 2026-08-06). Imports keep explicit `.ts` extensions so the same
files load under Deno (Supabase edge functions), jest (babel
preset-typescript, see jest.config.cjs) and Vite consumers without a build
step. The full tiered MBAL validation harness (14+ literature cases, tier
promotion) remains Suite-side at tools/validation/mbal-validation.ts and
runs against this vendored engine through the Suite shim; __tests__/mbal
carries the portable literature anchors (Pletcher SPE 75354, Ahmed
Ex. 10-10 and 11-1).

## Moved from petrolord-suite (N1 log)

| Here | Was |
|---|---|
| `engines/seismolord/` | `src/pages/apps/Seismolord/engine/` |
| `engines/welldata/` | `src/pages/apps/WellDataManager/engine/` |
| `engines/petrophysics/` | `src/pages/apps/PetrophysicsStudio/engine/` |
| `engines/wellcorrelation/` | `src/pages/apps/WellCorrelation/engine/` |
| `engines/mapping/` | `src/pages/apps/MappingSurfaceStudio/engine/` |
| `engines/rockphysics/` | `src/pages/apps/RockPhysicsStudio/engine/` |
| `engines/earthmodeling/` | `src/pages/apps/EarthModeling/engine/` |
| `engines/porepressure/` | `src/pages/apps/PorePressureStudio/engine/` |
| `lib/waveform.js`, `lib/gridding/` | `src/lib/waveform.js`, `src/lib/gridding/` |
| `test-data/{wells,petrophysics,rockphysics,earthmodel,porepressure}` | same paths in suite |
| `engines/dca/arps.js` | `src/utils/declineCurve/dcaEngine.js` (pure math; `exportToLAS`/`exportToCSV` stayed in the Suite) |
| `engines/dca/typeCurve.js` | `src/utils/declineCurve/typeCurveEngine.js` (`fitTypeCurve` two-array call fixed — it never fit pre-extraction, zero consumers) |
| `engines/dca/groupRollup.js` | `src/utils/declineCurve/dcaGroupRollup.js` |
| `engines/dca/monteCarlo.js` | `src/utils/dcaMonteCarlo.js` |
| `test-data/dca/dca-literature-fixtures.json` | `src/utils/declineCurve/__tests__/fixtures/` |
| `engines/aquifer/aquiferInflux.js` | `src/utils/aquiferInfluxCalculations.js` |
| `lib/welltest/{numerics.js,models/radial.js,models/dualPorosity.js}` | `src/utils/welltest/` (same names) |
| `test-data/aquifer/dake92-we.json` | `src/utils/__tests__/goldens/dake92-we.json` (generator stays in the Suite: `tools/validation/gen-dake92-client-golden.ts`) |
| `engines/scal/fractionalFlow.js` | `src/utils/fractionalFlowCalculations.js` |
| `engines/scal/scal.js` | `src/utils/scalCalculations.js` |
| `lib/welltest/lmFit.js` | `src/utils/welltest/lmFit.js` |
| `engines/mbal/mbalEngine.ts` | `supabase/functions/_shared/mbal-engine.ts` (server engine; the Suite path is now a re-export shim bundled into the calculate-mbal edge function) |
| `engines/mbal/lm.ts` | `supabase/functions/_shared/lm.ts` (mbal's own Levenberg-Marquardt; coexists with lib/welltest/lmFit.js for now, unification is a later cleanup) |
| `test-data/mbal/dake-9-2.ts` | `tools/validation/fixtures/dake-9-2.ts` |
| `test-data/mbal/ahmed-ex-*.json` | `tools/validation/mbal-fixtures/` |
| `engines/waterflood/vrr.js` | `src/utils/vrrCalculations.js` |
| `engines/waterflood/waterflood.js` | `src/utils/waterfloodCalculations.js` (pure math; `parseWaterfloodCSV` stays in the Suite — papaparse) |
| `engines/waterflood/layeredSweep.js` | `src/utils/layeredSweepCalculations.js` |
| `engines/waterflood/patternForecast.js` | `src/utils/patternForecastCalculations.js` |
| `tools/validation/{wells,petrophysics,rockphysics,earthmodel,porepressure}` | same paths in suite |

Import rewrites at extraction: `engines/seismolord/synthetics.js` and
all `@/lib/*` imports became `../../lib/*` (the package has no `@/`
alias). Everything else moved verbatim.

Not yet here: BasinFlowGenesis engines (they live mixed into that
app's `services/` — normalization + move is a follow-on), Seismolord's
`test-data/seismolord` app fixtures (its engine tests stay in the
Suite for now).
