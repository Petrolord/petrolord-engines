#!/usr/bin/env bash
# Supply Chain SC3 negative controls for the inventory and spares (inventory.js) gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-inventory.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/supplychain/inventory.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/supplychain/oracle_inventory.py alone,
#           with the golden regenerated. All must go RED or STOP (the
#           oracle refused to write a golden).
#
#   tools/validation/supplychain/negcontrol_inventory.sh [filter]
#
# It edits the working tree and restores it on exit: do not stage or commit
# while it runs. The last lines report N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/supplychain/inventory.js
ORACLE=tools/validation/supplychain/oracle_inventory.py
GOLDEN=test-data/supplychain/goldens/inventory_cases.json
TEST=__tests__/supplychain.inventory.test.js
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
# criticality
run_case ENGINE "weights ignored (every criterion 25)" $E "const v = (c.weight * it.scores[c.id]) / scoreMax;" "const v = (25 * it.scores[c.id]) / scoreMax;"
run_case ENGINE "score not divided by scoreMax" $E "const v = (c.weight * it.scores[c.id]) / scoreMax;" "const v = (c.weight * it.scores[c.id]) / 5;"
run_case ENGINE "class minimum exclusive" $E "const byScore = classes.find((c) => key12(score) >= key12(c.minScore));" "const byScore = classes.find((c) => key12(score) > key12(c.minScore) || c.minScore === 0);"
run_case ENGINE "class compared without the 12-digit key" $E "const byScore = classes.find((c) => key12(score) >= key12(c.minScore));" "const byScore = classes.find((c) => score >= c.minScore);"
run_case ENGINE "safety override ignored" $E "    if (forcing.length && byScore.label !== top) {" "    if (false) {"
run_case ENGINE "override fires one point below the maximum" $E "const forcing = topClassOnMaxScore.filter((id) => it.scores[id] === scoreMax);" "const forcing = topClassOnMaxScore.filter((id) => it.scores[id] >= scoreMax - 1);"
run_case ENGINE "weights need not add to 100" $E "if (Math.abs(wsum - DEFAULTS.WEIGHT_SUM) > DEFAULTS.WEIGHT_SUM_TOLERANCE)" "if (false)"
# ABC
run_case ENGINE "ABC at-or-below reads the share before the item" $E "cls = key12(after) <= key12(aPct) ? 'A' : key12(after) <= key12(bPct) ? 'B' : 'C';" "cls = key12(before) <= key12(aPct) ? 'A' : key12(before) <= key12(bPct) ? 'B' : 'C';"
run_case ENGINE "ABC cut-off exclusive" $E "cls = key12(after) <= key12(aPct) ? 'A' : key12(after) <= key12(bPct) ? 'B' : 'C';" "cls = key12(after) < key12(aPct) ? 'A' : key12(after) < key12(bPct) ? 'B' : 'C';"
run_case ENGINE "ABC include-crossing inclusive" $E "cls = key12(before) < key12(aPct) ? 'A' : key12(before) < key12(bPct) ? 'B' : 'C';" "cls = key12(before) <= key12(aPct) ? 'A' : key12(before) <= key12(bPct) ? 'B' : 'C';"
run_case ENGINE "ABC ranked lowest first" $E "? b.annualValue - a.annualValue : cmpStr(a.id, b.id)));" "? a.annualValue - b.annualValue : cmpStr(a.id, b.id)));"
run_case ENGINE "ABC tie-break by id reversed" $E "? b.annualValue - a.annualValue : cmpStr(a.id, b.id)));" "? b.annualValue - a.annualValue : cmpStr(b.id, a.id)));"
# EOQ
run_case ENGINE "EOQ without the factor 2" $E "const q = Math.sqrt((2 * orderCost * annualDemand) / h);" "const q = Math.sqrt((orderCost * annualDemand) / h);"
run_case ENGINE "holding rate taken as the holding cost" $E "    h = holdingRate * unitCost;" "    h = holdingRate;"
run_case ENGINE "nearest rounds halves downward" $E ": Math.floor(q + 0.5);" ": Math.ceil(q - 0.5);"
run_case ENGINE "rounding up taken as nearest" $E "const n = r.rule === 'up' ? Math.ceil(q)" "const n = r.rule === 'up' ? Math.floor(q + 0.5)"
run_case ENGINE "holding cost on the whole lot" $E "  const holdingCost = (h * qr) / 2;" "  const holdingCost = h * qr;"
# quantity discounts
run_case ENGINE "all-units break quantity never a candidate" $E "      quantity = lo;" "      quantity = null;"
run_case ENGINE "incremental fixed cost not carried forward" $E "F.push(F[i - 1] + (breaks[i - 1].unitPrice - breaks[i].unitPrice) * breaks[i].minQuantity);" "F.push((breaks[i - 1].unitPrice - breaks[i].unitPrice) * breaks[i].minQuantity);"
run_case ENGINE "incremental lot priced all-units" $E "const lot = discountType === 'all-units' ? v * Q : F[i] + v * Q;" "const lot = v * Q;"
run_case ENGINE "discount tie to the larger quantity" $E ": a.quantity - b.quantity));" ": b.quantity - a.quantity));"
# safety stock (normal)
run_case ENGINE "lead-time variance left out of sigma" $E "const sigma = Math.sqrt(P * demandSd * demandSd + demandMean * demandMean * leadTimeSd * leadTimeSd);" "const sigma = Math.sqrt(P * demandSd * demandSd);"
run_case ENGINE "review period left out of the protection period" $E "  const P = leadTime + reviewPeriod;" "  const P = leadTime;"
run_case ENGINE "cycle service z at 1 - level" $E "inverseNormal(serviceLevel) : solveLoss" "inverseNormal(1 - serviceLevel) : solveLoss"
run_case ENGINE "fill-rate target without (1 - level)" $E "solveLoss((orderQuantity * (1 - serviceLevel)) / sigma)" "solveLoss((orderQuantity * serviceLevel) / sigma)"
run_case ENGINE "safety factor truncated" $E "Number(kExact.toFixed(safetyFactorRounding.decimals))" "Math.trunc(kExact * 100) / 100"
run_case ENGINE "floor ignored" $E "  const k = floored ? minimumSafetyFactor : kRounded;" "  const k = kRounded;"
run_case ENGINE "safety stock not scaled by sigma" $E "  const safety = k * sigma;" "  const safety = k;"
run_case ENGINE "AS241 coefficient off in the 9th digit" $E "0.180625 - q * q;" "0.1806250001 - q * q;"
run_case ENGINE "Phi off by 1e-7 (an A&S-grade approximation)" $E "const halfQ = (x) => 0.5 * regularizedGammaQ(0.5, (x * x) / 2);" "const halfQ = (x) => 0.5 * regularizedGammaQ(0.5, (x * x) / 2) * (1 + 1e-7);"
# Poisson
run_case ENGINE "Poisson level strictly above the target" $E "? (row) => key12(row.cumulative) >= key12(serviceLevel)" "? (row) => key12(row.cumulative) > key12(serviceLevel)"
run_case ENGINE "Poisson loss recursion off by one" $E "    Ls -= 1 - F;" "    Ls -= 1 - F - p;"
run_case ENGINE "Poisson mean without the review period" $E "  const m = demandRate * (leadTime + reviewPeriod);" "  const m = demandRate * leadTime;"
run_case ENGINE "Poisson fill limit at the level" $E "const limit = serviceMeasure === 'fill-rate' ? orderQuantity * (1 - serviceLevel) : null;" "const limit = serviceMeasure === 'fill-rate' ? orderQuantity * serviceLevel : null;"
# insurance spares
run_case ENGINE "downtime counted once a year (days left out)" $E "const downtime = r.expectedShort * daysPerYear * downtimeCostPerDay;" "const downtime = r.expectedShort * downtimeCostPerDay;"
run_case ENGINE "holding on n - 1 spares" $E "    const holding = r.s * holdingPerSpare;" "    const holding = Math.max(0, r.s - 1) * holdingPerSpare;"
run_case ENGINE "spares tie to more" $E "if (key12(o.totalCost) < key12(best.totalCost)) best = o;" "if (key12(o.totalCost) <= key12(best.totalCost)) best = o;"
run_case ENGINE "fill rate read as P(X <= n)" $E "fillRate: r.s === 0 ? 0 : rows[r.s - 1].cumulative," "fillRate: r.cumulative,"
run_case ENGINE "mean outstanding without the lead time" $E "  const m = (failuresPerYear * leadTimeDays) / daysPerYear;" "  const m = failuresPerYear / daysPerYear;"
# lead-time risk
run_case ENGINE "draw order swapped" $E "    const t = draw(lt, rng);
    const rate = draw(dd, rng);" "    const rate = draw(dd, rng);
    const t = draw(lt, rng);"
