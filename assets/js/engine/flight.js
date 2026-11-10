// Simple 1D vertical flight model for the launch animation. No three.js, so it can be unit-tested.
// It is illustrative: it uses whatever masses are in rocket.json and a generic motor curve
// until a real motor (and its ThrustCurve.org data) is chosen.

/** A generic 29 mm G-class single-use motor: ~100 N·s over ~1.5 s. [time s, thrust N] */
export const GENERIC_G = {
  name: 'Generic G-class (placeholder)',
  propellant_g: 60,
  curve: [[0, 0], [0.04, 95], [0.15, 82], [0.6, 72], [1.1, 66], [1.35, 55], [1.5, 12], [1.56, 0]],
};

export function thrustAt(motor, t) {
  const c = motor.curve;
  if (t <= c[0][0] || t >= c[c.length - 1][0]) return 0;
  for (let i = 1; i < c.length; i++) {
    if (t <= c[i][0]) {
      const [t0, f0] = c[i - 1], [t1, f1] = c[i];
      return f0 + (f1 - f0) * (t - t0) / (t1 - t0);
    }
  }
  return 0;
}

export function totalImpulse(motor) {
  let I = 0;
  const c = motor.curve;
  for (let i = 1; i < c.length; i++) I += (c[i][0] - c[i - 1][0]) * (c[i][1] + c[i - 1][1]) / 2;
  return I;
}

/**
 * Integrate from ignition to apogee.
 * mass_g: lift-off mass including the loaded motor. diameter_mm: body diameter.
 * Returns {samples: [{t, h, v, a}], apogee, tApogee, burnout, vMax, aMax, valid}
 */
export function simulateFlight({ mass_g, diameter_mm, motor = GENERIC_G, cd = 0.55, dt = 0.005 }) {
  const g = 9.80665, rho = 1.225;
  const m0 = Math.max((mass_g || 0) / 1000, 0.05);
  const area = Math.PI * Math.pow(Math.max(diameter_mm || 54, 5) / 2000, 2);
  const I = totalImpulse(motor);
  const prop = Math.min((motor.propellant_g || 0) / 1000, m0 * 0.8);
  const burn = motor.curve[motor.curve.length - 1][0];
  let t = 0, h = 0, v = 0, used = 0, vMax = 0, aMax = 0;
  const samples = [{ t: 0, h: 0, v: 0, a: 0 }];
  let lastSample = 0;
  for (let step = 0; step < 200000; step++) {
    const F = thrustAt(motor, t);
    used += F * dt;
    const m = m0 - prop * Math.min(1, I > 0 ? used / I : 0);
    const drag = 0.5 * rho * cd * area * v * Math.abs(v);
    let a = (F - drag) / m - g;
    if (h <= 0 && v <= 0 && a < 0) a = 0; // sitting on the pad until thrust beats weight
    v += a * dt;
    h += v * dt;
    t += dt;
    if (h < 0) { h = 0; if (v < 0) v = 0; }
    vMax = Math.max(vMax, v);
    aMax = Math.max(aMax, a);
    if (t - lastSample >= 0.02) { samples.push({ t, h, v, a }); lastSample = t; }
    if (t > burn && v <= 0) break;
    if (t > 120) break;
  }
  const last = samples[samples.length - 1];
  return { samples, apogee: last.h, tApogee: last.t, burnout: burn, vMax, aMax, valid: last.h > 1, impulse: I };
}

/** Linear interpolation into the sample table at time t. */
export function stateAt(sim, t) {
  const s = sim.samples;
  if (t <= 0) return { ...s[0], t: 0 };
  if (t >= s[s.length - 1].t) return { ...s[s.length - 1] };
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid].t <= t) lo = mid; else hi = mid; }
  const a = s[lo], b = s[hi], k = (t - a.t) / (b.t - a.t || 1);
  return { t, h: a.h + (b.h - a.h) * k, v: a.v + (b.v - a.v) * k, a: a.a + (b.a - a.a) * k };
}
