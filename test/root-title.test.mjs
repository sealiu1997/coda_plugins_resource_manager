// 根目录名的四处显示（设计第 19 节、19.6 节）：Mac 目录树标题、iPhone 页内工具条标题、图标视图头部、系统返回的路径。
// 真实的 app.mjs 配假 DOM；页面收到 root 消息（带 project）后渲染。fit 的量宽度在假 DOM 里一个字算 1，元素的 clientWidth 是字数。
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../main.mjs';
import { loadApp } from './support/dom.mjs';
import { deferred, fakeCoda, flush, tempDir, waitFor } from './support/fake.mjs';
import { openTree, sectionOf } from './support/treehost.mjs';

const UUID = 'c0377d40-2fa7-42a0-94ab-49a31b2215c3';
const WT = `/work/${UUID}`, FULL = 'ActaView worktree-c037', SHORT = 'ActaView wt-c037';
const ICONS = { v: 1, seq: 1, hidden: false, view: 'icons', sessions: {} };
const LISTING = { '': ['dir/', 'a.txt'], dir: ['inner/', 'x.txt'], 'dir/inner': ['deep.txt'] };
const byClass = (page, panel, name) => panel.find(node => node.classList.contains(name))[0];
const barTitle = page => byClass(page, page.bar, 'bar-title');
const gridHead = page => byClass(page, page.grid, 'gname-head');
const text = node => node?.textContent;
// 标题里的两段：项目名（.rn-name）、后缀（.rn-tag，空格在里面）；普通目录名没有这两段。
const pieces = node => ({ name: text(byClass(null, node, 'rn-name')), tag: text(byClass(null, node, 'rn-tag')) });

async function treePage(t, { platform = 'mac', project = 'ActaView', path = WT, ...options } = {}) {
  const ctx = await openTree(t, { platform, listing: LISTING, ...options });
  if (platform === 'mac') sectionOf(ctx.page).clientWidth = 0;
  ctx.host.session('s1', path, project);
  await flush();
  return ctx;
}

// ---- Mac 目录树标题 ----

test('Mac 树标题：worktree 是「项目名 worktree-编号」两段，悬停是完整路径；宽度不够时按四步省略，拖宽拖窄重算', async t => {
  const { page } = await treePage(t);
  const title = sectionOf(page);
  assert.equal(text(title), FULL);
  assert.deepEqual(pieces(title), { name: 'ActaView', tag: ' worktree-c037' }, '两个元素：项目名和后缀（空格在后缀里）');
  assert.equal(title.title, WT, '悬停：完整路径');
  title.clientWidth = 25; page.resize();
  assert.equal(text(title), FULL, '第 1 步：22 个字，不超过 25 的 90%');
  title.clientWidth = 24; page.resize();
  assert.equal(text(title), SHORT, '第 2 步：22 超过 24 的 90%，后缀缩成 wt');
  title.clientWidth = 16; page.resize();
  assert.equal(text(title), SHORT, '第 2 步：短写法正好 100%');
  title.clientWidth = 13; page.resize();
  assert.equal(text(title), 'Ac…ew wt-c037', '第 3 步：项目名从中间省略');
  assert.deepEqual(pieces(title), { name: 'Ac…ew', tag: ' wt-c037' });
  title.clientWidth = 11; page.resize();
  assert.equal(text(title), 'A…w wt-c037', '第 3 步的最短：项目名只剩 2 个字');
  title.clientWidth = 9; page.resize();
  assert.equal(text(title), 'A…w wt-c…', '第 4 步：整段尾部省略');
  title.clientWidth = 40; page.resize();
  assert.equal(text(title), FULL, '拖宽后回到完整');
  assert.equal(title.title, WT);
});

test('Mac 树标题：非 worktree（反查失败、original）显示文件夹名，没有悬停，窄了也不被 JS 省略（交给 CSS）', async t => {
  const { page } = await treePage(t, { project: null });
  const title = sectionOf(page);
  assert.equal(text(title), UUID, '反查失败：和现在一样是目录名');
  assert.deepEqual(pieces(title), { name: undefined, tag: undefined }, '普通目录名是纯文本，没有两段');
  assert.equal(title.title, '');
  title.clientWidth = 5; page.resize();
  assert.equal(text(title), UUID);
  const other = await treePage(t, { project: null, path: '/work/ActaView' });
  assert.equal(text(sectionOf(other.page)), 'ActaView');
});

test('Mac 树标题：worktree 的目录名不是 UUID 时编号取整个目录名；project 单独变了也重画标题（路径、状态不变）', async t => {
  const { page, host } = await treePage(t, { path: '/work/feature-login' });
  assert.equal(text(sectionOf(page)), 'ActaView worktree-feature-login');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/work/feature-login', project: 'Other' });
  await flush();
  assert.equal(text(sectionOf(page)), 'Other worktree-feature-login', 'project 变了，页面跟着变');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/work/feature-login' });
  await flush();
  assert.equal(text(sectionOf(page)), 'feature-login', '消息里没有 project（旧模块）：当作反查失败');
  assert.deepEqual(pieces(sectionOf(page)), { name: undefined, tag: undefined }, '换回纯文本：两段不再留着');
});

test('Mac 树标题：根目录没就绪时不显示标题', async t => {
  const { page, host } = await treePage(t);
  page.post({ type: 'root', generation: host.generation, state: 'gone', path: WT, project: null });
  await flush();
  assert.equal(sectionOf(page).hidden, true);
  assert.equal(text(sectionOf(page)), '');
});

// ---- iPhone 页内工具条标题 ----

