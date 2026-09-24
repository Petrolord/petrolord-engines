#!/usr/bin/env bash
# Data & AI D3 negative controls for the electrofacies (cluster.js) gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-cluster.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/dataai/cluster.js alone (or, for the
#           scaler's row noun, in engines/dataai/ml.js alone). All must go RED.
#   ORACLE  plants go in tools/validation/dataai/oracle_cluster.py alone,
#           with the golden regenerated. All must go RED or STOP (the
#           oracle refused to write a golden).
#
#   tools/validation/dataai/negcontrol_cluster.sh [filter]
#
# The last line reports N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/dataai/cluster.js
ML=engines/dataai/ml.js
ORACLE=tools/validation/dataai/oracle_cluster.py
GOLDEN=test-data/dataai/goldens/cluster_cases.json
TEST=__tests__/dataai.cluster.test.js
TMP=$(mktemp -d)
cp "$ENGINE" "$TMP/engine.bak"; cp "$ML" "$TMP/ml.bak"; cp "$ORACLE" "$TMP/oracle.bak"; cp "$GOLDEN" "$TMP/golden.bak"
restore() { cp "$TMP/engine.bak" "$ENGINE"; cp "$TMP/ml.bak" "$ML"; cp "$TMP/oracle.bak" "$ORACLE"; cp "$TMP/golden.bak" "$GOLDEN"; }
trap restore EXIT

plant() { # file from to
  "$PY" - "$1" "$2" "$3" <<'PYEOF'
import sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if s.count(a) != 1:
    sys.stderr.write("PLANT TARGET NOT UNIQUE (%d): %s\n" % (s.count(a), a))
    sys.exit(3)
open(path, "w").write(s.replace(a, b))
PYEOF
}

ENGINE_RUN=0
ENGINE_RED=0

run_case() { # kind name file from to
  kind=$1; name=$2; file=$3; from=$4; to=$5
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  plant "$file" "$from" "$to" || { echo "SKIP  $name (target)"; return; }
  if [ "$kind" = ORACLE ]; then
    if ! "$PY" "$ORACLE" >/dev/null 2>&1; then
      echo "STOP  [$kind] $name -- the oracle refused to write a golden"
      return
    fi
  else
    ENGINE_RUN=$((ENGINE_RUN + 1))
  fi
  out=$(timeout 600 npx jest "$TEST" 2>&1)
  rc=$?
  if [ $rc -eq 124 ]; then
    echo "HANG  [$kind] $name"
    [ "$kind" = ENGINE ] && ENGINE_RED=$((ENGINE_RED + 1))
  elif echo "$out" | grep -q "Tests:.*failed"; then
    n=$(echo "$out" | grep -E "^Tests:" | grep -oE "[0-9]+ failed")
    first=$(echo "$out" | grep -E "^\s+●" | sed 's/^ *● //' | head -1)
    echo "RED   [$kind] $name -- $n -- $first"
    [ "$kind" = ENGINE ] && ENGINE_RED=$((ENGINE_RED + 1))
  else
    echo "GREEN [$kind] $name -- NOT CAUGHT"
  fi
}

E=$ENGINE
echo "=== baseline ==="
restore
npx jest "$TEST" 2>&1 | grep -E "^Tests:"

echo "=== ENGINE plants (all must be RED) ==="
# PCA
run_case ENGINE "correlation PCA standardised with the population SD" $E "const fit = fitStandardScaler({ X, names, sd: 'sample', rowNoun: 'rows passed' });" "const fit = fitStandardScaler({ X, names, rowNoun: 'rows passed' });"
run_case ENGINE "covariance divisor n, not n - 1" $E "S[a][b] = s / (n - 1); S[b][a] = S[a][b];" "S[a][b] = s / n; S[b][a] = S[a][b];"
run_case ENGINE "sign rule flipped (largest loading negative)" $E "return v[lead] < 0 ? v.map((x) => -x) : v;" "return v[lead] > 0 ? v.map((x) => -x) : v;"
run_case ENGINE "sign rule on the FIRST loading, not the largest" $E "while (Math.abs(v[lead]) < mx * (1 - DEFAULTS.SIGN_TIE_REL)) lead += 1;" "while (false) lead += 1;"
run_case ENGINE "Jacobi stops after one sweep" $E "if (rotations === 0) { converged = true; break; }" "if (true) { converged = true; break; }"
run_case ENGINE "eigenvalues sorted ascending" $E "eig.values[b] - eig.values[a] || a - b" "eig.values[a] - eig.values[b] || a - b"
run_case ENGINE "loadings scaled by the eigenvalue, not its square root" $E "loadings: comp.map((v, k) => v.map((x) => x * Math.sqrt(values[k])))," "loadings: comp.map((v, k) => v.map((x) => x * values[k])),"
# k-means
run_case ENGINE "k-means++ first centre floor(u (n - 1))" $E "const picks = [Math.floor(rng() * n)];" "const picks = [Math.floor(rng() * (n - 1))];"
run_case ENGINE "k-means++ weights by D, not D^2" $E "      cum += D2[i];
      if (cum > target) { pick = i; break; }" "      cum += Math.sqrt(D2[i]);
      if (cum > target) { pick = i; break; }"
