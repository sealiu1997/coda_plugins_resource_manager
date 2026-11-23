// 预览的两个持有者和提交顺序（设计第 27.2 节）：读取代次持有读取和挂载，正文版本持有这份正文上的图片口令和图片回调；
// 渲染挂载成功之后才提交 lastResult、shown、模式、元信息；正文先挂载，口令之后补。用 Markdown 验。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPreview } from '../view/preview.mjs';
import { Element } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { open as openFilePage } from './support/filepage.mjs';
import { FIND_BATCH } from '../view/find.mjs';
import { installHighlights } from './support/highlights.mjs';

const byTag = (root, tag) => root.find(n => n.tagName === tag.toUpperCase());
const byClass = (root, cls) => root.find(n => n.classList?.contains(cls));
const img = el => byTag(el, 'img')[0];
const src = el => img(el)?.getAttribute('src') ?? null;
const metaOf = el => byClass(el, 'pmeta')[0].textContent;
const button = (el, label) => byTag(el, 'button').find(node => node.textContent === label);

// 一个 Markdown 预览：口令的请求排在 grants 里，测试自己决定什么时候给、给什么。
async function setup(t, { text = '# 标题\n\n![图](a.png)\n', name = 'README.md' } = {}) {
  await openFilePage(t, { path: 'x.txt', files: {} });
  const file = { text, mtimeMs: 100 };
  const grants = [];
  const el = new Element('div');
  const preview = mountPreview(el, {
    read: async () => ({ kind: 'text', data: Buffer.from(file.text).toString('base64'), offset: 0, size: Buffer.byteLength(file.text), mtimeMs: file.mtimeMs, eof: true }),
    copy: () => {},
    media: () => new Promise((resolve, reject) => grants.push({
      ok: token => resolve({ token, size: 1, mtimeMs: 1 }),
      fail: message => reject(new Error(message)),
    })),
  });
  await preview.open(name);
  await flush();
  return { el, preview, file, grants };
}

// 让 document.createElement 对这些标签抛错（模拟渲染中途出错）。
function breakTags(t, ...tags) {
  const real = document.createElement;
  const broken = new Set(tags);
  document.createElement = tag => { if (broken.has(tag)) throw new Error(`渲染出错：${tag}`); return real(tag); };
  const heal = () => { document.createElement = real; };
  t.after(heal);
  return { heal, set: (...next) => { broken.clear(); next.forEach(tag => broken.add(tag)); } };
}

test('口令还没到：正文已经显示，图片没有地址；口令到了才补上', async t => {
  const { el, grants } = await setup(t);
  assert.equal(byTag(el, 'h1')[0].textContent, '标题', '正文不等口令');
  assert.equal(grants.length, 1);
  assert.ok(img(el), '图片的位置占着');
  assert.equal(src(el), null, '地址还没有');
  grants[0].ok('tok1');
  await flush();
  assert.equal(src(el), 'coda-view://service/media/tok1/a.png');
});

test('代码块和行内代码里的 ![x](a.png) 不触发取口令', async t => {
  const { el, grants } = await setup(t, { text: '```md\n![x](a.png)\n```\n\n行内 `![y](b.png)` 也不算\n' });
  assert.equal(grants.length, 0);
  assert.equal(img(el), undefined);
  assert.match(el.textContent, /!\[x\]\(a\.png\)/);
});

test('没有本地图片（外链、越界）也不取口令', async t => {
  const { grants } = await setup(t, { text: '![远](https://example.com/a.png) ![出](../../x.png) ![文](notes.md)\n' });
  assert.equal(grants.length, 0);
});

test('口令失败：没有可沿用的就换成占位；有已显示过的就沿用上一次的口令', async t => {
  const first = await setup(t);
  first.grants[0].fail('超时');
  await flush();
  assert.equal(img(first.el), undefined, '没有可沿用的：换成占位');
  assert.equal(byClass(first.el, 'md-img-fallback').length, 1);
  assert.equal(byTag(first.el, 'h1')[0].textContent, '标题', '正文不受影响');

  const second = await setup(t);
  second.grants[0].ok('tokA');
  await flush();
  second.file.mtimeMs = 200; second.file.text += '\n追加一行\n'; // 文件变了，新正文里的图片要重新取口令
  await second.preview.refresh();
  await flush();
  assert.equal(second.grants.length, 2);
  assert.equal(src(second.el), null);
  second.grants[1].fail('超时');
  await flush();
  assert.equal(src(second.el), 'coda-view://service/media/tokA/a.png', '沿用上一次的口令');
  assert.equal(byClass(second.el, 'md-img-fallback').length, 0);
});

