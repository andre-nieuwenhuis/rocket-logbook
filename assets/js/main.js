// Router, pages, transitions, search. Data comes from store.js, the 3D rocket from stage.js.
import { $, $$, h, fill, esc, fmtNum, fmtDate, toast, countUp, watchReveals, reducedMotion, markdown, highlight, parseCsv, lineChart, barChart, extOf, baseOf } from './util.js';
import { store, loadAll, getProject, getIteration, latest, previous, next, filePath, statusOf, OUTCOME, todoStatus, fixesOf, totalMass, searchIndex } from './store.js';
import { stage } from './stage.js';

const view = $('#view');
let cleanup = [];          // functions to run when leaving the current page
let modelCtx = null;       // set while the model tab is open

// ------------------------------------------------------------------ small view helpers
const statusTag = (it) => { const s = statusOf(it); return h(`span.tag${s.cls ? '.' + s.cls : ''}`, s.label); };
// Owner mode: the Builder and guide links only show in a browser where the Builder has been opened.
// Visitors never see them. (Publishing also needs the GitHub access key, which only the owner has.)
const OWNER_KEY = 'rocket-logbook-owner';
export function isOwner() { try { return localStorage.getItem(OWNER_KEY) === '1'; } catch (e) { return false; } }
export function setOwner(on) { try { if (on) localStorage.setItem(OWNER_KEY, '1'); else localStorage.removeItem(OWNER_KEY); } catch (e) { /* private mode */ } syncOwner(); }
function syncOwner() { $('#ownerLinks').hidden = !isOwner(); }
const sampleBanner = (p) => (p && p.sample ? h('div.sample-banner', h('span.tag.plain', 'Sample data'), 'This project is an example that shows how the site works.', isOwner() ? h('a', { href: '#/guide' }, 'How to replace it') : null) : null);
const crumbs = (...items) => h('nav.crumbs', { 'aria-label': 'Breadcrumb' }, items.flatMap((it, i) => [i ? h('span', { 'aria-hidden': 'true' }, '/') : null, it.href ? h('a', { href: it.href }, it.text) : h('span', { 'aria-current': 'page' }, it.text)]));
const stagger = (el) => { [...el.children].forEach((c, i) => c.style.setProperty('--i', i)); el.classList.add('in'); return el; };
function statCard(label, value, unit, delta) {
  const numeric = value !== '' && value !== null && Number.isFinite(Number(value));
  return h('div.stat', h('div.k', label),
    h('div.v', numeric ? h('span', { 'data-count': String(value) }, fmtNum(value)) : String(value ?? '–'), unit ? h('small', unit) : null),
    delta ? h(`div.d.${delta.cls}`, delta.text) : null);
}
function specDelta(it, prev, s) {
  if (!prev) return null;
  const o = prev.specs.find((x) => x.label.toLowerCase() === s.label.toLowerCase());
  const a = Number(o?.value), b = Number(s.value);
  if (!o || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = b - a;
  if (Math.abs(d) < 1e-9) return { cls: 'flat', text: `same as ${prev.name}` };
  return { cls: 'flat', text: `${d > 0 ? '+' : '−'}${fmtNum(Math.abs(d))} vs ${prev.name}` };
}
function lineage(p, currentIt) {
  const el = h('div.lineage', { 'aria-label': 'Iterations' });
  p.iterations.forEach((it, i) => {
    if (i) el.append(h('span.link', { style: { '--i': i }, 'aria-hidden': 'true' }));
    const s = statusOf(it);
    el.append(h(`a${it === currentIt ? '.on' : ''}`, { href: `#/p/${p.id}/${it.id}`, title: `${it.name}: ${s.label}` }, h(`span.dot${s.cls ? '.' + s.cls : ''}`), it.name));
  });
  return el;
}
function lightbox(src, alt) {
  const lb = h('div.lightbox', { onclick: () => lb.remove(), role: 'dialog', 'aria-label': alt || 'Photo' }, h('img', { src, alt: alt || '' }));
  document.body.append(lb);
}

// ------------------------------------------------------------------ pages
function homePage() {
  const p = store.projects[0];
  if (!p) {
    stage.pose('quiet');
    return h('div.prose', h('h1', 'No projects yet'), h('p', 'Open the ', h('a', { href: '#/builder' }, 'Builder'), ' to add your first rocket project, or read the ', h('a', { href: '#/guide' }, 'guide'), '.'));
  }
  const it = latest(p);
  stage.pose('home');
  if (it) stage.show(p, it);
  const change = it?.changes[0];
  const fx = change ? fixesOf(p, change) : [];
  const hero = h('section.hero',
    stagger(h('div.hero-left',
      h('div.row', h('span.eyebrow', `Project ${String(1).padStart(2, '0')}`), p.sample ? h('span.tag.plain', 'Sample data') : null),
      h('h1', { style: { viewTransitionName: 'hero-title' } }, p.name),
      h('p.lede', p.tagline || p.purpose || ''),
      h('div.row', it ? h('a.btn.primary', { href: `#/p/${p.id}/${it.id}` }, `Explore ${it.name}`) : null, h('a.btn', { href: `#/p/${p.id}` }, 'Lineage')))),
    stagger(h('div.hero-right',
      change ? h('a.glass.stack', { href: `#/p/${p.id}/${it.id}/new` },
        h('div.row', { style: { justifyContent: 'space-between' } }, h('span.eyebrow', change.part || 'Latest change'), h('span.faint.mono', { style: { fontSize: '11px' } }, `NEW IN ${it.name.toUpperCase()}`)),
        h('div', change.title),
        fx.length ? h('div.muted', { style: { fontSize: '13px' } }, `Fixes ${fx[0].iteration.name} failure: ${fx[0].todo.text}`) : null) : null,
      it && it.specs.length ? h('div.stats', it.specs.slice(0, 3).map((s) => statCard(s.label, s.value, s.unit))) : null)),
    h('div.scroll-cue', { 'aria-hidden': 'true' }, 'SCROLL'));
  const all = h('section.section.wide',
    h('div.section-head.reveal', h('h2', 'All projects')),
    h('div.grid', store.projects.map((pr) => {
      const l = latest(pr);
      return h('a.card.pcard.reveal', { href: `#/p/${pr.id}` },
        h('div.top', h('h3', pr.name), l ? statusTag(l) : null),
        h('p.muted', { style: { fontSize: '14px' } }, pr.tagline || ''),
        h('div.mk', pr.sample ? h('span.tag.plain', 'Sample') : null, `${pr.iterations.length} iteration${pr.iterations.length === 1 ? '' : 's'}`, l ? ` · latest ${l.name}` : ''));
    })));
  return h('div', hero, all);
}

function projectPage(pid) {
  const p = getProject(pid);
  if (!p) return notFound();
  const it = latest(p);
  stage.pose('project');
  if (it) stage.show(p, it);
  const flights = p.iterations.reduce((n, i) => n + i.flights.length, 0);
  const open = p.iterations.reduce((n, i) => n + todoStatus(p, i).filter((t) => !t.fixedIn).length, 0);
  const col = stagger(h('div.col',
    crumbs({ text: 'Projects', href: '#/' }, { text: p.name }),
    sampleBanner(p),
    h('span.eyebrow', p.status || 'Project'),
    h('h1', { style: { viewTransitionName: 'hero-title' } }, p.name),
    h('p.lede', p.purpose || p.tagline || ''),
    (p.goals || []).length ? h('div.glass.stack', h('h3', 'Goals'), h('ul', { style: { margin: 0, paddingLeft: '20px' } }, p.goals.map((g) => h('li.muted', g)))) : null,
    h('div.stats', statCard('Iterations', p.iterations.length), statCard('Flights', flights), statCard('Open issues', open)),
    it ? h('div.row', h('a.btn.primary', { href: `#/p/${p.id}/${it.id}` }, `Open ${it.name}`), p.iterations.length > 1 ? h('a.btn', { href: `#/compare/${p.id}/${p.iterations[p.iterations.length - 2].id}/${it.id}` }, 'Compare last two') : null) : null));

  const tl = h('div.timeline');
  [...p.iterations].reverse().forEach((i) => {
    const s = statusOf(i), prev = previous(p, i);
    tl.append(h(`a.tl-item${s.cls === 'bad' ? '.bad' : s.cls === 'good' ? '.good' : ''}.reveal`, { href: `#/p/${p.id}/${i.id}`, style: { display: 'block' } },
      h('div.card.stack',
        h('div.row', { style: { justifyContent: 'space-between' } }, h('h3', i.name), statusTag(i)),
        h('div.tl-date', fmtDate(i.date)),
        h('p.muted', { style: { fontSize: '14px' } }, i.summary || ''),
        h('div.row', i.changes.length ? h('span.tag.accent.plain', `${i.changes.length} change${i.changes.length === 1 ? '' : 's'}${prev ? ' from ' + prev.name : ''}`) : null,
          i.failure ? h('span.tag.bad.plain', `Failure: ${i.failure.title || 'see report'}`) : null))));
  });

  const labels = [...new Set(p.iterations.flatMap((i) => i.specs.filter((s) => Number.isFinite(Number(s.value)) && s.value !== '').map((s) => s.label)))];
  const trends = labels.map((label) => {
    const pts = p.iterations.map((i) => ({ i, s: i.specs.find((s) => s.label === label) })).filter((x) => x.s && Number.isFinite(Number(x.s.value)));
    if (pts.length < 2) return null;
    return h('div.card.reveal', h('div.stat', { style: { background: 'none', border: 'none', padding: 0 } }, h('div.k', `${label}${pts[0].s.unit ? ' (' + pts[0].s.unit + ')' : ''}`)),
      barChart(pts.map((x, k) => ({ label: x.i.name, value: Number(x.s.value), current: k === pts.length - 1 })), { unit: pts[0].s.unit || '' }));
  }).filter(Boolean);

  return h('div', col,
    h('section.section', { style: { maxWidth: 'min(42vw, 560px)' } }, h('div.section-head.reveal', h('h2', 'Lineage'), h('span.faint', 'Newest first')), tl),
    trends.length ? h('section.section.wide', h('div.section-head.reveal', h('h2', 'How the numbers moved')), h('div.grid', trends)) : null);
}

const TABS = [['overview', 'Overview'], ['model', '3D model'], ['new', "What's new"], ['build', 'Build log'], ['flights', 'Flights'], ['failure', 'Failure report'], ['files', 'Files']];

function iterationPage(pid, iid, tab = 'overview', query = {}) {
  const p = getProject(pid), it = getIteration(pid, iid);
  if (!p || !it) return notFound();
  if (!TABS.some((t) => t[0] === tab)) tab = 'overview';
  const prev = previous(p, it), nxt = next(p, it);
  stage.pose(tab === 'model' ? 'model' : 'iteration');
  stage.show(p, it);
  const counts = { new: it.changes.length, build: it.buildLog.length, flights: it.flights.length, files: it.files.length, failure: it.failure ? todoStatus(p, it).filter((t) => !t.fixedIn).length : 0 };
  const head = h('div.iter-head.pe',
    crumbs({ text: 'Projects', href: '#/' }, { text: p.name, href: `#/p/${p.id}` }, { text: it.name }),
    h('div.iter-title', h('h1', { style: { viewTransitionName: 'hero-title' } }, `${p.name} · ${it.name}`), statusTag(it), it.date ? h('span.faint.mono', { style: { fontSize: '12px' } }, fmtDate(it.date)) : null, p.sample ? h('span.tag.plain', 'Sample data') : null),
    lineage(p, it),
    h('nav.tabs', { 'aria-label': 'Sections' }, TABS.map(([id, label]) => h(`a${id === tab ? '.on' : ''}`, { href: `#/p/${p.id}/${it.id}${id === 'overview' ? '' : '/' + id}`, 'aria-current': id === tab ? 'page' : null }, label, counts[id] ? h('span.count', counts[id]) : null))));

  let body;
  if (tab === 'model') body = modelTab(p, it, prev, query);
  else {
    const inner = { overview: overviewTab, new: newTab, build: buildTab, flights: flightsTab, failure: failureTab, files: filesTab }[tab](p, it, prev, nxt);
    body = stagger(h('div.col', inner,
      h('div.row', { style: { marginTop: '10px' } }, prev ? h('a.btn.small', { href: `#/p/${p.id}/${prev.id}` }, `← ${prev.name}`) : null, nxt ? h('a.btn.small', { href: `#/p/${p.id}/${nxt.id}` }, `${nxt.name} →`) : null)));
  }
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    if (e.key === '[' && prev) location.hash = `#/p/${p.id}/${prev.id}`;
    if (e.key === ']' && nxt) location.hash = `#/p/${p.id}/${nxt.id}`;
  };
  window.addEventListener('keydown', onKey);
  cleanup.push(() => window.removeEventListener('keydown', onKey));
  return h('div', head, body);
}

