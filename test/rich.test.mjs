// 富文本共用策略（view/rich.mjs）：URL 表、相对路径校验、图片包装、锚点跳转。Markdown 和以后的 HTML 走同一处。
import assert from 'node:assert/strict';
import test from 'node:test';
import { h } from '../view/dom.mjs';
import { renderMarkdown } from '../view/markdown.mjs';
import { mountPreview } from '../view/preview.mjs';
import { MAX_IMAGES, classifyImage, createImageBudget, dataImageSize, renderImage, renderLink, resolveRelativePath, safeLinkTarget } from '../view/rich.mjs';
import { Element, loadFileApp } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { open } from './support/filepage.mjs';

const withDom = t => open(t, { path: 'x.txt', files: {} });
const byTag = (root, tag) => root.find(n => n.tagName === tag.toUpperCase());
const byClass = (root, cls) => root.find(n => n.classList?.contains(cls));
const textNodes = root => {
  const out = [];
  const walk = node => { if (typeof node.data === 'string') out.push(node); else node.children?.forEach(walk); };
  walk(root);
  return out;
};

test('URL 表（链接）：http/https 不分大小写、交出解析后的地址；http:foo、危险协议只留文字', () => {
  assert.deepEqual(safeLinkTarget('HTTPS://Example.com/a', 'README.md'), { kind: 'external', href: 'https://example.com/a' });
  assert.deepEqual(safeLinkTarget('http://example.com', 'README.md'), { kind: 'external', href: 'http://example.com/' });
  for (const bad of ['http:foo', 'https:foo', 'http:/foo', 'https://', 'http://:80', 'javascript:alert(1)', 'JavaScript:alert(1)', 'vbscript:x', 'file:///etc/passwd', 'data:text/html,hi', 'data:image/png;base64,AAAA', '']) {
    assert.equal(safeLinkTarget(bad, 'README.md'), null, bad);
  }
  assert.deepEqual(safeLinkTarget('mailto:a@b.com?subject=x', 'README.md'), { kind: 'mailto', email: 'a@b.com', href: 'mailto:a@b.com?subject=x' });
  assert.equal(safeLinkTarget('mailto:', 'README.md'), null);
  assert.deepEqual(safeLinkTarget('#Sec%201', 'README.md'), { kind: 'hash', href: '#Sec%201', fragment: 'Sec%201' }, '#片段返回原始片段，由调用方去查');
  assert.deepEqual(safeLinkTarget('#', 'README.md'), { kind: 'hash', href: '#', fragment: '' });
});

test('相对路径校验：逐行覆盖（第 27.3 节的 6 步）', () => {
  const at = target => resolveRelativePath('docs/sub/README.md', target);
  assert.equal(at('a.md'), 'docs/sub/a.md');
  assert.equal(at('./a'), 'docs/sub/a');
  assert.equal(at('../a'), 'docs/a');
  assert.equal(at('../../a'), 'a');
  assert.equal(at('../../../a'), null, '越出工作目录');
  assert.equal(at('a/../../../../b'), null, '中途越出');
  assert.equal(at('a.md?x=1#top'), 'docs/sub/a.md', '? 和 # 之后的丢掉');
  assert.equal(at('?q'), null, '只有查询串');
  assert.equal(at('#x'), null);
  assert.equal(at('/a'), null);
  assert.equal(at('//host/a'), null);
  assert.equal(at('\\a'), null);
  assert.equal(at('C:\\a'), null, '带协议头');
  assert.equal(at('file:a.png'), null);
  assert.equal(at('a%2Fb'), null, '解码后含 /');
  assert.equal(at('a%2fb'), null);
  assert.equal(at('%5C'), null, '解码后是 \\');
  assert.equal(at('a%5Cb'), null);
  assert.equal(at('a\\b'), null, '字面的 \\ 也拒绝');
  assert.equal(at('%2e%2e/a'), null, '解码后才变成点段');
  assert.equal(at('%2e/a'), null);
  assert.equal(at('a%00b'), null, '解码后含控制字符');
  assert.equal(at('a%0Ab'), null);
  assert.equal(at('a\u0000b'), null);
  assert.equal(at('%E0%A4%A'), null, '解码失败');
  assert.equal(at('a%20b/c%E4%B8%AD.png'), 'docs/sub/a b/c中.png', '每段单独解码一次');
  assert.equal(at('a%252Fb'), 'docs/sub/a%2Fb', '只解码一次');
  assert.equal(at('a//b/./c'), 'docs/sub/a/b/c');
  assert.equal(at('./'), 'docs/sub', '指向所在目录');
  assert.equal(resolveRelativePath('README.md', './'), null, '合并后为空');
  assert.equal(at(`${'a/'.repeat(2100)}b`), null, '过 splitRelative：超过 MAX_PATH');
  assert.equal(at('a'.repeat(140 * 1024)), null);
  assert.equal(resolveRelativePath('README.md', 'x.md'), 'x.md');
});

