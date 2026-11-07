// 文件名搜索（lib/search.mjs）：请求校验、匹配、收集和排序、停止原因、单槽、排空屏障。假文件系统，读取由 gate 控制，计时用假时钟。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearcher } from '../lib/search.mjs';
import { PAGE_BYTES } from '../view/protocol.mjs';
import { deferred, flush, trackTimers, waitFor } from './support/fake.mjs';
import { fakeTree } from './support/walkfs.mjs';

const make = (tree, limits = {}) => createSearcher(tree.listing, { resolve: tree.resolve, ...limits });
// 一次 search 请求；valid 默认永远有效。
const ask = (searcher, tree, query, { hidden = false, id = 'r1', generation = 1, valid = () => true } = {}) => (
  searcher.search({ query, hidden }, { root: tree.root, valid, generation, requestId: id }));
const paths = reply => reply.results.map(item => item.path);
const rejected = promise => promise.then(() => null, error => error.code);
const settled = async promise => { let done = false; promise.then(() => { done = true; }, () => { done = true; }); await flush(); return done; };

// ---- 请求校验 ----

test('请求校验：query 须是去掉首尾空白后 1～256 个字符、不含控制字符的字符串，hidden 须是布尔值；不合格回答 invalid_query', async t => {
  const tree = fakeTree({ '': ['a'] }), searcher = make(tree);
  const bad = [{ query: 5, hidden: false }, { query: undefined, hidden: false }, { query: '', hidden: false }, { query: '  \t ', hidden: false },
    { query: 'x'.repeat(257), hidden: false }, { query: 'a\u0000b', hidden: false }, { query: 'a\tb', hidden: false }, { query: 'a', hidden: 'no' }, { query: 'a' }];
  for (const message of bad) {
    assert.equal(await rejected(searcher.search(message, { root: tree.root, valid: () => true, generation: 1, requestId: 'r' })), 'invalid_query', JSON.stringify(message).slice(0, 40));
  }
  assert.equal(tree.counts.readdir, 0, '不合格的请求不读文件系统');
  assert.deepEqual(paths(await ask(searcher, tree, `  ${'a'.repeat(256)}\n`)), [], '去掉首尾空白后正好 256 个字符：合格');
  assert.deepEqual(paths(await ask(searcher, tree, '  a ')), ['a']);
});

// ---- 匹配 ----

test('匹配：不分大小写，包含就算；中文；分解形式的名字能被组合形式的词找到，反之亦然；回答里的 path 是原始名字', async t => {
  const decomposed = 'Café.txt', composed = 'Café-2.txt';
  const tree = fakeTree({ '': ['README.md', decomposed, composed, '中文文件.txt', 'other.txt'] }), searcher = make(tree);
  assert.deepEqual(paths(await ask(searcher, tree, 'readme')), ['README.md']);
  assert.deepEqual(paths(await ask(searcher, tree, 'READ')), ['README.md']);
  assert.deepEqual(paths(await ask(searcher, tree, '文件')), ['中文文件.txt']);
  assert.deepEqual(paths(await ask(searcher, tree, 'café')).sort(), [composed, decomposed].sort(), '组合形式的词找到分解形式的名字');
  assert.deepEqual(paths(await ask(searcher, tree, 'café')).sort(), [composed, decomposed].sort(), '分解形式的词找到组合形式的名字');
  assert.ok(paths(await ask(searcher, tree, 'café')).includes(decomposed), 'path 保持原始写法（分解形式）');
});

test('只比名字，不比路径：带斜杠的词找不到', async t => {
  const tree = fakeTree({ '': ['src/'], src: ['foo.js'] }), searcher = make(tree);
  assert.deepEqual(paths(await ask(searcher, tree, 'src/foo')), []);
  assert.deepEqual(paths(await ask(searcher, tree, 'foo')), ['src/foo.js']);
});

