// 文件内查找（设计见 docs/design/phase-3.md 第 18.6 节）：预览里的查找条，高亮全部匹配，显示「第几个 / 共几个」，上一个、下一个，不分大小写。
// 全部在页面里做，只找当前显示的这份正文。纯函数（findMatches、buildIndex、rangesFor）和查找条（createFind）在这里，预览（preview.mjs）负责接上自己的生命周期。
//
// 每个异步机制的五样：
// - 输入防抖：输入框 input 时开始，停顿 FIND_DEBOUNCE_MS 才找；找之前、关查找条、换正文时取消；到点只做一次。
// - 分批标记：一次查找（runId）持有。找完匹配先同步标第一批，之后每批 BATCH 个，批间 setTimeout(0) 让出；
//   每批开始时核对 runId 和正文版本，变了就停（关查找条、换词、换正文、清掉都会让它作废）。
// - 正文版本 version：show() 换正文、clearContent 都加一，之前的批次和待执行的防抖据此作废。
// - 高亮注册：find（全部匹配）和 find-current（当前这处，priority 更高）两个 Highlight，一次查找新建一份，关闭、换词、清掉时从 CSS.highlights 删掉。
//   不支持 Highlight API、或正文有长行（hasLongLine，预览给的）时不注册，只计数、导航、滚动。
// - 超时：没有；10000 处的上限和每批 2000 个让出就是它的界。
import { h } from './dom.mjs';
import { icon } from './icons.mjs';

export const FIND_MAX = 10_000;
export const FIND_BATCH = 2000;
export const FIND_DEBOUNCE_MS = 150;

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
  let content = null; // { el, text, index }：现在显示的这一版正文
  let version = 0, runId = 0, debounce = null, batch = null;
  let list = [], more = false, current = -1;
  let marks = null; // { all, now }

  const cancelWork = () => { runId++; clearTimeout(debounce); clearTimeout(batch); debounce = batch = null; };
  const clearMarks = () => {
    if (highlightsSupported()) { globalThis.CSS.highlights.delete('find'); globalThis.CSS.highlights.delete('find-current'); }
    marks = null;
  };
  const indexOf = () => (content.index ??= buildIndex(content.el));

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

  // 滚到这一处：只滚 body，竖向和横向都让它的起点进入可见区（横向扣掉行号列，键盘弹起时和 visualViewport 取交集），已经在可见区就不动。
  function scrollInto(range) {
    const r = range.getBoundingClientRect(), b = body.getBoundingClientRect(), view = globalThis.visualViewport;
    const left = b.left + gutterWidth(), top = view ? Math.max(b.top, view.offsetTop) : b.top, bottom = view ? Math.min(b.bottom, view.offsetTop + view.height) : b.bottom;
    if (bottom - top <= 0) return; // 可见区和 visualViewport 的交集是空的：没有地方可看，不滚
    if (r.top < top || r.bottom > bottom) body.scrollTop += r.top - (top + Math.max(0, (bottom - top - r.height) / 2));
    if (r.left < left || r.left > b.right) body.scrollLeft += r.left - (left + 24);
  }

  function showCurrent(scroll) {
    const range = rangeAt(indexOf(), list[current], makeRange);
    marks?.now.clear();
    marks?.now.add(range);
    if (scroll) scrollInto(range);
  }

  // 一次查找：scroll 为假时不滚动（正文换了、刷新）；near 是旧的当前处的起点，给了就取离它最近的。
  function run({ scroll = true, near = null } = {}) {
    cancelWork();
    clearMarks();
    list = []; more = false; current = -1;
    const mine = runId, ver = version, began = globalThis.performance?.now?.() ?? 0;
    if (term !== '' && content) {
      ({ list, more } = findMatches(content.text, term));
      if (list.length) current = near === null ? firstAfterTop() : nearest(near);
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
    // 换了一版正文（show）：词和查找条留着，重新找；当前这处取离旧起点最近的，不滚动。
    // highlight 为假（有长行的文件）时不标颜色，只计数、导航、滚动，同浏览器不支持 Highlight API。
    setContent(textEl, text, { highlight = true } = {}) {
      content = { el: textEl, text, index: null, highlight };
      version++;
      if (open) run({ scroll: false, near: current >= 0 ? list[current][0] : null });
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
