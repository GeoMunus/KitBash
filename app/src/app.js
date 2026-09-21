/* ================= app state ================= */
const KIND = {
  fn: ['FN', 'logic', 'Function'], component: ['UI', 'logic', 'Component'], class: ['CLS', 'logic', 'Class'], type: ['TYPE', 'logic', 'Type'], entry: ['MAIN', 'logic', 'Setup'],
  data: ['DATA', 'data', 'Data'], shader: ['GLSL', 'data', 'Shader'], css: ['CSS', 'style', 'Style'], tokens: ['TOK', 'style', 'Tokens'], keyframes: ['ANIM', 'style', 'Motion'],
  html: ['HTML', 'markup', 'Markup'], svg: ['SVG', 'markup', 'Graphic'], composite: ['KIT', 'build', 'Build'], skill: ['SKILL', 'build', 'Skill']
};
const GROUPS = [['all', 'All'], ['logic', 'Logic'], ['style', 'Style'], ['markup', 'Markup'], ['data', 'Data'], ['build', 'Builds']];
const state = {
  tab: 'import', skills: {}, packCounts: {}, index: buildIndex([]), q: '', group: 'all', sort: 'recent', open: null, confirm: null,
  intake: 'folder', ws: [], busy: '',
  build: { goal: SAMPLE_GOAL, pinned: new Set(), plan: null, result: null, view: 'preview', weaving: false, stream: '', abort: null },
  caps: { sample: null, downloads: null, mcp: null }, editing: null
};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const all = () => Object.values(state.skills);
const projLabel = p => (p === '_builds' ? 'Builds' : p === '_manual' ? 'Handmade' : p);
const kindInfo = k => KIND[k] || ['?', 'logic', k];
const ago = t => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + 'm ago' : s < 129600 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
const rebuild = () => { state.index = buildIndex(all()); };

let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600); }
async function copyText(text, ok = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(ok); return; } catch { /* fall through */ }
  const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
  let done = false; try { done = document.execCommand('copy'); } catch { /* ignore */ } ta.remove(); toast(done ? ok : 'Copy blocked here — select the text and copy it');
}
async function saveFile(filename, data, okMsg) {
  const dl = state.caps.downloads;
  if (!dl) { if (typeof data === 'string') return copyText(data, 'Downloads aren’t available here — copied instead'); return toast('Downloads aren’t available in this view'); }
  try { await dl.save({ filename, data }); toast(okMsg || 'Saved'); } catch (e) { if (e && e.code !== 'declined') toast('Couldn’t save: ' + (e.message || e.code)); }
}

/* ================= persistence ================= */
let persistChain = Promise.resolve();
function persist(project) {
  persistChain = persistChain.then(async () => {
    const mine = all().filter(s => s.project === project); const chunks = []; let cur = [], size = 0;
    for (const s of mine) { const sz = JSON.stringify(s).length; if (size + sz > 150000 && cur.length) { chunks.push(cur); cur = []; size = 0; } cur.push(s); size += sz; }
    if (cur.length) chunks.push(cur);
    const base = `${slug(project)}-${hash(project)}`; const prev = state.packCounts[project] || 0;
    try {
      for (let i = 0; i < chunks.length; i++) await Backend.save(`${base}__${i}`, { project, i, skills: chunks[i] });
      for (let i = chunks.length; i < prev; i++) await Backend.remove(`${base}__${i}`);
      state.packCounts[project] = chunks.length;
    } catch (e) { toast('Couldn’t save to the library: ' + (e.message || e.code || 'unknown error')); }
    renderStatus();
  });
  return persistChain;
}
function renderStatus() {
  const b = Backend.kind; const el = $('#status');
  el.className = 'status ' + b; el.textContent = b === 'shared' ? 'Saved to library' : b === 'local' ? 'This browser only' : 'Not saved';
  el.title = b === 'shared' ? 'Parts are stored with this page and survive reloads.' : b === 'local' ? 'Parts are kept in this browser only.' : 'Storage is unavailable — parts will be lost when you close the page.';
  const n = all().length, p = new Set(all().map(s => s.project)).size;
  $('#count').textContent = n ? `${n} part${n === 1 ? '' : 's'} · ${p} project${p === 1 ? '' : 's'}` : 'bin empty';
}

