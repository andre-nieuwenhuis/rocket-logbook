// Small helpers shared by every page: DOM building, formatting, markdown, code colouring, charts, zip.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div.card', {onclick}, child, 'text', [more]) */
export function h(tag, attrs, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

/** Replace an element's children; accepts the same nested arrays and nulls as h(). */
export function fill(el, ...kids) { el.replaceChildren(...h('div', null, ...kids).childNodes); return el; }

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const extOf = (p) => { const b = String(p || '').split('/').pop(); const i = b.lastIndexOf('.'); return i >= 0 ? b.slice(i + 1).toLowerCase() : ''; };
export const baseOf = (p) => String(p || '').split('/').pop();

export function fmtNum(v, digits) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return String(v ?? '');
  const n = Number(v);
  const d = digits ?? (Math.abs(n) >= 100 || Number.isInteger(n) ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  return n.toLocaleString('en-GB', { maximumFractionDigits: d });
}
export function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + (String(s).length <= 10 ? 'T12:00:00' : ''));
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function toast(msg, kind = '', ms = 4200) {
  const t = h(`div.toast${kind ? '.' + kind : ''}`, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Animate every [data-count] number inside root from 0 to its value. */
export function countUp(root) {
  for (const el of $$('[data-count]', root)) {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target) || reducedMotion()) continue;
    const digits = (String(el.dataset.count).split('.')[1] || '').length;
    const t0 = performance.now(), dur = 1100;
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 3);
      el.textContent = (target * e).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

let revealObs = null;
export function watchReveals(root) {
  if (!revealObs) {
    revealObs = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('seen'); revealObs.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
  }
  $$('.reveal', root).forEach((el, i) => { el.style.transitionDelay = `${Math.min(i, 6) * 50}ms`; revealObs.observe(el); });
}

// ---------------------------------------------------------------- markdown (small subset, enough for the guide and notes)
function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => `<a href="${u}"${/^https?:/.test(u) ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`);
}
export function markdown(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (/^#{1,3} /.test(l)) {
      const n = l.match(/^#+/)[0].length;
      const text = l.slice(n + 1);
      out.push(`<h${n} id="${slugify(text)}">${inlineMd(text)}</h${n}>`);
      i++;
    } else if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inlineMd(c.trim()));
      const body = rows.filter((r, k) => k !== 1 || !/^\|[\s:|-]+\|?$/.test(r));
      out.push('<div class="table-wrap"><table>' + body.map((r, k) => `<tr>${cells(r).map((c) => (k === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`).join('') + '</table></div>');
    } else if (/^(\d+\.|[-*]) /.test(l)) {
      const ordered = /^\d+\./.test(l);
      const items = [];
      while (i < lines.length && (/^(\d+\.|[-*]) /.test(lines[i]) || /^ {2,}\S/.test(lines[i]))) {
        if (/^ {2,}\S/.test(lines[i])) items[items.length - 1] += ' ' + lines[i].trim();
        else items.push(lines[i].replace(/^(\d+\.|[-*]) /, ''));
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inlineMd(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (!l.trim()) {
      i++;
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,3} |```|\||(\d+\.|[-*]) )/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inlineMd(buf.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- code colouring (comments, strings, numbers, keywords)
const KEYWORDS = new Set(('if else for while do return break continue switch case default void int float double long short unsigned signed char bool const static struct class public private ' +
  'protected include define import from as def lambda in not and or is None True False true false null undefined let var function new delete try except catch finally raise throw with ' +
  'yield async await typedef enum namespace using template auto byte uint8_t uint16_t uint32_t int16_t int32_t String boolean end elseif function').split(' '));
export function highlight(code, ext) {
  const hash = ['py', 'm', 'sh', 'yaml', 'yml', 'toml', 'r'].includes(ext);
  const comment = ext === 'm' ? '%[^\\n]*' : hash ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  const re = new RegExp(`(${comment})|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*')|\\b(\\d+\\.?\\d*(?:e[+-]?\\d+)?)\\b|\\b([A-Za-z_]\\w*)\\b`, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[1]) out += `<span class="tok-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`;
    else out += KEYWORDS.has(m[4]) ? `<span class="tok-k">${esc(m[4])}</span>` : esc(m[4]);
    last = re.lastIndex;
  }
  return out + esc(code.slice(last));
}

// ---------------------------------------------------------------- CSV + charts
export function parseCsv(text) {
  const rows = String(text).trim().split(/\r?\n/).map((r) => r.split(/[,;\t]/).map((c) => c.trim()));
  if (!rows.length) return { header: [], rows: [] };
  const hasHeader = rows[0].some((c) => c !== '' && !Number.isFinite(Number(c)));
  const header = hasHeader ? rows.shift() : rows[0].map((_, i) => `Column ${i + 1}`);
  return { header, rows: rows.map((r) => r.map(Number)).filter((r) => r.every(Number.isFinite)) };
}
function niceTicks(lo, hi, n = 4) {
  if (lo === hi) { hi = lo + 1; }
  const raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) || raw;
  const a = Math.floor(lo / step) * step, out = [];
  for (let v = a; v <= hi + step * 0.5; v += step) out.push(Math.round(v / step) * step);
  return out;
}
const svgEl = (s) => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstChild; };

