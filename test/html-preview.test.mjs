// HTML 接进预览（设计第 27.2、27.4、27.5 节）：类别、打开资格、解码、退回源码、元信息、查找、口令。
// 清洗本身在 test/html.test.mjs；这里用假 DOMParser（test/support/htmlparser.mjs）只验接线。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createModes } from '../view/modes.mjs';
import { mountPreview } from '../view/preview.mjs';
import { OpenCategory, canOpenInCoda, openCategoryOf } from '../view/protocol.mjs';
import { Element } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { open as openFilePage, start } from './support/filepage.mjs';
import { cmd } from './support/finder.mjs';
import { installHighlights } from './support/highlights.mjs';
import { installParser } from './support/htmlparser.mjs';
import { startPhone, startSearch } from './support/searchhost.mjs';

const byTag = (root, tag) => root.find(n => n.tagName === tag.toUpperCase());
const byClass = (root, cls) => root.find(n => n.classList?.contains(cls));
const metaOf = el => byClass(el, 'pmeta')[0];
const onDoc = (key, modifiers = {}) => { document.emit({ type: 'keydown', key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers, preventDefault() {}, target: null }); };
const pressedMode = el => byTag(byClass(el, 'pmode')[0], 'button').filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent);
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4]; // 「中文」的 GBK 字节
const gbkPage = () => Buffer.concat([Buffer.from('<meta charset="gbk"><p>'), Buffer.from(GBK_ZHONGWEN), Buffer.from('</p>')]);

// 一个预览：read 直接给字节（Buffer 或字符串）。
async function mount(t, { name = 'docs/a.html', body = '<p>正文</p>', parser = {}, media = undefined } = {}) {
  await openFilePage(t, { path: 'x.txt', files: {} }); // 装上假 document 和假时钟
  installParser(t, parser);
  const file = { body, mtimeMs: 100 };
  const el = new Element('div');
  const preview = mountPreview(el, {
    read: async () => { const data = Buffer.from(file.body); return { kind: 'text', data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: file.mtimeMs, eof: true }; },
    copy: () => {}, media,
  });
  await preview.open(name);
  await flush();
  return { el, preview, file };
}

// ---- 类别和打开资格 ----

test('类别：html、htm、xhtml（不分大小写）归 html，默认页内「预览」；Markdown 和其他文本不变', () => {
  for (const name of ['a.html', 'dir/a.HTM', 'a.xhtml']) assert.equal(openCategoryOf(name), OpenCategory.HTML, name);
  assert.equal(openCategoryOf('a.md'), OpenCategory.MARKDOWN);
  assert.equal(openCategoryOf('a.txt'), OpenCategory.TEXT);
  assert.equal(openCategoryOf('a.rtf'), OpenCategory.TEXT);
  const modes = createModes();
  modes.open(OpenCategory.HTML);
  modes.content(true);
  assert.deepEqual(modes.state(), { group: 'rich', mode: 'preview', available: true });
  assert.equal(modes.isRichPreview(), true);
  assert.deepEqual(modes.buttons().map(b => b.label), ['预览', '源码']);
});

test('canOpenInCoda：流式服务肯供应才为真——txt、RTF、HTML 为真；未知扩展名、mkv、avi 为假', () => {
  for (const name of ['a.txt', 'a.rtf', 'a.html', 'a.htm', 'a.xhtml', 'a.pdf', 'README.md', 'a.png']) assert.equal(canOpenInCoda(name), true, name);
  for (const name of ['a.xyz', 'noext', 'a.mkv', 'a.avi']) assert.equal(canOpenInCoda(name), false, name);
});

// ---- 预览挂载和元信息 ----

