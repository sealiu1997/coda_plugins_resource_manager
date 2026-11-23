// 属性页：进入、原生返回、页内返回、横屏返回、换会话和根目录变化关闭、changed 重取并标「上次统计」、重新统计、统计的各种文字、
// 关闭后取消本地等待（不会 30 秒后误报）。真实的 app.mjs 和 info.mjs，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatFullDate } from '../view/format.mjs';
import { iconFor } from '../view/icons.mjs';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { openTree, rowNamed } from './support/treehost.mjs';

const listing = { '': ['src/', 'a.txt', { name: 'out', kind: 'link' }, { name: 'sock', kind: 'other' }, { name: 'lnk', kind: 'dir', link: true }] };
const MTIME = new Date(2026, 10, 5, 14, 5, 9).getTime(), BIRTH = new Date(2025, 2, 4, 9, 30, 0).getTime();
const FILE = { name: 'a.txt', kind: 'file', size: 2560, mtimeMs: MTIME, birthtimeMs: BIRTH, mode: 0o644 };
const DIR = { name: 'src', kind: 'dir', mtimeMs: MTIME, mode: 0o755 };

async function start(t, options) {
  const ctx = await openTree(t, { platform: 'mac', back: true, listing, ...options });
  ctx.host.session('s1', '/work');
  await flush();
  return ctx;
}
const buttons = node => node.find(child => child.tagName === 'BUTTON');
const choose = (page, label) => buttons(page.menu).find(node => node.textContent === label).dispatch('click');
// 打开某一行的属性页，并等它发出 stat 请求。
async function openInfo(ctx, name) {
  rowNamed(ctx.page, name).dispatch('contextmenu', { clientX: 5, clientY: 6 });
  choose(ctx.page, '属性');
  const stats = await ctx.host.requests('stat');
  return stats.at(-1);
}
// 属性页里的 标签 → 值（文字）。
const rows = page => Object.fromEntries(page.info.find(node => node.classList.contains('irow')).map(row => [row.children[0].textContent, row.children[1].textContent]));
const button = (page, label) => buttons(page.info).find(node => node.textContent === label);
// Mac 和没有 coda.back 的环境：点头部最左边的返回关属性页。
const headBack = page => buttons(page.info).find(node => node.getAttribute('aria-label') === '返回');
const closeByHead = async ctx => { headBack(ctx.page).dispatch('click'); await flush(); };
const sized = (size, items, complete = true, unreadable = 0) => ({ size, items, complete, unreadable });

// ---- 进入和离开 ----

test('进入：菜单里点「属性」，属性页盖住目录树，Mac 不声明原生返回，发 stat；回答后显示内容', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  const request = await openInfo(ctx, 'a.txt');
  assert.equal(request.path, 'a.txt');
  assert.ok(visible(page.info));
  assert.equal(visible(page.tree), false);
  assert.equal(page.tree.inert, true, '隐藏的面板 inert');
  assert.equal(page.info.inert, false);
  assert.deepEqual(host.calls.back, [], 'Mac 上 coda.back 存在也不调用');
  assert.match(page.info.textContent, /a\.txt/);
  assert.match(page.info.textContent, /读取中/);
  host.answer(request, FILE);
  await flush();
  assert.deepEqual(rows(page), {
    种类: '文本', 大小: '2.5 KiB（2,560 字节）', 位置: '工作目录', 完整路径: '/work/a.txt',
    修改时间: formatFullDate(MTIME), 创建时间: formatFullDate(BIRTH), 权限: 'rw-r--r--',
  });
  assert.equal(host.sent.filter(m => m.type === 'dir_size').length, 0, '文件不统计大小');
});

