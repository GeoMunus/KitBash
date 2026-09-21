/* ================= recall (search) ================= */
const STOP = new Set('a an the of to and or for in on with by from is are be as at it this that into my your our its using use make build create want need like some simple small new'.split(' '));
const stem = t => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, m => (t.length - m.length >= 3 ? '' : m)) : t);
const tok = s => (String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) || []).map(stem).filter(t => t.length > 1 && !STOP.has(t));
const SYN = {
  anim: ['loop', 'frame', 'tick', 'keyframe'], animat: ['loop', 'frame', 'tick', 'keyframe'], background: ['bg', 'theme', 'stage'], color: ['palette', 'token', 'theme'], colour: ['palette', 'token', 'theme'],
  theme: ['token', 'palette'], chart: ['plot', 'graph', 'canvas'], random: ['rand'], sound: ['audio'], music: ['audio'], game: ['loop', 'canvas', 'entity'], menu: ['nav'], popup: ['modal', 'dialog'],
  save: ['storage', 'persist'], glow: ['pulse', 'twinkle', 'shadow'], pulse: ['twinkle', 'animation'], screensaver: ['loop', 'canvas', 'animation'], space: ['star', 'sky'], title: ['heading', 'header']
};

function buildIndex(skills) {
  const docs = []; const df = new Map();
  for (const s of skills) {
    const f = {
      name: tok(s.name), tags: tok((s.tags || []).join(' ')), summary: tok(s.summary), provides: tok((s.provides || []).join(' ')), path: tok(s.path + ' ' + s.project),
      code: tok(s.code.slice(0, 3000))
    };
    const all = new Set(Object.values(f).flat());
    for (const t of all) df.set(t, (df.get(t) || 0) + 1);
    docs.push({ s, f, sets: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, new Set(v)])) });
  }
  return { docs, df, N: docs.length };
}
const FIELD_W = { name: 4, tags: 3, summary: 2, provides: 2, path: 0.5, code: 0.5 };

function recall(index, query, limit = 60) {
  const base = [...new Set(tok(query))]; if (!base.length) return [];
  const terms = base.map(t => ({ t, w: 1 }));
  for (const t of base) for (const syn of SYN[t] || SYN[t.slice(0, 5)] || []) if (!base.includes(stem(syn))) terms.push({ t: stem(syn), w: 0.45 });
  const res = [];
  for (const d of index.docs) {
    let score = 0; let matched = 0;
    for (const { t, w } of terms) {
      const idf = Math.log(1 + index.N / (1 + (index.df.get(t) || 0)));
      let hit = 0;
      for (const [fld, fw] of Object.entries(FIELD_W)) {
        if (d.sets[fld].has(t)) hit = Math.max(hit, fw);
        else if (t.length >= 3) for (const x of d.sets[fld]) { if (x.startsWith(t)) { hit = Math.max(hit, fw * 0.5); break; } if (x.length >= 4 && t.startsWith(x)) { hit = Math.max(hit, fw * 0.8); break; } }
      }
      if (hit) { score += idf * hit * w; if (w === 1) matched++; }
    }
    if (!score) continue;
    score *= 0.55 + 0.45 * (matched / base.length);
    score += Math.log(1 + (d.s.hits || 0)) * 0.4;
    res.push({ s: d.s, score });
  }
  res.sort((a, b) => b.score - a.score);
  const top = res[0] ? res[0].score : 1;
  return res.slice(0, limit).map(r => ({ s: r.s, score: r.score, rel: r.score / top }));
}

/* ================= assembling a build ================= */
function closure(ids, byId) {
  const seen = new Set(); const order = [];
  const visit = id => {
    if (seen.has(id)) return; const s = byId[id]; if (!s) return; seen.add(id);
    for (const u of s.uses || []) visit(u);
    if (s.kind !== 'composite') order.push(id);
  };
  ids.forEach(visit);
  return order;
}

