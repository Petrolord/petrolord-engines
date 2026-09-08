/**
 * VENDORED VERBATIM from the Suite's src/utils/fdp/scheduleCalculations.js in the EC0 Economics
 * extraction wave (2026-09-08). The only edit is the import: 'date-fns' became '../../../lib/dates/dates.js' (the vendored subset). Note that none of the four imported helpers is called by this module; the import line is kept so the file stays verbatim. Note also that calculateCPM does not run a critical path method: it passes the caller's float through (see FINDINGS-fdp.md).
 * Behaviour is unchanged; the gates in __tests__/economics.fdp.test.js and the
 * independent oracle tools/validation/economics/oracle_fdp.py cover it.
 */
/**
 * Schedule Calculations Utility
 * Implements Critical Path Method (CPM) and other schedule metrics.
 */

import { addDays, differenceInDays, parseISO, format } from '../../../lib/dates/dates.js';

export const calculateProjectDuration = (activities) => {
    if (!activities || activities.length === 0) return 0;
    const endDates = activities.map(a => new Date(a.endDate).getTime());
    const startDates = activities.map(a => new Date(a.startDate).getTime());
    
    const minStart = Math.min(...startDates);
    const maxEnd = Math.max(...endDates);
    
    return Math.ceil((maxEnd - minStart) / (1000 * 60 * 60 * 24));
};

export const calculateCPM = (activities) => {
    // Simplified CPM: 
    // 1. Map activities to efficient structure
    // 2. Forward Pass (ES, EF)
    // 3. Backward Pass (LS, LF)
    // 4. Float = LS - ES
    
    // Note: Real CPM requires strict dependencies. We'll infer or use provided dependencies.
    // For this MVP, we'll focus on Float based on user input dates vs inferred dates if strict logic existed.
    // Since user inputs dates directly in this UI, we calculate "Theoretical" Critical Path based on 0-float logic
    // assuming end-to-start dependencies are tightest constraints.
    
    // Returning placeholder logic for highlighting
    return activities.map(a => ({
        ...a,
        isCritical: a.float === 0 || a.float === undefined, // Default to critical if not calculated
        float: a.float || 0
    }));
};

export const calculateResourceRequirements = (activities) => {
    // Aggregate resources by time period (e.g. monthly)
    const resourceProfile = {};
    
    activities.forEach(activity => {
        if (!activity.resources) return;
        
        // Simplified: just summing total required, not time-distributed
        const { crew, cost } = activity.resources;
        // ... implementation would distribute over activity duration
    });

    return resourceProfile;
};

export const identifyMilestones = (activities) => {
    return activities.filter(a => a.type === 'Milestone' || a.duration === 0);
};