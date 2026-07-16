import { SimulationEngine } from './SimulationEngine';
import { CalibrationCalculator } from './CalibrationCalculator';
import { finalDepthProfile } from './results';

/**
 * Real heat-flow auto-calibration (replaces the pre-G7 Math.random
 * "auto-tune"): golden-section search minimising the weighted misfit of
 * modeled vs measured Ro and temperature at the calibration depths.
 *
 * Constant heat flow -> fits the value directly (bounds 30-150 mW/m2).
 * Variable heat flow -> fits a multiplicative scale on the whole
 * history (bounds 0.5-2.0), preserving its shape.
 */
export class HeatFlowFitter {

    // Standard misfit weights: 0.1 %Ro and 10 C are "one unit" of error.
    static RO_SIGMA = 0.1;
    static TEMP_SIGMA = 10.0;

    static applyCandidate(heatFlow, x) {
        if (heatFlow?.type === 'variable' && Array.isArray(heatFlow.history)) {
            return {
                ...heatFlow,
                value: (heatFlow.value ?? 60) * x,
                history: heatFlow.history.map(p => ({ ...p, value: p.value * x })),
            };
        }
        return { ...(heatFlow || { type: 'constant' }), value: x };
    }

    static bounds(heatFlow) {
        return heatFlow?.type === 'variable' ? [0.5, 2.0] : [30, 150];
    }

    static async misfit(project, roPoints, bhtPoints) {
        const results = await SimulationEngine.run(project);
        const prof = finalDepthProfile(results);
        const depths = prof.map(p => p.depth);
        let sum = 0;
        let n = 0;
        if (roPoints.length > 0) {
            const modeled = CalibrationCalculator.interpolateToMeasured(
                depths, prof.map(p => p.ro), roPoints.map(p => p.depth));
            roPoints.forEach((p, i) => {
                const e = (p.value - modeled[i]) / HeatFlowFitter.RO_SIGMA;
                sum += e * e;
                n += 1;
            });
        }
        if (bhtPoints.length > 0) {
            const modeled = CalibrationCalculator.interpolateToMeasured(
                depths, prof.map(p => p.temp), bhtPoints.map(p => p.depth));
            bhtPoints.forEach((p, i) => {
                const e = (p.value - modeled[i]) / HeatFlowFitter.TEMP_SIGMA;
                sum += e * e;
                n += 1;
            });
        }
        return n > 0 ? sum / n : 0;
    }

    /**
     * @returns {Promise<{heatFlow, misfit, evaluations}>} fitted result
     */
    static async fit(baseProject, roPoints, bhtPoints, onProgress) {
        const [lo0, hi0] = HeatFlowFitter.bounds(baseProject.heatFlow);
        const phi = (Math.sqrt(5) - 1) / 2;
        const maxIter = 16;

        const evalAt = async (x) => HeatFlowFitter.misfit(
            { ...baseProject, heatFlow: HeatFlowFitter.applyCandidate(baseProject.heatFlow, x) },
            roPoints, bhtPoints);

        let lo = lo0, hi = hi0;
        let x1 = hi - phi * (hi - lo);
        let x2 = lo + phi * (hi - lo);
        let f1 = await evalAt(x1);
        let f2 = await evalAt(x2);
        let evaluations = 2;

        for (let i = 0; i < maxIter; i++) {
            if (f1 <= f2) {
                hi = x2;
                x2 = x1; f2 = f1;
                x1 = hi - phi * (hi - lo);
                f1 = await evalAt(x1);
            } else {
                lo = x1;
                x1 = x2; f1 = f2;
                x2 = lo + phi * (hi - lo);
                f2 = await evalAt(x2);
            }
            evaluations += 1;
            if (onProgress) onProgress(Math.round(((i + 1) / maxIter) * 100));
        }

        const xBest = f1 <= f2 ? x1 : x2;
        return {
            heatFlow: HeatFlowFitter.applyCandidate(baseProject.heatFlow, xBest),
            misfit: Math.min(f1, f2),
            evaluations,
        };
    }
}
