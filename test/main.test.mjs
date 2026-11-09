// 从 activate(coda) 入口走完整链路：假 coda（api、watch 可控）加真实临时目录。
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { checkoutOf, deferred, fakeCoda, flush, tempDir, trackTimers, waitFor } from './support/fake.mjs';

const POLL_MS = 2000;

async function repo(t) {
  const base = await tempDir(t);
  const root = join(base, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.txt'), 'hello');
  await writeFile(join(root, 'README.md'), '# hi');
  await mkdir(join(base, 'repo-other'));
  await writeFile(join(base, 'repo-other', 'secret.txt'), 's');
  await symlink(join(base, 'repo-other'), join(root, 'out'));
  return { base, root };
}

// 打开视图并 hello，等到第一条 root。
async function started(fake, session) {
  activate(fake.coda);
  const view = fake.open(session);
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  return view;
}

test('完整链路：hello → session、root；list 分页；read 分块；越界和错误都有回答', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await started(fake, 'A');
  assert.deepEqual(view.of('session'), [{ type: 'session', generation: 1, session: 'A' }]);
  assert.deepEqual(view.of('root'), [{ type: 'root', generation: 1, state: 'ready', path: root, project: null }]);

  view.send({ type: 'list', generation: 1, requestId: 'l1', path: '', cursor: null });
  const listed = await view.answer('l1');
  assert.equal(listed.type, 'listed');
  assert.deepEqual(listed.entries.map(e => [e.name, e.kind]), [['src', 'dir'], ['out', 'link'], ['README.md', 'file']]);
  assert.equal(listed.nextCursor, null);

  view.send({ type: 'read', generation: 1, requestId: 'r1', path: 'src/a.txt', offset: 0 });
  const chunk = await view.answer('r1');
  assert.equal(chunk.type, 'chunk');
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'hello');
  assert.deepEqual([chunk.offset, chunk.size, chunk.kind, chunk.eof], [0, 5, 'text', true]);
  assert.equal(chunk.path, undefined, '回答不回传路径');

  const failures = [
    ['list', { path: '../repo-other' }, 'invalid_path'],
    ['list', { path: '/etc' }, 'invalid_path'],
    ['list', { path: 'out' }, 'outside_root'],
    ['list', { path: 'src/a.txt' }, 'not_dir'],
    ['list', { path: 'nope' }, 'not_found'],
    ['list', { path: '', cursor: '???' }, 'cursor_expired'],
    ['read', { path: 'out/secret.txt', offset: 0 }, 'outside_root'],
    ['read', { path: 'src\u0000', offset: 0 }, 'invalid_path'],
    ['read', { path: 'src', offset: 0 }, 'not_file'],
    ['read', { path: 'README.md', offset: -1 }, 'invalid_offset'],
    ['read', { path: 'gone.txt', offset: 0 }, 'not_found'],
    ['read', { path: 7, offset: 0 }, 'invalid_path'],
  ];
  for (const [i, [type, body, code]] of failures.entries()) {
    view.send({ type, generation: 1, requestId: `e${i}`, ...body });
    const reply = await view.answer(`e${i}`);
    assert.equal(reply.type, type === 'list' ? 'listed' : 'chunk', code);
    assert.equal(reply.error?.code, code);
    assert.equal(typeof reply.error.message, 'string');
    assert.equal(reply.entries, undefined);
    assert.equal(reply.data, undefined);
  }
  assert.equal(view.dropped.length, 0);
});

test('回答的实际消息大小：目录页和文件块都不超过宿主的 128 KiB', async t => {
  const { root } = await repo(t);
  await mkdir(join(root, 'many'));
  for (let i = 0; i < 600; i++) await writeFile(join(root, 'many', `${'"\\'.repeat(60)}${i}`), '');
  await writeFile(join(root, 'big.txt'), Buffer.alloc(200_000, 'z'));
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await started(fake, 'A');
  let cursor = null, pages = 0;
  do {
    const id = `p${pages++}`;
    view.send({ type: 'list', generation: 1, requestId: id, path: 'many', cursor });
    cursor = (await view.answer(id)).nextCursor;
  } while (cursor);
  assert.ok(pages >= 2);
  for (let offset = 0, i = 0, eof = false; !eof; i++) {
    view.send({ type: 'read', generation: 1, requestId: `c${i}`, path: 'big.txt', offset });
    const reply = await view.answer(`c${i}`);
    offset += Buffer.from(reply.data, 'base64').length;
    eof = reply.eof;
  }
  assert.equal(view.dropped.length, 0, '没有消息超限被宿主丢弃');
  assert.equal(view.posted.filter(m => m.error).length, 0);
});

