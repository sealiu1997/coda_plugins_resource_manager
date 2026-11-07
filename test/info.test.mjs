// stat 和 dir_size：lib/info.mjs 直接测，加从 activate 入口走到真实文件系统的整条链路。
import assert from 'node:assert/strict';
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { dirSize, statPath } from '../lib/info.mjs';
import { fromFsError } from '../lib/paths.mjs';
import { createListing } from '../lib/tree.mjs';
import { countingFs } from './support/countfs.mjs';
import { checkoutOf, deferred, fakeCoda, flush, tempDir, trackTimers, waitFor } from './support/fake.mjs';

async function file(path, size) {
  await writeFile(path, '');
  await truncate(path, size);
}

// base/repo 是工作目录；base/outside 在外面，有个大文件。
async function repo(t) {
  const base = await tempDir(t), root = join(base, 'repo'), outside = join(base, 'outside');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, 'sub', 'deep'), { recursive: true });
  await mkdir(join(root, 'empty'));
  await mkdir(outside);
  await file(join(root, 'a.txt'), 5);
  await file(join(root, '.hidden'), 3);
  await file(join(root, '.git', 'config'), 10);
  await file(join(root, 'sub', 'b.txt'), 100);
  await file(join(root, 'sub', 'deep', 'c.txt'), 1000);
  await file(join(outside, 'big.bin'), 50_000);
  await symlink(join(root, 'sub'), join(root, 'inlink')); // 指向内部的目录
  await symlink(join(root, 'a.txt'), join(root, 'filelink')); // 指向内部的文件
  await symlink(outside, join(root, 'outlink')); // 指向外面的大目录
  await symlink(join(base, 'nowhere'), join(root, 'dangling'));
  return { base, root, outside };
}

const listingOf = (spy, options) => createListing({ fs: spy.fs, ...options });

// 数每次排进并发上限的任务：同时排着的最大数量，和总次数。
function tracked(listing) {
  const stats = { now: 0, max: 0, calls: 0 }, run = listing.run;
  listing.run = async fn => {
    stats.calls++;
    stats.max = Math.max(stats.max, ++stats.now);
    try { return await run(fn); } finally { stats.now--; }
  };
  return stats;
}

// ---- stat ----

test('stat：普通文件、文件夹、根目录；读不到的字段不带', async t => {
  const { root } = await repo(t);
  const listing = createListing();
  const a = await statPath(listing, root, 'a.txt');
  assert.deepEqual([a.name, a.kind, a.size, a.link, a.target], ['a.txt', 'file', 5, undefined, undefined]);
  assert.ok(Number.isInteger(a.mtimeMs) && a.mtimeMs > 0);
  assert.ok(Number.isInteger(a.mode) && a.mode <= 0o7777 && (a.mode & 0o400) !== 0);

  const dir = await statPath(listing, root, 'sub/deep');
  assert.deepEqual([dir.name, dir.kind, dir.size], ['deep', 'dir', undefined], '文件夹的大小不在这里');
  assert.deepEqual((await statPath(listing, root, '')).kind, 'dir');
  assert.equal((await statPath(listing, root, 'sub/./deep/')).name, 'deep');

  const fs = { ...createListing().fs, lstat: async () => ({
    isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 7, mtimeMs: Number.NaN, birthtimeMs: 0, mode: 0o100640,
  }) };
  const bare = await statPath(createListing({ fs }), root, 'a.txt');
  assert.deepEqual(bare, { name: 'a.txt', kind: 'file', size: 7, mode: 0o640 }, '没有的修改时间、创建时间不带');
});

