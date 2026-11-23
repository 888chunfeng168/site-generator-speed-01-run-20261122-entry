// fast-site: a fast drop-in for makefun-site 1.0.0.
//
// Written from scratch for the "Build a static site faster" bounty. It
// reproduces makefun-site 1.0.0's build byte for byte (front matter, template
// dialect, Markdown subset, slug rule and report) while doing the work
// faster: one fused pass over each Markdown body instead of lex-then-render,
// range-based inline rendering with regex jumps between markup instead of a
// per-character scan, cached slugs, template rendering straight into a chunk
// array, a scope chain instead of a merged vars object per render, and a
// cache for includes that read only the build's globals (site, tags, recent:
// header, nav, footer and the like render once per case, not once per page).
//
// Entry point: run(input) -> the output tree, a JSON object of path -> text.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;
/** The characters inline rendering must stop at. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const RESERVED = ['posts', 'tags', 'page'];
const INCLUDE_DEPTH = 8;
const SLUG_MAX = 64;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `text` with & < > " and ' escaped. Most values hold none of those, so a
 * single test first skips the replace for them.
 */
function escapeHtml(text) {
  return ESCAPE_TEST.test(text) ? text.replace(ESCAPE_RE, (c) => ESCAPES[c]) : text;
}

/** Whether code unit `c` is a space or tab. */
const isSpaceTab = (c) => c === 32 || c === 9;

/** Whether the slice [a, b) of `s` holds only spaces and tabs. */
function onlySpaceTab(s, a, b) {
  for (let i = a; i < b; i++) if (!isSpaceTab(s.charCodeAt(i))) return false;
  return true;
}

/** Whether line `s` (no newline) is blank: spaces and tabs only. */
function isBlank(s) {
  return onlySpaceTab(s, 0, s.length);
}

/** `s` with spaces and tabs at both ends dropped. */
function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b && isSpaceTab(s.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

// ---------------------------------------------------------------- slugs

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Pure ASCII text takes a fast path (NFKD is the identity there and
 * ASCII holds no combining marks); anything else follows the same rule
 * through the normaliser. Results are cached per build in `cache`.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/**
 * `slug` made unique against `taken` (and added to it): the first of slug,
 * slug-2, slug-3 ... not taken. `next` remembers, per base slug, the suffix
 * to try first, so a repeated collision never re-probes suffixes already
 * known taken; probing still walks up one by one, so the answer is the same.
 */
function uniqueSlug(slug, taken, next) {
  let n = next.get(slug);
  if (n === undefined) {
    if (!taken.has(slug)) {
      taken.add(slug);
      next.set(slug, 2);
      return slug;
    }
    n = 2;
  }
  let out = `${slug}-${n}`;
  while (taken.has(out)) {
    n++;
    out = `${slug}-${n}`;
  }
  taken.add(out);
  next.set(slug, n + 1);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone (dates repeat, so cache per build). */
function longDate(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const out = `${d} ${MONTHS[m - 1]} ${y}`;
  cache.set(date, out);
  return out;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. Lines are scanned by newline offsets, never
 * split into an array, and the body is one slice, never a re-join.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let pos = text.indexOf('\n');
  if (pos === -1) return { error: 'the front matter is not closed' };
  pos += 1;
  let lineNo = 1; // 0-based line index of the line starting at pos
  const data = {};
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: nl === -1 ? '' : text.slice(nl + 1) };
    }
    if (!isBlank(line) && line[0] !== '#') {
      // key: value — key of [a-z_]+, colon, one space, value
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line[k] !== ':') return { error: `line ${lineNo + 1} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      const rest = line.slice(k + 1);
      if (rest === '') raw = '';
      else if (rest[0] === ' ') raw = rest.slice(1);
      else return { error: `line ${lineNo + 1} is not "key: value"` };
      let e = raw.length;
      while (e > 0 && isSpaceTab(raw.charCodeAt(e - 1))) e--;
      raw = raw.slice(0, e);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
    lineNo++;
  }
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A fence-open line's language, or null: ``` then a language, then spaces/tabs only. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    i++;
  }
  return onlySpaceTab(line, i, line.length) ? line.slice(3, i) : null;
}

/** Whether `line` closes a fence: ``` then spaces or tabs only. */
function isFenceClose(line) {
  return line[0] === '`' && line[1] === '`' && line[2] === '`' && onlySpaceTab(line, 3, line.length);
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n < 1 || n > 6) return null;
  if (n >= line.length || !isSpaceTab(line.charCodeAt(n))) return null;
  let e = line.length;
  while (e > n && isSpaceTab(line.charCodeAt(e - 1))) e--;
  const text = line.slice(n + 1, e);
  return text === '' ? null : { depth: n, text };
}

