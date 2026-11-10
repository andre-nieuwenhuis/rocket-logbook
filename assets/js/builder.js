// The Builder: forms for adding projects and iterations, then publishing them to GitHub
// (or downloading them as a folder to upload by hand). No code editing needed.
import { $, $$, h, slug, fileExt, fileName, fmtBytes, toast, makeZip } from './util.js';
import { store, project, latest, STATUS, OUTCOME } from './store.js';
import * as gh from './github.js';
import { partNamesFromFile, supportedModelExt } from './stage.js';

const KIND_BY_EXT = { step: 'cad', stp: 'cad', iges: 'cad', igs: 'cad', stl: 'cad', obj: 'cad', glb: 'cad', gltf: 'cad', '3mf': 'cad', fbx: 'cad', sldprt: 'cad', sldasm: 'cad', f3d: 'cad', f3z: 'cad', dxf: 'cad',
  ino: 'code', cpp: 'code', c: 'code', h: 'code', py: 'code', m: 'code', js: 'code', json: 'code', txt: 'doc', md: 'doc', pdf: 'doc', csv: 'data', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image' };
const FOLDER = { cad: 'files/cad/', code: 'files/code/', data: 'files/data/', doc: 'files/docs/', image: 'files/photos/', other: 'files/other/' };
const safeName = (n) => n.replace(/[^A-Za-z0-9._-]+/g, '_');

let root, hooks, settings;
const S = { mode: null, pid: null, iid: null, isNew: false, draft: null, uploads: new Map(), projDraft: null, siteDraft: null };

// ---------------------------------------------------------------- form helpers
function field(label, input, hint) { return h('label.field', label, input, hint ? h('span.hint', hint) : null); }
function text(obj, key, { type = 'text', placeholder = '', oninput } = {}) {
  const el = h('input', { type, placeholder, value: obj[key] ?? '' });
  el.addEventListener('input', () => { obj[key] = type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value; oninput && oninput(el.value); });
  return el;
}
function area(obj, key, placeholder = '') { const el = h('textarea', { placeholder }); el.value = obj[key] ?? ''; el.addEventListener('input', () => { obj[key] = el.value; }); return el; }
function select(obj, key, options) {
  const el = h('select', options.map(([v, t]) => h('option', { value: v, selected: (obj[key] ?? '') === v }, t)));
  el.addEventListener('change', () => { obj[key] = el.value; });
  return el;
}
function fileButton(label, accept, multiple, onFiles) {
  const input = h('input', { type: 'file', accept: accept || null, multiple });
  input.addEventListener('change', () => { if (input.files.length) onFiles([...input.files]); input.value = ''; });
  const box = h('label.drop', label, input);
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('over'); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
  return box;
}
function addUpload(file, kind) {
  const k = kind || KIND_BY_EXT[fileExt(file.name)] || 'other';
  const path = FOLDER[k] + safeName(file.name);
  S.uploads.set(path, file);
  return { path, kind: k };
}

/** A repeating list of small forms (specs, parts, changes ...). `fields` builds the inputs for one row. */
function rows(list, blank, fields, addLabel, rowTitle) {
  const box = h('div.rows');
  const draw = () => {
    box.replaceChildren(...list.map((row, i) => h('div.rowbox',
      h('div.rtop', h('span', rowTitle ? rowTitle(row, i) : `#${i + 1}`),
        h('span', i ? h('button.btn.small', { type: 'button', style: { minHeight: '32px' }, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); } }, '↑') : null, ' ',
          h('button.btn.small', { type: 'button', style: { minHeight: '32px' }, onclick: () => { list.splice(i, 1); draw(); } }, 'Remove'))),
      fields(row, draw))),
      h('button.btn.small', { type: 'button', style: { width: 'fit-content' }, onclick: () => { list.push(typeof blank === 'function' ? blank() : { ...blank }); draw(); } }, addLabel));
  };
  draw();
  box.redraw = draw;
  return box;
}
const section = (title, note, open, ...kids) => h('details.b-sec.glass', { open }, h('summary', title, note ? h('small', note) : null), ...kids);