test('子目录里的文件：位置是它所在的相对目录', async t => {
  const ctx = await start(t);
  rowNamed(ctx.page, 'src').dispatch('dblclick');
  await flush();
  ctx.host.listing.src = ['app.ts'];
  ctx.host.changed();
  await flush();
  rowNamed(ctx.page, 'app.ts').dispatch('contextmenu', { clientX: 1, clientY: 1 });
  choose(ctx.page, '属性');
  const [request] = await ctx.host.requests('stat');
  ctx.host.answer(request, { name: 'app.ts', kind: 'file', size: 10 });
  await flush();
  assert.equal(rows(ctx.page).位置, 'src');
  assert.equal(rows(ctx.page).完整路径, '/work/src/app.ts');
  assert.equal(rows(ctx.page).种类, 'TypeScript');
  assert.equal(rows(ctx.page).大小, '10 字节');
});

test('属性页的种类名：3D 模型、音频的新扩展名和目录树图标用同一张种类表', async t => {
  const ctx = await start(t, { listing: { '': ['robot.glb', 'voice.opus'] } });
  for (const [name, kind, glyph] of [['robot.glb', '3D 模型', 'model3d'], ['voice.opus', '音频', 'audio']]) {
    await openInfo(ctx, name);
    const [request] = (await ctx.host.requests('stat')).slice(-1);
    ctx.host.answer(request, { name, kind: 'file', size: 10 });
    await flush();
    assert.equal(rows(ctx.page).种类, kind, name);
    assert.equal(iconFor({ kind: 'file', name }), glyph, name);
    await closeByHead(ctx);
  }
});

test('iPhone 原生返回：进入声明一层，头部没有返回；on(back) 关闭属性页，重新声明根层；目录树的滚动位置和展开状态不丢', async t => {
  const ctx = await start(t, { platform: 'ios' });
  const { page, host } = ctx;
  rowNamed(page, 'src').dispatch('click');
  await flush();
  const tree = page.tree.children;
  await openInfo(ctx, 'a.txt');
  assert.deepEqual(host.calls.back, [['资源管理器']]);
  assert.equal(headBack(page), undefined, '头部没有返回');
  host.events.back({ steps: 1 });
  await flush();
  assert.equal(visible(page.info), false);
  assert.equal(page.info.inert, true);
  assert.ok(visible(page.tree));
  assert.equal(page.tree.inert, false);
  assert.deepEqual(host.calls.back, [['资源管理器'], []]);
  assert.equal(page.tree.children, tree, '目录树只是被盖住，没有重画');
  assert.ok(rowNamed(page, 'src').classList.contains('open'));
  assert.equal(page.info.textContent, '', '内容清掉');
});

test('Mac 有 coda.back：不调用它，也不监听 back 事件；头部有返回，点了回到目录树，焦点在目录树', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  host.answer(await openInfo(ctx, 'a.txt'), FILE);
  await flush();
  assert.equal(host.events.back, undefined, '不监听 back');
  const back = page.info.children[0].children[0];
  assert.equal(back, headBack(page), '头部最左边');
  assert.ok(back.classList.contains('icon'));
  assert.equal(back.title, '返回');
  back.focus();
  back.dispatch('click');
  await flush();
  assert.equal(visible(page.info), false);
  assert.ok(visible(page.tree));
  assert.equal(page.info.textContent, '', '内容清掉');
  assert.equal(globalThis.document.activeElement, page.tree);
  assert.deepEqual(host.calls.back, [], '整个过程没有调用 coda.back');
});

test('没有 coda.back 的环境：页内头部放返回，点了回到目录树', async t => {
  const plain = await start(t, { back: false });
  const request = await openInfo(plain, 'a.txt');
  plain.host.answer(request, FILE);
  await flush();
  assert.equal(plain.host.calls.back.length, 0);
  const back = buttons(plain.page.info.children[0]).find(node => node.getAttribute('aria-label') === '返回');
  assert.ok(back, '头部有返回');
  back.dispatch('click');
  await flush();
  assert.equal(visible(plain.page.info), false);
  assert.ok(visible(plain.page.tree));
  assert.equal(plain.host.calls.back.length, 0, '没有 coda.back 不报错，也不记');
});

test('页内返回（没有 coda.back）之后，焦点交给目录树', async t => {
  const ctx = await start(t, { back: false });
  await openInfo(ctx, 'a.txt');
  const back = buttons(ctx.page.info).find(node => node.getAttribute('aria-label') === '返回');
  back.focus();
  back.dispatch('click');
  await flush();
  assert.equal(globalThis.document.activeElement, ctx.page.tree);
});

