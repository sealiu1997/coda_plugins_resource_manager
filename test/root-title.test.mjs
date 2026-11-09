// 根目录名的四处显示（设计第 19 节）：Mac 目录树标题、iPhone 页内工具条标题、图标视图头部、系统返回的路径。
// 真实的 app.mjs 配假 DOM；页面收到 root 消息（带 project）后渲染。fit 的量宽度在假 DOM 里一个字算 1，元素的 clientWidth 是字数。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { loadApp } from './support/dom.mjs';
import { checkoutOf, deferred, fakeCoda, flush, tempDir, waitFor } from './support/fake.mjs';
import { openTree, sectionOf } from './support/treehost.mjs';

const UUID = 'c0377d40-2fa7-42a0-94ab-49a31b2215c3';
const WT = `/work/${UUID}`, FULL = 'ActaView-wt-c037';
const ICONS = { v: 1, seq: 1, hidden: false, view: 'icons', sessions: {} };
const LISTING = { '': ['dir/', 'a.txt'], dir: ['inner/', 'x.txt'], 'dir/inner': ['deep.txt'] };
const byClass = (page, panel, name) => panel.find(node => node.classList.contains(name))[0];
const barTitle = page => byClass(page, page.bar, 'bar-title');
const gridHead = page => byClass(page, page.grid, 'gname-head');
const text = node => node?.textContent;

async function treePage(t, { platform = 'mac', project = 'ActaView', path = WT, ...options } = {}) {
  const ctx = await openTree(t, { platform, listing: LISTING, ...options });
  if (platform === 'mac') sectionOf(ctx.page).clientWidth = 0;
  ctx.host.session('s1', path, project);
  await flush();
  return ctx;
}

// ---- Mac 目录树标题 ----

test('Mac 树标题：worktree 是「项目名-wt-编号」，悬停是完整路径；宽度不够时按三步省略，拖宽拖窄重算', async t => {
  const { page } = await treePage(t);
  const title = sectionOf(page);
  assert.equal(text(title), FULL);
  assert.equal(title.title, WT, '悬停：完整路径');
  title.clientWidth = 16; page.resize();
  assert.equal(text(title), FULL, '第 1 步');
  title.clientWidth = 13; page.resize();
  assert.equal(text(title), 'Ac…ew-wt-c037', '第 2 步');
  title.clientWidth = 11; page.resize();
  assert.equal(text(title), 'A…w-wt-c037', '第 2 步的最短：项目名只剩 2 个字');
  title.clientWidth = 9; page.resize();
  assert.equal(text(title), 'A…w-wt-c…', '第 3 步：整段尾部省略');
  title.clientWidth = 40; page.resize();
  assert.equal(text(title), FULL, '拖宽后回到完整');
  assert.equal(title.title, WT);
});

test('Mac 树标题：非 worktree（反查失败、original）显示文件夹名，没有悬停，窄了也不被 JS 省略（交给 CSS）', async t => {
  const { page } = await treePage(t, { project: null });
  const title = sectionOf(page);
  assert.equal(text(title), UUID, '反查失败：和现在一样是目录名');
  assert.equal(title.title, '');
  title.clientWidth = 5; page.resize();
  assert.equal(text(title), UUID);
  const other = await treePage(t, { project: null, path: '/work/ActaView' });
  assert.equal(text(sectionOf(other.page)), 'ActaView');
});

test('Mac 树标题：worktree 的目录名不是 UUID 时编号取整个目录名；project 单独变了也重画标题（路径、状态不变）', async t => {
  const { page, host } = await treePage(t, { path: '/work/feature-login' });
  assert.equal(text(sectionOf(page)), 'ActaView-wt-feature-login');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/work/feature-login', project: 'Other' });
  await flush();
  assert.equal(text(sectionOf(page)), 'Other-wt-feature-login', 'project 变了，页面跟着变');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/work/feature-login' });
  await flush();
  assert.equal(text(sectionOf(page)), 'feature-login', '消息里没有 project（旧模块）：当作反查失败');
});

test('Mac 树标题：根目录没就绪时不显示标题', async t => {
  const { page, host } = await treePage(t);
  page.post({ type: 'root', generation: host.generation, state: 'gone', path: WT, project: null });
  await flush();
  assert.equal(sectionOf(page).hidden, true);
  assert.equal(text(sectionOf(page)), '');
});

// ---- iPhone 页内工具条标题 ----

test('iPhone 工具条：标题写 worktree 的写法，按标题的宽度省略，旋转或改字号后（resize）重算；非 worktree 同现在', async t => {
  const { page } = await treePage(t, { platform: 'ios' });
  const title = barTitle(page);
  assert.equal(text(title), FULL);
  title.clientWidth = 12; page.resize();
  assert.equal(text(barTitle(page)), 'Ac…w-wt-c037');
  title.clientWidth = 6; page.resize();
  assert.equal(text(barTitle(page)), 'A…w-w…');
  title.clientWidth = 30; page.resize();
  assert.equal(text(barTitle(page)), FULL);
  const plain = await treePage(t, { platform: 'ios', project: null });
  barTitle(plain.page).clientWidth = 4; plain.page.resize();
  assert.equal(text(barTitle(plain.page)), UUID, '反查失败：和现在一样，由 CSS 截断');
});

