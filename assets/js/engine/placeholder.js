// Parametric placeholder rocket, used until the real CAD exists.
// Three sections that mirror the real projects: forward (Fusion 360), recovery bay, aft (SolidWorks).
// Built directly in the rocket frame: +X from nose tip towards the tail, millimetres.
import * as THREE from 'three';

export const PLACEHOLDER_DEFAULTS = {
  body_od_mm: 54,
  body_id_mm: 51,
  nose_length_mm: 190,
  nose_shoulder_mm: 30,
  avbay_band_mm: 30,
  avbay_spigot_mm: 110,
  recovery_length_mm: 380,
  aft_length_mm: 330,
  motor_tube_od_mm: 31,
  motor_tube_id_mm: 29.2,
  motor_tube_length_mm: 150,
  motor_length_mm: 124,
  fin_count: 3,
  fin_root_mm: 100,
  fin_tip_mm: 45,
  fin_span_mm: 55,
  fin_sweep_mm: 45,
  fin_thickness_mm: 3,
};

const SEG = 72;

function lathe(profile, axis = 'x', segments = SEG) {
  const pts = profile.map(([r, h]) => new THREE.Vector2(Math.max(r, 1e-4), h));
  const g = new THREE.LatheGeometry(pts, segments);
  if (axis === 'x') g.rotateZ(-Math.PI / 2); // lathe height (Y) -> rocket axis (X)
  return g;
}

const tube = (ro, ri, x0, x1) => lathe([[ro, x0], [ro, x1], [ri, x1], [ri, x0], [ro, x0]]);
const disk = (r, x0, x1) => lathe([[0, x0], [r, x0], [r, x1], [0, x1]]);

function box(lx, ly, lz, cx, cy, cz) {
  const g = new THREE.BoxGeometry(lx, ly, lz);
  g.translate(cx, cy, cz);
  return g;
}

/** Small radial fitting (rail button, switch) built along +Y then rotated round the axis. */
function radialFitting(profile, radius, angle, station) {
  const g = lathe(profile, 'y', 32);
  g.translate(0, radius, 0);
  g.rotateX(angle);
  g.translate(station, 0, 0);
  return g;
}

function part(name, geometry) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = name;
  const group = new THREE.Group();
  group.name = name;
  group.add(mesh);
  return { name, object: group, cadColor: null };
}

function forward(p) {
  const R = p.body_od_mm / 2, Ri = p.body_id_mm / 2;
  const Ln = p.nose_length_mm, S = Math.min(p.nose_shoulder_mm, p.avbay_band_mm);
  const Rs = Ri - 0.15, wall = 2;
  const rho = (R * R + Ln * Ln) / (2 * R);
  const ogive = (x) => Math.sqrt(Math.max(rho * rho - (Ln - x) * (Ln - x), 0)) + R - rho;

  const outer = [[0, 0]];
  for (let i = 1; i <= 48; i++) {
    const x = Ln * Math.pow(i / 48, 1.5);
    outer.push([ogive(x), x]);
  }
  const inner = [];
  for (let i = 48; i >= 1; i--) {
    const x = Ln * Math.pow(i / 48, 1.5);
    const r = ogive(x) - wall;
    if (r < 0.6) { inner.push([0, x]); break; }
    inner.push([r, x]);
  }
  const nose = lathe([...outer, [Rs, Ln], [Rs, Ln + S], [Rs - wall, Ln + S], [Rs - wall, Ln], ...inner]);

  const a0 = Ln, a1 = Ln + p.avbay_band_mm, a2 = a1 + p.avbay_spigot_mm;
  const Rspig = Ri - 0.15, Rin = Rspig - 2.4;
  const avbay = lathe([[R, a0], [R, a1], [Rspig, a1], [Rspig, a2], [Rin, a2], [Rin, a1], [Ri, a1], [Ri, a0], [R, a0]]);
  const bhFwd = disk(Rin - 0.1, a1 + 2, a1 + 6);
  const bhAft = disk(Rin - 0.1, a2 - 6, a2 - 2);

  const s0 = a1 + 12, s1 = a2 - 12, sm = (s0 + s1) / 2, sl = s1 - s0;
  const sledW = Math.min(40, Rin * 1.7);
  const sled = box(sl, 3, sledW, sm, 0, 0);
  const board = box(Math.min(45, sl * 0.55), 6, 18, sm - sl * 0.1, 4.5, 0);
  const baro = box(10, 3, 10, s0 + 12, 3, -sledW / 2 + 6);
  const imu = box(12, 3, 12, s1 - 14, 3, 0);
  const battery = box(Math.min(50, sl * 0.6), 12, Math.min(20, sledW * 0.5), sm, -7.5, 0);
  const sw = radialFitting([[0, 0], [3.5, 0], [3.5, 2], [2, 2], [2, 6], [0, 6]], R - 0.5, 0, (a0 + a1) / 2);

  const shaft = new THREE.CylinderGeometry(2.5, 2.5, 12, 24);
  shaft.rotateZ(-Math.PI / 2);
  shaft.translate(a2 + 4, 0, 0);
  const ring = new THREE.TorusGeometry(6, 1.6, 12, 32);
  ring.translate(a2 + 16, 0, 0);
  const eyebolt = mergeSimple([shaft, ring]);

  return [
    part('Nose cone', nose),
    part('Avionics bay', avbay),
    part('Av-bay bulkhead (forward)', bhFwd),
    part('Av-bay bulkhead (aft)', bhAft),
    part('Electronics sled', sled),
    part('Flight computer (Arduino Nano)', board),
    part('Barometer', baro),
    part('IMU', imu),
    part('Battery', battery),
    part('Arming switch', sw),
    part('Recovery eyebolt', eyebolt),
  ];
}

