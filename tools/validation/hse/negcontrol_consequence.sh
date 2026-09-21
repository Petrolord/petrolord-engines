#!/usr/bin/env bash
# H4 negative controls for the consequence gate (engines/hse/consequence.js).
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-consequence.md about what this suite catches was produced by
# running this file: each row plants ONE defect, runs the suite, and records
# whether it went red.
#
#   ENGINE  plants go in engines/hse/consequence.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/hse/oracle_consequence.py alone,
#           with the golden regenerated. All must go RED: the control on the
#           controls.
#   SHARED  plants go in BOTH files, as a copied mistake would. RED means a
#           second route or a published value still catches it; GREEN is the
#           honest statement of what rests on a single transcription.
#
# The oracle runs in the venv /root/hseenv (numpy, scipy).
# Usage: tools/validation/hse/negcontrol_consequence.sh [filter]
set -u
cd "$(dirname "$0")/../../.." || exit 1
ENGINE=engines/hse/consequence.js
ORACLE=tools/validation/hse/oracle_consequence.py
GOLDEN=test-data/hse/goldens/consequence_cases.json
SUITE=__tests__/hse.consequence.test.js
PY=${PY:-/root/hseenv/bin/python}
FILTER=${1:-}
TMP=$(mktemp -d)
cp "$ENGINE" "$TMP/engine.bak"; cp "$ORACLE" "$TMP/oracle.bak"; cp "$GOLDEN" "$TMP/golden.bak"
restore() { cp "$TMP/engine.bak" "$ENGINE"; cp "$TMP/oracle.bak" "$ORACLE"; cp "$TMP/golden.bak" "$GOLDEN"; }
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
    timeout 300 "$PY" "$ORACLE" >/dev/null 2>&1 || { echo "RED?  [$kind] $name -- the ORACLE itself refused or hung (not a jest result)"; return; }
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

echo "=== baseline ==="
restore
npx jest "$SUITE" 2>&1 | grep -E "^Tests:"

echo "=== ENGINE-ONLY plants (all must be RED) ==="
run_case ENGINE "plume: ground reflection (image source) dropped" \
  "* (Math.exp(-((z - h) ** 2) / (2 * sz * sz)) + Math.exp(-((z + h) ** 2) / (2 * sz * sz)));" "* (Math.exp(-((z - h) ** 2) / (2 * sz * sz)));" "" ""
run_case ENGINE "plume: 2 pi -> pi in the prefactor" \
  "(q / (2 * Math.PI * sy * sz * u))" "(q / (Math.PI * sy * sz * u))" "" ""
run_case ENGINE "sigmas: class D takes the class E row (wrong stability column)" \
  "D: Object.freeze({ sy1: 0.08, sy2: 0.0001, sz1: 0.06, sz2: 0.0015, sz3: -0.5 })" "D: Object.freeze({ sy1: 0.06, sy2: 0.0001, sz1: 0.03, sz2: 0.0003, sz3: -1 })" "" ""
run_case ENGINE "sigmas: sz2 0.0015 -> 0.00015 for class D (the misprint ALOHA warns of)" \
  "sz1: 0.06, sz2: 0.0015," "sz1: 0.06, sz2: 0.00015," "" ""
run_case ENGINE "sigma_y: 1/sqrt(1 + sy2 x) dropped" \
  "const sigmaYM = (c.sy1 * x) / Math.sqrt(1 + c.sy2 * x);" "const sigmaYM = c.sy1 * x;" "" ""
run_case ENGINE "gas: critical pressure ratio inverted" \
  "const rcrit = criticalPressureRatio(g);" "const rcrit = 1 / criticalPressureRatio(g);" "" ""
run_case ENGINE "gas: exactly-critical counted as subsonic (<= read as <)" \
  "const choked = r <= rcrit;" "const choked = r < rcrit;" "" ""
run_case ENGINE "gas: subsonic psi exponent 2/gamma -> 1/gamma" \
  "* r ** (2 / g) * (1 - r ** ((g - 1) / g));" "* r ** (1 / g) * (1 - r ** ((g - 1) / g));" "" ""