// ---------------------------------------------------------------- drafts
function blankIteration(p) {
  const prev = p ? latest(p) : null;
  const n = p ? p.iters.length + 1 : 1;
  const d = { id: `mk${n}`, name: `Mk${n}`, date: new Date().toISOString().slice(0, 10), status: 'design', summary: '', specs: [], model: { layout: 'stack', models: [], stability: {} }, parts: [], changes: [], buildLog: [], flights: [], failure: null, files: [] };
  if (prev) {
    d.specs = prev.specs.map((s) => ({ ...s }));
    d.parts = prev.parts.map((x) => { const c = { ...x, change: 'unchanged', changeNote: '' }; delete c.files; return c; });
    d.model = JSON.parse(JSON.stringify(prev.model));
    // keep pointing at the previous iteration's CAD until new files are dropped in
    d.model.models = d.model.models.map((m) => (m.file && !/^(\.\.\/|https?:)/.test(m.file) ? { ...m, file: `../${prev.id}/${m.file}` } : m));
  }
  return d;
}
function cloneIteration(it) {
  const d = JSON.parse(JSON.stringify(it));
  delete d.pid; delete d.base;
  return d;
}
function cleanIteration(d) {
  const out = JSON.parse(JSON.stringify(d));
  delete out.id; delete out.pid; delete out.base;
  out.specs = out.specs.filter((s) => s.label).map((s) => ({ ...s, value: s.value !== '' && s.value !== null && Number.isFinite(Number(s.value)) ? Number(s.value) : s.value }));
  out.parts = out.parts.filter((p) => p.match).map((p) => { const c = { ...p }; if (!c.change || c.change === 'unchanged') { delete c.change; delete c.changeNote; } for (const k of Object.keys(c)) if (c[k] === '' || c[k] === null) delete c[k]; return c; });
  out.changes = out.changes.filter((c) => c.title);
  out.buildLog = out.buildLog.filter((b) => b.title || b.text);
  out.flights = out.flights.filter((f) => f.title || f.notes || f.date);
  if (out.failure) {
    const f = out.failure;
    f.todo = (f.todo || []).filter((t) => t.text && t.text.trim());
    if (!f.what && !f.rootCause && !f.evidence && !f.todo.length) out.failure = null;
  }
  if (out.model.stability && (out.model.stability.cp_mm === null || out.model.stability.cp_mm === '')) delete out.model.stability.cp_mm;
  return out;
}

