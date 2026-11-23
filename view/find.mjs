// 文件内查找（设计见 docs/design/phase-3.md 第 18.6 节、第 26.2 节）：预览里的查找条，高亮全部匹配，显示「第几个 / 共几个」，上一个、下一个，不分大小写。
// 全部在页面里做，只找当前显示的这份正文：源码（一个 <pre>）和富文本预览（Markdown 渲染出的一棵 DOM 树，建索引时在块边界插虚拟字符、折叠空白）。
// 纯函数（findMatches、buildIndex、buildRichIndex、rangesFor）和查找条（createFind）在这里，预览（preview.mjs）负责接上自己的生命周期。
//
// 每个异步机制的五样：
// - 输入防抖：输入框 input 时开始，停顿 FIND_DEBOUNCE_MS 才找；找之前、关查找条、换正文时取消；到点只做一次。
// - 分批标记：一次查找（runId）持有。找完匹配先同步标第一批，之后每批 BATCH 个，批间 setTimeout(0) 让出；
//   每批开始时核对 runId 和正文版本，变了就停（关查找条、换词、换正文、清掉都会让它作废）。
// - 正文版本 version：show() 换了正文后同步接着调 setContent（中间没有异步空档），clearContent 同样，都加一；之前的批次和待执行的防抖据此作废。富文本的索引和正文一一对应，随这一版持有。
// - 高亮注册：find（全部匹配）和 find-current（当前这处，priority 更高）两个 Highlight，一次查找新建一份，关闭、换词、清掉时从 CSS.highlights 删掉。
//   不支持 Highlight API、或正文有长行（hasLongLine，预览给的）时不注册，只计数、导航、滚动。
// - 超时：没有；10000 处的上限和每批 2000 个让出就是它的界。
import { h } from './dom.mjs';
import { icon } from './icons.mjs';
import { BLOCK_TAGS, CELL_TAGS, RICH_UI_ATTR, hiddenByDetails } from './rich.mjs';

export const FIND_MAX = 10_000;
export const FIND_BATCH = 2000;
export const FIND_DEBOUNCE_MS = 150;
export const FIND_MEASURE = 2000; // 富文本初始定位：从起点起最多逐个量这么多处

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 在原文上找：转义后的搜索词建 RegExp（giu），返回 UTF-16 下标（和文本节点的 Range 偏移一致），不靠 toLowerCase 再换算。
// 不重叠（g 的语义）；最多 max 处，多找到一处就是 more（界面写「10000+」）。空词不建正则。
export function findMatches(text, term, max = FIND_MAX) {
  if (term === '') return { list: [], more: false };
  const pattern = new RegExp(escape(term), 'giu'), list = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[0].length === 0) { pattern.lastIndex++; continue; } // 非空词不会走到这里，防死循环
    if (list.length >= max) return { list, more: true };
    list.push([match.index, match.index + match[0].length]);
  }
  return { list, more: false };
}

// 正文里的文本节点和它们的累计起点：每个正文版本只建一次。
const isText = node => node.nodeType === 3 || (node.nodeType === undefined && node.children === undefined);
export function buildIndex(root) {
  const nodes = [];
  let at = 0;
  const walk = parent => {
    for (const node of parent.childNodes ?? parent.children) {
      if (isText(node)) {
        const length = node.data.length;
        if (length > 0) { nodes.push({ node, start: at, end: at + length }); at += length; }
      } else walk(node);
    }
  };
  walk(root);
  return { nodes, length: at };
}

// 富文本的文本节点表：和 buildIndex 一样，但块（块级元素、单元格、<br>）的边界处累计位置加 1：一个不对应任何节点的虚拟字符 \0，匹配不能跨过它；
// 带 data-rich-ui 的元素（插件自己的按钮、占位、提示）不进表。top 是节点所在的根的顶层子节点的下标，初始定位分组用。
const parentOf = node => node.parentNode ?? node.parent ?? null;
const isElement = node => typeof node.tagName === 'string';
export function buildRichIndex(root) {
  const nodes = [];
  let at = 0, boundary = false;
  const walk = (parent, top) => {
    const kids = parent.childNodes ?? parent.children;
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i], key = top ?? i;
      if (isText(node)) {
        const length = node.data.length;
        if (length === 0) continue;
        if (boundary && nodes.length > 0) at++;
        boundary = false;
        nodes.push({ node, start: at, end: at + length, top: key });
        at += length;
      } else if (isElement(node)) {
        if (node.getAttribute(RICH_UI_ATTR) !== null) continue;
        const tag = node.tagName.toUpperCase(), edge = tag === 'BR' || BLOCK_TAGS.has(tag) || CELL_TAGS.has(tag);
        if (edge) boundary = true;
        walk(node, key);
        if (edge) boundary = true;
      }
    }
  };
  walk(root, null);
  return { nodes, length: at, root };
}

