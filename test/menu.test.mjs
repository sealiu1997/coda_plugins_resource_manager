// iPhone 树页的顶部工具条和 ⋯ 菜单：真实的 app.mjs，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { openTree, rowNamed, rowsOf } from './support/treehost.mjs';

const listing = { '': ['a.txt', '.git/', 'b.txt'], '.git': ['HEAD'] };
async function start(t, options) {
  const ctx = await openTree(t, { listing, ...options });
  ctx.host.session('s1', '/work/demo');
  await flush();
  return ctx;
}
const parts = page => ({
  more: page.bar.find(node => node.getAttribute('aria-label') === '更多')[0],
  title: page.bar.find(node => node.classList.contains('bar-title'))[0],
  exit: page.bar.find(node => node.classList.contains('exit'))[0],
});
const items = page => page.menu.find(node => node.tagName === 'BUTTON');
const item = (page, label) => items(page).find(node => node.textContent === label);
const pointerClick = node => { node.dispatch('pointerdown', { pointerId: 1, isPrimary: true }); node.dispatch('pointerup'); node.dispatch('click'); };
// ⋯ 菜单根层的项：刷新、显示隐藏文件、「显示」›；视图和排序在「显示」里（test/sort-ui.test.mjs）。
const MORE_ITEMS = ['刷新', '显示隐藏文件', '显示'];
const MORE_ROLES = ['menuitem', 'menuitemcheckbox', 'menuitem'];
const names = page => rowsOf(page).filter(node => node.classList.contains('entry')).map(node => node.find(part => part.classList.contains('name'))[0].textContent);

test('iPhone 工具条：返回（仅横屏）、根目录名、⋯；⋯ 是图标按钮，有可访问名称和菜单属性', async t => {
  const { page } = await start(t);
  const { more, title, exit } = parts(page);
  assert.equal(title.textContent, 'demo');
  assert.ok(exit.classList.contains('exit'), '返回照旧由 CSS 的横屏媒体查询决定显示');
  assert.equal(more.textContent, '');
  assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(page.bar.children.map(node => node.tagName), ['BUTTON', 'SPAN', 'BUTTON'], '返回、根目录名、⋯；没有「刷新」「显示隐藏文件」「排序」的按钮，它们在菜单里');
});

test('根目录名随会话变，工具条跟着重画；没变就不重画', async t => {
  const { page, host } = await start(t);
  const first = page.bar.children[1];
  host.changed();
  await flush();
  assert.equal(page.bar.children[1], first, '内容没变，不换节点');
  host.session('s2', '/other/place');
  await flush();
  assert.equal(parts(page).title.textContent, 'place');
  host.session('s3', '/');
  await flush();
  assert.equal(parts(page).title.textContent, '/');
});

test('根目录不可用时工具条仍在：名字为空，⋯ 能用', async t => {
  const { page, host } = await start(t);
  host.generation++;
  page.post({ type: 'session', generation: host.generation, session: 's2' });
  page.post({ type: 'root', generation: host.generation, state: 'gone', path: '/x' });
  await flush();
  assert.equal(parts(page).title.textContent, '');
  const before = host.lists().length;
  parts(page).more.dispatch('click');
  item(page, '刷新').dispatch('click');
  await flush();
  assert.equal(host.sent.filter(m => m.type === 'refresh').length, 1, '说明区下刷新照样发出');
  assert.equal(host.lists().length, before);
});

test('⋯ 菜单：刷新、显示隐藏文件，后者是带对勾的开关，再加「显示」；选完关闭；刷新发出协议刷新并重新读目录', async t => {
  const { page, host } = await start(t);
  const { more } = parts(page);
  more.dispatch('click');
  assert.ok(visible(page.menu));
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(items(page).map(node => node.textContent), MORE_ITEMS);
  assert.deepEqual(items(page).map(node => node.getAttribute('role')), MORE_ROLES);
  assert.equal(item(page, '显示隐藏文件').getAttribute('aria-checked'), 'false');
  assert.equal(item(page, '显示隐藏文件').find(node => node.tagName === 'SVG').length, 0, '没开时没有对勾');
  assert.deepEqual(names(page), ['a.txt', 'b.txt'], '.git 被藏起来');

  item(page, '显示隐藏文件').dispatch('click');
  assert.equal(visible(page.menu), false, '选完关闭');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await flush();
  assert.deepEqual(names(page), ['a.txt', '.git', 'b.txt']);

  more.dispatch('click');
  assert.equal(item(page, '显示隐藏文件').getAttribute('aria-checked'), 'true');
  assert.equal(item(page, '显示隐藏文件').find(node => node.tagName === 'SVG').length, 1, '开着有对勾');

  const lists = host.lists().length;
  item(page, '刷新').dispatch('click');
  await flush();
  assert.equal(visible(page.menu), false);
  assert.equal(host.sent.filter(m => m.type === 'refresh').length, 1);
  assert.ok(host.lists().length > lists, '刷新重新读目录');

  more.dispatch('click');
  item(page, '显示隐藏文件').dispatch('click');
  await flush();
  assert.deepEqual(names(page), ['a.txt', 'b.txt'], '再点一次关掉');
});

