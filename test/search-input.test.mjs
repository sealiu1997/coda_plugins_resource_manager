// 文件名搜索的键盘（第 18.5 节 Mac 的分派表，每格一条）、iPhone 的返回层级（第 18.5 节的表）、按下反馈的 search 身份。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { clickOn, cmd, press } from './support/finder.mjs';
import { box, found, hit, hitNamed, hitNames, searchShown, search, selectedHits, startPhone, startSearch, type } from './support/searchhost.mjs';
import { pick } from './support/more.mjs';
import { rowNamed } from './support/treehost.mjs';

const hitsEl = page => page.search.find(node => node.classList.contains('shits'))[0];
const active = () => document.activeElement;
const bare = {};
// document 上的按键（焦点不在任何控件上）：同浏览器，事件从 body 到 document。
const onPage = (key, modifiers = {}) => {
  let prevented = false;
  document.emit({ type: 'keydown', key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers, preventDefault() { prevented = true; }, target: null });
  return { get prevented() { return prevented; } };
};
const results = [hit('dir/x.txt'), hit('dir/y.txt'), hit('a.txt')];

// ---- Mac 键盘分派表 ----

test('浏览区（列表）：⌘F 聚焦搜索框并选中里面的字；Esc 不处理；↓ 照旧移动选中', async t => {
  const ctx = await startSearch(t);
  rowNamed(ctx.page, 'a.txt').dispatch('click');
  clickOn(rowNamed(ctx.page, 'a.txt'));
  const tree = ctx.page.tree;
  const esc = press(tree, 'Escape');
  assert.equal(esc.prevented, false, 'Esc 不处理');
  press(tree, 'ArrowDown');
  assert.deepEqual(ctx.page.tree.find(n => n.classList.contains('sel')).map(n => n.dataset.path), ['b.txt'], '↓ 同现在');
  const f = press(tree, 'f', cmd);
  assert.equal(f.prevented, true);
  assert.equal(active(), box(ctx.page));
  assert.equal(box(ctx.page).selected, true, '选中里面的字');
});

test('浏览区（图标视图）：⌘F 同样聚焦搜索框', async t => {
  const ctx = await startSearch(t, { state: { v: 1, seq: 1, hidden: false, view: 'icons', sessions: {} } });
  const body = ctx.page.grid.find(n => n.classList.contains('gbody'))[0];
  assert.equal(press(body, 'f', cmd).prevented, true);
  assert.equal(active(), box(ctx.page));
});

test('结果列表：⌘F 聚焦搜索框并选中；Esc 焦点回搜索框；↑↓ 移动；⌘↓ 打开；← → ⌘↑ 什么都不做，不改被遮住的目录视图', async t => {
  const ctx = await startSearch(t, { state: { v: 1, seq: 1, hidden: false, view: 'icons', sessions: { s1: { at: 1, expanded: [], selected: null, scroll: { tree: 0, top: 0, left: 0 }, cwd: 'dir', root: '/A' } } } });
  Object.assign(ctx.host, { autoRead: true });
  await search(ctx, 'x', results);
  const hits = hitsEl(ctx.page);
  hits.focus();
  press(hits, 'ArrowDown');
  assert.deepEqual(selectedHits(ctx.page), ['dir/x.txt']);
  press(hits, 'ArrowDown');
  assert.deepEqual(selectedHits(ctx.page), ['dir/y.txt']);
  press(hits, 'ArrowUp');
  assert.deepEqual(selectedHits(ctx.page), ['dir/x.txt']);
  for (const [key, modifiers] of [['ArrowLeft', bare], ['ArrowRight', bare], ['ArrowUp', cmd]]) {
    const result = press(hits, key, modifiers);
    assert.equal(result.prevented, true, `${key} 被结果列表吃掉`);
  }
  assert.deepEqual(selectedHits(ctx.page), ['dir/x.txt']);
  const cwd = ctx.page.grid.find(n => n.classList.contains('ghead'))[0]?.textContent ?? '';
  press(hits, 'ArrowUp', cmd);
  assert.equal(ctx.page.grid.find(n => n.classList.contains('ghead'))[0]?.textContent ?? '', cwd, '没有退出图标视图的目录');
  assert.equal(press(hits, 'f', cmd).prevented, true);
  assert.equal(active(), box(ctx.page));
  assert.equal(box(ctx.page).selected, true);
  hits.focus();
  press(hits, 'Escape');
  assert.equal(active(), box(ctx.page), 'Esc：焦点回搜索框');
  hits.focus();
  press(hits, 'ArrowDown', cmd);
  await flush();
  assert.equal(visible(ctx.page.preview), true, '⌘↓ 打开选中的');
});

