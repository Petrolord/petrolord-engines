#!/usr/bin/env bash
# H5 negative controls for the QRA gate (engines/hse/qra.js).
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-qra.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/hse/qra.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/hse/oracle_qra.py alone, with the
#           golden regenerated. All must go RED: the control on the controls.
#   SHARED  plants go in BOTH files, as a copied mistake would. RED means a
#           second route or a published value still catches it; GREEN is the
#           honest statement of what rests on a single transcription.
#
# The oracle runs in the venv /root/hseenv (numpy, scipy).
# Usage: tools/validation/hse/negcontrol_qra.sh [filter]
set -u
cd "$(dirname "$0")/../../.." || exit 1
ENGINE=engines/hse/qra.js
ORACLE=tools/validation/hse/oracle_qra.py
GOLDEN=test-data/hse/goldens/qra_cases.json
SUITE=__tests__/hse.qra.test.js
PY=${PY:-/root/hseenv/bin/python}
FILTER=${1:-}
TMP=$(mktemp -d)
cp "$ENGINE" "$TMP/engine.bak"; cp "$ORACLE" "$TMP/oracle.bak"; cp "$GOLDEN" "$TMP/golden.bak"; cp "$SUITE" "$TMP/suite.bak"
restore() { cp "$TMP/engine.bak" "$ENGINE"; cp "$TMP/oracle.bak" "$ORACLE"; cp "$TMP/golden.bak" "$GOLDEN"; cp "$TMP/suite.bak" "$SUITE"; }
trap restore EXIT

plant() { # file from to
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if a not in s:
    sys.stderr.write("PLANT TARGET MISSING: %s\n" % a)
    sys.exit(3)
open(path, "w").write(s.replace(a, b))
PY
}

run_case() { # kind name engine_from engine_to oracle_from oracle_to
  kind=$1; name=$2; ef=$3; et=$4; of=$5; ot=$6
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  if [ -n "$ef" ]; then plant "$ENGINE" "$ef" "$et" || { echo "SKIP  $name (engine target missing)"; return; }; fi
  if [ -n "$of" ]; then
    plant "$ORACLE" "$of" "$ot" || { echo "SKIP  $name (oracle target missing)"; return; }
    timeout 300 "$PY" "$ORACLE" >/dev/null 2>&1 || { echo "RED?  [$kind] $name -- the ORACLE itself refused or failed (not a jest result)"; return; }
  fi
  out=$(timeout 300 npx jest "$SUITE" 2>&1)
  rc=$?
  if [ $rc -eq 124 ]; then
    echo "HANG  [$kind] $name"
  elif echo "$out" | grep -q "Tests:.*failed"; then
    n=$(echo "$out" | grep -E "^Tests:" | grep -oE "[0-9]+ failed" | head -1)
    first=$(echo "$out" | grep -E "^\s+●" | sed 's/^ *● //' | sort -u | head -2 | tr '\n' ';')
    echo "RED   [$kind] $name -- $n -- $first"
  elif echo "$out" | grep -q "Test suite failed to run"; then
    echo "RED   [$kind] $name -- suite failed to run"
  else
    echo "GREEN [$kind] $name -- NOT CAUGHT"
  fi
}


# A TOLERANCE plant perturbs the engine by a small relative amount and says
# what it expects. Two rows make one argument: the perturbation is caught at
# the tolerance the suite ships, and the SAME perturbation is missed once that
# tolerance is loosened. That is what shows the number is load-bearing and not
# decoration. `expect` is RED or GREEN; a row that does not match is reported
# as MISMATCH and is a finding.
run_tol() { # expect name engine_from engine_to suite_from suite_to
  want=$1; name=$2; ef=$3; et=$4; sf=$5; st=$6
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  plant "$ENGINE" "$ef" "$et" || { echo "SKIP  $name (engine target missing)"; return; }
  if [ -n "$sf" ]; then plant "$SUITE" "$sf" "$st" || { echo "SKIP  $name (suite target missing)"; return; }; fi
  out=$(timeout 300 npx jest "$SUITE" 2>&1)
  if echo "$out" | grep -q "Tests:.*failed"; then
    got=RED; n=$(echo "$out" | grep -E "^Tests:" | grep -oE "[0-9]+ failed" | head -1)
  elif echo "$out" | grep -q "Test suite failed to run"; then
    got=RED; n="suite failed to run"
  else
    got=GREEN; n="NOT CAUGHT"
  fi
  if [ "$got" = "$want" ]; then echo "$got   [TOL] $name -- $n (expected $want)"
  else echo "MISMATCH [TOL] $name -- got $got, expected $want -- $n"; fi
}

