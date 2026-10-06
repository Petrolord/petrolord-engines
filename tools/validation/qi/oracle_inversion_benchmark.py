"""Blind-well benchmark for engines/qi/inversion.js and qi/lfm.js (QI Q8a).

Dev-time only (numpy, pylops 2.x). The truth is the 2D acoustic impedance
model of pylops' post-stack inversion tutorial (pylops testdata
avo/poststack_model.npz, 550 x 800, 4 m samples read as 4 ms of TWT as the
tutorial does), decimated to 50 traces and 400 samples. The seismic is
pylops' PoststackLinearModelling (explicit, centred) with a 20 Hz Ricker of
41 samples. Five wells; each in turn is left out of an inverse-distance
low-frequency model (constant time, power 2, the wells' ln(AI) low-passed by
a centred moving average of half width 16 samples, about 8 Hz) and the
blind trace is inverted by pylops' regularized_inversion with
||Op m - d||^2 + eps^2 ||m - m0||^2. The goldens carry the truth panel, the
well positions, the settings and pylops' blind results; the jest gate runs
the engine on the same inputs.

Usage: python -I oracle_inversion_benchmark.py <poststack_model.npz> <engines repo root>
"""
import json
import os
import sys
import numpy as np
import pylops
from pylops.utils.wavelets import ricker

npz, root = sys.argv[1], sys.argv[2]
m = np.load(npz)
model = m['model']  # (nz, nx)
lnai = np.round(np.log(model[50:450, ::16]), 6)  # 400 samples x 50 traces, rounded as stored so both sides read the same input
nt, nx = lnai.shape
dt = 0.004
wav = np.round(ricker(np.arange(21) * dt, 20)[0], 14)  # 41 samples, centred, rounded as stored
assert len(wav) == 41
Op = pylops.avo.poststack.PoststackLinearModelling(wav, nt0=nt, explicit=True, kind='centered')
d = np.stack([Op @ lnai[:, i] for i in range(nx)], axis=1)

wells = [5, 15, 25, 35, 45]
half = 16
eps = 0.05

def lowpass(x, h):
    out = np.empty_like(x)
    for i in range(len(x)):
        lo, hi = max(0, i - h), min(len(x) - 1, i + h)
        out[i] = x[lo:hi + 1].mean()
    return out

def lfm(at, exclude):
    use = [w for w in wells if w != exclude]
    wts = np.array([1.0 / (w - at) ** 2 for w in use])
    logs = np.stack([lowpass(lnai[:, w], half) for w in use], axis=1)
    return logs @ wts / wts.sum()

blind = []
for w in wells:
    m0 = lfm(w, w)
    minv = pylops.optimization.leastsquares.regularized_inversion(
        Op, d[:, w], [pylops.Identity(nt)], epsRs=[eps], dataregs=[m0], x0=m0,
        **dict(iter_lim=3000, atol=1e-14, btol=1e-14))[0]
    err = np.sqrt(np.mean(((np.exp(minv) - np.exp(lnai[:, w])) / np.exp(lnai[:, w])) ** 2)) * 100
    lfm_err = np.sqrt(np.mean(((np.exp(m0) - np.exp(lnai[:, w])) / np.exp(lnai[:, w])) ** 2)) * 100
    blind.append({'trace': w, 'm0': np.round(m0, 8).tolist(), 'm': np.round(minv, 8).tolist(), 'rmsPct': float(err), 'lfmRmsPct': float(lfm_err)})
    print(f'well {w}: blind AI error {err:.2f} percent (the model alone {lfm_err:.2f})')

# anchors: the inversion improves on the model alone at every well, and the forward data is reproduced
assert all(b['rmsPct'] < b['lfmRmsPct'] for b in blind)
out = {
    'source': 'pylops testdata avo/poststack_model.npz, model[50:450, ::16], ln',
    'dtMs': 4, 'wavelet': np.round(wav, 14).tolist(), 'eps': eps, 'lfmHalf': half, 'wells': wells,
    'lnAi': [np.round(lnai[:, i], 6).tolist() for i in range(nx)],
    'blind': blind,
}
with open(os.path.join(root, 'test-data/qi/goldens.inversionBenchmark.json'), 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print('wrote goldens.inversionBenchmark.json')
