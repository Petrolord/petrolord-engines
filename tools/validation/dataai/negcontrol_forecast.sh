#!/usr/bin/env bash
# Data & AI D4 negative controls for the forecasting (forecast.js) gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-forecast.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/dataai/forecast.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/dataai/oracle_forecast.py alone,
#           with the golden regenerated. All must go RED or STOP (the
#           oracle refused to write a golden).
#
#   tools/validation/dataai/negcontrol_forecast.sh [filter]
#
# It edits the working tree and restores it on exit: do not stage or commit
# while it runs. The last line reports N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/dataai/forecast.js
ORACLE=tools/validation/dataai/oracle_forecast.py
GOLDEN=test-data/dataai/goldens/forecast_cases.json
TEST=__tests__/dataai.forecast.test.js
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
      echo "STOP  [$kind] $name -- the oracle refused to write a golden"
      return
    fi
  else
    ENGINE_RUN=$((ENGINE_RUN + 1))
  fi
  out=$(timeout 600 npx jest "$TEST" 2>&1)
  rc=$?
  if [ $rc -eq 124 ]; then
    echo "HANG  [$kind] $name"
    [ "$kind" = ENGINE ] && ENGINE_RED=$((ENGINE_RED + 1))
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
# recursions and initialisation
run_case ENGINE "initial trend from y_3 - y_2" $E "spec.initialTrend : y[1] - y[0]);" "spec.initialTrend : y[2] - y[1]);"
run_case ENGINE "initial level the mean of y_1 and y_2" $E "const l1 = spec.initialLevel !== undefined ? spec.initialLevel : y[0];" "const l1 = spec.initialLevel !== undefined ? spec.initialLevel : (y[0] + y[1]) / 2;"
run_case ENGINE "y_2 scored under the default trend start" $E "return { minLen: 3, scoredFrom: 2," "return { minLen: 3, scoredFrom: 1,"
run_case ENGINE "SSE sums the unscored error too" $E "if (t >= scoredFrom) sse += e * e;" "sse += e * e;"
run_case ENGINE "level updated with the previous observation (lagged form)" $E "const ln = a * y[t] + (1 - a) * f;" "const ln = a * y[t - 1] + (1 - a) * f;"
run_case ENGINE "trend update forgets phi" $E "    if (trendOn) tr = b * (ln - l) + (1 - b) * ph * tr;
    l = ln;
    if (full)" "    if (trendOn) tr = b * (ln - l) + (1 - b) * tr;
    l = ln;
    if (full)"
run_case ENGINE "trend update on level minus forecast" $E "    if (trendOn) tr = b * (ln - l) + (1 - b) * ph * tr;
    l = ln;
    if (full)" "    if (trendOn) tr = b * (ln - f) + (1 - b) * ph * tr;
    l = ln;
    if (full)"