test('iPhone 工具条：标题是两段，按标题的宽度四步省略，旋转或改字号后（resize）重算；非 worktree 同现在', async t => {
  const { page } = await treePage(t, { platform: 'ios' });
  const title = barTitle(page);
  assert.equal(text(title), FULL);
  assert.deepEqual(pieces(title), { name: 'ActaView', tag: ' worktree-c037' });
  title.clientWidth = 24; page.resize();
  assert.equal(text(barTitle(page)), SHORT, '第 2 步');
  title.clientWidth = 12; page.resize();
  assert.equal(text(barTitle(page)), 'Ac…w wt-c037', '第 3 步');
  title.clientWidth = 6; page.resize();
  assert.equal(text(barTitle(page)), 'A…w w…', '第 4 步');
  title.clientWidth = 30; page.resize();
  assert.equal(text(barTitle(page)), FULL);
  const plain = await treePage(t, { platform: 'ios', project: null });
  barTitle(plain.page).clientWidth = 4; plain.page.resize();
  assert.equal(text(barTitle(plain.page)), UUID, '反查失败：和现在一样，由 CSS 截断');
  assert.deepEqual(pieces(barTitle(plain.page)), { name: undefined, tag: undefined });
});

test('iPhone 工具条：工具条重画（换到别的会话）后新标题也会省略，旧标题不再响应', async t => {
  const { page, host } = await treePage(t, { platform: 'ios' });
  host.session('s2', '/work/d0377d40-2fa7-42a0-94ab-49a31b2215c3', 'LongerProjectName');
  await flush();
  const title = barTitle(page);
  assert.equal(text(title), 'LongerProjectName worktree-d037');
  title.clientWidth = 14; page.resize();
  assert.equal(text(barTitle(page)), 'Lon…me wt-d037');
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
  assert.deepEqual(pieces(name), { name: 'ActaView', tag: ' worktree-c037' });
  name.clientWidth = 24; page.resize();
  assert.equal(text(gridHead(page)), SHORT, '第 2 步');
  gridHead(page).clientWidth = 13; page.resize();
  assert.equal(text(gridHead(page)), 'Ac…ew wt-c037', '第 3 步');
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
  assert.deepEqual(host.calls.back.at(-1), ['ActaView worktree-c037', 'dir'], '上层：纯文字的完整写法（空格分隔，不缩写、不分段），后面是路径里的目录');
  assert.ok(host.calls.back.at(-1).every(title => typeof title === 'string'));
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

// ---- 真实入口：真实模块（queryRoot 从 Coda 的项目列表取项目名）+ 真实页面 ----

test('真实入口：真实 activate 的 queryRoot 从 agents 的项目列表取项目名（checkout.projectId），root 消息送到页面，标题按宽度省略', async t => {
  const base = await tempDir(t), work = join(base, UUID);
  await mkdir(work);
  const fake = fakeCoda({ A: { checkout: { kind: 'worktree', state: 'ready', path: work, projectId: 'p1' } }, agents: { projects: [{ id: 'p1', name: 'coda_plugins_resource_manager' }] } });
  activate(fake.coda);
  const view = fake.open('A'), ready = deferred();
  let page;
  view.listen(message => ready.promise.then(() => queueMicrotask(() => page.post(message))));
  page = await loadApp(t, { platform: 'mac', postMessage: message => view.send(message), on: () => {}, copy: () => {}, getState: () => undefined, setState: () => {} });
  ready.resolve();
  const title = sectionOf(page);
  await waitFor(() => text(title) !== '', '根目录标题');
  const full = 'coda_plugins_resource_manager worktree-c037';
  assert.equal(text(title), full);
  assert.equal(view.lastRoot().project, 'coda_plugins_resource_manager', 'root 消息里的字段');
  assert.deepEqual(pieces(title), { name: 'coda_plugins_resource_manager', tag: ' worktree-c037' });
  title.clientWidth = 38; page.resize();
  assert.equal(text(title), 'coda_plugins_resource_manager wt-c037', '第 2 步：短写法 37 个字放得下，完整的 43 放不下');
  title.clientWidth = 30; page.resize();
  assert.ok(text(title).includes('…') && text(title).endsWith(' wt-c037') && text(title).length <= 30, `第 3 步：${text(title)}`);
  title.clientWidth = 10; page.resize();
  assert.ok(text(title).endsWith('…') && !text(title).includes('wt-c037'), `第 4 步：${text(title)}`);
});

// ---- 样式（第 19.6 节第 3、4 条）：后缀常规字重、三级灰、比项目名小一号；字号用 em，颜色只用 --coda-*；Mac 标题比 0.8.0 之前大一号 ----

test('style.css：.rn-tag 是常规字重、--coda-tertiary、em 字号；Mac 标题（.section）字号大一号，后缀用回原来的字号', async () => {
  const css = await readFile(new URL('../view/style.css', import.meta.url), 'utf8');
  const rule = selector => { const m = new RegExp(`^${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(css); assert.ok(m, `没有 ${selector} 的规则`); return m[1]; };
  const tag = rule('.rn-tag');
  assert.match(tag, /font-weight:\s*400/);
  assert.match(tag, /color:\s*var\(--coda-tertiary,/);
  assert.match(tag, /font-size:\s*[\d.]+em/, '字号用 em，跟着标题走（--coda-font-size）');
  assert.doesNotMatch(tag, /font-size:[^;]*px/);
  assert.match(rule('.section .rn-tag'), /font-size:\s*[\d.]+em/);
  assert.match(rule('.section'), /font-size:\s*\.92em/, '约 12 点：比原来的 .85em（约 11 点）大一号');
});
