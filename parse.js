// Markdown renderer matching marked 18.1.3 (default options) byte-for-byte.
// Dependency-free ES module: parse(markdown) -> HTML string.
// Architecture: line-based block dispatch producing a small AST, then a
// single-pass inline scanner with a delimiter stack for emphasis. All
// state is local to each parse() call; nothing is kept between calls.
// Written fresh in this session; behavior verified against the 720-case
// practice set shipped with the contest kit.

const ESCAPABLE = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const PUNCT_RE = /[\p{P}\p{S}]/u;
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// ---------- whitespace and column math (tabs advance to multiples of 4) ----------
function isSpace(ch) { return /\s/.test(ch); }
function indentCols(ln) {
  let col = 0;
  for (let k = 0; k < ln.length; k++) {
    const ch = ln[k];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}
function isBlank(ln) { return /^[ \t]*$/.test(ln); }
function stripCols(ln, target) {
  let col = 0, k = 0;
  while (k < ln.length && col < target) {
    const ch = ln[k];
    if (ch === ' ') { col++; k++; }
    else if (ch === '\t') {
      const adv = 4 - (col % 4);
      if (col + adv > target) return ' '.repeat(col + adv - target) + ln.slice(k + 1);
      col += adv; k++;
    } else break;
  }
  return ln.slice(k);
}
function expandLeadingWs(s, startCol) {
  let col = startCol, k = 0, out = '';
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
    if (s[k] === ' ') { out += ' '; col++; }
    else { const adv = 4 - (col % 4); out += ' '.repeat(adv); col += adv; }
    k++;
  }
  return out + s.slice(k);
}
// Column strip used for list/indented content: a tab straddling the
// boundary becomes spaces and the remainder is expanded from its column;
// a tab starting exactly at the boundary is preserved as-is.
function stripColsX(ln, target) {
  let col = 0, k = 0;
  while (k < ln.length && col < target) {
    const ch = ln[k];
    if (ch === ' ') { col++; k++; }
    else if (ch === '\t') {
      const adv = 4 - (col % 4);
      if (col + adv > target) return ' '.repeat(col + adv - target) + expandLeadingWs(ln.slice(k + 1), col + adv);
      col += adv; k++;
    } else break;
  }
  return ln.slice(k);
}
// Fenced-code indent strip: a tab met while stripping is dropped whole
// without advancing the column count (observed marked behavior).
function stripFence(ln, target) {
  let col = 0, k = 0;
  while (k < ln.length && col < target) {
    const ch = ln[k];
    if (ch === ' ') { col++; k++; }
    else if (ch === '\t') { k++; }
    else break;
  }
  return ln.slice(k);
}
function restOf(ln) { return stripColsX(ln, indentCols(ln)); }
// Strip the first `target` columns of a line (any chars count 1, tabs to
// tab stops); used to carve list-item content after the marker.
function stripPrefixCols(ln, target) {
  let col = 0, k = 0;
  while (k < ln.length && col < target) {
    const ch = ln[k];
    if (ch === '\t') {
      const adv = 4 - (col % 4);
      if (col + adv > target) {
        return ' '.repeat(col + adv - target) + expandLeadingWs(ln.slice(k + 1), col + adv);
      }
      col += adv; k++;
    } else { col++; k++; }
  }
  return expandLeadingWs(ln.slice(k), col);
}

