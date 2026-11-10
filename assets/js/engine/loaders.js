// Turns a model entry (file or placeholder) into a list of named parts.
// Every loader returns { parts: [{name, object: THREE.Group, cadColor}], defaultUnits, fixedUnits?, preOriented?, kind }.
import * as THREE from 'three';

const THREE_VERSION = '0.170.0';
const ADDONS = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/`;
const OCCT_BASE = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/';

export const SUPPORTED_EXT = ['step', 'stp', 'iges', 'igs', 'stl', 'obj', 'glb', 'gltf', '3mf', 'fbx'];

export const NATIVE_CAD_EXT = {
  sldprt: 'SolidWorks part', sldasm: 'SolidWorks assembly', slddrw: 'SolidWorks drawing',
  f3d: 'Fusion 360 design', f3z: 'Fusion 360 archive', ipt: 'Inventor part', iam: 'Inventor assembly',
  x_t: 'Parasolid', x_b: 'Parasolid', sat: 'ACIS', dwg: 'AutoCAD drawing', dxf: '2D drawing',
};

export const EXT_DEFAULT_UNITS = { stl: 'mm', obj: 'mm', glb: 'm', gltf: 'm', '3mf': 'mm', fbx: 'cm' };

export async function loadSource({ placeholder, params, url, ext, displayName }) {
  if (placeholder) {
    const { buildPlaceholder } = await import('./placeholder.js');
    return buildPlaceholder(placeholder, params);
  }
  switch (ext) {
    case 'step': case 'stp': return loadOCCT(url, 'step', displayName);
    case 'iges': case 'igs': return loadOCCT(url, 'iges', displayName);
    case 'stl': return loadSTL(url, displayName);
    case 'obj': return loadWith('loaders/OBJLoader.js', 'OBJLoader', url, displayName, 'obj', (r) => r);
    case 'glb': case 'gltf': return loadGLTF(url, displayName, ext);
    case '3mf': return loadWith('loaders/3MFLoader.js', 'ThreeMFLoader', url, displayName, '3mf', (r) => r);
    case 'fbx': return loadWith('loaders/FBXLoader.js', 'FBXLoader', url, displayName, 'fbx', (r) => r);
    default: throw new Error(`".${ext}" files aren't supported. Use STEP, STL, OBJ, GLB, 3MF, IGES or FBX.`);
  }
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || ''} — check the file is in the models/ folder and the name matches rocket.json`.trim());
  return res.arrayBuffer();
}

// ---------- STEP / IGES (real CAD, keeps part names and assembly structure) ----------
let occtPromise = null;
function getOcct() {
  if (!occtPromise) {
    occtPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = OCCT_BASE + 'occt-import-js.js';
      s.async = true;
      s.onload = () => {
        if (typeof window.occtimportjs !== 'function') return reject(new Error('STEP reader failed to start.'));
        window.occtimportjs({ locateFile: (f) => OCCT_BASE + f }).then(resolve, reject);
      };
      s.onerror = () => reject(new Error('Could not download the STEP reader (needs an internet connection).'));
      document.head.appendChild(s);
    }).catch((e) => { occtPromise = null; throw e; });
  }
  return occtPromise;
}

function colourToHex(c) {
  if (!Array.isArray(c) || c.length < 3) return null;
  const scale = c.some((v) => v > 1) ? 1 / 255 : 1;
  return '#' + new THREE.Color(c[0] * scale, c[1] * scale, c[2] * scale).getHexString(THREE.SRGBColorSpace);
}

async function loadOCCT(url, kind, displayName) {
  const [occt, buf] = await Promise.all([getOcct(), fetchBuffer(url)]);
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.0008,
    angularDeflection: 0.35,
  };
  const bytes = new Uint8Array(buf);
  const res = kind === 'step' ? occt.ReadStepFile(bytes, params) : occt.ReadIgesFile(bytes, params);
  if (!res || !res.success) throw new Error(`The ${kind.toUpperCase()} file could not be read. Try re-exporting it (AP214 for STEP).`);

  const parts = [];
  const walk = (node, inherited) => {
    const nodeName = (node.name || '').trim() || inherited;
    if (node.meshes && node.meshes.length) {
      const group = new THREE.Group();
      let colour = null;
      for (const mi of node.meshes) {
        const m = res.meshes[mi];
        if (!m || !m.attributes || !m.attributes.position) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
        if (m.attributes.normal && m.attributes.normal.array.length) {
          geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
        }
        if (m.index && m.index.array) geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.index.array), 1));
        if (!geo.attributes.normal) geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
        mesh.name = m.name || nodeName || '';
        group.add(mesh);
        if (!colour) colour = m.color || (m.brep_faces || []).map((f) => f.color).find(Boolean) || null;
      }
      if (group.children.length) {
        const first = res.meshes[node.meshes[0]];
        const name = (node.name || '').trim() || (first && first.name) || inherited || `Part ${parts.length + 1}`;
        group.name = name;
        parts.push({ name, object: group, cadColor: colourToHex(colour) });
      }
    }
    for (const child of node.children || []) walk(child, nodeName);
  };
  walk(res.root, displayName);
  if (!parts.length) throw new Error('No solid geometry was found in the file.');
  return { parts, defaultUnits: 'mm', fixedUnits: 'mm', kind };
}

// ---------- Mesh formats ----------
async function addon(path, exportName) {
  const mod = await import(ADDONS + path);
  return mod[exportName];
}

async function loadSTL(url, displayName) {
  const STLLoader = await addon('loaders/STLLoader.js', 'STLLoader');
  const geo = new STLLoader().parse(await fetchBuffer(url));
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  mesh.name = displayName;
  const group = new THREE.Group();
  group.name = displayName;
  group.add(mesh);
  return { parts: [{ name: displayName, object: group, cadColor: null }], defaultUnits: 'mm', kind: 'stl' };
}

async function loadGLTF(url, displayName, ext) {
  const { GLTFLoader } = await import(ADDONS + 'loaders/GLTFLoader.js');
  const { DRACOLoader } = await import(ADDONS + 'loaders/DRACOLoader.js');
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(ADDONS + 'libs/draco/gltf/');
  loader.setDRACOLoader(draco);
  const gltf = await loader.loadAsync(url);
  return { parts: partsFromObject(gltf.scene, displayName), defaultUnits: 'm', kind: ext };
}

async function loadWith(path, exportName, url, displayName, kind, pick) {
  const Loader = await addon(path, exportName);
  const result = await new Loader().loadAsync(url);
  return { parts: partsFromObject(pick(result), displayName), defaultUnits: EXT_DEFAULT_UNITS[kind] || 'mm', kind };
}

function hasMesh(o) {
  let found = false;
  o.traverse((c) => { if (c.isMesh) found = true; });
  return found;
}

function firstColour(o) {
  let hex = null;
  o.traverse((c) => {
    if (hex || !c.isMesh) return;
    const m = Array.isArray(c.material) ? c.material[0] : c.material;
    if (m && m.color) hex = '#' + m.color.getHexString(THREE.SRGBColorSpace);
  });
  return hex;
}

/** Split a loaded scene graph into parts: unwrap single-child wrappers, then each child is a part. */
export function partsFromObject(root, fallbackName) {
  root.updateMatrixWorld(true);
  let node = root;
  while (!node.isMesh && node.children.length === 1 && !node.children[0].isMesh) node = node.children[0];
  const candidates = node.isMesh ? [node] : node.children.filter(hasMesh);
  if (!candidates.length) throw new Error('No geometry found in the file.');
  return candidates.map((c, i) => {
    c.updateWorldMatrix(true, false);
    const world = c.matrixWorld.clone();
    c.removeFromParent();
    world.decompose(c.position, c.quaternion, c.scale);
    const group = new THREE.Group();
    let name = (c.name || '').trim();
    if (!name && c.isMesh && c.geometry && c.geometry.name) name = c.geometry.name;
    if (!name) name = candidates.length === 1 ? fallbackName : `${fallbackName} ${i + 1}`;
    group.name = name;
    group.add(c);
    return { name, object: group, cadColor: firstColour(c) };
  });
}
