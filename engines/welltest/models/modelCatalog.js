/**
 * Analytical model catalog for the Well Test Analysis Studio.
 *
 * Each entry pairs a Laplace-space dimensionless solution with parameter
 * metadata (units, defaults, bounds, log-scale flags). The metadata drives
 * both the manual-match UI controls and the Levenberg-Marquardt auto-fit, so
 * adding a model is one catalog entry plus one solution module.
 *
 * Oilfield units throughout:
 *   k md, h ft, phi fraction, mu cp, ct 1/psi, rw ft, B RB/STB, q STB/D,
 *   C bbl/psi, t hours, p psi.
 *
 * Dimensionless groups (standard SPE definitions):
 *   tD = 0.0002637 k t / (phi mu ct rw^2)
 *   pD = k h dp / (141.2 q B mu)
 *   CD = 0.8936 C / (phi ct h rw^2)
 */

import { stehfestInvert } from '../numerics.js';
import { pwdLaplaceHomogeneous } from './homogeneous.js';
import { makeRadialPwdLaplace } from './radial.js';
import { makeFracturePwdLaplace } from './fracture.js';
import { makeRectanglePwdLaplace } from './rectangle.js';
import { makeHorizontalPwdLaplace } from './horizontal.js';
import { withChangingStorage, cphiDFromRatio, WELLBORE_STORAGE_MODELS } from './changingStorage.js';

export { WELLBORE_STORAGE_MODELS };

export const OILFIELD = {
  TD_FACTOR: 0.0002637,
  PD_FACTOR: 141.2,
  CD_FACTOR: 0.8936,
  SEMILOG_SLOPE: 162.6, // m = 162.6 q B mu / (k h) psi per log10 cycle
  DERIVATIVE_PLATEAU: 70.6, // radial derivative plateau = 70.6 q B mu / (k h) psi
  RINV_948: 948, // ri = sqrt(k t / (948 phi mu ct)) ft
  PSS_CARTESIAN: 0.23396, // m* = 0.23396 q B / (ct Vp) psi/hr
  CUBIC_FT_PER_BBL: 5.614583,
};

/** Conversion factors between dimensional inputs and dimensionless groups. */
export const toDimensionlessGroups = ({ k, phi, mu, ct, rw, h, B, q }) => ({
  // tD = tdPerHour * t[hr]
  tdPerHour: (OILFIELD.TD_FACTOR * k) / (phi * mu * ct * rw * rw),
  // dp[psi] = dpPerPd * pD
  dpPerPd: (OILFIELD.PD_FACTOR * q * B * mu) / (k * h),
  // CD = cdPerBblPsi * C[bbl/psi]
  cdPerBblPsi: OILFIELD.CD_FACTOR / (phi * ct * h * rw * rw),
  rw,
  h,
});

// Shared parameter metadata. The additive Laplace skin term is only
// physical for S >= 0. Since U2-013 the radial, rectangle and dual-porosity
// models take S down to -5 through the effective-radius mapping with every
// rw-based group rescaled (withNegativeSkin below); the horizontal well
// (skin referenced to kh h) and the fractures (choked-fracture skin) keep
// S >= 0.
const P_K = { key: 'k', label: 'Permeability', symbol: 'k', unit: 'md', default: 50, min: 1e-3, max: 1e5, logScale: true };
const P_SKIN = { key: 'skin', label: 'Skin factor', symbol: 'S', unit: 'dimensionless', default: 0, min: 0, max: 100, logScale: false };
const P_C = { key: 'C', label: 'Wellbore storage', symbol: 'C', unit: 'bbl/psi', default: 0.01, min: 1e-6, max: 10, logScale: true };
const P_OMEGA = { key: 'omega', label: 'Storativity ratio', symbol: 'ω', unit: 'fraction', default: 0.1, min: 0.001, max: 1, logScale: true };
const P_LAMBDA = { key: 'lambda', label: 'Interporosity coefficient', symbol: 'λ', unit: 'dimensionless', default: 1e-6, min: 1e-10, max: 1e-2, logScale: true };
const P_LDIST = { key: 'L', label: 'Distance to boundary', symbol: 'L', unit: 'ft', default: 500, min: 10, max: 50000, logScale: true };
const P_WIDTH = { key: 'W', label: 'Channel width', symbol: 'W', unit: 'ft', default: 1000, min: 20, max: 100000, logScale: true };
const P_RE = { key: 're', label: 'External radius', symbol: 're', unit: 'ft', default: 2000, min: 50, max: 100000, logScale: true };
const P_XF = { key: 'xf', label: 'Fracture half-length', symbol: 'xf', unit: 'ft', default: 100, min: 1, max: 5000, logScale: true };
const rectDistance = (key, label, symbol) =>
  ({ key, label, symbol, unit: 'ft', default: 1000, min: 10, max: 50000, logScale: true });
