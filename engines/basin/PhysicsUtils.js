/**
 * Physics Utilities for BasinFlow Genesis
 * Unit conversions, interpolation, numerical solvers, and the G7 model
 * spec constants (pinned in tools/validation/basinflow/oracle.py — the
 * oracle and this engine MUST use identical values).
 */

// --- G7 spec constants ---
export const Spec = {
    SECONDS_PER_MA: 3.1536e13,      // 365-day year
    R_GAS: 8.314,                   // J/(mol*K)
    KCAL_TO_J: 4184.0,
    RHO_WATER: 1030.0,              // kg/m3 formation water
    CP_WATER: 4186.0,               // J/(kg*K)
    K_WATER: 0.6,                   // W/(m*K)
    RHO_HC: 850.0,                  // kg/m3 expelled-HC reference density
    S_EXPULSION_THRESHOLD: 0.1,
    MAX_CELL_M: 100.0,              // thermal grid max cell height
    DT_MA: 1.0,                     // simulation step
    DEFAULT_SURFACE_TEMP_C: 20.0,
};

// --- Unit Conversions ---
export const Units = {
    m_to_ft: (m) => m * 3.28084,
    ft_to_m: (ft) => ft / 3.28084,
    c_to_f: (c) => (c * 9/5) + 32,
    f_to_c: (f) => (f - 32) * 5/9,
    c_to_k: (c) => c + 273.15,
    k_to_c: (k) => k - 273.15,
    mpa_to_psi: (mpa) => mpa * 145.038,
    psi_to_mpa: (psi) => psi / 145.038,
    ma_to_sec: (ma) => ma * Spec.SECONDS_PER_MA,
};

// --- Numerical Methods ---

/**
 * Linear Interpolation
 */
export const lerp = (x, x0, x1, y0, y1) => {
    if (x1 === x0) return y0;
    return y0 + (x - x0) * (y1 - y0) / (x1 - x0);
};

/**
 * Value lookup from a set of points (x, y) sorted by x; clamped ends.
 */
export const interpolate = (value, points) => {
    if (!points || points.length === 0) return 0;
    if (value <= points[0].x) return points[0].y;
    if (value >= points[points.length - 1].x) return points[points.length - 1].y;

    for (let i = 0; i < points.length - 1; i++) {
        if (value >= points[i].x && value <= points[i+1].x) {
            return lerp(value, points[i].x, points[i+1].x, points[i].y, points[i+1].y);
        }
    }
    return points[points.length - 1].y;
};

/**
 * Tridiagonal Matrix Algorithm (Thomas Algorithm) solver
 * Solves Ax = d for x
 * a: lower diagonal (length n-1)
 * b: main diagonal (length n)
 * c: upper diagonal (length n-1)
 * d: right hand side (length n)
 */
export const tdma = (a, b, c, d) => {
    const n = d.length;
    if (n === 1) return [d[0] / b[0]];
    const c_prime = new Array(n - 1);
    const d_prime = new Array(n);
    const x = new Array(n);

    // Forward sweep
    c_prime[0] = c[0] / b[0];
    d_prime[0] = d[0] / b[0];

    for (let i = 1; i < n - 1; i++) {
        const temp = b[i] - a[i - 1] * c_prime[i - 1];
        c_prime[i] = c[i] / temp;
        d_prime[i] = (d[i] - a[i - 1] * d_prime[i - 1]) / temp;
    }

    // Last element forward sweep
    const tempLast = b[n - 1] - a[n - 2] * c_prime[n - 2];
    d_prime[n - 1] = (d[n - 1] - a[n - 2] * d_prime[n - 2]) / tempLast;

    // Back substitution
    x[n - 1] = d_prime[n - 1];
    for (let i = n - 2; i >= 0; i--) {
        x[i] = d_prime[i] - c_prime[i] * x[i + 1];
    }

    return x;
};
