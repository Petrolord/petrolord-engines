#!/usr/bin/env bash
# Data & AI D2 negative controls for the machine learning gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-ml.md about what this suite catches was produced by running this
# file: each row plants ONE defect, runs the suite, and records whether it
# went red.
#
#   ENGINE  plants go in engines/dataai/ml.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/dataai/oracle_ml.py alone, with the
#           golden regenerated. All must go RED (the harness can tell the
#           two files apart) or STOP (the oracle's own cross-check refused
#           to write a golden).
#
#   tools/validation/dataai/negcontrol_ml.sh [filter]
#
# The last line reports N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/dataai/ml.js
ORACLE=tools/validation/dataai/oracle_ml.py
GOLDEN=test-data/dataai/goldens/ml_cases.json
TEST=__tests__/dataai.ml.test.js
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
# preprocessing
run_case ENGINE "scaler fitted on ALL rows (trainIndices ignored)" $E "return { rows: pick(X, trainIndices), idx: [...trainIndices] };" "return { rows: X, idx: [...trainIndices] };"
run_case ENGINE "scaler defaults to the sample SD" $E "sd = 'population' } = {}) => {" "sd = 'sample' } = {}) => {"
run_case ENGINE "min-max divides by the maximum, not the range" $E "min.push(lo); max.push(hi); centre.push(lo); scale.push(hi - lo);" "min.push(lo); max.push(hi); centre.push(lo); scale.push(hi);"
# splits
run_case ENGINE "a group split leaks the first row of each test well into training" $E "groups.forEach((x, i) => (test.has(x) ? testIndices : trainIndices).push(i));" "groups.forEach((x, i) => (test.has(x) && groups.indexOf(x) !== i ? testIndices : trainIndices).push(i));"
run_case ENGINE "Fisher-Yates draws floor(u i) (Sattolo)" $E "const j = Math.floor(rng() * (i + 1));" "const j = Math.floor(rng() * i);"
run_case ENGINE "k-fold deals contiguous blocks, not round robin" $E "const foldOf = new Map(order.map((id, q) => [id, q % k]));" "const foldOf = new Map(order.map((id, q) => [id, Math.floor((q * k) / order.length)]));"
run_case ENGINE "test size without the whole-number rule (0.28 x 25 gives 8)" $E "return Math.abs(t - r) <= DEFAULTS.WHOLE_TOL ? r : Math.ceil(t);" "return Math.ceil(t);"
# OLS
run_case ENGINE "OLS standard errors on RSS / n (wrong denominator)" $E "const sigma2 = s.rss / dfResidual;" "const sigma2 = s.rss / n;"
run_case ENGINE "OLS R-squared uncentred with an intercept" $E "tss += intercept ? (y[i] - ybar) ** 2 : y[i] * y[i];" "tss += y[i] * y[i];"
run_case ENGINE "adjusted R-squared with n - 1 also without an intercept" $E "adjustedRSquared: 1 - (1 - r2) * (n - cdf) / dfResidual," "adjustedRSquared: 1 - (1 - r2) * (n - 1) / dfResidual,"
run_case ENGINE "no iterative refinement" $E "const REFINE_STEPS = 2;" "const REFINE_STEPS = 0;"
run_case ENGINE "refinement residual rounded to double (not double-double)" $E "  return twoSum(hi, lo); // [head, tail]" "  return [hi + lo, 0]; // [head, tail]"
run_case ENGINE "refinement gradient from the rounded scaled design" $E "g[j] = compensatedDot(A.map((row) => row[j]), r) / d[j];" "g[j] = compensatedDot(A.map((row) => row[j] / d[j]), r);"
run_case ENGINE "condition refusal limit 1e10 (Filip fitted by default)" $E "MAX_CONDITION: 1e8," "MAX_CONDITION: 1e10,"
run_case ENGINE "raw condition number reported as the scaled one" $E "const raw = condFrom(singularValues(Rs.map((r) => r.map((v, j) => v * d[j]))));" "const raw = condFrom(singularValues(Rs));"
# ridge
run_case ENGINE "ridge penalises the intercept (b0 = n ybar / (n + lambda))" $E "const ybar = statsMean(y);
  const yc = y.map((v) => v - ybar);" "const ybar = (statsMean(y) * n) / (n + lambda);
  const yc = y.map((v) => v - ybar);"
