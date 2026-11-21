// 页内 Markdown 富文本渲染：纯 DOM 构建（零 innerHTML，原始 HTML 按文本安全转义），无外部依赖。
// 支持 GFM 常用语法：标题、段落、粗体/斜体/删除线、行内代码、围栏代码块（复用 highlight.mjs 高亮）、引用块、有序/无序/任务列表、表格、分隔线、链接与图片。
import { h } from './dom.mjs';
import { HIGHLIGHT_LIMIT, appendAll, hasLongLine, highlight } from './highlight.mjs';
import { languageOf } from './languages.mjs';
import { hasControl } from './protocol.mjs';

const MAX_DEPTH = 16;

// 解析 Markdown 里的相对路径：以 basePath 所在目录为基准，拒绝绝对路径、协议头、控制字符和越出工作目录根的 ..。
export function resolveRelativePath(basePath, rawTarget) {
  if (typeof rawTarget !== 'string') return null;
  let target = rawTarget.trim();
  if (!target || hasControl(target)) return null;
  // 去掉可选的尖括号包裹 <path>
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  const cut = target.search(/[?#]/);
  if (cut >= 0) target = target.slice(0, cut);
  if (!target || target.startsWith('/') || target.startsWith('\\')) return null;
  // 含协议头（如 http: / data: / javascript:）不是相对路径
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return null;
  let decoded;
  try { decoded = target.split('/').map(decodeURIComponent); } catch { return null; }
  const dir = String(basePath ?? '').split('/').slice(0, -1).filter(Boolean);
  const stack = [...dir];
  for (const part of decoded) {
    if (part === '' || part === '.') continue;
    if (hasControl(part)) return null;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.length > 0 ? stack.join('/') : null;
}

// 链接安全校验：仅放行 http/https/mailto、页内锚点 #... 与工作目录内相对路径；拒绝 javascript:/data:/vbscript:/file: 等危险协议。
export function safeLinkTarget(rawHref, basePath = '') {
  if (typeof rawHref !== 'string') return null;
  let href = rawHref.trim();
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1).trim();
  if (!href || hasControl(href)) return null;
  if (href.startsWith('#')) return { kind: 'hash', href };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (proto === 'http' || proto === 'https' || proto === 'mailto') return { kind: 'external', href };
    return null;
  }
  const rel = resolveRelativePath(basePath, href);
  return rel ? { kind: 'relative', path: rel } : null;
}

// 图片地址安全校验：仅放行工作目录内相对图片（交给 resolveImage 生成流式服务地址）或显式 http/https 外链。
function safeImageSrc(rawSrc, basePath, resolveImage) {
  if (typeof rawSrc !== 'string') return null;
  let src = rawSrc.trim();
  if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1).trim();
  if (!src || hasControl(src)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(src);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    return proto === 'http' || proto === 'https' ? src : null;
  }
  const rel = resolveRelativePath(basePath, src);
  return rel && typeof resolveImage === 'function' ? resolveImage(rel) : null;
}

// ---- 行内解析 ----

function findMatching(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) { i++; continue; }
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

