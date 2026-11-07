// 走树（lib/walk.mjs）：顺序、并发上限、队列字节上限、进目录前再 lstat、排空信号。用假文件系统，读取由测试里的 gate 控制。
import assert from 'node:assert/strict';
import test from 'node:test';
import { startWalk } from '../lib/walk.mjs';
import { deferred, flush, waitFor } from './support/fake.mjs';
import { fakeTree } from './support/walkfs.mjs';

const TREE = { '': ['a/', 'b/', 'c.txt'], a: ['a1/', 'a.txt'], b: ['b1/'], 'a/a1': [], 'b/b1': [] };
const start = (tree, options = {}) => startWalk(tree.listing, tree.root, '', { visit: () => true, resolve: tree.resolve, ...options });
// 一次读取有没有结束：drained 是不是已经解析。
const settled = async promise => { let done = false; promise.then(() => { done = true; }); await flush(); return done; };

test('走树顺序：depth 是栈（后进先出），breadth 按层先浅后深；同一层按目录出队的顺序', async t => {
  const breadth = fakeTree(TREE), depth = fakeTree(TREE);
  assert.equal((await start(breadth, { order: 'breadth', ordered: true }).result).reason, 'done');
  assert.equal((await start(depth, { order: 'depth' }).result).reason, 'done');
  assert.deepEqual(breadth.order.readdir, ['/r', '/r/a', '/r/b', '/r/a/a1', '/r/b/b1']);
  assert.deepEqual(depth.order.readdir, ['/r', '/r/b', '/r/b/b1', '/r/a', '/r/a/a1']);
});

test('readdir 和 lstat 一样经并发上限排队：名额被占满时 readdir 不发，排到后先核对停止条件', async t => {
  const tree = fakeTree(TREE, { limit: 1 });
  const gate = deferred();
  const held = tree.listing.run(() => gate.promise);
  const walk = start(tree);
  await flush();
  assert.equal(tree.counts.readdir, 0, '名额占满：readdir 排在队里');
  walk.stop('time');
  gate.resolve();
  await held;
  assert.equal((await walk.result).reason, 'time');
  await walk.drained;
  assert.equal(tree.counts.readdir, 0, '排到名额时已经停了，不读');
});

test('同一次走树同一时间只读一个目录，条目的 lstat 一批最多 4 个', async t => {
  const names = Array.from({ length: 20 }, (_, i) => `f${i}`), tree = fakeTree({ '': [...names, 'd/'], d: names });
  let reading = 0, peakReading = 0, lstats = 0, peakLstat = 0;
  const { readdir, lstat } = tree.fs;
  tree.fs.readdir = async path => { peakReading = Math.max(peakReading, ++reading); try { return await readdir(path); } finally { reading--; } };
  tree.fs.lstat = async path => { peakLstat = Math.max(peakLstat, ++lstats); try { return await lstat(path); } finally { lstats--; } };
  const done = await start(tree, { order: 'breadth', ordered: true }).result;
  assert.deepEqual([done.reason, done.items], ['done', 21 + 20]);
  assert.equal(peakReading, 1);
  assert.equal(peakLstat, 4);
});

test('队列里目录路径的总字节到上限就停，原因 queue', async t => {
  const tree = fakeTree({ '': ['aaaa/', 'bbbb/', 'cccc/'], aaaa: [], bbbb: [], cccc: [] });
  const done = await start(tree, { order: 'breadth', ordered: true, queueBytes: 20 }).result; // 每条 7 字节，第三条超过
  assert.equal(done.reason, 'queue');
  assert.equal(tree.counts.readdir, 1, '没有再进别的目录');
  const roomy = fakeTree({ '': ['aaaa/', 'bbbb/', 'cccc/'], aaaa: [], bbbb: [], cccc: [] });
  assert.equal((await start(roomy, { order: 'breadth', ordered: true, queueBytes: 21 }).result).reason, 'done', '正好放得下');
});

test('进目录前再 lstat 一次：已经不是目录（被换成链接）就跳过；不重复计入 items；读不到计入 unreadable', async t => {
  const tree = fakeTree({ '': ['a/', 'b/'], a: ['x'], b: ['y'] });
  const seen = {}, { lstat } = tree.fs;
  tree.fs.lstat = async path => {
    const info = await lstat(path);
    seen[path] = (seen[path] ?? 0) + 1;
    if (path === '/r/a' && seen[path] === 2) return { ...info, isDirectory: () => false, isSymbolicLink: () => true }; // 被换成链接
    if (path === '/r/b' && seen[path] === 2) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return info;
  };
  const done = await start(tree, { order: 'breadth', ordered: true }).result;
  assert.deepEqual(tree.order.readdir, ['/r'], '两个目录都没有进');
  assert.deepEqual([done.reason, done.items, done.unreadable], ['done', 2, 1], '每项只计一次；读不到的目录计入 unreadable，变成链接的不计');
  assert.equal(seen['/r/a'], 2);
});

test('不跟随链接进目录：链接算一项，只进 lstat 说是目录的', async t => {
  const tree = fakeTree({ '': [{ name: 'l', kind: 'link', to: '/r/d' }, 'd/'], d: ['x'] });
  const done = await start(tree, { order: 'breadth', ordered: true }).result;
  assert.deepEqual(tree.order.readdir, ['/r', '/r/d']);
  assert.equal(done.items, 3);
});