test('stat：链接。指向内部的按目标显示并给相对路径；指向外面和失效的只给自己，不给目标', async t => {
  const { root, outside } = await repo(t);
  const listing = createListing();
  const toDir = await statPath(listing, root, 'inlink');
  assert.deepEqual([toDir.name, toDir.kind, toDir.link, toDir.target], ['inlink', 'dir', true, 'sub']);
  const toFile = await statPath(listing, root, 'filelink');
  assert.deepEqual([toFile.kind, toFile.link, toFile.target, toFile.size], ['file', true, 'a.txt', 5]);
  const viaLink = await statPath(listing, root, 'inlink/b.txt');
  assert.deepEqual([viaLink.kind, viaLink.link], ['file', undefined], '父目录是链接时最后一级照常按自己读');

  for (const name of ['outlink', 'dangling']) {
    const info = await statPath(listing, root, name);
    assert.deepEqual([info.name, info.kind, info.link, info.target, info.size], [name, 'link', true, undefined, undefined], name);
    assert.ok(info.mtimeMs > 0, '链接自己的元数据');
    assert.doesNotMatch(JSON.stringify(info), /outside|nowhere/, '回答里没有外面的路径');
  }
  assert.ok(outside);
});

test('stat：越界、不存在、控制字符都拒绝，不泄露外面', async t => {
  const { root } = await repo(t);
  const listing = createListing();
  const code = path => statPath(listing, root, path).then(() => null, error => error.code);
  assert.equal(await code('../outside'), 'invalid_path');
  assert.equal(await code('/etc/passwd'), 'invalid_path');
  assert.equal(await code('a\u0000'), 'invalid_path');
  assert.equal(await code(7), 'invalid_path');
  assert.equal(await code('outlink/big.bin'), 'outside_root', '父目录是指向外面的链接');
  assert.equal(await code('nope'), 'not_found');
  assert.equal(await code('a.txt/x'), 'not_dir');
});

test('stat：校验之后的 lstat 不跟随链接。被换成指向外面的链接时，不读外面的元数据', async t => {
  const { root, outside } = await repo(t);
  const reads = [];
  const fs = { ...createListing().fs, lstat: (path, ...rest) => { reads.push(path); return createListing().fs.lstat(path, ...rest); } };
  const info = await statPath(createListing({ fs }), root, 'outlink');
  assert.equal(info.kind, 'link');
  assert.ok(!reads.some(path => path.startsWith(outside)), '没有对外面的路径调 lstat');
});

// ---- dir_size：数字和规则 ----

test('dir_size：文件字节数和项数，隐藏文件和 .git 都算；链接算一项、不跟随、不计大小', async t => {
  const { root } = await repo(t);
  const pending = trackTimers(t);
  const result = await dirSize(createListing(), root, '');
  // 顶层 9 项，.git/config 1，sub 里 2，deep/c.txt 1
  assert.deepEqual(result, { size: 5 + 3 + 10 + 100 + 1000, items: 13, complete: true, unreadable: 0 });
  assert.equal(pending.size, 0, '定时器清掉了');
  assert.deepEqual(await dirSize(createListing(), root, 'sub'), { size: 1100, items: 3, complete: true, unreadable: 0 });
  assert.deepEqual(await dirSize(createListing(), root, 'empty'), { size: 0, items: 0, complete: true, unreadable: 0 });
});

test('dir_size：从链接进入时用解析后的目录；外面的大目录不计入', async t => {
  const { root } = await repo(t);
  assert.equal((await dirSize(createListing(), root, 'inlink')).size, 1100);
  const code = path => dirSize(createListing(), root, path).then(() => null, error => error.code);
  assert.equal(await code('outlink'), 'outside_root');
  assert.equal(await code('a.txt'), 'not_dir');
  assert.equal(await code('nope'), 'not_found');
  assert.equal(await code('../outside'), 'invalid_path');
});

test('dir_size：读失败（子目录读不到、文件中途消失）计入 unreadable，其余照常统计', async t => {
  const { root } = await repo(t);
  const spy = countingFs({ hooks: {
    readdir: async (path, original) => {
      if (path.endsWith('deep')) throw Object.assign(new Error('x'), { code: 'EACCES' });
      return original(path);
    },
    lstat: async (path, original) => {
      if (path.endsWith('b.txt')) throw Object.assign(new Error('x'), { code: 'ENOENT' });
      return original(path);
    },
  } });
  const result = await dirSize(listingOf(spy), root, 'sub');
  // sub 里 b.txt（读失败，算一项）和 deep（读不到目录，deep 本身算一项）
  assert.deepEqual(result, { size: 0, items: 2, complete: true, unreadable: 2 });
});

