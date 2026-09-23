#!/usr/bin/env bash
# Data & AI D1 negative controls for the quality gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-quality.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/dataai/quality.js (or, for the reused
#           Hampel decision, engines/petrophysics/conditioning.js) alone.
#           All must go RED.
#   ORACLE  plants go in tools/validation/dataai/oracle_quality.py alone,
#           with the golden regenerated. All must go RED (the harness can
#           tell the two files apart) or STOP (the oracle's own
#           cross-check refused to write a golden).
#
#   tools/validation/dataai/negcontrol_quality.sh [filter]
#
# The last line reports N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/dataai/quality.js
COND=engines/petrophysics/conditioning.js
ORACLE=tools/validation/dataai/oracle_quality.py
GOLDEN=test-data/dataai/goldens/quality_cases.json
TEST=__tests__/dataai.quality.test.js
TMP=$(mktemp -d)
cp "$ENGINE" "$TMP/engine.bak"; cp "$COND" "$TMP/cond.bak"; cp "$ORACLE" "$TMP/oracle.bak"; cp "$GOLDEN" "$TMP/golden.bak"
restore() { cp "$TMP/engine.bak" "$ENGINE"; cp "$TMP/cond.bak" "$COND"; cp "$TMP/oracle.bak" "$ORACLE"; cp "$TMP/golden.bak" "$GOLDEN"; }
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

ENGINE_RUN=0
ENGINE_RED=0

run_case() { # kind name file from to
  kind=$1; name=$2; file=$3; from=$4; to=$5
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  plant "$file" "$from" "$to" || { echo "SKIP  $name (target)"; return; }
  if [ "$kind" = ORACLE ]; then
    if ! "$PY" "$ORACLE" >/dev/null 2>&1; then
      echo "STOP  [$kind] $name -- the oracle's own cross-check refused to write a golden"
      return
    fi
  else
    ENGINE_RUN=$((ENGINE_RUN + 1))
  fi
  out=$(timeout 300 npx jest "$TEST" 2>&1)
  rc=$?
  if [ $rc -eq 124 ]; then
    echo "HANG  [$kind] $name"
  elif echo "$out" | grep -q "Tests:.*failed"; then
    n=$(echo "$out" | grep -E "^Tests:" | grep -oE "[0-9]+ failed")
    first=$(echo "$out" | grep -E "^\s+●" | sed 's/^ *● //' | head -1)
    echo "RED   [$kind] $name -- $n -- $first"
    [ "$kind" = ENGINE ] && ENGINE_RED=$((ENGINE_RED + 1))
  else
    echo "GREEN [$kind] $name -- NOT CAUGHT"
  fi
}

E=$ENGINE
echo "=== baseline ==="
restore
npx jest "$TEST" 2>&1 | grep -E "^Tests:"