run_case ENGINE "liquid: 2 dropped from Bernoulli" \
  "Math.sqrt(2 * deltaPa * liquidDensityKgM3)" "Math.sqrt(deltaPa * liquidDensityKgM3)" "" ""
run_case ENGINE "pool: bund overtopping check removed" \
  "if (depthM > bundWallHeightM) {" "if (false) {" "" ""
run_case ENGINE "evaporation: wind exponent 0.78 -> 0.8" \
  "windSpeed10mMS ** 0.78" "windSpeed10mMS ** 0.8" "" ""
run_case ENGINE "burning rate: diameter correction dropped" \
  ": mInf * (1 - Math.exp(-kb * poolDiameterM));" ": mInf;" "" ""
run_case ENGINE "Thomas wind: u* not clamped at 1" \
  "const uStar = Math.max(1, windSpeed10mMS / ucMS);" "const uStar = windSpeed10mMS / ucMS;" "" ""
run_case ENGINE "tilt: Re exponent 0.117 -> 0.17" \
  "re ** 0.117" "re ** 0.17" "" ""
run_case ENGINE "SEP: 1 + 4 L/D -> 1 + 2 L/D" \
  "/ (1 + (4 * flameLengthM) / poolDiameterM);" "/ (1 + (2 * flameLengthM) / poolDiameterM);" "" ""
run_case ENGINE "view factor: sign of the tilt term in A flipped" \
  "const A = Math.sqrt(a * a + (b + 1) ** 2 - 2 * a * (b + 1) * s);" "const A = Math.sqrt(a * a + (b + 1) ** 2 + 2 * a * (b + 1) * s);" "" ""
run_case ENGINE "view factor: C uses (b - 1)^2 (the extraction-garbled print)" \
  "const C = Math.sqrt(1 + (b * b - 1) * co * co);" "const C = Math.sqrt(1 + (b - 1) ** 2 * co * co);" "" ""
run_case ENGINE "view factor: overhang refusal removed" \
  "if (1 + a * s >= b) {" "if (false) {" "" ""
run_case ENGINE "solid flame: point source instead of the view factor" \
  "const q = solidFlameHeatFlux({ surfaceEmissivePowerWM2: e.surfaceEmissivePowerWM2, viewFactor: vf.viewFactorMax, transmissivity: tau });" \
  "const q = solidFlameHeatFlux({ surfaceEmissivePowerWM2: e.surfaceEmissivePowerWM2, viewFactor: (poolDiameterM * L.flameLengthM) / (4 * Math.PI * distanceFromCentreM ** 2), transmissivity: tau });" "" ""
run_case ENGINE "transmissivity: exponent -0.09 -> -0.08 (the YB jet example's slip)" \
  "transmissivity: 2.02 * p ** -0.09," "transmissivity: 2.02 * p ** -0.08," "" ""
run_case ENGINE "transmissivity: Bagster range guard removed" \
  "if (p < BAGSTER_RANGE_PA_M.min || p > BAGSTER_RANGE_PA_M.max) {" "if (false) {" "" ""
run_case ENGINE "blast: W^(1/2) scaling instead of the cube root" \
  "scaledDistanceMKg13: distanceM / Math.cbrt(tntMassKg)," "scaledDistanceMKg13: distanceM / Math.sqrt(tntMassKg)," "" ""