test('dir_size：项数到上限，立刻回答 complete: false，不再发读取', async t => {
  const base = await tempDir(t), root = join(base, 'r');
  await mkdir(root);
  for (let i = 0; i < 10; i++) await file(join(root, `f${i}`), 1);
  const spy = countingFs();
  assert.deepEqual(await dirSize(listingOf(spy), root, '', { limit: 5 }), { size: 5, items: 5, complete: false, unreadable: 0 });
  assert.equal(spy.counts.lstat, 5, '只对上限内的条目发读取');

  const exact = countingFs();
  assert.equal((await dirSize(listingOf(exact), root, '', { limit: 10 })).complete, true, '正好 10 项且没有剩余，算统计完');
  const nested = countingFs();
  await mkdir(join(root, 'more'));
  assert.equal((await dirSize(listingOf(nested), root, '', { limit: 11 })).complete, false, '还有没进去的子目录');
});

test('dir_size：上限落在最后一批里（目录剩 1～3 项没数）也回答 complete: false', async t => {
  const base = await tempDir(t), root = join(base, 'r');
  await mkdir(root);
  for (let i = 0; i < 13; i++) await file(join(root, `f${i}`), 1);
  for (const [files, limit] of [[13, 11], [13, 12], [13, 9], [12, 11]]) {
    const dir = join(root, `case${files}-${limit}`);
    await mkdir(dir);
    for (let i = 0; i < files; i++) await file(join(dir, `g${i}`), 1);
    const result = await dirSize(createListing(), root, `case${files}-${limit}`, { limit });
    assert.deepEqual([result.items, result.complete], [limit, false], `${files} 个文件、上限 ${limit}`);
  }
  assert.equal((await dirSize(createListing(), root, 'case12-11', { limit: 12 })).complete, true, '上限等于项数：统计完');
});

test('dir_size：用时到 5 秒立刻回答，已发出的读取在后台收尾，结果不再计入', async t => {
  const { root } = await repo(t);
  const pending = trackTimers(t);
  const gate = deferred();
  const spy = countingFs({ hooks: { lstat: async (path, original) => { await gate.promise; return original(path); } } });
  const answer = dirSize(listingOf(spy), root, 'sub');
  await waitFor(() => spy.counts.lstat === 2, '两项都已发出');
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(pending.size, 1, '没到点还在计时');
  t.mock.timers.tick(1);
  const result = await answer;
  assert.deepEqual(result, { size: 0, items: 0, complete: false, unreadable: 0 });
  assert.equal(pending.size, 0);
  gate.resolve();
  await flush();
  assert.equal(spy.counts.lstat, 2, '收尾之后没有再发新读取');
  assert.deepEqual(result, { size: 0, items: 0, complete: false, unreadable: 0 }, '已回答的数字不被后来收尾的读取改动');
});

test('dir_size：统计排在别的任务后面，到 5 秒一项都没读 → items: 0；排到名额后先核对，不再发读取', async t => {
  const { root } = await repo(t);
  trackTimers(t);
  const spy = countingFs();
  const listing = listingOf(spy, { limit: 2 });
  const stats = tracked(listing);
  const gate = deferred();
  const held = [listing.run(() => gate.promise), listing.run(() => gate.promise)]; // 把名额占满
  const answer = dirSize(listing, root, '');
  await waitFor(() => stats.calls === 2 + 1, 'readdir 也经并发上限，已排进队');
  t.mock.timers.tick(5000);
  assert.deepEqual(await answer, { size: 0, items: 0, complete: false, unreadable: 0 });
  gate.resolve();
  await Promise.all(held);
  await flush();
  assert.equal(spy.counts.lstat, 0, '排到名额的任务先核对停止条件，一次都没读');
});

// ---- dir_size：5 秒从收到请求算起，解析起点也在里面（假的解析函数，不碰真实时限）----

// 解析起点由测试手里的 gate 控制；到点、取消、解析回来之后的核对都在这里验。
function slowResolve() {
  const gate = deferred(), calls = [];
  return { calls, gate, resolve: async (root, path) => { calls.push(path); return gate.promise; } };
}