run_case ENGINE "assignment tie to the HIGHER centre" $E "    let best = 0;
    while (ds[best] > thr) best += 1;" "    let best = k - 1;
    while (ds[best] > thr) best -= 1;"
run_case ENGINE "empty cluster left empty (no relocation)" $E "if (empties.length) {" "if (false) {"
run_case ENGINE "iterations count centre updates, not assignment passes" $E "iterations: best.iterations," "iterations: best.iterations - 1,"
run_case ENGINE "the LAST run wins, not the lowest inertia" $E "if (!best || res.inertia < best.inertia - best.inertia * DEFAULTS.TIE_REL) {" "if (true) {"
run_case ENGINE "each nInit run restarts the seed (identical starts)" $E "const picks = kmeansPP(A, n, p, k, rng);" "const picks = kmeansPP(A, n, p, k, mulberry32(seed));"
run_case ENGINE "clustering scaler on the sample SD" $E "fitStandardScaler({ X, names, rowNoun })" "fitStandardScaler({ X, names, rowNoun, sd: 'sample' })"
# silhouette
run_case ENGINE "a singleton scores 1, not 0" $E "if (size[li] === 1) { values[i] = 0; continue; }" "if (size[li] === 1) { values[i] = 1; continue; }"
run_case ENGINE "a divides by the cluster size, not size - 1" $E "const a = sums[i * K + li] / (size[li] - 1);" "const a = sums[i * K + li] / size[li];"
run_case ENGINE "silhouette on squared distances" $E "      const d = Math.sqrt(s);
      sums[i * K + lab[j]] += d;" "      const d = s;
      sums[i * K + lab[j]] += d;"
# agglomerative
run_case ENGINE "Ward Lance-Williams with + nt d_ab^2" $E "- nt * h * h) / (na + nb + nt)" "+ nt * h * h) / (na + nb + nt)"
run_case ENGINE "average linkage unweighted (WPGMA)" $E "d = (na * dat + nb * dbt) / (na + nb);" "d = (dat + dbt) / 2;"
run_case ENGINE "complete linkage takes the min (single linkage)" $E "if (linkage === 'complete') d = Math.max(dat, dbt);" "if (linkage === 'complete') d = Math.min(dat, dbt);"
run_case ENGINE "merge tie to the HIGHEST ids" $E "if (active[s] && nnd[s] <= thr) { nCand += 1; if (a < 0 || ids[s] < ids[a]) a = s; }" "if (active[s] && nnd[s] <= thr) { nCand += 1; if (a < 0 || ids[s] > ids[a]) a = s; }"
run_case ENGINE "no merge tie band (exact float equality)" $E "const thr = m + m * DEFAULTS.TIE_REL;
    let a = -1;" "const thr = m;
    let a = -1;"