test('页面本身（焦点不在任何控件上）：浏览区和结果里 ⌘F 聚焦搜索框；能查找的预览打开查找条；属性页、说明区不拦', async t => {
  const ctx = await startSearch(t);
  Object.assign(ctx.host, { autoRead: true });
  document.activeElement = null;
  assert.equal(onPage('f', cmd).prevented, true);
  assert.equal(active(), box(ctx.page));
  await search(ctx, 'x', results);
  document.activeElement = null;
  assert.equal(onPage('f', cmd).prevented, true, '结果里也是');
  // 预览盖着：第 1 步不拦
  hitNamed(ctx.page, 'dir/x.txt').dispatch('dblclick');
  await flush();
  assert.equal(visible(ctx.page.preview), true);
  document.activeElement = null;
  assert.equal(onPage('f', cmd).prevented, true, '能查找的文本：⌘F 打开查找条（第 18.6 节）');
  assert.equal(ctx.page.preview.find(node => node.classList.contains('fbar'))[0].hidden, false);
  assert.notEqual(active(), box(ctx.page), '不去聚焦被遮住的搜索框');
});

test('属性页：⌘F 不拦，不去聚焦被遮住的搜索框', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', results);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  ctx.page.menu.find(n => n.textContent === '属性')[0].dispatch('click');
  await flush();
  assert.equal(visible(ctx.page.info), true);
  document.activeElement = null;
  assert.equal(onPage('f', cmd).prevented, false);
  assert.equal(active(), null);
});

test('搜索框：⌘F 选中里面的字；Esc 有字清空并把焦点回列表，没字焦点回列表；↓ 有结果时焦点给结果并选中第一条，没有时不动', async t => {
  const ctx = await startSearch(t);
  const input = box(ctx.page);
  input.focus();
  assert.equal(press(input, 'ArrowDown').prevented, false, '没有结果：↓ 不动');
  assert.equal(active(), input);
  press(input, 'f', cmd);
  assert.equal(input.selected, true);
  await search(ctx, 'x', results);
  input.focus();
  assert.equal(press(input, 'ArrowDown').prevented, true);
  assert.equal(active(), hitsEl(ctx.page));
  assert.deepEqual(selectedHits(ctx.page), ['dir/x.txt'], '选中第一条');
  input.focus();
  press(input, 'Escape'); // 有字：清空，焦点回列表
  await flush();
  assert.equal(input.value, '');
  assert.equal(searchShown(ctx.page), false);
  assert.equal(active(), ctx.page.tree, '焦点回到目录树');
  input.focus();
  press(input, 'Escape'); // 没字：焦点回列表
  assert.equal(active(), ctx.page.tree);
});

test('菜单开着时：Esc 只关菜单（不清搜索）；⌘F 先关菜单再聚焦搜索框', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', results);
  const input = box(ctx.page);
  input.focus();
  hitNamed(ctx.page, 'dir/x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  assert.equal(visible(ctx.page.menu), true);
  press(input, 'Escape');
  assert.equal(visible(ctx.page.menu), false, 'Esc 关了菜单');
  assert.equal(input.value, 'x', '搜索词还在');
  assert.equal(searchShown(ctx.page), true);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  const hits = hitsEl(ctx.page);
  hits.focus();
  press(hits, 'Escape');
  assert.equal(visible(ctx.page.menu), false);
  assert.equal(active(), hits, '菜单先处理 Esc，焦点不跳到搜索框');
  hitNamed(ctx.page, 'dir/x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  press(hits, 'f', cmd);
  assert.equal(visible(ctx.page.menu), false);
  assert.equal(active(), input);
});

test('输入法组字中的按键一律不管', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', results);
  const input = box(ctx.page), hits = hitsEl(ctx.page);
  assert.equal(press(input, 'Escape', { isComposing: true }).prevented, false);
  assert.equal(input.value, 'x');
  assert.equal(press(input, 'ArrowDown', { isComposing: true }).prevented, false);
  hits.focus();
  assert.equal(press(hits, 'ArrowDown', { isComposing: true }).prevented, false);
  assert.equal(onPage('f', { ...cmd, isComposing: true }).prevented, false);
});

