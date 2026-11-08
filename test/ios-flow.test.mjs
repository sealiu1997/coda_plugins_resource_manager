// 真实模块（activate）+ 真实 app.mjs + 真实临时目录：iPhone 上「打开文件再返回」走一遍（页内预览，同一个页面）。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { loadApp } from './support/dom.mjs';
import { checkoutOf, deferred, fakeCoda, tempDir, waitFor } from './support/fake.mjs';

const COUNT = 1000; // 名字取长一点，带上大小和修改时间后一页（96 KiB）放不下，需要两页
const name = i => `file-${String(i).padStart(4, '0')}-${'x'.repeat(80)}.txt`;

// 挂一个树页：getState 给上次存下的状态，coda.open 记下参数，原生返回的事件记在 events。
async function mountTree(t, fake, state, opened) {
  const view = fake.open('A');
  const ready = deferred(), saved = [], events = {};
  let page;
  view.listen(message => ready.promise.then(() => queueMicrotask(() => page.post(message))));
  page = await loadApp(t, {
    platform: 'ios', postMessage: message => view.send(message), on: (name, fn) => { events[name] = fn; }, back: () => {}, copy: () => {},
    getState: () => state, setState: value => saved.push(JSON.parse(JSON.stringify(value))),
    open: args => { opened.push(args); }, close: () => {},
  });
  ready.resolve();
  return { page, view, saved, events };
}

const entryRows = page => page.tree.find(node => node.classList.contains('entry'));
const scrollTo = (page, top) => { page.tree.scrollTop = top; page.tree.dispatch('scroll'); };

test('树 → 预览 → 返回：同一个页面里展开、已加载的条数、滚动位置都在，预览读到的是点的那个文件', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'x.txt'), 'x');
  for (let i = 0; i < COUNT; i++) await writeFile(join(root, name(i)), `body-${i}`);
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);

  // 展开 sub，加载第二页，滚到深处，点一个文件。
  const opened = [];
  const one = await mountTree(t, fake, undefined, opened);
  await waitFor(() => entryRows(one.page).some(node => node.textContent.includes('sub')), '根目录');
  const rowH = 24; // 假 DOM 量出的行高
  entryRows(one.page).find(node => node.textContent.includes('sub')).dispatch('click');
  await waitFor(() => entryRows(one.page).some(node => node.textContent.includes('x.txt')), '展开 sub');
  const total = () => one.page.tree.children[1].style.height;
  const firstPage = parseInt(total(), 10) / rowH;
  assert.ok(firstPage < COUNT + 2, '第一页放不下全部');
  scrollTo(one.page, (firstPage - 3) * rowH);
  const more = () => one.page.tree.find(node => node.classList.contains('more'))[0];
  await waitFor(() => more(), '再显示');
  more().dispatch('click');
  await waitFor(() => parseInt(total(), 10) / rowH === COUNT + 2, '第二页');
  scrollTo(one.page, (firstPage + 100) * rowH);
  const before = one.page.tree.scrollTop;
  const target = entryRows(one.page).find(node => node.classList.contains('file'));
  const targetName = target.find(node => node.classList.contains('name'))[0].textContent;
  target.dispatch('click');
  const index = Number(targetName.slice(5, 9));
  await waitFor(() => one.page.preview.find(node => node.classList.contains('text'))[0]?.textContent === `body-${index}`, '预览正文');
  assert.deepEqual(opened, [], '不再推入文件页');

  // 返回：同一个页面，目录树原样。
  one.events.back({ steps: 1 });
  await waitFor(() => !one.page.browse.classList.contains('off'), '回到树');
  assert.equal(one.page.tree.scrollTop, before, '滚动位置不变');
  assert.equal(parseInt(total(), 10) / rowH, COUNT + 2, '加载过的条数不变');
  scrollTo(one.page, 0);
  assert.ok(entryRows(one.page).some(node => node.textContent.includes('x.txt')), 'sub 仍然展开');
});