run_case ENGINE "ridge lambda on the mean loss (lambda x n)" $E "const rl = Math.sqrt(lambda);" "const rl = Math.sqrt(lambda * n);"
run_case ENGINE "ridge standardises with the sample SD" $E "const scaler = fitStandardScaler({ X, names });" "const scaler = fitStandardScaler({ X, names, sd: 'sample' });"
run_case ENGINE "ridge effective df on d, not d^2" $E "(di * di) / (di * di + lambda)" "di / (di + lambda)"
# logistic
run_case ENGINE "logistic stops at 1e-6" $E "if (change <= tol) { converged = true; break; }" "if (change <= 1e-6) { converged = true; break; }"
run_case ENGINE "separation never detected" $E "if (!(quasiValue > DEFAULTS.SEPARATION_TOL)) return" "if (true) return"
run_case ENGINE "quasi-complete separation called complete" $E "type: margin > DEFAULTS.SEPARATION_TOL ? 'complete' : 'quasi-complete'" "type: margin >= 0 ? 'complete' : 'quasi-complete'"
run_case ENGINE "logistic L2 penalises the intercept" $E "const pen = allNames.map((nmj) => nmj !== 'intercept');" "const pen = allNames.map(() => true);"
run_case ENGINE "probability 0.5 predicted as class 1" $E "classes: pr.map((v) => (v > 0.5 ? 1 : 0))" "classes: pr.map((v) => (v >= 0.5 ? 1 : 0))"
# metrics
run_case ENGINE "ROC without tie grouping (one row per step)" $E "while (q < order.length && scores[order[q]] === s) {" "for (let once = 0; once < 1 && q < order.length; once += 1) {"
run_case ENGINE "AUC by left rectangles, not trapezoids" $E "auc += (fpr[i] - fpr[i - 1]) * (tpr[i] + tpr[i - 1]) / 2;" "auc += (fpr[i] - fpr[i - 1]) * tpr[i - 1];"
run_case ENGINE "confusion matrix transposed" $E "M[pos.get(yTrue[i])][pos.get(yPred[i])] += 1;" "M[pos.get(yPred[i])][pos.get(yTrue[i])] += 1;"
run_case ENGINE "zeroDivision ignored (always 0)" $E "if (den === 0) { undefinedRatios.push({ label: cm.labels[c], metric: what }); return zeroDivision; }" "if (den === 0) { undefinedRatios.push({ label: cm.labels[c], metric: what }); return 0; }"
run_case ENGINE "weighted recall weighted by predicted count" $E "recall: avg('recall', (r) => r.support)" "recall: avg('recall', (r) => r.tp + r.fp)"
run_case ENGINE "log loss clipped at 1e-7" $E "LOG_LOSS_EPS: 1e-15," "LOG_LOSS_EPS: 1e-7,"
run_case ENGINE "log loss in log10" $E "s -= yTrue[i] === 1 ? Math.log(q) : Math.log(1 - q);" "s -= yTrue[i] === 1 ? Math.log10(q) : Math.log10(1 - q);"
run_case ENGINE "R-squared ignores referenceMean" $E "const m = referenceMean === undefined ? statsMean(yTrue) : referenceMean;" "const m = statsMean(yTrue);"
# evaluation
run_case ENGINE "permutation importance sign flipped for error metrics" $E "drops.push(hib ? base.value - sc.value : sc.value - base.value);" "drops.push(base.value - sc.value);"
run_case ENGINE "permutation importance SD on n - 1" $E "const sd = Math.sqrt(drops.reduce((a, v) => a + (v - mu) ** 2, 0) / nRepeats);" "const sd = Math.sqrt(drops.reduce((a, v) => a + (v - mu) ** 2, 0) / (nRepeats - 1 || 1));"
run_case ENGINE "learning curve trains on every training group at every point" $E "const use = new Set(trainOrder.slice(0, c));" "const use = new Set(trainOrder);"
run_case ENGINE "leakage demo scores the group split twice" $E "const rs = randomRowSplit({ groups, testFraction, seed });" "const rs = groupSplit({ groups, testFraction, seed });"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle Fisher-Yates draws floor(u i)" $O "        j = rng.draw(i + 1)" "        j = rng.draw(i)"
run_case ORACLE "oracle OLS SE on RSS / n (NIST self-check)" $O "    s2 = rss / (n - p)" "    s2 = rss / n"
run_case ORACLE "oracle AUC counts ties as losses" $O "    wins = sum((1 if p > q else F(1, 2) if p == q else 0) for p in pos for q in neg)
    return {'fpr'" "    wins = sum((1 if p > q else 0) for p in pos for q in neg)
    return {'fpr'"
run_case ORACLE "oracle log loss clipped at 10 eps" $O "    lo, hi = eps, 1.0 - eps" "    lo, hi = 10 * eps, 1.0 - 10 * eps"
run_case ORACLE "oracle ridge penalises the intercept" $O "    b0 = dec(ybar) - sum(coef[j] * dec(mean[j]) for j in range(p))" "    b0 = dec(ybar) * n / (n + lamd) - sum(coef[j] * dec(mean[j]) for j in range(p))"

restore
echo "=== restored; verifying clean ==="
npx jest "$TEST" 2>&1 | grep -E "^Tests:"
echo "ENGINE plants red: $ENGINE_RED/$ENGINE_RUN"
