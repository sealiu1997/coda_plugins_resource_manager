// 经 activate 的文件名搜索：整条链路（请求、回答、错误、取消）、页面重建（hello 清槽、请求号前缀、回答类型核对）、换会话和关闭。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { createListing } from '../lib/tree.mjs';
import { Link, newPrefix } from '../view/connection.mjs';
import { REQUEST_ID_MAX } from '../view/protocol.mjs';
import { countingFs } from './support/countfs.mjs';
import { checkoutOf, deferred, fakeCoda, flush, tempDir, trackTimers, waitFor } from './support/fake.mjs';

async function repo(t) {
  const root = join(await tempDir(t), 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'needle.js'), '');
  await writeFile(join(root, 'needle.txt'), '');
  await writeFile(join(root, 'other.txt'), '');
  return root;
}
async function started(fake, session, { spy = countingFs(), searchLimits } = {}) {
  activate(fake.coda, { makeListing: () => createListing({ fs: spy.fs }), searchLimits });
  const view = fake.open(session);
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  return { view, spy };
}
const send = (view, type, requestId, body = {}, generation = 1) => view.send({ type, generation, requestId, ...body });
const gateOn = (name, match) => { const gate = deferred(); return { gate, hooks: { [name]: async (path, original) => { if (path.includes(match)) await gate.promise; return original(path); } } }; };

test('经 activate：search 的回答、错误码和没有根目录时的 no_root；回答不超过消息上限', async t => {
  const root = await repo(t), fake = fakeCoda({ A: checkoutOf(root), N: {} });
  const { view } = await started(fake, 'A');
  send(view, 'search', 's1', { query: 'NEEDLE', hidden: false });
  const reply = await view.answer('s1');
  assert.deepEqual(reply, { type: 'searched', generation: 1, requestId: 's1', results: [{ path: 'needle.txt', kind: 'file' }, { path: 'src/needle.js', kind: 'file' }], stop: 'done', scanned: 4, unreadable: 0 });
  send(view, 'search', 's2', { query: '  ', hidden: false });
  assert.equal((await view.answer('s2')).error.code, 'invalid_query');
  assert.equal(view.dropped.length, 0);
  const none = fake.open('N');
  none.send({ type: 'hello' });
  await waitFor(() => none.of('root').length === 1, 'root');
  send(none, 'search', 's3', { query: 'a', hidden: false });
  assert.equal((await none.answer('s3')).error.code, 'no_root');
});

test('经 activate：search_cancel 要代次和请求号都对上才停，停了就不回答', async t => {
  const root = await repo(t), { gate, hooks } = gateOn('lstat', 'needle.txt'), spy = countingFs({ hooks });
  const { view } = await started(fakeCoda({ A: checkoutOf(root) }), 'A', { spy });
  send(view, 'search', 's1', { query: 'needle', hidden: false });
  await waitFor(() => spy.counts.lstat >= 3, '读取已发出');
  view.send({ type: 'search_cancel', generation: 1, requestId: 'other' });
  view.send({ type: 'search_cancel', generation: 9, requestId: 's1' });
  gate.resolve();
  assert.equal((await view.answer('s1')).results.length, 2, '对不上的取消不停');
  send(view, 'search', 's2', { query: 'needle', hidden: false });
  view.send({ type: 'search_cancel', generation: 1, requestId: 's2' });
  await flush();
  await flush();
  assert.equal(view.of('searched').filter(m => m.requestId === 's2').length, 0, '取消后不回答');
});

test('经 activate：hello（页面重建）中止旧页面的搜索和文件夹大小，不回答；新页面的搜索等旧读取排空后照常回答', async t => {
  const root = await repo(t), { gate, hooks } = gateOn('lstat', 'needle.txt'), spy = countingFs({ hooks });
  const { view } = await started(fakeCoda({ A: checkoutOf(root) }), 'A', { spy });
  send(view, 'search', 'old-q1', { query: 'needle', hidden: false });
  send(view, 'dir_size', 'old-q2', { path: '' });
  await waitFor(() => spy.counts.lstat >= 3, '读取已发出');
  view.send({ type: 'hello' }); // 新页面
  send(view, 'search', 'new-q1', { query: 'needle', hidden: false });
  await flush();
  assert.equal(view.of('searched').length, 0, '新搜索在等旧走树排空');
  gate.resolve();
  const reply = await view.answer('new-q1');
  assert.equal(reply.results.length, 2);
  await flush();
  assert.deepEqual(view.of('searched').map(m => m.requestId), ['new-q1'], '旧页面的搜索不回答');
  assert.equal(view.of('sized').length, 0, '旧页面的统计不回答');
});

test('经 activate：换会话、根目录变化、视图关闭时进行中的搜索不回答', async t => {
  const root = await repo(t), other = await repo(t);
  for (const action of ['switch', 'root', 'close']) {
    const { gate, hooks } = gateOn('lstat', 'needle.txt'), spy = countingFs({ hooks });
    const fake = fakeCoda({ A: checkoutOf(root), B: checkoutOf(other) });
    const { view } = await started(fake, 'A', { spy });
    send(view, 'search', 's1', { query: 'needle', hidden: false });
    await waitFor(() => spy.counts.lstat >= 3, `${action}：读取已发出`);
    if (action === 'switch') view.switchTo('B');
    else if (action === 'root') { fake.threads.A = checkoutOf(other); view.send({ type: 'refresh', generation: 1 }); await waitFor(() => view.of('root').length === 2, 'root 变了'); }
    else view.close();
    gate.resolve();
    await flush();
    await flush();
    assert.equal(view.of('searched').length, 0, action);
  }
});

test('页面重建：请求号带页面实例的随机前缀，新页面从 1 重新数也不会和旧页面的重复，总长在上限之内', async t => {
  const prefixes = new Set(Array.from({ length: 50 }, newPrefix));
  assert.equal(prefixes.size, 50);
  const ids = [];
  for (const prefix of [newPrefix(), newPrefix(), 'x'.repeat(200)]) {
    const link = new Link({ post: message => ids.push(message.requestId), prefix });
    link.reset(1);
    link.call('list', {}).catch(() => {});
    await flush();
  }
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every(id => id.length <= REQUEST_ID_MAX), ids.join());
  assert.match(ids[0], /^[a-z0-9]+-q1$/);
});

test('页面重建：旧页面迟到的 searched 撞上新页面同号的 list，不结算它（Link 核对回答类型）', async t => {
  trackTimers(t);
  const sent = [], link = new Link({ post: message => sent.push(message) });
  link.reset(1);
  let outcome = null;
  link.call('list', { path: '' }).then(value => { outcome = value; }, error => { outcome = error; });
  await flush();
  const { requestId } = sent[0];
  assert.equal(link.receive({ type: 'searched', generation: 1, requestId, results: [], stop: 'done', scanned: 0, unreadable: 0 }), false);
  assert.equal(link.pending.size, 1, '请求还在等它自己的回答');
  await flush();
  assert.equal(outcome, null);
  assert.equal(link.receive({ type: 'listed', generation: 1, requestId, entries: [], nextCursor: null }), true);
  await flush();
  assert.deepEqual(outcome.entries, []);
  assert.equal(link.receive({ type: 'listed', generation: 1, requestId, entries: [] }), false, '结算过的不再结算');
});