test('隐藏开关：hidden 为假时隐藏名单里的名字不算匹配、也不进；为真时算，并且进（.git 除外）', async t => {
  const spec = { '': ['.DS_Store/', '.git/', 'node_modules/', 'keep.txt'], '.DS_Store': ['inside-ds.txt'], '.git': ['inside-git.txt'], node_modules: ['inside-nm.txt'] };
  const tree = fakeTree(spec), searcher = make(tree);
  assert.deepEqual(paths(await ask(searcher, tree, 'ds_store')), [], '隐藏时 .DS_Store 不是结果');
  assert.deepEqual(paths(await ask(searcher, tree, 'inside')), [], '隐藏时不进隐藏名单里的目录；.git、node_modules 始终不进');
  assert.deepEqual(tree.order.readdir.filter(path => path !== '/r'), []);
  tree.order.readdir.length = 0;
  assert.deepEqual(paths(await ask(searcher, tree, 'ds_store', { hidden: true })), ['.DS_Store'], '显示隐藏文件：.DS_Store 可以是结果');
  assert.deepEqual(paths(await ask(searcher, tree, 'inside', { hidden: true })), ['.DS_Store/inside-ds.txt'], '.DS_Store 目录进了，.git、node_modules 仍不进');
  assert.deepEqual(paths(await ask(searcher, tree, 'git', { hidden: true })), ['.git'], '.git 自己可以作为结果');
  assert.deepEqual(paths(await ask(searcher, tree, 'node_modules')), ['node_modules'], 'node_modules 自己可以作为结果（隐藏与否都一样）');
  assert.ok(!tree.order.readdir.includes('/r/.git') && !tree.order.readdir.includes('/r/node_modules'));
});

test('链接：匹配上的才分类；指向工作目录内的显示成 dir/file 带 link: true，指向外面或失效的是 link；一律不进', async t => {
  const tree = fakeTree({ '': [
    'f.txt', 'd/', { name: 'ln-file', kind: 'link', to: '/r/f.txt' }, { name: 'ln-dir', kind: 'link', to: '/r/d' },
    { name: 'ln-out', kind: 'link', to: '/elsewhere/x' }, { name: 'ln-dead', kind: 'link' }, { name: 'zz', kind: 'link', to: '/r/f.txt' },
  ], d: ['inner'] });
  const searcher = make(tree), reply = await ask(searcher, tree, 'ln-');
  assert.deepEqual(Object.fromEntries(reply.results.map(item => [item.path, item])), {
    'ln-dead': { path: 'ln-dead', kind: 'link' }, 'ln-dir': { path: 'ln-dir', kind: 'dir', link: true },
    'ln-file': { path: 'ln-file', kind: 'file', link: true }, 'ln-out': { path: 'ln-out', kind: 'link' },
  });
  assert.equal(tree.counts.realpath, 4, '只对匹配上的链接分类，zz 没有');
  assert.deepEqual(tree.order.readdir, ['/r', '/r/d'], '链接不进，d 只因为它自己是目录才进');
});

test('名字含控制字符的算 other、不进；拼出来的路径超过 MAX_PATH 的不算结果也不进', async t => {
  const spec = { '': ['bad\nname.txt', 'bad\ndir/', 'x1/'], 'bad\ndir': ['bad-inner.txt'] };
  let dir = 'x1';
  const LEVELS = 13;
  for (let i = 2; i <= LEVELS; i++) { // 每层 401 个字符：到第 11 层目录自己的路径就超过 4096
    const name = `${String(i).padStart(2, '0')}${'d'.repeat(398)}`;
    spec[dir] = [`${name}/`, `needle-${i - 1}.txt`];
    dir = `${dir}/${name}`;
  }
  spec[dir] = [`needle-${LEVELS}.txt`];
  const tree = fakeTree(spec), searcher = make(tree);
  const reply = await ask(searcher, tree, 'bad');
  assert.deepEqual(reply.results.map(item => [item.path, item.kind]).sort(), [['bad\ndir', 'other'], ['bad\nname.txt', 'other']]);
  assert.ok(!tree.order.readdir.includes('/r/bad\ndir'), '含控制字符的目录不进');
  const needles = await ask(searcher, tree, 'needle');
  assert.ok(needles.results.length >= 9 && needles.results.length < LEVELS, `超长的没有进结果：${needles.results.length}/${LEVELS}`);
  assert.ok(needles.results.every(item => item.path.length <= 4096));
  assert.ok(!tree.order.readdir.includes(`/r/${dir}`), '超长路径的目录不进');
});