/** Whether `line` is a thematic break: --- or *** then spaces or tabs only. */
function isHr(line) {
  if (line.length < 3) return false;
  const c = line[0];
  if (c !== '-' && c !== '*') return false;
  if (line[1] !== c || line[2] !== c) return false;
  return onlySpaceTab(line, 3, line.length);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, to) {
  const last = to - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/**
 * `s[a..b)` rendered inline into `out`; `env.link(target)` is a link's href.
 * A regex jumps from one markup character to the next, so plain runs are
 * pushed whole and the scan itself runs in native code.
 */
function inlineRange(s, a, b, env, out) {
  let i = a;
  for (;;) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m === null || m.index >= b ? -1 : m.index;
    if (j === -1) {
      if (i < b) out.push(s.slice(i, b));
      return;
    }
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '&') { out.push('&amp;'); i = j + 1; continue; }
    if (c === '<') { out.push('&lt;'); i = j + 1; continue; }
    if (c === '>') { out.push('&gt;'); i = j + 1; continue; }
    if (c === '"') { out.push('&quot;'); i = j + 1; continue; }
    if (c === "'") { out.push('&#39;'); i = j + 1; continue; }
    if (c === '\\') {
      if (j + 1 < b && ESCAPABLE.has(s[j + 1])) {
        const n = s[j + 1];
        out.push(ESCAPES[n] || n);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k > j + 2) {
          out.push('<strong>');
          inlineRange(s, j + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k > j + 1) {
        out.push('<em>');
        inlineRange(s, j + 1, k, env, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i = j + 1;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1, b);
    let m2 = -1;
    if (k !== -1 && s[k + 1] === '(') {
      const r = s.indexOf(')', k + 2);
      if (r !== -1 && r < b) m2 = r;
    }
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !WS_RE.test(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineRange(s, j + 1, k, env, out);
      out.push('</a>');
      i = m2 + 1;
    } else {
      out.push('[');
      i = j + 1;
    }
  }
}

/**
 * `src` rendered in one fused pass: blocks are recognised and rendered as
 * they are scanned, straight into `out`. Returns the HTML, the table of
 * contents (every level 2 and 3 heading) and the excerpt (the first
 * paragraph's inline HTML, or "").
 */
// Line kinds for classifyLine: 0 blank, 1 fence, 2 heading, 3 hr, 4 quote, 5 bullet, 6 ordered, 7 text.
function classifyLine(line, c) {
  if (line.length === 0) { c.kind = 0; return 0; }
  const ch0 = line.charCodeAt(0);
  if (ch0 === 32 || ch0 === 9) {
    c.kind = isBlank(line) ? 0 : 7;
    return c.kind;
  }
  if (ch0 === 96) { // `
    const lang = fenceLang(line);
    if (lang !== null) { c.kind = 1; c.lang = lang; return 1; }
    c.kind = 7;
    return 7;
  }
  if (ch0 === 35) { // #
    const h = headingOf(line);
    if (h !== null) { c.kind = 2; c.depth = h.depth; c.text = h.text; return 2; }
    c.kind = 7;
    return 7;
  }
  if (ch0 === 45 || ch0 === 42) { // - or *
    if (isHr(line)) { c.kind = 3; return 3; }
    if (line.charCodeAt(1) === 32) { c.kind = 5; c.rest = line.slice(2); return 5; }
    c.kind = 7;
    return 7;
  }
  if (ch0 === 62) { c.kind = 4; return 4; } // >
  if (ch0 >= 48 && ch0 <= 57) {
    let d = 0;
    while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
    if (d >= 1 && d <= 9 && line[d] === '.' && line[d + 1] === ' ') {
      c.kind = 6;
      c.start = Number(line.slice(0, d));
      c.rest = line.slice(d + 2);
      return 6;
    }
    c.kind = 7;
    return 7;
  }
  c.kind = 7;
  return 7;
}

/**
 * `src` rendered in one fused pass: blocks are recognised and rendered as
 * they are scanned, straight into `out`. Each line is classified once and
 * the classification carries over: a paragraph keeps consuming lines until
 * the pending line's kind is one that ends it. Returns the HTML, the table
 * of contents (every level 2 and 3 heading) and the excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, cx) {
  const out = [];
  const toc = [];
  const ids = new Set();
  const idNext = new Map();
  let excerpt = null;
  const len = src.length;
  const c = {};
  let pos = 0;
  let curLine = null;
  let curKind = -1;
  // Read the next line into curLine/curKind (classified once); false at EOF.
  const advance = () => {
    if (pos > len) {
      curLine = null;
      return false;
    }
    let nl = src.indexOf('\n', pos);
    if (nl === -1) nl = len;
    curLine = src.slice(pos, nl);
    pos = nl === len ? len + 1 : nl + 1;
    curKind = classifyLine(curLine, c);
    return true;
  };
  advance();
  while (curLine !== null) {
    const kind = curKind;
    if (kind === 0) {
      advance();
      continue;
    }
    if (kind === 1) {
      const cls = c.lang === '' ? '' : ` class="language-${escapeHtml(c.lang)}"`;
      out.push(`<pre><code${cls}>`);
      advance();
      while (curLine !== null && !isFenceClose(curLine)) {
        out.push(escapeHtml(curLine), '\n');
        advance();
      }
      if (curLine !== null) advance(); // skip the closing fence line
      out.push('</code></pre>', '\n');
      continue;
    }
    if (kind === 2) {
      const id = uniqueSlug(slugify(c.text, cx.slugCache), ids, idNext);
      const mark = out.length;
      out.push(`<h${c.depth} id="${id}">`);
      inlineRange(c.text, 0, c.text.length, env, out);
      out.push(`</h${c.depth}>`, '\n');
      if (c.depth === 2 || c.depth === 3) {
        toc.push({ level: c.depth, id, html: out.slice(mark + 1, out.length - 2).join('') });
      }
      advance();
      continue;
    }
    if (kind === 3) {
      out.push('<hr>', '\n');
      advance();
      continue;
    }
    if (kind === 4) {
      const lines = [];
      while (curLine !== null && curKind === 4) {
        // drop the '>' and one space after it, then trim
        let t = curLine.slice(1);
        if (t[0] === ' ') t = t.slice(1);
        t = trimLine(t);
        if (t !== '') lines.push(t);
        advance();
      }
      if (lines.length === 0) {
        out.push('<blockquote>\n</blockquote>', '\n');
      } else {
        const joined = lines.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(joined, 0, joined.length, env, out);
        out.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    if (kind === 5 || kind === 6) {
      const isOrdered = kind === 6;
      const start = isOrdered ? c.start : 1;
      const items = [[trimLine(c.rest)]];
      advance();
      while (curLine !== null) {
        let m = null;
        if (isOrdered) {
          if (curKind === 6) m = c.rest;
        } else if (curKind === 5) {
          m = c.rest;
        }
        if (m !== null) {
          items.push([trimLine(m)]);
          advance();
        } else if (/^ {2,}\S/.test(curLine)) {
          items[items.length - 1].push(trimLine(curLine));
          advance();
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      out.push(`${open}\n`);
      for (const item of items) {
        const joined = item.join('\n');
        out.push('<li>');
        inlineRange(joined, 0, joined.length, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>`, '\n');
      continue;
    }
    // paragraph: this line and the following ones up to a blank line, a fence, a heading or a break
    const pLines = [trimLine(curLine)];
    advance();
    while (curLine !== null && curKind !== 0 && curKind !== 1 && curKind !== 2 && curKind !== 3) {
      pLines.push(trimLine(curLine));
      advance();
    }
    const joined = pLines.join('\n');
    const mark = out.length;
    out.push('<p>');
    inlineRange(joined, 0, joined.length, env, out);
    out.push('</p>', '\n');
    if (excerpt === null) excerpt = out.slice(mark + 1, out.length - 2).join('');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The first names a template's nodes read that no `for` inside the template
 * binds (`bound` carries the names the enclosing fors bind), collected into
 * `out`; `incs` collects the templates it includes, for the fixpoint below.
 */
function collectFree(names, nodes, bound, out, incs) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'var':
      case 'raw':
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        break;
      case 'if':
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        collectFree(names, n.then, bound, out, incs);
        if (n.else !== null) collectFree(names, n.else, bound, out, incs);
        break;
      case 'for': {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        const inner = new Set(bound);
        inner.add(n.name);
        inner.add('loop');
        collectFree(names, n.body, inner, out, incs);
        break;
      }
      case 'include':
        incs.add(n.name);
        break;
    }
  }
}