run_case ENGINE "blast: 808 -> 800 and 0.048 -> 0.049 (the CBU paper's printed form)" \
  "const kgRatio = (z) => (808 * (1 + (z / 4.5) ** 2))
  / (Math.sqrt(1 + (z / 0.048) ** 2)" "const kgRatio = (z) => (800 * (1 + (z / 4.5) ** 2))
  / (Math.sqrt(1 + (z / 0.049) ** 2)" "" ""
run_case ENGINE "blast: Z range guard removed" \
  "if (z < KINNEY_GRAHAM_Z_RANGE.min || z > KINNEY_GRAHAM_Z_RANGE.max) {" "if (false) {" "" ""
run_case ENGINE "TNT: efficiency applied twice" \
  "tntMassKg: (yieldFactor * fuelMassKg * heatOfCombustionJKg) / tntBlastEnergyJKg," "tntMassKg: (yieldFactor * yieldFactor * fuelMassKg * heatOfCombustionJKg) / tntBlastEnergyJKg," "" ""
run_case ENGINE "probit: ln -> log10" \
  "const y = a + b * Math.log(dose);" "const y = a + b * Math.log10(dose);" "" ""
run_case ENGINE "probit: P = Phi(Y) instead of Phi(Y - 5)" \
  "    probability: normalCDF(y - 5)," "    probability: normalCDF(y)," "" ""
run_case ENGINE "thermal: I^(4/3) -> I" \
  "const dose = exposureTimeS * I ** (4 / 3);" "const dose = exposureTimeS * I;" "" ""
run_case ENGINE "thermal: kW/m2 presets fed W/m2" \
  "const I = unit === 'kW/m2' ? heatFluxWM2 / 1000 : heatFluxWM2;" "const I = heatFluxWM2;" "" ""
run_case ENGINE "toxic: exponent n ignored" \
  "const dose = C ** c.n * exposureMinutes;" "const dose = C * exposureMinutes;" "" ""
run_case ENGINE "conversion: molar volume at 0 C instead of the stated T" \
  "export const molarVolumeM3Mol = (temperatureK = 298.15, pressurePa = ATM_PA) => (R_J_MOL_K * temperatureK) / pressurePa;" \
  "export const molarVolumeM3Mol = (temperatureK = 298.15, pressurePa = ATM_PA) => (R_J_MOL_K * 273.15) / pressurePa;" "" ""
run_case ENGINE "overpressure probit: Pa fed where psig is due" \
  "if (unit === 'psig') P = overpressurePa / PA_PER_PSI;" "if (unit === 'psig') P = overpressurePa;" "" ""

echo "=== ORACLE-ONLY plants (all must be RED) ==="
run_case ORACLE "oracle plume: image source dropped" "" "" \
  "        math.exp(-(z - h) ** 2 / (2 * sz * sz)) + math.exp(-(z + h) ** 2 / (2 * sz * sz)))" "        math.exp(-(z - h) ** 2 / (2 * sz * sz)))"
run_case ORACLE "oracle Briggs D sz1 0.06 -> 0.07" "" "" \
  "'D': (0.08, 0.0001, 0.06, 0.0015, -0.5)," "'D': (0.08, 0.0001, 0.07, 0.0015, -0.5),"
run_case ORACLE "oracle Mudan: sign of the tilt term in A flipped" "" "" \
  "A = math.sqrt(a * a + (b + 1) ** 2 - 2 * a * (b + 1) * s)" "A = math.sqrt(a * a + (b + 1) ** 2 + 2 * a * (b + 1) * s)"
run_case ORACLE "oracle route B: surface normal loses its tilt component" "" "" \
  "ndot = -(np.cos(P) * dx + np.sin(P) * dy - np.cos(P) * tt * dz)" "ndot = -(np.cos(P) * dx + np.sin(P) * dy)"
run_case ORACLE "oracle nozzle: throat pressure allowed below ambient" "" "" \
  "bounds=(pa, p0), method='bounded'," "bounds=(1.0, p0), method='bounded',"
run_case ORACLE "oracle Table 5.1 transcription slip 3.36 -> 3.63" "" "" \
  "[None, 2.67, 2.95, 3.12, 3.25, 3.36," "[None, 2.67, 2.95, 3.12, 3.25, 3.63,"
run_case ORACLE "oracle Kinney-Graham 1.35 -> 1.3" "" "" \
  "* math.sqrt(1 + (z / 1.35) ** 2))" "* math.sqrt(1 + (z / 1.3) ** 2))"
run_case ORACLE "oracle probit inverse uses 1 - P" "" "" \
  "            y = 5 + float(norm.ppf(p))
            rounded" "            y = 5 + float(norm.ppf(1 - p))
            rounded"

echo "=== SHARED plants (the same mistake in BOTH files) ==="
run_case SHARED "Mudan: sign of the tilt term in A flipped in both (route B must catch it)" \
  "const A = Math.sqrt(a * a + (b + 1) ** 2 - 2 * a * (b + 1) * s);" "const A = Math.sqrt(a * a + (b + 1) ** 2 + 2 * a * (b + 1) * s);" \
  "A = math.sqrt(a * a + (b + 1) ** 2 - 2 * a * (b + 1) * s)" "A = math.sqrt(a * a + (b + 1) ** 2 + 2 * a * (b + 1) * s)"
run_case SHARED "plume: image source dropped in both (the mass-flux route must catch it)" \
  "* (Math.exp(-((z - h) ** 2) / (2 * sz * sz)) + Math.exp(-((z + h) ** 2) / (2 * sz * sz)));" "* (Math.exp(-((z - h) ** 2) / (2 * sz * sz)));" \
  "        math.exp(-(z - h) ** 2 / (2 * sz * sz)) + math.exp(-(z + h) ** 2 / (2 * sz * sz)))" "        math.exp(-(z - h) ** 2 / (2 * sz * sz)))"
run_case SHARED "Kinney-Graham 808 -> 800 in both (the CBU table must catch it)" \
  "const kgRatio = (z) => (808 * (1 + (z / 4.5) ** 2))" "const kgRatio = (z) => (800 * (1 + (z / 4.5) ** 2))" \
  "    return 808 * (1 + (z / 4.5) ** 2)" "    return 800 * (1 + (z / 4.5) ** 2)"
run_case SHARED "Thomas wind 55 -> 50 in both (the YB example must catch it)" \
  "const ld = 55 * (burningFluxKgM2S" "const ld = 50 * (burningFluxKgM2S" \
  "    return 55 * (m / (rho * (G * d) ** 0.5))" "    return 50 * (m / (rho * (G * d) ** 0.5))"
run_case SHARED "Lees chlorine a -8.29 -> -8.39 in both (OSD/30 Table 2 must catch it)" \
  "'lees-chlorine': Object.freeze({ a: -8.29," "'lees-chlorine': Object.freeze({ a: -8.39," \
  "('chlorine', -8.29, 0.92, 2.0," "('chlorine', -8.39, 0.92, 2.0,"
run_case SHARED "Mackay-Matsugu wind exponent 0.78 -> 0.8 in both (single route: expected GREEN)" \
  "windSpeed10mMS ** 0.78" "windSpeed10mMS ** 0.8" \
  "km = 0.004786 * u ** 0.78" "km = 0.004786 * u ** 0.8"
run_case SHARED "Bagster exponent -0.09 -> -0.08 in both (single route: expected GREEN)" \
  "transmissivity: 2.02 * p ** -0.09," "transmissivity: 2.02 * p ** -0.08," \
  "'expected': {'transmissivity': 2.02 * pr ** -0.09}" "'expected': {'transmissivity': 2.02 * pr ** -0.08}"
run_case SHARED "Burgess 0.001 -> 0.0011 in both (single route: expected GREEN)" \
  "const m = (0.001 * heatOfCombustionJKg)" "const m = (0.0011 * heatOfCombustionJKg)" \
  "'burningFluxKgM2S': 0.001 * 4" "'burningFluxKgM2S': 0.0011 * 4"

restore
echo "=== restored; verifying clean ==="
cmp -s "$GOLDEN" "$TMP/golden.bak" && echo "golden restored byte-identical"
"$PY" "$ORACLE" >/dev/null && cmp -s "$GOLDEN" "$TMP/golden.bak" && echo "oracle regenerates the golden byte-identical"
npx jest "$SUITE" 2>&1 | grep -E "^Tests:"
