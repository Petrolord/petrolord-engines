#!/usr/bin/env bash
# Negative controls for the HSE H2 exposure gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-exposure.md about what this suite catches was produced by
# running this file: each row plants ONE defect, runs the suite, and
# records whether it went red.
#
#   ENGINE   plants in engines/hse/exposure.js alone. All must go RED.
#   ORACLE   plants in tools/validation/hse/oracle_exposure.py alone, with
#            the golden regenerated. All must go RED: the control on the
#            controls, proving the harness tells the two files apart.
#   BOTH     the same defect in BOTH files, golden regenerated. Only a
#            PUBLISHED value can catch these. Rows marked (expect RED) are
#            caught by a printed table; rows marked (expect GREEN) are the
#            honest statement of what nothing published here checks.
#
# Usage: tools/validation/hse/negcontrol_exposure.sh [filter]
set -u
cd "$(dirname "$0")/../../.." || exit 1
ENGINE=engines/hse/exposure.js
ORACLE=tools/validation/hse/oracle_exposure.py
GOLDEN=test-data/hse/goldens/exposure_cases.json
TEST=__tests__/hse.exposure.test.js
FILTER=${1:-}
TMP=$(mktemp -d)
cp "$ENGINE" "$TMP/engine.bak"; cp "$ORACLE" "$TMP/oracle.bak"; cp "$GOLDEN" "$TMP/golden.bak"
restore() { cp "$TMP/engine.bak" "$ENGINE"; cp "$TMP/oracle.bak" "$ORACLE"; cp "$TMP/golden.bak" "$GOLDEN"; }
trap restore EXIT

plant() { # file from to
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if s.count(a) != 1:
    sys.stderr.write("PLANT TARGET NOT UNIQUE (%d): %s\n" % (s.count(a), a))
    sys.exit(3)
open(path, "w").write(s.replace(a, b))
PY
}

run_case() { # kind name engine_from engine_to oracle_from oracle_to
  kind=$1; name=$2; ef=$3; et=$4; of=$5; ot=$6
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  if [ -n "$ef" ]; then plant "$ENGINE" "$ef" "$et" || { echo "SKIP  $name (engine target)"; return; }; fi
  if [ -n "$of" ]; then
    plant "$ORACLE" "$of" "$ot" || { echo "SKIP  $name (oracle target)"; return; }
    python3 "$ORACLE" >/dev/null || { echo "SKIP  $name (oracle failed)"; return; }
  fi
  out=$(timeout 180 npx jest "$TEST" 2>&1)
  if echo "$out" | grep -q "Tests:.*failed"; then
    n=$(echo "$out" | grep -E "^Tests:" | grep -oE "[0-9]+ failed")
    first=$(echo "$out" | grep -E "^\s+● " | head -2 | sed 's/^ *● //' | tr '\n' ';')
    echo "RED   [$kind] $name -- $n -- $first"
  else
    echo "GREEN [$kind] $name"
  fi
}

echo "=== baseline ==="
restore
npx jest "$TEST" 2>&1 | grep -E "^Tests:"

echo "=== ENGINE-ONLY plants (all must be RED) ==="
run_case ENGINE "OSHA PEL exchange rate 5 -> 3" \
  "exchangeRateDb: 5,
    thresholdDbA: 90," "exchangeRateDb: 3,
    thresholdDbA: 90," "" ""
run_case ENGINE "OSHA action level exchange rate 5 -> 3" \
  "exchangeRateDb: 5,
    thresholdDbA: 80," "exchangeRateDb: 3,
    thresholdDbA: 80," "" ""
run_case ENGINE "OSHA PEL TWA coefficient 16.61 -> 10" \
  "thresholdDbA: 90,
    twaCoefficientDb: 16.61," "thresholdDbA: 90,
    twaCoefficientDb: 10," "" ""
run_case ENGINE "NIOSH TWA coefficient 10.0 -> 3/log10(2)" \
  "twaCoefficientDb: 10.0," "twaCoefficientDb: 3 / Math.log10(2)," "" ""
run_case ENGINE "NIOSH exchange rate 3 -> 5" \
  "exchangeRateDb: 3,
    thresholdDbA: 80," "exchangeRateDb: 5,
    thresholdDbA: 80," "" ""
run_case ENGINE "PEL threshold 90 -> 80" \
  "thresholdDbA: 90," "thresholdDbA: 80," "" ""
