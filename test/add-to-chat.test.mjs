// 右键添加到聊天：行菜单的项和顺序、成功与失败的提示、失败时复制的内容、过期时静默；
// Mac 选中文字的右键菜单（选区行号、位置文字、裁剪、消息超限）。真实的 app.mjs 和预览，配假 DOM 和脚本化的假模块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { fakeSelection } from './support/selection.mjs';
import { openTree, rowNamed } from './support/treehost.mjs';

const listing = { '': ['src/', 'a.txt', { name: 'out', kind: 'link' }, { name: 'sock', kind: 'other' }, { name: 'in.txt', kind: 'file', link: true }], src: ['app.ts'] };
const FILE_TEXT = 'one\ntwo\nthree\nfour\n'; // 偏移：one 0-3，two 4-7，three 8-13，four 14-18

async function start(t, options) {
  const ctx = await openTree(t, { listing, ...options });
  ctx.host.session('s1', '/work');
  await flush();
  return ctx;
}
const menuButtons = page => page.menu.find(node => node.tagName === 'BUTTON');
const labels = page => menuButtons(page).map(node => node.textContent);
const choose = (page, label) => menuButtons(page).find(node => node.textContent === label).dispatch('click');
const rightClick = (page, name) => rowNamed(page, name).dispatch('contextmenu', { clientX: 5, clientY: 6 });
const addRequests = async host => (await host.requests('add_text')).map(({ text, block }) => ({ text, block }));
const b64 = text => Buffer.from(text).toString('base64');

// ---- 行菜单 ----

test('行菜单（Mac）：打开（文件夹写展开；文件另有「在 Coda 中打开」）、分隔线、添加到聊天、复制相对路径、复制绝对路径、分隔线、属性，顺序固定', async t => {
  const { page } = await start(t, { platform: 'mac' });
  for (const [name, head, headShape] of [
    ['a.txt', ['打开', '在 Coda 中打开'], ['BUTTON', 'BUTTON']],
    ['src', ['展开'], ['BUTTON']],
    ['in.txt', ['打开', '在 Coda 中打开'], ['BUTTON', 'BUTTON']],
  ]) {
    rightClick(page, name);
    assert.deepEqual(labels(page), [...head, '添加到聊天', '复制相对路径', '复制绝对路径', '属性'], name);
    const shape = page.menu.children.map(node => node.tagName);
    assert.deepEqual(shape.slice(shape.indexOf('BUTTON')), [...headShape, 'HR', 'BUTTON', 'BUTTON', 'BUTTON', 'HR', 'BUTTON'], '打开区、分隔线、三项、分隔线、属性');
  }
});

test('行菜单：link、other（不能打开的）没有「添加到聊天」，仍有复制和属性', async t => {
  const { page } = await start(t, { platform: 'mac' });
  for (const name of ['out', 'sock']) {
    rightClick(page, name);
    assert.deepEqual(labels(page), ['复制相对路径', '复制绝对路径', '属性'], name);
  }
});

test('iPhone 长按出同样的菜单（文件带切换打开方式）', async t => {
  const { page, tick } = await start(t);
  rowNamed(page, 'a.txt').dispatch('pointerdown', { pointerId: 1, isPrimary: true, clientX: 5, clientY: 6 });
  tick(500);
  assert.deepEqual(labels(page), ['在 Coda 中打开', '添加到聊天', '复制相对路径', '复制绝对路径', '属性']);
});

test('添加到聊天：发 add_text，路径是相对路径、block 为 false；成功提示「已添加到输入框」约 2 秒，普通样式', async t => {
  const { page, host, tick } = await start(t, { platform: 'mac' });
  rightClick(page, 'src');
  choose(page, '添加到聊天');
  assert.equal(visible(page.menu), false, '点了就关菜单');
  assert.deepEqual(await addRequests(host), [{ text: 'src', block: false }]);
  assert.equal(visible(page.hint), false, '回答之前没有提示');
  host.answer((await host.requests('add_text'))[0], {});
  await flush();
  assert.equal(page.hint.textContent, '已添加到输入框');
  assert.ok(visible(page.hint));
  assert.equal(page.hint.classList.contains('warn'), false);
  assert.deepEqual(host.calls.copy, [], '成功不复制');
  tick(1999);
  assert.ok(visible(page.hint));
  tick(1);
  assert.equal(visible(page.hint), false, '约 2 秒后消失');
});

for (const code of ['draft_failed', 'draft_too_long', 'io_error', 'no_root']) {
  test(`添加失败（${code}）：改为复制同一段文字，提示「没能写入输入框，已复制」约 5 秒，警告样式`, async t => {
    const { page, host, tick } = await start(t, { platform: 'mac' });
    rightClick(page, 'src');
    choose(page, '添加到聊天');
    host.answer((await host.requests('add_text'))[0], { error: { code, message: '不行' } });
    await flush();
    assert.deepEqual(host.calls.copy, ['src']);
    assert.equal(page.hint.textContent, '没能写入输入框，已复制');
    assert.ok(page.hint.classList.contains('warn'));
    tick(4999);
    assert.ok(visible(page.hint));
    tick(1);
    assert.equal(visible(page.hint), false, '约 5 秒后消失');
  });
}

