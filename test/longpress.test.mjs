// iPhone 长按菜单和防连点：真实的 app.mjs 和 tree.mjs，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { openTree, rowNamed } from './support/treehost.mjs';

const LONG = 'very-long-file-name-that-does-not-fit-in-one-row-on-a-phone.txt';
const listing = { '': ['dir/', 'a.txt', 'b.txt', LONG], dir: ['inner.txt'] };
const touch = (extra = {}) => ({ pointerId: 1, isPrimary: true, clientX: 50, clientY: 60, ...extra });

async function start(t, options) {
  const ctx = await openTree(t, { listing, ...options });
  ctx.host.session();
  await flush();
  return ctx;
}
const down = (page, name, extra) => rowNamed(page, name).dispatch('pointerdown', touch(extra));
const click = (page, name) => rowNamed(page, name).dispatch('click');
const escape = () => globalThis.document.emit({ type: 'keydown', key: 'Escape' });

test('长按：按住 500 毫秒打开菜单，写完整相对路径，复制按钮可用；没到时间不开', async t => {
  const { page, host, tick } = await start(t);
  down(page, LONG);
  tick(499);
  assert.equal(visible(page.menu), false);
  tick(1);
  assert.ok(visible(page.menu));
  assert.equal(page.menu.find(node => node.classList.contains('menu-path'))[0].textContent, LONG, '长文件名在菜单里看全');
  const buttons = page.menu.find(node => node.tagName === 'BUTTON').map(node => node.textContent);
  assert.deepEqual(buttons, ['添加到聊天', '复制相对路径', '复制绝对路径', '属性']);
  assert.match(page.menu.style.left, /var\(--safe-left\)/);
  assert.match(page.menu.style.top, /var\(--safe-bottom\)/);
  page.menu.find(node => node.textContent === '复制相对路径')[0].dispatch('click');
  assert.deepEqual(host.calls.copy, [LONG]);
  assert.equal(visible(page.menu), false);
});

test('长按：目录也能复制路径，触发后的点击不展开', async t => {
  const { page, tick } = await start(t);
  down(page, 'dir');
  tick(500);
  assert.equal(page.menu.find(node => node.classList.contains('menu-path'))[0].textContent, 'dir');
  click(page, 'dir');
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'false');
});

test('长按作废：移动超过 10 点、抬起、取消、滚动、第二根手指，都不开菜单', async t => {
  const { page, tick } = await start(t);
  const cases = {
    '移动超过阈值': () => rowNamed(page, 'a.txt').dispatch('pointermove', touch({ clientX: 50, clientY: 71 })),
    '抬起': () => rowNamed(page, 'a.txt').dispatch('pointerup', touch()),
    '取消（滚动接管）': () => rowNamed(page, 'a.txt').dispatch('pointercancel', touch()),
    '滚动': () => page.tree.dispatch('scroll'),
    '第二根手指': () => rowNamed(page, 'b.txt').dispatch('pointerdown', touch({ pointerId: 2, isPrimary: false })),
  };
  for (const [name, cancel] of Object.entries(cases)) {
    down(page, 'a.txt');
    tick(300);
    cancel();
    tick(500);
    assert.equal(visible(page.menu), false, name);
  }
  // 阈值以内的抖动不算移动
  down(page, 'a.txt');
  rowNamed(page, 'a.txt').dispatch('pointermove', touch({ clientX: 56, clientY: 68 }));
  tick(500);
  assert.ok(visible(page.menu), '移动 10 点以内仍然触发');
});

test('长按只作用于树的行：「再显示」「更新失败」这类行按住不开菜单', async t => {
  const { page, host, tick } = await start(t);
  host.failing.add('');
  host.changed();
  await flush();
  down(page, '更新失败');
  tick(500);
  assert.equal(visible(page.menu), false);
});

test('触发后紧接着的点击不打开文件，下一次独立点击正常；没有点击跟来时也不误吞后面的', async t => {
  const { page, host, tick } = await start(t, { back: true });
  down(page, 'a.txt');
  tick(500);
  rowNamed(page, 'a.txt').dispatch('pointerup', touch());
  click(page, 'a.txt');
  await flush();
  assert.equal(host.reads().length, 0, '被吞掉');
  escape(); // 菜单开着时点别处只会关菜单，先关掉

  down(page, 'a.txt'); // 下一次独立点击
  rowNamed(page, 'a.txt').dispatch('pointerup', touch());
  click(page, 'a.txt');
  await flush();
  assert.equal(host.reads().length, 1);
  host.back(); // 关预览回到目录

  tick(1000);
  down(page, 'b.txt'); // 触发了，但系统没有送来点击
  tick(500);
  rowNamed(page, 'b.txt').dispatch('pointerup', touch());
  escape();
  down(page, 'b.txt'); // 之后的新一次点击不受影响
  rowNamed(page, 'b.txt').dispatch('pointerup', touch());
  click(page, 'b.txt');
  await flush();
  assert.equal(host.reads().length, 2);
});

test('Mac 不启用长按（仍用右键）', async t => {
  const { page, tick } = await start(t, { platform: 'mac' });
  down(page, 'a.txt');
  tick(500);
  assert.equal(visible(page.menu), false);
  rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 10, clientY: 10 });
  assert.ok(visible(page.menu));
});

test('快速两次轻点：第一次切到预览，目录树不再接指针事件（.off），只读一次；不调 coda.open', async t => {
  const { page, host } = await start(t, { back: true });
  click(page, 'a.txt');
  await flush();
  click(page, 'a.txt'); // 假 DOM 不模拟 pointer-events：第二次仍会到达 openFile，这里只证明重复打开同一个文件是幂等的
  await flush();
  assert.ok(visible(page.preview));
  assert.ok(page.browse.classList.contains('off') && page.tree.inert, '浏览区 off、树 inert：真实的第二次轻点落在预览上（指针事件由 harness 验证）');
  assert.equal(host.reads().length, 1);
  assert.equal(host.calls.open.length, 0);
});
