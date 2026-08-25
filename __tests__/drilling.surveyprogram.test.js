// Survey-program compositing invariants: a single-run program is
// exactly the plain error model; multi-run programs freeze the carry at
// tool changes (ISCWSA tie-on convention), stay symmetric PSD, and
// break the systematic correlation across the tie.

import fs from 'fs';
import path from 'path';
import { computeErrorModel } from '../engines/drilling/errorModel';
import {
  compileSurveyProgram, TOOL_LIBRARY, toolById,
} from '../engines/drilling/surveyProgram';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', 'iscwsa_mwd_rev4_well1.json'),
  'utf8',
));

const stations = G.survey.md.map((md, i) => ({
  md, inc: G.survey.inc[i], azi: G.survey.azi[i],
}));
const header = G.header;
const TD = G.survey.md[G.survey.md.length - 1];

describe('tool library', () => {
  test('ships only validated tools and resolves by id', () => {
    expect(TOOL_LIBRARY.length).toBeGreaterThan(0);
    for (const tool of TOOL_LIBRARY) {
      expect(tool.validated).toBe(true);
      expect(toolById(tool.id)).toBe(tool);
    }
    expect(() => toolById('gyro-imaginary')).toThrow(/Unknown survey tool/);
  });
});

describe('compileSurveyProgram', () => {
  test('single full-well run equals the plain error model exactly', () => {
    const plain = computeErrorModel(stations, header);
    const prog = compileSurveyProgram(stations, header, [
      { fromMd: 0, toMd: TD, toolId: 'iscwsa-mwd-rev4' },
    ]);
    for (let i = 0; i < stations.length; i++) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          expect(prog.totalCov[i][r][c]).toBeCloseTo(plain.totalCov[i][r][c], 10);
        }
      }
    }
    expect(prog.runs).toHaveLength(1);
    expect(prog.runs[0].fromIndex).toBe(0);
    expect(prog.runs[0].toIndex).toBe(stations.length - 1);
  });

  test('two-run program freezes the carry at the tie and stays PSD', () => {
    const tieMd = 2100;
    const plain = computeErrorModel(stations, header);
    const prog = compileSurveyProgram(stations, header, [
      { fromMd: 0, toMd: tieMd, toolId: 'iscwsa-mwd-rev4' },
      { fromMd: tieMd, toMd: TD, toolId: 'iscwsa-mwd-rev4' },
    ]);
    const tieIndex = G.survey.md.indexOf(tieMd);
    // identical up to and including the tie station
    for (let i = 0; i <= tieIndex; i++) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          expect(prog.totalCov[i][r][c]).toBeCloseTo(plain.totalCov[i][r][c], 10);
        }
      }
    }
    // run 2 carries the tie covariance
    expect(prog.runs[1].tieCov).toEqual(prog.totalCov[tieIndex]);
    // below the tie: symmetric PSD, and the tool change breaks the
    // fully-correlated systematic sum, so the composite differs from the
    // single-run model
    let differs = false;
    for (let i = tieIndex + 1; i < stations.length; i++) {
      const c = prog.totalCov[i];
      expect(c[0][1]).toBeCloseTo(c[1][0], 10);
      expect(c[0][0]).toBeGreaterThanOrEqual(0);
      expect(c[1][1]).toBeGreaterThanOrEqual(0);
      expect(c[2][2]).toBeGreaterThanOrEqual(0);
      expect(c[0][0] * c[1][1] - c[0][1] ** 2).toBeGreaterThanOrEqual(-1e-9);
      if (Math.abs(c[0][0] - plain.totalCov[i][0][0]) > 1e-9) differs = true;
    }
    expect(differs).toBe(true);
    // uncertainty still accumulates along run 2
    const trace = (m) => m[0][0] + m[1][1] + m[2][2];
    expect(trace(prog.totalCov[stations.length - 1]))
      .toBeGreaterThan(trace(prog.totalCov[tieIndex]));
  });

  test('degenerate programs are rejected', () => {
    expect(() => compileSurveyProgram(stations, header, []))
      .toThrow(/at least one run/);
    expect(() => compileSurveyProgram(stations, header, [
      { fromMd: 0, toMd: 2100, toolId: 'iscwsa-mwd-rev4' },
      { fromMd: 3000, toMd: TD, toolId: 'iscwsa-mwd-rev4' },
    ])).toThrow(/gap or overlap/);
    expect(() => compileSurveyProgram(stations, header, [
      { fromMd: 0, toMd: 2100, toolId: 'iscwsa-mwd-rev4' },
    ])).toThrow(/does not reach the end/);
    expect(() => compileSurveyProgram(stations, header, [
      { fromMd: 0, toMd: TD, toolId: 'not-a-tool' },
    ])).toThrow(/Unknown survey tool/);
  });
});
