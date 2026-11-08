// 页面到模块的连接：真实的 connect() 分发（装一个 window 的消息事件源），不直接调 receive。
// 回答、超时、代次失效、取消都只结算一次，并清掉定时器和取消监听。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { draftSession } from '../lib/draft.mjs';
import { createListing } from '../lib/tree.mjs';
import { Cancelled, RequestError, Stale, connect } from '../view/connection.mjs';
import { MESSAGE_LIMIT, messageSize } from '../view/protocol.mjs';
import { countingFs } from './support/countfs.mjs';
import { checkoutOf, deferred, fakeCoda, flush, tempDir, trackTimers, waitFor } from './support/fake.mjs';

// 一个页面：window 上装消息事件源，connect() 监听它；deliver 把模块的消息送进去。
function pageOf(t, post) {
  const listeners = [], had = 'window' in globalThis, prev = globalThis.window;
  globalThis.window = { addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); } };
  t.after(() => { if (had) globalThis.window = prev; else delete globalThis.window; });
  const sent = [];
  const conn = connect({ postMessage: message => { sent.push(message); return post?.(message); } }, { handlers: { session() {}, root() {}, changed() {} } });
  const deliver = data => { for (const fn of listeners) fn({ data }); };
  deliver({ type: 'session', generation: 1, session: 'A' });
  return { conn, link: conn.link, sent, deliver };
}

// 记下每个请求最终怎么了：次数和结果。
function watch(promise) {
  const outcome = { count: 0, value: undefined, error: undefined };
  promise.then(value => { outcome.count++; outcome.value = value; }, error => { outcome.count++; outcome.error = error; });
  return outcome;
}
const lastRequest = async (page, type) => { await flush(); return page.sent.filter(m => m.type === type).at(-1); };

const REPLIES = [['stat', 'statted'], ['dir_size', 'sized'], ['add_text', 'added'], ['list', 'listed'], ['read', 'chunk']];

test('connect：各种回答经分发结算对应的请求，清掉定时器；重复的回答被忽略', async t => {
  const pending = trackTimers(t);
  const page = pageOf(t);
  for (const [type, reply] of REPLIES) {
    const call = page.link.call(type, { path: 'x' });
    const outcome = watch(call);
    const request = await lastRequest(page, type);
    assert.deepEqual([request.generation, request.path], [1, 'x']);
    assert.equal(pending.size, 1, `${type}：等待期间有一个定时器`);
    page.deliver({ type: reply, generation: 1, requestId: request.requestId, size: 3 });
    page.deliver({ type: reply, generation: 1, requestId: request.requestId, size: 4 });
    await flush();
    assert.equal(outcome.count, 1, `${type}：只结算一次`);
    assert.equal(outcome.value.size, 3, `${type}：用第一条回答`);
    assert.equal(pending.size, 0, `${type}：定时器清掉`);
    assert.equal(page.link.pending.size, 0);
  }
});

test('connect：回答带 error 时按错误结算；类型不是回答的消息不会结算请求', async t => {
  const pending = trackTimers(t);
  const page = pageOf(t);
  const outcome = watch(page.link.call('add_text', { text: 'p', block: false }));
  const { requestId } = await lastRequest(page, 'add_text');
  page.deliver({ type: 'changed', generation: 1, requestId });
  page.deliver({ type: 'hello', generation: 1, requestId });
  await flush();
  assert.equal(outcome.count, 0, '不是回答的消息不结算');
  page.deliver({ type: 'added', generation: 1, requestId, error: { code: 'draft_failed', message: '读写草稿失败' } });
  await flush();
  assert.ok(outcome.error instanceof RequestError);
  assert.equal(outcome.error.code, 'draft_failed');
  assert.equal(pending.size, 0);
});