test('dir_size：解析起点还没回来就到 5 秒 → items: 0、complete: false；之后解析回来也不读', async t => {
  const { root } = await repo(t);
  const pending = trackTimers(t);
  const spy = countingFs(), slow = slowResolve();
  const answer = dirSize(listingOf(spy), root, 'sub', { resolve: slow.resolve });
  await flush();
  assert.equal(pending.size, 1, '收到请求就开始计时，不等解析');
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(pending.size, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await answer, { size: 0, items: 0, complete: false, unreadable: 0 });
  slow.gate.resolve(join(root, 'sub'));
  await flush();
  assert.equal(spy.counts.readdir, 0, '解析回来时已经回答过，不再读');
  assert.equal(spy.counts.lstat, 0);
});

test('dir_size：解析途中取消 → 不回答，解析回来也不读，计时和监听都撤掉', async t => {
  const { root } = await repo(t);
  const pending = trackTimers(t);
  const spy = countingFs(), slow = slowResolve(), abort = new AbortController();
  const answer = dirSize(listingOf(spy), root, 'sub', { resolve: slow.resolve, signal: abort.signal });
  await flush();
  abort.abort();
  assert.equal(await answer, null);
  assert.equal(pending.size, 0);
  slow.gate.resolve(join(root, 'sub'));
  await flush();
  assert.equal(spy.counts.readdir, 0);
  assert.equal(spy.counts.lstat, 0);
});

test('dir_size：解析回来时 valid() 已经为假 → 不回答，不读', async t => {
  const { root } = await repo(t);
  const pending = trackTimers(t);
  const spy = countingFs(), slow = slowResolve();
  let alive = true;
  const answer = dirSize(listingOf(spy), root, 'sub', { resolve: slow.resolve, valid: () => alive });
  await flush();
  alive = false;
  slow.gate.resolve(join(root, 'sub'));
  assert.equal(await answer, null);
  assert.equal(pending.size, 0);
  assert.equal(spy.counts.readdir, 0);
  assert.equal(spy.counts.lstat, 0);
});

test('dir_size：解析失败按错误回答；解析在时限内回来照常统计', async t => {
  const { root } = await repo(t);
  trackTimers(t);
  const failing = dirSize(createListing(), root, 'sub', { resolve: async () => { throw fromFsError(Object.assign(new Error('x'), { code: 'ENOENT' })); } });
  await assert.rejects(failing, error => error.code === 'not_found');
  const slow = slowResolve();
  const answer = dirSize(createListing(), root, 'sub', { resolve: slow.resolve });
  await flush();
  slow.gate.resolve(join(root, 'sub'));
  assert.deepEqual(await answer, { size: 1100, items: 3, complete: true, unreadable: 0 });
});

// ---- dir_size：资源 ----

test('dir_size：同时排进并发上限的不超过 4 个，同时在读的也不超过 4 个，且一次只读一个目录', async t => {
  const base = await tempDir(t), root = join(base, 'r');
  await mkdir(root);
  for (let i = 0; i < 6; i++) {
    await mkdir(join(root, `d${i}`));
    for (let j = 0; j < 20; j++) await file(join(root, `d${i}`, `f${j}`), 1);
  }
  let reading = 0, maxReading = 0;
  const spy = countingFs({ hooks: { readdir: async (path, original) => {
    maxReading = Math.max(maxReading, ++reading);
    try { return await original(path); } finally { reading--; }
  } } });
  const listing = listingOf(spy), stats = tracked(listing);
  const result = await dirSize(listing, root, '');
  assert.deepEqual([result.items, result.size, result.complete], [6 + 120, 120, true]);
  assert.equal(stats.max, 4);
  assert.equal(spy.peak, 4);
  assert.equal(maxReading, 1);
});

// ---- 经 activate：整条链路 ----

async function started(fake, session, { spy = countingFs(), sizeLimits } = {}) {
  activate(fake.coda, { makeListing: () => createListing({ fs: spy.fs }), sizeLimits });
  const view = fake.open(session);
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  return { view, spy };
}
const send = (view, type, requestId, body = {}, generation = 1) => view.send({ type, generation, requestId, ...body });

