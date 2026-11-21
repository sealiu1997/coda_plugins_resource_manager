// 真实链路：真实的 app.mjs 页面 + 真实的 connect() + 真实的 activate 模块 + 真实的临时目录，只有 coda.query / coda.call 是假的。
// 「右键添加」从页面的右键一路走到假 coda.call 的 append-draft；「属性」从页面一路走到真实的 stat 和 dir_size。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { loadApp, visible } from './support/dom.mjs';
import { checkoutOf, deferred, fakeCoda, flush, tempDir, waitFor } from './support/fake.mjs';
import { rowNamed } from './support/treehost.mjs';

async function setup(t, { draft } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'a.txt'), 'hello');
  await writeFile(join(root, 'src', 'x.js'), 'x'.repeat(100));
  await writeFile(join(root, 'src', 'y.js'), 'y'.repeat(50));
  const fake = fakeCoda({ A: checkoutOf(root) }, { drafts: { A: draft } });
  activate(fake.coda);
  const view = fake.open('A');
  const loaded = deferred();
  view.listen(message => loaded.promise.then(() => queueMicrotask(() => page.post(message))));
  const copied = [], backs = [], events = {};
  const page = await loadApp(t, {
    platform: 'mac', postMessage: message => view.send(message), on: (name, fn) => { events[name] = fn; }, back: titles => backs.push(titles),
    copy: text => copied.push(text), getState: () => undefined, setState: () => {}, open: () => {}, close: () => {},
  });
  loaded.resolve();
  await waitFor(() => rowNamed(page, 'a.txt'), '目录树出现');
  return { base, root, fake, view, page, copied, backs, events, draft };
}
const buttons = page => page.menu.find(node => node.tagName === 'BUTTON');
const choose = (page, label) => buttons(page).find(node => node.textContent === label).dispatch('click');

test('右键添加：页面右键 → add_text → 模块调 append-draft（保留附件）→ 回答 → 提示「已添加到输入框」', async t => {
  const { page, fake, draft, copied } = await setup(t, { draft: { text: '看看', attachments: [{ id: 'f1' }] } });
  rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  assert.deepEqual(buttons(page).map(node => node.textContent), ['打开', '添加到聊天', '复制相对路径', '复制绝对路径', '属性']);
  choose(page, '添加到聊天');
  await waitFor(() => page.hint.textContent === '已添加到输入框', '成功提示');
  assert.deepEqual(fake.calls.map(entry => ({ resource: entry.resource, name: entry.name, input: entry.input })), [
    { resource: { kind: 'coda/thread@1', id: 'A' }, name: 'append-draft', input: { text: 'a.txt', line: false } },
  ]);
  assert.equal(draft.text, '看看 a.txt ');
  assert.deepEqual(draft.attachments, [{ id: 'f1' }]);
  assert.deepEqual(copied, [], '成功不复制');
  assert.ok(visible(page.hint));
  assert.equal(page.hint.classList.contains('warn'), false);
});

test('右键添加：草稿接口不可用时回答 draft_failed，页面改成复制并提示', async t => {
  const { page, fake, copied } = await setup(t, { draft: { text: '', attachments: [] } });
  fake.onCall = async () => { throw new Error('没有这个接口'); };
  rowNamed(page, 'src').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  choose(page, '添加到聊天');
  await waitFor(() => page.hint.textContent === '没能写入输入框，已复制', '失败提示');
  assert.deepEqual(copied, ['src']);
  assert.equal(fake.calls.length, 1);
  assert.ok(page.hint.classList.contains('warn'));
});

test('右键添加：草稿超限时回答 draft_too_long，页面改成复制并提示', async t => {
  const { page, fake, copied } = await setup(t, { draft: { text: '', attachments: [] } });
  fake.onCall = async () => { throw Object.assign(new Error('草稿太长'), { code: 'too_long' }); };
  rowNamed(page, 'src').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  choose(page, '添加到聊天');
  await waitFor(() => page.hint.textContent === '没能写入输入框，已复制', '超限回退提示');
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(copied, ['src']);
  assert.ok(page.hint.classList.contains('warn'));
});

test('属性：文件和文件夹经真实模块；文件夹的大小是子项之和，项数含子目录', async t => {
  const { page, backs } = await setup(t, { draft: { text: '', attachments: [], revision: 1 } });
  const rows = () => Object.fromEntries(page.info.find(node => node.classList.contains('irow')).map(row => [row.children[0].textContent, row.children[1].textContent]));

  rowNamed(page, 'a.txt').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  choose(page, '属性');
  await waitFor(() => rows().种类 === '文本', '文件属性');
  assert.equal(rows().大小, '5 字节');
  assert.match(rows().完整路径, /\/repo\/a\.txt$/);
  assert.deepEqual(backs, [], 'Mac 有 coda.back 也不调用');

  assert.equal(page.info.find(node => node.tagName === 'BUTTON').filter(node => node.getAttribute('aria-label') === '返回').length, 1, 'Mac：头部有返回按钮');
  assert.equal(page.info.find(node => node.tagName === 'BUTTON').length, 1, '文件没有重新统计');
});

test('属性：文件夹经真实的 dir_size 统计', async t => {
  const { page, events } = await setup(t, { draft: { text: '', attachments: [], revision: 1 } });
  const rows = () => Object.fromEntries(page.info.find(node => node.classList.contains('irow')).map(row => [row.children[0].textContent, row.children[1].textContent]));
  rowNamed(page, 'src').dispatch('contextmenu', { clientX: 5, clientY: 6 });
  choose(page, '属性');
  await waitFor(() => rows().大小 === '150 B（2 项）', '文件夹大小');
  assert.equal(rows().种类, '文件夹');
  page.info.find(node => node.tagName === 'BUTTON').find(node => node.getAttribute('aria-label') === '返回').dispatch('click');
  await flush();
  assert.equal(visible(page.info), false);
});
