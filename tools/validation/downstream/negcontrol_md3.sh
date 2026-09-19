#!/usr/bin/env bash
# Negative controls for the MD3 gate (MD3-0).
#
# A gate is only evidence if it fails when the thing it guards is wrong. This
# script plants one defect at a time in the shipped engine, runs the MD3
# golden gates, and requires each plant to turn them red. It restores every
# file afterwards, whatever happens.
#
# Part 1 runs the gates against origin/main's UNREPAIRED engines.
# Part 2 plants single-line defects, including the defects MD3-0 repaired and
# edits to held constants that only the literal pins can catch.
#
#   tools/validation/downstream/negcontrol_md1.sh
set -u
cd "$(dirname "$0")/../../.."

FILES=(engines/downstream/terminalDepot.js engines/downstream/fuelPricing.js)
GATES="__tests__/downstream.supply.golden"
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
T=engines/downstream/terminalDepot.js
P=engines/downstream/fuelPricing.js
plant $T "  const opening = num(openingM3, NaN);" "  const opening = num(openingM3, 0);" "terminal: a missing opening stock is an empty tank again"
plant $T "      ? { volumeM3: 0, note: null }
      : { volumeM3: null, error:" "      ? { volumeM3: 0, note: null }
      : { volumeM3: pts[0].v, error: null, x:" "terminal: a dip below the table reads the first entry"
plant $T "  if (water.volumeM3 === null) {" "  if (false) {" "terminal: an unconvertible water cut counts as no water"
plant $T "  if (wmm > num(heightMm)) {" "  if (false) {" "terminal: water above the product dip accepted"
plant $T "  if (!(Number.isInteger(c) && c >= 1)) {" "  if (false) {" "terminal: 0 or fractional bays accepted"
plant $T "  const erlangC = erlangB / (1 - utilisation * (1 - erlangB));" "  const erlangC = erlangB;" "terminal: Erlang B reported as Erlang C"
plant $T "    queueLength: erlangC * (utilisation / (1 - utilisation))," "    queueLength: erlangC * utilisation," "terminal: queue length off Little's law"
plant $T "  const pumpable = tanks.reduce((s, t) => s + Math.max(0, num(t.stockM3, 0) - num(t.heelM3, 0)), 0);" "  const pumpable = Math.max(0, stock - heel);" "terminal: heel netted across the farm"
plant $T "  const lossTonnes = hasRho ? num(lossM3, 0) * rho / 1000 : null;" "  const lossTonnes = hasRho ? num(lossM3, 0) * rho / 1000 : 0;" "terminal: a loss with no density weighs nothing"
plant $T "  const vcf = Math.exp(-alpha * dT * (1 + 0.8 * alpha * dT));" "  const vcf = Math.exp(-alpha * dT * (1 + 0.8 * alpha * dT)) + 1e-9;" "terminal: the VCF form moved"
plant $P "        const cifTotal = running / (1 - sumRate);" "        const cifTotal = running;" "fuel: insurance on CIF charged on C&F"
plant $P "  const forward = (stage, basis) => (stage === 'freight' && (basis === CHARGE_BASIS.PERCENT_OF_CF || basis === CHARGE_BASIS.PERCENT_OF_CIF));" "  const forward = () => false;" "fuel: a percentage of an unformed base accepted"
plant $P "  if (invalid.length > 0) {
    return { error:" "  if (false) {
    return { error:" "fuel: invalid charges ignored"
plant $P "  const perLitre = outturn.litres > 0 ? running / outturn.litres : null;" "  const perLitre = outturn.litres > 0 ? running / q.litres * (1 + loss / 100) : null;" "fuel: ocean loss added instead of divided"
plant $P "  const orMissing = (v) => (blank(v) ? null : num(v, 0));" "  const orMissing = (v) => num(v, 0);" "fuel: a blank trucking cost is free"
plant $P "    { label: 'Driver', amount: orMissing(driverCostPerTrip), required: blank(driverCostPerTrip) }," "    { label: 'Driver', amount: orMissing(driverCostPerTrip), required: false }," "fuel: a blank driver cost not named"
plant $P "  const trucks = Math.ceil(tripsNeeded / trips);" "  const trucks = Math.round(tripsNeeded / trips);" "fuel: fleet rounded instead of ceiled"
plant $P "      amount = (a / 100) * running;" "      amount = (a / 100) * landed;" "fuel: VAT on landed instead of the running total"

echo
echo "planted: $total   survivors: $survivors"
[ "$survivors" -eq 0 ]