const P_RECT_L1 = rectDistance('L1', 'Distance to west boundary', 'L1');
const P_RECT_L2 = rectDistance('L2', 'Distance to east boundary', 'L2');
const P_RECT_W1 = rectDistance('W1', 'Distance to south boundary', 'W1');
const P_RECT_W2 = rectDistance('W2', 'Distance to north boundary', 'W2');
const P_KVKH = { key: 'kvkh', label: 'Vertical anisotropy', symbol: 'kv/kh', unit: 'dimensionless', default: 0.1, min: 1e-4, max: 1, logScale: true };
const P_LW = { key: 'Lw', label: 'Well length', symbol: 'Lw', unit: 'ft', default: 2000, min: 100, max: 20000, logScale: true };
const P_ZWFRAC = { key: 'zwFrac', label: 'Standoff fraction', symbol: 'zw/h', unit: 'fraction', default: 0.5, min: 0.05, max: 0.95, logScale: false };
const P_FCD = { key: 'fcd', label: 'Fracture conductivity', symbol: 'FcD', unit: 'dimensionless', default: 10, min: 0.1, max: 10000, logScale: true };
const P_SKIN_CHOKE = { ...P_SKIN, label: 'Choked-fracture skin', max: 20 };

const baseDimless = (params, groups) => ({
  skin: Math.max(params.skin ?? 0, 0),
  // U2-013: the signed skin, read by the negative-skin mapping below
  skinRaw: params.skin ?? 0,
  cd: (params.C ?? 0) * groups.cdPerBblPsi,
});

/**
 * Negative skin on the radial and rectangle models (Well Test U2-013,
 * 2026-10-04). The additive Laplace skin term is physical only for S >= 0,
 * so a stimulated well is the same reservoir seen from an effective
 * wellbore of radius rw' = rw e^-S with zero skin (the mapping the
 * homogeneous model has used since WT1). Every rw-based dimensionless group
 * moves with rw': tD' = tD e^2S and CD' = CD e^2S (so in Laplace space
 * F(u) = F'(u/a)/a with a = e^2S), each distance in rw units (LD, WD, reD,
 * the rectangle's sides and well position) times e^S, and the Warren-Root
 * lambda, which carries rw^2, divided by a. pwD itself does not depend on
 * rw. omega and the boundary type are unchanged.
 */
const NEGATIVE_SKIN_LENGTHS = ['ld', 'wd', 'reD', 'xeD', 'xwD', 'yeD', 'ywD'];
export const withNegativeSkin = (pwdLaplace) => (u, d = {}) => {
  const S = d.skinRaw ?? d.skin ?? 0;
  if (!(S < 0)) return pwdLaplace(u, d);
  const a = Math.exp(2 * S);
  const e = Math.exp(S);
  const scaled = { ...d, skin: 0, skinRaw: 0, cd: (d.cd ?? 0) * a };
  for (const k of NEGATIVE_SKIN_LENGTHS) if (typeof d[k] === 'number') scaled[k] = d[k] * e;
  if (typeof d.lambda === 'number') scaled.lambda = d.lambda / a;
  return pwdLaplace(u / a, scaled) / a;
};
const P_SKIN_STIM = { ...P_SKIN, min: -5 };

const dualPorosityDimless = (mode) => (params, groups) => ({
  ...baseDimless(params, groups),
  omega: params.omega ?? 0.1,
  lambda: params.lambda ?? 1e-6,
  interporosity: mode,
});

