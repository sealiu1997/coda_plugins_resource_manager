// Mac 的打开方式在图标视图里（第 15.10 节）：单击选中、双击进入或打开、空白、右键、键盘；选中的状态规则（进入清空、回上一层选中来时的文件夹）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { pick } from './support/more.mjs';
import { cellNamed, cellNames, cmd, doubleClick, drain, gridBody, gridHead, press, savedOf, selectedCells, startGrid, clickOn } from './support/finder.mjs';

const reads = host => host.sent.filter(m => m.type === 'read');
const labels = page => page.menu.find(node => node.tagName === 'BUTTON').map(node => node.textContent);
const dblclick = (page, name) => doubleClick(gridBody(page), cellNamed(page, name));
const enter = async (page, ...names) => { for (const name of names) await dblclick(page, name); };
const back = async page => { gridHead(page).children[0].dispatch('click'); await flush(); };

test('单击只选中：文件夹、文件、不能打开的条目都不进入、不打开', async t => {
  const { page, host } = await startGrid(t);
  for (const name of ['dir', 'f1.txt', 'to']) {
    clickOn(cellNamed(page, name));
    await flush();
    assert.deepEqual(selectedCells(page), [name]);
    assert.equal(visible(page.grid), true);
    assert.equal(reads(host).length, 0);
  }
  assert.deepEqual(host.lists().map(m => m.path), [''], '没有进入任何目录');
});

test('双击文件夹进入这一层，双击文件在侧栏打开，双击不能打开的条目没反应；各恰好一次', async t => {
  const { page, host } = await startGrid(t);
  await dblclick(page, 'to');
  assert.equal(visible(page.grid), true);
  assert.deepEqual(host.lists().map(m => m.path), ['']);
  await dblclick(page, 'f1.txt');
  assert.equal(reads(host).length, 1);
  assert.equal(visible(page.preview), true);
  assert.equal(host.calls.open.length, 0);
});

test('双击文件夹：进入恰好一次，选中清空', async t => {
  const ctx = await startGrid(t);
  const { page, host } = ctx;
  clickOn(cellNamed(page, 'f1.txt'));
  await dblclick(page, 'dir');
  assert.deepEqual(cellNames(page), ['inner', 'x.txt', 'y.txt']);
  assert.equal(host.lists().filter(m => m.path === 'dir').length, 1);
  assert.deepEqual(selectedCells(page), [], '进入后选中清空');
  await drain(ctx);
  assert.equal(savedOf(ctx).selected, null);
});

test('选中不重画：节点身份不变；单击空白取消选中；头部的返回键不算空白', async t => {
  const { page } = await startGrid(t);
  const a = cellNamed(page, 'f1.txt'), b = cellNamed(page, 'f2.txt');
  clickOn(a);
  await flush();
  assert.equal(cellNamed(page, 'f1.txt'), a);
  clickOn(b);
  await flush();
  assert.deepEqual([a.classList.contains('sel'), b.classList.contains('sel')], [false, true]);
  clickOn(gridBody(page));
  assert.deepEqual(selectedCells(page), []);
  clickOn(b);
  await enter(page, 'dir');
  clickOn(cellNamed(page, 'x.txt'));
  await back(page);
  assert.deepEqual(selectedCells(page), ['dir'], '点头部的返回不会再取消选中');
});

