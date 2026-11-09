import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp, { mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { NO_ROOT, queryRoot, sameRoot } from '../lib/root.mjs';
import { checkoutOf, fakeCoda, tempDir } from './support/fake.mjs';

test('根目录状态映射：ready 给规范路径，preparing/failed/无 checkout/无会话各是对应状态', async t => {
  const base = await tempDir(t);
  await mkdir(join(base, 'real'));
  await symlink('real', join(base, 'link'));
  const fake = fakeCoda({
    ok: checkoutOf(join(base, 'link')),
    preparing: checkoutOf(null, 'preparing'),
    failed: checkoutOf(join(base, 'real'), 'failed'),
    bare: {},
    nopath: checkoutOf(null, 'ready'),
  });
  assert.deepEqual(await queryRoot(fake.coda, 'ok'), { state: 'ready', path: join(base, 'real'), project: null });
  assert.deepEqual(await queryRoot(fake.coda, 'preparing'), { state: 'preparing', path: null, project: null });
  assert.deepEqual(await queryRoot(fake.coda, 'failed'), { state: 'none', path: null, project: null });
  assert.deepEqual(await queryRoot(fake.coda, 'bare'), { state: 'none', path: null, project: null });
  assert.deepEqual(await queryRoot(fake.coda, 'nopath'), { state: 'none', path: null, project: null });
  assert.deepEqual(await queryRoot(fake.coda, null), { state: 'none', path: null, project: null });
  assert.equal(fake.api.length, 5, '没有会话时不调接口');
});

test('ready 但目录已被回收（或变成文件）是 gone；接口出错则抛出', async t => {
  const base = await tempDir(t);
  const path = join(base, 'worktree');
  await mkdir(path);
  const fake = fakeCoda({ a: checkoutOf(path), boom: new Error('接口出错') });
  assert.equal((await queryRoot(fake.coda, 'a')).state, 'ready');
  await rm(path, { recursive: true });
  assert.deepEqual(await queryRoot(fake.coda, 'a'), { state: 'gone', path, project: null });
  await assert.rejects(queryRoot(fake.coda, 'boom'), /接口出错/);
});

// ---- worktree 的项目名（0.8.1，设计第 19.7 节）：从 Coda 的项目列表取，不读任何文件 ----

const UUID = 'c0377d40-2fa7-42a0-94ab-49a31b2215c3';
const PROJECTS = { projects: [{ id: 'p1', name: 'ActaView' }, { id: 'p2', name: '  工具箱  ' }, { id: 'p3', name: '' }, { id: 'p4', name: 'Bad\u0007Name' }, { id: 'p5', name: 42 }, { id: 'p6' }, { name: 'no-id' }] };
// 会话详情的真实结构：{ thread: { …, projectId }, draft, checkout }（checkout 和 thread 并列；kind 缺省是 worktree）。checkout 和 thread 上都可以有 projectId。
const session = (path, { kind = 'worktree', projectId, threadProjectId, state = 'ready' } = {}) => ({ thread: { id: 'thread-1', ...(threadProjectId ? { projectId: threadProjectId } : {}) }, draft: {}, checkout: { kind, state, path, ...(projectId ? { projectId } : {}) } });
const agentCalls = fake => fake.api.filter(path => path === 'agents').length;
const rootOf = async (t, threads) => { const base = await tempDir(t); await mkdir(join(base, UUID)); const dir = join(base, UUID); return { dir, fake: fakeCoda(threads(dir)) }; };

test('worktree：项目名是 Coda 项目列表里这个 id 的名字（checkout.projectId），名字去掉首尾空白', async t => {
  const { dir, fake } = await rootOf(t, dir => ({ A: session(dir, { projectId: 'p1' }), B: session(dir, { projectId: 'p2' }), agents: PROJECTS }));
  assert.deepEqual(await queryRoot(fake.coda, 'A'), { state: 'ready', path: dir, project: 'ActaView' });
  assert.equal((await queryRoot(fake.coda, 'B')).project, '工具箱');
  assert.equal(agentCalls(fake), 1, '列表缓存了：两个会话只请求一次');
});

test('checkout 里没有 projectId 时用详情里 thread.projectId；两处都没有就不请求，project 是 null', async t => {
  const { fake } = await rootOf(t, dir => ({ A: session(dir, { threadProjectId: 'p1' }), B: session(dir, { projectId: 'p2', threadProjectId: 'p1' }), C: session(dir), agents: PROJECTS }));
  assert.equal((await queryRoot(fake.coda, 'A')).project, 'ActaView');
  assert.equal((await queryRoot(fake.coda, 'B')).project, '工具箱', 'checkout 优先');
  const none = await rootOf(t, dir => ({ C: session(dir), agents: PROJECTS }));
  assert.equal((await queryRoot(none.fake.coda, 'C')).project, null);
  assert.equal(agentCalls(none.fake), 0, '没有 id：不请求');
  // 详情顶层的 projectId 不是 id 的来源（thread 是详情里的字段，不是详情本身）。
  const top = await rootOf(t, dir => ({ T: { ...session(dir), projectId: 'p1' }, agents: PROJECTS }));
  assert.equal((await queryRoot(top.fake.coda, 'T')).project, null, '顶层的 projectId 不算');
  assert.equal(agentCalls(top.fake), 0);
});

test('original（用户直接把目录当项目打开）不调 agents，project 是 null，即使有 projectId', async t => {
  const { fake } = await rootOf(t, dir => ({ O: session(dir, { kind: 'original', projectId: 'p1' }), agents: PROJECTS }));
  assert.equal((await queryRoot(fake.coda, 'O')).project, null);
  assert.equal(agentCalls(fake), 0);
});

test('取不到时退回 null、queryRoot 不抛、根目录照常 ready：agents 失败、列表里没有这个 id、名字空、名字有控制字符、名字不是字符串、回答形状不对', async t => {
  const { dir, fake } = await rootOf(t, dir => ({
    miss: session(dir, { projectId: 'nope' }), empty: session(dir, { projectId: 'p3' }), control: session(dir, { projectId: 'p4' }), number: session(dir, { projectId: 'p5' }), absent: session(dir, { projectId: 'p6' }),
    agents: PROJECTS,
  }));
  for (const id of ['miss', 'empty', 'control', 'number', 'absent']) assert.deepEqual(await queryRoot(fake.coda, id), { state: 'ready', path: dir, project: null }, id);
  for (const [label, reply] of [['接口失败', new Error('boom')], ['没有 projects', {}], ['projects 不是数组', { projects: 'x' }], ['回答是 null', null]]) {
    const bad = await rootOf(t, dir => ({ A: session(dir, { projectId: 'p1' }), agents: reply }));
    assert.deepEqual(await queryRoot(bad.fake.coda, 'A'), { state: 'ready', path: bad.dir, project: null }, label);
  }
});

test('名字太长按码点截到 256 个字', async t => {
  const { fake } = await rootOf(t, dir => ({ A: session(dir, { projectId: 'p' }), agents: { projects: [{ id: 'p', name: '𠮷'.repeat(300) }] } }));
  const { project } = await queryRoot(fake.coda, 'A');
  assert.equal(Array.from(project).length, 256);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(project));
});