echo "=== ENGINE plants (all must be RED) ==="
run_case ENGINE "completeness: null fraction over present, not n" $E "nullFraction: missing / n," "nullFraction: missing / Math.max(1, n - missing),"
run_case ENGINE "coverage: a step equal to maxStep is a hole" $E "if (pts[j] - pts[j - 1] <= maxStep) {" "if (pts[j] - pts[j - 1] < maxStep) {"
run_case ENGINE "index: duplicates only when adjacent" $E "if (seen.has(v)) {" "if (prev !== null && index[prev] === v) {"
run_case ENGINE "range: exclusive bound treated as inclusive" $E "const low = lim.minExclusive ? v <= lim.min : v < lim.min;" "const low = v < lim.min;"
run_case ENGINE "rate: hours on 0 not read as shut in" $E "|| (hoursOn && hoursOn[i] === 0);" ";"
run_case ENGINE "cumulative: meter tolerance ignored" $E "if (last !== null && cumulative[last] - v > tolerance) {" "if (last !== null && cumulative[last] - v > 0) {"
run_case ENGINE "water cut on an oil basis" $E "wcCalc = water[i] / (oil[i] + water[i]);" "wcCalc = water[i] / Math.max(oil[i], 1e-9);"
run_case ENGINE "phase sum tolerance relative to the sum, not the total" $E "const allowed = Math.max(absTolerance, relTolerance * Math.abs(t));" "const allowed = Math.max(absTolerance, relTolerance * Math.abs(s));"
run_case ENGINE "frozen run compares with the previous value (lets a drift through)" $E "if (s >= 0 && Math.abs(v - values[s]) <= tolerance) continue;" "if (s >= 0 && Math.abs(v - values[i - 1]) <= tolerance) continue;"
run_case ENGINE "Levenshtein substitution costs 2" $E "prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)" "prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 2)"
run_case ENGINE "normalisation keeps leading zeros" $E "if (stripLeadingZeros) s = s.replace" "if (false) s = s.replace"
run_case ENGINE "near duplicates ignore the digit rule" $E "(!digitsMustMatch || digitsOf(norm[i]) === digitsOf(norm[j]))" "true"
run_case ENGINE "quantile R7 computed as R6" $E "else if (method === 'R7') h = 1 + p * (n - 1);" "else if (method === 'R7') h = p * (n + 1);"
run_case ENGINE "z-score defaults to the population SD" $E "sd = 'sample' } = {}) => {" "sd = 'population' } = {}) => {"
run_case ENGINE "modified z scale 1/1.4826 instead of the printed 0.6745" $E "MODIFIED_Z_SCALE: 0.6745," "MODIFIED_Z_SCALE: 1 / 1.4826,"
run_case ENGINE "modified z on a scaled MAD" $E "const mad = median(x.map((v) => Math.abs(v - med)));
  if (!(mad > 0))" "const mad = 1.4826 * median(x.map((v) => Math.abs(v - med)));
  if (!(mad > 0))"
run_case ENGINE "Tukey k = 2 by default" $E "TUKEY_K: 1.5," "TUKEY_K: 2,"
run_case ENGINE "a value on the fence is flagged" $E "if (v < lower) flags.push" "if (v <= lower) flags.push"
run_case ENGINE "Hampel window one sample wider" $E "const out = despikeHampel(x, halfWindow, nSigma);" "const out = despikeHampel(x, halfWindow + 1, nSigma);"
run_case ENGINE "Hampel (petrophysics): a point on the threshold is a spike" $COND "if (Math.abs(x[i] - med) > nSigma * 1.4826 * mad) out[i] = med;" "if (Math.abs(x[i] - med) >= nSigma * 1.4826 * mad) out[i] = med;"
run_case ENGINE "incomplete beta continued fraction stops at 1e-6" $E "if (Math.abs(del - 1) < 1e-16) break;" "if (Math.abs(del - 1) < 1e-6) break;"
run_case ENGINE "Grubbs two-sided at alpha/N, not alpha/(2N)" $E "? alpha / (2 * n) : alpha / n;" "? alpha / n : alpha / n;"
run_case ENGINE "Grubbs t on N - 1 degrees of freedom" $E "studentTUpperQuantile(tailProb, n - 2)" "studentTUpperQuantile(tailProb, n - 1)"
run_case ENGINE "Mahalanobis population covariance" $E "cov[a][c] /= n - 1;" "cov[a][c] /= n;"
run_case ENGINE "Mahalanobis cutoff on p + 1 degrees of freedom" $E "chiSquareQuantile(1 - alpha, p)" "chiSquareQuantile(1 - alpha, p + 1)"
run_case ENGINE "individuals d2 = 1.13" $E "D2_N2: 1.128," "D2_N2: 1.13,"
run_case ENGINE "MR chart D4 = 3" $E "D4_N2: 3.267," "D4_N2: 3,"
run_case ENGINE "individuals 2-sigma limits" $E "const ucl = cl + 3 * sigma;" "const ucl = cl + 2 * sigma;"
run_case ENGINE "EWMA starts at the first observation" $E "let e = target;" "let e = values[0];"
run_case ENGINE "EWMA variance factor lambda/2 instead of lambda/(2 - lambda)" $E "const factor = Math.sqrt(lambda / (2 - lambda));" "const factor = Math.sqrt(lambda / 2);"
run_case ENGINE "EWMA exact limits exponent t, not 2t" $E "(1 - lambda) ** (2 * t)" "(1 - lambda) ** t"
run_case ENGINE "CUSUM without the max(0, .) floor" $E "hi = Math.max(0, hi + v - target - kd);" "hi = hi + v - target - kd;"
run_case ENGINE "CUSUM signals AT h" $E "const up = hi > hd;" "const up = hi >= hd;"
run_case ENGINE "CUSUM sigma units ignored" $E "if (e) return e; scale = sigma; }" "if (e) return e; }"
run_case ENGINE "scorecard weights not normalised" $E "weight: w[i] / wsum, contribution: (w[i] / wsum) * r.score" "weight: w[i], contribution: w[i] * r.score"
run_case ENGINE "scorecard tie goes to the last listed" $E "if (r.score < weakest.score) weakest = r;" "if (r.score <= weakest.score) weakest = r;"
# foundation findings (fix/dataai-quality-foundation-findings)
run_case ENGINE "z ceiling uses the sample form for the population SD too" $E "const bound = sd === 'sample' ? (n - 1) / Math.sqrt(n) : Math.sqrt(n - 1);" "const bound = (n - 1) / Math.sqrt(n);"
run_case ENGINE "reason figures rounded to 6 significant figures" $E "  return String(x);
};" "  return String(Number(x.toPrecision(6)));
};"
run_case ENGINE "reason figures rounded to 6 decimal places" $E "  return String(x);
};" "  return String(Number(x.toFixed(6)));
};"
run_case ENGINE "Hampel nSigma not echoed in the result" $E "    halfWindow,
    nSigma,
    points," "    halfWindow,
    points,"
