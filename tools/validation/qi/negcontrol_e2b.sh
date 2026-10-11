#!/usr/bin/env bash
# Negative controls for the E2-B golden gates (QI course gate E2, 2026-10-11):
# engines/qi/propertyCalibration.js and engines/qi/prospectTrap.js.
#
# A gate is only evidence if it fails when the thing it guards is wrong. This
# script plants one defect at a time in a shipped engine, runs that engine's
# golden gate, and requires each plant to turn it red. It restores every file
# afterwards, whatever happens. Part 1 regenerates both goldens into a temp
# copy and requires them byte-identical to the committed files.
#
#   tools/validation/qi/negcontrol_e2b.sh
set -u
cd "$(dirname "$0")/../../.."

P=engines/qi/propertyCalibration.js
T=engines/qi/prospectTrap.js
FILES=("$P" "$T")
BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do cp "$f" "$BACKUP/$(basename "$f")"; done
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$f"; done; }
cleanup() { restore; [ -n "${REGEN:-}" ] && rm -rf "$REGEN"; }
trap cleanup EXIT

survivors=0
total=0

echo "== part 1: the oracles regenerate the goldens byte for byte"
REGEN=$(mktemp -d)
mkdir -p "$REGEN/tools/validation/qi" "$REGEN/test-data/qi"
for o in oracle_qi_property_calibration oracle_qi_prospect_trap; do cp "tools/validation/qi/$o.py" "$REGEN/tools/validation/qi/"; done
python3 "$REGEN/tools/validation/qi/oracle_qi_property_calibration.py" >/dev/null && python3 "$REGEN/tools/validation/qi/oracle_qi_prospect_trap.py" >/dev/null || { echo "   an oracle failed its own anchors"; exit 1; }
for g in goldens.propertyCalibration.json goldens.prospectTrap.json; do
  if cmp -s "$REGEN/test-data/qi/$g" "test-data/qi/$g"; then echo "   identical  $g"; else echo "   DIFFERS    $g"; survivors=$((survivors + 1)); fi
done

gate_red() {
  local gate=__tests__/qi.prospectTrap.golden
  [ "$1" = "$P" ] && gate=__tests__/qi.propertyCalibration.golden
  ! npx jest "$gate" --silent --testTimeout=300000 >/dev/null 2>&1
}

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
  if gate_red "$file"; then echo "   caught    $label"; else echo "   SURVIVED  $label"; survivors=$((survivors + 1)); fi
  restore
}

