// 菜单开着时按 Esc（第 18.5 节）：菜单先处理，关菜单并消费掉这个 Esc，查找条不关。真浏览器里 keydown 的传播顺序是
// document 捕获 → 目标 → 冒泡经过预览元素 → document 冒泡，菜单的监听要在捕获阶段才一定先于预览元素的监听标上「已消费」。
// 这里同时挂真实的菜单和真实的预览（接法同 file-app.mjs：consumed 用 menu.consumed），事件走假 DOM 里和浏览器一致的传播顺序（test/support/dom.mjs）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountMenu } from '../view/menu.mjs';
import { mountPreview } from '../view/preview.mjs';
import { Element } from './support/dom.mjs';
import { open } from './support/filepage.mjs';
import { installHighlights } from './support/highlights.mjs';

async function wired(t) {
  const env = installHighlights(t);
  await open(t, { path: 'x.txt', files: {} }); // 只为装好假 DOM 的全局
  const files = { 'a.txt': 'foo foo' };
  const read = async path => { const data = Buffer.from(files[path]); return { data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 1, kind: 'text', eof: true }; };
  const root = new Element('div'), sub = new Element('div'), el = new Element('div');
  root.hidden = sub.hidden = true;
  const menu = mountMenu(root, sub);
  const preview = mountPreview(el, { read, copy() {}, consumed: menu.consumed });
  await preview.open('a.txt');
  preview.openFind();
  const input = el.find(n => n.classList.contains('finput'))[0], body = el.find(n => n.classList.contains('pbody'))[0];
  input.value = 'foo';
  input.dispatch('input');
  t.mock.timers.tick(150);
  return { env, menu, preview, el, input, body };
}
const esc = (target, extra = {}) => { let prevented = false; target.dispatch('keydown', { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() { prevented = true; }, ...extra }); return { get prevented() { return prevented; } }; };

test('菜单开着、查找条开着：焦点在查找输入框里按 Esc，只关菜单；查找条、搜索词、标记都还在；再按一次才关查找条', async t => {
  const { env, menu, preview, input } = await wired(t);
  assert.equal(env.registry.get('find').size, 2);
  input.focus();
  menu.open({ clientX: 5, clientY: 5 }, { items: [{ label: '复制', run() {} }] }); // 从选中文字打开的右键菜单
  assert.equal(menu.hidden, false);
  const first = esc(input);
  assert.equal(first.prevented, true, '拦下默认动作：type=search 的输入框按 Esc 会自己清空');
  assert.equal(menu.hidden, true, '菜单关了');
  assert.equal(preview.findOpen, true, '查找条没关');
  assert.equal(input.value, 'foo', '搜索词还在');
  assert.equal(env.registry.get('find').size, 2, '标记还在');
  esc(input);
  assert.equal(preview.findOpen, false, '菜单已经关了：这一次 Esc 才关查找条');
  assert.equal(env.registry.size, 0);
});

test('菜单开着、焦点在正文里按 Esc：同样只关菜单', async t => {
  const { env, menu, preview, body } = await wired(t);
  body.focus();
  menu.open({ clientX: 5, clientY: 5 }, { items: [{ label: '复制', run() {} }] });
  esc(body);
  assert.equal(menu.hidden, true);
  assert.equal(preview.findOpen, true);
  assert.equal(env.registry.get('find').size, 2);
});

test('Esc 关菜单时 hide(true) 交还焦点之后，同一个事件仍派发到原目标：原目标上的监听看到已消费，什么都不做', async t => {
  const { menu, preview, input } = await wired(t);
  const opener = new Element('button');
  input.focus();
  menu.open(opener, { items: [{ label: '复制', run() {} }] }); // 有按钮的菜单：Esc 关时焦点回按钮
  let seen = null;
  input.addEventListener('keydown', event => { seen = menu.consumed(event); });
  esc(input);
  assert.equal(document.activeElement, opener, '焦点交回了按钮');
  assert.equal(seen, true, '原目标收到事件时 consumed 为真');
  assert.equal(preview.findOpen, true);
});

test('输入法组字中按 Esc：菜单照样先关（菜单不看 isComposing），查找条不动', async t => {
  const { menu, preview, input } = await wired(t);
  menu.open({ clientX: 5, clientY: 5 }, { items: [{ label: '复制', run() {} }] });
  input.dispatch('keydown', { key: 'Escape', isComposing: true, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
  assert.equal(preview.findOpen, true);
});