// ---------- text, escapes, entities ----------
function unescapePunct(s) {
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}
function isPunct(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return /[!-\/:-@\[-`{-~]/.test(ch);
  return PUNCT_RE.test(ch);
}
function escHtml(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}
// Decode an entity starting at s[i] === '&'. Named entities pass through
// verbatim (marked never decodes them); numeric refs decode, with U+FFFD
// for 0, surrogates and out-of-range values. Returns [text, next, raw?].
function entityAt(s, i) {
  if (s[i + 1] === '#') {
    const m = /^&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/.exec(s.slice(i, i + 12));
    if (!m) return null;
    let cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return [String.fromCodePoint(cp), i + m[0].length];
  }
  const m = /^&([A-Za-z][A-Za-z0-9]*);/.exec(s.slice(i, i + 40));
  if (!m) return null;
  return [m[0], i + m[0].length, true];
}
function normLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase();
}
function keyOf(rawLabel) { return normLabel(rawLabel.replace(/\\(.)/g, '$1')); }

const ENTITY_LIKE = /^&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);/;
function hrefEscape(dest) {
  let out = '';
  for (let i = 0; i < dest.length; i++) {
    const ch = dest[i];
    if (ch === '&') {
      const m = ENTITY_LIKE.exec(dest.slice(i, i + 40));
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
      out += '&amp;'; continue;
    }
    if (ch === '<') { out += '&lt;'; continue; }
    if (ch === '>') { out += '&gt;'; continue; }
    if (ch === '"') { out += '&quot;'; continue; }
    if (ch === "'") { out += '&#39;'; continue; }
    if (ch === '`') { out += '%60'; continue; }
    const code = dest.charCodeAt(i);
    if (ch === ' ' || ch === '\\' || code < 0x20 || code > 126) {
      const cp = dest.codePointAt(i);
      if (cp > 0xFFFF) i++;
      for (const b of new TextEncoder().encode(String.fromCodePoint(cp))) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      continue;
    }
    out += ch;
  }
  return out;
}
function escTitle(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') {
      const m = ENTITY_LIKE.exec(s.slice(i, i + 40));
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
      out += '&amp;'; continue;
    }
    if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// ---------- link reference definitions ----------
// Parse one definition starting at lines[i] (it may span lines: the
// destination and title may sit on following lines, and the title may
// span lines). Returns lines consumed, 0 when no valid definition starts
// here. The first definition for a label wins.
function tryDef(lines, i, end, defs) {
  if (indentCols(lines[i]) > 3) return 0;
  let wEnd = i;
  while (wEnd < end && wEnd < i + 6 && !isBlank(lines[wEnd])) wEnd++;
  const text = lines.slice(i, wEnd).join('\n');
  const lineOf = (pos) => { let c = 0; for (let k = 0; k < pos; k++) if (text[k] === '\n') c++; return c; };
  let p = 0;
  while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
  if (text[p] !== '[') return 0;
  let depth = 0, label = '', q = p + 1, labelEnd = -1;
  while (q < text.length) {
    const ch = text[q];
    if (ch === '\\' && q + 1 < text.length) { label += text.slice(q, q + 2); q += 2; continue; }
    if (ch === '[') { depth++; label += ch; q++; continue; }
    if (ch === ']') {
      if (depth > 0) { depth--; label += ch; q++; continue; }
      if (text[q + 1] === ':') { labelEnd = q; break; }
      label += ch; q++; continue;
    }
    label += ch; q++;
  }
  if (labelEnd === -1 || label.length === 0 || label.length > 999) return 0;
  q = labelEnd + 2;
  const skipInlineWs = () => { while (q < text.length && (text[q] === ' ' || text[q] === '\t')) q++; };
  skipInlineWs();
  if (text[q] === '\n') { q++; skipInlineWs(); }
  if (q >= text.length) return 0;
  let dest = null;
  if (text[q] === '<') {
    const close = text.indexOf('>', q + 1);
    if (close === -1) return 0;
    const inner = text.slice(q + 1, close);
    if (inner.includes('<') || inner.includes('\n')) return 0;
    dest = unescapePunct(inner);
    q = close + 1;
  } else {
    let depth2 = 0, k = q;
    while (k < text.length) {
      const ch = text[k];
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      if (ch === '\\' && k + 1 < text.length) { k += 2; continue; }
      if (ch === '(') depth2++;
      if (ch === ')') { if (depth2 === 0) break; depth2--; }
      k++;
    }
    if (k === q || depth2 !== 0) return 0;
    dest = unescapePunct(text.slice(q, k));
    q = k;
  }
  let title = null, endPos = q;
  const destEndQ = q;
  let destLineEnd = text.indexOf('\n', q);
  if (destLineEnd === -1) destLineEnd = text.length;
  const saveQ = q;
  skipInlineWs();
  const hadWs = q > saveQ;
  let titleStart = -1;
  if (q < text.length && hadWs && (text[q] === '"' || text[q] === "'" || text[q] === '(')) {
    titleStart = q;
  } else if (q < text.length && text[q] === '\n') {
    let r = q + 1;
    while (r < text.length && (text[r] === ' ' || text[r] === '\t')) r++;
    if (r < text.length && (text[r] === '"' || text[r] === "'" || text[r] === '(')) titleStart = r;
    else endPos = q;
  } else if (q >= text.length) {
    endPos = q;
  } else {
    return 0;
  }
  if (titleStart !== -1) {
    const qc = text[titleStart] === '(' ? ')' : text[titleStart];
    let t = titleStart + 1, tEnd = -1;
    while (t < text.length) {
      if (text[t] === '\\' && t + 1 < text.length) { t += 2; continue; }
      if (text[t] === qc) { tEnd = t; break; }
      t++;
    }
    let titleBad = tEnd === -1;
    if (!titleBad) {
      q = tEnd + 1;
      skipInlineWs();
      if (q < text.length && text[q] !== '\n') titleBad = true;
    }
    if (titleBad) {
      // Title candidate on a LATER line that fails: keep the definition
      // without a title, ending at the destination line. A failed title
      // on the destination's own line invalidates the definition.
      if (lineOf(titleStart) > lineOf(destEndQ)) { title = null; endPos = destLineEnd; }
      else return 0;
    } else {
      title = unescapePunct(text.slice(titleStart + 1, tEnd));
      endPos = q;
    }
  }
  const consumed = lineOf(endPos) + 1;
  const key = keyOf(label);
  if (key && !defs.has(key)) defs.set(key, { dest, title });
  return consumed;
}
function parseDefs(lines, start, end, defs) {
  let i = start, consumed = 0;
  while (i < end) {
    const r = tryDef(lines, i, end, defs);
    if (!r) break;
    i += r; consumed += r;
  }
  return consumed;
}

// ---------- inline parsing ----------
// mode 0: normal; 1: link text (no extended autolinks); 2: probe for
// explicit inner links (no autolinks of either kind).
function inline(text, defs, mode = 0) {
  const nodes = [];
  const delims = [];
  let i = 0;
  const n = text.length;
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ t: 'text', s: buf }); buf = ''; } };
  const prevChar = (idx) => (idx > 0 ? text[idx - 1] : '');
  const nextChar = (idx) => (idx < n ? text[idx] : '');

  while (i < n) {
    const ch = text[i];
    // backslash escape / hard break
    if (ch === '\\' && i + 1 < n) {
      const nx = text[i + 1];
      if (nx === '\n') { flush(); nodes.push({ t: 'br' }); i += 2; continue; }
      if (ESCAPABLE.has(nx)) { buf += nx; i += 2; continue; }
      buf += ch; i++; continue;
    }
    // code span: closes only at a backtick run of the SAME length
    if (ch === '`') {
      let run = 0; while (text[i + run] === '`') run++;
      let close = -1, s = i + run;
      while (s < n) {
        const nx = text.indexOf('`', s);
        if (nx === -1) break;
        let r2 = 0; while (text[nx + r2] === '`') r2++;
        if (r2 === run) { close = nx; break; }
        s = nx + r2;
      }
      if (close !== -1) {
        let content = text.slice(i + run, close);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1);
        flush(); nodes.push({ t: 'code', s: content }); i = close + run; continue;
      }
      buf += '`'.repeat(run); i += run; continue;
    }
    // entity
    if (ch === '&') {
      const e = entityAt(text, i);
      if (e) {
        if (e[2]) { flush(); nodes.push({ t: 'raw', s: e[0] }); }
        else buf += e[0];
        i = e[1]; continue;
      }
      buf += '&'; i++; continue;
    }
    // autolink / inline html
    if (ch === '<') {
      const al = mode < 2 ? tryAutolink(text, i) : null;
      if (al) { flush(); nodes.push(al.node); i = al.next; continue; }
      const tag = tryHtmlTag(text, i);
      if (tag) { flush(); nodes.push({ t: 'html', s: tag.html }); i = tag.next; continue; }
      buf += '<'; i++; continue;
    }
    // link / image
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const isImg = ch === '!';
      const r = tryLink(text, isImg ? i + 1 : i, defs);
      if (r) {
        // links cannot contain links: if the label text itself renders an
        // explicit link, the outer brackets stay literal (autolinks inside
        // link text do not count: extended autolinks are suppressed there,
        // and <...> autolinks nest freely)
        if (!isImg && /<a[\s>]/.test(inline(r.node.text, defs, 2))) { buf += ch; i++; continue; }
        flush();
        if (isImg) r.node.t = 'img';
        nodes.push(r.node); i = r.next; continue;
      }
      buf += ch; i++; continue;
    }
    // emphasis delimiters
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0; while (text[i + run] === ch) run++;
      const before = prevChar(i), after = nextChar(i + run);
      const beforeWS = before === '' || isSpace(before);
      const afterWS = after === '' || isSpace(after);
      const beforeP = isPunct(before), afterP = isPunct(after);
      const leftFlank = !afterWS && (!afterP || beforeWS || beforeP);
      const rightFlank = !beforeWS && (!beforeP || afterWS || afterP);
      let canOpen, canClose;
      if (ch === '_') { canOpen = leftFlank && (!rightFlank || beforeP); canClose = rightFlank && (!leftFlank || afterP); }
      else { canOpen = leftFlank; canClose = rightFlank; }
      flush();
      const node = { t: 'delim', ch, count: run };
      nodes.push(node);
      delims.push({ node, ch, canOpen, canClose, active: true });
      i += run; continue;
    }
    // extended autolinks (suppressed inside link text and probes)
    if (mode === 0) {
      const sc = trySchemeAutolink(text, i);
      if (sc) { flush(); nodes.push(sc.node); i = sc.next; continue; }
      if (i === 0 || isSpace(prevChar(i)) || '*_~('.includes(prevChar(i))) {
        const ea = tryExtendedAutolink(text, i);
        if (ea) { flush(); nodes.push(ea.node); i = ea.next; continue; }
      }
    }
    // newline: hard break if 2+ trailing spaces, else soft
    if (ch === '\n') {
      let spaces = 0, k = buf.length;
      while (k > 0 && buf[k - 1] === ' ') { spaces++; k--; }
      if (spaces >= 2) { buf = buf.slice(0, k); flush(); nodes.push({ t: 'br' }); }
      else { buf += '\n'; }
      i++; continue;
    }
    buf += ch; i++;
  }
  flush();
  resolveEmphasis(nodes, delims);
  return renderInline(nodes, defs);
}

