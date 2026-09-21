#!/usr/bin/env bash
# Negative controls for the MD2 gate (MD2-0).
#
# A gate is only evidence if it fails when the thing it guards is wrong. This
# script plants one defect at a time in the shipped engine, runs the MD2
# golden gates, and requires each plant to turn them red. It restores every
# file afterwards, whatever happens.
#
# Part 1 runs the gates against origin/main's UNREPAIRED engines.
# Part 2 plants single-line defects, including the defects MD2-0 repaired and
# edits to held constants that only the literal pins can catch.
#
#   tools/validation/downstream/negcontrol_md1.sh
set -u
cd "$(dirname "$0")/../../.."

FILES=(engines/downstream/refineryPlanning.js engines/downstream/streamModel.js engines/downstream/modularRefinery.js engines/economics/screening.js)
GATES="__tests__/downstream.refinery.golden"
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
R=engines/downstream/refineryPlanning.js
S=engines/downstream/streamModel.js
M=engines/downstream/modularRefinery.js
E=engines/economics/screening.js
plant $R "  if (crudeUnits.length > 0) {" "  if (false) {" "plan: crude no longer passes through the crude unit"
plant $R "    if (!given(v)) return Infinity;
    const x = Number(v);" "    if (!given(v)) return Infinity;
    const x = Number(v) || Infinity;" "plan: a typed zero limit is unlimited again"
plant $R "  if (missing.length > 0) {
    return { status: 'invalid'" "  if (false) {
    return { status: 'invalid'" "plan: a blank price or cost goes through again"
plant $R "      marginalValue: lp.shadowPrices ? -lp.shadowPrices[k] : null," "      marginalValue: lp.shadowPrices ? lp.shadowPrices[k] : null," "plan: stream value with the sign reversed"
plant $R "  const dayAt = (d) => new Date(startUtc + d * 86400000).toISOString().split('T')[0];" "  const dayAt = (d) => { const t = new Date(start); t.setDate(t.getDate() + d); return t.toISOString().split('T')[0]; };" "schedule: local calendar arithmetic again"
plant $S "    const sign = direction === 'revenue' ? 1 : -1;" "    const sign = 1;" "variance: a cost gap counted as a margin gain"
plant $S "    const k = signed ? (l.direction === 'revenue' ? 1 : -1) : 1;" "    const k = 1;" "variance: totals add revenue and cost gaps together"
plant $S "      unexplained: totalVariance - volumeVariance - priceVariance," "      unexplained: 0," "variance: money with no quantity hidden"
plant $M "      capex: build > 0 ? (producing ? 0 : num(capex) / build) : (y === 0 ? num(capex) : 0)," "      capex: producing ? 0 : (build > 0 ? num(capex) / build : 0)," "modular: capex vanishes with no construction period"
plant $M "    lossCarryForward: true," "    lossCarryForward: false," "modular: construction-year losses thrown away"
plant $M "    royaltyRate: 0," "    royaltyRate: 5," "modular: a royalty on a refinery"
plant $M "    price: { oil: ys.map((y) => (y.crudeBbl > 0 ? y.revenue / y.crudeBbl : 0)), gas: ys.map(() => 0) }," "    price: { oil: ys.map(() => 0), gas: ys.map(() => 0) }," "modular: revenue left out of the engine"
plant $M "  if (!(util >= 0 && util <= 1)) {" "  if (false) {" "modular: a utilisation typed as a percentage accepted"
plant $M "  MODULAR: 0.9," "  MODULAR: 0.85," "modular: move the held modular exponent"
plant $E "      npv += cf.ncf / Math.pow(1 + discountRate / 100, i + 0.5);" "      npv += cf.ncf / Math.pow(1 + discountRate / 100, i + 1);" "screening: end-year discounting"
plant $E "          lossPool = afterRelief < 0 ? -afterRelief : 0;" "          lossPool = 0;" "screening: the loss pool forgets"

plant $S "    else if (e.type === EVENT_TYPE.DELIVERY) revenue += e.cost;" "" "ledger totals: sales summed into cost again (MD2-1)"
plant $M "  const t = given(taxRate) ? Number(taxRate) : NaN;" "  const t = Number(taxRate);" "modular: a blank tax rate is 0 again (MD2-1)"
plant $M "  const build = Math.max(0, Math.round(num(constructionYears, 2)));" "  const build = Math.max(0, Math.round(num(constructionYears, 0)));" "modular: a blank construction period is 0 again (MD2-1)"

echo
echo "planted: $total   survivors: $survivors"
[ "$survivors" -eq 0 ]
