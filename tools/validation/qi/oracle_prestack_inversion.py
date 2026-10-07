"""pylops oracle for engines/qi/prestackInversion.js (QI Q8b).

The engine's operator is pylops' PrestackLinearModelling(explicit=True,
linearization='fatti', kind='centered'), with the model stacked as
[ln AI; ln SI; ln rho] and the data as [angle][time]. Here:
  * forward: blocky truth models, six angles 0 to 40 degrees, a 20 Hz Ricker;
  * inversion: regularized_inversion(Op, d, [Diagonal(eps per parameter)],
    dataregs=[eps * m0]) solved to convergence, the minimiser of
    ||Op m - d||^2 + sum_p eps_p^2 ||m_p - m0_p||^2, from m0;
  * the same with the near angles only (0 to 16 degrees), for the
    negative control on density.
Anchors: the operator's adjoint passes pylops' dottest; the truth is a fixed
point of the forward model.
Usage: python -I oracle_prestack_inversion.py <engines repo root>
"""
import json
import os
import sys
import numpy as np
import pylops
from pylops.utils.wavelets import ricker

root = sys.argv[1]
nt = 160; dt = 0.004; vsvp = 0.5
wav = np.round(ricker(np.arange(21) * dt, 20)[0], 14)
thetas = [0.0, 8.0, 16.0, 24.0, 32.0, 40.0]
t = np.arange(nt)

def blocky(levels, edges):
    out = np.full(nt, levels[0], dtype=float)
    for lv, e in zip(levels[1:], edges):
        out[t >= e] = lv
    return out

ln_ai = np.round(np.log(blocky([6500, 7400, 6200, 7900, 7000], [30, 60, 95, 125])), 8)
ln_si = np.round(np.log(blocky([3000, 3600, 3500, 3900, 3300], [30, 60, 95, 125])), 8)
ln_rho = np.round(np.log(blocky([2.30, 2.42, 2.15, 2.48, 2.38], [30, 60, 95, 125])), 8)

def smooth(x, h=12):
    return np.array([x[max(0, i - h):min(nt, i + h + 1)].mean() for i in range(nt)])

m_true = np.concatenate([ln_ai, ln_si, ln_rho])
m0 = np.concatenate([smooth(ln_ai), smooth(ln_si), smooth(ln_rho)])
eps = [0.05, 0.05, 0.05]
rng = np.random.default_rng(1)

def solve(th):
    Op = pylops.avo.prestack.PrestackLinearModelling(wav, np.array(th), vsvp=vsvp, nt0=nt, linearization='fatti', explicit=True, kind='centered')
    assert pylops.utils.dottest(Op, Op.shape[0], Op.shape[1])
    clean = Op @ m_true
    noise = np.round(0.05 * np.std(clean) * rng.standard_normal(clean.shape), 12)
    d = clean + noise
    E = pylops.Diagonal(np.concatenate([np.full(nt, e) for e in eps]))
    m = pylops.optimization.leastsquares.regularized_inversion(Op, d, [E], dataregs=[E @ m0], x0=m0, **dict(iter_lim=6000, atol=1e-15, btol=1e-15))[0]
    return clean, d, m

c_full, d_full, m_full = solve(thetas)
c_near, d_near, m_near = solve(thetas[:3])
detail = lambda m: float(np.corrcoef(m[2 * nt:] - m0[2 * nt:], m_true[2 * nt:] - m0[2 * nt:])[0, 1])
print('density detail correlation: full %.3f near %.3f' % (detail(m_full), detail(m_near)))
assert detail(m_full) > detail(m_near) + 0.15
rel = lambda m, k: float(np.sqrt(np.mean((m[k * nt:(k + 1) * nt] - m_true[k * nt:(k + 1) * nt]) ** 2)))
print('full angles: ln error AI %.4f SI %.4f rho %.4f' % (rel(m_full, 0), rel(m_full, 1), rel(m_full, 2)))
print('near angles: ln error AI %.4f SI %.4f rho %.4f' % (rel(m_near, 0), rel(m_near, 1), rel(m_near, 2)))
out = {
    'nt': nt, 'dtMs': 4, 'vsVp': vsvp, 'wavelet': wav.tolist(), 'thetas': thetas, 'eps': eps,
    'truth': {'lnAi': ln_ai.tolist(), 'lnSi': ln_si.tolist(), 'lnRho': ln_rho.tolist()},
    'm0': {'lnAi': np.round(m0[:nt], 10).tolist(), 'lnSi': np.round(m0[nt:2 * nt], 10).tolist(), 'lnRho': np.round(m0[2 * nt:], 10).tolist()},
    'cleanFull': np.round(c_full.reshape(len(thetas), nt), 12).tolist(),
    'dFull': np.round(d_full.reshape(len(thetas), nt), 12).tolist(),
    'dNear': np.round(d_near.reshape(3, nt), 12).tolist(),
    'mFull': np.round(m_full, 10).tolist(),
    'mNear': np.round(m_near, 10).tolist(),
}
with open(os.path.join(root, 'test-data/qi/goldens.prestackInversion.json'), 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print('wrote goldens.prestackInversion.json')
