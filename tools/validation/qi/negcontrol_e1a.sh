#!/usr/bin/env bash
# Negative controls for the E1a gate (QI course extraction gate, G1 + G2).
#
# A gate is only evidence if it fails when the thing it guards is wrong. This
# script (1) regenerates the goldens into a temp dir and requires them to be
# byte-identical to the committed ones, then (2) plants one defect at a time
# in the shipped engines, runs the E1a golden gate, and requires each plant
# to turn it red. Every file is restored afterwards, whatever happens.
#
#   tools/validation/qi/negcontrol_e1a.sh
set -u
cd "$(dirname "$0")/../../.."

FILES=(engines/qi/prestack.js engines/qi/prestackQc.js)
GATES="__tests__/qi.prestack.golden __tests__/qi.prestackQc.golden"
BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do cp "$f" "$BACKUP/$(basename "$f")"; done
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$f"; done; }
trap 'restore; rm -rf "$BACKUP"' EXIT

survivors=0
total=0

echo "== part 1: byte-identical regeneration"
REGEN=$(mktemp -d)
python3 tools/validation/qi/oracle_qi_prestack.py "$REGEN" >/dev/null || { echo "   the oracle failed its anchors"; exit 1; }
for g in goldens.prestack.json goldens.prestackQc.json; do
  if cmp -s "$REGEN/$g" "test-data/qi/$g"; then echo "   identical $g"; else echo "   DIFFERS   $g"; survivors=$((survivors + 1)); fi
done
rm -rf "$REGEN"

echo "== part 2: the gate is green on the shipped engines"
if ! npx jest $GATES --silent >/dev/null 2>&1; then echo "   RED on the shipped engines: fix the gate first"; exit 1; fi
echo "   green"

gate_red() { ! npx jest $GATES --silent >/dev/null 2>&1; }

plant() {
  local file="$1" from="$2" to="$3" label="$4"
  total=$((total + 1))
  if ! grep -qF -- "$from" "$file"; then
    echo "   [missing anchor] $label"; survivors=$((survivors + 1)); return
  fi
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
open(p, 'w').write(s.replace(a, b, 1))
PY
  if gate_red; then echo "   caught    $label"; else echo "   SURVIVED  $label"; survivors=$((survivors + 1)); fi
  restore
}

echo "== part 3: planted defects"
P=engines/qi/prestack.js
Q=engines/qi/prestackQc.js
plant $P "  out[0] = vrms[0];" "  out[0] = vrms[1];" "dix: the first interval is not the first RMS"
plant $P "out[i] = Math.sqrt(num / dt);" "out[i] = Math.sqrt(num / t0[i]);" "dix: divided by the time, not the interval"
plant $P "const dt = (2 * l.thicknessM) / l.v;" "const dt = l.thicknessM / l.v;" "layered RMS: one-way time"
plant $P "return Math.asin(((lo + hi) / 2) * layers[target].v) * DEG;" "return Math.asin(((lo + hi) / 2) * vmax) * DEG;" "ray trace: the angle in the fastest layer"
plant $P "const xOf = (p) => 2 * above.reduce(" "const xOf = (p) => 1 * above.reduce(" "ray trace: one leg of the ray"
plant $P "const s = ((vint / vrms) * offsetM) / Math.sqrt" "const s = (offsetM) / Math.sqrt" "walden: the Vint / Vrms factor dropped"
plant $P "Math.sqrt(offsetM * offsetM + (vrms * t0S) ** 2);" "Math.sqrt(offsetM * offsetM + (vint * t0S) ** 2);" "walden: the straight ray at Vint"
plant $P "Math.floor(o / widthM)" "Math.round(o / widthM)" "bins: rounded to the nearest bin"
plant $P "const a = waldenAngle(x, (t0Ms + i * dtMs) / 1000, vrms[i], vint[i]);" "const a = waldenAngle(x, (i * dtMs) / 1000, vrms[i], vint[i]);" "angle gather: the first-sample time ignored"
plant $P "for (let k = from; k < to; k++) if (fold[k][i] > 0)" "for (let k = from; k <= to; k++) if (fold[k] && fold[k][i] > 0)" "partial stack: the end bin included"
plant $P "if (fold[k][i] > 0) { s += gather[k][i] * fold[k][i]; n += fold[k][i]; }" "if (fold[k][i] > 0) { s += gather[k][i]; n += 1; }" "partial stack: bins averaged without their fold"
plant $P "return last >= 0 ? edges[last + 1] : NaN;" "return last >= 0 ? edges[last] : NaN;" "usable angle: the near edge of the last bin"
plant $P "if (fold[k][i] >= minFold) last = k; else break;" "if (fold[k][i] >= minFold) last = k;" "usable angle: a gap in coverage skipped over"
plant $P "    outI[k] = segV[j + 1];" "    outI[k] = segV[j];" "velocity grid: the interval velocity of the segment above"
plant $P "while (j < tMs.length - 1 && tMs[j + 1] < t) j++;" "while (j < tMs.length - 1 && tMs[j + 1] <= t) j++;" "velocity grid: a sample on a node read from the segment below"
plant $Q "return Math.sqrt(t0S * t0S + (offsetM * offsetM) / (v * v)) / t0S - 1;" "return Math.sqrt(t0S * t0S + (offsetM * offsetM) / (v * v)) / t0S - 1.000000001;" "stretch: a constant moved in the ninth figure"
plant $Q "return v * t0S * Math.sqrt((1 + maxStretch) ** 2 - 1);" "return v * t0S * Math.sqrt((1 + maxStretch) - 1);" "mute: the stretch not squared"
plant $Q "if (fin(c) && Math.abs(c) > bv) { bv = Math.abs(c); best = lag; }" "if (fin(c) && c > bv) { bv = c; best = lag; }" "rmo: the signed correlation peak again"
plant $Q "if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)); }
  return { lag: best + off, corr: peak };" "if (den < 0) off = 0; }
  return { lag: best + off, corr: peak };" "rmo: whole-sample lags only"
plant $Q "if (Math.sqrt(se / sw) > dtMs) a = NaN;" "if (Math.sqrt(se / sw) > 100 * dtMs) a = NaN;" "rmo: scattered lags trusted as timing"
plant $Q "const v = sampleAt(tr[k], i + (a * xs[k] * xs[k]) / dtMs);" "const v = sampleAt(tr[k], i - (a * xs[k] * xs[k]) / dtMs);" "rmo: AB semblance flattens with the wrong sign"
plant $Q "return { lagsMs, curvature: a, rmoFarMs: a * far * far," "return { lagsMs, curvature: a, rmoFarMs: a * far," "rmo: the residual at the far offset not squared"
plant $Q "for (let b = 0; b < fold.length; b++) if (fold[b] >= minFold) far = centres[b];" "for (let b = 0; b < fold.length; b++) if (fold[b] > minFold) far = centres[b];" "fold: the minimum fold excluded"

echo
echo "planted: $total   survivors: $survivors"
[ "$survivors" -eq 0 ]