test('经 activate：stat 和 dir_size 的回答；错误也有回答', async t => {
  const { root } = await repo(t);
  const { view } = await started(fakeCoda({ A: checkoutOf(root) }), 'A');
  send(view, 'stat', 's1', { path: 'sub/b.txt' });
  const stat = await view.answer('s1');
  assert.deepEqual([stat.type, stat.generation, stat.name, stat.kind, stat.size], ['statted', 1, 'b.txt', 'file', 100]);
  send(view, 'stat', 's2', { path: 'outlink/big.bin' });
  assert.deepEqual([(await view.answer('s2')).type, (await view.answer('s2')).error.code], ['statted', 'outside_root']);

  send(view, 'dir_size', 'd1', { path: '' });
  const sized = await view.answer('d1');
  assert.deepEqual(sized, { type: 'sized', generation: 1, requestId: 'd1', size: 1118, items: 13, complete: true, unreadable: 0 });
  send(view, 'dir_size', 'd2', { path: 'a.txt' });
  assert.deepEqual([(await view.answer('d2')).type, (await view.answer('d2')).error.code], ['sized', 'not_dir']);
  assert.equal(view.dropped.length, 0);
});

test('经 activate：没有根目录时 stat、dir_size、add_text 都回答 no_root，且不碰草稿接口', async t => {
  const fake = fakeCoda({ N: {}, P: checkoutOf(null, 'preparing') });
  activate(fake.coda);
  for (const session of ['N', 'P', null]) {
    const view = fake.open(session);
    view.send({ type: 'hello' });
    await waitFor(() => view.of('root').length === 1, 'root');
    for (const [type, body] of [['stat', { path: 'a' }], ['dir_size', { path: '' }], ['add_text', { text: 'x', block: false }]]) {
      send(view, type, type);
      const reply = await view.answer(type);
      assert.equal(reply.error.code, 'no_root', `${session} ${type}`);
    }
    view.close();
  }
  assert.ok(fake.api.every(path => /^threads\/[^/]+$/.test(path)), '只查过会话，没有别的接口调用');
});

test('经 activate：取消后不再发读取，也不回答；迟到的取消和代次不对的取消不影响新统计', async t => {
  const { root } = await repo(t);
  const base = join(root, 'big');
  await mkdir(base);
  for (let i = 0; i < 12; i++) await file(join(base, `f${i}`), 1);
  let gate = deferred();
  const spy = countingFs({ hooks: { lstat: async (path, original) => { await gate.promise; return original(path); } } });
  const { view } = await started(fakeCoda({ A: checkoutOf(root) }), 'A', { spy });

  send(view, 'dir_size', 'r1', { path: 'big' });
  await waitFor(() => spy.counts.lstat === 4, '第一批已发出');
  send(view, 'dir_size_cancel', null, { requestId: 'r1' });
  gate.resolve();
  await flush();
  assert.equal(spy.counts.lstat, 4, '取消后没有排下一批');
  assert.equal(view.of('sized').length, 0, '取消不回答');

  // 迟到的取消：r1 已经没了，r2 开始后收到它不受影响；代次不对的取消也一样
  gate = deferred();
  send(view, 'dir_size', 'r2', { path: 'big' });
  await waitFor(() => spy.counts.lstat === 8, 'r2 的第一批');
  send(view, 'dir_size_cancel', null, { requestId: 'r1' });
  send(view, 'dir_size_cancel', null, { requestId: 'r2' }, 99);
  send(view, 'dir_size_cancel', null, { requestId: 'nope' });
  gate.resolve();
  const reply = await view.answer('r2');
  assert.deepEqual([reply.items, reply.size, reply.complete], [12, 12, true]);
});

