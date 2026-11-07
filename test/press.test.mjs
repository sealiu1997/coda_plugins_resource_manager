// 按下反馈（第 17.3 节）：press.mjs 的状态机，经真实的页面入口、真实的 tree.mjs 和 grid.mjs，配假 DOM 和假定时器。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { cellNamed, startGrid, startMac } from './support/finder.mjs';
import { openTree, rowNamed, rowsOf } from './support/treehost.mjs';

const listing = { '': ['dir/', 'a.txt', 'b.txt', { name: 'to', kind: 'link' }], dir: ['x.txt'] };
const touch = (extra = {}) => ({ pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, clientX: 50, clientY: 60, ...extra });
const mouse = (extra = {}) => ({ pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: 50, clientY: 60, ...extra });
const pressed = page => [...page.tree.find(node => node.classList.contains('pressed')), ...page.grid.find(node => node.classList.contains('pressed')),
  ...page.bar.find(node => node.classList.contains('pressed')), ...page.menu.find(node => node.classList.contains('pressed'))];
const names = page => pressed(page).map(node => node.dataset.path ?? node.getAttribute('aria-label') ?? node.textContent);

async function start(t, options = {}) {
  const ctx = await openTree(t, { listing, motion: { reduce: false }, ...options });
  ctx.host.session();
  await flush();
  return ctx;
}

test('鼠标按下：立刻有 .pressed；松开后至少显示 100 毫秒，到点才去掉（Mac 不加淡出）', async t => {
  const { page, tick } = await start(t, { platform: 'mac' });
  const row = rowNamed(page, 'a.txt');
  row.dispatch('pointerdown', mouse());
  assert.deepEqual(names(page), ['a.txt'], '按下的那一刻就有');
  tick(40);
  row.dispatch('pointerup', mouse());
  assert.deepEqual(names(page), ['a.txt'], '没到 100 毫秒：松开了也还在');
  tick(59);
  assert.deepEqual(names(page), ['a.txt']);
  tick(1);
  assert.deepEqual(names(page), [], '到 100 毫秒去掉');
});

test('正常抬起时已经显示够久：马上去掉；iPhone 的 .fade 在去掉的同时加上，约 200 毫秒后摘掉', async t => {
  const { page, tick } = await start(t);
  const row = rowNamed(page, 'a.txt');
  row.dispatch('pointerdown', touch());
  tick(80);
  assert.deepEqual(names(page), ['a.txt']);
  tick(100);
  row.dispatch('pointerup', touch());
  assert.deepEqual(names(page), []);
  assert.ok(row.classList.contains('fade'), '正常抬起：淡出');
  tick(199);
  assert.ok(row.classList.contains('fade'));
  tick(1);
  assert.equal(row.classList.contains('fade'), false);
});

test('触摸：按下后 80 毫秒才亮；之前就正常抬起（快点一下）在抬起时补上，同样至少显示 100 毫秒', async t => {
  const { page, tick } = await start(t);
  const row = rowNamed(page, 'a.txt');
  row.dispatch('pointerdown', touch());
  tick(79);
  assert.deepEqual(names(page), [], '80 毫秒前不亮');
  tick(1);
  assert.deepEqual(names(page), ['a.txt']);
  row.dispatch('pointerup', touch());
  tick(99);
  assert.deepEqual(names(page), ['a.txt'], '亮起后至少 100 毫秒');
  tick(1);
  assert.deepEqual(names(page), []);

  rowNamed(page, 'b.txt').dispatch('pointerdown', touch());
  tick(30);
  rowNamed(page, 'b.txt').dispatch('pointerup', touch());
  assert.deepEqual(names(page), ['b.txt'], '快点：抬起时补上');
  tick(99);
  assert.deepEqual(names(page), ['b.txt']);
  tick(1);
  assert.deepEqual(names(page), []);
});

