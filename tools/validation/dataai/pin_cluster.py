#!/usr/bin/env python3
"""Second-witness pins for engines/dataai/cluster.js (Data & AI D3).

Needs numpy, scipy and scikit-learn (the library witness, NOT the stdlib
oracle):

    /root/daienv/bin/python tools/validation/dataai/pin_cluster.py

It reads the INPUTS of the golden cases (and, for k-means, the oracle's
chosen starting centres: k-means++ draws come from mulberry32, which no
library shares) and writes test-data/dataai/pins/cluster_pins.json. A
library result is pinned only where it agrees with the oracle (numbers to
1e-2 relative, labels exactly); every disagreement is listed in `skipped`
with its reason, and FINDINGS-cluster.md explains each convention
difference. Each numeric pin's tolerance is max(1e-10, 10 x the library's
own disagreement with the oracle), rounded up to a power of ten.

Mappings stated once:
  scaling      StandardScaler (population SD) / MinMaxScaler / none, fitted
               on the rows clustered (kNN: the training rows).
  PCA          covariance: PCA(svd_solver='full') on the raw rows (its
               explained_variance_ has divisor n - 1). correlation: numpy
               eigh of np.corrcoef for the eigenvalues, and PCA on the
               StandardScaler rows for ratios and components; its scores are
               the engine's x sqrt(n / (n - 1)) (population against sample
               SD), divided out here. scikit-learn flips each component so
               its largest absolute loading is positive, the engine's rule.
  k-means      KMeans(init = the oracle's starting centres, n_init = 1,
               algorithm = 'lloyd', tol = 0, max_iter); labels, inertia_,
               cluster_centers_, n_iter_.
  silhouette   silhouette_samples / silhouette_score, euclidean.
  hierarchy    scipy.cluster.hierarchy.linkage(method) (whole matrix when
               the tree is tie-free, merge heights sorted always),
               cut_tree(n_clusters = k), and sklearn AgglomerativeClustering;
               partitions compared with clusters renumbered by first row.
  kNN          KNeighborsClassifier(algorithm = 'brute', weights = 'uniform').
  CART         DecisionTreeClassifier(criterion = 'gini', random_state = 0,
               max_depth, min_samples_leaf, min_samples_split); scikit-learn
               casts X to float32, so thresholds agree to about 1e-7.
  ARI          adjusted_rand_score; matching optimum by
               scipy.optimize.linear_sum_assignment.
"""
import json
import math
import os

# one thread: scikit-learn KMeans sums inertia in OpenMP chunks, and the
# last bit then depends on the thread count (regeneration must be byte-identical)
os.environ.setdefault('OMP_NUM_THREADS', '1')

import numpy as np
import scipy
import sklearn
from scipy.cluster.hierarchy import cut_tree, linkage as sp_linkage
from scipy.optimize import linear_sum_assignment
from sklearn.cluster import AgglomerativeClustering, KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import adjusted_rand_score, silhouette_samples
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import MinMaxScaler, StandardScaler
from sklearn.tree import DecisionTreeClassifier

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', '..')
GOLD = os.path.join(ROOT, 'test-data', 'dataai', 'goldens', 'cluster_cases.json')
DEST = os.path.join(ROOT, 'test-data', 'dataai', 'pins', 'cluster_pins.json')
TOL = 1e-10


def up10(x):
    return 10.0 ** math.ceil(math.log10(x)) if x > 0 else 0.0


def get(obj, dotted):
    for k in dotted.split('.'):
        obj = obj[int(k)] if isinstance(obj, list) else obj[k]
    return obj


def canonical(labels):
    m = {}
    return [m.setdefault(v, len(m)) for v in labels]


def flat(v):
    if isinstance(v, list):
        return [x for e in v for x in flat(e)]
    return [v]


def scaled(X, scale):
    X = np.array(X, dtype=float)
    if scale == 'standard':
        s = StandardScaler().fit(X)
        return s.transform(X), s
    if scale == 'minmax':
        s = MinMaxScaler().fit(X)
        return s.transform(X), s
    return X, None