test('iPhone 横屏：工具条的「返回」在属性页里关属性页，不关视图；在根层才 coda.close()', async t => {
  const ctx = await start(t, { platform: 'ios' });
  const { page, host } = ctx;
  const exit = () => buttons(page.bar).find(node => node.classList.contains('exit'));
  await openInfo(ctx, 'a.txt'); // iPhone 用长按，菜单是同一个，这里直接右键
  exit().dispatch('click');
  await flush();
  assert.equal(visible(page.info), false);
  assert.ok(visible(page.tree));
  assert.equal(host.calls.close, undefined, '没有关视图');
  assert.deepEqual(host.calls.back, [['资源管理器'], []]);
  exit().dispatch('click');
  assert.equal(host.calls.close, 1, '在根层才关视图');
});

test('iPhone 横屏：「返回」关属性页后，焦点交给目录树（和页内返回、预览返回同一条路）', async t => {
  const ctx = await start(t, { platform: 'ios' });
  await openInfo(ctx, 'a.txt');
  const exit = buttons(ctx.page.bar).find(node => node.classList.contains('exit'));
  exit.focus();
  exit.dispatch('click');
  await flush();
  assert.equal(visible(ctx.page.info), false);
  assert.equal(globalThis.document.activeElement, ctx.page.tree);
});

test('iPhone：多余的 back 事件（不在属性页）只重新声明根层；换会话、根目录变化关闭时也声明回根层', async t => {
  const ctx = await start(t, { platform: 'ios' });
  const { page, host } = ctx;
  await openInfo(ctx, 'a.txt');
  host.events.back({ steps: 1 });
  host.events.back({ steps: 1 });
  await flush();
  assert.deepEqual(host.calls.back, [['资源管理器'], [], []]);
  await openInfo(ctx, 'a.txt');
  host.session('s2', '/other');
  await flush();
  assert.equal(visible(page.info), false);
  assert.deepEqual(host.calls.back.at(-1), []);
  await openInfo(ctx, 'a.txt');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/moved' });
  await flush();
  assert.equal(visible(page.info), false);
  assert.deepEqual(host.calls.back.at(-1), []);
});

test('iPhone 属性页：值的标签在上、值在下（样式由 CSS 管），内容同 Mac', async t => {
  const ctx = await start(t, { platform: 'ios' });
  ctx.host.answer(await openInfo(ctx, 'a.txt'), FILE);
  await flush();
  assert.equal(rows(ctx.page).权限, 'rw-r--r--');
  assert.ok(visible(ctx.page.info));
});

// ---- 换会话、根目录变化 ----

test('换会话：关闭属性页，重新声明根层，取消的统计不报失败', async t => {
  const ctx = await start(t);
  const { page, host, tick } = ctx;
  const stat = await openInfo(ctx, 'src');
  host.answer(stat, DIR);
  await flush();
  assert.match(page.info.textContent, /计算中/);
  host.session('s2', '/other');
  await flush();
  assert.equal(visible(page.info), false);
  assert.deepEqual(host.calls.back, [], 'Mac 不声明');
  tick(30_000);
  await flush();
  assert.equal(visible(page.hint), false, '没有超时误报');
  assert.equal(page.info.textContent, '');
});

test('根目录变化（同一会话换了位置）或不再 ready：关闭属性页；同一根目录的重复 root 不关', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  await openInfo(ctx, 'a.txt');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/work' });
  await flush();
  assert.ok(visible(page.info), '路径没变，不关');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/moved' });
  await flush();
  assert.equal(visible(page.info), false, '根目录换了位置');
  assert.deepEqual(host.calls.back, [], 'Mac 不声明');

  await openInfo(ctx, 'a.txt');
  page.post({ type: 'root', generation: host.generation, state: 'gone', path: '/moved' });
  await flush();
  assert.equal(visible(page.info), false, '工作目录不在了');
  assert.deepEqual(host.calls.back, [], 'Mac 不声明');
});

