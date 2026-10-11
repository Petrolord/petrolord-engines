#!/usr/bin/env bash
# Negative controls for the E1b gate (engines/qi/avo.js, engines/qi/wavelets.js).
#
# A gate is only evidence if it fails when the thing it guards is wrong. This
# script plants one defect at a time in the shipped engines, runs the E1b
# golden gate, and requires each plant to turn it red. It restores every file
# afterwards, whatever happens. It also regenerates both goldens into a temp
# directory and requires them byte-identical to the committed files.
#
#   tools/validation/qi/negcontrol_e1b.sh
set -u
cd "$(dirname "$0")/../../.."

FILES=(engines/qi/avo.js engines/qi/wavelets.js)
GATES="__tests__/qi.avo.golden __tests__/qi.wavelets.golden"
BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do cp "$f" "$BACKUP/$(basename "$f")"; done
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$f"; done; }
trap 'restore; rm -rf "$BACKUP"' EXIT

gate_red() { ! npx jest $GATES --silent >/dev/null 2>&1; }

survivors=0
total=0

echo "== part 0: the goldens regenerate byte for byte"
TMP=$(mktemp -d)
python3 tools/validation/qi/oracle_qi_avo.py "$TMP/a.json" >/dev/null && cmp -s "$TMP/a.json" test-data/qi/goldens.qiAvo.json \
  && echo "   goldens.qiAvo.json identical" || { echo "   goldens.qiAvo.json DIFFERS"; survivors=$((survivors + 1)); }
python3 tools/validation/qi/oracle_qi_wavelets.py "$TMP/w.json" >/dev/null && cmp -s "$TMP/w.json" test-data/qi/goldens.qiWavelets.json \
  && echo "   goldens.qiWavelets.json identical" || { echo "   goldens.qiWavelets.json DIFFERS"; survivors=$((survivors + 1)); }
rm -rf "$TMP"

echo "== part 0b: the gate is green on the shipped engines"
if gate_red; then echo "   RED on the shipped engines: fix the gate first"; exit 1; fi

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

echo "== part 1: planted defects in avo.js"
A=engines/qi/avo.js
plant $A "const s2 = Math.sin(t) ** 2; const g2 = vsVp * vsVp;" "const s2 = Math.sin(t); const g2 = vsVp * vsVp;" "akiRichards: sin in place of sin^2"
plant $A "(0.5 / Math.cos(t) ** 2) * dVpVp" "0.5 * dVpVp" "akiRichards: the 1/cos^2 on the Vp term dropped"
plant $A "B: 0.5 * dVpVp - 4 * g2 * dVsVs - 2 * g2 * dRhoRho" "B: 0.5 * dVpVp - 4 * g2 * dVsVs - 4 * g2 * dRhoRho" "shueyTerms: density gradient coefficient doubled"
plant $A "A: 0.5 * (dVpVp + dRhoRho)" "A: 0.5 * dVpVp + dRhoRho" "shueyTerms: intercept density weight 1"
plant $A "C: 0.5 * dVpVp }" "C: 0.5 * dVsVs }" "shueyTerms: curvature from Vs"
plant $A "const x = k === 3 ? [1, s2, Math.tan(t) ** 2 - s2] : [1, s2];" "const x = k === 3 ? [1, s2, Math.tan(t) ** 2] : [1, s2];" "fitShuey: tan^2 basis without - sin^2"
plant $A "const w = weights ? weights[i] : 1;" "const w = 1;" "fitShuey: weights ignored"
plant $A "const w = weights ? weights[i] : 1;" "const w = weights ? Math.sqrt(weights[i]) : 1;" "fitShuey: sqrt of the weights"
plant $A "const dRhoRho = dVpVp / 4;" "const dRhoRho = dVpVp / 3;" "contrastsFromAB: Gardner 1/4 -> 1/3"
plant $A "fluidFactor: dVpVp - 1.16 * vsVp * dVsVs" "fluidFactor: dVpVp - 1.0 * vsVp * dVsVs" "contrastsFromAB: mudrock 1.16 -> 1.0"
plant $A "const dVpVp = (8 / 5) * A;" "const dVpVp = 2 * A;" "contrastsFromAB: Gardner ignored in A"
plant $A "return { m: Math.tan(theta), n };" "return { m: sab / saa, n };" "backgroundTrend: OLS in place of the orthogonal fit"
plant $A "if (n < 3 || !(Math.abs(sab) > 0)) return { m: NaN, n };" "if (n < 3 || !(Math.abs(sab) > 0)) return { m: NaN, n: n + 1 };" "backgroundTrend: miscounted points"
plant $A "(B - m * A) / Math.sqrt(1 + m * m)" "(m * A - B) / Math.sqrt(1 + m * m)" "offTrend: sign flipped"
plant $A "(B - m * A) / Math.sqrt(1 + m * m)" "(B - m * A)" "offTrend: vertical, not perpendicular"
plant $A "A * Math.cos(chiDeg * RAD) + B * Math.sin(chiDeg * RAD)" "A * Math.sin(chiDeg * RAD) + B * Math.cos(chiDeg * RAD)" "chiProjection: sin and cos swapped"
plant $A "if (A >= band) return 'I';" "if (A > band) return 'I';" "avoClass: class I boundary exclusive"
plant $A "return B < 0 ? 'III' : 'IV';" "return B <= 0 ? 'III' : 'IV';" "avoClass: B = 0 read as class III"

echo "== part 2: planted defects in wavelets.js"
W=engines/qi/wavelets.js
plant $W "out[k + half] = f < 1e-12 ? (fin(a) ? a : 0) : (fin(a) && fin(b) ? a + f * (b - a) : 0);" "out[k + half] = fin(a) ? a : 0;" "resample: nearest-left in place of linear"
plant $W "const x = c + (k * dtOut) / dtIn;" "const x = c + (k * dtIn) / dtOut;" "resample: interval ratio inverted"
plant $W "const half = Math.floor((c * dtIn) / dtOut);" "const half = Math.round((c * dtIn) / dtOut);" "resample: half length rounded"
plant $W "return Float64Array.from(w, (v) => (e > 0 ? v / e : 0));" "return Float64Array.from(w, (v) => v);" "normalise: dropped"
plant $W "const j = i - lag; if (j >= 0 && j < b.length) s += a[i] * b[j]; }" "const j = i + lag; if (j >= 0 && j < b.length) s += a[i] * b[j]; }" "ncc: lag sign flipped"
plant $W "if (c > best.corr) best = { lag, corr: c };" "if (c >= best.corr) best = { lag, corr: c };" "align: tie-break to the last lag"
plant $W "if (c > best.corr) best = { lag, corr: c };" "if (Math.abs(c) > Math.abs(best.corr)) best = { lag, corr: c };" "align: best absolute correlation (polarity-blind)"
plant $W "for (let lag = -maxLag; lag <= maxLag; lag++) {" "for (let lag = -maxLag; lag < maxLag; lag++) {" "align: search one lag short"
plant $W "return { name: w.name, samples: normaliseWavelet(r.aligned), lag: r.lag };" "return { name: w.name, samples: r.aligned, lag: r.lag };" "compare: aligned wavelet not renormalised"
plant $W "const average = normaliseWavelet(avg);" "const average = avg;" "compare: average not normalised"
plant $W "const r = alignWavelet(ref, normaliseWavelet(w.samples), { maxLag });" "const r = alignWavelet(ref, normaliseWavelet(w.samples), { maxLag: 10 });" "compare: maxLag ignored"

echo
echo "planted: $total   survivors: $survivors"
[ "$survivors" -eq 0 ]