test('URL 表（图片）：只有图片扩展名的相对路径才显示，非图片不调 resolveImage、不发请求', () => {
  const requested = [];
  const resolve = rel => { requested.push(rel); return `svc/${rel}`; };
  assert.deepEqual(classifyImage('a.png', 'docs/R.md', resolve), { kind: 'local', path: 'docs/a.png', src: 'svc/docs/a.png' });
  assert.deepEqual(classifyImage('./A.PNG?v=1', 'docs/R.md', resolve), { kind: 'local', path: 'docs/A.PNG', src: 'svc/docs/A.PNG' });
  for (const skipped of ['a.txt', 'a', 'a.md', 'a.mp4', 'a.glb']) {
    assert.deepEqual(classifyImage(skipped, 'docs/R.md', resolve), { kind: 'invalid', skipped: true }, `${skipped}：基线里是 <img>，收紧后出占位`);
  }
  for (const bad of ['../../a.png', '/a.png', '//h/a.png', 'a%2Fb.png', 'javascript:x', 'data:image/png;base64,AAAA', 'mailto:a@b.c', '#x', 'http:foo.png']) {
    assert.deepEqual(classifyImage(bad, 'docs/R.md', resolve), { kind: 'invalid' }, bad);
  }
  assert.deepEqual(classifyImage('HTTPS://Example.com/a.png', 'R.md', resolve), { kind: 'remote', url: 'https://example.com/a.png' });
  assert.deepEqual(classifyImage('a.png', 'R.md', null), { kind: 'invalid' }, '没有流式地址');
  assert.deepEqual(requested, ['docs/a.png', 'docs/A.PNG'], '只有放行的才调 resolveImage');
});

const pngOf = (width, height) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...Buffer.from('IHDR'), width >>> 24, (width >> 16) & 255, (width >> 8) & 255, width & 255, height >>> 24, (height >> 16) & 255, (height >> 8) & 255, height & 255, 8, 6, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
const dataPng = (width, height) => `data:image/png;base64,${pngOf(width, height)}`;

test('URL 表（图片）：data: 位图只有给了预算才放行，先去掉所有空白再整串校验；读头部取宽高，按像素预算放行', () => {
  const url = dataPng(30, 20);
  assert.deepEqual(classifyImage(url, 'R.md', null), { kind: 'invalid' }, '不给预算一律按 invalid');
  const budget = createImageBudget();
  assert.deepEqual(classifyImage(url, 'R.md', null, budget), { kind: 'data', src: url, width: 30, height: 20 });
  const folded = `  data:image/PNG;base64,\n${pngOf(3, 4).slice(0, 8)}\r\n\t${pngOf(3, 4).slice(8)}  `;
  assert.deepEqual(classifyImage(folded, 'R.md', null, budget), { kind: 'data', src: `data:image/PNG;base64,${pngOf(3, 4)}`, width: 3, height: 4 });
  for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'data:image/png,AAAA', 'data:image/png;base64,AAAA', `${url}!`, `data:image/png;base64,${pngOf(0, 4)}`, 'data:', 'DATA:image/gif;base64,@@@@']) {
    assert.deepEqual(classifyImage(bad, 'R.md', null, budget), { kind: 'invalid' }, bad);
  }
  assert.equal(dataImageSize(pngOf(7, 8)).width, 7);
  assert.equal(dataImageSize('!!!'), null, '不是 base64');
  assert.equal(budget.images, 2);
  assert.equal(budget.pixels, 30 * 20 + 12);
});

