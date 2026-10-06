"""Independent oracle for engines/petrophysics/logEdit.js (QI programme Q1, A3).

Synthetic well: depth 1000 to 2000 m every 0.5 m; the TRUE sonic is linear in
depth (400 - 0.08 (z - 1000) us/m), so the trapezoid rule integrates it
exactly and checkshot times follow in closed form. The RECORDED sonic adds
bias blocks (+6 us/m over 1100 to 1400 m, -4 us/m over 1600 to 1900 m). The
drift at each level is then minus the trapezoid integral of the bias, known
exactly (anchors D1 to D5). Splice and edit cases are small and exact.
Standard library only; main() asserts the anchors, then writes
test-data/petrophysics/goldens.logEdit.json.
"""
import json
import math
import os

Z = [1000 + 0.5 * i for i in range(2001)]


def true_dt(z):
    return 400 - 0.08 * (z - 1000)


def bias(z):
    if 1100 <= z < 1400:
        return 6.0
    if 1600 <= z < 1900:
        return -4.0
    return 0.0


def owt_true(z):  # exact integral of the linear true sonic from 1000 m, plus 0.35 s at 1000 m
    d = z - 1000
    return 0.35 + (400 * d - 0.04 * d * d) * 1e-6


def trapz_time(z, dt):
    t = [0.0]
    for i in range(1, len(z)):
        t.append(t[-1] + 0.5 * (dt[i - 1] + dt[i]) * (z[i] - z[i - 1]) * 1e-6)
    return t


def interp(z, y, q):
    for i in range(1, len(z)):
        if z[i] >= q:
            f = (q - z[i - 1]) / (z[i] - z[i - 1])
            return y[i - 1] + f * (y[i] - y[i - 1])
    return float('nan')


LEVELS = [1000, 1250, 1500, 1750, 2000]


def drift_correct(z, dt, shots):
    t = trapz_time(z, dt)
    t0 = interp(z, t, shots[0][0])
    table = []
    for md, owt in shots:
        s = shots[0][1] + interp(z, t, md) - t0
        table.append((md, owt, s, (owt - s) * 1e3))
    out = list(dt)
    corr = []
    for k in range(len(table) - 1):
        a, b = table[k], table[k + 1]
        c = (b[3] - a[3]) * 1e3 / (b[0] - a[0])
        corr.append((a[0], b[0], c))
        last = k + 2 == len(table)
        for i, zz in enumerate(z):
            if (a[0] <= zz < b[0]) or (last and a[0] <= zz <= b[0]):
                out[i] += c
    return out, table, corr


def close(a, b, tol):
    return abs(a - b) <= tol


def anchors():
    shots = [(m, owt_true(m)) for m in LEVELS]
    # D1 the true sonic integrates exactly to the checkshots: zero drift
    _, table, _ = drift_correct(Z, [true_dt(z) for z in Z], shots)
    assert all(abs(r[3]) < 1e-9 for r in table), 'D1'
    rec = [true_dt(z) + bias(z) for z in Z]
    out, table, corr = drift_correct(Z, rec, shots)
    # D2 drift at 1250 m: the bias over 1100..1250 is 6 us/m x 150 m less half a cell
    #    (the trapezoid ramps in over the cell at 1099.5..1100): -(6*150 + 0) ... computed exactly below
    def bias_int(lo, hi):
        bz = [bias(z) for z in Z]
        t = trapz_time(Z, bz)
        return (interp(Z, t, hi) - interp(Z, t, lo)) * 1e3  # ms
    for md, _owt, _s, dms in table:
        assert close(dms, -bias_int(1000, md), 1e-9), ('D2', md)
    # D3 the bias block 1100-1400 integrates to exactly 1.8 ms (6 x 299.5 + two half-cell ramps of 1.5 us)
    assert close(bias_int(1000, 1500), 1.8, 1e-12), 'D3'
    # D4 the corrected sonic closes at every level to within half the spread of
    #    the corrections times the step: the trapezoid cell that ends on a level
    #    mixes the two intervals' corrections, and that residual accumulates
    t = trapz_time(Z, out)
    t0 = interp(Z, t, LEVELS[0])
    cs = [c for _a, _b, c in corr]
    bound = 0.5 * (max(cs) - min(cs)) * 0.5 * 1e-3 + 1e-12
    for md, owt in shots:
        assert abs(shots[0][1] + interp(Z, t, md) - t0 - owt) * 1e3 <= bound, ('D4', md)
    # D5 the correction in 1250-1500 is minus the mean bias over that interval
    assert close(corr[1][2], -bias_int(1250, 1500) * 1e3 / 250, 1e-9), 'D5'


def splice(depth, runs, window):
    n = len(depth)
    out = [float('nan')] * n
    src = [-1] * n
    joins = []
    for k, (x, top, base) in enumerate(runs):
        off, cnt = 0.0, 0
        if k and window > 0:
            s = 0.0
            for i in range(n):
                if top - window <= depth[i] <= top + window and not math.isnan(out[i]) and not math.isnan(x[i]):
                    s += out[i] - x[i]
                    cnt += 1
            off = s / cnt if cnt else 0.0
        if k:
            joins.append((top, off, cnt))
        for i in range(n):
            if src[i] < 0 and top <= depth[i] <= base and not math.isnan(x[i]):
                out[i] = x[i] + off
                src[i] = k
    return out, src, joins


def main():
    anchors()
    shots = [(m, owt_true(m)) for m in LEVELS]
    rec = [true_dt(z) + bias(z) for z in Z]
    out, table, corr = drift_correct(Z, rec, shots)
    picks = [0, 150, 200, 500, 700, 1000, 1300, 1600, 1999, 2000]
    g = {
        'drift': {
            'levels': [dict(md=m, owtS=o) for m, o in shots],
            'table': [dict(md=r[0], owtS=r[1], sonicS=r[2], driftMs=r[3]) for r in table],
            'corrections': [dict(top=a, base=b, dtCorrUsM=c) for a, b, c in corr],
            'picks': [dict(i=i, md=Z[i], dtIn=rec[i], dtOut=out[i]) for i in picks],
        },
    }
    d = [100.0 + i for i in range(21)]
    run1 = [10.0 + 0.1 * i if i <= 12 else float('nan') for i in range(21)]
    run2 = [12.5 + 0.1 * i for i in range(21)]  # 2.5 above run 1 in the overlap
    x, src, joins = splice(d, [(run1, 100, 112), (run2, 110, 120)], 3)
    g['splice'] = dict(depth=d, run1=[None if math.isnan(v) else v for v in run1], run2=run2,
                       out=x, source=src, joins=[dict(at=a, offset=o, nOverlap=c) for a, o, c in joins])
    open_dir = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(open_dir, '..', '..', '..', 'test-data', 'petrophysics', 'goldens.logEdit.json')
    with open(dest, 'w') as fh:
        json.dump(g, fh, indent=1, sort_keys=True)
        fh.write('\n')
    print('anchors D1-D5 ok; wrote', os.path.normpath(dest))


if __name__ == '__main__':
    main()