test('没有可浏览的根目录时（none、preparing、gone）请求仍有回答 no_root', async t => {
  const base = await tempDir(t);
  const fake = fakeCoda({
    N: {}, P: checkoutOf(null, 'preparing'), G: checkoutOf(join(base, 'removed')),
  });
  activate(fake.coda);
  for (const [session, state] of [['N', 'none'], ['P', 'preparing'], ['G', 'gone'], [null, 'none']]) {
    const view = fake.open(session);
    view.send({ type: 'hello' });
    await waitFor(() => view.of('root').length === 1, 'root');
    assert.equal(view.lastRoot().state, state);
    view.send({ type: 'list', generation: 1, requestId: 'l', path: '' });
    view.send({ type: 'read', generation: 1, requestId: 'r', path: 'x', offset: 0 });
    assert.equal((await view.answer('l')).error.code, 'no_root');
    assert.equal((await view.answer('r')).error.code, 'no_root');
    view.close();
  }
});

test('代次：A→B→A 之后，第一次 A 的在途请求不会回答；旧代次的请求不回答', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root), B: checkoutOf(root) });
  const view = await started(fake, 'A');
  view.send({ type: 'list', generation: 1, requestId: 'old', path: 'src' });
  view.send({ type: 'read', generation: 1, requestId: 'oldRead', path: 'README.md', offset: 0 });
  view.switchTo('B');
  view.switchTo('A');
  await waitFor(() => view.of('root').length === 2, '换会话后的 root');
  assert.deepEqual(view.of('session').map(m => [m.generation, m.session]), [[1, 'A'], [2, 'B'], [3, 'A']]);
  view.send({ type: 'list', generation: 1, requestId: 'older', path: '' });
  view.send({ type: 'list', generation: 3, requestId: 'new', path: 'src' });
  assert.equal((await view.answer('new')).generation, 3);
  await flush();
  assert.deepEqual(view.posted.filter(m => ['old', 'oldRead', 'older'].includes(m.requestId)), []);
});

test('代次：A→B→A 时第一次 A 迟到的根目录查询不能覆盖或推送', async t => {
  const calls = [];
  const fake = fakeCoda({
    A: () => { const d = deferred(); calls.push(d); return d.promise; },
    B: checkoutOf('/'),
  });
  activate(fake.coda);
  const view = fake.open('A');             // 第 1 次查询（代次 1）
  view.send({ type: 'hello' });            // 第 2 次查询（代次 1）
  await waitFor(() => calls.length === 2, '两次查询');
  view.switchTo('B');
  await waitFor(() => view.of('root').length === 1, 'B 的 root');
  view.switchTo('A');                      // 第 3 次查询（代次 3）
  await waitFor(() => calls.length === 3, '第三次查询');
  const dir = await tempDir(t);
  const old = await tempDir(t);
  calls[2].resolve(checkoutOf(dir));
  await waitFor(() => view.of('root').length === 2, 'A 的 root');
  calls[0].resolve(checkoutOf(old));
  calls[1].resolve(checkoutOf(old));
  await flush();
  assert.deepEqual(view.of('root').map(m => [m.generation, m.path]), [[2, '/'], [3, dir]]);
});

test('根目录状态：preparing → ready 靠每 2 秒的轮询，ready 之后停；结果没变不推送', async t => {
  trackTimers(t);
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(null, 'preparing') });
  const view = await started(fake, 'A');
  assert.equal(view.lastRoot().state, 'preparing');
  const before = fake.queried('A');
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(POLL_MS);
    await waitFor(() => fake.queried('A') === before + i + 1, `第 ${i + 1} 次轮询`);
    await flush();
  }
  assert.equal(view.of('root').length, 1, 'preparing 没变就不再推送');
  fake.threads.A = checkoutOf(root);
  t.mock.timers.tick(POLL_MS);
  await waitFor(() => view.of('root').length === 2, 'ready');
  assert.deepEqual(view.lastRoot(), { type: 'root', generation: 1, state: 'ready', path: root, project: null });
  const queried = fake.queried('A');
  t.mock.timers.tick(POLL_MS * 10);
  await flush();
  assert.equal(fake.queried('A'), queried, 'ready 之后不再轮询');
});

