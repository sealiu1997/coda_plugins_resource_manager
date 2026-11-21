import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp, { mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { NO_ROOT, queryRoot, sameRoot } from '../lib/root.mjs';
import { fakeCoda, tempDir, workspaceOf } from './support/fake.mjs';

test('根目录状态映射：ready 给规范路径，preparing/failed/gone/无回答/无会话各是对应状态', async t => {
  const base = await tempDir(t);
  await mkdir(join(base, 'real'));
  await symlink('real', join(base, 'link'));
  const fake = fakeCoda({
    ok: workspaceOf(join(base, 'link')),
    preparing: workspaceOf(null, 'preparing'),
    failed: workspaceOf(join(base, 'real'), 'failed'),
    gone: workspaceOf(null, 'gone'),
    bare: {},
    nopath: workspaceOf(null, 'ready'),
  });
  assert.deepEqual(await queryRoot(fake.coda, 'ok'), { state: 'ready', path: join(base, 'real'), project: null });
  assert.deepEqual(await queryRoot(fake.coda, 'preparing'), { state: 'preparing', path: null, project: null });
  assert.deepEqual(await queryRoot(fake.coda, 'failed'), { state: 'none', path: null, project: null });
  assert.deepEqual(await queryRoot(fake.coda, 'gone'), { state: 'gone', path: null, project: null });
  assert.deepEqual(await queryRoot(fake.coda, 'bare'), { state: 'none', path: null, project: null });
  assert.deepEqual(await queryRoot(fake.coda, 'nopath'), { state: 'none', path: null, project: null });
  assert.deepEqual(await queryRoot(fake.coda, null), { state: 'none', path: null, project: null });
  assert.equal(fake.queries.length, 6, '没有会话时不调接口');
  assert.deepEqual(fake.queries[0], { resource: { kind: 'coda/thread@1', id: 'ok' }, name: 'workspace', input: {} });
});

test('ready 但目录已被回收（或变成文件）是 gone；接口出错则抛出', async t => {
  const base = await tempDir(t);
  const path = join(base, 'worktree');
  await mkdir(path);
  const fake = fakeCoda({ a: workspaceOf(path), boom: new Error('接口出错') });
  assert.equal((await queryRoot(fake.coda, 'a')).state, 'ready');
  await rm(path, { recursive: true });
  assert.deepEqual(await queryRoot(fake.coda, 'a'), { state: 'gone', path, project: null });
  await assert.rejects(queryRoot(fake.coda, 'boom'), /接口出错/);
});

// ---- worktree 的项目名：从 workspace 查询返回的 project.name 取，不读工作目录之外的文件 ----

const UUID = 'c0377d40-2fa7-42a0-94ab-49a31b2215c3';
const rootOf = async (t, threads, dirName = UUID) => {
  const base = await tempDir(t);
  const dir = join(base, dirName);
  await mkdir(dir);
  return { dir, fake: fakeCoda(threads(dir)) };
};

test('worktree（UUID 目录名）：项目名取自 workspace 的 project.name，去掉首尾空白', async t => {
  const { dir, fake } = await rootOf(t, dir => ({
    A: workspaceOf(dir, 'ready', { id: 'p1', name: 'ActaView' }),
    B: workspaceOf(dir, 'ready', { id: 'p2', name: '  工具箱  ' }),
  }));
  assert.deepEqual(await queryRoot(fake.coda, 'A'), { state: 'ready', path: dir, project: 'ActaView' });
  assert.equal((await queryRoot(fake.coda, 'B')).project, '工具箱');
});

test('普通目录（非 UUID 目录名）：即使 workspace 带 project，project 也是 null，避免误标 worktree 后缀', async t => {
  const { dir, fake } = await rootOf(t, dir => ({
    O: workspaceOf(dir, 'ready', { id: 'p1', name: 'ActaView' }),
  }), 'ActaView');
  assert.deepEqual(await queryRoot(fake.coda, 'O'), { state: 'ready', path: dir, project: null });
});

test('project.name 不可用时退回 null、queryRoot 不抛、根目录照常 ready：缺失、空串、含控制字符、非字符串', async t => {
  const { dir, fake } = await rootOf(t, dir => ({
    none: workspaceOf(dir, 'ready', null),
    empty: workspaceOf(dir, 'ready', { id: 'p3', name: '   ' }),
    control: workspaceOf(dir, 'ready', { id: 'p4', name: 'Bad\u0007Name' }),
    number: workspaceOf(dir, 'ready', { id: 'p5', name: 42 }),
    absent: workspaceOf(dir, 'ready', { id: 'p6' }),
  }));
  for (const id of ['none', 'empty', 'control', 'number', 'absent']) {
    assert.deepEqual(await queryRoot(fake.coda, id), { state: 'ready', path: dir, project: null }, id);
  }
});

test('名字太长按码点截到 256 个字', async t => {
  const { fake } = await rootOf(t, dir => ({ A: workspaceOf(dir, 'ready', { id: 'p', name: '𠮷'.repeat(300) }) }));
  const { project } = await queryRoot(fake.coda, 'A');
  assert.equal(Array.from(project).length, 256);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(project));
});

test('没就绪时 project 都是 null：preparing、failed、gone、目录已被回收、没有会话', async t => {
  const base = await tempDir(t);
  const fake = fakeCoda({
    P: workspaceOf(null, 'preparing', 'ActaView'),
    F: workspaceOf(join(base, 'x'), 'failed', 'ActaView'),
    G1: workspaceOf(null, 'gone', 'ActaView'),
    G2: workspaceOf(join(base, UUID), 'ready', 'ActaView'),
  });
  for (const id of ['P', 'F', 'G1', 'G2', null]) assert.equal((await queryRoot(fake.coda, id)).project, null, String(id));
});

test('取项目名的过程中不打开会话根目录之外的任何文件（真实的 git worktree 就在旁边：主仓库的 .git 里有它的元数据，但一个都不读）', async t => {
  const base = await tempDir(t), main = join(base, 'coda_plugins_resource_manager'), work = join(base, UUID);
  await mkdir(main);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: main, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', work, '-b', `agent/${UUID}`);
  t.after(() => { try { git('worktree', 'prune'); } catch { /* 目录已删 */ } });
  const root = await realpath(work), fake = fakeCoda({ A: workspaceOf(work, 'ready', { id: 'p1', name: 'Coda 里的项目名' }) });
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