echo "== part 2: planted defects, property calibration"
plant $P "for (const [c, n] of count) if (n > bn) { best = c; bn = n; }" "for (const [c, n] of count) if (n >= bn) { best = c; bn = n; }" "mode filter: a tie leaves the centre code"
plant $P "(k * dtMs >= w[0] && k * dtMs <= w[1])" "(k * dtMs >= w[0] && k * dtMs < w[1])" "window: the end sample left out"
plant $P "const half = halfWindowFor(pr.upscaleHz ?? PROPERTY_DEFAULTS.upscaleHz, dtMs);" "const half = halfWindowFor(pr.upscaleHz ?? PROPERTY_DEFAULTS.upscaleHz, dtMs) - 1;" "upscale: the window one sample short (half-even rounding)"
plant $P "const ts = (atMean.hi - atMean.y) / Math.sqrt(1 + 1 / model.n);" "const ts = (atMean.hi - atMean.y);" "band: t s taken with the 1 + 1/n factor still in"
plant $P "? (t * model.sExtra) ** 2 : 0;" "? model.sExtra ** 2 : 0;" "band: the inversion error added without the t factor"
plant $P "(1 + 1 / model.n + (ai[k] - model.xMean) ** 2 / model.sxx)" "(1 + 1 / model.n)" "band: the leverage term dropped"
plant $P "return n >= 5 ? Math.sqrt(se / n) : NaN;" "return n >= 5 ? Math.sqrt(se / (n - 1)) : NaN;" "pooled RMS on n - 1"
plant $P "if (j === skip) return;" "if (j === skip && false) return;" "left-out check: the well's own residuals widen its band"
plant $P "rms > s ? Math.sqrt(rms * rms - s * s) : 0" "rms > s ? rms : 0" "widening: the RMS added whole, not in quadrature"
plant $P "if (y >= pred[0][i] && y <= pred[2][i]) inside += 1;" "if (y >= pred[0][i] && y <= pred[1][i]) inside += 1;" "coverage: counted to the median only"
plant $P "sr += q - y;" "sr += y - q;" "bias: sign flipped"
plant $P "const model = { ...all, sExtra: extraFor(sLoo, all.s) };" "const model = { ...all, sExtra: 0 };" "the volume model loses the widening (the pre-#987 band)"
plant $P "const TABLE_POINTS = 4001;" "const TABLE_POINTS = 401;" "posterior table ten times coarser"
plant $P "lo = Math.min(lo, c.mean[0] - 6 * sd); hi = Math.max(hi, c.mean[0] + 6 * sd);" "lo = Math.min(lo, c.mean[0] - 3 * sd); hi = Math.max(hi, c.mean[0] + 3 * sd);" "posterior table range 3 sd"
plant $P "const TABLE_2D = 201;" "const TABLE_2D = 101;" "2D posterior table coarser"
plant $P "const priors = pr.priors === 'equal'" "const priors = pr.priors === 'equals'" "equal priors ignored"
plant $P "if (p > probs[b]) b = j;" "if (p < probs[b]) b = j;" "facies: the least likely code"

echo "== part 3: planted defects, prospect trap"
plant $T "      if (isNull(depth.grid[i])) continue;
      const p = depth.nodeXY(r, c);
      const d =" "      const p = depth.nodeXY(r, c);
      const d =" "nearest node may be a null node"
plant $T "if (!isNull(z[j]) && z[j] > z[next]) next = j;" "if (!isNull(z[j]) && z[j] > z[i]) next = j;" "climb: the last higher neighbour, not the highest"
plant $T "seed = climbToCrest(z, spec, n);" "seed = n;" "no climb: the picked node is the crest"
plant $T "(sense === 'low' ? v <= threshold : v >= threshold)" "(sense === 'low' ? v >= threshold : v <= threshold)" "anomaly sense swapped"
plant $T "for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {" "for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c + 1]]) {" "patches: the westward neighbour lost"
plant $T "if (touches) for (const i of comp) out[i] = 1;" "for (const i of comp) out[i] = 1;" "patches off the structure kept"
plant $T "const depthOf = (zElev) => -zElev;" "const depthOf = (zElev) => zElev;" "elevation reported as depth"
plant $T "const atSpill = closureAt(spill, spec, spill.spillZ);" "const atSpill = closureAt(spill, spec, spill.spillZ + 1);" "closure taken 1 m above the spill"
plant $T "for (let k = 0; k < atSpill.nodes; k++) inClosure" "for (let k = 0; k < spill.order.length; k++) inClosure" "closure mask is the whole flood, past the spill"
plant $T "areaKm2: atSpill.areaM2 / 1e6," "areaKm2: atSpill.areaM2 / 1e5," "area in the wrong unit"
plant $T "merges: spill.merges.length," "merges: 0," "merges dropped"
plant $T "Math.max(c.impliedContactZ, spill.spillZ) : NaN;" "c.impliedContactZ : NaN;" "contact not held at the spill"
plant $T "c.impliedVsSpillM < 0 ? -c.impliedVsSpillM : 0," "c.impliedVsSpillM < 0 ? c.impliedVsSpillM : 0," "edge below spill sign flipped"
plant $T "const filledToSpill = !(anomaly && anomaly.impliedAboveSpillM > 0);" "const filledToSpill = false;" "edge rule never holds a filled trap at investigate"

echo
echo "planted: $total   survivors: $survivors"
[ "$survivors" -eq 0 ]
