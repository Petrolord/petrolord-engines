// Reservoir Simulation Studio U2-004 reads the Carter-Tracy influence
// function of the MBAL engine through carterTracyPD: the export is the
// function computeCarterTracyWe uses (pinned values; the Dake 9.2 gates of
// mbal.test.ts hold computeCarterTracyWe itself).
import { carterTracyPD } from '../engines/mbal/mbalEngine.ts';

describe('carterTracyPD', () => {
  test('infinite acting: the Lee-Wattenbarger fit, pinned at tD = 1 and 100', () => {
    const lw = (tD: number) => {
      const s = Math.sqrt(tD);
      return (370.529 * s + 137.582 * tD + 5.69549 * tD * s) / (328.834 + 265.488 * s + 45.2157 * tD + tD * s);
    };
    expect(carterTracyPD(1)).toBeCloseTo(lw(1), 15);
    expect(carterTracyPD(100)).toBeCloseTo(lw(100), 15);
    // van Everdingen-Hurst infinite aquifer: pD(1) = 0.802, pD(100) = 2.723 (published table, 3 decimals)
    expect(carterTracyPD(1)).toBeCloseTo(0.802, 2);
    expect(carterTracyPD(100)).toBeCloseTo(2.723, 2);
    expect(carterTracyPD(0)).toBe(0);
    expect(carterTracyPD(5, 1)).toBe(carterTracyPD(5));
  });
  test('finite reD = 5: pseudo-steady state late, 2 tD / (reD^2 - 1) + ln(reD) - 0.75', () => {
    const tD = 100;
    expect(carterTracyPD(tD, 5)).toBeCloseTo((2 * tD) / 24 + Math.log(5) - 0.75, 6);
    // early, the blend is still the infinite-acting solution to three decimals
    expect(carterTracyPD(0.1, 5)).toBeCloseTo(carterTracyPD(0.1), 2);
  });
});