test('根目录变化关闭时取消统计：发 dir_size_cancel，不会 30 秒后误报', async t => {
  const ctx = await start(t);
  const { page, host, tick } = ctx;
  host.answer(await openInfo(ctx, 'src'), DIR);
  const [size] = await host.requests('dir_size');
  page.post({ type: 'root', generation: host.generation, state: 'ready', path: '/moved' });
  await flush();
  assert.deepEqual((await host.requests('dir_size_cancel')).map(({ requestId, generation }) => ({ requestId, generation })), [{ requestId: size.requestId, generation: size.generation }]);
  tick(30_000);
  await flush();
  assert.equal(visible(page.hint), false);
});

// ---- 文件夹大小 ----

test('文件夹：stat 回来后才发 dir_size（看回答的种类，不猜）；先是「计算中…」，回答后是大小和项数', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  const stat = await openInfo(ctx, 'src');
  assert.equal((await host.requests('dir_size')).length, 0, 'stat 没回来不统计');
  host.answer(stat, DIR);
  await flush();
  const [size] = await host.requests('dir_size');
  assert.equal(size.path, 'src');
  assert.equal(rows(page).大小, '计算中…');
  assert.equal(button(page, '重新统计'), undefined);
  host.answer(size, sized(3.2 * 1024 ** 3, 1204));
  await flush();
  assert.equal(rows(page).大小, '3.2 GiB（1,204 项）');
  assert.equal(button(page, '重新统计'), undefined, '完整、没有变过：没有重新统计');
  assert.equal(rows(page).种类, '文件夹');
});

// 每种回答一个测试（假计时器每个测试只能开一次）。again：有没有「重新统计」。
const SIZE_TEXTS = [
  [sized(3.2 * 1024 ** 3, 200_000, false), '超过 3.2 GiB（已统计 20 万项）', true],
  [sized(3.2 * 1024 ** 3, 45_123, false), '超过 3.2 GiB（已统计 45,123 项）', true],
  [sized(3.2 * 1024 ** 3, 200_000, false, 2), '超过 3.2 GiB（已统计 20 万项，2 项读不到）', true],
  [sized(3.2 * 1024 ** 3, 1204, true, 3), '至少 3.2 GiB（3 项读不到）', false],
  [sized(0, 0, false), '目录正忙，没统计完', true],
  [sized(0, 0, true), '0 B（0 项）', false],
];
for (const [reply, text, again] of SIZE_TEXTS) {
  test(`文件夹大小的文字：${text}${again ? '，带「重新统计」' : '，没有「重新统计」'}`, async t => {
    const ctx = await start(t);
    ctx.host.answer(await openInfo(ctx, 'src'), DIR);
    await flush();
    ctx.host.answer((await ctx.host.requests('dir_size'))[0], reply);
    await flush();
    assert.equal(rows(ctx.page).大小.replace(/ 重新统计$/, ''), text);
    assert.equal(button(ctx.page, '重新统计') !== undefined, again);
  });
}

test('统计失败：显示原因和重新统计，点了再发一次', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  host.answer(await openInfo(ctx, 'src'), DIR);
  await flush();
  host.answer((await host.requests('dir_size'))[0], { error: { code: 'io_error', message: '读不了' } });
  await flush();
  assert.equal(rows(page).大小, '统计失败：读不了 重新统计');
  button(page, '重新统计').dispatch('click');
  assert.equal((await host.requests('dir_size')).length, 2);
  assert.equal(rows(page).大小, '计算中…');
});

