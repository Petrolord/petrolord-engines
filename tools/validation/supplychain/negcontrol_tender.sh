#!/usr/bin/env bash
# Supply Chain SC2 negative controls for the tender evaluation (tender.js) gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-tender.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/supplychain/tender.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/supplychain/oracle_tender.py alone,
#           with the golden regenerated. All must go RED or STOP (the
#           oracle refused to write a golden).
#
#   tools/validation/supplychain/negcontrol_tender.sh [filter]
#
# It edits the working tree and restores it on exit: do not stage or commit
# while it runs. The last lines report N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/supplychain/tender.js
ORACLE=tools/validation/supplychain/oracle_tender.py
GOLDEN=test-data/supplychain/goldens/tender_cases.json
TEST=__tests__/supplychain.tender.test.js
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
# weights
run_case ENGINE "weights need not sum to 100" $E "Math.abs(w - DEFAULTS.WEIGHT_SUM) > DEFAULTS.WEIGHT_SUM_TOLERANCE" "false"
run_case ENGINE "weights ignored (every criterion 20)" $E "(c.weight * b.scores[c.id]) / c.maxScore" "(20 * b.scores[c.id]) / c.maxScore"
run_case ENGINE "score not divided by its maxScore (fixed scale 4)" $E "(c.weight * b.scores[c.id]) / c.maxScore" "(c.weight * b.scores[c.id]) / 4"
# pass mark and the two envelopes
run_case ENGINE "pass mark exclusive" $E "if (technicalPercent >= passMark)" "if (technicalPercent > passMark)"
run_case ENGINE "every commercial envelope opened" $E "const open = bids.filter((b) => passed.has(b.id));" "const open = bids.filter((b) => passed.has(b.id) || b.scores);"
# arithmetic
run_case ENGINE "quoted total always governs" $E "const discrepancy = gap > tolerance;" "const discrepancy = false;"
run_case ENGINE "arithmetic tolerance inclusive" $E "const discrepancy = gap > tolerance;" "const discrepancy = gap >= tolerance;"
# omissions
run_case ENGINE "average rule priced at the highest" $E "const a = sum(prices) / prices.length;" "const a = Math.max(...prices);"
run_case ENGINE "highest rule priced at the lowest" $E "const h = Math.max(...prices);" "const h = Math.min(...prices);"
run_case ENGINE "rejected bids price omissions" $E "live.filter((x) => x.b.id !== self)" "corrected.filter((x) => x.b.id !== self)"
# schedule and discount
run_case ENGINE "credit for early completion" $E "const late = Math.max(0, b.completionWeeks - schedule.minWeeks);" "const late = b.completionWeeks - schedule.minWeeks;"
run_case ENGINE "maxWeeks exclusive" $E "if (schedule !== undefined && b.completionWeeks > schedule.maxWeeks) {" "if (schedule !== undefined && b.completionWeeks >= schedule.maxWeeks) {"
run_case ENGINE "discount not deducted" $E "const net = c.correctedTotal - discount;" "const net = c.correctedTotal;"
# life cycle
run_case ENGINE "residual value not credited" $E "flows[flows.length - 1] -= residualValue;" ""
run_case ENGINE "life cycle discounted from year 0" $E "return npv(flows, rate, 0, 1);" "return npv(flows, rate, 0, 0);"
# ties
run_case ENGINE "cost tie-break reversed" $E "if (ca !== cb) return { c: ca - cb, by: 'lower evaluated cost' };" "if (ca !== cb) return { c: cb - ca, by: 'lower evaluated cost' };"
run_case ENGINE "receipt tie-break reversed" $E "if (a.receivedAt !== b.receivedAt) return { c: cmpStr(a.receivedAt, b.receivedAt), by: 'earlier receipt' };" "if (a.receivedAt !== b.receivedAt) return { c: cmpStr(b.receivedAt, a.receivedAt), by: 'earlier receipt' };"
run_case ENGINE "id tie-break reversed" $E "return { c: cmpStr(a.id, b.id), by: 'bidder id' };" "return { c: cmpStr(b.id, a.id), by: 'bidder id' };"
run_case ENGINE "ties compared exactly (no 12-digit key)" $E "const key12 = (x) => Number(x.toPrecision(DEFAULTS.TIE_DIGITS));" "const key12 = (x) => x;"
# scoring
run_case ENGINE "lowest-ratio inverted" $E "if (priceMethod === 'lowest-ratio') return (100 * cMin) / c;" "if (priceMethod === 'lowest-ratio') return (100 * c) / cMax;"
run_case ENGINE "linear over Cmax" $E "(100 * (cMax - c)) / (cMax - cMin)" "(100 * (cMax - c)) / cMax"
run_case ENGINE "relative technical score not normalised" $E "(100 * b.technicalPercent) / tHigh" "b.technicalPercent"
run_case ENGINE "technical and commercial weights swapped" $E "const combinedScore = technicalWeight * technicalScore + (1 - technicalWeight) * commercialScore;" "const combinedScore = (1 - technicalWeight) * technicalScore + technicalWeight * commercialScore;"
run_case ENGINE "high value strictly above 10 million" $E "const highValue = estimatedCostUsd >= DEFAULTS.HIGH_VALUE_USD;" "const highValue = estimatedCostUsd > DEFAULTS.HIGH_VALUE_USD;"
# Nigerian content
run_case ENGINE "content measure not checked" $E "if (!s.measures.includes(r.measure))" "if (false)"
run_case ENGINE "content share of Nigerian over foreign" $E "const ncPct = (100 * r.nigerian) / r.total;" "const ncPct = (100 * r.nigerian) / Math.max(1, r.total - r.nigerian);"
run_case ENGINE "minimum met only strictly above" $E "const meets = ncPct >= s.targetPct;" "const meets = ncPct > s.targetPct;"
run_case ENGINE "mixed measures summed without weights" $E "const oneMeasure =" "const oneMeasure = true || "
run_case ENGINE "Schedule: coiled tubing 70 not 75" $E "'coiled-tubing-services': S(WDS, 'Coiled Tubing Services', 75, 'man-hours')," "'coiled-tubing-services': S(WDS, 'Coiled Tubing Services', 70, 'man-hours'),"
run_case ENGINE "Schedule: valves by tonnage" $E "valves: S(MAT, 'Valves', 60, 'number')," "valves: S(MAT, 'Valves', 60, 'tonnage'),"
run_case ENGINE "s.14 lead 6" $E "NC_LEAD_PCT: 5," "NC_LEAD_PCT: 6,"
run_case ENGINE "s.14 group within 2%" $E "NC_PRICE_MARGIN_PCT: 1," "NC_PRICE_MARGIN_PCT: 2,"
run_case ENGINE "s.16 margin 15 percent" $E "INDIGENOUS_MARGIN_PCT: 10," "INDIGENOUS_MARGIN_PCT: 15,"
run_case ENGINE "s.14 relative lead over the leader" $E "100 * (top.ncPct - second.ncPct) >= DEFAULTS.NC_LEAD_PCT * second.ncPct" "100 * (top.ncPct - second.ncPct) >= DEFAULTS.NC_LEAD_PCT * top.ncPct"
run_case ENGINE "s.14 shared top content ignored" $E "const tiedTop = byNc.filter((b) => b.ncPct === top.ncPct);" "const tiedTop = [top];"
# contract types
run_case ENGINE "draw order swapped" $E "const days = daysOf(draw(dur, rng));
    const rate = draw(costTri, rng);" "const rate = draw(costTri, rng);
    const days = daysOf(draw(dur, rng));"
