// Markdown 页内富文本渲染（view/markdown.mjs）与 preview.mjs 模式切换/相对图片/选中菜单集成测试。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChat } from '../view/chat.mjs';
import { renderMarkdown, resolveRelativePath, safeLinkTarget } from '../view/markdown.mjs';
import { mountPreview } from '../view/preview.mjs';
import { Element, loadFileApp, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { open } from './support/filepage.mjs';

async function withDom(t) {
  await open(t, { path: 'x.txt', files: {} });
}

const byTag = (root, tag) => root.find(n => n.tagName === tag.toUpperCase());
const byClass = (root, cls) => root.find(n => n.classList?.contains(cls));

test('resolveRelativePath：基于当前文件目录解析相对路径，拒绝越界、绝对路径、协议头与控制字符', () => {
  assert.equal(resolveRelativePath('docs/README.md', './diagram.png'), 'docs/diagram.png');
  assert.equal(resolveRelativePath('docs/README.md', '../assets/logo.png?v=1#top'), 'assets/logo.png');
  assert.equal(resolveRelativePath('README.md', 'img/a%20b.png'), 'img/a b.png');
  assert.equal(resolveRelativePath('docs/README.md', '../../secret.png'), null);
  assert.equal(resolveRelativePath('README.md', '../outside.png'), null);
  assert.equal(resolveRelativePath('docs/README.md', '/etc/passwd'), null);
  assert.equal(resolveRelativePath('docs/README.md', 'https://example.com/a.png'), null);
  assert.equal(resolveRelativePath('docs/README.md', 'javascript:alert(1)'), null);
  assert.equal(resolveRelativePath('docs/README.md', 'a\u0000b.png'), null);
});

test('safeLinkTarget：只放行 http/https/mailto、页内锚点与工作目录内相对路径，拒绝危险协议', () => {
  assert.deepEqual(safeLinkTarget('https://example.com/x', 'README.md'), { kind: 'external', href: 'https://example.com/x' });
  assert.deepEqual(safeLinkTarget('mailto:a@b.com', 'README.md'), { kind: 'external', href: 'mailto:a@b.com' });
  assert.deepEqual(safeLinkTarget('#section-1', 'README.md'), { kind: 'hash', href: '#section-1' });
  assert.deepEqual(safeLinkTarget('./guide.md', 'docs/README.md'), { kind: 'relative', path: 'docs/guide.md' });
  assert.equal(safeLinkTarget('javascript:alert(1)', 'README.md'), null);
  assert.equal(safeLinkTarget('data:text/html,<script>alert(1)</script>', 'README.md'), null);
  assert.equal(safeLinkTarget('file:///etc/passwd', 'README.md'), null);
  assert.equal(safeLinkTarget('../../outside.md', 'docs/README.md'), null);
});

test('renderMarkdown：支持 GFM 块级与行内语法，代码块复用语法高亮', async t => {
  await withDom(t);
  const src = [
    '# 主标题',
    '## 二级标题',
    '',
    '普通段落包含 **粗体**、*斜体*、~~删除线~~、`行内代码` 和 [外链](https://example.com)。',
    '',
    '> 引用第一行',
    '> 引用第二行',
    '',
    '- [x] 已完成任务',
    '- [ ] 待办任务',
    '',
    '3. 第三项',
    '4. 第四项',
    '',
    '| 列A | 列B |',
    '| :--- | ---: |',
    '| 左 | 右 |',
    '',
    '```js',
    'const n = 42;',
    '```',
    '',
    '---',
  ].join('\n');

  const md = renderMarkdown(src, { basePath: 'docs/README.md' });
  assert.equal(byTag(md, 'h1')[0]?.textContent, '主标题');
  assert.equal(byTag(md, 'h2')[0]?.textContent, '二级标题');
  assert.equal(byTag(md, 'strong')[0]?.textContent, '粗体');
  assert.equal(byTag(md, 'em')[0]?.textContent, '斜体');
  assert.equal(byTag(md, 'del')[0]?.textContent, '删除线');
  assert.equal(byClass(md, 'md-inline-code')[0]?.textContent, '行内代码');

  const link = byTag(md, 'a')[0];
  assert.equal(link.getAttribute('href'), 'https://example.com');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');

  assert.equal(byTag(md, 'blockquote').length, 1);
  const boxes = byTag(md, 'input');
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].getAttribute('checked'), '');
  assert.equal(boxes[1].getAttribute('checked'), null);
  assert.equal(boxes[0].getAttribute('disabled'), '');

  const ol = byTag(md, 'ol')[0];
  assert.equal(ol.getAttribute('start'), '3');
  assert.equal(byTag(md, 'table').length, 1);
  assert.equal(byTag(md, 'th')[1].getAttribute('style'), 'text-align:right');
  assert.equal(byTag(md, 'hr').length, 1);

  const code = byClass(md, 'md-code')[0];
  assert.ok(code, '渲染围栏代码块');
  assert.ok(code.find(n => n.classList?.contains('hljs-keyword')).length > 0, '代码块复用 highlight.js 高亮');
});