test('作废（80 毫秒前）：移动超过 10 点、滚动、pointercancel、拖动、右键菜单，之后也不会补亮', async t => {
  const { page, tick } = await start(t);
  const cases = {
    移动超过十点: () => page.tree.dispatch('pointermove', touch({ clientX: 50, clientY: 71 })),
    滚动: () => page.tree.dispatch('scroll'),
    pointercancel: () => page.tree.dispatch('pointercancel', touch()),
    拖动开始: () => page.tree.dispatch('dragstart', touch()),
    弹出菜单: () => page.tree.dispatch('contextmenu', touch()),
  };
  for (const [name, cancel] of Object.entries(cases)) {
    rowNamed(page, 'a.txt').dispatch('pointerdown', touch());
    tick(40);
    cancel();
    tick(500);
    assert.deepEqual(names(page), [], `${name}：不补亮`);
  }
  rowNamed(page, 'a.txt').dispatch('pointerdown', touch());
  tick(40);
  page.tree.dispatch('pointermove', touch({ clientX: 55, clientY: 63 }));
  tick(40);
  assert.deepEqual(names(page), ['a.txt'], '没超过 10 点的小抖动不算');
});

test('作废（亮起后）：立即去掉，不淡出，不受最短时间限制', async t => {
  const { page, tick } = await start(t);
  for (const cancel of [() => page.tree.dispatch('scroll'), () => page.tree.dispatch('pointercancel', touch()), () => page.tree.dispatch('pointermove', touch({ clientX: 80, clientY: 60 }))]) {
    const row = rowNamed(page, 'a.txt'); // 滚动会重画行：每次重新取
    row.dispatch('pointerdown', touch());
    tick(80);
    assert.deepEqual(names(page), ['a.txt']);
    cancel();
    assert.deepEqual(names(page), [], '立即去掉');
    assert.equal(row.classList.contains('fade'), false, '作废不淡出');
    tick(500);
  }
});

test('长按弹出菜单：按下反馈立即去掉', async t => {
  const { page, tick } = await start(t);
  rowNamed(page, 'a.txt').dispatch('pointerdown', touch());
  tick(100);
  assert.deepEqual(names(page), ['a.txt']);
  tick(400);
  assert.ok(visible(page.menu), '长按到点，菜单出来');
  assert.deepEqual(names(page), []);
});

test('第二根手指、窗口失焦、页面隐藏、换会话：清掉', async t => {
  const { page, host, tick } = await start(t);
  const down = () => { rowNamed(page, 'a.txt').dispatch('pointerdown', touch()); tick(80); assert.deepEqual(names(page), ['a.txt']); };
  down();
  rowNamed(page, 'b.txt').dispatch('pointerdown', touch({ pointerId: 2, isPrimary: false }));
  assert.deepEqual(names(page), [], '第二根手指');
  down();
  globalThis.window.emit({ type: 'blur' });
  assert.deepEqual(names(page), [], '窗口失焦');
  down();
  globalThis.document.hidden = true;
  globalThis.document.emit({ type: 'visibilitychange' });
  assert.deepEqual(names(page), [], '页面隐藏');
  globalThis.document.hidden = false;
  down();
  host.events.visibility(false);
  assert.deepEqual(names(page), [], 'visibility: false');
  down();
  host.session('s2', '/B');
  await flush();
  assert.deepEqual(names(page), [], '换会话');
});

test('禁用的按钮没有按下反馈，别的按钮有；.dead 的条目有', async t => {
  const { page } = await start(t, { platform: 'mac' });
  const dead = rowNamed(page, 'to');
  assert.ok(dead.classList.contains('dead'));
  dead.dispatch('pointerdown', mouse());
  assert.deepEqual(names(page), ['to'], '.dead 的条目能选中、能右键，也有反馈');
  dead.dispatch('pointerup', mouse());
  const button = page.bar.find(node => node.tagName === 'BUTTON')[0] ?? page.preview.find(node => node.tagName === 'BUTTON')[0];
  assert.ok(button, '页内工具条有按钮');
  button.setAttribute('disabled', '');
  button.dispatch('pointerdown', mouse());
  assert.equal(button.classList.contains('pressed'), false, '禁用');
  button.attributes.delete('disabled');
  button.dispatch('pointerdown', mouse());
  assert.ok(button.classList.contains('pressed'));
});