test('HTML 默认显示预览：元信息追加「静态预览」，完整说明和清洗过的标题放进悬停提示', async t => {
  const { el } = await mount(t, { body: '<title>我的 报告</title><p>正文</p>' });
  assert.equal(byClass(el, 'md').length, 1);
  assert.equal(byClass(el, 'text').length, 0);
  assert.equal(metaOf(el).textContent.endsWith('静态预览'), true, metaOf(el).textContent);
  assert.match(metaOf(el).title, /^修改于 /);
  assert.match(metaOf(el).title, /静态预览：不运行脚本/);
  assert.match(metaOf(el).title, /标题：我的 报告/);
  assert.equal(metaOf(el).textContent.includes('我的 报告'), false, '标题不进元信息');
  assert.deepEqual(pressedMode(el), ['预览']);
});

test('没有 <title> 时悬停提示里没有标题行；切到源码，元信息不再写「静态预览」，切回来又有', async t => {
  const { el } = await mount(t);
  assert.equal(metaOf(el).title.includes('标题：'), false);
  const [previewButton, sourceButton] = byTag(byClass(el, 'pmode')[0], 'button');
  sourceButton.dispatch('click');
  assert.equal(byClass(el, 'text').length, 1);
  assert.equal(metaOf(el).textContent.includes('静态预览'), false);
  previewButton.dispatch('click');
  assert.equal(metaOf(el).textContent.endsWith('静态预览'), true);
});

test('截断的文件：元信息写「只显示前 1.0 MiB」，再接「静态预览」', async t => {
  await openFilePage(t, { path: 'x.txt', files: {} });
  installParser(t);
  const el = new Element('div'), chunk = Buffer.from('<p>x</p>');
  const preview = mountPreview(el, { read: async () => ({ kind: 'text', data: chunk.toString('base64'), offset: 0, size: 2 * 1024 * 1024, mtimeMs: 1, eof: true }), copy: () => {} });
  await preview.open('a.html');
  await flush();
  assert.match(metaOf(el).textContent, /只显示前 1\.0 MiB，静态预览$/);
});

test('「内容很少」的提示和「看源码」按钮由渲染给出，点按钮切到源码', async t => {
  const { el } = await mount(t, { body: '<script>x()</script><p>短</p>' });
  assert.match(el.textContent, /静态预览里内容很少，页面的脚本没有运行/);
  const button = byTag(el, 'button').find(b => b.textContent === '看源码');
  assert.ok(button);
  button.dispatch('click');
  assert.equal(byClass(el, 'text').length, 1);
  assert.deepEqual(pressedMode(el), ['源码']);
});

// ---- 解码 ----

test('GBK 页面：预览和源码里的文字一致，都不乱码；开着查找来回切换，两边都能找到中文', async t => {
  const env = installHighlights(t);
  const { el, preview } = await mount(t, { body: gbkPage() });
  assert.equal(byTag(el, 'p')[0].textContent, '中文');
  const field = () => byClass(el, 'finput')[0], count = () => byClass(el, 'fcount')[0].textContent;
  assert.equal(preview.openFind(), true);
  field().value = '中文';
  field().dispatch('input');
  t.mock.timers.tick(150);
  assert.equal(count(), '1/1', '预览里找得到');
  const [previewButton, sourceButton] = byTag(byClass(el, 'pmode')[0], 'button');
  sourceButton.dispatch('click');
  const source = byClass(el, 'text')[0];
  assert.equal(source.textContent, '<meta charset="gbk"><p>中文</p>', '源码是解码后的文字');
  assert.equal(source.textContent.includes('�'), false);
  assert.equal(preview.findOpen, true);
  assert.equal(count(), '1/1', '源码里找得到');
  previewButton.dispatch('click');
  assert.equal(count(), '1/1', '切回预览又找得到');
  assert.equal(env.registry.get('find').size, 1);
});