// ---------------------------------------------------------------- the iteration form
function iterationForm(p, d) {
  const earlier = p.iters.filter((x) => x.id !== d.id && (S.isNew || p.iters.indexOf(x) < p.iters.findIndex((y) => y.id === d.id)));
  const todos = earlier.flatMap((x) => (x.failure ? x.failure.todo.map((t) => ({ ref: `${x.id}/${t.id}`, label: `${x.name}: ${t.text}` })) : []));
  d.failure ||= { what: '', rootCause: '', evidence: '', todo: [] };
  d.model.stability ||= {};

  const idField = text(d, 'id');
  idField.disabled = !S.isNew;
  const basics = section('1. Basics', 'name, date, status', true,
    h('div.frow', field('Name', text(d, 'name', { placeholder: 'Mk4', oninput: (v) => { if (S.isNew) { d.id = slug(v); idField.value = d.id; } } }), 'Shown everywhere, for example Mk4'),
      field('Folder name', idField, S.isNew ? 'Made from the name' : 'Cannot change after publishing'), field('Date', text(d, 'date', { type: 'date' })),
      field('Status', select(d, 'status', Object.entries(STATUS).map(([k, v]) => [k, v.label])))),
    field('One-paragraph summary', area(d, 'summary', 'What this iteration is and what it set out to do.')));

  const specs = section('2. Key numbers', 'length, mass, apogee…', false,
    h('p.faint', 'Use the same names in every iteration and the project page charts them automatically.'),
    rows(d.specs, { label: '', value: '', unit: '' }, (r) => h('div.frow', field('Name', text(r, 'label', { placeholder: 'Apogee' })), field('Value', text(r, 'value', { placeholder: '412' })), field('Unit', text(r, 'unit', { placeholder: 'm' }))), 'Add a number', (r) => r.label || 'New number'));

  // 3D model
  const modelList = h('div.chips');
  const drawModels = () => modelList.replaceChildren(...d.model.models.map((m, i) => h('span.chip', m.placeholder ? `sample ${m.placeholder} section` : m.file,
    h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => { if (m.file) S.uploads.delete(m.file); d.model.models.splice(i, 1); drawModels(); } }, '×'))));
  drawModels();
  const partsBox = rows(d.parts, { match: '', material: '', process: '', mass_g: null, change: 'unchanged', changeNote: '', description: '' }, (r) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div.frow', field('Part name in the CAD file', text(r, 'match', { placeholder: 'Nose cone' }), 'Must match the CAD name. * matches anything, e.g. Fin*'), field('Material', text(r, 'material', { placeholder: 'PETG' })),
      field('Made by', text(r, 'process', { placeholder: '3D printed' })), field('Mass each (g)', text(r, 'mass_g', { type: 'number' }))),
    h('div.frow', field('Compared with the last iteration', select(r, 'change', [['unchanged', 'Unchanged'], ['changed', 'Changed'], ['new', 'New part']])), field('What changed (if anything)', text(r, 'changeNote', { placeholder: 'Thicker walls, +6 g' }))),
    field('What this part does', area(r, 'description'))), 'Add a part', (r) => r.match || 'New part');
  const detect = async (files) => {
    for (const f of files) {
      try {
        toast(`Reading ${f.name}…`);
        const names = await partNamesFromFile(f);
        let added = 0;
        for (const n of names) if (!d.parts.some((x) => x.match.toLowerCase().replace(/\*/g, '') === n.toLowerCase())) { d.parts.push({ match: n, material: '', process: '', mass_g: null, change: S.isNew && p.iters.length ? 'new' : 'unchanged', changeNote: '', description: '' }); added++; }
        toast(`${f.name}: ${names.length} parts found, ${added} added to the parts list.`, 'ok');
      } catch (e) { toast(`${f.name} could not be read: ${e.message}`, 'error', 8000); }
    }
    partsBox.redraw();
  };
  const model = section('3. 3D model', 'your CAD export', false,
    h('p.faint', `Export one STEP file of the whole rocket from Fusion 360 or SolidWorks and drop it here. Also accepted: ${supportedModelExt().join(', ')}. Dropping a new file replaces the models listed below.`),
    fileButton('Drop your CAD export here, or click to choose', supportedModelExt().map((e) => '.' + e).join(','), true, (files) => {
      const ok = files.filter((f) => supportedModelExt().includes(fileExt(f.name)));
      if (!ok.length) return toast('That file type cannot be shown in 3D. Export it as STEP (.step).', 'error', 8000);
      d.model.models = d.model.models.filter((m) => m.file && S.uploads.has(m.file));
      for (const f of ok) { const u = addUpload(f, 'cad'); d.model.models.push({ file: u.path }); if (!d.files.some((x) => x.path === u.path)) d.files.push({ path: u.path, label: f.name, kind: 'cad' }); }
      drawModels(); filesBox.redraw(); detect(ok);
    }),
    modelList,
    h('div.frow', field('Centre of pressure (mm from the nose tip)', text(d.model.stability, 'cp_mm', { type: 'number' }), 'From OpenRocket or your own calculation. Leave empty to hide the marker.'),
      field('Outside diameter (mm)', text(d.model, 'diameter_mm', { type: 'number' }), 'Optional. Measured from the model if left empty.')));
  const parts = section('4. Parts', 'what each part is', false, h('p.faint', 'One entry per part. Parts dropped in above are added here automatically; fill in the details people see when they click the part.'), partsBox);

  const changes = section("5. What's new and why it's better", 'the story of this iteration', false,
    rows(d.changes, () => ({ title: '', part: '', detail: '', why: '', fixes: [] }), (r) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div.frow', field('Change', text(r, 'title', { placeholder: 'Larger fins' })), field('Part it is about (optional)', text(r, 'part', { placeholder: 'Fin' }), 'The camera flies to this part')),
      field('What changed', area(r, 'detail')), field('Why it is better', area(r, 'why')),
      todos.length ? h('div.checks', h('span.faint', 'Which earlier failures does this fix?'), todos.map((t) => { const c = h('input', { type: 'checkbox', checked: (r.fixes || []).includes(t.ref) }); c.addEventListener('change', () => { r.fixes = (r.fixes || []).filter((x) => x !== t.ref); if (c.checked) r.fixes.push(t.ref); }); return h('label', c, t.label); })) : null), 'Add a change', (r) => r.title || 'New change'));

  const photosFor = (r, redraw) => h('div', fileButton('Add photos', 'image/*', true, (files) => { r.photos ||= []; for (const f of files) r.photos.push(addUpload(f, 'image').path); redraw(); }),
    h('div.chips', { style: { marginTop: '8px' } }, (r.photos || []).map((ph, i) => h('span.chip', fileName(ph), h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => { r.photos.splice(i, 1); redraw(); } }, '×')))));
  const build = section('6. Build log', 'dated entries with photos', false,
    rows(d.buildLog, () => ({ date: new Date().toISOString().slice(0, 10), title: '', text: '', photos: [] }), (r, redraw) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div.frow', field('Date', text(r, 'date', { type: 'date' })), field('Title', text(r, 'title', { placeholder: 'Fins bonded' }))), field('What you did', area(r, 'text')), photosFor(r, redraw)), 'Add a log entry', (r) => r.title || 'New entry'));

  const flights = section('7. Flights', 'results and data', false,
    rows(d.flights, () => ({ date: new Date().toISOString().slice(0, 10), title: `Flight ${d.flights.length + 1}`, outcome: 'success', apogee_m: null, notes: '', video: '', data: '' }), (r, redraw) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div.frow', field('Date', text(r, 'date', { type: 'date' })), field('Title', text(r, 'title')), field('Outcome', select(r, 'outcome', Object.entries(OUTCOME).map(([k, v]) => [k, v.label]))), field('Apogee (m)', text(r, 'apogee_m', { type: 'number' }))),
      field('What happened', area(r, 'notes')), field('Video link (optional)', text(r, 'video', { placeholder: 'https://youtu.be/…' })),
      fileButton(r.data ? `Flight data: ${fileName(r.data)} (click to replace)` : 'Add flight data (.csv with a time column and an altitude column)', '.csv', false, (files) => { r.data = addUpload(files[0], 'data').path; if (!d.files.some((x) => x.path === r.data)) d.files.push({ path: r.data, label: `${r.title} data`, kind: 'data' }); redraw(); filesBox.redraw(); })), 'Add a flight', (r) => r.title || 'Flight'));

  const todoArea = h('textarea', { placeholder: 'One problem per line, for example:\nDetect apogee with two sensors\nStrengthen the fin roots' });
  todoArea.value = d.failure.todo.map((t) => t.text).join('\n');
  todoArea.addEventListener('input', () => {
    const old = d.failure.todo;
    let n = old.reduce((m, t) => Math.max(m, parseInt(String(t.id).slice(1), 10) || 0), 0);
    d.failure.todo = todoArea.value.split('\n').map((line, i) => ({ id: old[i] ? old[i].id : `f${++n}`, text: line.trim() }));
  });
  const failure = section('8. Failure report', 'only if it failed', false,
    h('p.faint', 'Fill this in when a flight fails. The "to solve" list is carried into the next iteration, where you tick off what you fixed.'),
    field('What failed', area(d.failure, 'what')), field('Root cause', area(d.failure, 'rootCause')), field('Evidence', area(d.failure, 'evidence')),
    field('What the next iteration needs to solve', todoArea, 'One per line. Keep the order the same if you edit later, so earlier fixes stay linked.'));

  const filesBox = rows(d.files, { path: '', label: '', kind: 'other' }, (r) => h('div.frow', field('File', h('input', { value: r.path, disabled: true })), field('Label', text(r, 'label')),
    field('Type', select(r, 'kind', [['cad', 'CAD'], ['code', 'Code'], ['data', 'Data'], ['doc', 'Document'], ['image', 'Image'], ['other', 'Other']]))), 'Add an empty row', (r) => fileName(r.path) || 'File');
  const files = section('9. Files', 'CAD, code, documents', false,
    fileButton('Drop any files here: CAD, code, documents, data', null, true, (fs) => { for (const f of fs) { const u = addUpload(f); if (!d.files.some((x) => x.path === u.path)) d.files.push({ path: u.path, label: f.name, kind: u.kind }); } filesBox.redraw(); }), filesBox);

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, basics, specs, model, parts, changes, build, flights, failure, files);
}