/**
 * For every parsed template, whether its rendering can only read the build's
 * globals (site, tags, recent): its own free names are all globals, and so
 * are every template's it includes, transitively. A fixpoint over the include
 * edges settles cycles too. Such a template renders the same string wherever
 * it is included at the same depth, unless an enclosing scope binds one of
 * the globals (checked at the include, where that can be seen).
 */
function analyseTemplates(templates) {
  const free = new Map();
  const incs = new Map();
  for (const [name, nodes] of templates) {
    const out = new Set();
    const edges = new Set();
    collectFree(name, nodes, new Set(), out, edges);
    free.set(name, out);
    incs.set(name, edges);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, edges] of incs) {
      const s = free.get(name);
      for (const u of edges) {
        const fu = free.get(u);
        if (fu === undefined) continue; // a missing template renders nothing
        for (const x of fu) {
          if (!s.has(x)) {
            s.add(x);
            changed = true;
          }
        }
      }
    }
  }
  const globalOnly = new Map();
  for (const [name, s] of free) {
    let ok = true;
    for (const x of s) {
      if (x !== 'site' && x !== 'tags' && x !== 'recent') { ok = false; break; }
    }
    globalOnly.set(name, ok);
  }
  return globalOnly;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appending to `out`. `cx`
 * holds the parsed templates, the globals-only table, the include cache and
 * the top scope. An include of a globals-only template is rendered once per
 * (template, depth) and reused, unless an enclosing scope binds one of the
 * globals it reads, in which case it is rendered live.
 */