test('再次激活 ⋯：键盘（只有 click，没有 pointerdown）只关闭，不会又打开；关了之后还能再打开', async t => {
  const { page } = await start(t);
  const { more } = parts(page);
  more.dispatch('click');
  assert.ok(visible(page.menu));
  more.dispatch('click'); // Enter、空格
  assert.equal(visible(page.menu), false);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  more.dispatch('click');
  assert.ok(visible(page.menu), '关闭后再激活是打开');
});

test('再次激活 ⋯：点按（pointerdown 加 click）只关闭，那次点击被吞，不会又打开', async t => {
  const { page } = await start(t);
  const { more } = parts(page);
  pointerClick(more);
  assert.ok(visible(page.menu));
  pointerClick(more);
  assert.equal(visible(page.menu), false);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  pointerClick(more);
  assert.ok(visible(page.menu));
});

test('菜单开着点菜单外：只关菜单，那次点击不交给树；Esc 也关', async t => {
  const { page, host } = await start(t);
  const { more } = parts(page);
  more.dispatch('click');
  pointerClick(rowNamed(page, 'a.txt'));
  assert.equal(visible(page.menu), false);
  assert.equal(host.calls.open.length, 0, '没有打开文件');
  more.dispatch('click');
  globalThis.document.emit({ type: 'keydown', key: 'Escape' });
  assert.equal(visible(page.menu), false);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
});

test('切会话时清掉 ⋯ 菜单；长按的路径菜单和 ⋯ 共用同一个菜单，互相替换', async t => {
  const { page, host, tick } = await start(t);
  const { more } = parts(page);
  more.dispatch('click');
  host.session('s2', '/B');
  await flush();
  assert.equal(visible(page.menu), false);

  const row = rowNamed(page, 'a.txt');
  row.dispatch('pointerdown', { pointerId: 1, isPrimary: true, clientX: 50, clientY: 60 });
  tick(500);
  assert.ok(visible(page.menu));
  assert.deepEqual(items(page).map(node => node.textContent), ['在 Coda 中打开', '添加到聊天', '复制相对路径', '复制绝对路径', '属性']);
  assert.ok(items(page).every(node => node.getAttribute('role') === 'menuitem'));
  assert.equal(parts(page).more.getAttribute('aria-expanded'), 'false', '点位置打开的菜单不属于 ⋯');
  pointerClick(parts(page).more);
  assert.equal(visible(page.menu), false);
  parts(page).more.dispatch('click');
  assert.deepEqual(items(page).map(node => node.textContent), MORE_ITEMS);
  assert.equal(page.menu.find(node => node.classList.contains('menu-path')).length, 0, '⋯ 菜单没有路径标题');
});

