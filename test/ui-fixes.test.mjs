// 0.9.x 审查后的界面小修：「不预览」提示里的「在 Coda 中打开」、Markdown 预览里的查找、取图片口令失败时沿用旧口令、样式规则。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mountPreview } from '../view/preview.mjs';
import { Element, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { open as openFilePage, start } from './support/filepage.mjs';
import { cmd } from './support/finder.mjs';
import { installHighlights } from './support/highlights.mjs';
import { startPhone, startSearch } from './support/searchhost.mjs';

const byTag = (root, tag) => root.find(n => n.tagName === tag.toUpperCase());
const byClass = (root, cls) => root.find(n => n.classList?.contains(cls));
const onDoc = (key, modifiers = {}) => { let prevented = false; document.emit({ type: 'keydown', key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers, preventDefault() { prevented = true; }, target: null }); return { get prevented() { return prevented; } }; };
const savedInline = { v: 1, seq: 1, hidden: false, sort: 'name', view: 'list', openWith: { document: 'inline' }, sessions: {} };
const CODA_BUTTON = '在 Coda 中打开';
const codaButtons = page => page.preview.find(node => node.tagName === 'BUTTON' && node.textContent === CODA_BUTTON);

// ---- 「不预览」提示里的「在 Coda 中打开」 ----

test('Mac 侧栏：文档类被切成页内后，「二进制文件，不预览」提示里有按钮，点了交给 Coda', async t => {
  const ctx = await startSearch(t, { listing: { '': ['report.pdf', 'blob.dat'] }, state: savedInline });
  Object.assign(ctx.host, { autoRead: true, files: { 'report.pdf': '%PDF', 'blob.dat': 'BIN' }, kinds: { 'report.pdf': 'binary', 'blob.dat': 'binary' } });
  const open = async name => { const row = ctx.page.tree.find(n => n.classList.contains('row') && n.textContent.includes(name))[0]; row.dispatch('click'); row.dispatch('dblclick'); await flush(); };

  await open('blob.dat');
  assert.match(ctx.page.preview.textContent, /二进制文件，不预览。/);
  assert.equal(codaButtons(ctx.page).length, 0, 'Coda 不接的类型（流式服务不供应）没有按钮');
  ctx.page.preview.find(node => node.getAttribute('aria-label') === '返回')[0].dispatch('click');
  await flush();

  await open('report.pdf');
  assert.match(ctx.page.preview.textContent, /二进制文件，不预览。/);
  const [button] = codaButtons(ctx.page);
  assert.ok(button, '提示里有「在 Coda 中打开」');
  assert.equal(button.className, 'link', '复用已有的 button.link');
  button.dispatch('click');
  await flush();
  assert.deepEqual(ctx.host.calls.open, ['coda-view://service/media/tok/report.pdf'], '和行菜单的同名项一样：经流式服务交给 coda.open');
});

test('iPhone：不预览的提示里同样有「在 Coda 中打开」', async t => {
  const ctx = await startPhone(t, { listing: { '': ['report.pdf'] }, state: savedInline });
  Object.assign(ctx.host, { autoRead: true, files: { 'report.pdf': '%PDF' }, kinds: { 'report.pdf': 'binary' } });
  ctx.page.tree.find(n => n.classList.contains('row') && n.textContent.includes('report.pdf'))[0].dispatch('click');
  await flush();
  const [button] = codaButtons(ctx.page);
  assert.ok(button);
  button.dispatch('click');
  await flush();
  assert.deepEqual(ctx.host.calls.open, ['coda-view://service/media/tok/report.pdf']);
});

test('Mac 独立窗口：不预览的提示里有按钮，点了取口令后交给 coda.open；不能交给 Coda 的类型没有按钮', async t => {
  const opened = [];
  const ctx = await start(t, { path: 'report.pdf', files: { 'report.pdf': { kind: 'binary', text: '%PDF' }, 'blob.dat': { kind: 'binary', text: 'BIN' } }, coda: { open: url => { opened.push(url); return Promise.resolve(); } } });
  const [button] = codaButtons(ctx.page);
  assert.ok(button);
  assert.equal(button.className, 'link');
  button.dispatch('click');
  await flush();
  assert.deepEqual(opened, ['coda-view://service/media/tok/report.pdf']);

  const bin = await start(t, { path: 'blob.dat', files: { 'blob.dat': { kind: 'binary', text: 'BIN' } }, coda: { open: () => Promise.resolve() } });
  assert.match(bin.page.preview.textContent, /二进制文件，不预览。/);
  assert.equal(codaButtons(bin.page).length, 0);
});

// 独立窗口和资源页共用 external.mjs 的串行与作废：连点只开一次，换会话、根目录、文件时旧请求作废。
const windowWithPdfs = async (t, opened) => {
  const ctx = await start(t, { path: 'a.pdf', files: { 'a.pdf': { kind: 'binary', text: '%PDF-a' }, 'b.pdf': { kind: 'binary', text: '%PDF-b' } }, coda: { open: url => { opened.push(url); return Promise.resolve(); } } });
  ctx.host.holdMedia = true; // 取口令的回答由测试放行，就能在「等口令」期间做别的事
  return ctx;
};
const releaseAll = async host => { while (host.heldMedia.length > 0) host.releaseMedia(host.heldMedia.shift()); await flush(); };

test('Mac 独立窗口：连点两次「在 Coda 中打开」只打开一次', async t => {
  const opened = [];
  const { page, host } = await windowWithPdfs(t, opened);
  const [button] = codaButtons(page);
  button.dispatch('click');
  await flush();
  button.dispatch('click');
  await flush();
  await releaseAll(host);
  await releaseAll(host); // 第二次点击排在第一次之后，它的口令请求在第一次作废后才发出
  assert.deepEqual(opened, ['coda-view://service/media/tok/a.pdf']);
});

test('Mac 独立窗口：等口令期间从 a.pdf 切到 b.pdf，不会打开 a.pdf', async t => {
  const opened = [];
  const { page, host } = await windowWithPdfs(t, opened);
  codaButtons(page)[0].dispatch('click');
  await flush();
  assert.equal(host.heldMedia.length, 1);
  host.events.context({ args: { session: 's1', path: 'b.pdf' } });
  await flush();
  await releaseAll(host);
  assert.deepEqual(opened, [], '旧请求作废：a.pdf 没有打开，b.pdf 也没有被误开');
});

test('Mac 独立窗口：等口令期间换会话或根目录，旧请求作废，晚到的失败也不提示', async t => {
  for (const change of [host => host.start('/A'), host => host.start('/B')]) {
    const opened = [];
    const { page, host } = await windowWithPdfs(t, opened);
    codaButtons(page)[0].dispatch('click');
    await flush();
    change(host);
    await flush();
    await releaseAll(host);
    assert.deepEqual(opened, []);
    assert.equal(visible(page.hint), false, '作废的请求不弹提示');
  }
});

test('Mac 独立窗口：取口令或 coda.open 失败时在原地提示', async t => {
  const ctx = await start(t, { path: 'a.pdf', files: { 'a.pdf': { kind: 'binary', text: '%PDF' } }, coda: { open: () => Promise.reject(new Error('打不开了')) } });
  codaButtons(ctx.page)[0].dispatch('click');
  await flush();
  assert.match(ctx.page.hint.textContent, /打不开文件：打不开了/);
});

test('Mac 独立窗口：拿不到口令（宿主没有流式服务）时提示中文原因，不调 coda.open', async t => {
  const opened = [];
  const ctx = await start(t, { path: 'a.pdf', files: { 'a.pdf': { kind: 'binary', text: '%PDF' } }, coda: { open: url => { opened.push(url); return Promise.resolve(); } } });
  ctx.host.service = false; // media 回答的 token 是 null
  codaButtons(ctx.page)[0].dispatch('click');
  await flush();
  assert.equal(ctx.page.hint.textContent, '打不开文件：没有可用的本机服务');
  assert.deepEqual(opened, []);
});

// ---- 预览关闭后，它发起的「在 Coda 中打开」作废：之后失败也不能把预览弹回来 ----

async function failingOpen(ctx, name) {
  Object.assign(ctx.host, { autoRead: true, files: { [name]: '%PDF' }, kinds: { [name]: 'binary' } });
  let fail;
  ctx.host.openResult = () => new Promise((_, reject) => { fail = reject; });
  ctx.page.tree.find(n => n.classList.contains('row') && n.textContent.includes(name))[0].dispatch('dblclick');
  ctx.page.tree.find(n => n.classList.contains('row') && n.textContent.includes(name))[0].dispatch('click');
  await flush();
  assert.equal(visible(ctx.page.preview), true);
  codaButtons(ctx.page)[0].dispatch('click');
  await flush();
  assert.equal(ctx.host.calls.open.length, 1, 'coda.open 已经在途');
  return fail;
}

test('Mac 侧栏：点了「在 Coda 中打开」后关掉预览，迟到的失败不会让预览重新弹出', async t => {
  const ctx = await startSearch(t, { listing: { '': ['report.pdf'] }, state: savedInline });
  const fail = await failingOpen(ctx, 'report.pdf');
  ctx.page.preview.find(node => node.getAttribute('aria-label') === '返回')[0].dispatch('click');
  await flush();
  assert.equal(visible(ctx.page.preview), false);
  fail(new Error('打不开'));
  await flush();
  assert.equal(visible(ctx.page.preview), false, '已关闭的预览没有被迟到的失败弹回来');
  assert.equal(visible(ctx.page.tree), true);
});

test('iPhone：点了「在 Coda 中打开」后原生返回关掉预览，迟到的失败不会让预览重新弹出', async t => {
  const ctx = await startPhone(t, { listing: { '': ['report.pdf'] }, state: savedInline });
  const fail = await failingOpen(ctx, 'report.pdf');
  ctx.host.back(1);
  await flush();
  assert.equal(visible(ctx.page.preview), false);
  fail(new Error('打不开'));
  await flush();
  assert.equal(visible(ctx.page.preview), false, '已关闭的预览没有被迟到的失败弹回来');
});

test('Mac 侧栏：不关预览时失败照旧退回页内预览（预览仍在）', async t => {
  const ctx = await startSearch(t, { listing: { '': ['report.pdf'] }, state: savedInline });
  const fail = await failingOpen(ctx, 'report.pdf');
  fail(new Error('打不开'));
  await flush();
  assert.equal(visible(ctx.page.preview), true);
});

test('mountPreview：没传 canOpenInCoda 时不放按钮，传了才放，点了带上路径', async t => {
  await openFilePage(t, { path: 'x.txt', files: {} }); // 装好假 DOM
  const read = async () => ({ kind: 'binary', data: '', offset: 0, size: 4, mtimeMs: 1, eof: true });
  const plain = new Element('div');
  await mountPreview(plain, { read, copy: () => {} }).open('a.pdf');
  assert.equal(codaButtons({ preview: plain }).length, 0);
  const opened = [];
  const withIt = new Element('div');
  await mountPreview(withIt, { read, copy: () => {}, canOpenInCoda: path => path.endsWith('.pdf'), openInCoda: path => opened.push(path) }).open('docs/a.pdf');
  codaButtons({ preview: withIt })[0].dispatch('click');
  assert.deepEqual(opened, ['docs/a.pdf']);
});

// ---- ⌘F 在 Markdown 预览里 ----

const MD = '# 标题\n\n**foo** bar\n'; // 渲染后「foo bar」跨了 <strong> 和后面的文字；源码里是「**foo** bar」，找不到
const previewShown = page => byClass(page.preview, 'md').length === 1 && byClass(page.preview, 'text').length === 0;
const findBar = page => byClass(page.preview, 'fbar')[0];
// 在查找条里输入、等防抖，返回计数；每个入口都用它证明查找真的在渲染后的文字里找。
const findCount = (page, tick, term) => { const field = byClass(page.preview, 'finput')[0]; field.value = term; field.dispatch('input'); tick(150); return byClass(page.preview, 'fcount')[0].textContent; };

test('Mac 独立窗口：Markdown 预览里 ⌘F 留在预览并打开查找条，找得到渲染后的文字', async t => {
  installHighlights(t);
  const { page } = await start(t, { path: 'README.md', files: { 'README.md': { text: MD } } });
  assert.equal(byClass(page.preview, 'md').length, 1);
  document.activeElement = null;
  assert.equal(onDoc('f', cmd).prevented, true);
  assert.ok(previewShown(page), '没有切到源码');
  assert.equal(findBar(page).hidden, false);
  assert.equal(findCount(page, ms => t.mock.timers.tick(ms), 'foo bar'), '1/1');
});

test('Mac 侧栏：Markdown 预览里 ⌘F 留在预览并打开查找条，找得到渲染后的文字', async t => {
  installHighlights(t);
  const ctx = await startSearch(t, { listing: { '': ['README.md'] } });
  Object.assign(ctx.host, { autoRead: true, files: { 'README.md': MD } });
  const row = ctx.page.tree.find(n => n.classList.contains('row') && n.textContent.includes('README.md'))[0];
  row.dispatch('click'); row.dispatch('dblclick');
  await flush();
  assert.equal(byClass(ctx.page.preview, 'md').length, 1);
  document.activeElement = null;
  assert.equal(onDoc('f', cmd).prevented, true);
  assert.ok(previewShown(ctx.page), '没有切到源码');
  assert.equal(findBar(ctx.page).hidden, false);
  assert.equal(findCount(ctx.page, ctx.tick, 'foo bar'), '1/1');
});

test('iPhone：Markdown 预览的 ⋯ 菜单里有「查找」，点了留在预览并打开查找条，找得到渲染后的文字', async t => {
  installHighlights(t);
  const ctx = await startPhone(t, { listing: { '': ['README.md'] } });
  Object.assign(ctx.host, { autoRead: true, files: { 'README.md': MD } });
  ctx.page.tree.find(n => n.classList.contains('row') && n.textContent.includes('README.md'))[0].dispatch('click');
  await flush();
  assert.equal(byClass(ctx.page.preview, 'md').length, 1);
  ctx.page.preview.find(node => node.getAttribute('aria-label') === '更多')[0].dispatch('click');
  assert.deepEqual(ctx.page.menu.find(node => node.tagName === 'BUTTON').map(node => node.textContent), ['刷新', '查找', '复制路径']);
  ctx.page.menu.find(node => node.textContent === '查找')[0].dispatch('click');
  assert.ok(previewShown(ctx.page), '没有切到源码');
  assert.equal(findBar(ctx.page).hidden, false);
  assert.equal(findCount(ctx.page, ctx.tick, 'foo bar'), '1/1');
});

// ---- B6：刷新时取图片口令失败，沿用上一次的 ----

test('Markdown 静默刷新时取口令失败：已显示的图片沿用上一次的口令，不换成占位', async t => {
  await openFilePage(t, { path: 'x.txt', files: {} });
  const content = '![图](a.png)\n';
  let mtime = 100, grants = 0, failNext = false;
  const el = new Element('div');
  const preview = mountPreview(el, {
    read: async () => ({ kind: 'text', data: Buffer.from(content).toString('base64'), offset: 0, size: content.length, mtimeMs: mtime, eof: true }),
    copy: () => {},
    media: async () => { grants++; if (failNext) throw new Error('服务暂时不可用'); return { token: 'tok1', size: content.length, mtimeMs: mtime }; },
  });
  await preview.open('README.md');
  await flush();
  assert.equal(byTag(el, 'img')[0].getAttribute('src'), 'coda-view://service/media/tok1/a.png');

  mtime = 200; failNext = true; // 文件变了，同时取口令失败
  await preview.refresh();
  await flush();
  assert.equal(grants, 2, '刷新时确实又取了一次');
  assert.equal(byTag(el, 'img')[0]?.getAttribute('src'), 'coda-view://service/media/tok1/a.png', '沿用旧口令');
  assert.equal(byClass(el, 'md-img-fallback').length, 0, '没有占位');
});

// ---- 样式 ----

const css = readFileSync(new URL('../view/style.css', import.meta.url), 'utf8');
const rule = selector => { const line = css.split('\n').find(l => l.startsWith(`${selector} {`)); assert.ok(line, `没有这条规则：${selector}`); return line; };

test('样式：.md 不设宽度上限，随窗口变宽', () => {
  assert.doesNotMatch(rule('.md'), /max-width/);
  assert.doesNotMatch(css.split('\n').filter(l => /^\.md[ ,{]/.test(l)).join('\n'), /max-width:\s*\d+px/, '.md 下没有别的固定宽度上限（图片的 100% 除外）');
});

test('样式：iPhone 的 .md 底部不再叠加安全区，安全区归 .pbody', () => {
  assert.doesNotMatch(rule('.coda-ios .md'), /safe-bottom/);
  assert.match(rule('.coda-ios .preview:not(.info) .pbody'), /padding-bottom: var\(--safe-bottom\)/);
});

test('样式：Markdown 代码块和代码预览共用同一组高亮规则，不再各写一份', () => {
  const rules = css.split('\n').filter(l => /\.hljs-/.test(l) && /\{ color: var\(--hl-/.test(l));
  assert.ok(rules.length >= 14);
  for (const line of rules) assert.ok(line.startsWith(':is(.code .text, .md .md-code) .hljs-'), line.slice(0, 80));
  assert.doesNotMatch(css, /^\.md \.md-code \.hljs-/m);
  assert.doesNotMatch(css, /^\.code \.text \.hljs-/m);
});

test('样式：行内代码的圆角用主题变量，不写死', () => {
  assert.match(rule('.md .md-inline-code'), /border-radius: var\(--coda-radius, 6px\)/);
});

test('样式：iPhone 上 Markdown 代码块和代码预览同一字号', () => {
  assert.match(rule('.coda-ios .code, .coda-ios .md .md-code'), /font-size: \.8em/);
});