function renderNodes(nodes, scope, cx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, cx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const L = xs.length;
        for (let k = 0; k < L; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === L - 1, length: L } };
          renderNodes(n.body, { vars, parent: scope }, cx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = cx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        if (cx.globalOnly.get(n.name)) {
          let shadowed = false;
          for (let s = scope; s !== null && s !== cx.topScope; s = s.parent) {
            const v = s.vars;
            if (Object.hasOwn(v, 'site') || Object.hasOwn(v, 'tags') || Object.hasOwn(v, 'recent')) {
              shadowed = true;
              break;
            }
          }
          if (!shadowed) {
            const key = `${n.name}\n${depth}`;
            let cached = cx.includeCache.get(key);
            if (cached === undefined) {
              const sub = [];
              renderNodes(t, scope, cx, depth + 1, sub);
              cached = sub.join('');
              cx.includeCache.set(key, cached);
            }
            out.push(cached);
            break;
          }
        }
        renderNodes(t, scope, cx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 ||
      c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
      c === 8287 || c === 12288 || c === 65279) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function run(input) {
  const cx = { slugCache: new Map(), dateCache: new Map(), templates: new Map(), includeCache: new Map(), topScope: null, globalOnly: new Map() };
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      cx.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  cx.globalOnly = analyseTemplates(cx.templates);
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. Sources, in code-unit order of their paths; .md is a source, anything else static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      // Line ends are already "\n" unless a "\r" is present, which the scan below avoids paying for twice.
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      let own;
      if (s.path.startsWith('tags/')) own = 'tags';
      else if (s.path.startsWith('page/')) own = 'page';
      if (own !== undefined) {
        report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!cx.templates.has(layout)) {
        report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    sources = kept;
  }

  // 3. Permalinks: each page's directory and url, its slug unique in its directory, in source order.
  const bySource = new Map();
  {
    const takenByDir = new Map();
    const nextByDir = new Map();
    const takenIn = (dir) => {
      let t = takenByDir.get(dir);
      if (t === undefined) {
        t = new Set(dir === '' ? RESERVED : []);
        takenByDir.set(dir, t);
        nextByDir.set(dir, new Map());
      }
      return t;
    };
    for (const s of sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const taken = takenIn(dir);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, cx.slugCache), taken, nextByDir.get(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // 4. Markdown: each body's HTML, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, cx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: the posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, cx.slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, cx.slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, cx.slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages and links as templates read them.
  const cardOf = (s) => {
    if (s.card === undefined) {
      s.card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date, cx.dateCache),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
    }
    return s.card;
  };
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, cx.dateCache),
  });
  const tagOf = (t) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
    posts: t.posts.map((p) => cardOf(p)),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts: every page through its layout, the index pages and the tag pages through theirs.
  // `site`, `tags` and `recent` live in one shared scope object; each render
  // chains its own vars above it instead of merging a fresh object per page.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const topScope = { vars: { site, tags: allTags, recent }, parent: null };
  cx.topScope = topScope;
  const render = (name, vars) => {
    const nodes = cx.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: topScope }, cx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
