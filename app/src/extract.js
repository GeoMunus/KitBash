/* ================= utilities ================= */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x';
const hash = s => { let h = 5381; s = String(s); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36).slice(0, 6); };
const humanize = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.\s]+/g, ' ').trim().toLowerCase();
const sentence = s => { s = String(s).replace(/\s+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; };
const baseName = p => p.split('/').pop();
const lineAt = (src, idx) => { let n = 1; for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++; return n; };
const MAX_CODE = 40000;

const IGNORE_DIR = /(^|\/)(node_modules|\.git|dist|build|\.next|\.cache|coverage|vendor|__pycache__|\.venv|\.idea|\.vscode)(\/|$)/;
const EXT_LANG = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', py: 'py', glsl: 'glsl', frag: 'glsl', vert: 'glsl', wgsl: 'glsl', svg: 'svg', md: 'md', json: 'json' };
const fileLang = p => { const m = /\.([a-z0-9]+)$/i.exec(p); return m ? EXT_LANG[m[1].toLowerCase()] || null : null; };

const FEATURES = [
  [/getContext\(\s*['"]2d/, 'canvas'], [/getContext\(\s*['"]webgl/, 'webgl'], [/\bTHREE\b|from\s+['"]three/, 'three'],
  [/\buse(State|Effect|Ref|Memo|Callback)\b/, 'react'], [/requestAnimationFrame/, 'animation'], [/\bfetch\(/, 'network'],
  [/AudioContext|new Audio\(/, 'audio'], [/localStorage|indexedDB/, 'storage'], [/addEventListener|onclick|onClick/, 'events'],
  [/document\.|querySelector|getElementById/, 'dom'], [/Math\.random/, 'random'], [/var\(--/, 'theme'],
  [/@keyframes|animation\s*:/, 'animation'], [/@media/, 'responsive'], [/grid-template|display:\s*grid/, 'grid'],
  [/display:\s*flex/, 'flex'], [/Math\.(sin|cos|atan2|sqrt|hypot)/, 'math'], [/\basync\b|\bawait\b|Promise/, 'async']
];
const featureTags = code => [...new Set(FEATURES.filter(([re]) => re.test(code)).map(f => f[1]))];

/* ================= JS statement scanner ================= */
function scanJS(src) {
  const n = src.length; let i = 0, depth = 0, start = -1, last = '', last2 = ''; const out = [];
  const skipStr = q => { i++; while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } i++; };
  const skipTpl = () => {
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') i += 2;
      else if (src[i] === '$' && src[i + 1] === '{') {
        i += 2; let d = 1;
        while (i < n && d) { const c = src[i]; if (c === '{') d++; else if (c === '}') d--; else if (c === '`') { skipTpl(); continue; } else if (c === '"' || c === "'") { skipStr(c); continue; } i++; }
      } else i++;
    }
    i++;
  };
  const push = (a, b) => { if (b > a) out.push({ start: a, end: b }); };
  const nextChar = () => { let j = i; while (j < n && /\s/.test(src[j])) j++; return src[j] || ''; };
  const nextWord = () => (/^\s*([A-Za-z]+)/.exec(src.slice(i, i + 40)) || [])[1] || '';
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") { if (start < 0) start = i; skipStr(c); last = '"'; last2 = ''; continue; }
    if (c === '`') { if (start < 0) start = i; skipTpl(); last = '"'; last2 = ''; continue; }
    if (c === '/' && (last === '' || /[(,=:[!&|?{};]/.test(last))) {
      if (start < 0) start = i;
      i++; let cls = false;
      while (i < n && src[i] !== '\n' && (src[i] !== '/' || cls)) { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++; }
      i++; last = '"'; last2 = ''; continue;
    }
    if (/\s/.test(c)) {
      if (c === '\n' && depth === 0 && start >= 0) {
        const nc = nextChar();
        const cont = /[=,+*/%&|?:<([!~^-]/.test(last) || last2 === '=>' || /[.?:+*/%&|,)\]]/.test(nc);
        if (!cont && !/^(else|catch|finally)$/.test(nextWord())) { push(start, i); start = -1; last = ''; }
      }
      i++; continue;
    }
    if (start < 0) start = i;
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { depth = Math.max(0, depth - 1); }
    else if (c === ';' && depth === 0) { i++; push(start, i); start = -1; last = ''; last2 = ''; continue; }
    last2 = last + c; last = c; i++;
    if (c === '}' && depth === 0) {
      const head = src.slice(start, start + 120);
      if (/^(export\s+)?(default\s+)?(async\s+)?(function|class)\b|^(if|for|while|switch|try|do)\b|^(export\s+)?(interface|enum|namespace)\b/.test(head)) {
        const nw = nextWord(), nc = nextChar();
        if (!/^(else|catch|finally|while)$/.test(nw) && !/[,.)]/.test(nc)) { push(start, i); start = -1; last = ''; last2 = ''; }
      }
    }
  }
  if (start >= 0) push(start, n);
  return out;
}

function leadingComment(src, idx) {
  const before = src.slice(0, idx).replace(/[ \t]*$/, '');
  const t = before.replace(/\s+$/, '');
  if (t.endsWith('*/')) {
    const s = t.lastIndexOf('/*');
    if (s >= 0 && /^\s*$/.test(before.slice(t.length))) return { text: t.slice(s), start: s };
  }
  const lines = t.split('\n'); const got = []; let pos = t.length;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (/^\s*\/\//.test(lines[k]) && before.slice(t.length).split('\n').length <= 2) { got.unshift(lines[k]); pos -= lines[k].length + 1; } else break;
  }
  if (got.length) return { text: got.join('\n'), start: Math.max(0, pos + 1) };
  return null;
}
const docSummary = c => {
  if (!c) return '';
  const t = c.replace(/^\/\*+|\*+\/$/g, '').replace(/^\s*(\*|\/\/+)\s?/gm, '').replace(/@\w+.*$/gm, '').trim();
  return sentence(t.split(/\n\s*\n|(?<=[.!?])\s/)[0] || '').slice(0, 220);
};

const IDENT = /[A-Za-z_$][\w$]*/g;
const JSX_RE = /(return\s*\(?\s*<|=>\s*\(?\s*<|React\.createElement|<>\s*<)/;

function jsDeclarations(src) {
  const decls = [], loose = [], imports = [];
  for (const st of scanJS(src)) {
    const text = src.slice(st.start, st.end); const head = text.slice(0, 500); let m;
    if (/^import\b/.test(head)) { const s = /from\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]/.exec(head); if (s) imports.push(s[1] || s[2]); continue; }
    if (/^export\s*(\{|\*)/.test(head)) continue;
    const h2 = head.replace(/^export\s+(default\s+)?/, '');
    let name = null, type = null;
    if ((m = /^(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(h2))) { name = m[1]; type = 'function'; }
    else if ((m = /^class\s+([\w$]+)/.exec(h2))) { name = m[1]; type = 'class'; }
    else if ((m = /^(interface|type|enum)\s+([\w$]+)/.exec(h2))) { name = m[2]; type = 'type'; }
    else if ((m = /^(?:const|let|var)\s+([\w$]+)\s*(?::[^=]{0,80})?=\s*([\s\S]*)/.exec(h2))) {
      name = m[1]; const rhs = m[2];
      const arrow = /^(async\s*)?(\(|[\w$]+\s*=>)/.test(rhs) && /=>/.test(rhs.slice(0, 320));
      if (arrow || /^(async\s+)?function\b/.test(rhs) || /^(React\.)?(memo|forwardRef)\(/.test(rhs)) type = 'function';
      else {
        const lines = text.split('\n').length;
        if (/^([[{`]|new\s|Object\.)/.test(rhs) && ((text.length >= 140 && lines >= 3) || (/^[A-Z][A-Z0-9_]+$/.test(name) && text.length >= 40))) type = 'value';
      }
    }
    if (!type) { loose.push(st); continue; }
    if (text.length > MAX_CODE) continue;
    const cm = leadingComment(src, st.start);
    const clean = text.replace(/^export\s+(default\s+)?(?=(async\s+)?function|class|const|let|var|interface|type|enum)/, '');
    decls.push({ name, type, start: st.start, code: (cm ? cm.text + '\n' : '') + clean, comment: cm && cm.text, line: lineAt(src, st.start), raw: text });
  }
  return { decls, loose, imports };
}

function paramsOf(code) {
  let m = /^[^(=]*\(([^)]*)\)/.exec(code.replace(/^(\/\*[\s\S]*?\*\/|\/\/.*\n)+/, '').replace(/^\s*(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?/, ''));
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 70) : '';
}

/* ================= per-language extractors ================= */
function mkSkill(ctx, o) {
  const code = o.code.length > MAX_CODE ? o.code.slice(0, MAX_CODE) : o.code;
  const id = `${o.kind}-${slug(o.name).slice(0, 28)}-${hash(ctx.project + '|' + ctx.path + '|' + o.name + '|' + o.kind)}`;
  return {
    id, name: o.name, kind: o.kind, lang: o.lang, summary: o.summary || '', tags: [...new Set(o.tags || [])].slice(0, 12), code,
    project: ctx.project, path: ctx.path, line: o.line || 1, provides: o.provides || [], requires: o.requires || [], uses: [], pkgs: o.pkgs || [],
    hits: 0, created: Date.now(), origin: 'extracted'
  };
}

function extractJS(src, ctx, pathLabel) {
  const out = []; const { decls, loose, imports } = jsDeclarations(src);
  const pkgs = [...new Set(imports.filter(x => !/^[./]/.test(x)).map(x => x.replace(/^(@[^/]+\/[^/]+|[^/]+).*/, '$1')))];
  for (const d of decls) {
    let kind = 'fn';
    if (d.type === 'class') kind = 'class';
    else if (d.type === 'type') kind = 'type';
    else if (d.type === 'value') kind = /void\s+main\s*\(/.test(d.code) ? 'shader' : 'data';
    else if (/^[A-Z]/.test(d.name) && JSX_RE.test(d.code)) kind = 'component';
    const doc = docSummary(d.comment);
    const params = kind === 'fn' || kind === 'component' ? paramsOf(d.code) : '';
    let summary = doc;
    if (!summary) {
      if (kind === 'fn') summary = `${sentence(humanize(d.name))} — function ${d.name}(${params}).`;
      else if (kind === 'component') summary = `${d.name} UI component${params ? ` taking ${params}` : ''}.`;
      else if (kind === 'class') summary = `Class ${d.name}${(/extends\s+([\w$.]+)/.exec(d.code) || [])[1] ? ` extending ${RegExp.$1}` : ''}.`;
      else if (kind === 'shader') summary = `GLSL shader source stored in ${d.name}.`;
      else if (kind === 'type') summary = `Type definition ${d.name}.`;
      else summary = `Constant ${d.name} (${/^\s*\[/.test(d.code.replace(/^[\s\S]*?=\s*/, '')) ? 'list' : 'object'}, ${d.code.split('\n').length} lines).`;
    }
    const tags = [...humanize(d.name).split(' '), kind, ...featureTags(d.code), ...pkgs];
    if (/^use[A-Z]/.test(d.name)) tags.push('hook');
    const s = mkSkill(ctx, { name: d.name, kind, lang: 'js', summary, tags, code: d.code, line: d.line, provides: [d.name], pkgs });
    s.requires = idents(d.code, d.name).concat(domRefs(d.code));
    out.push(s);
  }
  const looseCode = loose.map(l => src.slice(l.start, l.end)).join('\n').trim();
  if (looseCode.length >= 50) {
    const label = pathLabel || baseName(ctx.path);
    const s = mkSkill(ctx, {
      name: `${label} · setup`, kind: 'entry', lang: 'js', line: lineAt(src, loose[0].start), pkgs,
      summary: `Wiring code from ${label}: ${looseCode.split('\n').length} lines that set things up and start them running.`,
      tags: ['entry', 'setup', 'main', ...featureTags(looseCode), ...pkgs], code: looseCode
    });
    s.requires = idents(looseCode, '').concat(domRefs(looseCode));
    out.push(s);
  }
  return out;
}
const idents = (code, self) => [...new Set((code.match(IDENT) || []).filter(x => x.length >= 3 && x !== self))];
const domRefs = code => {
  const r = [];
  for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) r.push('#' + m[1]);
  for (const m of code.matchAll(/querySelector(?:All)?\(\s*['"]([^'"]+)['"]/g)) for (const t of m[1].match(/[#.][A-Za-z_][\w-]*/g) || []) r.push(t);
  return r;
};

/* ---- CSS ---- */
function scanCSS(src) {
  const out = []; let i = 0; const n = src.length;
  while (i < n) {
    let comment = '';
    for (; ;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; comment = src.slice(i, end); i = end; } else break;
    }
    if (i >= n) break;
    const start = i; let depth = 0, bodyStart = -1;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'") { const q = c; i++; while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === '{') { if (depth === 0) bodyStart = i; depth++; }
      else if (c === '}') { depth--; if (depth <= 0) { i++; break; } }
      else if (c === ';' && depth === 0) { i++; break; }
      i++;
    }
    const text = src.slice(start, i);
    if (bodyStart >= 0) out.push({ prelude: src.slice(start, bodyStart).trim(), body: src.slice(bodyStart + 1, Math.max(bodyStart + 1, i - 1)), text, start, comment });
    else out.push({ prelude: text.trim(), body: '', text, start, comment, stmt: true });
  }
  return out;
}
const cssClasses = t => [...new Set([...t.replace(/url\([^)]*\)|"[^"]*"|'[^']*'/g, '').matchAll(/\.([A-Za-z_][\w-]*)/g)].map(m => '.' + m[1]))];

function extractCSS(src, ctx, label) {
  const rules = scanCSS(src).filter(r => !r.stmt);
  const tokens = [], fonts = [], kf = [], groups = new Map(); const out = [];
  const withDoc = r => (r.comment ? r.comment + '\n' : '') + r.text;
  for (const r of rules) {
    const p = r.prelude;
    if (/^@(-webkit-)?keyframes/.test(p)) { kf.push(r); continue; }
    if (/^@font-face/.test(p)) { fonts.push(r); continue; }
    if ((/:root|\[data-theme|^html/.test(p) || (p.startsWith('@media') && /:root/.test(r.body))) && /--[\w-]+\s*:/.test(r.text)) { tokens.push(r); continue; }
    const m = /\.([\w-]+)/.exec(p.startsWith('@') ? r.body : p);
    const key = m ? m[1].split(/__|--|-|_/)[0] : 'base';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const at = r => lineAt(src, r.start);
  if (tokens.length) {
    const code = tokens.map(withDoc).join('\n\n'); const vars = [...new Set([...code.matchAll(/(--[\w-]+)\s*:/g)].map(x => x[1]))];
    const s = mkSkill(ctx, { name: `${label} design tokens`, kind: 'tokens', lang: 'css', code, line: at(tokens[0]), provides: vars,
      summary: `Design tokens: ${vars.length} CSS variables (${vars.slice(0, 5).join(', ')}${vars.length > 5 ? ', …' : ''}).`, tags: ['tokens', 'theme', 'palette', 'variables', 'color', ...featureTags(code)] });
    out.push(s);
  }
  for (const r of kf) {
    const name = p2(r.prelude); const s = mkSkill(ctx, { name: `@keyframes ${name}`, kind: 'keyframes', lang: 'css', code: withDoc(r), line: at(r), provides: ['@' + name],
      summary: `Keyframe animation "${name}".`, tags: ['animation', 'keyframes', ...humanize(name).split(' ')] });
    out.push(s);
  }
  if (fonts.length) out.push(mkSkill(ctx, { name: `${label} font faces`, kind: 'css', lang: 'css', code: fonts.map(withDoc).join('\n\n'), line: at(fonts[0]), summary: `${fonts.length} @font-face declaration(s).`, tags: ['fonts', 'typography'] }));
  for (const [key, rs] of groups) {
    const code = rs.map(withDoc).join('\n\n'); if (code.length < 30) continue;
    const props = {}; for (const m of code.matchAll(/([a-z-]+)\s*:/g)) props[m[1]] = (props[m[1]] || 0) + 1;
    const top = Object.entries(props).sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
    const doc = docSummary(rs[0].comment);
    const s = mkSkill(ctx, { name: key === 'base' ? `${label} base styles` : `.${key} styles`, kind: 'css', lang: 'css', code, line: at(rs[0]),
      provides: cssClasses(rs.map(r => r.prelude.startsWith('@') ? r.body : r.prelude).join(',')),
      summary: (doc ? doc + ' ' : '') + `${rs.length} rule${rs.length > 1 ? 's' : ''}${top.length ? ` — mostly ${top.join(', ')}` : ''}.`,
      tags: [key, 'css', 'style', ...featureTags(code)] });
    s.requires = [...new Set([...code.matchAll(/var\(\s*(--[\w-]+)/g)].map(x => x[1]))];
    for (const m of code.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) for (const w of m[1].split(/[\s,]+/)) if (/^[A-Za-z_][\w-]*$/.test(w)) s.requires.push('@' + w);
    out.push(s);
  }
  return out;
}
const p2 = prelude => prelude.replace(/^@(-webkit-)?keyframes\s+/, '').trim();

/* ---- HTML ---- */
function extractHTML(src, ctx) {
  const out = []; const label = baseName(ctx.path);
  let doc; try { doc = new DOMParser().parseFromString(src, 'text/html'); } catch { return out; }
  const styles = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n');
  if (styles.trim()) out.push(...extractCSS(styles, ctx, label));
  let si = 0;
  for (const sc of doc.querySelectorAll('script:not([src])')) {
    const t = (sc.getAttribute('type') || '').toLowerCase();
    if (/json|importmap/.test(t) || !sc.textContent.trim()) continue;
    si++; out.push(...extractJS(sc.textContent, ctx, si > 1 ? `${label} script ${si}` : `${label} inline`));
  }
  for (const sv of doc.querySelectorAll('svg')) {
    if (sv.parentElement && sv.parentElement.closest('svg')) continue;
    const html = sv.outerHTML; if (html.length < 80 || html.length > MAX_CODE) continue;
    const id = sv.getAttribute('id') || sv.getAttribute('class') || `graphic ${out.filter(x => x.kind === 'svg').length + 1}`;
    out.push(mkSkill(ctx, { name: `svg ${id}`, kind: 'svg', lang: 'html', code: html, summary: `Inline SVG (${sv.getAttribute('viewBox') || 'no viewBox'}, ${sv.querySelectorAll('*').length} shapes).`, tags: ['svg', 'graphic', 'icon'], provides: sv.id ? ['#' + sv.id] : [] }));
  }
  const SEM = /^(HEADER|NAV|MAIN|SECTION|FOOTER|FORM|DIALOG|ASIDE|TEMPLATE|ARTICLE)$/;
  let order = 0;
  for (const el of [...doc.body.children]) {
    if (/^(SCRIPT|STYLE|SVG|LINK|NOSCRIPT)$/i.test(el.tagName)) continue;
    order++;
    if (!(el.id || el.className || SEM.test(el.tagName))) continue;
    const html = el.outerHTML; if (html.length < 20 || html.length > MAX_CODE) continue;
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean);
    const nm = el.id ? `#${el.id}` : cls.length ? `.${cls[0]}` : el.tagName.toLowerCase();
    const s = mkSkill(ctx, { name: `${nm} markup`, kind: 'html', lang: 'html', code: html, line: order, summary: `<${el.tagName.toLowerCase()}> fragment with ${el.querySelectorAll('*').length} nested elements${el.textContent.trim() ? ` — “${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 50)}”` : ''}.`,
      tags: ['html', 'markup', el.tagName.toLowerCase(), ...cls, el.id].filter(Boolean), provides: [...new Set([...el.querySelectorAll('[id]')].map(x => '#' + x.id).concat(el.id ? ['#' + el.id] : []))] });
    s.requires = [...new Set([el, ...el.querySelectorAll('[class]')].flatMap(x => (typeof x.className === 'string' ? x.className : '').split(/\s+/).filter(Boolean)).map(c => '.' + c))];
    out.push(s);
  }
  return out;
}

/* ---- Python ---- */
function extractPy(src, ctx) {
  const lines = src.split('\n'); const out = []; let i = 0;
  while (i < lines.length) {
    const m = /^(async\s+def|def|class)\s+(\w+)/.exec(lines[i]);
    if (!m) { i++; continue; }
    let s = i; while (s > 0 && /^@/.test(lines[s - 1])) s--;
    let e = i + 1; while (e < lines.length && (lines[e].trim() === '' || /^\s/.test(lines[e]) || /^[)\]}]/.test(lines[e]))) e++;
    while (e > i + 1 && lines[e - 1].trim() === '') e--;
    const code = lines.slice(s, e).join('\n'); const isClass = m[1] === 'class';
    const doc = (/^\s+(?:"""|''')([\s\S]*?)(?:"""|''')/m.exec(lines.slice(i + 1, e).join('\n')) || [])[1];
    const params = (/\(([^)]*)\)/.exec(lines[i]) || [])[1] || '';
    out.push(mkSkill(ctx, { name: m[2], kind: isClass ? 'class' : 'fn', lang: 'py', code, line: i + 1, provides: [m[2]],
      summary: doc ? sentence(doc.trim().split(/\n\s*\n|(?<=[.!?])\s/)[0]).slice(0, 200) : `${sentence(humanize(m[2]))} — Python ${isClass ? 'class' : 'function'} ${m[2]}(${params.trim().slice(0, 60)}).`,
      tags: [...humanize(m[2]).split(' '), 'python', isClass ? 'class' : 'fn'] }));
    out[out.length - 1].requires = idents(code, m[2]);
    i = e;
  }
  return out;
}

function extractOther(lang, src, ctx) {
  const label = baseName(ctx.path);
  if (lang === 'glsl') return [mkSkill(ctx, { name: label, kind: 'shader', lang: 'glsl', code: src.slice(0, MAX_CODE), summary: `Shader file ${label} (${src.split('\n').length} lines).`, tags: ['shader', 'glsl', 'gpu', 'webgl'] })];
  if (lang === 'svg') return src.length >= 80 ? [mkSkill(ctx, { name: `svg ${label}`, kind: 'svg', lang: 'html', code: src.slice(0, MAX_CODE), summary: `SVG file ${label}.`, tags: ['svg', 'graphic', 'icon'] })] : [];
  if (lang === 'json' && /(^|\/)package\.json$/.test(ctx.path)) {
    try {
      const j = JSON.parse(src); const deps = Object.keys({ ...j.dependencies, ...j.devDependencies });
      return [mkSkill(ctx, { name: `${j.name || ctx.project} stack`, kind: 'data', lang: 'json', code: JSON.stringify({ name: j.name, scripts: j.scripts, dependencies: j.dependencies, devDependencies: j.devDependencies }, null, 2),
        summary: `Stack: ${deps.slice(0, 8).join(', ')}${deps.length > 8 ? ', …' : ''}.`, tags: ['package', 'dependencies', 'stack', ...deps] })];
    } catch { return []; }
  }
  if (lang === 'md') {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
    if (fm && /^name:/m.test(fm[1]) && /^description:/m.test(fm[1])) {
      const get = k => ((new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(fm[1]) || [])[1] || '').replace(/^["']|["']$/g, '').trim();
      const nm = get('name');
      return [mkSkill(ctx, { name: nm, kind: 'skill', lang: 'md', code: src.slice(0, MAX_CODE), summary: sentence(get('description')).slice(0, 300), tags: ['skill', 'instructions', ...humanize(nm).split(' ')] })];
    }
  }
  return [];
}

/* ================= project pipeline ================= */
function extractFile(project, path, text) {
  const lang = fileLang(path); const ctx = { project, path }; let out = [];
  try {
    if (lang === 'js') out = extractJS(text, ctx);
    else if (lang === 'css') out = extractCSS(text, ctx, baseName(path));
    else if (lang === 'html') out = extractHTML(text, ctx);
    else if (lang === 'py') out = extractPy(text, ctx);
    else if (lang) out = extractOther(lang, text, ctx);
  } catch (e) { console.warn('extract failed', path, e); }
  for (const s of out) s.path = path;
  return out;
}

function linkProject(skills) {
  const owners = new Map();
  for (const s of skills) for (const p of s.provides) { if (!owners.has(p)) owners.set(p, []); owners.get(p).push(s); }
  for (const s of skills) {
    const uses = new Set();
    for (const r of s.requires) for (const o of owners.get(r) || []) if (o.id !== s.id) uses.add(o.id);
    s.uses = [...uses];
  }
  return skills;
}

function extractProject(project, files) {
  const skills = [];
  for (const f of files) skills.push(...extractFile(project, f.path, f.text));
  const seen = new Set(); const uniq = skills.filter(s => (seen.has(s.id) ? false : seen.add(s.id)));
  return linkProject(uniq);
}

/* ================= .skill formatting ================= */
const LANG_FENCE = { js: 'js', css: 'css', html: 'html', py: 'python', glsl: 'glsl', json: 'json', md: 'md' };
function skillMd(s, byId) {
  const desc = (s.summary + (s.tags.length ? ` Use when working with: ${s.tags.slice(0, 8).join(', ')}.` : '')).replace(/[<>]/g, '').replace(/\s+/g, ' ').slice(0, 900);
  const uses = (s.uses || []).map(id => byId && byId[id] ? byId[id].name : null).filter(Boolean);
  return `---\nname: ${slug(s.name)}\ndescription: ${desc}\n---\n\n# ${s.name}\n\n${s.summary}\n\n- Kind: ${s.kind} (${s.lang})\n${s.path ? `- Source: ${s.project}/${s.path}:${s.line}\n` : ''}${uses.length ? `- Builds on: ${uses.join(', ')}\n` : ''}\n## Code\n\n\`\`\`${LANG_FENCE[s.lang] || ''}\n${s.code}\n\`\`\`\n`;
}
