#!/usr/bin/env bash
# Negative controls for the MD1 gate (MD1-0).
#
# A gate is only evidence if it fails when the thing it guards is wrong. This
# script plants one defect at a time in the shipped engine, runs the three MD1
# golden gates, and requires each plant to turn them red. It restores every
# file afterwards, whatever happens.
#
# Part 1 runs the gates against origin/main's UNREPAIRED engines.
# Part 2 plants single-line defects, including the defects MD1-0 repaired and
# edits to held constants that only the literal pins can catch.
#
#   tools/validation/downstream/negcontrol_md1.sh
set -u
cd "$(dirname "$0")/../../.."

FILES=(lib/lp/simplex.js engines/downstream/productBlending.js engines/downstream/crudeAssay.js)
GATES="__tests__/lp.simplex.golden __tests__/downstream.productBlending.golden __tests__/downstream.crudeAssay.golden"
BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do cp "$f" "$BACKUP/$(basename "$f")"; done
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$f"; done; }
trap restore EXIT

gate_red() { ! npx jest $GATES --silent >/dev/null 2>&1; }

survivors=0
total=0

echo "== part 1: the gates against origin/main's unrepaired engines"
for f in "${FILES[@]}"; do git show "origin/main:$f" > "$f"; done
if gate_red; then echo "   RED, as it must be"; else echo "   GREEN: the gate cannot see the repaired defects"; survivors=$((survivors + 1)); fi
restore

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

echo "== part 2: planted defects"
S=lib/lp/simplex.js
P=engines/downstream/productBlending.js
C=engines/downstream/crudeAssay.js
plant $S "* (meta.flipped ? -1 : 1)" "" "LP: forget the dual sign of a negated row"
plant $S "  driveOutArtificials(tableau, basis, artificialCols, total);" "" "LP: leave zero-level artificials in the basis"
plant $S "const sign = meta.op === '>=' ? -1 : 1;" "const sign = 1;" "LP: price a >= row with the <= sign"
plant $S "if (artificialTotal > 1e-7) {" "if (artificialTotal > 1e-1) {" "LP: accept a phase-one residual as feasible"
plant $S "if (a <= EPS) continue;" "if (a < -EPS) continue;" "LP: let the ratio test pivot on a zero entry"
plant $P "    return v;
  });
  if (badBounds.length > 0) {" "    return v > 0 ? v : Infinity;
  });
  if (badBounds.length > 0) {" "blend: a typed zero maximum becomes unlimited again"
plant $P "const unpriced = components.filter((c) => !Number.isFinite(num(c.cost))).map(label);" "const unpriced = [];" "blend: a blank cost is free again"
plant $P "const cost = components.map((c) => num(c.cost));" "const cost = components.map((c) => num(c.cost, 0) * 1.0001);" "blend: a cost read slightly wrong"
plant $P "const reliefValue = dCostdLimit === null ? null : (meta.bound === 'max' ? -dCostdLimit : dCostdLimit);" "const reliefValue = rowPrice;" "blend: hand back the row dual as the price of relief"
plant $P "rowPrice * scale * indexSlope" "rowPrice * scale" "blend: forget the index slope on an index spec"
plant $P "export const RVP_INDEX_EXPONENT = 1.25;" "export const RVP_INDEX_EXPONENT = 1.3;" "blend: move the held RVP exponent"
plant $P "const denominators = components.map((c) => (needsDensity(spec) ? specificGravity(c) : 1));" "const denominators = components.map(() => 1);" "blend: blend a mass property on volume"
plant $P "if (needsDensity(spec) && components.some((c) => specificGravity(c) === null)) {" "if (false) {" "blend: impose a mass spec on a stream with no density"
plant $P "export const BINDING_TOLERANCE = 1e-7;" "export const BINDING_TOLERANCE = 1e-12;" "blend: an absolute-scale binding test"
plant $C "if (t > last.t) return last.v === 100 ? 100 : null;" "if (t > last.t) return last.v;" "crude: clamp the curve flat above its last point"
plant $C "if (t < first.t) return first.v === 0 ? 0 : null;" "if (t < first.t) return first.v;" "crude: extrapolate below the first point as the app did"
plant $C "if (without.length > 0) { missing[key] = without; return null; }" "" "crude: read a blank property as zero again"
plant $C "const stable = cii < CII_BANDS.STABLE ? true : cii < CII_BANDS.UNSTABLE ? null : false;" "const stable = cii < CII_BANDS.STABLE;" "crude: call the uncertain band unstable"
plant $C "export const CII_BANDS = { STABLE: 0.7, UNSTABLE: 0.9 };" "export const CII_BANDS = { STABLE: 0.75, UNSTABLE: 0.9 };" "crude: move a held CII band"
plant $C "return 14.534 * Math.log(inner) + 10.975;" "return 14.534 * Math.log(inner) + 10.9;" "crude: move a held Refutas constant"
plant $C "const tbR = num(meanBoilingPointF) + 459.67;" "const tbR = num(meanBoilingPointF) + 460;" "crude: Rankine offset rounded"
plant $C "const f = (target - pts[i - 1].v) / (pts[i].v - pts[i - 1].v);" "const f = 1;" "crude: T50 taken at the next grid point, as the app did"
plant $C "const afterLosses = grossValue * (1 - loss / 100);" "const afterLosses = grossValue;" "crude: drop the losses from the netback"
plant $C "const massRaw = volume.map((v, i) => v * sgs[i]);" "const massRaw = volume.map((v) => v);" "crude: mass fractions taken as volume fractions"

plant $C "    complete: unpriced.length === 0 && unyielded.length === 0," "    complete: unpriced.length === 0," "crude: a netback with an unyielded cut reads complete again (MD1-1)"
plant $P "    if (!Number.isFinite(value)) { if (volumes[i] > 0) unknown = true; return; }
    weighted += volumes[i] * value;" "    if (!Number.isFinite(value)) return;
    weighted += volumes[i] * value;" "blend: a volume property with a missing stream prints a value again (MD1-1)"
plant $C "  const sparse = components.some((c) => c.sara);" "  const sparse = false;" "crude: SARA on some crudes reported as none (MD1-1)"

echo
echo "planted: $total   survivors: $survivors"
[ "$survivors" -eq 0 ]
