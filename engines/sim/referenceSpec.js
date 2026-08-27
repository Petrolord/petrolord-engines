// Reference deck spec: the SPE1 problem (Odeh 1981) expressed as a
// composeDeck spec. PVT/kr tables are the published Odeh values as they
// appear in the ODbL OPM SPE1CASE1 deck; using known-good physics data
// isolates the S3 tests to what this domain actually does (serialization),
// and flow acceptance of THIS spec is the S3 gate. It also seeds the Suite
// builder's defaults.

export function referenceSpec() {
  return {
    title: 'PETROLORD S3 REFERENCE - SPE1-EQUIVALENT',
    startDate: '2015-01-01',
    grid: {
      nx: 10, ny: 10, nz: 3,
      dx: 1000, dy: 1000,
      topsDepth: 8325,
      layers: [
        { dz: 20, poro: 0.3, permx: 500, permz: 500 },
        { dz: 30, poro: 0.3, permx: 50, permz: 50 },
        { dz: 50, poro: 0.3, permx: 200, permz: 200 },
      ],
    },
    pvt: {
      density: { oil: 53.66, water: 64.49, gas: 0.0533 },
      pvtw: { pref: 4017.55, bw: 1.038, cw: 3.22e-6, muw: 0.318 },
      rock: { pref: 14.7, cr: 3e-6 },
      pvdg: [
        { p: 14.7, bg: 166.666, mug: 0.008 },
        { p: 264.7, bg: 12.093, mug: 0.0096 },
        { p: 514.7, bg: 6.274, mug: 0.0112 },
        { p: 1014.7, bg: 3.197, mug: 0.014 },
        { p: 2014.7, bg: 1.614, mug: 0.0189 },
        { p: 2514.7, bg: 1.294, mug: 0.0208 },
        { p: 3014.7, bg: 1.08, mug: 0.0228 },
        { p: 4014.7, bg: 0.811, mug: 0.0268 },
        { p: 5014.7, bg: 0.649, mug: 0.0309 },
        { p: 9014.7, bg: 0.386, mug: 0.047 },
      ],
      pvtoRecords: [
        { rs: 0.001, p: 14.7, bo: 1.062, muo: 1.04 },
        { rs: 0.0905, p: 264.7, bo: 1.15, muo: 0.975 },
        { rs: 0.18, p: 514.7, bo: 1.207, muo: 0.91 },
        { rs: 0.371, p: 1014.7, bo: 1.295, muo: 0.83 },
        { rs: 0.636, p: 2014.7, bo: 1.435, muo: 0.695 },
        { rs: 0.775, p: 2514.7, bo: 1.5, muo: 0.641 },
        { rs: 0.93, p: 3014.7, bo: 1.565, muo: 0.594 },
        {
          rs: 1.27, p: 4014.7, bo: 1.695, muo: 0.51,
          undersat: [{ p: 9014.7, bo: 1.579, muo: 0.74 }],
        },
        {
          rs: 1.618, p: 5014.7, bo: 1.827, muo: 0.449,
          undersat: [{ p: 9014.7, bo: 1.737, muo: 0.631 }],
        },
      ],
    },
    satfn: {
      swof: [
        { Sw: 0.12, krw: 0, krow: 1, pcow: 0 },
        { Sw: 0.18, krw: 4.64876033057851e-8, krow: 1, pcow: 0 },
        { Sw: 0.24, krw: 1.86e-7, krow: 0.997, pcow: 0 },
        { Sw: 0.3, krw: 4.18388429752066e-7, krow: 0.98, pcow: 0 },
        { Sw: 0.36, krw: 7.43801652892562e-7, krow: 0.7, pcow: 0 },
        { Sw: 0.42, krw: 1.16219008264463e-6, krow: 0.35, pcow: 0 },
        { Sw: 0.48, krw: 1.67355371900826e-6, krow: 0.2, pcow: 0 },
        { Sw: 0.54, krw: 2.27789256198347e-6, krow: 0.09, pcow: 0 },
        { Sw: 0.6, krw: 2.97520661157025e-6, krow: 0.021, pcow: 0 },
        { Sw: 0.66, krw: 3.7654958677686e-6, krow: 0.01, pcow: 0 },
        { Sw: 0.72, krw: 4.64876033057851e-6, krow: 0.001, pcow: 0 },
        { Sw: 0.78, krw: 0.000005625, krow: 0.0001, pcow: 0 },
        { Sw: 0.84, krw: 6.69421487603306e-6, krow: 0, pcow: 0 },
        { Sw: 0.91, krw: 8.05914256198347e-6, krow: 0, pcow: 0 },
        { Sw: 1, krw: 0.00001, krow: 0, pcow: 0 },
      ],
      sgof: [
        { Sg: 0, krg: 0, krog: 1, pcog: 0 },
        { Sg: 0.001, krg: 0, krog: 1, pcog: 0 },
        { Sg: 0.02, krg: 0, krog: 0.997, pcog: 0 },
        { Sg: 0.05, krg: 0.005, krog: 0.98, pcog: 0 },
        { Sg: 0.12, krg: 0.025, krog: 0.7, pcog: 0 },
        { Sg: 0.2, krg: 0.075, krog: 0.35, pcog: 0 },
        { Sg: 0.25, krg: 0.125, krog: 0.2, pcog: 0 },
        { Sg: 0.3, krg: 0.19, krog: 0.09, pcog: 0 },
        { Sg: 0.4, krg: 0.41, krog: 0.021, pcog: 0 },
        { Sg: 0.45, krg: 0.6, krog: 0.01, pcog: 0 },
        { Sg: 0.5, krg: 0.72, krog: 0.001, pcog: 0 },
        { Sg: 0.6, krg: 0.87, krog: 0.0001, pcog: 0 },
        { Sg: 0.7, krg: 0.94, krog: 0, pcog: 0 },
        { Sg: 0.85, krg: 0.98, krog: 0, pcog: 0 },
        { Sg: 0.88, krg: 0.984, krog: 0, pcog: 0 },
      ],
    },
    equil: {
      datumDepth: 8400,
      datumPressure: 4800,
      owc: 8450,
      goc: 8300,
    },
    wells: [
      {
        name: 'PROD', type: 'producer', i: 10, j: 10, k1: 3, k2: 3,
        refDepth: 8400, wellboreRadiusFt: 0.25,
        control: { mode: 'ORAT', rate: 20000, bhpMin: 1000 },
      },
      {
        name: 'INJ', type: 'gas_injector', i: 1, j: 1, k1: 1, k2: 1,
        refDepth: 8335, wellboreRadiusFt: 0.25,
        control: { rate: 100000, bhpMax: 9014 },
      },
    ],
    schedule: {
      steps: [{ count: 60, dtDays: 30.4375 }], // ~5 years, monthly reports
    },
  };
}