test('changed：重取 stat，不自动重新统计；已有结果标「上次统计」并给「重新统计」；点了重新统计发新请求，新结果不再标', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  host.answer(await openInfo(ctx, 'src'), DIR);
  await flush();
  host.answer((await host.requests('dir_size'))[0], sized(1024, 5));
  await flush();
  assert.equal(rows(page).大小, '1.0 KiB（5 项）');

  host.changed();
  const stats = await host.requests('stat');
  assert.equal(stats.length, 2, '重取 stat');
  assert.equal((await host.requests('dir_size')).length, 1, '不自动重新统计');
  assert.equal(rows(page).大小, '1.0 KiB（5 项） · 上次统计 重新统计');
  host.answer(stats[1], { ...DIR, mtimeMs: MTIME + 1000 });
  await flush();
  assert.equal(rows(page).修改时间, formatFullDate(MTIME + 1000), '属性是新的');
  assert.equal(rows(page).大小, '1.0 KiB（5 项） · 上次统计 重新统计', '重取 stat 不清掉统计结果');

  button(page, '重新统计').dispatch('click');
  const second = (await host.requests('dir_size'))[1];
  assert.equal(rows(page).大小, '计算中…');
  host.answer(second, sized(2048, 6));
  await flush();
  assert.equal(rows(page).大小, '2.0 KiB（6 项）');
});

test('统计进行中先 changed、统计回答后到：这个结果也标「上次统计」（先 changed 后回答的顺序）', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  host.answer(await openInfo(ctx, 'src'), DIR);
  await flush();
  const [size] = await host.requests('dir_size');
  host.changed();
  await flush();
  assert.equal(rows(page).大小, '计算中…', '统计还在进行');
  host.answer(size, sized(1024, 5));
  await flush();
  assert.equal(rows(page).大小, '1.0 KiB（5 项） · 上次统计 重新统计');
});

test('统计回答之后才 changed：同样标「上次统计」', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  host.answer(await openInfo(ctx, 'src'), DIR);
  await flush();
  host.answer((await host.requests('dir_size'))[0], sized(1024, 5));
  await flush();
  assert.equal(rows(page).大小.includes('上次统计'), false);
  host.changed();
  await flush();
  assert.equal(rows(page).大小, '1.0 KiB（5 项） · 上次统计 重新统计');
});

test('changed 时重取的 stat 失败（文件没了）：显示原因和重试，重试成功后恢复', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  host.answer(await openInfo(ctx, 'a.txt'), FILE);
  await flush();
  host.changed();
  host.answer((await host.requests('stat'))[1], { error: { code: 'not_found', message: '没有这个文件' } });
  await flush();
  assert.match(page.info.textContent, /读不到属性/);
  assert.match(page.info.textContent, /没有这个文件/);
  button(page, '重试').dispatch('click');
  host.answer((await host.requests('stat'))[2], FILE);
  await flush();
  assert.equal(rows(page).种类, '文本');
});

test('取属性失败：显示原因和重试', async t => {
  const ctx = await start(t);
  const { page, host } = ctx;
  host.answer(await openInfo(ctx, 'a.txt'), { error: { code: 'denied', message: '没有权限' } });
  await flush();
  assert.match(page.info.textContent, /没有权限/);
  assert.equal(host.sent.filter(m => m.type === 'dir_size').length, 0);
  button(page, '重试').dispatch('click');
  assert.equal((await host.requests('stat')).length, 2);
});

test('关闭属性页：统计的本地等待同时取消，发 dir_size_cancel，30 秒后没有超时误报，迟到的回答被忽略', async t => {
  const ctx = await start(t);
  const { page, host, tick } = ctx;
  host.answer(await openInfo(ctx, 'src'), DIR);
  await flush();
  const [size] = await host.requests('dir_size');
  await closeByHead(ctx);
  assert.deepEqual((await host.requests('dir_size_cancel')).map(m => m.requestId), [size.requestId]);
  tick(30_000);
  await flush();
  assert.equal(visible(page.hint), false, '没有失败提示');
  assert.equal(page.info.textContent, '');
  host.answer(size, sized(1, 1)); // 迟到的回答
  await flush();
  assert.equal(page.info.textContent, '');
});

test('统计已经回答之后关闭：不再发 dir_size_cancel', async t => {
  const ctx = await start(t);
  const { host } = ctx;
  host.answer(await openInfo(ctx, 'src'), DIR);
  await flush();
  host.answer((await host.requests('dir_size'))[0], sized(1, 1));
  await flush();
  await closeByHead(ctx);
  assert.equal((await host.requests('dir_size_cancel')).length, 0);
});

