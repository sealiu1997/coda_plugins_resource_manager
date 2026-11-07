// 真实模块（activate）+ 真实 connect()、app.mjs、grid.mjs + 真实临时目录：图标视图里进入目录、列出、回上一层、目录被删，一路走通。
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { loadApp } from './support/dom.mjs';
import { checkoutOf, deferred, fakeCoda, tempDir, waitFor } from './support/fake.mjs';

const body = page => page.grid.find(node => node.classList.contains('gbody'))[0];
const names = page => page.grid.find(node => node.classList.contains('gi')).map(node => node.textContent);
const cell = (page, name) => page.grid.find(node => node.classList.contains('cell') && node.textContent === name)[0];
// Mac：一次完整的双击（浏览器的事件顺序：两次 click，再 dblclick）。
const dbl = node => { node.dispatch('click'); node.dispatch('click'); node.dispatch('dblclick'); };
const head = page => page.grid.find(node => node.classList.contains('ghead'))[0];

async function mountGrid(t, fake, { platform = 'mac', state, saved = [], back } = {}) {
  const view = fake.open('A'), ready = deferred();
  let page;
  view.listen(message => ready.promise.then(() => queueMicrotask(() => page.post(message))));
  const calls = { back: [] }, events = {};
  page = await loadApp(t, {
    platform, postMessage: message => view.send(message), on: (name, fn) => { events[name] = fn; }, copy: () => {},
    ...(back ? { back: titles => calls.back.push(titles) } : {}),
    getState: () => state, setState: value => saved.push(JSON.parse(JSON.stringify(value))), open: () => {}, close: () => {},
  });
  Object.assign(body(page), { clientWidth: 300, clientHeight: 240 });
  ready.resolve();
  return { page, calls, saved, events };
}
const iconsState = { v: 1, seq: 1, hidden: false, view: 'icons', sessions: {} };

test('真实模块：单击文件夹列出它的内容，Mac 头部返回回到根目录；每一步都是真实的 list 请求', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = join(await tempDir(t), 'repo');
  await mkdir(join(root, 'sub', 'deeper'), { recursive: true });
  await writeFile(join(root, 'sub', 'inner.txt'), 'x');
  await writeFile(join(root, 'sub', 'deeper', 'deep.txt'), 'y');
  await writeFile(join(root, 'top.txt'), 'z');
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);
  const { page } = await mountGrid(t, fake, { state: iconsState });
  await waitFor(() => names(page).includes('top.txt'), '根目录的图标');
  assert.deepEqual(names(page), ['sub', 'top.txt']);
  dbl(cell(page, 'sub'));
  await waitFor(() => names(page).includes('inner.txt'), '进入 sub');
  assert.deepEqual(names(page), ['deeper', 'inner.txt']);
  dbl(cell(page, 'deeper'));
  await waitFor(() => names(page).includes('deep.txt'), '进入 sub/deeper');
  assert.equal(head(page).find(node => node.classList.contains('gname-head'))[0].textContent, 'deeper');
  head(page).children[0].dispatch('click');
  await waitFor(() => names(page).includes('inner.txt'), '回到 sub');
  head(page).children[0].dispatch('click');
  await waitFor(() => names(page).includes('top.txt'), '回到根目录');
  assert.equal(head(page).children.some(node => node.tagName === 'BUTTON'), false);
});

test('真实模块：目录被删之后刷新，模块回答 not_found，回到最近还在的上一层并提示', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = join(await tempDir(t), 'repo');
  await mkdir(join(root, 'sub', 'deeper'), { recursive: true });
  await writeFile(join(root, 'sub', 'keep.txt'), 'x');
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);
  const { page } = await mountGrid(t, fake, { state: iconsState });
  await waitFor(() => names(page).includes('sub'), '根目录');
  dbl(cell(page, 'sub'));
  await waitFor(() => names(page).includes('deeper'), 'sub');
  dbl(cell(page, 'deeper'));
  await waitFor(() => names(page).includes('空目录'), 'sub/deeper');
  await rm(join(root, 'sub', 'deeper'), { recursive: true });
  page.bar.find(node => node.tagName === 'BUTTON' && node.textContent === '刷新')[0].dispatch('click');
  await waitFor(() => page.hint.textContent === '文件夹已不存在' && names(page).join() === 'keep.txt', '退到 sub，内容是刷新后的');
  assert.equal(page.hint.textContent, '文件夹已不存在');
});

test('真实模块：iPhone 单击文件在页内预览，声明的路径多一级；一次 back 关预览，steps 为 2 关预览并退一层；重建后回到预览', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = join(await tempDir(t), 'repo');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'inner.txt'), 'inner-body');
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);
  const saved = [];
  const first = await mountGrid(t, fake, { platform: 'ios', state: iconsState, saved, back: true });
  await waitFor(() => names(first.page).includes('sub'), '根目录');
  cell(first.page, 'sub').dispatch('click');
  await waitFor(() => names(first.page).includes('inner.txt'), 'sub');
  assert.deepEqual(first.calls.back.at(-1), ['repo']);
  cell(first.page, 'inner.txt').dispatch('click');
  const text = page => page.preview.find(node => node.classList.contains('text'))[0]?.textContent;
  await waitFor(() => text(first.page) === 'inner-body', '预览读到正文');
  assert.deepEqual(first.calls.back.at(-1), ['repo', 'sub'], '多一级：要回到的 sub');

  first.events.back({ steps: 1 });
  await waitFor(() => !first.page.browse.classList.contains('off'), '一次 back 关预览');
  assert.deepEqual(first.calls.back.at(-1), ['repo'], '路径回到打开前');
  assert.ok(cell(first.page, 'inner.txt').classList.contains('sel'), '选中留着');
  cell(first.page, 'inner.txt').dispatch('click');
  await waitFor(() => first.page.browse.classList.contains('off'), '再打开');
  first.events.back({ steps: 2 });
  await waitFor(() => names(first.page).includes('sub'), 'steps 为 2：关预览并退到根目录');
  assert.deepEqual(first.calls.back.at(-1), []);

  // 在 sub 里开着文件时 visibility: false（长按返回退出整层），重建页面：回到预览，返回后仍在 sub。
  cell(first.page, 'sub').dispatch('click');
  await waitFor(() => names(first.page).includes('inner.txt'), 'sub');
  cell(first.page, 'inner.txt').dispatch('click');
  await waitFor(() => text(first.page) === 'inner-body', '预览');
  first.events.visibility(false);
  const second = await mountGrid(t, fake, { platform: 'ios', state: saved.at(-1), back: true });
  await waitFor(() => text(second.page) === 'inner-body', '重建后回到预览');
  assert.deepEqual(second.calls.back.at(-1), ['repo', 'sub'], '到达就绪后一次声明完整路径');
  second.events.back({ steps: 1 });
  await waitFor(() => names(second.page).includes('inner.txt'), '返回后在 sub');
  assert.deepEqual(second.calls.back.at(-1), ['repo']);
});
