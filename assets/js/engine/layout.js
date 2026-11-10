// Puts every model into the rocket frame: +X from nose tip (x = 0) to tail, millimetres,
// rocket axis on y = z = 0. Works for any part sizes; nothing here is hard-coded to one design.
import * as THREE from 'three';
import { UNIT_TO_MM, noseNeedsFlip, accumulateVolume, finishCentroid } from './math.js';
import { modelTitle } from './config.js';

const DEG = Math.PI / 180;
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

function forEachMesh(obj, fn) {
  obj.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) fn(o); });
}

function worldBox(obj) {
  obj.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(obj, true);
}

export function samplePoints(obj, max = 60000) {
  obj.updateWorldMatrix(true, true);
  let total = 0;
  forEachMesh(obj, (m) => { total += m.geometry.attributes.position.count; });
  const stride = Math.max(1, Math.ceil(total / max));
  const out = [];
  const v = new THREE.Vector3();
  forEachMesh(obj, (m) => {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(out);
}

function axisVector(axis, box) {
  if (axis === 'x') return new THREE.Vector3(1, 0, 0);
  if (axis === 'y') return new THREE.Vector3(0, 1, 0);
  if (axis === 'z') return new THREE.Vector3(0, 0, 1);
  const s = box.getSize(new THREE.Vector3());
  if (s.x >= s.y && s.x >= s.z) return new THREE.Vector3(1, 0, 0);
  if (s.y >= s.z) return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

/** The rocket axis passes through the centre of the longest part (normally a body tube). */
function radialCentre(parts) {
  let best = null, bestLen = -1;
  for (const p of parts) {
    const b = worldBox(p.group);
    if (b.isEmpty()) continue;
    const len = b.max.x - b.min.x;
    if (len > bestLen) { bestLen = len; best = b; }
  }
  return best ? best.getCenter(new THREE.Vector3()) : new THREE.Vector3();
}

function orient(container, parts, { axis = 'auto', flip = false, roll = 0, preOriented = false }) {
  container.updateWorldMatrix(true, true);
  const box0 = worldBox(container);
  if (box0.isEmpty()) throw new Error('Model has no geometry.');
  if (!preOriented) {
    const av = axisVector(axis, box0);
    container.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(av, AXIS_X));
    container.updateWorldMatrix(true, true);
    const c = radialCentre(parts);
    let needFlip = noseNeedsFlip(samplePoints(container), c.y, c.z);
    if (flip) needFlip = !needFlip;
    if (needFlip) container.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Y, Math.PI));
  } else if (flip) {
    container.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Y, Math.PI));
  }
  if (roll) container.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(AXIS_X, roll * DEG));
  container.updateWorldMatrix(true, true);
  const c = radialCentre(parts);
  const b = worldBox(container);
  container.position.x -= b.min.x;
  container.position.y -= c.y;
  container.position.z -= c.z;
  container.updateWorldMatrix(true, true);
  return { length: b.max.x - b.min.x };
}

/**
 * instances: [{index, entry (model config), source (loader result)}]
 * Returns {parts, length, radialMax, modelInfo, warnings}. Each part has a THREE.Group in the rocket frame
 * plus analysis `a` (bounding box, volume centroid, radial size, stations).
 */