const isSpace = code => code === 32 || code === 9 || code === 10 || code === 13; // [ \t\r\n]，不用正则：长空白零命中时正则回溯会变慢
// 折叠视图：连续空白折成一个空格，虚拟字符 \0 留着（挡住跨块匹配）；starts[i]、ends[i] 是折叠后第 i 个字符对应原始偏移的 [起, 终)（折叠的空白占整段）。一次线性扫描。
function foldIndex({ nodes, length }) {
  const starts = new Uint32Array(length), ends = new Uint32Array(length);
  let text = '', n = 0, space = false, prev = 0;
  for (const { node, start } of nodes) {
    for (let k = prev; k < start; k++) { text += '\0'; starts[n] = k; ends[n++] = k + 1; space = false; }
    const data = node.data;
    let run = 0;
    for (let k = 0; k < data.length; k++) {
      if (isSpace(data.charCodeAt(k))) {
        if (k > run) text += data.slice(run, k);
        run = k + 1;
        if (space) ends[n - 1] = start + k + 1;
        else { text += ' '; starts[n] = start + k; ends[n++] = start + k + 1; space = true; }
      } else { starts[n] = start + k; ends[n++] = start + k + 1; space = false; }
    }
    if (run < data.length) text += data.slice(run);
    prev = start + data.length;
  }
  return { text, starts, ends };
}
// 搜索词：空白折成一个空格，去掉 \0。
function foldTerm(term) {
  let out = '', space = false;
  for (const ch of term) {
    if (ch === '\0') continue;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { if (!space) out += ' '; space = true; } else { out += ch; space = false; }
  }
  return out;
}
// 在富文本里找：在折叠视图上找，命中位置映射回原始偏移（Range 用的就是它）。
export function findRich(index, term, max = FIND_MAX) {
  const fold = (index.fold ??= foldIndex(index));
  const { list, more } = findMatches(fold.text, foldTerm(term), max);
  return { list: list.map(([start, end]) => [fold.starts[start], fold.ends[end - 1]]), more };
}

// 第一个包含 offset 的节点（end > offset）的下标，从 from 起往后找。
const startNode = (nodes, offset, from = 0) => { let i = from; while (i < nodes.length && nodes[i].end <= offset) i++; return i; };
// 第一个 end 不小于 end 的节点：匹配的终点（不含）落在它里面。
const endNode = (nodes, end, from = 0) => { let i = from; while (i < nodes.length && nodes[i].end < end) i++; return i; };
// 二分：第一个 end > offset 的节点，单个匹配用。
function bisect(nodes, offset) {
  let low = 0, high = nodes.length;
  while (low < high) { const mid = (low + high) >> 1; if (nodes[mid].end <= offset) low = mid + 1; else high = mid; }
  return low;
}

// 一批匹配的 Range：匹配是递增的，起点和终点各用一个指针在表里往前走，不从头找。
export function rangesFor(index, list, from, to, makeRange) {
  const { nodes } = index, ranges = [];
  let p = bisect(nodes, list[from][0]), q = p;
  for (let i = from; i < to; i++) {
    const [start, end] = list[i];
    p = startNode(nodes, start, p);
    q = endNode(nodes, end, Math.max(q, p));
    const range = makeRange();
    range.setStart(nodes[p].node, start - nodes[p].start);
    range.setEnd(nodes[q].node, end - nodes[q].start);
    ranges.push(range);
  }
  return ranges;
}
// 单个匹配的 Range（不靠指针，二分定位）。
export function rangeAt(index, [start, end], makeRange) {
  const { nodes } = index, p = bisect(nodes, start), q = endNode(nodes, end, p), range = makeRange();
  range.setStart(nodes[p].node, start - nodes[p].start);
  range.setEnd(nodes[q].node, end - nodes[q].start);
  return range;
}

