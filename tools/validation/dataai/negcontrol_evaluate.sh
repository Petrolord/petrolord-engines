#!/usr/bin/env bash
# Data & AI D5 negative controls for the applied AI evaluation (evaluate.js) gate.
#
# A gate that restates the formula validates nothing, so every claim in
# FINDINGS-evaluate.md about what this suite catches was produced by running
# this file: each row plants ONE defect, runs the suite, and records whether
# it went red.
#
#   ENGINE  plants go in engines/dataai/evaluate.js alone. All must go RED.
#   ORACLE  plants go in tools/validation/dataai/oracle_evaluate.py alone,
#           with the golden regenerated. All must go RED or STOP (the
#           oracle refused to write a golden).
#
#   tools/validation/dataai/negcontrol_evaluate.sh [filter]
#
# It edits the working tree and restores it on exit: do not stage or commit
# while it runs. The last line reports N/N engine plants red.
set -u
cd "$(dirname "$0")/../../.." || exit 1
PY=${PY:-python3}
FILTER=${1:-}
ENGINE=engines/dataai/evaluate.js
ORACLE=tools/validation/dataai/oracle_evaluate.py
GOLDEN=test-data/dataai/goldens/evaluate_cases.json
TEST=__tests__/dataai.evaluate.test.js
TMP=$(mktemp -d)
cp "$ENGINE" "$TMP/engine.bak"; cp "$ORACLE" "$TMP/oracle.bak"; cp "$GOLDEN" "$TMP/golden.bak"
restore() { cp "$TMP/engine.bak" "$ENGINE"; cp "$TMP/oracle.bak" "$ORACLE"; cp "$TMP/golden.bak" "$GOLDEN"; }
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
ORACLE_RUN=0
ORACLE_CAUGHT=0

run_case() { # kind name file from to
  kind=$1; name=$2; file=$3; from=$4; to=$5
  [ -n "$FILTER" ] && case "$name" in *"$FILTER"*) ;; *) return ;; esac
  restore
  plant "$file" "$from" "$to" || { echo "SKIP  $name (target)"; return; }
  if [ "$kind" = ORACLE ]; then
    ORACLE_RUN=$((ORACLE_RUN + 1))
    if ! "$PY" "$ORACLE" >/dev/null 2>&1; then
      echo "STOP  [$kind] $name -- the oracle refused to write a golden"
      ORACLE_CAUGHT=$((ORACLE_CAUGHT + 1))
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
    [ "$kind" = ORACLE ] && ORACLE_CAUGHT=$((ORACLE_CAUGHT + 1))
  elif echo "$out" | grep -qE "Tests:.*failed|Test suite failed to run"; then
    n=$(echo "$out" | grep -E "^Tests:" | grep -oE "[0-9]+ failed")
    first=$(echo "$out" | grep -E "^\s+●" | sed 's/^ *● //' | head -1)
    echo "RED   [$kind] $name -- ${n:-suite failed} -- $first"
    [ "$kind" = ENGINE ] && ENGINE_RED=$((ENGINE_RED + 1))
    [ "$kind" = ORACLE ] && ORACLE_CAUGHT=$((ORACLE_CAUGHT + 1))
  else
    echo "GREEN [$kind] $name -- NOT CAUGHT"
  fi
}

E=$ENGINE
echo "=== baseline ==="
restore
npx jest "$TEST" 2>&1 | grep -E "^Tests:"

