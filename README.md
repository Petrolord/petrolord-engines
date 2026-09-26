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
  The `stratigraphy` domain (2026-09-06, Stratigraphy Studio ST0) is
  vocabulary and time, no numerics: `vocabulary.js` holds the stored
  Catuneanu surface types and systems tracts (Catuneanu 2006; Catuneanu
  et al. 2009) with the Exxon terminology as a display-only label map
  (`displayLabel` flags fallbacks where Exxon has no term; nothing ever
  stores an Exxon code), marker line styles per surface type, and the
  tract a pair of surfaces bounds (`expectedTract`); `timescale.js` is
  the ICS International Chronostratigraphic Chart v2023/09 (CC BY 4.0)
  with lookups by name and by age; `column.js` orders and validates a
  lithostratigraphic unit tree. ST1 (2026-09-06) added `lithology.js`
  (lithology, Wentworth grain size and depositional-environment
  vocabularies with tolerant resolution of mud-log abbreviations, and the
  interval kinds the registry stores) and `intervals.js` (interval-log
  arithmetic: validation per kind, rasterizing onto a depth vector for
  the strip track, run-length encoding a categorical curve back into
  intervals). Goldens are analytic (lookup tables and boundary guards
  pinned from the chart itself). The `welldata` domain's `lasBlocks.js`
  maps LAS 3.0 core and lithology blocks (which `lasParse.js` now hands
  back as `blocks`) to interval rows through the stratigraphy vocabulary:
  the second sanctioned cross-domain edge, welldata -> stratigraphy, with
  a generator-written golden (`las3_intervals_30.intervals.json`). ST2
  (2026-09-06) added `ageDepth.js` (piecewise-linear age-depth model with
  hiatuses, ageAt / depthAt / rates), `wheeler.js` (the chronostratigraphic
  chart: deposition and hiatus cells per well labelled with the tract the
  bounding surfaces imply), `stretch.js` (stratigraphic flattening between
  two surfaces as a {fwd, inv} mapping the section engine's
  `displayedDepth` now accepts) and `sequence.js` (systems tracts from
  typed surfaces, stacking from motifs). Golden: the hand-derived
  three-well synthetic in `test-data/stratigraphy/` (README there). ST3
  (2026-09-06) added `basinLayers.js`: a Basin & Charge Modeling layer
  table (youngest first, Basin's lithology list, deposition ages from the
  bounding surfaces, an unconformity's hiatus ending deposition below it,
  erosion events with the amount declared unknown) from a well's dated,
  typed tops and its lithology log; placeholders and flags where a layer
  is undated, never invented ages. ST4 (2026-09-06) added `stratMaps.js`:
  control points for stratigraphic maps between two tops (gross thickness,
  net thickness of a lithology family from the interval log, net-to-gross)
  and the dominant depositional environment per well, with every skipped
  well named by reason; thicknesses are measured-depth thicknesses. ST5
  (2026-09-06) reached into the `seismolord` domain: `extractStratalSlice`
  in `horizonAmplitude.js` (the amplitude at a proportional position
  between two horizons, ends identical to the single-horizon value
  extraction, the interval attribute's span walker) and `flatten.js`
  (per-trace offsets that hang a section on a horizon, a median datum;
  the renderer applies them in the shader, never to stored data).
  Seismolord structure attributes (2026-09-23): `structureAttributes.js`
  adds Sobel edge and the gradient structure tensor family (dip magnitude,
  dip azimuth in the lattice frame, chaos, most positive and most negative
  curvature after Al-Dossary and Marfurt 2006) as regional
  `DISCONTINUITY_DEFS` entries that `makeDiscontinuityJob` builds a brick
  column at a time over `structureHalo`, and `attributes.js` gains
  spectral decomposition (the `isofrequencyAt` kernel at every sample) and
  relative acoustic impedance. Golden: the self-asserting numpy oracle
  `test-data/seismolord/structure/gen_structure.py`; the column and whole
  volume runs are proven equal in `seismolord.structure.test.js`.
  Follow-up (2026-09-23): `azimuth_north` (Dip azimuth, grid north) maps
  the time gradient through the survey affine (G = J^-T g), so rotation,
  unequal bins and skew are honoured; it needs `volume.affine` and refuses
  the legacy two-corner fallback. `spectralTrace` computes interior
  windows from three prefix sums (Hann = three exponentials), O(1) per
  sample, equal to `isofrequencyAt` within 1e-9 of peak and about 20x
  faster at a 400 ms window (`seismolord.geoazimuth.spectral.test.js`).
  The `fluid` domain (2026-08-28) is the PVT backbone, and it holds two
  layers that are deliberately not merged. `blackOil.ts` carries the
  correlation set -- Standing / Vasquez-Beggs / Glaso for Pb, Rs and Bo,
  Hall-Yarborough and Dranchuk-Abou-Kassem for gas z, McCain for water,
  Beal + Beggs-Robinson + Vasquez-Beggs for oil viscosity and
  Lee-Gonzalez-Eakin for gas -- each with the published training range
  attached, so a number produced outside the range a correlation was
  fitted over is reported as such rather than quietly used. Everything
  else is the Peng-Robinson (1978) compositional engine the Suite's
  Fluid Systems Studio was built on: `components` (Whitson & Brule
  Monograph 20 library with Jhaveri & Youngren shifts and BIPs), `pr78`,
  `flash` (Michelsen stability + SS/GDEM with a safeguarded
  Rachford-Rice), `characterization` (single C7+ pseudo: Soreide,
  Kesler-Lee, Lee-Kesler, Firoozabadi, modified Chueh-Prausnitz),
  `envelope`, `separator` (sequential per-stage flash to stock tank),
  `experiments` (CCE, differential liberation, and the Amyx composite
  black-oil table an EOS fluid hands to a simulator), `transport` (LBC
  viscosity + Weinaug-Katz IFT) and `tuning`/`labTune` (four bounded
  C7+ knobs regressed to lab targets on the shared LM kernel).
  Goldens are an independent Python oracle (`tools/validation/fluid/`,
  which reaches the same numbers by different routes -- bisection rather
  than Cardano for the cubic, residual-Helmholtz quadrature rather than
  closed-form fugacity, Maxwell equal areas rather than successive
  substitution for Psat) plus NIST vapor pressures and three published
  anchors: Whitson & Brule Monograph 20 App. B Problem 18, the eight
  Coats & Smart SPE 11197 fluids, and Good Oil Well No. 4 (Core Labs
  RFL 88001).
  The `production` domain (2026-08-28) holds eight families. Well
  intervention diagnostics (P12), whose organising idea is that THE
  DIAGNOSIS DECIDES THE TREATMENT: water channelling is a plumbing
  problem and a squeeze has something to seal, while water coning is
  not and the cone simply re-forms above whatever was plugged. Every
  screening rule is therefore gated by the diagnosis, and a candidate
  the diagnostic argues against comes back as a refusal with the reason
  rather than quietly scored lower. Chan's published type curves are
  NOT transcribed; what is here reads the same two things Chan reads,
  the trend of the ratio and the sign and steepness of its derivative,
  with every threshold a named input. The derivative itself is passed
  in, because the consumer already has a validated Bourdet one and a
  second would be a second thing to be wrong. Plus the skin group
  ln(re/rw) - 3/4 + S, which refuses the skin at which the productivity
  index goes infinite instead of returning a spectacular uplift. The
  gathering-network solver (P11), which is the one module here with no
  petroleum in it at all: nodes, branches, a Newton solve on nodal mass
  balance, and the branch relations supplied as CALLBACKS. That is
  deliberate, and it is what makes it checkable without judgement --
  hand it linear resistances and the network collapses to a weighted
  graph Laplacian whose answer is a matrix inverse, so Newton iteration
  and Gaussian elimination have to agree to machine precision. They do.
  Mass is the currency throughout, because surface volumes do not add
  across pressures. Plus line pipe geometry, whose schedule table
  carries od, wall AND bore so that it can catch its own transcription
  errors. Flow
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
  And nodal analysis itself (2026-09-04), which is the root the other
  seven hang off: oil inflow (straight-line PI, Vogel, the Standing
  composite, Fetkovich, Jones-Blount-Glaze, with calibration from a
  production test and the published depletion rule for each family),
  gas deliverability (Rawlins-Schellhardt and Houpeurt, both with the
  closed-form inverse the empirical families admit), the dry-gas
  Cullender and Smith column, and the operating point where inflow and
  outflow cross. The solver takes the two curves as FUNCTIONS and knows
  nothing about what made them, which is what lets a consumer hand it a
  Beggs-Brill or Hagedorn-Brown traverse from its own PVT stack and what
  lets the gates hand it curves whose crossing is closed-form algebra.
  It returns EVERY crossing with its stability, because a J-shaped
  outflow can cross a falling inflow twice and only the right-hand
  crossing is a well that stays put; the reported operating point is the
  rightmost stable one and is gated as its own value. Two results worth
  knowing came out of the oracle: the published two-station Cullender
  and Smith construction is 11.6 psi low on a friction-dominated gas
  well (so `steps` is an input, defaulting to the published two), and a
  40-point crossing scan stops seeing a well whose two crossings have
  pinched together as it approaches loading up.
  And the SURVEILLANCE AND ALLOCATION half of the domain (2026-09-04),
  which is what an operations engineer actually spends the day in.
  BACK ALLOCATION: a facility meters one commingled stream, so what is
  booked against each well is an arithmetic split, not a measurement.
  The metered total is distributed in proportion to what each well was
  CAPABLE of producing -- its latest valid test scaled by the hours it
  was on -- and the factor that falls out is the OUTPUT, never
  normalised to one and never clamped into its warning band, because a
  persistently high or low factor is the disagreement between the
  tests, the meter and the uptime record that the engineer is looking
  for. A date with no metered total is not allocated, and a well with no
  test in force takes no share rather than a guessed rate. The gate that
  matters is CLOSURE: the allocated volumes sum back to the meter
  exactly, every day and every phase. Plus well-test data QC against the
  well's own history and the ledger on the test date, and the nodal
  cross-check of a test against what its own well model says it should
  have made at that wellhead pressure. SURVEILLANCE: the discipline of
  saying which wells to go and look at today -- a recent window against
  a baseline window on the same well, every window anchored on the
  FIELD's own latest ledger date rather than the wall clock (so an old
  dataset surveils honestly) and WIDENED when the ledger is coarse, so a
  monthly ledger is not silently compared one month against nothing.
  Zero hours on stream is a null producing-day rate and never Infinity.
  Decline overlays call the canonical Arps engine rather than re-deriving
  it. ARTIFICIAL LIFT SCREENING AND THE DESIGN PASS: the six-method
  rules matrix is labelled as operating guidance and nothing in it is
  derived from anything, while the design pass runs each method's real
  chain against ONE shared well record and reports the equipment each
  would cost; where the two disagree the DESIGN wins, and the
  disagreement is surfaced rather than resolved. A design that reaches a
  third of the target is a SHORTFALL with its achieved rate stated, never
  a success. Six results came out of these oracles and all are open owner
  decisions: the module reads a period water cut and GOR two
  incompatible ways in two of its own functions (a mean of daily ratios
  in the exception detector, volumetrically in the KPIs) and on the
  golden well the gap changes the SEVERITY a studio prints; the same
  target rate is documented as liquid by the screening and used as oil by
  the design pass; a missing API is coerced to zero and read as heavier
  than any real crude; the ESP reference-stage ranges overlap so the pick
  is decided by catalog order; the motor pick falls back to a frame that
  does not meet its own headroom rule; and the rod-loading guard fails
  open on an unknown loading.