test('根目录状态：ready → gone → ready 随一轮的开始和结束更新，结束时 root 先于 changed', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await started(fake, 'A');
  fake.emit('A', null, 'ADDED');
  fake.emit('other', 'x', 'ADDED');

  await rm(root, { recursive: true });
  fake.emit('A', 't1');                    // 一轮开始，不发 changed
  await waitFor(() => view.lastRoot().state === 'gone', 'gone');
  assert.equal(view.lastRoot().path, root);
  assert.equal(view.of('changed').length, 0);

  await mkdir(root);
  fake.emit('A', null);                    // 一轮结束
  await waitFor(() => view.of('changed').length === 1, 'changed');
  assert.equal(view.lastRoot().state, 'ready');
  const order = view.posted.map(m => m.type);
  assert.ok(order.lastIndexOf('root') < order.indexOf('changed'));
  assert.equal(view.of('changed')[0].generation, 1);

  const roots = view.of('root').length;    // 没变化的一轮：只有 changed，没有 root
  fake.emit('A', 't2');
  fake.emit('A', null);
  await waitFor(() => view.of('changed').length === 2, '第二个 changed');
  assert.equal(view.of('root').length, roots);

  fake.emit('other', null);                // 别的会话的一轮不相干
  await flush();
  assert.equal(view.of('changed').length, 2);
});

test('refresh：当前代次重新查询根目录并在变化时推送，旧代次忽略；hello 重发 session 和 root', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await started(fake, 'A');
  const queried = fake.queried('A');
  view.send({ type: 'refresh', generation: 0 });
  await flush();
  assert.equal(fake.queried('A'), queried);

  fake.threads.A = checkoutOf(join(root, 'src'));
  view.send({ type: 'refresh', generation: 1 });
  await waitFor(() => view.of('root').length === 2, '新 root');
  assert.equal(view.lastRoot().path, join(root, 'src'));
  view.send({ type: 'refresh', generation: 1 });
  await flush();
  assert.equal(view.of('root').length, 2, '没变不推送');

  view.send({ type: 'hello' });            // 页面重载：一样也要重发
  await waitFor(() => view.of('root').length === 3, 'hello 的 root');
  assert.equal(view.of('session').length, 2);
});

test('同一代次内两次查询乱序返回：旧的后到，不覆盖新的，也不再推送', async t => {
  const { root } = await repo(t);
  const calls = [];
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await started(fake, 'A');
  fake.threads.A = () => { const d = deferred(); calls.push(d); return d.promise; };
  view.send({ type: 'refresh', generation: 1 });
  view.send({ type: 'refresh', generation: 1 });
  await waitFor(() => calls.length === 2, '两次查询');
  const [older, newer] = [join(root, 'src'), root];
  calls[1].resolve(checkoutOf(newer));     // 后发的先回来：和已推送的一样，不推
  calls[0].resolve(checkoutOf(older));     // 先发的后回来：丢掉
  await flush();
  assert.deepEqual(view.of('root').map(m => m.path), [root]);
  fake.threads.A = () => checkoutOf(older);
  view.send({ type: 'refresh', generation: 1 });
  await waitFor(() => view.of('root').length === 2, '之后的查询照常');
  assert.equal(view.lastRoot().path, older);
});

test('查询根目录失败时保留上一次的结果，不推送，请求照常', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await started(fake, 'A');
  fake.threads.A = new Error('接口出错');
  view.send({ type: 'refresh', generation: 1 });
  await flush();
  assert.equal(view.of('root').length, 1);
  view.send({ type: 'list', generation: 1, requestId: 'l', path: '' });
  assert.ok((await view.answer('l')).entries);
});

test('轮询启停：A、B 都在 preparing 时切换，只轮询 B', async t => {
  const pending = trackTimers(t);
  const fake = fakeCoda({ A: checkoutOf(null, 'preparing'), B: checkoutOf(null, 'preparing') });
  const view = await started(fake, 'A');
  view.switchTo('B');
  await waitFor(() => view.lastRoot()?.generation === 2, 'B 的 root');
  await flush();
  assert.equal(pending.size, 1, '只有 B 的一个计时器');
  const [a, b] = [fake.queried('A'), fake.queried('B')];
  t.mock.timers.tick(POLL_MS);
  await waitFor(() => fake.queried('B') === b + 1, 'B 轮询');
  await flush();
  t.mock.timers.tick(POLL_MS);
  await waitFor(() => fake.queried('B') === b + 2, 'B 再轮询');
  assert.equal(fake.queried('A'), a, 'A 不再被轮询');
});

