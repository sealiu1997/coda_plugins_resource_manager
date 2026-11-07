// 「在目录中显示」和结果里打开文件夹：一次可以取消的定位操作（第 18.3 节）。真实的 app.mjs、tree.mjs、grid.mjs，配脚本化的假模块；
// 目录页由测试里的 gate 控制（host.held 扣住的 list 请求，用 next 回答），不用固定等待。
import assert from 'node:assert/strict';
import test from 'node:test';
import { RESTORE_LIMIT } from '../view/model.mjs';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { cellNamed, cellNames, clickOn, gridBody, iconsState, selectedCells, selectedRows } from './support/finder.mjs';
import { pick } from './support/more.mjs';
import { box, cancels, hit, hitNamed, search, searchShown, searches, startSearch, type } from './support/searchhost.mjs';
import { rowNamed } from './support/treehost.mjs';

const DEEP = { '': ['dir/', 'other/', 'a.txt'], dir: ['x.txt', 'y.txt', 'inner/'], 'dir/inner': ['deep.txt', 'z.txt'], other: ['o.txt'] };
const iconsAt = (cwd = '') => iconsState({ s1: { at: 1, expanded: [], selected: null, scroll: { tree: 0, top: 0, left: 0, sort: 'name', grid: 0, gridSort: 'name' }, cwd, root: '/A' } });
const more = ctx => ctx.host.events.toolbar({ id: 'more' });
const rowIndex = (ctx, path) => ctx.page.tree.find(node => node.classList.contains('row') && node.classList.contains('entry')).findIndex(node => node.dataset.path === path);

// 搜出结果，右键 → 菜单项。
async function ask(ctx, path, label = '在目录中显示', kind = 'file') {
  await search(ctx, 'q', [hit(path, kind)]);
  hitNamed(ctx.page, path).dispatch('contextmenu', { clientX: 5, clientY: 5 });
  const item = ctx.page.menu.find(node => node.textContent === label)[0];
  item.dispatch('click');
  await flush();
}
// 每个用例一份自己的目录内容（host.listing 就是它，用例里会改）。
const start = (t, { listing = DEEP, ...options } = {}) => startSearch(t, { listing: structuredClone(listing), ...options });
// 扣住的 list 请求：一个一个取，回答。
const nextHeld = async host => { await flush(); return host.heldLists.shift(); };
const page = (entries, next = null) => ({ entries: entries.map(name => (typeof name === 'string' ? { name, kind: name.endsWith('/') ? 'dir' : 'file' } : name)), nextCursor: next });
const names = count => Array.from({ length: count }, (_, i) => `f${String(i).padStart(5, '0')}`);

// ---- 列表视图 ----

test('列表视图：从根往下逐级展开，选中它并滚到可见区中间；搜索框清空，回到目录树', async t => {
  const ctx = await start(t);
  await ask(ctx, 'dir/inner/deep.txt');
  assert.equal(box(ctx.page).value, '', '开始时清空搜索');
  assert.equal(searchShown(ctx.page), false);
  assert.ok(rowNamed(ctx.page, 'deep.txt') && rowNamed(ctx.page, 'inner'), '每一级都展开了');
  assert.deepEqual(selectedRows(ctx.page), ['deep.txt']);
  const index = rowIndex(ctx, 'dir/inner/deep.txt');
  assert.equal(ctx.page.tree.scrollTop, Math.max(0, index * 24 - (120 - 24) / 2), '居中');
});

test('列表视图：上层分页时接着取，直到找到；不碰 wanted，取一页就停', async t => {
  const ctx = await start(t, { prepare: host => host.held.add('dir') });
  await ask(ctx, 'dir/y.txt');
  const first = await nextHeld(ctx.host);
  assert.equal(first.cursor, null);
  ctx.host.answer(first, page(['x.txt'], 'c1'));
  const second = await nextHeld(ctx.host);
  assert.equal(second.cursor, 'c1', '没找到：取下一页');
  assert.deepEqual(selectedRows(ctx.page), [], '还没找到');
  ctx.host.answer(second, page(['y.txt'], 'c2'));
  await flush();
  assert.deepEqual(selectedRows(ctx.page), ['y.txt']);
  assert.equal(ctx.host.heldLists.length, 0, '找到就停，不再取 c2');
});