run_case ENGINE "Hampel nSigma not echoed in the basis" $E "basis: { halfWindow, nSigma, madScale" "basis: { halfWindow, madScale"
# zero-MAD wording (fix/dataai-zero-mad-wording): the refusal states the exact condition
run_case ENGINE "zero-MAD refusal says at least half (the old wording)" $E "MAD = 0: more than half the present values" "MAD = 0: at least half the present values"
run_case ENGINE "zero-MAD refused at least half on the median" $E "if (!(mad > 0)) return refuse('values', 'have MAD" "if (!(mad > 0) || 2 * x.filter((v) => v === med).length >= x.length) return refuse('values', 'have MAD"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle modified z scale 0.675" $O "mz = F('0.6745') * (F(v) - med) / mad" "mz = F('0.675') * (F(v) - med) / mad"
run_case ORACLE "oracle CUSUM without the floor" $O "hi = max(F(0), hi + v - F(target) - kd)" "hi = hi + v - F(target) - kd"
run_case ORACLE "oracle R7 as R6 (statistics.quantiles cross-check)" $O "        h = 1 + p * (n - 1)" "        h = p * (n + 1)"
run_case ORACLE "oracle Grubbs t on N - 1 df" $O "t = t_upper_quantile(tail, n - 2)" "t = t_upper_quantile(tail, n - 1)"
run_case ORACLE "oracle z ceiling closed form sample-only" $O "    closed = F((n - 1) ** 2, n) if sd == 'sample' else F(n - 1)" "    closed = F((n - 1) ** 2, n)"
run_case ORACLE "oracle z ceiling from the sample variance for both SDs" $O "    var = ss / (n - 1) if sd == 'sample' else ss / n
    c2 =" "    var = ss / (n - 1)
    c2 ="
run_case ORACLE "oracle number layout switches to exponent form one decade late" $O "    elif -6 < n <= 0:" "    elif -7 < n <= 0:"
run_case ORACLE "oracle zero-MAD refusal says at least half (the old wording)" $O "MAD = 0: more than half the present values" "MAD = 0: at least half the present values"
run_case ORACLE "oracle refuses at least half on the median" $O "    if mad == 0:
        return {'error': True, 'field': 'values', 'message': MODZ_ZERO_MAD}" "    if 2 * on_median >= len(xs):
        return {'error': True, 'field': 'values', 'message': MODZ_ZERO_MAD}"
run_case ORACLE "oracle cross-check states at least half" $O "assert (mad == 0) == (2 * on_median > len(xs))" "assert (mad == 0) == (2 * on_median >= len(xs))"

restore
echo "=== restored; verifying clean ==="
npx jest "$TEST" 2>&1 | grep -E "^Tests:"
echo "ENGINE plants red: $ENGINE_RED/$ENGINE_RUN"
