#!/usr/bin/env bash
# EC7 negative controls for the PIA 2021 / NTA 2025 default path.
#
# Each row plants ONE defect in the engine (the pre-audit behaviour a repair
# removed, or a plausible slip) and runs the gate. Every row must go RED.
# The files are restored after every row and on exit. Never commit while
# this runs: the engine files are rewritten in place.
#
#   tools/validation/economics/negcontrol_pia2021.sh [filter]
set -u
cd "$(dirname "$0")/../../.." || exit 1
FILTER=${1:-}
CF=engines/economics/cashflow.ts
FR=engines/economics/fiscalRegime.js
TEST="__tests__/economics.pia2021.test.ts"
TMP=$(mktemp -d)
cp "$CF" "$TMP/cf.bak"; cp "$FR" "$TMP/fr.bak"
restore() { cp "$TMP/cf.bak" "$CF"; cp "$TMP/fr.bak" "$FR"; }
trap 'restore; rm -rf "$TMP"' EXIT

plant() { # file from to
  python3 - "$1" "$2" "$3" <<'PYEOF'
import sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if s.count(a) != 1:
    sys.stderr.write("PLANT TARGET NOT UNIQUE (%d): %s\n" % (s.count(a), a))
    sys.exit(3)
open(path, "w").write(s.replace(a, b))
PYEOF
}

row() { # repair name file from to
  rep=$1; name=$2; f=$3; a=$4; b=$5
  [ -n "$FILTER" ] && case "$rep $name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  plant "$f" "$a" "$b" || { echo "SKIP  [$rep] $name (target)"; return; }
  out=$(timeout 600 npx jest "$TEST" 2>&1)
  rc=$?
  if [ $rc -eq 124 ]; then echo "HANG  [$rep] $name"
  elif echo "$out" | grep -qE "Tests:.*failed|Test Suites:.*failed"; then
    n=$(echo "$out" | grep -E "^Tests:" | grep -oE "[0-9]+ failed")
    echo "RED   [$rep] $name -- ${n:-suite failed}"
  else echo "GREEN [$rep] $name -- NOT CAUGHT"; fi
}

echo "=== baseline ==="
restore
npx jest "$TEST" 2>&1 | grep -E "^Tests:"

echo "=== plants (all must be RED) ==="
row R1 "deep offshore royalty as a whole-year step (pre-audit)" "$CF" \
  "    if (liquidsBopd <= 50000) return 0.05;
    return (50000 * 0.05 + (liquidsBopd - 50000) * 0.075) / liquidsBopd;" \
  "    return liquidsBopd > 50000 ? 0.075 : 0.05;"
row R1 "onshore/shallow flat at the terrain rate (pre-audit)" "$CF" \
  "  if (liquidsBopd <= 5000) return 0.05;
  if (liquidsBopd <= 10000)" "  return upper;
  if (liquidsBopd <= 10000)"
row R1 "second tranche at 7.0% instead of 7.5%" "$CF" \
  "(5000 * 0.05 + (liquidsBopd - 5000) * 0.075) / liquidsBopd" "(5000 * 0.05 + (liquidsBopd - 5000) * 0.07) / liquidsBopd"
row R1 "daily rate from crude only (condensate left out)" "$CF" \
  "const liquidsBopd = liquidsBbl / calendarDays(inputs.year);" "const liquidsBopd = inputs.oil_bbl / calendarDays(inputs.year);"
row R1 "365 days in a leap year" "$CF" "(isLeapYear(year) ? 366 : 365)" "365"
row R2 "gas royalty 7% onshore and shallow (pre-audit)" "$CF" \
  "return 0.05 * (1 - s / 100) + 0.025 * (s / 100);" "return terrain === 'deep_offshore' || terrain === 'frontier' ? 0.05 : 0.07;"
row R2 "in-country gas share ignored" "$CF" \
  "return 0.05 * (1 - s / 100) + 0.025 * (s / 100);" "return 0.05;"
row R3 "no allowance after the new-lease cap (pre-audit)" "$CF" \
  "const perAfter = Math.min(Number(cfg.pia_production_allowance_per_bbl_new_after_cap ?? 4), pct * fiscalPrice);" "const perAfter = 0;"
row R3 "deep offshore allowance kept under the NTA (pre-audit)" "$CF" \
  "if ((terrain === 'deep_offshore' || terrain === 'frontier') && framework === 'nta_2025') return none;" ""