// ---- 收集和排序 ----

test('排序：名字以搜索词开头的在前；同组浅的在前；再按路径逐段用目录列表的名称比较', async t => {
  const tree = fakeTree({
    '': ['docs/', 'src/', 'foo.txt', 'a-foo.txt', 'FOO.md'], docs: ['foo/', 'x-foo.txt'], 'docs/foo': [],
    src: ['foo.js', 'lib/'], 'src/lib': ['foo.ts', 'foobar.ts'],
  });
  assert.deepEqual(paths(await ask(make(tree), tree, 'foo')), [
    'FOO.md', 'foo.txt', 'docs/foo', 'src/foo.js', 'src/lib/foo.ts', 'src/lib/foobar.ts', 'a-foo.txt', 'docs/x-foo.txt',
  ]);
});

test('收集顺序：按层；同一目录按 readdir 的名字顺序提交，不按 lstat 回来的先后（到条数上限时看得出）', async t => {
  const tree = fakeTree({ '': ['d/', 'm1', 'm2', 'm3', 'm4'], d: ['m5'] }), gate = deferred();
  tree.gates.lstat.set('/r/m1', gate); // m1 的 lstat 最后才回来
  const pending = ask(make(tree, { results: 2 }), tree, 'm');
  await waitFor(() => tree.counts.lstat === 4, '第一批');
  await flush();
  gate.resolve();
  const reply = await pending;
  assert.equal(reply.stop, 'count');
  assert.deepEqual(paths(reply), ['m1', 'm2'], '先提交 m1、m2，不是先回来的 m2、m3');
  const layers = fakeTree({ '': ['d/', 'm1'], d: ['m5/', 'm6'], 'd/m5': ['m7'] });
  assert.deepEqual(paths(await ask(make(layers, { results: 3 }), layers, 'm')), ['m1', 'd/m5', 'd/m6'], '到 3 条就停：先浅后深');
});

// ---- 停止原因（全部六种）和回答 ----

test('停止原因 done：走完整棵树；scanned 含隐藏的和不进的目录本身，不含不进的目录里面的', async t => {
  const tree = fakeTree({ '': ['.git/', 'node_modules/', '.DS_Store', 'a/', 'f.txt'], '.git': ['c1', 'c2'], node_modules: ['n'], a: ['x'] });
  const reply = await ask(make(tree), tree, 'f');
  assert.deepEqual([reply.stop, reply.scanned, reply.unreadable], ['done', 6, 0]);
});

test('停止原因 count：到 500 条（默认）就停，只给已收集的', async t => {
  const tree = fakeTree({ '': Array.from({ length: 600 }, (_, i) => `m${i}`) });
  const result = await ask(make(tree), tree, 'm');
  assert.deepEqual([result.stop, result.results.length], ['count', 500]);
});

test('停止原因 bytes：最终回答（含信封）的 JSON UTF-8 字节不超过上限，排好序后从尾部去掉放不下的', async t => {
  const names = Array.from({ length: 60 }, (_, i) => `文件${String(i).padStart(2, '0')}.txt`);
  const tree = fakeTree({ '': names });
  const limit = 1000, reply = await ask(make(tree, { pageBytes: limit }), tree, '文件', { id: 'req-1' });
  const size = body => Buffer.byteLength(JSON.stringify({ type: 'searched', generation: 1, requestId: 'req-1', ...body }));
  assert.equal(reply.stop, 'bytes');
  assert.ok(size(reply) <= limit, `回答 ${size(reply)} 字节`);
  assert.ok(reply.results.length > 0 && reply.results.length < 60);
  assert.ok(size({ ...reply, results: [...reply.results, { path: names[reply.results.length], kind: 'file' }] }) > limit, '再多放一条就超了');
  assert.deepEqual(paths(reply), [...names].sort().slice(0, reply.results.length), '去掉的是排在后面的');
  const all = await ask(make(tree), tree, '文件');
  assert.ok(size(all) <= PAGE_BYTES);
  assert.equal(all.stop, 'done', '放得下时不是 bytes');
});

