#!/usr/bin/env bash
# FC5-0 negative controls for the relief-and-flare gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-relief.md about what this suite now catches was produced by
# running this file: each row plants ONE defect, runs the suite, and
# records whether it went red and which test named it.
#
#   ENGINE  plants go in engines/facilities/relief.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/facilities/oracle_relief.py alone,
#           with the golden regenerated. All must go RED: this is the control
#           on the controls, proving the harness can tell the two files apart.
#   SHARED  plants go in BOTH, for the two expressions this package shares on
#           purpose (the Kv fit and the sphere-drag correlation, neither of
#           which any route here can derive). These are EXPECTED GREEN and are
#           the honest statement of what is still unvalidated.
#
# Usage: tools/validation/facilities/negcontrol_relief.sh [filter]
set -u
cd "$(dirname "$0")/../../.." || exit 1
ENGINE=engines/facilities/relief.js
ORACLE=tools/validation/facilities/oracle_relief.py
GOLDEN=test-data/facilities/goldens/relief_cases.json
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

run_case() { # kind name [engine_from engine_to] [oracle_from oracle_to]
  kind=$1; name=$2; ef=$3; et=$4; of=$5; ot=$6
  [ -n "${FILTER:-}" ] && case "$name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  if [ -n "$ef" ]; then plant "$ENGINE" "$ef" "$et" || { echo "SKIP  $name (engine target missing)"; return; }; fi
  if [ -n "$of" ]; then
    plant "$ORACLE" "$of" "$ot" || { echo "SKIP  $name (oracle target missing)"; return; }
    python3 "$ORACLE" >/dev/null || { echo "SKIP  $name (oracle failed)"; return; }
  fi
  out=$(timeout 120 npx jest __tests__/facilities.relief.test.js 2>&1)
  rc=$?
  if [ $rc -eq 124 ]; then
    echo "HANG  [$kind] $name -- the suite never returned"
  elif echo "$out" | grep -q "Tests:.*failed"; then
    failed=$(echo "$out" | grep -E "^\s+●" | grep -v "Console" | sed 's/^ *● //' | sort -u | head -3 | tr '\n' ';')
    n=$(echo "$out" | grep -oE "[0-9]+ failed" | head -1)
    echo "RED   [$kind] $name -- $n -- $failed"
  else
    echo "GREEN [$kind] $name -- NOT CAUGHT"
  fi
}

echo "=== baseline ==="
restore
npx jest __tests__/facilities.relief.test.js 2>&1 | grep -E "^Tests:"

echo "=== ENGINE-ONLY plants (all must be RED) ==="
run_case ENGINE "liquidKv 342.75 -> 340" \
  "342.75 / reynolds ** 1.5" "340 / reynolds ** 1.5" "" ""
run_case ENGINE "liquid Reynolds 2800 -> 2500" \
  "qGpm * 2800 * sg" "qGpm * 2500 * sg" "" ""
run_case ENGINE "Kv clamp removed (a correction that adds capacity)" \
  "return Number.isNaN(raw) ? NaN : Math.min(raw, 1.0);" "return raw;" "" ""
run_case ENGINE "steamKn 0.1906 -> 0.19" \
  "(0.1906 * p1Psia - 1000)" "(0.19 * p1Psia - 1000)" "" ""
run_case ENGINE "blowdown: the hidden 0.975 put back" \
  "(c * pOf(m, t) * (aFt2 * 144)" "(c * 0.975 * pOf(m, t) * (aFt2 * 144)" "" ""
run_case ENGINE "blowdown temperature exponent k-1 -> k" \
  "t0R * (m / m0) ** (k - 1)" "t0R * (m / m0) ** k" "" ""
run_case ENGINE "blowdown: the substep cap removed" \
  "if (w0 * dt > cap)" "if (false && w0 * dt > cap)" "" ""
run_case ENGINE "blowdown: the terminal landing overshoots again" \
  "const frac = (lo + hi) / 2;" "const frac = 1;" "" ""
run_case ENGINE "drum fall distance loses (1 - liquidFraction)" \
  "const fallFt = diameterFt * (1 - liquidFraction);" "const fallFt = diameterFt;" "" ""
run_case ENGINE "drum length v*fall/ud -> v*fall*ud" \
  "const requiredLengthFt = vVapor * (fallFt / udFtS);" "const requiredLengthFt = vVapor * (fallFt * udFtS);" "" ""