test('URL 表（图片）：data: 位图的像素预算——单张超过 1600 万、整页累计超过 6400 万的按 invalid，不计入累计；每页最多 200 张', () => {
  const budget = createImageBudget();
  const kinds = [dataPng(4000, 4000), dataPng(4001, 4000), dataPng(4000, 4000), dataPng(4000, 4000), dataPng(4000, 4000), dataPng(1, 1)].map(url => classifyImage(url, 'R.md', null, budget).kind);
  assert.deepEqual(kinds, ['data', 'invalid', 'data', 'data', 'data', 'invalid']);
  assert.equal(budget.pixels, 64_000_000);
  const counted = createImageBudget();
  const resolve = rel => rel;
  const results = Array.from({ length: MAX_IMAGES + 2 }, (_, index) => classifyImage(index % 2 ? dataPng(1, 1) : `a${index}.png`, 'R.md', resolve, counted).kind);
  assert.equal(results.filter(kind => kind !== 'invalid').length, MAX_IMAGES, '本地图和 data: 图合计 200 张');
  assert.deepEqual(results.slice(-2), ['invalid', 'invalid']);
  assert.equal(classifyImage('a.txt', 'R.md', resolve, counted).skipped, true, '非图片不受 200 张的限制');
  assert.equal(classifyImage('https://example.com/a.png', 'R.md', resolve, counted).kind, 'remote', '外链图片只出占位，不占名额');
});

test('Markdown：data: 位图按 URL 表放行（Markdown 和 HTML 共用同一张表），带 loading="lazy"、decoding="async"；非位图和读不出头部的出占位', async t => {
  await withDom(t);
  const md = renderMarkdown(`![点](${dataPng(2, 2)}) ![坏](data:image/png;base64,AAAA) ![页](data:text/html;base64,PGI+) ![图](a.png)`, { basePath: 'R.md', resolveImage: rel => `svc/${rel}` });
  const images = byTag(md, 'img');
  assert.deepEqual(images.map(img => img.getAttribute('src')), [dataPng(2, 2), 'svc/a.png']);
  assert.deepEqual(images.map(img => [img.getAttribute('loading'), img.getAttribute('decoding'), img.getAttribute('draggable')]), [['lazy', 'async', 'false'], ['lazy', 'async', 'false']]);
  assert.deepEqual(byClass(md, 'md-img-fallback').map(n => n.textContent), ['[图片：坏]', '[图片：页]']);
  const locals = [];
  renderMarkdown(`![点](${dataPng(2, 2)}) ![图](a.png)`, { basePath: 'R.md', resolveImage: rel => rel, onLocalImage: entry => locals.push(entry.path) });
  assert.deepEqual(locals, ['a.png'], 'data: 图不进本地图片清单');
  const big = renderMarkdown(Array.from({ length: MAX_IMAGES + 1 }, (_, index) => `![i${index}](a${index}.png)`).join(' '), { basePath: 'R.md', resolveImage: rel => rel });
  assert.equal(byTag(big, 'img').length, MAX_IMAGES);
  assert.equal(byClass(big, 'md-img-fallback')[0].textContent, `[图片：i${MAX_IMAGES}]`);
});

test('图片包装：data: 图加载失败同样只在包装里面换成占位', async t => {
  await withDom(t);
  const box = renderImage({ kind: 'data', src: dataPng(1, 1) }, '点', '', () => true);
  assert.equal(box.className, 'md-img-box');
  byTag(box, 'img')[0].dispatch('error');
  assert.equal(byTag(box, 'img').length, 0);
  assert.equal(box.textContent, '[图片：点]');
});

test('Markdown：相对图片 .png 放行，.txt 出占位且不取地址', async t => {
  await withDom(t);
  const requested = [];
  const md = renderMarkdown('![图](a.png) ![文](a.txt) ![无](a)', { basePath: 'R.md', resolveImage: rel => { requested.push(rel); return `svc/${rel}`; } });
  assert.deepEqual(byTag(md, 'img').map(img => img.getAttribute('src')), ['svc/a.png']);
  assert.deepEqual(byClass(md, 'md-img-fallback').map(n => n.textContent), ['[图片：文]', '[图片：无]']);
  assert.deepEqual(requested, ['a.png']);
});

test('Markdown：http:foo 只留文字，HTTPS://Example.com/a 交给 coda.open 的是解析后的地址', async t => {
  await withDom(t);
  const opened = [];
  const md = renderMarkdown('[坏](http:foo) [好](HTTPS://Example.com/a)', { basePath: 'R.md', onOpenExternal: url => opened.push(url) });
  const links = byTag(md, 'a');
  assert.deepEqual(links.map(a => a.textContent), ['好']);
  assert.equal(links[0].getAttribute('href'), 'https://example.com/a');
  links[0].dispatch('click');
  assert.deepEqual(opened, ['https://example.com/a']);
  assert.match(md.textContent, /坏/);
});

