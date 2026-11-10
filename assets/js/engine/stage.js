// Scenery for the viewer: star sky, launch-range grid, contact shadow, exhaust/smoke particles.
import * as THREE from 'three';

// ---------------------------------------------------------------- star sky
// Stars live "at infinity": only the camera's rotation moves them, so they never clip or get flown through.
export function makeStars(count = 2200) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    pos[i * 3] = r * Math.cos(th); pos[i * 3 + 1] = u; pos[i * 3 + 2] = r * Math.sin(th);
    const b = 0.45 + Math.pow(Math.random(), 3) * 0.55;
    const tint = Math.random();
    col[i * 3] = b * (tint > 0.85 ? 1.0 : tint < 0.15 ? 0.78 : 0.92);
    col[i * 3 + 1] = b * 0.92;
    col[i * 3 + 2] = b * (tint < 0.15 ? 1.0 : tint > 0.85 ? 0.75 : 0.98);
    size[i] = 0.7 + Math.pow(Math.random(), 4) * 2.6;
    phase[i] = Math.random() * Math.PI * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uFade: { value: 1 } },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aSize; attribute float aPhase;
      uniform float uTime; uniform float uPixelRatio; uniform float uFade;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
        float tw = 0.75 + 0.25 * sin(uTime * (0.6 + fract(aPhase) * 1.4) + aPhase * 7.0);
        // dim stars near and below the horizon
        float horizon = smoothstep(-0.08, 0.35, position.y);
        vAlpha = tw * horizon * uFade;
        vColor = aColor;
        gl_PointSize = aSize * uPixelRatio;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(vColor, a * a * vAlpha);
      }`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = -10;
  return pts;
}

// ---------------------------------------------------------------- launch-range grid
// Concentric range rings and bearing spokes that fade out with distance.
export function makeRange({ radius, step, dark, accent = '#ff7a2f' }) {
  const pos = [], col = [];
  const base = dark ? [0.55, 0.66, 0.82] : [0.30, 0.37, 0.47];
  const a0 = dark ? 0.42 : 0.5;
  const fade = (r) => a0 * Math.pow(Math.max(0, 1 - r / radius), 1.15);
  const push = (x1, z1, x2, z2, c, a1, a2) => {
    pos.push(x1, 0, z1, x2, 0, z2);
    col.push(c[0], c[1], c[2], a1, c[0], c[1], c[2], a2);
  };
  const seg = 160;
  for (let r = step; r <= radius + 1e-6; r += step) {
    const major = Math.abs((r / step) % 2) < 1e-6 || r === step;
    const a = fade(r) * (major ? 1 : 0.55);
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      push(Math.cos(t0) * r, Math.sin(t0) * r, Math.cos(t1) * r, Math.sin(t1) * r, base, a, a);
    }
  }
  for (let k = 0; k < 12; k++) {
    const th = (k / 12) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    const r0 = step * 0.5;
    const n = 12;
    for (let j = 0; j < n; j++) {
      const ra = r0 + (radius - r0) * (j / n), rb = r0 + (radius - r0) * ((j + 1) / n);
      const w = k % 3 === 0 ? 0.9 : 0.45;
      push(c * ra, s * ra, c * rb, s * rb, base, fade(ra) * w, fade(rb) * w);
    }
  }
  // centre crosshair in the accent colour
  const ac = new THREE.Color(accent);
  const cc = [ac.r, ac.g, ac.b];
  const ch = step * 0.35;
  push(-ch, 0, -ch * 0.001, 0, cc, 0.0, 0.85); push(ch * 0.001, 0, ch, 0, cc, 0.85, 0.0);
  push(0, -ch, 0, -ch * 0.001, cc, 0.0, 0.85); push(0, ch * 0.001, 0, ch, cc, 0.85, 0.0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  return new THREE.LineSegments(g, m);
}

// ---------------------------------------------------------------- soft contact shadow
let shadowTex = null;
export function makeShadow() {
  if (!shadowTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,1)');
    gr.addColorStop(0.45, 'rgba(0,0,0,0.55)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 128, 128);
    shadowTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, color: 0x000000, opacity: 0.6 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
}

// ---------------------------------------------------------------- particles (flame, smoke)
export class Particles {
  constructor(max, { additive = false } = {}) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max).fill(0);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aAlpha', this.aAlpha);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 } },
      vertexShader: /* glsl */`
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(aSize * uScale / max(-mv.z, 1.0), 512.0);
          vColor = aColor; vAlpha = aAlpha;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor; varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          float a = pow(1.0 - d, 1.6) * vAlpha;
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
  }

  emit(px, py, pz, vx, vy, vz, life, s0, s1, a0, c0, c1) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = px; this.pos[i * 3 + 1] = py; this.pos[i * 3 + 2] = pz;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.age[i] = 0; this.life[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a0;
    this.c0[i * 3] = c0[0]; this.c0[i * 3 + 1] = c0[1]; this.c0[i * 3 + 2] = c0[2];
    this.c1[i * 3] = c1[0]; this.c1[i * 3 + 1] = c1[1]; this.c1[i * 3 + 2] = c1[2];
  }

  update(dt, { drag = 0, rise = 0 } = {}) {
    const k = Math.exp(-drag * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) { this.life[i] = 0; this.alpha[i] = 0; this.size[i] = 0; continue; }
      const j = i * 3;
      this.vel[j] *= k; this.vel[j + 1] = this.vel[j + 1] * k + rise * dt; this.vel[j + 2] *= k;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      this.alpha[i] = this.a0[i] * Math.pow(1 - t, 1.4) * Math.min(1, t * 12 + 0.25);
      this.col[j] = this.c0[j] + (this.c1[j] - this.c0[j]) * t;
      this.col[j + 1] = this.c0[j + 1] + (this.c1[j + 1] - this.c0[j + 1]) * t;
      this.col[j + 2] = this.c0[j + 2] + (this.c1[j + 2] - this.c0[j + 2]) * t;
    }
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = this.aAlpha.needsUpdate = true;
  }

  clear() {
    this.life.fill(0); this.alpha.fill(0); this.size.fill(0);
    this.aAlpha.needsUpdate = this.aSize.needsUpdate = true;
  }

  dispose() { this.points.geometry.dispose(); this.material.dispose(); }
}
