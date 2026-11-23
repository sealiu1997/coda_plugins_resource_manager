// 富文本预览里的查找（第 26.2 节）：索引（块边界、虚拟字符、空白折叠）、初始定位、滚动、折叠的 <details>、选区、和预览的接线。
// 假 DOM 没有布局：每个测试自己给节点指定矩形（layout），Range 的矩形由 installHighlights 的 rectOf 钩子给。真实布局由 test/harness/rich-find.mjs 在真 Chrome 里量。
import assert from 'node:assert/strict';
import test from 'node:test';
import { FIND_BATCH, FIND_MEASURE, buildRichIndex, createFind, findRich, firstVisible, rangeAt } from '../view/find.mjs';
import { renderMarkdown } from '../view/markdown.mjs';
import { mountPreview } from '../view/preview.mjs';
import { hiddenByDetails } from '../view/rich.mjs';
import { clippedRichSelection } from '../view/selection.mjs';
import { Element } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { open } from './support/filepage.mjs';
import { installHighlights } from './support/highlights.mjs';
import { fakeSelection } from './support/selection.mjs';

const el = (tag, attrs = null, ...kids) => {
  const node = new Element(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) node.setAttribute(key, value);
  node.append(...kids);
  return node;
};
const textOf = node => node.children.find(child => typeof child.data === 'string');
const byClass = (root, cls) => root.find(n => n.classList?.contains(cls));
const rows = (count, make) => Array.from({ length: count }, (_, i) => make(i));
const withDom = t => open(t, { path: 'x.txt', files: {} }); // 装上假 document 和假时钟

// 行内元素的 display：富文本根的顶层分组据此把相邻的文本和行内元素合成一个匿名组。
function inlineStyles(t) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  globalThis.getComputedStyle = node => ({ display: ['STRONG', 'A', 'CODE', 'EM', 'SPAN'].includes(node.tagName) ? 'inline' : 'block', lineHeight: '20px' });
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'getComputedStyle', saved); else delete globalThis.getComputedStyle; });
}

// 给节点指定矩形 [top, bottom]：元素量自己的，文本节点（匹配的 Range 起点）量它自己的，根上的组 Range 量覆盖的子节点。
function layout(t, root, spec) {
  const env = installHighlights(t), calls = { match: 0, group: 0 };
  const box = ([top, bottom]) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top });
  env.rectOf = range => {
    if (range.startNode === root) {
      calls.group++;
      const boxes = root.children.slice(range.startOffset, range.endOffset).map(node => spec.get(node));
      return box([Math.min(...boxes.map(b => b[0])), Math.max(...boxes.map(b => b[1]))]);
    }
    calls.match++;
    return box(spec.get(range.startNode));
  };
  for (const [node, rect] of spec) if (node.tagName) node.getBoundingClientRect = () => box(rect);
  return { env, calls };
}
const pick = (root, term, top, env) => {
  const index = buildRichIndex(root), { list } = findRich(index, term);
  return { list, at: firstVisible(index, list, top, env.makeRange), index };
};

// ---- 索引 ----

test('buildRichIndex：块、<br>、单元格的边界各占一个虚拟字符，匹配不跨过它；空文本节点不进表', () => {
  const root = el('div', null, el('p', null, 'ab'), el('p', null, 'cd', el('br'), 'ef', ''), el('table', null, el('tr', null, el('td', null, '10'), el('td', null, '20'))));
  const index = buildRichIndex(root);
  assert.deepEqual(index.nodes.map(n => [n.start, n.end]), [[0, 2], [3, 5], [6, 8], [9, 11], [12, 14]], '每个边界只加 1');
  assert.equal(index.length, 14);
  assert.deepEqual(findRich(index, 'cd').list, [[3, 5]]);
  for (const term of ['bc', 'de', '1020', '02', 'abcd']) assert.deepEqual(findRich(index, term).list, [], `「${term}」跨了块、硬换行或单元格`);
  assert.deepEqual(findRich(index, '10').list, [[9, 11]]);
});