test('renderMarkdown：安全渲染——原始 HTML 当纯文本转义，危险链接降级，相对图片按边界校验加载', async t => {
  await withDom(t);
  const src = [
    '<script>alert(1)</script> <img src=x onerror=alert(2)>',
    '',
    '[点我](javascript:alert(3)) [数据](data:text/html,hi)',
    '',
    '![本地图](../assets/diagram.png)',
    '![越界图](../../secret.png)',
    '![坏协议](javascript:alert(4))',
  ].join('\n');

  const md = renderMarkdown(src, {
    basePath: 'docs/README.md',
    resolveImage: rel => `coda-view://service/media/tok1/${rel}`,
  });

  assert.equal(byTag(md, 'script').length, 0, '绝不生成 script 节点');
  assert.equal(byTag(md, 'a').length, 0, '危险协议链接不生成 a 标签');
  assert.ok(md.textContent.includes('<script>alert(1)</script>'), '原始 HTML 按纯文本显示');
  assert.ok(md.textContent.includes('点我'), '危险链接文字仍保留');

  const imgs = byTag(md, 'img');
  assert.equal(imgs.length, 1, '只有工作目录内合法相对图片生成 img');
  assert.equal(imgs[0].getAttribute('src'), 'coda-view://service/media/tok1/assets/diagram.png');
  assert.equal(imgs[0].getAttribute('alt'), '本地图');
  assert.equal(byClass(md, 'md-img-fallback').length, 2, '越界与坏协议图片降级为文字占位');
});

test('mountPreview：Markdown 默认进入「预览」模式，支持「预览 / 源码」切换与相对图片流式加载', async t => {
  await withDom(t);
  const el = new Element('div');
  const content = '# 标题\n\n![图](../assets/a b.png)\n';
  const data = Buffer.from(content).toString('base64');
  let mediaCalls = 0;
  const preview = mountPreview(el, {
    read: async () => ({ kind: 'text', data, offset: 0, size: Buffer.byteLength(content), mtimeMs: 100, eof: true }),
    copy: () => {},
    media: async () => { mediaCalls++; return { token: 'tok99', size: Buffer.byteLength(content), mtimeMs: 100 }; },
  });

  await preview.open('docs/README.md');
  await flush();

  assert.equal(mediaCalls, 1, '含图片时按需取一次流式服务口令');
  assert.equal(byClass(el, 'md').length, 1, '默认进入富文本预览');
  assert.equal(byTag(el, 'h1')[0]?.textContent, '标题');
  assert.equal(byTag(el, 'img')[0]?.getAttribute('src'), 'coda-view://service/media/tok99/assets/a%20b.png');
  assert.equal(preview.canFind, false, '预览模式不开启源码查找');

  const modeBar = byClass(el, 'pmode')[0];
  assert.equal(modeBar.hidden, false);
  const buttons = byTag(modeBar, 'button');
  assert.deepEqual(buttons.map(b => [b.textContent, b.getAttribute('aria-pressed')]), [
    ['预览', 'true'],
    ['源码', 'false'],
  ]);

  // 切换到「源码」模式
  buttons[1].dispatch('click');
  assert.equal(byClass(el, 'md').length, 0);
  assert.equal(byClass(el, 'code').length, 1, '切到源码显示带行号代码视图');
  assert.equal(byClass(el, 'text')[0]?.textContent, content);
  assert.equal(preview.canFind, true, '源码模式可查找');
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true');

  // 切回「预览」模式
  buttons[0].dispatch('click');
  assert.equal(byClass(el, 'md').length, 1);
  assert.equal(preview.canFind, false);
});

test('chat.selectionItems：Markdown 预览选区无行号时只提供「添加到聊天（内容）」和「复制」', () => {
  const chat = createChat({ link: { generation: 1, size: () => 10, call: async () => ({}) }, copy: () => {}, hint: { show: () => {} } });
  const mdItems = chat.selectionItems({ path: 'README.md', text: '选中一段文字' });
  assert.deepEqual(mdItems.map(i => i.label), ['添加到聊天（内容）', '复制']);

  const codeItems = chat.selectionItems({ path: 'README.md', text: 'line1', startLine: 1, endLine: 1 });
  assert.deepEqual(codeItems.map(i => i.label), ['添加到聊天（内容）', '添加到聊天（位置）', '复制']);
});

test('独立 file 视图打开 Markdown 也默认渲染富文本并支持切换源码', async t => {
  const page = await loadFileApp(t, {
    platform: 'mac',
    args: { session: 's1', path: 'README.md' },
    postMessage: message => {
      if (message.type === 'read') {
        const data = Buffer.from('# standalone\n');
        queueMicrotask(() => page.post({
          type: 'chunk', generation: message.generation, requestId: message.requestId,
          data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 100, kind: 'text', eof: true,
        }));
      }
    },
    on: () => {},
    copy: () => {},
    getState: () => undefined,
    setState: () => {},
    open: () => {},
  });
  page.post({ type: 'session', generation: 1, session: 's1' });
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/A' });
  await flush();

  assert.equal(visible(page.preview), true);
  assert.equal(byTag(page.preview, 'h1')[0]?.textContent, 'standalone');
  const sourceBtn = byClass(page.preview, 'pmode')[0].find(n => n.tagName === 'BUTTON' && n.textContent === '源码')[0];
  sourceBtn.dispatch('click');
  assert.equal(byClass(page.preview, 'text')[0]?.textContent, '# standalone\n');
});