function overviewTab(p, it, prev) {
  const todos = todoStatus(p, it);
  return [
    h('p.lede', it.summary || ''),
    it.specs.length ? h('div.stats', it.specs.map((s) => statCard(s.label, s.value, s.unit, specDelta(it, prev, s)))) : h('div.empty', 'No specifications entered yet.'),
    h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' } },
      h('a.card.stack', { href: `#/p/${p.id}/${it.id}/model` }, h('span.eyebrow', '3D model'), h('div', `${it.parts.length} documented part${it.parts.length === 1 ? '' : 's'}`), h('span.muted', { style: { fontSize: '13px' } }, 'Explode it, cut it open, click any part')),
      h('a.card.stack', { href: `#/p/${p.id}/${it.id}/new` }, h('span.eyebrow', "What's new"), h('div', it.changes.length ? `${it.changes.length} change${it.changes.length === 1 ? '' : 's'}${prev ? ' from ' + prev.name : ''}` : 'First iteration'), it.changes[0] ? h('span.muted', { style: { fontSize: '13px' } }, it.changes[0].title) : null),
      it.failure ? h('a.card.stack', { href: `#/p/${p.id}/${it.id}/failure` }, h('span.eyebrow', { style: { color: 'var(--bad)' } }, 'Failure report'), h('div', it.failure.title || 'Failure recorded'), h('span.muted', { style: { fontSize: '13px' } }, `${todos.filter((t) => t.fixedIn).length} of ${todos.length} items solved since`)) : null),
  ];
}

