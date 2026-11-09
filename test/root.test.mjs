import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile as readFileText, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { NO_ROOT, projectOf, queryRoot, readMeta, sameRoot } from '../lib/root.mjs';
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

// ---- 元数据文件不可信：项目名只能是真实存在的目录的名字（评审意见：越界读取、类型和大小上限）----

// 一个正常的 worktree 在 <base>/<main>/.git/worktrees/<UUID>，工作目录 <base>/<UUID>；返回各路径，调用方再把其中一个文件换掉。
async function layout(base, main = 'ActaView') {
  const work = await handmade(base, { main });
  return { work, dotgit: join(work, '.git'), admin: join(base, main, '.git', 'worktrees', UUID), common: join(base, main, '.git', 'worktrees', UUID, 'commondir') };
}
const SECRET = 'TOKEN=example-secret';
const within = (promise, ms = 3000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('读取卡住了')), ms))]);

test('projectOf：commondir 是符号链接（指向工作目录外的文本文件）不读，标题不会出现文件里的文字', async t => {
  const base = await tempDir(t), { work, common } = await layout(join(base, 'a'));
  await writeFile(join(base, 'outside.txt'), `${SECRET}\n`);
  await rm(common);
  await symlink(join(base, 'outside.txt'), common);
  assert.equal(await projectOf(work), null);
  // 链接指向的文件内容恰好是合法的 ../..：也不读（只接受普通文件）。
  await writeFile(join(base, 'dots.txt'), '../..\n');
  await rm(common);
  await symlink(join(base, 'dots.txt'), common);
  assert.equal(await projectOf(work), null, '只接受普通文件，不管内容');
});

test('projectOf：commondir 是普通文件但内容不是路径（别的文件里的文字）、或指向别的目录，都是 null', async t => {
  const base = await tempDir(t), { work, common } = await layout(join(base, 'a'));
  await writeFile(common, `${SECRET}\n`);
  assert.equal(await projectOf(work), null, '内容指向的目录不存在');
  await mkdir(join(base, 'a', 'ActaView', '.git', 'Elsewhere'));
  await writeFile(common, '../../Elsewhere\n');
  assert.equal(await projectOf(work), null, '指到别的真实目录：必须正好是 gitdir 再上两级');
  await writeFile(common, '../..\n../..\n');
  assert.equal(await projectOf(work), null, '不是单行');
  await writeFile(common, '../..\n');
  assert.equal(await projectOf(work), 'ActaView', '改回正常');
});

test('projectOf：.git 是符号链接（指向别处的文件）不读，即使内容是合法的指针', async t => {
  const base = await tempDir(t), { work, dotgit, admin } = await layout(join(base, 'a'));
  await writeFile(join(base, 'pointer.txt'), `gitdir: ${admin}\n`);
  await rm(dotgit);
  await symlink(join(base, 'pointer.txt'), dotgit);
  assert.equal(await projectOf(work), null);
  await rm(dotgit);
  await writeFile(dotgit, `gitdir: ${admin}\n`);
  assert.equal(await projectOf(work), 'ActaView', '改回普通文件');
  await writeFile(dotgit, `gitdir: ${admin}\ngitdir: ${admin}\n`);
  assert.equal(await projectOf(work), null, '不是单行');
});

test('projectOf：gitdir 不在 worktrees/ 下、或主仓库的 git 目录不存在，是 null', async t => {
  const base = await tempDir(t), { work, dotgit, admin } = await layout(join(base, 'a'));
  const stray = join(base, 'a', 'ActaView', '.git', 'not-worktrees', UUID);
  await mkdir(stray, { recursive: true });
  await writeFile(join(stray, 'commondir'), '../..\n');
  await writeFile(dotgit, `gitdir: ${stray}\n`);
  assert.equal(await projectOf(work), null, '上一级不叫 worktrees');
  await writeFile(dotgit, `gitdir: ${join(base, 'a', 'ActaView', '.git')}\n`);
  assert.equal(await projectOf(work), null, 'gitdir 指到 .git 本身');
  await writeFile(dotgit, `gitdir: ${admin}\n`);
  assert.equal(await projectOf(work), 'ActaView');
  await rm(join(base, 'a', 'ActaView'), { recursive: true });
  assert.equal(await projectOf(work), null, '主仓库的 git 目录不存在');
});

test('projectOf：gitdir 指到的是文件、不是目录，是 null', async t => {
  const base = await tempDir(t), { work, dotgit } = await layout(join(base, 'a'));
  const file = join(base, 'a', 'ActaView', '.git', 'worktrees', 'plain-file');
  await writeFile(file, 'x');
  await writeFile(dotgit, `gitdir: ${file}\n`);
  assert.equal(await projectOf(work), null);
});

test('projectOf：项目名里有控制字符（不能进标题）是 null；符号链接的主仓库用真实目录名', async t => {
  const base = await tempDir(t), bell = await layout(join(base, 'a'), 'Acta\u0007View');
  assert.equal(await projectOf(bell.work), null);
  const linked = await layout(join(base, 'b'), 'Real');
  await symlink(join(base, 'b', 'Real'), join(base, 'b', 'Alias'));
  await writeFile(linked.dotgit, `gitdir: ${join(base, 'b', 'Alias', '.git', 'worktrees', UUID)}\n`);
  assert.equal(await projectOf(linked.work), 'Real', '经符号链接找到主仓库：取真实目录的名字');
});

