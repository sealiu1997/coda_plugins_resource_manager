// Mac 的键盘（第 15.10 节）：浏览区的 ↑ ↓ ← → ⌘↓ ⌘↑、侧栏预览的 ⌘↑、焦点交接、和滚动恢复。
import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutOf, stepCells } from '../view/grid.mjs';
import { browseAction, previewAction } from '../view/keys.mjs';
import { stepRows } from '../view/tree.mjs';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { cmd, drain, press, rowNamed, savedOf, selectedCells, selectedRows, startMac, clickOn } from './support/finder.mjs';

const ev = (key, extra = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
const reads = host => host.sent.filter(m => m.type === 'read');
const entry = (path, extra = {}) => ({ type: 'entry', path, kind: 'file', ...extra });
const dir = (path, open = false) => entry(path, { kind: 'dir', open });
const note = { type: 'status', path: '', text: '空目录' };

// ---- 按键匹配 ----

test('按键：只认最小的一组，带其他修饰键、Return、空格、⌘→ 都不匹配', () => {
  assert.deepEqual(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map(key => browseAction(ev(key))), ['up', 'down', 'left', 'right']);
  assert.equal(browseAction(ev('ArrowDown', { metaKey: true })), 'open');
  assert.equal(browseAction(ev('ArrowUp', { metaKey: true })), 'parent');
  for (const extra of [{ altKey: true }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true, shiftKey: true }, { metaKey: true, altKey: true }, { isComposing: true }]) {
    assert.equal(browseAction(ev('ArrowDown', extra)), null, JSON.stringify(extra));
  }
  for (const key of ['Enter', ' ', 'a', 'Tab']) assert.equal(browseAction(ev(key)), null, key);
  assert.equal(browseAction(ev('ArrowLeft', { metaKey: true })), null);
  assert.equal(browseAction(ev('ArrowRight', { metaKey: true })), null);
  assert.equal(previewAction(ev('ArrowUp', { metaKey: true })), 'back');
  assert.equal(previewAction(ev('ArrowUp')), null);
  assert.equal(previewAction(ev('ArrowDown', { metaKey: true })), null);
  assert.equal(previewAction(ev('ArrowUp', { metaKey: true, shiftKey: true })), null);
});

// ---- 纯逻辑：列表 ----

test('stepRows：没有选中 ↓ 选第一个、↑ 选最后一个，说明行和「再显示」跳过', () => {
  const rows = [note, entry('a'), { type: 'more', path: '' }, entry('b'), note];
  assert.deepEqual(stepRows(rows, null, 'down'), { select: 1 });
  assert.deepEqual(stepRows(rows, null, 'up'), { select: 3 });
  assert.deepEqual(stepRows(rows, 'a', 'down'), { select: 3 }, '跳过「再显示」');
  assert.deepEqual(stepRows(rows, 'b', 'up'), { select: 1 });
  assert.equal(stepRows(rows, 'b', 'down'), null, '到底不动');
  assert.equal(stepRows(rows, 'a', 'up'), null);
  assert.deepEqual(stepRows(rows, 'gone', 'down'), { select: 1 }, '选中的不在了：按没有选中算');
  assert.equal(stepRows([note], null, 'down'), null);
});

test('stepRows：→ 展开选中的文件夹；← 收起，已收起或是文件就选中所在文件夹，根目录下的什么都不做', () => {
  const rows = [dir('d', true), entry('d/f'), dir('d/s'), entry('z')];
  assert.equal(stepRows(rows, 'z', 'right'), null);
  assert.deepEqual(stepRows(rows, 'd/s', 'right'), { toggle: 2 });
  assert.equal(stepRows(rows, 'd', 'right'), null, '已展开：不动');
  assert.deepEqual(stepRows(rows, 'd', 'left'), { toggle: 0 }, '先收起');
  assert.deepEqual(stepRows(rows, 'd/s', 'left'), { select: 0 }, '已收起：选所在文件夹');
  assert.deepEqual(stepRows(rows, 'd/f', 'left'), { select: 0 }, '文件：选所在文件夹');
  assert.equal(stepRows(rows, 'z', 'left'), null, '根目录下没有上一层');
  assert.equal(stepRows(rows, null, 'left'), null);
});

// ---- 纯逻辑：图标 ----

const cellsOf = (n, notes = {}) => {
  const cells = [];
  for (let i = 0; i < n; i++) { if (notes[i]) cells.push({ type: 'status', path: '', text: '读取失败' }); cells.push(entry(`f${i}`)); }
  return cells;
};