function projectForm(d, isNew) {
  const idField = text(d, 'id');
  idField.disabled = !isNew;
  const goals = h('textarea', { placeholder: 'One goal per line' });
  goals.value = (d.goals || []).join('\n');
  goals.addEventListener('input', () => { d.goals = goals.value.split('\n').map((x) => x.trim()).filter(Boolean); });
  return section(isNew ? 'New rocket project' : 'Project details', '', true,
    h('div.frow', field('Project name', text(d, 'name', { placeholder: 'Thrust vector lander', oninput: (v) => { if (isNew) { d.id = slug(v); idField.value = d.id; } } })), field('Folder name', idField, isNew ? 'Made from the name' : 'Cannot change after publishing')),
    field('One-line description', text(d, 'tagline', { placeholder: 'What this rocket is for, in one sentence.' })),
    field('Purpose', area(d, 'purpose', 'Why this rocket exists and what it is meant to prove.')), field('Goals', goals));
}

function siteForm(d) {
  // Same shape as data/site.json: title, owner {name, headline, bio[], links[]}, about (text for "About this site").
  if (!d.owner || typeof d.owner !== 'object') d.owner = { name: typeof d.owner === 'string' ? d.owner : '' };
  d.owner.bio = Array.isArray(d.owner.bio) ? d.owner.bio : [];
  d.owner.links = Array.isArray(d.owner.links) ? d.owner.links : [];
  if (typeof d.about !== 'string') d.about = '';
  const bio = h('textarea', { placeholder: 'A few sentences about you.' });
  bio.value = d.owner.bio.join('\n\n');
  bio.addEventListener('input', () => { d.owner.bio = bio.value.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean); });
  return section('Site name and About page', '', true,
    h('div.frow', field('Site name', text(d, 'title', { placeholder: 'Rocket logbook' }), 'Shown top left and in the browser tab'), field('Your name', text(d.owner, 'name'), 'Heading of the About page')),
    field('Headline', text(d.owner, 'headline', { placeholder: 'MEng Aerospace Engineering student at the University of Sheffield.' }), 'One line under your name'),
    field('About you', bio, 'Leave an empty line between paragraphs.'),
    h('div', h('p', { style: { fontSize: '13px', fontWeight: 500, color: 'var(--muted)', margin: '4px 0 8px' } }, 'Links (CV, LinkedIn, GitHub, email)'),
      rows(d.owner.links, { label: '', url: '' }, (r) => h('div.frow', field('Label', text(r, 'label', { placeholder: 'LinkedIn' })), field('Address', text(r, 'url', { placeholder: 'https://' }))), 'Add a link', (r) => r.label || 'Link')),
    field('About this site', area(d, 'about', 'What the site is and how it is organised.'), 'Shown under "About this site" at the bottom of the About page'));
}

