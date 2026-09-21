#!/usr/bin/env bash
# HSE H1 negative controls for the safetyStats gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-safetystats.md about what this suite catches was produced by
# running this file: each row plants ONE defect, runs the suite, and records
# whether it went red.
#
#   ENGINE  plants go in engines/hse/safetyStats.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/hse/oracle_safetystats.py alone,
#           with the golden regenerated. All must go RED (the harness can tell
#           the two files apart) or STOP (the oracle's own scipy-versus-mpmath
#           cross-check refused to write a golden).
#
# Needs a python with scipy and mpmath for the ORACLE rows:
#   PY=/root/hseenv/bin/python tools/validation/hse/negcontrol_safetystats.sh [filter]
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/hse/safetyStats.js
ORACLE=tools/validation/hse/oracle_safetystats.py
GOLDEN=test-data/hse/goldens/safetyStats_cases.json
TEST=__tests__/hse.safetyStats.test.js
TMP=$(mktemp -d)
cp "$ENGINE" "$TMP/engine.bak"; cp "$ORACLE" "$TMP/oracle.bak"; cp "$GOLDEN" "$TMP/golden.bak"
restore() { cp "$TMP/engine.bak" "$ENGINE"; cp "$TMP/oracle.bak" "$ORACLE"; cp "$TMP/golden.bak" "$GOLDEN"; }
trap restore EXIT

plant() { # file from to
  "$PY" - "$1" "$2" "$3" <<'PYEOF'
import sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if s.count(a) != 1:
    sys.stderr.write("PLANT TARGET NOT UNIQUE (%d): %s\n" % (s.count(a), a))
    sys.exit(3)
open(path, "w").write(s.replace(a, b))
PYEOF
}

run_case() { # kind name engine_from engine_to oracle_from oracle_to
  kind=$1; name=$2; ef=$3; et=$4; of=$5; ot=$6
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  if [ -n "$ef" ]; then plant "$ENGINE" "$ef" "$et" || { echo "SKIP  $name (engine target)"; return; }; fi
  if [ -n "$of" ]; then
    plant "$ORACLE" "$of" "$ot" || { echo "SKIP  $name (oracle target)"; return; }
    if ! "$PY" "$ORACLE" >/dev/null 2>&1; then
      echo "STOP  [$kind] $name -- the oracle's own cross-check refused to write a golden"
      return
    fi
  fi
  out=$(timeout 300 npx jest "$TEST" 2>&1)
  rc=$?
  if [ $rc -eq 124 ]; then
    echo "HANG  [$kind] $name"
  elif echo "$out" | grep -q "Tests:.*failed"; then
    n=$(echo "$out" | grep -E "^Tests:" | grep -oE "[0-9]+ failed")
    first=$(echo "$out" | grep -E "^\s+●" | sed 's/^ *● //' | head -2 | tr '\n' ';')
    echo "RED   [$kind] $name -- $n -- $first"
  else
    echo "GREEN [$kind] $name -- NOT CAUGHT"
  fi
}

echo "=== baseline ==="
restore
npx jest "$TEST" 2>&1 | grep -E "^Tests:"

echo "=== ENGINE plants (all must be RED) ==="
run_case ENGINE "rolling window: mean of monthly rates instead of sum-then-divide" \
  "rate: hours > 0 ? (count * base) / hours : null," \
  "rate: monthly.length > 0 ? monthly.reduce((a, b) => a + b, 0) / monthly.length : null," "" ""
run_case ENGINE "pooled: mean of period rates instead of sum-then-divide" \
  "rate: (count * base) / hours,
    count," \
  "rate: rated.reduce((a, b) => a + b, 0) / rated.length,
    count," "" ""
run_case ENGINE "Garwood upper df 2N+2 -> 2N" \
  "chiSquareQuantileUpper(alpha / 2, 2 * count + 2)" "chiSquareQuantileUpper(alpha / 2, 2 * count)" "" ""
run_case ENGINE "Garwood lower df 2N -> 2N+2" \
  "chiSquareQuantile(alpha / 2, 2 * count) / 2" "chiSquareQuantile(alpha / 2, 2 * count + 2) / 2" "" ""
