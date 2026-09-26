#!/usr/bin/env bash
# Economics EC9 negative controls for the joint venture engine
# (jointVenture.js) gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-jointVenture.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/economics/jointVenture.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/economics/oracle_jointventure.py
#           alone, with the golden regenerated. All must go RED or STOP (the
#           oracle refused to write a golden).
#
#   tools/validation/economics/negcontrol_jointventure.sh [filter]
#
# It edits the working tree and restores it on exit: do not stage or commit
# while it runs. The last lines report N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/economics/jointVenture.js
ORACLE=tools/validation/economics/oracle_jointventure.py
GOLDEN=test-data/economics/goldens/jointventure_cases.json
TEST=__tests__/economics.jointVenture.test.js
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
run_case ENGINE "paying and beneficial interest swapped (entitlement split by paying interest)" $E "const entSplit = splitBy(y.entitlement, irows, 'beneficialPct');" "const entSplit = splitBy(y.entitlement, irows, 'payingPct');"
run_case ENGINE "paying and beneficial interest swapped (cash calls on beneficial interest)" $E "const fs = splitBy(m.forecast, rows, 'payingPct');
    const as = splitBy(m.actual, rows, 'payingPct');" "const fs = splitBy(m.forecast, rows, 'beneficialPct');
    const as = splitBy(m.actual, rows, 'beneficialPct');"
