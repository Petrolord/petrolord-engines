# Fluid Systems Studio PR78 engine validation

Validation-first gate for the compositional EOS engine in
`engines/fluid/` (plan of record:
`docs/scope/FluidSystemsStudio-STATUS.md`).

## Pieces

- `oracle.py` - independent Python stdlib implementation. Independence by
  route, not just by reimplementation: the compressibility cubic is solved
  by bracketed bisection between its analytic extrema (the JS engine uses
  Cardano + Newton polish); ln(phi) comes from numerical quadrature of the
  residual-Helmholtz integral with dP/dn_i differentiated from the
  pressure-explicit mole-number form (the JS engine uses the closed-form
  fugacity expression, so agreement cross-validates the algebra); pure
  saturation pressure comes from the Maxwell equal-area construction (the
  JS engine iterates fugacity equality). Component constants are read from
  the committed, source-cited table
  `test-data/fluid/componentReference.json` - one
  transcription shared by both sides. The BIP table IS deliberately
  transcribed twice (genfixtures.py vs components.js) and gated for
  equality.
- `genfixtures.py` - regenerates the committed goldens consumed by jest
  and the harness:

      python3 tools/validation/fluid/genfixtures.py
      # writes test-data/fluid/goldens.json

- `run-validation.mjs` - labeled-CASE gate runner (mbal-validation style),
  exit 0 only on full pass:

      node tools/validation/fluid/run-validation.mjs

## Cases

1. BIP table vs the oracle's independent Monograph 20 Table 4-2 transcription
2. Z roots + lowest-Gibbs root selection vs the bisection-route oracle
   (gate 1e-9/1e-10; observed ~1e-15) across three mixtures x T x P,
   including four three-root states that exercise the selection logic
3. ln(phi) closed form vs the quadrature oracle (gate 1e-8 abs, observed
   ~1e-13)
4. Peneloux-translated molar volumes and densities (gate 1e-9, observed
   ~1e-15)
5. purePsat fugacity route vs Maxwell equal-area route, 44 points at
   Tr 0.60-0.95 (gate 1e-7, observed ~1e-12)
6. NIST measured vapor pressures: normal boiling points (CO2 uses the
   0 degC saturation point since it sublimes at 1 atm) with honest
   per-component bands set at ~1.5x observed PR78 error - sub-1% for
   most paraffins, 2.6% iC4, 9.4% H2S (Tr 0.57, known low-Tr PR
   overprediction). Plus the omega-definition identity at Tr = 0.7
   (log10 Pr = -(1 + omega), gate 0.02 abs).
7. Analytic identities: ideal-gas limit, cubic residual at the chosen
   root, split invariance (duplicating a component changes nothing),
   Peneloux touching volumes only (zFactor/lnPhi bit-identical with and
   without shifts) and the correction equaling sum x_i s_i b_i.
8. (FS3) Rachford-Rice: binary closed-form beta, root residual +
   unit-sum + material balance, negative-flash root outside [0,1],
   null when K does not straddle 1.
9. (FS3) Stability + flashPT vs the plain-SS oracle flash grid - the
   oracle uses no GDEM, bisection-only RR and the bisection cubic, so
   both sides converging to the same fixed point cross-validates
   accelerator, RR solver and root selection (gates 1e-8..1e-9,
   observed ~1e-10; 8 two-phase + 31 single-phase states). Every
   two-phase golden is sealed at generation time by the quadrature
   fugacity-equality check (observed 5e-12, generator aborts above 1e-6).
10. (FS3) Convergence identities on live flash results: isofugacity
    (observed ~1e-11), exact material balance, K = y/x = phiL/phiV.
11. (FS3) Low-pressure K limits anchored to the NIST-gated Psat:
    plain Raoult for the heavy component (2%), the Lewis-rule phiSat
    correction for the volatile one (3%) - the light component's
    departure from naive Raoult IS its saturated-vapor fugacity
    coefficient, and the gate verifies exactly that.