const nodeAt = (index, offset) => index.nodes[bisect(index.nodes, offset)].node;
// 一处匹配的第一个矩形：跨多行时 getBoundingClientRect 是整块，用第一行定位。
const firstRect = range => (range.getClientRects?.() ?? [])[0] ?? range.getBoundingClientRect();

// 初始定位的分组（第 26.2 节）：根的每个顶层子元素一组；相邻的顶层文本和行内元素合成一个匿名组。分组覆盖所有文本，顶层块上下堆叠，组的 bottom 单调。
// of[i]：根的第 i 个子节点属于第几组。分组只看结构，每个正文版本建一次；矩形每次现量。
function richGroups(index) {
  if (index.groups) return index.groups;
  const kids = index.root.childNodes ?? index.root.children, list = [], of = [];
  let anon = null;
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i], text = isText(node);
    if (!text && !isElement(node)) continue;
    if (text || globalThis.getComputedStyle?.(node)?.display?.startsWith('inline')) {
      if (anon) anon.to = i + 1; else list.push(anon = { from: i, to: i + 1 });
    } else { anon = null; list.push({ el: node }); }
    of[i] = list.length - 1;
  }
  return (index.groups = { list, of });
}

// 富文本里「可视区里的第一处」：返回 list 的下标，top 是可视区顶（viewport 坐标）。
// 组二分 → 从起点按 DOM 顺序逐个量（最多 FIND_MEASURE 个）→ 量满了后面还有就取后面第一处（近似），扫完了回绕到第一处。
// 没有超长组时，选中的就是 DOM 顺序上第一处底边在可视区顶以下的匹配。匹配在收起的 <details> 里时，用最外层收起者的矩形。
export function firstVisible(index, list, top, makeRange) {
  const { list: groups, of } = richGroups(index);
  const bottomOf = group => {
    if (group.el) return group.el.getBoundingClientRect().bottom;
    const range = makeRange();
    range.setStart(index.root, group.from);
    range.setEnd(index.root, group.to);
    return range.getBoundingClientRect().bottom;
  };
  let low = 0, high = groups.length;
  while (low < high) { const mid = (low + high) >> 1; if (bottomOf(groups[mid]) < top) low = mid + 1; else high = mid; }
  const groupOf = ([start]) => of[index.nodes[bisect(index.nodes, start)].top];
  let from = 0, to = list.length;
  while (from < to) { const mid = (from + to) >> 1; if (groupOf(list[mid]) < low) from = mid + 1; else to = mid; }
  if (from === list.length) return 0; // 可视区下方没有任何匹配：回绕
  const stop = Math.min(list.length, from + FIND_MEASURE);
  for (let i = from; i < stop; i++) {
    const hidden = hiddenByDetails(nodeAt(index, list[i][0]));
    if ((hidden ?? rangeAt(index, list[i], makeRange)).getBoundingClientRect().bottom >= top) return i; // 跨行的匹配只要还有一行看得见就算：整块的底边，不是第一行的
  }
  return stop < list.length ? stop : 0;
}


const highlightsSupported = () => typeof globalThis.CSS !== 'undefined' && !!globalThis.CSS.highlights && typeof globalThis.Highlight === 'function';
const mark = (name, options) => { try { globalThis.performance?.measure?.(name, options); } catch { /* 没有也不影响 */ } };