test('停止原因 items：lstat 过的条目到上限就停，已发出的读取不再计入', async t => {
  const tree = fakeTree({ '': ['a', 'b', 'c', 'd', 'e', 'f'] });
  const reply = await ask(make(tree, { items: 5 }), tree, 'zzz');
  assert.deepEqual([reply.stop, reply.scanned], ['items', 5]);
  const exact = fakeTree({ '': ['a', 'b', 'c'] });
  assert.equal((await ask(make(exact, { items: 3 }), exact, 'zzz')).stop, 'done', '正好看完最后一项且没有剩余：done');
});

test('停止原因 queue：待访问目录的路径总字节到上限就停', async t => {
  const tree = fakeTree({ '': ['aaaa/', 'bbbb/', 'cccc/', 'hit.txt'], aaaa: [], bbbb: [], cccc: [] });
  const reply = await ask(make(tree, { queueBytes: 20 }), tree, 'hit');
  assert.equal(reply.stop, 'queue');
  assert.deepEqual(paths(reply), [], '停在第三个目录入队时，还没来得及提交 hit.txt');
});

test('停止原因 time：5 秒到了回答已收集的；等屏障的时间也算在里面', async t => {
  const pending = trackTimers(t), tree = fakeTree({ '': ['hit.txt', 'd/'], d: ['hit2.txt'] }), gate = deferred();
  tree.gates.readdir.set('/r/d', gate);
  const answer = ask(make(tree), tree, 'hit');
  await waitFor(() => tree.counts.readdir === 2, '进了 d');
  assert.equal(pending.size, 1, '收到请求就开始计时');
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(await settled(answer), false);
  t.mock.timers.tick(1);
  const reply = await answer;
  assert.deepEqual([reply.stop, paths(reply)], ['time', ['hit.txt']]);
  assert.equal(pending.size, 0, '结算后计时撤掉');
  gate.resolve();
});

test('unreadable：读不到的目录和 lstat 失败的条目合计；scanned 是 lstat 过的条目数', async t => {
  const tree = fakeTree({ '': ['ok.txt', 'bad.txt', 'locked/', 'sub/'], locked: ['x'], sub: ['y.txt'] });
  tree.fail.lstat.add('/r/bad.txt');
  tree.fail.readdir.add('/r/locked');
  const reply = await ask(make(tree), tree, 'y');
  assert.deepEqual([reply.stop, reply.scanned, reply.unreadable, paths(reply)], ['done', 5, 2, ['sub/y.txt']]);
});

test('起点读不到按错误回答（不是静默）', async t => {
  const tree = fakeTree({ '': ['a'] });
  tree.fail.readdir.add('/r');
  assert.equal(await rejected(ask(make(tree), tree, 'a')), 'denied');
});

// ---- 单槽 ----

test('单槽：新的搜索让旧的静默结束（不回答），只有新的有结果', async t => {
  const tree = fakeTree({ '': ['hit-a', 'hit-b'] }), gate = deferred(), searcher = make(tree);
  tree.gates.lstat.set('/r/hit-a', gate);
  const first = ask(searcher, tree, 'hit', { id: 'A' });
  await waitFor(() => tree.counts.lstat === 2, 'A 的读取已发出');
  const second = ask(searcher, tree, 'hit', { id: 'B' });
  assert.equal(await first, null, '旧的不回答');
  gate.resolve();
  assert.deepEqual(paths(await second), ['hit-a', 'hit-b']);
});

test('取消：代次和请求号都对上才停，迟到的、对不上的取消不误伤新的搜索', async t => {
  const tree = fakeTree({ '': ['hit'] }), gate = deferred(), searcher = make(tree);
  tree.gates.lstat.set('/r/hit', gate);
  const answer = ask(searcher, tree, 'hit', { id: 'A', generation: 2 });
  await waitFor(() => tree.counts.lstat === 1, '读取已发出');
  searcher.cancel({ generation: 2, requestId: 'other' });
  searcher.cancel({ generation: 1, requestId: 'A' });
  gate.resolve();
  assert.deepEqual(paths(await answer), ['hit'], '请求号不对、代次不对的取消都不停');
  const second = ask(searcher, tree, 'hit', { id: 'B', generation: 2 });
  searcher.cancel({ generation: 2, requestId: 'A' }); // 迟到的 A 的取消
  assert.deepEqual(paths(await second), ['hit']);
  const third = ask(searcher, tree, 'hit', { id: 'C', generation: 2 });
  searcher.cancel({ generation: 2, requestId: 'C' });
  assert.equal(await third, null);
});