export const MODEL_CATALOG = [
  {
    id: 'homogeneous',
    label: 'Homogeneous reservoir',
    wellbore: 'Constant wellbore storage and skin',
    boundary: 'Infinite acting',
    parameters: [
      P_K,
      { ...P_SKIN, min: -5 }, // effective-radius mapping handles S < 0 here
      P_C,
    ],
    pwdLaplace: pwdLaplaceHomogeneous,
  },
  {
    id: 'homogeneous-sealing-fault',
    label: 'Homogeneous + sealing fault',
    wellbore: 'Constant wellbore storage and skin',
    boundary: 'Single sealing fault (image well); late derivative doubles',
    parameters: [P_K, P_SKIN_STIM, P_C, P_LDIST],
    pwdLaplace: withNegativeSkin(makeRadialPwdLaplace({ mode: 'homogeneous', boundaryType: 'fault' })),
    toDimless: (params, groups) => ({
      ...baseDimless(params, groups),
      ld: (params.L ?? P_LDIST.default) / groups.rw,
    }),
  },
  {
    id: 'homogeneous-constant-pressure',
    label: 'Homogeneous + constant-pressure boundary',
    wellbore: 'Constant wellbore storage and skin',
    boundary: 'Constant-pressure boundary (negative image); pressure stabilizes, derivative falls',
    parameters: [P_K, P_SKIN_STIM, P_C, P_LDIST],
    pwdLaplace: withNegativeSkin(makeRadialPwdLaplace({ mode: 'homogeneous', boundaryType: 'constant-pressure' })),
    toDimless: (params, groups) => ({
      ...baseDimless(params, groups),
      ld: (params.L ?? P_LDIST.default) / groups.rw,
    }),
  },
  {
    id: 'homogeneous-channel',
    label: 'Homogeneous + parallel faults (channel)',
    wellbore: 'Constant wellbore storage and skin',
    boundary: 'Well centered between two parallel sealing faults; late linear flow (half slope)',
    parameters: [P_K, P_SKIN_STIM, P_C, P_WIDTH],
    pwdLaplace: withNegativeSkin(makeRadialPwdLaplace({ mode: 'homogeneous', boundaryType: 'channel' })),
    toDimless: (params, groups) => ({
      ...baseDimless(params, groups),
      wd: (params.W ?? P_WIDTH.default) / groups.rw,
    }),
  },
  {
    id: 'homogeneous-closed-circle',
    label: 'Homogeneous, closed circle',
    wellbore: 'Constant wellbore storage and skin',
    boundary: 'No-flow circular boundary (van Everdingen-Hurst); late pseudo-steady state (unit slope)',
    parameters: [P_K, P_SKIN_STIM, P_C, P_RE],
    pwdLaplace: withNegativeSkin(makeRadialPwdLaplace({ mode: 'homogeneous', boundaryType: 'closed-circle' })),
    toDimless: (params, groups) => ({
      ...baseDimless(params, groups),
      reD: (params.re ?? P_RE.default) / groups.rw,
    }),
  },
  {
    id: 'homogeneous-closed-rectangle',
    label: 'Homogeneous, closed rectangle',
    wellbore: 'Constant wellbore storage and skin',
    boundary: 'No-flow rectangle, well position via four boundary distances; late pseudo-steady state (unit slope)',
    parameters: [P_K, P_SKIN_STIM, P_C, P_RECT_L1, P_RECT_L2, P_RECT_W1, P_RECT_W2],
    pwdLaplace: withNegativeSkin(makeRectanglePwdLaplace()),
    toDimless: (params, groups) => {
      const L1 = params.L1 ?? P_RECT_L1.default;
      const L2 = params.L2 ?? P_RECT_L2.default;
      const W1 = params.W1 ?? P_RECT_W1.default;
      const W2 = params.W2 ?? P_RECT_W2.default;
      return {
        ...baseDimless(params, groups),
        xeD: (L1 + L2) / groups.rw,
        xwD: L1 / groups.rw,
        yeD: (W1 + W2) / groups.rw,
        ywD: W1 / groups.rw,
      };
    },
  },
  {
    id: 'dual-porosity-pss',
    label: 'Dual porosity (Warren-Root, PSS)',
    wellbore: 'Constant wellbore storage and skin',
    boundary: 'Infinite acting; pseudo-steady-state interporosity flow',
    parameters: [P_K, P_SKIN_STIM, P_C, P_OMEGA, P_LAMBDA],
    pwdLaplace: withNegativeSkin(makeRadialPwdLaplace({ mode: 'dual-porosity', boundaryType: 'infinite' })),
    toDimless: dualPorosityDimless('pss'),
  },
  {
    id: 'dual-porosity-slab',
    label: 'Dual porosity (transient slabs)',
    wellbore: 'Constant wellbore storage and skin',
    boundary: 'Infinite acting; transient interporosity flow, slab matrix blocks',
    parameters: [P_K, P_SKIN_STIM, P_C, P_OMEGA, P_LAMBDA],
    pwdLaplace: withNegativeSkin(makeRadialPwdLaplace({ mode: 'dual-porosity', boundaryType: 'infinite' })),
    toDimless: dualPorosityDimless('transient-slab'),
  },
  {
    id: 'dual-porosity-pss-fault',
    label: 'Dual porosity (PSS) + sealing fault',
    wellbore: 'Constant wellbore storage and skin',
    boundary: 'Single sealing fault in a Warren-Root reservoir',
    parameters: [P_K, P_SKIN_STIM, P_C, P_OMEGA, P_LAMBDA, P_LDIST],
    pwdLaplace: withNegativeSkin(makeRadialPwdLaplace({ mode: 'dual-porosity', boundaryType: 'fault' })),
    toDimless: (params, groups) => ({
      ...dualPorosityDimless('pss')(params, groups),
      ld: (params.L ?? P_LDIST.default) / groups.rw,
    }),
  },
  {
    id: 'horizontal-well',
    label: 'Horizontal well',
    wellbore: 'Constant wellbore storage and skin (skin referenced to kh h)',
    boundary: 'Laterally infinite slab, no-flow top and bottom; vertical radial, then linear, then pseudoradial flow',
    parameters: [P_K, P_KVKH, P_LW, P_ZWFRAC, P_SKIN, P_C],
    pwdLaplace: makeHorizontalPwdLaplace(),
    toDimless: (params, groups) => {
      const beta = Math.sqrt(1 / Math.max(params.kvkh ?? P_KVKH.default, 1e-9));
      const lh = (params.Lw ?? P_LW.default) / 2;
      const hD = (groups.h * beta) / lh;
      const zwD = (params.zwFrac ?? P_ZWFRAC.default) * hD;
      const rwPrimeD = (groups.rw * (1 + beta)) / (2 * lh);
      return {
        ...baseDimless(params, groups),
        lhOverRw: lh / groups.rw,
        hD,
        zwD,
        zobsD: Math.min(zwD + rwPrimeD, hD * (1 - 1e-6)),
      };
    },
  },
  {
    id: 'fracture-infinite-conductivity',
    label: 'Vertical fracture, infinite conductivity',
    wellbore: 'Constant wellbore storage and choked-fracture skin',
    boundary: 'Infinite acting (Gringarten); early linear flow (half slope)',
    parameters: [P_K, P_XF, P_C, P_SKIN_CHOKE],
    pwdLaplace: makeFracturePwdLaplace({ conductivity: 'infinite' }),
    toDimless: (params, groups) => ({
      ...baseDimless(params, groups),
      xfOverRw: (params.xf ?? P_XF.default) / groups.rw,
    }),
  },
  {
    id: 'fracture-finite-conductivity',
    label: 'Vertical fracture, finite conductivity',
    wellbore: 'Constant wellbore storage and choked-fracture skin',
    boundary: 'Infinite acting (Cinco-Ley); early bilinear flow (quarter slope)',
    parameters: [P_K, P_XF, P_FCD, P_C, P_SKIN_CHOKE],
    pwdLaplace: makeFracturePwdLaplace({ conductivity: 'finite' }),
    toDimless: (params, groups) => ({
      ...baseDimless(params, groups),
      xfOverRw: (params.xf ?? P_XF.default) / groups.rw,
      fcd: params.fcd ?? P_FCD.default,
    }),
  },
];