test('列表视图：读尽了没有 → 提示「找不到这一项，可能已被删除或改名」，已展开的上层留着', async t => {
  const ctx = await start(t);
  await ask(ctx, 'dir/gone.txt');
  assert.match(ctx.page.hint.textContent, /找不到这一项，可能已被删除或改名/);
  assert.deepEqual(selectedRows(ctx.page), []);
  assert.ok(rowNamed(ctx.page, 'x.txt'), 'dir 已展开，留着');
});

test('列表视图：到 2 万条上限 → 提示「已打开所在的文件夹，这一项在前 2 万条之外」；按已有条目算：一页越过 2 万条时这一页照样用完', async t => {
  const ctx = await start(t, { listing: { '': ['big/', 'a.txt'] }, prepare: host => host.held.add('big') });
  await ask(ctx, 'big/zzz');
  const first = await nextHeld(ctx.host);
  ctx.host.answer(first, page(names(RESTORE_LIMIT), 'c1'));
  await flush();
  assert.equal(ctx.host.heldLists.length, 0, '已经 2 万条：不再取');
  assert.match(ctx.page.hint.textContent, /已打开所在的文件夹，这一项在前 2 万条之外/);
  assert.deepEqual(selectedRows(ctx.page), []);
});

test('列表视图：2 万条之内取到的一页越过上限也用完；目标在这一页里就找到', async t => {
  const ctx = await start(t, { listing: { '': ['big/'] }, prepare: host => host.held.add('big') });
  await ask(ctx, 'big/zzz');
  const first = await nextHeld(ctx.host);
  ctx.host.answer(first, page(names(RESTORE_LIMIT - 1), 'c1'));
  const second = await nextHeld(ctx.host);
  assert.ok(second, '1.9999 万条：还可以取');
  ctx.host.answer(second, page(['f19999', 'zzz'], null));
  await flush();
  assert.deepEqual(selectedRows(ctx.page), ['zzz']);
});

test('列表视图：读失败 → 失败行照常显示，不另提示，不自动重试同一页', async t => {
  const ctx = await start(t, { prepare: host => host.held.add('dir') });
  await ask(ctx, 'dir/y.txt');
  const first = await nextHeld(ctx.host);
  ctx.host.answer(first, page(['x.txt'], 'c1'));
  const second = await nextHeld(ctx.host);
  ctx.host.answer(second, { error: { code: 'io_error', message: '读不了' } });
  await flush();
  assert.ok(ctx.page.tree.find(node => node.classList.contains('retry') && node.textContent.includes('读不了')).length === 1, '失败行');
  assert.equal(ctx.page.hint.hidden, true, '不另提示');
  assert.equal(ctx.host.heldLists.length, 0, '没有重试同一页');
  assert.deepEqual(selectedRows(ctx.page), []);
});

test('列表视图：一级正在加载时先等这次加载结束，再接着找', async t => {
  const ctx = await start(t, { prepare: host => host.held.add('dir') });
  rowNamed(ctx.page, 'dir').dispatch('click');
  ctx.page.tree.find(node => node.classList.contains('chev'))[0].dispatch('click'); // 用户先展开 dir：正在加载
  await flush();
  assert.equal(ctx.host.heldLists.length, 1);
  await ask(ctx, 'dir/y.txt');
  assert.equal(ctx.host.heldLists.length, 1, '定位等这次加载，不另发');
  ctx.host.answer(ctx.host.heldLists.shift(), page(['x.txt', 'y.txt']));
  await flush();
  assert.deepEqual(selectedRows(ctx.page), ['y.txt']);
});

// ---- 打开文件夹 ----

test('结果里的文件夹：双击或 ⌘↓ = 在目录中显示，然后列表视图展开它', async t => {
  const ctx = await start(t);
  await search(ctx, 'inner', [hit('dir/inner', 'dir')]);
  hitNamed(ctx.page, 'dir/inner').dispatch('dblclick');
  await flush();
  assert.equal(searchShown(ctx.page), false);
  assert.deepEqual(selectedRows(ctx.page), ['inner']);
  assert.ok(rowNamed(ctx.page, 'deep.txt'), '展开了它');
});

// ---- 图标视图 ----

test('图标视图：进入它的上一层，记 trail、滚到顶部，选中并居中；文件夹结果之后进入它', async t => {
  const ctx = await start(t, { state: iconsAt('') });
  gridBody(ctx.page).scrollTop = 40;
  await ask(ctx, 'dir/inner/deep.txt');
  assert.ok(cellNames(ctx.page).includes('deep.txt') && cellNames(ctx.page).includes('z.txt'), '在 dir/inner 里');
  assert.deepEqual(selectedCells(ctx.page), ['deep.txt']);
  assert.equal(box(ctx.page).value, '');
  // 回到上一层：trail 里记着进来之前的位置
  ctx.page.grid.find(node => node.getAttribute('aria-label') === '返回')[0].dispatch('click');
  await flush();
  assert.ok(cellNames(ctx.page).includes('inner'));
});

