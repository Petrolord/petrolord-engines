#!/usr/bin/env bash
# Economics EC10 negative controls for the farm-out engine
# (farmout.js) gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-farmout.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/economics/farmout.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/economics/oracle_farmout.py
#           alone, with the golden regenerated. All must go RED or STOP (the
#           oracle refused to write a golden).
#
#   tools/validation/economics/negcontrol_farmout.sh [filter]
#
# It edits the working tree and restores it on exit: do not stage or commit
# while it runs. The last lines report N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/economics/farmout.js
ORACLE=tools/validation/economics/oracle_farmout.py
GOLDEN=test-data/economics/goldens/farmout_cases.json
TEST=__tests__/economics.farmout.test.js
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
run_case ENGINE "promote computed on the wrong base (points on the event's own earned interest)" $E "promotePoints: ev.farmineePaysPct - Y, promoteRatio: ev.farmineePaysPct / Y," "promotePoints: ev.farmineePaysPct - ev.earnedPct, promoteRatio: ev.farmineePaysPct / Y,"
run_case ENGINE "promote computed on the wrong base (ratio over the farmor's retained interest)" $E "promotePoints: ev.farmineePaysPct - Y, promoteRatio: ev.farmineePaysPct / Y," "promotePoints: ev.farmineePaysPct - Y, promoteRatio: ev.farmineePaysPct / (F - Y),"
run_case ENGINE "carry cap ignored (carry-amount)" $E "const carry = Math.min(carryUncapped, cap.amount);" "const carry = carryUncapped;"
run_case ENGINE "carry cap ignored (gross-cost)" $E "base = Math.min(C, cap.amount);" "base = C;"
run_case ENGINE "cash bonus double-counted (the farminee's positions)" $E "farminee: { success: partyValue(pr, Y) - ws.farmineePays - cash, dry: -wd.farmineePays - cash }," "farminee: { success: partyValue(pr, Y) - ws.farmineePays - cash - deal.cashBonus, dry: -wd.farmineePays - cash - deal.cashBonus },"
run_case ENGINE "cash bonus double-counted (the consideration)" $E "consideration: carry + cashBonus + reimbursement," "consideration: carry + 2 * cashBonus + reimbursement,"
run_case ENGINE "EMV without dry-hole cost (the farminee)" $E "dry: -wd.farmineePays - cash }," "dry: -cash },"
run_case ENGINE "EMV without dry-hole cost (the farmor alone)" $E "dry: -(F * project.wellCost.dry) / 100 }," "dry: 0 },"
run_case ENGINE "EMV without dry-hole cost (the 100% position)" $E "const dry100 = -project.wellCost.dry;" "const dry100 = 0;"
run_case ENGINE "break-even promote solved on the farmor's EMV" $E "const q = payoffs(pr, project, deal, F, x).farminee;" "const q = payoffs(pr, project, deal, F, x).farmorFarmOut;"
run_case ENGINE "NPV-per-percent on unrisked value (the price basis)" $E "const baseValue = valueBasis === 'risked' ? risked100 : success100;" "const baseValue = success100;"
run_case ENGINE "NPV-per-percent on unrisked value (the risked figure)" $E "const perPct = { risked: risked100 / 100," "const perPct = { risked: success100 / 100,"
run_case ENGINE "WI scaling applied twice (stated success NPV)" $E "  : scaleWI(pr.S, wiPct));" "  : scaleWI(scaleWI(pr.S, wiPct), wiPct));"
run_case ENGINE "WI scaling applied twice (cash flows)" $E "scaleWI(y.net, wiPct)), pr.flows.discountRate" "scaleWI(scaleWI(y.net, wiPct), wiPct)), pr.flows.discountRate"
run_case ENGINE "WI scaling applied twice (the priced interest)" $E "const interestValue = scaleWI(baseValue, interestPct);" "const interestValue = scaleWI(scaleWI(baseValue, interestPct), interestPct);"
# earning
run_case ENGINE "overrun rules swapped" $E "const post = cap.overrunRule === 'post-deal-interests';" "const post = cap.overrunRule === 'farmor-side';"
run_case ENGINE "all-events vesting vests event by event" $E "const vested = vesting === 'per-event' ? sum(done.map((r) => r.earnedPct)) : allDone ? Y : 0;" "const vested = sum(done.map((r) => r.earnedPct));"
run_case ENGINE "cap reached exactly counted as exceeded" $E "capState = C < cap.amount ? 'below' : C === cap.amount ? 'exactly' : 'exceeded';" "capState = C < cap.amount ? 'below' : 'exceeded';"
# deal value
run_case ENGINE "farmor keeps its whole interest after the farm-out" $E "farmorFarmOut: { success: partyValue(pr, F - Y)" "farmorFarmOut: { success: partyValue(pr, F)"
run_case ENGINE "assignor fees not paid" $E "- ws.farmorPays + cash - deal.assignorFees, dry: -wd.farmorPays + cash - deal.assignorFees }" "- ws.farmorPays + cash, dry: -wd.farmorPays + cash }"
run_case ENGINE "break-even chance on the wrong side" $E "return { status: 'solved', chanceOfSuccessPct: (-b * 100) / (a - b) };" "return { status: 'solved', chanceOfSuccessPct: (a * 100) / (a - b) };"
# information, risk, fee
run_case ENGINE "VOI likelihoods swapped" $E "likelihoods: [s.likelihoodsPct[0] / 100, s.likelihoodsPct[1] / 100]" "likelihoods: [s.likelihoodsPct[1] / 100, s.likelihoodsPct[0] / 100]"
run_case ENGINE "Monte Carlo seed ignored" $E "correlation, { seed, iterations });" "correlation, { iterations });"
run_case ENGINE "Monte Carlo work cap ignored" $E "  if (iterations * holdings > DEFAULTS.MAX_DRAW_WORK) return" "  if (false) return"
run_case ENGINE "intra group transfer pays the premium" $E "prem = intraGroup ? 0 : NIGERIA_ASSIGNMENT.premiumPct;" "prem = NIGERIA_ASSIGNMENT.premiumPct;"
run_case ENGINE "day 90 counted late" $E "if (days <= N.payWithinDays) status = 'on-time';" "if (days < N.payWithinDays) status = 'on-time';"
run_case ENGINE "surcharge 0.1% a day" $E "surchargePctPerDay: 0.01," "surchargePctPerDay: 0.1,"
run_case ENGINE "the 90th surcharge day withdraws the consent" $E "else if (late <= N.surchargeDays)" "else if (late < N.surchargeDays)"
# keys and messages
run_case ENGINE "unknown keys ignored" $E "  for (const k of Object.keys(v)) if (v[k] !== undefined && !spec.keys.includes(k)) return unknownKey(path, k, spec.keys);" ""
run_case ENGINE "message: money printed with float noise" $E "const money = (x) => fmt(Number(x.toFixed(2)));" "const money = (x) => fmt(x);"
run_case ENGINE "message: unit agreement dropped" $E "const unit = (x, one, many = \`\${one}s\`) => \`\${fmt(x)} \${x === 1 ? one : many}\`;" "const unit = (x, one, many = \`\${one}s\`) => \`\${fmt(x)} \${many}\`;"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle excess by the farmor side under post-deal-interests" $O "segs.append((C - K, {'fin': Y / 100, 'farmor': (Fp - Y) / 100}))" "segs.append((C - K, {'fin': F(0), 'farmor': Fp / 100}))"
run_case ORACLE "oracle bonus left out of the farminee's success" $O "'farminee': {'success': Y / 100 * S - ws['farmineePays'] - cash," "'farminee': {'success': Y / 100 * S - ws['farmineePays'] - reimb,"
run_case ORACLE "oracle break-even bisection keeps the wrong half" $O "        if f_emv(mid) >= 0:" "        if f_emv(mid) < 0:"
run_case ORACLE "oracle posterior of the dry hole" $O "post = p * ls / ps if ps > 0 else p" "post = (1 - p) * ld / ps if ps > 0 else p"
run_case ORACLE "oracle premium 6%" $O "PROCESSING_PCT, PREMIUM_PCT = 2, 5" "PROCESSING_PCT, PREMIUM_PCT = 2, 4"
run_case ORACLE "oracle unknown keys ignored" $O "        OJ.check_keys(args, SHAPES[fn], '')" "        pass"

restore
echo "=== summary ==="
echo "engine plants red: $ENGINE_RED/$ENGINE_RUN"
echo "oracle plants caught: $ORACLE_CAUGHT/$ORACLE_RUN"
echo "skipped (target not unique): $SKIPPED"
