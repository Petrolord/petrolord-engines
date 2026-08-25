// ISCWSA MWD (fixed rig) Revision 4 error-model definition — the 27
// agreed error sources with their magnitudes, propagation modes and
// weighting-function keys. Published by ISCWSA/OWSG (same as OWSG MWD
// Rev.2, revision date 2015-03-20); transcription follows welleng
// 0.29.0 (Apache-2.0, jonnymaserati/welleng) whose output reproduces
// the official iscwsa.net example Well #1 workbook to machine
// precision. Angular magnitudes are in radians, magnetic in nT, depth
// in metres (per-unit where dimensionless).
//
// `fn` keys map to the weighting functions in ../errorModel.js.

export const ISCWSA_MWD_REV4 = {
  name: 'ISCWSA MWD Rev4',
  revision: 4,
  codes: {
    'DRFR': { fn: 'DREF', magnitude: 0.35, propagation: 'random', unit: 'm' },
    'DSFS': { fn: 'DSF', magnitude: 0.00056, propagation: 'systematic', unit: '-' },
    'DSTG': { fn: 'DST', magnitude: 2.5e-7, propagation: 'global', unit: '1/m' },
    'ABXY-TI1S': { fn: 'ABXY_TI1', magnitude: 0.004, propagation: 'systematic', unit: 'm/s2' },
    'ABXY-TI2S': { fn: 'ABXY_TI2', magnitude: 0.004, propagation: 'systematic', unit: 'm/s2' },
    'ABZ': { fn: 'ABZ', magnitude: 0.004, propagation: 'systematic', unit: 'm/s2' },
    'ASXY-TI1S': { fn: 'ASXY_TI1', magnitude: 0.0005, propagation: 'systematic', unit: '-' },
    'ASXY-TI2S': { fn: 'ASXY_TI2', magnitude: 0.0005, propagation: 'systematic', unit: '-' },
    'ASXY-TI3S': { fn: 'ASXY_TI3', magnitude: 0.0005, propagation: 'systematic', unit: '-' },
    'ASZ': { fn: 'ASZ', magnitude: 0.0005, propagation: 'systematic', unit: '-' },
    'MBXY-TI1S': { fn: 'MBXY_TI1', magnitude: 70, propagation: 'systematic', unit: 'nT' },
    'MBXY-TI2S': { fn: 'MBXY_TI2', magnitude: 70, propagation: 'systematic', unit: 'nT' },
    'MBZ': { fn: 'MBZ', magnitude: 70, propagation: 'systematic', unit: 'nT' },
    'MSXY-TI1S': { fn: 'MSXY_TI1', magnitude: 0.0016, propagation: 'systematic', unit: '-' },
    'MSXY-TI2S': { fn: 'MSXY_TI2', magnitude: 0.0016, propagation: 'systematic', unit: '-' },
    'MSXY-TI3S': { fn: 'MSXY_TI3', magnitude: 0.0016, propagation: 'systematic', unit: '-' },
    'MSZ': { fn: 'MSZ', magnitude: 0.0016, propagation: 'systematic', unit: '-' },
    'DECG': { fn: 'AZ', magnitude: 0.006283185307179586, propagation: 'global', unit: 'rad' },
    'DECR': { fn: 'AZ', magnitude: 0.0017453292519943296, propagation: 'random', unit: 'rad' },
    'DBHG': { fn: 'DBH', magnitude: 87.26646259971648, propagation: 'global', unit: 'rad.nT' },
    'DBHR': { fn: 'DBH', magnitude: 52.35987755982988, propagation: 'random', unit: 'rad.nT' },
    'AMIL': { fn: 'AMIL', magnitude: 220, propagation: 'systematic', unit: 'nT' },
    'SAG': { fn: 'SAG', magnitude: 0.003490658503988659, propagation: 'systematic', unit: 'rad' },
    'XYM1': { fn: 'XYM1', magnitude: 0.0017453292519943296, propagation: 'systematic', unit: 'rad' },
    'XYM2': { fn: 'XYM2', magnitude: 0.0017453292519943296, propagation: 'systematic', unit: 'rad' },
    'XYM3': { fn: 'XYM3', magnitude: 0.0017453292519943296, propagation: 'systematic', unit: 'rad' },
    'XYM4': { fn: 'XYM4', magnitude: 0.0017453292519943296, propagation: 'systematic', unit: 'rad' },
  },
};