function cleanJS(code) {
  return code
    .replace(/^\s*import[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^\s*import\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^(\s*)export\s+default\s+(?=(async\s+)?function|class)/gm, '$1')
    .replace(/^(\s*)export\s+(?=(async\s+)?function|class|const|let|var)/gm, '$1');
}
const CDN = {
  react: ['https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.4/babel.min.js'],
  three: ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js']
};

function assemble(ids, byId, goal) {
  const order = closure(ids, byId); const parts = order.map(id => byId[id]); const notes = []; const used = [];
  const css = [], markup = [], js = []; const pkgs = new Set(); let jsx = false;
  const kindRank = { tokens: 0, keyframes: 1, css: 2 };
  for (const s of parts) {
    if (['tokens', 'keyframes', 'css'].includes(s.kind)) css.push(s);
    else if (['html', 'svg'].includes(s.kind)) markup.push(s);
    else if (['fn', 'class', 'component', 'data', 'shader', 'entry'].includes(s.kind) && s.lang === 'js') js.push(s);
    else if (s.kind === 'type') notes.push(`Skipped type ${s.name} (needs a TypeScript build).`);
    else if (s.kind === 'skill') notes.push(`Skill “${s.name}” is instructions, not code — not embedded.`);
    else notes.push(`Skipped ${s.name} (${s.kind}/${s.lang}) — can’t be embedded in a web page.`);
    (s.pkgs || []).forEach(p => pkgs.add(p));
  }
  css.sort((a, b) => (kindRank[a.kind] ?? 3) - (kindRank[b.kind] ?? 3));
  const src = (a, b) => (a.project + a.path).localeCompare(b.project + b.path) || a.line - b.line;
  markup.sort(src);
  // dependency-ordered JS, entries last
  const rank = k => (k === 'entry' ? 2 : 1);
  const jsSorted = []; const done = new Set(); const inSet = new Set(js.map(s => s.id));
  const put = s => { if (done.has(s.id)) return; done.add(s.id); for (const u of s.uses || []) if (inSet.has(u) && u !== s.id && !done.has(u) && byId[u].kind !== 'entry') put(byId[u]); jsSorted.push(s); };
  [...js].sort((a, b) => rank(a.kind) - rank(b.kind) || src(a, b)).forEach(put);
  // collisions
  const declared = new Map(); const finalJs = [];
  for (const s of jsSorted) {
    if (s.kind !== 'entry' && s.provides[0]) {
      if (declared.has(s.provides[0])) { notes.push(`Name clash: “${s.provides[0]}” exists in ${declared.get(s.provides[0])} and ${s.path || s.project} — kept the first.`); continue; }
      declared.set(s.provides[0], s.path || s.project);
    }
    finalJs.push(s);
  }
  jsx = finalJs.some(s => s.kind === 'component' || /^\s*<[A-Za-z]/m.test(s.code) && JSX_RE.test(s.code));
  const libs = [];
  if (jsx || [...pkgs].some(p => /^react/.test(p))) libs.push(...CDN.react);
  if ([...pkgs].includes('three')) libs.push(...CDN.three);
  for (const p of pkgs) if (!/^(react|react-dom|three)$/.test(p)) notes.push(`Imports “${p}” were removed — load that library yourself if a part needs it.`);
  let script = finalJs.map(s => `/* ▸ ${s.name}${s.path ? ` · ${s.project}/${s.path}` : ''} */\n${cleanJS(s.code)}`).join('\n\n');
  if (libs.length && (jsx || /\buse(State|Effect|Ref|Memo|Callback)\b/.test(script))) {
    const hooks = [...new Set(script.match(/\buse(State|Effect|Ref|Memo|Callback|Reducer|Context|LayoutEffect)\b/g) || [])];
    if (hooks.length && !/const\s*\{[^}]*useState/.test(script)) script = `const { ${hooks.join(', ')} } = React;\n\n` + script;
  }
  const title = (goal || 'Kitbash build').replace(/\s+/g, ' ').slice(0, 60);
  const cssText = css.map(s => `/* ▸ ${s.name} */\n${s.code}`).join('\n\n');
  const body = markup.map(s => `<!-- ▸ ${s.name} -->\n${s.code}`).join('\n');
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${esc(title)}</title>\n${libs.map(u => `<script src="${u}"><\/script>`).join('\n')}${libs.length ? '\n' : ''}${cssText ? `<style>\n${cssText}\n</style>\n` : ''}</head>\n<body>\n${body}\n${script ? `<script${jsx ? ' type="text/babel" data-presets="react"' : ''}>\n${script}\n<\/script>\n` : ''}</body>\n</html>\n`;
  const requested = new Set(ids); const pulled = order.filter(id => !requested.has(id));
  const composites = ids.filter(id => byId[id] && byId[id].kind === 'composite');
  composites.forEach(id => notes.push(`“${byId[id].name}” is an earlier build — its ${byId[id].uses.length} parts were pulled in instead of the finished page.`));
  return { html, order, pulled, notes, count: css.length + markup.length + finalJs.length, jsx };
}

/* ================= zip export ================= */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (~c) >>> 0; };
function makeZip(files) {
  const enc = new TextEncoder(); const parts = [], central = []; let offset = 0, cdSize = 0; const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const nm = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
    parts.push(lh.buffer, nm, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, nm); cdSize += 46 + nm.length; offset += 30 + nm.length + data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
const EXT_OF = { js: 'js', css: 'css', html: 'html', py: 'py', glsl: 'glsl', json: 'json', md: 'md' };

/* ================= storage ================= */
const Backend = {
  kind: 'memory', db: null, mem: new Map(),
  async init() {
    const db = await cap('db');
    if (db) { try { const snap = await db.collection('packs').get(); this.db = db; this.kind = 'shared'; return snap.docs.map(d => ({ id: d.id, data: d.data() })); } catch (e) { console.warn('db unavailable', e); } }
    try {
      const rows = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('kitbash:pack:')) rows.push({ id: k.slice(13), data: JSON.parse(localStorage.getItem(k)) }); }
      localStorage.setItem('kitbash:probe', '1'); localStorage.removeItem('kitbash:probe'); this.kind = 'local'; return rows;
    } catch { this.kind = 'memory'; return []; }
  },
  async save(id, data) {
    if (this.kind === 'shared') return this.db.doc('packs/' + id).set(data);
    if (this.kind === 'local') { try { localStorage.setItem('kitbash:pack:' + id, JSON.stringify(data)); return; } catch { this.kind = 'memory'; } }
    this.mem.set(id, data);
  },
  async remove(id) {
    if (this.kind === 'shared') return this.db.doc('packs/' + id).delete();
    if (this.kind === 'local') { try { localStorage.removeItem('kitbash:pack:' + id); } catch { /* ignore */ } }
    this.mem.delete(id);
  }
};
async function cap(name) { try { const c = window.claude; return c && c.use ? ((await c.use(name)) || null) : null; } catch { return null; } }