test('stepCells：↑↓ 走同一列，目标行不满时选那一行的最后一个，说明项独占的行跳过', () => {
  const cells = [...cellsOf(7)]; // 3 列：[0 1 2][3 4 5][6]
  const layout = layoutOf(cells, 3);
  assert.deepEqual(stepCells(cells, layout, 'f1', 'down'), { select: 4 });
  assert.deepEqual(stepCells(cells, layout, 'f4', 'down'), { select: 6 }, '末行不满：选最后一个');
  assert.deepEqual(stepCells(cells, layout, 'f5', 'down'), { select: 6 });
  assert.deepEqual(stepCells(cells, layout, 'f6', 'up'), { select: 3 });
  assert.equal(stepCells(cells, layout, 'f6', 'down'), null);
  assert.equal(stepCells(cells, layout, 'f1', 'up'), null);
  assert.deepEqual(stepCells(cells, layout, 'f1', 'left'), { select: 0 });
  assert.deepEqual(stepCells(cells, layout, 'f2', 'right'), { select: 3 }, '行尾接下一行');
  assert.equal(stepCells(cells, layout, 'f0', 'left'), null);
  assert.equal(stepCells(cells, layout, 'f6', 'right'), null);
  const withNote = [...cellsOf(3), note, ...cellsOf(4).map(cell => ({ ...cell, path: `g${cell.path}` }))]; // [0 1 2][说明][g0 g1 g2][g3]
  const noteLayout = layoutOf(withNote, 3);
  assert.deepEqual(stepCells(withNote, noteLayout, 'f1', 'down'), { select: 5 }, '跳过说明行落在下一段同一列');
  assert.deepEqual(stepCells(withNote, noteLayout, 'gf1', 'up'), { select: 1 });
  assert.equal(stepCells(withNote, noteLayout, 'f2', 'right'), null, '右边是说明项，不选');
});

test('stepCells：没有选中 ↓ 选第一个条目、↑ 选最后一个；选中的不在了按没有选中算', () => {
  const cells = [note, ...cellsOf(4)];
  const layout = layoutOf(cells, 3);
  assert.deepEqual(stepCells(cells, layout, null, 'down'), { select: 1 });
  assert.deepEqual(stepCells(cells, layout, null, 'up'), { select: 4 });
  assert.deepEqual(stepCells(cells, layout, 'gone', 'up'), { select: 4 });
  assert.equal(stepCells(cells, layout, null, 'left'), null);
  assert.equal(stepCells([note], layoutOf([note], 3), null, 'down'), null);
});

// ---- 列表页 ----

test('列表：↓ ↑ 移动选中（没有选中时从两端开始），匹配的键同步 preventDefault', async t => {
  const ctx = await startMac(t);
  const { page } = ctx;
  const down = press(page.tree, 'ArrowDown');
  assert.equal(down.prevented, true);
  assert.deepEqual(selectedRows(page), ['dir']);
  press(page.tree, 'ArrowDown');
  assert.deepEqual(selectedRows(page), ['a.txt']);
  press(page.tree, 'ArrowUp');
  assert.deepEqual(selectedRows(page), ['dir']);
  clickOn(page.tree); // 取消选中
  press(page.tree, 'ArrowUp');
  assert.deepEqual(selectedRows(page), ['dev'], '没有选中 ↑ 选最后一个');
  press(page.tree, 'ArrowDown');
  assert.deepEqual(selectedRows(page), ['dev'], '到底不动');
});

test('列表：→ 展开、← 收起、再 ← 选中所在文件夹；根目录下的条目 ← 什么都不做', async t => {
  const ctx = await startMac(t);
  const { page } = ctx;
  press(page.tree, 'ArrowDown');
  press(page.tree, 'ArrowRight');
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(selectedRows(page), ['dir'], '展开不改选中');
  press(page.tree, 'ArrowDown');
  assert.deepEqual(selectedRows(page), ['x.txt']);
  press(page.tree, 'ArrowLeft');
  assert.deepEqual(selectedRows(page), ['dir'], '文件：选所在文件夹，父项不需要先画出来');
  press(page.tree, 'ArrowLeft');
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'false');
  press(page.tree, 'ArrowDown');
  press(page.tree, 'ArrowLeft');
  assert.deepEqual(selectedRows(page), ['a.txt']);
});

