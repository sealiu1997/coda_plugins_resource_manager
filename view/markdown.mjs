// 页内 Markdown 富文本渲染：纯 DOM 构建（零 innerHTML，原始 HTML 按文本安全转义），无外部依赖。
// 支持 CommonMark / GFM 常用语法：ATX/Setext 标题（含页内锚点）、段落、粗体/斜体/删除线、行内代码、围栏与缩进代码块（围栏复用 highlight.mjs 高亮）、引用块、有序/无序/任务/松散列表（Tab 按 4 列制表位）、表格、分隔线、内联与引用式链接/图片；另外丢弃 HTML 注释、开头 YAML front matter 按代码块显示、<br> 转换行，其余原始 HTML 仍按文本显示。
import { h } from './dom.mjs';
import { classifyImage, countsInHeadingId, renderCodeBlock, renderImage, renderLink, resolveRelativePath, safeDecode, safeLinkTarget as richLinkTarget } from './rich.mjs';
import { richTextContent } from './selection.mjs';

const MAX_DEPTH = 16;

// 标题锚点 slug：小写、去除标点、空白换连字符，保留中英文与数字。
export function slugify(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// 标题元素 id：加 md- 前缀，避免与页面自身的 #tree、#stage 等 id 撞上。
const headingId = slug => `md-${slug}`;

// #片段对应的标题 id：片段先百分号解码（失败用原文）再 slugify；空片段没有 id。
const fragmentId = fragment => {
  const slug = slugify(safeDecode(fragment));
  return slug ? headingId(slug) : '';
};

// 链接目标分类走 rich.mjs 的唯一策略；Markdown 只把 #片段 补上标题 id。
export function safeLinkTarget(rawHref, basePath = '') {
  const target = richLinkTarget(rawHref, basePath);
  return target?.kind === 'hash' ? { kind: 'hash', href: target.href, id: fragmentId(target.fragment) } : target;
}

export { resolveRelativePath };

// ---- 行内解析 ----

const ESCAPABLE_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

// 行内「原子」片段的结尾（不含）：反斜杠转义、完整的代码跨度、HTML 注释，按这个顺序识别；不是返回 -1。
// 反引号序列找不到等长闭合时，整段反引号作为字面量原子（结尾 = i + 反引号数），不再从中间重新配对。
// parseInline 和所有闭合前瞻（强调、删除线、链接、图片）共用，识别顺序只此一份。
function atomEnd(text, i) {
  const ch = text[i];
  if (ch === '\\') return i + 1 < text.length && ESCAPABLE_RE.test(text[i + 1]) ? i + 2 : -1;
  if (ch === '`') {
    let ticks = 1;
    while (text[i + ticks] === '`') ticks++;
    for (let j = i + ticks; j < text.length; j++) {
      if (text[j] !== '`') continue;
      let n = 1;
      while (text[j + n] === '`') n++;
      if (n === ticks) return j + n;
      j += n - 1;
    }
    return i + ticks;
  }
  if (text.startsWith('<!--', i)) {
    const end = text.indexOf('-->', i + 4);
    return end >= 0 ? end + 3 : -1;
  }
  return -1;
}

// 从 from 起找 needle，跳过原子片段内部（转义、代码跨度、注释里的 * _ ~ 不参与配对）。
function findClose(text, needle, from) {
  for (let i = from; i < text.length; i++) {
    const end = atomEnd(text, i);
    if (end > 0) i = end - 1;
    else if (text.startsWith(needle, i)) return i;
  }
  return -1;
}

function findMatching(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const end = atomEnd(text, i);
    if (end > 0) { i = end - 1; continue; }
    if (text[i] === open) depth++;
    else if (text[i] === close) { if (depth === 0) return i; depth--; }
  }
  return -1;
}

