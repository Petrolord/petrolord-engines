/**
 * Calibration Calculator
 * Statistical utilities for misfit calculation
 */
export class CalibrationCalculator {
    
    static calculateRMS(measured, modelled) {
        if (!measured || !modelled || measured.length === 0) return 0;
        const sumSq = measured.reduce((acc, m, i) => {
            const diff = m - modelled[i];
            return acc + (diff * diff);
        }, 0);
        return Math.sqrt(sumSq / measured.length);
    }

    static calculateMAE(measured, modelled) {
        if (!measured || !modelled || measured.length === 0) return 0;
        const sumAbs = measured.reduce((acc, m, i) => {
            return acc + Math.abs(m - modelled[i]);
        }, 0);
        return sumAbs / measured.length;
    }

    static calculateR2(measured, modelled) {
        if (!measured || !modelled || measured.length === 0) return 0;
        const meanMeasured = measured.reduce((a, b) => a + b, 0) / measured.length;
        const ssTot = measured.reduce((acc, m) => acc + Math.pow(m - meanMeasured, 2), 0);
        const ssRes = measured.reduce((acc, m, i) => acc + Math.pow(m - modelled[i], 2), 0);
        return 1 - (ssRes / ssTot);
    }

    /**
     * Interpolate model values to match measured depths
     * @param {Array} modelDepths 
     * @param {Array} modelValues 
     * @param {Array} measuredDepths 
     */
    static interpolateToMeasured(modelDepths, modelValues, measuredDepths) {
        return measuredDepths.map(d => {
            // Simple linear interpolation
            // Find indices
            const idx = modelDepths.findIndex(md => md >= d);
            if (idx === -1) return modelValues[modelValues.length - 1]; // Deeper than model
            if (idx === 0) return modelValues[0]; // Shallower than model
            
            const d0 = modelDepths[idx-1];
            const d1 = modelDepths[idx];
            const v0 = modelValues[idx-1];
            const v1 = modelValues[idx];
            
            return v0 + (d - d0) * (v1 - v0) / (d1 - d0);
        });
    }
}