test('projectOf：超过字节上限的 .git、commondir 不读（几 KB 就够），退回 null；上限以内照常', async t => {
  const base = await tempDir(t), { work, dotgit, admin, common } = await layout(join(base, 'a'));
  await writeFile(dotgit, `gitdir: ${admin}${' '.repeat(2 * 1024 * 1024)}\n`);
  assert.equal(await projectOf(work), null, '.git 2 MiB');
  await writeFile(dotgit, `gitdir: ${admin}\n`);
  await writeFile(common, `../..${' '.repeat(5000)}\n`);
  assert.equal(await projectOf(work), null, 'commondir 5000 字节以上');
  await writeFile(common, `../..${' '.repeat(100)}\n`);
  assert.equal(await projectOf(work), 'ActaView', '100 字节：照常');
});

test('projectOf：.git、commondir 是 FIFO 时不卡住（不阻塞打开、不读），退回 null', async t => {
  const base = await tempDir(t), { work, dotgit, common } = await layout(join(base, 'a'));
  const fifo = path => { execFileSync('mkfifo', [path]); };
  try { fifo(join(base, 'probe')); } catch { t.skip('没有 mkfifo'); return; }
  await rm(common);
  fifo(common);
  assert.equal(await within(projectOf(work)), null, 'commondir 是 FIFO');
  await rm(common);
  await writeFile(common, '../..\n');
  const saved = await readFileText(dotgit);
  await rm(dotgit);
  fifo(dotgit);
  assert.equal(await within(projectOf(work)), null, '.git 是 FIFO');
  await rm(dotgit);
  await writeFile(dotgit, saved);
  assert.equal(await projectOf(work), 'ActaView', '改回正常');
});

test('projectOf：正常的 Coda worktree（真实 git）和真实的裸仓库 worktree 仍得到项目名', async t => {
  const base = await tempDir(t), main = join(base, 'ActaView'), bare = join(base, 'tools.git');
  await mkdir(main);
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', join(base, UUID), '-b', 'agent/x');
  assert.equal(await projectOf(join(base, UUID)), 'ActaView');
  execFileSync('git', ['clone', '-q', '--bare', main, bare], { stdio: 'pipe' });
  execFileSync('git', ['-C', bare, 'worktree', 'add', '-q', join(base, 'from-bare'), 'HEAD', '--detach'], { stdio: 'pipe' });
  assert.equal(await projectOf(join(base, 'from-bare')), 'tools', '裸仓库：去掉 .git 后缀');
});

// ---- 短读：read 返回的字节少于要的、但还没到文件尾（慢的网络盘），不能把有效元数据截断 ----

// 真实文件的句柄，但每次 read 最多给 sizes 里的下一个数（用完了重复最后一个）字节；记下每次实际请求和返回。
function shortReads(sizes, log = []) {
  let call = 0;
  return async (path, flags) => {
    const real = await open(path, flags);
    return {
      stat: () => real.stat(),
      close: () => real.close(),
      read: async (buffer, offset, length, position) => {
        const cap = sizes[Math.min(call++, sizes.length - 1)], result = await real.read(buffer, offset, Math.min(length, cap), position);
        log.push({ asked: length, got: result.bytesRead });
        return result;
      },
    };
  };
}

test('短读：每次只读回 1～5 字节，仍读全并得到项目名；读到 0 字节才算结束', async t => {
  const base = await tempDir(t), { work } = await layout(join(base, 'a'));
  for (const sizes of [[1], [2], [3, 1, 5, 2], [5]]) {
    const log = [];
    assert.equal(await projectOf(work, shortReads(sizes, log)), 'ActaView', `每次 ${sizes}`);
    assert.ok(log.length > 10 && log.every(({ got }, i) => got <= sizes[Math.min(i, sizes.length - 1)]), `确实是短读：${log.length} 次`);
    assert.equal(log.filter(({ got }) => got === 0).length, 2, '两个文件各读到一次 EOF（0 字节）才结束');
  }
});

test('短读：多字节字符（项目路径含中文）跨读取边界仍正确，整段读完再按 UTF-8 解码', async t => {
  const base = await tempDir(t), { work } = await layout(join(base, 'a'), '工具箱项目');
  for (const sizes of [[1], [2], [4]]) assert.equal(await projectOf(work, shortReads(sizes)), '工具箱项目', `每次 ${sizes} 字节（汉字 3 字节，必然被切在中间）`);
  assert.equal(await projectOf(work), '工具箱项目', '不短读也一样');
});

test('短读：累计超过上限仍退回 null（不靠 stat 报的大小）；上限以内的短读不受影响', async t => {
  const base = await tempDir(t), file = join(base, 'big.txt');
  await writeFile(file, 'x'.repeat(5000));
  assert.equal(await readMeta(file, shortReads([100])), null, '5000 字节，每次 100：累计过了 4096');
  // stat 说文件很小、实际读出来很多（文件在读的时候变大）：靠累计字节拦住。
  const lying = async (path, flags) => { const real = await open(path, flags); return { stat: async () => ({ isFile: () => true, size: 10 }), close: () => real.close(), read: (...args) => real.read(...args) }; };
  assert.equal(await readMeta(file, lying), null);
  await writeFile(file, 'y'.repeat(4096));
  assert.equal((await readMeta(file, shortReads([100]))).length, 4096, '正好 4096 字节：读得下');
});