test('解码失败：退回源码，用读取时的 UTF-8 文本，元信息提示；再点「预览」还是退回', async t => {
  await openFilePage(t, { path: 'x.txt', files: {} });
  installParser(t);
  const Real = globalThis.TextDecoder;
  globalThis.TextDecoder = class extends Real { constructor(label, options) { if (label !== undefined) throw new RangeError('解码器不可用'); super(); } };
  t.after(() => { globalThis.TextDecoder = Real; });
  const el = new Element('div'), data = Buffer.from('<p>文字</p>');
  const preview = mountPreview(el, { read: async () => ({ kind: 'text', data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 1, eof: true }), copy: () => {} });
  await preview.open('a.html');
  await flush();
  assert.equal(byClass(el, 'md').length, 0);
  assert.equal(byClass(el, 'text')[0].textContent, '<p>文字</p>');
  assert.match(metaOf(el).textContent, /预览出错，改显示源码/);
  assert.deepEqual(pressedMode(el), ['源码']);
  byTag(byClass(el, 'pmode')[0], 'button')[0].dispatch('click');
  assert.equal(byClass(el, 'md').length, 0);
  assert.deepEqual(pressedMode(el), ['源码']);
});

test('解析或清洗抛错：退回源码，用已经解码好的文字（GBK 不会退回乱码），元信息提示', async t => {
  const { el } = await mount(t, { body: gbkPage(), parser: { fail: true } });
  assert.equal(byClass(el, 'md').length, 0);
  assert.equal(byClass(el, 'text')[0].textContent, '<meta charset="gbk"><p>中文</p>');
  assert.match(metaOf(el).textContent, /预览出错，改显示源码/);
  assert.deepEqual(pressedMode(el), ['源码']);
});

test('清洗抛错（解析正常返回，清洗读节点时才抛）：退回源码，提示出错，用已经解码好的 GBK 文字，不是 UTF-8 乱码', async t => {
  const { el } = await mount(t, { body: gbkPage(), parser: { poison: true } });
  assert.equal(byClass(el, 'md').length, 0, '没有留下半截预览');
  assert.equal(byClass(el, 'text')[0].textContent, '<meta charset="gbk"><p>中文</p>');
  assert.equal(byClass(el, 'text')[0].textContent.includes('�'), false);
  assert.match(metaOf(el).textContent, /预览出错，改显示源码/);
  assert.equal(metaOf(el).textContent.includes('静态预览'), false, '旧状态没有混进来');
  assert.deepEqual(pressedMode(el), ['源码']);
});

// ---- 图片口令 ----

test('口令按渲染出的本地图片清单取：有图片取一次、补上地址；没有图片不取', async t => {
  const grants = [];
  const media = () => { grants.push(1); return Promise.resolve({ token: 'tk', size: 1, mtimeMs: 1 }); };
  const { el } = await mount(t, { body: '<p>图</p><img src="pic.png" alt="示意">', media });
  assert.equal(grants.length, 1);
  assert.equal(byTag(el, 'img')[0].getAttribute('src'), 'coda-view://service/media/tk/docs/pic.png');

  const none = [];
  await mount(t, { body: '<p>没有图</p>', media: () => { none.push(1); return Promise.resolve({ token: 'tk', size: 1, mtimeMs: 1 }); } });
  assert.equal(none.length, 0);
});

// ---- 长行：Highlight 只在没有不折行的超长行时注册（第 26.2 节）----

async function findIn(t, body, term = 'needle') {
  const env = installHighlights(t);
  const { el, preview } = await mount(t, { body });
  preview.openFind();
  const field = byClass(el, 'finput')[0];
  field.value = term;
  field.dispatch('input');
  t.mock.timers.tick(150);
  return { count: byClass(el, 'fcount')[0].textContent, registered: env.registry.get('find')?.size ?? 0 };
}
const LONG = 'x'.repeat(6000);

test('长行：压成一行的 HTML 源码（超过 5000 字）不影响预览里注册高亮，因为渲染出来没有不折行的长行', async t => {
  const { count, registered } = await findIn(t, `<p data-x="${LONG}">needle</p>`);
  assert.equal(count, '1/1');
  assert.equal(registered, 1);
});