test('添加超时（30 秒没有回答）也算失败：复制并提示', async t => {
  const { page, host, tick } = await start(t, { platform: 'mac' });
  rightClick(page, 'a.txt');
  choose(page, '添加到聊天');
  await flush();
  tick(30_000);
  await flush();
  assert.deepEqual(host.calls.copy, ['a.txt']);
  assert.equal(page.hint.textContent, '没能写入输入框，已复制');
});

test('添加过程中换了会话：静默，不提示、不复制；新会话的提示也不被碰', async t => {
  const { page, host } = await start(t, { platform: 'mac' });
  rightClick(page, 'a.txt');
  choose(page, '添加到聊天');
  const [request] = await host.requests('add_text');
  host.session('s2', '/other');
  await flush();
  host.answer(request, {}); // 迟到的成功回答：代次不对，忽略
  host.answer({ ...request, generation: host.generation }, { error: { code: 'draft_failed', message: 'x' } }); // 请求号已作废
  await flush();
  assert.equal(visible(page.hint), false);
  assert.deepEqual(host.calls.copy, []);
});

test('复制相对路径、复制绝对路径照旧', async t => {
  const { page, host } = await start(t, { platform: 'mac' });
  rightClick(page, 'a.txt');
  choose(page, '复制相对路径');
  rightClick(page, 'a.txt');
  choose(page, '复制绝对路径');
  assert.deepEqual(host.calls.copy, ['a.txt', '/work/a.txt']);
  assert.equal((await host.requests('add_text')).length, 0);
});

// ---- 选中文字的菜单（只有 Mac）----

async function previewOf(t, text = FILE_TEXT, options) {
  const ctx = await start(t, { platform: 'mac', ...options });
  rowNamed(ctx.page, 'a.txt').dispatch('dblclick'); // Mac：双击打开
  const [read] = await ctx.host.requests('read');
  ctx.host.answer(read, { data: b64(text), offset: 0, size: Buffer.byteLength(text), mtimeMs: 1, kind: 'text', eof: true });
  await flush();
  const el = ctx.page.preview.find(node => node.classList.contains('text'))[0];
  const sel = fakeSelection(t, ctx.page.preview.find(node => node.classList.contains('code'))[0]);
  // 右键选中 [from, to)；返回有没有接管（preventDefault）。
  const rightClickSelection = (from, to) => {
    sel.select(el, from, to);
    let taken = false;
    el.dispatch('contextmenu', { clientX: 8, clientY: 9, preventDefault() { taken = true; } });
    return taken;
  };
  return { ...ctx, el, sel, rightClickSelection };
}

test('选中文字右键：三项菜单（内容、位置、复制），没有路径标题；单行位置是 路径:行', async t => {
  const { page, rightClickSelection } = await previewOf(t);
  assert.equal(rightClickSelection(4, 7), true);
  assert.ok(visible(page.menu));
  assert.deepEqual(labels(page), ['添加到聊天（内容）', '添加到聊天（位置）', '复制']);
  assert.equal(page.menu.find(node => node.classList.contains('menu-path')).length, 0);
  assert.equal(page.menu.find(node => node.tagName === 'HR').length, 0);
});

test('内容和位置：内容 block 为 true，位置 block 为 false；选区在打开菜单前取好，之后选区变了、清了也不影响', async t => {
  const { page, host, sel, el, rightClickSelection } = await previewOf(t);
  rightClickSelection(4, 7); // two
  sel.clear(); // 菜单打开后选区没了（WKWebView 右键可能不保留选区）
  choose(page, '添加到聊天（内容）');
  assert.deepEqual(await addRequests(host), [{ text: 'two', block: true }]);
  rightClickSelection(4, 13); // two\nthree
  sel.select(el, 0, 3);
  choose(page, '添加到聊天（位置）');
  assert.deepEqual(await addRequests(host), [{ text: 'two', block: true }, { text: 'a.txt:2-3', block: false }]);
  rightClickSelection(4, 7);
  choose(page, '复制');
  assert.deepEqual(host.calls.copy, ['two']);
});

test('选区行号：单行、多行、三击选行（结尾在下一行行首）、从行号列拖进来、拖出正文末尾', async t => {
  const { page, host, rightClickSelection } = await previewOf(t);
  const positions = [];
  const position = async (from, to) => {
    assert.equal(rightClickSelection(from, to), true, `${from}-${to}`);
    choose(page, '添加到聊天（位置）');
    positions.push((await addRequests(host)).at(-1).text);
  };
  await position(4, 7); // 单行
  await position(4, 13); // 多行
  await position(4, 8); // 三击选 two：包含换行，结尾在 three 的行首
  await position(-3, 7); // 从行号列拖进正文：裁掉行号列，从第一行开始
  await position(14, 100); // 拖出正文末尾：裁到末尾，four\n
  await position(0, 19); // 全选
  assert.deepEqual(positions, ['a.txt:2', 'a.txt:2-3', 'a.txt:2', 'a.txt:1-2', 'a.txt:4', 'a.txt:1-4']);
});