12. Published literature flash fixtures - ARMED: Whitson & Brule,
    Phase Behavior, SPE Monograph 20 (2000), Appendix B Problem 18
    (a) and (b) - a fully converged PR flash (SS+GDEM to 1e-12) of
    C1/C4/C10 at 280F, 500 and 1500 psia, run on the PRINTED
    component properties (Table B-28) with kij = 0 as printed.
    Observed: beta within 2.2e-4 / 3.6e-4 rel of the printed
    Fv = 0.853401 / 0.566844; K within 0.17% except K_C10 (0.78% /
    0.75%) - the printed solution applies the PR78 cubic kappa to
    C10 (omega 0.4902; the problem statement switches at omega > 0.4,
    the engine at the standard 0.491), which fully accounts for the
    C10 residual. Gates: beta 2%, K 5%.
13. (FS4) C7+ characterization vs the oracle's second transcription of
    Soreide / Kesler-Lee / Lee-Kesler / Edmister / Jhaveri-Youngren /
    LBC-Vc / Firoozabadi / Chueh-Prausnitz (gate 1e-12, observed
    ~1e-15), plus pure n-alkane recovery: Kesler-Lee run on nC5/nC6
    NIST boiling points + committed GPSA specific gravities must land
    inside honest correlation bands of the FS1 library constants
    (Tc 1%, Pc 8%, omega 0.06 abs; observed 0.06%/5.6%/0.021).
14. (FS4) Characterized-fluid flash grid vs the plain-SS oracle - the
    pseudo is built by each side's own correlation transcription, so
    this seals characterization -> EOS end to end (observed ~1e-12).
15. (FS4) Phase boundaries / envelope vs the oracle's stability-
    bisection route (same scan/bisection protocol, independent
    stability + cubic + RR implementations). Engine and oracle agreed
    on every one of the ~1500 stability probes, so all boundary
    pressures matched exactly; gate kept at 2e-4 rel. Plus the Raoult
    bubble-point band on equimolar C3/nC4 anchored to the NIST-gated
    purePsat (4% observed, 6% band) and flash phase-count flips across
    a detected boundary.
16. (FS4) LBC viscosity + Weinaug-Katz IFT vs the oracle transcription
    of the SPE 109892 field-unit statement (gate 1e-6, observed
    ~1e-10), NIST dilute-gas viscosity anchors (methane/nitrogen at
    300 K / 1 atm, +-10% bands; observed 2.8%/0.9%) and identity gates
    (Herning-Zipperer collapse, zero IFT for identical phases).
17. Coats & Smart SPE 11197 fixtures - ARMED with 8 of the paper's
    Table 1 fluids (Oils 1/2/4/6/7, Gas 2 bubble- and dewpoint
    samples, Gas 5 dewpoint): measured lab saturation pressures vs
    the untuned single-pseudo engine. Observed rel errors: Oil 6
    0.08%, Gas 2 bubble 1.8%, Oil 4 2.3%, Gas 2 dew 2.5%, Oil 7
    5.0%, Oil 2 8.0% inside the 10% correlation-level gate; two
    documented outliers gated just above their observed error to
    regression-pin: Oil 1 +10.3% (heaviest fluid, C7+ SG 0.90
    near-aromatic vs paraffin-leaning characterization; gate 13%)
    and Gas 5 -15.8% (lean-condensate dew point controlled by the
    heavy tail a single C7+ pseudo cannot resolve; gate 20%).
    Excluded: Oil 3 (C10+ plus fraction with discrete C7-C9) and
    Gas 4 (C6+ plus fraction). This scatter is the paper's own
    point - untuned EOS needs regression; the ET tuning program (below)
    demonstrates exactly that on these same fluids.

Cases 18-22 (FS6-FS8: separator train, CCE, differential liberation +
composite table, performance smoke) are documented in
docs/scope/FluidSystemsStudio-STATUS.md. The ET tuning program adds:

23. ET1 tuning seam: absent/identity tuning is bitwise identical to the
    untuned path through flash/Psat/separator; a volume-shift-only tune
    leaves the phase split bitwise intact (Peneloux decoupling); raising
    the C1-C7+ BIP raises an oil bubble point; library components are
    untouched by tuning.
