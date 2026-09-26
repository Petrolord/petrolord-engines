#!/usr/bin/env bash
# Economics EC8 negative controls for the gas sales agreement engine
# (gasContract.js) gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-gasContract.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/economics/gasContract.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/economics/oracle_gascontract.py
#           alone, with the golden regenerated. All must go RED or STOP (the
#           oracle refused to write a golden).
#
#   tools/validation/economics/negcontrol_gascontract.sh [filter]
#
# It edits the working tree and restores it on exit: do not stage or commit
# while it runs. The last lines report N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/economics/gasContract.js
ORACLE=tools/validation/economics/oracle_gascontract.py
GOLDEN=test-data/economics/goldens/gascontract_cases.json
TEST=__tests__/economics.gasContract.test.js
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
# take-or-pay base and netting
run_case ENGINE "TOP base: TOPQ on the ACQ (no adjustment)" $E "const topQuantity = (topPct * adjustedAcq) / 100;" "const topQuantity = (topPct * y.acq) / 100;"
run_case ENGINE "FM netting: force majeure not netted from the ACQ" $E "const adjustedAcq = y.acq - maint - fm - sfq - perm;" "const adjustedAcq = y.acq - maint - sfq - perm;"
run_case ENGINE "seller shortfall not netted from the ACQ" $E "const adjustedAcq = y.acq - maint - fm - sfq - perm;" "const adjustedAcq = y.acq - maint - fm - perm;"
run_case ENGINE "permitted reduction not netted" $E "const adjustedAcq = y.acq - maint - fm - sfq - perm;" "const adjustedAcq = y.acq - maint - fm - sfq;"
# make-up order, FIFO, expiry, end of term
run_case ENGINE "make-up order: Adjusted ACQ and TOPQ thresholds swapped" $E "const threshold = makeUp.order === 'after-adjusted-acq' ? adjustedAcq : makeUp.order === 'after-top-quantity' ? topQuantity : 0;" "const threshold = makeUp.order === 'after-adjusted-acq' ? topQuantity : makeUp.order === 'after-top-quantity' ? adjustedAcq : 0;"
run_case ENGINE "make-up order: 'first' waits for the Adjusted ACQ" $E "const threshold = makeUp.order === 'after-adjusted-acq' ? adjustedAcq : makeUp.order === 'after-top-quantity' ? topQuantity : 0;" "const threshold = makeUp.order === 'after-adjusted-acq' ? adjustedAcq : makeUp.order === 'after-top-quantity' ? topQuantity : adjustedAcq;"
run_case ENGINE "make-up drawn last in first out" $E "  for (const entry of ledger) {" "  for (const entry of ledger.slice().reverse()) {"
run_case ENGINE "expiry boundary: make-up period one year longer" $E "mu.push({ fromYear: y.year, lastYear: y.year + makeUp.periodYears, left: deficiencyPaid });" "mu.push({ fromYear: y.year, lastYear: y.year + makeUp.periodYears + 1, left: deficiencyPaid });"
run_case ENGINE "expiry boundary: make-up period one year shorter" $E "mu.push({ fromYear: y.year, lastYear: y.year + makeUp.periodYears, left: deficiencyPaid });" "mu.push({ fromYear: y.year, lastYear: y.year + makeUp.periodYears - 1, left: deficiencyPaid });"
run_case ENGINE "expiry test on a later year only" $E "for (const m of mu) if (m.lastYear === y.year && m.left > 0)" "for (const m of mu) if (m.lastYear < y.year && m.left > 0)"
run_case ENGINE "last-year deficiency opens a make-up entry" $E "if (deficiencyPaid > 0 && makeUp.periodYears > 0 && y.year !== last) mu.push(" "if (deficiencyPaid > 0 && makeUp.periodYears > 0) mu.push("
run_case ENGINE "end-of-term refund at the contract price" $E "if (makeUp.endOfTerm === 'refund') refund = q * y.topPrice;" "if (makeUp.endOfTerm === 'refund') refund = q * y.contractPrice;"
run_case ENGINE "deficiency paid at the contract price" $E "const deficiencyPayment = deficiencyPaid * y.topPrice;" "const deficiencyPayment = deficiencyPaid * y.contractPrice;"
run_case ENGINE "make-up gas invoiced at the contract price" $E "const makeUpRevenue = makeUpTaken * y.makeUpPrice;" "const makeUpRevenue = makeUpTaken * y.contractPrice;"
run_case ENGINE "shortfall damages added to the seller" $E "netToSeller: regularRevenue + makeUpRevenue + deficiencyPayment - shortfallPayment - refund," "netToSeller: regularRevenue + makeUpRevenue + deficiencyPayment + shortfallPayment - refund,"
# carry forward
run_case ENGINE "carry-forward cap ignored" $E "cfApplied = Math.min(cfAvail, (carryForward.capPct * deficiency) / 100);" "cfApplied = Math.min(cfAvail, deficiency);"
run_case ENGINE "carry-forward base swapped" $E "const base = carryForward.base === 'adjusted-acq' ? adjustedAcq : topQuantity;" "const base = carryForward.base === 'adjusted-acq' ? topQuantity : adjustedAcq;"
run_case ENGINE "carry-forward never expires" $E "for (const c of cf) if (c.lastYear === y.year && c.left > 0)" "for (const c of cf) if (false)"
# daily balance
run_case ENGINE "seller shortfall measured against the quantity taken" $E "const gap = pnq - deliveryTolerance - d.available;" "const gap = pnq - deliveryTolerance - d.taken;"
run_case ENGINE "delivery tolerance ignored" $E "const gap = pnq - deliveryTolerance - d.available;" "const gap = pnq - d.available;"
run_case ENGINE "nomination not capped at MaxDCQ" $E "const pnq = maxDcq !== null && d.nominated > maxDcq ? maxDcq : d.nominated;" "const pnq = d.nominated;"
run_case ENGINE "force majeure does not excuse the gap" $E "const excused = Math.min(gap, fm + sm);" "const excused = Math.min(gap, sm);"
run_case ENGINE "buyer-caused day counted against the seller" $E "if (d.buyerCaused === true) {" "if (false) {"
# price formulas
run_case ENGINE "price lag one month longer" $E "const wEnd = blockStart - lagMonths;" "const wEnd = blockStart - lagMonths - 1;"
run_case ENGINE "averaging divides by one month too many" $E "averages[nm] = s / averagingMonths;" "averages[nm] = s / (averagingMonths + 1);"
run_case ENGINE "averaging window one month short" $E "const wStart = wEnd - averagingMonths + 1;" "const wStart = wEnd - averagingMonths + 2;"
run_case ENGINE "reset ignored (priced monthly)" $E "const blockStart = t0 + Math.floor((t - t0) / resetMonths) * resetMonths;" "const blockStart = t;"
run_case ENGINE "S-curve kink: low segment keeps the mid slope" $E "s.lowSlope * (x - s.lowKink)" "f.slope * (x - s.lowKink)"
run_case ENGINE "S-curve kink: high segment not anchored at the kink" $E "return { raw: f.constant + f.slope * s.highKink + s.highSlope * (x - s.highKink), segment: 'high' };" "return { raw: f.constant + s.highSlope * x, segment: 'high' };"
run_case ENGINE "S-curve kink: the low kink itself in the low segment" $E "if (x < s.lowKink) return" "if (x <= s.lowKink) return"
run_case ENGINE "price floor ignored" $E "if (f.floor !== undefined && raw < f.floor)" "if (false && raw < f.floor)"
run_case ENGINE "rounding: fifth decimal 5 rounds down" $E "return Number(fp[4]) >= 5 ?" "return Number(fp[4]) > 5 ?"
run_case ENGINE "rounding: rounded to 5 decimals before the 4-decimal rule" $E "const s = Number(x.toPrecision(DEFAULTS.PRICE_DIGITS)).toFixed(DEFAULTS.PRICE_DIGITS);" "const s = Number(x.toFixed(5)).toFixed(DEFAULTS.PRICE_DIGITS);"
run_case ENGINE "basket index floor ignored" $E "if (lo !== undefined && x < lo) x = lo;" "if (false) x = lo;"
run_case ENGINE "escalation steps monthly" $E "const k = Math.floor((blockStart - monthIndex(formula.baseMonth)) / 12);" "const k = (blockStart - monthIndex(formula.baseMonth)) / 12;"
# quantities and energy
run_case ENGINE "day count: every year 365 days" $E "const n = calendarDays(year);" "const n = 365;"
run_case ENGINE "period end date counted" $E "- Date.parse(\`\${period.start}T00:00:00Z\`)) / 86400000);" "- Date.parse(\`\${period.start}T00:00:00Z\`)) / 86400000) + 1;"
run_case ENGINE "effective swing inverted" $E "out.effectiveSwing = maxDcqPct / topPct;" "out.effectiveSwing = topPct / maxDcqPct;"
run_case ENGINE "Btu at 59 F in place of the International Table Btu" $E "BTU_IT_J: 1055.05585262," "BTU_IT_J: 1054.804,"
run_case ENGINE "cubic foot rounded to 0.0283" $E "M3_PER_FT3: 0.028316846592," "M3_PER_FT3: 0.0283,"
# Nigeria
run_case ENGINE "commercial adder 0.6" $E "commercialAdderUsdPerMmbtu: 0.5," "commercialAdderUsdPerMmbtu: 0.6,"
run_case ENGINE "gas based industries floor 0.95" $E "gbiFloorUsdPerMmbtu: 0.9," "gbiFloorUsdPerMmbtu: 0.95,"
run_case ENGINE "GTL PRP 250" $E "nrp: 1, prp: 325 })," "nrp: 1, prp: 250 }),"
run_case ENGINE "EPF over CMPP" $E "const epf = (cmpp - prp) / prp;" "const epf = (cmpp - prp) / cmpp;"
run_case ENGINE "GBI floor applied before the ceiling" $E "    if (price > dbp) { price = dbp; held = 'ceiling'; }
    if (price < PIA_GAS.gbiFloorUsdPerMmbtu) { price = PIA_GAS.gbiFloorUsdPerMmbtu; held = 'floor'; }" "    if (price < PIA_GAS.gbiFloorUsdPerMmbtu) { price = PIA_GAS.gbiFloorUsdPerMmbtu; held = 'floor'; }"