test('visit 的返回决定进不进，tag 带给里面的条目', async t => {
  const tree = fakeTree({ '': ['a/', 'skip/'], a: ['x'], skip: ['y'] }), tags = [];
  const done = await start(tree, {
    order: 'breadth', ordered: true, tag: 'T',
    visit: ({ name, tag }) => { tags.push([name, tag]); return name === 'skip' ? false : { tag: `${tag}/${name}` }; },
  }).result;
  assert.equal(done.reason, 'done');
  assert.deepEqual(tags, [['a', 'T'], ['skip', 'T'], ['x', 'T/a']]);
  assert.deepEqual(tree.order.readdir, ['/r', '/r/a']);
});

test('ordered：一批的 lstat 谁先回来都按 readdir 的名字顺序提交；不 ordered 则按回来的先后', async t => {
  const names = ['n1', 'n2', 'n3', 'n4'];
  for (const ordered of [true, false]) {
    const tree = fakeTree({ '': names }), gate = deferred(), seen = [];
    tree.gates.lstat.set('/r/n1', gate);
    const walk = start(tree, { ordered, visit: ({ name }) => { seen.push(name); return false; } });
    await waitFor(() => tree.counts.lstat === 4, '一批已发出');
    await flush();
    gate.resolve();
    await walk.result;
    assert.deepEqual(seen, ordered ? names : ['n2', 'n3', 'n4', 'n1']);
  }
});

test('排空：走完后马上排空；中途在途个数暂时为 0（visit 在等）不算排空', async t => {
  const tree = fakeTree({ '': ['a', 'b'] }), pause = deferred();
  const walk = start(tree, { ordered: true, visit: async () => { await pause.promise; return false; } });
  await waitFor(() => tree.counts.lstat === 2, 'lstat 已发出');
  await flush();
  assert.equal(await settled(walk.drained), false, '一批读完、visit 还在等：在途为 0，但没有停止派发，不算排空');
  pause.resolve();
  assert.equal((await walk.result).reason, 'done');
  assert.equal(await settled(walk.drained), true, '走完且没有在途读取：排空');
});

test('排空：在途为 0 的间隙之后被取消，仍要等它随后发出的读取回来', async t => {
  const tree = fakeTree({ '': ['a/', 'b'], a: ['x'] }), pause = deferred(), gate = deferred(), abort = new AbortController();
  tree.gates.readdir.set('/r/a', gate);
  const walk = start(tree, { order: 'breadth', ordered: true, signal: abort.signal, visit: async ({ name }) => { if (name === 'b') await pause.promise; return name === 'a' ? true : false; } });
  await waitFor(() => tree.counts.lstat === 2, '第一批');
  await flush();
  assert.equal(await settled(walk.drained), false);
  pause.resolve();
  await waitFor(() => tree.counts.readdir === 2, '进 a：readdir 已发出（扣在 gate 里）');
  abort.abort();
  assert.equal(await walk.result, null, '请求立刻静默结算');
  assert.equal(await settled(walk.drained), false, '但 readdir 还没回来：没有排空');
  gate.resolve();
  await walk.drained;
});

test('排空：起点解析、进目录前的 lstat、readdir、条目的 lstat、调用方 track 的读取，每一种都要等', async t => {
  const cases = {
    起点解析: tree => { const gate = deferred(); return { gate, options: { resolve: async () => { await gate.promise; return tree.root; } }, ready: () => true }; },
    进目录前的lstat: tree => {
      const gate = deferred(), { lstat } = tree.fs; // 同一路径的第一次（条目的 lstat）放行，第二次（进目录前）扣住
      let seen = 0;
      tree.fs.lstat = async path => { if (path === '/r/a' && ++seen === 2) await gate.promise; return lstat(path); };
      return { gate, options: {}, ready: () => seen === 2 };
    },
    readdir: tree => { const gate = deferred(); tree.gates.readdir.set('/r', gate); return { gate, options: {}, ready: () => tree.counts.readdir === 1 }; },
    条目的lstat: tree => { const gate = deferred(); tree.gates.lstat.set('/r/a', gate); return { gate, options: {}, ready: () => tree.counts.lstat === 1 }; },
  };
  for (const [name, build] of Object.entries(cases)) {
    const tree = fakeTree({ '': ['a/'], a: [] }), { gate, options, ready } = build(tree), abort = new AbortController();
    const walk = start(tree, { order: 'breadth', ordered: true, signal: abort.signal, ...options });
    await waitFor(ready, `${name}：读取已发出`);
    abort.abort();
    assert.equal(await walk.result, null, name);
    assert.equal(await settled(walk.drained), false, `${name}：读取还没回来，没有排空`);
    gate.resolve();
    await walk.drained;
  }
  // 调用方自己的读取（链接分类）经 track 登记
  const tree = fakeTree({ '': ['a'] }), gate = deferred(), abort = new AbortController();
  const walk = start(tree, { signal: abort.signal, visit: () => { walk.track(() => gate.promise); return false; } });
  await waitFor(() => tree.counts.lstat === 1, 'lstat');
  await flush();
  abort.abort();
  assert.equal(await settled(walk.drained), false, 'track 登记的读取没回来');
  gate.resolve();
  await walk.drained;
});

test('结算之后不再派发新的读取，回来的结果不再计入', async t => {
  const tree = fakeTree({ '': ['a/', 'b/'], a: ['x'], b: ['y'] }), gate = deferred(), seen = [];
  tree.gates.readdir.set('/r', gate);
  const walk = start(tree, { order: 'breadth', ordered: true, visit: ({ name }) => { seen.push(name); return true; } });
  await waitFor(() => tree.counts.readdir === 1, 'readdir 已发出');
  walk.stop('count');
  gate.resolve();
  const done = await walk.result;
  await walk.drained;
  assert.deepEqual([done.reason, done.items], ['count', 0]);
  assert.deepEqual(seen, []);
  assert.equal(tree.counts.lstat, 0);
});