row R4 "CPR-limited opex in the CIT base (pre-audit)" "$CF" \
  "grossRev - totalRoyalties - inputs.opex_inflated - hcdt - nddc - decomDeduction;" \
  "grossRev - totalRoyalties - Math.min(inputs.opex_inflated, cprClaimed) - hcdt - nddc - decomDeduction;"
row R4 "CPR cap on gross revenue including gas (pre-audit)" "$CF" \
  "const cprCap = Math.max(0, liquidsRev * cprPct / 100);" "const cprCap = Math.max(0, grossRev * cprPct / 100);"
row R4 "decommissioning contribution outside the CPR" "$CF" \
  "const hctOperatingCosts = share * (inputs.opex_inflated + decomDeduction);" "const hctOperatingCosts = share * inputs.opex_inflated;"
row R5 "NDDC left out of the HCT base (pre-audit)" "$CF" \
  "- operatingClaimed - share * (hcdt + nddc);" "- operatingClaimed - share * hcdt;"
row R5 "NDDC on opex instead of the total budget (pre-audit)" "$CF" \
  "(nddcBase === 'total_budget' ? opexInflated + capexNominal : opexInflated)" "opexInflated"
row R6 "one framework per run from base_year (pre-audit)" "$CF" \
  "(compliantPIA ? fiscalFrameworkForYear(cfg, year) : framework)" "framework"
row R7 "two-thirds restriction applied under the NTA (pre-audit)" "$CF" \
  "const restricted = framework === 'pia_only' && cfg.pia_cit_company_gas_operations !== true;" \
  "const restricted = cfg.pia_cit_company_gas_operations !== true;"
row R8 "PIA capital allowance at 20% x 5, no 1% retention (pre-audit)" "$CF" \
  "return [0.20, 0.20, 0.20, 0.20, 0.19][yearOfLife];" "return 0.20;"
row R9 "TET at 2.5% after 2023 (pre-audit)" "$CF" "(year >= 2023 ? 3 : 2.5)" "2.5"
row R10 "NTA decommissioning deduction without the escrow condition" "$CF" \
  "  const decomDeductible = inputs.decom_contribution > 0
    && (framework === 'pia_only' || cfg.pia_decom_escrow_condition_met === true);" \
  "  const decomDeductible = inputs.decom_contribution > 0;"
row R11 "price royalty benchmarks from 2020 by default" "$CF" \
  "const baseYear = base === 'regulations_2021' ? 2021 : 2020;" "const baseYear = 2020;"
row R11 "benchmarks not rounded to cents" "$CF" \
  "const cents = (x: number) => Math.round(x * 100) / 100;" "const cents = (x: number) => x;"
row R11 "condensate price royalty at the oil price (pre-audit)" "$CF" \
  "const priceRateCond = derivePriceRoyaltyRate(inputs.condensate_price_usd_bbl," "const priceRateCond = derivePriceRoyaltyRate(inputs.oil_price_usd_bbl,"
row D5 "new-acreage PML defaulted to 30% instead of a stated input" "$CF" \
  "if (leaseStatus === 'converted') return 0.30;" "if (leaseStatus === 'converted' || leaseStatus === 'new') return 0.30;"
row D5 "deep offshore NTA defaulted to zero" "$CF" \
  "      default:
        return refuse('A deep offshore year" "      default: return 0;
        return refuse('A deep offshore year"
row HCT "marginal field flag ignored" "$CF" "  if (marginalPre2021 === true) return 0.15;" ""
row ETR "minimum ETR top-up in PIA years" "$CF" \
  "if (cfg.pia_apply_minimum_etr === true && yearFramework === 'nta_2025') {" "if (cfg.pia_apply_minimum_etr === true) {"
row D1 "legacy switch ignored" "$CF" \
  "const legacyPIA = cfg.fiscal_regime === 'PIA' && cfg.pia_legacy_pre_audit === true;" \
  "const legacyPIA = false;"
row R12 "template cost limit on revenue after royalty (pre-audit base)" "$FR" \
  "(regime.costRecoveryBase === 'liquids_gross' ? oilRev + nglRev : revenueAfterRoyalty)" "revenueAfterRoyalty"
# (A plant charging gas at the oil production rate is invisible on both
# projects: below 50,000 bopd both rates are 5%. The row below drops it.)
row R12 "template gas and NGL royalty left out" "$FR" \
  "return oilRevMM * (production + byPrice) + gasAndNglRevMM * gas;" "return oilRevMM * (production + byPrice);"
row R12 "template royalty by price left out" "$FR" \
  "return oilRevMM * (production + byPrice) + gasAndNglRevMM * gas;" "return oilRevMM * production + gasAndNglRevMM * gas;"
echo "=== done ==="
