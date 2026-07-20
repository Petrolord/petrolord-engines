// Voidage Replacement Ratio (VRR) calculations.
//
// VRR is the classic waterflood/pressure-maintenance surveillance metric:
//   VRR = reservoir-barrels injected / reservoir-barrels of voidage produced
// A value near 1.0 means produced voidage is being replaced (pressure held);
// < 1 means under-injection (expect pressure decline); > 1 means over-injection.
//
// All voidages are computed in reservoir barrels (RB) for consistency.
// Units (field): Np, Wp, Wi in STB/bbl; Gp, Gi in Mscf; Bo, Bw in RB/STB(bbl);
// Bg in RB/Mscf; Rs (solution GOR) in scf/STB.
//
// Only the FREE (excess) produced gas contributes to voidage — the solution gas
// (Rs * Np) is already accounted for in Bo, so it is subtracted from produced gas.

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Resolve the FVF/PVT set for a period: per-period overrides win over the global set.
function resolveFvf(globalFvf, period) {
  return {
    Bo: period?.Bo != null && period.Bo !== '' ? num(period.Bo) : num(globalFvf.Bo),
    Bw: period?.Bw != null && period.Bw !== '' ? num(period.Bw) : num(globalFvf.Bw),
    Bg: period?.Bg != null && period.Bg !== '' ? num(period.Bg) : num(globalFvf.Bg),
    Rs: period?.Rs != null && period.Rs !== '' ? num(period.Rs) : num(globalFvf.Rs),
  };
}

export function computePeriodVoidage(period, fvf) {
  const Np = num(period.Np);
  const Wp = num(period.Wp);
  const Gp = num(period.Gp); // Mscf
  const Wi = num(period.Wi);
  const Gi = num(period.Gi); // Mscf
  const { Bo, Bw, Bg, Rs } = fvf;

  // Solution gas already in Bo; only free gas adds reservoir voidage.
  const solutionGasMscf = (Rs * Np) / 1000;
  const freeGasProdMscf = Math.max(0, Gp - solutionGasMscf);

  const producedVoidage = Np * Bo + Wp * Bw + freeGasProdMscf * Bg; // RB
  const injectedVoidage = Wi * Bw + Gi * Bg; // RB
  const instantaneousVRR = producedVoidage > 0 ? injectedVoidage / producedVoidage : null;

  return { producedVoidage, injectedVoidage, freeGasProdMscf, instantaneousVRR };
}

// Compute per-period + running-cumulative VRR for an ordered series of periods.
export function computeVRRSeries(periods, globalFvf) {
  let cumProd = 0;
  let cumInj = 0;
  return periods.map((p, index) => {
    const r = computePeriodVoidage(p, resolveFvf(globalFvf, p));
    cumProd += r.producedVoidage;
    cumInj += r.injectedVoidage;
    const cumulativeVRR = cumProd > 0 ? cumInj / cumProd : null;
    return { ...p, index, ...r, cumProd, cumInj, cumulativeVRR };
  });
}

// Interpret a VRR value into a status band + engineer-facing message.
export function classifyVRR(vrr) {
  if (vrr == null || !Number.isFinite(vrr)) {
    return { label: 'No data', tone: 'neutral' };
  }
  if (vrr < 0.9) {
    return {
      label: 'Under-injection — produced voidage not replaced; expect reservoir pressure to decline.',
      tone: 'warn',
    };
  }
  if (vrr > 1.1) {
    return {
      label: 'Over-injection — injecting more than produced; repressurizing / possible voidage fill-up.',
      tone: 'info',
    };
  }
  return {
    label: 'Balanced — voidage is being replaced; effective pressure maintenance.',
    tone: 'good',
  };
}

// Roll-up KPIs for the whole series.
export function summarizeVRR(series) {
  if (!series.length) return null;
  const last = series[series.length - 1];
  return {
    cumulativeVRR: last.cumulativeVRR,
    latestInstantaneousVRR: last.instantaneousVRR,
    totalProducedVoidage: last.cumProd,
    totalInjectedVoidage: last.cumInj,
    status: classifyVRR(last.cumulativeVRR),
  };
}

// A small realistic demo dataset (monthly volumes) so the app is useful on first open.
export function sampleVRRData() {
  return {
    fvf: { Bo: 1.25, Bw: 1.02, Bg: 0.9, Rs: 550 },
    periods: [
      { label: '2024-01', Np: 62000, Wp: 8000, Gp: 40000, Wi: 40000, Gi: 0 },
      { label: '2024-02', Np: 60000, Wp: 12000, Gp: 39000, Wi: 62000, Gi: 0 },
      { label: '2024-03', Np: 58000, Wp: 16000, Gp: 38000, Wi: 78000, Gi: 0 },
      { label: '2024-04', Np: 56000, Wp: 21000, Gp: 37000, Wi: 90000, Gi: 0 },
      { label: '2024-05', Np: 54000, Wp: 26000, Gp: 36000, Wi: 98000, Gi: 0 },
      { label: '2024-06', Np: 52000, Wp: 30000, Gp: 35000, Wi: 101000, Gi: 0 },
    ],
  };
}