test('新统计替换旧的：旧的请求被取消（本地和模块），只有新的结果显示', async t => {
  const ctx = await start(t);
  const { page, host, tick } = ctx;
  host.answer(await openInfo(ctx, 'src'), DIR);
  await flush();
  const [first] = await host.requests('dir_size');
  // 关掉再打开另一个文件夹：旧的统计取消
  await closeByHead(ctx);
  rowNamed(page, 'lnk').dispatch('contextmenu', { clientX: 1, clientY: 1 });
  choose(page, '属性');
  host.answer((await host.requests('stat')).at(-1), { name: 'lnk', kind: 'dir', link: true, target: 'src' });
  await flush();
  const second = (await host.requests('dir_size'))[1];
  assert.notEqual(second.requestId, first.requestId);
  assert.deepEqual((await host.requests('dir_size_cancel')).map(m => m.requestId), [first.requestId]);
  host.answer(first, sized(999, 9)); // 旧的迟到：忽略
  host.answer(second, sized(2048, 2));
  await flush();
  assert.equal(rows(page).大小, '2.0 KiB（2 项）');
  tick(30_000);
  await flush();
  assert.equal(visible(page.hint), false);
});

// ---- 不同种类的条目 ----

test('内链接（按目标显示）：种类带「链接」，有「链接到」', async t => {
  const ctx = await start(t);
  ctx.host.answer(await openInfo(ctx, 'lnk'), { name: 'lnk', kind: 'dir', link: true, target: 'src', mtimeMs: MTIME });
  await flush();
  assert.equal(rows(ctx.page).种类, '文件夹（链接）');
  assert.equal(rows(ctx.page).链接到, 'src');
  assert.equal((await ctx.host.requests('dir_size')).length, 1, '指向目录的内链接也统计（按目标）');
});

test('内链接的种类看目标的名字，不看链接自己叫什么：叫 latest-notes 的链接指向 notes.txt 是文本', async t => {
  const ctx = await start(t);
  ctx.host.answer(await openInfo(ctx, 'lnk'), { name: 'latest-notes', kind: 'file', link: true, target: 'docs/notes.txt', size: 5 });
  await flush();
  assert.equal(rows(ctx.page).种类, '文本（链接）');
});

test('外链接和失效的链接：只有自己的元数据，没有链接到，没有大小，不统计', async t => {
  const ctx = await start(t);
  ctx.host.answer(await openInfo(ctx, 'out'), { name: 'out', kind: 'link', link: true, mtimeMs: MTIME, mode: 0o777 });
  await flush();
  const shown = rows(ctx.page);
  assert.equal(shown.种类, '链接（指向工作目录外或已失效）');
  assert.equal('链接到' in shown, false);
  assert.equal('大小' in shown, false);
  assert.equal(shown.权限, 'rwxrwxrwx');
  assert.equal((await ctx.host.requests('dir_size')).length, 0);
});

test('other：种类是特殊文件，只有自己的元数据', async t => {
  const ctx = await start(t);
  ctx.host.answer(await openInfo(ctx, 'sock'), { name: 'sock', kind: 'other', mtimeMs: MTIME });
  await flush();
  assert.deepEqual(rows(ctx.page), { 种类: '特殊文件', 位置: '工作目录', 完整路径: '/work/sock', 修改时间: formatFullDate(MTIME) });
});

test('读不到的字段不显示：没有创建时间和权限就没有这两行', async t => {
  const ctx = await start(t);
  ctx.host.answer(await openInfo(ctx, 'a.txt'), { name: 'a.txt', kind: 'file', size: 0, mtimeMs: MTIME });
  await flush();
  assert.equal('创建时间' in rows(ctx.page), false);
  assert.equal('权限' in rows(ctx.page), false);
  assert.equal(rows(ctx.page).大小, '0 字节');
});

test('属性页里的文字可以选中（selectable）', async t => {
  const ctx = await start(t);
  ctx.host.answer(await openInfo(ctx, 'a.txt'), FILE);
  await flush();
  assert.ok(ctx.page.info.find(node => node.classList.contains('pbody'))[0].classList.contains('selectable'));
});

