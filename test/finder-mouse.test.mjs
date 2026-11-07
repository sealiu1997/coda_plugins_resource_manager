// Mac 的鼠标（第 15.10 节）：列表视图里单击只选中、双击打开或展开、箭头、空白、说明行、右键的「打开」；选中不重画也会保存；iPhone 不变。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountGestures } from '../view/gestures.mjs';
import { Element, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { LISTING, doubleClick, drain, press, savedOf, selectedRows, startMac, clickOn } from './support/finder.mjs';
import { rowNamed, rowsOf } from './support/treehost.mjs';

const reads = host => host.sent.filter(m => m.type === 'read');
const pickItem = (page, label) => page.menu.find(node => node.tagName === 'BUTTON').find(node => node.textContent === label);
const labels = page => page.menu.find(node => node.tagName === 'BUTTON').map(node => node.textContent);

test('单击只选中：文件、文件夹、不能打开的条目都不打开、不展开', async t => {
  const { page, host } = await startMac(t);
  for (const name of ['a.txt', 'dir', 'to', 'dev']) {
    clickOn(rowNamed(page, name));
    await flush();
    assert.deepEqual(selectedRows(page), [name], `${name} 选中`);
    assert.equal(reads(host).length, 0);
    assert.equal(visible(page.preview), false);
    assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'false');
  }
});

test('双击文件在侧栏打开预览，选中的就是它；双击文件夹展开、再双击收起；双击不能打开的条目没反应', async t => {
  const { page, host } = await startMac(t);
  await doubleClick(page.tree, rowNamed(page, 'dir'));
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true', '展开恰好一次');
  assert.ok(rowNamed(page, 'x.txt'));
  await doubleClick(page.tree, rowNamed(page, 'dir'));
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'false', '收起');
  for (const name of ['to', 'dev']) {
    await doubleClick(page.tree, rowNamed(page, name));
    assert.equal(visible(page.tree), true, `${name} 双击没反应`);
    assert.equal(reads(host).length, 0);
  }
  assert.equal(host.lists().filter(m => m.path === 'dir').length, 1, '展开只取了一次');
  await doubleClick(page.tree, rowNamed(page, 'a.txt'));
  assert.equal(reads(host).length, 1, '打开恰好一次');
  assert.equal(visible(page.preview), true);
  assert.equal(host.calls.open.length, 0, '不开窗口');
});

test('先单击别的条目再双击这个也对', async t => {
  const { page, host } = await startMac(t);
  clickOn(rowNamed(page, 'b.txt'));
  await flush();
  await doubleClick(page.tree, rowNamed(page, 'a.txt'));
  assert.equal(reads(host).length, 1);
  assert.equal(reads(host)[0].path, 'a.txt');
});

test('选中不重画：节点身份不变，.sel 移到新节点上；两次 click 之后 dblclick 的目标还在容器里', async t => {
  const { page } = await startMac(t);
  const a = rowNamed(page, 'a.txt'), b = rowNamed(page, 'b.txt');
  clickOn(a);
  await flush();
  assert.equal(rowNamed(page, 'a.txt'), a, '同一个节点');
  assert.ok(a.classList.contains('sel'));
  clickOn(b);
  await flush();
  assert.equal(rowNamed(page, 'b.txt'), b);
  assert.deepEqual([a.classList.contains('sel'), b.classList.contains('sel')], [false, true]);
  assert.ok(page.tree.contains(a) && page.tree.contains(b));
});

test('单击箭头展开或收起，选中不变；双击箭头不再多切一次', async t => {
  const { page } = await startMac(t);
  clickOn(rowNamed(page, 'b.txt'));
  const chevron = name => rowNamed(page, name).find(node => node.classList.contains('chev'))[0];
  clickOn(chevron('dir'));
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(selectedRows(page), ['b.txt'], '选中不变');
  chevron('dir').dispatch('dblclick'); // dblclick 落在箭头上：click 已经切过了，不再重复
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true');
  clickOn(chevron('dir'));
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'false', '双击箭头两次 click：回到原状');
  assert.deepEqual(selectedRows(page), ['b.txt']);
});

test('单击空白处取消选中；点在条目上不算空白', async t => {
  const { page } = await startMac(t);
  clickOn(rowNamed(page, 'a.txt'));
  assert.deepEqual(selectedRows(page), ['a.txt']);
  clickOn(page.tree);
  await flush();
  assert.deepEqual(selectedRows(page), []);
});

test('说明行（重试）单击照旧立即执行，不用双击', async t => {
  const { page, host } = await startMac(t);
  await doubleClick(page.tree, rowNamed(page, 'dir'));
  host.failing.add('dir');
  host.changed();
  await flush();
  const failed = rowsOf(page).find(node => node.textContent.startsWith('更新失败'));
  assert.ok(failed);
  host.failing.clear();
  const before = host.lists().length;
  clickOn(failed);
  await flush();
  assert.deepEqual(host.lists().slice(before).map(m => m.path), ['dir'], '单击就重试');
});

