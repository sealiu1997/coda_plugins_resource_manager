// 文件内查找的纯部分（view/find.mjs）：匹配、文本节点表、Range 定位（双指针和逐个查找一致）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { FIND_MAX, buildIndex, findMatches, rangeAt, rangesFor } from '../view/find.mjs';
import { Element } from './support/dom.mjs';
import { installHighlights } from './support/highlights.mjs';

test('空词：没有匹配，不建正则', () => {
  assert.deepEqual(findMatches('abc', ''), { list: [], more: false });
});

test('不分大小写，下标是 UTF-16 下标：emoji 占两个单元，中文、希腊字母、变小写会变的字符都对得上原文', () => {
  assert.deepEqual(findMatches('a😀B😀b', 'b').list, [[3, 4], [6, 7]]);
  assert.deepEqual(findMatches('a😀B😀b', '😀').list, [[1, 3], [4, 6]]);
  assert.deepEqual(findMatches('中文 αβγ ΑΒΓ', 'αβγ').list, [[3, 6], [7, 10]]);
  const text = 'x İ y ß z';
  for (const term of ['İ', 'ß']) {
    const [[start, end]] = findMatches(text, term).list;
    assert.equal(text.slice(start, end), term, '下标直接取自原文，不经 toLowerCase 换算');
  }
});

test('正则的特殊字符按字面找；不重叠；每处长度不为 0', () => {
  assert.deepEqual(findMatches('a.b a*b (a)', '.').list, [[1, 2]]);
  assert.deepEqual(findMatches('(a)[b]\\', '(a)').list, [[0, 3]]);
  assert.deepEqual(findMatches('aaaa', 'aa').list, [[0, 2], [2, 4]], '不重叠');
  assert.ok(findMatches('x y  z', ' ').list.every(([s, e]) => e > s));
});

test('10000 处上限：找到第 10001 处就是 more，只保留前 10000 处；正好 10000 处不是 more', () => {
  const exact = findMatches('a'.repeat(FIND_MAX), 'a'), over = findMatches('a'.repeat(FIND_MAX + 1), 'a');
  assert.deepEqual([exact.list.length, exact.more], [FIND_MAX, false]);
  assert.deepEqual([over.list.length, over.more], [FIND_MAX, true]);
});

// 假的正文：<pre> 里是 span 嵌套，文本节点各自的起点不同。
function body(...parts) {
  const root = new Element('pre');
  const build = (parent, items) => { for (const item of items) { if (typeof item === 'string') parent.append(item); else { const span = new Element('span'); build(span, item); parent.append(span); } } };
  build(root, parts);
  return root;
}

test('文本节点表：每个节点的累计起点；空文本节点不进表；嵌套的 span 照常走', () => {
  const root = body('ab', ['cd', ['ef']], '', 'gh');
  const { nodes, length } = buildIndex(root);
  assert.deepEqual(nodes.map(n => [n.start, n.end]), [[0, 2], [2, 4], [4, 6], [6, 8]]);
  assert.equal(length, 8);
});

test('跨 span 的匹配：Range 的起点终点落在各自的文本节点里；双指针定位和逐个二分定位的结果一致', t => {
  const env = installHighlights(t), { makeRange } = env;
  const root = body('const x = ', ['"he', ['llo'], ' wor'], 'ld";\n', ['// hello'], '\nhello');
  const index = buildIndex(root), full = root.textContent;
  const { list } = findMatches(full, 'hello wor');
  assert.equal(list.length, 1);
  const [range] = rangesFor(index, list, 0, 1, makeRange);
  assert.deepEqual(env.spanOf(range, root), list[0]);
  assert.notEqual(range.startNode, range.endNode, '跨了节点');
  // 很多匹配：批量和逐个一致
  const many = findMatches(full, 'l').list;
  const batch = rangesFor(index, many, 0, many.length, makeRange);
  batch.forEach((r, i) => {
    assert.deepEqual(env.spanOf(r, root), many[i]);
    const single = rangeAt(index, many[i], makeRange);
    assert.deepEqual([single.startNode, single.startOffset, single.endNode, single.endOffset], [r.startNode, r.startOffset, r.endNode, r.endOffset]);
  });
  // 从中间一批开始（分批时每批的起点不是 0）
  const tail = rangesFor(index, many, 3, many.length, makeRange);
  tail.forEach((r, i) => assert.deepEqual(env.spanOf(r, root), many[3 + i]));
});

test('终点正好落在节点边界：Range 的终点在前一个节点的末尾，不跑到下一个节点开头', t => {
  const { makeRange } = installHighlights(t);
  const root = body('ab', ['cd']);
  const index = buildIndex(root), list = [[1, 2]];
  const [range] = rangesFor(index, list, 0, 1, makeRange);
  assert.equal(range.endOffset, 2);
  assert.equal(range.endNode, index.nodes[0].node);
});
