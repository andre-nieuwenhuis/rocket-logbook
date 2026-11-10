// The persistent 3D rocket behind every page. Wraps the viewer engine in assets/js/engine/.
// Pages call stage.show(project, iteration) and stage.pose(name); the model tab uses the tool functions.
import { filePath } from './store.js';

const listeners = {};
const emit = (evt, ...a) => (listeners[evt] || []).forEach((fn) => fn(...a));

let E = null;            // engine modules, loaded on first use
let viewer = null;
let loading = null;
const cache = new Map(); // "project/iteration" -> { parts, layout, config, items, rocket }
let current = null;      // cache entry on stage
let currentKey = '';
let showToken = 0;
let ghostGroup = null;
let measure = { on: false, pts: [], line: null, handler: null };
let changesOn = false;
let poseName = 'home';

export const stage = {
  failed: false,
  on(evt, fn) { (listeners[evt] ||= []).push(fn); },
  get items() { return current ? current.items : []; },
  get rocket() { return current ? current.rocket : null; },
  get key() { return currentKey; },
  show, pose, setTheme, selectLabel, clearSelection,
  setExplode: (t) => viewer && viewer.setExplode(t),
  setCutaway: (on) => viewer && viewer.setCutaway(on),
  setXray: (on) => viewer && viewer.setXray(on),
  resetView() { if (!viewer) return; viewer.isolate(null); viewer.select(null); viewer.setExplode(0); viewer.fitView(true); },
  showChanges, playAssembly, stopAssembly: () => viewer && viewer.stopAssembly(),
  setGhost, setMeasure, focusLabel,
  /** Part names found in a CAD file the user picked (used by the Builder). */
  async partNamesFromFile(file) {
    await ensure();
    const ext = file.name.split('.').pop().toLowerCase();
    const url = URL.createObjectURL(file);
    try {
      const src = await E.loaders.loadSource({ url, ext, displayName: file.name.replace(/\.[^.]+$/, '') });
      return [...new Set(src.parts.map((p) => E.math.baseName(p.name)))];
    } finally { URL.revokeObjectURL(url); }
  },
};

async function ensure() {
  if (viewer) return;
  if (stage.failed) throw new Error('3D engine unavailable');
  if (!loading) {
    loading = (async () => {
      const [THREE, v, loaders, layout, math, config, appearance] = await Promise.all([
        import('three'), import('./engine/viewer.js'), import('./engine/loaders.js'), import('./engine/layout.js'),
        import('./engine/math.js'), import('./engine/config.js'), import('./engine/appearance.js'),
      ]);
      E = { THREE, loaders, layout, math, config, appearance };
      viewer = new v.RocketViewer(document.getElementById('stage-view'), document.getElementById('stage-overlay'), { accent: '#5eead4' });
      viewer.setTheme(document.documentElement.dataset.theme !== 'light');
      viewer.on('select', (p) => emit('select', p ? p.item : null, p));
      viewer.on('balloon', (it) => { const p = viewer.byId.get(it.partIds[0]); if (p) viewer.select(p.id, { focus: true }); });
      applyPoseSettings();
    })().catch((e) => { stage.failed = true; console.error(e); emit('failed', e); throw e; });
  }
  await loading;
}

function engineConfig(project, it) {
  const m = it.model || {};
  return E.config.normaliseConfig({
    rocket: { title: `${project.name} ${it.name}`, layout: m.layout || 'stack', axis: m.axis || 'auto', flip: !!m.flip, diameter_mm: m.diameter_mm ?? null },
    stability: m.stability || {},
    models: (m.models || []).map((x) => (x.file ? { ...x, file: filePath(project.id, it.id, x.file) } : { ...x })),
    parts: (it.parts || []).filter((p) => p.match).map((p) => ({
      match: p.match, model: p.model, label: p.label, material: p.material, mass_g: p.mass_g, description: p.description, color: p.color, order: p.order, hidden: p.hidden,
    })),
    extra_masses: m.extra_masses || [],
  }).config;
}

