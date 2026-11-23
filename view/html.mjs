// 页内 HTML 预览（设计第 27 节）：解码、解析、清洗重建。
// 1) decodeHtmlBytes：纯函数，BOM 优先，再预扫前 1024 字节的 meta（借用 WHATWG 的属性扫描和 pragma 规则）；
// 2) sanitizeHtml / renderHtml：用显式栈遍历解析树，按策略表在页面里重建节点；URL、图片、代码块一律走 rich.mjs，这里不另写一套。
// 清洗器从解析树上只读 nodeType、data、namespaceURI、localName、getAttribute、childNodes，重建只用 createElement、createTextNode、append、setAttribute。
import { h } from './dom.mjs';
import { appendAll } from './highlight.mjs';
import { RICH_UI_ATTR, classifyImage, createImageBudget, renderCodeBlock, renderImage, renderLink, safeDecode, safeLinkTarget } from './rich.mjs';

// ---- 解码（第 27.2 节第 2 步）----

// WHATWG 里映射到 replacement 的标签：TextDecoder 对它们抛 RangeError，和「认不出」分开处理：命中就停止扫描、按 UTF-8。
const REPLACEMENT_LABELS = new Set(['iso-2022-kr', 'hz-gb-2312', 'csiso2022kr', 'iso-2022-cn', 'iso-2022-cn-ext', 'replacement']);
// 规范化后落在这几个上的，一律改按 UTF-8（UTF-16 的 meta 本身就不可信；x-user-defined 不换成 windows-1252）。
const UTF8_ONLY = new Set(['utf-16le', 'utf-16be', 'replacement', 'x-user-defined']);
const PRESCAN_BYTES = 1024;

const isSpace = code => code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
const asciiLower = text => text.replace(/[A-Z]/g, char => char.toLowerCase());

// 标签 → 规范化后的编码名；命中 replacement 表返回 'replacement'（调用方停止扫描）；认不出返回 null（继续往后找）。
function resolveLabel(label) {
  const clean = asciiLower(label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''));
  if (REPLACEMENT_LABELS.has(clean)) return 'replacement';
  try { return new TextDecoder(clean).encoding; } catch { return null; }
}

// WHATWG「从 meta 元素提取字符编码」：在 content 里找 charset=，取引号里或到空白、分号为止的值。
function charsetOfContent(value) {
  let at = 0;
  for (;;) {
    const found = value.indexOf('charset', at);
    if (found < 0) return null;
    at = found + 7;
    while (isSpace(value.charCodeAt(at))) at++;
    if (value[at] !== '=') continue;
    at++;
    while (isSpace(value.charCodeAt(at))) at++;
    const quote = value[at];
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, at + 1);
      return close < 0 ? null : value.slice(at + 1, close);
    }
    let end = at;
    while (end < value.length && !isSpace(value.charCodeAt(end)) && value[end] !== ';') end++;
    return value.slice(at, end);
  }
}