function recovery(p) {
  const R = p.body_od_mm / 2, Ri = p.body_id_mm / 2, L = p.recovery_length_mm;
  const bodyTube = tube(R, Ri, 0, L);
  const c0 = L * 0.38, c1 = c0 + L * 0.13;
  const cord = lathe([[0, c0], [Ri * 0.45, c0], [Ri * 0.55, c0 + 6], [Ri * 0.55, c1 - 6], [Ri * 0.45, c1], [0, c1]]);
  const p0 = c1 + 2, p1 = p0 + L * 0.24;
  const chute = lathe([[0, p0], [Ri * 0.7, p0], [Ri * 0.82, p0 + 8], [Ri * 0.82, p1 - 8], [Ri * 0.7, p1], [0, p1]]);
  const n0 = p1 + 1, n1 = n0 + L * 0.06;
  const nomex = lathe([[0, n0], [Ri * 0.86, n0], [Ri * 0.9, n0 + 3], [Ri * 0.9, n1], [0, n1]]);
  return [
    part('Recovery body tube', bodyTube),
    part('Shock cord', cord),
    part('Parachute (packed)', chute),
    part('Nomex chute protector', nomex),
  ];
}

function aft(p) {
  const R = p.body_od_mm / 2, Ri = p.body_id_mm / 2, L = p.aft_length_mm;
  const Rmo = p.motor_tube_od_mm / 2, Rmi = p.motor_tube_id_mm / 2;
  const mt1 = L, mt0 = L - p.motor_tube_length_mm;
  const ringT = 6;
  const fwdRing0 = mt0, aftRing1 = L - 18;

  const out = [
    part('Body tube (aft)', tube(R, Ri, 0, L)),
    part('Motor tube', tube(Rmo, Rmi, mt0, mt1)),
    part('Forward centring ring', tube(Ri, Rmo, fwdRing0, fwdRing0 + ringT)),
    part('Aft centring ring', tube(Ri, Rmo, aftRing1 - ringT, aftRing1)),
    part('Thrust ring', tube(Rmi, Rmi - 2.6, mt0, mt0 + 4)),
  ];

  const m1 = L - 4, m0 = m1 - p.motor_length_mm, Rc = Rmi - 0.6;
  out.push(part('Motor (29 mm dummy)', lathe([[0, m0], [Rc - 0.2, m0], [Rc, m0 + 1], [Rc, m1 - 8], [Rc * 0.8, m1], [Rc * 0.4, m1], [Rc * 0.4, m1 - 4], [0, m1 - 4]])));
  out.push(part('Motor retainer', lathe([[Rmo + 0.1, L - 4], [Rmo + 2.4, L - 4], [Rmo + 2.4, L + 15], [Rc * 0.7, L + 15], [Rc * 0.7, L + 12], [Rmo + 0.1, L + 12], [Rmo + 0.1, L - 4]])));

  // Through-the-wall fins
  const rootEnd = L - 2, rootStart = rootEnd - p.fin_root_mm;
  const tipStart = rootStart + p.fin_sweep_mm, tipEnd = tipStart + p.fin_tip_mm;
  const tabStart = Math.max(rootStart + 10, fwdRing0 + ringT + 2);
  const tabEnd = Math.max(tabStart + 5, Math.min(rootEnd - 10, aftRing1 - ringT - 2));
  const span = R + p.fin_span_mm;
  const shape = new THREE.Shape();
  shape.moveTo(tabStart, Rmo);
  shape.lineTo(tabEnd, Rmo);
  shape.lineTo(tabEnd, R);
  shape.lineTo(rootEnd, R);
  shape.lineTo(tipEnd, span);
  shape.lineTo(tipStart, span);
  shape.lineTo(rootStart, R);
  shape.lineTo(tabStart, R);
  shape.closePath();
  const n = Math.max(1, Math.round(p.fin_count));
  for (let k = 0; k < n; k++) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: p.fin_thickness_mm, bevelEnabled: false });
    g.translate(0, 0, -p.fin_thickness_mm / 2);
    g.rotateX((2 * Math.PI * k) / n);
    out.push(part(`Fin-${k + 1}`, g));
  }

  const btn = [[0, 0], [5, 0], [5, 2], [2.6, 2], [2.6, 5.5], [4.8, 5.5], [4.8, 7.5], [0, 7.5]];
  const between = Math.PI / n;
  out.push(part('Rail button-1', radialFitting(btn, R - 0.5, between, 40)));
  out.push(part('Rail button-2', radialFitting(btn, R - 0.5, between, Math.max(80, L - 40))));

  const ubolt = new THREE.TorusGeometry(5, 1.3, 10, 24, Math.PI);
  ubolt.rotateZ(Math.PI / 2);
  ubolt.translate(fwdRing0 - 1, 0, 0);
  out.push(part('Shock cord anchor', ubolt));
  return out;
}

function mergeSimple(geoms) {
  // Minimal merge for non-indexed + indexed geometries with position/normal only.
  const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const g of parts) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

const BUILDERS = { forward, recovery, aft };

export function buildPlaceholder(name, params = {}) {
  const builder = BUILDERS[name];
  if (!builder) throw new Error(`Unknown placeholder "${name}". Use one of: ${Object.keys(BUILDERS).join(', ')}.`);
  const p = { ...PLACEHOLDER_DEFAULTS, ...params };
  return { parts: builder(p), defaultUnits: 'mm', fixedUnits: 'mm', preOriented: true, kind: 'placeholder' };
}
