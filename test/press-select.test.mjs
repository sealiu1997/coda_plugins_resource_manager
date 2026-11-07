// Mac 按下即选中（第 17.4 节）：选中在 pointerdown 时做，click 只管箭头和说明行；菜单消费的按下、右键、Control 左键不选中；有效的鼠标选中作废待恢复的滚动。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { cellNamed, clickOn, doubleClick, selectedCells, selectedRows, startGrid, startMac } from './support/finder.mjs';
import { rowNamed } from './support/treehost.mjs';

const down = (node, extra = {}) => node.dispatch('pointerdown', { button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra });
const chevOf = node => node.find(child => child.classList.contains('chev'))[0];

test('按下的那一刻条目就选中了（松开之前）；按下空白取消选中；click 里不再选', async t => {
  const { page } = await startMac(t);
  down(rowNamed(page, 'a.txt'));
  assert.deepEqual(selectedRows(page), ['a.txt'], '还没松开、没有 click');
  down(rowNamed(page, 'b.txt'));
  assert.deepEqual(selectedRows(page), ['b.txt']);
  down(page.tree);
  assert.deepEqual(selectedRows(page), [], '按下空白：取消选中');
  rowNamed(page, 'a.txt').dispatch('click');
  assert.deepEqual(selectedRows(page), [], '单独的 click 什么都不选');
});

test('图标视图：按下格子就选中，按下空白取消', async t => {
  const { page } = await startGrid(t);
  down(cellNamed(page, 'f1.txt'));
  assert.deepEqual(selectedCells(page), ['f1.txt']);
  down(page.grid.find(node => node.classList.contains('gbody'))[0]);
  assert.deepEqual(selectedCells(page), []);
});

test('右键和按住 Control 的左键不改选中（Mac 上是右键菜单）', async t => {
  const { page } = await startMac(t);
  down(rowNamed(page, 'a.txt'));
  down(rowNamed(page, 'b.txt'), { button: 2 });
  assert.deepEqual(selectedRows(page), ['a.txt'], '右键');
  down(rowNamed(page, 'b.txt'), { ctrlKey: true });
  assert.deepEqual(selectedRows(page), ['a.txt'], 'Control 左键');
  down(page.tree, { button: 2 });
  assert.deepEqual(selectedRows(page), ['a.txt'], '右键按在空白也不取消');
});

test('菜单开着：按另一个条目、按空白、按打开菜单的按钮，都只关菜单，选中不变', async t => {
  const { page } = await startMac(t);
  down(rowNamed(page, 'a.txt'));
  const open = () => { rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 }); assert.ok(visible(page.menu)); };
  open();
  down(rowNamed(page, 'b.txt'));
  assert.equal(visible(page.menu), false);
  assert.deepEqual(selectedRows(page), ['a.txt'], '按另一个条目：只关菜单');
  rowNamed(page, 'b.txt').dispatch('click');
  open();
  down(page.tree);
  assert.equal(visible(page.menu), false);
  assert.deepEqual(selectedRows(page), ['a.txt'], '按空白：只关菜单');
  page.tree.dispatch('click');
  down(rowNamed(page, 'b.txt'));
  assert.deepEqual(selectedRows(page), ['b.txt'], '菜单关了之后照常选');
});

test('展开箭头、说明行、「再显示」仍在 click 时执行，按下不选中', async t => {
  const { page, host } = await startMac(t);
  down(rowNamed(page, 'a.txt'));
  const chev = chevOf(rowNamed(page, 'dir'));
  down(chev);
  assert.deepEqual(selectedRows(page), ['a.txt'], '按下箭头：选中不变');
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'false', '按下不展开');
  chev.dispatch('click');
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true', 'click 才展开');
  assert.deepEqual(selectedRows(page), ['a.txt']);
  host.failing.add('dir');
  host.changed();
  await flush();
  const retry = page.tree.find(node => node.classList.contains('retry'))[0];
  assert.ok(retry, '展开的目录读失败：出现重试行');
  const before = host.lists().length;
  down(retry);
  assert.equal(host.lists().length, before, '按下重试行不重试');
  assert.deepEqual(selectedRows(page), ['a.txt'], '也不选中');
  retry.dispatch('click');
  await flush();
  assert.ok(host.lists().length > before, 'click 才重试');
});

