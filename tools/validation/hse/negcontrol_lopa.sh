#!/usr/bin/env bash
# H3 negative controls for the LOPA / SIL gate (engines/hse/lopa.js).
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-lopa.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/hse/lopa.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/hse/oracle_lopa.py alone, with the
#           golden regenerated. All must go RED: the control on the controls.
#   SHARED  plants go in BOTH, for rules that are specification rather than
#           mathematics (no independent route can derive them). EXPECTED
#           GREEN, and that is the honest statement of what is unvalidated.
#
# Usage: tools/validation/hse/negcontrol_lopa.sh [filter]
set -u
cd "$(dirname "$0")/../../.." || exit 1
ENGINE=engines/hse/lopa.js
ORACLE=tools/validation/hse/oracle_lopa.py
GOLDEN=test-data/hse/goldens/lopa_cases.json
SUITE=__tests__/hse.lopa.test.js
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
    timeout 120 python3 "$ORACLE" >/dev/null || { echo "RED?  [$kind] $name -- the ORACLE itself refused or hung (not a jest result)"; return; }
  fi
  out=$(timeout 180 npx jest "$SUITE" 2>&1)
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
run_case ENGINE "1oo1 loses the /2 (lambdaDU T instead of lambdaDU T/2)" \
  "      independent = lD * tCE;" "      independent = 2 * lD * tCE;" "" ""
run_case ENGINE "down time T/(j+1) -> T/j everywhere (the /2 and /3 both shift)" \
  "const covered = v.t1 / (j + 1) + v.mrt;" "const covered = v.t1 / j + v.mrt;" "" ""
run_case ENGINE "tGE uses T/2 instead of T/3 in 1oo2/2oo3/1oo3" \
  "tGE = equivalentDownTime(v, 2);" "tGE = equivalentDownTime(v, 1);" "" ""
run_case ENGINE "(1-beta) dropped from the independent rate" \
  "(1 - v.b) * v.lDU" "v.lDU" "" ""
run_case ENGINE "2oo3 multiplicity 6 -> 3" \
  "independent = 6 * lInd ** 2 * tCE * tGE;" "independent = 3 * lInd ** 2 * tCE * tGE;" "" ""
run_case ENGINE "MRT dropped from the DU down time" \
  "const covered = v.t1 / (j + 1) + v.mrt;" "const covered = v.t1 / (j + 1);" "" ""
run_case ENGINE "CCF DD term uses MRT instead of MTTR" \
  "const ccfDD = v.bD * v.lDD * v.mttr;" "const ccfDD = v.bD * v.lDD * v.mrt;" "" ""
run_case ENGINE "proof test coverage ignored" \
  "if (v.ptc === 1) return covered;" "return covered;" "" ""
run_case ENGINE "decade snap removed (exact float equality)" \
  "return Math.abs(x / 10 ** r - 1) <= DECADE_SNAP ? r : null;" "return x === 10 ** r ? r : null;" "" ""
run_case ENGINE "mis-band: an exact decade goes to the lower-PFD (higher SIL) band" \
  "if (r !== null) return -r;" "if (r !== null) return -r + 1;" "" ""
run_case ENGINE "f == TMEL demands a SIF (RRF <= 1 read as < 1)" \
  "if (rrf < 1 || one) {" "if (rrf < 1) {" "" ""
run_case ENGINE "beyond SIL 3 clipped into the band table" \
  "  if (n > 3) {" "  if (n > 99) {" "" ""
run_case ENGINE "independence flag ignored (every IPL credited)" \
  "if (ipl.independent !== true) {" "if (false) {" "" ""
run_case ENGINE "duplicate IPL accepted (credit taken twice)" \
  "if (seen.has(key)) return" "if (false) return" "" ""

echo "=== ORACLE-ONLY plants (all must be RED) ==="
run_case ORACLE "oracle route A down time T/(j+1) -> T/j" "" "" \
  "cov = T1 / (j + 1) + mrt" "cov = T1 / j + mrt"
run_case ORACLE "oracle route B average inflated 2 percent" "" "" \
  "return total / T2" "return 1.02 * total / T2"
run_case ORACLE "oracle band: an exact RRF decade put in the higher SIL" "" "" \
  "if 10 ** n < rrf <= 10 ** (n + 1):" "if 10 ** n <= rrf < 10 ** (n + 1):"
run_case ORACLE "oracle successive failure rate (n-j) -> (n-j+1)" "" "" \
  "rate *= (n - j) * lam" "rate *= (n - j + 1) * lam"

echo "=== SHARED plants (EXPECTED GREEN: specification, not mathematics) ==="
run_case SHARED "the 'auditable: false' credit exclusion removed in BOTH" \
  "} else if (ipl.auditable === false) {" "} else if (false) {" \
  "ipl.get('independent') is True and ipl.get('auditable') is not False" "ipl.get('independent') is True"

restore
echo "=== restored; verifying clean ==="
cmp -s "$GOLDEN" "$TMP/golden.bak" && echo "golden restored byte-identical"
npx jest "$SUITE" 2>&1 | grep -E "^Tests:"