test('轮询启停：旧会话在途的轮询查询回来后不会重新挂起轮询；换到 ready 的会话后不轮询', async t => {
  const pending = trackTimers(t);
  const { root } = await repo(t);
  let hold = null;
  const fake = fakeCoda({ A: checkoutOf(null, 'preparing'), B: checkoutOf(root) });
  const view = await started(fake, 'A');
  fake.threads.A = () => { hold = deferred(); return hold.promise; };
  t.mock.timers.tick(POLL_MS);
  await waitFor(() => hold, 'A 的轮询查询在途');
  view.switchTo('B');
  await waitFor(() => view.lastRoot().state === 'ready', 'B ready');
  hold.resolve(checkoutOf(null, 'preparing'));
  await flush();
  assert.equal(pending.size, 0, '没有残留的轮询计时器');
  const count = fake.api.length;
  t.mock.timers.tick(POLL_MS * 5);
  await flush();
  assert.equal(fake.api.length, count);
});

test('轮询启停：视图关闭后，关闭前在途的查询回来也不会重新挂起轮询；watch 被取消', async t => {
  const pending = trackTimers(t);
  let hold = null;
  const fake = fakeCoda({ A: checkoutOf(null, 'preparing') });
  const view = await started(fake, 'A');
  fake.threads.A = () => { hold = deferred(); return hold.promise; };
  t.mock.timers.tick(POLL_MS);
  await waitFor(() => hold, '在途的轮询查询');
  await view.close();
  assert.equal(fake.disposed, 1);
  hold.resolve(checkoutOf(null, 'preparing'));
  await flush();
  assert.equal(pending.size, 0, '没有残留的轮询计时器');
  const count = fake.api.length, posted = view.posted.length;
  t.mock.timers.tick(POLL_MS * 5);
  await flush();
  assert.equal(fake.api.length, count);
  assert.equal(view.posted.length, posted);
});

test('视图关闭：挂着的轮询计时器被清掉，关闭后的请求和 watch 事件无动静', async t => {
  const pending = trackTimers(t);
  const fake = fakeCoda({ A: checkoutOf(null, 'preparing') });
  const view = await started(fake, 'A');
  const count = fake.api.length;
  assert.equal(pending.size, 1, '关闭前挂着一个轮询计时器');
  await view.close();
  assert.equal(pending.size, 0);
  t.mock.timers.tick(POLL_MS * 3);
  fake.emit('A', 't');
  view.send({ type: 'list', generation: 1, requestId: 'late', path: '' });
  await flush();
  assert.equal(fake.api.length, count);
  assert.equal(view.of('listed').length, 0);
});

test('换会话：session 先于新的 root；换到没有会话的状态是 none；同一会话的 context 不当作换会话', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await started(fake, 'A');
  view.switchTo('A');
  await flush();
  assert.equal(view.of('session').length, 1);
  view.switchTo(null);
  await waitFor(() => view.of('root').length === 2, '无会话的 root');
  assert.deepEqual(view.lastRoot(), { type: 'root', generation: 2, state: 'none', path: null, project: null });
  assert.deepEqual(view.of('session').at(-1), { type: 'session', generation: 2, session: null });
  const order = view.posted.map(m => m.type);
  assert.ok(order.lastIndexOf('session') < order.lastIndexOf('root'));
});

test('异常输入不让模块抛出：非对象、未知类型、缺请求号的 list', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await started(fake, 'A');
  for (const message of [null, 'x', 5, {}, { type: 'nope' }, { type: 'list', generation: 1, path: '' },
    { type: 'list', generation: 1, requestId: { a: 1 }, path: '' }, { type: 'list', generation: 1, requestId: 'x'.repeat(65), path: '' }]) {
    await view.send(message);
  }
  await flush();
  assert.equal(view.of('listed').length, 0);
});

// ---- 按视图解析会话（file 取 args.session，files 取 context.session）----

async function startedFile(fake, args, session = null) {
  activate(fake.coda);
  const view = fake.open(session, { view: 'file', args });
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  return view;
}