// WHATWG「预扫字节流确定编码」：只看前 1024 字节；跳过注释，对每个标签都按属性边界吃掉属性，所以写在属性值里的假 meta 不算。
// 返回规范化后的编码名；没有声明（或声明都认不出）返回 null；命中 replacement 表返回 'replacement'。
function prescan(bytes) {
  const end = Math.min(bytes.length, PRESCAN_BYTES);
  let p = 0;
  const startsWith = (text, from = p) => {
    for (let i = 0; i < text.length; i++) {
      const byte = from + i < end ? bytes[from + i] : -1;
      if ((byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte) !== text.charCodeAt(i)) return false;
    }
    return true;
  };
  const at = index => (index < end ? bytes[index] : -1);
  const isLetter = byte => (byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x7a;
  const lower = byte => String.fromCharCode(byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);
  // 取一个属性；没有了（遇到 > 或数据到头）返回 null。
  const getAttribute = () => {
    while (p < end && (isSpace(bytes[p]) || bytes[p] === 0x2f)) p++;
    if (p >= end || bytes[p] === 0x3e) return null;
    let name = '', value = '';
    for (;;) {
      if (p >= end) return null;
      const byte = bytes[p];
      if (byte === 0x3d && name.length > 0) { p++; break; }
      if (isSpace(byte)) {
        while (p < end && isSpace(bytes[p])) p++;
        if (p >= end) return null;
        if (bytes[p] !== 0x3d) return { name, value };
        p++;
        break;
      }
      if (byte === 0x2f || byte === 0x3e) return { name, value };
      name += lower(byte);
      p++;
    }
    while (p < end && isSpace(bytes[p])) p++;
    if (p >= end) return null;
    const first = bytes[p];
    if (first === 0x22 || first === 0x27) {
      for (p++; p < end; p++) {
        if (bytes[p] === first) { p++; return { name, value }; }
        value += lower(bytes[p]);
      }
      return null;
    }
    if (first === 0x3e) return { name, value };
    for (; p < end; p++) {
      if (isSpace(bytes[p]) || bytes[p] === 0x3e) return { name, value };
      value += lower(bytes[p]);
    }
    return null;
  };
  while (p < end) {
    if (bytes[p] !== 0x3c) { p++; continue; }
    if (startsWith('<!--')) {
      let close = p + 2;
      while (close + 2 < end && !(bytes[close] === 0x2d && bytes[close + 1] === 0x2d && bytes[close + 2] === 0x3e)) close++;
      if (close + 2 >= end) return null;
      p = close + 3;
      continue;
    }
    if (startsWith('<meta') && (isSpace(at(p + 5)) || at(p + 5) === 0x2f)) {
      p += 5;
      const seen = new Set();
      let gotPragma = false, needPragma = null, charset; // charset：undefined 没设过，null 设了但认不出
      for (let attr; (attr = getAttribute());) {
        if (seen.has(attr.name)) continue;
        seen.add(attr.name);
        if (attr.name === 'http-equiv') {
          if (attr.value === 'content-type') gotPragma = true;
        } else if (attr.name === 'content') {
          const extracted = charset === undefined ? charsetOfContent(attr.value) : null;
          const resolved = extracted === null ? null : resolveLabel(extracted);
          if (resolved !== null) { charset = resolved; needPragma = true; }
        } else if (attr.name === 'charset') {
          charset = resolveLabel(attr.value);
          needPragma = false;
        }
      }
      if (needPragma !== null && (!needPragma || gotPragma) && charset) return charset;
    } else if (isLetter(at(p + 1)) || (at(p + 1) === 0x2f && isLetter(at(p + 2)))) { // 其他标签：也按属性边界吃掉属性
      while (p < end && !isSpace(bytes[p]) && bytes[p] !== 0x3e) p++;
      while (getAttribute());
    } else if (at(p + 1) === 0x21 || at(p + 1) === 0x2f || at(p + 1) === 0x3f) { // <! </ <?：跳到下一个 >
      while (p < end && bytes[p] !== 0x3e) p++;
    }
    p++;
  }
  return null;
}

// 把读到的字节解码成文本（「预览」和「源码」共用）：有 UTF-8 BOM 就按 UTF-8；否则预扫 meta；没有声明、声明认不出、
// 或规范化后是 UTF-16、replacement、x-user-defined 的，按 UTF-8。不采用标准里的两条：退到 XML 声明、把 x-user-defined 换成 windows-1252。
// 截断的文件（truncated 为真）用流式解码，只丢末尾没写完的字节；文件里本来就有的 U+FFFD 原样保留。
export function decodeHtmlBytes(bytes, truncated = false) {
  let encoding = 'utf-8';
  if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    const found = prescan(bytes);
    if (found && !UTF8_ONLY.has(found)) encoding = found;
  }
  const decoder = new TextDecoder(encoding);
  return truncated ? decoder.decode(bytes, { stream: true }) : decoder.decode(bytes);
}

// ---- 清洗重建（第 27.3、27.4 节）----

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATH_NS = 'http://www.w3.org/1998/Math/MathML';

export const INPUT_LIMIT = 300_000; // 输入遍历最多这么多个源节点
export const OUTPUT_LIMIT = 100_000; // 输出最多这么多个节点
export const OUTPUT_RESERVE = 16; // 只为全局截断提示预留；正文和其余一切（含「内容很少」提示、折叠结构）最多用到 OUTPUT_LIMIT - OUTPUT_RESERVE
export const MAX_DEPTH = 256;
export const MAX_TABLE_NESTING = 3;
export const MAX_COLUMNS = 100;
export const MAX_GRID_CELLS = 10_000;
const MAX_COLSPAN = 50;
const MAX_ROWSPAN = 100;
const FEW_CHARS = 80;
const TITLE_CHARS = 80; // 元信息里最多 80 字
const BODY_LIMIT = OUTPUT_LIMIT - OUTPUT_RESERVE;

const KEEP = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr', 'br', 'details', 'summary', 'figure', 'figcaption', 'strong', 'b', 'em', 'i', 's', 'del', 'strike', 'u', 'ins', 'kbd', 'samp', 'var', 'sub', 'sup', 'mark', 'small', 'abbr', 'q', 'cite', 'dfn', 'time']);
const AS_DIV = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'address', 'center', 'hgroup', 'search', 'form', 'fieldset']);
const DROP = new Set(['script', 'style', 'template', 'title', 'link', 'meta', 'base', 'map', 'area', 'input', 'select', 'textarea', 'option', 'optgroup', 'datalist', 'output', 'progress', 'meter', 'dialog', 'portal', 'source', 'track', 'param', 'noembed', 'noframes', 'colgroup', 'col']);
const EMBED = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'applet']);
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption']);
const ROW_GROUPS = new Set(['thead', 'tbody', 'tfoot']);
// 这些容器里只有结构，没有排版意义的空白文字，不建节点。
const STRUCTURAL = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'dl']);
const ALIGN_TAGS = new Set(['p', 'div', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const ALIGNS = new Set(['left', 'center', 'right']);
const LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,4}$/;
const FENCE_LANG_RE = /(?:^|\s)(?:language|lang)-([a-z0-9_+-]+)/;
const WS_RUN = /[\t\r\n ]+/g;
// 控制字符（制表、换行等空白类的先换成空格）和 BiDi 覆盖字符。
const STRIP_RE = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

// 去掉控制字符和 BiDi 覆盖字符，再折叠空白、截长（不在代理对中间切）。
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/[\t\n\f\r]/g, ' ').replace(STRIP_RE, '').replace(/\s+/g, ' ').trim();
  if (text.length > max) {
    text = text.slice(0, max);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  }
  return text;
}

