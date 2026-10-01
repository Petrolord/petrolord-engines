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
            // defineProperty, not assignment: a layer named '__proto__' was
            // silently dropped from the series.
            if (e !== undefined) {
                Object.defineProperty(point, layer.name, { value: pick(e), writable: true, enumerable: true, configurable: true });
            }
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

/**
 * U2-004: the present-day profile calibration compares against. The column
 * (slices about 100 m thick through every layer) when the result carries
 * it, so a measured Ro inside a thick layer meets the Ro at its own depth
 * rather than a line drawn between layer centres; the layer centres for a
 * result saved before.
 * @returns {Array<{depth:number, top:number, bottom:number, temp:number, ro:number, layerId?:string}>}
 */
export function calibrationProfile(results) {
    const col = results?.data?.column;
    if (Array.isArray(col) && col.length) {
        return col.map((c) => ({ layerId: c.layerId, depth: c.depth, top: c.top, bottom: c.bottom, temp: c.temp, ro: c.ro }))
            .sort((a, b) => a.depth - b.depth);
    }
    return finalDepthProfile(results);
}