test('connect：超时只结算一次并清掉定时器；超时之后迟到的回答被忽略', async t => {
  const pending = trackTimers(t);
  const page = pageOf(t);
  const outcome = watch(page.link.call('dir_size', { path: '' }));
  const { requestId } = await lastRequest(page, 'dir_size');
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(outcome.count, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(outcome.count, 1);
  assert.deepEqual([outcome.error.code, outcome.error.stale], ['timeout', undefined], '超时算失败，不是静默');
  assert.equal(pending.size, 0);
  page.deliver({ type: 'sized', generation: 1, requestId, size: 1, items: 1, complete: true, unreadable: 0 });
  await flush();
  assert.equal(outcome.count, 1);
});

test('connect：代次失效（换会话）静默结算所有等待，清掉定时器；旧代次和旧请求号的回答被忽略', async t => {
  const pending = trackTimers(t);
  const page = pageOf(t);
  const outcomes = REPLIES.map(([type]) => watch(page.link.call(type, { path: 'x' })));
  await flush();
  const old = page.sent.map(m => m.requestId);
  assert.equal(pending.size, REPLIES.length);
  page.deliver({ type: 'session', generation: 2, session: 'B' });
  await flush();
  for (const outcome of outcomes) {
    assert.equal(outcome.count, 1);
    assert.ok(outcome.error instanceof Stale && outcome.error.stale === true, '静默：调用方按 stale 吞掉');
  }
  assert.equal(pending.size, 0);
  assert.equal(page.link.pending.size, 0);
  for (const [i, [, reply]] of REPLIES.entries()) {
    page.deliver({ type: reply, generation: 1, requestId: old[i] }); // 旧代次
    page.deliver({ type: reply, generation: 2, requestId: old[i] }); // 新代次但请求号已作废
  }
  await flush();
  assert.ok(outcomes.every(outcome => outcome.count === 1));
});

test('connect：取消静默结算，清掉定时器和取消监听；取消后迟到的回答被忽略；告诉模块取消的是哪个请求', async t => {
  const pending = trackTimers(t);
  const page = pageOf(t);
  const controller = new AbortController();
  const outcome = watch(page.link.call('dir_size', { path: 'big' }, { signal: controller.signal, cancel: 'dir_size_cancel' }));
  const { requestId } = await lastRequest(page, 'dir_size');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  controller.abort();
  await flush();
  assert.equal(outcome.count, 1);
  assert.ok(outcome.error instanceof Cancelled && outcome.error.stale === true, '取消和过期一样静默');
  assert.equal(pending.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(page.sent.filter(m => m.type === 'dir_size_cancel'), [{ type: 'dir_size_cancel', generation: 1, requestId }]);
  page.deliver({ type: 'sized', generation: 1, requestId, size: 1, items: 1, complete: true, unreadable: 0 });
  await flush();
  assert.equal(outcome.count, 1);
  assert.equal(outcome.error instanceof Cancelled, true, '结果不被迟到的回答改写');
});

test('connect：发出之前就中止，请求和取消都不发；已经中止的信号直接作废；回答之后再中止不发取消', async t => {
  const pending = trackTimers(t);
  const page = pageOf(t);
  const early = new AbortController();
  const outcome = watch(page.link.call('dir_size', { path: '' }, { signal: early.signal, cancel: 'dir_size_cancel' }));
  early.abort(); // 同步中止：排队的发送还没执行
  await flush();
  assert.equal(outcome.error instanceof Cancelled, true);
  assert.deepEqual(page.sent.filter(m => m.type === 'dir_size' || m.type === 'dir_size_cancel'), []);

  const done = new AbortController();
  done.abort();
  const before = page.sent.length;
  await assert.rejects(page.link.call('dir_size', {}, { signal: done.signal, cancel: 'dir_size_cancel' }), Cancelled);
  await flush();
  assert.equal(page.sent.length, before);

  const late = new AbortController();
  const answered = watch(page.link.call('dir_size', { path: '' }, { signal: late.signal, cancel: 'dir_size_cancel' }));
  const { requestId } = await lastRequest(page, 'dir_size');
  page.deliver({ type: 'sized', generation: 1, requestId, size: 0, items: 0, complete: true, unreadable: 0 });
  await flush();
  late.abort();
  await flush();
  assert.equal(answered.count, 1);
  assert.equal(answered.error, undefined);
  assert.equal(page.sent.some(m => m.type === 'dir_size_cancel'), false);
  assert.equal(getEventListeners(late.signal, 'abort').length, 0);
  assert.equal(pending.size, 0);
});

test('connect：发送失败算失败，只结算一次，清掉定时器和取消监听', async t => {
  const pending = trackTimers(t);
  const page = pageOf(t, () => { throw new Error('宿主不可用'); });
  const controller = new AbortController();
  const outcome = watch(page.link.call('stat', { path: 'a' }, { signal: controller.signal }));
  await flush();
  assert.equal(outcome.count, 1);
  assert.equal(outcome.error.code, 'io_error');
  assert.equal(pending.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(outcome.count, 1);
});

test('connect：回答、超时、换会话、取消先后到达，只按先到的结算一次', async t => {
  const pending = trackTimers(t);
  const page = pageOf(t);
  const controller = new AbortController();
  const outcome = watch(page.link.call('stat', { path: 'a' }, { signal: controller.signal, cancel: 'dir_size_cancel' }));
  const { requestId } = await lastRequest(page, 'stat');
  page.deliver({ type: 'statted', generation: 1, requestId, name: 'a' });
  controller.abort();
  page.deliver({ type: 'session', generation: 2, session: 'B' });
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(outcome.count, 1);
  assert.equal(outcome.value.name, 'a');
  assert.equal(pending.size, 0);
  assert.equal(page.sent.some(m => m.type === 'dir_size_cancel'), false);
});

// ---- 接真实模块 ----

test('connect 接真实模块：stat、dir_size、add_text 的往返；取消真的让模块停止读取', async t => {
  const base = await tempDir(t), root = join(base, 'repo');
  await mkdir(join(root, 'big'), { recursive: true });
  for (let i = 0; i < 12; i++) await writeFile(join(root, 'big', `f${i}`), 'z');
  await writeFile(join(root, 'a.txt'), 'hello');

  const gate = deferred();
  const spy = countingFs({ hooks: { lstat: async (path, original) => { if (path.includes('big/')) await gate.promise; return original(path); } } });
  const drafts = { text: '', attachments: [{ id: 'f1' }], revision: 1, posts: [] };
  const fake = fakeCoda({ A: checkoutOf(root) });
  const base_api = fake.coda.api;
  fake.coda.api = async (path, body) => {
    if (draftSession(path) === null) return base_api(path);
    if (!body) return { text: drafts.text, attachments: drafts.attachments, revision: drafts.revision };
    drafts.posts.push(body);
    drafts.text = body.text;
    return { draft: { ...drafts } };
  };
  activate(fake.coda, { makeListing: () => createListing({ fs: spy.fs }) });
  const view = fake.open('A');
  let page;
  view.listen(message => queueMicrotask(() => page.deliver(message)));
  page = pageOf(t, message => view.send(message));
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  await flush();

  const stat = await page.link.call('stat', { path: 'a.txt' });
  assert.deepEqual([stat.type, stat.kind, stat.size], ['statted', 'file', 5]);
  const added = await page.link.call('add_text', { text: 'a.txt', block: false });
  assert.equal(added.type, 'added');
  assert.deepEqual(drafts.posts, [{ text: 'a.txt ', attachments: ['f1'], revision: 1 }]);

  const before = spy.counts.lstat;
  const controller = new AbortController();
  const outcome = watch(page.link.call('dir_size', { path: 'big' }, { signal: controller.signal, cancel: 'dir_size_cancel' }));
  await waitFor(() => spy.counts.lstat === before + 4, '统计开始');
  controller.abort();
  await flush();
  gate.resolve();
  await flush();
  assert.equal(outcome.error instanceof Cancelled, true);
  assert.equal(spy.counts.lstat, before + 4, '模块收到取消，没有排下一批');
  assert.equal(view.of('sized').length, 0);

  const sized = await page.link.call('dir_size', { path: '' });
  assert.deepEqual([sized.type, sized.items, sized.size, sized.complete], ['sized', 14, 12 + 5, true]);
});

test('Link.size：按完整信封算，和真正发出的消息一样大，页面用它在发之前判断会不会超过消息上限', async t => {
  const page = pageOf(t);
  for (const text of ['a', 'x'.repeat(5000), '字'.repeat(300), 'quote"and\\slash\n'.repeat(50)]) {
    const fields = { text, block: true };
    const expected = page.link.size('add_text', fields);
    page.link.call('add_text', fields).catch(() => {});
    await flush();
    const message = page.sent.at(-1);
    assert.equal(messageSize(message), expected, text.slice(0, 8));
    assert.match(message.requestId, new RegExp(`^[a-z0-9]+-q${page.sent.length}$`), '用的就是下一个请求号（带页面前缀）');
  }
  const base = page.link.size('add_text', { text: '', block: false });
  const edge = 'e'.repeat(MESSAGE_LIMIT - base);
  assert.equal(page.link.size('add_text', { text: edge, block: false }), MESSAGE_LIMIT, '正好等于上限');
  assert.equal(page.link.size('add_text', { text: `${edge}e`, block: false }), MESSAGE_LIMIT + 1);
});
