#!/usr/bin/env bash
# Prospect valuation negative controls for __tests__/prospect.valuation.test.js.
# Each row plants ONE defect in engines/prospect/valuation.js; all must go RED.
set -u
cd "$(dirname "$0")/../../.." || exit 1
E=engines/prospect/valuation.js
TEST=__tests__/prospect.valuation.test.js
TMP=$(mktemp); cp "$E" "$TMP"; trap 'cp "$TMP" "$E"' EXIT
RUN=0; RED=0
case_() { cp "$TMP" "$E"
  python3 - "$E" "$2" "$3" <<'PY' || { echo "SKIP  $1"; return; }
import sys
p,a,b=sys.argv[1:4]; s=open(p).read()
if s.count(a)!=1: sys.exit(3)
open(p,'w').write(s.replace(a,b))
PY
  RUN=$((RUN+1))
  if npx jest "$TEST" 2>&1 | grep -qE "Tests:.*failed"; then echo "RED   $1"; RED=$((RED+1)); else echo "GREEN $1 -- NOT CAUGHT"; fi; }
case_ "sigma over z90 not 2 z90" "  const sigma = (Math.log(p10) - Math.log(p90)) / (2 * Z90);" "  const sigma = (Math.log(p10) - Math.log(p90)) / Z90;"
case_ "median as the mean" "  const mean = Math.exp(mu + (sigma * sigma) / 2);" "  const mean = Math.exp(mu);"
case_ "partial expectation without the sigma shift" "export const partialMeanAbove = (ln, m) => (m > 0 ? ln.mean * normCdf(ln.sigma - (Math.log(m) - ln.mu) / ln.sigma) : ln.mean);" "export const partialMeanAbove = (ln, m) => (m > 0 ? ln.mean * normCdf(-(Math.log(m) - ln.mu) / ln.sigma) : ln.mean);"
case_ "commercial chance ignores MEFS" "  const pc = pg * pComm;" "  const pc = pg;"
case_ "development cost paid on every success" "  const valueIfDiscovery = u * partial - D * pComm; // \$MM, expectation over success cases" "  const valueIfDiscovery = u * partial - D; // \$MM, expectation over success cases"
case_ "well cost only on failure" "  const emv = pg * valueIfDiscovery - W;" "  const emv = pg * valueIfDiscovery - (1 - pg) * W;"
case_ "Swanson weights swapped" "export const swansonMean = (p90, p50, p10) => 0.3 * p90 + 0.4 * p50 + 0.3 * p10;" "export const swansonMean = (p90, p50, p10) => 0.4 * p90 + 0.3 * p50 + 0.3 * p10;"
case_ "portfolio chance as a sum" "    pAtLeastOneCommercial: n ? 1 - valued.reduce((s, v) => s * (1 - v.pc), 1) : 0," "    pAtLeastOneCommercial: n ? Math.min(1, valued.reduce((s, v) => s + v.pc, 0)) : 0,"
case_ "curve not risked by Pg" "    out.push({ volume: x, exceedance: Number(p.pg) * exceedance(ln, x) });" "    out.push({ volume: x, exceedance: exceedance(ln, x) });"
cp "$TMP" "$E"
echo "ENGINE plants red: $RED/$RUN"