// ---- iPhone ----

test('iPhone：键盘的「搜索」键（回车）收起键盘；开始滚动结果时收起键盘', async t => {
  const ctx = await startPhone(t);
  await search(ctx, 'x', results);
  const input = box(ctx.page);
  input.focus();
  press(input, 'Enter');
  assert.notEqual(active(), input, '回车收起键盘');
  input.focus();
  hitsEl(ctx.page).dispatch('scroll');
  assert.notEqual(active(), input, '滚动结果收起键盘');
});

test('iPhone：不处理 Mac 的键盘（⌘F、Esc）', async t => {
  const ctx = await startPhone(t);
  document.activeElement = null;
  assert.equal(onPage('f', cmd).prevented, false);
  assert.equal(active(), null);
});

// ---- iPhone 返回层级（第 18.5 节的表）----

const declared = ctx => ctx.host.calls.back.at(-1) ?? []; // 没有声明过：和初始的空路径一样
const iconsRecord = { v: 1, seq: 1, hidden: false, view: 'icons', sessions: { s1: { at: 1, expanded: [], selected: null, scroll: { tree: 0, top: 0, left: 0 }, cwd: 'dir', root: '/A' } } };

test('返回层级：结果 → 声明的路径空，返回一次离开资源页（不是一级）', async t => {
  const ctx = await startPhone(t);
  await search(ctx, 'x', results);
  assert.deepEqual(declared(ctx), []);
  ctx.host.back(1);
  await flush();
  assert.equal(box(ctx.page).value, 'x', '搜索没有被返回消耗');
  assert.deepEqual(declared(ctx), [], '路径照旧，客户端自己退出页面');
});

test('返回层级：结果 → 预览：声明「搜索」，返回一次关预览回到结果', async t => {
  const ctx = await startPhone(t);
  Object.assign(ctx.host, { autoRead: true });
  await search(ctx, 'x', results);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('click');
  await flush();
  assert.deepEqual(declared(ctx), ['搜索']);
  ctx.host.back(1);
  await flush();
  assert.deepEqual(declared(ctx), []);
  assert.equal(visible(ctx.page.search), true);
  assert.deepEqual(hitNames(ctx.page), ['x.txt', 'y.txt', 'a.txt']);
  assert.deepEqual(selectedHits(ctx.page), ['dir/x.txt']);
});

test('返回层级：结果 → 属性页：声明「搜索」，返回一次关属性页回到结果；属性页的统计和搜索各占一个槽', async t => {
  const ctx = await startPhone(t);
  await search(ctx, 'x', results);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('pointerdown', { pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, clientX: 5, clientY: 5 });
  ctx.tick(500);
  ctx.page.menu.find(n => n.textContent === '属性')[0].dispatch('click');
  await flush();
  assert.deepEqual(declared(ctx), ['搜索']);
  ctx.host.back(1);
  await flush();
  assert.equal(visible(ctx.page.info), false);
  assert.equal(visible(ctx.page.search), true);
  assert.deepEqual(declared(ctx), []);
});

test('返回层级：搜索词留着、根目录不可用（说明区）→ 路径空，返回离开资源页', async t => {
  const ctx = await startPhone(t);
  await search(ctx, 'x', results);
  ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'gone', path: '/A' });
  await flush();
  assert.deepEqual(declared(ctx), []);
  assert.equal(box(ctx.page).value, 'x');
  ctx.host.back(1);
  await flush();
  assert.equal(box(ctx.page).value, 'x', '说明区没有消耗任何一级');
});

test('返回层级：一次退多级（steps 为 2）从结果打开的预览：只消耗预览这一级，搜索留着', async t => {
  const ctx = await startPhone(t);
  Object.assign(ctx.host, { autoRead: true });
  await search(ctx, 'x', results);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('click');
  await flush();
  ctx.host.back(2);
  await flush();
  assert.equal(visible(ctx.page.search), true);
  assert.equal(box(ctx.page).value, 'x');
  assert.deepEqual(declared(ctx), []);
});

test('返回层级：搜索模式下图标视图的目录层级不声明，也不被返回消耗', async t => {
  const ctx = await startPhone(t, { state: iconsRecord });
  assert.deepEqual(declared(ctx), ['A'], '浏览图标视图的 dir：声明根目录名');
  await search(ctx, 'x', results);
  assert.deepEqual(declared(ctx), [], '搜索盖住了它们：不声明');
  ctx.host.back(2);
  await flush();
  assert.equal(box(ctx.page).value, 'x');
  // 清空搜索后图标视图还在 dir，层级回来
  type(ctx.page, '');
  await flush();
  assert.deepEqual(declared(ctx), ['A']);
});