function newTab(p, it, prev) {
  if (!it.changes.length) return [h('div.empty', prev ? `No changes from ${prev.name} recorded yet.` : 'This is the first iteration, so there is nothing to compare it with.')];
  const cards = it.changes.map((c, i) => {
    const fx = fixesOf(p, c);
    return h('article.card.change.reveal', { 'data-part': c.part || '' },
      h('div.row', h('span.mono.faint', { style: { fontSize: '12px' } }, String(i + 1).padStart(2, '0')), c.part ? h('span.tag.changed.plain', c.part) : null),
      h('h3', c.title),
      c.detail ? h('p', c.detail) : null,
      c.why ? h('p.why', h('strong', { style: { color: 'var(--text)' } }, "Why it's better: "), c.why) : null,
      fx.map((f) => h('a.fix-link', { href: `#/p/${p.id}/${f.iteration.id}/failure` }, '✓', `Fixes ${f.iteration.name}: ${f.todo.text}`)));
  });
  // As each change scrolls into the middle of the screen, the camera moves to the part it is about.
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting && e.target.dataset.part) { stage.selectLabel(e.target.dataset.part, true); }
  }, { rootMargin: '-40% 0px -40% 0px' });
  setTimeout(() => cards.forEach((c) => obs.observe(c)), 900);
  cleanup.push(() => { obs.disconnect(); stage.clearSelection(); });
  return [h('p.lede', prev ? `What changed between ${prev.name} and ${it.name}, and why each change makes it better.` : ''), ...cards];
}

function buildTab(p, it) {
  if (!it.buildLog.length) return [h('div.empty', 'No build log entries yet.')];
  return [h('div.timeline', it.buildLog.map((b) => h('div.tl-item.reveal', h('div.tl-date', fmtDate(b.date)), h('h3', b.title), b.text ? h('p.muted', { style: { fontSize: '15px' } }, b.text) : null,
    (b.photos || []).length ? h('div.photos', b.photos.map((ph) => { const src = filePath(p.id, it.id, ph); return h('img', { src, alt: `${b.title} photo`, loading: 'lazy', onclick: () => lightbox(src, b.title) }); })) : null)))];
}

