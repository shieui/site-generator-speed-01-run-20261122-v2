// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// Written fresh for this competition. It runs the same build makefun-site
// runs — same pipeline, same rules, same report lines — and returns the same
// output tree, byte for byte, only faster:
//
//   * front matter is parsed by a hand-rolled line scanner (no regexes),
//   * Markdown is rendered in one pass, straight into the output string
//     (no token array, no per-character escaping),
//   * templates are compiled to small JavaScript functions, so rendering a
//     page is straight-line code with direct variable reads instead of a
//     tree walk with scope-chain lookups (an interpreter over the same
//     parse tree stands by if compiling is ever refused),
//   * slugs are cached within a case, words are counted by a character scan.
//
// Nothing is cached from one case to the next: every run() call builds its
// own tables. The module is dependency-free and uses only Node 22
// standard-library APIs.

export function run(input) {
  return build(input);
}

// ------------------------------------------------------------------ text

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
];

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. Returns `text` itself when it holds none of them. */
function escapeHtml(text) {
  let out = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (out === null) out = text.slice(0, i);
    else out += text.slice(start, i);
    out += rep;
    start = i + 1;
  }
  if (out === null) return text;
  return out + text.slice(start);
}

/** One character, escaped (used for a backslash-escaped character). */
function esc1(ch) {
  const r = ESCAPES[ch];
  return r === undefined ? ch : r;
}