test('列表：⌘↓ 和双击一样（文件打开、文件夹展开）；⌘↑ 在列表里不绑定、不拦', async t => {
  const ctx = await startMac(t);
  const { page, host } = ctx;
  press(page.tree, 'ArrowDown');
  const open = press(page.tree, 'ArrowDown', cmd);
  assert.equal(open.prevented, true);
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true');
  press(page.tree, 'ArrowDown');
  press(page.tree, 'ArrowDown');
  press(page.tree, 'ArrowDown');
  assert.deepEqual(selectedRows(page), ['a.txt']);
  press(page.tree, 'ArrowDown', cmd);
  await flush();
  assert.equal(reads(host)[0].path, 'a.txt');
  assert.equal(visible(page.preview), true);
  const none = await startMac(t);
  assert.equal(press(none.page.tree, 'ArrowUp', cmd).prevented, false, '列表的 ⌘↑ 不拦');
  press(none.page.tree, 'ArrowDown', cmd);
  await flush();
  assert.equal(reads(none.host).length, 0, '没有选中的 ⌘↓ 什么都不做');
});

test('不匹配的键不拦：其他修饰键组合、Return、空格、⌘→；选中的不在了按没有选中算', async t => {
  const { page } = await startMac(t);
  for (const [key, extra] of [['ArrowDown', { altKey: true }], ['ArrowDown', { shiftKey: true }], ['ArrowUp', { ctrlKey: true }], ['Enter', {}], [' ', {}], ['ArrowRight', cmd], ['ArrowUp', { metaKey: true, shiftKey: true }]]) {
    assert.equal(press(page.tree, key, extra).prevented, false, `${key} ${JSON.stringify(extra)}`);
  }
  assert.deepEqual(selectedRows(page), []);
});

test('菜单开着时浏览区不处理按键，也不拦', async t => {
  const { page } = await startMac(t);
  rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.ok(visible(page.menu));
  const result = press(page.tree, 'ArrowDown');
  assert.equal(result.prevented, false);
  assert.deepEqual(selectedRows(page), []);
});

test('选中的条目被删或被藏起来：路径留着没有高亮，键盘移动按没有选中算', async t => {
  const state = { v: 1, seq: 1, hidden: false, sessions: { s1: { at: 1, expanded: [], selected: 'gone.txt', scroll: { tree: 0, top: 0, left: 0 } } } };
  const ctx = await startMac(t, { state });
  assert.deepEqual(selectedRows(ctx.page), []);
  press(ctx.page.tree, 'ArrowDown');
  assert.deepEqual(selectedRows(ctx.page), ['dir']);
});

test('滚到能看见：↓ 到可见范围外，选中行滚进视口，只滚最少的距离；按行号算，不找节点', async t => {
  const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  const ctx = await startMac(t, { listing: { '': names } });
  const { page } = ctx;
  page.tree.clientHeight = 24 * 5;
  for (let i = 0; i < 5; i++) press(page.tree, 'ArrowDown');
  assert.equal(page.tree.scrollTop, 0, '第 5 项（序号 4）还看得见');
  press(page.tree, 'ArrowDown'); // 序号 5：底边 144 > 120
  assert.equal(page.tree.scrollTop, 24);
  for (let i = 0; i < 20; i++) press(page.tree, 'ArrowDown');
  assert.equal(page.tree.scrollTop, 24 * 26 - 24 * 5, '序号 25：底边对齐视口底部');
  assert.deepEqual(selectedRows(page), ['f25.txt']);
  page.tree.scrollTop = 24 * 30;
  press(page.tree, 'ArrowUp'); // 序号 24 在视口上方
  assert.equal(page.tree.scrollTop, 24 * 24);
  assert.deepEqual(selectedRows(page), ['f24.txt'], '滚过去之后新画的行带着 .sel');
});

test('2 万条的目录里 ↓ 到可见范围外：按行号算位置，选中行在新画的一段里', async t => {
  const names = Array.from({ length: 20_000 }, (_, i) => `n${String(i).padStart(5, '0')}.txt`);
  const ctx = await startMac(t, { listing: { '': names } });
  const { page } = ctx;
  for (let i = 0; i < 300; i++) press(page.tree, 'ArrowDown');
  assert.deepEqual(selectedRows(page), ['n00299.txt']);
  assert.equal(page.tree.scrollTop, 24 * 300 - 24 * 5);
});

// ---- 预览：焦点和 ⌘↑ ----

