/**
 * Ported from the Suite at AS12 (src/lib/__tests__/riskScoring.test.js), the rule
 * tests only. The Suite keeps its whole-tree single-authority guards, its
 * migration vocabulary checks and its colour token tests, which are about
 * the Suite, not the engine.
 */
/**
 * AS2 — the risk scoring authority.
 *
 * The Assurance module had no tests of any kind before this file.
 *
 * Two of these describe blocks are ordinary unit tests. The third is the
 * one that matters: a guard that fails if a second copy of the 5x5
 * thresholds appears anywhere in the module again. Four copies had
 * already accumulated, and they disagreed (see the header of
 * src/lib/riskScoring.js), so a test that only checks the authority
 * would have passed happily while the table page painted a score of 15
 * green.
 */
import {
  APPETITE,
  NO_BAND,
  RISK_BANDS,
  calculateResidualScore,
  calculateRiskScore,
  countByBand,
  deriveRiskFields,
  getAppetiteStatus,
  getRiskBand,
  isReviewOverdue,
} from '../engines/assurance/riskScoring.js';

describe('risk score', () => {
  it('is likelihood times impact across the whole 5x5 matrix', () => {
    for (let l = 1; l <= 5; l += 1) {
      for (let i = 1; i <= 5; i += 1) {
        expect(calculateRiskScore(l, i)).toBe(l * i);
      }
    }
  });

  it('accepts the numeric strings a <select> hands back', () => {
    expect(calculateRiskScore('4', '4')).toBe(16);
  });

  it('refuses a level off the scale rather than scoring it', () => {
    // The old implementation returned 0 for anything non-numeric via
    // `Number(x) || 0`, but happily multiplied a 9 by a 9 into an 81
    // that lands in no band at all.
    expect(calculateRiskScore(9, 9)).toBe(0);
    expect(calculateRiskScore(0, 3)).toBe(0);
    expect(calculateRiskScore(-1, 3)).toBe(0);
    expect(calculateRiskScore(null, 3)).toBe(0);
    expect(calculateRiskScore(undefined, undefined)).toBe(0);
    expect(calculateRiskScore('high', 3)).toBe(0);
  });
});

describe('bands', () => {
  it.each([
    [25, 'Critical'], [16, 'Critical'], [15, 'Critical'],
    [14, 'High'], [12, 'High'], [10, 'High'],
    [9, 'Medium'], [6, 'Medium'], [5, 'Medium'],
    [4, 'Low'], [2, 'Low'], [1, 'Low'],
    [0, NO_BAND],
  ])('scores %i as %s', (score, band) => {
    expect(getRiskBand(score)).toBe(band);
  });

  it('covers every score the 5x5 matrix can produce, with no gaps', () => {
    const reachable = new Set();
    for (let l = 1; l <= 5; l += 1) {
      for (let i = 1; i <= 5; i += 1) reachable.add(l * i);
    }
    reachable.forEach((score) => {
      expect(getRiskBand(score)).not.toBe(NO_BAND);
    });
  });

  it('bands are contiguous and non-overlapping', () => {
    const sorted = [...RISK_BANDS].sort((a, b) => a.min - b.min);
    sorted.forEach((b, idx) => {
      expect(b.min).toBeLessThanOrEqual(b.max);
      if (idx > 0) expect(b.min).toBe(sorted[idx - 1].max + 1);
    });
  });

});

describe('residual risk', () => {
  it('is the inherent score until a residual position is assessed', () => {
    expect(calculateResidualScore({ likelihood: 4, impact: 4 })).toBe(16);
  });

  it('uses the residual pair once it is set', () => {
    expect(calculateResidualScore({
      likelihood: 4, impact: 4, residual_likelihood: 2, residual_impact: 3,
    })).toBe(6);
  });

  it('falls back per axis, not all or nothing', () => {
    // Mitigation that reduces likelihood but not impact is the common
    // case, and it must not silently reset impact to 1.
    expect(calculateResidualScore({
      likelihood: 5, impact: 4, residual_likelihood: 2,
    })).toBe(8);
  });

  it('treats a residual of zero as unassessed rather than as safe', () => {
    expect(calculateResidualScore({ likelihood: 4, impact: 4, residual_likelihood: 0 }))
      .toBe(0);
    expect(getRiskBand(0)).toBe(NO_BAND);
  });
});

