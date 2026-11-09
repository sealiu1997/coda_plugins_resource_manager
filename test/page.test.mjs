// 真实 activate(coda) 模块 + 页面状态层（Link、Model）+ 真实临时目录，走完整链路。
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { readFile } from '../view/preview.mjs';
import { visibleRows } from '../view/tree.mjs';
import { checkoutOf, fakeCoda, tempDir, waitFor } from './support/fake.mjs';
import { connected } from './support/page.mjs';

async function repo(t, files) {
  const root = join(await tempDir(t), 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}
const rootNames = model => model.dirs.get('')?.entries.map(e => e.name);
const srcNames = model => model.dirs.get('src')?.entries.map(e => e.name);

test('hello → session、root → 展开 → 一轮结束后文件变化 → 树和预览更新', async t => {
  const root = await repo(t, { 'src/a.txt': 'one', 'src/b.txt': 'two', 'README.md': '# hi' });
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);
  const page = connected(fake, 'A');
  await waitFor(() => page.model.dirs.get('')?.loaded, '根目录');
  assert.deepEqual([page.model.session, page.model.root, rootNames(page.model)], ['A', { state: 'ready', path: root, project: null }, ['src', 'README.md']]);

  page.model.toggle('src');
  await waitFor(() => srcNames(page.model)?.length === 2, '展开 src');
  assert.deepEqual(visibleRows(page.model).map(r => r.name), ['src', 'a.txt', 'b.txt', 'README.md']);
  const read = path => offset => page.link.call('read', { path, offset });
  const before = await readFile(read('src/a.txt'));
  assert.equal(before.text, 'one');

  // 一轮：Agent 改了文件，结束时模块推 changed。
  fake.emit('A', null, 'ADDED');
  fake.emit('A', 't1');
  await rm(join(root, 'src', 'a.txt'));
  await writeFile(join(root, 'src', 'c.txt'), 'three');
  await writeFile(join(root, 'src', 'b.txt'), 'two changed');
  const changed = page.view.of('changed').length;
  fake.emit('A', null);
  await waitFor(() => page.view.of('changed').length === changed + 1, 'changed');
  await waitFor(() => srcNames(page.model).join() === 'b.txt,c.txt', '树更新');
  const after = await readFile(read('src/b.txt'), { prev: { size: 3, mtimeMs: 0 } });
  assert.equal(after.text, 'two changed');
  await assert.rejects(readFile(read('src/a.txt')), { code: 'not_found' });
});

test('切换会话：树和等待中的请求立即换成新会话的，旧会话的回答进不来', async t => {
  const a = await repo(t, { 'only-a.txt': '' });
  const b = await repo(t, { 'only-b.txt': '' });
  const fake = fakeCoda({ A: checkoutOf(a), B: checkoutOf(b) });
  activate(fake.coda);
  const page = connected(fake, 'A');
  await waitFor(() => page.model.dirs.get('')?.loaded, 'A 的根');
  page.model.toggle('src');
  page.view.switchTo('B'); // 展开 src 的请求还在途中
  await waitFor(() => page.model.session === 'B', '换会话');
  assert.equal(page.model.dirs.size, 0, 'session 一到就清空');
  assert.deepEqual([...page.model.expanded], []);
  await waitFor(() => page.model.dirs.get('')?.loaded, 'B 的根');
  assert.deepEqual(rootNames(page.model), ['src', 'only-b.txt']);
  assert.equal(page.model.dirs.has('src'), false);
  assert.equal(page.link.pending.size, 0);
});

test('根目录 ready → gone → ready：展开状态保留，回来后重新取', async t => {
  const root = await repo(t, { 'src/a.txt': '' });
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);
  const page = connected(fake, 'A');
  await waitFor(() => page.model.ready, 'ready');
  page.model.toggle('src');
  await waitFor(() => srcNames(page.model)?.length === 1, '展开');

  fake.threads.A = checkoutOf(join(root, 'removed'));
  fake.emit('A', null, 'ADDED'); fake.emit('A', 't1');
  fake.emit('A', null);
  await waitFor(() => page.model.root?.state === 'gone', 'gone');
  assert.deepEqual([...page.model.expanded], ['src']);

  await writeFile(join(root, 'src', 'b.txt'), '');
  fake.threads.A = checkoutOf(root);
  fake.emit('A', 't2'); fake.emit('A', null);
  await waitFor(() => page.model.ready && srcNames(page.model).length === 2, '回到 ready 并重新取');
});
