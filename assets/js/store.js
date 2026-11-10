// Loads everything under data/ and answers questions about it. No page code in here.
// Layout on disk:
//   data/site.json                              site title, owner, list of project ids
//   data/projects/<project>/project.json        project details, list of iteration ids (oldest first)
//   data/projects/<project>/<iteration>/iteration.json   one iteration; its files live beside it in files/

export const store = { site: null, projects: [], byId: new Map(), errors: [] };

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} (${r.status})`);
  return r.json();
}

export async function loadAll() {
  store.errors = [];
  store.site = await getJson('data/site.json');
  const projects = await Promise.all((store.site.projects || []).map(async (pid) => {
    try {
      const p = await getJson(`data/projects/${pid}/project.json`);
      p.id = pid;
      p.goals = Array.isArray(p.goals) ? p.goals : [];
      p.iterations = (await Promise.all((p.iterations || []).map(async (iid) => {
        try { const it = await getJson(`data/projects/${pid}/${iid}/iteration.json`); it.id = iid; it.pid = pid; return normaliseIteration(it); }
        catch (e) { store.errors.push(`Could not load ${pid}/${iid}: ${e.message}`); return null; }
      }))).filter(Boolean);
      p.iters = p.iterations; // same list, shorter name used by the Builder
      return p;
    } catch (e) { store.errors.push(`Could not load project ${pid}: ${e.message}`); return null; }
  }));
  store.projects = projects.filter(Boolean);
  store.byId = new Map(store.projects.map((p) => [p.id, p]));
  return store;
}

export function normaliseIteration(it) {
  it.name = it.name || it.id;
  it.status = it.status || 'design';
  for (const k of ['specs', 'parts', 'changes', 'buildLog', 'flights', 'files']) if (!Array.isArray(it[k])) it[k] = [];
  it.model = it.model && typeof it.model === 'object' ? it.model : {};
  if (!Array.isArray(it.model.models)) it.model.models = [];
  it.failure = it.failure && typeof it.failure === 'object' ? it.failure : null;
  if (it.failure && !Array.isArray(it.failure.todo)) it.failure.todo = [];
  return it;
}

export const getProject = (pid) => store.byId.get(pid) || null;
export const project = getProject;
export const getIteration = (pid, iid) => (getProject(pid)?.iterations || []).find((i) => i.id === iid) || null;
export const latest = (p) => p.iterations[p.iterations.length - 1] || null;
export function previous(p, it) { const i = p.iterations.indexOf(it); return i > 0 ? p.iterations[i - 1] : null; }
export function next(p, it) { const i = p.iterations.indexOf(it); return i >= 0 && i < p.iterations.length - 1 ? p.iterations[i + 1] : null; }

/** Turn a path written inside iteration.json (relative to that iteration's folder) into a site URL. */
export function filePath(pid, iid, rel) {
  if (/^(https?:|data:|blob:)/.test(rel)) return rel;
  const parts = `data/projects/${pid}/${iid}/${rel}`.split('/');
  const out = [];
  for (const s of parts) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}

export const STATUS = {
  design: { label: 'In design', cls: '' },
  building: { label: 'Being built', cls: 'changed' },
  ready: { label: 'Flight ready', cls: 'good' },
  flown: { label: 'Flown', cls: 'good' },
  failed: { label: 'Failed', cls: 'bad' },
  retired: { label: 'Retired', cls: '' },
};
export const statusOf = (it) => STATUS[it.status] || { label: it.status, cls: '' };
export const OUTCOME = { success: { label: 'Success', cls: 'good' }, partial: { label: 'Partial', cls: 'changed' }, failure: { label: 'Failure', cls: 'bad' } };

export const specValue = (it, label) => it.specs.find((s) => s.label.toLowerCase() === label.toLowerCase()) || null;

/** Every "to solve" item from this iteration's failure report, with the later change that fixed it (if any). */
export function todoStatus(p, it) {
  if (!it.failure) return [];
  const later = p.iterations.slice(p.iterations.indexOf(it) + 1);
  return it.failure.todo.map((t) => {
    const ref = `${it.id}/${t.id}`;
    for (const li of later) {
      const ch = li.changes.find((c) => (c.fixes || []).includes(ref));
      if (ch) return { ...t, fixedIn: li, change: ch };
    }
    return { ...t, fixedIn: null, change: null };
  });
}

/** For a change in `it`, the earlier failure items it fixes: [{iteration, todo}] */
export function fixesOf(p, change) {
  return (change.fixes || []).map((ref) => {
    const [iid, tid] = ref.split('/');
    const src = p.iterations.find((i) => i.id === iid);
    const todo = src?.failure?.todo.find((t) => t.id === tid);
    return src && todo ? { iteration: src, todo } : null;
  }).filter(Boolean);
}

export function totalMass(it) {
  const m = it.parts.map((p) => Number(p.mass_g) * (Number(p.qty) || 1)).filter(Number.isFinite);
  return m.length ? m.reduce((a, b) => a + b, 0) : null;
}

/** Flat list for the search box. */
export function searchIndex() {
  const out = [];
  for (const p of store.projects) {
    out.push({ text: p.name, kind: 'Project', href: `#/p/${p.id}` });
    for (const it of p.iterations) {
      const base = `#/p/${p.id}/${it.id}`;
      out.push({ text: `${p.name} ${it.name}`, kind: 'Iteration', href: base });
      for (const part of it.parts) out.push({ text: `${part.label || part.match}`, kind: `Part · ${it.name}`, href: `${base}/model?part=${encodeURIComponent(part.label || part.match)}` });
      for (const f of it.files) out.push({ text: f.label || f.path.split('/').pop(), kind: `File · ${it.name}`, href: `${base}/files` });
      for (const c of it.changes) out.push({ text: c.title, kind: `Change · ${it.name}`, href: `${base}/new` });
      if (it.failure) out.push({ text: it.failure.title || 'Failure report', kind: `Failure · ${it.name}`, href: `${base}/failure` });
    }
  }
  out.push({ text: 'Compare iterations', kind: 'Page', href: '#/compare' }, { text: 'About', kind: 'Page', href: '#/about' },
    { text: 'Guide: how to add projects and iterations', kind: 'Page', href: '#/guide' }, { text: 'Builder', kind: 'Page', href: '#/builder' });
  return out;
}