function flightsTab(p, it) {
  if (!it.flights.length) return [h('div.empty', 'Not flown yet.')];
  return it.flights.map((f, i) => {
    const o = OUTCOME[f.outcome] || { label: f.outcome || 'Flight', cls: '' };
    const chartBox = h('div');
    if (f.data) {
      fetch(filePath(p.id, it.id, f.data)).then((r) => (r.ok ? r.text() : Promise.reject())).then((t) => {
        const { header, rows } = parseCsv(t);
        if (rows.length > 1) chartBox.append(lineChart(rows.map((r) => [r[0], r[1]]), { xLabel: header[0] || 'Time (s)', yLabel: header[1] || 'Altitude (m)' }), h('a.hint', { href: filePath(p.id, it.id, f.data), download: '' }, `Download ${baseOf(f.data)}`));
      }).catch(() => chartBox.append(h('p.hint', 'Flight data file could not be read.')));
    }
    return h('article.card.stack.reveal',
      h('div.row', { style: { justifyContent: 'space-between' } }, h('h3', f.title || `Flight ${i + 1}`), h(`span.tag${o.cls ? '.' + o.cls : ''}`, o.label)),
      h('div.tl-date', fmtDate(f.date)),
      f.notes ? h('p.muted', f.notes) : null,
      Number.isFinite(Number(f.apogee_m)) && f.apogee_m !== null && f.apogee_m !== '' ? h('div.stats', statCard('Apogee', f.apogee_m, 'm')) : null,
      chartBox,
      f.video ? h('a.btn.small', { href: f.video, target: '_blank', rel: 'noopener' }, 'Watch the video') : null);
  });
}

function failureTab(p, it, prev, nxt) {
  if (!it.failure) return [h('div.empty', it.flights.length ? 'No failure recorded for this iteration.' : 'Nothing has failed yet, because this iteration has not flown.')];
  const f = it.failure, todos = todoStatus(p, it);
  return [
    h('span.eyebrow', { style: { color: 'var(--bad)' } }, 'Failure report'),
    h('h2', f.title || 'What went wrong'),
    h('div.card.stack', h('dl.kv', h('dt', 'What failed'), h('dd', f.what || '–'), h('dt', 'Root cause'), h('dd', f.rootCause || '–'), f.evidence ? [h('dt', 'Evidence'), h('dd', f.evidence)] : null)),
    h('div.card', h('h3', { style: { marginBottom: '6px' } }, nxt ? 'What the next iteration had to solve' : 'To solve in the next iteration'),
      todos.length ? todos.map((t) => h(`div.todo${t.fixedIn ? '.done' : ''}`, h('span.box', { 'aria-hidden': 'true' }, t.fixedIn ? '✓' : ''),
        h('div', h('span.txt', t.text), t.fixedIn ? h('a.res', { href: `#/p/${p.id}/${t.fixedIn.id}/new` }, `Solved in ${t.fixedIn.name}: ${t.change.title}`) : h('span.res.open', 'Still open')))) : h('p.muted', 'No items listed.')),
  ];
}

const KIND_LABEL = { cad: 'CAD', code: 'Code', data: 'Data', doc: 'Documents', image: 'Images', other: 'Other files' };
const TEXT_EXT = ['ino', 'c', 'cpp', 'h', 'hpp', 'py', 'm', 'js', 'ts', 'json', 'txt', 'md', 'csv', 'yaml', 'yml', 'toml', 'ini', 'sh', 'ork', 'eng', 'xml', 'gcode'];
export function kindOf(path) {
  const e = extOf(path);
  if (['step', 'stp', 'iges', 'igs', 'stl', 'obj', 'glb', 'gltf', '3mf', 'fbx', 'sldprt', 'sldasm', 'slddrw', 'f3d', 'f3z', 'dxf', 'dwg'].includes(e)) return 'cad';
  if (['ino', 'c', 'cpp', 'h', 'hpp', 'py', 'm', 'js', 'ts', 'sh', 'json', 'yaml', 'yml', 'toml'].includes(e)) return 'code';
  if (['csv', 'tsv', 'xlsx', 'ork', 'eng', 'log'].includes(e)) return 'data';
  if (['pdf', 'md', 'txt', 'docx', 'pptx'].includes(e)) return 'doc';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(e)) return 'image';
  return 'other';
}
function filesTab(p, it) {
  if (!it.files.length) return [h('div.empty', 'No files uploaded for this iteration yet.')];
  const viewer = h('div');
  const open = async (f) => {
    const url = filePath(p.id, it.id, f.path), e = extOf(f.path);
    viewer.replaceChildren(h('p.hint', 'Loading…'));
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      const text = await r.text();
      const pre = h('pre', { html: e === 'md' ? '' : highlight(text.slice(0, 400000), e), tabindex: '0' });
      viewer.replaceChildren(h('div.codebox', h('div.bar', h('span', baseOf(f.path)), h('a', { href: url, download: '' }, 'Download')), e === 'md' ? h('div.prose', { style: { padding: '14px' }, html: markdown(text) }) : pre));
      viewer.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    } catch (err) { viewer.replaceChildren(h('p.hint', 'This file could not be opened here. Use the download link instead.')); }
  };
  const groups = {};
  for (const f of it.files) (groups[f.kind || kindOf(f.path)] ||= []).push(f);
  const out = [];
  for (const k of Object.keys(KIND_LABEL)) {
    if (!groups[k]) continue;
    out.push(h('div.stack.reveal', h('h3', KIND_LABEL[k]), h('div.files', groups[k].map((f) => {
      const url = filePath(p.id, it.id, f.path), e = extOf(f.path);
      const inner = [h('span.ext', e || 'file'), h('span.nm', f.label || baseOf(f.path)), h('span.kind', TEXT_EXT.includes(e) ? 'View' : k === 'image' ? 'Open' : 'Download')];
      if (TEXT_EXT.includes(e)) return h('button.file', { onclick: () => open(f) }, inner);
      if (k === 'image') return h('button.file', { onclick: () => lightbox(url, f.label) }, inner);
      return h('a.file', { href: url, download: '' }, inner);
    }))));
  }
  out.push(viewer);
  return out;
}