// ---------------------------------------------------------------- collecting and publishing
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj, null, 2) + '\n');
async function fresh(path, fallback) {
  if (gh.connected(settings)) { try { const j = await gh.readJSON(settings, path); if (j) return j; } catch (e) { console.warn(e); } }
  return JSON.parse(JSON.stringify(fallback));
}
const rawProject = (p) => { const c = JSON.parse(JSON.stringify(p)); delete c.iters; delete c.id; c.iterations = p.iters ? p.iters.map((x) => x.id) : c.iterations || []; return c; };

async function collect() {
  const files = [], deletions = [];
  let message = '', goto = '#/';
  if (S.mode === 'iteration') {
    const d = S.draft, p = project(S.pid);
    if (!d.name || !d.id) throw new Error('Give the iteration a name first.');
    if (S.isNew && p.iters.some((x) => x.id === d.id)) throw new Error(`${p.name} already has an iteration with the folder name "${d.id}". Choose another name.`);
    const base = `data/projects/${S.pid}/${d.id}/`;
    const clean = cleanIteration(d);
    const used = JSON.stringify(clean);
    files.push({ path: base + 'iteration.json', bytes: enc(clean) });
    for (const [path, file] of S.uploads) if (used.includes(path)) files.push({ path: base + path, bytes: new Uint8Array(await file.arrayBuffer()) });
    if (S.isNew) {
      const pj = await fresh(`data/projects/${S.pid}/project.json`, rawProject(p));
      pj.iterations = [...new Set([...(pj.iterations || []), d.id])];
      files.push({ path: `data/projects/${S.pid}/project.json`, bytes: enc(pj) });
    }
    message = `${S.isNew ? 'Add' : 'Update'} ${p.name} ${d.name}`; goto = `#/p/${S.pid}/${d.id}`;
  } else if (S.mode === 'project') {
    const d = S.projDraft;
    if (!d.name || !d.id) throw new Error('Give the project a name first.');
    if (S.isNew && project(d.id)) throw new Error(`A project with the folder name "${d.id}" already exists.`);
    const pj = S.isNew ? { iterations: [] } : await fresh(`data/projects/${d.id}/project.json`, rawProject(project(d.id)));
    Object.assign(pj, { name: d.name, tagline: d.tagline || '', purpose: d.purpose || '', goals: d.goals || [] });
    files.push({ path: `data/projects/${d.id}/project.json`, bytes: enc(pj) });
    if (S.isNew) { const site = await fresh('data/site.json', rawSite()); site.projects = [...new Set([...(site.projects || []), d.id])]; files.push({ path: 'data/site.json', bytes: enc(site) }); }
    message = `${S.isNew ? 'Add' : 'Update'} project ${d.name}`; goto = `#/p/${d.id}`;
  } else if (S.mode === 'site') {
    const site = await fresh('data/site.json', rawSite());
    const sd = S.siteDraft;
    if (!String(sd.title || '').trim()) throw new Error('Give the site a name first.');
    Object.assign(site, { title: sd.title.trim(), owner: { ...sd.owner, links: sd.owner.links.filter((l) => l.label && l.url) }, about: sd.about });
    files.push({ path: 'data/site.json', bytes: enc(site) }); message = 'Update site details'; goto = '#/about';
  } else if (S.mode === 'remove') {
    const p = project(S.pid);
    if (!gh.connected(settings)) throw new Error('Removing a project needs the GitHub connection. Without it, delete the project folder on GitHub and remove its line from data/site.json (the guide shows how).');
    const site = await fresh('data/site.json', rawSite());
    site.projects = (site.projects || []).filter((x) => x !== S.pid);
    files.push({ path: 'data/site.json', bytes: enc(site) });
    deletions.push(...await gh.listPaths(settings, `data/projects/${S.pid}/`));
    message = `Remove project ${p.name}`;
  } else throw new Error('Choose what you want to do first.');
  return { files, deletions, message, goto };
}
const rawSite = () => JSON.parse(JSON.stringify(store.site));