test('buildRichIndex：匹配可以跨行内节点（半句加粗）；顶层文本记下自己的下标', t => {
  const strong = el('strong', null, '加粗');
  const root = el('div', null, '前文', strong, el('p', null, '半句', el('em', null, '斜'), '尾'));
  const index = buildRichIndex(root);
  assert.deepEqual(index.nodes.map(n => n.top), [0, 1, 2, 2, 2]);
  const { list } = findRich(index, '文加粗');
  assert.deepEqual(list, [[1, 4]]);
  const env = installHighlights(t);
  const range = rangeAt(index, list[0], env.makeRange);
  assert.equal(range.startNode, textOf(root), '起点在「前文」里');
  assert.equal(range.endNode, textOf(strong));
  assert.deepEqual(findRich(index, '句斜尾').list.length, 1);
});

test('buildRichIndex：带 data-rich-ui 的元素（复制邮箱按钮、占位、提示）不进表，里面的字搜不到', () => {
  const root = el('div', null, el('p', null, '联系 ', el('span', null, el('button', { 'data-rich-ui': '' }, '复制邮箱')), '结束'));
  const index = buildRichIndex(root);
  assert.equal(index.nodes.length, 2);
  assert.deepEqual(findRich(index, '复制邮箱').list, []);
  assert.deepEqual(findRich(index, '联系 结束').list.length, 1, '按钮的位置不留痕迹');
});

test('空白折叠：连续空白（含换行、缩进、跨节点）折成一个空格，命中映射回原始偏移，包括以空白结尾的匹配', () => {
  const root = el('pre', null, 'foo\n   bar', el('b', null, '  baz'), '\t\nqux  ');
  const index = buildRichIndex(root), text = 'foo\n   bar  baz\t\nqux  ';
  const at = word => { const start = text.indexOf(word); return [start, start + word.length]; };
  assert.deepEqual(findRich(index, 'foo bar').list, [[0, 10]], '换行加缩进');
  assert.deepEqual(findRich(index, 'bar baz').list, [[7, 15]], '跨节点的空白');
  assert.deepEqual(findRich(index, 'baz qux').list, [[12, 20]]);
  assert.deepEqual(findRich(index, 'foo ').list, [[0, 7]], '以空白结尾：终点是整段空白的末尾，不差一位');
  assert.deepEqual(findRich(index, ' bar').list, [[3, 10]]);
  assert.deepEqual(findRich(index, 'foo   \n bar').list, [[0, 10]], '搜索词里的空白同样折叠');
  assert.deepEqual(findRich(index, 'qux ').list, [[at('qux')[0], text.length]]);
  assert.deepEqual(findRich(index, 'f\0oo\0 bar').list, [[0, 10]], '搜索词里的 \\0 去掉');
  assert.deepEqual(findRich(index, '\0').list, []);
});

test('空白折叠是线性的：一百万个空白后零命中，不回溯', () => {
  const root = el('pre', null, `a${' \n'.repeat(500_000)}b`);
  const began = performance.now(), index = buildRichIndex(root);
  assert.deepEqual(findRich(index, 'a   c').list, []);
  assert.deepEqual(findRich(index, 'a b').list, [[0, 1_000_002]], '整段空白折成一个空格');
  assert.ok(performance.now() - began < 2000, `用了 ${Math.round(performance.now() - began)} 毫秒`);
});

// ---- 初始定位：断言具体选中哪一处 ----

test('初始定位：表格同一行三个单元格高低交错，选中的是 DOM 顺序上第一处底边在可视区顶以下的', t => {
  const cells = ['x', 'x', 'x'].map(word => el('td', null, word));
  const root = el('div', null, el('p', null, '无'), el('table', null, el('tr', null, ...cells)));
  const [p, table] = root.children;
  const { env } = layout(t, root, new Map([[p, [0, 100]], [table, [100, 300]], [textOf(cells[0]), [100, 140]], [textOf(cells[1]), [140, 180]], [textOf(cells[2]), [100, 120]], [textOf(p), [0, 100]]]));
  const { list, at } = pick(root, 'x', 150, env);
  assert.equal(list.length, 3);
  assert.equal(at, 1, '第 1 个在上方，第 2 个底边 180 ≥ 150；第 3 个更靠上也不影响，不是二分');
});