/** Line chart of one series. points: [[x, y], ...] */
export function lineChart(points, { xLabel = '', yLabel = '', width = 560, height = 240 } = {}) {
  const m = { l: 48, r: 14, t: 30, b: 34 };
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const xt = niceTicks(Math.min(...xs), Math.max(...xs), 5), yt = niceTicks(Math.min(0, ...ys), Math.max(...ys), 4);
  const x0 = xt[0], x1 = xt[xt.length - 1], y0 = yt[0], y1 = yt[yt.length - 1];
  const X = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * (width - m.l - m.r);
  const Y = (v) => height - m.b - ((v - y0) / (y1 - y0 || 1)) * (height - m.t - m.b);
  const step = Math.max(1, Math.floor(points.length / 400));
  const d = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(' ');
  const peak = points.reduce((a, b) => (b[1] > a[1] ? b : a), points[0]);
  return svgEl(`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(yLabel)} against ${esc(xLabel)}, peaking at ${fmtNum(peak[1])}">
    ${yt.map((v) => `<line class="gridl" x1="${m.l}" x2="${width - m.r}" y1="${Y(v)}" y2="${Y(v)}"></line><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtNum(v)}</text>`).join('')}
    ${xt.map((v) => `<text x="${X(v)}" y="${height - m.b + 16}" text-anchor="middle">${fmtNum(v)}</text>`).join('')}
    <line class="axis" x1="${m.l}" x2="${width - m.r}" y1="${height - m.b}" y2="${height - m.b}"></line>
    <text x="${width - m.r}" y="${height - 4}" text-anchor="end">${esc(xLabel)}</text><text x="4" y="12">${esc(yLabel)}</text>
    <path class="series" d="${d}"></path>
    <circle class="pt" cx="${X(peak[0])}" cy="${Y(peak[1])}" r="4"></circle>
    <text class="lab" x="${X(peak[0]) + 8}" y="${Y(peak[1]) - 6}">${fmtNum(peak[1])}</text>
  </svg>`);
}

/** Small bar chart of one value across iterations. items: [{label, value, current}] */
export function barChart(items, { unit = '', width = 280, height = 120 } = {}) {
  const max = Math.max(...items.map((d) => d.value), 0) || 1;
  const m = { l: 6, r: 6, t: 20, b: 22 };
  const bw = (width - m.l - m.r) / items.length;
  return svgEl(`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${items.map((d) => `${d.label} ${fmtNum(d.value)} ${unit}`).join(', ')}">
    <line class="axis" x1="${m.l}" x2="${width - m.r}" y1="${height - m.b}" y2="${height - m.b}"></line>
    ${items.map((d, i) => {
      const bh = Math.max(2, (d.value / max) * (height - m.t - m.b));
      const x = m.l + i * bw + bw * 0.2, w = Math.min(46, bw * 0.6), y = height - m.b - bh;
      return `<rect class="bar${d.current ? '' : ' dim'}" x="${x}" y="${y}" width="${w}" height="${bh}" rx="4"></rect>
        <text class="lab" x="${x + w / 2}" y="${y - 6}" text-anchor="middle">${fmtNum(d.value)}</text>
        <text x="${x + w / 2}" y="${height - 6}" text-anchor="middle">${esc(d.label)}</text>`;
    }).join('')}
  </svg>`);
}

// ---------------------------------------------------------------- files: base64 + a store-only zip writer (no library needed)
export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** entries: [{path, bytes: Uint8Array}] -> Blob (zip, stored without compression) */
export function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path), crc = crc32(e.bytes), size = e.bytes.length;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 0, true);
    head.setUint16(10, 0, true); head.setUint16(12, 0x21, true); head.setUint32(14, crc, true); head.setUint32(18, size, true); head.setUint32(22, size, true);
    head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
    chunks.push(new Uint8Array(head.buffer), name, e.bytes);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true);
    cen.setUint16(12, 0, true); cen.setUint16(14, 0x21, true); cen.setUint32(16, crc, true); cen.setUint32(20, size, true); cen.setUint32(24, size, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + size;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
export function downloadBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// names used by the Builder
export const slug = slugify;
export const fileExt = extOf;
export const fileName = baseOf;
