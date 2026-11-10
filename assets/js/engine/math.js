// Pure maths helpers (no three.js) so they can be unit-tested in Node.
// All lengths are millimetres, the rocket axis is +X (nose tip at x = 0, tail at x = length).

export const UNIT_TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Glob with * and ? wildcards, case-insensitive. A pattern without wildcards is an exact match. */
export function globToRegExp(glob) {
  const esc = String(glob ?? '')
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + esc + '$', 'i');
}

const INSTANCE_SUFFIXES = [
  /\s*<\d+>$/,      // SolidWorks  "Fin<1>"
  /\s*\(\d+\)$/,    // generic     "Fin (2)"
  /:\d+$/,          // Fusion 360  "Fin:1"
  /\.\d{3}$/,       // Blender     "Fin.001"
  /-\d+$/,          // SolidWorks  "Fin-1"
  /_\d+$/,          //             "Fin_1"
  /\s+v\d+$/i,      // Fusion 360  "Fin v3"
];

/** Strip CAD instance/version suffixes: "Fin-2" -> "Fin", "Nose Cone v3:1" -> "Nose Cone". */
export function baseName(name) {
  const original = String(name ?? '').trim();
  let s = original;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const re of INSTANCE_SUFFIXES) {
      if (re.test(s)) {
        const next = s.replace(re, '').trim();
        if (next) { s = next; changed = true; }
      }
    }
    if (!changed) break;
  }
  return s || original;
}

/**
 * Accumulate signed volume and first moments of a closed triangle mesh.
 * pos: flat xyz array (world coordinates); index: triangle index array or null.
 */
export function accumulateVolume(pos, index, acc) {
  const n = index ? index.length : pos.length / 3;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = (index ? index[t] : t) * 3;
    const b = (index ? index[t + 1] : t + 1) * 3;
    const c = (index ? index[t + 2] : t + 2) * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    acc.v += v;
    acc.x += v * (ax + bx + cx) / 4;
    acc.y += v * (ay + by + cy) / 4;
    acc.z += v * (az + bz + cz) / 4;
  }
  return acc;
}

/** Returns {volume, x, y, z} or null if the mesh encloses no volume (open surface). */
export function finishCentroid(acc, bounds) {
  if (!acc || Math.abs(acc.v) < 1e-6) return null;
  const c = { volume: Math.abs(acc.v), x: acc.x / acc.v, y: acc.y / acc.v, z: acc.z / acc.v };
  if (bounds) {
    const pad = 0.02 * Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2], 1e-6);
    const inside = [0, 1, 2].every((i) => {
      const v = [c.x, c.y, c.z][i];
      return v >= bounds.min[i] - pad && v <= bounds.max[i] + pad;
    });
    if (!inside) return null; // open or badly-wound mesh: caller falls back to bbox centre
  }
  return c;
}

/**
 * Decide whether a model aligned with +X has its nose at the max-X end (and so needs flipping).
 * Compares the largest radial extent in the first and last 10 % of the length:
 * a nose is narrow, a tail has fins / full-diameter tube.
 */
export function noseNeedsFlip(points, cy = 0, cz = 0, band = 0.1) {
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const L = maxX - minX;
  if (!(L > 0)) return false;
  const lo = minX + band * L, hi = maxX - band * L;
  let rLo = 0, rHi = 0, nLo = 0, nHi = 0;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const r = Math.hypot(points[i + 1] - cy, points[i + 2] - cz);
    if (x <= lo) { nLo++; if (r > rLo) rLo = r; }
    if (x >= hi) { nHi++; if (r > rHi) rHi = r; }
  }
  if (!nLo || !nHi) return false;
  return rHi < rLo * 0.9;
}

function interp(table, x) {
  if (!table.length) return 0;
  if (x <= table[0].x) return table[0].a;
  const last = table[table.length - 1];
  if (x >= last.x) return last.a;
  for (let k = 1; k < table.length; k++) {
    const p = table[k - 1], q = table[k];
    if (x <= q.x) {
      const span = q.x - p.x;
      return span < 1e-9 ? (p.a + q.a) / 2 : p.a + (q.a - p.a) * (x - p.x) / span;
    }
  }
  return last.a;
}