- Cross-directory imports: `engines/* -> ../../lib/*`, plus the
  sanctioned cross-domain edges listed here (wellsite -> drilling for
  `tvdAt`, `mdsAtTvd`, `computeWellPath`, `wellVolumes` and `annulusCapAt`,
  and wellsite -> stratigraphy for the lithology and grain-size tables,
  both added 2026-09-06 for the Wellsite Studio WS series: annular volume,
  minimum curvature and the lithology vocabulary each exist once), TWO
  older sanctioned cross-domain edges: `engines/waterflood/patternForecast.js
  -> ../scal/fractionalFlow.js` (Buckley-Leverett displacement is the
  shared physics between the two domains) and
  `engines/production/surveillance.js -> ../dca/arps.js` (the decline
  overlay calls the CANONICAL Arps engine; a second decline
  implementation would be a second thing to be wrong).
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
  `mapping/oracle_structure_points.py` (2026-09-05) writes the
  structure-map goldens: tops placed through the well's depth frame
  (TVDSS elevation at the borehole position, closed-form build-and-hold
  wells) and a dipping plane that TPS gridding must reproduce; the
  elevation convention for every depth surface (negative below datum,
  m or ft per `z_unit`) is an owner decision recorded there.
  Mapping T1 (2026-09-26, the Suite's senior test of the Mapping &
  Surface Studio) added `mapping/oracle_closure.py` (closures above a
  contact, spill to the map boundary by union-find, fill-spill merges),
  `mapping/oracle_tension.py` (splines in tension: K0 by integration and
  series, dense solve) and `mapping/oracle_welltie.py` (closed-form linear
  velocity), gated by `__tests__/mapping.t1.test.js` with
  `negcontrol_t1.sh` (30/30 engine plants red); modules
  `lib/gridding/closure.js`, `lib/gridding/tensionSpline.js`,
  `engines/mapping/wellTie.js`, plus `mergeCloseControls` and
  `mask: 'none'` in `lib/gridding/gridding.js`. Decisions in
  `mapping/FINDINGS-t1.md`.
  Earth Modeling T1 (2026-09-26) added `earthmodel/oracle_contacts.py`:
  `zoneVolumesWithContacts` in `engines/earthmodeling/volumes.js` cuts each
  node's zone interval by the GOC and OWC (one depth or one per block),
  sums HCPV over the gas and oil columns only, and gives STOIIP and GIIP
  from Bo and Bg; a radial integral anchors the grid sums within 1%; gated
  by `__tests__/earthmodel.contacts.test.js`, `negcontrol_contacts.sh`
  7/7 red.
  Risked Reserves Valuation T1 (2026-09-26) added `engines/prospect/`
  (`valuation.js`): success-case lognormal through P90 and P10, Swanson's
  mean, P(V >= MEFS) and commercial chance, EMV after the exploration well
  from the lognormal partial expectation, break-even Pg, the risked
  expectation curve and an independent-prospect portfolio; oracle
  `prospect/oracle_valuation.py` (statistics.NormalDist and a numerical
  integral), gated by `__tests__/prospect.valuation.test.js`,
  `negcontrol_valuation.sh` 9/9 red.