/** Load every model of one iteration and lay it out in the rocket frame. Cached per iteration. */
async function build(project, it) {
  const key = `${project.id}/${it.id}`;
  if (cache.has(key)) return cache.get(key);
  const cfg = engineConfig(project, it);
  const results = await Promise.all(cfg.models.map((m, i) => {
    const req = m.placeholder
      ? { placeholder: m.placeholder, params: m.params }
      : { url: m.file, ext: E.config.fileExt(m.file), displayName: E.config.fileBase(m.file).replace(/\.[^.]+$/, '') };
    return E.loaders.loadSource(req).then((source) => ({ index: i, entry: m, source }), (error) => ({ index: i, entry: m, error }));
  }));
  const errors = results.filter((r) => r.error).map((r) => `${E.config.modelTitle(r.entry)}: ${r.error.message || r.error}`);
  const ok = results.filter((r) => !r.error);
  let layout = { parts: [], length: 0, radialMax: 0, warnings: [] };
  if (ok.length) layout = E.layout.layoutModels(ok, cfg);
  const parts = layout.parts;
  for (const p of parts) {
    p.base = p.group.position.clone();
    p.meta = E.config.resolvePartMeta(cfg, p.name, p.model);
    p.info = [...(it.parts || [])].reverse().find((r) => r.match && E.config.ruleMatches(r, p.name, p.model)) || null;
    p.label = p.meta.label || E.math.baseName(p.name);
    p.hidden = !!p.meta.hidden;
  }
  const map = new Map();
  for (const p of parts) {
    const k = p.label.toLowerCase();
    if (!map.has(k)) map.set(k, { key: k, label: p.label, parts: [], info: p.info, meta: p.meta });
    map.get(k).parts.push(p);
  }
  const items = [...map.values()].sort((a, b) => a.parts[0].a.front - b.parts[0].a.front || a.label.localeCompare(b.label));
  items.forEach((item, i) => {
    item.number = i + 1; item.qty = item.parts.length;
    item.length = Math.max(...item.parts.map((p) => p.a.length));
    item.parts.forEach((p) => { p.item = item; });
  });

  let D = cfg.rocket.diameter_mm;
  if (!(D > 0)) { let longest = null; for (const p of parts) if (!longest || p.a.length > longest.a.length) longest = p; D = longest ? Math.round(longest.a.radialMax * 20) / 10 : 50; }
  const cgEntries = []; let total = 0;
  for (const p of parts) if (Number.isFinite(p.meta.mass_g)) { total += p.meta.mass_g; cgEntries.push({ mass_g: p.meta.mass_g, x: p.a.centroid.x }); }
  const cg = Number.isFinite(cfg.stability.cg_mm) ? cfg.stability.cg_mm : E.math.computeCG(cgEntries);
  const cp = cfg.stability.cp_mm;
  const rocket = { length: layout.length, diameter: D, totalMass: total, cg, cp, ...E.math.stability(cg, cp, D) };
  const offs = E.math.explodeOffsets(parts.map((p) => ({ centreX: p.a.centre.x, cy: p.a.centre.y, cz: p.a.centre.z, override: p.meta.explode })), { length: layout.length, radius: D / 2, gap: 0.06 });
  parts.forEach((p, i) => { p.explode = new E.THREE.Vector3(offs[i].axial, offs[i].radial * offs[i].dy, offs[i].radial * offs[i].dz); });

  const entry = { key, parts, layout, items, rocket, errors, warnings: layout.warnings || [] };
  cache.set(key, entry);
  return entry;
}

