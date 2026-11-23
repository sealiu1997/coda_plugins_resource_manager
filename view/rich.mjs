// 富文本预览（Markdown、之后的 HTML）共用的东西，也是两者唯一的安全策略：
// 1) 查找和选区共用的标签表、操作控件标记、<details> 遮挡判断；
// 2) URL 分类（链接、图片）和相对路径校验，以及按分类结果建链接、图片、「复制邮箱」的节点；
// 3) 围栏语言识别和代码块渲染。
// 不依赖 selection.mjs 和 markdown.mjs（它们引用这里）。
import { h } from './dom.mjs';
import { HIGHLIGHT_LIMIT, appendAll, hasLanguage, hasLongLine, highlight } from './highlight.mjs';
import { languageOf } from './languages.mjs';
import { hasControl, joinRelative, mediaOf, splitRelative } from './protocol.mjs';

// 块标签和单元格标签：块的边界对应换行，单元格的边界对应制表符，选区提取要分得开；查找里两种边界一样，都是匹配不能跨过的地方。
export const BLOCK_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'HR', 'DIV', 'DETAILS', 'SUMMARY']);
export const CELL_TAGS = new Set(['TD', 'TH']);

// 标记富文本预览中不属于正文的操作控件（如「复制邮箱」按钮）：提取正文（标题锚点、选区复制/添加到聊天）和查找建索引时共用此区分。
export const RICH_UI_ATTR = 'data-rich-ui';

const parentOf = node => node.parentNode ?? node.parent ?? null;
const isElement = node => typeof node.tagName === 'string';
// <details> 的可见摘要：第一个 summary 子元素，不要求它是第一个子节点。
const visibleSummary = details => {
  for (const child of details.childNodes ?? details.children ?? []) if (isElement(child) && child.tagName.toUpperCase() === 'SUMMARY') return child;
  return null;
};

// 遮住 node 的 <details>（收起着，node 又不在它的可见摘要里）；有几层取最外层，没有返回 null。
// 外层收起时，里层的摘要也看不见，所以只要沿途有一层遮住就算被遮住。
export function hiddenByDetails(node) {
  let outermost = null;
  for (let child = node, parent = parentOf(node); parent; child = parent, parent = parentOf(parent)) {
    if (isElement(parent) && parent.tagName.toUpperCase() === 'DETAILS' && parent.getAttribute('open') === null && visibleSummary(parent) !== child) outermost = parent;
  }
  return outermost;
}

// ---- URL 分类和相对路径校验 ----

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

// 去空白、去 <> 包裹；空串和含控制字符的返回 null。
function cleanUrl(raw) {
  if (typeof raw !== 'string') return null;
  let url = raw.trim();
  if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1).trim();
  return !url || hasControl(url) ? null : url;
}

// 不分大小写以 http:// 或 https:// 开头，且 new URL() 解析出的主机非空；返回解析后的 URL，否则 null。http:foo 这类没有 // 的不算。
function webUrl(text) {
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.hostname ? url : null;
  } catch { return null; }
}