async function previewing(t, options) {
  const ctx = await startMac(t, options);
  press(ctx.page.tree, 'ArrowDown');
  press(ctx.page.tree, 'ArrowDown'); // a.txt
  press(ctx.page.tree, 'ArrowDown', cmd);
  await flush();
  return ctx;
}

test('只用键盘：⌘↓ 打开文件，焦点交给预览面板；⌘↑ 返回，焦点回到浏览区，选中的仍是那个文件，tabIndex 不变', async t => {
  const { page } = await previewing(t);
  assert.equal(visible(page.preview), true);
  assert.equal(document.activeElement, page.preview, '焦点交给预览面板');
  const back = press(document.activeElement, 'ArrowUp', cmd);
  assert.equal(back.prevented, true);
  await flush();
  assert.equal(visible(page.tree), true);
  assert.equal(document.activeElement, page.tree, '焦点回到浏览区');
  assert.deepEqual(selectedRows(page), ['a.txt']);
  assert.equal(page.tree.tabIndex, 0);
});

test('后台恢复、换会话时打开的预览不交焦点', async t => {
  const state = { v: 1, seq: 1, hidden: false, sessions: { s1: { at: 1, expanded: [], selected: 'a.txt', opened: 'a.txt', scroll: { tree: 0, top: 0, left: 0 } } } };
  const ctx = await startMac(t, { state });
  assert.equal(visible(ctx.page.preview), true);
  assert.equal(document.activeElement ?? null, null, '恢复出来的预览不抢焦点');
});

test('预览里 ⌘↑：焦点在正文（点正文或拖选文字）时返回，页面不滚', async t => {
  const { page } = await previewing(t);
  const body = page.preview.find(node => node.classList.contains('pbody'))[0];
  body.focus();
  assert.equal(press(body, 'ArrowUp', cmd).prevented, true, '焦点在正文：事件冒泡到面板');
  await flush();
  assert.equal(visible(page.tree), true);
});

test('预览里 ⌘↑：其他键不拦；菜单开着不返回也不拦；属性页开着不处理', async t => {
  const { page, host } = await previewing(t);
  assert.equal(press(page.preview, 'ArrowUp').prevented, false);
  assert.equal(press(page.preview, 'ArrowDown', cmd).prevented, false);
  host.events.toolbar({ id: 'more' });
  assert.ok(visible(page.menu));
  const withMenu = press(page.preview, 'ArrowUp', cmd);
  assert.equal(withMenu.prevented, false);
  assert.equal(visible(page.preview), true, '菜单开着不返回');
});

test('滚动恢复（对照）：没有按键时，目录到齐后恢复到保存的位置', async t => {
  const ctx = await restoring(t);
  await ctx.finish();
  assert.equal(ctx.page.tree.scrollTop, 24 * 20);
});

test('键盘作废还在等的滚动恢复：部分目录先到、按 ↓、剩余目录后到，位置不被拉走', async t => {
  const ctx = await restoring(t);
  press(ctx.page.tree, 'ArrowDown');
  assert.deepEqual(selectedRows(ctx.page), ['dir']);
  await ctx.finish();
  assert.equal(ctx.page.tree.scrollTop, 0, '恢复被作废');
  assert.deepEqual(selectedRows(ctx.page), ['dir'], '选中还在');
});

async function restoring(t) {
  const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  const state = { v: 1, seq: 1, hidden: false, sessions: { s1: { at: 1, expanded: ['dir'], selected: null, scroll: { tree: 24 * 20, top: 0, left: 0, sort: 'name' } } } };
  const ctx = await startMac(t, { listing: { '': ['dir/', ...names], dir: ['x.txt'] }, state, settle: false, prepare: host => host.held.add('dir') });
  await flush();
  assert.equal(ctx.host.heldLists.length, 1, '根目录到了，dir 还没到');
  ctx.finish = async () => {
    ctx.host.held.delete('dir');
    ctx.host.answer(ctx.host.heldLists[0], { entries: [{ name: 'x.txt', kind: 'file' }], nextCursor: null });
    await flush();
  };
  return ctx;
}

test('页面骨架：预览面板可以获得焦点（点正文时进面板），浏览区的可聚焦由页面按平台设置', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../view/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="preview"[^>]*tabindex="-1"/);
  assert.doesNotMatch(html, /<div id="tree"[^>]*tabindex/, 'iPhone 的树不加 tabindex，Mac 在 app.mjs 里设');
});