echo "=== baseline ==="
restore
npx jest "$SUITE" 2>&1 | grep -E "^Tests:"

echo "=== ENGINE-ONLY plants (all must be RED) ==="
# the brief's seven
run_case ENGINE "F-N non-cumulative (each N carries only its own frequency)" \
  "desc.push({ fatalities: n, cumulativeFrequencyPerYr: cum });" "desc.push({ fatalities: n, cumulativeFrequencyPerYr: cum }); cum = 0;" "" ""
run_case ENGINE "IRPA: occupancy ignored" \
  "const c = l.lsirPerYr * o * v;" "const c = l.lsirPerYr * v;" "" ""
run_case ENGINE "PLL uses f / N" \
  "pllPerYr: s.frequencyPerYr * s.fatalities }));" "pllPerYr: s.fatalities > 0 ? s.frequencyPerYr / s.fatalities : 0 }));" "" ""
run_case ENGINE "ALARP upper boundary flipped (exactly 1e-3 counted unacceptable)" \
  "if (up === 1) band = 'UNACCEPTABLE';" "if (up >= 0) band = 'UNACCEPTABLE';" "" ""
run_case ENGINE "ALARP lower boundary flipped (exactly 1e-6 counted tolerable)" \
  "else if (low <= 0) band = 'BROADLY_ACCEPTABLE';" "else if (low < 0) band = 'BROADLY_ACCEPTABLE';" "" ""
run_case ENGINE "CBA: DF applied to the benefit side twice" \
  "const threshold = disproportionFactor * pvBenefit;" "const threshold = disproportionFactor * disproportionFactor * pvBenefit;" "" ""
run_case ENGINE "event tree: branch sum not checked" \
  "if (Math.abs(sum - 1) > BRANCH_SUM_TOLERANCE) {" "if (false) {" "" ""
run_case ENGINE "FAR base 1e6 instead of 1e8" \
  "const base = RATE_BASES.FAR_100M;" "const base = RATE_BASES.IOGP_1M;" "" ""
# more
run_case ENGINE "F-N criterion lookup uses N > instead of N >=" \
  "pts[i].fatalities >= n; i -= 1)" "pts[i].fatalities > n; i -= 1)" "" ""
run_case ENGINE "boundary snap removed (1e-4 x 10 is no longer 1e-3)" \
  "if (Math.abs(value - threshold) <= BOUNDARY_SNAP * Math.abs(threshold)) return 0;" "if (value === threshold) return 0;" "" ""
run_case ENGINE "occupancy sum over 1 not refused" \
  "if (occ > 1 + 1e-12) return refuse(" "if (false) return refuse(" "" ""
run_case ENGINE "event tree: leaf frequency without the initiating frequency" \
  "frequencyPerYr: initiatingFrequencyPerYr * pp });" "frequencyPerYr: pp });" "" ""
run_case ENGINE "PB vapour cloud split swapped (0.4 flash fire, 0.6 explosion)" \
  "flashFire: 0.6, explosion: 0.4," "flashFire: 0.4, explosion: 0.6," "" ""
run_case ENGINE "PB Table 4.5: middle band open at the top (100 kg/s counted large)" \
  "(x <= hi ? 1 : 2)" "(x < hi ? 1 : 2)" "" ""
run_case ENGINE "IRPA: hours over 8766 instead of 8760" \
  "o = l.hoursPerYr / HOURS_PER_YEAR;" "o = l.hoursPerYr / 8766;" "" ""
run_case ENGINE "toxic: Pci without the number of sectors" \
  "const pci = (windSectors * ecw) / (2 * Math.PI * distanceM);" "const pci = ecw / (2 * Math.PI * distanceM);" "" ""
run_case ENGINE "toxic: ECW = PI x Pcl instead of PI / Pcl" \
  "const ecw = PI / cl.probability;" "const ecw = PI * cl.probability;" "" ""
run_case ENGINE "toxic: 30 minute cap removed" \
  "const tMin = Math.min(exposureMinutes, 30);" "const tMin = exposureMinutes;" "" ""