run_case ENGINE "drum segment area / 2pi -> / 2.02pi" \
  "(theta - Math.sin(theta)) / (2 * Math.PI)" "(theta - Math.sin(theta)) / (2.02 * Math.PI)" "" ""
run_case ENGINE "vertical wetted area halved" \
  "areaFt2: Math.PI * diameterFt * Math.min(liquidLevelFt, lengthFt)" "areaFt2: 0.5 * Math.PI * diameterFt * Math.min(liquidLevelFt, lengthFt)" "" ""
run_case ENGINE "horizontal wetted arc 2 acos -> 2.02 acos" \
  "const theta = 2 * Math.acos((r - h) / r);" "const theta = 2.02 * Math.acos((r - h) / r);" "" ""
run_case ENGINE "orientation matched with === again" \
  "const o = String(orientation ?? '').trim().toLowerCase();" "const o = orientation;" "" ""
run_case ENGINE "fire exponent 0.82 -> 0.80" \
  "wettedFt2 ** 0.82" "wettedFt2 ** 0.80" "" ""
run_case ENGINE "settling coefficient sqrt(4/3) -> 1.15 (the printed rounding)" \
  "const coeff = Math.sqrt(4 / 3);" "const coeff = 1.15;" "" ""
run_case ENGINE "settling coefficient -> 1.30" \
  "const coeff = Math.sqrt(4 / 3);" "const coeff = 1.30;" "" ""
run_case ENGINE "drag law + 0.34 -> + 0.50 (engine alone)" \
  "3 / Math.sqrt(re) + 0.34" "3 / Math.sqrt(re) + 0.50" "" ""
run_case ENGINE "point source 4 pi -> 4.4 pi, both directions" \
  "4 * Math.PI * distanceM ** 2" "4.4 * Math.PI * distanceM ** 2" "" ""
run_case ENGINE "setback 4 pi -> 4.4 pi (inverse alone)" \
  "4 * Math.PI * allowableKwM2" "4.4 * Math.PI * allowableKwM2" "" ""
run_case ENGINE "subcritical F2 exponent 2/k -> 2.05/k" \
  "r ** (2 / k) * ((1 - r" "r ** (2.05 / k) * ((1 - r" "" ""
run_case ENGINE "the coefficient ceiling of 1 removed" \
  "|| !(v > 0) || v > 1) {" "|| !(v > 0)) {" "" ""
run_case ENGINE "the time-step guard removed (this used to hang)" \
  "if (!Number.isFinite(dtS) || !(dtS > 0)) return { error: 'the time step must be a finite number above zero' };" "" "" ""

echo "=== ORACLE-ONLY plants (all must be RED: the control on the controls) ==="
run_case ORACLE "oracle critical flux scaled 1.01" "" "" \
  "g_flux = c_true * p1" "g_flux = 1.01 * c_true * p1"
run_case ORACLE "oracle liquid 11.78 -> 11.5" "" "" \
  "return 11.78 * q" "return 11.5 * q"
run_case ORACLE "oracle sphere quadrature 2 pi -> 2.2 pi" "" "" \
  "return 2.0 * math.pi * r * r * simpson" "return 2.2 * math.pi * r * r * simpson"
run_case ORACLE "oracle blowdown drops the phi factor" "" "" \
  "b = a * phi *" "b = a *"
run_case ORACLE "oracle polyline arc scaled 1.001" "" "" \
  "return (4.0 * s2 - s1) / 3.0" "return 1.001 * (4.0 * s2 - s1) / 3.0"

echo "=== SHARED-BY-DESIGN plants (EXPECTED GREEN, and that is the finding) ==="
run_case SHARED "the Kv fit's 342.75 in BOTH files" \
  "342.75 / reynolds ** 1.5" "340 / reynolds ** 1.5" \
  "342.75 / reynolds ** 1.5" "340 / reynolds ** 1.5"
run_case SHARED "the drag correlation's 0.34 in BOTH files" \
  "3 / Math.sqrt(re) + 0.34" "3 / Math.sqrt(re) + 0.50" \
  "3.0 / math.sqrt(re) + 0.34" "3.0 / math.sqrt(re) + 0.50"

restore
echo "=== restored; verifying clean ==="
npx jest __tests__/facilities.relief.test.js 2>&1 | grep -E "^Tests:"
