// Loading, normalising, matching and saving rocket.json. No three.js here.
import { globToRegExp, baseName } from './math.js';

export const SOFTWARE_OPTIONS = ['SolidWorks', 'Fusion 360', 'Purchased', 'Other'];
export const UNIT_OPTIONS = ['auto', 'mm', 'cm', 'm', 'in'];
export const AXIS_OPTIONS = ['auto', 'x', 'y', 'z'];
export const COLOUR_MODES = { material: 'Material', software: 'Software', section: 'Section' };

const MODEL_DEFAULTS = {
  software: 'Other',
  section: '',
  units: 'auto',
  axis: 'auto',
  flip: false,
  roll_deg: 0,
  gap_mm: 0,
  start_mm: null,
  rotate_deg: [0, 0, 0],
  offset_mm: [0, 0, 0],
};

export const LABEL_STYLES = { minimal: 'Numbers (names on hover)', names: 'Numbers and names' };

export const VIEWER_DEFAULTS = {
  colour_mode: 'material',
  label_style: 'minimal',
  turntable: true,
  explode_gap: 0.06,
  start_exploded: false,
  labels: true,
  ruler: true,
  markers: true,
  grid: true,
};

export function fileBase(path) {
  return String(path || '').split(/[\\/]/).pop();
}

export function fileExt(path) {
  const b = fileBase(path);
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i + 1).toLowerCase() : '';
}

/** Identifier used by part rules to target one model: file name, or "placeholder:<name>". */
export function modelKey(model) {
  if (!model) return '';
  return model.placeholder ? `placeholder:${model.placeholder}` : fileBase(model.file);
}

export function modelTitle(model) {
  if (!model) return '';
  if (model.placeholder) return `Placeholder ${model.placeholder} section`;
  return fileBase(model.file);
}

const num = (v, d = null) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));
const vec3 = (v) => (Array.isArray(v) && v.length === 3 ? v.map((x) => num(x, 0)) : [0, 0, 0]);

export function normaliseModel(m, i, warnings) {
  if (!m || (!m.file && !m.placeholder)) {
    warnings.push(`models[${i}] has neither "file" nor "placeholder" and was skipped.`);
    return null;
  }
  const out = { ...MODEL_DEFAULTS, ...m };
  out.rotate_deg = vec3(m.rotate_deg);
  out.offset_mm = vec3(m.offset_mm);
  out.roll_deg = num(m.roll_deg, 0);
  out.gap_mm = num(m.gap_mm, 0);
  out.start_mm = num(m.start_mm, null);
  out.flip = !!m.flip;
  if (!UNIT_OPTIONS.includes(out.units)) { warnings.push(`models[${i}] units "${out.units}" unknown, using auto.`); out.units = 'auto'; }
  if (!AXIS_OPTIONS.includes(out.axis)) { warnings.push(`models[${i}] axis "${out.axis}" unknown, using auto.`); out.axis = 'auto'; }
  if (!out.section) out.section = m.placeholder ? `${capital(m.placeholder)} section` : stripExt(fileBase(m.file));
  if (m.placeholder) out.params = { ...(m.params || {}) };
  return out;
}