- `__tests__/` — smoke suite: every module imports cleanly and
  per-domain anchors match the goldens. The FULL acceptance suites
  currently run in the Suite's CI against the vendored copy
  (consolidation into this repo is a follow-on).

- `engines/wellsite/` — Wellsite Studio (the WS series, plan of record
  in the Suite at docs/scope/WellsiteStudio-PLAN.md). WS0 (2026-09-06)
  added `depth.js` (the mandatory depth structure: value, unit,
  reference, datum and kind; canonical metres MD below KB with the
  calculated TVD and subsea depth, the survey version and the method
  recorded, datum shifts as a length along the vertical surface hole,
  refusal of ambiguous or unreachable TVD entries; sits on the drilling
  survey math), `time.js` (UTC plus rig offset, tour and report-day
  boundaries by arithmetic, never the machine timezone) and `pumps.js`
  (triplex and duplex displacement per stroke). Goldens from a stdlib
  oracle (`tools/validation/wellsite/oracle_ws0.py`, longhand minimum
  curvature for the build section, textbook cylinder geometry). WS1
  (2026-09-07) added `descriptionVocabulary.js` (the controlled cuttings
  vocabulary: colour hue and modifier, hardness, texture, sorting,
  rounding, cement, accessories, fossils, porosity and its types, amounts,
  with the lithology and grain-size tables reused from stratigraphy; the
  ATTRIBUTES order every screen and renderer follows; tolerant term
  resolution; validation with a percent-sum tolerance; describe by
  exception through copyPrevious and diffDescriptions; the registry
  publish shape) and `abbreviations.js` (the Petrolord default profile,
  operator house-style profiles as display rules over the stored codes
  with fallback reporting, the abbreviation string and the narrative).
  Golden hand-derived (`test-data/wellsite/description-goldens.json`).
  WS2 and WS3 (2026-09-07) added `events.js` (the seventeen operational
  event types, start and end-later, overlap validation, period clipping
  and time by type), `lag.js` (strokes-based lag on the drilling
  `wellVolumes`: string built to the bit, survey extended to the bit,
  annulus rows with the casing flag, the piecewise-constant pump log
  integrated for strokes and for the time strokes take, bit-depth history,
  arrival prediction and the lagged depth now by bisection on a monotone
  function) and `sampleProgram.js` (versioned authorised programme,
  scheduled depths, stage lifecycle with mandatory stages, due and overdue
  states that never say "missed", in-transit and expected arrivals).
  Lag goldens from a stdlib oracle (`tools/validation/wellsite/oracle_lag.py`)
  for the three mandatory reference cases plus a casing-shoe-and-BHA case,
  with the hand numbers in `test-data/wellsite/README.md`. Floating rigs
  (2026-09-07, tester note): the lag runs in two legs, bit to BOP on the
  main pump and the marine riser on main plus booster; the riser is one
  row above the hole sections, the pump log carries `boosterSpm`, and the
  land-rig case is the floater with no riser (G5 steady, G6 booster
  switched on mid-lag). WS4
  (2026-09-07) added `shows.js` (controlled show values for fluorescence,
  cut, stain, odour and residue; the derived quality by a published
  scoring rule, never typed; indicator wording that never claims a
  determination). Golden hand-derived (`show-goldens.json`). WS5
  (2026-09-07) added `tops.js` (interpretation and official call as
  separate version chains, the status lifecycle and its transitions,
  heads, current call and interpretation with competing heads surfaced,
  conflicts of two heads or two finals, the approach panel with
  distances in MD and TVD on the depth engine, and the registry publish
  shape of a final call). Analytic in-test goldens. WS7 and WS8
  (2026-09-07) added `reports.js` (the shift handover and the daily
  geological report as models generated from records: a JSON-driven
  template of sections, each fact citing the record ids it came from,
  narratives read from narrative records, tour and report-day periods,
  the canonical form a sign-off hashes). Golden: a synthetic report day
  written by `tools/validation/wellsite/gen_report_day.py` with the
  expected counts worked by hand in the test-data README.

- `lib/conventions/percentile.js` — the Suite-wide percentile conventions
  (owner decision 2026-09-09): P-labels mean probability of exceedance of an
  OUTCOME where more is better (SPE PRMS), P90 the low case, shown low to
  high; parameters and more-is-worse quantities never carry a P-label and use
  "10th / 50th / 90th percentile". Moved here 2026-09-14 from the Suite's
  `src/lib/percentileConventions.js` (which becomes a re-export shim) so the
  NextGen courses import the same words as the apps. Words and gate helpers
  only (`findPLabels`, `outcomeOrderViolation`), no numerics.

- `engines/downstream/` — the Midstream & Downstream module (M&D DS0 to
  DS10, 2026-08-29), eleven modules: `streamModel.js` (the shared
  product and stream vocabulary), `crudeAssay.js`, `productBlending.js`
  and `refineryPlanning.js` (both solved as linear programmes on
  `lib/lp/simplex.js`), `modularRefinery.js`, `terminalDepot.js`,
  `fuelPricing.js`, `lpgCng.js`, `energyEfficiency.js`,
  `carbonAbatement.js` and `flareToValue.js` (which reuses
  `engines/production/gasProperties.js` and
  `engines/facilities/compression.js`). The DS waves wrote these
  straight into the Suite's vendored copy of this package and never
  upstreamed them, so every `git subtree pull` into the Suite saw them
  as deleted upstream; they were moved here byte for byte on 2026-09-14
  with their twelve test files, which are self-consistency identities.
  `lib/lp/simplex.js` is the dense simplex solver (`solveLP`,
  `LP_STATUS`) the two LP modules share. VALIDATION (MD-0, per course
  wave): MD1-0 (2026-09-19) put `crudeAssay.js`, `productBlending.js`
  and `simplex.js` behind stdlib oracles in `tools/validation/downstream/`
  (the LP by exact rational vertex enumeration), goldens in
  `test-data/downstream/goldens/`, the gates
  `downstream.crudeAssay.golden`, `downstream.productBlending.golden`
  and `lp.simplex.golden`, and a planted-defect battery
  (`negcontrol_md1.sh`); findings in `FINDINGS-crude.md`. The other
  eight modules have no oracle yet and stay gated for their courses.
  MD2-0 (2026-09-19) did the same for `refineryPlanning.js`,
  `streamModel.js` (the variance) and `modularRefinery.js`: oracles
  `oracle_refineryplanning.py` (on `exact_simplex.py`, a rational simplex
  that returns only certificate-proved optima) and
  `oracle_modularrefinery.py`, gate `downstream.refinery.golden`, battery
  `negcontrol_md2.sh`, findings `FINDINGS-refinery.md`. It added the
  opt-in `lossCarryForward` to `engines/economics/screening.js`.
  MD5-0 (2026-09-19, run beside MD4-0) did the same for
  `carbonAbatement.js` and `energyEfficiency.js`: oracles
  `oracle_carbonabatement.py` (combustion by mass, a levelised PV ledger)
  and `oracle_energyefficiency.py` (a species ledger whose mass balance
  must close, pinch by the largest heat deficit), gate
  `downstream.carbon.golden`, battery `negcontrol_md5.sh`, findings
  `FINDINGS-carbon.md`.
  MD3-0 (2026-09-19) did the same for `terminalDepot.js` and
  `fuelPricing.js`: oracles `oracle_terminaldepot.py` (strapping from tank
  geometry, exact factorial Erlang C) and `oracle_fuelpricing.py` (a cargo
  invoice, insurance on CIF by fixed point), gate `downstream.supply.golden`,
  battery `negcontrol_md3.sh`, findings `FINDINGS-supply.md`. The three
  Commercial & Trading course engines (MD1 to MD3) are now all gated.
  MD4-0 (2026-09-19): `flareToValue.js` and `lpgCng.js`, oracles
  `oracle_flaretovalue.py` and `oracle_lpgcng.py`, gate
  `downstream.gasvalue.golden`, battery `negcontrol_md4.sh`, findings
  `FINDINGS-gasvalue.md`.
  COPY SWEEP (B3, 2026-09-21): live NextGen lessons quote downstream
  engine strings verbatim, so the domain's user-facing strings were swept
  for the owner's copy rule (no contrastive "X, not Y", "rather than",
  "instead of", "is not a Z", or a capitalised NOT). Strings only: no value
  moved. `terminalDepot.rackQueue` takes an optional `vocabulary` (its two
  refusal sentences); the loading rack keeps `RACK_VOCABULARY`, and the
  bottling carousel (`BOTTLING_QUEUE_VOCABULARY`: filling positions), the
  CNG forecourt (`CNG_QUEUE_VOCABULARY`: dispensers) and the petrol
  forecourt (`FORECOURT_QUEUE_VOCABULARY`: nozzles) speak their own. The
  gate `downstream copy: no contrastive shapes` in
  `__tests__/engine.copy.lint.test.js` reads every downstream string
  literal and holds the domain clean.