run_case ENGINE "carry recovered without the stated uplift" $E "const upliftAmt = uplift.type === 'compound' ? (opening * uplift.ratePctPerYear) / 100 :" "const upliftAmt = uplift.type === 'compound' ? 0 :"
run_case ENGINE "over/under-call not carried to a later call" $E "const pending = (due ? due[id] : 0) + carried[id];" "const pending = carried[id];"
run_case ENGINE "overhead base wrong (exclusions ignored)" $E "const base = costs[k] - ex;" "const base = costs[k];"
run_case ENGINE "overhead base wrong (whole base at each band rate)" $E "const amount = Math.max(0, Math.min(base, b.upTo) - lo);" "const amount = base <= b.upTo && base > lo ? base : 0;"
run_case ENGINE "default cover not pro rata (equal shares)" $E "c.cover = (unpaidTotal * c.payingPct) / coverPayTotal;" "c.cover = unpaidTotal / coverRows.length;"
run_case ENGINE "default cover not pro rata (the defaulter left in the base)" $E "const coverPayTotal = sum(coverers.map((r) => r.payingPct));" "const coverPayTotal = sum(rows.map((r) => r.payingPct));"
run_case ENGINE "premium multiple applied to the whole cost" $E "premium: (operation.cost * p.participatingPct * premiumMultiplePct) / 10000" "premium: (operation.cost * premiumMultiplePct) / 100"
run_case ENGINE "premium multiple applied to the consenting parties' cost" $E "premium: (operation.cost * p.participatingPct * premiumMultiplePct) / 10000" "premium: (operation.cost * (100 - p.participatingPct) * premiumMultiplePct) / 10000"
run_case ENGINE "reversion one period late (the whole share taken in the payout year)" $E "const recovered = Math.min(available, due, capLeft);" "const recovered = due > 0 ? Math.min(available, capLeft) : 0;"
# interests and cash calls
run_case ENGINE "carry pro rata over every party (carried party included)" $E "const payerTotal = sum(payers.map((p) => p.participatingPct));" "const payerTotal = sum(parties.map((p) => p.participatingPct));"
run_case ENGINE "reconciliation one month early" $E "const due = t - lag >= 0 ? diffs[t - lag] : null;" "const due = t - lag + 1 >= 0 && t > 0 ? diffs[t - lag + 1] : null;"
run_case ENGINE "negative call refunded under 'carry'" $E "if (raw >= 0 || negativeCall === 'refund') call = raw; else carryOut = -raw;" "call = raw;"
run_case ENGINE "threshold strict (a forecast at the threshold not called)" $E "const called = noCallBelow === undefined || m.forecast >= noCallBelow;" "const called = noCallBelow === undefined || m.forecast > noCallBelow;"
# budget
run_case ENGINE "budget item tolerance strict" $E "within = it.actual <= limit;" "within = it.actual < limit;"
run_case ENGINE "budget tolerance the higher of pct and amount" $E "const allowed = budgetTolerance.amount === undefined ? byPct : Math.min(byPct, budgetTolerance.amount);" "const allowed = budgetTolerance.amount === undefined ? byPct : Math.max(byPct, budgetTolerance.amount);"
# default dates and interest
run_case ENGINE "default interest counts the value date" $E "const days = dayNo(end) - dayNo(dueDate);" "const days = dayNo(end) - dayNo(dueDate) + 1;"
run_case ENGINE "working days count weekends" $E "if (wd !== 0 && wd !== 6 && !holidays.has(dayName(k))) left -= 1;" "if (!holidays.has(dayName(k))) left -= 1;"
run_case ENGINE "working days ignore holidays" $E "if (wd !== 0 && wd !== 6 && !holidays.has(dayName(k))) left -= 1;" "if (wd !== 0 && wd !== 6) left -= 1;"
run_case ENGINE "months overflow past the month end" $E "Math.min(dd, last)" "dd"
run_case ENGINE "consequence applies on the trigger date itself" $E "const applies = d.curedOn !== undefined ? d.curedOn > on : asOf > on;" "const applies = d.curedOn !== undefined ? d.curedOn >= on : asOf >= on;"
run_case ENGINE "forfeited interest apportioned over every party" $E "const keepTotal = sum(keep.map((p) => p.participatingPct));" "const keepTotal = 100;"
# carry and back-in
run_case ENGINE "carried cost on the paying interest" $E "const added = years.map((y) => (y.cost * cRow.beneficialPct * c.carriedPct) / 10000);" "const added = years.map((y) => (y.cost * cRow.payingPct * c.carriedPct) / 10000);"
run_case ENGINE "recovery share ignores recoverFromPct" $E "const available = (share * recoverFromPct) / 100;" "const available = share;"
run_case ENGINE "uplift on the year's new cost too" $E "(opening * uplift.ratePctPerYear) / 100" "((opening + added[i]) * uplift.ratePctPerYear) / 100"
run_case ENGINE "PIA uplift allowed" $E "if (basis === 'pia-s85-4' && uplift.type !== 'none') return" "if (false) return"
run_case ENGINE "PIA participation cap 65" $E "maxGovernmentParticipationPct: 60," "maxGovernmentParticipationPct: 65,"
run_case ENGINE "PIA refund includes exploration" $E "refundableKinds: Object.freeze(['development', 'production'])," "refundableKinds: Object.freeze(['exploration', 'development', 'production']),"
run_case ENGINE "back-in reduction in equal points" $E "after: me ? targetPct : (p.participatingPct * (100 - targetPct)) / rest," "after: me ? targetPct : p.participatingPct - step / (parties.length - 1),"
run_case ENGINE "back-in refund on the target interest" $E "const refund = (step * refundable) / 100;" "const refund = (targetPct * refundable) / 100;"
# non-consent
run_case ENGINE "non-consent: deductions not taken off" $E "entitlement: Math.max(0, y.grossValue - y.deductions)" "entitlement: y.grossValue"
run_case ENGINE "buy-in apportioned on the participating interest over 100" $E "toParties: shares.map((s) => ({ id: s.id, amount: (r.premium * s.participatingPct) / consTotal }))" "toParties: shares.map((s) => ({ id: s.id, amount: (r.premium * s.participatingPct) / 100 }))"
# PSC
run_case ENGINE "PSC gross limit passed on revenue after royalty" $E "const capFraction = costOilLimitBase === 'gross' ? costOilLimitPct / (100 - royaltyPct) : costOilLimitPct / 100;" "const capFraction = costOilLimitPct / 100;"
run_case ENGINE "PSC entitlement split on 100 - share" $E "const ent = splitBy(r.contractorEntitlement, irows, 'pct');" "const ent = splitBy(r.contractorEntitlement, irows.map((x) => ({ ...x, pct: 100 / irows.length })), 'pct');"
run_case ENGINE "NPV discounted one year early" $E "npv: npv(flows[id], discountRate, baseYear, years[0].year) }));
  return {
    carried," "npv: npv(flows[id], discountRate, baseYear, years[0].year - 1) }));
  return {
    carried,"
# default interest method and grace (lead decision)
run_case ENGINE "monthly compounding computed as simple" $E "const growth = (1 + interest.annualRatePct / 1200) ** wholeMonths * (1 + (interest.annualRatePct * remainingDays) / (100 * interest.dayBasis));" "const growth = 1 + (interest.annualRatePct * (dayNo(end) - dayNo(dueDate))) / (100 * interest.dayBasis);"
run_case ENGINE "monthly rate taken as the annual rate" $E "(1 + interest.annualRatePct / 1200) ** wholeMonths" "(1 + interest.annualRatePct / 100) ** wholeMonths"
run_case ENGINE "remaining days after the whole months dropped" $E "* (1 + (interest.annualRatePct * remainingDays) / (100 * interest.dayBasis));" ";"
run_case ENGINE "grace boundary strict (72 hours exceeds a 72-hour grace)" $E "const withinGrace = days * 24 <= interest.graceHours;" "const withinGrace = days * 24 < interest.graceHours;"
run_case ENGINE "grace ignored" $E "const withinGrace = days * 24 <= interest.graceHours;" "const withinGrace = false;"
run_case ENGINE "interest starts after the grace" $E "amount = withinGrace ? 0 : (unpaid * interest.annualRatePct * days) / (100 * interest.dayBasis);" "amount = withinGrace ? 0 : (unpaid * interest.annualRatePct * (days - interest.graceHours / 24)) / (100 * interest.dayBasis);"
run_case ENGINE "graceHours defaults to 0" $E "fin(interest.graceHours) && interest.graceHours >= 0 ? null :" "interest.graceHours === undefined || (fin(interest.graceHours) && interest.graceHours >= 0) ? null :"
# keys and messages
run_case ENGINE "unknown keys ignored" $E "  for (const k of Object.keys(v)) if (v[k] !== undefined && !spec.keys.includes(k)) return unknownKey(path, k, spec.keys);" ""
run_case ENGINE "message: money printed with float noise" $E "const money = (x) => fmt(Number(x.toFixed(2)));" "const money = (x) => fmt(x);"
run_case ENGINE "message: unit agreement dropped" $E "const unit = (x, one, many = \`\${one}s\`) => \`\${fmt(x)} \${x === 1 ? one : many}\`;" "const unit = (x, one, many = \`\${one}s\`) => \`\${fmt(x)} \${many}\`;"
run_case ENGINE "message: PIA uplift refusal loses its section" $E "the refund excludes interest, premium or markups on cost (PIA s.85(4)(c))" "the refund excludes interest"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle adjustment one month late" $O "due_sum = sum((diff[s][k] for s in range(0, t - lag + 1)), F(0))" "due_sum = sum((diff[s][k] for s in range(0, t - lag)), F(0))"
run_case ORACLE "oracle band charges the whole lower band only" $O "                amt_ = hi - lo" "                amt_ = F(0)"
run_case ORACLE "oracle gross limit on revenue after royalty" $O "limit = gross * F(lim) / 100 if base == 'gross' else net * F(lim) / 100" "limit = net * F(lim) / 100"
run_case ORACLE "oracle premium on the whole cost" $O "own_share = cost * F(p['participatingPct']) / 100" "own_share = cost"
run_case ORACLE "oracle carry pro rata over every party" $O "w = [(p['id'], F(p['participatingPct']) / ptot) for p in payers]" "w = [(p['id'], F(p['participatingPct']) / 100) for p in payers]"
run_case ORACLE "oracle interest counts the value date" $O "days = (end - parse_day(due)).days" "days = (end - parse_day(due)).days + 1"
run_case ORACLE "oracle unknown keys ignored" $O "        check_keys(args, SHAPES[fn], '')" "        pass"

restore
echo "=== summary ==="
echo "engine plants red: $ENGINE_RED/$ENGINE_RUN"
echo "oracle plants caught: $ORACLE_CAUGHT/$ORACLE_RUN"
echo "skipped (target not unique): $SKIPPED"