test('初始定位：可视区顶落在一个没有命中的段落里，选中下一段的命中', t => {
  const [a, b, c] = ['hit', '无', 'hit'].map(word => el('p', null, word));
  const root = el('div', null, a, b, c);
  const { env } = layout(t, root, new Map([[a, [0, 100]], [b, [100, 200]], [c, [200, 300]], [textOf(a), [0, 100]], [textOf(b), [100, 200]], [textOf(c), [200, 300]]]));
  assert.equal(pick(root, 'hit', 150, env).at, 1);
  assert.equal(pick(root, 'hit', 50, env).at, 0, '可视区顶在第一段里：第一段的命中');
});

test('初始定位：长表格里前 200 处都已滚出可视区，第 201 处正好可见', t => {
  const cells = rows(300, () => el('td', null, 'x'));
  const trs = cells.map(cell => el('tr', null, cell));
  const table = el('table', null, ...trs), root = el('div', null, table);
  const spec = new Map([[table, [0, 3000]]]);
  cells.forEach((cell, i) => spec.set(textOf(cell), [i * 10, i * 10 + 10]));
  const { env, calls } = layout(t, root, spec);
  const { at } = pick(root, 'x', 2001, env);
  assert.equal(at, 200, '第 201 处（下标 200）：前 200 处的底边都 ≤ 2000');
  assert.equal(calls.match, 201, '从起点逐个量，量到它就停');
});

test('初始定位：超过 2000 处都在可视区上方、后面还有匹配：量满 2000 个，取第 2000 个之后的第一处（近似）', t => {
  const cells = rows(2500, () => el('td', null, 'x'));
  const table = el('table', null, ...cells.map(cell => el('tr', null, cell))), root = el('div', null, table);
  const spec = new Map([[table, [0, 25_000]]]);
  cells.forEach((cell, i) => spec.set(textOf(cell), [i * 10, i * 10 + 10]));
  const { env, calls } = layout(t, root, spec);
  const { at } = pick(root, 'x', 24_005, env);
  assert.equal(FIND_MEASURE, 2000);
  assert.equal(at, 2000);
  assert.equal(calls.match, 2000, '只量了 2000 个');
});

test('初始定位：只有第一段有命中、可视区停在末尾：回绕到全文第一处', t => {
  const paragraphs = ['hit hit', '无', '无', '无', '无', '无'].map(word => el('p', null, word));
  const root = el('div', null, ...paragraphs);
  const spec = new Map();
  paragraphs.forEach((p, i) => { spec.set(p, [i * 100, i * 100 + 100]); spec.set(textOf(p), [i * 100, i * 100 + 100]); });
  const { env } = layout(t, root, spec);
  const { list, at } = pick(root, 'hit', 450, env);
  assert.equal(list.length, 2);
  assert.equal(at, 0, '起点不存在：回绕到第一处，不是最后一处');
});

test('初始定位：起点之后正好 2000 处、全在可视区上方、后面没有了：回绕到第一处', t => {
  const head = el('p', null, 'x');
  const cells = rows(2000, () => el('td', null, 'x'));
  const table = el('table', null, ...cells.map(cell => el('tr', null, cell))), root = el('div', null, head, table);
  const spec = new Map([[head, [0, 50]], [textOf(head), [0, 50]], [table, [50, 5000]]]);
  cells.forEach((cell, i) => spec.set(textOf(cell), [50 + i, 51 + i]));
  const { env } = layout(t, root, spec);
  const { list, at } = pick(root, 'x', 3000, env);
  assert.equal(list.length, 2001);
  assert.equal(at, 0, '起点是第 2 处，量满 2000 个都在上方，后面没有了：回绕，不是越界的 2001');
});