- `engines/economics/` — the Economics module (EC0 extraction wave,
  2026-09-08; plan of record in the Suite at
  docs/scope/NextGen-Remaining-Courses-PLAN.md section 8, which gated
  every Economics course on this extraction). Twelve modules, every one
  VERBATIM from the Suite with only imports repointed, each with a
  stdlib python oracle under `tools/validation/economics/` and goldens
  under `test-data/economics/goldens/`: `cashflow.ts` (the Petroleum
  Economics Studio cash flow engine, v3.9.0: JV, PSC with cost-recovery
  carryforward, tranches and ITC, the Nigerian PIA 2021 cascade and the
  NTA 2025 framework switch, allowances with volume caps, CPR
  forfeiture, tax-loss carryforward, economic limit, abandonment,
  decision KPIs, breakeven price; year-end discounting on a real or
  nominal basis; since engines 3.12.0 (EC7) the PIA / NTA path follows
  the gazetted PIA 2021, NTA 2025, Petroleum Royalty Regulations 2022 and
  Finance Act 2023 by default, gated by the text-derived oracle
  `oracle_pia2021.py`, `__tests__/economics.pia2021.test.ts` and
  `negcontrol_pia2021.sh`, with the single documented input
  `pia_legacy_pre_audit: true` reproducing every pre-audit result, see
  `tools/validation/economics/AUDIT-PIA-2021.md` and
  `tools/validation/economics/FINDINGS-pia2021.md`) and `montecarlo.ts` (the seeded Monte Carlo over it),
  both TypeScript like `engines/mbal` because they are DEPLOYED AS
  SUPABASE EDGE FUNCTIONS and bundle through the Suite's shims;
  `screening.js` (the client screening economics: exponential decline,
  JV / PSC, straight-line depreciation, MID-YEAR discounting,
  sensitivity, scenarios); `fiscalRegime.js` + `fiscalTemplates.js`
  (the Fiscal Regime Designer: concession, PSC with a cost pool, sliding
  royalty, R-factor tranches, RRT with uplift, bisection IRR, regime
  comparison and insights); `breakeven.js` (bisection breakeven price
  and the seeded probabilistic breakeven); `decisionTree.js` (EMV
  rollback, EVPI, Bayes-derived EVII, implied priors, information
  trees), `voi.js` (the VOI Analyzer over it) and `portfolio.js`
  (risked-EMV 0/1 knapsack on a capex grid, efficient frontier, mixture
  moments, correlated portfolio variance); `fdp/` (the FDP Accelerator's
  twelve calculation modules: case economics through screening.js,
  costs, scenarios, concepts, subsurface, wells, facilities, HSE, risks,
  schedule, completeness); `afe.js` (partner cost split with the
  validity rule, AFE cost-control metrics and the S-curve) and
  `projectControls.js` (earned value). The oracles reach every number by
  a different road (closed-form declines, bracket-scan IRR, exact
  rational rollback, brute-force knapsack over all subsets, a second CPM
  pass, mulberry32 replicated in uint32 arithmetic so seeded samples
  reproduce element for element) and compute EVERY reported summary.
  Where engine and oracle disagree the golden carries BOTH numbers and
  the gate pins the gap; the four `FINDINGS-*.md` files record them for
  the owner (the screening IRR reports its 1000 percent Newton clamp as
  the answer on profiles whose only root is negative or beyond the
  clamp; the knapsack grid can pick a set over the limit or 23 percent
  short; `calculateCPM` is a passthrough; the NPV profile point at the
  applied rate is evaluated at a rate rounded to two decimals).
- `engines/assurance/` — the Assurance & Compliance module (AS12
  extraction wave, 2026-09-18; plan of record in the Suite at
  docs/scope/Assurance-ROADMAP.md, which gated both NextGen assurance
  courses on this extraction). Rules, not numerics: nine modules taken
  from the Suite's `src/lib/` with the UI colour tokens left behind
  (every `*_TOKENS`, `*_CHART_COLORS` and the risk band class helpers
  stay Suite-side) and imports repointed; everything else verbatim.
  `riskScoring.js` (ISO 31000 5x5 score, bands, residual as inherent
  until assessed, appetite, review dates), `complianceStatus.js`
  (obligation status: expired outranks overdue, due soon inside the
  obligation's own lead time, compliant only with evidence; roll
  forward), `documentControl.js` (review due calculus, revision
  numbers, confidentiality floor), `peerReview.js` (comment disposition
  transitions; a review cannot close over an unresolved Critical or
  Major comment), `managementOfChange.js` (temporary change expiry,
  every approval level signs before implementation, action closure),
  `qualityAssurance.js` (hold points, checkpoint decisions carry a
  verification record, NCR closure on evidence and CAPA effectiveness,
  plan closure, NCR ageing), `isoCompliance.js` (conformity claims need
  evidence, date and assessor; ISO 19011 independence; clause coverage
  over the certification cycle; certification readiness as a list of
  blockers, never a percentage; ISO 9001 10.2 finding closure),
  `lessonsLearned.js` (an anecdote is not a lesson, an author may not
  validate their own, Embedded is earned by an application) and
  `auditManagement.js` (checklist completeness, critical nonconformance
  raises a finding, lead auditor is not the auditee, a programme is
  complete when its audits are; the finding rules are isoCompliance's,
  imported). `calendar.js` is the one copy of the calendar date helpers
  five Suite modules each carried byte for byte (a `YYYY-MM-DD` parses at
  LOCAL midnight; AS3 found a UTC parse that moved a permit expiry by a
  day). Gates: the Suite's rule tests ported (`assurance.*.test.js`),
  and `assurance.goldens.test.js`, which runs every case in
  `test-data/assurance/goldens/` against the engine and replays them all
  under five time zones. The goldens are written by stdlib python
  oracles in `tools/validation/assurance/`, from the rules as documented
  rather than from the JavaScript, and they compute every summary
  (1,745 cases). The oracles found thirteen engine defects, all repaired
  in the same wave and each pinned by `"repaired"` cases: impossible dates
  rolling over into real ones and years below 1000 misprinted
  (calendar), a UTC parse that made a review due today overdue west of
  Greenwich and a blank residual axis scoring 0 (risk), unreadable dates
  reading "due soon" or passing the temporary change gate (documents,
  MOC), a null severity sorting above Critical and "A open comment"
  (peer review), a non-transitive lesson sort, and in ISO the dashboard
  ignoring each standard's certification cycle, findings ageing after
  closure and a 29 February cycle start rolled to 1 March. The
  `FINDINGS-*.md` files keep the owner questions that were not changed.