run_case ENGINE "fee charged twice" $E "cost * (1 + reimbursable.feeFraction)" "cost * (1 + 2 * reimbursable.feeFraction)"
run_case ENGINE "overrun split against a zero planned margin" $E "acc[t].contractorAbsorbs += (pay0[t] - cost0) - m;" "acc[t].contractorAbsorbs += -m;"
run_case ENGINE "P90 and P10 swapped" $E "const pick = (s) => ({ mean: s.mean, p90: s.p90, p50: s.p50, p10: s.p10, min: s.min, max: s.max });" "const pick = (s) => ({ mean: s.mean, p90: s.p10, p50: s.p50, p10: s.p90, min: s.min, max: s.max });"
run_case ENGINE "plan 10 percent above the mode" $E "const d0 = plan ? plan.days : planDaysDefault;" "const d0 = plan ? plan.days : planDaysDefault * 1.1;"
run_case ENGINE "a zero margin counted as a loss" $E "if (m < 0) acc[t].losses += 1;" "if (m <= 0) acc[t].losses += 1;"
# should-cost
run_case ENGINE "band limits outside the band" $E "const flag = ratio < band.low ? 'below' : ratio > band.high ? 'above' : null;" "const flag = ratio <= band.low ? 'below' : ratio >= band.high ? 'above' : null;"
run_case ENGINE "contingency dropped from the estimate" $E "estimate: c.totalUsd };" "estimate: c.baseUsd };"
# abnormally low bids
run_case ENGINE "ALB absolute strictly more than 20%" $E "const flag = 100 * (estimate - c) >= DEFAULTS.ALB_ABSOLUTE_PCT * estimate;" "const flag = 100 * (estimate - c) > DEFAULTS.ALB_ABSOLUTE_PCT * estimate;"
run_case ENGINE "ALB relative at the limit flagged" $E "    const flag = c < limit;" "    const flag = c <= limit;"
run_case ENGINE "ALB relative from 4 bids" $E "ALB_RELATIVE_MIN_BIDS: 5," "ALB_RELATIVE_MIN_BIDS: 4,"
run_case ENGINE "ALB limit two standard deviations" $E "const limit = approach === 'relative' ? avg - sd : null;" "const limit = approach === 'relative' ? avg - 2 * sd : null;"
run_case ENGINE "ALB reason drops 'never rejected automatically'" $E "before any decision; it is never rejected automatically';" "before any decision';"
# messages are course content: each changed wording must go red
run_case ENGINE "s.14 reason in other words" $E "at least 5% higher, so s.14 selects" "5% or more higher, so s.14 selects"
run_case ENGINE "pass-mark reason in other words" $E "is below the pass mark" "is under the pass mark"
run_case ENGINE "omission refusal drops 'not from the cited texts'" $E "an option not from the cited texts)\");" "an option)\");"
run_case ENGINE "omission default is the highest" $E "export const evaluatedCosts = ({ bids, omissionRule = 'average'," "export const evaluatedCosts = ({ bids, omissionRule = 'highest',"
run_case ENGINE "s.14 readings dropped from the reason" $E "  s14.reason = \`\${s14.reason} (readings of s.14: \${readings.join('; ')})\`;" ""
run_case ENGINE "cost P-label reversal dropped from the basis" $E "so for a cost P90 is the LOW cost (10th percentile) and P10 the HIGH cost (90th percentile)" "P90 is the high cost"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle pass mark exclusive" $O "if pct >= F(pm):" "if pct > F(pm):"
run_case ORACLE "oracle average rule as the highest" $O "ex = sum((g[0] for g in got), F(0)) / len(got)" "ex = max(g[0] for g in got)"
run_case ORACLE "oracle s.14 lead 6 points" $O "ok = lead >= 5" "ok = lead >= 6"
run_case ORACLE "oracle id tie-break reversed" $O "return (-1 if a['id'] < b['id'] else 1), 'bidder id'" "return (-1 if a['id'] > b['id'] else 1), 'bidder id'"
run_case ORACLE "oracle measure not checked" $O "if r.get('measure') not in s['measures']:" "if False:"
run_case ORACLE "oracle ALB sample standard deviation" $O "        var = sum(((x - m) ** 2 for x in xs), F(0)) / n          # population variance" "        var = sum(((x - m) ** 2 for x in xs), F(0)) / (n - 1)"
run_case ORACLE "oracle s.14 group within 2%" $O "group = [b for b in ordered if (F(b['evaluatedCost']) - cmin) * 100 <= cmin]" "group = [b for b in ordered if (F(b['evaluatedCost']) - cmin) * 100 <= 2 * cmin]"

restore
echo "=== summary ==="
echo "engine plants red: $ENGINE_RED/$ENGINE_RUN"
echo "oracle plants caught: $ORACLE_CAUGHT/$ORACLE_RUN"
echo "skipped (target not unique): $SKIPPED"
