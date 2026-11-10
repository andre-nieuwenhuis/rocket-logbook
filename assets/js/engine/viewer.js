// The 3D view: rendering, camera, picking, exploded view, cutaway, balloons, CG/CP markers,
// station ruler and the assembly animation. Knows nothing about rocket.json.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clamp, niceStep, fmt } from './math.js';
import { makeStars, makeRange, makeShadow, Particles } from './stage.js';
import { stateAt } from './flight.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export class RocketViewer {
  constructor(container, overlay, { accent = '#ff8a3d' } = {}) {
    this.container = container;
    this.overlay = overlay;
    this.listeners = {};
    this.accent = new THREE.Color(accent);

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.localClippingEnabled = true;
    r.domElement.className = 'viewer-canvas';
    container.prepend(r.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3340, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(0.6, 1.4, 1.1);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9ec9ff, 0.7); // cool back light for a crisp silhouette
    rim.position.set(-1, 0.5, -1.2);
    this.scene.add(rim);
    this.stars = makeStars();
    this.scene.add(this.stars);

    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 500000);
    this.camera.position.set(400, 300, 1500);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('start', () => { this.camAnim = null; });

    this.root = new THREE.Group();
    this.helpers = new THREE.Group();
    this.flightProps = new THREE.Group();
    this.scene.add(this.root, this.helpers, this.flightProps);
    this.flame = new Particles(2600, { additive: true });
    this.smoke = new Particles(7000);
    this.flightProps.add(this.smoke.points, this.flame.points);
    this.engineLight = new THREE.PointLight(0xff8a3d, 0, 1, 0);
    this.flightProps.add(this.engineLight);
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x7cc4ff, transparent: true, opacity: 0.5, depthWrite: false });
    this.xray = false;
    this.autoSpin = true;
    this.lastInput = performance.now();
    this.flight = null;
    this.groundY = -100;

    this.cutPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.cutUniforms = { uCut: { value: 0 }, uCutColor: { value: srgbColour(accent) } };

    this.parts = [];
    this.byId = new Map();
    this.meshes = [];
    this.info = { length: 1000, diameter: 50, radialMax: 50 };
    this.explodeT = 0;
    this.explodeTarget = 0;
    this.cutaway = false;
    this.labelsOn = true;
    this.labelStyle = 'minimal';
    this.rulerOn = true;
    this.markersOn = true;
    this.gridOn = true;
    this.hovered = null;
    this.selected = null;
    this.isolated = null;
    this.balloons = [];
    this.markers = [];
    this.rulerLabels = [];
    this.assembly = null;
    this.camAnim = null;
    this.defaultDir = new THREE.Vector3(0.22, 0.34, 1).normalize();
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(9, 9);
    this.pointerDirty = false;
    this.positionsDirty = true;

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'overlay-svg');
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'label-layer';
    overlay.append(this.svg, this.labelLayer);
    // engineering dimension callout for the selected part
    this.dim = document.createElementNS(SVG_NS, 'g');
    this.dim.setAttribute('class', 'dim');
    this.dim.innerHTML = '<line class="ext a"/><line class="ext b"/><line class="main"/><line class="tick a"/><line class="tick b"/>';
    this.svg.appendChild(this.dim);
    this.dimLabel = document.createElement('div');
    this.dimLabel.className = 'dim-label';
    this.labelLayer.appendChild(this.dimLabel);
    this.fadeEl = document.createElement('div');
    this.fadeEl.className = 'viewer-fade';
    container.appendChild(this.fadeEl);

    this._bindEvents();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(container);
    r.setAnimationLoop(() => this._frame());
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); }
  emit(evt, ...args) { (this.listeners[evt] || []).forEach((fn) => fn(...args)); }

  // ---------------------------------------------------------------- parts
  /** parts: [{id, group, base: Vector3, explode: Vector3, a: analysis}] ; info: {length, diameter, radialMax} */
  setParts(parts, info) {
    this.stopAssembly();
    for (const p of this.parts) {
      this.root.remove(p.group);
      if (p.material) p.material.dispose();
    }
    const keepSel = this.selected && this.selected.id;
    const keepIso = this.isolated && this.isolated.id;
    this.parts = parts;
    this.byId = new Map(parts.map((p) => [p.id, p]));
    this.meshes = [];
    for (const p of parts) {
      p.group.position.copy(p.base);
      this.root.add(p.group);
      p.material = this._makeMaterial();
      p.fade = 1;
      if (p.edges) { for (const e of p.edges) { e.removeFromParent(); e.geometry.dispose(); } p.edges = null; }
      p.flyOffset = new THREE.Vector3();
      p.group.traverse((o) => {
        if (o.isMesh) {
          o.material = p.material;
          o.userData.partId = p.id;
          this.meshes.push(o);
        }
      });
      this._refresh(p);
    }
    this.info = { ...this.info, ...info };
    this.selected = keepSel ? this.byId.get(keepSel) || null : null;
    this.isolated = keepIso ? this.byId.get(keepIso) || null : null;
    this.hovered = null;
    this._applyCutMaterials();
    this._buildHelpers();
    this.positionsDirty = true;
    if (this.xray) this.setXray(true);
    this.parts.forEach((p) => this._refresh(p));
  }

  setAppearance(id, look) {
    const p = this.byId.get(id);
    if (!p) return;
    p.look = look;
    this._refresh(p);
  }

  setExplodeVectors(map) {
    for (const p of this.parts) if (map.has(p.id)) p.explode = map.get(p.id);
    this.positionsDirty = true;
  }

  setHidden(id, hidden) {
    const p = this.byId.get(id);
    if (!p) return;
    p.hidden = hidden;
    if (hidden && this.selected === p) this.select(null);
    this._refresh(p);
  }

  _makeMaterial() {
    const m = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uCut = this.cutUniforms.uCut;
      shader.uniforms.uCutColor = this.cutUniforms.uCutColor;
      shader.fragmentShader =
        'uniform float uCut;\nuniform vec3 uCutColor;\n' +
        shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\n  if (uCut > 0.5 && !gl_FrontFacing) { gl_FragColor.rgb = uCutColor; }'
        );
    };
    m.customProgramCacheKey = () => 'rocket-section-v1';
    return m;
  }

  _refresh(p) {
    const m = p.material;
    if (!m) return;
    const look = p.look || {};
    m.color.set(look.color || '#c9ced6');
    m.metalness = look.metalness ?? 0.1;
    m.roughness = look.roughness ?? 0.55;
    if (p === this.selected) { m.emissive.copy(this.accent); m.emissiveIntensity = 0.42; }
    else if (p === this.hovered) { m.emissive.copy(this.accent); m.emissiveIntensity = 0.2; }
    else { m.emissive.setRGB(0, 0, 0); m.emissiveIntensity = 0; }
    const ghost = this.isolated && this.isolated !== p;
    const see = this.xray && p !== this.selected && p !== this.hovered;
    const opacity = (p.fade ?? 1) * (ghost ? 0.09 : 1) * (see ? 0.13 : 1);
    if (p.edges) for (const e of p.edges) e.visible = this.xray;
    const transparent = opacity < 0.999;
    if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
    m.opacity = opacity;
    m.depthWrite = !transparent;
    p.group.visible = !p.hidden && (p.fade ?? 1) > 0.001;
  }

  // ---------------------------------------------------------------- state setters
  setExplode(t, immediate = false) {
    this.explodeTarget = clamp(t, 0, 1);
    if (immediate) this.explodeT = this.explodeTarget;
    this.positionsDirty = true;
  }

  setCutaway(on) {
    this.cutaway = !!on;
    this.cutUniforms.uCut.value = on ? 1 : 0;
    this._applyCutMaterials();
  }

  _applyCutMaterials() {
    for (const p of this.parts) {
      if (!p.material) continue;
      p.material.clippingPlanes = this.cutaway ? [this.cutPlane] : null;
      p.material.needsUpdate = true;
    }
    this.edgeMat.clippingPlanes = this.cutaway ? [this.cutPlane] : null;
    this.edgeMat.needsUpdate = true;
  }

  /** X-ray: every part turns glassy with its edges drawn, so the internals show through. */
  setXray(on) {
    this.xray = !!on;
    if (this.xray) {
      for (const p of this.parts) {
        if (p.edges) continue;
        p.edges = [];
        p.group.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          const e = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 28), this.edgeMat);
          e.raycast = () => {};
          e.renderOrder = 2;
          o.add(e);
          p.edges.push(e);
        });
      }
    }
    this.parts.forEach((p) => this._refresh(p));
  }

  setAutoSpin(on) { this.autoSpin = !!on; if (!on) this.controls.autoRotate = false; this.poke(); }

  /** Any user input: stop the idle turntable and restart its timer. */
  poke() { this.lastInput = performance.now(); this.controls.autoRotate = false; }

  setLabels(on) { this.labelsOn = !!on; this.labelLayer.classList.toggle('no-balloons', !on); this.svg.classList.toggle('no-balloons', !on); }
  setRuler(on) { this.rulerOn = !!on; if (this.ruler) this.ruler.visible = on; }
  setMarkersVisible(on) { this.markersOn = !!on; }
  setGrid(on) { this.gridOn = !!on; if (this.grid) this.grid.visible = on; }

  setTheme(dark) {
    this.dark = dark;
    this.stars.visible = dark;
    this.edgeMat.color.set(dark ? 0x7cc4ff : 0x1f6fb8);
    this.edgeMat.opacity = dark ? 0.5 : 0.6;
    this._buildHelpers();
  }

  select(id, { focus = false, emit = true } = {}) {
    const p = id ? this.byId.get(id) : null;
    const prev = this.selected;
    this.selected = p || null;
    if (prev) this._refresh(prev);
    if (p) this._refresh(p);
    if (p && focus) this.focus(p.id);
    this._syncBalloonStates();
    if (emit) this.emit('select', this.selected);
  }

  isolate(id) {
    this.isolated = id ? this.byId.get(id) || null : null;
    this.parts.forEach((p) => this._refresh(p));
  }

  // ---------------------------------------------------------------- balloons & markers
  /** items: [{key, number, text, partIds}] */
  setBalloons(items) {
    for (const b of this.balloons) { b.el.remove(); b.line.remove(); b.dot.remove(); }
    this.balloons = items.map((it) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'balloon';
      el.innerHTML = `<span class="num"></span><span class="txt"></span>`;
      el.querySelector('.num').textContent = it.number;
      el.querySelector('.txt').textContent = it.text;
      el.setAttribute('aria-label', `${it.number}: ${it.text}`);
      el.addEventListener('click', (e) => { e.stopPropagation(); this.emit('balloon', it); });
      el.addEventListener('pointerenter', () => this._hoverPart(this.byId.get(it.partIds[0]) || null));
      el.addEventListener('pointerleave', () => this._hoverPart(null));
      this.labelLayer.appendChild(el);
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'leader');
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('class', 'leader-dot');
      dot.setAttribute('r', '2.6');
      this.svg.append(line, dot);
      return { ...it, el, line, dot, w: 0, h: 0 };
    });
    this._syncBalloonStates();
  }

  _syncBalloonStates() {
    for (const b of this.balloons) {
      const active = !!(this.selected && b.partIds.includes(this.selected.id));
      const hot = !!(this.hovered && b.partIds.includes(this.hovered.id));
      b.el.classList.toggle('active', active);
      b.el.classList.toggle('hot', hot && !active);
      b.line.classList.toggle('active', active);
      b.line.classList.toggle('hot', hot && !active);
      b.dot.classList.toggle('active', active || hot);
    }
  }

  /** 'minimal' = numbers only, names appear on hover/selection; 'names' = always show names. */
  setLabelStyle(style) {
    this.labelStyle = style === 'names' ? 'names' : 'minimal';
    this.labelLayer.classList.toggle('names', this.labelStyle === 'names');
    for (const b of this.balloons) b.w = 0;
  }

  /** markers: [{key, station, label, kind: 'cg'|'cp'}] */
  setMarkers(markers) {
    for (const m of this.markers) m.el.remove();
    this.markers = markers.map((m) => {
      const el = document.createElement('div');
      el.className = `marker marker-${m.kind}`;
      el.innerHTML = `<span class="sym"></span><span class="mtxt"></span>`;
      el.querySelector('.mtxt').textContent = m.label;
      el.title = m.title || m.label;
      this.labelLayer.appendChild(el);
      return { ...m, el };
    });
  }

  // ---------------------------------------------------------------- helpers (grid, ruler)
  _buildHelpers() {
    for (const c of [...this.helpers.children]) {
      this.helpers.remove(c);
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    for (const l of this.rulerLabels) l.el.remove();
    this.rulerLabels = [];
    const L = Math.max(this.info.length || 1, 1);
    const Rm = Math.max(this.info.radialMax || L * 0.03, 1);
    const dark = this.dark !== false;

    this.groundY = -Rm * 1.9;
    const step = niceStep(L * 0.4, 4);
    const grid = makeRange({ radius: L * 1.6, step, dark, accent: '#' + this.accent.getHexString() });
    grid.position.set(L / 2, this.groundY, 0);
    grid.visible = this.gridOn;
    this.grid = grid;
    const shadow = makeShadow();
    shadow.position.set(L / 2, this.groundY + 0.5, 0);
    shadow.scale.set(L * 1.15, Rm * 4.2, 1);
    shadow.material.opacity = dark ? 0.75 : 0.28;
    this.shadow = shadow;
    this.shadowBase = { sx: L * 1.15, sy: Rm * 4.2, op: shadow.material.opacity };

    const tick = niceStep(L, 8);
    const y = -Rm * 1.3;
    const pts = [0, y, 0, L, y, 0];
    for (let x = 0; x <= L + 1e-6; x += tick / 2) {
      const major = Math.abs(x / tick - Math.round(x / tick)) < 1e-6;
      const h = major ? Rm * 0.16 : Rm * 0.08;
      pts.push(x, y, 0, x, y - h, 0);
      if (major) this._addRulerLabel(x, y - Rm * 0.16, fmt(x));
    }
    pts.push(L, y + Rm * 0.08, 0, L, y - Rm * 0.16, 0);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const ruler = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: dark ? 0x8b95a7 : 0x5c6676, transparent: true }));
    ruler.visible = this.rulerOn;
    this.ruler = ruler;
    this._addRulerLabel(L, y - Rm * 0.16, `${fmt(L)} mm`, true);
    this.helpers.add(grid, shadow, ruler);
  }

  _addRulerLabel(x, y, text, end = false) {
    const el = document.createElement('div');
    el.className = 'ruler-label' + (end ? ' end' : '');
    el.textContent = text;
    this.labelLayer.appendChild(el);
    this.rulerLabels.push({ el, pos: new THREE.Vector3(x, y, 0) });
  }

  // ---------------------------------------------------------------- camera
  fitView(animate = true, dir = null) {
    const box = this._visibleBox();
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const d = (dir ? dir.clone() : this.defaultDir.clone()).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(d.dot(up)) > 0.98) up.set(0, 0, -1);
    const right = new THREE.Vector3().crossVectors(up, d).normalize();
    const camUp = new THREE.Vector3().crossVectors(d, right).normalize();
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const tanV = Math.tan(vHalf) * 0.62; // leave room above/below for balloons
    const tanH = Math.tan(vHalf) * this.camera.aspect * 0.86;
    let dist = 0;
    const c = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(centre);
      const x = c.dot(right), y = c.dot(camUp), z = c.dot(d);
      dist = Math.max(dist, z + Math.abs(x) / tanH, z + Math.abs(y) / tanV);
    }
    this._animateCamera(centre.clone().addScaledVector(d, dist), centre, animate);
  }

  /** Opening shot: the camera sweeps round and settles on the 3D view. */
  intro() {
    this.fitView(false);
    const t = this.controls.target.clone();
    const end = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(t));
    const start = new THREE.Spherical(end.radius * 2.3, clamp(end.phi - 0.5, 0.3, 1.4), end.theta - 1.7);
    this.camera.position.copy(t).add(new THREE.Vector3().setFromSpherical(start));
    this.camAnim = { orbit: true, s0: start, s1: end, target: t, start: performance.now() + 150, dur: 2900 };
    this.poke();
  }

  focus(id) {
    const p = this.byId.get(id);
    if (!p) return;
    const box = new THREE.Box3().setFromObject(p.group);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const fov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const dist = Math.max(sphere.radius / Math.sin(fov), this.info.diameter * 1.2) * 1.5;
    this._animateCamera(sphere.center.clone().addScaledVector(dir, dist), sphere.center, true);
  }

  viewFrom(name) {
    const dirs = { side: new THREE.Vector3(0, 0, 1), top: new THREE.Vector3(0, 1, 0.0001), nose: new THREE.Vector3(-1, 0.0001, 0.0001), tail: new THREE.Vector3(1, 0.0001, 0.0001), iso: this.defaultDir };
    this.fitView(true, dirs[name] || this.defaultDir);
  }

  _animateCamera(pos, target, animate) {
    if (!animate) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.camAnim = null;
      this._updateClip();
      return;
    }
    this.camAnim = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos, t1: target, start: performance.now(), dur: 750 };
  }

  _updateClip() {
    const L = Math.max(this.info.length, 1);
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(0.5, dist / 500);
    this.camera.far = this.flight ? 4e6 : dist + L * 20;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = L * 12;
    this.controls.minDistance = Math.max(this.info.diameter * 0.3, 5);
  }

  _visibleBox() {
    const box = new THREE.Box3();
    for (const p of this.parts) {
      if (p.hidden) continue;
      const d = p.group.position.clone().sub(p.base);
      box.union(p.a.box.clone().translate(d));
    }
    return box;
  }

  // ---------------------------------------------------------------- assembly animation
  /** orderIds: part ids in build order. */
  playAssembly(orderIds, { onStep, onDone } = {}) {
    this.stopAssembly();
    const order = orderIds.map((id) => this.byId.get(id)).filter((p) => p && !p.hidden);
    if (!order.length) return;
    const step = clamp(7 / order.length, 0.22, 0.75);
    const L = this.info.length;
    for (const p of order) {
      const dir = p.explode && p.explode.lengthSq() > 1 ? p.explode.clone().normalize() : new THREE.Vector3(0, 1, 0);
      p.flyFrom = dir.multiplyScalar(L * 0.22 + this.info.diameter * 2);
      p.fade = 0;
      this._refresh(p);
    }
    this.explodeTarget = 0;
    this.assembly = { order, start: performance.now() / 1000 + 0.35, step, dur: step * 1.8, lastIdx: -1, onStep, onDone };
  }

  stopAssembly() {
    if (!this.assembly) return;
    for (const p of this.assembly.order) { p.fade = 1; p.flyOffset.set(0, 0, 0); this._refresh(p); }
    this.assembly = null;
    this.positionsDirty = true;
  }

  get assembling() { return !!this.assembly; }

  _stepAssembly() {
    const A = this.assembly;
    const now = performance.now() / 1000 - A.start;
    let done = true;
    A.order.forEach((p, k) => {
      const local = (now - k * A.step) / A.dur;
      const c = clamp(local, 0, 1);
      if (c < 1) done = false;
      p.flyOffset.copy(p.flyFrom).multiplyScalar(1 - easeOut(c));
      const fade = local <= 0 ? 0 : Math.min(1, local * 3);
      if (fade !== p.fade) { p.fade = fade; this._refresh(p); }
    });
    const idx = Math.min(A.order.length - 1, Math.floor(now / A.step));
    if (idx >= 0 && idx !== A.lastIdx) {
      A.lastIdx = idx;
      A.onStep && A.onStep(idx, A.order.length, A.order[idx]);
    }
    this.positionsDirty = true;
    if (done) {
      const cb = A.onDone;
      this.stopAssembly();
      cb && cb();
    }
  }

  // ---------------------------------------------------------------- screenshot
  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ---------------------------------------------------------------- events & picking
  _bindEvents() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.lastClient = { x: e.clientX, y: e.clientY };
      this.pointerDirty = true;
    });
    el.addEventListener('pointerleave', () => { this.pointer.set(9, 9); this._hoverPart(null); });
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    this.container.addEventListener('pointerdown', () => this.poke(), true);
    this.container.addEventListener('wheel', () => this.poke(), { passive: true, capture: true });
    window.addEventListener('keydown', () => this.poke());
    el.addEventListener('pointerup', (e) => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const id = this._raycast(ndc);
      this.select(id);
    });
    el.addEventListener('dblclick', (e) => {
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const id = this._raycast(ndc);
      if (id) this.focus(id); else this.fitView(true);
    });
  }

  _raycast(ndc) {
    if (this.flight) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes, false);
    for (const h of hits) {
      if (this.cutaway && this.cutPlane.distanceToPoint(h.point) < 0) continue;
      const p = this.byId.get(h.object.userData.partId);
      if (!p || p.hidden || (p.fade ?? 1) < 0.5) continue;
      if (this.isolated && p !== this.isolated) continue;
      return p.id;
    }
    return null;
  }

  _hoverPart(p) {
    if (p === this.hovered) return;
    const prev = this.hovered;
    this.hovered = p;
    if (prev) this._refresh(prev);
    if (p) this._refresh(p);
    this.renderer.domElement.style.cursor = p ? 'pointer' : '';
    this._syncBalloonStates();
    this.emit('hover', p);
  }

  // ---------------------------------------------------------------- frame
  _resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width', w);
    this.svg.setAttribute('height', h);
    for (const b of this.balloons || []) b.w = 0; // re-measure (text may hide on small screens)
  }

  _frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (Math.abs(this.explodeTarget - this.explodeT) > 1e-4) {
      this.explodeT += (this.explodeTarget - this.explodeT) * (1 - Math.exp(-dt * 7));
      if (Math.abs(this.explodeTarget - this.explodeT) <= 1e-4) this.explodeT = this.explodeTarget;
      this.positionsDirty = true;
    }
    if (this.assembly) this._stepAssembly();
    if (this.positionsDirty) this._applyPositions();
    if (this.camAnim) {
      const A = this.camAnim;
      const t = clamp((performance.now() - A.start) / A.dur, 0, 1);
      if (A.orbit) {
        const e = easeOut(t) * (1 - t) + easeInOut(t) * t;
        const sp = new THREE.Spherical(
          A.s0.radius + (A.s1.radius - A.s0.radius) * e,
          A.s0.phi + (A.s1.phi - A.s0.phi) * e,
          A.s0.theta + (A.s1.theta - A.s0.theta) * e);
        this.controls.target.copy(A.target);
        this.camera.position.copy(A.target).add(new THREE.Vector3().setFromSpherical(sp));
      } else {
        const e = easeInOut(t);
        this.camera.position.lerpVectors(A.p0, A.p1, e);
        this.controls.target.lerpVectors(A.t0, A.t1, e);
      }
      if (t >= 1) this.camAnim = null;
    }
    const now = performance.now();
    if (this.autoSpin && !this.flight && !this.assembly && !this.camAnim && now - this.lastInput > 9000) {
      this.controls.autoRotate = true;
      this.controls.autoRotateSpeed = 0.45;
    }
    if (this.flight) this._stepFlight(dt);
    else this.controls.update();
    this._updateClip();
    this.stars.material.uniforms.uTime.value += dt;
    this.stars.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    this.flame.material.uniforms.uScale.value = this.smoke.material.uniforms.uScale.value =
      this.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.flame.update(dt, { drag: 6 });
    this.smoke.update(dt, { drag: 0.9, rise: 60 });
    if (this.cutaway) this._updateCutPlane();
    if (this.pointerDirty) {
      this.pointerDirty = false;
      const id = this._raycast(this.pointer);
      this._hoverPart(id ? this.byId.get(id) : null);
    }
    this.renderer.render(this.scene, this.camera);
    this._updateOverlay();
  }

  _applyPositions() {
    this.positionsDirty = false;
    for (const p of this.parts) {
      p.group.position.copy(p.base);
      if (p.explode) p.group.position.addScaledVector(p.explode, this.explodeT);
      if (p.flyOffset) p.group.position.add(p.flyOffset);
    }
  }

  _updateCutPlane() {
    const v = this.camera.position.clone().sub(this.controls.target);
    v.x = 0;
    if (v.lengthSq() < 1e-6) v.set(0, 0, 1);
    v.normalize().negate();
    this.cutPlane.normal.copy(v);
    this.cutPlane.constant = 0;
  }

  _updateDim() {
    const p = this.selected;
    const show = p && !this.flight && !this.assembly && p.group.visible && !p.hidden;
    this.dim.style.display = show ? '' : 'none';
    this.dimLabel.style.display = show ? '' : 'none';
    if (!show) return;
    const d = p.group.position.clone().sub(p.base);
    const b = p.a.box;
    const z = (b.min.z + b.max.z) / 2 + d.z;
    const y0 = b.max.y + d.y;
    const y = y0 + Math.max(this.info.diameter * 0.55, (b.max.y - b.min.y) * 0.25);
    const A0 = this._project(new THREE.Vector3(b.min.x + d.x, y0, z));
    const B0 = this._project(new THREE.Vector3(b.max.x + d.x, y0, z));
    const A = this._project(new THREE.Vector3(b.min.x + d.x, y, z));
    const B = this._project(new THREE.Vector3(b.max.x + d.x, y, z));
    if (!A.ok || !B.ok) { this.dim.style.display = 'none'; this.dimLabel.style.display = 'none'; return; }
    const set = (sel, x1, y1, x2, y2) => {
      const l = this.dim.querySelector(sel);
      l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    };
    set('.ext.a', A0.x, A0.y, A.x, A.y);
    set('.ext.b', B0.x, B0.y, B.x, B.y);
    set('.main', A.x, A.y, B.x, B.y);
    // architectural 45° ticks at both ends
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, tx = (ux - uy) * 4.5, ty = (uy + ux) * 4.5;
    set('.tick.a', A.x - tx, A.y - ty, A.x + tx, A.y + ty);
    set('.tick.b', B.x - tx, B.y - ty, B.x + tx, B.y + ty);
    const L = b.max.x - b.min.x;
    this.dimLabel.textContent = `${fmt(L, L < 100 ? 1 : 0)} mm  ·  Ø ${fmt(p.a.radialMax * 2, 1)}`;
    this.dimLabel.style.transform = `translate(${(A.x + B.x) / 2}px, ${(A.y + B.y) / 2}px)`;
    this.dimLabel.classList.toggle('tight', len < 60);
  }

  // ---------------------------------------------------------------- launch sequence
  /**
   * Plays the launch: the rocket is raised onto a rail, counts down, ignites and climbs to apogee
   * following `sim` (from flight.js), then everything resets.
   * hooks: onEvent(name, data), onUpdate(state), onDone()
   */
  playFlight(sim, hooks = {}) {
    if (this.flight || !this.parts.length || !sim || !sim.valid) return false;
    this.stopAssembly();
    this.select(null);
    this.isolate(null);
    const L = Math.max(this.info.length, 1), R = Math.max(this.info.diameter / 2, 1);
    const saved = { cutaway: this.cutaway, xray: this.xray, explode: this.explodeTarget };
    if (this.cutaway) { this.cutUniforms.uCut.value = 0; this.cutaway = false; this._applyCutMaterials(); }
    if (this.xray) this.setXray(false);
    this.explodeTarget = 0;
    this.controls.autoRotate = false;
    this.controls.enabled = false;

    // launch rail beside the rocket
    const railH = L * 1.7;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(R * 0.22, railH, R * 0.22),
      new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.85, roughness: 0.35, transparent: true, opacity: 0 }));
    rail.position.set(L / 2 + R * 1.25, this.groundY + railH / 2, 0);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(R * 2.6, R * 3, R * 0.5, 40),
      new THREE.MeshStandardMaterial({ color: 0x3a4250, metalness: 0.4, roughness: 0.6, transparent: true, opacity: 0 }));
    base.position.set(L / 2, this.groundY + R * 0.25, 0);
    // altitude gates every 100 m
    const gates = new THREE.Group();
    const gateMat = new THREE.LineBasicMaterial({ color: 0x7cc4ff, transparent: true, opacity: 0.32, depthWrite: false });
    const ring = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 97 }, (_, i) => {
      const a = (i / 96) * Math.PI * 2; return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    }));
    for (let h = 100; h < sim.apogee + 100; h += 100) {
      const g = new THREE.Line(ring, gateMat);
      g.position.set(L / 2, this.groundY + L + h * 1000, 0);
      g.scale.setScalar(L * 0.75);
      gates.add(g);
    }
    this.flightProps.add(rail, base, gates);

    const fromTarget = this.controls.target.clone();
    const target = new THREE.Vector3(L / 2, this.groundY + L * 0.55, 0);
    this.flight = {
      sim, hooks, saved, rail, base, gates, ring, gateMat,
      t: 0, prep: 1.7, count: 3, hold: 2.4,
      lastCount: 4, events: {}, L, R,
      camFrom: this.camera.position.clone(), tgtFrom: fromTarget,
      camTo: target.clone().add(new THREE.Vector3(L * 0.75, L * 0.05, L * 2.35)), tgtTo: target,
      nozzle: null,
    };
    hooks.onEvent && hooks.onEvent('prep');
    return true;
  }

  stopFlight() {
    if (!this.flight || this.flight.resetting) return;
    this._resetFlight(true);
  }

  get flying() { return !!this.flight; }

  _stepFlight(dt) {
    const F = this.flight;
    F.t += dt;
    const { L, R, sim } = F;
    const tLaunch = F.prep + F.count;
    const simT = F.t - tLaunch;
    const hooks = F.hooks;

    // 1. raise the rocket onto the rail
    const e = smooth(F.t / F.prep);
    const eUp = smooth(F.t / (F.prep * 0.7)); // lift slightly ahead of the rotation so the tail clears the ground
    const h = simT > 0 ? stateAt(sim, Math.min(simT, sim.tApogee)).h : 0;
    const y = this.groundY + L;
    this.root.rotation.z = -Math.PI / 2 * e;
    this.root.position.set(L / 2 * eUp, y * eUp + h * 1000, 0);
    this.root.updateMatrixWorld();
    F.rail.material.opacity = F.base.material.opacity = smooth((F.t - 0.6) / 1.0);
    if (this.shadow) {
      const sb = this.shadowBase;
      const k = smooth(F.t / F.prep);
      this.shadow.scale.set(sb.sx + (R * 5 - sb.sx) * k, sb.sy + (R * 5 - sb.sy) * k, 1);
      this.shadow.material.opacity = sb.op * clamp(1 - h / 25, 0, 1);
    }

    // 2. camera: glide to the launch view, then chase the rocket
    const rocketMid = new THREE.Vector3(L / 2, 0, 0).applyMatrix4(this.root.matrixWorld);
    if (F.t < F.prep + 0.4) {
      const c = smooth(F.t / (F.prep + 0.4));
      this.camera.position.lerpVectors(F.camFrom, F.camTo, c);
      this.controls.target.lerpVectors(F.tgtFrom, F.tgtTo, c);
    } else {
      const chase = smooth((simT - 0.3) / 2.5);
      const off = new THREE.Vector3(L * (0.75 + 0.45 * chase), L * (0.05 - 0.75 * chase), L * (2.35 + 0.9 * chase));
      const tgt = rocketMid.clone().add(new THREE.Vector3(0, L * 0.05, 0));
      if (simT > 0) {
        // lock onto the rocket exactly: at ~120 m/s any lag would lose it off screen
        this.controls.target.copy(tgt);
        this.camera.position.copy(tgt).add(off);
      } else {
        const k = 1 - Math.exp(-dt * 4);
        this.controls.target.lerp(tgt, k);
        this.camera.position.lerp(tgt.clone().add(off), k);
      }
    }
    this.camera.lookAt(this.controls.target);

    // 3. countdown
    if (simT < 0 && F.t > F.prep) {
      const n = Math.ceil(-simT);
      if (n !== F.lastCount && n >= 1 && n <= 3) { F.lastCount = n; hooks.onEvent && hooks.onEvent('count', n); }
    }

    // 4. flight
    const nozzle = new THREE.Vector3(L / 2, this.groundY + h * 1000 - L * 0.012, 0);
    const burning = simT >= 0 && simT < sim.burnout;
    if (simT >= 0 && !F.events.ignition) { F.events.ignition = true; hooks.onEvent && hooks.onEvent('ignition'); }
    if (simT >= sim.burnout && !F.events.burnout) { F.events.burnout = true; hooks.onEvent && hooks.onEvent('burnout'); }
    if (simT >= sim.tApogee && !F.events.apogee) { F.events.apogee = true; hooks.onEvent && hooks.onEvent('apogee', { apogee: sim.apogee, t: sim.tApogee }); }
    if (simT >= 0) {
      const st = stateAt(sim, Math.min(simT, sim.tApogee));
      hooks.onUpdate && hooks.onUpdate({ t: Math.min(simT, sim.tApogee), h: st.h, v: st.v, a: st.a, phase: simT >= sim.tApogee ? 'apogee' : burning ? 'boost' : 'coast' });
    }
    if (burning) this._emitExhaust(F.nozzle || nozzle, nozzle, R, dt, simT);
    F.nozzle = nozzle;
    const flick = burning ? 2.6 + Math.random() * 1.4 : 0;
    this.engineLight.intensity += (flick - this.engineLight.intensity) * 0.5;
    this.engineLight.distance = L * 1.6;
    this.engineLight.position.copy(nozzle).add(new THREE.Vector3(0, -R * 2, 0));
    if (simT > sim.tApogee + F.hold && !F.resetting) this._resetFlight(false);
  }

  _emitExhaust(from, to, R, dt, simT) {
    const steps = 18, D = R * 2;
    const dark = this.dark !== false;
    const smokeC = dark ? [0.78, 0.8, 0.84] : [0.55, 0.57, 0.6];
    const smokeC1 = dark ? [0.45, 0.48, 0.55] : [0.72, 0.73, 0.75];
    const ignitionPuff = simT < 0.25 ? 3 : 1;
    for (let i = 0; i < steps; i++) {
      const k = i / steps;
      const px = from.x + (to.x - from.x) * k, py = from.y + (to.y - from.y) * k, pz = from.z + (to.z - from.z) * k;
      for (let j = 0; j < 2; j++) {
        const sp = (Math.random() - 0.5) * D * 0.9;
        this.flame.emit(px + sp * 0.3, py, pz + (Math.random() - 0.5) * D * 0.25,
          sp * 0.8, -(2200 + Math.random() * 2600), (Math.random() - 0.5) * D * 0.8,
          0.06 + Math.random() * 0.1, D * 0.95, D * 0.25, 0.9,
          [1.0, 0.92, 0.7], [1.0, 0.38, 0.08]);
      }
      if (i % 2 === 0) {
        for (let j = 0; j < ignitionPuff; j++) {
          const spread = simT < 0.25 ? D * 3 : D * 0.35;
          this.smoke.emit(px + (Math.random() - 0.5) * D * 0.4, py - D * 0.6, pz + (Math.random() - 0.5) * D * 0.4,
            (Math.random() - 0.5) * spread, -(150 + Math.random() * 250), (Math.random() - 0.5) * spread,
            3.2 + Math.random() * 3.2, D * 0.9, D * (5 + Math.random() * 3), 0.32,
            smokeC, smokeC1);
        }
      }
    }
  }

  _resetFlight(skipped) {
    const F = this.flight;
    F.resetting = true;
    this.fadeEl.classList.add('on');
    setTimeout(() => {
      this.root.rotation.set(0, 0, 0);
      this.root.position.set(0, 0, 0);
      this.flame.clear();
      this.smoke.clear();
      this.engineLight.intensity = 0;
      for (const o of [F.rail, F.base]) { this.flightProps.remove(o); o.geometry.dispose(); o.material.dispose(); }
      this.flightProps.remove(F.gates);
      F.ring.dispose(); F.gateMat.dispose();
      if (this.shadow) { const sb = this.shadowBase; this.shadow.scale.set(sb.sx, sb.sy, 1); this.shadow.material.opacity = sb.op; }
      this.flight = null;
      this.controls.enabled = true;
      if (F.saved.cutaway) this.setCutaway(true);
      if (F.saved.xray) this.setXray(true);
      this.explodeTarget = F.saved.explode;
      this.positionsDirty = true;
      this.intro();
      this.fadeEl.classList.remove('on');
      F.hooks.onDone && F.hooks.onDone({ skipped, apogee: F.sim.apogee });
    }, 450);
  }

  _project(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x + 1) / 2 * this.width, y: (1 - p.y) / 2 * this.height, ok: p.z > -1 && p.z < 1 };
  }

  _updateOverlay() {
    const W = this.width, H = this.height;
    const flat = clamp(1 - this.explodeT * 5, 0, 1);
    this._updateDim();
    if (this.flight) {
      for (const l of this.rulerLabels) l.el.style.display = 'none';
      for (const m of this.markers) m.el.style.display = 'none';
      for (const b of this.balloons) { b.el.style.display = 'none'; b.line.style.display = 'none'; b.dot.style.display = 'none'; }
      if (this.ruler) this.ruler.visible = false;
      return;
    }

    // ruler labels & markers (only meaningful when assembled)
    const rulerVis = this.rulerOn && flat > 0.02 && !this.assembly;
    for (const l of this.rulerLabels) {
      const s = this._project(l.pos);
      l.el.style.display = rulerVis && s.ok ? '' : 'none';
      if (rulerVis && s.ok) { l.el.style.transform = `translate(${s.x}px, ${s.y}px)`; l.el.style.opacity = flat; }
    }
    if (this.ruler) { this.ruler.visible = rulerVis; this.ruler.material.opacity = flat; }
    const markVis = this.markersOn && flat > 0.02 && !this.assembly;
    for (const m of this.markers) {
      const s = this._project(new THREE.Vector3(m.station, 0, 0));
      m.el.style.display = markVis && s.ok ? '' : 'none';
      if (markVis && s.ok) { m.el.style.transform = `translate(${s.x}px, ${s.y}px)`; m.el.style.opacity = flat; }
    }

    // balloons
    const showBalloons = this.labelsOn && !this.assembly;
    const placed = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const corner = new THREE.Vector3();
    for (const p of this.parts) {
      if (p.hidden || !p.group.visible) continue;
      if (this.isolated && p !== this.isolated) continue;
      const d = p.group.position.clone().sub(p.base);
      const b = p.a.box;
      for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).add(d);
        const s = this._project(corner);
        if (!s.ok) continue;
        minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
        minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
      }
    }
    if (rulerVis && Number.isFinite(maxY)) {
      for (const l of this.rulerLabels) {
        const s = this._project(l.pos);
        if (s.ok) maxY = Math.max(maxY, s.y + 18);
      }
    }
    for (const b of this.balloons) {
      let anchorPart = null;
      if (showBalloons) {
        for (const id of b.partIds) {
          const p = this.byId.get(id);
          if (!p || p.hidden || !p.group.visible) continue;
          if (this.isolated && p !== this.isolated) continue;
          anchorPart = p;
          break;
        }
      }
      if (!anchorPart) { b.el.style.display = 'none'; b.line.style.display = 'none'; b.dot.style.display = 'none'; continue; }
      const world = anchorPart.a.centre.clone().add(anchorPart.group.position).sub(anchorPart.base);
      const s = this._project(world);
      if (!s.ok) { b.el.style.display = 'none'; b.line.style.display = 'none'; b.dot.style.display = 'none'; continue; }
      b.el.style.display = '';
      if (!b.w) {
        const wasOpen = b.el.classList.contains('active') || b.el.classList.contains('hot');
        if (wasOpen && this.labelStyle !== 'names') { b.el.classList.remove('active', 'hot'); }
        b.w = b.el.offsetWidth; b.h = b.el.offsetHeight;
        if (wasOpen) this._syncBalloonStates();
      }
      placed.push({ b, ax: s.x, ay: s.y });
    }
    if (!placed.length) return;
    const horizontal = maxX - minX >= (maxY - minY) * 0.8;
    const sorted = placed.sort((u, v) => (horizontal ? u.ax - v.ax : u.ay - v.ay));
    const levels = [[], []];
    const gap = 6, maxLevels = 5;
    sorted.forEach((q, i) => {
      const side = i % 2;
      const { w, h } = q.b;
      const along = horizontal ? clamp(q.ax, w / 2 + 6, W - w / 2 - 6) : clamp(q.ay, h / 2 + 6, H - h / 2 - 6);
      const half = horizontal ? w / 2 : h / 2;
      const lv = levels[side];
      let level = lv.findIndex((end) => along - half > end + gap);
      if (level === -1) level = lv.length < maxLevels ? lv.length : lv.indexOf(Math.min(...lv));
      lv[level] = along + half;
      let x, y;
      if (horizontal) {
        x = along;
        y = side === 0 ? minY - 26 - level * (h + 8) - h / 2 : maxY + 26 + level * (h + 8) + h / 2;
        y = clamp(y, h / 2 + 4, H - h / 2 - 4);
      } else {
        y = along;
        const push = level * (w * 0.6 + 10);
        x = side === 0 ? minX - 26 - w / 2 - push : maxX + 26 + w / 2 + push;
        x = clamp(x, w / 2 + 4, W - w / 2 - 4);
      }
      q.b.el.style.transform = `translate(${x - w / 2}px, ${y - h / 2}px)`;
      q.b.el.style.zIndex = q.b.el.classList.contains('active') ? 3 : q.b.el.classList.contains('hot') ? 2 : 1;
      q.b.line.style.display = '';
      q.b.dot.style.display = '';
      q.b.line.setAttribute('x1', q.ax); q.b.line.setAttribute('y1', q.ay);
      q.b.line.setAttribute('x2', x); q.b.line.setAttribute('y2', y);
      q.b.dot.setAttribute('cx', q.ax); q.b.dot.setAttribute('cy', q.ay);
    });
  }
}

function srgbColour(hex) {
  const c = new THREE.Color(hex);
  c.convertLinearToSRGB();
  return c;
}