function resolveEmphasis(nodes, delims) {
  // Process closers left to right.
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.canClose || closer.node.count === 0) continue;
    let openerIdx = ci - 1;
    let oddMatch = false;
    while (openerIdx >= 0) {
      const opener = delims[openerIdx];
      if (opener.ch !== closer.ch || !opener.active || !opener.canOpen || opener.node.count === 0) { openerIdx--; continue; }
      if (opener.node === closer.node) break;
      // odd match rule (rule of 3)
      if (opener.canClose && closer.canOpen) {
        const sum = opener.node.count + closer.node.count;
        if (sum % 3 === 0 && (opener.node.count % 3 !== 0 || closer.node.count % 3 !== 0)) { oddMatch = true; openerIdx--; continue; }
      }
      let use = 1;
      if (opener.node.count >= 2 && closer.node.count >= 2) use = 2;
      // wrap nodes between opener and closer
      const oi = nodes.indexOf(opener.node), cix = nodes.indexOf(closer.node);
      const inner = nodes.slice(oi + 1, cix);
      const wrap = { t: closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em', kids: inner };
      nodes.splice(oi, cix - oi + 1, opener.node, wrap, closer.node);
      opener.node.count -= use; closer.node.count -= use;
      if (opener.node.count === 0) opener.active = false;
      if (closer.node.count === 0) break;
      if (oddMatch) break;
      // restart the search just before this closer: the same opener may
      // still hold delimiters (***a*** -> em around strong)
      openerIdx = ci - 1;
    }
  }
}

function renderInline(nodes, defs) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += escHtml(nd.s); break;
      case 'raw': out += nd.s; break;
      case 'code': out += '<code>' + escHtml(nd.s) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'delim': out += escHtml(nd.ch.repeat(nd.count)); break;
      case 'em': out += '<em>' + renderInline(nd.kids, defs) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(nd.kids, defs) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(nd.kids, defs) + '</del>'; break;
      case 'link': out += renderLink(nd, defs); break;
      case 'img': out += renderImg(nd, defs); break;
    }
  }
  return out;
}
function renderLink(nd, defs) {
  const title = nd.title ? ` title="${escTitle(nd.title)}"` : '';
  const inner = nd.literal ? escHtml(nd.text) : inline(nd.text, defs, 1);
  return `<a href="${hrefEscape(nd.dest)}"${title}>${inner}</a>`;
}
function renderImg(nd, defs) {
  const alt = stripTags(inline(nd.text, defs));
  const title = nd.title ? ` title="${escTitle(nd.title)}"` : '';
  return `<img src="${hrefEscape(nd.dest)}" alt="${alt}"${title}>`;
}
function stripTags(html) { return html.replace(/<[^>]*>/g, ''); }