test('约 140 KiB 的相对链接（预览层）：只留文字，点击之后没有读取、口令请求和交给宿主的动作', async t => {
  await withDom(t);
  const calls = { read: 0, media: 0, copy: [], external: [], relative: [], email: [], open: [] };
  const content = `# 标题\n\n[长](${'a'.repeat(140 * 1024)}.md)\n`;
  const data = Buffer.from(content).toString('base64');
  const el = new Element('div');
  const preview = mountPreview(el, {
    read: async () => { calls.read++; return { kind: 'text', data, offset: 0, size: Buffer.byteLength(content), mtimeMs: 1, eof: true }; },
    copy: text => calls.copy.push(text),
    media: async () => { calls.media++; return { token: 'tok', size: 1, mtimeMs: 1 }; },
    openExternal: url => calls.external.push(url),
    openRelative: path => calls.relative.push(path),
    copyEmail: email => calls.email.push(email),
    canOpenInCoda: () => true,
    openInCoda: path => calls.open.push(path),
  });
  await preview.open('docs/README.md');
  await flush();
  const md = byClass(el, 'md')[0];
  assert.deepEqual(byTag(md, 'a'), [], '没有链接');
  assert.deepEqual(byClass(md, 'md-rel-link'), []);
  assert.equal(byTag(md, 'p')[0].textContent, '长', '文字照旧显示');
  const readsBefore = calls.read;
  for (const p of byTag(md, 'p')) p.dispatch('click');
  await flush();
  assert.equal(calls.read, readsBefore, '点击之后没有新的读取');
  const requested = [];
  const image = renderMarkdown(`![长图](${'b'.repeat(140 * 1024)}.png)`, { basePath: 'R.md', resolveImage: rel => { requested.push(rel); return rel; } });
  assert.deepEqual([byTag(image, 'img').length, requested.length, byClass(image, 'md-img-fallback')[0].textContent], [0, 0, '[图片：长图]'], '过长的图片地址出占位，不取地址');
  assert.deepEqual([calls.media, calls.copy, calls.external, calls.relative, calls.email, calls.open], [0, [], [], [], [], []], '没有口令请求，也没有交给宿主的动作');
});

test('renderLink：链接包着很多节点时分批挂标签（append 的参数个数有上限）', async t => {
  await withDom(t);
  const labels = () => Array.from({ length: 200_000 }, () => document.createTextNode('x'));
  const [link] = renderLink(labels(), { kind: 'external', href: 'https://example.com/' }, '', {});
  assert.equal(link.children.length, 200_000);
  const [wrap] = renderLink(labels(), { kind: 'mailto', email: 'a@b.c', href: 'mailto:a@b.c' }, '', {});
  assert.equal(byClass(wrap, 'md-mailto-label')[0].children.length, 200_000);
});

test('图片包装：失败占位加在包装里面，已有文本节点原样不动；旧正文的 error 回调被忽略', async t => {
  await withDom(t);
  let version = 1;
  const md = renderMarkdown('前文 ![封面](a.png) 后文\n\n![另一张](b.png)', { basePath: 'R.md', resolveImage: rel => `svc/${rel}`, isCurrent: () => version === 1 });
  const boxes = byClass(md, 'md-img-box');
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].children[0].tagName, 'IMG');
  assert.equal(boxes[0].getAttribute('data-rich-ui'), null, '包装本身是正文的一部分');
  const before = textNodes(md);
  const textBefore = md.textContent;

  boxes[0].children[0].dispatch('error');
  assert.equal(boxes[0].find(n => n.getAttribute('data-rich-ui') === '').length, 1, '占位在包装里面，带 data-rich-ui');
  assert.equal(byClass(boxes[0], 'md-img-fallback')[0].textContent, '[图片：封面]');
  assert.equal(boxes[0].parent, byTag(md, 'p')[0], '包装还在原处');
  const after = textNodes(md);
  assert.ok(before.every(node => after.includes(node)), '已有的文本节点一个不少、还是原来的节点');
  assert.equal(md.textContent, textBefore.replace('前文  后文', '前文 [图片：封面] 后文'), '正文文字只多了占位');

  version = 2;
  boxes[1].children[0].dispatch('error');
  assert.equal(byTag(boxes[1], 'img').length, 1, '旧正文的 error 回调被忽略：不加占位');
  assert.equal(byClass(boxes[1], 'md-img-fallback').length, 0);
});

