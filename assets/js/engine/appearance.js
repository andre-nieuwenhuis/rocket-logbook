// Colours for parts. Pure functions: return {color, metalness, roughness}.

export const SOFTWARE_COLOURS = {
  'SolidWorks': '#e5594f',
  'Fusion 360': '#f2a93b',
  'Purchased': '#62a8e5',
  'Other': '#9aa3b2',
};

export const SECTION_PALETTE = ['#ff8a3d', '#5aa9ff', '#3ecf8e', '#c58bff', '#f5c84a', '#ef6b8a', '#4fd1c5', '#a3b1c6'];

const DEFAULT_LOOK = { color: '#c9ced6', metalness: 0.1, roughness: 0.55 };

// Order matters: the first match wins.
const MATERIAL_PRESETS = [
  [/alumin/i, { color: '#b9bec7', metalness: 0.85, roughness: 0.32 }],
  [/stainless|steel|zinc|eyebolt|u-?bolt/i, { color: '#9aa0a8', metalness: 0.9, roughness: 0.28 }],
  [/brass/i, { color: '#c8a24c', metalness: 0.9, roughness: 0.3 }],
  [/titanium/i, { color: '#a7a9ac', metalness: 0.85, roughness: 0.35 }],
  [/carbon/i, { color: '#2a2c31', metalness: 0.3, roughness: 0.35 }],
  [/fib(re|er) ?glass|g-?10|grp/i, { color: '#d5dccb', metalness: 0, roughness: 0.42 }],
  [/phenolic|kraft|cardboard|paper|blue ?tube/i, { color: '#b98f5e', metalness: 0, roughness: 0.75 }],
  [/birch|ply|wood|balsa|bass/i, { color: '#d6b37c', metalness: 0, roughness: 0.7 }],
  [/fr-?4|pcb|circuit/i, { color: '#1f7a46', metalness: 0.15, roughness: 0.45 }],
  [/lipo|li-?ion|battery|\b9 ?v\b/i, { color: '#3d6fd6', metalness: 0.2, roughness: 0.4 }],
  [/kevlar/i, { color: '#e8c34a', metalness: 0, roughness: 0.8 }],
  [/nomex/i, { color: '#d9a441', metalness: 0, roughness: 0.85 }],
  [/ripstop|parachute|chute|canopy/i, { color: '#ff6a3d', metalness: 0, roughness: 0.85 }],
  [/delrin|acetal|pom/i, { color: '#f1f1ee', metalness: 0, roughness: 0.5 }],
  [/pet-?g|\bpla\b|\basa\b|\babs\b|resin|print/i, { color: '#e7e5e0', metalness: 0, roughness: 0.55 }],
  [/nylon/i, { color: '#efe9dc', metalness: 0, roughness: 0.6 }],
  [/rubber|silicone|foam/i, { color: '#2b2b2e', metalness: 0, roughness: 0.9 }],
  [/motor|propellant|casing/i, { color: '#4a4f58', metalness: 0.35, roughness: 0.5 }],
];

const COLOUR_WORDS = {
  black: '#232428', white: '#f2f2ef', grey: '#8d939c', gray: '#8d939c', silver: '#c3c7cd',
  red: '#d6453d', orange: '#f07a2b', yellow: '#efc63b', green: '#3f9a5a', blue: '#3a72d8',
  purple: '#8a5fd1', pink: '#e8789c', gold: '#c9a548', clear: '#dfe7ee', natural: '#e7e1d2',
};

export function materialPreset(material) {
  if (!material) return null;
  const s = String(material);
  let look = null;
  for (const [re, l] of MATERIAL_PRESETS) {
    if (re.test(s)) { look = { ...l }; break; }
  }
  // "PETG (black)" -> use the colour word but keep the plastic finish
  const word = Object.keys(COLOUR_WORDS).find((w) => new RegExp(`\\b${w}\\b`, 'i').test(s));
  if (word) look = { ...(look || DEFAULT_LOOK), color: COLOUR_WORDS[word] };
  return look;
}

export function sectionColour(index) {
  return SECTION_PALETTE[((index % SECTION_PALETTE.length) + SECTION_PALETTE.length) % SECTION_PALETTE.length];
}

/**
 * part: {meta, cadColor, software, modelIndex}
 * mode: 'material' | 'software' | 'section'
 */
export function appearanceFor(part, mode) {
  if (mode === 'software') {
    return { color: SOFTWARE_COLOURS[part.software] || SOFTWARE_COLOURS.Other, metalness: 0.05, roughness: 0.55 };
  }
  if (mode === 'section') {
    return { color: sectionColour(part.modelIndex), metalness: 0.05, roughness: 0.55 };
  }
  const preset = materialPreset(part.meta && part.meta.material);
  const look = { ...DEFAULT_LOOK, ...(preset || {}) };
  if (part.meta && part.meta.color) look.color = part.meta.color;
  else if (!preset && part.cadColor) look.color = part.cadColor;
  else if (!preset) look.color = mix(sectionColour(part.modelIndex), '#d7dbe2', 0.55);
  return look;
}

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (p, s) => (p >> s) & 255;
  const c = (s) => Math.round(ch(pa, s) * (1 - t) + ch(pb, s) * t);
  return '#' + ((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, '0');
}

export const MATERIAL_SUGGESTIONS = [
  'PETG (3D printed)', 'ASA (3D printed)', 'PLA (3D printed)', 'Kraft phenolic tube', 'Cardboard tube',
  'Fibreglass', 'Carbon fibre', 'Birch plywood 3 mm', 'Balsa', 'Aluminium 6061', 'Stainless steel',
  'Delrin', 'Nylon', 'PCB (FR-4)', 'LiPo battery', 'Ripstop nylon', 'Kevlar', 'Nomex', 'Motor casing',
];