async function show(project, it) {
  const key = `${project.id}/${it.id}`;
  if (key === currentKey) return current;
  const token = ++showToken;
  try { await ensure(); } catch (e) { return null; }
  emit('loading', true);
  let entry;
  try { entry = await build(project, it); }
  catch (e) { console.error(e); emit('loading', false); emit('error', `Could not load the 3D model: ${e.message}`); return null; }
  if (token !== showToken) return null;
  const first = !current;
  setGhost(null); setMeasure(false);
  current = entry; currentKey = key;
  viewer.setParts(entry.parts, { length: entry.rocket.length || 1000, diameter: entry.rocket.diameter || 50, radialMax: entry.layout.radialMax || 50 });
  applyLooks();
  viewer.setExplodeVectors(new Map(entry.parts.map((p) => [p.id, p.explode])));
  viewer.setBalloons(entry.items.map((x) => ({ key: x.key, number: x.number, text: x.label, partIds: x.parts.map((p) => p.id) })));
  const R = entry.rocket, f = E.math.fmt, markers = [];
  if (Number.isFinite(R.cg)) markers.push({ key: 'cg', kind: 'cg', station: R.cg, label: `CG ${f(R.cg)}`, title: `Centre of gravity, ${f(R.cg)} mm from the nose tip` });
  if (Number.isFinite(R.cp)) markers.push({ key: 'cp', kind: 'cp', station: R.cp, label: `CP ${f(R.cp)}`, title: `Centre of pressure, ${f(R.cp)} mm from the nose tip` });
  viewer.setMarkers(markers);
  viewer.setExplode(0, true);
  emit('loading', false);
  if (entry.errors.length) emit('error', entry.errors.join(' · '));
  if (!entry.parts.length) emit('empty');
  if (first && !matchMedia('(prefers-reduced-motion: reduce)').matches) viewer.intro(); else frame(!first);
  emit('shown', entry);
  return entry;
}

function applyLooks() {
  if (!current) return;
  for (const p of current.parts) {
    let look = E.appearance.appearanceFor(p, 'material');
    if (changesOn) {
      const c = p.info && p.info.change;
      look = c === 'changed' ? { color: '#f5a524', metalness: 0.1, roughness: 0.5 } : c === 'new' ? { color: '#5b9bff', metalness: 0.1, roughness: 0.5 } : { color: '#5d6679', metalness: 0.05, roughness: 0.8 };
    }
    viewer.setAppearance(p.id, look);
    viewer.setHidden(p.id, p.hidden);
  }
}
function showChanges(on) { changesOn = !!on; applyLooks(); }

const POSES = {
  home: [0.3, 0.3, 1], project: [0.08, 0.16, 1], iteration: [-0.42, 0.3, 1], model: [0.22, 0.34, 1], compare: [0.0, 0.5, 1], quiet: [0.3, 0.3, 1],
};
function applyPoseSettings() {
  if (!viewer) return;
  const model = poseName === 'model';
  viewer.controls.enabled = model;
  viewer.setLabels(model); viewer.setRuler(model); viewer.setMarkersVisible(model); viewer.setGrid(model);
  viewer.setAutoSpin(poseName === 'home');
  if (!model) { viewer.select(null, { emit: false }); viewer.isolate(null); viewer.setExplode(0); viewer.setCutaway(false); viewer.setXray(false); setMeasure(false); setGhost(null); if (changesOn) showChanges(false); }
}
function frame(animate = true) {
  if (!viewer || !current || !current.parts.length) return;
  const d = POSES[poseName] || POSES.model;
  viewer.fitView(animate, new E.THREE.Vector3(d[0], d[1], d[2]));
}
let poseTimer = 0;
/** Move the camera (and the stage's screen region, via CSS on body[data-pose]) for a kind of page. */
function pose(name) {
  const changed = name !== poseName;
  poseName = name;
  document.body.dataset.pose = name;
  if (!viewer) return;
  if (changed) applyPoseSettings();
  frame(true);
  clearTimeout(poseTimer);
  if (changed) poseTimer = setTimeout(() => frame(true), 950); // the stage region finishes sliding, so frame again at its final size
}

function setTheme(dark) { if (viewer) viewer.setTheme(dark); }
function findItem(label) { return current ? current.items.find((x) => x.label.toLowerCase() === String(label).toLowerCase()) : null; }
function selectLabel(label, focus = true) {
  const item = findItem(label);
  if (item && viewer) viewer.select(item.parts[0].id, { focus });
  return item;
}
function focusLabel(label) { const item = findItem(label); if (item && viewer) viewer.focus(item.parts[0].id); return !!item; }
function clearSelection() { if (viewer) viewer.select(null); }

