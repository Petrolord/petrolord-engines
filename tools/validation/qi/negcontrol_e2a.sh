#!/usr/bin/env bash
# Negative controls for the QI course gate E2, part A (avoWells, inversionQc,
# angleWavelets, seismolord/wellWavelet).
#
# A gate is only evidence if it fails when the thing it guards is wrong. This
# script plants one defect at a time in the shipped engines, runs the three
# golden gates, and requires each plant to turn them red. It restores every
# file afterwards, whatever happens. Then it regenerates the three goldens into
# a scratch directory and requires them byte-identical to the committed ones.
#
#   tools/validation/qi/negcontrol_e2a.sh
set -u
cd "$(dirname "$0")/../../.."

FILES=(engines/qi/avoWells.js engines/qi/inversionQc.js engines/qi/angleWavelets.js engines/seismolord/wellWavelet.js)
GATES="__tests__/qi.avoWells.golden __tests__/qi.inversionQc.golden __tests__/qi.angleWavelets.golden"
BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do cp "$f" "$BACKUP/$(basename "$f")"; done
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$f"; done; }
trap restore EXIT

gate_red() { ! npx jest $GATES --silent >/dev/null 2>&1; }

survivors=0
total=0

echo "== part 0: the gates are green on the shipped engines"
if gate_red; then echo "   RED on the shipped engines: fix the gate first"; exit 1; else echo "   green"; fi

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

echo "== part 1: planted defects"
A=engines/qi/avoWells.js
I=engines/qi/inversionQc.js
W=engines/qi/angleWavelets.js
L=engines/seismolord/wellWavelet.js
plant $A "for (const k of ['A', 'B']) {" "for (const k of ['A']) {" "avoWells: the scale from the intercepts only"
plant $A "const obs = { A: r.observed.A / scale, B: r.observed.B / scale };" "const obs = { A: r.observed.A * scale, B: r.observed.B * scale };" "avoWells: the seismic multiplied by the scale"
plant $A "const res = Math.hypot(obs.A - r.modelled.A, obs.B - r.modelled.B);" "const res = Math.hypot(obs.A - r.modelled.A, 0);" "avoWells: the residual ignores the gradient"
plant $A "const oClass = avoClass(obs.A, obs.B);" "const oClass = avoClass(r.observed.A, r.observed.B);" "avoWells: the seismic class read before scaling"
plant $A "rows.filter((r) => r.ok && fin(r.topTwt))" "rows.filter((r) => r.ok && r.topTwt)" "avoWells: a zone top at 0 ms dropped"
plant $I "Math.max(1, Math.round(1000 / (hz * dtMs) / 2))" "Math.max(1, Math.floor(1000 / (hz * dtMs) / 2))" "inversionQc: the half window truncated"
plant $I "Math.max(1, Math.round(1000 / (hz * dtMs) / 2))" "Math.max(0, Math.round(1000 / (hz * dtMs) / 2))" "inversionQc: a zero half window allowed"
plant $I "out[i] = fin(out[i]) ? lp[i] : NaN;" "out[i] = lp[i];" "inversionQc: the low pass fills the gaps"
plant $I "for (let j = i - half - 1; j <= i + half + 1; j++)" "for (let j = i - half; j <= i + half; j++)" "inversionQc: the coverage window one sample short each side"
plant $I "if (isNull(trace[i]) || !coveredWithin(lnAi, i, half)) continue;" "if (!coveredWithin(lnAi, i, half)) continue;" "inversionQc: dead trace samples used"
plant $I "if (n < 10 || !(sxx > 0))" "if (n < 1000 || !(sxx > 0))" "inversionQc: the sample floor raised"
plant $I "blind: score(invert(traces[k], w.il, w.xl, w.name))," "blind: score(invert(traces[k], w.il, w.xl))," "inversionQc: the blind well left in its own model"
plant $I "truth = truth.map((v, i) => v - low[i]);" "truth = truth.map((v) => v);" "inversionQc: relative truth not band-passed"
plant $I "export const BLIND_LOW_CUT_HZ = 8;" "export const BLIND_LOW_CUT_HZ = 10;" "inversionQc: the default low cut moved"
plant $I "return { corr: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN, rmsPct: null, n };" "return { corr: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * sxx) : NaN, rmsPct: null, n };" "inversionQc: relative correlation normalised wrongly"
plant $W "return Float64Array.from(r, (v, i) => (ok(i - 1) && ok(i + 1) ? v : NaN));" "return Float64Array.from(r, (v, i) => (ok(i) ? v : NaN));" "angleWavelets: reflectivity kept beside a log gap"
plant $W "{ maxLag: 4 }" "{ maxLag: 0 }" "angleWavelets: no alignment across wells"
plant $W "avg = Float64Array.from(cmp.average, (v) => v * energy);" "avg = Float64Array.from(cmp.average, (v) => v);" "angleWavelets: the wells' energy dropped"
plant $W "const cov = sab / n - (sa / n) * (sb / n);" "const cov = sab / n;" "angleWavelets: the synthetic correlation uncentred"
plant $W "if (fin(v)) { s += w[k + h] * v; any = true; }" "if (fin(v)) { s += w[h - k] * v; any = true; }" "angleWavelets: the synthetic wavelet reversed in time"
plant $L "const lam = damping * (diag / m);" "const lam = damping * diag;" "wellWavelet: damping not relative to the mean diagonal"
plant $L "row[k + L] = live(v) ? v : 0;" "row[L - k] = live(v) ? v : 0;" "wellWavelet: the lag axis reversed"
plant $L "if (!live(seismic[t])) continue;" "if (!Number.isFinite(seismic[t])) continue;" "wellWavelet: the Float32 brick null read as a sample"
plant $L "if (rows.length < 2 * m) {" "if (rows.length < m) {" "wellWavelet: a log half as long accepted"
plant $L "fitCorr: xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0," "fitCorr: xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy + 1e-9) : 0," "wellWavelet: fit correlation off in the ninth figure"

echo "== part 2: the goldens regenerate byte for byte"
TMP=$(mktemp -d)
for g in avoWells inversionQc angleWavelets; do cp "test-data/qi/goldens.$g.json" "$TMP/$g.committed"; done
python3 tools/validation/qi/oracle_qi_avo_wells.py >/dev/null
python3 tools/validation/qi/oracle_qi_inversion_qc.py >/dev/null
python3 tools/validation/qi/oracle_qi_angle_wavelets.py >/dev/null
for g in avoWells inversionQc angleWavelets; do
  total=$((total + 1))
  if cmp -s "test-data/qi/goldens.$g.json" "$TMP/$g.committed"; then echo "   identical goldens.$g.json"; else echo "   CHANGED   goldens.$g.json"; survivors=$((survivors + 1)); cp "$TMP/$g.committed" "test-data/qi/goldens.$g.json"; fi
done

echo
echo "checked: $total   survivors: $survivors"
[ "$survivors" -eq 0 ]