// 内联 style 里只读这几句：display:none、visibility:hidden（判断「整个跳过」）和 text-align；style 本身不输出。
function styleFacts(style) {
  let hidden = false, align = null;
  for (const declaration of style.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).replace(/!important/i, '').trim().toLowerCase();
    if ((name === 'display' && value === 'none') || (name === 'visibility' && value === 'hidden')) hidden = true;
    else if (name === 'text-align') align = value;
  }
  return { hidden, align };
}

// 整个跳过：带 hidden 的、aria-hidden="true" 的、内联 style 里有 display:none 或 visibility:hidden 的。
function isSkipped(node) {
  if (node.getAttribute('hidden') !== null) return true;
  const aria = node.getAttribute('aria-hidden');
  if (aria !== null && aria.trim().toLowerCase() === 'true') return true;
  const style = node.getAttribute('style');
  return style !== null && styleFacts(style).hidden;
}

function alignClass(node) {
  const style = node.getAttribute('style');
  let value = style !== null ? styleFacts(style).align : null;
  if (!ALIGNS.has(value)) value = (node.getAttribute('align') ?? '').trim().toLowerCase();
  return ALIGNS.has(value) ? `md-align-${value}` : null;
}

// 属性表里「任意元素」的三项：title、lang、dir（链接的 title 交给 renderLink，不在这里设）。
function setCommonAttributes(el, node, withTitle = true) {
  const title = withTitle ? cleanText(node.getAttribute('title'), 500) : '';
  if (title) el.setAttribute('title', title);
  const lang = node.getAttribute('lang');
  if (typeof lang === 'string' && lang.length <= 35 && LANG_RE.test(lang)) el.setAttribute('lang', lang);
  const dir = node.getAttribute('dir')?.trim().toLowerCase();
  if (dir === 'ltr' || dir === 'rtl' || dir === 'auto') el.setAttribute('dir', dir);
}