function capital(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
function stripExt(s) { return String(s).replace(/\.[^.]+$/, ''); }

export function normaliseConfig(raw) {
  const warnings = [];
  raw = raw && typeof raw === 'object' ? raw : {};
  const rocket = {
    title: 'My rocket',
    subtitle: '',
    layout: 'stack',
    axis: 'auto',
    flip: false,
    roll_deg: 0,
    diameter_mm: null,
    project_url: '',
    ...(raw.rocket || {}),
  };
  if (!['stack', 'assembly'].includes(rocket.layout)) {
    warnings.push(`rocket.layout "${rocket.layout}" unknown, using "stack".`);
    rocket.layout = 'stack';
  }
  rocket.diameter_mm = num(rocket.diameter_mm, null);
  rocket.roll_deg = num(rocket.roll_deg, 0);

  const stabilityCfg = { cp_mm: null, cg_mm: null, source: '', ...(raw.stability || {}) };
  stabilityCfg.cp_mm = num(stabilityCfg.cp_mm, null);
  stabilityCfg.cg_mm = num(stabilityCfg.cg_mm, null);

  const models = (Array.isArray(raw.models) ? raw.models : []).map((m, i) => normaliseModel(m, i, warnings)).filter(Boolean);

  const parts = (Array.isArray(raw.parts) ? raw.parts : [])
    .filter((r, i) => {
      if (r && typeof r === 'object' && r.match) return true;
      warnings.push(`parts[${i}] has no "match" and was ignored.`);
      return false;
    })
    .map((r) => ({ ...r }));

  const extra = (Array.isArray(raw.extra_masses) ? raw.extra_masses : [])
    .filter((e) => e && e.name)
    .map((e) => ({ name: String(e.name), mass_g: num(e.mass_g, null), station_mm: num(e.station_mm, null) }));

  const viewer = { ...VIEWER_DEFAULTS, ...(raw.viewer || {}) };
  if (!COLOUR_MODES[viewer.colour_mode]) viewer.colour_mode = 'material';
  if (!LABEL_STYLES[viewer.label_style]) viewer.label_style = 'minimal';
  viewer.explode_gap = num(viewer.explode_gap, VIEWER_DEFAULTS.explode_gap);

  // Optional real motor for the launch preview: { motor_name, propellant_g, curve: [[t, N], ...], cd }
  const flight = raw.flight && typeof raw.flight === 'object' ? { ...raw.flight } : null;
  if (flight && flight.curve && !Array.isArray(flight.curve)) { warnings.push('flight.curve must be a list of [time, thrust] pairs; using the generic motor.'); delete flight.curve; }

  return { config: { rocket, stability: stabilityCfg, models, parts, extra_masses: extra, viewer, flight }, warnings };
}

export function ruleMatches(rule, partName, model) {
  if (rule.model && String(rule.model).toLowerCase() !== modelKey(model).toLowerCase()) return false;
  const re = globToRegExp(rule.match);
  return re.test(partName) || re.test(baseName(partName));
}

const META_FIELDS = ['label', 'description', 'material', 'mass_g', 'order', 'color', 'software', 'section', 'link', 'explode', 'hidden'];

/** Merge every rule that matches this part; later rules override earlier ones field by field. */
export function resolvePartMeta(config, partName, model) {
  const meta = {};
  for (const rule of config.parts) {
    if (!ruleMatches(rule, partName, model)) continue;
    for (const f of META_FIELDS) {
      if (rule[f] === undefined || rule[f] === null || rule[f] === '') continue;
      meta[f] = f === 'explode' ? { ...(meta.explode || {}), ...rule[f] } : rule[f];
    }
  }
  if (meta.mass_g !== undefined) meta.mass_g = num(meta.mass_g, undefined);
  if (meta.order !== undefined) meta.order = num(meta.order, undefined);
  if (meta.explode) {
    meta.explode = { axial_mm: num(meta.explode.axial_mm, null), radial_mm: num(meta.explode.radial_mm, null) };
  }
  return meta;
}

/**
 * Find (or create) the rule that targets exactly this part (or all its instances) in this model,
 * and apply `changes`. Empty strings / null delete a field.
 */
export function upsertPartRule(config, { partName, model, allInstances }, changes) {
  const match = allInstances ? baseName(partName) : partName;
  const mk = modelKey(model);
  let rule = config.parts.find((r) => r.match === match && (r.model || '') === mk);
  if (!rule) {
    rule = { match, model: mk };
    config.parts.push(rule);
  }
  for (const [k, v] of Object.entries(changes)) {
    if (v === '' || v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) delete rule[k];
    else rule[k] = v;
  }
  if (rule.explode && typeof rule.explode === 'object') {
    for (const k of Object.keys(rule.explode)) if (rule.explode[k] === null || rule.explode[k] === '') delete rule.explode[k];
    if (!Object.keys(rule.explode).length) delete rule.explode;
  }
  return rule;
}

/** Clean JSON for saving: drops fields that are just defaults so the file stays readable. */
export function serialiseConfig(config) {
  const out = {
    rocket: pruneEmpty({ ...config.rocket }),
    stability: pruneEmpty({ ...config.stability }),
    models: config.models.map((m) => {
      const o = {};
      if (m.placeholder) o.placeholder = m.placeholder; else o.file = m.file;
      o.software = m.software;
      o.section = m.section;
      for (const [k, d] of Object.entries(MODEL_DEFAULTS)) {
        if (k === 'software' || k === 'section') continue;
        if (JSON.stringify(m[k]) !== JSON.stringify(d)) o[k] = m[k];
      }
      if (m.placeholder && m.params && Object.keys(m.params).length) o.params = m.params;
      return o;
    }),
    parts: config.parts.map((r) => {
      const o = { match: r.match };
      if (r.model) o.model = r.model;
      for (const f of META_FIELDS) if (r[f] !== undefined && r[f] !== '' && r[f] !== null) o[f] = r[f];
      return o;
    }),
    extra_masses: config.extra_masses.map((e) => pruneEmpty({ ...e })),
    viewer: { ...config.viewer },
  };
  if (config.flight && Object.keys(config.flight).length) out.flight = config.flight;
  return JSON.stringify(out, null, 2) + '\n';
}

function pruneEmpty(o) {
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === '' || o[k] === undefined) delete o[k];
  return o;
}
