"""pylops oracle for engines/qi/inversion.js (QI programme Q8a, Milestone B).

Dev-time only (numpy, pylops 2.x): the engine's forward operator matches
pylops' PoststackLinearModelling (explicit, kind="centered"), so pylops'
solvers are the reference:
  * forward: the data of a blocky ln(AI) model with a 20 Hz Ricker (4 ms);
  * model-based: regularized_inversion(Op, d, [Identity], epsRs=[eps],
    dataregs=[m0]) solved to convergence, the minimiser of
    ||Op m - d||^2 + eps^2 ||m - m0||^2;
  * FISTA reflectivity: pylops.optimization.sparsity.fista on the
    convolution operator alone. pylops thresholds at eps * alpha / 2, so it
    minimises 1/2 ||C r - d||^2 + (eps / 2) ||r||_1: the engine's lambda is
    eps / 2.
Writes test-data/qi/goldens.inversion.json. Anchors I1-I3 asserted first.
"""
import json
import os
import numpy as np
import pylops
from pylops.utils.wavelets import ricker
from pylops.optimization.leastsquares import regularized_inversion
from pylops.optimization.sparsity import fista

nt, dt = 240, 0.004
t = np.arange(nt) * dt
# blocky ln(AI): layers of known impedance
ai = np.full(nt, 6000.0)
for top, val in ((40, 6800.0), (85, 6200.0), (120, 7600.0), (150, 7000.0), (190, 8200.0)):
    ai[top:] = val
m = np.log(ai)
wav = ricker(t[:21], f0=20)[0]  # 41 samples, centred
Op = pylops.avo.poststack.PoststackLinearModelling(wav, nt0=nt, explicit=True)
d = Op @ m


def moving_average(x, half):
    out = np.empty_like(x)
    for i in range(len(x)):
        lo, hi = max(0, i - half), min(len(x) - 1, i + half)
        out[i] = x[lo:hi + 1].mean()
    return out


m0 = moving_average(m, 15)
eps = 0.05
minv = regularized_inversion(Op, d, [pylops.Identity(nt)], epsRs=[eps], dataregs=[m0], x0=m0.copy(),
                             **dict(damp=0, iter_lim=5000, atol=1e-14, btol=1e-14))[0]
C = pylops.signalprocessing.Convolve1D(nt, h=wav, offset=len(wav) // 2)
r_true = np.zeros(nt)
for k, a in ((50, 0.08), (110, -0.05), (170, 0.06)):
    r_true[k] = a
dr = C @ r_true
lam = 0.002
L = np.max(np.abs(np.linalg.eigvalsh((C.H @ C).todense())))
r_f = fista(C, dr, niter=400, eps=lam, alpha=1.0 / L, show=False)[0]

# anchors
# I1 the forward operator is the centred difference then the centred convolution
D = np.zeros(nt)
D[1:-1] = 0.5 * (m[2:] - m[:-2])
assert np.allclose(np.convolve(D, wav)[len(wav) // 2: len(wav) // 2 + nt], d, atol=1e-12), 'I1'
# I2 the regularised solution satisfies its normal equations
G = Op.todense()
lhs = (G.T @ G + eps ** 2 * np.eye(nt)) @ minv
rhs = G.T @ d + eps ** 2 * m0
assert np.allclose(lhs, rhs, atol=1e-6 * np.abs(rhs).max()), 'I2'
# I3 FISTA finds the spikes of a sparse reflectivity
assert set(np.argsort(-np.abs(r_f))[:3]) == {50, 110, 170}, 'I3'

g = dict(nt=nt, dtMs=dt * 1000, wavelet=wav.tolist(), m=m.tolist(), d=d.tolist(), m0=m0.tolist(), eps=eps,
         mInv=minv.tolist(), rTrue=r_true.tolist(), dR=dr.tolist(), lam=lam, L=float(L), rFista=r_f.tolist())
here = os.path.dirname(os.path.abspath(__file__))
dest = os.path.join(here, '..', '..', '..', 'test-data', 'qi', 'goldens.inversion.json')
with open(dest, 'w') as fh:
    json.dump(g, fh, indent=0, sort_keys=True)
    fh.write('\n')
print('anchors I1-I3 ok; wrote', os.path.normpath(dest), 'fista convention check: max|r_f|', float(np.abs(r_f).max()))