test('iPhone 工具条：工具条重画（换到别的会话）后新标题也会省略，旧标题不再响应', async t => {
  const { page, host } = await treePage(t, { platform: 'ios' });
  host.session('s2', '/work/d0377d40-2fa7-42a0-94ab-49a31b2215c3', 'LongerProjectName');
  await flush();
  const title = barTitle(page);
  assert.equal(text(title), 'LongerProjectName-wt-d037');
  title.clientWidth = 14; page.resize();
  assert.equal(text(barTitle(page)), 'Lon…me-wt-d037');
});

// ---- 图标视图头部（Mac）和系统返回（iPhone） ----

test('图标视图头部（Mac）：根目录是 worktree 写法，悬停完整路径，窄了省略并随宽度重算；进了子目录是目录名', async t => {
  const { page } = await treePage(t, { state: ICONS });
  const body = byClass(page, page.grid, 'gbody');
  Object.assign(body, { clientWidth: 300, clientHeight: 120 });
  page.resize();
  const name = gridHead(page);
  assert.equal(text(name), FULL);
  assert.equal(name.title, WT);
  name.clientWidth = 13; page.resize();
  assert.equal(text(gridHead(page)), 'Ac…ew-wt-c037');
  gridHead(page).clientWidth = 40; page.resize();
  assert.equal(text(gridHead(page)), FULL);
});

test('图标视图头部（Mac）：非 worktree 照旧，标题悬停是目录名', async t => {
  const { page } = await treePage(t, { state: ICONS, project: null, path: '/work/ActaView' });
  assert.equal(text(gridHead(page)), 'ActaView');
  assert.equal(gridHead(page).title, 'ActaView');
});

test('系统返回的路径（iPhone 图标视图）：根目录用完整的 worktree 写法，不省略，不看宽度', async t => {
  const { page, host } = await treePage(t, { platform: 'ios', state: ICONS, back: true });
  barTitle(page).clientWidth = 4; page.resize();
  page.grid.find(node => node.classList.contains('cell') && node.textContent === 'dir')[0].dispatch('click');
  await flush();
  page.grid.find(node => node.classList.contains('cell') && node.textContent === 'inner')[0].dispatch('click');
  await flush();
  assert.deepEqual(host.calls.back.at(-1), [FULL, 'dir'], '上层：完整的 -wt- 写法，后面是路径里的目录');
  assert.equal(text(barTitle(page)), 'inner', '标题是当前目录名，不是根目录');
});

test('系统返回的路径：反查失败时仍是目录名（同现在）', async t => {
  const { page, host } = await treePage(t, { platform: 'ios', state: ICONS, back: true, project: null });
  page.grid.find(node => node.classList.contains('cell') && node.textContent === 'dir')[0].dispatch('click');
  await flush();
  page.grid.find(node => node.classList.contains('cell') && node.textContent === 'inner')[0].dispatch('click');
  await flush();
  assert.deepEqual(host.calls.back.at(-1), [UUID, 'dir']);
});

test('根目录没就绪（gone）：iPhone 工具条标题空、系统返回的路径空，Mac 图标视图头部不显示', async t => {
  const phone = await treePage(t, { platform: 'ios', state: ICONS, back: true });
  phone.page.grid.find(node => node.classList.contains('cell') && node.textContent === 'dir')[0].dispatch('click');
  await flush();
  assert.deepEqual(phone.host.calls.back.at(-1), [FULL], '进了 dir：上层是根目录名');
  phone.page.post({ type: 'root', generation: phone.host.generation, state: 'gone', path: WT, project: null });
  await flush();
  assert.equal(text(barTitle(phone.page)), '');
  assert.deepEqual(phone.host.calls.back.at(-1), [], '没就绪：页面是说明区，路径为空');
  const mac = await treePage(t, { state: ICONS });
  mac.page.post({ type: 'root', generation: mac.host.generation, state: 'gone', path: WT, project: null });
  await flush();
  assert.equal(byClass(mac.page, mac.page.grid, 'ghead').hidden, true);
});

// ---- 真实入口：真实模块 + 真实 git worktree + 真实页面 ----

test('真实入口：真实 git worktree（UUID 目录、长项目名）经 queryRoot 反查，root 消息送到页面，标题按宽度省略', async t => {
  const base = await tempDir(t), main = join(base, 'coda_plugins_resource_manager'), work = join(base, UUID);
  await mkdir(main);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: main, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', work, '-b', `agent/${UUID}`);
  t.after(() => { try { git('worktree', 'prune'); } catch { /* 目录已删 */ } });
  const fake = fakeCoda({ A: checkoutOf(work) });
  activate(fake.coda);
  const view = fake.open('A'), ready = deferred();
  let page;
  view.listen(message => ready.promise.then(() => queueMicrotask(() => page.post(message))));
  page = await loadApp(t, { platform: 'mac', postMessage: message => view.send(message), on: () => {}, copy: () => {}, getState: () => undefined, setState: () => {} });
  ready.resolve();
  const title = sectionOf(page);
  await waitFor(() => text(title) !== '', '根目录标题');
  const full = 'coda_plugins_resource_manager-wt-c037';
  assert.equal(text(title), full);
  assert.equal(view.lastRoot().project, 'coda_plugins_resource_manager', 'root 消息里的字段');
  title.clientWidth = 30; page.resize();
  assert.ok(text(title).includes('…') && text(title).endsWith('-wt-c037') && text(title).length <= 30, text(title));
  title.clientWidth = 10; page.resize();
  assert.ok(text(title).endsWith('…') && !text(title).includes('-wt-c037'), `第 3 步：${text(title)}`);
});