async function publish(msgEl, btns) {
  btns.forEach((b) => { b.disabled = true; });
  try {
    if (!gh.connected(settings)) throw new Error('Fill in "Publish settings" first (once), or use "Download as a folder" instead.');
    const out = await collect();
    const total = out.files.reduce((n, f) => n + f.bytes.length, 0);
    msgEl.textContent = `Publishing ${out.files.length} files (${fmtBytes(total)})…`;
    await gh.commit(settings, out.files, out.deletions, out.message, (m) => { msgEl.textContent = m; });
    msgEl.textContent = 'Published. GitHub takes about a minute to update the live site; refresh the page after that.';
    toast('Published to GitHub. The live site updates in about a minute.', 'ok', 9000);
    S.uploads.clear();
  } catch (e) { msgEl.textContent = e.message; toast(e.message, 'error', 9000); }
  btns.forEach((b) => { b.disabled = false; });
}

async function download(msgEl) {
  try {
    const out = await collect();
    const blob = makeZip(out.files);
    const a = h('a', { href: URL.createObjectURL(blob), download: `rocket-logbook-update-${new Date().toISOString().slice(0, 10)}.zip` });
    document.body.appendChild(a); a.click(); a.remove();
    msgEl.textContent = 'Downloaded. Unzip it, then drag the "data" folder onto your repository page on GitHub (Add file → Upload files) and commit.';
  } catch (e) { msgEl.textContent = e.message; toast(e.message, 'error', 9000); }
}