test('双击仍恰好执行一次，期间行节点身份不变', async t => {
  const { page } = await startMac(t);
  const node = rowNamed(page, 'dir');
  const before = rowNamed(page, 'dir');
  // 浏览器的双击：按下、松开、click，再按下、松开、click、dblclick
  down(node); node.dispatch('pointerup', {}); node.dispatch('click');
  await flush();
  down(node); node.dispatch('pointerup', {}); node.dispatch('click');
  await flush();
  assert.equal(rowNamed(page, 'dir'), before, '两次按下之后选中没有重画：dblclick 的目标节点还在容器里');
  assert.ok(page.tree.contains(node));
  node.dispatch('dblclick');
  await flush();
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'true', '展开一次（再来一次会收起）');
  await doubleClick(page.tree, rowNamed(page, 'dir'));
  assert.equal(rowNamed(page, 'dir').getAttribute('aria-expanded'), 'false', '第二次双击收起');
});

test('拖动带的是按下的那一个：按下已经选中，dragstart 写它的路径', async t => {
  const { page } = await startMac(t);
  const node = rowNamed(page, 'b.txt');
  down(node);
  const data = {};
  node.dispatch('dragstart', { dataTransfer: { setData: (type, text) => { data[type] = text; }, effectAllowed: '' } });
  assert.deepEqual(selectedRows(page), ['b.txt']);
  assert.equal(data['text/plain'], 'b.txt');
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

test('有效的鼠标选中作废还在等的滚动恢复：选中条目、在空白处取消，都算用户接管', async t => {
  for (const act of [ctx => down(rowNamed(ctx.page, 'dir')), ctx => down(ctx.page.tree)]) {
    const ctx = await restoring(t);
    act(ctx);
    await ctx.finish();
    assert.equal(ctx.page.tree.scrollTop, 0, '恢复被作废，位置不被拉走');
  }
});

test('不选中的按下不作废滚动恢复：右键、Control 左键、被菜单消费的按下、按展开箭头', async t => {
  const cases = {
    右键: ctx => down(rowNamed(ctx.page, 'dir'), { button: 2 }),
    Control左键: ctx => down(rowNamed(ctx.page, 'dir'), { ctrlKey: true }),
    箭头: ctx => down(chevOf(rowNamed(ctx.page, 'dir'))),
    菜单消费的按下: ctx => {
      rowNamed(ctx.page, 'f01.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
      assert.ok(visible(ctx.page.menu));
      down(rowNamed(ctx.page, 'f02.txt'));
      assert.equal(visible(ctx.page.menu), false);
    },
  };
  for (const [name, act] of Object.entries(cases)) {
    const ctx = await restoring(t);
    act(ctx);
    await ctx.finish();
    assert.equal(ctx.page.tree.scrollTop, 24 * 20, `${name}：恢复照常`);
  }
});

test('按在滚动条上不取消选中：目标是滚动容器自己、位置在内容区之外；按在内容区空白仍取消', async t => {
  const { page } = await startMac(t);
  down(rowNamed(page, 'a.txt'));
  Object.assign(page.tree, { clientWidth: 285 });
  down(page.tree, { offsetX: 290, offsetY: 40 });
  assert.deepEqual(selectedRows(page), ['a.txt'], '竖向滚动条');
  Object.assign(page.tree, { clientHeight: 100 });
  down(page.tree, { offsetX: 40, offsetY: 105 });
  assert.deepEqual(selectedRows(page), ['a.txt'], '横向滚动条');
  down(page.tree, { offsetX: 40, offsetY: 40 });
  assert.deepEqual(selectedRows(page), [], '内容区空白：取消');
});