echo "=== ENGINE plants (all must be RED) ==="
# tokens and the stop list
run_case ENGINE "no lowercasing" $E "const lowerAscii = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());" "const lowerAscii = (s) => s;"
run_case ENGINE "digits split off (letters only)" $E "const t = lowerAscii(s).split(/[^a-z0-9]+/)" "const t = lowerAscii(s).split(/[^a-z]+/)"
run_case ENGINE "stop list always on" $E "  return stopWords ? t.filter((w) => !STOP.has(w)) : t;" "  return t.filter((w) => !STOP.has(w));"
run_case ENGINE "stop list without 'well'" $E "'we', 'well', 'were'" "'we', 'were'"
# BM25
run_case ENGINE "BM25 Robertson idf without the 1 +" $E "return Math.log(1 + (index.N - d + 0.5) / (d + 0.5));" "return Math.log((index.N - d + 0.5) / (d + 0.5));"
run_case ENGINE "BM25 score without (k1 + 1)" $E "scores[i] += (idf * f * (k1 + 1))" "scores[i] += (idf * f)"
run_case ENGINE "BM25 b and 1 - b swapped" $E "scores[i] += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * index.lengths[i]) / setup.avgdl));" "scores[i] += (idf * f * (k1 + 1)) / (f + k1 * (b + ((1 - b) * index.lengths[i]) / setup.avgdl));"
run_case ENGINE "avgdl over N + 1" $E "const avgdl = index.total / index.N;" "const avgdl = index.total / (index.N + 1);"
run_case ENGINE "repeated query words counted" $E "tokensOf(text, stopWords).forEach((w) => { if (!seen.has(w)) { seen.add(w); out.push(w); } });" "tokensOf(text, stopWords).forEach((w) => { out.push(w); });"
run_case ENGINE "document length before the stop list" $E "const lengths = toks.map((t) => t.length);" "const lengths = documents.map((d) => tokensOf(d.text, false).length);"
# TF-IDF
run_case ENGINE "idf not smoothed" $E "Math.log((1 + index.N) / (1 + index.df.get(w))) + 1" "Math.log(index.N / index.df.get(w)) + 1"
run_case ENGINE "idf without the + 1" $E "Math.log((1 + index.N) / (1 + index.df.get(w))) + 1" "Math.log((1 + index.N) / (1 + index.df.get(w)))"
run_case ENGINE "document vectors not normalised" $E "terms.forEach((w, j) => weights.set(w, raw[j] / norm));" "terms.forEach((w, j) => weights.set(w, raw[j]));"
run_case ENGINE "sublinear tf ignored" $E "const tw = (f) => (sublinearTf ? 1 + Math.log(f) : f);" "const tw = (f) => f;"
run_case ENGINE "sublinear tf as ln(1 + tf)" $E "const tw = (f) => (sublinearTf ? 1 + Math.log(f) : f);" "const tw = (f) => (sublinearTf ? Math.log(1 + f) : f);"
run_case ENGINE "query vector not normalised" $E "return { terms, weights: new Map(terms.map((w, j) => [w, raw[j] / norm])), counts };" "return { terms, weights: new Map(terms.map((w, j) => [w, raw[j]])), counts };"
# ranking
run_case ENGINE "ties to the id DESCENDING" $E "idx.sort((a, b) => (key.get(b) - key.get(a)) || cmpStr(ids[a], ids[b]));" "idx.sort((a, b) => (key.get(b) - key.get(a)) || cmpStr(ids[b], ids[a]));"
run_case ENGINE "ties at 6 significant digits" $E "TIE_DIGITS: 12," "TIE_DIGITS: 6,"
run_case ENGINE "zero-score documents ranked" $E "for (let i = 0; i < scores.length; i += 1) if (scores[i] > 0) idx.push(i);" "for (let i = 0; i < scores.length; i += 1) if (scores[i] >= 0) idx.push(i);"
run_case ENGINE "tie at the cutoff never reported" $E "const tieAtCutoff = idx.length > k && key.get(idx[k]) === key.get(idx[k - 1]);" "const tieAtCutoff = false;"
# retrieval metrics
run_case ENGINE "P@k over the documents ranked" $E "    precision: hits / k," "    precision: hits / Math.max(1, top.length),"
run_case ENGINE "DCG discount log2(i + 2)" $E "dcg += G(g) / Math.log2(i + 1);" "dcg += G(g) / Math.log2(i + 2);"
run_case ENGINE "ideal DCG from the ranked documents only" $E "const ideal = grades.slice().sort((a, b) => b - a).slice(0, k);" "const ideal = top.map((id) => (own(judgments, id) ? judgments[id] : 0)).sort((a, b) => b - a);"
run_case ENGINE "AP over min(k, relevant)" $E "averagePrecision: nRel ? apSum / nRel : null," "averagePrecision: nRel ? apSum / Math.min(k, nRel) : null,"
run_case ENGINE "relevant strictly above the grade" $E "if (g >= t) { hits += 1;" "if (g > t) { hits += 1;"
run_case ENGINE "exponential gain 2^g (no - 1)" $E "(g) => 2 ** g - 1" "(g) => 2 ** g"
run_case ENGINE "no-relevant query kept in the means by default" $E "if (noRelevant === 'zero') used.push(r);" "used.push(r);"
# answers
run_case ENGINE "articles kept" $E "t = o.replace(/\\b(a|an|the)\\b/g, ' ');" "t = o;"
run_case ENGINE "punctuation kept" $E "for (let i = 0; i < t.length; i += 1) if (!PUNCT.has(t[i])) o += t[i];" "for (let i = 0; i < t.length; i += 1) o += t[i];"
run_case ENGINE "F1 on token sets, not multisets" $E "pt.forEach((w) => { const n = c.get(w) || 0; if (n > 0) { common += 1; c.set(w, n - 1); } });" "pt.forEach((w) => { if (c.has(w)) common += 1; });"
run_case ENGINE "two empty answers score F1 0" $E "return { f1: pt.length === tt.length ? 1 : 0, precision: null" "return { f1: 0, precision: null"
# extraction
run_case ENGINE "numeric tolerance exclusive" $E "if (d <= tol) return { ...cell, outcome: 'correct', difference: d };" "if (d < tol) return { ...cell, outcome: 'correct', difference: d };"
run_case ENGINE "relTol on the prediction" $E "(f.relTol || 0) * Math.abs(label)" "(f.relTol || 0) * Math.abs(x)"
run_case ENGINE "both empty scored missed" $E "if (le && pe) return { ...cell, outcome: 'correct', empty: true," "if (le && pe) return { ...cell, outcome: 'missed', empty: true,"
run_case ENGINE "unsupported scored wrong" $E "if (le) return { ...cell, outcome: 'unsupported'" "if (le) return { ...cell, outcome: 'wrong'"
run_case ENGINE "macro F1 is the micro F1" $E "macroF1: macroOf(perField.map((f) => f.f1))" "macroF1: overall.f1"
run_case ENGINE "extraction F1 null counted as 0 in the macro" $E "const macroOf = (xs) => { const v = xs.filter((x) => x !== null); return v.length ? mean(v) : null; };" "const macroOf = (xs) => mean(xs.map((x) => x || 0));"
run_case ENGINE "numeric strings with thousands commas unread" $E "NUMBER_STRING.test(v.trim()) ? Number(v.trim().replace(/,/g, '')) : null" "NUMBER_STRING.test(v.trim()) ? Number(v.trim()) : null"
# groundedness
run_case ENGINE "identifier numbers counted as claims" $E "    if (isAlpha(p)) continue;" "    if (false) continue;"
run_case ENGINE "any corpus passage supports a claim" $E "  const eligible = citationStatus.filter((c) => c.status === 'ok').map((c) => c.id);" "  const eligible = [...factsById.keys()];"
run_case ENGINE "unretrieved citations support claims" $E "status: !factsById.has(id) ? 'unknown' : retrievedSet && !retrievedSet.has(id) ? 'notRetrieved' : 'ok'" "status: !factsById.has(id) ? 'unknown' : 'ok'"
run_case ENGINE "numeric match strict (equal values unsupported)" $E "return facts.numbers.some((v) => Math.abs(claim.value - v) <= relTol * Math.abs(v));" "return facts.numbers.some((v) => Math.abs(claim.value - v) < relTol * Math.abs(v));"
run_case ENGINE "dates not read (split into numbers)" $E "    if (isAlnum(text[a - 1]) || isAlnum(text[e])) continue;
    out.push({ kind: 'date'" "    continue;
    out.push({ kind: 'date'"
run_case ENGINE "quotes matched as character substrings" $E "  if (claim.kind === 'quote') return hasRun(facts.tokens, claim.value.split(' '));" "  if (claim.kind === 'quote') return facts.tokens.join(' ').includes(claim.value);"
run_case ENGINE "minus sign ignored" $E "const neg = p === '-' && !isAlnum(s[a - 2]);" "const neg = false;"
run_case ENGINE "comma groups of more than three digits" $E "const NUM_RE = /\\d+(?:,\\d{3}(?!\\d))*(?:\\.\\d+)?/g;" "const NUM_RE = /\\d+(?:,\\d{3})*(?:\\.\\d+)?/g;"
# kappa
run_case ENGINE "linear weights quadratic" $E "weights === 'linear' ? Math.abs(i - j) : (i - j) ** 2" "weights === 'linear' ? (i - j) ** 2 : (i - j) ** 2"
run_case ENGINE "expected counts over n - 1" $E "den += (w(i, j) * row[i] * col[j]) / n;" "den += (w(i, j) * row[i] * col[j]) / (n - 1);"
run_case ENGINE "numeric labels sorted as strings" $E "L = [...new Set([...a, ...b])].sort(kind === 'number' ? (x, y) => x - y : cmpStr);" "L = [...new Set([...a, ...b])].sort();"
# calibration
run_case ENGINE "edge value in the lower bin (scikit-learn rule)" $E "  let i = Math.min(M - 1, Math.floor(p * M));
  if (i > 0 && p < i / M) i -= 1;
  else if (i < M - 1 && p >= (i + 1) / M) i += 1;" "  let i = Math.min(M - 1, Math.max(0, Math.ceil(p * M) - 1));"
run_case ENGINE "last bin open at 1" $E "  let i = Math.min(M - 1, Math.floor(p * M));" "  let i = Math.floor(p * M);"
run_case ENGINE "ECE unweighted over bins" $E "ece += (js.length / N) * gap;" "ece += gap / M;"
run_case ENGINE "WBC without the factor 2" $E "const withinBinCovariance = (2 * wbc) / N;" "const withinBinCovariance = wbc / N;"
run_case ENGINE "WBC doubled (4 wbc / N)" $E "const withinBinCovariance = (2 * wbc) / N;" "const withinBinCovariance = (4 * wbc) / N;"
run_case ENGINE "WBC halved and the identity rewritten as - 2 WBC" $E "const withinBinVariance = wbv / N; const withinBinCovariance = (2 * wbc) / N;
  const sum = reliability - resolution + uncertainty + withinBinVariance - withinBinCovariance;" "const withinBinVariance = wbv / N; const withinBinCovariance = wbc / N;
  const sum = reliability - resolution + uncertainty + withinBinVariance - 2 * withinBinCovariance;"
run_case ENGINE "resolution about 0.5" $E "res += js.length * (ok - obar) ** 2;" "res += js.length * (ok - 0.5) ** 2;"
run_case ENGINE "Brier over N - 1" $E "  brier /= N;" "  brier /= N - 1 || 1;"
run_case ENGINE "eps not passed to ml.js logLoss" $E "const ll = logLoss(eps === undefined ? { yTrue, probabilities } : { yTrue, probabilities, eps });" "const ll = logLoss({ yTrue, probabilities });"
# bootstrap
run_case ENGINE "bootstrap draw floor(u (n - 1))" $E "for (let i = 0; i < n; i += 1) s += values[Math.floor(rng() * n)];" "for (let i = 0; i < n; i += 1) s += values[Math.floor(rng() * (n - 1))];"
run_case ENGINE "interval tails at 1 - level, not half" $E "const tails = (level) => { const lo = Math.round(((1 - level) / 2) * 1e12) / 1e12;" "const tails = (level) => { const lo = Math.round((1 - level) * 1e12) / 1e12;"
run_case ENGINE "paired draws a and b separately" $E "      for (let i = 0; i < n; i += 1) s += d[Math.floor(rng() * n)];" "      for (let i = 0; i < n; i += 1) s += a[Math.floor(rng() * n)] - b[Math.floor(rng() * n)];"
run_case ENGINE "standard error with divisor nBoot" $E "standardError: B > 1 ? Math.sqrt(ss / (B - 1)) : null," "standardError: B > 1 ? Math.sqrt(ss / B) : null,"
run_case ENGINE "share strictly below zero" $E "if (v <= 0) atOrBelow += 1;" "if (v < 0) atOrBelow += 1;"
run_case ENGINE "a fresh stream per replicate" $E "  const rng = mulberry32(seed);
  const reps = new Float64Array(nBoot);
  for (let r = 0; r < nBoot; r += 1) {
    let s = 0;" "  const reps = new Float64Array(nBoot);
  for (let r = 0; r < nBoot; r += 1) {
    const rng = mulberry32(seed + r);
    let s = 0;"
# messages are course content: each changed wording must go red
run_case ENGINE "nDCG note: empty judgments worded as all grades 0" $E "      ? 'nDCG is undefined: the query has no judged documents, so the ideal DCG is 0'" "      ? 'nDCG is undefined: every judged grade is 0, so the ideal DCG is 0'"
run_case ENGINE "k refusal in other words" $E "refuse('k', \`must be a whole number from 1 to \${DEFAULTS.MAX_K}\`)" "refuse('k', \`must be between 1 and \${DEFAULTS.MAX_K}\`)"
run_case ENGINE "kappa undefined note in other words" $E "so the expected disagreement is 0\`;" "so kappa cannot be computed\`;"
run_case ENGINE "groundedness reason drops 'cited but not retrieved'" $E "reason += \`; it appears in \${listIds(cnr)}, cited but not retrieved\`;" "reason += \`; it appears in \${listIds(cnr)}\`;"
run_case ENGINE "excluded-query reason in other words" $E "excluded.push({ query: r.query, reason: \`no judged document has grade \${relevantGrade} or more\` });" "excluded.push({ query: r.query, reason: 'no relevant document' });"
run_case ENGINE "plain-number reason in other words" $E "is not a plain number (digits with optional comma thousands groups and a decimal part)\` };" "is not a number\` };"
run_case ENGINE "'1 ratings' (no singular)" $E "refuse('b', \`must be an array of \${plural(a.length, 'rating')}, one per item of a\`)" "refuse('b', \`must be an array of \${a.length} ratings, one per item of a\`)"

echo "=== ORACLE plants (RED or STOP: the control on the controls) ==="
O=$ORACLE
run_case ORACLE "oracle BM25 idf without the 1 +" $O "    idf = {w: (D(1) + dfrac((N - df[w] + F(1, 2)) / (df[w] + F(1, 2)))).ln() for w in terms}" "    idf = {w: (dfrac((N - df[w] + F(1, 2)) / (df[w] + F(1, 2)))).ln() for w in terms}"
run_case ORACLE "oracle DCG discount log2(i + 2)" $O "        dcg += D(G(g)) / log2d(i + 1)" "        dcg += D(G(g)) / log2d(i + 2)"
run_case ORACLE "oracle linear kappa quadratic" $O "        return abs(i - j) if weights == 'linear' else (i - j) ** 2" "        return (i - j) ** 2"
run_case ORACLE "oracle WBC without the factor 2" $O "    C = 2 * wbc / N" "    C = wbc / N"
run_case ORACLE "oracle WBC doubled" $O "    C = 2 * wbc / N" "    C = 4 * wbc / N"
run_case ORACLE "oracle WBC halved and the identity as - 2 WBC" $O "    C = 2 * wbc / N
    total = R - S + U + V - C" "    C = wbc / N
    total = R - S + U + V - 2 * C"
run_case ORACLE "oracle bootstrap draws from n - 1" $O "        reps.append(sum(fv[rng.draw(n)] for _ in range(n)) / n)" "        reps.append(sum(fv[rng.draw(n - 1)] for _ in range(n)) / n)"
run_case ORACLE "oracle SQuAD keeps articles" $O "            out.append(' ' if w in ('a', 'an', 'the') else w)" "            out.append(w)"

restore
echo "=== restored; verifying clean ==="
npx jest "$TEST" 2>&1 | grep -E "^Tests:"
echo "ORACLE plants caught: $ORACLE_CAUGHT/$ORACLE_RUN"
echo "ENGINE plants red: $ENGINE_RED/$ENGINE_RUN"