/**
 * Exploded-view offsets.
 * items: [{centreX, cy, cz, override?: {axial_mm, radial_mm}}]
 * Parts near the axis are spread along the axis by rank (so nested parts separate),
 * parts off the axis (fins, rail buttons) follow their neighbourhood and also move outward.
 * Returns [{axial, radial, dy, dz}] where the radial direction is (dy, dz).
 */
export function explodeOffsets(items, { length, radius, gap = 0.06, radialFactor = 1.6 } = {}) {
  const L = Math.max(length || 1, 1);
  const R = Math.max(radius || L * 0.03, 1e-3);
  const step = gap * L;
  const offAxisLimit = R * 0.4;
  const res = items.map(() => ({ axial: 0, radial: 0, dy: 1, dz: 0 }));

  const onAxis = [];
  items.forEach((it, i) => {
    const r = Math.hypot(it.cy || 0, it.cz || 0);
    if (r > 1e-6) { res[i].dy = it.cy / r; res[i].dz = it.cz / r; }
    if (r <= offAxisLimit) onAxis.push({ i, x: it.centreX });
  });
  onAxis.sort((a, b) => a.x - b.x || a.i - b.i);
  const n = onAxis.length;
  onAxis.forEach((o, k) => { res[o.i].axial = (k - (n - 1) / 2) * step; });
  const table = onAxis.map((o) => ({ x: o.x, a: res[o.i].axial }));

  items.forEach((it, i) => {
    const r = Math.hypot(it.cy || 0, it.cz || 0);
    if (r > offAxisLimit) {
      res[i].axial = n ? interp(table, it.centreX) : (it.centreX / L - 0.5) * step * 4;
      res[i].radial = radialFactor * R;
    }
    const o = it.override || {};
    if (Number.isFinite(o.axial_mm)) res[i].axial = o.axial_mm;
    if (Number.isFinite(o.radial_mm)) res[i].radial = o.radial_mm;
  });
  return res;
}

/** Centre of gravity from [{mass_g, x}] entries (x = station in mm). */
export function computeCG(entries) {
  let m = 0, mx = 0;
  for (const e of entries) {
    if (Number.isFinite(e.mass_g) && e.mass_g > 0 && Number.isFinite(e.x)) {
      m += e.mass_g;
      mx += e.mass_g * e.x;
    }
  }
  return m > 0 ? mx / m : null;
}

/** Stability margin in calibers and a status word for colouring. */
export function stability(cg, cp, diameter) {
  if (!Number.isFinite(cg) || !Number.isFinite(cp) || !(diameter > 0)) return { margin: null, status: 'unknown' };
  const margin = (cp - cg) / diameter;
  let status = 'good';
  if (margin < 0.5) status = 'unsafe';
  else if (margin < 1) status = 'low';
  else if (margin > 3) status = 'very-high';
  else if (margin > 2) status = 'high';
  return { margin, status };
}

/**
 * Build order for the assembly animation.
 * items: [{id, order, modelIndex, radialMax, centreX}]
 * Explicit "order" first; otherwise aft section first, inner parts before outer, tail before nose.
 */
export function assemblyOrder(items) {
  const big = Number.POSITIVE_INFINITY;
  return [...items]
    .sort((a, b) => {
      const oa = Number.isFinite(a.order) ? a.order : big;
      const ob = Number.isFinite(b.order) ? b.order : big;
      if (oa !== ob) return oa < ob ? -1 : 1;
      if (a.modelIndex !== b.modelIndex) return b.modelIndex - a.modelIndex;
      if (Math.abs(a.radialMax - b.radialMax) > 0.5) return a.radialMax - b.radialMax;
      return b.centreX - a.centreX;
    })
    .map((it) => it.id);
}

/** A "nice" tick step (1, 2 or 5 x 10^n) giving roughly `target` ticks across `span`. */
export function niceStep(span, target = 8) {
  const raw = Math.max(span, 1e-9) / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

/** Format a number for display: fmt(812.345) -> "812", fmt(1.234, 2) -> "1.23". */
export function fmt(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function slug(s) {
  return String(s || 'rocket').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rocket';
}