// Changing wellbore storage (U2-002): two parameters on top of the model's
// own; C stays the final (late) storage.
const P_CI_RATIO = { key: 'ciOverC', label: 'Initial to final storage ratio', symbol: 'Ci/C', unit: 'ratio', default: 3, min: 0.02, max: 50, logScale: true };
const P_ALPHA = { key: 'alpha', label: 'Storage change time', symbol: 'alpha', unit: 'hr', default: 0.05, min: 1e-4, max: 100, logScale: true };

/** Separator of a composed model id: '<model id>+<wellbore model>'. */
export const WELLBORE_ID_SEPARATOR = '+';

/** { baseId, wellbore } of a catalog id; wellbore 'constant' when none is named. */
export const splitModelId = (id) => {
  const [baseId, wellbore] = String(id ?? '').split(WELLBORE_ID_SEPARATOR);
  return { baseId, wellbore: wellbore || 'constant' };
};

/** The catalog id of a model with a wellbore storage model. */
export const composeModelId = (baseId, wellbore = 'constant') => (
  !wellbore || wellbore === 'constant' ? baseId : `${baseId}${WELLBORE_ID_SEPARATOR}${wellbore}`
);

const composedCache = new Map();

/**
 * A catalog model with changing wellbore storage: the model's own sandface
 * solution (cd = 0) composed by engines/welltest/models/changingStorage.js,
 * with Ci/C and alpha added to its parameters. Cached, so a caller gets the
 * same object for the same id.
 */
