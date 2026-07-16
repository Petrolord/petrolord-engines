// Result-shaping helpers for the basin forward model (extracted from
// the Suite's BasinFlowGenesis resultsView.js, UI colors left behind).
// Pure data transforms over SimulationEngine.run() output.

/**
 * Build chart rows [{age, [layerName]: value}] from per-layer series
 * arrays of {age, ...} entries.
 * @param {Array<number>} timeSteps - master age list
 * @param {Array<Array>} perLayerSeries - data.<field> arrays
 * @param {Array} layers - meta.layers (same order as perLayerSeries)
 * @param {Function} pick - entry => plotted value (default e.value)
 */
export function alignSeriesByAge(timeSteps, perLayerSeries, layers, pick = (e) => e.value) {
    const maps = layers.map((_, li) => new Map((perLayerSeries[li] || []).map(e => [e.age, e])));
    return timeSteps.map(age => {
        const point = { age };
        layers.forEach((layer, li) => {
            const e = maps[li].get(age);
            if (e !== undefined) point[layer.name] = pick(e);
        });
        return point;
    });
}

/**
 * Final-state depth profile: one point per layer at the last time step,
 * ordered by depth. Used by calibration (modeled vs measured).
 */
export function finalDepthProfile(results) {
    if (!results?.data || !results?.meta) return [];
    const { data, meta } = results;
    const rows = meta.layers.map((layer, li) => {
        const t = data.temperature[li];
        const m = data.maturity[li];
        const b = data.burial[li];
        if (!t?.length || !m?.length || !b?.length) return null;
        const last = t.length - 1;
        return {
            name: layer.name,
            depth: t[last].depth,
            top: b[last].top,
            bottom: b[last].bottom,
            temp: t[last].value,
            ro: m[last].value,
        };
    }).filter(Boolean);
    return rows.sort((a, b) => a.depth - b.depth);
}