test('跨出 .text 时内容也裁到正文里：不带行号列的数字', async t => {
  const { page, host, rightClickSelection } = await previewOf(t);
  rightClickSelection(-6, 7);
  choose(page, '添加到聊天（内容）');
  assert.deepEqual(await addRequests(host), [{ text: 'one\ntwo', block: true }]);
});

test('不接管、走系统默认：没有选区、选区折叠、选区在正文外、裁剪后为空', async t => {
  const { page, el, sel, rightClickSelection } = await previewOf(t);
  let taken = false;
  sel.clear();
  el.dispatch('contextmenu', { preventDefault() { taken = true; } });
  assert.equal(taken, false, '没有选区');
  assert.equal(rightClickSelection(5, 5), false, '折叠的选区');
  assert.equal(rightClickSelection(-5, -1), false, '整个选区在行号列');
  assert.equal(rightClickSelection(-5, 0), false, '擦着正文的开头：裁剪后为空');
  assert.equal(rightClickSelection(19, 30), false, '擦着正文的末尾：裁剪后为空');
  assert.equal(visible(page.menu), false, '都没有弹自己的菜单');
});

test('消息超过上限：不发 add_text，直接复制，提示「选中内容太长，已复制」；位置照常能加', async t => {
  const big = `${'x'.repeat(130 * 1024)}\n`;
  const { page, host, rightClickSelection } = await previewOf(t, big);
  rightClickSelection(0, big.length);
  choose(page, '添加到聊天（内容）');
  await flush();
  assert.equal((await host.requests('add_text')).length, 0, '没发');
  assert.deepEqual(host.calls.copy, [big]);
  assert.equal(page.hint.textContent, '选中内容太长，已复制');
  assert.ok(page.hint.classList.contains('warn'));
  rightClickSelection(0, big.length);
  choose(page, '添加到聊天（位置）');
  assert.deepEqual(await addRequests(host), [{ text: 'a.txt:1', block: false }]);
});

test('选中内容没超过消息上限、但接近：照常发；草稿放不下（draft_too_long）由模块回答，同样改成复制', async t => {
  const text = 'y'.repeat(120 * 1024);
  const { page, host, rightClickSelection } = await previewOf(t, text);
  rightClickSelection(0, text.length);
  choose(page, '添加到聊天（内容）');
  const [request] = await host.requests('add_text');
  assert.equal(request.text.length, text.length);
  host.answer(request, { error: { code: 'draft_too_long', message: '草稿太长' } });
  await flush();
  assert.deepEqual(host.calls.copy, [text]);
  assert.equal(page.hint.textContent, '没能写入输入框，已复制');
});

test('切会话时关掉选中文字的菜单；预览滚动也关', async t => {
  const { page, host, rightClickSelection } = await previewOf(t);
  rightClickSelection(4, 7);
  assert.ok(visible(page.menu));
  page.preview.find(node => node.classList.contains('pbody'))[0].emit({ type: 'scroll' });
  assert.equal(visible(page.menu), false);
  rightClickSelection(4, 7);
  host.session('s2', '/other');
  await flush();
  assert.equal(visible(page.menu), false);
});

// ---- 菜单搬到 menu.mjs 之后 ----

test('菜单关闭之后，留在手里的按钮不再响应（Escape、点外面、换成别的菜单都算关闭）', async t => {
  const { page, host } = await start(t, { platform: 'mac' });
  rightClick(page, 'a.txt');
  const stale = menuButtons(page).find(node => node.textContent === '复制相对路径');
  globalThis.document.emit({ type: 'keydown', key: 'Escape' });
  stale.dispatch('click');
  assert.deepEqual(host.calls.copy, [], 'Escape 之后');

  rightClick(page, 'a.txt');
  const second = menuButtons(page).find(node => node.textContent === '复制相对路径');
  rightClick(page, 'src'); // 换成另一行的菜单
  second.dispatch('click');
  assert.deepEqual(host.calls.copy, [], '被换掉的菜单');

  rightClick(page, 'a.txt');
  const outside = menuButtons(page).find(node => node.textContent === '复制绝对路径');
  globalThis.document.emit({ type: 'pointerdown', target: rowNamed(page, 'src') });
  outside.dispatch('click');
  assert.deepEqual(host.calls.copy, [], '点菜单外');

  rightClick(page, 'a.txt');
  choose(page, '复制绝对路径');
  assert.deepEqual(host.calls.copy, ['/work/a.txt'], '开着的菜单照常响应');
});
