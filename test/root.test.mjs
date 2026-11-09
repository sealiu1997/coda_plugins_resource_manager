import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { NO_ROOT, projectOf, queryRoot, sameRoot } from '../lib/root.mjs';
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

// ---- worktree 的项目名（0.8.1，设计第 19 节）----

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' });
const UUID = 'c0377d40-2fa7-42a0-94ab-49a31b2215c3';

// 手写的 worktree：<base>/<main>/.git 是目录，<base>/<main>/.git/worktrees/<UUID>/commondir 是 ../..，<base>/<UUID>/.git 是文件。
async function handmade(base, { main = 'ActaView', gitName = '.git', commondir = '../..', pointer = null } = {}) {
  const common = join(base, main, gitName), admin = join(common, 'worktrees', UUID), work = join(base, UUID);
  await mkdir(admin, { recursive: true });
  await mkdir(work, { recursive: true });
  if (commondir !== null) await writeFile(join(admin, 'commondir'), `${commondir}\n`);
  await writeFile(join(work, '.git'), pointer ?? `gitdir: ${admin}\n`);
  return work;
}

test('projectOf：.git 文件 + commondir 正常时是主仓库的文件夹名；裸仓库去掉 .git 后缀', async t => {
  const base = await tempDir(t);
  assert.equal(await projectOf(await handmade(join(base, 'a'))), 'ActaView');
  assert.equal(await projectOf(await handmade(join(base, 'b'), { main: 'foo', gitName: '.git' })), 'foo');
  assert.equal(await projectOf(await handmade(join(base, 'c'), { main: 'foo.git', gitName: '' })), 'foo', '裸仓库：foo.git/worktrees/<名字>，去掉后缀');
  assert.equal(await projectOf(await handmade(join(base, 'd'), { commondir: join(base, 'd', 'ActaView', '.git') })), 'ActaView', 'commondir 是绝对路径也行');
});

test('projectOf：.git 是目录、缺 commondir、内容格式不对、指向不存在、读失败，都是 null，不抛', async t => {
  const base = await tempDir(t);
  const plain = join(base, 'plain');
  await mkdir(join(plain, '.git'), { recursive: true });
  assert.equal(await projectOf(plain), null, '.git 是目录（主仓库自己）');
  assert.equal(await projectOf(join(base, 'nothing')), null, '没有 .git');
  assert.equal(await projectOf(await handmade(join(base, 'a'), { commondir: null })), null, '缺 commondir');
  assert.equal(await projectOf(await handmade(join(base, 'b'), { pointer: 'not a pointer\n' })), null, '内容格式不对');
  assert.equal(await projectOf(await handmade(join(base, 'c'), { pointer: 'gitdir:\n' })), null, 'gitdir 后面是空的');
  assert.equal(await projectOf(await handmade(join(base, 'd'), { pointer: `gitdir: ${join(base, 'd', 'gone')}\n` })), null, '指向的目录不存在');
  assert.equal(await projectOf(await handmade(join(base, 'e'), { commondir: '   ' })), null, 'commondir 是空白');
});

test('projectOf：gitdir 写相对路径时以 worktree 根为基准', async t => {
  const base = await tempDir(t), work = await handmade(join(base, 'a'), { pointer: 'gitdir: ../ActaView/.git/worktrees/' + UUID + '\n' });
  assert.equal(await projectOf(work), 'ActaView');
});

test('queryRoot：checkout 是 worktree 才反查项目名；original、反查失败、没就绪的都是 null', async t => {
  const base = await tempDir(t), work = await handmade(base);
  const fake = fakeCoda({ wt: checkoutOf(work), original: checkoutOf(work, 'ready', 'original'), broken: checkoutOf(await handmade(join(base, 'x'), { commondir: null })), preparing: checkoutOf(null, 'preparing', 'worktree') });
  assert.deepEqual(await queryRoot(fake.coda, 'wt'), { state: 'ready', path: work, project: 'ActaView' });
  assert.equal((await queryRoot(fake.coda, 'original')).project, null, 'original：用户直接把目录当项目打开，即使它是 worktree 也不反查');
  assert.equal((await queryRoot(fake.coda, 'broken')).project, null);
  assert.equal((await queryRoot(fake.coda, 'preparing')).project, null);
  await rm(work, { recursive: true });
  assert.equal((await queryRoot(fake.coda, 'wt')).project, null, '目录没了（gone）');
});

test('真实的 git worktree：目录名 UUID、主仓库文件夹名很长，queryRoot 反查到主仓库的文件夹名', async t => {
  const base = await tempDir(t), main = join(base, 'coda_plugins_resource_manager'), work = join(base, UUID);
  await mkdir(main);
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', work, '-b', `agent/${UUID}`);
  t.after(() => { try { git(main, 'worktree', 'prune'); } catch { /* 目录已删 */ } });
  const fake = fakeCoda({ wt: checkoutOf(work), orig: checkoutOf(main, 'ready', 'original') });
  const root = await queryRoot(fake.coda, 'wt');
  assert.equal(root.project, 'coda_plugins_resource_manager');
  assert.equal(root.path, await realpath(work));
  assert.equal((await queryRoot(fake.coda, 'orig')).project, null, '主仓库本身（original）不反查');
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