// body：正文滚动容器（.pbody）；gutterWidth()：行号列（sticky）的宽度，横向滚动要扣掉；
// makeRange()：造 Range，测试可换。返回查找条（el）和控制它的方法。
export function createFind({ body, gutterWidth = () => 0, makeRange = () => document.createRange() }) {
  const input = h('input', { type: 'search', class: 'finput', placeholder: '查找', enterkeyhint: 'search', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': '在文件里查找' });
  const count = h('span', { class: 'fcount caption secondary', 'aria-live': 'polite' });
  const prev = h('button', { class: 'icon fprev', 'aria-label': '上一个', title: '上一个（⇧⌘G）' }, icon('chevron', 18));
  const next = h('button', { class: 'icon fnext', 'aria-label': '下一个', title: '下一个（⌘G）' }, icon('chevron', 18));
  const done = h('button', { class: 'link fdone' }, '完成');
  const el = h('div', { class: 'fbar', role: 'search', hidden: true }, input, count, prev, next, done);

  let open = false, term = '';
  let content = null; // { el, text, index, highlight, rich }：现在显示的这一版正文
  let version = 0, runId = 0, debounce = null, batch = null;
  let list = [], more = false, current = -1;
  let marks = null; // { all, now }

  const cancelWork = () => { runId++; clearTimeout(debounce); clearTimeout(batch); debounce = batch = null; };
  const clearMarks = () => {
    if (highlightsSupported()) { globalThis.CSS.highlights.delete('find'); globalThis.CSS.highlights.delete('find-current'); }
    marks = null;
  };
  const indexOf = () => (content.index ??= (content.rich ? buildRichIndex : buildIndex)(content.el));

  function paint() {
    count.textContent = term === '' ? '' : !content ? '—' : list.length === 0 ? '0' : `${current + 1}/${more ? `${FIND_MAX}+` : list.length}`;
    prev.disabled = next.disabled = list.length === 0;
  }

  // 可见区顶部之后的第一个匹配的下标：按行算（正文不折行，每行一样高）；没有就是第一个。
  function firstAfterTop() {
    const text = content.el, box = text.getBoundingClientRect(), top = body.getBoundingClientRect().top - box.top;
    const lh = parseFloat(globalThis.getComputedStyle?.(text)?.lineHeight) || 20, line = Math.max(0, Math.floor(top / lh));
    let offset = 0;
    for (let n = 0, at = content.text.indexOf('\n'); n < line && at !== -1; n++, at = content.text.indexOf('\n', at + 1)) offset = at + 1;
    const at = list.findIndex(([start]) => start >= offset);
    return at < 0 ? 0 : at;
  }
  // 起点离 near 最近的（差的绝对值最小，一样近取前一个）。
  function nearest(near) {
    let best = 0;
    for (let i = 1; i < list.length; i++) if (Math.abs(list[i][0] - near) < Math.abs(list[best][0] - near)) best = i;
    return best;
  }

  // 滚到这一处：先竖向滚 body，让它的起点进入可见区（键盘弹起时和 visualViewport 取交集），已经在可见区就不动。
  // 源码：横向也只滚 body（扣掉行号列）。富文本：沿祖先链把每个横向可滚动的元素（宽表格、代码块）滚到能看见这一处。
  function scrollInto(range, node) {
    const r = firstRect(range), b = body.getBoundingClientRect(), view = globalThis.visualViewport;
    const left = b.left + gutterWidth(), top = view ? Math.max(b.top, view.offsetTop) : b.top, bottom = view ? Math.min(b.bottom, view.offsetTop + view.height) : b.bottom;
    if (bottom - top <= 0) return; // 可见区和 visualViewport 的交集是空的：没有地方可看，不滚
    if (r.top < top || r.bottom > bottom) body.scrollTop += r.top - (top + Math.max(0, (bottom - top - r.height) / 2));
    if (!content.rich) { if (r.left < left || r.left > b.right) body.scrollLeft += r.left - (left + 24); return; }
    for (let el = parentOf(node); el; el = parentOf(el)) {
      if (el.scrollWidth > el.clientWidth) {
        const box = el.getBoundingClientRect(), now = firstRect(range);
        if (now.left < box.left) el.scrollLeft += now.left - box.left - 24;
        else if (now.right > box.right) el.scrollLeft += Math.min(now.right - box.right + 24, now.left - box.left);
      }
      if (el === body) break;
    }
  }

  // 滚动的导航（新词、上一个、下一个、切模式）先展开沿途遮住它的 <details>；后台刷新不滚动，也不擅自展开。
  function showCurrent(scroll) {
    const index = indexOf(), range = rangeAt(index, list[current], makeRange);
    marks?.now.clear();
    marks?.now.add(range);
    if (!scroll) return;
    const node = nodeAt(index, list[current][0]);
    if (content.rich) for (let details = hiddenByDetails(node); details; details = hiddenByDetails(node)) details.setAttribute('open', '');
    scrollInto(range, node);
  }

  // 一次查找：scroll 为假时不滚动（后台刷新）；near 是旧的当前处的起点，给了就取离它最近的；first 为真取第 1 处（切模式）；都没有就取可视区里的第一处。
  function run({ scroll = true, near = null, first = false } = {}) {
    cancelWork();
    clearMarks();
    list = []; more = false; current = -1;
    const mine = runId, ver = version, began = globalThis.performance?.now?.() ?? 0;
    if (term !== '' && content) {
      ({ list, more } = content.rich ? findRich(indexOf(), term) : findMatches(content.text, term));
      if (list.length) current = near !== null ? nearest(near) : first ? 0 : content.rich ? firstVisible(indexOf(), list, body.getBoundingClientRect().top, makeRange) : firstAfterTop();
    }
    paint();
    if (list.length === 0) { mark('find-run', { start: began }); globalThis.performance?.mark?.('find-done'); return; }
    if (highlightsSupported() && content.highlight) {
      const all = new globalThis.Highlight(), now = new globalThis.Highlight();
      all.priority = 0;
      now.priority = 1; // 当前这处盖在全部匹配上面，不靠注册的先后
      marks = { all, now };
      globalThis.CSS.highlights.set('find', all);
      globalThis.CSS.highlights.set('find-current', now);
    }
    showCurrent(scroll);
    if (!marks) { mark('find-run', { start: began }); globalThis.performance?.mark?.('find-done'); return; }
    let at = 0;
    const step = () => {
      if (mine !== runId || ver !== version) return; // 换词、换正文、关闭：停
      const t0 = globalThis.performance?.now?.() ?? 0, to = Math.min(list.length, at + FIND_BATCH);
      for (const range of rangesFor(indexOf(), list, at, to, makeRange)) marks.all.add(range);
      at = to;
      mark('find-batch', { start: t0 });
      if (at < list.length) batch = setTimeout(step, 0); // 让出到宏任务：输入和绘制能插进来
      else globalThis.performance?.mark?.('find-done');
    };
    step();
    mark('find-run', { start: began }); // 这次查找同步算的部分：找匹配、定当前这处、标第一批
  }

  const go = step => {
    if (list.length === 0) return;
    current = (current + step + list.length) % list.length;
    paint();
    showCurrent(true);
  };

  input.addEventListener('input', () => {
    term = input.value;
    cancelWork();
    if (term === '') return run();
    debounce = setTimeout(() => { debounce = null; run(); }, FIND_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const bare = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (event.key === 'Enter' && bare) { event.preventDefault(); go(event.shiftKey ? -1 : 1); }
  });
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));

  return {
    el, input, done,
    get isOpen() { return open; },
    get term() { return term; },
    get count() { return count.textContent; },
    get current() { return list.length ? list[current] : null; },
    get total() { return list.length; },
    get supported() { return highlightsSupported(); },
    // 打开并聚焦；已经开着就选中输入框里的字。
    open() {
      const was = open;
      open = true;
      el.hidden = false;
      body.classList.add('finding'); // 高亮的样式规则只在查找开着时生效（style.css）
      input.focus();
      if (was) input.select?.();
    },
    // 关：立刻取消防抖和计算，删掉注册的 Highlight，关查找条；搜索词一并清掉。
    close() {
      cancelWork();
      clearMarks();
      open = false;
      body.classList.remove('finding');
      term = '';
      input.value = '';
      list = []; more = false; current = -1;
      el.hidden = true;
      paint();
    },
    // 换了一版正文（show）：词和查找条留着，重新找。rich 为真时 textEl 是富文本的根（text 不用）。
    // keepPosition（后台刷新）：当前这处取离旧起点最近的，不滚动；为假（预览和源码之间切换）：取第 1 处并滚过去。
    // highlight 为假（有长行的文件）时不标颜色，只计数、导航、滚动，同浏览器不支持 Highlight API。
    setContent(textEl, text, { rich = false, highlight = true, keepPosition = true } = {}) {
      content = { el: textEl, text, index: null, highlight, rich };
      version++;
      if (!open) return;
      if (keepPosition) run({ scroll: false, near: current >= 0 ? list[current][0] : null });
      else run({ first: true });
    },
    // 正文没了（读取中、文件没了、整页重读失败）：清掉标记，计数写「—」；之后再 setContent 就重新找。
    clearContent() {
      content = null;
      version++;
      cancelWork();
      clearMarks();
      list = []; more = false; current = -1;
      paint();
    },
    next: () => go(1),
    prev: () => go(-1),
    // 跳到上一个、下一个（⌘G、⇧⌘G）由预览的键盘处理调用。
  };
}