test('标题 ID：ID 在建标题时定下，之后图片失败不改；占位的字照旧计入', async t => {
  await withDom(t);
  const md = renderMarkdown('# 安装 ![状态](a.png)\n\n# 安装 ![状态](https://example.com/b.png)\n\n[上](#安装) [下](#安装-外链图片状态)', { basePath: 'R.md', resolveImage: rel => `svc/${rel}` });
  const [first, second] = md.find(n => n.tagName === 'H1');
  assert.equal(first.getAttribute('id'), 'md-安装', '能显示的图片不带字');
  assert.equal(second.getAttribute('id'), 'md-安装-外链图片状态', '基线里就有的占位，字计入 ID');
  byTag(md, 'img')[0].dispatch('error');
  assert.equal(first.getAttribute('id'), 'md-安装', '失败占位出现后 ID 不变');
  const scrolled = [];
  for (const el of [first, second]) el.scrollIntoView = () => scrolled.push(el.getAttribute('id'));
  const links = byTag(md, 'a');
  links[0].dispatch('click');
  links[1].dispatch('click');
  assert.deepEqual(scrolled, ['md-安装', 'md-安装-外链图片状态']);
});

test('锚点：先取消默认导航；查到了就一层层展开遮住它的 details 再滚动，查不到什么也不做', async t => {
  await withDom(t);
  const target = h('h2', {}, '目标');
  const inner = h('details', {}, h('summary', {}, '内'), target);
  const outer = h('details', {}, h('summary', {}, '外'), inner);
  const visibleTarget = h('h2', {}, '看得见');
  const scrolled = [];
  target.scrollIntoView = () => scrolled.push(['target', outer.getAttribute('open'), inner.getAttribute('open')]);
  visibleTarget.scrollIntoView = () => scrolled.push(['visible']);
  const known = new Map([['t', target], ['v', visibleTarget]]);
  const handlers = { lookupAnchor: fragment => known.get(fragment) ?? null };
  const click = fragment => {
    const [a] = renderLink(['x'], safeLinkTarget(`#${fragment}`, 'R.md'), '', handlers);
    let prevented = 0;
    a.dispatch('click', { preventDefault() { prevented++; } });
    return prevented;
  };
  assert.equal(click('missing'), 1, '查不到也取消默认导航');
  assert.deepEqual(scrolled, []);
  assert.equal(outer.getAttribute('open'), null);
  assert.equal(click('t'), 1);
  assert.deepEqual(scrolled, [['target', '', '']], '外层、里层都展开之后才滚动');
  assert.equal(click('v'), 1);
  assert.deepEqual(scrolled.at(-1), ['visible']);
});

test('约 140 KiB 的相对链接（独立窗口）：点击之后没有新的宿主消息、没有 coda.open、没有写状态', async t => {
  const sent = [], opened = [], saved = [], copied = [];
  const doc = `# 首页\n\n[长](${'a'.repeat(140 * 1024)}.md) [外](http:foo) [好](./guide.md)\n`;
  const page = await loadFileApp(t, {
    platform: 'mac',
    args: { session: 's1', path: 'README.md' },
    postMessage: message => {
      sent.push(message.type);
      if (message.type === 'read') {
        const data = Buffer.from(doc);
        queueMicrotask(() => page.post({
          type: 'chunk', generation: message.generation, requestId: message.requestId,
          data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 100, kind: 'text', eof: true,
        }));
      }
    },
    on: () => {},
    copy: text => { copied.push(text); },
    getState: () => undefined,
    setState: state => { saved.push(state); },
    open: target => { opened.push(target); return Promise.resolve(); },
  });
  page.post({ type: 'session', generation: 1, session: 's1' });
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/A' });
  await flush();
  const links = byTag(page.preview, 'a');
  assert.deepEqual(links.map(a => a.textContent), ['好'], '只有合法的相对链接是链接');

  const baseline = [sent.length, opened.length, saved.length, copied.length];
  for (const p of byTag(page.preview, 'p')) p.dispatch('click');
  await flush();
  assert.deepEqual([sent.length, opened.length, saved.length, copied.length], baseline, '点击文字之后没有宿主消息、没有 coda.open、没有写状态、没有复制');
});

test('标题 ID：收紧新产生的占位（非图片扩展名的相对「图片」）不计入，ID 和基线一致', async t => {
  await withDom(t);
  const md = renderMarkdown('# 安装 ![状态](badge.txt)\n\n# 安装\n\n[跳到安装](#安装)', { basePath: 'R.md', resolveImage: rel => `svc/${rel}` });
  const [first, second] = md.find(n => n.tagName === 'H1');
  assert.equal(byClass(first, 'md-img-fallback')[0].textContent, '[图片：状态]', '照样出占位');
  assert.deepEqual([first.getAttribute('id'), second.getAttribute('id')], ['md-安装', 'md-安装-1']);
  const scrolled = [];
  for (const el of [first, second]) el.scrollIntoView = () => scrolled.push(el);
  byTag(md, 'a')[0].dispatch('click');
  assert.deepEqual(scrolled, [first], '跳到第一个标题');
});