test('返回层级：结果 → 预览，退场还没结束又收到返回：上一个过渡结束到终点，再按当时声明的路径处理', async t => {
  const ctx = await startPhone(t, { motion: { reduce: false } });
  Object.assign(ctx.host, { autoRead: true });
  await search(ctx, 'x', results);
  hitNamed(ctx.page, 'dir/x.txt').dispatch('click');
  await flush();
  ctx.host.back(1);
  await flush();
  ctx.host.back(1); // 退场没结束
  await flush();
  assert.equal(ctx.page.motion.animations.filter(anim => !anim.finished && !anim.canceled).length <= 2, true);
  assert.equal(visible(ctx.page.search), true);
  assert.equal(box(ctx.page).value, 'x');
});

// ---- 按下反馈的 search 身份 ----

test('按下反馈：结果行有自己的身份 search，和目录树里同路径的行不是同一个按下；重画后仍亮', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'a', [hit('a.txt'), hit('dir/x.txt')]);
  const row = hitNamed(ctx.page, 'a.txt');
  assert.ok(row.classList.contains('hit'));
  row.dispatch('pointerdown', { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 });
  assert.equal(row.classList.contains('pressed'), true);
  // 状态变了重画（搜索状态行换了）：同一个按下，新节点仍带 .pressed
  ctx.host.changed();
  await flush();
  assert.equal(hitNamed(ctx.page, 'a.txt').classList.contains('pressed'), true);
  // 目录树里同一路径的行没有被标
  assert.equal(ctx.page.tree.find(node => node.classList.contains('pressed')).length, 0);
  row.dispatch('pointerup', { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 });
  ctx.tick(100);
  assert.equal(hitNamed(ctx.page, 'a.txt').classList.contains('pressed'), false);
});

test('按下反馈：先在目录树按下 a.txt，再搜到同一路径的结果：结果行不亮', async t => {
  const ctx = await startSearch(t);
  const treeRow = rowNamed(ctx.page, 'a.txt');
  treeRow.dispatch('pointerdown', { pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, clientX: 5, clientY: 5 });
  ctx.tick(80);
  assert.equal(treeRow.classList.contains('pressed'), true);
  await search(ctx, 'a', [hit('a.txt')]);
  assert.equal(hitNamed(ctx.page, 'a.txt').classList.contains('pressed'), false);
});

test('iPhone 顶部标题：搜索时盖住了图标视图的目录，标题是根目录名；清空后回到当前目录名', async t => {
  const ctx = await startPhone(t, { state: iconsRecord });
  const title = () => ctx.page.bar.find(node => node.classList.contains('bar-title'))[0].textContent;
  assert.equal(title(), 'dir');
  await search(ctx, 'x', results);
  assert.equal(title(), 'A');
  type(ctx.page, '');
  await flush();
  assert.equal(title(), 'dir');
});

test('搜索框 ↓：明确选中第一条，有旧选中时也一样（↓ 进结果 → 往下一条 → Esc 回搜索框 → 再按 ↓，选中的仍是第一条）', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', results);
  const input = box(ctx.page), list = hitsEl(ctx.page);
  input.focus();
  press(input, 'ArrowDown');
  assert.deepEqual(selectedHits(ctx.page), ['dir/x.txt']);
  press(list, 'ArrowDown');
  assert.deepEqual(selectedHits(ctx.page), ['dir/y.txt']);
  press(list, 'Escape');
  assert.equal(active(), input);
  press(input, 'ArrowDown');
  assert.deepEqual(selectedHits(ctx.page), ['dir/x.txt'], '不是相对移动：回到第一条');
  assert.equal(active(), list);
});

test('菜单关掉的 Esc 到了搜索框：拦下默认动作（type=search 的输入框按 Esc 会自己清空），搜索词和结果都还在', async t => {
  const ctx = await startSearch(t);
  await search(ctx, 'x', results);
  const field = box(ctx.page);
  field.focus();
  hitNamed(ctx.page, 'dir/x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  let prevented = false;
  field.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(visible(ctx.page.menu), false);
  assert.equal(prevented, true);
  assert.equal(field.value, 'x');
  assert.equal(searchShown(ctx.page), true);
});
