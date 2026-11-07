// 菜单的出现动画（第 17.5 节）：iPhone 根层缩放加淡入，换层只淡入，关闭不做动画；Mac 和减弱动态效果时都没有。动画是桩（test/support/dom.mjs），按调用记录断言。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { openTree } from './support/treehost.mjs';

async function start(t, options = {}) {
  const ctx = await openTree(t, { motion: { reduce: false }, ...options });
  ctx.host.session();
  await flush();
  return ctx;
}
const more = page => page.bar.find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === '更多')[0];
const item = (page, label) => page.menu.find(node => node.tagName === 'BUTTON' && node.textContent === label)[0];
const menuAnims = ctx => ctx.page.motion.animations.filter(anim => anim.el === ctx.page.menu);

test('iPhone 打开菜单：约 150 毫秒，透明度 0→1、缩放 0.96→1', async t => {
  const ctx = await start(t);
  more(ctx.page).dispatch('click');
  assert.ok(visible(ctx.page.menu));
  const [anim] = menuAnims(ctx);
  assert.equal(menuAnims(ctx).length, 1);
  assert.equal(anim.options.duration, 150);
  assert.deepEqual(anim.frames, [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'scale(1)' }]);
});

test('缩放原点：菜单在锚点下方从上沿，在上方从下沿', async t => {
  for (const [menuTop, anchorBottom, origin] of [[40, 24, 'right top'], [0, 200, 'right bottom']]) {
    const ctx = await start(t);
    ctx.page.menu.getBoundingClientRect = () => ({ left: 0, top: menuTop, right: 100, bottom: menuTop + 100, width: 100, height: 100 });
    const button = more(ctx.page);
    button.getBoundingClientRect = () => ({ left: 0, top: anchorBottom - 24, right: 100, bottom: anchorBottom, width: 100, height: 24 });
    button.dispatch('click');
    assert.equal(ctx.page.menu.style.transformOrigin, origin);
  }
});

test('关闭不做动画：hide() 取消还开着的动画，立刻消失', async t => {
  const ctx = await start(t);
  more(ctx.page).dispatch('click');
  const [anim] = menuAnims(ctx);
  globalThis.document.emit({ type: 'keydown', key: 'Escape' });
  assert.equal(visible(ctx.page.menu), false);
  assert.ok(anim.canceled, '取消');
  assert.equal(menuAnims(ctx).length, 1, '关闭没有新动画');
});

test('换层：根层的动画没播完就先停在终点，新的一层只淡入；退回上一层也只淡入', async t => {
  const ctx = await start(t);
  more(ctx.page).dispatch('click');
  const [root] = menuAnims(ctx);
  item(ctx.page, '显示').dispatch('click');
  assert.ok(root.canceled, '根层动画结束到终点（没有 fill：取消就是停在终点）');
  const next = menuAnims(ctx).at(-1);
  assert.notEqual(next, root);
  assert.deepEqual(next.frames, [{ opacity: 0 }, { opacity: 1 }], '只淡入，不缩放');
  const back = ctx.page.menu.find(node => node.classList.contains('menu-back'))[0];
  back.dispatch('click');
  const last = menuAnims(ctx).at(-1);
  assert.ok(next.canceled);
  assert.deepEqual(last.frames, [{ opacity: 0 }, { opacity: 1 }], '切回上一层同样只淡入');
});

test('自然播完之后换层：不再取消什么', async t => {
  const ctx = await start(t);
  more(ctx.page).dispatch('click');
  const [root] = menuAnims(ctx);
  root.finish();
  item(ctx.page, '显示').dispatch('click');
  assert.equal(root.canceled, false);
});

test('Mac 没有菜单动画（原生菜单立刻出现）', async t => {
  const ctx = await start(t, { platform: 'mac' });
  rowsMenu(ctx);
  assert.ok(visible(ctx.page.menu));
  assert.equal(menuAnims(ctx).length, 0);
});
function rowsMenu({ page }) {
  const row = page.tree.find(node => node.classList.contains('row') && node.classList.contains('entry'))[0];
  row.dispatch('contextmenu', { clientX: 5, clientY: 6 });
}

test('减弱动态效果：菜单没有动画；设置中途打开也不播', async t => {
  const ctx = await start(t, { motion: { reduce: true } });
  more(ctx.page).dispatch('click');
  assert.ok(visible(ctx.page.menu));
  assert.equal(menuAnims(ctx).length, 0);
  item(ctx.page, '显示').dispatch('click');
  assert.equal(menuAnims(ctx).length, 0, '换层也没有');
  globalThis.document.emit({ type: 'keydown', key: 'Escape' });
  ctx.page.motion.set(false);
  more(ctx.page).dispatch('click');
  assert.equal(menuAnims(ctx).length, 1, '设置改回来之后又有');
});

test('没有 matchMedia 的环境按减弱动态效果处理，不播', async t => {
  const ctx = await openTree(t);
  ctx.host.session();
  await flush();
  more(ctx.page).dispatch('click');
  assert.ok(visible(ctx.page.menu));
});
