#!/usr/bin/env bash
# Mapping T1 negative controls (2026-09-26) for __tests__/mapping.t1.test.js.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-t1.md about what the T1 suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records
# whether it went red.
#
#   ENGINE  plants go in one engine file alone. All must go RED.
#   ORACLE  plants go in an oracle alone, with its golden regenerated.
#           All must go RED or STOP (the oracle refused to write).
#
#   tools/validation/mapping/negcontrol_t1.sh [filter]
#
# It edits the working tree and restores it on exit: do not stage or commit
# while it runs. The last line reports N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
CL=lib/gridding/closure.js
TS=lib/gridding/tensionSpline.js
WT=engines/mapping/wellTie.js
GR=lib/gridding/gridding.js
OC=tools/validation/mapping/oracle_closure.py
OT=tools/validation/mapping/oracle_tension.py
OW=tools/validation/mapping/oracle_welltie.py
GOLD=test-data/mapping/goldens
TEST=__tests__/mapping.t1.test.js
FILES="$CL $TS $WT $GR $OC $OT $OW $GOLD/closure_cases.json $GOLD/tension_cases.json $GOLD/welltie_cases.json"
TMP=$(mktemp -d)
for f in $FILES; do mkdir -p "$TMP/$(dirname "$f")"; cp "$f" "$TMP/$f"; done
restore() { for f in $FILES; do cp "$TMP/$f" "$f"; done; }
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

ENGINE_RUN=0; ENGINE_RED=0; ORACLE_RUN=0; ORACLE_CAUGHT=0