- `engines/hse/safetyStats.js` (HSE H1, 2026-09-19): incidence, FAR,
  severity and API RP 754 PSE rates with the base always named by the
  caller (200,000 OSHA/BLS, 1,000,000 IOGP, 100,000,000 FAR); pooled and
  rolling rates, sum-then-divide, with the mean of period rates shown
  beside them; the Garwood exact Poisson interval (its own inverse
  regularised gamma, gated to 1e-10 against mpmath and scipy); the
  conditional exact comparison of two rates; the u-chart. Goldens in
  `test-data/hse/goldens/` from `tools/validation/hse/oracle_safetystats.py`
  (scipy + mpmath, not stdlib), anchored on the BLS worked example and
  IOGP 2024 published figures; findings and the negative control in
  `tools/validation/hse/`.
- `engines/hse/exposure.js` (HSE H2, 2026-09-19): occupational hygiene
  exposure, written here first. Noise dose, reference duration and TWA
  per 29 CFR 1910.95 Appendix A with OSHA PEL, OSHA action level and
  NIOSH REL presets (each carries the TWA constant its source prints,
  16.61 or 10.0), the OSHA extended-shift action level, hearing protector
  estimates (Appendix B, the OTM 50 percent field derating and dual
  protection, NIOSH type derating), LEX,8h, weekly LEX and HSE exposure
  points, the 1910.1000(d) 8-hour TWA and mixture index, the 15-minute
  STEL, Brief and Scala factors, WBGT and the NIOSH 2016 RAL/REL. No
  licensed limit table is embedded: limits are inputs. Gate:
  `hse.exposure.test.js` replays `test-data/hse/goldens/exposure_cases.json`
  (written by `tools/validation/hse/oracle_exposure.py`) against the
  engine, checks 372 cases against the value the source prints, pins
  five published errata and 57 refusals by field name;
  `tools/validation/hse/negcontrol_exposure.sh` records what the gate can
  and cannot catch (the heat-limit equations and WBGT weights have no
  printed value that reproduces them, so a change made to both engine and
  oracle passes).
- `engines/hse/lopa.js` (HSE H3, 2026-09-19) — Layer of Protection
  Analysis and SIL determination / verification: scenario frequency
  (CCPS 2001: IEF x conditional modifiers x credited IPL PFDs), required
  RRF and SIL against a supplied TMEL with explicit NO_SIF_REQUIRED,
  below-SIL1 and BEYOND_SIL3_REDESIGN states; low-demand PFDavg by the
  full IEC 61508-6:2010 Annex B simplified equations (1oo1, 1oo2, 2oo2,
  2oo3, 1oo3; DD/MTTR, MRT, beta/betaD, optional proof test coverage),
  which reduce to the ISA-TR84.00.02 forms; proof test interval
  sensitivity and the longest interval meeting a target. No failure-rate
  data and no architectural-constraint table are embedded. Goldens
  (`test-data/hse/goldens/lopa_cases.json`): the 61508 Association worked
  SIF (Dolan 2024) to every printed digit, plus an exact-rational oracle
  and a time-dependent quadrature route (`tools/validation/hse/`,
  FINDINGS-lopa.md, negcontrol_lopa.sh). Follow-ups from the course
  builds (2026-09-21): one exported `BAND_CONVENTION` is printed by
  `silFromPfdAvg`, `lopaScenario` and `pfdAvgSubsystem`;
  `maxProofTestInterval` refuses a floor of PFDavg 1 or more as
  `pfdAvgSubsystem` does (golden `maxT-refused-floor`); the three goldens
  that carry the rare-event warning are documented and gated.
- `engines/hse/consequence.js` (HSE H4, 2026-09-19): consequence
  modelling. Liquid and gas orifice discharge (choked at or above the
  critical ratio), bunded pool from a spill, Mackay-Matsugu evaporation,
  Gaussian plume with Briggs rural sigmas and the distance to a
  concentration, pool burning rate, Thomas flame length (still-air form
  shared with facilities/spacing.js), tilt, surface emissive power, the
  tilted-cylinder view factor, Bagster transmissivity, the solid-flame
  pool fire, TNT equivalence with Kinney-Graham overpressure, and
  thermal, toxic and overpressure probits. It exports none of the
  point-source radiation outputs FC1 and FC5 grade. Gate:
  `hse.consequence.test.js` replays
  `test-data/hse/goldens/consequence_cases.json` (written by
  `tools/validation/hse/oracle_consequence.py`); findings, errata and
  dropped scope in `tools/validation/hse/FINDINGS-consequence.md`.
- `engines/hse/qra.js` (HSE H5, 2026-09-19): quantitative risk
  assessment. Event trees with every branch set checked to sum to 1 (and
  a flammable-release builder with the Purple Book 0.6 / 0.4 flash fire /
  explosion split and its Table 4.5 direct ignition), location-specific
  individual risk, IRPA over occupied locations, PLL, FAR on the
  safetyStats 1e8 base, F-N curves ("N or more") against the Purple Book /
  Bevi line F = 1e-3 / N^2 or the single R2P2 point (50 deaths, 1 in 5000),
  R2P2 ALARP banding with a stated boundary convention, cost-benefit with
  the HSE gross disproportion test (cost / benefit > DF; VPF and DF are
  inputs; discounting through the canonical `economics/cashflow.ts` npv),
  the Purple Book indoor / outdoor fatality fractions, and the H4 link:
  the toxic plume probability of death at a grid point (PB Appendix 6.B)
  and pool fire probit transects into IR contours. Gate:
  `hse.qra.test.js` replays `test-data/hse/goldens/qra_cases.json`
  (written by `tools/validation/hse/oracle_qra.py`); findings, errata,
  dropped scope, the fail-opens closed and the negative controls in
  `tools/validation/hse/FINDINGS-qra.md` and `negcontrol_qra.sh`. It
  re-grades nothing: point-source flare and pool radiation stay with FC1,
  FC5 and `engines/facilities/`, and the probits, plume and solid flame
  stay with `engines/hse/consequence.js`. The IRPA occupancy-sum refusal
  names the field the caller typed (occupancyFraction, hoursPerYr, or both;
  2026-09-21).