// ---------------------------------------------------------------- page
function draw() {
  const form = h('div');
  const pickProject = (onPick) => h('div.frow', field('Project', h('select', { onchange: (e) => onPick(e.target.value) }, h('option', { value: '' }, 'Choose a project'), store.projects.map((p) => h('option', { value: p.id, selected: p.id === S.pid }, p.name)))));
  const start = (mode, isNew) => { Object.assign(S, { mode, isNew, pid: null, iid: null, draft: null, projDraft: null, siteDraft: null }); S.uploads.clear(); drawForm(); };
  const drawForm = () => {
    $$('.mode-btn', root).forEach((b) => b.classList.toggle('on', b.dataset.mode === `${S.mode}${S.isNew ? '-new' : ''}`));
    if (!S.mode) return form.replaceChildren();
    if (S.mode === 'project' && S.isNew) { S.projDraft ||= { id: '', name: '', tagline: '', purpose: '', goals: [] }; return form.replaceChildren(projectForm(S.projDraft, true)); }
    if (S.mode === 'site') { S.siteDraft ||= rawSite(); return form.replaceChildren(siteForm(S.siteDraft)); }
    const picker = pickProject((pid) => { S.pid = pid || null; S.iid = null; S.draft = null; S.projDraft = null; S.uploads.clear(); drawForm(); });
    const p = S.pid ? project(S.pid) : null;
    if (!p) return form.replaceChildren(section('Choose the project', '', true, picker));
    if (S.mode === 'project') { S.projDraft ||= { id: p.id, name: p.name, tagline: p.tagline || '', purpose: p.purpose || '', goals: [...p.goals] }; return form.replaceChildren(section('Choose the project', '', true, picker), projectForm(S.projDraft, false)); }
    if (S.mode === 'remove') return form.replaceChildren(section('Remove a project', '', true, picker, h('p', `This deletes "${p.name}" and all ${p.iters.length} of its iterations from the site when you press Publish. It cannot be undone from here.`)));
    if (S.isNew) { S.draft ||= blankIteration(p); return form.replaceChildren(section('Choose the project', '', true, picker, p.iters.length ? h('p.faint', `Starting from ${latest(p).name}: its numbers, parts and model are copied in so you only change what is different.`) : null), iterationForm(p, S.draft)); }
    const iterPick = h('div.frow', field('Iteration', h('select', { onchange: (e) => { S.iid = e.target.value || null; S.draft = null; S.uploads.clear(); drawForm(); } }, h('option', { value: '' }, 'Choose an iteration'), p.iters.map((x) => h('option', { value: x.id, selected: x.id === S.iid }, x.name)))));
    const it = S.iid ? p.iters.find((x) => x.id === S.iid) : null;
    if (!it) return form.replaceChildren(section('Choose the iteration', '', true, picker, iterPick));
    S.draft ||= cloneIteration(it);
    form.replaceChildren(section('Choose the iteration', '', true, picker, iterPick), iterationForm(p, S.draft));
  };

  const modeBtn = (label, mode, isNew, note) => h('button.card.mode-btn', { type: 'button', 'data-mode': `${mode}${isNew ? '-new' : ''}`, style: { textAlign: 'left' }, onclick: () => start(mode, isNew) }, h('h3', label), h('p.faint', { style: { fontSize: '13px', marginTop: '4px' } }, note));
  const msg = h('span.msg', 'Nothing is saved until you publish or download.');
  const pubBtn = h('button.btn.primary', { type: 'button' }, 'Publish to GitHub');
  const dlBtn = h('button.btn', { type: 'button' }, 'Download as a folder');
  pubBtn.onclick = () => publish(msg, [pubBtn, dlBtn]);
  dlBtn.onclick = () => download(msg);

  const testMsg = h('span.faint');
  const conn = section('Publish settings', gh.connected(settings) ? `connected to ${settings.owner}/${settings.repo}` : 'set up once', !gh.connected(settings),
    h('p.faint', 'These let the Builder save straight to your GitHub repository. The access key stays in this browser only and is never put on the site. The guide explains how to create one.'),
    h('div.frow', field('GitHub username', text(settings, 'owner')), field('Repository', text(settings, 'repo')), field('Branch', text(settings, 'branch')), field('Access key', text(settings, 'token', { type: 'password', placeholder: 'github_pat_…' }))),
    h('div.actions', h('button.btn.small', { type: 'button', onclick: async () => { gh.saveSettings(settings); testMsg.textContent = 'Checking…'; try { await gh.testConnection(settings); testMsg.textContent = 'Connected. You can publish.'; } catch (e) { testMsg.textContent = e.message; } } }, 'Save and test'),
      h('button.btn.small', { type: 'button', onclick: () => { settings.token = ''; gh.saveSettings(settings); testMsg.textContent = 'Access key removed from this browser.'; draw(); } }, 'Forget the key'), link('#/guide', 'How to get an access key')), testMsg);

  root.replaceChildren(h('div.builder',
    h('div.eyebrow.in', 'Builder'), h('h1.in', { style: { '--i': 1, fontSize: 'clamp(30px, 4vw, 46px)' } }, 'Add to the logbook'),
    h('p.lede.in', { style: { '--i': 2 } }, 'Fill in a form, drop in your files and publish. No code to edit.'),
    h('p.faint.in', { style: { '--i': 3 } }, 'Only you see the Builder links, because you have opened this page in this browser. Visitors never see them, and nothing can be published without your access key. ',
      h('button.btn.small', { type: 'button', onclick: () => { try { localStorage.removeItem('rocket-logbook-owner'); } catch (e) { /* ignore */ } document.getElementById('ownerLinks').hidden = true; toast('Builder links hidden in this browser. Visit /#/builder to bring them back.', 'ok', 7000); } }, 'Hide the links in this browser')),
    conn,
    h('div.grid', modeBtn('New iteration', 'iteration', true, 'Upload the next Mk of an existing rocket'), modeBtn('Update an iteration', 'iteration', false, 'Log a flight, a failure or more build notes'),
      modeBtn('New rocket project', 'project', true, 'Start a new section of the site'), modeBtn('Edit project details', 'project', false, 'Name, purpose and goals'),
      modeBtn('Site name and About', 'site', false, 'Your details and links'), modeBtn('Remove a project', 'remove', false, 'For example the sample project')),
    form,
    h('div.publish-bar.glass', pubBtn, dlBtn, msg)));
  drawForm();
}
const link = (href, label) => h('a', { href, style: { color: 'var(--accent)', textDecoration: 'underline', alignSelf: 'center', fontSize: '14px' } }, label);

export function mountBuilder(node, h2) {
  root = node; hooks = h2;
  settings = gh.loadSettings(store.site.github || {});
  draw();
}
