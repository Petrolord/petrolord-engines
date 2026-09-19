#!/usr/bin/env bash
# Negative controls for the MD4 gate (MD4-0).
#
# A gate is only evidence if it fails when the thing it guards is wrong. This
# script plants one defect at a time in the shipped engines, runs the MD4
# golden gate, and requires each plant to turn it red. It restores every
# file afterwards, whatever happens.
#
# Part 1 runs the gate against the engines before MD4-0 (5c0cb97) and before
# MD45-1 (f0aef14). Both are pinned: origin/main moves once a repair merges,
# and a part 1 read from it would go green on the repaired engines.
# Part 2 plants single-line defects: logic flips, the defects MD4-0 repaired,
# blanks read as 0 or as a default again, and small constant moves that only
# a tight tolerance catches.
#
#   tools/validation/downstream/negcontrol_md4.sh
set -u
cd "$(dirname "$0")/../../.."

FILES=(engines/downstream/flareToValue.js engines/downstream/lpgCng.js)
GATES="__tests__/downstream.gasvalue.golden"
BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do cp "$f" "$BACKUP/$(basename "$f")"; done
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$f"; done; }
trap restore EXIT

gate_red() { ! npx jest $GATES --silent >/dev/null 2>&1; }

survivors=0
total=0

for base in 5c0cb97 f0aef14; do
  echo "== part 1: the gate against the unrepaired engines at $base"
  for f in "${FILES[@]}"; do git show "$base:$f" > "$f"; done
  if gate_red; then echo "   RED, as it must be"; else echo "   GREEN: the gate cannot see the repaired defects"; survivors=$((survivors + 1)); fi
  restore
done

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
F=engines/downstream/flareToValue.js
L=engines/downstream/lpgCng.js
plant $F "tonnesFrom(lbmolPerYear * (etaC * hcCarbon + yCo2), FLARE_MOLAR_MASS.CO2)" "tonnesFrom(lbmolPerYear * etaC * (hcCarbon + yCo2), FLARE_MOLAR_MASS.CO2)" "flare: the gas's CO2 burned with the fuel again"
plant $F "tonnesFrom(lbmolPerYear * yCh4 * (1 - eta), FLARE_MOLAR_MASS.CH4)" "tonnesFrom(lbmolPerYear * gas.carbonPerMol * (1 - eta), FLARE_MOLAR_MASS.CH4)" "flare: every unburned carbon counted as methane again"
plant $F "flareCo2e * rec;" "flareCo2e;" "flare: the whole flare credited to a partial recovery"
plant $F ".filter((r) => !r.inert && r.code !== 'CO2')" ".filter(() => true)" "flare: hydrocarbon carbon includes the inerts"
plant $F "export const FLARE_MOLAR_MASS = Object.freeze({ CO2: 44.009," "export const FLARE_MOLAR_MASS = Object.freeze({ CO2: 44.0095," "flare: CO2 molar mass moved in the fifth figure"
plant $F "if (ceiling !== null && yieldPerMscf > ceiling * (1 + 1e-9)) {" "if (false) {" "flare: a yield above what the gas holds accepted"
plant $F "const all = nglRows.filter((r) => codes.includes(r.code));" "const all = nglRows.filter((r) => codes.includes(r.code) && r.liquidDensityLbGal !== null);" "flare: liquids content a partial sum again"
plant $F "const typed = num(c.c, null);" "const typed = num(c.c, 0);" "flare: a missing carbon number burns nothing"
plant $F "  if (rows.some((r) => r.y < 0)) {" "  if (false) {" "flare: a negative mole fraction accepted"
plant $F ": standsAlone ? 0 : (hurdle - margin) / t;" ": standsAlone ? 0 : (hurdle + margin) / t;" "credits: breakeven sign flipped"
plant $F "Math.min(...clearing)" "clearing[0]" "credits: the first tested price that clears, in typed order"
plant $F "  if (!(t > 0)) {" "  if (false) {" "credits: negative credits sold"
plant $F "isBlank(hurdleMarginPerYear) ? null" "isBlank(hurdleMarginPerYear) ? 0" "credits: a blank hurdle is 0 again"
plant $F "const best = top(valued.filter((r) => r.verdict === 'passes'));" "const best = top(valued.filter((r) => r.verdict !== 'fails'));" "compare: an unscreened route crowned best again"
plant $F "  if (v === undefined) return { value: 350, error: null };" "  if (v === undefined || v === '') return { value: 350, error: null };" "flare: blank on-stream days read as 350 again"
plant $F "export const SCF_PER_LBMOL = 379.49;" "export const SCF_PER_LBMOL = 379.5;" "flare: standard molar volume moved in the fifth figure"
plant $L "      if (b.currentBar <= pv + TOL_BAR) continue;" "      if (b.currentBar <= pTarget) continue;" "cascade: a bank below the target gives nothing again"
plant $L "      if (pEq >= pTarget) {" "      if (pEq >= pTarget || true) {" "cascade: every vehicle topped to target from one bank"
plant $L "  const realKg = idealKg / z;" "  const realKg = idealKg;" "vessel: ideal gas"
plant $L "  if (tIn !== null && tBp !== null && tIn > tBp) {" "  if (false) {" "vaporizer: a liquid above its boiling point accepted"
plant $L "    ? m * cpL * (tBp - tIn) : null;" "    ? m * cpL * (tIn - tBp) : null;" "vaporizer: sensible term sign flipped"
plant $L "  const queuePositions = Math.floor(effectivePositions + 1e-9);" "  const queuePositions = Math.max(1, Math.round(effectivePositions));" "bottling: rounded to the nearest position again"
plant $L "    const eta = num(efficiencyRatio, null);" "    const eta = num(efficiencyRatio, 1);" "conversion: the efficiency ratio defaults to 1 again"
plant $L "  if (unsized.length) {" "  if (false) {" "float: a stage with no duration dropped again"
plant $L "  const lead = withDefault(leadTimeDays, 0);" "  const lead = num(leadTimeDays, 0);" "storage: a blank lead time is 0 again"
plant $L "  const usableTonnes = fillRatioBasis === FILL_RATIO_BASIS.WATER_CAPACITY_MASS" "  const usableTonnes = false" "storage: a filling density read as a volume"
plant $L "  const sg = withDefault(gasSg, 0.6);" "  const sg = num(gasSg, 0.6);" "vessel: a blank gravity is 0.6 again"
plant $L "  const SCF_PER_KMOL = 379.49 / 0.45359237;" "  const SCF_PER_KMOL = 836.6;" "compression: the rounded molar volume again"
plant $L "  if (queue.error && queue.stable !== false) return { error: queue.error };" "" "dispensing: a queue refusal hidden under a clean result"
plant $L "  if (rows.length === 0 || rows.some((r) => !Number.isFinite(r.volumeFraction))) {" "  if (false) {" "blend: a blank volume fraction accepted"
plant $L "  const massTotal = norm.reduce((s, r) => s + r.v * r.liquidDensityKgM3, 0);" "  const massTotal = norm.reduce((s, r) => s + r.v * r.liquidDensityKgM3, 0) * 1.000001;" "blend: mass fractions off by a part in a million"