test('图标视图：文件夹结果 = 定位到它所在的目录选中它，然后进入它', async t => {
  const ctx = await start(t, { state: iconsAt('') });
  await search(ctx, 'inner', [hit('dir/inner', 'dir')]);
  hitNamed(ctx.page, 'dir/inner').dispatch('dblclick');
  await flush();
  assert.ok(cellNames(ctx.page).includes('deep.txt'), '进入了 dir/inner');
});

test('图标视图：目标在已经在看的目录里：不换目录，只选中居中', async t => {
  const ctx = await start(t, { state: iconsAt('dir') });
  await ask(ctx, 'dir/y.txt');
  assert.deepEqual(selectedCells(ctx.page), ['y.txt']);
  assert.ok(cellNames(ctx.page).includes('inner'));
});

// ---- 作废：每一种都不选中、不滚动，已展开的留着 ----

// 扣住 dir 的第二页，定位在等；触发 trigger；放行；断言没有选中。
async function voided(t, trigger, { state, scrolls = false } = {}) {
  const ctx = await start(t, { prepare: host => host.held.add('dir'), state });
  await ask(ctx, 'dir/y.txt');
  const first = await nextHeld(ctx.host);
  ctx.host.answer(first, page(['x.txt'], 'c1'));
  const second = await nextHeld(ctx.host);
  assert.ok(second, '定位在等第二页');
  const top = ctx.page.tree.scrollTop;
  await trigger(ctx);
  ctx.host.held.clear();
  if (ctx.host.heldLists.length) for (const request of ctx.host.heldLists.splice(0)) ctx.host.answer(request, page(['x.txt', 'y.txt']));
  else ctx.host.answer(second, page(['y.txt']));
  await flush();
  assert.deepEqual(selectedRows(ctx.page).filter(name => name === 'y.txt'), [], '没有选中目标');
  if (!scrolls) assert.equal(ctx.page.tree.scrollTop, top, '没有滚动'); // 又发起的新定位自己会滚
  return ctx;
}

test('作废：换会话、换根目录、根目录不可用', async t => {
  await voided(t, ctx => { ctx.host.session('s2', '/B'); });
  await voided(t, ctx => { ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'ready', path: '/B' }); });
  await voided(t, ctx => { ctx.page.post({ type: 'root', generation: ctx.host.generation, state: 'gone', path: '/A' }); });
});

test('作废：换排序、换视图、切换显示隐藏文件', async t => {
  await voided(t, ctx => { more(ctx); pick(ctx.page, '日期'); });
  await voided(t, ctx => { more(ctx); pick(ctx.page, '图标'); });
  await voided(t, ctx => { more(ctx); pick(ctx.page, '显示隐藏文件'); });
});

test('作废：任何刷新（changed、手动刷新）', async t => {
  await voided(t, ctx => { ctx.host.changed(); });
  await voided(t, ctx => { more(ctx); pick(ctx.page, '刷新'); });
});