export const withWellboreModel = (base, wellbore) => {
  if (!base || !wellbore || wellbore === 'constant') return base || null;
  const wb = WELLBORE_STORAGE_MODELS[wellbore];
  if (!wb) return null;
  const id = composeModelId(base.id, wellbore);
  if (composedCache.has(id)) return composedCache.get(id);
  const short = wellbore === 'hegeman' ? 'Hegeman' : 'Fair';
  const composed = {
    ...base,
    id,
    baseId: base.id,
    wellboreModel: wellbore,
    label: `${base.label}, changing storage (${short})`,
    wellbore: `${wb.label}; ${base.wellbore.replace(/^Constant wellbore storage/, 'final storage C')}`,
    wellboreReference: wb.reference,
    parameters: [...base.parameters, P_CI_RATIO, P_ALPHA],
    pwdLaplace: withChangingStorage(base.pwdLaplace, wellbore),
    toDimless: (params, groups) => {
      const d = toDimensionlessParams(base, params, groups);
      const alphaD = groups.tdPerHour * (params.alpha ?? P_ALPHA.default);
      return {
        ...d,
        alphaD,
        cphiD: cphiDFromRatio({ kind: wellbore, ciOverC: params.ciOverC ?? P_CI_RATIO.default, alphaD, cd: d.cd }),
      };
    },
  };
  composedCache.set(id, composed);
  return composed;
};

export const getModel = (id) => {
  const { baseId, wellbore } = splitModelId(id);
  const base = MODEL_CATALOG.find((m) => m.id === baseId) || null;
  return withWellboreModel(base, wellbore);
};

export const defaultParams = (model) =>
  Object.fromEntries(model.parameters.map((p) => [p.key, p.default]));

const toDimensionlessParams = (model, params, groups) =>
  model?.toDimless ? model.toDimless(params, groups) : {
    skin: params.skin ?? 0,
    cd: (params.C ?? 0) * groups.cdPerBblPsi,
  };

/**
 * Dimensionless pwD(tD) for a catalog model via Stehfest inversion.
 */
export const modelPwd = (model, tD, dimlessParams, stehfestN = 12) =>
  stehfestInvert((u) => model.pwdLaplace(u, dimlessParams), tD, stehfestN);

/**
 * Constant-rate drawdown response.
 * @returns array of { t, dp, pw } with dp = pi - pwf(t)
 */
export const evaluateDrawdown = ({ model, params, reservoir, times, stehfestN = 12 }) => {
  const groups = toDimensionlessGroups({ ...reservoir, k: params.k });
  const dimless = toDimensionlessParams(model, params, groups);
  const pi = reservoir.pi ?? 0;
  return times.map((t) => {
    const pwd = modelPwd(model, groups.tdPerHour * t, dimless, stehfestN);
    const dp = groups.dpPerPd * pwd;
    return { t, dp, pw: pi - dp };
  });
};

/**
 * Buildup response after producing at constant rate q for tp hours, by exact
 * superposition of the constant-rate solution (linear system, constant C):
 *   pws(dt) = pi - dpPerPd [ pwD(tp + dt) - pwD(dt) ]
 *   dp(dt)  = pws(dt) - pwf(tp)
 *           = dpPerPd [ pwD(tp) - pwD(tp + dt) + pwD(dt) ]
 * @returns array of { dt, dp, pws } plus pwfAtShutIn on the array object
 */
export const evaluateBuildup = ({ model, params, reservoir, tp, dts, stehfestN = 12 }) => {
  const groups = toDimensionlessGroups({ ...reservoir, k: params.k });
  const dimless = toDimensionlessParams(model, params, groups);
  const pi = reservoir.pi ?? 0;
  const pwdTp = modelPwd(model, groups.tdPerHour * tp, dimless, stehfestN);
  const pwfAtShutIn = pi - groups.dpPerPd * pwdTp;
  const points = dts.map((dt) => {
    const pwdSum =
      pwdTp -
      modelPwd(model, groups.tdPerHour * (tp + dt), dimless, stehfestN) +
      modelPwd(model, groups.tdPerHour * dt, dimless, stehfestN);
    const dp = groups.dpPerPd * pwdSum;
    return { dt, dp, pws: pwfAtShutIn + dp };
  });
  points.pwfAtShutIn = pwfAtShutIn;
  return points;
};

/**
 * Dispatch a model evaluation by test type ('drawdown' | 'buildup').
 */
export const evaluateModelTest = ({ testType, ...rest }) => {
  if (testType === 'buildup') return evaluateBuildup(rest);
  return evaluateDrawdown({ ...rest, times: rest.times ?? rest.dts });
};
