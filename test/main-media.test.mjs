// 从 activate(coda) 入口走：media 请求发口令、口令的生命周期（根目录变化、换会话、视图关闭）、宿主没有流式服务。
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { checkoutOf, fakeCoda, flush, tempDir, waitFor } from './support/fake.mjs';

async function repo(t, name = 'repo') {
  const root = join(await tempDir(t), name);
  await mkdir(join(root, 'dir'), { recursive: true });
  await writeFile(join(root, 'a.mp3'), 'AUDIO-A');
  await symlink('/etc/hosts', join(root, 'out.mp3'));
  return root;
}

async function started(fake, session, options) {
  activate(fake.coda);
  const view = fake.open(session, options);
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  return view;
}

let seq = 0;
async function media(view, generation, path) {
  const requestId = `m${++seq}`;
  view.send({ type: 'media', generation, requestId, path });
  return view.answer(requestId);
}

// 把登记的服务处理函数接到真实 http 服务器上，用口令取文件。
async function fetcher(t, fake) {
  const server = createServer(fake.services.get('media'));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  return async (token, path) => (await fetch(`http://127.0.0.1:${server.address().port}/${token}/${path}`)).status;
}

test('登记服务；media 回答口令、大小、修改时间；同一视图口令不变，两个视图口令不同', async t => {
  const root = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const first = await started(fake, 'A');
  assert.deepEqual([...fake.services.keys()], ['media']);
  const one = await media(first, 1, 'a.mp3');
  assert.equal(one.type, 'media_granted');
  assert.deepEqual([one.size, Number.isInteger(one.mtimeMs)], [7, true]);
  assert.match(one.token, /^[0-9a-f]{32}$/);
  assert.equal((await media(first, 1, 'a.mp3')).token, one.token);
  const second = fake.open('A');
  second.send({ type: 'hello' });
  await waitFor(() => second.of('root').length > 0, 'root');
  assert.notEqual((await media(second, 1, 'a.mp3')).token, one.token);
  const fetchStatus = await fetcher(t, fake);
  assert.equal(await fetchStatus(one.token, 'a.mp3'), 200);
});

test('media 的错误：目录、外链、不存在、越界路径、没有根目录', async t => {
  const root = await repo(t);
  const view = await started(fakeCoda({ A: checkoutOf(root) }), 'A');
  assert.equal((await media(view, 1, 'dir')).error.code, 'not_file');
  assert.equal((await media(view, 1, 'out.mp3')).error.code, 'not_file', '指向根目录外的链接不发口令');
  assert.equal((await media(view, 1, 'nope.mp3')).error.code, 'not_found');
  assert.equal((await media(view, 1, '../x.mp3')).error.code, 'invalid_path');
  assert.equal((await media(view, 1, 'a.mp3')).error, undefined);
  const none = await started(fakeCoda({}), 'B');
  assert.equal((await media(none, 1, 'a.mp3')).error.code, 'no_root');
});

test('口令随换会话作废：旧口令 404，新会话发新口令、读新根目录', async t => {
  const rootA = await repo(t, 'A'), rootB = await repo(t, 'B');
  await writeFile(join(rootB, 'a.mp3'), 'AUDIO-B-LONGER');
  const fake = fakeCoda({ A: checkoutOf(rootA), B: checkoutOf(rootB) });
  const view = await started(fake, 'A');
  const old = (await media(view, 1, 'a.mp3')).token;
  const status = await fetcher(t, fake);
  assert.equal(await status(old, 'a.mp3'), 200);
  view.switchTo('B');
  await waitFor(() => view.of('root').some(m => m.generation === 2), '新会话的 root');
  assert.equal(await status(old, 'a.mp3'), 404);
  const fresh = await media(view, 2, 'a.mp3');
  assert.notEqual(fresh.token, old);
  assert.equal(fresh.size, 14);
  assert.equal(await status(fresh.token, 'a.mp3'), 200);
});

test('口令随根目录变化作废（同一会话换了工作目录）', async t => {
  const rootA = await repo(t, 'A'), rootB = await repo(t, 'B');
  const fake = fakeCoda({ S: checkoutOf(rootA) });
  const view = await started(fake, 'S');
  const old = (await media(view, 1, 'a.mp3')).token;
  const status = await fetcher(t, fake);
  fake.threads.S = checkoutOf(rootB);
  fake.emit('S', 'turn-1');
  fake.emit('S', null);
  await waitFor(() => view.lastRoot().path === rootB, '根目录换了');
  assert.equal(await status(old, 'a.mp3'), 404);
  const fresh = (await media(view, 1, 'a.mp3')).token;
  assert.notEqual(fresh, old);
  assert.equal(await status(fresh, 'a.mp3'), 200);
});

test('口令随视图关闭作废；别的视图的口令不受影响', async t => {
  const root = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const one = await started(fake, 'A');
  const two = fake.open('A');
  two.send({ type: 'hello' });
  await waitFor(() => two.of('root').length > 0, 'root');
  const [a, b] = [(await media(one, 1, 'a.mp3')).token, (await media(two, 1, 'a.mp3')).token];
  const status = await fetcher(t, fake);
  await one.close();
  assert.deepEqual([await status(a, 'a.mp3'), await status(b, 'a.mp3')], [404, 200]);
});

test('读的途中视图关了：不发口令', async t => {
  const root = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await started(fake, 'A');
  view.send({ type: 'media', generation: 1, requestId: 'late', path: 'a.mp3' });
  await view.close();
  await flush();
  assert.equal(view.of('media_granted').length, 0);
  const status = await fetcher(t, fake);
  assert.equal(await status('anything', 'a.mp3'), 404);
});

test('宿主没有流式服务（旧 Coda）：media 只回大小和修改时间，token 是 null；登记被拒绝也一样', async t => {
  const root = await repo(t);
  const old = fakeCoda({ A: checkoutOf(root) });
  delete old.coda.services;
  const reply = await media(await started(old, 'A'), 1, 'a.mp3');
  assert.deepEqual([reply.token, reply.size, reply.error], [null, 7, undefined]);

  const refused = fakeCoda({ A: checkoutOf(root) });
  refused.coda.services.register = async () => { throw new Error('不支持'); };
  const view = await started(refused, 'A');
  await flush();
  assert.equal((await media(view, 1, 'a.mp3')).token, null);

  const throws = fakeCoda({ A: checkoutOf(root) });
  throws.coda.services.register = () => { throw new Error('同步抛出'); };
  assert.equal((await media(await started(throws, 'A'), 1, 'a.mp3')).token, null);
});