run_case ENGINE "linkage row with the larger id first" $E "Zl.push([Math.min(ids[a], ids[b]), Math.max(ids[a], ids[b]), h, na + nb]);" "Zl.push([Math.max(ids[a], ids[b]), Math.min(ids[a], ids[b]), h, na + nb]);"
run_case ENGINE "new cluster id n + s + 1" $E "ids[keep] = n + step;" "ids[keep] = n + step + 1;"
run_case ENGINE "cut after n - k - 1 merges" $E "for (let s = 0; s < n - k; s += 1) { const nid = n + s;" "for (let s = 0; s < n - k - 1; s += 1) { const nid = n + s;"
run_case ENGINE "row cap off by one (3,001 accepted)" $E "if (n > DEFAULTS.AGGLOMERATIVE_MAX_ROWS) return refuse('X', \`has \${n} rows, above the \${DEFAULTS.AGGLOMERATIVE_MAX_ROWS} agglomerative" "if (n > DEFAULTS.AGGLOMERATIVE_MAX_ROWS + 1) return refuse('X', \`has \${n} rows, above the \${DEFAULTS.AGGLOMERATIVE_MAX_ROWS} agglomerative"
# kNN
run_case ENGINE "vote tie to the label that sorts first (scikit-learn)" $E "if (win === null || c > count.get(win)) { win = lab; tie = false; }" "if (win === null || c > count.get(win) || (c === count.get(win) && lab < win)) { win = lab; tie = false; }"
run_case ENGINE "kNN new rows scaled with their own scaler (the salvage defect)" $E "const B = flat(scaleApply(sf.scaler, Xnew));" "const B = flat(scaleFit(Xnew, scale, names).Z);"
run_case ENGINE "equidistant neighbours to the HIGHER row" $E "if (!taken[z] && cand[z] < cand[pick]) pick = z;" "if (!taken[z] && cand[z] > cand[pick]) pick = z;"
# CART
run_case ENGINE "threshold at the lower value, not the midpoint" $E "let t = a / 2 + b / 2;" "let t = a;"
run_case ENGINE "split tie to the HIGHER feature" $E "            better = lhs > rhs;" "            better = lhs >= rhs;"
run_case ENGINE "zero-decrease split allowed" $E "if (!(lhs > BigInt(parentSq) * BigInt(best.nL) * BigInt(best.nR))) return node.id;" "if (!(lhs >= BigInt(parentSq) * BigInt(best.nL) * BigInt(best.nR))) return node.id;"
run_case ENGINE "majority tie to the class that sorts LAST" $E "for (let c = 1; c < counts.length; c += 1) if (counts[c] > counts[b]) b = c;" "for (let c = 1; c < counts.length; c += 1) if (counts[c] >= counts[b]) b = c;"
run_case ENGINE "minSamplesLeaf ignored" $E "if (nL < minSamplesLeaf || nR < minSamplesLeaf) continue;" "if (false) continue;"
run_case ENGINE "importances not normalised" $E "importance.map((v) => (tot > 0 ? v / tot : 0));" "importance.map((v) => (tot > 0 ? v : 0));"
run_case ENGINE "maxDepth counted from 1" $E "if (pure || depth >= maxDepth ||" "if (pure || depth >= maxDepth - 1 ||"
# foundation findings (PR fix/dataai-cluster-foundation-findings)
run_case ENGINE "pca constant refusal in the old wording (training rows)" $E "fitStandardScaler({ X, names, sd: 'sample', rowNoun: 'rows passed' })" "fitStandardScaler({ X, names, sd: 'sample' })"
run_case ENGINE "clustering standard scaler in the old wording (training rows)" $E "fitStandardScaler({ X, names, rowNoun }) :" "fitStandardScaler({ X, names }) :"
run_case ENGINE "clustering min-max scaler in the old wording (training rows)" $E ": fitMinMaxScaler({ X, names, rowNoun });" ": fitMinMaxScaler({ X, names });"
run_case ENGINE "kNN refusal says rows passed (its rows ARE training rows)" $E "scaleFit(X, scale, names, 'training rows')" "scaleFit(X, scale, names, 'rows passed')"
run_case ENGINE "ml.js standard scaler ignores the row noun" $ML "has zero variance on the \${n} \${rowNoun} (every" "has zero variance on the \${n} training rows (every"
run_case ENGINE "ml.js min-max scaler ignores the row noun" $ML "has zero range on the \${rows.length} \${rowNoun} (every" "has zero range on the \${rows.length} training rows (every"
run_case ENGINE "pca warning overwritten (the last one wins)" $E "if (warnings.length) out.warning = warnings.join('; ');" "if (warnings.length) out.warning = warnings[warnings.length - 1];"
run_case ENGINE "pca warnings in the other order" $E "if (warnings.length) out.warning = warnings.join('; ');" "if (warnings.length) out.warning = [...warnings].reverse().join('; ');"
run_case ENGINE "pca maxSweeps ignored (always 50)" $E "const eig = jacobiEigen(S, maxSweeps);" "const eig = jacobiEigen(S, DEFAULTS.JACOBI_MAX_SWEEPS);"
run_case ENGINE "pca maxSweeps 0 accepted" $E "if (!isInt(maxSweeps) || maxSweeps < 1)" "if (!isInt(maxSweeps) || maxSweeps < 0)"
run_case ENGINE "cutTree id reuse not checked" $E "if (mergedAt.has(id)) return" "if (false) return"
run_case ENGINE "cutTree reuse message names the later step" $E "which linkageMatrix[\${mergedAt.get(id)}] already merged" "which linkageMatrix[\${s}] already merged"
# matching and ARI
run_case ENGINE "one-to-one greedy (first free facies, no optimum)" $E "if (t.M[c][f] + rest === target) {" "if (true) {"
run_case ENGINE "ARI special case scores 0" $E "if (mx - expected === 0) return 1;" "if (mx - expected === 0) return 0;"
run_case ENGINE "ARI expected index over n^2 / 2 pairs" $E "const expected = (sa * sb) / c2(n);" "const expected = (sa * sb) / ((n * n) / 2);"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle k-means++ first draw from n - 1" $O "    picks = [rng.draw(n)]" "    picks = [rng.draw(n - 1)]"
run_case ORACLE "oracle singleton silhouette 1" $O "            s.append(D(0))
            continue" "            s.append(D(1))
            continue"
run_case ORACLE "oracle Ward height without the factor 2" $O "return (2 * D(na * nb) / D(na + nb) * sq(cent[a], cent[b])).sqrt()" "return (D(na * nb) / D(na + nb) * sq(cent[a], cent[b])).sqrt()"
run_case ORACLE "oracle ARI special case 0" $O "    if mx == expected:
        return F(1)" "    if mx == expected:
        return F(0)"
run_case ORACLE "oracle constant rule in the old wording" $O "on the {len(X)} {rows} (every value" "on the {len(X)} training rows (every value"
run_case ORACLE "oracle keeps only the last pca warning" $O "return '; '.join(parts) if parts else None" "return parts[-1] if parts else None"
run_case ORACLE "oracle has no id reuse rule" $O "            if i in first:" "            if False:"

restore
echo "=== restored; verifying clean ==="
npx jest "$TEST" 2>&1 | grep -E "^Tests:"
echo "ENGINE plants red: $ENGINE_RED/$ENGINE_RUN"