run_case() { # kind name file from to
  kind=$1; name=$2; file=$3; from=$4; to=$5
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  plant "$file" "$from" "$to" || { echo "SKIP  $name (target)"; return; }
  if [ "$kind" = ORACLE ]; then
    ORACLE_RUN=$((ORACLE_RUN + 1))
    if ! "$PY" "$file" >/dev/null 2>&1; then
      echo "STOP  [$kind] $name -- the oracle refused to write a golden"
      ORACLE_CAUGHT=$((ORACLE_CAUGHT + 1)); return
    fi
  else
    ENGINE_RUN=$((ENGINE_RUN + 1))
  fi
  out=$(timeout 600 npx jest "$TEST" 2>&1); rc=$?
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

echo "=== baseline ==="
restore
npx jest "$TEST" 2>&1 | grep -E "^Tests:"

echo "=== ENGINE plants: closure (all must be RED) ==="
run_case ENGINE "closure: open flag never set" $CL "      if (isBoundaryNode(z, spec, i)) open = true;" "      if (false) open = true;"
run_case ENGINE "closure: GRV without subtracting the contact" $CL "      sum += z[i] - contact;" "      sum += z[i];"
run_case ENGINE "closure: nodes AT the contact included" $CL "        if (label[j] === -1 && !isNull(z[j]) && z[j] > contact) { label[j] = id; stack.push(j); }" "        if (label[j] === -1 && !isNull(z[j]) && z[j] >= contact) { label[j] = id; stack.push(j); }"
run_case ENGINE "closure: no east neighbour" $CL "  if (c < nx - 1) out.push(i + 1);" "  if (false) out.push(i + 1);"
run_case ENGINE "spill: edge limit by node identity only" $CL "  const limitedByEdge = z[exit] <= runMin;" "  const limitedByEdge = z[exit] < runMin;"
run_case ENGINE "spill: the spill-level climb closed as a merge" $CL "    if (z[i] < runMin) { closeEvent(); runMin = z[i]; climbMax = -Infinity; climbSaddle = -1; }" "    if (z[i] < runMin) { closeEvent(); runMin = z[i]; climbMax = -Infinity; climbSaddle = -1; }
    if (isBoundaryNode(z, spec, i)) closeEvent();"
run_case ENGINE "spill: relief threshold ignored" $CL "    if (climbSaddle >= 0 && climbMax - runMin >= minRelief) {" "    if (climbSaddle >= 0) {"
run_case ENGINE "spill: saddle = climb node, not its pusher" $CL "      if (climbSaddle < 0) climbSaddle = from[i];" "      if (climbSaddle < 0) climbSaddle = i;"
run_case ENGINE "closureAt: prefix includes the contact node" $CL "    if (runMin[mid] <= contact) hi = mid; else lo = mid + 1;" "    if (runMin[mid] < contact) hi = mid; else lo = mid + 1;"
run_case ENGINE "closureAt: GRV sign flipped" $CL "    grvM3: nodes ? (sumZ - contact * nodes) * A : 0," "    grvM3: nodes ? (contact * nodes - sumZ) * A : 0,"
run_case ENGINE "closureAt: closed strictly above the spill" $CL "    closed: contact >= spill.spillZ," "    closed: contact > spill.spillZ + 1,"

echo "=== ENGINE plants: spline in tension ==="
run_case ENGINE "tension: p without the (1 - T)" $TS "  return tension / (1 - tension) / spacing;" "  return tension / spacing;"
run_case ENGINE "tension: smoothing sign not flipped" $TS "    A[i * m + i] += p > 0 ? -smoothing : smoothing;" "    A[i * m + i] += smoothing;"
run_case ENGINE "tension: series factorial as k not k^2" $TS "    term *= q / (k * k);" "    term *= q / k;"
run_case ENGINE "tension: harmonic numbers off by one" $TS "    H += 1 / k;" "    H += 1 / (k + 1);"
run_case ENGINE "tension: g(0) without the Euler constant" $TS "  let sum = Math.log(2) - EULER_GAMMA;" "  let sum = Math.log(2);"
run_case ENGINE "tension: large-x branch drops ln x" $TS "  return besselK0(x) + Math.log(x);" "  return besselK0(x);"
run_case ENGINE "tension: mean spacing instead of median" $TS "  return d[Math.floor(d.length / 2)];" "  return d.reduce((a, b) => a + b, 0) / d.length;"
run_case ENGINE "tension: affine x column unscaled" $TS "    A[i * m + n] = 1; A[i * m + n + 1] = xi / L; A[i * m + n + 2] = yi / L;" "    A[i * m + n] = 1; A[i * m + n + 1] = xi; A[i * m + n + 2] = yi / L;"
run_case ENGINE "tension: table read without interpolation" $TS "        s += w[i] * (tab[k] + (f - k) * (tab[k + 1] - tab[k]));" "        s += w[i] * tab[k];"
run_case ENGINE "tension: hull mask ignored" $TS "      if (hull && !insideHull(hull, q.x, q.y)) continue;" "      if (false) continue;"

echo "=== ENGINE plants: well tie ==="
run_case ENGINE "tie: one-way time used as two-way" $WT "vavg: w.depthM / (t / 2000)" "vavg: w.depthM / (t / 1000)"
run_case ENGINE "tie: depth positive (no elevation sign)" $WT "    out[i] = isNull(t) || isNull(v) || !(v > 0) ? NULL_VALUE : -(v * t) / 2000;" "    out[i] = isNull(t) || isNull(v) || !(v > 0) ? NULL_VALUE : (v * t) / 2000;"
run_case ENGINE "tie: residual sign flipped" $WT "residualM: isNull(m) ? null : wellZ - m" "residualM: isNull(m) ? null : m - wellZ"
run_case ENGINE "tie: well elevation positive" $WT "    const wellZ = -w.depthM;" "    const wellZ = w.depthM;"
run_case ENGINE "tie: RMS without the square root" $WT "  const rms = Math.sqrt(r.reduce((a, b) => a + b * b, 0) / r.length);" "  const rms = r.reduce((a, b) => a + b * b, 0) / r.length;"

echo "=== ENGINE plants: merge and mask ==="
run_case ENGINE "merge: strict distance" $GR "          if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) <= tol) unite(i, j);" "          if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < tol) unite(i, j);"
run_case ENGINE "merge: first value kept, not the mean" $GR "    const m = { x: sx / idx.length, y: sy / idx.length, z: sz / idx.length };" "    const m = { x: sx / idx.length, y: sy / idx.length, z: points[idx[0]].z };"
run_case ENGINE "merge: spread not reported" $GR "    merged.push({ wells, n: idx.length, ...m, spreadZ: zmax - zmin });" "    merged.push({ wells, n: idx.length, ...m, spreadZ: 0 });"
run_case ENGINE "mask: hull applied even with mask none" $GR "      if (mask === 'hull' && !insideHull(hull, x, y)) continue;" "      if (!insideHull(hull, x, y)) continue;"

echo "=== ORACLE plants (RED or STOP) ==="
run_case ORACLE "oracle closure: GRV without the contact" $OC "            tot += z[i] - contact" "            tot += z[i]"
run_case ORACLE "oracle closure: open never set" $OC "            if boundary(z, nx, ny, i):
                op = True" "            if False:
                op = True"
run_case ORACLE "oracle tension: p without (1 - T)" $OT "    p = T / (1 - T) / L if T > 0 else 0.0" "    p = T / L if T > 0 else 0.0"
run_case ORACLE "oracle tension: smoothing sign +" $OT "        sign = -1.0" "        sign = 1.0"
run_case ORACLE "oracle welltie: one-way as two-way" $OW "        v = w[\"depthM\"] / (t / 2000.0)" "        v = w[\"depthM\"] / (t / 1000.0)"

restore
echo "=== restored; verifying clean ==="
npx jest "$TEST" 2>&1 | grep -E "^Tests:"
echo "ORACLE plants caught: $ORACLE_CAUGHT/$ORACLE_RUN"
echo "ENGINE plants red: $ENGINE_RED/$ENGINE_RUN"