/* ================= shell ================= */
const ICON = {
  parts: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><path d="M13.5 17h7M17 13.5v7"/></svg>',
  import: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4 15.5v3a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-3"/></svg>',
  build: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 20.5h17"/><rect x="5" y="12.5" width="5.5" height="8" rx="1"/><rect x="13" y="7.5" width="6" height="13" rx="1"/><path d="M7.7 9V4.5M6 6.2l1.7-1.7L9.4 6.2"/></svg>',
  team: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.5" cy="8.5" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M3 19c0-3 2.4-5 5.5-5s5.5 2 5.5 5M14.5 14.4c.6-.3 1.3-.4 2-.4 2.6 0 4.5 1.7 4.5 4.6"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>'
};
function shell() {
  $('#root').innerHTML = `
  <div class="app">
    <header class="top">
      <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="15" width="12" height="14" rx="2"/><rect x="17" y="6" width="12" height="9" rx="2"/><rect x="17" y="17" width="12" height="12" rx="2" class="alt"/><rect x="3" y="3" width="10" height="10" rx="2" class="alt"/></svg><span class="wordmark">Kitbash</span></div>
      <div class="topmeta"><span id="count" class="count"></span><span id="status" class="status"></span></div>
    </header>
    <nav class="nav" aria-label="Sections">
      ${[['import', 'Import'], ['parts', 'Parts'], ['build', 'Build'], ['team', 'Team']].map(([k, l]) => `<button data-act="tab" data-tab="${k}" id="nav-${k}">${ICON[k]}<span>${l}</span></button>`).join('')}
    </nav>
    <main id="view"></main>
  </div>
  <div id="toast" role="status" aria-live="polite"></div>
  <div id="sheet" class="sheet" hidden></div>`;
}
function showTab(t) {
  state.tab = t; $$('.nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ({ parts: viewParts, import: viewImport, build: viewBuild, team: viewTeam })[t](); window.scrollTo(0, 0);
}

/* ================= PARTS ================= */
function viewParts() {
  $('#view').innerHTML = `
  <section class="page">
    <div class="toolbar">
      <label class="search" for="q">${ICON.search}<input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="Recall a part — “loop”, “card styles”, “stars”…" value="${esc(state.q)}"></label>
      <button class="btn ghost" data-act="new">New part</button>
    </div>
    <div class="chips" id="chips"></div>
    <div class="listhead" id="listhead"></div>
    <div id="results"></div>
  </section>`;
  updateParts();
}
function updateParts() {
  const q = state.q.trim(); let rows;
  if (q) rows = recall(state.index, q, 80).filter((r, i) => r.rel >= 0.15 || i < 3); else {
    const sorters = { recent: (a, b) => b.created - a.created, used: (a, b) => (b.hits || 0) - (a.hits || 0) || b.created - a.created, name: (a, b) => a.name.localeCompare(b.name) };
    rows = all().sort(sorters[state.sort]).map(s => ({ s, rel: 0 }));
  }
  const counts = { all: rows.length }; for (const r of rows) { const g = kindInfo(r.s.kind)[1]; counts[g] = (counts[g] || 0) + 1; }
  if (state.group !== 'all') rows = rows.filter(r => kindInfo(r.s.kind)[1] === state.group);
  $('#chips').innerHTML = GROUPS.map(([k, l]) => `<button class="chip${state.group === k ? ' on' : ''}" data-act="group" data-g="${k}" ${counts[k] ? '' : 'disabled'}>${l}<i>${counts[k] || 0}</i></button>`).join('');
  $('#listhead').innerHTML = all().length ? `<span>${q ? `${rows.length} recalled for “${esc(q)}”` : `${rows.length} part${rows.length === 1 ? '' : 's'}`}</span>
    <span class="lh-actions">${q ? '' : `<select id="sort" aria-label="Sort parts"><option value="recent">Newest</option><option value="used">Most used</option><option value="name">A–Z</option></select>`}<button class="link" data-act="export">Export skills (.zip)</button></span>` : '';
  if (!q && $('#sort')) $('#sort').value = state.sort;
  const box = $('#results');
  if (!all().length) { box.innerHTML = `<div class="empty"><h2>The bin is empty</h2><p>Import a project and Kitbash will lift its reusable pieces into parts you can recall instantly.</p><button class="btn" data-act="tab" data-tab="import">Import a project</button></div>`; return; }
  if (!rows.length) { box.innerHTML = `<div class="empty"><h2>Nothing matches</h2><p>Try a broader word — Kitbash searches names, tags, summaries and the code itself.</p></div>`; return; }
  box.innerHTML = rows.map(r => partCard(r)).join('');
}
function partCard({ s, rel }) {
  const [lab, grp] = kindInfo(s.kind); const open = state.open === s.id;
  const usedBy = all().filter(o => (o.uses || []).includes(s.id)).length;
  const meta = [s.path ? `${projLabel(s.project)}/${s.path}:${s.line}` : projLabel(s.project), s.uses && s.uses.length ? `builds on ${s.uses.length}` : '', usedBy ? `needed by ${usedBy}` : '', s.hits ? `used ${s.hits}×` : ''].filter(Boolean).join(' · ');
  return `<article class="part g-${grp}${open ? ' open' : ''}" data-id="${esc(s.id)}">
    <button class="part-main" data-act="toggle" data-id="${esc(s.id)}" aria-expanded="${open}">
      <span class="lab">${lab}</span>
      <span class="pbody"><span class="nm">${esc(s.name)}</span><span class="sm">${esc(s.summary)}</span><span class="meta">${esc(meta)}</span></span>
      ${rel ? `<span class="rel" title="Match strength"><i style="width:${Math.max(8, Math.round(rel * 100))}%"></i></span>` : ''}
    </button>${open ? partDetail(s) : ''}</article>`;
}
function partDetail(s) {
  const by = state.skills; const uses = (s.uses || []).map(id => by[id]).filter(Boolean);
  const pinned = state.build.pinned.has(s.id); const sure = state.confirm === s.id;
  return `<div class="detail">
    ${s.tags.length ? `<div class="tags">${s.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
    ${uses.length ? `<p class="builds">Builds on ${uses.map(u => `<button class="link" data-act="toggle" data-id="${esc(u.id)}" data-jump="1">${esc(u.name)}</button>`).join(', ')}</p>` : ''}
    <pre class="code" tabindex="0"><code>${esc(s.code)}</code></pre>
    <div class="actions">
      <button class="btn small" data-act="pin" data-id="${esc(s.id)}">${pinned ? 'Pinned to Build ✓' : 'Add to Build'}</button>
      <button class="btn small ghost" data-act="copy-md" data-id="${esc(s.id)}">Copy SKILL.md</button>
      <button class="btn small ghost" data-act="copy-code" data-id="${esc(s.id)}">Copy code</button>
      <button class="btn small ghost" data-act="edit" data-id="${esc(s.id)}">Edit</button>
      <button class="btn small ${sure ? 'danger' : 'ghost'}" data-act="delete" data-id="${esc(s.id)}">${sure ? 'Tap again to delete' : 'Delete'}</button>
    </div></div>`;
}

/* ---- new / edit sheet ---- */
function openSheet(id) {
  const s = id ? state.skills[id] : null; state.editing = id || null;
  const sh = $('#sheet'); sh.hidden = false;
  sh.innerHTML = `<div class="sheet-card" role="dialog" aria-modal="true" aria-label="${s ? 'Edit part' : 'New part'}">
    <div class="sheet-head"><h2>${s ? 'Edit part' : 'New part'}</h2><button class="btn ghost small" data-act="sheet-close">Close</button></div>
    <label for="f-name">Name</label><input id="f-name" value="${esc(s ? s.name : '')}" placeholder="fadeIn, card styles, hero markup…" autocomplete="off">
    <div class="two"><div><label for="f-kind">Kind</label><select id="f-kind">${[['fn', 'Function'], ['component', 'Component'], ['class', 'Class'], ['data', 'Data / constants'], ['css', 'Styles'], ['html', 'Markup'], ['skill', 'Instructions (skill)']].map(([k, l]) => `<option value="${k}"${s && s.kind === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <div><label for="f-tags">Tags</label><input id="f-tags" value="${esc(s ? s.tags.join(', ') : '')}" placeholder="animation, canvas" autocomplete="off"></div></div>
    <label for="f-summary">What it does and when to reach for it</label><textarea id="f-summary" rows="2" placeholder="One or two sentences a future build can search for.">${esc(s ? s.summary : '')}</textarea>
    <label for="f-code">Code or instructions</label><textarea id="f-code" class="mono" rows="10" spellcheck="false" placeholder="Paste the code here">${esc(s ? s.code : '')}</textarea>
    <div class="sheet-foot"><button class="btn" data-act="sheet-save">${s ? 'Save changes' : 'Add to bin'}</button></div></div>`;
  setTimeout(() => $('#f-name').focus(), 30);
}
function saveSheet() {
  const name = $('#f-name').value.trim(), code = $('#f-code').value; const kind = $('#f-kind').value;
  if (!name || !code.trim()) return toast('A part needs a name and some code.');
  const lang = { css: 'css', html: 'html', skill: 'md' }[kind] || 'js'; const old = state.editing ? state.skills[state.editing] : null;
  const s = old ? { ...old } : { id: `${kind}-${slug(name).slice(0, 28)}-${hash('_manual|' + name + kind + Date.now())}`, project: '_manual', path: '', line: 1, hits: 0, created: Date.now(), origin: 'manual', provides: [], requires: [], uses: [], pkgs: [] };
  Object.assign(s, { name, kind, lang, code: code.slice(0, 100000), summary: $('#f-summary').value.trim() || `${sentence(humanize(name))}.`, tags: $('#f-tags').value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 12) });
  if (lang === 'js' && ['fn', 'class', 'component', 'data'].includes(kind)) s.provides = [name];
  s.uses = autoUses(s); state.skills[s.id] = s; rebuild(); persist(s.project); renderStatus(); closeSheet(); state.open = s.id; toast(old ? 'Part updated' : 'Part added'); if (state.tab === 'parts') updateParts();
}
function autoUses(s) {
  if (s.lang !== 'js') return s.uses || []; const ids = new Set(idents(s.code, s.name));
  return all().filter(o => o.id !== s.id && o.lang === 'js' && o.provides[0] && o.provides[0].length >= 4 && ids.has(o.provides[0])).map(o => o.id);
}
function closeSheet() { const sh = $('#sheet'); sh.hidden = true; sh.innerHTML = ''; state.editing = null; }

/* ---- export ---- */
async function exportZip() {
  const list = all(); if (!list.length) return; const byId = state.skills; const used = new Set(); const files = [];
  for (const s of list) {
    let dir = slug(s.name); while (used.has(dir)) dir += '-' + hash(s.id); used.add(dir);
    files.push({ name: `${dir}/SKILL.md`, data: skillMd(s, byId) });
    if (!['skill'].includes(s.kind)) files.push({ name: `${dir}/part.${EXT_OF[s.lang] || 'txt'}`, data: s.code });
  }
  files.unshift({ name: 'README.md', data: `# Kitbash skills\n\n${list.length} parts exported ${new Date().toISOString().slice(0, 10)}. Each folder holds a SKILL.md (what it is and when to use it) and the raw code.\n` });
  await saveFile('kitbash-skills.zip', makeZip(files), 'Skills exported');
}

/* ================= IMPORT ================= */
function viewImport() {
  $('#view').innerHTML = `
  <section class="page">
    <div class="intro"><h1>Feed the bin</h1><p>Add a project. Kitbash reads every file, lifts out the reusable pieces — functions, components, styles, markup, shaders — and remembers each one as a mini skill you can recall later instead of rewriting.</p></div>
    <div class="intake">
      <div class="seg" role="tablist">${[['folder', 'Folder'], ['files', 'Files'], ['paste', 'Paste']].map(([k, l]) => `<button role="tab" data-act="intake" data-k="${k}" class="${state.intake === k ? 'on' : ''}" aria-selected="${state.intake === k}">${l}</button>`).join('')}</div>
      <div id="intake-body"></div>
    </div>
    <div id="ws"></div>
  </section>`;
  renderIntake(); renderWorkspace();
}
function renderIntake() {
  const b = $('#intake-body'); if (!b) return;
  if (state.intake === 'folder') b.innerHTML = `<label class="drop" id="drop" for="in-folder"><strong>Choose a folder</strong><span>or drag one in — node_modules, .git and build output are skipped</span><input id="in-folder" type="file" webkitdirectory multiple hidden></label><p class="hint">Phones often can’t pick folders — use Files or Paste instead.</p>`;
  else if (state.intake === 'files') b.innerHTML = `<label class="drop" id="drop" for="in-files"><strong>Choose files</strong><span>.js .ts .jsx .tsx .css .html .py .glsl .svg .json .md</span><input id="in-files" type="file" multiple hidden></label>`;
  else b.innerHTML = `<div class="paste"><label for="p-name">File name</label><input id="p-name" value="snippet.js" autocomplete="off"><label for="p-text">Code</label><textarea id="p-text" class="mono" rows="7" spellcheck="false" placeholder="Paste a file’s contents"></textarea><button class="btn" data-act="paste-add">Read it</button></div>`;
}

async function ingest(files) {
  files = [...files]; if (!files.length) return; state.busy = `Reading ${files.length} file${files.length === 1 ? '' : 's'}…`; renderWorkspace();
  const groups = new Map();
  for (const f of files) {
    const rel = f.webkitRelativePath || f._rel || f.name; const segs = rel.split('/').filter(Boolean); const rooted = segs.length > 1;
    const project = rooted ? segs[0] : (f._project || 'Loose files'); const path = rooted ? segs.slice(1).join('/') : rel;
    if (!groups.has(project)) groups.set(project, { name: project, sample: false, files: [], skipped: [] });
    const g = groups.get(project);
    if (IGNORE_DIR.test('/' + path)) { g.skipped.push({ path, reason: 'ignored folder' }); continue; }
    if (/\.min\.(js|css)$/.test(path)) { g.skipped.push({ path, reason: 'minified' }); continue; }
    if (!fileLang(path)) { g.skipped.push({ path, reason: 'not code' }); continue; }
    if (f.size > 400000) { g.skipped.push({ path, reason: 'over 400 KB' }); continue; }
    try { g.files.push({ path, text: await f.text() }); } catch { g.skipped.push({ path, reason: 'unreadable' }); }
  }
  for (const g of groups.values()) addProject(g);
  state.busy = ''; renderWorkspace();
}
function addProject(g) {
  const cands = extractProject(g.name, g.files); const p = { ...g, cands, sel: new Set(cands.map(c => c.id)), open: false };
  const i = state.ws.findIndex(x => x.name === g.name); if (i >= 0) state.ws[i] = p; else state.ws.unshift(p);
}
async function entriesToFiles(items) {
  const out = [];
  const walk = entry => new Promise(res => {
    if (entry.isFile) entry.file(f => { f._rel = entry.fullPath.replace(/^\//, ''); out.push(f); res(); }, () => res());
    else { const r = entry.createReader(); const all2 = []; const pull = () => r.readEntries(async es => { if (!es.length) { for (const e of all2) await walk(e); res(); } else { all2.push(...es); pull(); } }, () => res()); pull(); }
  });
  for (const it of items) { const e = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (e) await walk(e); }
  return out;
}

function treeText(p) {
  const counts = {}; p.cands.forEach(c => { counts[c.path] = (counts[c.path] || 0) + 1; });
  const paths = [...p.files.map(f => f.path), ...p.skipped.map(s => s.path)].sort(); const seen = new Set(); const lines = [];
  const skipMap = Object.fromEntries(p.skipped.map(s => [s.path, s.reason]));
  for (const path of paths) {
    const segs = path.split('/');
    for (let i = 0; i < segs.length - 1; i++) { const d = segs.slice(0, i + 1).join('/'); if (!seen.has(d)) { seen.add(d); lines.push('  '.repeat(i) + segs[i] + '/'); } }
    lines.push('  '.repeat(segs.length - 1) + segs[segs.length - 1] + (skipMap[path] ? `  — skipped (${skipMap[path]})` : `  → ${counts[path] || 0} part${(counts[path] || 0) === 1 ? '' : 's'}`));
  }
  return lines.join('\n');
}
function renderWorkspace() {
  const box = $('#ws'); if (!box) return;
  const busy = state.busy ? `<div class="busy"><i></i>${esc(state.busy)}</div>` : '';
  const next = state.next ? `<div class="next"><p><b>Stored.</b> Now put them to work: describe something new and Kitbash will recall these parts and assemble it.</p><button class="btn" data-act="try-build">Try it in Build →</button></div>` : '';
  box.innerHTML = next + busy + state.ws.map((p, pi) => {
    const byFile = new Map(); p.cands.forEach(c => { if (!byFile.has(c.path)) byFile.set(c.path, []); byFile.get(c.path).push(c); });
    const n = p.sel.size; const known = p.cands.filter(c => state.skills[c.id]).length;
    return `<section class="proj" data-pi="${pi}">
      <header class="proj-head"><div><h2>${esc(p.name)}${p.sample ? '<span class="pill">Sample project</span>' : ''}</h2>
      <p>${p.files.length} file${p.files.length === 1 ? '' : 's'} read · ${p.cands.length} part${p.cands.length === 1 ? '' : 's'} found${p.skipped.length ? ` · ${p.skipped.length} skipped` : ''}${known ? ` · ${known} already in bin` : ''}</p></div></header>
      <details class="tree"><summary>Folder map</summary><pre>${esc(treeText(p))}</pre></details>
      <div class="proj-actions">
        <button class="btn" data-act="memorize" data-pi="${pi}" ${n ? '' : 'disabled'}>Memorize ${n} part${n === 1 ? '' : 's'}</button>
        ${state.caps.sample ? `<button class="btn ghost" data-act="polish" data-pi="${pi}" ${p.polishing ? 'disabled' : ''}>${p.polishing ? esc(p.polishing) : 'Sharpen summaries with Claude'}</button>` : ''}
        <button class="link" data-act="sel-all" data-pi="${pi}">${n === p.cands.length ? 'Select none' : 'Select all'}</button>
      </div>
      ${[...byFile].map(([path, cs]) => `<details class="file" ${cs.length <= 6 || p.sample ? 'open' : ''}><summary><span class="fp">${esc(path)}</span><i>${cs.length}</i></summary>
        ${cs.map(c => { const [lab, grp] = kindInfo(c.kind); return `<label class="cand g-${grp}"><input type="checkbox" data-act="cand" data-pi="${pi}" data-id="${esc(c.id)}" ${p.sel.has(c.id) ? 'checked' : ''}><span class="lab">${lab}</span><span class="cbody"><b>${esc(c.name)}</b><span>${esc(c.summary)}</span>${c.uses.length ? `<em>builds on ${c.uses.map(u => esc((p.cands.find(x => x.id === u) || {}).name || '')).filter(Boolean).slice(0, 4).join(', ')}</em>` : ''}</span></label>`; }).join('')}
      </details>`).join('') || '<p class="hint">No reusable parts found in these files.</p>'}
    </section>`;
  }).join('');
}
function memorize(pi) {
  const p = state.ws[pi]; if (!p) return; let fresh = 0, upd = 0;
  for (const c of p.cands) {
    if (!p.sel.has(c.id)) continue; const old = state.skills[c.id];
    if (old) { upd++; state.skills[c.id] = { ...c, hits: old.hits, created: old.created }; } else { fresh++; state.skills[c.id] = { ...c }; }
  }
  rebuild(); persist(p.name); renderStatus(); renderWorkspace();
  toast(`Memorized ${fresh} new${upd ? `, refreshed ${upd}` : ''} · recall them in Parts`);
  if (p.sample) { state.next = true; renderWorkspace(); }
}

async function polish(pi) {
  const p = state.ws[pi]; const sample = state.caps.sample; if (!p || !sample || p.polishing) return;
  const list = p.cands.filter(c => p.sel.has(c.id)); const size = 12; let done = 0;
  try {
    for (let i = 0; i < list.length; i += size) {
      p.polishing = `Sharpening ${Math.min(i + size, list.length)}/${list.length}…`; renderWorkspace();
      const batch = list.slice(i, i + size);
      const prompt = `You label reusable code parts for a searchable library. For every part below write:\n- "summary": ONE sentence (max 140 characters) saying what it does and when someone would reach for it. Plain words, no code.\n- "tags": 3 to 6 lowercase single-word search terms a person might type.\nReturn only JSON: {"parts":[{"i":0,"summary":"...","tags":["..."]}]}\n\n` +
        batch.map((c, k) => `### ${k}. ${c.name} (${c.kind}, ${c.lang})\n${c.code.slice(0, 700)}`).join('\n\n');
      const res = await sample.json(prompt, { modelTier: 'quick', cache: false });
      for (const r of (res && res.parts) || []) { const c = batch[r.i]; if (!c) continue; if (typeof r.summary === 'string' && r.summary.trim()) { c.summary = r.summary.trim().slice(0, 220); done++; } if (Array.isArray(r.tags)) c.tags = [...new Set([...r.tags.map(t => String(t).toLowerCase().slice(0, 24)), ...c.tags])].slice(0, 12); }
    }
    toast(`Sharpened ${done} summaries`);
  } catch (e) { if (e && e.code === 'not_granted') { state.caps.sample = null; toast('Claude access wasn’t granted'); } else toast('Couldn’t reach Claude: ' + ((e && e.message) || 'try again')); }
  p.polishing = ''; renderWorkspace();
}

/* ================= BUILD ================= */
function viewBuild() {
  $('#view').innerHTML = `
  <section class="page">
    <div class="intro"><h1>Build something bigger</h1><p>Describe what you want. Kitbash recalls the parts that fit, pulls in whatever they depend on, and assembles a working page — no starting from scratch.</p></div>
    <label class="lbl" for="goal">What are you making?</label>
    <textarea id="goal" rows="3" placeholder="A pulsing starfield with a title, a card grid that uses my theme…">${esc(state.build.goal)}</textarea>
    <div class="row"><button class="btn" data-act="plan">Find parts</button><span class="hint" id="planhint"></span></div>
    <div id="plan"></div>
    <div id="result"></div>
  </section>`;
  renderPlan(); renderResult();
}
function planNow() {
  const goal = $('#goal') ? $('#goal').value.trim() : state.build.goal; state.build.goal = goal;
  if (!all().length) { state.build.plan = { items: [], empty: true }; return renderPlan(); }
  const rows = recall(state.index, goal, 14); const items = rows.filter((r, i) => r.rel >= 0.2 || i < 3).slice(0, 10).map(r => ({ id: r.s.id, rel: r.rel, on: r.rel >= 0.3, pinned: false }));
  for (const id of state.build.pinned) { const it = items.find(x => x.id === id); if (it) { it.on = true; it.pinned = true; } else if (state.skills[id]) items.unshift({ id, rel: 1, on: true, pinned: true }); }
  // wiring code that ties the chosen parts together
  const chosen = closure(items.filter(i => i.on).map(i => i.id), state.skills);
  for (const s of all()) {
    if (s.kind !== 'entry' || (s.uses || []).length < 2) continue;
    const hit = s.uses.filter(u => chosen.includes(u)).length; if (hit / s.uses.length < 0.5) continue;
    const ex = items.find(i => i.id === s.id);
    if (ex) Object.assign(ex, { on: true, wiring: true }); else items.push({ id: s.id, rel: 0.5, on: true, pinned: false, wiring: true });
  }
  state.build.plan = { items }; state.build.result = null; renderPlan(); renderResult();
}
function checkedIds() { return state.build.plan ? state.build.plan.items.filter(i => i.on && state.skills[i.id]).map(i => i.id) : []; }
function renderPlan() {
  const box = $('#plan'); if (!box) return; const pl = state.build.plan;
  if (!pl) { box.innerHTML = state.build.pinned.size ? `<p class="hint">${state.build.pinned.size} part${state.build.pinned.size === 1 ? '' : 's'} pinned from Parts.</p>` : ''; return; }
  if (pl.empty) { box.innerHTML = `<div class="empty"><h2>Nothing to build from yet</h2><p>Memorize a project first — the sample in Import takes one tap.</p><button class="btn" data-act="tab" data-tab="import">Go to Import</button></div>`; return; }
  const ids = checkedIds(); const asm = ids.length ? closure(ids, state.skills) : []; const pulled = asm.filter(id => !ids.includes(id));
  box.innerHTML = `<div class="planhead"><h2>Recalled parts</h2><span>${ids.length} chosen${pulled.length ? ` + ${pulled.length} they depend on` : ''}</span></div>
  <div class="plan">${pl.items.map((it, k) => { const s = state.skills[it.id]; if (!s) return ''; const [lab, grp] = kindInfo(s.kind);
    return `<label class="cand g-${grp}"><input type="checkbox" data-act="plan-toggle" data-k="${k}" ${it.on ? 'checked' : ''}><span class="lab">${lab}</span><span class="cbody"><b>${esc(s.name)}${it.pinned ? '<span class="pill">pinned</span>' : ''}${it.wiring ? '<span class="pill">wires these together</span>' : ''}</b><span>${esc(s.summary)}</span><em>${esc(s.path ? projLabel(s.project) + '/' + s.path : projLabel(s.project))}</em></span><span class="rel"><i style="width:${Math.max(8, Math.round(it.rel * 100))}%"></i></span></label>`; }).join('') || '<p class="hint">No parts match that description. Try different words, or pin parts from the Parts tab.</p>'}</div>
  ${pulled.length ? `<p class="deps"><b>Pulled in as dependencies:</b> ${pulled.map(id => esc(state.skills[id].name)).join(', ')}</p>` : ''}
  <div class="row wrap"><button class="btn" data-act="assemble" ${ids.length ? '' : 'disabled'}>Assemble page</button>
    ${state.caps.sample ? `<button class="btn ghost" data-act="weave" ${ids.length && !state.build.weaving ? '' : 'disabled'}>${state.build.weaving ? 'Weaving…' : 'Weave with Claude'}</button>` : ''}
    ${state.build.weaving ? '<button class="link" data-act="stop">Stop</button>' : ''}</div>
  <p class="hint">${state.caps.sample ? 'Assemble stitches the parts together exactly as stored. Weave lets Claude write the glue so they fit your goal.' : 'Assemble stitches the parts together exactly as stored.'}</p>`;
}
function bumpHits(ids) { const touched = new Set(); ids.forEach(id => { const s = state.skills[id]; if (s) { s.hits = (s.hits || 0) + 1; touched.add(s.project); } }); rebuild(); touched.forEach(persist); }

function doAssemble() {
  const ids = checkedIds(); if (!ids.length) return; const r = assemble(ids, state.skills, state.build.goal);
  state.build.result = { html: r.html, notes: r.notes, order: r.order, how: 'assembled', ids }; state.build.view = 'preview'; bumpHits(r.order); renderResult();
  requestAnimationFrame(() => { const el = $('#result'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}
function extractHtmlBlock(text) {
  const m = /```html\s*\n([\s\S]*?)```/.exec(text) || /```\s*\n(<!doctype[\s\S]*?)```/i.exec(text); if (m) return m[1].trim() + '\n';
  const open = /```html\s*\n([\s\S]*)$/.exec(text); if (open) return open[1].trim() + '\n';
  const d = /<!doctype html[\s\S]*<\/html>/i.exec(text); return d ? d[0] + '\n' : '';
}
async function weave() {
  const sample = state.caps.sample; const ids = checkedIds(); if (!sample || !ids.length || state.build.weaving) return;
  const order = closure(ids, state.skills); let budget = 60000; const blocks = [];
  for (const id of order) { const s = state.skills[id]; const code = s.code.length <= budget ? s.code : s.code.slice(0, 400) + '\n/* … truncated … */'; budget -= code.length; blocks.push(`### ${s.name} — ${s.kind}, ${s.lang}${s.path ? ` (from ${s.project}/${s.path})` : ''}\n${s.summary}\n\`\`\`${LANG_FENCE[s.lang] || ''}\n${code}\n\`\`\``); }
  const prompt = `You are assembling a small, working single-file web page out of reusable parts the user already wrote and stored in their parts bin.\n\nGOAL: ${state.build.goal}\n\nRules:\n- Reuse the parts' code verbatim wherever it fits; keep their names. Drop parts that don't serve the goal.\n- Add only the glue needed: wiring, markup, small tweaks so the parts work together and match the goal.\n- Strip ES-module import/export syntax (everything lives in one file).\n- One HTML file, all CSS and JS inline. No external requests except cdnjs.cloudflare.com if a part needs React or three.js.\n- Reply with a single \`\`\`html code block and one short sentence after it saying what you changed.\n\nPARTS:\n\n${blocks.join('\n\n')}`;
  const ac = new AbortController(); Object.assign(state.build, { weaving: true, abort: ac, stream: '', view: 'code', result: { html: '', notes: [], order, how: 'weaving', ids } }); renderPlan(); renderResult();
  try {
    const res = await sample(prompt, { signal: ac.signal, modelTier: 'complex', cache: false, onText: ({ text }) => { state.build.stream = text; const c = $('#stream'); if (c) { c.textContent = extractHtmlBlock(text) || text; c.scrollTop = c.scrollHeight; } } });
    const html = extractHtmlBlock(res.text); const notes = [];
    if (!html) notes.push('Claude’s reply had no HTML block — nothing to preview.'); if (res.truncated) notes.push('The reply was cut off; the page may be incomplete.');
    const tail = res.text.split('```').pop().trim(); if (tail && html) notes.push('Claude: ' + tail.slice(0, 300));
    state.build.result = { html, notes, order, how: 'woven', ids }; state.build.view = html ? 'preview' : 'notes'; if (html) bumpHits(order);
  } catch (e) {
    const partial = e && e.text ? extractHtmlBlock(e.text) : '';
    if (e && e.code === 'cancelled') toast('Stopped'); else if (e && e.code === 'not_granted') { state.caps.sample = null; toast('Claude access wasn’t granted'); } else toast('Claude couldn’t finish: ' + ((e && e.message) || 'try again'));
    state.build.result = partial ? { html: partial, notes: ['Stopped early — partial page.'], order, how: 'partial', ids } : null;
  }
  state.build.weaving = false; renderPlan(); renderResult();
}
function renderResult() {
  const box = $('#result'); if (!box) return; const r = state.build.result; if (!r) { box.innerHTML = ''; return; }
  const v = state.build.view; const lines = r.html ? r.html.split('\n').length : 0;
  const tabs = [['preview', 'Preview'], ['code', 'Code'], ['notes', `Notes${r.notes.length ? ` (${r.notes.length})` : ''}`]];
  box.innerHTML = `<div class="planhead"><h2>${r.how === 'weaving' ? 'Weaving…' : r.how === 'woven' ? 'Woven by Claude' : r.how === 'partial' ? 'Partial build' : 'Assembled'}</h2><span>${r.order.length} part${r.order.length === 1 ? '' : 's'}${lines ? ` · ${lines} lines` : ''}</span></div>
  <div class="seg small" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-act="rview" data-k="${k}" class="${v === k ? 'on' : ''}" aria-selected="${v === k}">${l}</button>`).join('')}</div>
  <div class="resbody">${v === 'preview' ? (r.html ? '<iframe id="pv" title="Build preview" sandbox="allow-scripts"></iframe>' : '<p class="hint pad">Nothing to preview yet.</p>')
      : v === 'code' ? `<pre class="code big" id="stream" tabindex="0">${esc(r.how === 'weaving' ? (extractHtmlBlock(state.build.stream) || state.build.stream || 'Waiting for Claude…') : r.html)}</pre>`
        : `<ul class="notes">${r.notes.length ? r.notes.map(n => `<li>${esc(n)}</li>`).join('') : '<li>No warnings.</li>'}<li>Parts used: ${r.order.map(id => esc((state.skills[id] || {}).name || id)).join(' → ')}</li></ul>`}</div>
  ${r.html && r.how !== 'weaving' ? `<div class="row wrap"><button class="btn" data-act="save-build">Save as a new part</button><button class="btn ghost" data-act="dl-build">Download .html</button><button class="btn ghost" data-act="copy-build">Copy code</button></div>
  <p class="hint">Saving turns this build into a part of its own — later builds can start from it.</p>` : ''}`;
  if (v === 'preview' && r.html) $('#pv').srcdoc = r.html;
}
function saveBuild() {
  const r = state.build.result; if (!r || !r.html) return; const goal = state.build.goal || 'Untitled build';
  const s = { id: `composite-${slug(goal).slice(0, 28)}-${hash(goal + Date.now())}`, name: sentence(goal).slice(0, 60), kind: 'composite', lang: 'html', code: r.html.slice(0, 100000), project: '_builds', path: '', line: 1,
    summary: `Finished build (${r.how}) from ${r.order.length} parts for: ${goal.slice(0, 120)}`, tags: ['build', 'project', 'composite', ...tok(goal)].slice(0, 12), provides: [], requires: [], uses: r.order.slice(), pkgs: [], hits: 0, created: Date.now(), origin: 'build' };
  state.skills[s.id] = s; rebuild(); persist('_builds'); renderStatus(); toast('Saved to Parts as a build — ready to reuse');
}

/* ================= events ================= */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return; const act = t.dataset.act; const id = t.dataset.id;
  switch (act) {
    case 'tab': showTab(t.dataset.tab); break;
    case 'group': state.group = t.dataset.g; updateParts(); break;
    case 'toggle': state.open = state.open === id && !t.dataset.jump ? null : id; state.confirm = null; if (t.dataset.jump) { state.q = ''; state.group = 'all'; if (state.tab === 'parts') viewParts(); } updateParts(); if (t.dataset.jump) setTimeout(() => { const el = document.querySelector(`.part[data-id="${CSS.escape(id)}"]`); if (el) el.scrollIntoView({ block: 'center' }); }, 30); break;
    case 'pin': state.build.pinned.has(id) ? state.build.pinned.delete(id) : state.build.pinned.add(id); toast(state.build.pinned.has(id) ? 'Pinned — it will be included in your next build' : 'Unpinned'); updateParts(); break;
    case 'copy-md': copyText(skillMd(state.skills[id], state.skills), 'SKILL.md copied'); break;
    case 'copy-code': copyText(state.skills[id].code, 'Code copied'); break;
    case 'edit': openSheet(id); break;
    case 'delete': if (state.confirm === id) { const p = state.skills[id].project; delete state.skills[id]; state.confirm = null; state.open = null; rebuild(); persist(p); renderStatus(); toast('Deleted'); } else state.confirm = id; updateParts(); break;
    case 'new': openSheet(null); break;
    case 'sheet-close': closeSheet(); break;
    case 'sheet-save': saveSheet(); break;
    case 'export': exportZip(); break;
    case 'intake': state.intake = t.dataset.k; viewImport(); break;
    case 'paste-add': { const name = $('#p-name').value.trim() || 'snippet.js'; const text = $('#p-text').value; if (!text.trim()) return toast('Paste some code first.'); if (!fileLang(name)) return toast('Give the file a name with an extension, like .js or .css'); const g = { name: 'Pasted', sample: false, files: [{ path: name, text }], skipped: [] }; const ex = state.ws.find(x => x.name === 'Pasted'); if (ex) g.files.unshift(...ex.files.filter(f => f.path !== name)); addProject(g); renderWorkspace(); break; }
    case 'memorize': memorize(+t.dataset.pi); break;
    case 'sel-all': { const p = state.ws[+t.dataset.pi]; if (p.sel.size === p.cands.length) p.sel.clear(); else p.cands.forEach(c => p.sel.add(c.id)); renderWorkspace(); break; }
    case 'polish': polish(+t.dataset.pi); break;
    case 'try-build': state.build.goal = SAMPLE_GOAL; state.build.plan = null; state.build.result = null; showTab('build'); planNow(); break;
    case 'plan': planNow(); break;
    case 'assemble': doAssemble(); break;
    case 'weave': weave(); break;
    case 'stop': if (state.build.abort) state.build.abort.abort(); break;
    case 'rview': state.build.view = t.dataset.k; renderResult(); break;
    case 'save-build': saveBuild(); break;
    case 'dl-build': saveFile('kitbash-build.html', state.build.result.html, 'Build saved'); break;
    case 'copy-build': copyText(state.build.result.html, 'Code copied'); break;
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'in-folder' || t.id === 'in-files') { ingest(t.files); t.value = ''; }
  else if (t.id === 'sort') { state.sort = t.value; updateParts(); }
  else if (t.dataset.act === 'cand') { const p = state.ws[+t.dataset.pi]; t.checked ? p.sel.add(t.dataset.id) : p.sel.delete(t.dataset.id); const b = $(`[data-act="memorize"][data-pi="${t.dataset.pi}"]`); if (b) { b.disabled = !p.sel.size; b.textContent = `Memorize ${p.sel.size} part${p.sel.size === 1 ? '' : 's'}`; } }
  else if (t.dataset.act === 'plan-toggle') { state.build.plan.items[+t.dataset.k].on = t.checked; renderPlan(); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { state.q = e.target.value; updateParts(); }
  else if (e.target.id === 'goal') state.build.goal = e.target.value;
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
document.addEventListener('dragover', e => { if ($('#drop')) { e.preventDefault(); $('#drop').classList.add('over'); } });
document.addEventListener('dragleave', e => { if ($('#drop') && !e.relatedTarget) $('#drop').classList.remove('over'); });
document.addEventListener('drop', async e => {
  const d = $('#drop'); if (!d) return; e.preventDefault(); d.classList.remove('over');
  const items = e.dataTransfer && e.dataTransfer.items ? [...e.dataTransfer.items] : [];
  const files = items.length && items[0].webkitGetAsEntry ? await entriesToFiles(items) : [...e.dataTransfer.files]; ingest(files);
});

/* ================= boot ================= */
async function boot() {
  shell(); renderStatus();
  addProject({ name: 'starfield', sample: true, files: SAMPLE_FILES.filter(f => !f.skip).map(f => ({ path: f.path, text: f.text })), skipped: SAMPLE_FILES.filter(f => f.skip).map(f => ({ path: f.path, reason: f.skip })) });
  showTab('import');
  const [rows, sample, dl, mcp] = await Promise.all([Backend.init(), cap('sample'), cap('downloads'), cap('mcp')]);
  state.caps.sample = sample; state.caps.downloads = dl; state.caps.mcp = mcp;
  if (!state.caps.mcp && document.querySelector('meta[name="kitbash-server"]')) { state.caps.mcp = teamServerMcp(); team.standalone = true; }   // served by its own workspace server
  if (state.tab === 'team' && team.status !== 'ok') { team.status = 'idle'; viewTeam(); }
  for (const r of rows) { const d = r.data || {}; if (!d.project || !Array.isArray(d.skills)) continue; state.packCounts[d.project] = Math.max(state.packCounts[d.project] || 0, (d.i || 0) + 1); for (const s of d.skills) state.skills[s.id] = s; }
  rebuild(); renderStatus();
  const known = state.ws[0] && state.ws[0].cands.filter(c => state.skills[c.id]).length; if (state.tab === 'import') renderWorkspace(); else if (state.tab === 'build') renderPlan();
  if (all().length && known !== undefined && state.tab === 'import' && !state.ws.some(w => !w.sample)) showTab('parts');
}
boot();