test('初始定位：根上直接是「正文<strong>重点</strong>」，没有块：相邻的文本和行内元素合成一个匿名组，用覆盖它们的 Range 量', t => {
  inlineStyles(t);
  const strong = el('strong', null, '重点');
  const root = el('div', null, '正文重点', strong);
  const spec = new Map([[root.children[0], [0, 20]], [strong, [40, 60]], [textOf(strong), [40, 60]]]);
  const { env, calls } = layout(t, root, spec);
  const { list, at } = pick(root, '重点', 30, env);
  assert.equal(list.length, 2);
  assert.equal(at, 1, '第一处在第一行（底边 20 < 30），第二处在 strong 里');
  assert.equal(calls.group, 1, '只有一个匿名组：用 Range 量了一次');
});

test('初始定位：没有匹配时不量，回到第一处（空表不出错）', t => {
  const root = el('div', null, el('p', null, 'abc'));
  const { env, calls } = layout(t, root, new Map([[root.children[0], [0, 10]], [textOf(root.children[0]), [0, 10]]]));
  const { list, at } = pick(root, 'zzz', 0, env);
  assert.deepEqual(list, []);
  assert.equal(at, 0);
  assert.equal(calls.match, 0, '没有匹配可量');
});

test('初始定位：第 1 处跨两行，第一行已滚出可视区、第二行还看得见，选中它而不是跳到第 2 处', t => {
  const [a, b] = ['hit', 'hit'].map(word => el('p', null, word));
  const root = el('div', null, a, b);
  const { env } = layout(t, root, new Map([[a, [20, 65]], [b, [70, 90]], [textOf(a), [20, 65]], [textOf(b), [70, 90]]]));
  const makeRange = () => { // 第 1 处跨两行：第一行底边 44，整块底边 65；第 2 处只有一行
    const range = env.makeRange();
    range.getClientRects = () => [range.startNode === textOf(a) ? { top: 20, bottom: 44, left: 0, right: 100, width: 100, height: 24 } : range.getBoundingClientRect()];
    return range;
  };
  const index = buildRichIndex(root), { list } = findRich(index, 'hit');
  assert.equal(list.length, 2);
  assert.equal(firstVisible(index, list, 50, makeRange), 0, '整块的底边 65 ≥ 50：还看得见，不能按第一行（44）跳过');
});

test('初始定位：匹配在收起的 <details> 里，用最外层收起者的矩形；展开后用自己的', t => {
  const inner = el('details', null, el('summary', null, 'b'), el('p', null, 'hit'));
  const outer = el('details', null, el('summary', null, 'a'), inner);
  const lead = el('p', null, 'hit'), root = el('div', null, lead, outer);
  const spec = new Map([[lead, [0, 40]], [textOf(lead), [0, 40]], [outer, [100, 130]], [textOf(inner.children[1]), [0, 0]], [inner, [0, 0]]]);
  const { env } = layout(t, root, spec);
  // 隐藏的内容量不出矩形（0）：不用最外层的矩形的话，第二处会被当成在可视区上方
  assert.equal(pick(root, 'hit', 90, env).at, 1, '第一处在上方；第二处在 [100,130] 的 details 里，可见');
  outer.setAttribute('open', '');
  inner.setAttribute('open', '');
  assert.equal(pick(root, 'hit', 90, env).at, 0, '展开后自己的矩形 [0,0] 在上方：没有可见的，回绕到第一处');
});

test('图片占位（远程图片、没有流式地址的本地图片）是插件自己的文字：搜不到', async t => {
  await withDom(t);
  const md = renderMarkdown('![图](https://example.com/a.png) 和 ![本地](a.png) 正文\n', { basePath: 'README.md' });
  assert.equal(byClass(md, 'md-img-fallback').length, 2);
  const index = buildRichIndex(md);
  for (const term of ['图片', '外链图片', '[图片：本地]']) assert.deepEqual(findRich(index, term).list, [], `「${term}」是占位的字`);
  assert.equal(findRich(index, '正文').list.length, 1);
});