describe('appetite', () => {
  it('says nothing when no target is set', () => {
    expect(getAppetiteStatus({ likelihood: 5, impact: 5 })).toBe(APPETITE.NOT_SET);
  });

  it('is within appetite when residual meets the target exactly', () => {
    expect(getAppetiteStatus({
      likelihood: 5, impact: 5, residual_likelihood: 2, residual_impact: 3, target_score: 6,
    })).toBe(APPETITE.WITHIN);
  });

  it('is above appetite when residual exceeds the target', () => {
    expect(getAppetiteStatus({
      likelihood: 5, impact: 5, residual_likelihood: 3, residual_impact: 3, target_score: 6,
    })).toBe(APPETITE.ABOVE);
  });

  it('judges the RESIDUAL score, not the inherent one', () => {
    // A risk mitigated down to 4 against a target of 6 is within
    // appetite even though it started at 25. Judging the inherent score
    // would report every well-controlled risk as a breach.
    expect(getAppetiteStatus({
      likelihood: 5, impact: 5, residual_likelihood: 2, residual_impact: 2, target_score: 6,
    })).toBe(APPETITE.WITHIN);
  });

  it('does not report a pass for a risk that has no score at all', () => {
    expect(getAppetiteStatus({ target_score: 6 })).toBe(APPETITE.NOT_SET);
  });
});

describe('review dates', () => {
  const asOf = new Date('2026-09-16T12:00:00Z');

  it('a risk with no review date is not overdue', () => {
    expect(isReviewOverdue({}, asOf)).toBe(false);
  });

  it('a review due today is not yet overdue', () => {
    expect(isReviewOverdue({ next_review_date: '2026-09-16' }, asOf)).toBe(false);
  });

  it('yesterday is overdue', () => {
    expect(isReviewOverdue({ next_review_date: '2026-09-15' }, asOf)).toBe(true);
  });

  it('tomorrow is not', () => {
    expect(isReviewOverdue({ next_review_date: '2026-09-17' }, asOf)).toBe(false);
  });

  it('an unparseable date is not silently treated as overdue', () => {
    expect(isReviewOverdue({ next_review_date: 'soon' }, asOf)).toBe(false);
  });
});

describe('derived fields written on save', () => {
  it('rating always matches the stored inherent score', () => {
    const d = deriveRiskFields({ likelihood: 4, impact: 4 });
    expect(d.inherentScore).toBe(16);
    expect(d.rating).toBe('Critical');
    expect(d.rating).toBe(getRiskBand(d.inherentScore));
  });

  it('reports inherent and residual separately', () => {
    const d = deriveRiskFields({
      likelihood: 5, impact: 5, residual_likelihood: 2, residual_impact: 2, target_score: 6,
    });
    expect(d.inherentScore).toBe(25);
    expect(d.inherentBand).toBe('Critical');
    expect(d.residualScore).toBe(4);
    expect(d.residualBand).toBe('Low');
    expect(d.appetite_status).toBe(APPETITE.WITHIN);
  });
});

describe('counts', () => {
  const risks = [
    { likelihood: 4, impact: 4 },                                        // 16 Critical
    { likelihood: 3, impact: 3 },                                        // 9  Medium
    { likelihood: 5, impact: 2 },                                        // 10 High
    { likelihood: 4, impact: 2, residual_likelihood: 1, residual_impact: 1 }, // 8 High -> 1 Low
  ];

  it('counts inherent bands', () => {
    expect(countByBand(risks)).toEqual({
      Critical: 1, High: 1, Medium: 2, Low: 0, [NO_BAND]: 0,
    });
  });

  it('counts residual bands differently, which is the point of them', () => {
    expect(countByBand(risks, { residual: true })).toEqual({
      Critical: 1, High: 1, Medium: 1, Low: 1, [NO_BAND]: 0,
    });
  });

  it('every risk lands in exactly one band', () => {
    const total = Object.values(countByBand(risks)).reduce((a, b) => a + b, 0);
    expect(total).toBe(risks.length);
  });
});

describe('AS15 owner decision Q3: whole levels only', () => {
  it('leaves a fractional level unscored', () => {
    expect(calculateRiskScore(2.5, 4)).toBe(0);
    expect(calculateRiskScore(3, '3.5')).toBe(0);
    expect(calculateResidualScore({ likelihood: 4, impact: 5, residual_likelihood: 1.5 })).toBe(0);
  });

  it('still reads a whole number however it is written', () => {
    expect(calculateRiskScore(3.0, '4')).toBe(12);
    expect(calculateRiskScore('4.0', 2)).toBe(8);
  });
});