function tryAutolink(text, i) {
  const rest = text.slice(i);
  const m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest);
  if (m) {
    const dest = m[1];
    return { node: { t: 'link', dest, title: null, text: dest, literal: true }, next: i + m[0].length };
  }
  const em = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(rest);
  if (em) {
    return { node: { t: 'link', dest: 'mailto:' + em[1], title: null, text: em[1], literal: true }, next: i + em[0].length };
  }
  return null;
}
function tryHtmlTag(text, i) {
  const rest = text.slice(i);
  let m = /^<!--(>|->|-->|[\s\S]*?-->)/.exec(rest);
  if (m && (m[0].endsWith('-->') || m[0] === '<!-->' || m[0] === '<!--->')) return { html: m[0], next: i + m[0].length };
  m = /^<\?[\s\S]*?\?>/.exec(rest);
  if (m) return { html: m[0], next: i + m[0].length };
  m = /^<![A-Za-z][^>]*>/.exec(rest);
  if (m) return { html: m[0], next: i + m[0].length };
  m = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(rest);
  if (m) return { html: m[0], next: i + m[0].length };
  m = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:'[^'\n]*'|"[^"\n]*"|[^\s"'=<>`]+))?)*[ \t\n]*\/?>/.exec(rest);
  if (m) return { html: m[0], next: i + m[0].length };
  return null;
}

// Find matching ']' for '[' at pos. Returns index or -1.
function findCloseBracket(text, pos) {
  let depth = 0, i = pos;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { i += 2; continue; }
    if (ch === '`') {
      let run = 0; while (text[i + run] === '`') run++;
      let close = -1, s = i + run;
      while (s < text.length) {
        const nx = text.indexOf('`', s);
        if (nx === -1) break;
        let r2 = 0; while (text[nx + r2] === '`') r2++;
        if (r2 === run) { close = nx; break; }
        s = nx + r2;
      }
      if (close !== -1) { i = close + run; continue; }
      i += run; continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}
function tryLink(text, openPos, defs) {
  const close = findCloseBracket(text, openPos);
  if (close === -1) return null;
  const labelText = text.slice(openPos + 1, close);
  if (labelText.length > 999) return null;
  const after = text.slice(close + 1);
  // inline link: (dest "title")
  if (after.startsWith('(')) {
    const r = parseInlineDest(after);
    if (r) return { node: { t: 'link', dest: r.dest, title: r.title, text: labelText }, next: close + 1 + r.used, labelText };
  }
  // full reference [id]
  if (after.startsWith('[')) {
    const end2 = after.indexOf(']', 1);
    if (end2 !== -1) {
      const id = after.slice(1, end2);
      if (id !== '' && id.length <= 999) {
        const d = defs.get(keyOf(id));
        if (d) return { node: { t: 'link', dest: d.dest, title: d.title, text: labelText }, next: close + 1 + end2 + 1 };
      }
      // collapsed []
      if (id === '') {
        const d = defs.get(keyOf(labelText));
        if (d) return { node: { t: 'link', dest: d.dest, title: d.title, text: labelText }, next: close + 1 + 2 };
      }
    }
  }
  // shortcut reference
  if (labelText !== '') {
    const d = defs.get(keyOf(labelText));
    if (d) return { node: { t: 'link', dest: d.dest, title: d.title, text: labelText }, next: close + 1 };
  }
  return null;
}
function parseInlineDest(after) {
  // after starts with '('. Parse dest, optional title, ')'.
  let i = 1;
  while (i < after.length && (after[i] === ' ' || after[i] === '\n')) i++;
  let dest = '', j;
  if (after[i] === '<') {
    j = after.indexOf('>', i + 1);
    if (j === -1) return null;
    const inner = after.slice(i + 1, j);
    if (inner.includes('<') || inner.includes('\n')) return null;
    dest = unescapePunct(inner);
    j++;
  } else {
    let depth = 0, k = i;
    while (k < after.length) {
      const ch = after[k];
      if (ch === ' ' || ch === '\n' || ch === '\r') break;
      if (ch === '\\' && k + 1 < after.length) { k += 2; continue; }
      if (ch === '(') depth++;
      if (ch === ')') { if (depth === 0) break; depth--; }
      k++;
    }
    if (depth !== 0) return null;
    dest = after.slice(i, k).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
    j = k;
  }
  // optional title then ')'
  let k = j;
  while (k < after.length && (after[k] === ' ' || after[k] === '\n')) k++;
  let title = null;
  if (after[k] === '"' || after[k] === "'" || after[k] === '(') {
    const q = after[k];
    const qc = q === '(' ? ')' : q;
    let t = k + 1, tEnd = -1;
    while (t < after.length) {
      if (after[t] === '\\' && t + 1 < after.length) { t += 2; continue; }
      if (after[t] === qc) { tEnd = t; break; }
      if (q !== '(' && after[t] === '\n' && after[t + 1] === '\n') break;
      t++;
    }
    if (tEnd === -1) return null;
    title = after.slice(k + 1, tEnd).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
    k = tEnd + 1;
    while (k < after.length && (after[k] === ' ' || after[k] === '\n')) k++;
  }
  if (after[k] !== ')') return null;
  return { dest, title, used: k + 1 };
}

