// Literature gates (Well Design Studio WD6 follow-on): survey-engine
// results vs published textbook truth. First entry: the Applied
// Drilling Engineering ch.8 survey-calculation example (Bourgoyne et
// al. 1991), secured via its attributed open-access republication
// (Amorin & Broni-Bediako 2010, RJASET 2(7):679-686) — see the golden's
// description for the provenance chain and the closed-form identity
// the published numbers satisfy.

import fs from 'fs';
import path from 'path';
import { computeWellPath } from '../engines/drilling/surveyMath';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', 'ade_ch8_survey_methods.json'),
  'utf8',
));

describe('ADE ch.8 survey-calculation example (Bourgoyne et al. 1991)', () => {
  const stations = G.survey.md.map((md, i) => ({
    md, inc: G.survey.inc[i], azi: G.survey.azi[i],
  }));
  const path_ = computeWellPath(stations, { surfaceX: 0, surfaceY: 0, kb: 0 });
  const last = path_[path_.length - 1];
  const exp = G.expected.minimumCurvature;
  const tol = G.expected.tolerance;

  test(`minimum-curvature TVD matches the published ${exp.tvd} ft`, () => {
    expect(Math.abs(last.tvd - exp.tvd)).toBeLessThanOrEqual(tol);
  });

  test(`north displacement matches the published ${exp.northDisplacement} ft`, () => {
    expect(Math.abs(last.y - exp.northDisplacement)).toBeLessThanOrEqual(tol);
    // due-north well: no east displacement
    expect(Math.abs(last.x)).toBeLessThan(1e-9);
  });

  test('published values satisfy the closed-form build-arc identity', () => {
    const R = 100 / ((3 * Math.PI) / 180);
    expect(R * Math.sin(Math.PI / 3)).toBeCloseTo(exp.tvd, 2);
    expect(R * (1 - Math.cos(Math.PI / 3))).toBeCloseTo(exp.northDisplacement, 2);
  });
});