test('经 activate：新统计让旧的静默停止；旧的不回答、不再读', async t => {
  const { root } = await repo(t);
  await mkdir(join(root, 'big'));
  for (let i = 0; i < 12; i++) await file(join(root, 'big', `f${i}`), 1);
  const gate = deferred();
  const spy = countingFs({ hooks: { lstat: async (path, original) => { if (path.includes('big')) await gate.promise; return original(path); } } });
  const { view } = await started(fakeCoda({ A: checkoutOf(root) }), 'A', { spy });
  send(view, 'dir_size', 'old', { path: 'big' });
  await waitFor(() => spy.counts.lstat === 4, '旧的第一批');
  send(view, 'dir_size', 'new', { path: 'sub' });
  const reply = await view.answer('new');
  assert.deepEqual([reply.items, reply.size, reply.complete], [3, 1100, true]);
  gate.resolve();
  await flush();
  assert.equal(view.of('sized').length, 1, '只有新的有回答');
  assert.equal(spy.counts.lstat, 4 + 3 + 1, '旧的没有排第二批（新的 3 项，加进 deep 之前再 lstat 它一次）');
});

test('经 activate：换会话、根目录变化、视图关闭时进行中的统计停止，不回答，计时器清掉', async t => {
  const pending = trackTimers(t);
  const a = await repo(t), b = await repo(t);
  await mkdir(join(a.root, 'big'));
  for (let i = 0; i < 12; i++) await file(join(a.root, 'big', `f${i}`), 1);
  const cases = {
    '换会话': (fake, view) => view.switchTo('B'),
    '根目录变化': (fake, view) => {
      fake.threads.A = checkoutOf(b.root);
      fake.emit('A', null, 'ADDED');
      fake.emit('A', 't');
      fake.emit('A', null);
    },
    '视图关闭': (fake, view) => view.close(),
  };
  for (const [name, act] of Object.entries(cases)) {
    const gate = deferred();
    const spy = countingFs({ hooks: { lstat: async (path, original) => { if (path.includes('big')) await gate.promise; return original(path); } } });
    const fake = fakeCoda({ A: checkoutOf(a.root), B: checkoutOf(b.root) });
    const { view } = await started(fake, 'A', { spy });
    send(view, 'dir_size', 'r', { path: 'big' });
    await waitFor(() => spy.counts.lstat === 4, `${name}：第一批`);
    const before = spy.counts.lstat;
    act(fake, view);
    await flush();
    assert.equal(pending.size, 0, `${name}：读取还卡着时，统计的计时器已经清掉`);
    gate.resolve();
    await flush();
    assert.equal(view.of('sized').length, 0, `${name}：不回答`);
    assert.equal(spy.counts.lstat, before, `${name}：没有再发读取`);
    assert.equal(pending.size, 0, `${name}：没有残留计时器`);
    view.close();
  }
});

test('经 activate：统计进行时列目录请求及时回答，统计排的任务不超过 4 个', async t => {
  const { root } = await repo(t);
  await mkdir(join(root, 'big'));
  for (let i = 0; i < 400; i++) await file(join(root, 'big', `f${i}`), 1);
  const spy = countingFs();
  let listing;
  const fake = fakeCoda({ A: checkoutOf(root) });
  activate(fake.coda, { makeListing: () => (listing = listingOf(spy)) });
  const view = fake.open('A');
  view.send({ type: 'hello' });
  await waitFor(() => view.of('root').length > 0, 'root');
  const stats = tracked(listing);
  send(view, 'dir_size', 'big', { path: 'big' });
  await waitFor(() => spy.counts.lstat > 20, '统计在进行');
  send(view, 'list', 'l', { path: 'sub', cursor: null, sort: 'date' });
  const listed = await view.answer('l');
  assert.equal(listed.error, undefined);
  assert.equal(view.of('sized').length, 0, '列目录先于整个统计回答');
  const sized = await view.answer('big');
  assert.equal(sized.items, 400);
  assert.ok(stats.max <= 4 + 2, '统计最多 4 个，加上列目录自己的 2 个');
});

test('经 activate：统计超过项数上限，回答 complete: false', async t => {
  const { root } = await repo(t);
  const { view } = await started(fakeCoda({ A: checkoutOf(root) }), 'A', { sizeLimits: { limit: 6 } });
  send(view, 'dir_size', 'r', { path: '' });
  const reply = await view.answer('r');
  assert.deepEqual([reply.items, reply.complete], [6, false]);
});
