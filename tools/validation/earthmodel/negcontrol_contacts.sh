#!/usr/bin/env bash
# Earth Modeling T1 negative controls for __tests__/earthmodel.contacts.test.js.
# Each row plants ONE defect in engines/earthmodeling/volumes.js, runs the
# suite and records whether it went red. Restores the file on exit.
set -u
cd "$(dirname "$0")/../../.." || exit 1
E=engines/earthmodeling/volumes.js
TEST=__tests__/earthmodel.contacts.test.js
TMP=$(mktemp); cp "$E" "$TMP"; trap 'cp "$TMP" "$E"' EXIT
RUN=0; RED=0
plant() { python3 - "$E" "$2" "$3" <<'PY'
import sys
p,a,b=sys.argv[1:4]; s=open(p).read()
if s.count(a)!=1: sys.exit(3)
open(p,'w').write(s.replace(a,b))
PY
}
case_() { cp "$TMP" "$E"; plant x "$2" "$3" || { echo "SKIP  $1"; return; }; RUN=$((RUN+1))
  if npx jest "$TEST" 2>&1 | grep -qE "Tests:.*failed"; then echo "RED   $1"; RED=$((RED+1)); else echo "GREEN $1 -- NOT CAUGHT"; fi; }
case_ "water leg counted (OWC ignored)" "    const hcBottom = w === null ? zb : Math.min(zb, w);" "    const hcBottom = zb;"
case_ "gas cap not split" "    const gasT = g === null ? 0 : Math.max(0, Math.min(hcBottom, g) - zt);" "    const gasT = 0;"
case_ "oil starts at the zone top under a GOC" "    const oilTop = g === null ? zt : Math.max(zt, g);" "    const oilTop = zt;"
case_ "STOIIP multiplies by Bo" "    b.stoiip_m3 = bo !== null ? b.oil_hcpv_m3 / bo : null;" "    b.stoiip_m3 = bo !== null ? b.oil_hcpv_m3 * bo : null;"
case_ "GIIP from total HCPV" "    b.giip_m3 = bg !== null ? b.gas_hcpv_m3 / bg : null;" "    b.giip_m3 = bg !== null ? b.hcpv_m3 / bg : null;"
case_ "per-block contact ignored" "    const v = Object.prototype.hasOwnProperty.call(c, lab) ? c[lab] : null;" "    const v = Object.values(c)[0];"
case_ "Sw not applied" "    b.oil_hcpv_m3 += oilT * cell * ntg * phi * (1 - sw);" "    b.oil_hcpv_m3 += oilT * cell * ntg * phi;"
cp "$TMP" "$E"
echo "ENGINE plants red: $RED/$RUN"