- `engines/dataai/quality.js` (Data & AI D1, 2026-09-23): oilfield data
  quality for the Data Quality Studio and the `dataqc` course.
  Completeness (null fraction, gap runs, coverage of an interval),
  validity (caller or definitional range limits keyed by unit and never
  converted, depth/time index duplicates, reversals and irregular steps,
  negative rates, rate while shut in), consistency (cumulatives
  non-decreasing, liquid-basis water cut, phase sums, frozen runs),
  uniqueness (stated identifier normalisation, Levenshtein, a digit rule
  so two real wells are not called near duplicates), univariate outliers
  (z on the sample SD with its (n - 1)/sqrt(n) ceiling, sqrt(n - 1) for
  the population option, Iglewicz-Hoaglin
  modified z at 0.6745 / 3.5 (refused when MAD = 0, which happens exactly
  when more than half the present values equal the median), Tukey fences on Hyndman-Fan R6/R7/R8
  quantiles, Hampel through the petrophysics `despikeHampel` (which
  expects NaN for a missing sample: a null input comes back as 0 at that
  position; audited 2026-09-23, no live caller passes null, see
  FINDINGS-quality.md open question 1), Grubbs with
  its own incomplete beta and t quantile), Mahalanobis with the
  safetyStats chi-square quantile, Shewhart individuals/MR, EWMA and
  tabular CUSUM charts, and a weighted scorecard. Every flag carries its
  rule and reason (figures printed as the shortest round-trip decimal, so
  each parses back to exactly the field it quotes); every refusal names
  its field. Gate:
  `dataai.quality.test.js` replays `test-data/dataai/goldens/quality_cases.json`
  (written by the stdlib oracle `tools/validation/dataai/oracle_quality.py`,
  anchored on the NIST/SEMATECH e-Handbook worked examples in 1.3.5.17.1,
  6.3.2.2, 6.3.2.3, 6.3.2.4 and 7.2.6.2) and the numpy/scipy/statsmodels/
  pandas pins in `test-data/dataai/pins/` (`pin_quality.py`); findings,
  errata and the negative control in `tools/validation/dataai/`.
- `engines/dataai/ml.js` (Data & AI D2, 2026-09-24): machine learning on
  well data for the ML Workbench and the `mlcore` course. Standard and
  min-max scalers fitted on training rows only (population SD, a constant
  feature refused by name); seeded group split, group k-fold (round robin
  after a mulberry32 shuffle) and a random row split that exists only to
  show leakage; OLS by equilibrated Householder QR with two steps of
  iterative refinement in double-double (coefficients, standard errors,
  residual SE, R^2, adjusted R^2, raw and scaled condition numbers;
  refused above a scaled condition number of 1e8); ridge in closed form on
  standardised features with the intercept unpenalised (lambda =
  scikit-learn alpha); binary logistic regression by Newton (its Newton
  system solved by its own scale-aware Cholesky, `solveSPD`, with a
  relative pivot rule instead of lib/linalg solveDense) with a stated
  stopping rule, and separation decided before fitting by the dual Gordan
  and Stiemke linear programmes (lib/lp, p rows whatever n; timed to 200k
  rows); RMSE, MAE, R^2, confusion matrix, per-class and
  macro/weighted precision, recall and F1 with a stated zero division,
  ROC with tied scores grouped, trapezoid AUC, clipped log loss; seeded
  permutation importance, a learning curve by well count and a leakage
  demo (random rows against whole wells). Gate: `dataai.ml.test.js`
  replays `test-data/dataai/goldens/ml_cases.json` (stdlib oracle
  `tools/validation/dataai/oracle_ml.py`, exact rational OLS) with the
  NIST StRD linear regression certified values (Norris, Pontius, NoInt1/2,
  Longley, Wampler1-5 and Filip, whose default refusal and 8-digit input
  limit are recorded) as published anchors, and the numpy/scikit-learn/
  statsmodels pins in `test-data/dataai/pins/ml_pins.json` (`pin_ml.py`);
  findings, decisions and the negative control in
  `tools/validation/dataai/FINDINGS-ml.md` and `negcontrol_ml.sh`.
- `engines/dataai/cluster.js` (Data & AI D3, 2026-09-24): electrofacies for
  the Electrofacies Studio and the `facies` course. PCA on the correlation
  (sample-SD standardised) or covariance matrix by cyclic Jacobi with a
  stated sign rule (largest absolute loading positive, ties within 1e-9 to
  the first), explained variance, loadings and scores; seeded k-means++
  (one mulberry32 stream, nInit runs) with Lloyd passes, a stated empty
  cluster rule, inertia and an elbow table; silhouette (singletons 0,
  seeded sampling above 10,000 rows); agglomerative Ward, complete and
  average by Lance-Williams with a scipy-compatible linkage matrix and a
  3,000-row cap; kNN and a CART classification tree (Gini, exact split
  comparison on integer counts, stated split and leaf ties); cluster to
  core-facies matching (Hungarian one-to-one or majority) scored by ml.js
  classificationReport, and the adjusted Rand index. Distance and merge
  ties are judged in a stated 1e-12 relative band so decimal log values
  cannot let rounding pick the winner. Scaling and metrics are imported
  from ml.js; a constant log is refused naming the rows it was fitted on
  ("the N rows passed" when clustering or in PCA, "the N training rows"
  for kNN). Gate: `dataai.cluster.test.js` replays
  `test-data/dataai/goldens/cluster_cases.json` (stdlib oracle
  `tools/validation/dataai/oracle_cluster.py`: bisection eigenvalues,
  linkage heights from their definitions, brute-force matching, pair-count
  ARI) with Fisher's iris data (1936) as the published anchor, and the
  scikit-learn/scipy pins in `test-data/dataai/pins/cluster_pins.json`
  (`pin_cluster.py`, convention differences listed); findings, the
  boundary table, the salvage review of the Suite's
  logFaciesCalculations.js and the negative control in
  `tools/validation/dataai/FINDINGS-cluster.md` and `negcontrol_cluster.sh`.