test('⋯ 菜单贴在按钮下面、右对齐，并按安全区夹住', async t => {
  const { page } = await start(t);
  parts(page).more.dispatch('click');
  assert.match(page.menu.style.left, /^max\(var\(--safe-left\), min\(0px,/, '右边缘 100 减去菜单宽 100');
  assert.match(page.menu.style.top, /min\(28px,/, '按钮底边 24 加 4');
  assert.doesNotMatch(page.menu.style.left + page.menu.style.top, /NaN|undefined/);
});

test('Mac 没有 coda.toolbar 时（harness）退成页内一条文字按钮，没有返回和 ⋯', async t => {
  const { page } = await start(t, { platform: 'mac' });
  const labels = page.bar.find(node => node.tagName === 'BUTTON').map(node => node.textContent);
  assert.deepEqual(labels, ['刷新', '显示隐藏文件']);
  assert.equal(parts(page).more, undefined);
  assert.equal(page.bar.find(node => node.classList.contains('bar-title')).length, 0);
});

const MAC_MORE = { id: 'more', label: '更多', icon: 'ellipsis', kind: 'button' };

test('Mac 有 coda.toolbar 时：只声明一个「更多」按钮，图标是 ellipsis，不是菜单，没有返回；页内没有工具条', async t => {
  const given = [];
  const { page } = await start(t, { platform: 'mac', coda: { toolbar: items => given.push(items) } });
  assert.equal(visible(page.bar), false);
  assert.deepEqual(given.at(-1), [MAC_MORE]);
  tapRow(page);
  await flush();
  assert.deepEqual(given.at(-1), [MAC_MORE], '预览里工具栏不变，也没有返回');
});

// 假的客户端：记下 coda.on('toolbar') 的回调，按 { id } 触发。
async function startMac(t) {
  const given = [], events = {};
  const ctx = await start(t, { platform: 'mac', coda: { toolbar: items => given.push(items), on: (name, fn) => { events[name] = fn; } } });
  return { ...ctx, given, press: event => events.toolbar(event) };
}
const tapRow = page => rowNamed(page, 'a.txt').dispatch('click');
const openMore = async (ctx, event = { id: 'more' }) => { ctx.press(event); await flush(); };

test('Mac 按下「更多」：页面弹出菜单，项和 iPhone 的 ⋯ 相同，隐藏文件的对勾不在，贴页面右上角', async t => {
  const ctx = await startMac(t);
  await openMore(ctx);
  const { page } = ctx;
  assert.ok(visible(page.menu));
  assert.deepEqual(items(page).map(node => node.textContent), MORE_ITEMS);
  assert.equal(item(page, '显示隐藏文件').getAttribute('role'), 'menuitemcheckbox');
  assert.equal(item(page, '显示隐藏文件').getAttribute('aria-checked'), 'false');
  assert.match(page.menu.style.left, /^max\(var\(--safe-left\), min\(220px,/, '右边缘 320 减去菜单宽 100');
  assert.match(page.menu.style.top, /min\(4px,/, '贴着顶边，只留 4 点');
});

test('Mac 的「更多」菜单：刷新重新列目录并关菜单；显示隐藏文件切换、关菜单，再打开对勾在；工具栏不重新声明', async t => {
  const ctx = await startMac(t);
  const { page, host, given } = ctx;
  assert.deepEqual(names(page), ['a.txt', 'b.txt']);
  const [lists, declared] = [host.lists().length, given.length];
  await openMore(ctx);
  item(page, '刷新').dispatch('click');
  await flush();
  assert.ok(host.lists().length > lists, '刷新重新列了目录');
  assert.equal(visible(page.menu), false);
  await openMore(ctx);
  item(page, '显示隐藏文件').dispatch('click');
  await flush();
  assert.deepEqual(names(page), ['a.txt', '.git', 'b.txt']);
  assert.equal(visible(page.menu), false);
  await openMore(ctx);
  assert.equal(item(page, '显示隐藏文件').getAttribute('aria-checked'), 'true');
  assert.ok(item(page, '显示隐藏文件').find(node => node.tagName === 'SVG').length > 0, '对勾图标在');
  item(page, '显示隐藏文件').dispatch('click');
  await flush();
  assert.deepEqual(names(page), ['a.txt', 'b.txt']);
  assert.equal(given.length, declared, '状态都在菜单里，工具栏不用再声明');
});

test('Mac 菜单开着时再按「更多」是关闭，再按一次又打开；点菜单外只关菜单', async t => {
  const ctx = await startMac(t);
  const { page } = ctx;
  await openMore(ctx);
  assert.ok(visible(page.menu));
  await openMore(ctx);
  assert.equal(visible(page.menu), false);
  await openMore(ctx);
  assert.ok(visible(page.menu));
  page.tree.dispatch('pointerdown', { pointerId: 1, isPrimary: true });
  assert.equal(visible(page.menu), false);
});

test('Mac 的工具栏事件：只认 id 为 more，别的什么都不做', async t => {
  const { page, host, given, press } = await startMac(t);
  const [lists, declared] = [host.lists().length, given.length];
  for (const event of [{ id: 'refresh' }, { id: 'hidden' }, { id: 'back' }, { id: 'other' }, { id: 'more2' }, {}, undefined]) press(event);
  await flush();
  assert.equal(visible(page.menu), false);
  assert.equal(host.lists().length, lists);
  assert.equal(given.length, declared);
  assert.deepEqual(names(page), ['a.txt', 'b.txt']);
});

test('Mac 的「更多」菜单开着时切会话：菜单关闭，再按是打开', async t => {
  const ctx = await startMac(t);
  await openMore(ctx);
  ctx.host.session('s2', '/other');
  await flush();
  assert.equal(visible(ctx.page.menu), false);
  await openMore(ctx);
  assert.ok(visible(ctx.page.menu));
});

test('iPhone 不声明 coda.toolbar，用页内工具条', async t => {
  let declared = 0;
  const { page } = await start(t, { platform: 'ios', coda: { toolbar: () => { declared++; } } });
  assert.equal(declared, 0);
  assert.ok(visible(page.bar));
});

test('菜单开着时工具条重画（根目录从不可用变成 ready）：菜单关闭，新的 ⋯ 再激活是打开', async t => {
  const { page, host } = await start(t);
  host.generation++;
  page.post({ type: 'session', generation: host.generation, session: 's2' });
  page.post({ type: 'root', generation: host.generation, state: 'preparing', path: '/x' });
  await flush();
  parts(page).more.dispatch('click');
  assert.ok(visible(page.menu));
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/work/ready' });
  await flush();
  assert.equal(parts(page).title.textContent, 'ready');
  assert.equal(visible(page.menu), false);
  assert.equal(parts(page).more.getAttribute('aria-expanded'), 'false');
  parts(page).more.dispatch('click');
  assert.ok(visible(page.menu));
  parts(page).more.dispatch('click');
  assert.equal(visible(page.menu), false);
});