// 解析 (url "optional title")，返回 { dest, title, end } 或 null。
function parseDestAndTitle(text, openParen) {
  let i = openParen + 1;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  let dest = '';
  if (text[i] === '<') {
    const closeAngle = text.indexOf('>', i + 1);
    if (closeAngle < 0) return null;
    dest = text.slice(i + 1, closeAngle);
    i = closeAngle + 1;
  } else {
    let parens = 0;
    const start = i;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) { i += 2; continue; }
      if (ch === '(') parens++;
      else if (ch === ')') { if (parens === 0) break; parens--; }
      else if (ch === '\n') break;
      else if ((ch === ' ' || ch === '\t') && (text[i + 1] === '"' || text[i + 1] === "'")) break;
      i++;
    }
    dest = text.slice(start, i).trim();
  }
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  let title = '';
  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i];
    const endQuote = text.indexOf(quote, i + 1);
    if (endQuote > i) { title = text.slice(i + 1, endQuote); i = endQuote + 1; }
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  }
  if (text[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

const normalizeLabel = label => String(label ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

function resolveRef(text, closeBracket, fallbackLabel, defs) {
  if (!defs || defs.size === 0) return null;
  if (text[closeBracket + 1] === '[') {
    const closeRef = findMatching(text, closeBracket + 2, '[', ']');
    if (closeRef >= 0) {
      const refText = text.slice(closeBracket + 2, closeRef);
      const key = normalizeLabel(refText || fallbackLabel);
      const found = defs.get(key);
      if (found) return { dest: found.dest, title: found.title, end: closeRef + 1 };
    }
  }
  const key = normalizeLabel(fallbackLabel);
  const found = defs.get(key);
  return found ? { dest: found.dest, title: found.title, end: closeBracket + 1 } : null;
}

const renderImageNode = (alt, dest, title, ctx) => renderImage(classifyImage(dest, ctx.basePath, ctx.resolveImage), alt, title, ctx.isCurrent);

const renderLinkNode = (labelNodes, dest, title, ctx) => renderLink(labelNodes, richLinkTarget(dest, ctx.basePath), title, ctx);

const BR_RE = /<br[ \t]*\/?>/iy;

function parseInline(text, ctx, depth = 0) {
  if (depth > MAX_DEPTH || !text) return text ? [text] : [];
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // 转义、代码跨度、HTML 注释（识别顺序与闭合前瞻共用 atomEnd）
    const atom = atomEnd(text, i);
    if (atom > 0) {
      if (ch === '\\') buf += text[i + 1];
      else if (ch === '`') {
        let ticks = 1;
        while (text[i + ticks] === '`') ticks++;
        if (atom === i + ticks) { buf += '`'.repeat(ticks); i = atom; continue; }
        flush();
        let code = text.slice(i + ticks, atom - ticks).replace(/\n/g, ' ');
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) code = code.slice(1, -1);
        out.push(h('code', { class: 'md-inline-code' }, code));
      } else flush(); // 行内注释整段丢弃（可跨段内软换行，不跨块）
      i = atom;
      continue;
    }

    // 硬换行（两个及以上空格 + \n，或 \ + \n）
    if (ch === '\n') {
      if (buf.endsWith('  ') || buf.endsWith('\\')) {
        buf = buf.endsWith('\\') ? buf.slice(0, -1) : buf.replace(/ +$/, '');
        flush();
        out.push(h('br'));
      } else {
        buf += '\n';
      }
      i++;
      continue;
    }

    // 图片：内联 ![alt](src) 或引用式 ![alt][ref] / ![alt][] / ![alt]
    if (ch === '!' && text[i + 1] === '[') {
      const closeBracket = findMatching(text, i + 2, '[', ']');
      if (closeBracket >= 0) {
        const alt = text.slice(i + 2, closeBracket);
        const parsed = text[closeBracket + 1] === '('
          ? parseDestAndTitle(text, closeBracket + 1)
          : resolveRef(text, closeBracket, alt, ctx.defs);
        if (parsed) {
          flush();
          out.push(renderImageNode(alt, parsed.dest, parsed.title, ctx));
          i = parsed.end;
          continue;
        }
      }
    }

    // 链接：内联 [label](href) 或引用式 [label][ref] / [label][] / [label]
    if (ch === '[') {
      const closeBracket = findMatching(text, i + 1, '[', ']');
      if (closeBracket >= 0) {
        const rawLabel = text.slice(i + 1, closeBracket);
        const parsed = text[closeBracket + 1] === '('
          ? parseDestAndTitle(text, closeBracket + 1)
          : resolveRef(text, closeBracket, rawLabel, ctx.defs);
        if (parsed) {
          flush();
          const label = parseInline(rawLabel, ctx, depth + 1);
          out.push(...renderLinkNode(label, parsed.dest, parsed.title, ctx));
          i = parsed.end;
          continue;
        }
      }
    }

    // <br> 转换行；其余原始 HTML 仍按文本显示
    if (ch === '<') {
      BR_RE.lastIndex = i;
      const br = BR_RE.exec(text);
      if (br) {
        flush();
        out.push(h('br'));
        i += br[0].length;
        continue;
      }
    }

    // 自动链接 <https://...> / <mailto:...>
    if (ch === '<') {
      const close = text.indexOf('>', i + 1);
      if (close > i + 1) {
        const inner = text.slice(i + 1, close);
        if (!/\s/.test(inner)) {
          const target = richLinkTarget(inner, ctx.basePath);
          if (target?.kind === 'external' || target?.kind === 'mailto') {
            flush();
            out.push(...renderLinkNode([inner], inner, '', ctx));
            i = close + 1;
            continue;
          }
        }
      }
    }

    // 删除线 ~~text~~
    if (ch === '~' && text[i + 1] === '~') {
      const close = findClose(text, '~~', i + 2);
      if (close > i + 2) {
        flush();
        out.push(h('del', {}, ...parseInline(text.slice(i + 2, close), ctx, depth + 1)));
        i = close + 2;
        continue;
      }
    }

    // 粗斜体 *** / ___、粗体 ** / __、斜体 * / _
    if (ch === '*' || ch === '_') {
      let run = 1;
      while (run < 3 && text[i + run] === ch) run++;
      const prevWord = i > 0 && /\w/.test(text[i - 1]);
      if (!(ch === '_' && prevWord)) {
        const marker = ch.repeat(run);
        let close = findClose(text, marker, i + run);
        while (close > i + run && ch === '_' && close + run < text.length && /\w/.test(text[close + run])) {
          close = findClose(text, marker, close + 1);
        }
        if (close > i + run && text[i + run] !== ' ' && text[close - 1] !== ' ') {
          flush();
          const inner = parseInline(text.slice(i + run, close), ctx, depth + 1);
          if (run === 3) out.push(h('strong', {}, h('em', {}, ...inner)));
          else if (run === 2) out.push(h('strong', {}, ...inner));
          else out.push(h('em', {}, ...inner));
          i = close + run;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ---- 块级解析（两阶段：AST + 引用定义收集 → 安全 DOM 渲染）----

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const HR_RE = /^ {0,3}(?:(\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_RE = /^( *)([-*+]|(\d+)[.)])[ \t]+(.*)$/;
const TASK_RE = /^\[( |x|X)\][ \t]+(.*)$/;
const TABLE_SEP_RE = /^\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-{3,}:?[ \t]*\|?$|^\|[ \t]*:?-{3,}:?[ \t]*\|$/;
const COMMENT_START_RE = /^ {0,3}<!--/;
const LINK_DEF_RE = /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))(?:[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'|\(([^)\n]*)\)))?[ \t]*$/;

function stripClosingHashes(raw) {
  return String(raw ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function parseAligns(sepLine) {
  return splitTableRow(sepLine).map(cell => {
    const left = cell.startsWith(':'), right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}

// 行首 Tab 按 CommonMark 的制表位（4 列）展开为空格；只动行首空白，正文里的 Tab 保留。col 是这一行起点在原始行里的绝对列（剥过容器缩进的行不从 0 列算制表位）。
function expandLead(line, col = 0) {
  if (!line.includes('\t')) return line;
  const lead = /^[ \t]*/.exec(line)[0];
  if (!lead.includes('\t')) return line;
  let width = 0;
  for (const ch of lead) width += ch === '\t' ? 4 - ((col + width) % 4) : 1;
  return ' '.repeat(width) + line.slice(lead.length);
}

// 去掉行首 n 列空白，col 同上；Tab 被剥掉一部分时，剩下的列补成空格（部分 Tab），没动到的 Tab 与正文原样保留。
function dropColumns(line, n, col = 0) {
  let width = 0, at = 0;
  while (width < n && (line[at] === ' ' || line[at] === '\t')) { width += line[at] === '\t' ? 4 - ((col + width) % 4) : 1; at++; }
  return ' '.repeat(Math.max(0, width - n)) + line.slice(at);
}

const leadWidth = line => line.length - line.trimStart().length;
const closerOf = marker => new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
const isTableRow = line => line.trim() !== '' && line.includes('|') && !FENCE_RE.test(line);

// HTML 注释块在 `-->` 所在行结束（起始行从 `<!--` 之后找），返回 `-->` 之后的剩余文本，没有闭合返回 null。
const commentRest = (line, from) => { const at = line.indexOf('-->', from); return at < 0 ? null : line.slice(at + 3); };

// 以 line 为起点（next 是其后一行，没有则 undefined）会开启哪种块，按 CommonMark 的优先级判定。
// 块解析（parseBlockAst）、段落打断判断（interrupts）和列表项末尾跟踪（openTracker）都用它，三处不各写一份规则。
function blockKind(line, next, afterBlank) {
  if (afterBlank && line.startsWith('    ')) return 'code';
  if (COMMENT_START_RE.test(line)) return 'comment';
  if (FENCE_RE.test(line)) return 'fence';
  if (HEADING_RE.test(line)) return 'heading';
  if (HR_RE.test(line)) return 'hr';
  if (QUOTE_RE.test(line)) return 'quote';
  if (next !== undefined && line.includes('|') && TABLE_SEP_RE.test(next.trim())) return 'table';
  if (LIST_RE.test(line)) return 'list';
  return LINK_DEF_RE.test(line) ? 'def' : 'para';
}

// 非空行 line 能否打断正在进行的段落。
const interrupts = (line, next) => { const kind = blockKind(line, next, false); return kind !== 'para' && kind !== 'def'; };

const isBlockStart = (lines, i) => lines[i].trim() === '' || interrupts(lines[i], lines[i + 1]);

const sameMarker = (a, b) => (a[3] !== undefined ? a[2].slice(-1) === b[2].slice(-1) : a[2] === b[2]);

// 列表容器如何处理一行：sibling 同一列表的下一项；end 列表在此结束；indent 属于当前项（有缩进）；flush 无缩进的非列表行（至多是段落续行）。
// 同一列表的条目必须同标记（无序列表的标记字符相同、有序列表的分隔符相同），换了标记就另起一个列表，有没有空行都一样。形如 `* * *` 的分隔线不算列表项。
function listLineKind(line, list) {
  const next = LIST_RE.exec(line);
  if (next && next[1].length <= list.base) {
    const same = next[1].length === list.base && (next[3] !== undefined) === list.ordered && !HR_RE.test(line) && sameMarker(next, list.first);
    return same ? 'sibling' : 'end';
  }
  return line.startsWith(' ') ? 'indent' : 'flush';
}

// 增量维护「当前容器（列表项内容）末尾是否为开放段落」，决定无缩进的行能否作为段落续行留在列表项里，避免对每一行重解析整个列表项。
// 逐行喂入容器内的行，块类型、打断、列表归属都用上面的共用判定；表格需要看下一行，所以每行等后一行到了再处理（held）。
// 嵌套列表由子跟踪器接力，每行只做常数次判断。
function openTracker(depth) {
  if (depth > MAX_DEPTH) return { push() {}, open() { return true; } };
  let mode = 'idle'; // idle | para | fence | code | comment | quote | table | list
  let held = null, fenceRe = null, list = null, pending = false, eatSep = false, afterBlank = true;

  const feedList = (line, next) => {
    const kind = listLineKind(line, list);
    if (kind === 'sibling') {
      const m = LIST_RE.exec(line);
      list.content = m[1].length + m[2].length + 1;
      list.item = openTracker(depth + 1);
      list.item.push(m[4]);
      pending = false;
      return true;
    }
    if (kind === 'indent') {
      if (pending) { list.item.push(''); pending = false; }
      list.item.push(line.slice(Math.min(leadWidth(line), list.content)));
      return true;
    }
    if (kind === 'flush' && !pending && !interrupts(line, next) && list.item.open(line)) {
      list.item.push(line);
      return true;
    }
    return false;
  };

  const begin = (line, next) => {
    switch (blockKind(line, next, afterBlank)) {
      case 'code': mode = 'code'; break;
      case 'comment': {
        const rest = commentRest(line, COMMENT_START_RE.exec(line)[0].length);
        mode = rest === null ? 'comment' : 'idle';
        if (rest !== null && rest.trim() !== '') begin(rest, next);
        break;
      }
      case 'fence': mode = 'fence'; fenceRe = closerOf(FENCE_RE.exec(line)[1]); break;
      case 'quote': mode = 'quote'; break;
      case 'table': mode = 'table'; eatSep = true; break;
      case 'list': {
        const m = LIST_RE.exec(line);
        mode = 'list';
        pending = false;
        list = { base: m[1].length, ordered: m[3] !== undefined, first: m, content: m[1].length + m[2].length + 1, item: openTracker(depth + 1) };
        list.item.push(m[4]);
        break;
      }
      case 'para': mode = 'para'; break;
      default: mode = 'idle';
    }
  };

  const step = (line, next) => {
    const blank = line.trim() === '';
    if (mode === 'fence') {
      if (fenceRe.test(line)) mode = 'idle';
    } else if (mode === 'comment') {
      const rest = blank ? null : commentRest(line, 0);
      if (rest !== null) {
        mode = 'idle';
        if (rest.trim() !== '') begin(rest, next);
      }
    } else if (blank) {
      if (mode === 'list') pending = true;
      else if (mode !== 'code') mode = 'idle';
    } else if (eatSep) {
      eatSep = false;
    } else if (mode === 'list' && feedList(line, next)) {
      // 已并入当前列表项
    } else {
      if (mode === 'list') { mode = 'idle'; list = null; pending = false; }
      if (mode === 'para' && SETEXT_RE.test(line)) mode = 'idle';
      else if (mode === 'para' && !interrupts(line, next)) { /* 段落续行 */ }
      else if (mode === 'table' && isTableRow(line)) { /* 表格数据行 */ }
      else if (mode === 'quote' && QUOTE_RE.test(line)) { /* 引用续行 */ }
      else if (mode === 'code' && line.startsWith('    ')) { /* 代码续行 */ }
      else begin(line, next);
    }
    afterBlank = blank;
  };

  const settle = next => {
    if (held === null) return;
    const line = held;
    held = null;
    step(line, next);
  };

  return {
    push(line) { settle(line); held = line; },
    // next 是紧随其后、准备作为无缩进续行并入的那一行（也是 held 那一行的「下一行」）。
    open(next) {
      settle(next);
      return mode === 'para' || (mode === 'list' && !pending && list.item.open(next));
    },
  };
}

// 第一阶段：块级解析生成 AST，仅在合法块起始位置（含顶层、引用块、列表项内，排除代码块与段落续行）收集引用定义。
// rawLines 保留行首 Tab（代码正文用），lines 是行首 Tab 已展开的同一批行（结构判断用），cols 是每行起点的绝对列（剥过容器缩进的行，缺省为 0）；三者按行对齐。
function parseBlockAst(rawLines, defs, depth = 0, lines = rawLines.map(line => expandLead(line)), cols = []) {
  if (depth > MAX_DEPTH) return [{ type: 'paragraph', text: rawLines.join('\n') }];
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const kind = blockKind(line, lines[i + 1], i === 0 || lines[i - 1].trim() === '');

    // 缩进代码块：前面是空行或文档开头、行首 4 列以上缩进的连续行（列表项内的缩进内容已在列表分支里被消费）
    if (kind === 'code') {
      const codeLines = [];
      let last = 0;
      while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('    '))) {
        codeLines.push(dropColumns(rawLines[i], 4, cols[i] ?? 0));
        if (lines[i].trim() !== '') last = codeLines.length;
        i++;
      }
      blocks.push({ type: 'code', code: codeLines.slice(0, last).join('\n'), info: '' });
      continue;
    }

    // HTML 注释块：到含 `-->` 的行结束，中间可跨空行，整块不显示；没有闭合则到容器末尾。
    // 闭合行 `-->` 之后若还有正文，该正文作为新的一行继续解析（不丢内容）。
    if (kind === 'comment') {
      let rest = commentRest(line, COMMENT_START_RE.exec(line)[0].length), j = i;
      while (rest === null && ++j < lines.length) rest = commentRest(lines[j], 0);
      if (rest === null) i = lines.length;
      else if (rest.trim() === '') i = j + 1;
      else { lines[j] = rawLines[j] = rest; i = j; }
      continue;
    }

    // 围栏代码块
    if (kind === 'fence') {
      const marker = FENCE_RE.exec(line);
      const codeLines = [];
      i++;
      const closeRe = closerOf(marker[1]);
      while (i < lines.length && !closeRe.test(lines[i])) { codeLines.push(rawLines[i]); i++; }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', code: codeLines.join('\n'), info: marker[2] });
      continue;
    }

    // ATX 标题（CommonMark：仅空白分隔的尾随 # 为闭合序列，# C# 保留为 C#）
    if (kind === 'heading') {
      const heading = HEADING_RE.exec(line);
      blocks.push({ type: 'heading', level: heading[1].length, text: stripClosingHashes(heading[2] ?? '') });
      i++;
      continue;
    }

    // 分隔线
    if (kind === 'hr') {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 引用块
    if (kind === 'quote') {
      const inner = [], innerLines = [], innerCols = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i]);
        if (!m) break;
        const raw = QUOTE_RE.exec(rawLines[i])?.[1] ?? m[1];
        const col = (cols[i] ?? 0) + rawLines[i].length - raw.length;
        inner.push(raw);
        innerLines.push(expandLead(raw, col));
        innerCols.push(col);
        i++;
      }
      blocks.push({ type: 'blockquote', children: parseBlockAst(inner, defs, depth + 1, innerLines, innerCols) });
      continue;
    }

    // GFM 表格
    if (kind === 'table') {
      const headers = splitTableRow(line);
      const aligns = parseAligns(lines[i + 1].trim());
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, aligns, rows });
      continue;
    }

    // 有序 / 无序 / 任务列表（按当前打开的块决定列表容器是否结束，只允许段落续行省略缩进；条目之间的空行不结束同类列表）
    if (kind === 'list') {
      const first = LIST_RE.exec(line);
      const list = { base: first[1].length, ordered: first[3] !== undefined, first };
      const items = [];
      while (i < lines.length && listLineKind(lines[i], list) === 'sibling') {
        const m = LIST_RE.exec(lines[i]);
        const contentIndent = m[1].length + m[2].length + 1;
        const itemLines = [m[4]], itemRaw = [m[4]], itemCols = [(cols[i] ?? 0) + contentIndent];
        const tracker = openTracker(depth + 1);
        tracker.push(m[4]);
        i++;
        while (i < lines.length) {
          if (lines[i].trim() === '') {
            let next = i + 1;
            while (next < lines.length && lines[next].trim() === '') next++;
            if (next < lines.length && listLineKind(lines[next], list) === 'indent') {
              for (; i < next; i++) { itemLines.push(''); itemRaw.push(''); itemCols.push(0); tracker.push(''); }
              continue;
            }
            break;
          }
          const kindHere = listLineKind(lines[i], list);
          if (kindHere === 'indent') {
            const strip = Math.min(leadWidth(lines[i]), contentIndent);
            const sub = lines[i].slice(strip);
            itemLines.push(sub);
            itemRaw.push(dropColumns(rawLines[i], strip, cols[i] ?? 0));
            itemCols.push((cols[i] ?? 0) + strip);
            tracker.push(sub);
            i++;
          } else if (kindHere === 'flush' && !isBlockStart(lines, i) && tracker.open(lines[i])) {
            itemLines.push(lines[i]);
            itemRaw.push(rawLines[i]);
            itemCols.push(cols[i] ?? 0);
            tracker.push(lines[i]);
            i++;
          } else {
            break;
          }
        }
        // 先完成块解析，再在渲染阶段识别首段的任务清单标记，避免任务文本里的 `1.` / `>` 被重新解析为块。
        items.push({ blocks: parseBlockAst(itemRaw, defs, depth + 1, itemLines, itemCols) });
        // 空行之后紧跟同类列表项：松散列表，继续同一个列表
        if (i < lines.length && lines[i].trim() === '') {
          let next = i;
          while (next < lines.length && lines[next].trim() === '') next++;
          if (next < lines.length && listLineKind(lines[next], list) === 'sibling') i = next;
        }
      }
      blocks.push({ type: 'list', ordered: list.ordered, startNum: list.ordered ? Number(first[3]) : 1, items });
      continue;
    }

    // 独立引用定义（CommonMark：只能在块起始位置出现，不能打断段落）
    const def = LINK_DEF_RE.exec(line);
    if (def) {
      const key = normalizeLabel(def[1]);
      if (key && !defs.has(key)) {
        defs.set(key, { dest: def[2] ?? def[3], title: def[4] ?? def[5] ?? def[6] ?? '' });
      }
      i++;
      continue;
    }

    // Setext 标题或普通段落
    const para = [line];
    i++;
    let setextLevel = 0;
    while (i < lines.length) {
      const setext = SETEXT_RE.exec(lines[i]);
      if (setext) { setextLevel = setext[1][0] === '=' ? 1 : 2; i++; break; }
      if (isBlockStart(lines, i)) break;
      para.push(lines[i]);
      i++;
    }
    if (setextLevel) blocks.push({ type: 'heading', level: setextLevel, text: para.join('\n').trim() });
    else blocks.push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}

// 第二阶段：使用完整收集好的 defs 将块级 AST 渲染为安全 DOM 节点。
function renderBlockAst(blocks, ctx) {
  return blocks.map(block => {
    switch (block.type) {
      case 'code': return renderCodeBlock(block.code, block.info);
      case 'heading': {
        const content = parseInline(block.text, ctx);
        const headingEl = h(`h${block.level}`, {}, ...content);
        const base = slugify(richTextContent(headingEl, countsInHeadingId)); // 基线里就有的图片占位照旧计入标题 ID，按钮和收紧新产生的占位不计
        if (base) {
          let id = headingId(base), n = 1;
          while (ctx.headings.has(id)) id = headingId(`${base}-${n++}`);
          headingEl.setAttribute('id', id);
          ctx.headings.set(id, headingEl);
        }
        return headingEl;
      }
      case 'hr': return h('hr');
      case 'blockquote': return h('blockquote', {}, ...renderBlockAst(block.children, ctx));
      case 'table': {
        const alignAttr = idx => (block.aligns[idx] ? { style: `text-align:${block.aligns[idx]}` } : {});
        const thead = h('thead', {}, h('tr', {}, ...block.headers.map((cell, idx) => h('th', alignAttr(idx), ...parseInline(cell, ctx)))));
        const tbody = h('tbody', {}, ...block.rows.map(cells => h('tr', {}, ...block.headers.map((_, idx) => h('td', alignAttr(idx), ...parseInline(cells[idx] ?? '', ctx))))));
        return h('div', { class: 'md-table-wrap' }, h('table', {}, thead, tbody));
      }
      case 'list': {
        const attrs = block.ordered && block.startNum !== 1 ? { start: String(block.startNum) } : {};
        return h(block.ordered ? 'ol' : 'ul', attrs, ...block.items.map(item => {
          const [first, ...rest] = item.blocks;
          if (first?.type === 'paragraph') {
            const nl = first.text.indexOf('\n');
            const firstLine = nl >= 0 ? first.text.slice(0, nl) : first.text;
            const task = TASK_RE.exec(firstLine);
            if (task) {
              const checked = task[1].toLowerCase() === 'x';
              const tailText = nl >= 0 ? `${task[2]}\n${first.text.slice(nl + 1)}` : task[2];
              const inlineNodes = parseInline(tailText, ctx);
              const extraNodes = rest.length > 0 ? renderBlockAst(rest, ctx) : [];
              return h('li', { class: 'md-task' },
                h('input', { type: 'checkbox', disabled: '', checked: checked ? '' : null }),
                h('span', {}, ...inlineNodes, ...extraNodes));
            }
            if (rest.length === 0) return h('li', {}, ...parseInline(first.text, ctx));
          }
          return h('li', {}, ...renderBlockAst(item.blocks, ctx));
        }));
      }
      default: return h('p', {}, ...parseInline(block.text, ctx));
    }
  });
}

// 渲染 Markdown 文本为 .md 容器节点；绝不解析原始 HTML。
export function renderMarkdown(text, { basePath = '', resolveImage = null, onOpenExternal = null, onOpenRelative = null, onCopyEmail = null, isCurrent = () => true } = {}) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const defs = new Map();
  const lines = normalized.split('\n');
  // 文件开头的 YAML front matter（首行 --- 到下一个 --- 或 ...）按代码块显示，不当分隔线和标题
  const front = lines[0] === '---' ? lines.findIndex((line, at) => at > 0 && (line === '---' || line === '...')) : -1;
  const ast = front > 0
    ? [{ type: 'code', code: lines.slice(1, front).join('\n'), info: 'yaml' }, ...parseBlockAst(lines.slice(front + 1), defs)]
    : parseBlockAst(lines, defs);
  const headings = new Map();
  const ctx = { basePath, resolveImage, onOpenExternal, onOpenRelative, onCopyEmail, isCurrent, defs, headings, lookupAnchor: fragment => headings.get(fragmentId(fragment)) ?? null };
  return h('div', { class: 'md selectable' }, ...renderBlockAst(ast, ctx));
}