test('工具条和菜单项的按钮也有按下反馈', async t => {
  const { page } = await start(t);
  const more = page.bar.find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === '更多')[0];
  assert.ok(more);
  more.dispatch('pointerdown', touch());
  globalThis.window.emit({ type: 'blur' });
  more.dispatch('click');
  assert.ok(visible(page.menu));
  const item = page.menu.find(node => node.tagName === 'BUTTON')[0];
  item.dispatch('pointerdown', mouse());
  assert.ok(item.classList.contains('pressed'));
});

test('虚拟列表重画：新节点带上 .pressed；同一路径的条目、「重试」说明行、「再显示」不串', async t => {
  const { page, host, tick } = await start(t, { platform: 'mac' });
  host.listing.dir = ['x.txt'];
  host.failing.add('dir');
  const chev = rowNamed(page, 'dir').find(node => node.classList.contains('chev'))[0];
  chev.dispatch('click', mouse());
  await flush();
  const retry = rows => rows.find(node => node.classList.contains('retry'));
  const rows = () => rowsOf(page);
  assert.ok(retry(rows()), '展开失败：目录下出现重试行');
  const entry = rowNamed(page, 'dir');
  entry.dispatch('pointerdown', mouse());
  tick(1);
  assert.deepEqual(names(page), ['dir']);
  // 重画：节点全部换新
  host.changed();
  await flush();
  const fresh = rowNamed(page, 'dir');
  assert.notEqual(fresh, entry, '节点换过了');
  assert.ok(fresh.classList.contains('pressed'), '新节点带上 .pressed');
  assert.deepEqual(rows().filter(node => node.classList.contains('pressed')).map(node => node.className.split(' ')[1]), ['entry'], '同路径的重试行没有');
  fresh.dispatch('pointerup', mouse());
  tick(100);
  assert.deepEqual(names(page), []);
  // 按下重试行：只有重试行亮，同路径的条目不亮
  retry(rows()).dispatch('pointerdown', mouse());
  assert.deepEqual(rows().filter(node => node.classList.contains('pressed')).map(node => node.classList.contains('retry')), [true]);
  host.changed();
  await flush();
  assert.deepEqual(rows().filter(node => node.classList.contains('pressed')).map(node => node.classList.contains('retry')), [true], '重画后仍只有重试行');
});

test('重画时会话或根目录身份变了：不带回 .pressed', async t => {
  const { page, host, tick } = await start(t, { platform: 'mac' });
  rowNamed(page, 'a.txt').dispatch('pointerdown', mouse());
  assert.deepEqual(names(page), ['a.txt']);
  // 同一个路径、换了根目录（scope 变）：重画出来的 a.txt 不是被按的那个
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/other' });
  await flush();
  tick(1);
  assert.deepEqual(names(page), [], '换了根目录，旧的按下不带过去');
});

test('图标视图：格子和说明行也有 .pressed，重画后带上', async t => {
  const ctx = await startGrid(t, { motion: { reduce: false } });
  const cell = cellNamed(ctx.page, 'f1.txt');
  cell.dispatch('pointerdown', mouse());
  assert.ok(cell.classList.contains('pressed'));
  ctx.host.changed();
  await flush();
  const fresh = cellNamed(ctx.page, 'f1.txt');
  assert.ok(fresh.classList.contains('pressed'), '重画后新节点带上');
});