run_case ENGINE "stockout at demand equal to the stock" $E "    if (x > reorderPoint) outs += 1;" "    if (x >= reorderPoint) outs += 1;"
run_case ENGINE "P90 and P10 swapped" $E "const pick = (s) => ({ mean: s.mean, p90: s.p90, p50: s.p50, p10: s.p10, min: s.min, max: s.max });" "const pick = (s) => ({ mean: s.mean, p90: s.p10, p50: s.p50, p10: s.p90, min: s.min, max: s.max });"
run_case ENGINE "seed ignored" $E "  const rng = mulberry32(seed);" "  const rng = mulberry32(12345);"
run_case ENGINE "service reorder point one draw high" $E "Math.ceil(key12(serviceLevel * iterations)) - 1)];" "Math.ceil(key12(serviceLevel * iterations)))];"
# slow-moving
run_case ENGINE "band minimum exclusive" $E "if (key12(it.monthsSinceLastIssue) >= key12(bands[i].minMonths)) bi = i;" "if (key12(it.monthsSinceLastIssue) > key12(bands[i].minMonths)) bi = i;"
run_case ENGINE "write-down percent not divided by 100" $E "    const writeDown = (stockValue * b.writeDownPct) / 100;" "    const writeDown = stockValue * b.writeDownPct;"
run_case ENGINE "cover limit inclusive" $E ": key12(cover) > key12(excessCoverMonths);" ": key12(cover) >= key12(excessCoverMonths);"
run_case ENGINE "no usage never excess" $E "const excess = cover === null ? it.onHand > 0 :" "const excess = cover === null ? false :"
# accepted keys, bounds and messages (course content)
run_case ENGINE "unknown keys ignored everywhere" $E "  const e = walkKeys(args, ACCEPTED_KEYS[name], '');" "  const e = null;"
run_case ENGINE "unknown keys ignored inside lists" $E "    if (!Array.isArray(v)) return null;" "    return null;"
run_case ENGINE "printed bound rounded to nearest" $E "  let k = Math.floor(x * 1e6);
  while (ok((k + 1) / 1e6)) k += 1;
  while (!ok(k / 1e6)) k -= 1;" "  const k = Math.round(x * 1e6);"