- `engines/dataai/forecast.js` (Data & AI D4, 2026-09-24): data-driven
  production forecasting for the Production Forecasting ML Workbench and
  the `forecastml` course. Simple exponential smoothing, Holt's linear
  trend and the Gardner-McKenzie damped trend (FPP3 component form,
  initialised at the first observation with y_2 spent on the trend start),
  fitted by one-step SSE with a deterministic optimiser (a stated coarse
  grid with an earlier-point tie rule, then compass search in the box
  alpha, beta in [0, 1], phi in [0.8, 0.98], stopping at a step of 2^-30);
  rolling-origin expanding-window backtests with refit or held parameters;
  MAE, RMSE, ME, MAPE (null with the reason on a zero actual), sMAPE (0 to
  200) and MASE (in-sample lag-m naive scale); residual bootstrap
  intervals (residuals drawn as fitted, uncentred, as FPP3 5.5) from one
  lib/stats mulberry32 stream with the lib/stats
  quantile rule and P90/P50/P10 labels from `lib/conventions/percentile.js`;
  and an Arps baseline imported from `engines/dca/arps.js` (fitArpsModel,
  never re-implemented) compared on the same origins and ranked with a
  stated tie rule. Gate: `dataai.forecast.test.js` replays
  `test-data/dataai/goldens/forecast_cases.json` (stdlib oracle
  `tools/validation/dataai/oracle_forecast.py`: error-correction
  recursions in Decimal, a zoom-grid fit, exact metrics, integer
  mulberry32) with the NIST/SEMATECH e-Handbook 6.4.3 examples as the
  published anchors, and the statsmodels/scipy/scikit-learn pins in
  `test-data/dataai/pins/forecast_pins.json` (`pin_forecast.py`,
  convention differences listed); findings, the boundary table and the
  negative control in `tools/validation/dataai/FINDINGS-forecast.md` and
  `negcontrol_forecast.sh`.