test('没就绪的不请求：preparing、failed、目录已被回收（gone）、没有会话，project 都是 null', async t => {
  const base = await tempDir(t);
  const fake = fakeCoda({ P: session(null, { state: 'preparing', projectId: 'p1' }), F: session(join(base, 'x'), { state: 'failed', projectId: 'p1' }), G: session(join(base, 'gone'), { projectId: 'p1' }), agents: PROJECTS });
  for (const id of ['P', 'F', 'G', null]) assert.equal((await queryRoot(fake.coda, id)).project, null, String(id));
  assert.equal(agentCalls(fake), 0);
});

test('缓存：同时发起的查询共用一次请求；超过 60 秒重取（改了名字能看到）；查不到 id 时重取，但两次之间至少隔 5 秒', async t => {
  let clock = 0, projects = [{ id: 'p1', name: 'Old' }];
  const { fake } = await rootOf(t, dir => ({ A: session(dir, { projectId: 'p1' }), M: session(dir, { projectId: 'new' }), agents: () => ({ projects }) }));
  const ask = id => queryRoot(fake.coda, id, { now: () => clock }).then(root => root.project);
  assert.deepEqual(await Promise.all([ask('A'), ask('A'), ask('A'), ask('A'), ask('A')]), Array(5).fill('Old'));
  assert.equal(agentCalls(fake), 1, '同时发起的 5 个查询只请求一次');
  clock = 59_999; projects = [{ id: 'p1', name: 'Renamed' }];
  assert.equal(await ask('A'), 'Old', '60 秒内用缓存');
  assert.equal(agentCalls(fake), 1);
  clock = 60_000;
  assert.equal(await ask('A'), 'Renamed', '到 60 秒重取');
  assert.equal(agentCalls(fake), 2);
  // 查不到 id：第一次（距上次请求不到 5 秒）不重取，满 5 秒才重取一次。
  projects = [{ id: 'p1', name: 'Renamed' }, { id: 'new', name: 'Fresh' }];
  clock = 64_999;
  assert.equal(await ask('M'), null, '新建的项目：列表里还没有，距上次请求不到 5 秒，不重取');
  assert.equal(agentCalls(fake), 2);
  clock = 65_000;
  assert.equal(await ask('M'), 'Fresh', '满 5 秒：查不到 id 重取一次，拿到了');
  assert.equal(agentCalls(fake), 3);
  for (let i = 0; i < 5; i++) assert.equal(await ask('M'), 'Fresh');
  assert.equal(agentCalls(fake), 3, '之后都用缓存');
});