run_case ENGINE "unit agreement dropped" $E "const unit = (text, x, one, many = \`\${one}s\`) => \`\${text} \${x === 1 ? one : many}\`;" "const unit = (text, x, one, many = \`\${one}s\`) => \`\${text} \${many}\`;"
run_case ENGINE "money printed unrounded" $E "const money = (x) => fmt(Number(x.toFixed(2)));" "const money = (x) => fmt(x);"
run_case ENGINE "class reason in other words" $E "is at or above \${fmt(byScore.minScore)}, the minimum for class" "reaches \${fmt(byScore.minScore)}, the minimum for class"
run_case ENGINE "insurance reason drops the marginal spare" $E "  if (next) reason += " "  if (false) reason += "
run_case ENGINE "cost P-label reversal dropped from the basis" $E "so for a lead time or a demand P90 is the LOW figure (10th percentile)" "P90 is the high figure"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle class minimum exclusive" $O "by_score = next(c for c in classes if key12(score) >= key12(c['minScore']))" "by_score = next(c for c in classes if key12(score) > key12(c['minScore']) or c['minScore'] == 0)"
run_case ORACLE "oracle Poisson loss off by one" $O "Ls = D(m) - s + sum(((s - x) * ps[x] for x in range(s)), Decimal(0))" "Ls = D(m) - s + sum(((s - x) * ps[x] for x in range(s + 1)), Decimal(0)) + ps[s]"
run_case ORACLE "oracle fill target at the level" $O "t = D(F(Qo) * (1 - F(lvl))) / sigma" "t = D(F(Qo) * F(lvl)) / sigma"
run_case ORACLE "oracle EOQ without the factor 2" $O "    q = sqrtF(2 * F(A) * F(Dm) / hx)" "    q = sqrtF(F(A) * F(Dm) / hx)"
run_case ORACLE "oracle ABC ranked lowest first" $O "                if rv < v:" "                if rv > v:"
run_case ORACLE "oracle Monte Carlo lead time from the second uniform" $O "        t = draw(lt)
        rate = draw(dd)" "        rate = draw(dd)
        t = draw(lt)"
run_case ORACLE "oracle unknown keys ignored" $O "    e = check_keys(args, SHAPES[fn], '')" "    e = None"

restore
echo "=== summary ==="
echo "engine plants red: $ENGINE_RED/$ENGINE_RUN"
echo "oracle plants caught: $ORACLE_CAUGHT/$ORACLE_RUN"
echo "skipped (target not unique): $SKIPPED"