run_case ENGINE "Garwood upper at alpha, not alpha/2" \
  "chiSquareQuantileUpper(alpha / 2, 2 * count + 2)" "chiSquareQuantileUpper(alpha, 2 * count + 2)" "" ""
run_case ENGINE "gamma inversion always on the lower tail (1 - P for upper quantiles)" \
  "const useLower = p <= q;" "const useLower = true;" "" ""
run_case ENGINE "gamma series stops at 1e-6" \
  "if (Math.abs(del) < Math.abs(sum) * EPS) break;" "if (Math.abs(del) < Math.abs(sum) * 1e-6) break;" "" ""
run_case ENGINE "Lanczos coefficient truncated to 13 figures" \
  "676.5203681218851" "676.5203681218" "" ""
run_case ENGINE "compare: one tail, not doubled" \
  "Math.min(1, 2 * Math.min(lower, upper))" "Math.min(lower, upper)" "" ""
run_case ENGINE "compare: Clopper-Pearson lower at alpha, not alpha/2" \
  "binomUpperTail(lc, n, count1, p) - alpha / 2" "binomUpperTail(lc, n, count1, p) - alpha" "" ""
run_case ENGINE "compare: expected proportion from the wrong group's hours" \
  "const p0 = exposureHours1 / (exposureHours1 + exposureHours2);" "const p0 = exposureHours2 / (exposureHours1 + exposureHours2);" "" ""
run_case ENGINE "u-chart: 2 sigma limits" \
  "const half = 3 * Math.sqrt(ubar / units[i]);" "const half = 2 * Math.sqrt(ubar / units[i]);" "" ""
run_case ENGINE "u-chart: lower limit not floored" \
  "const lcl = Math.max(0, rawLcl);" "const lcl = rawLcl;" "" ""
run_case ENGINE "u-chart: a point ON the limit signals" \
  "if (u > ucl) signal = 'above';" "if (u >= ucl) signal = 'above';" "" ""
run_case ENGINE "u-chart: centre as the mean of the u_i" \
  "const ubar = total / units.reduce((a, b) => a + b, 0);" \
  "const ubar = counts.reduce((s, ci, i) => s + ci / units[i], 0) / counts.length;" "" ""
run_case ENGINE "FAR on a 1,000,000 base" \
  "FAR_100M: 100000000," "FAR_100M: 1000000," "" ""
run_case ENGINE "a silent default base of 200,000" \
  "export const incidenceRate = ({ count, exposureHours, base } = {}) => {" \
  "export const incidenceRate = ({ count, exposureHours, base = 200000 } = {}) => {" "" ""
run_case ENGINE "events in a month with no hours accepted" \
  "if (hours[i] === 0 && counts[i] > 0) {" "if (false) {" "" ""
run_case ENGINE "API 754 base check removed" \
  "if (base !== RATE_BASES.OSHA_200K && base !== RATE_BASES.IOGP_1M) {" "if (false) {" "" ""

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
run_case ORACLE "oracle rolling: mean of monthly rates" "" "" \
  "'rate': fl(F(c) * base / h) if h > 0 else None," \
  "'rate': fl(sum(rated) / len(rated)) if rated else None,"
run_case ORACLE "oracle u-chart 2.5 sigma" "" "" \
  "half = 3 * math.sqrt(fl(ubar / n))" "half = 2.5 * math.sqrt(fl(ubar / n))"
run_case ORACLE "oracle Garwood upper df 2N+2 -> 2N (arbiter only)" "" "" \
  "hi_m = fl(mp_chi2_ppf(alpha / 2, 2 * n + 2, upper=True)) / 2" \
  "hi_m = fl(mp_chi2_ppf(alpha / 2, 2 * n, upper=True)) / 2"
run_case ORACLE "oracle compare: one tail, not doubled" "" "" \
  "pval = min(1.0, 2 * min(lower, upper))" "pval = min(lower, upper)"

restore
echo "=== restored; verifying clean ==="
npx jest "$TEST" 2>&1 | grep -E "^Tests:"