def main():
    G = json.load(open(GOLD))
    by_id = {c['id']: c for c in G['cases']}
    pins, skipped, worst = [], [], {}

    def pin(case, field, value, lib, expected=None, transform=None):
        value = value.tolist() if hasattr(value, 'tolist') else value
        exp = get(case['expected'], field) if expected is None else expected
        fv, fe = flat(value), flat(exp)
        if len(fv) != len(fe):
            skipped.append([case['id'], field, lib, f'shape {len(fv)} vs {len(fe)}'])
            return
        rel = ab = 0.0
        for v, e in zip(fv, fe):
            if isinstance(e, (bool, str)) or e is None or isinstance(v, str):
                if v != e:
                    skipped.append([case['id'], field, lib, 'labels differ from the oracle (a convention difference, see FINDINGS)'])
                    return
                continue
            if abs(e) < 1e-12:  # an exact zero the oracle printed with rounding
                ab = max(ab, abs(v - e))
            else:
                rel = max(rel, abs(v - e) / abs(e))
        if rel > 1e-2 or ab > 1e-6:
            skipped.append([case['id'], field, lib, f'library off by {rel:.2g} relative ({ab:.2g} absolute): no witness'])
            return
        worst[case['fn']] = max(worst.get(case['fn'], 0.0), rel)
        pid = f"{case['id']}:{field}"
        k = 2
        while any(p['id'] == pid for p in pins):
            pid = f"{case['id']}:{field}#{k}"
            k += 1
        entry = {'id': pid, 'case': case['id'], 'field': field, 'value': value, 'tol': max(TOL, up10(10 * rel)), 'witness': lib}
        if ab > 0:
            entry['abs'] = max(1e-12, up10(10 * ab))
        if transform:
            entry['transform'] = transform
        pins.append(entry)

    for c in G['cases']:
        e, a, fn = c['expected'], c['args'], c['fn']
        if isinstance(e, dict) and e.get('error'):
            continue
        if fn == 'pca':
            X = np.array(a['X'], dtype=float)
            n, p = X.shape
            q = a.get('nComponents', p)
            if a.get('matrix', 'correlation') == 'covariance':
                m = PCA(n_components=q, svd_solver='full').fit(X)
                if 'eigenvalues' in e and 'explainedVariance' not in e:
                    pin(c, 'eigenvalues', np.linalg.eigvalsh(np.cov(X.T))[::-1], 'numpy eigvalsh of cov (divisor n - 1)')
                if 'explainedVariance' in e:
                    pin(c, 'explainedVariance', m.explained_variance_, 'sklearn PCA explained_variance_')
                if 'explainedVarianceRatio' in e:
                    pin(c, 'explainedVarianceRatio', m.explained_variance_ratio_, 'sklearn PCA explained_variance_ratio_')
                if 'components' in e:
                    pin(c, 'components', m.components_, 'sklearn PCA components_ (svd_flip: largest |loading| positive)')
                if 'scores' in e:
                    pin(c, 'scores', m.transform(X), 'sklearn PCA transform')
            else:
                w = np.linalg.eigh(np.corrcoef(X.T))[0][::-1]
                pin(c, 'eigenvalues', w, 'numpy eigh of corrcoef')
                Z = StandardScaler().fit_transform(X)
                m = PCA(n_components=q, svd_solver='full').fit(Z)
                pin(c, 'explainedVarianceRatio', m.explained_variance_ratio_, 'sklearn PCA on StandardScaler rows')
                # the warning cases pin eigenvalues and ratios only: their components are not unique
                if 'components' in e:
                    pin(c, 'components', m.components_, 'sklearn PCA components_ on StandardScaler rows')
                if 'scores' in e:
                    pin(c, 'scores', m.transform(Z) * math.sqrt((n - 1) / n), 'sklearn PCA transform x sqrt((n - 1) / n)')
        elif fn == 'pcaTransform':
            fa = a['model']['args']
            X = np.array(fa['X'], dtype=float)
            n = len(X)
            s = StandardScaler().fit(X)
            m = PCA(n_components=fa.get('nComponents', X.shape[1]), svd_solver='full').fit(s.transform(X))
            pin(c, 'scores', m.transform(s.transform(np.array(a['X'], dtype=float))) * math.sqrt((n - 1) / n), 'sklearn PCA transform x sqrt((n - 1) / n)')
        elif fn == 'kmeans':
            Z, _ = scaled(a['X'], a.get('scale', 'standard'))
            km = KMeans(n_clusters=a['k'], init=np.array(e['initialCentres']), n_init=1, algorithm='lloyd', tol=0.0,
                        max_iter=a.get('maxIter', 300)).fit(Z)
            pin(c, 'labels', [int(v) for v in km.labels_], 'sklearn KMeans(init = oracle start) labels_')
            pin(c, 'inertia', float(km.inertia_), 'sklearn KMeans inertia_')
            pin(c, 'centres', km.cluster_centers_, 'sklearn KMeans cluster_centers_')
            pin(c, 'iterations', int(km.n_iter_), 'sklearn KMeans n_iter_')
        elif fn == 'assignClusters':
            fa = a['model']['args']
            ref = next(x for x in G['cases'] if x['fn'] == 'kmeans' and x['args'] == fa)
            Z, s = scaled(fa['X'], fa.get('scale', 'standard'))
            km = KMeans(n_clusters=fa['k'], init=np.array(ref['expected']['centres']), n_init=1, max_iter=1).fit(Z)
            km.cluster_centers_ = np.array(ref['expected']['centres'])
            Xn = np.array(a['X'], dtype=float)
            pin(c, 'labels', [int(v) for v in km.predict(s.transform(Xn) if s else Xn)], 'sklearn KMeans.predict with the fitted centres')
        elif fn == 'silhouette':
            Z, _ = scaled(a['X'], a.get('scale', 'standard'))
            lab = np.array(a['labels'])
            if e.get('rows'):
                Z, lab = Z[e['rows']], lab[e['rows']]
            v = silhouette_samples(Z, lab, metric='euclidean')
            pin(c, 'values', v, 'sklearn silhouette_samples')
            pin(c, 'mean', float(v.mean()), 'sklearn silhouette_score')
        elif fn == 'agglomerative':
            Z, _ = scaled(a['X'], a.get('scale', 'standard'))
            lk = a.get('linkage', 'ward')
            L = sp_linkage(Z, method=lk, metric='euclidean')
            pin(c, 'heights', sorted(L[:, 2].tolist()), f'scipy linkage({lk}) heights, sorted', transform='sortedHeights',
                expected=sorted(e['heights']))
            if e.get('tiedSteps') == 0:
                pin(c, 'linkageMatrix', [[int(r[0]), int(r[1]), float(r[2]), int(r[3])] for r in L], f'scipy linkage({lk})')
            if 'k' in a:
                pin(c, 'labels', canonical(cut_tree(L, n_clusters=a['k']).ravel().tolist()), 'scipy cut_tree, renumbered by first row', transform='canonical')
                sk = AgglomerativeClustering(n_clusters=a['k'], linkage=lk).fit(Z)
                pin(c, 'labels', canonical(sk.labels_.tolist()), 'sklearn AgglomerativeClustering, renumbered by first row', transform='canonical')
        elif fn == 'cutTree':
            L = np.array(a['linkageMatrix'], dtype=float)
            pin(c, 'labels', canonical(cut_tree(L, n_clusters=a['k']).ravel().tolist()), 'scipy cut_tree, renumbered by first row', transform='canonical')
        elif fn == 'knnClassify':
            Z, s = scaled(a['X'], a.get('scale', 'standard'))
            Xn = np.array(a['Xnew'], dtype=float)
            kn = KNeighborsClassifier(n_neighbors=a.get('k', 5), algorithm='brute').fit(Z, a['y'])
            pin(c, 'predictions', [v.item() if hasattr(v, 'item') else v for v in kn.predict(s.transform(Xn) if s else Xn)], 'sklearn KNeighborsClassifier(brute)')
        elif fn == 'cartFit':
            if a.get('maxDepth', 5) == 0:
                skipped.append([c['id'], 'all', 'sklearn DecisionTreeClassifier', 'max_depth must be 1 or more in scikit-learn; the engine allows 0 (a single leaf)'])
                continue
            X = np.array(a['X'], dtype=float)
            dt = DecisionTreeClassifier(criterion='gini', random_state=0, max_depth=a.get('maxDepth', 5),
                                        min_samples_leaf=a.get('minSamplesLeaf', 1), min_samples_split=a.get('minSamplesSplit', 2)).fit(X, a['y'])
            pin(c, 'trainingPredictions', [v.item() if hasattr(v, 'item') else v for v in dt.predict(X)], 'sklearn DecisionTreeClassifier predict (training rows)')
            pin(c, 'featureImportances', dt.feature_importances_, 'sklearn feature_importances_')
            pin(c, 'nLeaves', int(dt.get_n_leaves()), 'sklearn get_n_leaves')
            t = dt.tree_
            thr = [float(t.threshold[i]) for i in range(t.node_count) if t.children_left[i] != -1]
            pin(c, 'thresholds', thr, 'sklearn tree_.threshold (float32 X)', expected=[nd['threshold'] for nd in e['nodes'] if not nd['leaf']])
        elif fn == 'cartPredict':
            fa = a['model']['args']
            X = np.array(fa['X'], dtype=float)
            dt = DecisionTreeClassifier(criterion='gini', random_state=0, max_depth=fa.get('maxDepth', 5),
                                        min_samples_leaf=fa.get('minSamplesLeaf', 1), min_samples_split=fa.get('minSamplesSplit', 2)).fit(X, fa['y'])
            pin(c, 'predictions', [v.item() if hasattr(v, 'item') else v for v in dt.predict(np.array(a['X'], dtype=float))], 'sklearn DecisionTreeClassifier predict')
        elif fn == 'adjustedRandIndex':
            pin(c, 'ari', float(adjusted_rand_score(a['a'], a['b'])), 'sklearn adjusted_rand_score')
        elif fn == 'matchClusters':
            pin(c, 'ari', float(adjusted_rand_score(a['yTrue'], a['clusters'])), 'sklearn adjusted_rand_score')
            if a.get('mode', 'one-to-one') == 'one-to-one':
                M = np.array(e['contingency'])
                r, q = linear_sum_assignment(-M)
                pin(c, 'matchedRows', int(M[r, q].sum()), 'scipy linear_sum_assignment optimum')
        # elbow is a composition of kmeans and silhouette calls, witnessed there

    # thresholds are not an engine field: they are read from the nodes
    for p in pins:
        if p['field'] == 'thresholds':
            p['field'] = 'nodes'
            p['transform'] = 'splitThresholds'
    out = {
        'generatedBy': 'tools/validation/dataai/pin_cluster.py',
        'versions': {'numpy': np.__version__, 'scipy': scipy.__version__, 'scikit-learn': sklearn.__version__},
        'pins': pins,
        'skipped': skipped,
    }
    with open(DEST, 'w') as fh:
        json.dump(out, fh, indent=1, allow_nan=False)
        fh.write('\n')
    print('wrote', os.path.relpath(DEST), len(pins), 'pins,', len(skipped), 'skipped')
    for fn, w in sorted(worst.items()):
        print(f'  {fn:20s} worst relative disagreement with the oracle {w:.2g}')
    for s in skipped:
        print('  SKIPPED', *s)


if __name__ == '__main__':
    main()
