#!/usr/bin/env bash
# Negative controls for the QI course gate E1c (G5 lfm, G6 seismicQc, G8
# prospectAssessment).
#
# A gate is only evidence if it fails when the thing it guards is wrong. This
# script plants one defect at a time in the shipped engines, runs the E1c
# golden gates, and requires each plant to turn them red. It restores every
# file afterwards, whatever happens. Then it regenerates the three goldens
# into a scratch directory and requires them byte-identical to the committed
# ones (an oracle that drifts is not an oracle).
#
#   tools/validation/qi/negcontrol_e1c.sh
set -u
cd "$(dirname "$0")/../../.."

FILES=(engines/qi/lfm.js engines/qi/seismicQc.js engines/qi/prospectAssessment.js)
GATES="__tests__/qi.lfm.golden __tests__/qi.seismicQc2.golden __tests__/qi.prospectAssessment.golden"
BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do cp "$f" "$BACKUP/$(basename "$f")"; done
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$f"; done; }
trap restore EXIT

gate_red() { ! npx jest $GATES --silent >/dev/null 2>&1; }

survivors=0
total=0

echo "== the gate is green on the shipped engines"
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

echo "== planted defects"
L=engines/qi/lfm.js
S=engines/qi/seismicQc.js
P=engines/qi/prospectAssessment.js
plant $L "  if (t <= H[0]) return h[0] + (t - H[0]);" "  if (t <= H[0]) return h[0] + (t - H[0]) * (h[0] / H[0]);" "lfm: above the top horizon the offset is stretched"
plant $L "  if (t >= H[last]) return h[last] + (t - H[last]);" "  if (t >= H[last]) return t;" "lfm: below the base the time is not mapped"
plant $L "      return h[i] + p * (h[i + 1] - h[i]);" "      return h[i] + p * (h[i + 1] - h[i]) + 1e-6;" "lfm: a microsecond off between horizons"
plant $L "  if (f < 1e-12) return fin(a) ? a : NaN;" "  if (f < 0.01) return fin(a) ? a : NaN;" "lfm: sampleAt snaps to a sample within a hundredth"
plant $L "  return fin(a) && fin(b) ? a + f * (b - a) : NaN;" "  return fin(a) ? a + f * ((fin(b) ? b : a) - a) : NaN;" "lfm: a null neighbour treated as the sample itself"
plant $L "    return d < 1e-6 ? Infinity : 1 / d ** power;" "    return d < 1e-6 ? Infinity : 1 / d ** (power + 0.001);" "lfm: IDW power off by a thousandth"
plant $L "  for (let k = first + 1; k < grid.ns; k++) if (!fin(out[k])) out[k] = out[k - 1];" "" "lfm: trailing uncovered samples left missing"
plant $L "    se += ((a[i] - b[i]) / b[i]) ** 2;" "    se += ((a[i] - b[i]) / a[i]) ** 2;" "lfm: blind error relative to the estimate"
plant $L "  if (n < 3) return { corr: NaN, rmsPct: NaN, n };" "  if (n < 2) return { corr: NaN, rmsPct: NaN, n };" "lfm: a two-sample score reported"
plant $S "  const edge = Math.floor((alpha * (n - 1)) / 2);" "  const edge = Math.floor((alpha * n) / 2);" "qc: taper width on n samples"
plant $S "    const v = 0.5 * (1 - Math.cos((Math.PI * i) / edge));" "    const v = Math.sin((Math.PI * i) / (2 * edge));" "qc: a sine taper"
plant $S "  const N = 2 * nextPow2(n);" "  const N = nextPow2(n);" "qc: no zero padding"
plant $S "    for (let k = 0; k < acc.length; k++) acc[k] += s.amp[k] * s.amp[k];" "    for (let k = 0; k < acc.length; k++) acc[k] += s.amp[k];" "qc: amplitudes averaged, not power"
plant $S "      peakAmp = b - 0.25 * (a - c) * p;" "      peakAmp = b;" "qc: peak amplitude unrefined"
plant $S "      if (amp[k - 1] < thr) { lo = freqHz[k - 1] + ((thr - amp[k - 1]) / (amp[k] - amp[k - 1])) * (freqHz[k] - freqHz[k - 1]); break; }" "      if (amp[k - 1] < thr) { lo = freqHz[k]; break; }" "qc: low edge snapped to the bin"
plant $S "  for (let k = 0; k < amp.length; k++) { const p = amp[k] * amp[k]; sw += p * freqHz[k]; s += p; }" "  for (let k = 0; k < amp.length; k++) { const p = amp[k]; sw += p * freqHz[k]; s += p; }" "qc: amplitude centroid, not power"
plant $S "    perPair.push(c / (1 - c));" "    perPair.push(c / Math.sqrt(1 - c * c));" "qc: S/N as an amplitude ratio"
plant $S "  const snr = m % 2 ? sorted[(m - 1) / 2] : 0.5 * (sorted[m / 2 - 1] + sorted[m / 2]);" "  const snr = sorted.reduce((a, v) => a + v, 0) / m;" "qc: mean S/N, not median"
plant $S "    if (!fin(x) || !fin(y)) continue;" "    if (!fin(x) || !fin(y)) { saa += fin(x) ? x * x : 0; sbb += fin(y) ? y * y : 0; continue; }" "qc: a null read as zero (its partner's energy counted)"
plant $S "    const d = p.map((v, k) => v - (a + b * k));" "    const d = p.map((v) => v - a);" "qc: footprint profile not detrended"
plant $S "      if (near(cand) >= 0.5 * near(kPeak)) { kf = cand; break; }" "      if (near(cand) >= 0.25 * near(kPeak)) { kf = cand; break; }" "qc: fundamental at a quarter of the peak"
plant $S "    const median = sorted[Math.floor((sorted.length - 1) / 2)];" "    const median = sorted[Math.floor(sorted.length / 2)];" "qc: upper median for the prominence"
plant $P "        if (!(mask[j] > 0) && !isNull(z[j]) && z[j] < z[i]) { s += (z[i] + z[j]) / 2; k += 1; }" "        if (!(mask[j] > 0) && !isNull(z[j]) && z[j] < z[i]) { s += z[i]; k += 1; }" "prospect: edge read at the anomaly node, not the midpoint"
plant $P "        if (!(mask[j] > 0) && !isNull(z[j]) && z[j] < z[i]) { s += (z[i] + z[j]) / 2; k += 1; }" "        if (!(mask[j] > 0) && !isNull(z[j])) { s += (z[i] + z[j]) / 2; k += 1; }" "prospect: updip neighbours counted as edge"
plant $P "  const sd = n > 1 ? Math.sqrt(edge.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : NaN;" "  const sd = n > 1 ? Math.sqrt(edge.reduce((a, v) => a + (v - mean) ** 2, 0) / n) : NaN;" "prospect: population sd"
plant $P "  const implied = fin(mean) ? Math.max(mean, spill.spillZ) : NaN; // a contact cannot sit below the spill" "  const implied = mean;" "prospect: implied contact not held at the spill"
plant $P "      if (inClosure[i]) inside += 1;" "      inside += 1;" "prospect: every anomaly node counted inside"
plant $P "    if (!bySource.has(src)) bySource.set(src, []);" "    if (!bySource.has(src)) bySource.set(src, []); else bySource.set(src + '_dup', [it]);" "evidence: shared sources counted twice"
plant $P "  if (fin(conformance) && conformance < 0.3) {" "  if (fin(conformance) && conformance <= 0.3) {" "decision: conformance 0.3 read as cutting across"
plant $P "  if (!fin(conformance) || conformance < 0.7) reasons.push" "  if (fin(conformance) && conformance < 0.7) reasons.push" "decision: an unmeasured conformance matures"
plant $P "  if (fin(insideClosure) && insideClosure < 0.5) reasons.push" "  if (fin(insideClosure) && insideClosure < 0.4) reasons.push" "decision: inside-closure threshold moved"

echo "== byte-identical regeneration"
TMP=$(mktemp -d)
for o in lfm:lfm seismic_qc2:seismicQc2 prospect:prospectAssessment; do
  py=${o%%:*}; gj=${o##*:}
  total=$((total + 1))
  python3 -I tools/validation/qi/oracle_qi_${py}.py "$TMP/$gj.json" >/dev/null
  if cmp -s "$TMP/$gj.json" "test-data/qi/goldens.$gj.json"; then echo "   identical goldens.$gj.json"; else echo "   DRIFTED   goldens.$gj.json"; survivors=$((survivors + 1)); fi
done
rm -rf "$TMP"

echo
echo "planted and checked: $total   survivors: $survivors"
[ "$survivors" -eq 0 ]