test('file 视图：从 args.session 取会话，并按它的根目录读文件', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root), B: checkoutOf('/nowhere') });
  const view = await startedFile(fake, { session: 'A', path: 'src/a.txt' }, 'B'); // context.session 不起作用
  assert.deepEqual(view.of('session'), [{ type: 'session', generation: 1, session: 'A' }]);
  assert.deepEqual(view.lastRoot(), { type: 'root', generation: 1, state: 'ready', path: root, project: null });
  assert.equal(fake.queried('B'), 0);
  view.send({ type: 'read', generation: 1, requestId: 'r1', path: 'src/a.txt', offset: 0 });
  assert.equal(Buffer.from((await view.answer('r1')).data, 'base64').toString(), 'hello');
});

test('file 视图：args 缺失或 session 不是非空字符串时没有会话，不查询', async t => {
  for (const args of [null, {}, { session: 5 }, { session: null }, { session: '' }, { session: ['A'] }, 'A']) {
    const { root } = await repo(t);
    const fake = fakeCoda({ A: checkoutOf(root) });
    const view = await startedFile(fake, args, 'A');
    assert.deepEqual(view.of('session'), [{ type: 'session', generation: 1, session: null }], JSON.stringify(args));
    assert.deepEqual(view.lastRoot(), { type: 'root', generation: 1, state: 'none', path: null, project: null }, JSON.stringify(args));
    assert.equal(fake.api.length, 0);
  }
});

test('files 视图：带了 args.session 也只跟随 context.session', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root), B: checkoutOf('/nowhere') });
  activate(fake.coda);
  const view = fake.open('A', { view: 'files', args: { session: 'B' } });
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  assert.equal(view.of('session')[0].session, 'A');
  assert.equal(fake.queried('B'), 0);
  view.switchTo('A', { session: 'B' }); // 只有 args 变了，会话没变
  await flush();
  assert.equal(view.of('session').length, 1, '没有换会话');
  view.switchTo(null, { session: 'A' }); // context.session 为空：args 帮不上忙
  await waitFor(() => view.of('session').length === 2, '换会话');
  assert.equal(view.of('session')[1].session, null);
  assert.equal(view.lastRoot().state, 'none');
});

test('file 视图：args.session 变了才换会话和代次，旧代次的请求不再回答', async t => {
  const { root, base } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root), B: checkoutOf(join(base, 'repo-other')) });
  const view = await startedFile(fake, { session: 'A', path: 'src/a.txt' });
  view.switchTo(null, { session: 'A', path: 'README.md' }); // 只换文件：会话不变
  await flush();
  assert.equal(view.of('session').length, 1);
  view.switchTo(null, { session: 'B', path: 'secret.txt' });
  await waitFor(() => view.of('session').length === 2, '换会话');
  assert.deepEqual(view.of('session')[1], { type: 'session', generation: 2, session: 'B' });
  await waitFor(() => view.lastRoot().generation === 2, '新根目录');
  assert.equal(view.lastRoot().path, join(base, 'repo-other'));
  view.send({ type: 'read', generation: 1, requestId: 'old', path: 'src/a.txt', offset: 0 });
  view.send({ type: 'read', generation: 2, requestId: 'new', path: 'secret.txt', offset: 0 });
  assert.equal(Buffer.from((await view.answer('new')).data, 'base64').toString(), 's');
  assert.equal(view.posted.some(m => m.requestId === 'old'), false);
});

test('file 视图：读文件受路径校验约束，越界和绝对路径都拒绝', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root) });
  const view = await startedFile(fake, { session: 'A', path: '../repo-other/secret.txt' });
  const cases = [
    ['../repo-other/secret.txt', 'invalid_path'], ['/etc/passwd', 'invalid_path'], ['out/secret.txt', 'outside_root'], ['src', 'not_file'],
  ];
  for (const [i, [path, code]] of cases.entries()) {
    view.send({ type: 'read', generation: 1, requestId: `p${i}`, path, offset: 0 });
    const reply = await view.answer(`p${i}`);
    assert.equal(reply.error?.code, code, path);
    assert.equal(reply.data, undefined);
  }
});

test('file 视图：本会话一轮结束先查根目录再推 changed；别的会话的不理', async t => {
  const { root } = await repo(t);
  const fake = fakeCoda({ A: checkoutOf(root), B: checkoutOf(root) });
  const view = await startedFile(fake, { session: 'A', path: 'README.md' });
  const before = fake.queried('A');
  fake.emit('B', 't'); fake.emit('B', null);
  fake.emit('A', 't');
  fake.emit('A', null);
  await waitFor(() => view.of('changed').length === 1, 'changed');
  assert.ok(fake.queried('A') > before, '先查询根目录');
  await flush();
  assert.equal(view.of('changed').length, 1);
});