test('<details> 和 <summary> 是块边界：摘要和折叠的正文不拼成一个命中；搜折叠里的字，导航先展开再滚动', async t => {
  const details = el('details', null, el('summary', null, 'summary'), 'hidden');
  const root = el('div', null, details);
  assert.deepEqual(findRich(buildRichIndex(root), 'summaryhidden').list, []);
  const { find, type } = await fixture(t, root);
  type('hidden');
  assert.equal(find.count, '1/1');
  assert.notEqual(details.getAttribute('open'), null, '折叠的部分展开了');
});

// ---- hiddenByDetails ----

test('hiddenByDetails：可见摘要是第一个 summary 子元素，不要求是第一个子节点；摘要里的不算遮住', () => {
  const summary = el('summary', null, '摘要'), body = el('p', null, '正文');
  const details = el('details', null, '前置文字', body, summary, el('summary', null, '第二个摘要'));
  assert.equal(hiddenByDetails(textOf(summary)), null);
  assert.equal(hiddenByDetails(summary), null);
  assert.equal(hiddenByDetails(textOf(body)), details);
  assert.equal(hiddenByDetails(textOf(details)), details, '直接在 details 下的文字');
  assert.equal(hiddenByDetails(details.children[3].children[0]), details, '第二个 summary 不是可见摘要');
  details.setAttribute('open', '');
  assert.equal(hiddenByDetails(textOf(body)), null, '展开了：没有遮住');
  assert.equal(hiddenByDetails(textOf(el('p', null, '游离'))), null);
});

test('hiddenByDetails：两层嵌套，外层收起时里层的摘要也看不见；返回最外层遮住的', () => {
  const innerSummary = el('summary', null, '里摘要'), innerBody = el('p', null, '里正文');
  const inner = el('details', null, innerSummary, innerBody);
  const outer = el('details', null, el('summary', null, '外摘要'), inner);
  assert.equal(hiddenByDetails(textOf(innerSummary)), outer, '里层的摘要被外层遮住');
  assert.equal(hiddenByDetails(textOf(innerBody)), outer, '两层都遮住：取最外层');
  outer.setAttribute('open', '');
  assert.equal(hiddenByDetails(textOf(innerSummary)), null);
  assert.equal(hiddenByDetails(textOf(innerBody)), inner);
  inner.setAttribute('open', '');
  assert.equal(hiddenByDetails(textOf(innerBody)), null);
});

// ---- 选区 ----

test('选区：clippedRichSelection 跳过被收起的 <details> 遮住的文字，保留 Range 的起止偏移；展开后带上', async t => {
  await withDom(t);
  const hidden = el('p', null, '藏起来');
  const details = el('details', null, el('summary', null, '摘要'), hidden);
  const root = el('div', null, el('p', null, '前'), details, el('p', null, '后'));
  const sel = fakeSelection(t, root), all = root.textContent;
  assert.equal(all, '前摘要藏起来后');
  sel.select(root, 0, all.length);
  assert.deepEqual(clippedRichSelection(root), { text: '前\n摘要\n后', start: 0 });
  sel.select(root, 3, all.length); // 从「藏起来」中间开始
  assert.deepEqual(clippedRichSelection(root), { text: '后', start: 3 }, '起点偏移是选区的，不因为跳过而变');
  sel.select(root, 3, 6);
  assert.equal(clippedRichSelection(root), null, '选的全是被遮住的字：没有可复制的');
  details.setAttribute('open', '');
  sel.select(root, 0, all.length);
  assert.equal(clippedRichSelection(root)?.text, '前\n摘要\n藏起来\n后');
});

// ---- 查找条：导航、滚动、展开 ----

async function fixture(t, root, { highlight = true, rich = true, version } = {}) {
  await withDom(t);
  const env = installHighlights(t), body = el('div');
  body.append(root);
  const makeRange = () => { const range = env.makeRange(); range.getClientRects = () => env.rects?.(range) ?? [env.rectOf?.(range) ?? { top: 0, bottom: 20, left: 0, right: 10, height: 20, width: 10 }]; return range; };
  const find = createFind({ body, makeRange, version });
  find.open();
  find.setContent(root, null, { rich, highlight });
  const type = term => { find.input.value = term; find.input.dispatch('input'); t.mock.timers.tick(150); };
  return { env, body, find, type };
}

