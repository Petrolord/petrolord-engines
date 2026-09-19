#!/usr/bin/env bash
# Negative controls for the MD5 gate (MD5-0).
#
# A gate is only evidence if it fails when the thing it guards is wrong. This
# script plants one defect at a time in the shipped engines, runs the MD5
# golden gate, and requires each plant to turn it red. It restores every file
# afterwards, whatever happens.
#
# Part 1 runs the gate against origin/main's UNREPAIRED engines.
# Part 2 plants single-line defects: logic flips, loosened tolerances,
# changed defaults and constants, and blanks read as 0 (or as 1, or a year).
#
#   tools/validation/downstream/negcontrol_md5.sh
set -u
cd "$(dirname "$0")/../../.."

FILES=(engines/downstream/carbonAbatement.js engines/downstream/energyEfficiency.js)
GATES="__tests__/downstream.carbon.golden"
BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do cp "$f" "$BACKUP/$(basename "$f")"; done
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$f"; done; }
trap restore EXIT

gate_red() { ! npx jest $GATES --silent >/dev/null 2>&1; }

survivors=0
total=0

echo "== part 1: the gate against origin/main's unrepaired engines"
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
C=engines/downstream/carbonAbatement.js
E=engines/downstream/energyEfficiency.js
plant $C "  if (blank(destructionEfficiencyFraction)) {" "  if (false) {" "carbon: a blank destruction efficiency is 100 percent again"
plant $C "  const co2Tonnes = (carbonKmol * eta * MW_CO2) / 1000;" "  const co2Tonnes = (carbonKmol * MW_CO2) / 1000;" "carbon: the unburned carbon also counted as CO2"
plant $C "export const MW_CO2 = 44.009;" "export const MW_CO2 = 44.01;" "carbon: CO2 molar mass moved"
plant $C "export const MW_CH4 = 16.043;" "export const MW_CH4 = 16.04;" "carbon: CH4 molar mass moved"
plant $C "  const rows = lines.filter(Boolean).map((l) => {" "  const rows = lines.filter((l) => l && !l.error).map((l) => {" "carbon: an errored line dropped from the inventory"
plant $C "    if (s !== SCOPE.ONE && s !== SCOPE.TWO) {" "    if (false) {" "carbon: an off-scope line accepted"
plant $C "    : (r === 0 ? 1 / life : (r * (1 + r) ** life) / ((1 + r) ** life - 1));" "    : 1 / life;" "carbon: capital annualised straight-line at any rate"
plant $C "  if (blank(capitalCost)) {" "  if (false) {" "carbon: a blank capital cost is free again"
plant $C "  if (capex !== 0 && blank(discountRate)) {" "  if (false) {" "carbon: a blank discount rate is 0 again"
plant $C "  if (!Number.isFinite(r) || r <= -1 || r >= 1) {" "  if (!Number.isFinite(r)) {" "carbon: a rate typed as a percentage accepted"
plant $C "  if (t < 0) {" "  if (false) {" "carbon: a negative abatement accepted"
plant $C "    return a.costPerTonne - b.costPerTonne;" "    return b.costPerTonne - a.costPerTonne;" "carbon: the curve sorted dearest first"
plant $C "    meetsTarget: target === null || overClaims.length ? null : cumulative >= target," "    meetsTarget: target === null ? null : cumulative >= target," "carbon: a target met on over-claimed tonnes"
plant $C "    if (emitted !== null && claimed > emitted + 1e-9) {" "    if (emitted !== null && claimed > emitted * 3) {" "carbon: the over-claim tolerance loosened"
plant $C "  const unscheduled = measures.filter((m) => m && !m.error && (" "  const unscheduled = measures.filter((m) => false && (" "carbon: an unscheduled measure dropped silently"
plant $C "  if (!(base > 0)) {" "  if (false) {" "carbon: a zero baseline accepted"

plant $E "    + airN2 * ATMOSPHERIC_N2_MOLAR_MASS + fuelN2 * 28.014" "    + airN2 * 28.014 + fuelN2 * 28.014" "energy: argon carried as nitrogen again"
plant $E "export const O2_MOLE_FRACTION_DRY_AIR = 0.20946;" "export const O2_MOLE_FRACTION_DRY_AIR = 0.21;" "energy: oxygen in air rounded to 21 percent"
plant $E "  const excess = (f * dryProductsStoich) / denom;" "  const excess = (f * (dryProductsStoich + st.products.h2oPerKmolFuel)) / denom;" "energy: a dry oxygen reading solved on a wet basis"
plant $E "    moistureLossKJ = h2oMassKg * (hfg + cpV * (tStack - tRef));" "    moistureLossKJ = h2oMassKg * cpV * (tStack - tRef);" "energy: HHV moisture loss without the latent heat"
plant $E "  const savingFraction = 1 - fuelRatio;" "  const savingFraction = (et - ec) / 100;" "energy: the saving as the efficiency difference"
plant $E "  if (!Number.isFinite(tgt)) {" "  if (false) {" "energy: a blank target oxygen skips the safe floor"
plant $E "  const k = num(specificHeatRatio);" "  const k = num(specificHeatRatio, 1.3);" "energy: the superheated exponent is the default again"
plant $E "  const eta = num(boilerEfficiencyFraction, null);" "  const eta = num(boilerEfficiencyFraction, 1);" "energy: a trap's boiler is 100 percent efficient again"
plant $E "  if (blank(hoursPerYear) || !(num(hoursPerYear) > 0)" "  if (!(num(hoursPerYear, 8760) > 0)" "energy: blank trap hours are a full year again"
plant $E "  const term = (2 / (k + 1)) ** ((k + 1) / (k - 1));" "  const term = (2 / (k + 1)) ** (k / (k - 1));" "energy: the choked-flux exponent wrong"
plant $E "  const comparable = peerOk && missing.length === 0;" "  const comparable = peerOk;" "energy: a floor intensity compared with the peer"
plant $E "  const zeroPoints = cascade.slice(1, -1).filter((p) => Math.abs(p.heatFlowKW) < 1e-6);" "  const zeroPoints = cascade.filter((p) => Math.abs(p.heatFlowKW) < 1e-6);" "energy: a threshold problem reports an end as its pinch"
plant $E "  const zeroPoints = cascade.slice(1, -1).filter((p) => Math.abs(p.heatFlowKW) < 1e-6);" "  const zeroPoints = cascade.slice(1, -1).filter((p) => Math.abs(p.heatFlowKW) < 50);" "energy: the pinch tolerance loosened"
plant $E "  if (parsed.some((s) => s.cpKWperK < 0)) {" "  if (false) {" "energy: a negative heat capacity flowrate accepted"
plant $E "    const half = dTmin / 2;" "    const half = dTmin;" "energy: streams shifted by the full approach"
plant $E "    costPerTonneCo2e: abatement && !abatement.error ? abatement.costPerTonne : null," "    costPerTonneCo2e: capex === null || !tCo2 ? null : (capex - (annualValue ?? 0)) / tCo2," "energy: capital set against one year again"
plant $E "  if (bases.length > 1) {" "  if (false) {" "energy: a price and a factor on different bases multiplied"
plant $E "  condensateTempC, makeupTempC, waterCpKJkgK = 4.19," "  condensateTempC, makeupTempC, waterCpKJkgK = 4.18," "energy: the water specific heat default moved"

echo
echo "planted: $total   survivors: $survivors"
[ "$survivors" -eq 0 ]