run_case ENGINE "DGDO penalty 3" $E "dgdoPenaltyUsdPerMmbtu: 3.5," "dgdoPenaltyUsdPerMmbtu: 3,"
run_case ENGINE "DGDO agreement rate below 3.50 accepted" $E "rate = Math.max(agreementPenaltyRate, PIA_GAS.dgdoPenaltyUsdPerMmbtu);" "rate = agreementPenaltyRate;"
run_case ENGINE "DGDO deemed fulfilment strictly above" $E "const deemedFulfilled = voluntaryContracts >= obligation;" "const deemedFulfilled = voluntaryContracts > obligation;"
run_case ENGINE "DGDO excuses not capped at the undelivered quantity" $E "const used = Math.min(q, left);" "const used = q;"
# cash flows
run_case ENGINE "royalty ignores the in-country share" $E "const rate = deriveGasRoyaltyRate(royalty.terrain, share);" "const rate = deriveGasRoyaltyRate(royalty.terrain, 0);"
run_case ENGINE "royalty charged on deficiency payments" $E "const deliveredValue = r.taken * contract.years[i].contractPrice;" "const deliveredValue = r.netToSeller;"
run_case ENGINE "NPV discounted one year early" $E "npvNetAfterRoyalty: npv(net, discountRate, baseYear, firstYear)," "npvNetAfterRoyalty: npv(net, discountRate, baseYear, firstYear - 1),"
# accepted keys and messages
run_case ENGINE "unknown keys ignored" $E "  for (const k of Object.keys(v)) if (v[k] !== undefined && !spec.keys.includes(k)) return unknownKey(path, k, spec.keys);" ""
run_case ENGINE "message: make-up expiry wording" $E "expired unrecovered at the end of \${y.year}, the last year of its make-up period" "expired at the end of \${y.year}"
run_case ENGINE "message: unit agreement dropped" $E "make up \${fmt(deficiencyPaid)} in the \${unit(makeUp.periodYears, 'contract year')} after" "make up \${fmt(deficiencyPaid)} in the \${fmt(makeUp.periodYears)} contract years after"
run_case ENGINE "message: domestic base price refusal" $E "the Authority determines it each year (PIA s.167(1)) and the engine holds no default" "the Authority determines it each year"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle TOPQ on the ACQ" $O "        topq = top * adj / 100                                       # TOPQ" "        topq = top * F(y['acq']) / 100"
run_case ORACLE "oracle make-up drawn newest first" $O "    for e in ledger:" "    for e in reversed(ledger):"
run_case ORACLE "oracle window ends at the priced month" $O "            we, ws_ = b0 - lag, b0 - lag - avgm + 1" "            we, ws_ = b0, b0 - avgm + 1"
run_case ORACLE "oracle DGDO rate 3" $O "DGDO_RATE = F(7, 2)" "DGDO_RATE = F(3)"
run_case ORACLE "oracle royalty 5% in-country" $O "    rate = F(5, 100) * (1 - s / 100) + F(25, 1000) * (s / 100)" "    rate = F(5, 100)"
run_case ORACLE "oracle unknown keys ignored" $O "        check_keys(args, SHAPES[fn], '')" "        pass"

restore
echo "=== summary ==="
echo "engine plants red: $ENGINE_RED/$ENGINE_RUN"
echo "oracle plants caught: $ORACLE_CAUGHT/$ORACLE_RUN"
echo "skipped (target not unique): $SKIPPED"