run_case ENGINE "one-step forecast undamped" $E "  for (let t = 1; t < n; t += 1) {
    const f = trendOn ? l + ph * tr : l;" "  for (let t = 1; t < n; t += 1) {
    const f = trendOn ? l + tr : l;"
run_case ENGINE "mse over n, not the scored count" $E "mse: r.sse / nScored," "mse: r.sse / y.length,"
# h-step forecasts
run_case ENGINE "holt forecast (h - 1) steps of trend" $E "out[j - 1] = l + j * tr; return out; }" "out[j - 1] = l + (j - 1) * tr; return out; }"
run_case ENGINE "damped sum starts at phi^0" $E "p *= phi; s += p; out[j - 1] = l + s * tr;" "s += p; p *= phi; out[j - 1] = l + s * tr;"
run_case ENGINE "damped forecast undamped (holt)" $E "  let s = 0; let p = 1;" "  phi = 1; let s = 0; let p = 1;"
# the fit
run_case ENGINE "grid tie keeps the LATER point" $E "if (best === null || f < bestF - bestF * DEFAULTS.GRID_TIE_REL) { best = x; bestF = f; }" "if (best === null || f <= bestF) { best = x; bestF = f; }"
run_case ENGINE "grid alpha from 0.05 (no 0)" $E "GRID_ALPHA: Object.freeze([0, 0.1," "GRID_ALPHA: Object.freeze([0.05, 0.1,"
run_case ENGINE "phi searched to 0.99" $E "PHI_MAX: 0.98," "PHI_MAX: 0.99,"
run_case ENGINE "phi searched from 0.7" $E "PHI_MIN: 0.8," "PHI_MIN: 0.7,"
run_case ENGINE "search not clipped to the box" $E "        const c = clip(t, free);" "        const c = t;"
run_case ENGINE "search stops at a step of 2^-8" $E "PS_MIN_STEP: 2 ** -30," "PS_MIN_STEP: 2 ** -8,"
run_case ENGINE "no search: the grid point is returned" $E "    if (bx) { x = bx; fx = bf; moves += 1; continue; }" "    if (false) { x = bx; fx = bf; moves += 1; continue; }"
run_case ENGINE "atBounds not reported" $E "const atBounds = free.filter((nm, i) => x[i] === bounds(nm)[0] || x[i] === bounds(nm)[1])" "const atBounds = free.filter((nm, i) => false)"
# parameter rules
run_case ENGINE "alpha 0 refused" $E "(v === undefined || (isNum(v) && v >= 0 && v <= 1) ?" "(v === undefined || (isNum(v) && v > 0 && v <= 1) ?"
run_case ENGINE "a fixed phi limited to the search range" $E "if (phi !== undefined && !(isNum(phi) && phi > 0 && phi <= 1))" "if (phi !== undefined && !(isNum(phi) && phi >= 0.8 && phi <= 1))"
run_case ENGINE "phi on 'ses' names holt (the draft wording)" $E "refuse('phi', \"applies to 'damped' only: 'ses' has no trend to damp\")" "refuse('phi', \"applies to 'damped' only: 'holt' is the damped method with phi = 1\")"
run_case ENGINE "Arps no-fit reason in the draft wording" $E "fit with finite qi > 0 and Di > 0 on the \${nPos} positive values (a least-squares line through the rates on the log, reciprocal or q^-b scale that shows no decline gives Di <= 0)" "fit with qi > 0 and Di > 0 on the \${nPos} positive values (a series that does not decline cannot be fitted)"
run_case ENGINE "bootstrap 10th percentile taken at 0.11" $E "quantile(Array.from(paths[j]), [0.1, 0.5, 0.9]);" "quantile(Array.from(paths[j]), [0.11, 0.5, 0.9]);"
run_case ENGINE "holt length rule in other words" $E "the third is the first scored forecast)\" };" "the third is scored)\" };"
# metrics
run_case ENGINE "error sign forecast - actual" $E "    const e = actual[i] - forecast[i];" "    const e = forecast[i] - actual[i];"
run_case ENGINE "MAPE as a fraction, not percent" $E "mape: mapeReason ? null : (100 * sp) / n," "mape: mapeReason ? null : sp / n,"
run_case ENGINE "MAPE ignores zero actuals silently" $E "mape: mapeReason ? null : (100 * sp) / n," "mape: (100 * sp) / n,"
run_case ENGINE "sMAPE on the 0 to 100 scale" $E "ss += den === 0 ? 0 : (2 * Math.abs(e)) / den;" "ss += den === 0 ? 0 : Math.abs(e) / den;"
run_case ENGINE "sMAPE 0/0 term scores 200" $E "ss += den === 0 ? 0 : (2 * Math.abs(e)) / den;" "ss += den === 0 ? 2 : (2 * Math.abs(e)) / den;"
run_case ENGINE "MASE scale over n, not n - m" $E "return { q: s / (train.length - m) };" "return { q: s / train.length };"
run_case ENGINE "MASE lag ignored (always 1)" $E "for (let t = m; t < train.length; t += 1) s += Math.abs(train[t] - train[t - m]);" "for (let t = m; t < train.length; t += 1) s += Math.abs(train[t] - train[t - 1]);"
run_case ENGINE "RMSE with n - 1" $E "rmse: Math.sqrt(s2 / n)," "rmse: Math.sqrt(s2 / Math.max(1, n - 1)),"
run_case ENGINE "m = 0 accepted by accuracy" $E "  if (!isInt(m) || m < 1) return refuse('m', 'must be a whole number, 1 or more (1 is the non-seasonal naive; 12 is a monthly seasonal naive)');
  let qs = null;" "  if (!isInt(m) || m < 0) return refuse('m', 'must be a whole number, 1 or more (1 is the non-seasonal naive; 12 is a monthly seasonal naive)');
  let qs = null;"
# bootstrap
run_case ENGINE "bootstrap draw floor(u (m - 1))" $E "const ys = f + pool[Math.floor(rng() * m)];" "const ys = f + pool[Math.floor(rng() * (m - 1))];"
run_case ENGINE "bootstrap pool takes the structural zero" $E "const pool = r.residuals.slice(r.scoredFrom);" "const pool = r.residuals.slice(1).map((v) => v || 0);"
run_case ENGINE "simulated value does not update the state" $E "const ln = a * ys + (1 - a) * f;" "const ln = a * f + (1 - a) * f;"
run_case ENGINE "percentile labels swapped (P90 the high case)" $E "p90.push(keep(q10)); p50.push(keep(q50)); p10.push(keep(q90));" "p90.push(keep(q90)); p50.push(keep(q50)); p10.push(keep(q10));"
run_case ENGINE "nonNegative ignored" $E "if (nonNegative && v < 0) { clipped += 1; return 0; }" "if (false && v < 0) { clipped += 1; return 0; }"
run_case ENGINE "a fresh stream per path" $E "  for (let k = 0; k < nSims; k += 1) {
    let l = r.last.level;" "  for (let k = 0; k < nSims; k += 1) {
    const rng = mulberry32(seed + k);
    let l = r.last.level;"
# backtests
run_case ENGINE "last origin dropped (o + H < n)" $E "for (let k = firstOrigin; k + horizon <= n; k += step) o.push(k);" "for (let k = firstOrigin; k + horizon < n; k += step) o.push(k);"
run_case ENGINE "refit false ignored" $E "if (!refit && idx > 0) sp = { ...spec, ...held };" "if (false) sp = { ...spec, ...held };"
run_case ENGINE "training window leaks the first actual" $E "    const train = y.slice(0, o);
    let sp = spec;" "    const train = y.slice(0, o + 1);
    let sp = spec;"
run_case ENGINE "MASE scaled on the whole series" $E "    const sc = naiveScale(train, m, \`the \${o} training values\`);
    const errors" "    const sc = naiveScale(y, m, \`the \${o} training values\`);
    const errors"
run_case ENGINE "firstOrigin upper bound off by one" $E "if (!isInt(firstOrigin) || firstOrigin < minTrain || firstOrigin > hi)" "if (!isInt(firstOrigin) || firstOrigin < minTrain || firstOrigin > hi + 1)"
# Arps and the comparison
run_case ENGINE "Arps time from index 0, not the first positive value" $E "const arpsAt = (p, t0, k) => calculateArpsHyperbolic(p.qi, p.Di, p.b, k - t0);" "const arpsAt = (p, t0, k) => calculateArpsHyperbolic(p.qi, p.Di, p.b, k);"
run_case ENGINE "Arps step passed as 30 days" $E "date: new Date(ARPS_EPOCH + k * DAY_MS).toISOString()" "date: new Date(ARPS_EPOCH + k * 30 * DAY_MS).toISOString()"
run_case ENGINE "Arps training window leaks the first actual" $E "    const train = y.slice(0, o);
    const a = arpsFit(" "    const train = y.slice(0, o + 1);
    const a = arpsFit("
run_case ENGINE "ranking tie goes to the LATER method" $E "if (a < b - Math.abs(b) * DEFAULTS.RANK_TIE_REL) bi = k;" "if (a <= b) bi = k;"
run_case ENGINE "ranking highest first" $E "if (a < b - Math.abs(b) * DEFAULTS.RANK_TIE_REL) bi = k;" "if (a > b + Math.abs(b) * DEFAULTS.RANK_TIE_REL) bi = k;"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle scores y_2 under the default start" $O "        return 2, 1
    return 3, 2" "        return 2, 1
    return 3, 1"
run_case ORACLE "oracle sMAPE on 0 to 100" $O "        ss += 0 if den == 0 else 2 * abs(e) / den" "        ss += 0 if den == 0 else abs(e) / den"
run_case ORACLE "oracle bootstrap draws from m - 1" $O "            e = pool[rng.draw(m)]" "            e = pool[rng.draw(m - 1)]"
run_case ORACLE "oracle damped forecast from phi^0" $O "    return [l + ph * (1 - ph ** j) / (1 - ph) * tr for j in range(1, h + 1)]" "    return [l + (1 - ph ** j) / (1 - ph) * tr for j in range(1, h + 1)]"
run_case ORACLE "oracle MASE lag 1 always" $O "    s = sum(abs(F(train[t]) - F(train[t - m])) for t in range(m, len(train)))" "    s = sum(abs(F(train[t]) - F(train[t - 1])) for t in range(m, len(train)))"
run_case ORACLE "oracle NIST published trend alpha 0.3 fit misread" $O "    pub_t = [6.4, 6.2, 6.7, 7.3, 8.4, 9.4, 11.6, 12.7, 15.4]" "    pub_t = [6.4, 6.2, 6.7, 7.3, 8.4, 9.4, 11.6, 12.7, 15.5]"

restore
echo "=== restored; verifying clean ==="
npx jest "$TEST" 2>&1 | grep -E "^Tests:"
echo "ENGINE plants red: $ENGINE_RED/$ENGINE_RUN"