export function layoutModels(instances, config) {
  const mode = config.rocket.layout;
  const scene = new THREE.Group();
  const parts = [];
  const modelInfo = {};
  const warnings = [];

  const entries = instances.map((inst) => {
    const m = inst.entry, src = inst.source;
    const c = new THREE.Group();
    const unitKey = src.fixedUnits || (m.units === 'auto' ? src.defaultUnits || 'mm' : m.units);
    c.scale.setScalar(UNIT_TO_MM[unitKey] ?? 1);
    if (!src.preOriented) {
      const r = m.rotate_deg || [0, 0, 0];
      c.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG);
    }
    const mine = src.parts.map((sp, k) => {
      const g = sp.object.clone(true);
      g.name = sp.name;
      c.add(g);
      return {
        id: `${inst.index}:${k}`, name: sp.name, group: g, modelIndex: inst.index, model: m,
        cadColor: sp.cadColor, isPlaceholder: !!m.placeholder,
      };
    });
    scene.add(c);
    parts.push(...mine);
    return { inst, c, mine, unitKey };
  });

  if (mode === 'assembly') {
    const big = new THREE.Group();
    scene.add(big);
    entries.forEach((e) => big.add(e.c));
    orient(big, parts, {
      axis: config.rocket.axis, flip: config.rocket.flip, roll: config.rocket.roll_deg,
      preOriented: entries.every((e) => e.inst.source.preOriented),
    });
    entries.forEach((e) => {
      const b = worldBox(e.c);
      modelInfo[e.inst.index] = { length: b.max.x - b.min.x, start: b.min.x, units: e.unitKey };
    });
  } else {
    let cursor = 0;
    entries.forEach((e, j) => {
      const m = e.inst.entry;
      const info = orient(e.c, e.mine, { axis: m.axis, flip: m.flip, roll: m.roll_deg, preOriented: e.inst.source.preOriented });
      const start = Number.isFinite(m.start_mm) ? m.start_mm : j === 0 ? 0 : cursor + (m.gap_mm || 0);
      e.c.position.x += start;
      e.c.updateWorldMatrix(true, true);
      cursor = start + info.length;
      modelInfo[e.inst.index] = { length: info.length, start, units: e.unitKey };
    });
  }

  scene.updateWorldMatrix(true, true);
  const root = new THREE.Group();
  for (const p of parts) root.attach(p.group);
  for (const p of parts) {
    const o = p.model.offset_mm;
    if (o && (o[0] || o[1] || o[2])) p.group.position.add(new THREE.Vector3(o[0], o[1], o[2]));
  }
  root.updateWorldMatrix(true, true);

  // Station zero = nose tip
  const all = new THREE.Box3().setFromObject(root, true);
  if (!all.isEmpty() && Math.abs(all.min.x) > 1e-6) {
    const dx = all.min.x;
    for (const p of parts) p.group.position.x -= dx;
    for (const k of Object.keys(modelInfo)) modelInfo[k].start -= dx;
    root.updateWorldMatrix(true, true);
  }

  let length = 0, radialMax = 0;
  for (const p of parts) {
    p.a = analysePart(p.group);
    length = Math.max(length, p.a.aft);
    radialMax = Math.max(radialMax, p.a.radialMax);
  }

  for (const inst of instances) {
    const info = modelInfo[inst.index];
    if (!info) continue;
    if (info.length < 20 || info.length > 8000) {
      warnings.push(`${modelTitle(inst.entry)} comes out ${Math.round(info.length)} mm long — check its units setting.`);
    }
  }
  return { parts, length, radialMax, modelInfo, warnings };
}

/** Bounding box, volume centroid and radial size of one part, in the rocket frame. */
export function analysePart(group) {
  group.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(group, true);
  const acc = { v: 0, x: 0, y: 0, z: 0 };
  let rmax = 0;
  const v = new THREE.Vector3();
  forEachMesh(group, (m) => {
    const pos = m.geometry.attributes.position;
    const w = new Float64Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      w[i * 3] = v.x; w[i * 3 + 1] = v.y; w[i * 3 + 2] = v.z;
      const r = Math.hypot(v.y, v.z);
      if (r > rmax) rmax = r;
    }
    const idx = m.geometry.index;
    accumulateVolume(w, idx ? idx.array : null, acc);
  });
  const centre = box.getCenter(new THREE.Vector3());
  const c = finishCentroid(acc, { min: box.min.toArray(), max: box.max.toArray() });
  return {
    box, centre,
    centroid: c ? new THREE.Vector3(c.x, c.y, c.z) : centre.clone(),
    volume: c ? c.volume : 0,
    radialMax: rmax,
    front: box.min.x, aft: box.max.x,
    length: box.max.x - box.min.x,
  };
}