test('等口令时切模式：晚到的口令丢掉，也不记下；切回预览重新取', async t => {
  const { el, preview, grants } = await setup(t);
  button(el, '源码').dispatch('click');
  await flush();
  assert.equal(byClass(el, 'md').length, 0, '显示源码');
  grants[0].ok('late'); // 旧正文的口令
  await flush();
  assert.equal(grants.length, 1);
  button(el, '预览').dispatch('click');
  await flush();
  assert.equal(grants.length, 2, '旧口令没有记下，切回来重新取');
  assert.equal(src(el), null);
  grants[1].ok('second');
  await flush();
  assert.equal(src(el), 'coda-view://service/media/second/a.png');
  assert.equal(preview.path, 'README.md');
});

test('等口令时切模式再切回：更早的口令这时才到，不给新正文补地址', async t => {
  const { el, grants } = await setup(t);
  button(el, '源码').dispatch('click');
  button(el, '预览').dispatch('click');
  await flush();
  assert.equal(grants.length, 2);
  grants[0].ok('late');
  await flush();
  assert.equal(src(el), null, '旧正文的口令不属于这一份');
  grants[1].ok('second');
  await flush();
  assert.equal(src(el), 'coda-view://service/media/second/a.png');
});

test('等口令时换根目录（重载）：旧口令丢掉，新正文用自己的口令', async t => {
  const { el, preview, grants } = await setup(t);
  preview.reload();
  await flush();
  assert.equal(grants.length, 2);
  grants[0].ok('oldroot');
  await flush();
  assert.equal(src(el), null);
  grants[1].ok('newroot');
  await flush();
  assert.equal(src(el), 'coda-view://service/media/newroot/a.png');
});

test('口令在途时刷新读到「没变」：正文不换，原来的图片照常补上地址', async t => {
  const { el, preview, grants } = await setup(t);
  const before = img(el);
  await preview.refresh();
  await flush();
  assert.equal(grants.length, 1, '没变不重新取');
  grants[0].ok('tok1');
  await flush();
  assert.equal(img(el), before, '还是同一份正文里的图片');
  assert.equal(src(el), 'coda-view://service/media/tok1/a.png');
});

test('口令在途时刷新读到新内容：旧口令丢掉，新正文再取', async t => {
  const { el, file, preview, grants } = await setup(t);
  file.mtimeMs = 200; file.text += '\n追加\n';
  await preview.refresh();
  await flush();
  assert.equal(grants.length, 2);
  grants[0].ok('late');
  await flush();
  assert.equal(src(el), null);
  grants[1].ok('tok2');
  await flush();
  assert.equal(src(el), 'coda-view://service/media/tok2/a.png');
});

test('图片晚到的失败回调：属于当前正文才换占位，旧正文的忽略', async t => {
  const { el, file, preview, grants } = await setup(t);
  grants[0].ok('tok1');
  await flush();
  const old = img(el), oldBox = old.parent;
  file.mtimeMs = 200; file.text += '\n追加\n';
  await preview.refresh();
  await flush();
  grants[1].ok('tok1');
  await flush();
  assert.notEqual(img(el), old);
  old.dispatch('error');
  assert.equal(old.parent, oldBox, '旧图片还在旧包装里');
  assert.equal(byClass(oldBox, 'md-img-fallback').length, 0, '旧包装里没有新增占位');
  assert.ok(img(el), '新正文的图片不受影响');
  assert.equal(byClass(el, 'md-img-fallback').length, 0);
  img(el).dispatch('error');
  assert.equal(img(el), undefined);
  assert.equal(byClass(el, 'md-img-fallback').length, 1, '当前正文的图片出错：换占位');
});

test('渲染抛错：退回源码并提示，旧正文不和新状态混用，按钮和显示一致', async t => {
  const { el, file, preview } = await setup(t, { text: '# 旧\n' });
  assert.equal(byTag(el, 'h1')[0].textContent, '旧');
  const broken = breakTags(t, 'h1');
  file.text = '# 新\n'; file.mtimeMs = 200;
  await preview.refresh();
  await flush();
  assert.equal(byClass(el, 'md').length, 0, '显示源码');
  assert.match(byTag(el, 'pre').map(n => n.textContent).join(''), /# 新/);
  assert.match(metaOf(el), /预览出错，改显示源码/);
  const modes = byClass(el, 'pmode')[0];
  assert.deepEqual(byTag(modes, 'button').map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['预览', 'false'], ['源码', 'true']]);
  await preview.refresh(); // 源码挂载成功后已提交：同一份内容读到「没变」
  assert.match(metaOf(el), /预览出错/, '没变就不动');
  broken.heal();
  button(el, '预览').dispatch('click'); // 再点「预览」就是重试
  await flush();
  assert.equal(byTag(el, 'h1')[0].textContent, '新');
  assert.doesNotMatch(metaOf(el), /预览出错/);
});