echo "== part 3: MD45-1 repairs reversed"
plant $F "export const FLARE_MOLAR_MASS = Object.freeze({ CO2: 44.009, CH4: 16.043 });" "export const FLARE_MOLAR_MASS = Object.freeze({ CO2: 44.01, CH4: 16.043 });" "flare F-R4: CO2 molar mass moved to the table's 44.010"
plant $F "export const FLARE_MOLAR_MASS = Object.freeze({ CO2: 44.009, CH4: 16.043 });" "export const FLARE_MOLAR_MASS = Object.freeze({ CO2: 44.009, CH4: 16.04 });" "flare F-R4: CH4 molar mass moved"
plant $F "  const flareCo2 = tonnesFrom(lbmolPerYear * (etaC * hcCarbon + yCo2), FLARE_MOLAR_MASS.CO2);" "  const flareCo2 = tonnesFrom(lbmolPerYear * (etaC * hcCarbon + yCo2), 44.01);" "flare F-R4: the flare weighed off the exported constant"
plant $F "export const RICHNESS_GPM = Object.freeze({ rich: 2.5, moderate: 1 });" "export const RICHNESS_GPM = Object.freeze({ rich: 2.4, moderate: 1 });" "flare F-R4: the rich edge moved"
plant $F "gpmC3Plus >= RICHNESS_GPM.moderate ? 'moderate' : 'lean'," "gpmC3Plus >= 1.1 ? 'moderate' : 'lean'," "flare F-R4: the word decided off the exported edge"
plant $F "leaves the mixture value missing too. No partial average is reported." "makes the mixture value missing, not partial." "flare F-R3: the contrastive back in the heating value note"
plant $L "reported as missing for the blend. It is never averaged over the components that have it." "reported as missing for the blend, not averaged over the components that have it." "lpg F-R3: the contrastive back in the blend note"
plant $L "It is a floor: the full duty is at least this." "It is a floor, not the duty." "lpg F-R3: the contrastive back in the vaporizer note"

echo
echo "planted: $total   survivors: $survivors"
[ "$survivors" -eq 0 ]