test('折叠内容：新词、上一个、下一个、切模式后的第一处展开沿途所有 <details>；后台刷新不擅自展开', async t => {
  const innerHit = el('p', null, 'needle one'), inner = el('details', null, el('summary', null, 'b'), innerHit);
  const outer = el('details', null, el('summary', null, 'a'), inner);
  const tail = el('p', null, 'needle two');
  const root = el('div', null, outer, tail);
  const { find, type } = await fixture(t, root);
  const closeAll = () => { outer.removeAttribute('open'); inner.removeAttribute('open'); };
  const opened = () => [outer, inner].map(d => d.getAttribute('open') !== null);

  type('needle');
  assert.equal(find.count, '1/2');
  assert.deepEqual(opened(), [true, true], '新词：外层和里层都展开');
  closeAll();
  find.setContent(root, null, { rich: true, keepPosition: true });
  assert.deepEqual(opened(), [false, false], '后台刷新：不展开');
  assert.equal(find.count, '1/2');
  find.next();
  assert.equal(find.count, '2/2');
  assert.deepEqual(opened(), [false, false], '第二处不在 details 里');
  find.next();
  assert.equal(find.count, '1/2');
  assert.deepEqual(opened(), [true, true], '下一个（回绕）：展开');
  closeAll();
  find.prev();
  find.prev();
  assert.equal(find.count, '1/2');
  assert.deepEqual(opened(), [true, true], '上一个：展开');
  closeAll();
  find.setContent(root, null, { rich: true, keepPosition: false });
  assert.equal(find.count, '1/2');
  assert.deepEqual(opened(), [true, true], '切模式后跳到第一处：展开');
});

test('滚动：匹配跨多行时用第一个矩形定位竖向位置', async t => {
  const root = el('p', null, 'a needle b');
  const { env, body, find, type } = await fixture(t, root);
  const first = { top: 500, bottom: 520, left: 0, right: 100, height: 20, width: 100 }, second = { top: 520, bottom: 540, left: 0, right: 40, height: 20, width: 40 };
  env.rects = () => [first, second];
  env.rectOf = () => ({ top: 500, bottom: 540, left: 0, right: 100, height: 40, width: 100 });
  type('needle');
  assert.equal(find.count, '1/1');
  assert.equal(body.scrollTop, 500 - 2, '按第一行（高 20）居中，不是按整块（高 40）');
});

test('滚动：沿祖先链把横向可滚动的元素（宽表格、代码块）滚到匹配可见；已经可见就不动', async t => {
  const hit = el('p', null, 'a needle b'), wrap = el('div', null, hit);
  Object.assign(wrap, { scrollWidth: 500, clientWidth: 100, scrollLeft: 0 });
  wrap.getBoundingClientRect = () => ({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 });
  const root = el('div', null, wrap);
  const { env, body, find, type } = await fixture(t, root);
  const at = (left, right) => { env.rects = () => [{ top: 0, bottom: 20, left, right, height: 20, width: right - left }]; };
  at(300, 340);
  type('needle');
  assert.equal(wrap.scrollLeft, 264, '右边在外面：滚到看得见，但不超过它的起点');
  assert.equal(body.scrollLeft ?? 0, 0, 'body 没有横向溢出，不动');
  wrap.scrollLeft = 200;
  at(-50, -10);
  find.next();
  assert.equal(wrap.scrollLeft, 200 - 50 - 24, '左边在外面：起点留 24 的边距');
  wrap.scrollLeft = 7;
  at(20, 60);
  find.next();
  assert.equal(wrap.scrollLeft, 7, '已经在可见范围内：不动');
  wrap.scrollLeft = 0;
  at(80, 400);
  find.next();
  assert.equal(wrap.scrollLeft, 80, '匹配比可见范围还宽：最多滚到它的起点贴左边');
});

