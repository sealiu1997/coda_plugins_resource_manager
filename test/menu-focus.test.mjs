// 菜单关闭后的焦点（第 18.5 节）：⋯ 按钮打开的菜单，Esc 关、选了一项之后焦点回到那个按钮；点外面关不交（点到哪里焦点就在哪里）；右键菜单没有按钮，焦点不动。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountMenu } from '../view/menu.mjs';
import { Element, loadApp } from './support/dom.mjs';

async function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // 页面的握手超时不能留着真实的 30 秒计时器
  const page = await loadApp(t, { platform: 'ios', postMessage() {}, on() {}, getState: () => undefined, setState() {} });
  const root = new Element('div'), sub = new Element('div'); // 页面自己的菜单挂在 #menu 上，这里另用一对元素
  root.hidden = sub.hidden = true;
  const menu = mountMenu(root, sub), opener = new Element('button'), other = new Element('button');
  const ran = [];
  const items = { items: [{ label: '甲', run: () => ran.push({ label: '甲', focus: document.activeElement }) }, { label: '乙', run: () => { other.focus(); ran.push({ label: '乙' }); } }] };
  const item = label => root.find(node => node.textContent === label)[0];
  return { page, menu, opener, other, ran, items, item };
}

test('Esc 关菜单：焦点回到打开它的按钮，这个 Esc 标成已消费', async t => {
  const { menu, opener, other, items } = await setup(t);
  other.focus();
  menu.open(opener, items);
  const event = { type: 'keydown', key: 'Escape', preventDefault() {} };
  document.emit(event);
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, opener);
  assert.equal(menu.consumed(event), true);
});

test('选了一项：焦点先回到按钮，再执行操作（操作自己要移焦点时以操作为准）', async t => {
  const { menu, opener, other, ran, items, item } = await setup(t);
  other.focus();
  menu.open(opener, items);
  item('甲').dispatch('click');
  assert.deepEqual(ran.map(r => [r.label, r.focus === opener]), [['甲', true]], '执行时焦点已经在按钮上');
  assert.equal(document.activeElement, opener);
  menu.open(opener, items);
  item('乙').dispatch('click');
  assert.equal(document.activeElement, other, '操作聚焦别处：以操作为准');
});

test('点菜单外关闭：不交还焦点；滚动、旋转关闭也不交；没有按钮的菜单（右键）焦点不动', async t => {
  const { page, menu, opener, other, items } = await setup(t);
  other.focus();
  menu.open(opener, items);
  document.emit({ type: 'pointerdown', target: other, preventDefault() {} });
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, other, '点到哪里焦点就在哪里');
  menu.open(opener, items);
  menu.hide();
  assert.equal(document.activeElement, other, '页面自己关（滚动、旋转）：不交');
  menu.open({ clientX: 5, clientY: 5 }, items);
  document.emit({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.equal(document.activeElement, other, '右键菜单没有按钮');
  void page;
});

test('resize、blur、滚动关菜单：事件回调不是「交还焦点」（Event 对象是真值，只认 restore === true）', async t => {
  const { menu, opener, other, items } = await setup(t);
  for (const close of [() => window.emit({ type: 'resize' }), () => window.emit({ type: 'blur' }), () => menu.hide({ type: 'scroll' })]) {
    other.focus();
    menu.open(opener, items);
    close();
    assert.equal(menu.hidden, true);
    assert.equal(document.activeElement, other, '焦点留在原处，没有被拉回按钮');
  }
});
