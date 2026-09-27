#!/usr/bin/env bash
# Supply Chain SC4 negative controls for the marine logistics (marineLogistics.js) gate.
#
# A gate that restates the formula validates nothing, so every claim in
# the FINDINGS text for marine about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/supplychain/marineLogistics.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/supplychain/oracle_marine.py alone,
#           with the golden regenerated. All must go RED or STOP (the
#           oracle refused to write a golden).
#
#   tools/validation/supplychain/negcontrol_marine.sh [filter]
#
# It edits the working tree and restores it on exit: do not stage or commit
# while it runs. The last lines report N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/supplychain/marineLogistics.js
ORACLE=tools/validation/supplychain/oracle_marine.py
GOLDEN=test-data/supplychain/goldens/marine_cases.json
TEST=__tests__/supplychain.marine.test.js
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
# voyage time and fuel
run_case ENGINE "weather factor on every activity" $E "h[a] = appliesTo.includes(a) ? calm[a] * factor : calm[a];" "h[a] = calm[a] * factor;"
run_case ENGINE "weather factor ignored" $E "h[a] = appliesTo.includes(a) ? calm[a] * factor : calm[a];" "h[a] = calm[a];"
run_case ENGINE "speed read as km/h" $E "sailing: nm / vessel.speedKnots," "sailing: nm / (vessel.speedKnots * 1.852),"
run_case ENGINE "return leg dropped" $E "const nm = sum(v.legs.map((l) => l.nm));" "const nm = sum(v.legs.slice(0, -1).map((l) => l.nm));"
run_case ENGINE "dedicated voyage one way" $E "{ from: x.id, to: 'base', nm: x.distanceFromBaseNm }" "{ from: x.id, to: 'base', nm: 0 }"
run_case ENGINE "every activity burns at the sailing rate" $E "for (const a of ACTIVITIES) f[a] = hours[a] * vessel.fuelTPerHour[a];" "for (const a of ACTIVITIES) f[a] = hours[a] * vessel.fuelTPerHour.sailing;"
run_case ENGINE "fuel price per thousand tonnes" $E "fuelCost: fuelT.total * fuelPricePerT," "fuelCost: (fuelT.total * fuelPricePerT) / 1000,"
# capacity and the binding constraint
run_case ENGINE "usable deck fraction ignored" $E "capacity: vessel.deckAreaM2 * vessel.deckUsableFraction," "capacity: vessel.deckAreaM2,"
run_case ENGINE "deadweight without bulk" $E "deadweightT: deckWeightT + sum(products.map((p) => bulkM3[p.id] * p.densityTPerM3))," "deadweightT: deckWeightT,"
run_case ENGINE "bulk m3 counted as tonnes" $E "bulkM3[p.id] * p.densityTPerM3" "bulkM3[p.id]"
run_case ENGINE "binding tie goes to the last" $E "for (const r of rows) if (key12(r.utilisation) > key12(best.utilisation)) best = r;" "for (const r of rows) if (key12(r.utilisation) >= key12(best.utilisation)) best = r;"
run_case ENGINE "load at capacity counted as overloaded" $E "const over = rows.filter((r) => key12(r.load) > key12(r.capacity));" "const over = rows.filter((r) => key12(r.load) >= key12(r.capacity));"
run_case ENGINE "zero tank accepted" $E "if (c.capacity === 0 && c.of(load) > 0) return refuse(" "if (false) return refuse("
# fleet sizing
run_case ENGINE "voyages rounded to nearest" $E "const roundVoyages = (x, rule) => (rule === 'up' ? ceil12(x) : x);" "const roundVoyages = (x, rule) => (rule === 'up' ? Math.round(x) : x);"
run_case ENGINE "counts rounded up without the 12-digit key" $E "const ceil12 = (x) => Math.ceil(key12(x));" "const ceil12 = (x) => Math.ceil(x);"
run_case ENGINE "minimum visits ignored" $E "const exact = byDemand ? r : s.minVisits;" "const exact = r;"
run_case ENGINE "demand equal to minimum visits named minimum visits" $E "const byDemand = key12(r) > 0 && key12(r) >= s.minVisits;" "const byDemand = key12(r) > 0 && key12(r) > s.minVisits;"
run_case ENGINE "nearest vessels halves down" $E "rule === 'nearest' ? Math.floor(key12(x) + 0.5)" "rule === 'nearest' ? Math.ceil(key12(x) - 0.5)"
run_case ENGINE "vessels over the period in place of available days" $E "const vesselsExact = vesselDays / vesselAvailableDays;" "const vesselsExact = vesselDays / a.periodDays;"
run_case ENGINE "shortfall never reported" $E "const shortVesselDays = key12(vesselDays) > key12(capacityDays) ? vesselDays - capacityDays : 0;" "const shortVesselDays = 0;"
run_case ENGINE "available days may exceed the period" $E "if (vesselAvailableDays > periodDays) return refuse(" "if (false) return refuse("
# shore base
run_case ENGINE "Erlang B recursion one step too far" $E "for (let k = 1; k <= c - 1; k += 1) b = (a * b) / (k + a * b);" "for (let k = 1; k <= c; k += 1) b = (a * b) / (k + a * b);"
run_case ENGINE "mean wait without 1 - rho" $E "const wqM = (piW * S) / (c * (1 - rho));" "const wqM = (piW * S) / c;"
run_case ENGINE "Cosmetatos correction dropped" $E "const wq = (wqM / 2) * (1 + ((1 - rho) * (c - 1) * (Math.sqrt(4 + 5 * c) - 2)) / (16 * rho * c));" "const wq = wqM / 2;"
run_case ENGINE "M/D/c answered as M/M/c" $E "if (model === 'M/M/c') return { rho, piW, wq: wqM };" "return { rho, piW, wq: wqM };"
run_case ENGINE "concurrent service summed" $E "(service.concurrent ? Math.max(liftHours, bulkHours) : liftHours + bulkHours)" "(liftHours + bulkHours)"
run_case ENGINE "working hours ignored (24-hour clock)" $E "const lambda = arrivalsPerDay / workingHoursPerDay;" "const lambda = arrivalsPerDay / 24;"
run_case ENGINE "utilisation 1 accepted as steady" $E "if (!(rho < 1)) {" "if (rho > 1) {"
run_case ENGINE "berth target strict" $E "if (key12(qc.wq) <= key12(targetMeanWaitHours))" "if (key12(qc.wq) < key12(targetMeanWaitHours))"
run_case ENGINE "printed bound not moved to the accepted side" $E "  while (!ok(k / 1e6)) k -= 1;" ""
# deck plan
run_case ENGINE "FFD sorts ascending" $E "list.sort((p, q) => (key12(q.areaM2) - key12(p.areaM2))" "list.sort((p, q) => (key12(p.areaM2) - key12(q.areaM2))"
run_case ENGINE "FFD tie lighter first" $E "|| (key12(q.weightT) - key12(p.weightT))" "|| (key12(p.weightT) - key12(q.weightT))"
run_case ENGINE "deck load ignored" $E " && key12(b.weightT + u.weightT) <= key12(deck.loadT));" ");"
run_case ENGINE "last fit in place of first fit" $E "const bin = bins.find((b) =>" "const bin = bins.slice().reverse().find((b) =>"
run_case ENGINE "deck fit exclusive" $E "key12(b.areaM2 + u.areaM2) <= key12(usable)" "key12(b.areaM2 + u.areaM2) < key12(usable)"
run_case ENGINE "usable deck fraction ignored in the deck plan" $E "const usable = deck.areaM2 * deck.usableFraction;" "const usable = deck.areaM2;"
# Monte Carlo
run_case ENGINE "draw order swapped" $E "const w = draw(wTri, rng);
    const f = draw(fTri, rng);" "const f = draw(fTri, rng);
    const w = draw(wTri, rng);"