test('切模式（keepPosition 为假）取第 1 处并滚过去；后台刷新（为真）取离旧位置最近的，不滚动', async t => {
  const paragraphs = rows(3, () => el('p', null, 'hit'));
  const root = el('div', null, ...paragraphs);
  const { env, body, find, type } = await fixture(t, root);
  const tops = new Map(paragraphs.map((p, i) => [textOf(p), 300 + 100 * i]));
  env.rectOf = range => ({ top: tops.get(range.startNode), bottom: tops.get(range.startNode) + 20, left: 0, right: 10, width: 10, height: 20 });
  env.rects = undefined;
  type('hit');
  find.next();
  find.next();
  assert.equal(find.count, '3/3');
  body.scrollTop = 0;
  const near = find.current[0];
  find.setContent(root, null, { rich: true, keepPosition: true });
  assert.equal(find.count, '3/3', '最近的还是第 3 处');
  assert.equal(find.current[0], near);
  assert.equal(body.scrollTop, 0, '不滚动');
  find.setContent(root, null, { rich: true, keepPosition: false });
  assert.equal(find.count, '1/3', '第 1 处');
  assert.equal(body.scrollTop, 300 - 2, '滚到第 1 处（在可见区下面）');
});

test('有长行时（highlight 为假）不注册 Highlight，只计数、导航、滚动；上一个下一个按 DOM 顺序', async t => {
  const root = el('div', null, el('p', null, 'a'), el('p', null, 'a'));
  const { env, find, type } = await fixture(t, root, { highlight: false });
  type('a');
  assert.equal(find.count, '1/2');
  assert.equal(env.registry.size, 0);
  find.next();
  assert.equal(find.count, '2/2');
  find.prev();
  find.prev();
  assert.equal(find.count, '2/2', '按 DOM 顺序回绕');
  assert.equal(env.registry.size, 0);
});

test('分批标记：富文本里的 Highlight 一批批注册；换了正文后，旧正文的批次不再往新的里加', async t => {
  const queue = new Map();
  let id = 2_000_000;
  const root = el('p', null, 'a '.repeat(FIND_BATCH * 2 + 5));
  const { env, find, type } = await fixture(t, root);
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout; // 假时钟启用之后才能取
  globalThis.setTimeout = (fn, ms, ...args) => { if (ms !== 0) return realSet(fn, ms, ...args); queue.set(++id, fn); return id; };
  globalThis.clearTimeout = handle => { if (queue.delete(handle)) return; realClear(handle); };
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });
  type('a');
  const old = env.registry.get('find');
  assert.equal(old.size, FIND_BATCH, '同步标第一批');
  assert.equal(queue.size, 1);
  const next = el('p', null, 'a '.repeat(FIND_BATCH + 10));
  find.setContent(next, null, { rich: true });
  assert.equal(queue.size, 1, '旧正文的下一批已作废，只有新正文的');
  const fresh = env.registry.get('find');
  assert.notEqual(fresh, old);
  while (queue.size) { const [[handle, fn]] = queue; queue.delete(handle); fn(); }
  assert.equal(old.size, FIND_BATCH, '旧批次没有再动');
  assert.equal(fresh.size, FIND_BATCH + 10);
});

test('分批标记：正文版本由调用方给；版本变了，排着的批次不再往里加（不靠 setContent）', async t => {
  const queue = new Map();
  let id = 3_000_000, bodyVersion = 7;
  const root = el('p', null, 'a '.repeat(FIND_BATCH * 2 + 5));
  const { env, type } = await fixture(t, root, { version: () => bodyVersion });
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => { if (ms !== 0) return realSet(fn, ms, ...args); queue.set(++id, fn); return id; };
  globalThis.clearTimeout = handle => { if (queue.delete(handle)) return; realClear(handle); };
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });
  type('a');
  const marks = env.registry.get('find');
  assert.equal(marks.size, FIND_BATCH);
  bodyVersion++;
  while (queue.size) { const [[handle, fn]] = queue; queue.delete(handle); fn(); }
  assert.equal(marks.size, FIND_BATCH, '版本变了：下一批不再动');
});