run_case ENGINE "fire: 20 s cap removed" \
  "exposureTimeUsedS = Math.min(fireDurationS, PB_MAX_FIRE_EXPOSURE_S);" "exposureTimeUsedS = fireDurationS;" "" ""
run_case ENGINE "fire: Q > 35 kW/m2 instead of >=" \
  "if (heatFluxWM2 >= PB_IGNITION_FLUX_WM2) {" "if (heatFluxWM2 > PB_IGNITION_FLUX_WM2) {" "" ""
run_case ENGINE "fire: clothing factor 0.14 dropped" \
  "FEin = 0; FEout = 0.14 * PE;" "FEin = 0; FEout = PE;" "" ""
run_case ENGINE "toxic: indoor factor 0.1 dropped" \
  "PE = probabilityOfDeath; FEin = 0.1 * PE;" "PE = probabilityOfDeath; FEin = PE;" "" ""
run_case ENGINE "explosion: > 0.3 barg read as >=" \
  "if (peakOverpressurePa > PB_VCE_OVERPRESSURE_PA.lethal)" "if (peakOverpressurePa >= PB_VCE_OVERPRESSURE_PA.lethal)" "" ""
run_case ENGINE "CBA: benefits discounted at the cost rate" \
  "const pvBenefit = npv(benefitFlows, benefitDiscountRate, 0, 1);" "const pvBenefit = npv(benefitFlows, costDiscountRate, 0, 1);" "" ""
run_case ENGINE "CBA: benefit uprating ignored" \
  "benefitPerYr * (1 + benefitGrowthRate) ** t);" "benefitPerYr);" "" ""
run_case ENGINE "CBA: benefits discounted from year 0 (start of year)" \
  "const pvBenefit = npv(benefitFlows, benefitDiscountRate, 0, 1);" "const pvBenefit = npv(benefitFlows, benefitDiscountRate, 0, 0);" "" ""
run_case ENGINE "transect: contour interpolation linear in IR, not log" \
  "if (a > 0 && b > 0) t = (Math.log10(level)" "if (false) t = (Math.log10(level)" "" ""
run_case ENGINE "transect: flame envelope given the probit instead of 1" \
  "if (x <= R) { points.push({ distanceFromCentreM: x, state: 'IN_FLAME_ENVELOPE', heatFluxWM2: null, probability: 1 }); continue; }" \
  "if (x <= R) { points.push({ distanceFromCentreM: x, state: 'IN_FLAME_ENVELOPE', heatFluxWM2: null, probability: 0 }); continue; }" "" ""

echo "=== ORACLE-ONLY plants (all must be RED) ==="
run_case ORACLE "oracle F-N brute force uses N > instead of N >=" "" "" \
  "if s['fatalities'] >= n)" "if s['fatalities'] > n)"
run_case ORACLE "oracle toxic Pci with pi R instead of 2 pi R" "" "" \
  "pci = nws * ecw / (2 * math.pi * x)" "pci = nws * ecw / (math.pi * x)"
run_case ORACLE "oracle discounting from t - 1" "" "" \
  "return sum(B * (1 + gr) ** t / (1 + r) ** t for t in range(1, n + 1))" "return sum(B * (1 + gr) ** t / (1 + r) ** (t - 1) for t in range(1, n + 1))"
run_case ORACLE "oracle thermal dose I instead of I^(4/3)" "" "" \
  "return P(a + b * math.log(t * I ** (4 / 3)))" "return P(a + b * math.log(t * I))"
run_case ORACLE "oracle FAR base 1e6" "" "" \
  "'expected': {'far': 6.9e-3 * 1e8 / (120 * 8760 / 2)}}," "'expected': {'far': 6.9e-3 * 1e6 / (120 * 8760 / 2)}},"
run_case ORACLE "oracle contour interpolation linear" "" "" \
  "            t = (math.log10(level) - math.log10(A)) / (math.log10(B) - math.log10(A))" "            t = (level - A) / (B - A)"

echo "=== SHARED plants (the same mistake in BOTH files) ==="
run_case SHARED "Pci with pi R in both (PB Appendix 6.B must catch it)" \
  "const pci = (windSectors * ecw) / (2 * Math.PI * distanceM);" "const pci = (windSectors * ecw) / (Math.PI * distanceM);" \
  "pci = nws * ecw / (2 * math.pi * x)" "pci = nws * ecw / (math.pi * x)"