// 相对路径：以 basePath 所在目录为基准，返回工作目录内的路径；不是本地目标返回 null（只留文字，不发请求）。
// 顺序：1) 丢掉 ?、# 之后的部分，剩下为空就拒绝；2) 以 / 或 \ 开头（含 //host）或带协议头的拒绝；
// 3) 按字面的 / 切段，字面的 . 和 .. 段原样留下，其余每段单独解码——解码失败、解码后含 / \ 或控制字符、解码后才变成 . 或 .. 的整条拒绝；
// 4) 合并点段，越出工作目录就拒绝；5) 结果再过 splitRelative（长度、控制字符）。
export function resolveRelativePath(basePath, rawTarget) {
  const url = cleanUrl(rawTarget);
  if (url === null) return null;
  const cut = url.search(/[?#]/);
  const target = cut >= 0 ? url.slice(0, cut) : url;
  if (!target || /^[/\\]/.test(target) || SCHEME_RE.test(target)) return null;
  const segments = [];
  for (const part of target.split('/')) {
    if (part === '.' || part === '..') { segments.push(part); continue; }
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { return null; }
    if (decoded === '.' || decoded === '..' || /[/\\]/.test(decoded) || hasControl(decoded)) return null;
    segments.push(decoded);
  }
  const base = String(basePath ?? '');
  const joined = joinRelative(base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '', segments.join('/'));
  return joined && !splitRelative(joined).problem ? joined : null;
}

// 链接目标分类（URL 表的「链接」一列）：
//   { kind: 'external', href }  href 是解析后的 url.href；{ kind: 'mailto', email, href }；
//   { kind: 'hash', href, fragment }  fragment 是 # 之后的原始片段，由调用方去查；{ kind: 'relative', path }。
// 其余（javascript:、vbscript:、file:、data:、http:foo、路径校验不过的）返回 null：只留文字。
export function safeLinkTarget(rawHref, basePath = '') {
  const href = cleanUrl(rawHref);
  if (href === null) return null;
  if (href.startsWith('#')) return { kind: 'hash', href, fragment: href.slice(1) };
  const url = webUrl(href);
  if (url) return { kind: 'external', href: url.href };
  const scheme = SCHEME_RE.exec(href);
  if (scheme) {
    if (scheme[0].toLowerCase() !== 'mailto:') return null;
    const rest = href.slice(7);
    const q = rest.indexOf('?');
    const email = safeDecode((q >= 0 ? rest.slice(0, q) : rest).trim());
    return email && !hasControl(email) ? { kind: 'mailto', email, href } : null;
  }
  const path = resolveRelativePath(basePath, href);
  return path ? { kind: 'relative', path } : null;
}

// ---- 图片 ----

// 每页最多 200 张（data: 和本地图合计）；data: 位图按声明的像素预算放行：单张不超过 1600 万像素，整页累计不超过 6400 万像素。
// 这里只限制声明的尺寸，不能证明解码内存有界（动画图的多帧不在预算里）。阈值在 iPhone 真机实测后再定。
export const MAX_IMAGES = 200;
export const MAX_DATA_PIXELS = 16_000_000;
export const MAX_PAGE_DATA_PIXELS = 64_000_000;
export const createImageBudget = () => ({ images: 0, pixels: 0 });

const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/i;
const JPEG_SCAN_BYTES = 64 * 1024;

// 从 base64 开头解码出头部，读出宽高（PNG 的 IHDR、GIF 的逻辑屏幕、WebP 的 VP8/VP8L/VP8X、JPEG 在前 64 KiB 内找 SOF）；读不出来返回 null。
export function dataImageSize(base64) {
  let head;
  try {
    const chars = Math.min(base64.length, Math.ceil(JPEG_SCAN_BYTES / 3) * 4);
    head = atob(base64.slice(0, chars - (chars % 4)));
  } catch { return null; }
  const at = index => head.charCodeAt(index);
  const be16 = index => (at(index) << 8) | at(index + 1);
  const le16 = index => at(index) | (at(index + 1) << 8);
  const le24 = index => at(index) | (at(index + 1) << 8) | (at(index + 2) << 16);
  const tag = (index, text) => head.startsWith(text, index);
  let size = null;
  if (tag(0, '\x89PNG\r\n\x1a\n') && tag(12, 'IHDR') && head.length >= 24) {
    size = [((at(16) * 256 + at(17)) * 256 + at(18)) * 256 + at(19), ((at(20) * 256 + at(21)) * 256 + at(22)) * 256 + at(23)];
  } else if ((tag(0, 'GIF87a') || tag(0, 'GIF89a')) && head.length >= 10) {
    size = [le16(6), le16(8)];
  } else if (tag(0, 'RIFF') && tag(8, 'WEBP')) {
    if (tag(12, 'VP8 ') && head.length >= 30 && at(23) === 0x9d && at(24) === 0x01 && at(25) === 0x2a) size = [le16(26) & 0x3fff, le16(28) & 0x3fff];
    else if (tag(12, 'VP8L') && head.length >= 25 && at(20) === 0x2f) size = [1 + (at(21) | ((at(22) & 0x3f) << 8)), 1 + ((at(22) >> 6) | (at(23) << 2) | ((at(24) & 0x0f) << 10))];
    else if (tag(12, 'VP8X') && head.length >= 30) size = [1 + le24(24), 1 + le24(27)];
  } else if (at(0) === 0xff && at(1) === 0xd8) {
    for (let i = 2; i + 4 <= head.length;) {
      if (at(i) !== 0xff) { i++; continue; }
      const marker = at(i + 1);
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (i + 9 <= head.length) size = [be16(i + 7), be16(i + 5)];
        break;
      }
      const length = be16(i + 2);
      if (length < 2) break;
      i += 2 + length;
    }
  }
  return size && size[0] > 0 && size[1] > 0 ? { width: size[0], height: size[1] } : null;
}

// data: 位图：先去掉里面所有空白，再整串校验字符集（折行的 base64 要在 cleanUrl 之前处理）；读不出头部、超过像素预算的按 invalid。
function classifyDataImage(rawSrc, budget) {
  const match = DATA_IMAGE_RE.exec(rawSrc.replace(/\s+/g, ''));
  const size = match && budget.images < MAX_IMAGES ? dataImageSize(match[1]) : null;
  if (!size) return { kind: 'invalid' };
  const pixels = size.width * size.height;
  if (pixels > MAX_DATA_PIXELS || budget.pixels + pixels > MAX_PAGE_DATA_PIXELS) return { kind: 'invalid' };
  budget.images++;
  budget.pixels += pixels;
  return { kind: 'data', src: rawSrc.replace(/\s+/g, ''), width: size.width, height: size.height };
}

// 图片地址分类（URL 表的「图片」一列）：
//   { kind: 'local', path, src }  只有相对路径且是图片扩展名（mediaOf 的种类是 image），经 resolveImage 给出流式服务地址；resolveImage 返回 null 表示口令还没到，地址之后由调用方补；
//   { kind: 'data', src, width, height }  data: 位图（png、jpeg、gif、webp），只有给了 budget 才放行；
//   { kind: 'remote', url } 外链图片，只出占位；其余 { kind: 'invalid' }。
//   非图片的相对路径：不调 resolveImage，不发请求；其中基线里本来会显示成 <img> 的（路径合法、有流式地址），多带 skipped: true。
// budget（createImageBudget）由调用方按页持有：本地图和 data: 图合计不超过 MAX_IMAGES，data: 图另受像素预算。不给 budget 时 data: 一律按 invalid。
export function classifyImage(rawSrc, basePath, resolveImage, budget = null) {
  if (budget && typeof rawSrc === 'string' && /^\s*data:/i.test(rawSrc)) return classifyDataImage(rawSrc.trim(), budget);
  const src = cleanUrl(rawSrc);
  if (src === null) return { kind: 'invalid' };
  const url = webUrl(src);
  if (url) return { kind: 'remote', url: url.href };
  const path = resolveRelativePath(basePath, src);
  if (!path || typeof resolveImage !== 'function') return { kind: 'invalid' };
  if (mediaOf(path)?.kind !== 'image') return { kind: 'invalid', skipped: true };
  if (budget) {
    if (budget.images >= MAX_IMAGES) return { kind: 'invalid' };
    budget.images++;
  }
  return { kind: 'local', path, src: resolveImage(path) };
}

// ---- 建节点 ----

// 点 #片段：先取消浏览器的默认导航；lookup(fragment) 找到目标元素就展开遮住它的 <details>（一层一层，直到看得见）再滚过去，找不到什么也不做。
function jumpToAnchor(event, fragment, lookup) {
  event?.preventDefault?.();
  const target = lookup?.(fragment);
  if (!target) return;
  for (let hidden = hiddenByDetails(target); hidden; hidden = hiddenByDetails(target)) hidden.setAttribute('open', '');
  target.scrollIntoView?.({ block: 'start' });
}

// 标签节点分批挂（append(...nodes) 的参数个数有上限，一个链接可能包着很多节点）。
const withLabel = (parent, labelNodes) => {
  appendAll(parent, labelNodes);
  return parent;
};

// 按 safeLinkTarget 的结果建链接节点，返回节点数组；target 为 null 时只返回标签节点（不套链接样式）。
// handlers: { onOpenExternal(href)、onOpenRelative(path)、onCopyEmail(email)、lookupAnchor(fragment) → 元素 | null }。
export function renderLink(labelNodes, target, title, handlers) {
  if (target?.kind === 'external') {
    return [withLabel(h('a', {
      href: target.href,
      title: title || target.href,
      onclick: event => {
        event?.preventDefault?.();
        handlers.onOpenExternal?.(target.href);
      },
    }), labelNodes)];
  }
  if (target?.kind === 'mailto') {
    return [h('span', { class: 'md-mailto-wrap', title: title || null },
      withLabel(h('span', { class: 'md-mailto-label' }), labelNodes),
      h('button', {
        type: 'button',
        class: 'md-copy-email',
        [RICH_UI_ATTR]: '',
        'data-email': target.email,
        'aria-label': `复制邮箱 ${target.email}`,
        title: `复制邮箱：${target.email}`,
        onclick: event => {
          event?.preventDefault?.();
          handlers.onCopyEmail?.(target.email);
        },
      }, '复制邮箱'),
    )];
  }
  if (target?.kind === 'hash') {
    return [withLabel(h('a', {
      href: target.href,
      title: title || null,
      onclick: event => jumpToAnchor(event, target.fragment, handlers.lookupAnchor),
    }), labelNodes)];
  }
  if (target?.kind === 'relative') {
    return [withLabel(h('a', {
      href: '#',
      class: 'md-rel-link',
      'data-rel-path': target.path,
      title: title || target.path,
      onclick: event => {
        event?.preventDefault?.();
        handlers.onOpenRelative?.(target.path);
      },
    }), labelNodes)];
  }
  return labelNodes;
}

// 占位的字是否计入标题 ID：基线里本来就出占位的照旧计入；这次收紧新产生的（skipped，基线里是不带字的 <img>）不计入，ID 才和基线一致。
const SKIPPED_CLASS = 'md-img-skipped';
export const countsInHeadingId = node => Boolean(node.classList?.contains('md-img-fallback') && !node.classList.contains(SKIPPED_CLASS));

const imagePlaceholder = (text, title, skipped = false) => h('span', { class: `md-img-fallback secondary${skipped ? ` ${SKIPPED_CLASS}` : ''}`, [RICH_UI_ATTR]: '', title: title ?? null }, text);

// 按 classifyImage 的结果建图片节点。能显示的（本地图、data: 图）是稳定的包装 span.md-img-box，里面放 img.md-img；
// 加载失败时只在包装里面加占位（包装外和已有的文本节点不动，查找索引不用重建）；isCurrent() 为假（正文已换）的回调直接忽略。
// onLocal({ img, path, fail })：本地图片的清单项（data: 图没有），调用方在口令到了之后补 src，口令拿不到就调 fail() 换成占位（同样受 isCurrent 约束）。
export function renderImage(info, alt, title, isCurrent = () => true, onLocal = null) {
  if (info.kind === 'local' || info.kind === 'data') {
    const fail = () => {
      if (!isCurrent()) return;
      img.remove();
      box.append(imagePlaceholder(alt ? `[图片：${alt}]` : '[图片]'));
    };
    const img = h('img', { class: 'md-img', loading: 'lazy', decoding: 'async', src: info.src, alt, title: title || null, draggable: 'false', onerror: fail });
    const box = h('span', { class: 'md-img-box' }, img);
    if (info.kind === 'local') onLocal?.({ img, path: info.path, fail });
    return box;
  }
  if (info.kind === 'remote') return imagePlaceholder(alt ? `[外链图片：${alt}]` : '[外链图片]', info.url);
  return imagePlaceholder(alt ? `[图片：${alt}]` : '[图片]', null, info.skipped);
}

// ---- 代码块 ----

// 围栏语言解析：优先匹配 highlight.js 已注册语言名或别名（如 javascript、python），再退回文件名/扩展名表。
export function resolveFenceLang(info) {
  const token = String(info ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!token) return null;
  if (hasLanguage(token)) return token;
  return languageOf(`x.${token}`) ?? languageOf(token);
}

export function renderCodeBlock(code, info) {
  const lang = resolveFenceLang(info);
  const codeEl = h('code', { class: lang ? `language-${lang}` : null });
  const colored = lang && code.length <= HIGHLIGHT_LIMIT && !hasLongLine(code) ? highlight(code, lang) : null;
  if (colored) appendAll(codeEl, colored);
  else codeEl.append(code);
  return h('pre', { class: 'md-code' }, codeEl);
}
