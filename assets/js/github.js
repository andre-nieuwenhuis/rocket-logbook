// Talks to GitHub so the Builder can publish straight to the repository. Nothing here runs unless
// the person has entered their own access key, which is kept only in this browser.
const KEY = 'rocket-logbook-github';

export function loadSettings(defaults = {}) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  return { owner: '', repo: '', branch: 'main', token: '', ...defaults, ...saved };
}
export function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} }
export const connected = (s) => !!(s && s.owner && s.repo && s.token);

async function api(s, path, { method = 'GET', body, raw = false } = {}) {
  const r = await fetch(`https://api.github.com/repos/${s.owner}/${s.repo}${path}`, {
    method,
    headers: { Authorization: `Bearer ${s.token}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).message || msg; } catch {}
    if (r.status === 401) msg = 'GitHub did not accept the access key. Check it has not expired.';
    if (r.status === 403) msg = `GitHub refused: ${msg}. The key needs "Contents: Read and write" on this repository.`;
    throw new Error(msg);
  }
  return raw ? r.text() : r.json();
}

export async function testConnection(s) {
  const repo = await api(s, '');
  if (!repo) throw new Error(`Repository ${s.owner}/${s.repo} was not found. Check the names, and that the key can see it.`);
  if (repo.permissions && !repo.permissions.push) throw new Error('The key can read this repository but cannot write to it.');
  const ref = await api(s, `/git/ref/heads/${encodeURIComponent(s.branch)}`);
  if (!ref) throw new Error(`Branch "${s.branch}" was not found. Upload the site folder first, then try again.`);
  return true;
}

export async function readJSON(s, path) {
  const text = await api(s, `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(s.branch)}`, { raw: true });
  return text === null ? null : JSON.parse(text);
}

export async function listPaths(s, prefix) {
  const tree = await api(s, `/git/trees/${encodeURIComponent(s.branch)}?recursive=1`);
  return tree ? tree.tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix)).map((e) => e.path) : [];
}

function toBase64(bytes) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(new Blob([bytes]));
  });
}

/** files: [{path, bytes}] to add or replace, deletions: [path]. Everything lands in one commit. */
export async function commit(s, files, deletions, message, onProgress = () => {}) {
  const ref = await api(s, `/git/ref/heads/${encodeURIComponent(s.branch)}`);
  if (!ref) throw new Error(`Branch "${s.branch}" was not found.`);
  const head = ref.object.sha;
  const headCommit = await api(s, `/git/commits/${head}`);
  const tree = [];
  let i = 0;
  for (const f of files) {
    onProgress(`Uploading ${++i} of ${files.length}: ${f.path.split('/').pop()}`);
    if (f.bytes.length > 95 * 1024 * 1024) throw new Error(`${f.path.split('/').pop()} is over GitHub's 100 MB file limit.`);
    const blob = await api(s, '/git/blobs', { method: 'POST', body: { content: await toBase64(f.bytes), encoding: 'base64' } });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const path of deletions) tree.push({ path, mode: '100644', type: 'blob', sha: null });
  onProgress('Saving the change…');
  const newTree = await api(s, '/git/trees', { method: 'POST', body: { base_tree: headCommit.tree.sha, tree } });
  const newCommit = await api(s, '/git/commits', { method: 'POST', body: { message, tree: newTree.sha, parents: [head] } });
  await api(s, `/git/refs/heads/${encodeURIComponent(s.branch)}`, { method: 'PATCH', body: { sha: newCommit.sha } });
  return newCommit.sha;
}