// 链接引用标签归一化（CommonMark：去掉首尾空白、合并内部空白、转小写）。
const normalizeLabel = label => String(label ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// 从文本末尾的 [ref] / [] 或简写 [label] 查找引用定义，返回 { dest, title, end } 或 null。
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

function renderImageNode(alt, dest, title, ctx) {
  const src = safeImageSrc(dest, ctx.basePath, ctx.resolveImage);
  if (src) return h('img', { class: 'md-img', src, alt, title: title || null, draggable: 'false' });
  return h('span', { class: 'md-img-fallback secondary' }, alt ? `[图片：${alt}]` : '[图片]');
}

function renderLinkNode(labelNodes, dest, title, ctx) {
  const target = safeLinkTarget(dest, ctx.basePath);
  if (target?.kind === 'external') {
    return [h('a', { href: target.href, title: title || null, target: '_blank', rel: 'noopener noreferrer' }, ...labelNodes)];
  }
  if (target?.kind === 'hash') {
    return [h('a', { href: target.href, title: title || null }, ...labelNodes)];
  }
  if (target?.kind === 'relative') {
    return [h('span', { class: 'md-rel-link', 'data-rel-path': target.path, title: title || target.path }, ...labelNodes)];
  }
  return labelNodes;
}

function parseInline(text, ctx, depth = 0) {
  if (depth > MAX_DEPTH || !text) return text ? [text] : [];
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // 反斜杠转义 ASCII 标点
    if (ch === '\\' && i + 1 < text.length && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
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

    // 行内代码（支持多反引号）
    if (ch === '`') {
      let ticks = 1;
      while (text[i + ticks] === '`') ticks++;
      const marker = '`'.repeat(ticks);
      const close = text.indexOf(marker, i + ticks);
      if (close >= 0) {
        flush();
        let code = text.slice(i + ticks, close).replace(/\n/g, ' ');
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) code = code.slice(1, -1);
        out.push(h('code', { class: 'md-inline-code' }, code));
        i = close + ticks;
        continue;
      }
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

    // 自动链接 <https://...> / <mailto:...>
    if (ch === '<') {
      const close = text.indexOf('>', i + 1);
      if (close > i + 1) {
        const inner = text.slice(i + 1, close);
        if (!/\s/.test(inner)) {
          const target = safeLinkTarget(inner, ctx.basePath);
          if (target?.kind === 'external') {
            flush();
            out.push(h('a', { href: target.href, target: '_blank', rel: 'noopener noreferrer' }, inner));
            i = close + 1;
            continue;
          }
        }
      }
    }

    // 删除线 ~~text~~
    if (ch === '~' && text[i + 1] === '~') {
      const close = text.indexOf('~~', i + 2);
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
      // 下划线在单词中间不触发斜体（如 foo_bar_baz）
      const prevWord = i > 0 && /\w/.test(text[i - 1]);
      if (!(ch === '_' && prevWord)) {
        const marker = ch.repeat(run);
        let close = text.indexOf(marker, i + run);
        while (close > i + run && ch === '_' && close + run < text.length && /\w/.test(text[close + run])) {
          close = text.indexOf(marker, close + 1);
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

// ---- 块级解析 ----

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const HR_RE = /^ {0,3}(?:(\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_RE = /^( *)([-*+]|(\d+)[.)])[ \t]+(.*)$/;
const TASK_RE = /^\[( |x|X)\][ \t]+(.*)$/;
const TABLE_SEP_RE = /^\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-{3,}:?[ \t]*\|?$|^\|[ \t]*:?-{3,}:?[ \t]*\|$/;
const LINK_DEF_RE = /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))(?:[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'|\(([^)\n]*)\)))?[ \t]*$/;

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

function resolveFenceLang(info) {
  const token = String(info ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!token) return null;
  return languageOf(`x.${token}`) ?? languageOf(token);
}

function renderCodeBlock(code, info) {
  const lang = resolveFenceLang(info);
  const codeEl = h('code', { class: lang ? `language-${lang}` : null });
  const colored = lang && code.length <= HIGHLIGHT_LIMIT && !hasLongLine(code) ? highlight(code, lang) : null;
  if (colored) appendAll(codeEl, colored);
  else codeEl.append(code);
  return h('pre', { class: 'md-code' }, codeEl);
}

function isBlockStart(lines, i) {
  const line = lines[i];
  if (line.trim() === '') return true;
  if (FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line)) return true;
  if (i + 1 < lines.length && line.includes('|') && TABLE_SEP_RE.test(lines[i + 1].trim())) return true;
  return false;
}

// 第一阶段：块级解析生成 AST，仅在合法块起始位置（含顶层、引用块、列表项内，排除代码块与段落续行）收集引用定义。
function parseBlockAst(lines, defs, depth = 0) {
  if (depth > MAX_DEPTH) return [{ type: 'paragraph', text: lines.join('\n') }];
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    // 围栏代码块（内部内容原样保留，绝不提取引用定义）
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const markerChar = fence[1][0], markerLen = fence[1].length, info = fence[2];
      const codeLines = [];
      i++;
      const closeRe = new RegExp(`^ {0,3}${markerChar}{${markerLen},}[ \\t]*$`);
      while (i < lines.length && !closeRe.test(lines[i])) { codeLines.push(lines[i]); i++; }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', code: codeLines.join('\n'), info });
      continue;
    }

    // ATX 标题
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '') });
      i++;
      continue;
    }

    // 分隔线
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 引用块（递归解析内部块，合法引用定义会自然收集到共享 defs）
    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i]);
        if (m) { inner.push(m[1]); i++; }
        else break;
      }
      blocks.push({ type: 'blockquote', children: parseBlockAst(inner, defs, depth + 1) });
      continue;
    }

    // GFM 表格
    if (i + 1 < lines.length && line.includes('|') && TABLE_SEP_RE.test(lines[i + 1].trim())) {
      const headers = splitTableRow(line);
      const aligns = parseAligns(lines[i + 1].trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|') && !FENCE_RE.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, aligns, rows });
      continue;
    }

    // 有序 / 无序 / 任务列表
    const listStart = LIST_RE.exec(line);
    if (listStart) {
      const ordered = listStart[3] !== undefined;
      const baseIndent = listStart[1].length;
      const startNum = ordered ? Number(listStart[3]) : 1;
      const items = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m || m[1].length !== baseIndent || (m[3] !== undefined) !== ordered) break;
        const contentIndent = m[1].length + m[2].length + 1;
        const itemLines = [m[4]];
        i++;
        while (i < lines.length) {
          if (lines[i].trim() === '') {
            if (i + 1 < lines.length && /^ +/.test(lines[i + 1])) { itemLines.push(''); i++; continue; }
            break;
          }
          const nextList = LIST_RE.exec(lines[i]);
          if (nextList && nextList[1].length <= baseIndent) break;
          if (/^ +/.test(lines[i])) {
            const strip = Math.min(lines[i].match(/^ */)[0].length, contentIndent);
            itemLines.push(lines[i].slice(strip));
            i++;
          } else if (!isBlockStart(lines, i)) {
            itemLines.push(lines[i]);
            i++;
          } else {
            break;
          }
        }
        const task = TASK_RE.exec(itemLines[0]);
        if (task) {
          itemLines[0] = task[2];
          const checked = task[1].toLowerCase() === 'x';
          const hasSubBlock = itemLines.some(l => l.trim() === '' || FENCE_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l));
          items.push({
            task: { checked },
            blocks: hasSubBlock ? parseBlockAst(itemLines, defs, depth + 1) : null,
            text: hasSubBlock ? null : itemLines.join('\n'),
          });
        } else {
          const hasSubBlock = itemLines.some(l => l.trim() === '' || FENCE_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l))
            || LINK_DEF_RE.test(itemLines[0]);
          items.push({
            task: null,
            blocks: hasSubBlock ? parseBlockAst(itemLines, defs, depth + 1) : null,
            text: hasSubBlock ? null : itemLines.join('\n'),
          });
        }
      }
      blocks.push({ type: 'list', ordered, startNum, items });
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

    // Setext 标题或普通段落（紧跟普通行后的 === / --- 下划线解析为 h1 / h2；引用定义不能打断段落）
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
      case 'heading': return h(`h${block.level}`, {}, ...parseInline(block.text, ctx));
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
          const content = item.blocks ? renderBlockAst(item.blocks, ctx) : parseInline(item.text, ctx);
          if (item.task) {
            return h('li', { class: 'md-task' }, h('input', { type: 'checkbox', disabled: '', checked: item.task.checked ? '' : null }), h('span', {}, ...content));
          }
          return h('li', {}, ...content);
        }));
      }
      default: return h('p', {}, ...parseInline(block.text, ctx));
    }
  });
}

// 渲染 Markdown 文本为 .md 容器节点；绝不解析原始 HTML。
export function renderMarkdown(text, { basePath = '', resolveImage = null } = {}) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const defs = new Map();
  const ast = parseBlockAst(normalized.split('\n'), defs);
  const ctx = { basePath, resolveImage, defs };
  return h('div', { class: 'md selectable' }, ...renderBlockAst(ast, ctx));
}