function playAssembly(onStep, onDone) {
  if (!viewer || !current) return;
  const order = E.math.assemblyOrder(current.parts.filter((p) => !p.hidden).map((p) => ({ id: p.id, order: p.meta.order, modelIndex: p.modelIndex, radialMax: p.a.radialMax, centreX: p.a.centre.x })));
  viewer.isolate(null);
  viewer.playAssembly(order, { onStep: (i, n, p) => onStep && onStep(i, n, p.label), onDone: () => onDone && onDone() });
}

/** Draw another iteration as a faint ghost over the current one (both share the nose tip as station zero). */
async function setGhost(project, it) {
  if (ghostGroup) {
    ghostGroup.traverse((o) => { if (o.isLineSegments) o.geometry.dispose(); });
    viewer.scene.remove(ghostGroup); ghostGroup = null;
  }
  if (!project || !it || !viewer) return false;
  let entry;
  try { entry = await build(project, it); } catch (e) { emit('error', `Could not load ${it.name} to compare.`); return false; }
  const T = E.THREE;
  const mat = new T.MeshBasicMaterial({ color: 0xff8080, transparent: true, opacity: 0.16, depthWrite: false, side: T.DoubleSide });
  const wire = new T.LineBasicMaterial({ color: 0xff8080, transparent: true, opacity: 0.55 });
  const g = new T.Group();
  for (const p of entry.parts) {
    if (p.hidden) continue;
    const saved = p.group.position.clone();
    p.group.position.copy(p.base);
    p.group.updateWorldMatrix(true, true);
    p.group.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const m = new T.Mesh(o.geometry, mat);
      m.matrixAutoUpdate = false; m.matrix.copy(o.matrixWorld); m.renderOrder = 5;
      const edges = new T.LineSegments(new T.EdgesGeometry(o.geometry, 35), wire);
      edges.matrixAutoUpdate = false; edges.matrix.copy(o.matrixWorld);
      g.add(m, edges);
    });
    p.group.position.copy(saved);
  }
  ghostGroup = g;
  viewer.scene.add(g);
  viewer.setExplode(0);
  return true;
}

function setMeasure(on) {
  if (!viewer) return;
  const el = viewer.renderer.domElement;
  if (measure.line) { viewer.scene.remove(measure.line); measure.line.geometry.dispose(); measure.line = null; }
  measure.pts = [];
  if (measure.handler) { el.removeEventListener('click', measure.handler); measure.handler = null; }
  measure.on = !!on;
  if (!on) return;
  const T = E.THREE;
  measure.handler = (e) => {
    const r = el.getBoundingClientRect();
    const ndc = new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    viewer.raycaster.setFromCamera(ndc, viewer.camera);
    const hit = viewer.raycaster.intersectObjects(viewer.meshes, false).find((x) => { const p = viewer.byId.get(x.object.userData.partId); return p && !p.hidden; });
    if (!hit) return;
    if (measure.pts.length >= 2) { measure.pts = []; if (measure.line) { viewer.scene.remove(measure.line); measure.line = null; } }
    measure.pts.push(hit.point.clone());
    if (measure.pts.length === 2) {
      const geo = new T.BufferGeometry().setFromPoints(measure.pts);
      measure.line = new T.Line(geo, new T.LineBasicMaterial({ color: 0x5eead4, depthTest: false }));
      measure.line.renderOrder = 10;
      viewer.scene.add(measure.line);
      emit('measure', measure.pts[0].distanceTo(measure.pts[1]));
    } else emit('measure', null);
  };
  el.addEventListener('click', measure.handler);
}

export const partNamesFromFile = (file) => stage.partNamesFromFile(file);
export const supportedModelExt = () => ['step', 'stp', 'iges', 'igs', 'stl', 'obj', 'glb', 'gltf', '3mf', 'fbx'];