run_case SHARED "ECW = PI x Pcl in both (PB Appendix 6.B must catch it)" \
  "const ecw = PI / cl.probability;" "const ecw = PI * cl.probability;" \
  "    ecw = PI / Pcl" "    ecw = PI * Pcl"
run_case SHARED "F-N N > instead of N >= in both (the engine's own fnCurve and PB touch case must catch it)" \
  "pts[i].fatalities >= n; i -= 1)" "pts[i].fatalities > n; i -= 1)" \
  "if s['fatalities'] >= n)" "if s['fatalities'] > n)"
run_case SHARED "DF applied twice in both (the CBA checklist 93,000 must catch it)" \
  "const threshold = disproportionFactor * pvBenefit;" "const threshold = disproportionFactor * disproportionFactor * pvBenefit;" \
  "'maximumReasonablyPracticableCost': 10 * B * 25," "'maximumReasonablyPracticableCost': 100 * B * 25,"
run_case SHARED "FAR base 1e6 in both (safetyStats bit-for-bit must catch it)" \
  "const base = RATE_BASES.FAR_100M;" "const base = RATE_BASES.IOGP_1M;" \
  "'expected': {'far': 6.9e-3 * 1e8 / (120 * 8760 / 2)}}," "'expected': {'far': 6.9e-3 * 1e6 / (120 * 8760 / 2)}},"
run_case SHARED "VROM line C 1e-3 -> 1e-2 in both (Bevi art. 13 points must catch it)" \
  "constantC: 1e-3, exponentAlpha: 2, minFatalities: 10," "constantC: 1e-2, exponentAlpha: 2, minFatalities: 10," \
  "checks, gm = fn_line_compare(scen, 1e-3, 2, 10)" "checks, gm = fn_line_compare(scen, 1e-2, 2, 10)"
run_case SHARED "clothing factor 0.14 -> 1 in both (single transcription: expected GREEN)" \
  "FEin = 0; FEout = 0.14 * PE;" "FEin = 0; FEout = 1.0 * PE;" \
  "0.14 * heatP" "1.0 * heatP"
run_case SHARED "contour interpolation linear in both (single rule: expected GREEN)" \
  "if (a > 0 && b > 0) t = (Math.log10(level)" "if (false) t = (Math.log10(level)" \
  "            t = (math.log10(level) - math.log10(A)) / (math.log10(B) - math.log10(A))" "            t = (level - A) / (B - A)"

echo "=== FAIL-OPEN plants: revert each prototype-chain fix (all must be RED) ==="
# Every row here restores the code as it stood before 2026-09-20. Each one
# made the engine answer a bogus preset with a RESULT instead of a refusal.
run_case ENGINE "fail-open: ownPreset reverted to a prototype-walking truthiness test (all four presets at once)" \
  "const ownPreset = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);" \
  "const ownPreset = (table, key) => !!table[key];" "" ""
run_case ENGINE "fail-open: ALARP preset unchecked ('constructor' returned BROADLY_ACCEPTABLE)" \
  "if (!ownPreset(TOLERABILITY_PRESETS, thresholds)) return refuse('thresholds'," "if (false) return refuse('thresholds'," "" ""
run_case ENGINE "fail-open: F-N criterion preset unchecked ('valueOf' returned BELOW, i.e. compliant)" \
  "if (!ownPreset(FN_CRITERIA, criterion)) return refuse('criterion'," "if (false) return refuse('criterion'," "" ""
run_case ENGINE "fail-open: PB Table 4.5 substance unchecked (returned a result with no probability)" \
  "if (!ownPreset(PB_DIRECT_IGNITION_STATIONARY, substance)) return refuse('substance'," "if (false) return refuse('substance'," "" ""
run_case ENGINE "fail-open: PB Table 5.3 period unchecked ('toString' gave a NaN fraction of deaths)" \
  "if (!ownPreset(PB_FRACTION_INDOORS, period)) return refuse('period'," "if (false) return refuse('period'," "" ""
run_case ENGINE "fail-open: event tree totals back on an object literal ('constructor' concatenated, '__proto__' vanished)" \
  "  const totals = new Map();
  outcomes.forEach((o) => { totals.set(o.outcome, (totals.get(o.outcome) || 0) + o.frequencyPerYr); });
  const outcomeTotals = Object.fromEntries(totals);" \
  "  const outcomeTotals = {};
  outcomes.forEach((o) => { outcomeTotals[o.outcome] = (outcomeTotals[o.outcome] || 0) + o.frequencyPerYr; });" "" ""