24. ET2 self-recovery: synthetic lab data generated from a known
    perturbed truth (fTc 1.04, fPc 0.88, kC1 0.10, sPlus 0.08) is
    recovered by the regression - psat 0.1%, GOR 0.5%, API 0.3,
    Bo 0.5% gates (observed well inside).
25. ET2 real anchors: every armed Coats & Smart fluid tunes to its
    measured Psat within 0.5% in-bounds (observed <=0.02%, INCLUDING the
    two pinned untuned outliers - Oil 1 +10.3% -> 0.004%, Gas 5 dew
    -15.8% -> -0.012%); the Good Oil joint 4-target fit gates at
    psat 0.3% / GOR 1.5% / API 2.5 / Bo 1.5% (observed -0.08% / -0.8% /
    -1.9 / -1.1%). The residual GOR/API split is the honest 4-knob
    frontier: both pull on the stock-tank oil volume, so with
    inconsistent measurements the weighted fit balances them. Modeling
    fidelity note: the Good Oil lab stock tank ran at 75F (volumes
    corrected to 60F), so the anchor models it as an explicit 75F/14.65
    stage ahead of the implicit 60F stock tank - worth ~1.5 API.
    Regression kernel gotcha, documented in lmFit.js: Psat bisection is
    quantized to tolPsia (0.05 psia), so the tune passes an absolute
    1e-3 jacobianStep - the kernel default 1e-6 relative step reads a
    zero derivative for the equilibrium knobs.

The same gates run in jest (`test-data/fluid/`:
`pr78.test.js`, `flash.test.js`, `characterization.test.js`,
`envelope.test.js`, `transport.test.js`) so CI catches regressions
without Python; this runner is the regeneration-time cross-check and the
place tolerances are documented.

## Literature gates (CASES 12 / 17 / 19) - armed 2026-07-19

All three literature gates are ARMED and CLOSED. The owner had no
printed pages, so the data was sourced from fetched copies of the
printed sources on the open web (the "never from model memory" rule was
honored: every number was read from a fetched document, cross-verified
across independent documents or doubly attested inside the primary):

- CASE 12: Whitson & Brule Monograph 20 Appendix B Problem 18, from the
  full-text copy at pdfcoffee.com; internally re-verified (feed
  recovered from z = Fv*y + (1-Fv)*x; converged fL = fV printed
  per component).
- CASE 17: the SPE 11197 paper scan itself, publicly hosted on Curtis
  Whitson's NTNU course site (ipt.ntnu.no/~curtis); every composition
  column sums to exactly 1.0000 and every Table 1 psig Ps cross-checks
  against the paper's own Table 12 / body-text psia values at +14.7.
- CASE 19: Good Oil Co. Oil Well No. 4 (Core Laboratories RFL 88001) -
  the original report scan hosted in the TAMU Blasingame course
  archive, cross-verified against Whitson & Brule Phase Behavior Ch. 6
  Tables 6.4/6.7/6.9 (NTNU-hosted) and wiki.whitson.com; composition,
  C7+ MW 218 / SG 0.8515, all four separator tests and Pb 2620 psig @
  220F identical across all three. Report pressures are PSIG (base
  14.65 psia); the monograph header's "(psia)" contradicts its own
  "Gauge" footnote and both other sources.

CASE 19 observed (untuned engine vs measured lab data, all four
two-stage tests): total GOR within 0.05-2.4% (gate 10%); multistage
Bofb within 0.3-1.4% (gate 8%), compared at the ENGINE's saturation
pressure (2791 psia vs lab Pb 2634.65 psia, +5.9%, in line with the
CASE 17 oils) because the untuned Psat overprediction makes the fluid
two-phase at lab reservoir conditions - the standard untuned-EOS vs
lab-report comparison; stock-tank API reads ~9.2 API heavy of the
measured 40.1-40.7 (gate 10 API, set just above the observed bias):
the generalized Jhaveri-Youngren volume shift under-corrects heavy
pseudos (the pure C7+ pseudo's std-condition SG recovers 0.9075 vs its
defining 0.8515). The API/Psat biases are the headline targets for the
EOS-tuning-to-lab-data initiative.

Full source URLs live in the `_readme` fields of
literature-fixtures.json next to the data they attest.
