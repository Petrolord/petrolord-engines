#!/usr/bin/env bash
# Economics EC11 negative controls for the reserves and resources engine
# (prms.js) gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-prms.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/economics/prms.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/economics/oracle_prms.py
#           alone, with the golden regenerated. All must go RED or STOP (the
#           oracle refused to write a golden).
#
#   tools/validation/economics/negcontrol_prms.sh [filter]
#
# It edits the working tree and restores it on exit: do not stage or commit
# while it runs. The last lines report N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/economics/prms.js
ORACLE=tools/validation/economics/oracle_prms.py
GOLDEN=test-data/economics/goldens/prms_cases.json
TEST=__tests__/economics.prms.test.js
TMP=$(mktemp -d)
cp "$ENGINE" "$TMP/engine.bak"; cp "$ORACLE" "$TMP/oracle.bak"; cp "$GOLDEN" "$TMP/golden.bak"
restore() { cp "$TMP/engine.bak" "$ENGINE"; cp "$TMP/oracle.bak" "$ORACLE"; cp "$TMP/golden.bak" "$GOLDEN"; }
trap 'restore; rm -rf "$TMP"' EXIT

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

ENGINE_RUN=0; ENGINE_RED=0; ORACLE_RUN=0; ORACLE_CAUGHT=0; SKIPPED=0

run_case() { # kind name file from to
  kind=$1; name=$2; file=$3; from=$4; to=$5
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  plant "$file" "$from" "$to" || { echo "SKIP  $name (target)"; SKIPPED=$((SKIPPED + 1)); return; }
  if [ "$kind" = ORACLE ]; then
    ORACLE_RUN=$((ORACLE_RUN + 1))
    if ! "$PY" "$ORACLE" >/dev/null 2>&1; then
      echo "STOP  [$kind] $name -- the oracle refused to write a golden"
      ORACLE_CAUGHT=$((ORACLE_CAUGHT + 1))
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
    [ "$kind" = ORACLE ] && ORACLE_CAUGHT=$((ORACLE_CAUGHT + 1))
  elif echo "$out" | grep -qE "Tests:.*failed|Test suite failed to run"; then
    n=$(echo "$out" | grep -E "^Tests:" | grep -oE "[0-9]+ failed")
    first=$(echo "$out" | grep -E "^\s+●" | sed 's/^ *● //' | head -1)
    echo "RED   [$kind] $name -- ${n:-suite failed} -- $first"
    [ "$kind" = ENGINE ] && ENGINE_RED=$((ENGINE_RED + 1))
    [ "$kind" = ORACLE ] && ORACLE_CAUGHT=$((ORACLE_CAUGHT + 1))
  else
    echo "GREEN [$kind] $name -- NOT CAUGHT"
  fi
}
E=$ENGINE
echo "=== baseline ==="
restore
npx jest "$TEST" 2>&1 | grep -E "^Tests:"