echo "=== TOLERANCE plants (a small perturbation, caught; then missed once loosened) ==="
run_tol RED   "LSIR out by 1e-9 relative, at the shipped RTOL of 1e-12" \
  "const lsir = contributions.reduce((a, c) => a + c.contributionPerYr, 0);" \
  "const lsir = contributions.reduce((a, c) => a + c.contributionPerYr, 0) * (1 + 1e-9);" "" ""
run_tol GREEN "the SAME 1e-9 perturbation, with the suite RTOL loosened to 1e-6" \
  "const lsir = contributions.reduce((a, c) => a + c.contributionPerYr, 0);" \
  "const lsir = contributions.reduce((a, c) => a + c.contributionPerYr, 0) * (1 + 1e-9);" \
  "const RTOL = 1e-12;" "const RTOL = 1e-6;"
run_tol RED   "toxic probability integral out by 1e-5 relative, at the route tolerance of 1e-6" \
  "const PI = 2 * (h / 3) * s;" "const PI = 2 * (h / 3) * s * (1 + 1e-5);" "" ""
# both places the suite spends this tolerance must be loosened: the first
# attempt loosened only one of the two and the other still caught the plant,
# which is itself worth knowing.
run_tol GREEN "the SAME 1e-5 perturbation, with BOTH toxic tolerances loosened to 1e-3" \
  "const PI = 2 * (h / 3) * s;" "const PI = 2 * (h / 3) * s * (1 + 1e-5);" \
  ", 1e-6)" ", 1e-3)"
run_tol RED   "CBA present value out by 1e-3 relative, against the checklist's GBP 1" \
  "const pvBenefit = npv(benefitFlows, benefitDiscountRate, 0, 1);" \
  "const pvBenefit = npv(benefitFlows, benefitDiscountRate, 0, 1) * (1 + 1e-3);" "" ""
# This row is expected RED, and that is the finding. Loosening the published
# checklist tolerance from GBP 1 to GBP 1000 does NOT hide the perturbation:
# seven independent assertions cover this present value (the checklist
# example, the R2P2 footnote at 1e-12, the DF boundary verdict, three route-B
# closed-form annuity comparisons at 1e-11, and the canonical-npv identity,
# which is an exact toBe and has no tolerance to loosen at all). No single
# tolerance is load-bearing here because no single tolerance stands alone.
run_tol RED   "the SAME 1e-3 perturbation, with the checklist tolerance loosened to GBP 1000 (six other assertions still catch it)" \
  "const pvBenefit = npv(benefitFlows, benefitDiscountRate, 0, 1);" \
  "const pvBenefit = npv(benefitFlows, benefitDiscountRate, 0, 1) * (1 + 1e-3);" \
  "toBeLessThan(c.printedAbsTol);" "toBeLessThan(1000);"
run_tol RED   "PB Appendix 6.B contribution out by 1 percent, against a value printed to 2 significant figures" \
  "const pd = cl.probability * pci;" "const pd = cl.probability * pci * 1.01;" "" ""
run_tol RED   "branch-sum tolerance loosened from 1e-9 to 1e-3 (0.4000001 must still be refused)" \
  "export const BRANCH_SUM_TOLERANCE = 1e-9;" "export const BRANCH_SUM_TOLERANCE = 1e-3;" "" ""
run_tol RED   "boundary snap loosened from 1e-9 to 1e-2 (bands must not drift a percent)" \
  "export const BOUNDARY_SNAP = 1e-9;" "export const BOUNDARY_SNAP = 1e-2;" "" ""

restore
echo "=== restored; verifying clean ==="
cmp -s "$GOLDEN" "$TMP/golden.bak" && echo "golden restored byte-identical"
cmp -s "$SUITE" "$TMP/suite.bak" && echo "suite restored byte-identical"
cmp -s "$ENGINE" "$TMP/engine.bak" && echo "engine restored byte-identical"
"$PY" "$ORACLE" >/dev/null && cmp -s "$GOLDEN" "$TMP/golden.bak" && echo "oracle regenerates the golden byte-identical"
npx jest "$SUITE" 2>&1 | grep -E "^Tests:"