test('成功和出错两个出口都核对身份：valid() 为假（读的途中根目录或会话换了）一律静默', async t => {
  const tree = fakeTree({ '': ['hit', 'd/'], d: ['hit2'] }), searcher = make(tree);
  let alive = true;
  const gate = deferred();
  tree.gates.readdir.set('/r/d', gate);
  const success = ask(searcher, tree, 'hit', { valid: () => alive });
  await waitFor(() => tree.counts.readdir === 2, '进了 d');
  alive = false;
  gate.resolve();
  assert.equal(await success, null, '成功出口：不回答');
  const broken = fakeTree({ '': ['a'] });
  broken.fail.readdir.add('/r');
  assert.equal(await ask(make(broken), broken, 'a', { valid: () => false }), null, '出错出口：不回答');
  assert.equal(await rejected(ask(make(broken), broken, 'a')), 'denied', '仍然有效：照常回答错误');
});

test('clear（hello、换会话、根目录变化、视图关闭）：中止当前搜索，静默结束', async t => {
  const tree = fakeTree({ '': ['hit'] }), gate = deferred(), searcher = make(tree);
  tree.gates.lstat.set('/r/hit', gate);
  const answer = ask(searcher, tree, 'hit');
  await waitFor(() => tree.counts.lstat === 1, '读取已发出');
  searcher.clear();
  gate.resolve();
  assert.equal(await answer, null);
});

// ---- 排空屏障 ----

test('屏障：A→B→C，B 在待启动位上被 C 顶掉后退出、不回答、不读；只有 C 开始，并且等 A 的读取回来', async t => {
  const tree = fakeTree({ '': ['hit-a', 'hit-b'] }), gate = deferred(), searcher = make(tree);
  tree.gates.lstat.set('/r/hit-a', gate);
  const a = ask(searcher, tree, 'hit', { id: 'A' });
  await waitFor(() => tree.counts.lstat === 2, 'A 的读取已发出');
  const b = ask(searcher, tree, 'hit', { id: 'B' });
  assert.equal(await a, null, 'A 立刻静默结算');
  await flush();
  assert.equal(tree.counts.readdir, 1, 'A 的读取还没回来：B 在等，没有读');
  const c = ask(searcher, tree, 'hit', { id: 'C' });
  assert.equal(await b, null, 'B 退出，不回答');
  await flush();
  assert.equal(tree.counts.readdir, 1);
  gate.resolve();
  assert.deepEqual(paths(await c), ['hit-a', 'hit-b']);
  assert.deepEqual(tree.order.readdir, ['/r', '/r'], '只有 A 和 C 读过根目录，B 没有取得读取权');
});

test('屏障：等屏障时被取消，退出且不读；屏障排空之后下一个搜索照常开始', async t => {
  const tree = fakeTree({ '': ['hit'] }), gate = deferred(), searcher = make(tree);
  tree.gates.lstat.set('/r/hit', gate);
  const a = ask(searcher, tree, 'hit', { id: 'A' });
  await waitFor(() => tree.counts.lstat === 1, 'A 的读取已发出');
  const b = ask(searcher, tree, 'hit', { id: 'B' });
  assert.equal(await a, null);
  searcher.cancel({ generation: 1, requestId: 'B' });
  assert.equal(await b, null);
  await flush();
  assert.equal(tree.counts.readdir, 1);
  gate.resolve();
  await flush();
  assert.deepEqual(paths(await ask(searcher, tree, 'hit', { id: 'D' })), ['hit']);
});