test('右键：不改选中，菜单第一项是「打开」，不能打开的条目没有；「打开」进入文件夹或打开文件', async t => {
  const { page, host } = await startGrid(t);
  clickOn(cellNamed(page, 'f2.txt'));
  const right = name => cellNamed(page, name).dispatch('contextmenu', { clientX: 5, clientY: 6 });
  right('to');
  assert.equal(labels(page).includes('打开'), false);
  right('dir');
  assert.deepEqual(selectedCells(page), ['f2.txt']);
  assert.equal(labels(page)[0], '打开');
  page.menu.find(node => node.tagName === 'BUTTON')[0].dispatch('click');
  await flush();
  assert.deepEqual(cellNames(page), ['inner', 'x.txt', 'y.txt']);
  cellNamed(page, 'x.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  page.menu.find(node => node.tagName === 'BUTTON')[0].dispatch('click');
  await flush();
  assert.equal(reads(host)[0]?.path, 'dir/x.txt');
});

test('iPhone：轻点照旧进入，dblclick 不触发任何东西', async t => {
  const { page, host } = await startGrid(t, { platform: 'ios' });
  cellNamed(page, 'f1.txt').dispatch('dblclick');
  await flush();
  assert.equal(host.calls.open.length, 0);
  clickOn(cellNamed(page, 'dir'));
  await flush();
  assert.deepEqual(cellNames(page), ['inner', 'x.txt', 'y.txt']);
  cellNamed(page, 'x.txt').dispatch('dblclick');
  await flush();
  assert.equal(host.calls.open.length, 0);
});

// ---- 键盘 ----

test('图标：↑ ↓ 走同一列，末行不满时 ↓ 落在最后一个；← → 在条目之间走；没有选中时 ↓ 选第一个、↑ 选最后一个', async t => {
  const { page } = await startGrid(t);
  const body = gridBody(page); // 7 个条目，3 列：[dir f1 f2][f3 f4 f5][to]
  assert.equal(press(body, 'ArrowDown').prevented, true);
  assert.deepEqual(selectedCells(page), ['dir']);
  press(body, 'ArrowDown');
  assert.deepEqual(selectedCells(page), ['f3.txt']);
  press(body, 'ArrowDown');
  assert.deepEqual(selectedCells(page), ['to'], '末行不满，没有这一列：选那一行的最后一个');
  press(body, 'ArrowDown');
  assert.deepEqual(selectedCells(page), ['to'], '到底不动');
  press(body, 'ArrowUp');
  assert.deepEqual(selectedCells(page), ['f3.txt'], '同一列（第 0 列）');
  press(body, 'ArrowUp');
  assert.deepEqual(selectedCells(page), ['dir']);
  press(body, 'ArrowRight');
  assert.deepEqual(selectedCells(page), ['f1.txt']);
  press(body, 'ArrowRight');
  press(body, 'ArrowRight');
  assert.deepEqual(selectedCells(page), ['f3.txt'], '行尾接下一行');
  press(body, 'ArrowLeft');
  assert.deepEqual(selectedCells(page), ['f2.txt']);
  clickOn(body);
  press(body, 'ArrowUp');
  assert.deepEqual(selectedCells(page), ['to']);
});

test('图标：⌘↓ 进入文件夹或打开文件（同双击）；⌘↑ 回上一层并选中来时的文件夹，在根目录什么都不做', async t => {
  const { page, host } = await startGrid(t);
  const body = gridBody(page);
  assert.equal(press(body, 'ArrowUp', cmd).prevented, true, '根目录：匹配、拦下，什么都不做');
  assert.deepEqual(cellNames(page).slice(0, 2), ['dir', 'f1.txt']);
  press(body, 'ArrowDown');
  press(body, 'ArrowDown', cmd);
  await flush();
  assert.deepEqual(cellNames(page), ['inner', 'x.txt', 'y.txt']);
  assert.deepEqual(selectedCells(page), []);
  press(body, 'ArrowDown');
  press(body, 'ArrowRight');
  press(body, 'ArrowDown', cmd);
  await flush();
  assert.equal(reads(host)[0].path, 'dir/x.txt', '⌘↓ 打开文件');
  press(page.preview, 'ArrowUp', cmd); // 预览里 ⌘↑ 回到图标视图，选中还是 x.txt
  await flush();
  assert.deepEqual(selectedCells(page), ['x.txt']);
  assert.equal(document.activeElement, body, '焦点回到图标视图的滚动容器');
  press(body, 'ArrowUp', cmd);
  await flush();
  assert.deepEqual(cellNames(page).slice(0, 2), ['dir', 'f1.txt'], '回到根目录');
  assert.deepEqual(selectedCells(page), ['dir'], '选中来时的文件夹');
});

test('图标：键盘移动选中时滚到能看见，只滚最少的距离', async t => {
  const names = Array.from({ length: 30 }, (_, i) => `n${String(i).padStart(2, '0')}.txt`);
  const { page } = await startGrid(t, { listing: { '': names } }); // 30 个，3 列：10 行；视口 5 行
  const body = gridBody(page);
  press(body, 'ArrowDown'); // n00
  for (let i = 0; i < 4; i++) press(body, 'ArrowDown');
  assert.equal(body.scrollTop, 0, '第 5 行还看得见');
  press(body, 'ArrowDown');
  assert.equal(body.scrollTop, ROW_H, '第 6 行：滚一行');
  assert.deepEqual(selectedCells(page), ['n15.txt']);
  body.scrollTop = ROW_H * 5;
  press(body, 'ArrowUp'); // 选中 n12，第 4 行（序号 4）在视口上方（视口从第 5 行起）
  assert.equal(body.scrollTop, ROW_H * 4);
});
const ROW_H = 24;

// ---- 状态：进入、回上一层 ----

test('回上一层：头部返回、⌘↑ 选中来时的文件夹；连续进入几层再一层层退', async t => {
  const ctx = await startGrid(t);
  const { page } = ctx;
  await enter(page, 'dir', 'inner');
  assert.deepEqual(selectedCells(page), []);
  await back(page);
  assert.deepEqual(selectedCells(page), ['inner'], 'dir 里选中 inner');
  await back(page);
  assert.deepEqual(selectedCells(page), ['dir']);
  await drain(ctx);
  assert.equal(savedOf(ctx).selected, 'dir', '回上一层也保存');
});

test('iPhone 原生返回 steps 大于 1：选的是退到那一层的直接子项（a/b/c 退到 a 选 a/b）', async t => {
  const { page, host } = await startGrid(t, { platform: 'ios', back: true });
  const tap = async name => { clickOn(cellNamed(page, name)); await flush(); };
  await tap('dir');
  await tap('inner');
  await tap('z');
  host.events.back({ steps: 2 });
  await flush();
  assert.deepEqual(cellNames(page), ['inner', 'x.txt', 'y.txt'], '退到 dir');
  assert.deepEqual(selectedCells(page), ['inner'], '选 dir/inner');
  host.events.back({ steps: 1 });
  await flush();
  assert.deepEqual(selectedCells(page), ['dir']);
});

test('和属性页叠加：steps 为 2 先关属性页再退一层，选中退到那一层里来时的文件夹', async t => {
  const { page, host } = await startGrid(t, { platform: 'ios', back: true });
  const tap = async name => { clickOn(cellNamed(page, name)); await flush(); };
  await tap('dir');
  await tap('inner');
  cellNamed(page, 'deep.txt').dispatch('contextmenu', { clientX: 1, clientY: 1 });
  page.menu.find(node => node.tagName === 'BUTTON').at(-1).dispatch('click');
  await flush();
  assert.equal(visible(page.info), true);
  host.events.back({ steps: 2 });
  await flush();
  assert.equal(visible(page.info), false);
  assert.deepEqual(cellNames(page), ['inner', 'x.txt', 'y.txt'], '退到 dir');
  assert.deepEqual(selectedCells(page), ['inner']);
  host.events.back({ steps: 1 });
  await flush();
  assert.deepEqual(selectedCells(page), ['dir']);
});

test('当前目录被删：模型自己退回上一层时不改选中', async t => {
  const ctx = await startGrid(t);
  const { page, host } = ctx;
  await enter(page, 'dir');
  clickOn(cellNamed(page, 'x.txt'));
  host.missing.add('dir');
  host.changed();
  await flush();
  assert.deepEqual(cellNames(page).slice(0, 2), ['dir', 'f1.txt'], '退回根目录');
  assert.deepEqual(selectedCells(page), [], '选中的是 dir/x.txt，根目录里没有它');
  await drain(ctx);
  assert.equal(savedOf(ctx).selected, 'dir/x.txt', '路径留着，没被清');
});

test('换排序、显示隐藏文件、切换视图：选中不变', async t => {
  const ctx = await startGrid(t);
  const { page, host } = ctx;
  clickOn(cellNamed(page, 'f2.txt'));
  const choose = async label => { host.events.toolbar({ id: 'more' }); pick(page, label); await flush(); };
  await choose('日期');
  assert.deepEqual(selectedCells(page), ['f2.txt'], '换排序');
  await choose('显示隐藏文件');
  assert.deepEqual(selectedCells(page), ['f2.txt'], '显示隐藏文件');
  await choose('列表');
  const rows = page.tree.find(node => node.classList.contains('row') && node.classList.contains('sel'));
  assert.equal(rows.length, 1, '切到列表：同一个文件还是选中的');
  assert.match(rows[0].textContent, /f2\.txt/);
  await drain(ctx);
  assert.equal(savedOf(ctx).selected, 'f2.txt');
});

test('连续几级上层都被删：模型逐级退回根目录，选中不变', async t => {
  const ctx = await startGrid(t);
  const { page, host } = ctx;
  await enter(page, 'dir', 'inner', 'z');
  clickOn(cellNamed(page, 'q.txt'));
  for (const path of ['dir', 'dir/inner', 'dir/inner/z']) host.missing.add(path);
  host.changed();
  await flush();
  assert.deepEqual(cellNames(page).slice(0, 2), ['dir', 'f1.txt'], '退回根目录');
  await drain(ctx);
  assert.equal(savedOf(ctx).selected, 'dir/inner/z/q.txt');
});