test('长行：渲染出的代码块或表格单元格里有超长行，只计数、导航，不注册高亮；短的照常注册', async t => {
  for (const body of [`<pre>${LONG} needle</pre>`, `<td>${LONG} needle</td>`]) {
    const { count, registered } = await findIn(t, body);
    assert.equal(count, '1/1', body.slice(0, 8));
    assert.equal(registered, 0, `${body.slice(0, 8)}：不注册`);
  }
  for (const body of ['<pre>short needle</pre>', '<td>short needle</td>']) assert.equal((await findIn(t, body)).registered, 1, body);
});

// ---- 查找的三个入口都留在预览里 ----

const HTML_FILE = '<p>foo bar foo</p>';
const pick = (page, cls) => page.preview.find(node => node.classList.contains(cls))[0];
const stays = page => {
  assert.equal(pick(page, 'fbar').hidden, false, '查找条已打开');
  assert.equal(page.preview.find(node => node.classList.contains('md')).length, 1, '留在预览');
  assert.equal(page.preview.find(node => node.classList.contains('text')).length, 0, '没有切到源码');
  assert.deepEqual(page.preview.find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-pressed') === 'true').map(b => b.textContent), ['预览']);
};
const typeFind = (page, term) => { const field = pick(page, 'finput'); field.value = term; field.dispatch('input'); };

test('Mac 独立窗口：⌘F 打开查找条，留在 HTML 预览里，找得到渲染后的文字', async t => {
  installHighlights(t);
  installParser(t);
  const { page } = await start(t, { path: 'a.html', files: { 'a.html': { text: HTML_FILE } } });
  document.activeElement = null;
  onDoc('f', cmd);
  stays(page);
  typeFind(page, 'foo');
  t.mock.timers.tick(150);
  assert.equal(pick(page, 'fcount').textContent, '1/2');
});

// 0.10.1 起 .html 默认交给 Coda：要在页内预览的用例先存「页内」偏好。
const savedInlineHtml = { v: 1, seq: 1, hidden: false, sort: 'name', view: 'list', openWith: { html: 'inline' }, sessions: {} };

test('Mac 侧栏：⌘F 打开查找条，留在 HTML 预览里', async t => {
  installHighlights(t);
  installParser(t);
  const ctx = await startSearch(t, { listing: { '': ['a.html'] }, state: savedInlineHtml });
  Object.assign(ctx.host, { autoRead: true, files: { 'a.html': HTML_FILE } });
  const row = ctx.page.tree.find(n => n.classList.contains('row') && n.textContent.includes('a.html'))[0];
  row.dispatch('click');
  row.dispatch('dblclick');
  await flush();
  document.activeElement = null;
  onDoc('f', cmd);
  stays(ctx.page);
  typeFind(ctx.page, 'foo');
  ctx.tick(150);
  assert.equal(pick(ctx.page, 'fcount').textContent, '1/2');
});

test('iPhone：⋯ 菜单里的「查找」打开查找条，留在 HTML 预览里；模式切换在头部', async t => {
  installHighlights(t);
  installParser(t);
  const ctx = await startPhone(t, { listing: { '': ['a.html'] }, state: savedInlineHtml });
  Object.assign(ctx.host, { autoRead: true, files: { 'a.html': HTML_FILE } });
  ctx.page.tree.find(n => n.classList.contains('row') && n.textContent.includes('a.html'))[0].dispatch('click');
  await flush();
  ctx.page.preview.find(node => node.getAttribute('aria-label') === '更多')[0].dispatch('click');
  assert.deepEqual(ctx.page.menu.find(node => node.tagName === 'BUTTON').map(node => node.textContent), ['刷新', '查找', '复制路径']);
  ctx.page.menu.find(node => node.textContent === '查找')[0].dispatch('click');
  stays(ctx.page);
  typeFind(ctx.page, 'foo');
  ctx.tick(150);
  assert.equal(pick(ctx.page, 'fcount').textContent, '1/2');
  assert.deepEqual(byTag(pick(ctx.page, 'pmode'), 'button').map(b => b.textContent), ['预览', '源码']);
});