test('作废：又发起一次定位、重新输入搜索词', async t => {
  await voided(t, async ctx => {
    await search(ctx, 'q', [hit('a.txt')]);
    hitNamed(ctx.page, 'a.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
    ctx.page.menu.find(node => node.textContent === '在目录中显示')[0].dispatch('click');
    await flush();
  }, { scrolls: true });
  await voided(t, ctx => { type(ctx.page, 'again'); });
});

test('作废（用户接管，只看用户的输入）：浏览区上的 pointerdown、wheel、touchstart、keydown；点已选中的条目、点空白、右键起手、长按起手', async t => {
  const events = [
    ctx => ctx.page.tree.dispatch('pointerdown', { pointerId: 1, isPrimary: true, button: 0, pointerType: 'mouse' }),
    ctx => ctx.page.tree.dispatch('wheel', {}),
    ctx => ctx.page.tree.dispatch('touchstart', {}),
    ctx => ctx.page.tree.dispatch('keydown', { key: 'ArrowDown', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
    ctx => { const row = rowNamed(ctx.page, 'x.txt'); clickOn(row); clickOn(row); }, // 点已选中的条目（选中没变也算）
    ctx => clickOn(ctx.page.tree, { target: ctx.page.tree }), // 点空白
    ctx => { rowNamed(ctx.page, 'x.txt').dispatch('pointerdown', { pointerId: 1, isPrimary: true, button: 2, pointerType: 'mouse' }); }, // 右键起手
    ctx => { rowNamed(ctx.page, 'x.txt').dispatch('touchstart', {}); }, // 长按起手
  ];
  for (const event of events) await voided(t, event);
});

test('作废：用户经菜单打开预览、属性页', async t => {
  await voided(t, async ctx => {
    rowNamed(ctx.page, 'x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
    ctx.page.menu.find(node => node.textContent === '属性')[0].dispatch('click');
    await flush();
  });
  await voided(t, async ctx => {
    rowNamed(ctx.page, 'x.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
    ctx.page.menu.find(node => node.textContent === '打开')[0].dispatch('click');
    await flush();
  });
});

// ---- 不作废：程序自己的变化不算接管 ----

test('不作废：定位自己的展开、进入目录、滚到顶部、最后居中；程序滚动的 scroll 事件迟到也不算接管', async t => {
  const ctx = await start(t);
  await search(ctx, 'q', [hit('dir/inner/deep.txt')]);
  hitNamed(ctx.page, 'dir/inner/deep.txt').dispatch('contextmenu', { clientX: 5, clientY: 5 });
  ctx.page.menu.find(node => node.textContent === '在目录中显示')[0].dispatch('click');
  for (let i = 0; i < 5; i++) { ctx.page.tree.dispatch('scroll'); await flush(); } // 迟到的 scroll 事件
  assert.deepEqual(selectedRows(ctx.page), ['deep.txt']);
  const icons = await start(t, { state: iconsAt('') });
  await ask(icons, 'dir/inner/deep.txt');
  gridBody(icons.page).dispatch('scroll');
  assert.deepEqual(selectedCells(icons.page), ['deep.txt'], '图标视图里进入目录、滚到顶部都不作废自己');
});

test('找到后：完成之后的任何事件都和它无关，迟到的恢复不把它滚走', async t => {
  const ctx = await start(t);
  await ask(ctx, 'dir/inner/deep.txt');
  const top = ctx.page.tree.scrollTop;
  ctx.host.changed();
  await flush();
  await flush();
  assert.equal(ctx.page.tree.scrollTop, top, '刷新之后位置仍在');
  assert.deepEqual(selectedRows(ctx.page), ['deep.txt']);
});

test('找到时 clientHeight 小于一行也不出错（居中夹在顶部）', async t => {
  const ctx = await start(t);
  ctx.page.tree.clientHeight = 10;
  await ask(ctx, 'dir/x.txt');
  assert.ok(ctx.page.tree.scrollTop >= 0);
});

const many = (count, prefix = 'f') => Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);

test('开始时丢掉目标视图还在等的滚动恢复：定位居中之后，另一个目录晚到也不会触发恢复把它滚走', async t => {
  const saved = { v: 1, seq: 1, hidden: false, sort: 'name', sessions: { s1: { at: 1, expanded: ['dir'], selected: null, scroll: { tree: 200, top: 0, left: 0, sort: 'name' } } } };
  const ctx = await start(t, { listing: { '': [...many(80), 'dir/'], dir: ['x.txt'] }, state: saved, prepare: host => { host.held.add(''); host.held.add('dir'); } });
  await ask(ctx, 'f070');
  ctx.host.answer(await nextHeld(ctx.host), page([...many(80), 'dir/']));
  await flush();
  const top = ctx.page.tree.scrollTop;
  assert.equal(top, 70 * 24 - (120 - 24) / 2, '居中：第 70 行的中心在可见区中间');
  ctx.host.answer(await nextHeld(ctx.host), page(['x.txt'])); // 恢复要等的最后一个目录到了
  await flush();
  assert.equal(ctx.page.tree.scrollTop, top, '没有被保存的 200 拉走');
});

test('图标视图进入上一层之后不触发 landed 的补滚动：居中的位置不被拉回顶部', async t => {
  const ctx = await start(t, { listing: { '': ['dir/'], dir: many(100) }, state: iconsAt('') });
  await ask(ctx, 'dir/f090');
  const top = gridBody(ctx.page).scrollTop;
  assert.ok(top > 0, '滚到了 f090 附近');
  assert.deepEqual(selectedCells(ctx.page), ['f090']);
  ctx.host.changed();
  await flush();
  await flush();
  assert.equal(gridBody(ctx.page).scrollTop, top);
});
