// 图标视图接进页面（view/app.mjs）：单击进入和打开、右键、长按、上一层（Mac 头部、iPhone 原生返回和 EXIT）、滚动位置的保存和恢复。
// 真实的 app.mjs、Model、Link、grid.mjs，配最小的假 DOM 和脚本化的假模块；视图经真实的「更多」菜单切换（Mac 原生按钮 → 「显示」）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { pick } from './support/more.mjs';
import { openTree } from './support/treehost.mjs';

const FILES = Array.from({ length: 90 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
// 每个用例一份：用例会改目录的内容，不能共用。
const makeListing = () => ({ '': ['dir/', 'other/', ...FILES], dir: ['inner/', 'x.txt', 'y.txt'], 'dir/inner': ['deep.txt'], other: [] });
const ROW = 24; // 假 DOM 量出的单元格高度；宽度 100，所以 300 宽是 3 列
const touch = (extra = {}) => ({ pointerId: 1, isPrimary: true, clientX: 50, clientY: 60, ...extra });
const body = page => page.grid.find(node => node.classList.contains('gbody'))[0];
const cells = page => page.grid.find(node => node.classList.contains('gi'));
const cellNamed = (page, name) => page.grid.find(node => node.classList.contains('cell') && node.textContent === name)[0];
const head = page => page.grid.find(node => node.classList.contains('ghead'))[0];
const headName = page => head(page).find(node => node.classList.contains('gname-head'))[0]?.textContent;
const state = (view, sessions = {}) => ({ v: 1, seq: 1, hidden: false, view, sessions });

// 起一个会话；icons 为 true 时从图标视图开始（保存的状态里 view 是 icons）。
async function start(t, { platform = 'mac', icons = true, saved, settle = true, ...options } = {}) {
  platformNow = platform;
  const sessions = saved ? { s1: { at: 1, expanded: [], selected: null, scroll: { tree: 0, top: 0, left: 0 }, ...saved } } : {};
  const ctx = await openTree(t, { platform, listing: makeListing(), state: state(icons ? 'icons' : 'list', sessions), ...options });
  Object.assign(body(ctx.page), { clientWidth: 300, clientHeight: ROW * 5 });
  ctx.host.session('s1', '/A');
  if (settle) await flush();
  return ctx;
}
// 打开一项：Mac 是一次完整的双击（两次 click 加 dblclick，浏览器的顺序），iPhone 是轻点（不监听 dblclick）。
let platformNow = 'mac';
const click = async (page, name) => {
  const node = cellNamed(page, name);
  node.dispatch('click');
  if (platformNow === 'mac') { node.dispatch('click'); node.dispatch('dblclick'); }
  await flush();
};
const tap = async (page, name) => { cellNamed(page, name).dispatch('click'); await flush(); };
// 经「显示」菜单换视图：起的时候要带 coda.toolbar（Mac 的原生「更多」按钮）。
const showAs = async ({ page, host }, view) => { host.events.toolbar({ id: 'more' }); pick(page, view === 'icons' ? '图标' : '列表'); await flush(); };
const TOOLBAR = { toolbar: () => {} };
const scrollTo = (page, top) => { body(page).scrollTop = top; body(page).dispatch('scroll'); };

// ---- 交互 ----

test('图标视图：只显示当前这一层，面板可见、目录树面板不可见', async t => {
  const { page } = await start(t);
  assert.equal(visible(page.grid), true);
  assert.equal(visible(page.tree), false);
  assert.equal(page.tree.inert, true);
  assert.ok(cellNamed(page, 'dir') && cellNamed(page, 'f00.txt'));
  assert.equal(cellNamed(page, 'x.txt'), undefined, '子目录的条目不在这一层');
});

for (const platform of ['mac', 'ios']) {
  test(`单击文件夹进入这一层并加载，单击文件在页内切到预览（${platform}）`, async t => {
    const { page, host } = await start(t, { platform });
    await click(page, 'dir');
    assert.ok(host.lists().some(request => request.path === 'dir'));
    assert.deepEqual(cells(page).map(node => node.textContent), ['inner', 'x.txt', 'y.txt']);
    await click(page, 'x.txt');
    assert.equal(visible(page.preview), true, '在页内切到文件');
    assert.equal(visible(page.grid), false);
    assert.deepEqual(host.calls.open, [], '两端都不再推入文件页');
    assert.equal(host.reads().length, 1);
  });
}

test('link 和 other 点了没反应', async t => {
  const { page, host } = await start(t, { listing: { '': [{ name: 'to', kind: 'link' }, { name: 'dev', kind: 'other' }] } });
  await click(page, 'to');
  await click(page, 'dev');
  assert.deepEqual(host.lists().map(request => request.path), ['']);
  assert.equal(visible(page.grid), true);
  assert.deepEqual(host.calls.open, []);
});

test('Mac 右键弹行菜单（和列表一样的项：复制路径、属性），属性页能打开；拖动带相对路径', async t => {
  const { page } = await start(t);
  await click(page, 'dir');
  cellNamed(page, 'x.txt').dispatch('contextmenu', { clientX: 10, clientY: 10 });
  assert.equal(visible(page.menu), true);
  const items = page.menu.find(node => node.tagName === 'BUTTON').map(node => node.textContent);
  assert.deepEqual(items, ['打开', '在 Coda 中打开', '添加到聊天', '复制相对路径', '复制绝对路径', '属性']);
  page.menu.find(node => node.tagName === 'BUTTON').at(-1).dispatch('click');
  await flush();
  assert.equal(visible(page.info), true, '属性页叠在图标视图上');
  const data = {};
  cellNamed(page, 'y.txt').dispatch('dragstart', { dataTransfer: { setData: (type, value) => { data[type] = value; } } });
  assert.deepEqual(data, { 'text/plain': 'dir/y.txt' });
});

test('iPhone 长按弹菜单；触发后吞掉紧接的点击（不进目录）；长按后滑动不弹', async t => {
  const { page, tick } = await start(t, { platform: 'ios' });
  const down = name => cellNamed(page, name).dispatch('pointerdown', touch());
  down('dir');
  tick(500);
  assert.equal(visible(page.menu), true);
  cellNamed(page, 'dir').dispatch('pointerup', touch());
  cellNamed(page, 'dir').dispatch('click');
  await flush();
  assert.equal(cellNamed(page, 'dir') !== undefined, true, '点击被吞，没进目录');
  assert.deepEqual(page.grid.find(node => node.classList.contains('cell')).map(node => node.textContent).slice(0, 2), ['dir', 'other']);
  page.menu.hidden = true;

  down('other');
  tick(300);
  cellNamed(page, 'other').dispatch('pointermove', touch({ clientX: 80, clientY: 90 })); // 滑出范围
  tick(300);
  assert.equal(visible(page.menu), false, '滑动超限，作废');
  cellNamed(page, 'other').dispatch('pointerup', touch());
  cellNamed(page, 'other').dispatch('click');
  await flush();
  assert.deepEqual(cells(page).map(node => node.textContent), ['空目录'], '取消的长按只是一次普通的点击：进了 other');
});

test('长按的等待属于上一个会话：换会话后到点不弹菜单', async t => {
  const { page, host, tick } = await start(t, { platform: 'ios' });
  cellNamed(page, 'f00.txt').dispatch('pointerdown', touch());
  tick(300);
  host.session('s2', '/A');
  await flush();
  tick(500);
  assert.equal(visible(page.menu), false);
});

// ---- 上一层 ----

test('Mac：头部返回回到上一层，根目录没有返回键；不声明原生返回', async t => {
  const { page, host } = await start(t, { back: true });
  assert.equal(headName(page), 'A', '根目录：标题是根目录名');
  assert.equal(head(page).children.some(node => node.tagName === 'BUTTON'), false);
  await click(page, 'dir');
  assert.equal(headName(page), 'dir');
  await click(page, 'inner');
  assert.equal(headName(page), 'inner');
  const back = head(page).children[0];
  assert.equal(back.getAttribute('aria-label'), '返回');
  back.dispatch('click');
  await flush();
  assert.equal(headName(page), 'dir');
  head(page).children[0].dispatch('click');
  await flush();
  assert.equal(headName(page), 'A');
  assert.deepEqual(host.calls.back, [], 'Mac 不声明');
});

test('iPhone：coda.back 声明上层的标题（由远到近，不含当前页），on(back) 按 steps 退几层，工具条标题是当前目录名', async t => {
  const { page, host } = await start(t, { platform: 'ios', back: true });
  const title = () => page.bar.find(node => node.classList.contains('bar-title'))[0].textContent;
  assert.deepEqual(host.calls.back, [], '根目录：没有上层，不用声明');
  assert.equal(title(), 'A');
  await click(page, 'dir');
  await click(page, 'inner');
  assert.deepEqual(host.calls.back.at(-1), ['A', 'dir']);
  assert.equal(title(), 'inner');
  assert.equal(head(page).hidden, true, '有原生返回：没有页内头部');
  host.events.back({ steps: 1 });
  await flush();
  assert.deepEqual(cells(page).map(node => node.textContent), ['inner', 'x.txt', 'y.txt']);
  assert.deepEqual(host.calls.back.at(-1), ['A']);
  assert.equal(title(), 'dir');
  await click(page, 'inner');
  host.events.back({ steps: 2 }); // 一次退两层
  await flush();
  assert.ok(cellNamed(page, 'f00.txt'), '回到根目录');
  assert.deepEqual(host.calls.back.at(-1), []);
  host.events.back({ steps: 3 }); // 已经在最上层：重新声明一次，不报错
  await flush();
  assert.deepEqual(host.calls.back.slice(-2), [[], []]);
  assert.equal(host.calls.close ?? 0, 0, '原生返回不关视图');
});

test('iPhone 横屏：EXIT 和原生返回走同一个退层逻辑，在根层才关视图', async t => {
  const { page, host } = await start(t, { platform: 'ios', back: true });
  const exit = () => page.bar.find(node => node.tagName === 'BUTTON' && node.classList.contains('exit'))[0];
  await click(page, 'dir');
  exit().dispatch('click');
  await flush();
  assert.ok(cellNamed(page, 'f00.txt'), '先退一层');
  assert.equal(host.calls.close ?? 0, 0);
  assert.deepEqual(host.calls.back.at(-1), []);
  exit().dispatch('click');
  assert.equal(host.calls.close, 1, '在根层才关视图');
});

test('没有 coda.back 的 iPhone：头部自己放返回，样式同 Mac', async t => {
  const { page } = await start(t, { platform: 'ios', back: false });
  await click(page, 'dir');
  assert.equal(head(page).hidden, false);
  head(page).children[0].dispatch('click');
  await flush();
  assert.ok(cellNamed(page, 'f00.txt'));
});

test('和属性页叠加：路径算在一起，steps 为 2 时回到上一层；列表视图的基础路径为空，属性页仍加一层', async t => {
  const { page, host } = await start(t, { platform: 'ios', back: true });
  await click(page, 'dir');
  await click(page, 'inner');
  cellNamed(page, 'deep.txt').dispatch('contextmenu', { clientX: 1, clientY: 1 });
  page.menu.find(node => node.tagName === 'BUTTON').at(-1).dispatch('click');
  await flush();
  assert.deepEqual(host.calls.back.at(-1), ['A', 'dir', 'inner'], '在 dir/inner 打开属性页');
  assert.equal(visible(page.info), true);
  host.events.back({ steps: 1 });
  await flush();
  assert.equal(visible(page.info), false);
  assert.deepEqual(host.calls.back.at(-1), ['A', 'dir'], '只关了属性页，还在 dir/inner');
  assert.ok(cellNamed(page, 'deep.txt'));
  cellNamed(page, 'deep.txt').dispatch('contextmenu', { clientX: 1, clientY: 1 });
  page.menu.find(node => node.tagName === 'BUTTON').at(-1).dispatch('click');
  await flush();
  host.events.back({ steps: 2 });
  await flush();
  assert.equal(visible(page.info), false);
  assert.deepEqual(host.calls.back.at(-1), ['A'], '回到 dir');
  assert.deepEqual(cells(page).map(node => node.textContent), ['inner', 'x.txt', 'y.txt']);
});

test('列表视图的基础路径为空，属性页仍加一层', async t => {
  const { page, host } = await start(t, { platform: 'ios', back: true, icons: false });
  page.tree.find(node => node.classList.contains('row'))[0].dispatch('contextmenu', { clientX: 1, clientY: 1 });
  page.menu.find(node => node.tagName === 'BUTTON').at(-1).dispatch('click');
  await flush();
  assert.deepEqual(host.calls.back, [['资源管理器']]);
});

test('iPhone 页面重建后立刻重新声明恢复的路径', async t => {
  const saved = [];
  const first = await start(t, { platform: 'ios', back: true, coda: { setState: value => saved.push(JSON.parse(JSON.stringify(value))) } });
  await click(first.page, 'dir');
  await click(first.page, 'inner');
  first.host.events.visibility(false);
  const rebuilt = await openTree(t, { platform: 'ios', listing: makeListing(), back: true, state: saved.at(-1) }); // 两个页面共用假计时器：t.mock.timers 已启用时 openTree 会再启用一次，放在新的用例里
  Object.assign(body(rebuilt.page), { clientWidth: 300, clientHeight: ROW * 5 });
  rebuilt.host.session('s1', '/A');
  await flush();
  assert.deepEqual(rebuilt.host.calls.back, [['A', 'dir']]);
  assert.deepEqual(rebuilt.page.grid.find(node => node.classList.contains('cell')).map(node => node.textContent), ['deep.txt']);
});

// ---- 目录没了 ----

test('当前目录被删：回到最近的上一层，提示「文件夹已不存在」，落到哪一层就用哪一层的位置', async t => {
  const { page, host } = await start(t);
  scrollTo(page, ROW * 2); // 再往下 dir 就不在画出来的那一段里了
  await click(page, 'dir');
  assert.equal(body(page).scrollTop, 0, '进入子目录滚到顶部');
  host.missing.add('dir');
  host.changed(); // 一轮结束：cwd 重取，发现没了
  await flush();
  assert.ok(cellNamed(page, 'f00.txt'), '回到根目录');
  assert.equal(page.hint.textContent, '文件夹已不存在');
  assert.equal(body(page).scrollTop, ROW * 2, '落在根目录：用根目录记下的位置');
  assert.equal(host.lists().filter(request => request.path === 'dir').length, 2, '进入一次、刷新一次，回退时没有再试它');
});

test('恢复时 cwd 已经不存在：悄悄回到上一层，不提示', async t => {
  const host = { missing: ['dir/inner'] };
  const ctx = await openTree(t, { listing: makeListing(), state: state('icons', { s1: { at: 1, expanded: [], selected: null, cwd: 'dir/inner', root: '/A', scroll: { tree: 0, top: 0, left: 0, grid: 48, gridSort: 'name' } } }) });
  Object.assign(body(ctx.page), { clientWidth: 300, clientHeight: ROW * 5 });
  ctx.host.missing.add(host.missing[0]);
  ctx.host.session('s1', '/A');
  await flush();
  assert.deepEqual(cells(ctx.page).map(node => node.textContent), ['inner', 'x.txt', 'y.txt'], '回到 dir');
  assert.equal(ctx.page.hint.hidden, true, '恢复时不提示');
});

// ---- 滚动 ----

test('进入回到顶部、返回恢复进去之前的位置（上层的位置在内存里，每个目录一份）', async t => {
  const { page, host } = await start(t);
  host.listing.dir = Array.from({ length: 12 }, (_, i) => `s${i}.txt`).concat('inner/'); // 够滚，dir 里的子目录排在最后
  scrollTo(page, ROW * 2);
  await click(page, 'dir');
  assert.equal(body(page).scrollTop, 0);
  scrollTo(page, ROW * 3);
  await click(page, 'inner');
  assert.equal(body(page).scrollTop, 0, '每一层进去都从顶部');
  head(page).children[0].dispatch('click'); // 回 dir
  await flush();
  assert.equal(body(page).scrollTop, ROW * 3, 'dir 恢复进去之前的位置');
  head(page).children[0].dispatch('click'); // 回根目录
  await flush();
  assert.equal(body(page).scrollTop, ROW * 2, '根目录恢复进去之前的位置');
});

test('换排序：两种视图都回到顶部，上层的记录作废；显示隐藏文件变化时图标视图回到顶部', async t => {
  const ctx = await start(t, { coda: { toolbar: () => {} } });
  const { page, host } = ctx;
  host.listing.dir = Array.from({ length: 30 }, (_, i) => `s${i}.txt`);
  scrollTo(page, ROW * 2);
  await click(page, 'dir');
  const choose = async label => {
    host.events.toolbar({ id: 'more' });
    pick(page, label);
    await flush();
  };
  scrollTo(page, ROW * 6);
  await choose('日期');
  assert.equal(body(page).scrollTop, 0, '换排序回到顶部');
  head(page).children[0].dispatch('click');
  await flush();
  assert.equal(body(page).scrollTop, 0, '上层的记录作废：回去也在顶部，不是换排序之前的 ROW * 2');
  scrollTo(page, ROW * 2);
  host.events.toolbar({ id: 'more' });
  page.menu.find(node => node.tagName === 'BUTTON').find(node => node.textContent === '显示隐藏文件').dispatch('click');
  await flush();
  assert.equal(body(page).scrollTop, 0, '显示隐藏文件变化：回到顶部');
});

test('恢复途中换排序：待恢复的位置作废，内容到了也不跳', async t => {
  const saved = { cwd: 'dir', root: '/A', scroll: { tree: 0, top: 0, left: 0, grid: ROW * 3, gridSort: 'name' } };
  const ctx = await openTree(t, { listing: makeListing(), coda: { toolbar: () => {} }, state: state('icons', { s1: { at: 1, expanded: [], selected: null, ...saved } }) });
  const { page, host } = ctx;
  Object.assign(body(page), { clientWidth: 300, clientHeight: ROW * 5 });
  host.listing.dir = FILES.slice(0, 40);
  host.held.add('dir');
  host.session('s1', '/A');
  await flush();
  host.events.toolbar({ id: 'more' });
  pick(page, '大小');
  await flush();
  host.held.clear();
  host.heldLists.splice(0).forEach(request => host.answer(request, { entries: FILES.slice(0, 40).map(name => ({ name, kind: 'file' })), nextCursor: null }));
  await flush();
  assert.equal(body(page).scrollTop, 0);
});

test('页面重建（iPhone 退出时预览开着）：回到预览；返回后当前目录的位置恢复，再往上一层回到顶部', async t => {
  const saved = [];
  const first = await start(t, { platform: 'ios', coda: { setState: value => saved.push(JSON.parse(JSON.stringify(value))) } });
  scrollTo(first.page, ROW * 2);
  await click(first.page, 'dir');
  assert.equal(body(first.page).scrollTop, 0);
  first.host.listing.dir = Array.from({ length: 60 }, (_, i) => `d${String(i).padStart(2, '0')}.txt`);
  first.host.changed();
  await flush();
  scrollTo(first.page, ROW * 8);
  await click(first.page, 'd27.txt'); // 打开文件：页内预览，长按返回退出整层时 visibility: false 同步存下
  assert.equal(first.host.calls.open.length, 0);
  first.host.events.visibility(false);
  const second = await openTree(t, { platform: 'ios', listing: { ...makeListing(), dir: first.host.listing.dir }, state: saved.at(-1) });
  Object.assign(body(second.page), { clientWidth: 300, clientHeight: ROW * 5 });
  second.host.session('s1', '/A');
  await flush();
  assert.equal(visible(second.page.preview), true, '恢复到上次开着的文件');
  second.page.bar.find(node => node.classList.contains('exit'))[0].dispatch('click'); // 横屏返回先关预览
  await flush();
  assert.equal(visible(second.page.grid), true);
  assert.equal(body(second.page).scrollTop, ROW * 8, '当前目录的位置恢复');
  second.page.bar.find(node => node.classList.contains('exit'))[0].dispatch('click');
  await flush();
  assert.ok(cellNamed(second.page, 'f00.txt'));
  assert.equal(body(second.page).scrollTop, 0, '内存里的记录没了：上一层回到顶部');
});

test('换会话回来：恢复 cwd 和它的滚动位置；排序变过则回到顶部', async t => {
  const { page, host } = await start(t);
  await click(page, 'dir');
  host.listing.dir = FILES.slice(0, 40);
  host.changed();
  await flush();
  scrollTo(page, ROW * 7);
  host.session('s2', '/A');
  await flush();
  assert.ok(cellNamed(page, 'f00.txt'), '新会话在根目录');
  assert.equal(body(page).scrollTop, 0);
  host.session('s1', '/A');
  await flush();
  assert.equal(headName(page), 'dir', '回到 s1 的 cwd');
  assert.equal(body(page).scrollTop, ROW * 7);
});

test('内容晚到才恢复：等 cwd 的内容到了才用，之前不动', async t => {
  const saved = { cwd: 'dir', root: '/A', scroll: { tree: 0, top: 0, left: 0, grid: ROW * 3, gridSort: 'name' } };
  const ctx = await openTree(t, { listing: { ...makeListing(), dir: FILES.slice(0, 40) }, state: state('icons', { s1: { at: 1, expanded: [], selected: null, ...saved } }) });
  const { page, host } = ctx;
  Object.assign(body(page), { clientWidth: 300, clientHeight: ROW * 5 });
  host.held.add('dir');
  host.session('s1', '/A');
  await flush();
  assert.equal(body(page).scrollTop, 0, '根目录先到了，目标目录还没到：不动');
  assert.equal(host.heldLists.length, 1);
  host.heldLists.splice(0).forEach(request => host.answer(request, { entries: FILES.slice(0, 40).map(name => ({ name, kind: 'file' })), nextCursor: null }));
  await flush();
  assert.equal(body(page).scrollTop, ROW * 3);
});

test('加载失败就结束恢复：内容之后到了也不再跳', async t => {
  const ctx = await openTree(t, { listing: makeListing(), state: state('icons', { s1: { at: 1, expanded: [], selected: null, cwd: 'dir', root: '/A', scroll: { tree: 0, top: 0, left: 0, grid: ROW * 3, gridSort: 'name' } } }) });
  const { page, host } = ctx;
  Object.assign(body(page), { clientWidth: 300, clientHeight: ROW * 5 });
  host.failing.add('dir');
  host.session('s1', '/A');
  await flush();
  assert.equal(body(page).scrollTop, 0);
  host.failing.delete('dir');
  host.listing.dir = FILES;
  cellNamed(page, 'x.txt') ?? null;
  page.grid.find(node => node.classList.contains('retry'))[0].dispatch('click'); // 重试
  await flush();
  assert.equal(body(page).scrollTop, 0, '失败时就结束了，重试成功也不跳');
});

test('用户在内容到达之前自己滚了：放弃恢复，不再跳', async t => {
  const ctx = await openTree(t, { listing: makeListing(), state: state('icons', { s1: { at: 1, expanded: [], selected: null, cwd: 'dir', root: '/A', scroll: { tree: 0, top: 0, left: 0, grid: ROW * 3, gridSort: 'name' } } }) });
  const { page, host } = ctx;
  Object.assign(body(page), { clientWidth: 300, clientHeight: ROW * 5 });
  host.held.add('dir');
  host.session('s1', '/A');
  await flush();
  scrollTo(page, 10);
  host.heldLists.splice(0).forEach(request => host.answer(request, { entries: FILES.slice(0, 40).map(name => ({ name, kind: 'file' })), nextCursor: null }));
  await flush();
  assert.equal(body(page).scrollTop, 10);
});

test('保存的排序和现在不一致：恢复时回到顶部', async t => {
  const ctx = await openTree(t, { listing: makeListing(), state: { ...state('icons', { s1: { at: 1, expanded: [], selected: null, cwd: 'dir', root: '/A', scroll: { tree: 0, top: 0, left: 0, grid: ROW * 3, gridSort: 'size' } } }) } });
  Object.assign(body(ctx.page), { clientWidth: 300, clientHeight: ROW * 5 });
  ctx.host.session('s1', '/A');
  await flush();
  assert.equal(body(ctx.page).scrollTop, 0);
  assert.equal(ctx.page.grid.find(node => node.classList.contains('cell')).length, 3, 'cwd 仍然恢复');
});

test('根目录换了：cwd 和滚动位置回到根目录和顶部', async t => {
  const ctx = await openTree(t, { listing: makeListing(), state: state('icons', { s1: { at: 1, expanded: [], selected: null, cwd: 'dir', root: '/OLD', scroll: { tree: 0, top: 0, left: 0, grid: ROW * 3, gridSort: 'name' } } }) });
  Object.assign(body(ctx.page), { clientWidth: 300, clientHeight: ROW * 5 });
  ctx.host.session('s1', '/A');
  await flush();
  assert.ok(cellNamed(ctx.page, 'f00.txt'), '回到根目录');
  assert.equal(body(ctx.page).scrollTop, 0);
});

test('切换视图：两种视图各自的滚动位置互不影响，列表的展开状态不丢；视图存进状态', async t => {
  const saved = [];
  const ctx = await start(t, { icons: false, coda: { ...TOOLBAR, setState: value => saved.push(JSON.parse(JSON.stringify(value))) } });
  const { page, host } = ctx;
  const pane = page.tree;
  pane.scrollTop = 24 * 9;
  pane.dispatch('scroll');
  await showAs(ctx, 'icons');
  assert.equal(visible(page.grid), true);
  scrollTo(page, ROW * 4);
  await showAs(ctx, 'list');
  assert.equal(visible(page.tree), true);
  assert.equal(pane.scrollTop, 24 * 9, '列表的位置还在');
  await showAs(ctx, 'icons');
  assert.equal(body(page).scrollTop, ROW * 4, '网格的位置还在');
  host.events.visibility(false);
  assert.equal(saved.at(-1).view, 'icons');
  assert.deepEqual([saved.at(-1).sessions.s1.scroll.tree, saved.at(-1).sessions.s1.scroll.grid], [24 * 9, ROW * 4]);
  assert.ok(host.lists().length > 0);
});

test('切换视图：列表的展开状态在图标里不丢，换回去目录还展开着', async t => {
  const ctx = await start(t, { icons: false, coda: TOOLBAR });
  const { page } = ctx;
  const dirRow = () => page.tree.find(node => node.classList.contains('row') && node.textContent.includes('dir'))[0];
  dirRow().dispatch('dblclick');
  await flush();
  assert.equal(dirRow().getAttribute('aria-expanded'), 'true');
  await showAs(ctx, 'icons');
  assert.ok(cellNamed(page, 'dir'));
  await showAs(ctx, 'list');
  assert.equal(dirRow().getAttribute('aria-expanded'), 'true');
  assert.ok(page.tree.find(node => node.classList.contains('row') && node.textContent.includes('x.txt')).length > 0);
});

test('旧状态（0.5.0：没有视图、cwd、网格位置）：启动是列表，位置照旧', async t => {
  const old = { v: 1, seq: 1, hidden: false, sessions: { s1: { at: 1, expanded: [], selected: null, scroll: { tree: 55, top: 0, left: 0 } } } };
  const ctx = await start(t, { state: old, coda: TOOLBAR });
  const { page } = ctx;
  assert.equal(visible(page.tree), true);
  assert.equal(page.tree.scrollTop, 55);
  await showAs(ctx, 'icons');
  assert.ok(cellNamed(page, 'dir'), '切到图标：从根目录开始');
});

test('列数变化（iPhone 旋转）：第一个可见的单元格不变', async t => {
  const { page } = await start(t, { platform: 'ios' });
  scrollTo(page, ROW * 10); // 3 列：第 10 行，第一个可见的是 30 号
  body(page).clientWidth = 400; // 横过来：4 列
  page.resize();
  assert.equal(body(page).scrollTop, ROW * 7, '30 号在 4 列里是第 7 行');
  const first = cells(page).map(node => Number(node.dataset.i));
  assert.ok(first.includes(28) && first.includes(31), '这一行的单元格画出来了');
});

// ---- 失效：隐藏文件变化、换根目录要让两种视图都回到顶部，待恢复的位置和上层的记录一起作废 ----

const chooseMore = async ({ page, host }, label) => { host.events.toolbar({ id: 'more' }); pick(page, label); await flush(); };

test('列表视图里切换显示隐藏文件：列表和图标视图都回到顶部', async t => {
  const ctx = await start(t, { coda: TOOLBAR });
  const { page } = ctx;
  scrollTo(page, ROW * 4);
  await showAs(ctx, 'list');
  page.tree.scrollTop = 24 * 9;
  page.tree.dispatch('scroll');
  await chooseMore(ctx, '显示隐藏文件');
  assert.equal(page.tree.scrollTop, 0, '列表回到顶部');
  await showAs(ctx, 'icons');
  assert.equal(body(page).scrollTop, 0, '图标视图也回到顶部');
});

test('切换显示隐藏文件：上层的记录和另一个视图待恢复的位置作废', async t => {
  const ctx = await start(t, { icons: false, coda: TOOLBAR, saved: { cwd: '', root: '/A', scroll: { tree: 0, top: 0, left: 0, grid: ROW * 3, gridSort: 'name' } } });
  await chooseMore(ctx, '显示隐藏文件');
  await showAs(ctx, 'icons');
  assert.equal(body(ctx.page).scrollTop, 0, '待恢复的网格位置作废，切过去不跳');
  scrollTo(ctx.page, ROW * 2);
  await click(ctx.page, 'dir');
  await showAs(ctx, 'list');
  await chooseMore(ctx, '显示隐藏文件');
  await showAs(ctx, 'icons');
  head(ctx.page).children[0].dispatch('click');
  await flush();
  assert.equal(body(ctx.page).scrollTop, 0, '回到根目录用不上切换之前记下的 ROW * 2');
});

test('页面存续期间换了根目录：图标视图和列表都回到顶部', async t => {
  const ctx = await start(t, { coda: TOOLBAR });
  const { page, host } = ctx;
  scrollTo(page, ROW * 4);
  await showAs(ctx, 'list');
  page.tree.scrollTop = 24 * 9;
  page.tree.dispatch('scroll');
  await showAs(ctx, 'icons');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/NEW' });
  await flush();
  assert.equal(body(page).scrollTop, 0, '图标视图');
  await showAs(ctx, 'list');
  assert.equal(page.tree.scrollTop, 0, '列表');
});

test('换根目录：旧根目录的上层位置不会被新根目录复用', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  scrollTo(page, ROW * 2);
  await click(page, 'dir');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/B' });
  await flush();
  assert.ok(cellNamed(page, 'f00.txt'), '回到新根目录的根层');
  assert.equal(body(page).scrollTop, 0, '不是旧根目录记下的 ROW * 2');
});

test('换根目录失效不误伤：同根的 root 消息（含重建、重复就绪）保留 cwd 和上层位置', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  scrollTo(page, ROW * 2);
  await click(page, 'dir');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/A' });
  await flush();
  assert.deepEqual(cells(page).map(node => node.textContent), ['inner', 'x.txt', 'y.txt'], 'cwd 还在 dir');
  head(page).children[0].dispatch('click');
  await flush();
  assert.equal(body(page).scrollTop, ROW * 2, '上层的位置还在');
});