// ------------------------------------------------------------------ 3D model tab
function modelTab(p, it, prev, query) {
  const list = h('div.glass.parts-panel');
  const insp = h('div.glass.inspector');
  const measureOut = h('span.measure-out');
  const state = { xray: false, cut: false, changes: false, ghost: false, measure: false, selected: null };
  const tool = (label, key, fn) => { const b = h('button.tool', { 'aria-pressed': 'false', onclick: () => { state[key] = !state[key]; b.setAttribute('aria-pressed', String(state[key])); fn(state[key]); } }, label); return b; };
  const explode = h('input', { type: 'range', min: '0', max: '100', value: '0', id: 'explode', oninput: (e) => stage.setExplode(e.target.value / 100) });
  const assembleBtn = h('button.tool', { onclick: () => { explode.value = 0; assembleBtn.textContent = 'Assembling…'; stage.playAssembly((i, n, label) => { measureOut.textContent = `Step ${i + 1} of ${n}: ${label}`; }, () => { assembleBtn.textContent = 'Play assembly'; measureOut.textContent = ''; }); } }, 'Play assembly');
  const toolbar = h('div.glass.toolbar', { role: 'toolbar', 'aria-label': '3D view tools' },
    h('label.tool-range', { for: 'explode' }, 'Explode', explode),
    tool('Cutaway', 'cut', (v) => stage.setCutaway(v)),
    tool('X-ray', 'xray', (v) => stage.setXray(v)),
    tool('Show changes', 'changes', (v) => { stage.showChanges(v); renderList(); }),
    prev ? tool(`Ghost ${prev.name}`, 'ghost', (v) => { if (v) explode.value = 0; stage.setGhost(v ? p : null, v ? prev : null); }) : null,
    tool('Measure', 'measure', (v) => { stage.setMeasure(v); measureOut.textContent = v ? 'Click two points on the model' : ''; }),
    assembleBtn,
    h('button.tool', { onclick: () => { explode.value = 0; stage.resetView(); } }, 'Reset view'),
    measureOut);

  const infoFor = (label) => it.parts.find((x) => (x.label || x.match || '').toLowerCase() === label.toLowerCase()) || null;
  function rows() {
    if (stage.items.length && stage.key === `${p.id}/${it.id}`) return stage.items.map((x) => ({ label: x.label, qty: x.qty, info: x.info, length: x.length }));
    return it.parts.map((x) => ({ label: x.label || x.match, qty: 1, info: x }));
  }
  function renderList() {
    const rs = rows();
    fill(list, h('h3', `Parts · ${rs.length}`), rs.map((r) => {
      const c = r.info?.change;
      return h(`button.part-row${state.selected === r.label ? '.on' : ''}`, { onclick: () => { if (!stage.selectLabel(r.label)) { state.selected = r.label; renderList(); renderInspector(r); } } },
        h(`span.sw${c === 'changed' ? '.changed' : c === 'new' ? '.new' : ''}`), h('span.nm', r.label + (r.qty > 1 ? ` ×${r.qty}` : '')), Number.isFinite(Number(r.info?.mass_g)) && r.info.mass_g !== '' ? h('span.ms', `${fmtNum(r.info.mass_g)} g`) : null);
    }),
    h('div.legend', h('span', h('span.sw.changed', { style: { width: '10px', height: '10px', borderRadius: '2px', background: 'var(--changed)' } }), prev ? `Changed since ${prev.name}` : 'Changed'),
      h('span', h('span', { style: { width: '10px', height: '10px', borderRadius: '2px', background: 'var(--new)' } }), 'New part'),
      h('span', h('span', { style: { width: '10px', height: '10px', borderRadius: '2px', border: '1px solid var(--line-strong)' } }), 'Unchanged')));
  }
  function renderInspector(r) {
    if (!r) {
      const R = stage.key === `${p.id}/${it.id}` ? stage.rocket : null;
      fill(insp, h('span.eyebrow', 'Whole rocket'), h('h2', `${it.name}`),
        h('p.muted', { style: { fontSize: '14px' } }, 'Click any part, on the model or in the list, to see what it is, what it weighs and what changed.'),
        R ? h('dl.kv', h('dt', 'Length'), h('dd', `${fmtNum(R.length)} mm`), h('dt', 'Diameter'), h('dd', `${fmtNum(R.diameter)} mm`), R.totalMass ? [h('dt', 'Mass (parts)'), h('dd', `${fmtNum(R.totalMass)} g`)] : null,
          Number.isFinite(R.cg) ? [h('dt', 'Centre of gravity'), h('dd', `${fmtNum(R.cg)} mm from nose`)] : null, Number.isFinite(R.cp) ? [h('dt', 'Centre of pressure'), h('dd', `${fmtNum(R.cp)} mm from nose`)] : null,
          Number.isFinite(R.margin) ? [h('dt', 'Stability'), h('dd', `${fmtNum(R.margin, 2)} calibres`)] : null) : null,
        stage.failed ? h('p.hint', 'The 3D view could not load (it needs an internet connection the first time). The parts list still works.') : null);
      return;
    }
    const i = r.info || {}, c = i.change;
    const partFiles = (i.files || []);
    fill(insp,
      h('div.row', h('span.eyebrow', 'Selected part'), c === 'changed' ? h('span.tag.changed.plain', 'Changed') : c === 'new' ? h('span.tag.new.plain', 'New') : null),
      h('h2', r.label),
      i.description ? h('p.muted', { style: { fontSize: '14px' } }, i.description) : (r.info ? null : h('p.hint', 'No details recorded for this part yet. Add them in the Builder.')),
      h('dl.kv',
        Number.isFinite(Number(i.mass_g)) && i.mass_g !== '' ? [h('dt', 'Mass'), h('dd', `${fmtNum(i.mass_g)} g${r.qty > 1 ? ' each' : ''}`)] : null,
        r.qty > 1 ? [h('dt', 'Quantity'), h('dd', r.qty)] : null,
        i.material ? [h('dt', 'Material'), h('dd', i.material)] : null,
        i.process ? [h('dt', 'Made by'), h('dd', i.process)] : null,
        r.length ? [h('dt', 'Length'), h('dd', `${fmtNum(r.length)} mm`)] : null),
      i.changeNote ? h('div.card.stack', { style: { padding: '12px 14px' } }, h('span.faint.mono', { style: { fontSize: '11px', letterSpacing: '0.08em' } }, prev ? `WHAT CHANGED FROM ${prev.name.toUpperCase()}` : 'WHAT CHANGED'), h('div', { style: { fontSize: '14px' } }, i.changeNote)) : null,
      partFiles.length ? h('div.stack', h('span.faint.mono', { style: { fontSize: '11px', letterSpacing: '0.08em' } }, 'FILES FOR THIS PART'), h('div.files', partFiles.map((f) => h('a.file', { href: filePath(p.id, it.id, f), download: '' }, h('span.ext', extOf(f)), h('span.nm', baseOf(f)), h('span.kind', 'Download'))))) : null);
  }
  modelCtx = {
    onSelect(item) { state.selected = item ? item.label : null; renderList(); renderInspector(item ? { label: item.label, qty: item.qty, info: item.info || infoFor(item.label), length: item.length } : null); },
    onShown() { renderList(); renderInspector(null); if (query.part) stage.selectLabel(query.part); },
    onMeasure(d) { measureOut.textContent = d === null ? 'Now click the second point' : `${fmtNum(d, 1)} mm`; },
  };
  cleanup.push(() => { modelCtx = null; });
  renderList(); renderInspector(null);
  if (query.part) setTimeout(() => stage.selectLabel(query.part), 1200);
  return h('div.model-ui', list, h('div.model-gap', { 'aria-hidden': 'true' }), insp, toolbar);
}

