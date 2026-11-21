// 真实模块（activate）+ 真实 view/file-app.mjs + 真实临时目录：消息经假 coda 的视图往返。
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { loadFileApp, visible } from './support/dom.mjs';
import { checkoutOf, deferred, fakeCoda, flush, tempDir, waitFor } from './support/fake.mjs';

async function setup(t, args) {
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.txt'), 'hello');
  await mkdir(join(base, 'repo-other'));
  await writeFile(join(base, 'repo-other', 'secret.txt'), 'top secret');
  await symlink(join(base, 'repo-other'), join(root, 'out'));
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda);
  const view = fake.open(null, { view: 'file', args });
  const loaded = deferred();
  view.listen(message => loaded.promise.then(() => queueMicrotask(() => page.post(message))));
  const page = await loadFileApp(t, { platform: 'ios', args, postMessage: message => view.send(message), on: () => {}, copy: () => {}, getState: () => undefined, setState: () => {} });
  loaded.resolve();
  return { base, root, fake, view, page };
}

const text = page => page.preview.find(node => node.classList.contains('text'))[0]?.textContent;
const notice = page => page.notice.textContent;

test('打开文件；一轮结束后更新；根目录消失和回来时说明与恢复', async t => {
  const { root, fake, page, view } = await setup(t, { session: 'A', path: 'src/a.txt' });
  await waitFor(() => text(page) === 'hello', '首次显示');

  await writeFile(join(root, 'src', 'a.txt'), 'hello again');
  fake.emit('A', 't');
  fake.emit('A', null);
  await waitFor(() => text(page) === 'hello again', '一轮结束后更新');
  assert.equal(view.of('changed').length, 1);

  fake.threads.A = checkoutOf(`${root}-missing`); // 工作树被回收
  fake.emit('A', 't');
  fake.emit('A', null);
  await waitFor(() => /工作目录已不存在/.test(notice(page)), 'gone 说明');
  assert.equal(visible(page.preview), false);

  fake.threads.A = checkoutOf(root);
  fake.emit('A', 't');
  fake.emit('A', null);
  await waitFor(() => text(page) === 'hello again', '恢复后重新打开');
});

test('路径校验经整条链路生效：越界和符号链接都显示读不到，不泄露内容', async t => {
  for (const path of ['../repo-other/secret.txt', 'out/secret.txt']) {
    const { page } = await setup(t, { session: 'A', path });
    await waitFor(() => /读不到这个文件/.test(page.preview.textContent), path);
    assert.doesNotMatch(page.preview.textContent, /top secret/);
  }
});

test('文件被删：显示已不存在；没有会话：模块不查询，页面说明', async t => {
  const { root, page } = await setup(t, { session: 'A', path: 'src/a.txt' });
  await waitFor(() => text(page) === 'hello', '首次显示');
  await rm(join(root, 'src', 'a.txt'));
  page.post({ type: 'changed', generation: 1 });
  await waitFor(() => /文件已不存在/.test(page.preview.textContent), '已不存在');

  const bare = await setup(t, { path: 'src/a.txt' });
  await waitFor(() => /没有打开的会话/.test(notice(bare.page)), '没有会话');
  await flush();
  assert.equal(bare.fake.queries.length, 0);
});