test('右键：不改选中；菜单第一项「打开」「展开」「收起」各自生效；不能打开的条目没有这一项', async t => {
  const { page, host } = await startMac(t);
  clickOn(rowNamed(page, 'b.txt'));
  const right = name => rowNamed(page, name).dispatch('contextmenu', { clientX: 5, clientY: 6 });
  right('dir');
  assert.deepEqual(selectedRows(page), ['b.txt'], '右键不改选中');
  assert.equal(labels(page)[0], '展开');
  pickItem(page, '展开').dispatch('click');
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(selectedRows(page), ['b.txt']);
  right('dir');
  assert.equal(labels(page)[0], '收起');
  pickItem(page, '收起').dispatch('click');
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'false');
  for (const name of ['to', 'dev']) {
    right(name);
    assert.equal(labels(page).includes('打开'), false, `${name} 没有打开`);
    assert.equal(labels(page)[0], '复制相对路径');
  }
  right('a.txt');
  assert.equal(labels(page)[0], '打开');
  pickItem(page, '打开').dispatch('click');
  await flush();
  assert.equal(reads(host)[0]?.path, 'a.txt');
  assert.equal(visible(page.preview), true);
});

test('选中会保存：页面稳定后单击、取消选中、键盘移动，过了保存的延迟，setState 存的是新的 selected', async t => {
  const ctx = await startMac(t);
  const { page, tick, saves } = ctx;
  await drain(ctx);
  const before = saves.length;
  clickOn(rowNamed(page, 'b.txt'));
  assert.equal(saves.length, before, '还没到延迟');
  tick(300);
  assert.equal(savedOf(ctx).selected, 'b.txt');
  clickOn(page.tree);
  tick(300);
  assert.equal(savedOf(ctx).selected, null, '取消选中也保存');
  press(page.tree, 'ArrowDown');
  tick(300);
  assert.equal(savedOf(ctx).selected, 'dir');
  assert.equal(savedOf(ctx).opened, null);
  assert.equal(saves.length, before + 3);
});

test('选中同一个路径什么都不做：不重新保存', async t => {
  const ctx = await startMac(t);
  clickOn(rowNamed(ctx.page, 'b.txt'));
  ctx.tick(300);
  const count = ctx.saves.length;
  clickOn(rowNamed(ctx.page, 'b.txt'));
  ctx.tick(300);
  assert.equal(ctx.saves.length, count);
});

test('iPhone：轻点打开（文件夹展开、文件在页内预览，不调 coda.open），dblclick 不触发任何东西', async t => {
  const { page, host } = await startMac(t, { platform: 'ios' });
  clickOn(rowNamed(page, 'dir'));
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true');
  rowNamed(page, 'dir').dispatch('dblclick');
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true', 'dblclick 不再切');
  rowNamed(page, 'b.txt').dispatch('dblclick');
  await flush();
  assert.equal(host.reads().length, 0);
  clickOn(rowNamed(page, 'a.txt'));
  await flush();
  assert.equal(host.reads().length, 1, '页内预览读一次');
  assert.deepEqual(host.calls.open, [], '不再推入文件页');
  assert.equal(visible(page.preview), true);
  assert.equal(visible(page.tree), false);
});

test('iPhone 长按菜单没有「打开」', async t => {
  const { page, tick } = await startMac(t, { platform: 'ios' });
  rowNamed(page, 'a.txt').dispatch('pointerdown', { pointerId: 1, isPrimary: true, clientX: 5, clientY: 6 });
  tick(500);
  assert.equal(labels(page).includes('打开'), false);
});

test('键盘接口只有 Mac：Mac 的滚动容器可以获得焦点，iPhone 不加 tabindex', async t => {
  const { page } = await startMac(t, { platform: 'ios' });
  assert.equal(page.tree.tabIndex, undefined, 'iPhone 不加 tabindex');
  const mac = await startMac(t);
  assert.equal(mac.page.tree.tabIndex, 0, 'Mac 的滚动容器可以获得焦点');
});

// ---- 手势层：箭头和说明项的规则 ----

function gestureHost({ withSelect = true } = {}) {
  const el = new Element('div'), row = new Element('div'), chev = new Element('span'), calls = [];
  row.append(chev);
  el.append(row);
  const items = { entry: { type: 'entry', n: 'e' }, status: { type: 'status', n: 's' } };
  mountGestures(el, {
    hit: event => (event.target === chev || event.target === row ? items.entry : event.target === el ? undefined : undefined),
    pressable: item => item.type === 'entry',
    activate: item => calls.push(['activate', item.n]),
    ...(withSelect ? { select: item => calls.push(['select', item?.n ?? null]) } : {}),
    direct: event => event.target === chev,
    menu: () => {}, dragText: () => '',
  });
  return { el, row, chev, calls };
}

test('gestures：Mac 模式按下条目就选中（click 不再选）、双击条目激活；箭头在 click 时激活、按下不选中、双击不再激活；按下空白取消选中', () => {
  const { el, row, chev, calls } = gestureHost();
  const down = node => node.dispatch('pointerdown', { button: 0, pointerId: 1 });
  down(row);
  assert.deepEqual(calls, [['select', 'e']], '按下的那一刻就选中了，还没有 click');
  row.dispatch('click');
  row.dispatch('dblclick');
  down(chev);
  chev.dispatch('click');
  chev.dispatch('dblclick');
  down(el);
  el.dispatch('click');
  assert.deepEqual(calls, [['select', 'e'], ['activate', 'e'], ['activate', 'e'], ['select', null]], 'click 里不再重复选中');
});

test('gestures：没有 select（iPhone）单击就激活，不监听 dblclick', () => {
  const { row, calls } = gestureHost({ withSelect: false });
  row.dispatch('click');
  row.dispatch('dblclick');
  assert.deepEqual(calls, [['activate', 'e']]);
});