function comparePage(pid, a, b) {
  const p = getProject(pid) || store.projects.find((x) => x.iterations.length > 1) || store.projects[0];
  if (!p) return notFound();
  const its = p.iterations;
  let A = its.find((i) => i.id === a), B = its.find((i) => i.id === b);
  if (!B) B = latest(p);
  if (!A) A = previous(p, B) || B;
  stage.pose('compare');
  if (B) stage.show(p, B).then(() => { if (A && A !== B && document.body.dataset.pose === 'compare') stage.setGhost(p, A); });
  const go = () => { location.hash = `#/compare/${selP.value}/${selA.value}/${selB.value}`; };
  const selP = h('select', { 'aria-label': 'Project', onchange: () => { location.hash = `#/compare/${selP.value}`; } }, store.projects.map((x) => h('option', { value: x.id, selected: x === p }, x.name)));
  const selA = h('select', { 'aria-label': 'First iteration', onchange: go }, its.map((i) => h('option', { value: i.id, selected: i === A }, i.name)));
  const selB = h('select', { 'aria-label': 'Second iteration', onchange: go }, its.map((i) => h('option', { value: i.id, selected: i === B }, i.name)));
  const labels = [...new Set([...A.specs, ...B.specs].map((s) => s.label))];
  const specRows = labels.map((l) => {
    const x = A.specs.find((s) => s.label === l), y = B.specs.find((s) => s.label === l);
    const nx = Number(x?.value), ny = Number(y?.value);
    const d = x && y && Number.isFinite(nx) && Number.isFinite(ny) ? ny - nx : null;
    return h('tr', h('td', l), h('td.num', x ? `${fmtNum(x.value)} ${x.unit || ''}` : '–'), h('td.num', y ? `${fmtNum(y.value)} ${y.unit || ''}` : '–'), h('td.num', d === null ? '' : d === 0 ? 'same' : `${d > 0 ? '+' : '−'}${fmtNum(Math.abs(d))}`));
  });
  const names = [...new Set([...A.parts, ...B.parts].map((x) => x.label || x.match))];
  const partRows = names.map((n) => {
    const x = A.parts.find((q) => (q.label || q.match) === n), y = B.parts.find((q) => (q.label || q.match) === n);
    const st = !x ? ['new', 'Added'] : !y ? ['bad', 'Removed'] : y.change === 'changed' ? ['changed', 'Changed'] : y.change === 'new' ? ['new', 'New'] : ['', 'Unchanged'];
    return h('tr', h('td', n), h('td.num', x && x.mass_g !== undefined && x.mass_g !== '' ? `${fmtNum(x.mass_g)} g` : '–'), h('td.num', y && y.mass_g !== undefined && y.mass_g !== '' ? `${fmtNum(y.mass_g)} g` : '–'), h('td', h(`span.tag.plain${st[0] ? '.' + st[0] : ''}`, st[1])));
  });
  const solved = todoStatus(p, A).filter((t) => t.fixedIn === B);
  return stagger(h('div.col',
    crumbs({ text: 'Projects', href: '#/' }, { text: 'Compare' }),
    h('h1', { style: { fontSize: 'clamp(30px, 4vw, 46px)' } }, 'Compare iterations'),
    sampleBanner(p),
    h('div.glass.row', selP, selA, h('span.faint', 'against'), selB),
    A === B ? h('div.empty', 'Pick two different iterations. This project may only have one so far.') : null,
    h('p.hint', `The 3D view shows ${B.name}, with ${A.name} drawn over it as a red ghost.`),
    h('div.glass.stack', h('h3', 'Specifications'), h('div.table-wrap', h('table.cmp', h('thead', h('tr', h('th', 'Measure'), h('th', A.name), h('th', B.name), h('th', 'Change'))), h('tbody', specRows)))),
    h('div.glass.stack', h('h3', 'Parts'), h('div.table-wrap', h('table.cmp', h('thead', h('tr', h('th', 'Part'), h('th', A.name), h('th', B.name), h('th', 'Status'))), h('tbody', partRows)))),
    solved.length ? h('div.glass.stack', h('h3', `${A.name} problems solved in ${B.name}`), solved.map((t) => h('div.todo.done', h('span.box', '✓'), h('div', h('span.txt', t.text), h('a.res', { href: `#/p/${p.id}/${B.id}/new` }, t.change.title))))) : null));
}