test('菜单开着：按另一个条目、按空白、按打开菜单的 ⋯，都只关菜单：没有按下反馈（iPhone）', async t => {
  const { page, tick } = await start(t);
  const more = () => page.bar.find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === '更多')[0];
  const openMenu = () => { more().dispatch('click'); assert.ok(visible(page.menu)); };
  openMenu();
  rowNamed(page, 'b.txt').dispatch('pointerdown', touch());
  tick(100);
  assert.equal(visible(page.menu), false, '菜单关了');
  assert.deepEqual(names(page), [], '按另一个条目：没有反馈');
  rowNamed(page, 'b.txt').dispatch('pointerup', touch());
  rowNamed(page, 'b.txt').dispatch('click'); // 被菜单吞掉的点击：浏览器照常发，吞完才能再点别的
  openMenu();
  page.tree.dispatch('pointerdown', touch());
  tick(100);
  assert.equal(visible(page.menu), false);
  assert.deepEqual(names(page), [], '按空白');
  page.tree.dispatch('pointerup', touch());
  page.tree.dispatch('click');
  openMenu();
  more().dispatch('pointerdown', touch());
  tick(100);
  assert.equal(visible(page.menu), false);
  assert.deepEqual(names(page), [], '按打开菜单的 ⋯：只关菜单');
});

test('减弱动态效果：按下反馈照常，只是没有淡出', async t => {
  const { page, tick } = await start(t, { motion: { reduce: true } });
  const row = rowNamed(page, 'a.txt');
  row.dispatch('pointerdown', touch());
  tick(80);
  assert.deepEqual(names(page), ['a.txt']);
  tick(100);
  row.dispatch('pointerup', touch());
  assert.deepEqual(names(page), []);
  assert.equal(row.classList.contains('fade'), false);
});

test('Mac 的按下：右键和按住 Control 的左键不加反馈', async t => {
  const { page } = await start(t, { platform: 'mac' });
  rowNamed(page, 'a.txt').dispatch('pointerdown', mouse({ button: 2 }));
  assert.deepEqual(names(page), []);
  rowNamed(page, 'a.txt').dispatch('pointerdown', mouse({ ctrlKey: true }));
  assert.deepEqual(names(page), []);
});

test('Mac 页面里的 startMac 也装上按下反馈（同一个入口）', async t => {
  const { page } = await startMac(t);
  rowNamed(page, 'a.txt').dispatch('pointerdown', mouse());
  assert.deepEqual(names(page), ['a.txt']);
});

test('触摸等待显示期间重画：80 毫秒到时新节点亮（旧节点已脱离）', async t => {
  const { page, host, tick } = await start(t);
  const old = rowNamed(page, 'a.txt');
  old.dispatch('pointerdown', touch());
  tick(20);
  host.changed();
  await flush();
  const fresh = rowNamed(page, 'a.txt');
  assert.notEqual(fresh, old, '节点换过了');
  tick(60);
  assert.ok(fresh.classList.contains('pressed'), '新节点亮');
  assert.equal(old.classList.contains('pressed'), false);
});

test('触摸快点：重画后才抬起，补亮在新节点上', async t => {
  const { page, host, tick } = await start(t);
  const old = rowNamed(page, 'a.txt');
  old.dispatch('pointerdown', touch());
  tick(20);
  host.changed();
  await flush();
  const fresh = rowNamed(page, 'a.txt');
  fresh.dispatch('pointerup', touch());
  assert.ok(fresh.classList.contains('pressed'), '抬起时补在新节点上');
  assert.equal(old.classList.contains('pressed'), false);
});

test('按下淡出进行中系统改成减弱动态效果：淡出结束到终点，定时器清掉', async t => {
  const { page, tick } = await start(t);
  const row = rowNamed(page, 'a.txt');
  row.dispatch('pointerdown', touch());
  tick(80);
  tick(100);
  row.dispatch('pointerup', touch());
  assert.ok(row.classList.contains('fade'));
  page.motion.set(true);
  assert.equal(row.classList.contains('fade'), false, '淡出结束');
  assert.equal(names(page).length, 0);
});

test('仍按着时改成减弱动态效果：反馈保留', async t => {
  const { page, tick } = await start(t);
  const row = rowNamed(page, 'a.txt');
  row.dispatch('pointerdown', touch());
  tick(80);
  page.motion.set(true);
  assert.deepEqual(names(page), ['a.txt']);
});