function trySchemeAutolink(text, i) {
  // scheme URLs form anywhere, with no predecessor restriction (marked),
  // and the scheme itself is case-insensitive
  const m = /^(?:https?|ftp):\/\/[^\s<]*[^\s<]/i.exec(text.slice(i));
  if (!m) return null;
  const url = trimTrail(m[0]);
  return { node: { t: 'link', dest: url, title: null, text: url, literal: true }, next: i + url.length };
}
function tryExtendedAutolink(text, i) {
  const rest = text.slice(i);
  // www. domain: lowercase prefix only, word-boundary predecessor required
  let m = /^www\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+[^\s<]*/.exec(rest);
  if (m) {
    let url = trimTrail(m[0]);
    if (url.length > 4) return { node: { t: 'link', dest: 'http://' + url, title: null, text: url, literal: true }, next: i + url.length };
  }
  // email
  m = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/.exec(rest);
  if (m) {
    const lastLabel = m[0].slice(m[0].lastIndexOf('.') + 1);
    if (/^[A-Za-z]{2,}$/.test(lastLabel) || /[A-Za-z]/.test(lastLabel)) {
      return { node: { t: 'link', dest: 'mailto:' + m[0], title: null, text: m[0], literal: true }, next: i + m[0].length };
    }
  }
  return null;
}
function trimTrail(url) {
  // GFM trailing rules, repeated until stable: strip trailing punctuation
  // (? ! . , : * _ ~), drop unbalanced trailing ')', and cut a trailing
  // entity-like ';' sequence back to '&'.
  let end = url.length;
  for (;;) {
    let changed = false;
    while (end > 0 && '?!,.:*_~'.includes(url[end - 1])) { end--; changed = true; }
    let opens = 0, closes = 0;
    for (let k = 0; k < end; k++) { if (url[k] === '(') opens++; if (url[k] === ')') closes++; }
    while (end > 0 && url[end - 1] === ')' && closes > opens) { end--; closes--; changed = true; }
    if (end > 0 && url[end - 1] === ';') {
      const ampIdx = url.lastIndexOf('&', end - 1);
      if (ampIdx !== -1 && /^&[A-Za-z0-9#]+;$/.test(url.slice(ampIdx, end))) { end = ampIdx; changed = true; }
    }
    if (!changed) break;
  }
  return url.slice(0, end);
}

// ---------- block parsing ----------
function isHrLine(ln) {
  return indentCols(ln) <= 3 && /^((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(restOf(ln));
}
// Strip a blockquote marker from a raw line; null if not a quote line.
function quoteStrip(ln) {
  if (indentCols(ln) > 3) return null;
  let p = 0;
  while (ln[p] === ' ' || ln[p] === '\t') p++;
  if (ln[p] !== '>') return null;
  const rest = expandLeadingWs(ln.slice(p + 1), indentCols(ln) + 1);
  return stripCols(rest, 1);
}
function deepEndsParagraph(blocks) {
  if (!blocks.length) return false;
  const last = blocks[blocks.length - 1];
  if (last.type === 'paragraph') return true;
  if (last.type === 'quote') return deepEndsParagraph(last.children);
  if (last.type === 'list') {
    const it = last.items[last.items.length - 1];
    return it ? deepEndsParagraph(it.children) : false;
  }
  return false;
}
// Shape a lazy continuation line into paragraph content: a setext-looking
// line at indent 0 gains 4 spaces (so it cannot become an underline),
// deeper lines lose 4 columns, anything else is kept as-is.
function transformLazy(ln) {
  const stripped = restOf(ln);
  if (/^(=+|-+)[ \t]*$/.test(stripped) && indentCols(ln) === 0) return '    ' + ln;
  if (indentCols(ln) >= 4) return stripColsX(ln, 4);
  return ln;
}

function parseBlocks(lines, defs, endsNl = false, lazy = null, sepOut = null) {
  const blocks = [];
  let i = 0;
  const n = lines.length;
  let pendingBlank = false;
  while (i < n) {
    if (isBlank(lines[i])) { if (blocks.length > 0) pendingBlank = true; i++; continue; }
    if (pendingBlank) { if (sepOut) sepOut.value = true; pendingBlank = false; }
    // Fenced code
    const rest0 = restOf(lines[i]);
    const fence = indentCols(lines[i]) <= 3 ? /^(`{3,}|~{3,})(.*)$/.exec(rest0) : null;
    if (fence && (fence[1][0] !== '`' || !fence[2].includes('`'))) {
      const ch = fence[1][0], len = fence[1].length;
      const info = unescapePunct(fence[2].trim());
      const fenceIndent = indentCols(lines[i]);
      const content = [];
      i++;
      while (i < n) {
        const close = indentCols(lines[i]) <= 3 ? new RegExp(`^${ch}{${len},}[ \\t]*$`).exec(restOf(lines[i])) : null;
        if (close) { i++; break; }
        content.push(stripFence(lines[i], fenceIndent)); i++;
      }
      let ftext = content.join('\n');
      if (content.length > 0 && !ftext.endsWith('\n')) ftext += '\n';
      blocks.push({ type: 'code', text: ftext, lang: info.split(/\s+/)[0] || null });
      continue;
    }
    // ATX heading
    const atx = indentCols(lines[i]) <= 3 ? /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(rest0) : null;
    if (atx) {
      let content = atx[2] ?? '';
      if (/^[ \t]*#+[ \t]*$/.test(content)) content = '';
      else content = content.replace(/[ \t]+#+[ \t]*$/, '');
      content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      blocks.push({ type: 'heading', depth: atx[1].length, text: content });
      i++;
      continue;
    }
    // Thematic break
    if (isHrLine(lines[i])) {
      blocks.push({ type: 'hr' }); i++; continue;
    }
    // HTML block
    const html = tryHtmlBlock(lines, i);
    if (html) {
      html.block.trailNl = (html.next < n && !isBlank(lines[html.next])) || (html.next >= n && endsNl);
      blocks.push(html.block); i = html.next; continue;
    }
    // Blockquote
    if (indentCols(lines[i]) <= 3 && rest0.startsWith('>')) {
      const inner = [];
      const lazyIdx = new Set();
      let lastWasBlank = false;
      while (i < n) {
        const ln = lines[i];
        const qs = quoteStrip(ln);
        if (qs !== null) { lastWasBlank = isBlank(qs); inner.push(qs); i++; continue; }
        if (isBlank(ln)) break;
        // lazy continuation: only when the inner content ends with a
        // paragraph, the line starts no interrupting block, no blank
        // quote line intervened, and the line is not a definition
        if (lastWasBlank) break;
        if (interruptsParagraph(ln)) break;
        if (tryDef(lines, i, n, defs) > 0) break; // a definition ends the quote
        const prev = parseBlocks(inner, new Map(defs), false, lazyIdx);
        if (prev.length > 0 && deepEndsParagraph(prev)) {
          lazyIdx.add(inner.length);
          inner.push(transformLazy(ln)); i++; continue;
        }
        break;
      }
      blocks.push({ type: 'quote', children: parseBlocks(inner, defs, false, lazyIdx) });
      continue;
    }
    // List
    const listStart = matchListMarker(lines[i]);
    if (listStart) {
      const r = parseList(lines, i, defs);
      blocks.push(r.block); i = r.next;
      continue;
    }
    // Table: header line + delimiter line
    if (i + 1 < n && !isBlank(lines[i]) && indentCols(lines[i]) <= 3 && indentCols(lines[i + 1]) <= 3 && parseDelimRow(lines[i + 1]) && (lines[i].includes('|') && lines[i + 1].includes('|') || lines[i + 1].includes(':'))) {
      const aligns = parseDelimRow(lines[i + 1]);
      const header = splitCells(lines[i]);
      const rows = [];
      i += 2;
      while (i < n && !isBlank(lines[i])) {
        rows.push(splitCells(lines[i])); i++;
      }
      blocks.push({ type: 'table', aligns, header, rows });
      continue;
    }
    // Indented code
    if (indentCols(lines[i]) >= 4) {
      const content = [];
      while (i < n) {
        if (isBlank(lines[i])) {
          // peek: include blank only if followed by indented line
          let k = i;
          while (k < n && isBlank(lines[k])) k++;
          if (k < n && indentCols(lines[k]) >= 4) { while (i < k) { content.push(stripColsX(lines[i], 4)); i++; } continue; }
          break;
        }
        if (indentCols(lines[i]) < 4) break;
        content.push(stripColsX(lines[i], 4)); i++;
      }
      while (content.length && isBlank(content[content.length - 1])) content.pop();
      blocks.push({ type: 'code', text: content.length ? content.join('\n') + '\n' : '', lang: null });
      continue;
    }
    // Paragraph (with leading link definitions + setext)
    const consumed = parseDefs(lines, i, n, defs);
    i += consumed;
    if (consumed > 0) continue;
    if (i >= n || isBlank(lines[i])) continue;
    const paraLines = [];
    while (i < n) {
      const ln = lines[i];
      if (isBlank(ln)) break;
      // setext underline? (never for a lazy continuation line)
      const isLazyLine = lazy !== null && lazy.has(i);
      const setext = indentCols(ln) <= 3 && !isLazyLine ? /^(=+|-+)[ \t]*$/.exec(restOf(ln)) : null;
      if (setext && paraLines.length > 0) {
        blocks.push({ type: 'heading', depth: setext[1][0] === '=' ? 1 : 2, text: paraLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') });
        paraLines.length = 0; i++;
        break;
      }
      if (paraLines.length > 0 && !isLazyLine && interruptsParagraph(ln)) break;
      paraLines.push(ln); i++;
    }
    if (paraLines.length) blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
  }
  return blocks;
}

function interruptsParagraph(ln) {
  if (indentCols(ln) > 3) return false;
  const rest = restOf(ln);
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return true;
  if (/^(`{3,}|~{3,})/.test(rest)) return true;
  if (rest.startsWith('>')) return true;
  if (isHrLine(ln)) return true;
  const lm = matchListMarker(ln);
  if (lm) {
    if (lm.firstContent.trim() === '') return false; // empty item: cannot interrupt
    if (lm.ordered) return lm.num === 1;
    return true;
  }
  if (tryHtmlBlock([ln], 0, true)) return true;
  return false;
}

function matchListMarker(ln) {
  const ind = indentCols(ln);
  if (ind > 3) return null;
  const rest = stripCols(ln, ind);
  let ordered = false, bullet = null, delim = null, num = 0, markerLen = 0, wsRun = '';
  let m = /^([*+-])([ \t]*)/.exec(rest);
  if (m && (m[2].length > 0 || rest.length === 1)) {
    bullet = m[1]; markerLen = 1; wsRun = m[2];
  } else {
    m = /^(\d{1,9})([.)])([ \t]*)/.exec(rest);
    if (!m || (m[3].length === 0 && rest.length !== m[1].length + 1)) return null;
    ordered = true; num = parseInt(m[1], 10); delim = m[2]; markerLen = m[1].length + 1; wsRun = m[3];
  }
  const afterWs = rest.slice(markerLen + wsRun.length);
  let col = ind + markerLen;
  for (const ch of wsRun) { if (ch === ' ') col++; else col += 4 - (col % 4); }
  const wsCols = col - (ind + markerLen);
  let contentIndent;
  if (afterWs === '') contentIndent = ind + markerLen + 1;
  else if (wsCols >= 1 && wsCols <= 4) contentIndent = ind + markerLen + wsCols;
  else contentIndent = ind + markerLen + 1;
  return { ordered, bullet, delim, num, markerLen, contentIndent, firstContent: stripPrefixCols(ln, contentIndent) };
}

function parseList(lines, start, defs) {
  const first = matchListMarker(lines[start]);
  const items = [];
  let i = start;
  let loose = false;
  const listOrdered = first.ordered, listDelim = first.delim, listBullet = first.bullet;
  while (i < lines.length) {
    const lm = matchListMarker(lines[i]);
    if (!lm || isHrLine(lines[i])) break;
    if (lm.ordered !== listOrdered) break;
    if (listOrdered && lm.delim !== listDelim) break;
    if (!listOrdered && lm.bullet !== listBullet) break;
    // content indent: marker + spaces (1..4) else marker + 1
    const contentIndent = lm.contentIndent;
    const itemLines = [];
    const lazyIdx = new Set();
    const firstContent = lm.firstContent;
    itemLines.push(firstContent);
    i++;
    let blankRun = 0, sawBlankAfter = false, sepBlank = false;
    while (i < lines.length) {
      const ln = lines[i];
      if (isBlank(ln)) {
        if (!itemLines.some((x) => !isBlank(x))) {
          // empty item followed by a blank line: the item ends; the list
          // continues only if a same-list marker follows the blank run
          let k = i + 1;
          while (k < lines.length && isBlank(lines[k])) k++;
          const nlm = k < lines.length ? matchListMarker(lines[k]) : null;
          if (nlm && !isHrLine(lines[k]) && nlm.ordered === listOrdered && (!listOrdered || nlm.delim === listDelim) && (listOrdered || nlm.bullet === listBullet)) {
            loose = true; i = k; break;
          }
          break;
        }
        // look ahead: if next non-blank is indented enough or a new item, blank belongs to list
        let k = i + 1;
        while (k < lines.length && isBlank(lines[k])) k++;
        if (k >= lines.length) { i = k; break; }
        const indK = indentCols(lines[k]);
        if (indK >= contentIndent) {
          blankRun += (k - i); sawBlankAfter = true;
          for (let b = 0; b < k - i; b++) itemLines.push('');
          i = k; continue;
        }
        const nlm = matchListMarker(lines[k]);
        if (nlm && !isHrLine(lines[k]) && nlm.ordered === listOrdered && (!listOrdered || nlm.delim === listDelim) && (listOrdered || nlm.bullet === listBullet)) {
          blankRun += (k - i); sawBlankAfter = true; sepBlank = true; i = k; break;
        }
        // next content belongs to neither this item nor the list: leave i
        // on the blank line so the enclosing level sees the separation
        break;
      }
      const ind = indentCols(ln);
      if (ind >= contentIndent) { itemLines.push(stripColsX(ln, contentIndent)); i++; continue; }
      const nlm = matchListMarker(ln);
      if (nlm && !isHrLine(ln) && nlm.ordered === listOrdered && (!listOrdered || nlm.delim === listDelim) && (listOrdered || nlm.bullet === listBullet)) break;
      // lazy continuation: the line joins the item's trailing paragraph
      // (never a list marker line: it starts a new item or a new list;
      // never a link definition line: it ends the item)
      if (!matchListMarker(ln) && !interruptsParagraph(ln) && tryDef(lines, i, lines.length, defs) === 0) {
        const prev = parseBlocks(itemLines, new Map(defs), false, lazyIdx);
        if (prev.length > 0 && deepEndsParagraph(prev)) {
          lazyIdx.add(itemLines.length);
          itemLines.push(transformLazy(ln)); i++; continue;
        }
      }
      // less indented non-blank: ends item (and possibly list)
      break;
    }
    if (blankRun > 0) {
      // trailing blanks inside item: drop from item lines
      while (itemLines.length && itemLines[itemLines.length - 1] === '') itemLines.pop();
    }
    if (sepBlank) loose = true; // blank line separating two items
    // task marker?
    let task = null;
    if (itemLines.length) {
      const tm = /^\[([ xX])\][ ]+(.*)$/s.exec(itemLines[0]);
      if (tm) { task = tm[1] !== ' '; itemLines[0] = tm[2]; }
    }
    items.push({ lines: itemLines, task, startNum: lm.num, lazy: lazyIdx });
    if (sawBlankAfter && blankRun > 0 && i >= lines.length) break;
    if (i >= lines.length) break;
    // continue loop if next line is a list item of same list
    const nx = matchListMarker(lines[i]);
    if (!nx || isHrLine(lines[i]) || nx.ordered !== listOrdered || (listOrdered && nx.delim !== listDelim) || (!listOrdered && nx.bullet !== listBullet)) break;
  }
  // Looseness: blank line between items (handled above) or a blank line
  // separating two blocks inside an item, judged at the item's own level.
  const parsedItems = items.map((it) => {
    const sep = { value: false };
    const kids = parseBlocks(it.lines, defs, false, it.lazy, sep);
    if (sep.value) loose = true;
    return { children: kids, task: it.task };
  });
  return {
    next: i,
    block: { type: 'list', ordered: listOrdered, delim: listDelim, start: first.num ?? 1, loose, items: parsedItems },
  };
}

function parseDelimRow(ln) {
  const t = ln.trim();
  if (!/^\|?[\s:|-]+\|?$/.test(t)) return null;
  if (!t.includes('-')) return null;
  let cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|');
  const aligns = [];
  for (const c of cells) {
    const cc = c.trim();
    if (!/^:?-+:?$/.test(cc)) return null;
    aligns.push(cc.startsWith(':') && cc.endsWith(':') ? 'center' : cc.startsWith(':') ? 'left' : cc.endsWith(':') ? 'right' : null);
  }
  return aligns;
}
function unescapePipe(s) {
  let out = '', k = 0;
  while (k < s.length) {
    if (s[k] === '\\' && k + 1 < s.length && s[k + 1] === '\\') { out += '\\\\'; k += 2; continue; }
    if (s[k] === '\\' && k + 1 < s.length && s[k + 1] === '|') { out += '|'; k += 2; continue; }
    out += s[k]; k++;
  }
  return out;
}
function splitCells(ln) {
  let s = ln.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', k = 0;
  while (k < s.length) {
    const ch = s[k];
    if (ch === '\\' && k + 1 < s.length && s[k + 1] === '\\') { cur += '\\\\'; k += 2; continue; }
    if (ch === '\\' && k + 1 < s.length && s[k + 1] === '|') { cur += '\\|'; k += 2; continue; }
    if (ch === '`') {
      let run = 0; while (s[k + run] === '`') run++;
      let close = -1, ss = k + run;
      while (ss < s.length) {
        const nx = s.indexOf('`', ss);
        if (nx === -1) break;
        let r2 = 0; while (s[nx + r2] === '`') r2++;
        if (r2 === run) { close = nx; break; }
        ss = nx + r2;
      }
      if (close !== -1) { cur += s.slice(k, close + run); k = close + run; continue; }
      cur += ch; k++; continue;
    }
    if (ch === '|') { cells.push(unescapePipe(cur.trim())); cur = ''; k++; continue; }
    cur += ch; k++;
  }
  cells.push(unescapePipe(cur.trim()));
  return cells;
}

function tryHtmlBlock(lines, i, singleLineOnly = false) {
  const ln = lines[i];
  if (indentCols(ln) > 3) return null;
  const rest = restOf(ln);
  let endRe = null, type = 0;
  if (/^<!--/.test(rest)) { endRe = /-->/; type = 2; }
  else if (/^<\?/.test(rest)) { endRe = /\?>/; type = 3; }
  else if (/^<![A-Za-z]/.test(rest)) { endRe = />/; type = 4; }
  else if (/^<!\[CDATA\[/.test(rest)) { endRe = /\]\]>/; type = 5; }
  else {
    const m1 = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    if (m1) {
      const name = m1[1].toLowerCase();
      const after = rest.slice(m1[0].length);
      if (/^(?:script|pre|style|textarea)$/.test(name) && /^(?:[ \t>]|$)/.test(after)) {
        endRe = new RegExp(`</${name}[ \\t>]`, 'i'); type = 1;
      } else if (BLOCK_TAGS.has(name) && /^(?:[ \t>\/]|$)/.test(after)) {
        endRe = null; type = 6;
      } else if (type === 0 && !singleLineOnly) {
        // type 7: complete tag alone on line
        if (/^<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:'[^']*'|"[^"]*"|[^\s"'=<>`]+))?)*[ \t]*\/?>[ \t]*$/.test(rest)) {
          endRe = null; type = 7;
        }
      }
    }
  }
  if (type === 0) return null;
  if (singleLineOnly) return type <= 6 ? { block: null, next: i } : null;
  const content = [ln];
  let j = i + 1;
  if (type === 1 || type === 2 || type === 3 || type === 4 || type === 5) {
    if (endRe.test(rest.slice(rest.indexOf('>') + 1)) || (type !== 1 && endRe.test(rest))) {
      // end on same line: for type 2-5 check remainder after start marker
      const startLen = type === 2 ? 4 : type === 3 ? 2 : type === 5 ? 9 : 2;
      if (endRe.test(rest.slice(startLen))) return { block: { type: 'html', text: ln }, next: i + 1 };
    }
    while (j < lines.length) {
      content.push(lines[j]);
      if (endRe.test(lines[j])) { j++; break; }
      j++;
    }
    return { block: { type: 'html', text: content.join('\n') }, next: j };
  }
  // types 6, 7: until blank line
  while (j < lines.length && !isBlank(lines[j])) { content.push(lines[j]); j++; }
  return { block: { type: 'html', text: content.join('\n') }, next: j };
}

// ---------- rendering ----------
function renderBlock(b, defs) {
  switch (b.type) {
    case 'heading': return `<h${b.depth}>${inline(b.text, defs)}</h${b.depth}>\n`;
    case 'paragraph': return `<p>${inline(b.text, defs)}</p>\n`;
    case 'hr': return '<hr>\n';
    case 'code': {
      const cls = b.lang ? ` class="language-${escTitle(b.lang)}"` : '';
      return `<pre><code${cls}>${escHtml(b.text)}</code></pre>\n`;
    }
    case 'html': return b.text + (b.trailNl ? '\n' : '');
    case 'quote': return `<blockquote>\n${b.children.map((c) => renderBlock(c, defs)).join('')}</blockquote>\n`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
      let out = `<${tag}${start}>\n`;
      for (const it of b.items) {
        let inner;
        if (b.loose) {
          // task checkbox goes inside the first paragraph when there is one
          let placed = false;
          inner = it.children.map((c, idx) => {
            if (!placed && idx === 0 && c.type === 'paragraph' && it.task !== null) {
              placed = true;
              return `<p>${taskHtml(it.task)}${inline(c.text, defs)}</p>\n`;
            }
            return renderBlock(c, defs);
          }).join('');
          out += `<li>${!placed && it.task !== null ? taskHtml(it.task) : ''}${inner}</li>\n`;
        } else {
          inner = it.children.map((c) => {
            if (c.type === 'paragraph') return inline(c.text, defs);
            return renderBlock(c, defs);
          }).join('');
          out += `<li>${it.task !== null ? taskHtml(it.task) : ''}${inner}</li>\n`;
        }
      }
      return out + `</${tag}>\n`;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      b.header.forEach((cell, idx) => {
        const a = b.aligns[idx] ? ` align="${b.aligns[idx]}"` : '';
        out += `<th${a}>${inline(cell, defs)}</th>\n`;
      });
      out += '</tr>\n</thead>\n<tbody>';
      for (const row of b.rows) {
        out += '<tr>\n';
        for (let idx = 0; idx < b.header.length; idx++) {
          const a = b.aligns[idx] ? ` align="${b.aligns[idx]}"` : '';
          out += `<td${a}>${inline(row[idx] ?? '', defs)}</td>\n`;
        }
        out += '</tr>\n';
      }
      return out + '</tbody></table>\n';
    }
  }
  return '';
}
function taskHtml(checked) {
  return checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ';
}

// ---------- entry point ----------
export function parse(markdown) {
  const defs = new Map();
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n'); // tabs preserved; structure uses column math
  if (src.endsWith('\n')) lines.pop(); // trailing '' is a split artifact, not a line
  // First pass collects link reference definitions document-wide (forward
  // references resolve); the second pass builds the rendered block tree.
  parseBlocks(lines, defs, src.endsWith('\n'));
  const blocks = parseBlocks(lines, defs, src.endsWith('\n'));
  return blocks.map((b) => renderBlock(b, defs)).join('');
}