run_case ENGINE "dose threshold inclusive -> exclusive" \
  "if (p.levelDbA < c.thresholdDbA) {
      return { levelDbA" "if (p.levelDbA <= c.thresholdDbA) {
      return { levelDbA" "" ""
run_case ENGINE "reference duration 8 h -> 8.5 h" \
  "referenceDurationH: 8 / 2 **" "referenceDurationH: 8.5 / 2 **" "" ""
run_case ENGINE "action limit 50 -> 100 percent" \
  "limitDosePct: 50," "limitDosePct: 100," "" ""
run_case ENGINE "extended-shift AL 12.5 -> 12" \
  "16.61 * Math.log10(50 / (12.5 * shiftHours)) + 90" "16.61 * Math.log10(50 / (12 * shiftHours)) + 90" "" ""
run_case ENGINE "OSHA field derating 50 -> 60 percent" \
  "(nrrDb - 7) * 0.5" "(nrrDb - 7) * 0.6" "" ""
run_case ENGINE "NIOSH earmuff credit 0.75 -> 0.7" \
  "earmuff: 0.75," "earmuff: 0.7," "" ""
run_case ENGINE "dual protection +5 -> +3" \
  "(weighting === 'A' ? nrrDb - 7 : nrrDb) + 5" "(weighting === 'A' ? nrrDb - 7 : nrrDb) + 3" "" ""
run_case ENGINE "protector floor removed" \
  "const attenuationDb = Math.max(0, rawAttenuationDb);" "const attenuationDb = rawAttenuationDb;" "" ""
run_case ENGINE "LEX reference 8 h -> 8.5 h" \
  "const energy = periods.map((p) => (p.durationH / 8) *" "const energy = periods.map((p) => (p.durationH / 8.5) *" "" ""
run_case ENGINE "exposure points pivot 85 -> 80" \
  "exposurePoints: 100 * (durationH / 8) * 10 ** ((laeqDbA - 85) / 10)" "exposurePoints: 100 * (durationH / 8) * 10 ** ((laeqDbA - 80) / 10)" "" ""
run_case ENGINE "weekly LEX divisor 5 -> days" \
  "10 * Math.log10(sum / 5)" "10 * Math.log10(sum / dailyLexDbA.length)" "" ""
run_case ENGINE "chemical TWA divides by the sampled time" \
  "twa8h: periods.reduce((s, p) => s + p.concentration * p.durationH, 0) / 8," "twa8h: periods.reduce((s, p) => s + p.concentration * p.durationH, 0) / totalDurationH," "" ""
run_case ENGINE "STEL window 15 -> sampled minutes" \
  "stel15Min: periods.reduce((s, p) => s + p.concentration * p.durationMin, 0) / 15," "stel15Min: periods.reduce((s, p) => s + p.concentration * p.durationMin, 0) / totalDurationMin," "" ""
run_case ENGINE "mixture C/L -> L/C" \
  "components.map((c) => c.concentration / c.limit)" "components.map((c) => c.limit / c.concentration)" "" ""
run_case ENGINE "mixture unity inclusive" \
  "exceeds: index > 1," "exceeds: index >= 1," "" ""
run_case ENGINE "Brief and Scala 16 -> 15" \
  "((24 - shiftHours) / 16)" "((24 - shiftHours) / 15)" "" ""
run_case ENGINE "Brief and Scala cap at 1 removed" \
  "return { rf: Math.min(1, rawRf), rawRf, basis: 'daily'" "return { rf: rawRf, rawRf, basis: 'daily'" "" ""
run_case ENGINE "Brief and Scala weekly 128 -> 120" \
  "((168 - weeklyHours) / 128)" "((168 - weeklyHours) / 120)" "" ""
run_case ENGINE "the larger factor governs" \
  "(b.rf < a.rf ? b : a)" "(b.rf > a.rf ? b : a)" "" ""
run_case ENGINE "WBGT outdoor 0.2 Tg + 0.1 Ta swapped" \
  "0.7 * naturalWetBulbC + 0.2 * globeC + 0.1 * dryBulbC" "0.7 * naturalWetBulbC + 0.1 * globeC + 0.2 * dryBulbC" "" ""
run_case ENGINE "WBGT indoor 0.3 -> 0.2" \
  "0.7 * naturalWetBulbC + 0.3 * globeC" "0.7 * naturalWetBulbC + 0.2 * globeC" "" ""
run_case ENGINE "REL slope 11.5 -> 11" \
  "(metabolicRateW) => heatLimit(metabolicRateW, 56.7, 11.5," "(metabolicRateW) => heatLimit(metabolicRateW, 56.7, 11," "" ""
run_case ENGINE "RAL intercept 59.9 -> 59" \
  "heatLimit(metabolicRateW, 59.9, 14.1," "heatLimit(metabolicRateW, 59, 14.1," "" ""
run_case ENGINE "refusals lose their field name" \
  "const refuse = (field, message) => ({ error: message, field });" "const refuse = (field, message) => ({ error: message });" "" ""
run_case ENGINE "negative duration accepted" \
  "if (rule === 'nonneg' && v < 0)" "if (false && v < 0)" "" ""

echo "=== ORACLE-ONLY plants (all must be RED) ==="
run_case ORACLE "oracle OSHA coefficient 16.61 -> 16.6096" "" "" \
  "'OSHA_PEL': dict(lc=90, q=5, thr=90, k=16.61, limit=100)," "'OSHA_PEL': dict(lc=90, q=5, thr=90, k=16.6096, limit=100),"
run_case ORACLE "oracle LEX reference 28800 s -> 28000 s" "" "" \
  "return 10.0 * math.log10(e / (P0 ** 2 * 28800.0))" "return 10.0 * math.log10(e / (P0 ** 2 * 28000.0))"
run_case ORACLE "oracle Brief and Scala 16 -> 15" "" "" \
  "rf = F(8, 1) / h * (24 - h) / 16
        g.add(f'bs-daily-{h}h', 'briefScalaDailyRf', [h], {'rf': float(min(1, rf)), 'rawRf': float(rf)},
              SRC_BS" "rf = F(8, 1) / h * (24 - h) / 15
        g.add(f'bs-daily-{h}h', 'briefScalaDailyRf', [h], {'rf': float(min(1, rf)), 'rawRf': float(rf)},
              SRC_BS"
run_case ORACLE "oracle REL 11.5 -> 11" "" "" \
  "return 56.7 - 11.5 * math.log10(m)" "return 56.7 - 11 * math.log10(m)"

echo "=== BOTH-FILE plants: only a printed value can catch these ==="
run_case BOTH "16.61 -> 10 in both (expect RED: Table A-1)" \
  "thresholdDbA: 90,
    twaCoefficientDb: 16.61," "thresholdDbA: 90,
    twaCoefficientDb: 10," \
  "'OSHA_PEL': dict(lc=90, q=5, thr=90, k=16.61, limit=100)," "'OSHA_PEL': dict(lc=90, q=5, thr=90, k=10, limit=100),"
run_case BOTH "NIOSH 10.0 -> 3/log10(2) in both (expect RED: Table 1-2)" \
  "twaCoefficientDb: 10.0," "twaCoefficientDb: 3 / Math.log10(2)," \
  "'NIOSH_REL': dict(lc=85, q=3, thr=80, k=10.0, limit=100)," "'NIOSH_REL': dict(lc=85, q=3, thr=80, k=3 / math.log10(2), limit=100),"
run_case BOTH "WBGT outdoor weights swapped in both (expect GREEN: nothing printed)" \
  "0.7 * naturalWetBulbC + 0.2 * globeC + 0.1 * dryBulbC" "0.7 * naturalWetBulbC + 0.1 * globeC + 0.2 * dryBulbC" \
  "F('0.2') * F(str(tg)) + F('0.1') * F(str(ta))" "F('0.1') * F(str(tg)) + F('0.2') * F(str(ta))"
run_case BOTH "REL slope 11.5 -> 11 in both (expect GREEN: nothing printed reproduces)" \
  "(metabolicRateW) => heatLimit(metabolicRateW, 56.7, 11.5," "(metabolicRateW) => heatLimit(metabolicRateW, 56.7, 11," \
  "return 56.7 - 11.5 * math.log10(m)" "return 56.7 - 11 * math.log10(m)"

restore
echo "=== restored; verifying clean ==="
python3 "$ORACLE" >/dev/null
git diff --quiet -- "$GOLDEN" && echo "golden byte-identical to the committed one"
npx jest "$TEST" 2>&1 | grep -E "^Tests:"