test('属性页开着时 Mac 的目录树 inert，隐藏面板（预览、说明）一直 inert', async t => {
  const ctx = await start(t);
  await openInfo(ctx, 'a.txt');
  assert.equal(ctx.page.tree.inert, true);
  assert.equal(ctx.page.preview.inert, true);
  assert.equal(ctx.page.notice.inert, true);
  assert.equal(ctx.page.info.inert, false);
});

// ---- 工具条：属性页上没有 ⋯ ----

const MAC_MORE = { id: 'more', label: '更多', icon: 'ellipsis', kind: 'button' };
const barLabels = page => buttons(page.bar).map(node => node.getAttribute('aria-label') ?? node.textContent);
const barParts = page => page.bar.children.map(node => (node.classList.contains('bar-title') ? 'title' : node.classList.contains('exit') ? 'exit' : node.getAttribute('aria-label')));

test('Mac（原生工具栏）：进入属性页工具栏撤空，退出恢复「更多」；撤空期间迟到的 more 事件不弹菜单', async t => {
  const given = [];
  const ctx = await start(t, { coda: { toolbar: items => given.push(items) } });
  const { page, host } = ctx;
  assert.deepEqual(given.at(-1), [MAC_MORE]);
  await openInfo(ctx, 'a.txt');
  assert.deepEqual(given.at(-1), [], '属性页上没有「更多」');
  host.events.toolbar({ id: 'more' });
  await flush();
  assert.equal(page.menu.hidden, true, '原生按钮已撤掉，迟到的事件不弹菜单');
  await closeByHead(ctx);
  await flush();
  assert.deepEqual(given.at(-1), [MAC_MORE], '退出属性页恢复');
  host.events.toolbar({ id: 'more' });
  await flush();
  assert.equal(page.menu.hidden, false, '恢复后「更多」照常弹菜单');
});

test('iPhone：属性页上页内工具条只留返回（横屏才显示），没有根目录名和 ⋯，并标成只有返回；退出恢复', async t => {
  const ctx = await start(t, { platform: 'ios' });
  const { page, host } = ctx;
  assert.deepEqual(barParts(page), ['exit', 'title', '更多']);
  await openInfo(ctx, 'a.txt');
  assert.deepEqual(barParts(page), ['exit'], '只留返回，没有根目录名');
  assert.equal(page.bar.hidden, false, '横屏要用它');
  assert.ok(page.bar.classList.contains('exit-only'), '竖屏整条由 CSS 隐藏');
  host.events.back({ steps: 1 });
  await flush();
  assert.deepEqual(barParts(page), ['exit', 'title', '更多'], '退出恢复');
  assert.equal(page.bar.classList.contains('exit-only'), false, '不再是只有返回的工具条');
});

test('iPhone 横屏的返回关属性页后，工具条也恢复', async t => {
  const ctx = await start(t, { platform: 'ios' });
  const { page } = ctx;
  await openInfo(ctx, 'a.txt');
  buttons(page.bar).find(node => node.classList.contains('exit')).dispatch('click');
  await flush();
  assert.deepEqual(barParts(page), ['exit', 'title', '更多']);
  assert.equal(page.bar.classList.contains('exit-only'), false);
});

test('没有原生工具栏的 Mac（harness）：属性页上整条页内工具条不显示，退出恢复刷新和显示隐藏文件', async t => {
  const ctx = await start(t, { back: false });
  const { page } = ctx;
  assert.deepEqual(barLabels(page), ['刷新', '显示隐藏文件']);
  assert.equal(page.bar.hidden, false);
  await openInfo(ctx, 'a.txt');
  assert.equal(page.bar.hidden, true, '没有项就整条藏起来，不留一条空线');
  assert.deepEqual(barLabels(page), []);
  buttons(page.info).find(node => node.getAttribute('aria-label') === '返回').dispatch('click');
  await flush();
  assert.equal(page.bar.hidden, false);
  assert.deepEqual(barLabels(page), ['刷新', '显示隐藏文件']);
});