const spanOf = (node, name, max) => {
  const value = Number.parseInt(node.getAttribute(name) ?? '', 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : 1;
};

// 量输出树：节点数和元素的层数（挂上之前量 rich.mjs 产出的块，计入预算和深度）。
function measure(root) {
  let count = 0, height = 0;
  const todo = [[root, 1]];
  while (todo.length) {
    const [node, level] = todo.pop();
    count++;
    if (typeof node.tagName === 'string') height = Math.max(height, level);
    const kids = node.childNodes ?? node.children ?? [];
    for (let i = 0; i < kids.length; i++) todo.push([kids[i], level + 1]);
  }
  return { count, height };
}

const visibleLength = text => text.replace(/\s/g, '').length;

const note = (text, extra = null) => h('div', { class: 'md-note secondary', [RICH_UI_ATTR]: '' }, text, extra);

// 清洗 root（解析出的文档，或任何只带那六样只读属性的树），在页面里重建。
// options 同 renderMarkdown：basePath、resolveImage、onOpenExternal、onOpenRelative、onCopyEmail、isCurrent；另有 onViewSource（「看源码」按钮）。
// 返回 { node, anchors, images, scripts, visibleChars, capped, title }：
//   node：.md 容器；anchors：Map（原始 id 或 a 的 name → 输出节点）；images：本地图片清单（{ img, path, fail }）；scripts：遍历到的 script 数；
//   visibleChars：清洗后可见文字字数；capped：触到输入或输出上限（到上限就停，所以刚好用满也算）；title：head 里第一个 title（已清洗、最多 80 字），没有是空串。
export function sanitizeHtml(tree, { basePath = '', resolveImage = null, onOpenExternal = null, onOpenRelative = null, onCopyEmail = null, onViewSource = null, isCurrent = () => true } = {}) {
  const anchors = new Map();
  const images = [];
  const imageBudget = createImageBudget();
  const asides = [];
  const st = { input: 0, output: 1, stop: false, capped: false, scripts: 0, chars: 0, title: null, hasMain: false };
  const handlers = { onOpenExternal, onOpenRelative, onCopyEmail, lookupAnchor: fragment => anchors.get(safeDecode(fragment)) ?? null };

  // 输出预算：放不下就停；刚好用满也停（「到上限就停」）。
  const spend = count => {
    if (st.output + count > BODY_LIMIT) { st.capped = st.stop = true; return false; }
    st.output += count;
    if (st.output === BODY_LIMIT) st.capped = st.stop = true;
    return true;
  };
  // 输入预算：主遍历和所有子遍历共用这一个计数；返回这个节点能不能处理。
  const tick = () => {
    if (st.input >= INPUT_LIMIT) return false;
    if (++st.input >= INPUT_LIMIT) st.capped = st.stop = true;
    return true;
  };

  // 输出容器：el 是挂节点的地方，buf 是还没建节点的相邻文字（拼好再建，一次一个文本节点）。
  const newSlot = (el, parent, levels = 1, noText = false) => ({ el, buf: '', depth: parent.depth + levels, noText, afterLink: false });
  const canNest = (slot, levels) => slot.depth + levels <= MAX_DEPTH;
  const flush = slot => {
    if (slot.buf === '') return true;
    const text = slot.buf.replace(WS_RUN, ' ');
    slot.buf = '';
    if (slot.noText && text === ' ') return true;
    if (!spend(1)) return false;
    st.chars += visibleLength(text);
    slot.el.append(document.createTextNode(text));
    return true;
  };
  const addText = (slot, data) => {
    if (data === '') return;
    slot.buf += data;
    slot.afterLink = false;
  };
  const put = (slot, node) => {
    slot.el.append(node);
    slot.afterLink = false;
  };
  const emit = (slot, tag, cost = 1) => {
    if (!flush(slot) || !spend(cost)) return null;
    const el = document.createElement(tag);
    put(slot, el);
    return el;
  };
  const placeholder = (slot, text) => {
    if (!canNest(slot, 1) || !flush(slot) || !spend(2)) return null;
    const el = h('span', { class: 'md-img-fallback secondary', [RICH_UI_ATTR]: '' }, text);
    put(slot, el);
    return el;
  };

  // 锚点：先出现的优先，后来的不覆盖；输出的 DOM 不写任何来自文件的 id 或 name。
  const anchorKey = node => {
    const id = node.getAttribute('id');
    if (id) return id;
    return node.localName === 'a' ? node.getAttribute('name') || null : null;
  };
  const register = (node, out) => {
    const key = anchorKey(node);
    if (key && !anchors.has(key)) anchors.set(key, out);
  };
  // 层数用完、放不下新元素时，锚点并入当前这一层：登记所在的容器（链接的标签暂存区不是元素，不登记）。
  const registerHost = (node, slot) => {
    const key = anchorKey(node);
    if (key && !anchors.has(key) && typeof slot.el.setAttribute === 'function') anchors.set(key, slot.el);
  };
  // 自身不出元素的（拆标签、整个丢弃以外的）：在产出的内容前面插一个空的 span.md-anchor，登记它。
  const anchorSpan = (node, slot) => {
    const key = anchorKey(node);
    if (!key || anchors.has(key)) return;
    if (!canNest(slot, 1)) return registerHost(node, slot);
    const span = emit(slot, 'span');
    if (!span) return;
    span.setAttribute('class', 'md-anchor');
    anchors.set(key, span);
  };

  // 子树遍历（pre 取字、math 找注释、label 取字、按钮找文字）：按文档顺序，读每个子节点之前先过共享的输入预算，
  // 预算用完就停，后面的节点一个都不读。visit(kid) 返回真才进它的子节点，返回 STOP 结束整个遍历。
  const STOP = Symbol('stop');
  const walkKids = (root, visit) => {
    const todo = [[root.childNodes, 0]];
    while (todo.length) {
      const top = todo.at(-1);
      if (top[1] >= top[0].length) { todo.pop(); continue; }
      if (!tick()) return;
      const kid = top[0][top[1]++];
      const next = visit(kid);
      if (next === STOP) return;
      if (next) todo.push([kid.childNodes, 0]);
    }
  };

  const push = (stack, kids, slot, c, options = null) => stack.push({ kids, i: 0, slot, c, own: options?.own ?? false, exit: options?.exit ?? null });
  const unwrap = (node, f, stack, c = f.c) => {
    anchorSpan(node, f.slot);
    push(stack, node.childNodes, f.slot, c);
  };

  // 折叠：把容器里已有的内容挪进默认收起的 details.md-landmark（summary 是插件自己的文字，带 data-rich-ui）。费用在入口时按最坏情况预扣了。
  const fold = (el, summaryText) => {
    const kids = Array.from(el.childNodes ?? el.children);
    const details = document.createElement('details');
    details.setAttribute('class', 'md-landmark');
    const summary = document.createElement('summary');
    summary.setAttribute(RICH_UI_ATTR, '');
    summary.append(document.createTextNode(summaryText));
    details.append(summary);
    appendAll(details, kids);
    el.append(details);
  };

  // 原样保留、换成 div 等：建一个元素，只带属性表里的属性，子内容进它；返回建出的元素（拆掉标签或预算用完时没有）。
  const keep = (node, tag, f, stack, outTag = tag, c = f.c) => {
    if (!canNest(f.slot, 1)) return unwrap(node, f, stack, c);
    const el = emit(f.slot, outTag);
    if (!el) return null;
    setCommonAttributes(el, node);
    if (ALIGN_TAGS.has(tag)) {
      const align = alignClass(node);
      if (align) el.setAttribute('class', align);
    }
    if (tag === 'ol') {
      const start = Number.parseInt(node.getAttribute('start') ?? '', 10);
      if (Number.isFinite(start)) el.setAttribute('start', String(Math.max(-1_000_000, Math.min(1_000_000, start))));
      if (node.getAttribute('reversed') !== null) el.setAttribute('reversed', '');
    } else if (tag === 'details' && node.getAttribute('open') !== null) {
      el.setAttribute('open', '');
    }
    register(node, el);
    if (tag !== 'br' && tag !== 'hr') push(stack, node.childNodes, newSlot(el, f.slot, 1, STRUCTURAL.has(tag)), c, { own: true });
    return el;
  };

  // ---- 表格（第 27.4 节）----

  const countRows = node => {
    let rows = 0;
    const kids = node.childNodes;
    for (let i = 0; i < kids.length && tick(); i++) { // 预读也走共享的输入预算
      const kid = kids[i];
      if (kid.nodeType === 1 && kid.namespaceURI === HTML_NS && kid.localName === 'tr' && !isSkipped(kid)) rows++;
    }
    return rows;
  };
  const newGroup = node => ({ rows: countRows(node), index: 0, occupied: new Set() });

  // 这张表放不下了：它后面的内容都不再访问，表格下方写提示（在表格的退出里写）。
  const overflow = (table, stack) => {
    table.overflow = true;
    for (let k = table.frame; k < stack.length; k++) stack[k].i = stack[k].kids.length;
  };

  const degradedTag = (node, tag, f, stack) => {
    const c = f.c;
    if (tag === 'table') return keep(node, tag, f, stack, 'div', { ...c, level: c.level + 1, degraded: true, row: null });
    if (tag === 'caption') return keep(node, tag, f, stack, 'p');
    if (tag === 'th' || tag === 'td') {
      if (c.row && c.row.cells++ > 0) f.slot.buf += ' | ';
      return keep(node, tag, f, stack, 'span');
    }
    return keep(node, tag, f, stack, 'div', tag === 'tr' ? { ...c, row: { cells: 0 } } : c);
  };

  const tableTag = (node, tag, f, stack) => {
    const c = f.c, slot = f.slot;
    if (c.degraded) return degradedTag(node, tag, f, stack);
    if (tag === 'table') {
      const level = c.level + 1;
      if (level > MAX_TABLE_NESTING) return degradedTag(node, tag, f, stack);
      if (!canNest(slot, 2)) return unwrap(node, f, stack);
      const wrap = emit(slot, 'div');
      if (!wrap) return;
      wrap.setAttribute('class', 'md-table-wrap');
      const inner = newSlot(wrap, slot, 1, false);
      const table = emit(inner, 'table');
      if (!table) return;
      setCommonAttributes(table, node);
      register(node, wrap);
      const state = { cells: 0, overflow: false, frame: stack.length };
      push(stack, node.childNodes, newSlot(table, inner, 1, true), { ...c, level, table: state, group: newGroup(node), row: null }, {
        own: true,
        exit: () => {
          if (!state.overflow || !flush(slot) || !spend(2)) return;
          put(slot, note('表格太大，后面省略'));
        },
      });
      return;
    }
    if (ROW_GROUPS.has(tag)) return keep(node, tag, f, stack, tag, { ...c, group: newGroup(node), row: null });
    if (tag === 'tr') return keep(node, tag, f, stack, tag, { ...c, row: c.group ? { index: c.group.index++, col: 0 } : null });
    if (tag !== 'td' && tag !== 'th') return keep(node, tag, f, stack, tag);
    // 单元格：按浏览器的表格模型逐格模拟占用。
    let colspan = spanOf(node, 'colspan', MAX_COLSPAN), rowspan = spanOf(node, 'rowspan', MAX_ROWSPAN);
    const { row, group, table } = c;
    if (row && group && table) {
      const key = (y, x) => (row.index + y) * 128 + x;
      rowspan = Math.max(1, Math.min(rowspan, group.rows - row.index)); // rowspan 不延伸出所在的行组
      let col = row.col;
      while (group.occupied.has(key(0, col))) col++; // 放在本行第一个空着的列
      const overlaps = () => {
        for (let y = 0; y < rowspan; y++) for (let x = 0; x < colspan; x++) if (group.occupied.has(key(y, col + x))) return true;
        return false;
      };
      const fits = (width, height) => col + width <= MAX_COLUMNS && table.cells + width * height <= MAX_GRID_CELLS;
      if (colspan * rowspan > 1 && (!fits(colspan, rowspan) || overlaps())) colspan = rowspan = 1;
      if (!fits(1, 1)) return overflow(table, stack);
      for (let y = 0; y < rowspan; y++) for (let x = 0; x < colspan; x++) group.occupied.add(key(y, col + x));
      table.cells += colspan * rowspan;
      row.col = col + colspan;
    }
    const cell = keep(node, tag, f, stack);
    if (!cell) return;
    if (colspan > 1) cell.setAttribute('colspan', String(colspan)); // 输出的跨度就是计费用的那个值
    if (rowspan > 1) cell.setAttribute('rowspan', String(rowspan));
  };

  // ---- 其余元素 ----

  const landmark = (node, tag, f, stack) => {
    const c = f.c;
    const foldable = tag === 'nav' || !c.inMain;
    if (!canNest(f.slot, foldable ? 2 : 1)) return unwrap(node, f, stack);
    const el = emit(f.slot, 'div'); // 折叠时再按实际生成的 details、summary、文字结算（3 个）
    if (!el) return;
    setCommonAttributes(el, node);
    register(node, el);
    const slot = newSlot(el, f.slot, foldable ? 2 : 1, false);
    if (tag === 'nav') {
      const nav = { links: 0, parent: c.nav };
      push(stack, node.childNodes, slot, { ...c, nav }, {
        own: true,
        exit: () => {
          if (nav.parent) nav.parent.links += nav.links;
          if (nav.links >= 4 && spend(3)) fold(el, `导航（${nav.links} 项）`);
        },
      });
      return;
    }
    if (foldable) asides.push(el); // 页面有没有 main、article 要走完才知道，之后再折叠
    push(stack, node.childNodes, slot, c, { own: true });
  };

  const anchorTag = (node, f, stack) => {
    const c = f.c, slot = f.slot;
    const href = node.getAttribute('href');
    if (href !== null && c.nav) c.nav.links++;
    const inner = { ...c, inA: true };
    if (c.inA) return unwrap(node, f, stack, inner); // 已经在 a 里的内层 a 只展开内容
    if (slot.afterLink) slot.buf += ' '; // 两个 a 之间没有任何文本节点时补一个空格（不分放行不放行）
    const target = href === null ? null : safeLinkTarget(href, basePath);
    if (!target || !canNest(slot, 2)) { // 只留文字：去掉标签，保留子内容
      anchorSpan(node, slot);
      push(stack, node.childNodes, slot, inner, { exit: () => { slot.afterLink = true; } });
      return;
    }
    anchorSpan(node, slot);
    if (!flush(slot) || !spend(target.kind === 'mailto' ? 4 : 1)) return;
    const labels = [];
    const title = cleanText(node.getAttribute('title'), 500);
    push(stack, node.childNodes, newSlot({ append: child => labels.push(child) }, slot, 2, false), inner, {
      own: true,
      exit: () => {
        const out = renderLink(labels, target, title, handlers);
        if (out[0]?.setAttribute) setCommonAttributes(out[0], node, false);
        for (const child of out) slot.el.append(child);
        slot.afterLink = true;
      },
    });
  };

  const imageTag = (node, f) => {
    const slot = f.slot;
    let info = classifyImage(node.getAttribute('src'), basePath, resolveImage, imageBudget);
    let shown = info.kind === 'local' || info.kind === 'data';
    if (shown && !canNest(slot, 2)) { shown = false; info = { kind: 'invalid' }; } // 包装和图片要两层，只剩一层就出占位
    if (!canNest(slot, 1)) return registerHost(node, slot);
    // 包装和图片 2 个，加载失败时包装里要加的占位 2 个，建包装时就计入预算。
    if (!flush(slot) || !spend(shown ? 4 : 2)) return;
    const out = renderImage(info, cleanText(node.getAttribute('alt'), 500), cleanText(node.getAttribute('title'), 500), isCurrent, entry => images.push(entry));
    put(slot, out);
    setCommonAttributes(out, node, !shown); // 能显示的图，title 已经在 img 上
    if (shown) setCommonAttributes(out.children[0], node, false);
    register(node, out);
  };

  // 按钮按清洗后留下的文字决定出不出：找第一个会输出的非空白文字（占位、丢弃的、整个跳过的里面的字不算）。
  const hasText = node => {
    let found = false;
    walkKids(node, kid => {
      if (kid.nodeType === 3) {
        if (kid.data.trim() === '') return false;
        found = true;
        return STOP;
      }
      if (kid.nodeType !== 1) return false;
      const tag = kid.localName;
      if (kid.namespaceURI === HTML_NS) return !(DROP.has(tag) || EMBED.has(tag) || tag === 'video' || tag === 'audio' || tag === 'canvas' || isSkipped(kid));
      return kid.namespaceURI === MATH_NS && tag !== 'annotation' && tag !== 'annotation-xml' && !isSkipped(kid);
    });
    return found;
  };

  // pre：遍历子树（和主遍历共用输入计数），跳过丢弃和整个跳过的节点，br 换成换行，其余只取文字。
  const preTag = (node, f) => {
    const parts = [];
    let lang = null;
    walkKids(node, kid => {
      if (kid.nodeType === 3) { parts.push(kid.data); return false; }
      if (kid.nodeType !== 1) return false;
      if (kid.namespaceURI !== HTML_NS) return !isSkipped(kid);
      const tag = kid.localName;
      if (tag === 'script') st.scripts++;
      if (DROP.has(tag) || isSkipped(kid)) return false;
      if (tag === 'br') { parts.push('\n'); return false; }
      if (tag === 'code' && lang === null) lang = FENCE_LANG_RE.exec(kid.getAttribute('class') ?? '')?.[1] ?? null;
      return true;
    });
    lang ??= FENCE_LANG_RE.exec(node.getAttribute('class') ?? '')?.[1] ?? null;
    codeBlock(f.slot, parts.join(''), lang, node);
  };

  // label：只取允许显示的文字（丢弃的、整个跳过的不取），不保留子元素和图片，图片也不进本地清单；自己的锚点照旧登记。
  const labelTag = (node, f) => {
    const parts = [];
    walkKids(node, kid => {
      if (kid.nodeType === 3) { parts.push(kid.data); return false; }
      if (kid.nodeType !== 1 || kid.namespaceURI !== HTML_NS) return false;
      if (kid.localName === 'script') st.scripts++;
      return !(DROP.has(kid.localName) || isSkipped(kid));
    });
    anchorSpan(node, f.slot);
    addText(f.slot, parts.join(''));
  };

  // 代码块：高亮产生的节点和层数都要放得下，放不下退回纯文本；连 pre、code 两层都放不下，就把文字并入当前这一层。
  const codeBlock = (slot, text, lang, node) => {
    if (!flush(slot)) return;
    if (!canNest(slot, 2)) {
      if (node) registerHost(node, slot);
      addText(slot, text);
      return;
    }
    let block = renderCodeBlock(text, lang);
    let { count, height } = measure(block);
    if (st.output + count > BODY_LIMIT || !canNest(slot, height)) {
      block = h('pre', { class: 'md-code' }, h('code', {}, text));
      count = 3;
    }
    if (!spend(count)) return;
    st.chars += visibleLength(text);
    put(slot, block);
    if (node) { setCommonAttributes(block, node); register(node, block); }
  };

  const mediaName = node => {
    let src = node.getAttribute('src');
    if (src === null) {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length && src === null && tick(); i++) {
        const kid = kids[i];
        if (kid.nodeType === 1 && kid.namespaceURI === HTML_NS && kid.localName === 'source') src = kid.getAttribute('src');
      }
    }
    if (typeof src !== 'string') return '';
    const path = src.replace(/[?#][\s\S]*$/, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^https?:/i.test(path)) return '';
    return cleanText(safeDecode(path.slice(path.lastIndexOf('/') + 1)), 60);
  };

  const textOfKids = node => {
    let text = '';
    const kids = node.childNodes;
    for (let i = 0; i < kids.length && tick(); i++) if (kids[i].nodeType === 3) text += kids[i].data;
    return text;
  };

  const svgTag = (node, f) => {
    const c = f.c;
    if (c.inA || c.inButton) return;
    let title = cleanText(node.getAttribute('aria-label') ?? node.getAttribute('title'), 80);
    if (!title) {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length && !title && tick(); i++) {
        const kid = kids[i];
        if (kid.nodeType === 1 && kid.localName === 'title') title = cleanText(textOfKids(kid), 80);
      }
    }
    const small = ['width', 'height'].every(name => { const size = Number.parseFloat(node.getAttribute(name) ?? ''); return Number.isFinite(size) && size <= 32; });
    if (!title && small) return;
    placed(node, placeholder(f.slot, title ? `[图形：${title}]` : '[图形]'));
  };

  const mathTag = (node, f) => {
    const slot = f.slot;
    const parts = [];
    let tex = null;
    walkKids(node, kid => {
      if (kid.nodeType === 3) { parts.push(kid.data); return false; }
      if (kid.nodeType !== 1 || isSkipped(kid)) return false; // 先判断整棵是否跳过，再选 TeX 注释：带 hidden 的注释不能替换公式
      const tag = kid.localName;
      if (tag === 'annotation' || tag === 'annotation-xml') {
        if (tex === null && tag === 'annotation' && kid.getAttribute('encoding')?.toLowerCase() === 'application/x-tex') tex = textOfKids(kid).trim();
        return false;
      }
      return !(kid.namespaceURI === HTML_NS && DROP.has(tag));
    });
    if (tex === null) { // 没有 TeX：取文字，锚点照旧登记
      anchorSpan(node, slot);
      addText(slot, parts.join(''));
      return;
    }
    if (node.getAttribute('display') === 'block') return codeBlock(slot, tex, null, node);
    if (!canNest(slot, 1)) { registerHost(node, slot); addText(slot, tex); return; }
    if (!flush(slot) || !spend(2)) return;
    st.chars += visibleLength(tex);
    const code = h('code', { class: 'md-inline-code' }, tex);
    put(slot, code);
    setCommonAttributes(code, node);
    register(node, code);
  };

  const buttonTag = (node, f, stack) => {
    if (!hasText(node)) return;
    const c = f.c;
    if (!canNest(f.slot, 1)) return unwrap(node, f, stack, { ...c, inButton: true });
    const el = emit(f.slot, 'span');
    if (!el) return;
    el.setAttribute('class', 'md-chip');
    setCommonAttributes(el, node);
    register(node, el);
    push(stack, node.childNodes, newSlot(el, f.slot, 1, false), { ...c, inButton: true }, { own: true });
  };

  const placed = (node, el) => {
    if (!el) return;
    setCommonAttributes(el, node);
    register(node, el);
  };

  const element = (node, tag, f, stack) => {
    const c = f.c;
    if (tag === 'head') return push(stack, node.childNodes, f.slot, { ...c, head: true });
    if (tag === 'script') { st.scripts++; return; }
    if (DROP.has(tag)) return;
    if (TABLE_TAGS.has(tag)) return tableTag(node, tag, f, stack);
    if (KEEP.has(tag)) return keep(node, tag, f, stack);
    if (AS_DIV.has(tag)) {
      const inner = tag === 'main' || tag === 'article' ? { ...c, inMain: true } : c;
      if (inner !== c) st.hasMain = true;
      return keep(node, tag, f, stack, 'div', inner);
    }
    switch (tag) {
      case 'legend': return keep(node, tag, f, stack, 'p');
      case 'nav': case 'aside': return landmark(node, tag, f, stack);
      case 'a': return anchorTag(node, f, stack);
      case 'img': return imageTag(node, f);
      case 'pre': return preTag(node, f);
      case 'button': return buttonTag(node, f, stack);
      case 'code': {
        if (!canNest(f.slot, 1)) return unwrap(node, f, stack);
        const el = emit(f.slot, 'code');
        if (!el) return;
        el.setAttribute('class', 'md-inline-code');
        setCommonAttributes(el, node);
        register(node, el);
        return push(stack, node.childNodes, newSlot(el, f.slot, 1, false), c, { own: true });
      }
      case 'label': return labelTag(node, f);
      case 'canvas': return placed(node, placeholder(f.slot, '[画布]'));
      case 'video': case 'audio': {
        const name = mediaName(node);
        const label = tag === 'video' ? '视频' : '音频';
        return placed(node, placeholder(f.slot, name ? `[${label}：${name}]` : `[${label}]`));
      }
      default:
        if (EMBED.has(tag)) return placed(node, placeholder(f.slot, '[嵌入内容]'));
        return unwrap(node, f, stack); // noscript 和表外的未知元素：去掉标签，保留子内容
    }
  };

  // head：遍历它只为数 script、取标题，不输出任何内容。
  const headElement = (node, f, stack) => {
    if (node.namespaceURI !== HTML_NS) return;
    if (node.localName === 'script') st.scripts++;
    else if (node.localName === 'title') { if (st.title === null) st.title = cleanText(textOfKids(node), TITLE_CHARS); } else push(stack, node.childNodes, f.slot, f.c);
  };

  const visit = (node, f, stack) => {
    const type = node.nodeType;
    if (type === 3) { if (!f.c.head) addText(f.slot, node.data); return; }
    if (type === 9 || type === 11) return push(stack, node.childNodes, f.slot, f.c);
    if (type !== 1) return; // 注释、处理指令、doctype 等丢掉
    if (f.c.head) return headElement(node, f, stack);
    const ns = node.namespaceURI;
    if (isSkipped(node)) return;
    if (ns === HTML_NS) return element(node, node.localName, f, stack);
    // 其他命名空间的元素不进通用遍历：只有 svg、math 出占位或取文字，其余直接丢掉（foreignObject 下面的 HTML 元素永远不会被放行）。
    if (ns === SVG_NS && node.localName === 'svg') svgTag(node, f);
    else if (ns === MATH_NS && node.localName === 'math') mathTag(node, f);
  };

  const node = h('div', { class: 'md selectable' });
  const rootSlot = { el: node, buf: '', depth: 0, noText: false, afterLink: false };
  const stack = [];
  push(stack, tree.nodeType === 9 || tree.nodeType === 11 ? tree.childNodes : [tree], rootSlot, { inA: false, inButton: false, inMain: false, head: false, level: 0, nav: null, table: null, group: null, row: null, degraded: false }, { own: true });
  while (stack.length) {
    const f = stack.at(-1);
    if (st.stop || f.i >= f.kids.length) { // 停下后一路退出，退出时照常收尾
      stack.pop();
      if (f.own) flush(f.slot);
      f.exit?.();
      continue;
    }
    const kid = f.kids[f.i++];
    tick();
    visit(kid, f, stack);
  }
  if (st.hasMain) for (const aside of asides) if (spend(3)) fold(aside, '侧栏'); else break;

  // 「内容很少」提示（4 个节点）从普通预算里支出；预留的 16 个只给全局截断提示（2 个）。
  if (st.scripts > 0 && st.chars < FEW_CHARS && spend(4)) {
    const button = h('button', { type: 'button', class: 'md-note-action', [RICH_UI_ATTR]: '', onclick: () => onViewSource?.() }, '看源码');
    node.prepend(note('静态预览里内容很少，页面的脚本没有运行', button));
  }
  if (st.capped) node.append(note('内容太多，后面没有显示，可以切到源码看'));
  return { node, anchors, images, scripts: st.scripts, visibleChars: st.chars, capped: st.capped, title: st.title ?? '' };
}

// 解析并清洗：DOMParser 可以注入（Node 单测没有它）；解析出的文档没有浏览上下文，脚本不执行、资源不加载。
export function renderHtml(text, { DOMParser: Parser = globalThis.DOMParser, ...options } = {}) {
  return sanitizeHtml(new Parser().parseFromString(String(text ?? ''), 'text/html'), options);
}