test('屏障：等屏障超过 5 秒（从收到请求算起）回答 time、空结果、scanned: 0，不再等', async t => {
  const pending = trackTimers(t), tree = fakeTree({ '': ['hit'] }), gate = deferred(), searcher = make(tree);
  tree.gates.lstat.set('/r/hit', gate);
  const a = ask(searcher, tree, 'hit', { id: 'A' });
  await waitFor(() => tree.counts.lstat === 1, 'A 的读取已发出');
  const b = ask(searcher, tree, 'hit', { id: 'B' });
  assert.equal(await a, null);
  await flush();
  assert.equal(pending.size, 1, '只剩 B 的计时：A 结算时撤掉了自己的');
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(await settled(b), false);
  t.mock.timers.tick(1);
  assert.deepEqual(await b, { results: [], stop: 'time', scanned: 0, unreadable: 0 });
  assert.equal(tree.counts.readdir, 1, '没有读');
  assert.equal(pending.size, 0);
  gate.resolve();
});

test('屏障：等屏障时换会话（clear 加 valid 为假），退出且不回答；屏障排空后也不读', async t => {
  const tree = fakeTree({ '': ['hit'] }), gate = deferred(), searcher = make(tree);
  tree.gates.lstat.set('/r/hit', gate);
  const a = ask(searcher, tree, 'hit', { id: 'A' });
  await waitFor(() => tree.counts.lstat === 1, 'A 的读取已发出');
  let alive = true;
  const b = ask(searcher, tree, 'hit', { id: 'B', valid: () => alive });
  assert.equal(await a, null);
  alive = false;
  searcher.clear();
  assert.equal(await b, null);
  gate.resolve();
  await flush();
  assert.equal(tree.counts.readdir, 1, '没有人再读');
});

test('屏障：起点解析慢也要等', async t => {
  const tree = fakeTree({ '': ['hit'] }), gate = deferred(), calls = [];
  const resolve = async root => { calls.push(root); if (calls.length === 1) await gate.promise; return root; };
  const searcher = createSearcher(tree.listing, { resolve });
  const a = ask(searcher, tree, 'hit', { id: 'A' });
  await waitFor(() => calls.length === 1, 'A 在解析起点');
  const b = ask(searcher, tree, 'hit', { id: 'B' });
  assert.equal(await a, null);
  await flush();
  assert.equal(calls.length, 1, 'A 的解析没回来，B 不开始');
  gate.resolve();
  assert.deepEqual(paths(await b), ['hit']);
  assert.equal(calls.length, 2);
  assert.equal(tree.counts.readdir, 1, 'A 回来后没有读（已停止派发）');
});

test('屏障：链接分类慢也要等', async t => {
  const tree = fakeTree({ '': [{ name: 'hit-link', kind: 'link', to: '/r/f' }, 'f'] }), gate = deferred(), searcher = make(tree);
  tree.gates.realpath.set('/r/hit-link', gate);
  const a = ask(searcher, tree, 'hit', { id: 'A' });
  await waitFor(() => tree.counts.realpath === 1, 'A 在分类链接');
  const b = ask(searcher, tree, 'hit', { id: 'B' });
  assert.equal(await a, null);
  await flush();
  assert.equal(tree.counts.readdir, 1, 'A 的分类没回来：B 不开始');
  gate.resolve();
  assert.deepEqual(paths(await b), ['hit-link']);
});

test('屏障：hello 清槽之后，旧走树的排空记录仍在，新的搜索照样等', async t => {
  const tree = fakeTree({ '': ['hit'] }), gate = deferred(), searcher = make(tree);
  tree.gates.lstat.set('/r/hit', gate);
  const a = ask(searcher, tree, 'hit', { id: 'A' });
  await waitFor(() => tree.counts.lstat === 1, 'A 的读取已发出');
  searcher.clear(); // hello
  assert.equal(await a, null);
  const b = ask(searcher, tree, 'hit', { id: 'q1' }); // 新页面从头数的请求号
  await flush();
  assert.equal(tree.counts.readdir, 1, '旧页面的读取没回来：新搜索不开始');
  gate.resolve();
  assert.deepEqual(paths(await b), ['hit']);
});