test('缓存：接口失败也算一次请求，5 秒内不反复请求；失败时保留上一次的列表；恢复后能取到', async t => {
  let clock = 0, reply = { projects: [{ id: 'p1', name: 'ActaView' }] };
  const { fake } = await rootOf(t, dir => ({ A: session(dir, { projectId: 'p1' }), M: session(dir, { projectId: 'p9' }), agents: () => { if (reply instanceof Error) throw reply; return reply; } }));
  const ask = id => queryRoot(fake.coda, id, { now: () => clock }).then(root => root.project);
  assert.equal(await ask('A'), 'ActaView');
  clock = 60_000; reply = new Error('接口出错');
  assert.equal(await ask('A'), 'ActaView', '重取失败：保留上一次的列表');
  assert.equal(agentCalls(fake), 2);
  for (let i = 0; i < 5; i++) await ask('M'); // 查不到 id 想重取，但上一次请求（失败）还不到 5 秒
  assert.equal(agentCalls(fake), 2, '失败后 5 秒内不反复请求');
  clock = 65_000; reply = { projects: [{ id: 'p9', name: 'Back' }] };
  assert.equal(await ask('M'), 'Back', '恢复后取到');
});

test('缓存按 coda 对象分开：另一个宿主有自己的列表', async t => {
  const one = await rootOf(t, dir => ({ A: session(dir, { projectId: 'p1' }), agents: { projects: [{ id: 'p1', name: 'One' }] } }));
  const two = await rootOf(t, dir => ({ A: session(dir, { projectId: 'p1' }), agents: { projects: [{ id: 'p1', name: 'Two' }] } }));
  assert.equal((await queryRoot(one.fake.coda, 'A')).project, 'One');
  assert.equal((await queryRoot(two.fake.coda, 'A')).project, 'Two');
});

test('取项目名的过程中不打开会话根目录之外的任何文件（真实的 git worktree 就在旁边：主仓库的 .git 里有它的元数据，但一个都不读）', async t => {
  const base = await tempDir(t), main = join(base, 'coda_plugins_resource_manager'), work = join(base, UUID);
  await mkdir(main);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: main, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', work, '-b', `agent/${UUID}`);
  t.after(() => { try { git('worktree', 'prune'); } catch { /* 目录已删 */ } });
  const root = await realpath(work), fake = fakeCoda({ A: session(work, { projectId: 'p1' }), agents: { projects: [{ id: 'p1', name: 'Coda 里的项目名' }] } });
  // 拦截 fs/promises 的各个入口（lib/root.mjs 的具名导入是活绑定，syncBuiltinESMExports 之后跟着换），记下所有传进去的路径。
  const seen = [], names = ['realpath', 'stat', 'lstat', 'open', 'readFile', 'readdir', 'opendir', 'access', 'readlink'];
  const mocks = names.map(name => { const original = fsp[name]; return t.mock.method(fsp, name, (...args) => { seen.push({ name, path: String(args[0]) }); return original(...args); }); });
  syncBuiltinESMExports();
  let result;
  try { result = await queryRoot(fake.coda, 'A'); } finally { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(seen.length > 0, '拦截生效：queryRoot 自己查根目录时调了 fs');
  const outside = seen.filter(({ path }) => path !== root && !path.startsWith(`${root}/`));
  assert.deepEqual(outside, [], '只有根目录本身（realpath、stat）；没有打开根目录之外的任何路径');
  assert.deepEqual(seen.filter(({ name }) => ['open', 'readFile', 'readdir', 'opendir'].includes(name)), [], '一个文件也没有读、没有列目录');
  assert.deepEqual(result, { state: 'ready', path: root, project: 'Coda 里的项目名' }, '名字是 Coda 的，不是主仓库的文件夹名 coda_plugins_resource_manager');
});

test('sameRoot：状态、路径、项目名任一不同就不同；缺省的 project 当 null', () => {
  const root = { state: 'ready', path: '/a', project: 'P' };
  assert.equal(sameRoot(root, { ...root }), true);
  assert.equal(sameRoot(root, { ...root, project: 'Q' }), false, 'project 变了要推给页面');
  assert.equal(sameRoot(root, { ...root, project: null }), false);
  assert.equal(sameRoot(root, { ...root, path: '/b' }), false);
  assert.equal(sameRoot(root, { ...root, state: 'gone' }), false);
  assert.equal(sameRoot({ state: 'ready', path: '/a' }, { state: 'ready', path: '/a', project: null }), true);
  assert.equal(sameRoot(null, NO_ROOT), false);
});