echo "=== ENGINE plants (all must be RED) ==="
# the lead's named defects
run_case ENGINE "P90 read as high (the Monte Carlo low at the 0.9 quantile)" $E "const stat = { low: quantile(totals, 0.1), best: quantile(totals, 0.5), high: quantile(totals, 0.9)," "const stat = { low: quantile(totals, 0.9), best: quantile(totals, 0.5), high: quantile(totals, 0.1),"
run_case ENGINE "P90 read as high (the category label of the low estimate)" $E "const CASE_OUTCOME = { low: 'p90', best: 'p50', high: 'p10' };" "const CASE_OUTCOME = { low: 'p10', best: 'p50', high: 'p90' };"
run_case ENGINE "P90 read as high (a lognormal project's low estimate)" $E "cases = { low: Math.exp(mu - Z90 * s), best: Math.exp(mu), high: Math.exp(mu + Z90 * s) };" "cases = { low: Math.exp(mu + Z90 * s), best: Math.exp(mu), high: Math.exp(mu - Z90 * s) };"
run_case ENGINE "arithmetic sum reported as the probabilistic P90" $E "const stat = { low: quantile(totals, 0.1)," "const stat = { low: arith.low,"
run_case ENGINE "incremental vs cumulative swapped (categorize)" $E "cum = { low: est.first, best: est.first + est.second, high: est.first + est.second + est.third };" "cum = { low: est.first, best: est.second, high: est.third };"
run_case ENGINE "incremental vs cumulative swapped (economic limit P2, P3)" $E "incremental: { P1: low, P2: inc(best, low), P3: inc(high, best) }," "incremental: { P1: low, P2: best, P3: high },"
run_case ENGINE "contingent counted as reserves (unmet criteria ignored)" $E "const commercial = unmet.length === 0 && technologyReady;" "const commercial = technologyReady;"
run_case ENGINE "contingent counted as reserves (technology under development)" $E "const commercial = unmet.length === 0 && technologyReady;" "const commercial = unmet.length === 0;"
run_case ENGINE "contingent counted as reserves (best case fails the economic test)" $E "  if (cases.best.economic) {
    const low" "  if (true) {
    const low"
run_case ENGINE "economic limit ignored (the technical forecast kept)" $E "const kept = rows.filter((r) => r.year <= limitYear);" "const kept = rows;"
run_case ENGINE "economic limit ignored (the canonical limit switched off)" $E "    apply_economic_limit: limit," "    apply_economic_limit: false,"
run_case ENGINE "correlation ignored" $E "const sampler = createCorrelatedSampler({ inputs, paramOrder: P.map((p) => p.id), correlations: pairs," "const sampler = createCorrelatedSampler({ inputs, paramOrder: P.map((p) => p.id), correlations: [],"
run_case ENGINE "reconciliation not closing (closing check dropped)" $E "const closes = CASE_KEYS.every((k) => Math.abs(difference[k]) <= a.tolerance);" "const closes = true;"
run_case ENGINE "reconciliation not closing (production added)" $E "moves.push({ type: m.type, low: -m.quantity, best: -m.quantity, high: -m.quantity });" "moves.push({ type: m.type, low: m.quantity, best: m.quantity, high: m.quantity });"
run_case ENGINE "reconciliation not closing (divestments added)" $E "const s = spec.sign === -1 ? -1 : 1;" "const s = 1;"
# economic limit and entitlement
run_case ENGINE "1P kept when the low case fails the economic test" $E "const low = cases.low.economic ? perCase.low.reported : zero;" "const low = perCase.low.reported;"
run_case ENGINE "economic at an undiscounted net cash flow of exactly 0" $E "const economic = undiscounted > 0;" "const economic = undiscounted >= 0;"
run_case ENGINE "licence expiry ignored" $E "const licenceCut = lic.renewalExpected ? null : lic.expiryYear;" "const licenceCut = null;"
run_case ENGINE "production tax deducted as a royalty interest" $E "const volRoy = a.royalty.form === 'royalty-interest' ? roy : 0;" "const volRoy = roy;"
run_case ENGINE "working interest not applied" $E "return qty(scale(q.oil, wi, r), scale(q.gas, wi, r));" "return qty(scale(q.oil, 100, r), scale(q.gas, 100, r));"
run_case ENGINE "PRMS peak check dropped" $E "    if (r.economic && r.prmsPeakYear !== r.economicLimitYear) {" "    if (false) {"
# classification
run_case ENGINE "Pc of a prospect read as Pg alone" $E "const pc = (a.chances.geologicDiscoveryPct * a.chances.developmentPct) / 100;" "const pc = a.chances.geologicDiscoveryPct;"
run_case ENGINE "five-year benchmark exclusive" $E "const tfMet = tf.startWithinYears <= T || tf.longerJustified;" "const tfMet = tf.startWithinYears < T || tf.longerJustified;"
run_case ENGINE "approved and justified sub-classes swapped" $E ": ps.finalInvestmentDecision ? 'approved-for-development' : 'justified-for-development';" ": ps.finalInvestmentDecision ? 'justified-for-development' : 'approved-for-development';"
run_case ENGINE "PIA retention limit 11 years" $E "significantDiscoveryRetentionMaxYears: 10," "significantDiscoveryRetentionMaxYears: 11,"
# aggregation
run_case ENGINE "Monte Carlo seed ignored" $E "rng: mulberry32(a.seed) });" "rng: mulberry32(1) });"
run_case ENGINE "risked mean without the chance of commerciality" $E "(p.chance * p.meanExact) / 100, 0)" "p.meanExact, 0)"
run_case ENGINE "statistical figures reportable above the field level" $E "const reportable = a.level === 'above-field' ? 'arithmetic' : 'arithmetic-or-statistical';" "const reportable = 'arithmetic-or-statistical';"
run_case ENGINE "non positive semidefinite correlation accepted" $E "  if (worst > DEFAULTS.PSD_TOLERANCE) return" "  if (false) return"
run_case ENGINE "a missing correlation pair taken as 0" $E "    if (seen.size !== need) {" "    if (false) {"
run_case ENGINE "production accepted in Contingent Resources" $E "      if (a.resourceClass !== 'reserves') return must" "      if (false) return must"
# keys and messages
run_case ENGINE "a triangular fit below 0 accepted" $E "    if (f.min < 0) return { e: must(" "    if (false) return { e: must("
run_case ENGINE "unknown keys ignored" $E "  for (const k of Object.keys(v)) if (v[k] !== undefined && !spec.keys.includes(k)) return unknownKey(path, k, spec.keys);" ""
run_case ENGINE "message: money printed with float noise" $E "const money = (x) => fmt(Number(x.toFixed(2)));" "const money = (x) => fmt(x);"
run_case ENGINE "message: unit agreement dropped" $E "const unit = (x, one, many = \`\${one}s\`) => \`\${fmt(x)} \${x === 1 ? one : many}\`;" "const unit = (x, one, many = \`\${one}s\`) => \`\${fmt(x)} \${many}\`;"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle trim cuts a zero year" $O "and noi(kept[-1]) < 0:" "and noi(kept[-1]) <= 0:"
run_case ORACLE "oracle P90 at the 0.9 quantile" $O "stat = {'low': ss_quantile_sorted(srt, 0.1)," "stat = {'low': ss_quantile_sorted(srt, 0.9),"
run_case ORACLE "oracle production added" $O "moves.append({'type': 'production', **{k: -F(m['quantity']) for k in ks}})" "moves.append({'type': 'production', **{k: F(m['quantity']) for k in ks}})"
run_case ORACLE "oracle Pc = Pg" $O "pc = F(pg) * F(pd) / 100" "pc = F(pg)"
run_case ORACLE "oracle ADR left out" $O "            ncf -= F(adr)" "            ncf -= 0"
run_case ORACLE "oracle unknown keys ignored" $O "        check_keys(args, SHAPES[fn], '')" "        pass"

restore
echo "=== summary ==="
echo "engine plants red: $ENGINE_RED/$ENGINE_RUN"
echo "oracle plants caught: $ORACLE_CAUGHT/$ORACLE_RUN"
echo "skipped (target not unique): $SKIPPED"