// ---- 和预览的接线 ----

const MD = '# 标题\n\n**foo** bar and foo\n';
const readOf = body => async () => ({ kind: 'text', data: Buffer.from(body.text).toString('base64'), offset: 0, size: Buffer.byteLength(body.text), mtimeMs: body.mtime, eof: true });

test('预览：⌘F 留在预览；在预览和源码之间切换时查找条保持打开，用同一个词重新找', async t => {
  await withDom(t);
  const env = installHighlights(t), box = new Element('div');
  const preview = mountPreview(box, { read: readOf({ text: MD, mtime: 100 }), copy: () => {} });
  await preview.open('docs/README.md');
  await flush();
  assert.equal(preview.openFind(), true);
  const field = byClass(box, 'finput')[0], count = () => byClass(box, 'fcount')[0].textContent;
  field.value = 'foo bar';
  field.dispatch('input');
  t.mock.timers.tick(150);
  assert.equal(count(), '1/1', '渲染后的「foo bar」跨了 <strong>');
  assert.equal(env.registry.get('find').size, 1);
  const [previewButton, sourceButton] = byClass(box, 'pmode')[0].find(n => n.tagName === 'BUTTON');
  sourceButton.dispatch('click');
  assert.equal(preview.findOpen, true, '切到源码：查找条还开着');
  assert.equal(field.value, 'foo bar');
  assert.equal(count(), '0', '源码里是「**foo** bar」：同一个词，重新找');
  field.value = 'foo';
  field.dispatch('input');
  t.mock.timers.tick(150);
  assert.equal(count(), '1/2');
  previewButton.dispatch('click');
  assert.equal(preview.findOpen, true);
  assert.equal(count(), '1/2', '切回预览：同一个词重新找，两处 foo');
  assert.equal(byClass(box, 'md').length, 1);
});

test('预览：后台刷新换了正文，查找条保持，重新找，不滚动', async t => {
  await withDom(t);
  installHighlights(t);
  const box = new Element('div'), source = { text: MD, mtime: 100 };
  const preview = mountPreview(box, { read: readOf(source), copy: () => {} });
  await preview.open('README.md');
  await flush();
  preview.openFind();
  const field = byClass(box, 'finput')[0], count = () => byClass(box, 'fcount')[0].textContent;
  field.value = 'foo';
  field.dispatch('input');
  t.mock.timers.tick(150);
  assert.equal(count(), '1/2');
  const body = byClass(box, 'pbody')[0];
  body.scrollTop = 77;
  Object.assign(source, { text: `${MD}\nfoo foo\n`, mtime: 200 });
  await preview.refresh();
  await flush();
  assert.equal(count(), '1/4', '新正文里重新找');
  assert.equal(body.scrollTop, 77, '后台刷新不滚动');
  assert.equal(preview.findOpen, true);
});

test('预览：富文本里有超长行时不注册 Highlight，只计数、导航；没有时照常注册', async t => {
  await withDom(t);
  const env = installHighlights(t), box = new Element('div');
  const body = { text: `# 标题\n\n\`\`\`\n${'x'.repeat(6000)} needle\n\`\`\`\n\nneedle\n`, mtime: 100 };
  const preview = mountPreview(box, { read: readOf(body), copy: () => {} });
  await preview.open('README.md');
  await flush();
  preview.openFind();
  const field = byClass(box, 'finput')[0], count = () => byClass(box, 'fcount')[0].textContent;
  field.value = 'needle';
  field.dispatch('input');
  t.mock.timers.tick(150);
  assert.equal(count(), '1/2');
  assert.equal(env.registry.size, 0, '有长行：不注册');
  preview.find.next();
  assert.equal(count(), '2/2');
  Object.assign(body, { text: '# 标题\n\nneedle\n', mtime: 200 });
  await preview.refresh();
  await flush();
  assert.equal(count(), '1/1');
  assert.equal(env.registry.get('find').size, 1, '没有长行：照常注册');
});