run_case ENGINE "P90 and P10 swapped" $E "const pick = (s) => ({ mean: s.mean, p90: s.p90, p50: s.p50, p10: s.p10, min: s.min, max: s.max });" "const pick = (s) => ({ mean: s.mean, p90: s.p10, p50: s.p50, p10: s.p90, min: s.min, max: s.max });"
run_case ENGINE "seed ignored" $E "const rng = mulberry32(a.seed);" "const rng = mulberry32(1);"
run_case ENGINE "short at equality" $E "const short = key12(d) > key12(capacityDays);" "const short = key12(d) >= key12(capacityDays);"
run_case ENGINE "demand factor ignored" $E "    const r = f * s.maxRatio;
    const exact = key12(r) > 0" "    const r = s.maxRatio;
    const exact = key12(r) > 0"
run_case ENGINE "Monte Carlo ignores minimum visits" $E "? r : s.minVisits;
    vd +=" "? r : r;
    vd +="
run_case ENGINE "Monte Carlo weather on every activity" $E "const total = (ws ? c.sailing * w : c.sailing) + (wp ? c.port * w : c.port)" "const total = (c.sailing * w) + (c.port * w)"
run_case ENGINE "draws cap ignored" $E "if (a.iterations * nSets > DEFAULTS.MAX_DRAWS) {" "if (false) {"
# accepted keys and stated inputs
run_case ENGINE "unknown keys ignored" $E "const e = walkKeys(args, ACCEPTED_KEYS[name], '');" "const e = null;"
run_case ENGINE "unknown product ids ignored" $E "if (obj[k] !== undefined && !ids.includes(k)) return refuse(" "if (false) return refuse("
run_case ENGINE "a missing tank read as 0" $E "if (vessel.tanks[id] === undefined) return refuse(" "if (vessel.tanks[id] === undefined) vessel.tanks[id] = 0; if (false) return refuse("
run_case ENGINE "distance on a milk run silently ignored" $E "if (installations[i].distanceFromBaseNm !== undefined) return refuse(" "if (false) return refuse("
run_case ENGINE "weather cap 12" $E "MAX_WEATHER_FACTOR: 10," "MAX_WEATHER_FACTOR: 12,"
# messages are course content
run_case ENGINE "overflow reason reworded" $E "reason: \`\${u.unit} is overflow: \${reason}\`" "reason: \`\${u.unit} overflows: \${reason}\`"
run_case ENGINE "binding reason reworded" $E "const reasons = [\`the binding constraint is " "const reasons = [\`binding: "
run_case ENGINE "concurrent refusal drops 'there is no default'" $E "(one after the other); there is no default'" "(one after the other)'"
run_case ENGINE "unit agreement dropped" $E "const unitOf = (printed, x, one, many = \`\${one}s\`) => \`\${printed} \${x === 1 ? one : many}\`;" "const unitOf = (printed, x, one, many = \`\${one}s\`) => \`\${printed} \${many}\`;"
run_case ENGINE "requirement P-label reversal dropped from the basis" $E "for a requirement P90 is the LOW figure (10th percentile) and P10 the HIGH figure (90th percentile)" "P90 is the high figure"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle Erlang C sum to c" $O "s = sum((a ** n / math.factorial(n) for n in range(c)), F(0))" "s = sum((a ** n / math.factorial(n) for n in range(c + 1)), F(0))"
run_case ORACLE "oracle binding ties to the last" $O "            if r['utilisation'] > best['utilisation']:" "            if r['utilisation'] >= best['utilisation']:"
run_case ORACLE "oracle weather on every activity" $O "h = {a: (c[a] * w if a in applies else c[a]) for a in ACTS}" "h = {a: c[a] * w for a in ACTS}"
run_case ORACLE "oracle FFD ascending" $O "lst.sort(key=lambda u: u['area'], reverse=True)" "lst.sort(key=lambda u: u['area'])"
run_case ORACLE "oracle unknown keys ignored" $O "    e = check_keys(a, SHAPES[fn], '')" "    e = None"
run_case ORACLE "oracle M/D/1 without the half" $O "return None, rho * (S / 2) / (1 - rho)" "return None, rho * S / (1 - rho)"
run_case ORACLE "oracle P90 at the 90th percentile" $O "'p90': fl(at(1))" "'p90': fl(at(9))"
run_case ORACLE "oracle minimum visits ignored" $O "ex = r if by_demand else F(s['minVisits'])" "ex = r"

restore
echo "=== summary ==="
echo "engine plants red: $ENGINE_RED/$ENGINE_RUN"
echo "oracle plants caught: $ORACLE_CAUGHT/$ORACLE_RUN"
echo "skipped (target not unique): $SKIPPED"