/** Whether the code unit is JavaScript whitespace (the \s set), as a table. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;

/** Whether the code unit is JavaScript whitespace (the \s set). */
function isWS(c) {
  return WS_TABLE[c] === 1;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. `cache` is the build's own, so a repeated title or tag is slugged once.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  // NFKD is the identity on pure ASCII, and ASCII holds no combining marks.
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
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
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `s` with spaces and tabs dropped at both ends. */
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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

// ------------------------------------------------------------------ front matter

/** The keys a source's front matter may give. */
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
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
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is a template name (a-z, 0-9 and "-"). */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug (a-z and 0-9, single "-" between), at most 64 characters. */
function isSlug(s) {
  if (s.length === 0 || s.length > 64) return false;
  let i = 0;
  const n = s.length;
  for (;;) {
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
      else break;
    }
    if (j === i) return false;
    if (j === n) return true;
    if (s.charCodeAt(j) !== 45) return false;
    i = j + 1;
    if (i === n) return false;
  }
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) {
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = [];
      for (const p of inner.split(',')) {
        const t = p.trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags.push(t);
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * One front-matter line, parsed into `data`: an error string, or null.
 * `ln` is the line's 0-based index (the opening "---" is line 0).
 */
function parseFmLine(line, ln, data) {
  let k = 0;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  if (k === line.length) return null; // blank
  if (line.charCodeAt(0) === 35) return null; // a comment opens on "#"
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j === 0 || line.charCodeAt(j) !== 58) return `line ${ln + 1} is not "key: value"`;
  const key = line.slice(0, j);
  let raw;
  if (j + 1 === line.length) raw = '';
  else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
  else return `line ${ln + 1} is not "key: value"`;
  let r = raw.length;
  while (r > 0 && (raw.charCodeAt(r - 1) === 32 || raw.charCodeAt(r - 1) === 9)) r--;
  if (r !== raw.length) raw = raw.slice(0, r);
  if (!KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = valueOf(key, raw);
  if (v.error !== undefined) return v.error;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  let e = text.indexOf('\n', 0);
  if (e === -1) e = text.length;
  if (text.slice(0, e) !== '---') return { error: 'no front matter' };
  // The closing "---" is found first: a source whose front matter is not
  // closed is refused for that, whatever its lines hold.
  let pos = e === text.length ? text.length + 1 : e + 1;
  let ln = 1;
  let closeEnd = -1;
  while (pos <= text.length) {
    let e2 = text.indexOf('\n', pos);
    if (e2 === -1) e2 = text.length;
    if (text.slice(pos, e2) === '---') {
      closeEnd = e2;
      break;
    }
    if (e2 === text.length) break;
    pos = e2 + 1;
    ln++;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = e === text.length ? text.length + 1 : e + 1;
  for (let i = 1; i < ln; i++) {
    let e2 = text.indexOf('\n', pos);
    if (e2 === -1) e2 = text.length;
    const err = parseFmLine(text.slice(pos, e2), i, data);
    if (err !== null) return { error: err };
    pos = e2 + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ------------------------------------------------------------------ Markdown

/** Whether `line` is blank (spaces and tabs only). */
function isBlankLine(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let a = h;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: h, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(1);
  const c2 = line.charCodeAt(2);
  if (!((c0 === 45 && c1 === 45 && c2 === 45) || (c0 === 42 && c1 === 42 && c2 === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's content, or null when `line` does not open one. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and content, or null when `line` does not open one. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 9) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), content: line.slice(i + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWS(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const n = line.length;
  if (n === 0) return true;
  const c = line.charCodeAt(0);
  // A blank line, a fence, a heading and a break all start at column 0.
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

/** The first index from `from` where `s` holds "**" outside a backslash escape, or -1. */
function findDoubleStar(s, from) {
  for (let j = from; j + 1 < s.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first index from `from` where `s` holds "]" outside a backslash escape, or -1. */
function findBracket(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) === 93) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds any whitespace. */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

/** The inline dispatch: 0 plain, 1 backslash, 2 backtick, 3 star, 4 bracket, 5 an HTML special. */
const INL = new Uint8Array(128);
INL[92] = 1;
INL[96] = 2;
INL[42] = 3;
INL[91] = 4;
for (const c of [38, 60, 62, 34, 39]) INL[c] = 5;

/** `s` rendered inline; `link(target)` is a link's href. */
function inline(s, link) {
  // Fast path: no markup character at all, so the text is only escaped.
  if (s.indexOf('\\') === -1 && s.indexOf('`') === -1 && s.indexOf('*') === -1 && s.indexOf('[') === -1) {
    return escapeHtml(s);
  }
  let out = '';
  let i = 0;
  let run = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    switch (c < 128 ? INL[c] : 0) {
      case 1: {
        // A backslash before an escapable character writes that character (escaped).
        if (i + 1 < n && ESCAPABLE.has(s.charCodeAt(i + 1))) {
          if (i > run) out += s.slice(run, i);
          out += esc1(s[i + 1]);
          i += 2;
          run = i;
          continue;
        }
        i++;
        continue;
      }
      case 2: {
        const j = s.indexOf('`', i + 1);
        if (j > i + 1) {
          if (i > run) out += s.slice(run, i);
          out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
          i = j + 1;
          run = i;
          continue;
        }
        i++;
        continue;
      }
      case 3: {
        if (s.charCodeAt(i + 1) === 42) {
          const j = findDoubleStar(s, i + 2);
          if (j > i + 2) {
            if (i > run) out += s.slice(run, i);
            out += `<strong>${inline(s.slice(i + 2, j), link)}</strong>`;
            i = j + 2;
            run = i;
            continue;
          }
          i += 2;
          continue;
        }
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (i > run) out += s.slice(run, i);
          out += `<em>${inline(s.slice(i + 1, j), link)}</em>`;
          i = j + 1;
          run = i;
          continue;
        }
        i++;
        continue;
      }
      case 4: {
        const k = findBracket(s, i + 1);
        const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
        const target = m === -1 ? '' : s.slice(k + 2, m);
        if (target !== '' && !hasWS(target)) {
          if (i > run) out += s.slice(run, i);
          out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`;
          i = m + 1;
          run = i;
          continue;
        }
        i++;
        continue;
      }
      case 5: {
        if (i > run) out += s.slice(run, i);
        out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
        i++;
        run = i;
        continue;
      }
      default:
        i++;
    }
  }
  if (n > run) out += s.slice(run, n);
  return out;
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading: level,
 * id and its inline HTML) and its excerpt (the first paragraph's inline HTML,
 * or ""). `link(target)` resolves a link's href; `cache` is the build's slug cache.
 */
function renderMarkdown(src, link, cache) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  let out = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    // A blank line: empty, or only spaces and tabs.
    if (c0 === -1 || ((c0 === 32 || c0 === 9) && isBlankLine(line))) {
      i++;
      continue;
    }
    // A fence, a heading, a break and a quote each start at column 0.
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        out += `<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`;
        while (i < n && !isFenceClose(lines[i])) {
          out += escapeHtml(lines[i]);
          out += '\n';
          i++;
        }
        i++;
        out += '</code></pre>\n';
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, cache), ids);
        const html = inline(heading.text, link);
        out += `<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`;
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out += '<hr>\n';
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        parts.push(trimST(l));
        i++;
      }
      const kept = [];
      for (const p of parts) if (p !== '') kept.push(p);
      out += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = c0 === 45 || c0 === 42 ? bulletOf(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      items.push([trimST(isOrdered ? ordered.content : bullet)]);
      i++;
      while (i < n) {
        const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          items.push([trimST(isOrdered ? m.content : m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimST(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered.num) !== 1 ? `<ol start="${Number(ordered.num)}">` : `<${tag}>`;
      out += open;
      out += '\n';
      for (const item of items) {
        out += `<li>${inline(item.join('\n'), link)}</li>\n`;
      }
      out += `</${tag}>\n`;
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimST(lines[i]));
      i++;
    }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out += `<p>${html}</p>\n`;
  }
  return { html: out, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

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

/** Whether `src[a..b)` holds only spaces and tabs. */
function isBlankRange(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
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
    const standalone = isBlankRange(src, lineStart, open) && isBlankRange(src, end, lineEnd);
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
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
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
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
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

/** The own property `k` of the object `v`, or undefined (a path's next name). */
function prop(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/** The value at `path` in the scope chain (the interpreter's lookup). */
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

/**
 * `nodes` rendered in `scope` ({ vars, parent }): the interpreter, used when
 * a template cannot be compiled. `ctx` holds the parsed templates and the
 * include depth.
 */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {
            [n.name]: xs[k],
            loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
          };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------- the template compiler

/** The helpers a compiled template reads: H.esc, H.txt, H.truthy, H.prop. */
const H = { esc: escapeHtml, txt: textOf, truthy, prop };

/** The names `nodes` reads that no enclosing for binds (its free variables). */
function collectFree(nodes, bound, free) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
      if (n.kind === 'if') {
        collectFree(n.then, bound, free);
        if (n.else !== null) collectFree(n.else, bound, free);
      }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      collectFree(n.body, inner, free);
    }
  }
}

/**
 * The JavaScript expression for `name` in the code being generated: the
 * innermost loop that binds it, else the template's own parameter for it,
 * else the root values (`V` has no prototype, so a missing name reads undefined).
 */
function resolveName(name, stack, freeSet) {
  if (name === 'loop') {
    if (stack.length > 0) return stack[stack.length - 1].loopJs;
    return freeSet.has('loop') ? '$f_loop' : 'V.loop';
  }
  for (let s = stack.length - 1; s >= 0; s--) {
    if (stack[s].elementName === name) return stack[s].elementJs;
  }
  if (freeSet.has(name)) return `$f_${name}`;
  return `V.${name}`;
}

/** The JavaScript expression for `path` in the code being generated. */
function genPath(path, stack, freeSet) {
  let e = resolveName(path[0], stack, freeSet);
  for (let k = 1; k < path.length; k++) e = `H.prop(${e},${JSON.stringify(path[k])})`;
  return e;
}

/** `nodes` compiled into `parts`, the lines of a render function's body. */
function genNodes(nodes, stack, freeSet, freeMap, parts, fid) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      parts.push(`out+=${JSON.stringify(n.text)};`);
    } else if (n.kind === 'var') {
      parts.push(`out+=H.esc(H.txt(${genPath(n.path, stack, freeSet)}));`);
    } else if (n.kind === 'raw') {
      parts.push(`out+=H.txt(${genPath(n.path, stack, freeSet)});`);
    } else if (n.kind === 'if') {
      parts.push(`if(H.truthy(${genPath(n.path, stack, freeSet)})!==${n.not}){`);
      genNodes(n.then, stack, freeSet, freeMap, parts, fid);
      if (n.else !== null) {
        parts.push('}else{');
        genNodes(n.else, stack, freeSet, freeMap, parts, fid);
      }
      parts.push('}');
    } else if (n.kind === 'for') {
      const id = fid.next++;
      const vJs = `$v${id}`;
      const lJs = `$l${id}`;
      parts.push(
        `{const _x${id}=${genPath(n.path, stack, freeSet)};` +
          `if(Array.isArray(_x${id})){const ${lJs}={index:0,first:false,last:false,length:_x${id}.length};` +
          `for(let _k${id}=0;_k${id}<_x${id}.length;_k${id}++){const ${vJs}=_x${id}[_k${id}];` +
          `${lJs}.index=_k${id}+1;${lJs}.first=_k${id}===0;${lJs}.last=_k${id}===_x${id}.length-1;`,
      );
      stack.push({ elementName: n.name, elementJs: vJs, loopJs: lJs });
      genNodes(n.body, stack, freeSet, freeMap, parts, fid);
      stack.pop();
      parts.push('}}}');
    } else if (n.kind === 'include') {
      // A missing template, or one nested more than 8 deep, renders nothing.
      const calleeFree = freeMap.get(n.name);
      if (calleeFree !== undefined) {
        const args = calleeFree.map((f) => resolveName(f, stack, freeSet)).join(',');
        parts.push(`_fn=T[${JSON.stringify(n.name)}];if(_fn!==undefined&&d<8)out+=_fn(V,T,H${args === '' ? '' : `,${args}`},d+1);`);
      }
    }
  }
}

/**
 * `nodes` as a render function (V, T, H, ...its free variables, d):
 * V is the root values, T the compiled templates by name, H the helpers and
 * d the include depth. A template's free variables arrive as parameters, and
 * a for's element and loop as locals, so a path reads straight off them.
 */
function compileTemplate(nodes, free, freeMap) {
  const params = ['V', 'T', 'H', ...free.map((f) => `$f_${f}`), 'd'];
  const parts = ['let out="";', 'let _fn;'];
  genNodes(nodes, [], new Set(free), freeMap, parts, { next: 0 });
  parts.push('return out;');
  return new Function(...params, parts.join(''));
}

// ------------------------------------------------------------------ the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      };

/** One site's output tree: path -> text. */
function build(input) {
  const slugCache = new Map();
  const report = [];

  // Templates, parsed in code-unit order of their names; one that does not
  // parse is reported and left out, as if it were not there.
  const asts = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      asts.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Each template's free variables, then each template compiled. When a
  // template cannot be compiled, the whole case falls back to the interpreter.
  const freeMap = new Map();
  for (const [name, nodes] of asts) {
    const free = new Set();
    collectFree(nodes, new Set(), free);
    freeMap.set(name, [...free].sort(byCodeUnits));
  }
  const compiled = new Map();
  let useCompiled = true;
  try {
    for (const [name, nodes] of asts) compiled.set(name, compileTemplate(nodes, freeMap.get(name), freeMap));
  } catch {
    useCompiled = false;
    compiled.clear();
  }
  const T = Object.create(null);
  if (useCompiled) for (const [name, fn] of compiled) T[name] = fn;

  const base = input.site.base_url.replace(/\/+$/, '');

  // The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!asts.has(layout)) {
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

  // Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort(
    (x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug),
  );
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
    // Its link record, read by the neighbours' pages: the same values every time.
    p.linkRec = linkOf(p);
  });

  // The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
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
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [], link: { name, slug, url: `${base}/tags/${slug}/` } };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      const found = bySlug.get(slug);
      if (found !== undefined) return found;
      const link = { name, slug, url: '' };
      return { name, slug, url: '', posts: [], link };
    });
  }
  const tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // A post's card, as lists show it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => t.link),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));

  // A page as its layout reads it.
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: s.newer == null ? null : s.newer.linkRec,
    older: s.older == null ? null : s.older.linkRec,
    is_post: s.post,
  });

  // Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const V = Object.assign(Object.create(null), { site, tags: allTags, recent }, vars);
    if (useCompiled) {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      const free = freeMap.get(name);
      const args = [V, T, H];
      for (let i = 0; i < free.length; i++) args.push(V[free[i]]);
      args.push(0);
      return fn.apply(null, args);
    }
    const nodes = asts.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: V, parent: null }, { templates: asts }, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
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
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let j = 1;
  while (j < target.length) {
    const c = target.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) j++;
    else break;
  }
  return j < target.length && target.charCodeAt(j) === 58;
}