test('同一时间最多一次走树的读取在途：连续搜索之间读取不重叠', async t => {
  const tree = fakeTree({ '': ['m1', 'm2', 'm3', 'm4', 'd/'], d: ['m5'] }), searcher = make(tree), gate = deferred();
  tree.gates.lstat.set('/r/m1', gate);
  let active = 0, peak = 0;
  for (const name of ['lstat', 'readdir']) {
    const original = tree.fs[name];
    tree.fs[name] = async path => { peak = Math.max(peak, ++active); try { return await original(path); } finally { active--; } };
  }
  const answers = [ask(searcher, tree, 'm', { id: 'r0' })];
  await waitFor(() => tree.counts.lstat === 4, 'r0 的第一批');
  for (let i = 1; i < 5; i++) { answers.push(ask(searcher, tree, 'm', { id: `r${i}` })); await flush(); }
  gate.resolve();
  const replies = await Promise.all(answers);
  assert.deepEqual(replies.map(reply => reply !== null), [false, false, false, false, true]);
  assert.equal(peak, 4, '只有 r0 的那一批在途，后来的搜索等它排空才读');
  assert.equal(tree.counts.readdir, 3, 'r0 读根目录，最后一个读根目录和 d，中间的没有读');
});

// ---- 反向核对补上的 ----

test('排序：路径逐段比较，不是整串比（a-b/c 的第一段 a-b 排在 a 之后）', async t => {
  const tree = fakeTree({ '': ['a/', 'a-b/'], a: ['x/'], 'a-b': ['x/'], 'a/x': ['hit'], 'a-b/x': ['hit'] });
  assert.deepEqual(paths(await ask(make(tree), tree, 'hit')), ['a/x/hit', 'a-b/x/hit'], '同深度同名：先比第一段 a 和 a-b，a 在前（整串比 - 排在 / 前面，会反过来）');
});

test('收集顺序：按层、先出队的目录先读（不是栈）：到 1 条就停时是第一个目录里的', async t => {
  const tree = fakeTree({ '': ['a/', 'b/'], a: ['m-a'], b: ['m-b'] });
  assert.deepEqual(paths(await ask(make(tree, { results: 1 }), tree, 'm')), ['a/m-a']);
});

test('单槽：新的搜索中止旧的走树，旧的不再派发新的读取', async t => {
  const tree = fakeTree({ '': ['d/', 'x'], d: ['inner'] }), gate = deferred(), searcher = make(tree);
  tree.gates.lstat.set('/r/x', gate);
  const first = ask(searcher, tree, 'zzz', { id: 'A' });
  await waitFor(() => tree.counts.lstat === 2, 'A 的第一批已发出');
  const second = ask(searcher, tree, 'zzz', { id: 'B' });
  assert.equal(await first, null);
  gate.resolve();
  await second;
  assert.deepEqual(tree.order.readdir, ['/r', '/r', '/r/d'], 'A 只读过根目录，没有进 d；B 读了根目录和 d');
});

test('停止原因 time：到点之后走树停止派发，已发出的读取回来也不再往下读', async t => {
  trackTimers(t);
  const tree = fakeTree({ '': ['d/'], d: ['inner/'], 'd/inner': ['hit'] }), gate = deferred();
  tree.gates.readdir.set('/r/d', gate);
  const answer = ask(make(tree), tree, 'hit');
  await waitFor(() => tree.counts.readdir === 2, '进了 d');
  t.mock.timers.tick(5000);
  assert.equal((await answer).stop, 'time');
  gate.resolve();
  await flush();
  assert.deepEqual(tree.order.readdir, ['/r', '/r/d'], '没有进 d/inner');
});

test('等屏障的时间算在 5 秒里：屏障排空时已经过了 5 秒，不开始读', async t => {
  trackTimers(t);
  const tree = fakeTree({ '': ['hit'] }), gate = deferred(), searcher = make(tree);
  tree.gates.lstat.set('/r/hit', gate);
  const a = ask(searcher, tree, 'hit', { id: 'A' });
  await waitFor(() => tree.counts.lstat === 1, 'A 的读取已发出');
  const b = ask(searcher, tree, 'hit', { id: 'B' });
  await a;
  t.mock.timers.tick(5000);
  gate.resolve();
  assert.deepEqual(await b, { results: [], stop: 'time', scanned: 0, unreadable: 0 });
  assert.equal(tree.counts.readdir, 1, '排空之后也没有读');
});