function aboutPage() {
  stage.pose('quiet');
  const o = store.site.owner || {};
  return stagger(h('div.prose',
    h('span.eyebrow', 'About'),
    h('h1', o.name || 'About'),
    o.headline ? h('p', { style: { fontSize: '18px', color: 'var(--text)' } }, o.headline) : null,
    (o.bio || []).map((t) => h('p', t)),
    (o.links || []).length ? h('div.row', { style: { marginTop: '18px' } }, o.links.map((l) => h('a.btn', { href: l.url, target: '_blank', rel: 'noopener', style: { textDecoration: 'none', color: 'var(--text)' } }, l.label))) : null,
    h('h2', 'About this site'),
    h('p', store.site.about || 'Every rocket project gets its own section, and every iteration records what was new, how it was built, how it flew and what failed. Each failure lists what the next iteration has to solve, and each fix links back to the problem it answers.')));
}

async function guidePage() {
  setOwner(true);
  stage.pose('quiet');
  const box = h('div.prose', h('p', 'Loading…'));
  fetch('assets/guide.txt').then((r) => r.text()).then((t) => { box.innerHTML = markdown(t); }).catch(() => { box.innerHTML = '<p>The guide could not be loaded. Open assets/guide.txt in the repository instead.</p>'; });
  return box;
}

async function builderPage() {
  setOwner(true);
  stage.pose('quiet');
  const box = h('div.builder', h('p.muted', 'Loading the Builder…'));
  import('./builder.js').then((m) => m.mountBuilder(box, { reload: async () => { await loadAll(); } })).catch((e) => { console.error(e); box.replaceChildren(h('div.empty', 'The Builder could not load.')); });
  return box;
}

const notFound = () => { stage.pose('quiet'); return h('div.prose', h('h1', 'Page not found'), h('p', h('a', { href: '#/' }, 'Back to projects'))); };