- `engines/dataai/evaluate.js` (Data & AI D5, 2026-09-25): applied AI
  evaluation for the AI Evaluation Studio and the `appliedai` course, all
  deterministic (no language model runs). A stated tokeniser (ASCII
  lowercase, split outside [a-z0-9]) with scikit-learn's stop list off by
  default; TF-IDF as scikit-learn's TfidfVectorizer and Okapi BM25 with the
  Lucene idf, ranked with a 12-significant-digit tie key and the id
  ascending; P@k, R@k, hit@k, RR/MRR, AP/MAP and nDCG@k (linear or 2^g - 1
  gain, ideal DCG from every judged grade; nDCG null with a note naming
  the case when the query has no judged documents or every judged grade
  is 0) with a stated no-relevant rule;
  SQuAD exact match and token F1; extraction scoring (correct, wrong,
  missed, unsupported; micro and macro accuracy); a claim groundedness
  check of an answer's quotes, dates and numbers against the passages it
  cites and retrieved; Cohen's kappa (unweighted, linear, quadratic);
  Brier, reliability table, ECE, MCE and the Murphy decomposition with the
  within-bin terms (Brier = REL - RES + UNC + WBV - WBC, Stephenson, Coelho
  and Jolliffe 2008 eq. 7, where WBC carries the paper's factor 2), log loss imported from `ml.js`; and percentile and
  paired bootstrap intervals from one lib/stats mulberry32 stream,
  labelled as parameter percentiles. Fixtures: the synthetic Ekene document
  set in `test-data/dataai/ekene-docs/` (60 passages, 24 judged queries,
  two answer systems, 30 extraction records, 200 calibration rows;
  `make_evaluate_fixtures.py`). Gate: `dataai.evaluate.test.js` replays
  `test-data/dataai/goldens/evaluate_cases.json` (stdlib oracle
  `tools/validation/dataai/oracle_evaluate.py`: Decimal BM25 and TF-IDF,
  exact metrics and calibration, integer mulberry32) and the scikit-learn
  and numpy pins in `test-data/dataai/pins/evaluate_pins.json`
  (`pin_evaluate.py`, convention differences listed); findings, the
  boundary table and the negative control in
  `tools/validation/dataai/FINDINGS-evaluate.md` and
  `negcontrol_evaluate.sh`.
- `engines/supplychain/tender.js` (Supply Chain SC2, 2026-09-26): tender
  evaluation and contracting. Two-envelope evaluation (mandatory checks,
  weighted technical score, pass mark at or above; only passing bids have
  their price opened), arithmetic correction (World Bank SPD ITB 35.1: the
  unit rate prevails), lowest evaluated cost (discounts, priced deviations,
  omissions at the average price of the other responsive bids per SPD ITB
  34.1 (the default; a highest-price option is labelled as not from the cited
  texts), schedule adjustment, life-cycle
  cost through the canonical `economics/cashflow.ts` npv), the combined score
  B = Clow/C x X x 100 + T/Thigh x (1 - X) x 100 with lowest-ratio and linear
  price methods, the World Bank Rated Criteria weighting
  matrix, abnormally low bid identification (World Bank ALB Guidance,
  absolute below five bids, relative from five), Nigerian content against the
  Schedule of the Nigerian Oil and Gas Industry Content Development Act 2010
  with its s.14 (1% / 5%, the readings stated in every reason, the lead
  reading a required input) and s.16 (10
  percent) rules, lump sum against day rate against reimbursable under
  duration uncertainty (lib/stats mulberry32 and triInvCDF, days from
  `drilling/wellCost.js`), and a should-cost estimate built by
  `drilling/wellCost.js` and `economics/afe.js`. Gate:
  `supplychain.tender.test.js` replays
  `test-data/supplychain/goldens/tender_cases.json` (written by
  `tools/validation/supplychain/oracle_tender.py`, stdlib, with the World
  Bank, Kiiver and Kodym 2015 and Chen 2008 worked examples); synthetic Ekene
  tenders in `test-data/supplychain/ekene-tender/`; negative control
  `negcontrol_tender.sh`; timing `timing_tender.js`.
- `engines/economics/gasContract.js` (Economics EC8, 2026-09-26): gas sales
  agreements. Volume to energy through a stated heating value (International
  Table Btu), ACQ from DCQ and a stated day count, MaxDCQ and swing (effective
  swing = swing / take-or-pay level, HMRC OT05402), the daily balance of
  nominations against deliveries (properly nominated quantity, the seller's
  Shortfall Quantity after force majeure and maintenance, the buyer's
  shortfall), the annual take-or-pay reconciliation on the Commonwealth model
  GSA (2025, CC BY 4.0) formulas (Adjusted ACQ, TOPQ, deficiency and payment,
  a make-up ledger with three stated recovery orders, first in first out,
  expiry and the end-of-term forfeit or refund, optional carry-forward with
  its cap, seller shortfall damages), contract prices from a monthly index
  series (fixed, escalated, oil-indexed with floor, ceiling and S-curve,
  hub-indexed, the Article 15.1 basket; stated averaging, lag and reset; the
  Article 15.4 4-decimal rule; reopeners reported), the Nigerian domestic gas
  prices of PIA 2021 s.167, s.168 and the Fourth Schedule (the domestic base
  price is a required input) and the Domestic Gas Delivery Obligation penalty
  (s.110; DGDO Regulations 2022 r.6), and the GSA cash flows with the gas
  royalty and NPV imported from `economics/cashflow.ts`. Gate:
  `economics.gasContract.test.js` replays
  `test-data/economics/goldens/gascontract_cases.json` (written by
  `tools/validation/economics/oracle_gascontract.py`, stdlib, with the HMRC,
  Energy Charter, OIES and PIA printed figures); synthetic Ekene GSAs in
  `test-data/economics/ekene-gsa/`; findings, sources with dates, the boundary
  table and the negative control in
  `tools/validation/economics/FINDINGS-gasContract.md` and
  `negcontrol_gascontract.sh`; timing `timing_gascontract.js`.
- `lib/stats/` — the canonical Monte Carlo sampling primitives and
  descriptive statistics (the Suite's src/lib/monteCarlo.js with
  simple-statistics 7.8.8 vendored bit-identically: Kahan sum,
  POPULATION standard deviation, the quantile rule; pinned against the
  real library in `test-data/stats/`). `lib/dates/` is the date-fns
  4.1.0 subset the economics modules use (parseISO, isValid,
  differenceInDays, addDays, light `format` tokens), pinned against the
  real library in `test-data/dates/`; UTC assumed.

## Own-property lookups (2026-09-21)

A preset or table read as `TABLE[key]` walks the prototype chain, so
`'constructor'`, `'toString'`, `'valueOf'`, `'hasOwnProperty'` and
`'__proto__'` are found in every object literal and pass a falsy guard; a
running total keyed by a caller's name loses a `'__proto__'` row and can
write onto `Object.prototype`. The rule for every engine: read a table
with a caller key through an own-property check
(`Object.prototype.hasOwnProperty.call`), and store caller-named rows with
`Object.defineProperty` or a Map. `engines/hse/qra.js` was the first file
repaired (H5); the repo-wide sweep closed the rest across assurance,
basin, dca, downstream, drilling, earthmodeling, economics, facilities,
fluid, hse, mapping, mbal, petrophysics, production, rockphysics,
seismolord, sim, waterflood, welldata, wellsite, welltest and `lib/`.
`__tests__/prototypeChainLookups.test.js` calls each repaired function with
all five names and is red on the unrepaired code. Domain notes are in the
matching `tools/validation/<domain>/FINDINGS-*.md`.

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
`engines/economics/cashflow.ts` and `montecarlo.ts` (2026-09-08) follow the
same rule for the same reason: they are bundled into the Suite's
epe-cash-flow-engine, epe-cash-flow-engine-batch and epe-monte-carlo edge
functions through one-line shims at supabase/functions/_shared/.

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
| `engines/economics/cashflow.ts` | `supabase/functions/_shared/epe-engine.ts` (edge-function engine; the Suite path is a re-export shim bundled into three epe edge functions) |
| `engines/economics/montecarlo.ts` | `supabase/functions/_shared/epe-mc.ts` (same shim arrangement) |
| `test-data/economics/fixtures/pia-worked-example.json` | `tools/validation/fixtures/epe-pia-worked-example.ts` (the TS fixture stays in the Suite for its harness) |
| `engines/economics/screening.js` | `src/utils/npvCalculations.js` (`quantile` now from lib/stats) |
| `engines/economics/fiscalRegime.js`, `fiscalTemplates.js` | `src/utils/fiscalDesignerCalculations.js`, `src/utils/fiscalTemplates.js` |
| `engines/economics/breakeven.js` | `src/utils/breakevenCalculations.js` |
| `engines/economics/decisionTree.js` | `src/lib/decisionTree.js` |
| `engines/economics/voi.js` | `src/utils/voiCalculations.js` |
| `engines/economics/portfolio.js` | `src/utils/portfolioOptimizer.js` |
| `engines/economics/fdp/*.js` | `src/utils/fdp/*.js` (`formatting.js` stays in the Suite, Intl-dependent; `riskModel.js` is `src/data/fdp/RiskManagementModel.js`) |
| `engines/economics/afe.js` | `src/utils/afeServices.js` (`calculatePartnerCosts` only; PDF and Excel stay) + `src/utils/costControlCalculations.js` |
| `engines/economics/projectControls.js` | `src/utils/projectManagementCalculations.js` |
| `lib/stats/stats.js` | `src/lib/monteCarlo.js` (simple-statistics vendored; the Suite keeps its copy on the npm dependency for now) |
| `lib/dates/dates.js` | date-fns subset (new) |
| `engines/mbal/mbalEngine.ts` | `supabase/functions/_shared/mbal-engine.ts` (server engine; the Suite path is now a re-export shim bundled into the calculate-mbal edge function) |
| `engines/mbal/lm.ts` | `supabase/functions/_shared/lm.ts` (mbal's own Levenberg-Marquardt; coexists with lib/welltest/lmFit.js for now, unification is a later cleanup) |
| `test-data/mbal/dake-9-2.ts` | `tools/validation/fixtures/dake-9-2.ts` |
| `test-data/mbal/ahmed-ex-*.json` | `tools/validation/mbal-fixtures/` |
| `engines/waterflood/vrr.js` | `src/utils/vrrCalculations.js` |
| `engines/waterflood/waterflood.js` | `src/utils/waterfloodCalculations.js` (pure math; `parseWaterfloodCSV` stays in the Suite — papaparse) |
| `engines/waterflood/layeredSweep.js` | `src/utils/layeredSweepCalculations.js` |
| `engines/waterflood/patternForecast.js` | `src/utils/patternForecastCalculations.js` |
| `tools/validation/{wells,petrophysics,rockphysics,earthmodel,porepressure}` | same paths in suite |
| `engines/fluid/blackOil.ts` | `engines/mbal/mbalEngine.ts` (private helpers; mbal now imports them, and its own gates still pin every one) |
| `engines/fluid/{units,components,pr78,flash,characterization,envelope,transport,separator,experiments,tuning,labTune}.js` | `src/utils/fluidstudio/eos/` (same names; `envelope.worker.js` and `eosAnalysis.js` stay in the Suite -- they are worker and UI plumbing, not physics) |
| `test-data/fluid/{goldens,componentReference,characterizationReference,nistVaporPressure}.json` | `src/utils/fluidstudio/eos/__tests__/` |
| `test-data/fluid/literature-fixtures.json` | `tools/validation/fluidstudio/` |
| `tools/validation/fluid/` | `tools/validation/fluidstudio/` |
| `engines/downstream/` (all eleven modules) | the Suite's vendored `packages/engines/engines/downstream/` (written there directly by DS0 to DS10 and never upstreamed; moved byte for byte 2026-09-14; the Suite's `src/utils/downstream/engine/*.js` re-export shims stay) |
| `lib/conventions/percentile.js` | `src/lib/percentileConventions.js` (verbatim; the Suite path becomes a re-export shim) |
| `lib/lp/simplex.js` | the Suite's vendored `packages/engines/lib/lp/simplex.js` (same history; shim `src/utils/downstream/engine/simplex.js` stays) |
| `__tests__/downstream.*.test.js`, `__tests__/lp.simplex.test.js` | the Suite's vendored `packages/engines/__tests__/` (same history) |
| `engines/assurance/{riskScoring,complianceStatus,documentControl,peerReview,managementOfChange,qualityAssurance,isoCompliance,lessonsLearned,auditManagement}.js` | `src/lib/` (same names; the colour tokens stayed in the Suite, which keeps each path as a shim that re-exports the engine and adds them) |
| `engines/assurance/calendar.js` | five byte-identical copies of `parseDateOnly` / `daysUntil` / `toDateOnlyString` in the Suite modules above |

Import rewrites at extraction: `engines/seismolord/synthetics.js` and
all `@/lib/*` imports became `../../lib/*` (the package has no `@/`
alias). Everything else moved verbatim.

Not yet here: BasinFlowGenesis engines (they live mixed into that
app's `services/` — normalization + move is a follow-on), Seismolord's
`test-data/seismolord` app fixtures (its engine tests stay in the
Suite for now).