test('渲染（含源码退路）抛错：旧画面和旧状态原样留着，提示失败；下一次刷新照常重读', async t => {
  const { el, file, preview } = await setup(t, { text: '# 旧\n' });
  const broken = breakTags(t, 'h1', 'pre');
  file.text = '# 新\n'; file.mtimeMs = 200;
  await preview.refresh();
  await flush();
  assert.equal(byTag(el, 'h1')[0].textContent, '旧', '旧正文还在');
  assert.match(metaOf(el), /更新失败/);
  assert.equal(byClass(el, 'md').length, 1);
  broken.heal();
  await preview.refresh(); // 没有提交过新的 shown，所以不会被判成「没变」
  await flush();
  assert.equal(byTag(el, 'h1')[0].textContent, '新');
  assert.doesNotMatch(metaOf(el), /更新失败/);
});

test('首次打开渲染抛错：退回源码，之后再读也正常', async t => {
  await openFilePage(t, { path: 'x.txt', files: {} });
  const broken = breakTags(t, 'h1');
  const text = '# 标题\n';
  const el = new Element('div');
  const preview = mountPreview(el, {
    read: async () => ({ kind: 'text', data: Buffer.from(text).toString('base64'), offset: 0, size: Buffer.byteLength(text), mtimeMs: 1, eof: true }),
    copy: () => {},
  });
  await preview.open('a.md');
  await flush();
  assert.match(byTag(el, 'pre').map(n => n.textContent).join(''), /# 标题/);
  broken.heal();
  await preview.reload();
  await flush();
  assert.equal(byTag(el, 'h1')[0].textContent, '标题', '重载回到预览');
});

test('iPhone 返回：stop 之后、release 之前口令才到，画面不变；release 才清掉', async t => {
  const { el, preview, grants } = await setup(t);
  preview.stop();
  assert.equal(byTag(el, 'h1')[0].textContent, '标题', '退场画面保留原样');
  grants[0].ok('late');
  await flush();
  assert.equal(src(el), null, '晚到的口令不再改画面');
  const old = img(el);
  old.dispatch('error');
  assert.ok(img(el), '图片回调也作废了');
  preview.release();
  assert.equal(byClass(el, 'md').length, 0);
});

test('关闭：close 之后晚到的口令不改画面，也不抛错', async t => {
  const { el, preview, grants } = await setup(t);
  preview.close();
  grants[0].ok('late');
  await flush();
  assert.equal(byClass(el, 'md').length, 0);
});

test('挂载抛错（旧画面留着）：图片回调和排着的查找批次用的是同一个版本，都还有效', async t => {
  const env = installHighlights(t);
  const { el, file, preview, grants } = await setup(t, { text: `![图](a.png)\n\n${`${'a '.repeat(10)}\n`.repeat((FIND_BATCH * 2 + 50) / 10)}` });
  grants[0].ok('tok1');
  await flush();
  const queue = new Map(); // 批间的 setTimeout(0) 攥在手里，测试自己放行
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  let id = 4_000_000;
  globalThis.setTimeout = (fn, ms, ...args) => { if (ms !== 0) return realSet(fn, ms, ...args); queue.set(++id, fn); return id; };
  globalThis.clearTimeout = handle => { if (queue.delete(handle)) return; realClear(handle); };
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });
  preview.openFind();
  const input = byClass(el, 'finput')[0];
  input.value = 'a';
  input.dispatch('input');
  t.mock.timers.tick(150); // 防抖（页面的假时钟）
  const marks = env.registry.get('find');
  assert.equal(marks.size, FIND_BATCH);
  assert.equal(queue.size, 1);

  const pbody = byClass(el, 'pbody')[0], real = pbody.replaceChildren;
  pbody.replaceChildren = () => { throw new Error('挂载失败'); }; // 预览和源码都挂不上
  file.text += '\n追加\n'; file.mtimeMs = 200;
  await preview.refresh();
  await flush();
  pbody.replaceChildren = real;
  assert.match(metaOf(el), /更新失败/);

  img(el).dispatch('error');
  assert.equal(img(el), undefined, '图片回调还属于当前正文');
  while (queue.size) { const [[handle, fn]] = queue; queue.delete(handle); fn(); }
  assert.ok(marks.size > FIND_BATCH, '查找批次也还属于当前正文');
});