// ------------------------------------------------------------------ router
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { seg: path.split('/').filter(Boolean).map(decodeURIComponent), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
let first = true;
async function route() {
  const { seg, query } = parseHash();
  cleanup.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  cleanup = [];
  let node, navKey = 'home', title = '';
  try {
    if (!seg.length) node = homePage();
    else if (seg[0] === 'p' && seg.length === 2) { node = projectPage(seg[1]); title = getProject(seg[1])?.name; }
    else if (seg[0] === 'p' && seg.length >= 3) { node = iterationPage(seg[1], seg[2], seg[3], query); title = `${getProject(seg[1])?.name || ''} ${getIteration(seg[1], seg[2])?.name || ''}`; }
    else if (seg[0] === 'compare') { node = comparePage(seg[1], seg[2], seg[3]); navKey = 'compare'; title = 'Compare'; }
    else if (seg[0] === 'about') { node = aboutPage(); navKey = 'about'; title = 'About'; }
    else if (seg[0] === 'guide') { node = await guidePage(); navKey = ''; title = 'Guide'; }
    else if (seg[0] === 'builder') { node = await builderPage(); navKey = ''; title = 'Builder'; }
    else node = notFound();
  } catch (e) { console.error(e); node = h('div.prose', h('h1', 'Something went wrong'), h('p', String(e.message || e))); }
  document.title = `${title ? title.trim() + ' · ' : ''}${store.site?.title || 'Rocket logbook'}`;
  const swap = () => {
    view.replaceChildren(node);
    window.scrollTo(0, 0);
    setNav(navKey);
    const head = $('.iter-head', view);
    document.body.style.setProperty('--model-top', head ? `${Math.round(head.getBoundingClientRect().bottom + window.scrollY + 14)}px` : '150px');
    countUp(view); watchReveals(view);
  };
  if (!first && document.startViewTransition && !reducedMotion()) document.startViewTransition(swap);
  else swap();
  first = false;
  if (!reducedMotion()) view.focus({ preventScroll: true });
}

function setNav(key) {
  const pill = $('.pill');
  let ink = $('.pill-ink', pill);
  if (!ink) { ink = h('span.pill-ink'); pill.prepend(ink); }
  let on = null;
  $$('a', pill).forEach((a) => { const is = a.dataset.nav === key; a.classList.toggle('on', is); if (is) { a.setAttribute('aria-current', 'page'); on = a; } else a.removeAttribute('aria-current'); });
  if (on) { ink.style.opacity = 1; ink.style.left = `${on.offsetLeft}px`; ink.style.width = `${on.offsetWidth}px`; } else ink.style.opacity = 0;
}

// ------------------------------------------------------------------ theme, search, chrome
function initTheme() {
  $('#themeBtn').addEventListener('click', (e) => {
    const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    const apply = () => { document.documentElement.dataset.theme = nextTheme; try { localStorage.setItem('theme', nextTheme); } catch (err) { /* private mode */ } stage.setTheme(nextTheme === 'dark'); };
    if (!document.startViewTransition || reducedMotion()) return apply();
    const r = e.currentTarget.getBoundingClientRect();
    const root = document.documentElement;
    root.style.setProperty('--wx', `${r.left + r.width / 2}px`); root.style.setProperty('--wy', `${r.top + r.height / 2}px`);
    root.classList.add('theme-wipe');
    document.startViewTransition(apply).finished.finally(() => root.classList.remove('theme-wipe'));
  });
}

function initSearch() {
  const pal = $('#palette'), input = $('#paletteInput'), listEl = $('#paletteList');
  let results = [], idx = 0, index = [];
  const draw = () => listEl.replaceChildren(...results.map((r, i) => h(`li${i === idx ? '.on' : ''}`, { onclick: () => pick(r), onmousemove: () => { if (idx !== i) { idx = i; draw(); } } }, h('span', r.text), h('small', r.kind))));
  const search = () => {
    const q = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    results = (q.length ? index.filter((r) => q.every((w) => `${r.text} ${r.kind}`.toLowerCase().includes(w))) : index.filter((r) => ['Project', 'Iteration', 'Page'].includes(r.kind))).slice(0, 30);
    idx = 0; draw();
  };
  const open = () => { index = searchIndex().filter((r) => isOwner() || !/^(#\/builder|#\/guide)/.test(r.href)); pal.hidden = false; input.value = ''; search(); input.focus(); };
  const close = () => { pal.hidden = true; };
  const pick = (r) => { close(); location.hash = r.href; };
  $('#searchBtn').addEventListener('click', open);
  input.addEventListener('input', search);
  pal.addEventListener('click', (e) => { if (e.target === pal) close(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { idx = Math.min(results.length - 1, idx + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && results[idx]) pick(results[idx]);
    else if (e.key === 'Escape') close();
    const li = listEl.children[idx]; if (li) li.scrollIntoView({ block: 'nearest' });
  });
  window.addEventListener('keydown', (e) => {
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); open(); }
  });
}

function initChrome() {
  const nav = $('#nav'), bar = $('#progress');
  const onScroll = () => {
    nav.classList.toggle('scrolled', window.scrollY > 24);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.transform = `scaleX(${max > 40 ? Math.min(1, window.scrollY / max) : 0})`;
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => setNav($('.pill a.on')?.dataset.nav || ''));
  // buttons lean a little toward the pointer
  document.addEventListener('pointermove', (e) => {
    const b = e.target.closest && e.target.closest('.btn.primary');
    $$('.btn.primary').forEach((x) => { if (x !== b) x.style.translate = ''; });
    if (!b || reducedMotion()) return;
    const r = b.getBoundingClientRect();
    b.style.translate = `${((e.clientX - r.left) / r.width - 0.5) * 8}px ${((e.clientY - r.top) / r.height - 0.5) * 6}px`;
  });
  const note = h('div.stage-note', { hidden: true });
  $('#stage').append(note);
  let noteTimer = 0;
  const say = (text, ms = 0) => { clearTimeout(noteTimer); note.textContent = text; note.hidden = !text; if (ms) noteTimer = setTimeout(() => { note.hidden = true; }, ms); };
  stage.on('loading', (on) => say(on ? 'Loading 3D model…' : ''));
  stage.on('failed', () => { say('3D view unavailable (needs a connection)', 6000); if (modelCtx) modelCtx.onShown(); });
  stage.on('error', (msg) => toast(msg, 'error', 8000));
  stage.on('empty', () => say('No 3D model uploaded for this iteration yet', 6000));
  stage.on('select', (item) => { if (modelCtx) modelCtx.onSelect(item); });
  stage.on('shown', () => { if (modelCtx) modelCtx.onShown(); });
  stage.on('measure', (d) => { if (modelCtx) modelCtx.onMeasure(d); });
}

async function boot() {
  const intro = $('#intro');
  let seen = false;
  try { seen = sessionStorage.getItem('seen') === '1'; sessionStorage.setItem('seen', '1'); } catch (e) { /* private mode */ }
  if (seen || reducedMotion()) intro.classList.add('gone');
  const t0 = performance.now();
  initTheme(); initSearch(); initChrome();
  try { await loadAll(); }
  catch (e) {
    intro.classList.add('gone');
    view.replaceChildren(h('div.prose', h('h1', 'The site data could not be loaded'), h('p', String(e.message || e)), h('p', 'If you opened index.html straight from your computer, it needs to be served by a web server (GitHub Pages does this for you).')));
    return;
  }
  const s = store.site;
  $('#brand').textContent = s.title || 'Rocket logbook';
  $('.intro-mark').lastChild.textContent = s.title || 'Rocket logbook';
  $('#footName').textContent = `${s.owner?.name ? s.owner.name + ' · ' : ''}${s.title || ''}`;
  store.errors.forEach((m) => toast(m, 'error', 9000));
  syncOwner();
  window.addEventListener('hashchange', route);
  await route();
  setTimeout(() => intro.classList.add('gone'), Math.max(0, 900 - (performance.now() - t0)));
}
boot();
