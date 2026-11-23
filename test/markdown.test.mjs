// Markdown 页内富文本渲染（view/markdown.mjs）与 preview.mjs 模式切换/相对图片/选中菜单集成测试。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChat } from '../view/chat.mjs';
import { renderMarkdown, resolveRelativePath, safeLinkTarget } from '../view/markdown.mjs';
import { mountPreview } from '../view/preview.mjs';
import { clippedRichSelection } from '../view/selection.mjs';
import { Element, loadFileApp, visible } from './support/dom.mjs';
import { flush } from './support/fake.mjs';
import { open } from './support/filepage.mjs';
import { fakeSelection } from './support/selection.mjs';

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
  assert.deepEqual(safeLinkTarget('mailto:a@b.com', 'README.md'), { kind: 'mailto', email: 'a@b.com', href: 'mailto:a@b.com' });
  assert.deepEqual(safeLinkTarget('#section-1', 'README.md'), { kind: 'hash', href: '#section-1', id: 'md-section-1' });
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
  assert.equal(link.getAttribute('target'), null, '不使用沙箱禁止的 target=_blank');

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
  assert.equal(preview.canFind, true, '预览模式下查找入口可用，打开时切到源码');

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

  // 切回「预览」模式：查找条还开着时仍可查找
  buttons[0].dispatch('click');
  assert.equal(byClass(el, 'md').length, 1);
});

test('mountPreview：Markdown 预览里 openFind 自动切到「源码」并打开查找条，非 Markdown 预览不受影响', async t => {
  await withDom(t);
  const el = new Element('div');
  const content = '# 标题\n\n正文\n';
  const data = Buffer.from(content).toString('base64');
  const preview = mountPreview(el, {
    read: async () => ({ kind: 'text', data, offset: 0, size: Buffer.byteLength(content), mtimeMs: 100, eof: true }),
    copy: () => {},
  });
  assert.equal(preview.canFind, false, '没打开文件：没有查找');
  assert.equal(preview.openFind(), false);

  await preview.open('docs/README.md');
  await flush();
  assert.equal(byClass(el, 'md').length, 1);
  assert.equal(preview.findOpen, false);
  assert.equal(preview.canFind, true);

  assert.equal(preview.openFind(), true);
  assert.equal(byClass(el, 'md').length, 0, '已切到源码');
  assert.equal(byClass(el, 'text')[0]?.textContent, content);
  assert.equal(preview.findOpen, true, '查找条已打开');
  const pressed = byTag(byClass(el, 'pmode')[0], 'button').map(b => b.getAttribute('aria-pressed'));
  assert.deepEqual(pressed, ['false', 'true'], '模式条跟着切到「源码」');

  // 读不到文件的页面不能查找
  const broken = mountPreview(new Element('div'), { read: async () => { throw Object.assign(new Error('坏了'), { code: 'io' }); }, copy: () => {} });
  await broken.open('docs/README.md');
  await flush();
  assert.equal(broken.canFind, false);
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

test('Setext 标题、有序列表任务清单与引用式相对图片/链接回归', async t => {
  await withDom(t);
  const src = [
    '主标题',
    '=====',
    '',
    '副标题',
    '-----',
    '',
    '1. [x] Done',
    '2. [ ] Todo',
    '',
    '![Logo][logo] ![Bad][bad] [官网][site]',
    '',
    '[logo]: assets/logo.png "图标"',
    '[bad]: ../../secret.png',
    '[site]: https://example.com',
  ].join('\n');

  const md = renderMarkdown(src, {
    basePath: 'README.md',
    resolveImage: rel => `coda-view://service/media/tok1/${rel}`,
  });

  assert.equal(byTag(md, 'h1')[0]?.textContent, '主标题');
  assert.equal(byTag(md, 'h2')[0]?.textContent, '副标题');
  assert.equal(byTag(md, 'ol').length, 1);
  const boxes = byTag(md, 'input');
  assert.equal(boxes.length, 2, '有序列表任务清单应渲染复选框');
  assert.equal(boxes[0].getAttribute('checked'), '');
  assert.equal(boxes[1].getAttribute('checked'), null);

  const imgs = byTag(md, 'img');
  assert.equal(imgs.length, 1, '合法引用式相对图片应生成 img，越界引用图片应降级');
  assert.equal(imgs[0].getAttribute('src'), 'coda-view://service/media/tok1/assets/logo.png');
  assert.equal(imgs[0].getAttribute('alt'), 'Logo');
  assert.equal(byClass(md, 'md-img-fallback').length, 1);

  const link = byTag(md, 'a')[0];
  assert.equal(link?.getAttribute('href'), 'https://example.com');
  assert.equal(link?.textContent, '官网');
  assert.equal(md.textContent.includes('[logo]:'), false, '引用定义行不应显示在正文中');
});

test('引用定义块级语义回归：保留列表内围栏代码与段落续行，并支持引用块内图片与定义', async t => {
  await withDom(t);
  const src = [
    '- ```text',
    '  [example]: example.txt',
    '  ```',
    '',
    'See the following',
    '[example]: example.txt',
    '',
    '> ![Quoted][q]',
    '>',
    '> [q]: assets/quoted.png',
  ].join('\n');

  const md = renderMarkdown(src, {
    basePath: 'README.md',
    resolveImage: rel => `coda-view://service/media/tok1/${rel}`,
  });

  const code = byClass(md, 'md-code')[0];
  assert.equal(code?.textContent, '[example]: example.txt', '列表内围栏代码块不得被引用定义吞掉');

  const para = byTag(md, 'p').find(p => p.textContent.includes('See the following'));
  assert.equal(para?.textContent, 'See the following\n[example]: example.txt', '段落续行不得被引用定义吞掉');

  const bq = byTag(md, 'blockquote')[0];
  const img = byTag(bq, 'img')[0];
  assert.equal(img?.getAttribute('src'), 'coda-view://service/media/tok1/assets/quoted.png', '引用块内定义与图片应正常渲染');
  assert.equal(img?.getAttribute('alt'), 'Quoted');
  assert.equal(bq.textContent.includes('[q]:'), false, '引用块内的定义行不显示为字面文本');
});

test('读取失败/换根后清除 Markdown 缓存并隐藏切换栏，不会恢复旧正文', async t => {
  const roots = {
    '/A': { 'README.md': '# 根A正文\n' },
    '/B': {},
  };
  let currentRoot = '/A';
  const page = await loadFileApp(t, {
    platform: 'mac',
    args: { session: 's1', path: 'README.md' },
    postMessage: message => {
      if (message.type === 'read') {
        const text = roots[currentRoot]?.[message.path];
        queueMicrotask(() => {
          if (text === undefined) {
            page.post({ type: 'chunk', generation: message.generation, requestId: message.requestId, error: { code: 'not_found', message: '没有这个文件' } });
          } else {
            const data = Buffer.from(text);
            page.post({
              type: 'chunk', generation: message.generation, requestId: message.requestId,
              data: data.toString('base64'), offset: 0, size: data.length, mtimeMs: 100, kind: 'text', eof: true,
            });
          }
        });
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

  assert.equal(byTag(page.preview, 'h1')[0]?.textContent, '根A正文');
  const modeBar = byClass(page.preview, 'pmode')[0];
  assert.equal(modeBar.hidden, false);
  const sourceBtn = modeBar.find(n => n.tagName === 'BUTTON' && n.textContent === '源码')[0];

  // 切到缺少同名文件的根 B
  currentRoot = '/B';
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/B' });
  await flush();

  assert.match(page.preview.textContent, /文件已不存在/);
  assert.equal(modeBar.hidden, true, '读取失败后切换栏必须隐藏');
  // 即使点击之前拿在手里的源码按钮，也绝不能恢复根 A 的旧正文
  sourceBtn.dispatch('click');
  await flush();
  assert.equal(page.preview.textContent.includes('根A正文'), false, '绝不能恢复旧正文');
  assert.match(page.preview.textContent, /文件已不存在/);
});

test('富文本右键复制和添加到聊天保留跨块换行与 <br> 换行', async t => {
  await withDom(t);
  const el = new Element('div');
  const content = '# 安装\n\n运行命令\n\n第一行  \n第二行\n';
  const data = Buffer.from(content).toString('base64');
  const added = [], copied = [];
  const chat = createChat({
    link: { generation: 1, size: () => 10, call: async (_type, fields) => { added.push(fields); return {}; } },
    copy: text => { copied.push(text); },
    hint: { show: () => {} },
  });
  let menuItems = null;
  const preview = mountPreview(el, {
    read: async () => ({ kind: 'text', data, offset: 0, size: Buffer.byteLength(content), mtimeMs: 100, eof: true }),
    copy: () => {},
    selectionMenu: (_event, selection) => { menuItems = chat.selectionItems(selection); },
  });

  await preview.open('README.md');
  await flush();

  const sel = fakeSelection(t, el);
  const md = byClass(el, 'md')[0];
  // md.textContent 为 '安装运行命令第一行第二行'：0-6 跨选 h1「安装」与 p「运行命令」
  sel.select(md, 0, 6);

  // 验证 clippedRichSelection 保留跨块换行
  assert.equal(clippedRichSelection(md)?.text, '安装\n运行命令');

  // 验证右键菜单的「添加到聊天（内容）」和「复制」都收到带换行的文字
  md.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  assert.deepEqual(menuItems?.map(i => i.label), ['添加到聊天（内容）', '复制']);
  await menuItems[0].run();
  menuItems[1].run();
  assert.deepEqual(added, [{ text: '安装\n运行命令', block: true }]);
  assert.deepEqual(copied, ['安装\n运行命令']);

  // 验证 <br> 硬换行也保留换行（6-12 对应「第一行」<br>「第二行」）
  sel.select(md, 6, 12);
  assert.equal(clippedRichSelection(md)?.text, '第一行\n第二行');
});

test('表格空单元格选区、ATX # C#、全名围栏高亮、列表后顶层定义、任务文本保留、外链/相对/锚点/远程图片与后台刷新失败切模式回归', async t => {
  await withDom(t);

  // 1. # C# 保留、全名 javascript / python 围栏高亮、列表内标题和未闭合围栏后无空行的顶层引用定义、任务清单保留 1. 与 >
  const src = [
    '# C#',
    '## Title ###',
    '',
    '![Logo][logo]',
    '',
    '- # Assets',
    '[logo]: assets/logo.png',
    '',
    '![After][after]',
    '',
    '- ```text',
    '  unclosed',
    '[after]: assets/after.png',
    '',
    '- [x] 1. Install dependencies',
    '- [ ] > 80% coverage',
    '- [x] [example]: example.txt',
    '',
    '  More details',
    '',
    '```javascript',
    'const a = 1;',
    '```',
    '',
    '```python',
    'def foo(): return 1',
    '```',
    '',
    '[外链](https://example.com) <https://auto.example> [相对](./other.md) [跳标题](#c)',
    '',
    '![远程](https://example.com/pic.png)',
    '',
    '| 左 |  | 右 |',
    '| --- | --- | --- |',
    '| A |  | B |',
  ].join('\n');

  const extOpened = [], relOpened = [];
  let scrolledId = null;
  const md = renderMarkdown(src, {
    basePath: 'docs/README.md',
    resolveImage: rel => `coda-view://service/media/tok1/${rel}`,
    onOpenExternal: url => extOpened.push(url),
    onOpenRelative: p => relOpened.push(p),
  });

  assert.equal(byTag(md, 'h1')[0]?.textContent, 'C#', '# C# 必须保留尾随 #');
  assert.equal(byTag(md, 'h1')[0]?.getAttribute('id'), 'md-c');
  assert.equal(byTag(md, 'h2')[0]?.textContent, 'Title', '空白分隔的闭合 ### 去掉');

  // 两个顶层引用定义均生效
  const imgs = byTag(md, 'img');
  assert.deepEqual(imgs.map(i => i.getAttribute('src')), [
    'coda-view://service/media/tok1/docs/assets/logo.png',
    'coda-view://service/media/tok1/docs/assets/after.png',
  ]);
  // 远程图片降级为占位而非 img
  assert.ok(byClass(md, 'md-img-fallback').some(n => n.textContent === '[外链图片：远程]'));

  // 任务清单保留 1.、> 与 [example]:，不生成嵌套 ol / blockquote 或被当成引用定义删除
  const tasks = byClass(md, 'md-task');
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].textContent, '1. Install dependencies');
  assert.equal(byTag(tasks[0], 'ol').length, 0);
  assert.equal(tasks[1].textContent, '> 80% coverage');
  assert.equal(byTag(tasks[1], 'blockquote').length, 0);
  assert.ok(tasks[2].textContent.includes('[example]: example.txt'), '任务首行形似引用定义的正文必须保留');
  assert.ok(tasks[2].textContent.includes('More details'), '任务项后续缩进段落必须保留');

  // javascript 和 python 全名围栏均高亮
  const codes = byClass(md, 'md-code');
  const jsCode = codes.find(c => c.textContent.includes('const a = 1;'));
  const pyCode = codes.find(c => c.textContent.includes('def foo()'));
  assert.ok(jsCode.find(n => n.classList?.contains('hljs-keyword')).length > 0, 'javascript 全名高亮');
  assert.ok(pyCode.find(n => n.classList?.contains('hljs-keyword')).length > 0, 'python 全名高亮');

  // 外链、自动链接、相对链接与锚点跳转
  const links = byTag(md, 'a');
  for (const a of links) assert.equal(a.getAttribute('target'), null);
  links.find(a => a.textContent === '外链').dispatch('click');
  links.find(a => a.textContent === 'https://auto.example').dispatch('click');
  links.find(a => a.textContent === '相对').dispatch('click');
  assert.deepEqual(extOpened, ['https://example.com', 'https://auto.example']);
  assert.deepEqual(relOpened, ['docs/other.md']);
  byTag(md, 'h1')[0].scrollIntoView = () => { scrolledId = byTag(md, 'h1')[0].getAttribute('id'); };
  links.find(a => a.textContent === '跳标题').dispatch('click');
  assert.equal(scrolledId, 'md-c');

  // 2. 跨空单元格表格选区：| 左 |  | 右 | → '左\t\t右'
  const table = byTag(md, 'table')[0];
  const sel = fakeSelection(t, md);
  const start = md.textContent.indexOf('左右');
  sel.select(md, start, start + 2);
  assert.equal(clippedRichSelection(md)?.text, '左\t\t右', '跨越空单元格必须保留两个制表符');
  assert.ok(table);

  // 3. 后台刷新失败后切到「源码」仍保留失败提示与重试入口
  const el = new Element('div');
  const docText = '# 初始\n';
  let failNext = false;
  const preview = mountPreview(el, {
    read: async () => {
      if (failNext) throw Object.assign(new Error('磁盘忙'), { code: 'io_error' });
      return { kind: 'text', data: Buffer.from(docText).toString('base64'), offset: 0, size: Buffer.byteLength(docText), mtimeMs: 100, eof: true };
    },
    copy: () => {},
  });
  await preview.open('README.md');
  await flush();
  failNext = true;
  await preview.refresh();
  await flush();
  const meta = byClass(el, 'pmeta')[0];
  const retry = el.find(n => n.tagName === 'BUTTON' && n.textContent === '重试')[0];
  assert.match(meta.textContent, /更新失败：磁盘忙/);
  assert.equal(retry.hidden, false);

  const sourceBtn = byClass(el, 'pmode')[0].find(n => n.tagName === 'BUTTON' && n.textContent === '源码')[0];
  sourceBtn.dispatch('click');
  assert.match(meta.textContent, /更新失败：磁盘忙/, '切到源码后仍应保留后台刷新失败提示');
  assert.equal(retry.hidden, false, '切到源码后仍应保留重试入口');
});

test('列表续行（无缩进与缩进两格）不被误收为引用定义，也不脱离列表', async t => {
  await withDom(t);
  const src1 = '- Accepted values:\n[mode]: auto\n\nSee [mode].';
  const md1 = renderMarkdown(src1, { basePath: 'README.md' });
  assert.equal(byTag(md1, 'li')[0]?.textContent, 'Accepted values:\n[mode]: auto', '无缩进的形似引用定义行作为开放段落续行留在列表内');
  assert.equal(byTag(md1, 'a').length, 0, '[mode] 不应被误收集为引用定义');

  const src2 = '- Accepted values:\n  [mode]: auto\nmore text';
  const md2 = renderMarkdown(src2, { basePath: 'README.md' });
  assert.equal(byTag(md2, 'li').length, 1);
  assert.equal(byTag(md2, 'li')[0]?.textContent, 'Accepted values:\n[mode]: auto\nmore text', '缩进两格后再接无缩进续行仍留在同一列表项');
  assert.equal(byTag(md2, 'p').length, 0, '续行不得脱离列表成为独立段落');

  // 列表内表格后的顶层引用定义不被吞进表格或列表
  const src3 = '- Table:\n\n  A | B\n  --- | ---\n  x | y\n[guide]: guide.md "Setup | Guide"\n\nSee [guide].';
  const md3 = renderMarkdown(src3, { basePath: 'README.md' });
  assert.equal(byTag(md3, 'tbody')[0].children.length, 1, '表格只应包含数据行 x | y，不吞入引用定义');
  const guideLink3 = byTag(md3, 'a').find(a => a.textContent === 'guide');
  assert.equal(guideLink3?.getAttribute('data-rel-path'), 'guide.md', '列表内表格后的顶层引用定义应生效');

  // 列表内 Setext 标题后的顶层引用定义与顶层段落均不被吞入列表
  const src4 = '- Heading\n  ===\n[guide]: guide.md\nTop-level paragraph.\n\nSee [guide].';
  const md4 = renderMarkdown(src4, { basePath: 'README.md' });
  assert.equal(byTag(md4, 'li')[0]?.textContent, 'Heading');
  assert.ok(byTag(md4, 'p').some(p => p.textContent === 'Top-level paragraph.'), '顶层段落不得被吞入列表');
  const guideLink4 = byTag(md4, 'a').find(a => a.textContent === 'guide');
  assert.equal(guideLink4?.getAttribute('data-rel-path'), 'guide.md', 'Setext 标题后的顶层引用定义应生效');

  // 嵌套列表的无缩进段落续行留在最内层 li，不被移到外层 ul 之外
  const src5 = '- Outer\n  - Inner\n    first detail\ncontinued detail';
  const md5 = renderMarkdown(src5, { basePath: 'README.md' });
  assert.deepEqual(md5.children.map(n => n.tagName), ['UL'], '外层容器只应有顶层 ul，不得在外层 ul 后生成独立 p');
  const uls5 = byTag(md5, 'ul');
  assert.equal(uls5.length, 2, '应保留外层与内层两级 ul');
  assert.equal(byTag(uls5[1], 'li')[0]?.textContent, 'Inner\nfirst detail\ncontinued detail', '无缩进续行应保留在内层 li 中');
});

test('独立文件窗口：相对链接经 coda.open 新开 file 视图、mailto 提供可见「复制邮箱」按钮、外链失败显示原因', async t => {
  const opened = [], copied = [];
  const doc = '# 首页\n\n[指南](./guide.md) [联系](mailto:a@example.com) [外链](https://example.com)\n';
  const page = await loadFileApp(t, {
    platform: 'mac',
    args: { session: 's1', path: 'README.md' },
    postMessage: message => {
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
    setState: () => {},
    open: target => {
      opened.push(target);
      if (typeof target === 'string') return Promise.reject(new Error('禁止打开外链'));
      return Promise.resolve();
    },
  });
  page.post({ type: 'session', generation: 1, session: 's1' });
  page.post({ type: 'root', generation: 1, state: 'ready', path: '/A' });
  await flush();

  const links = byTag(page.preview, 'a');
  links.find(a => a.textContent === '指南').dispatch('click');
  await flush();
  assert.deepEqual(opened, [{ view: 'file', args: { session: 's1', path: 'guide.md' } }], '独立窗口相对链接应经 coda.open 打开新 file 视图');
  assert.equal(byTag(page.preview, 'h1')[0]?.textContent, '首页', '原窗口仍保留 README.md 不被覆盖');

  assert.equal(links.some(a => a.getAttribute('href')?.startsWith('mailto:')), false, '不渲染为普通 mailto 跳转链接');
  const copyBtn = byClass(page.preview, 'md-copy-email')[0];
  assert.equal(copyBtn?.textContent, '复制邮箱', '点按前提供明确可识别的「复制邮箱」按钮');
  copyBtn.dispatch('click');
  await flush();
  assert.deepEqual(copied, ['a@example.com'], '点「复制邮箱」应复制纯邮箱地址而不调 coda.open');
  assert.equal(opened.length, 1);
  assert.equal(page.hint.textContent, '已复制邮箱');

  links.find(a => a.textContent === '外链').dispatch('click');
  await flush();
  assert.equal(opened.at(-1), 'https://example.com');
  assert.match(page.hint.textContent, /打不开链接：禁止打开外链/, '外链打开失败应给出明确原因');
});

test('复制邮箱按钮不影响标题锚点，且富文本选区跳过按钮文案并保持字符偏移准确', async t => {
  await withDom(t);
  const src = '# [Contact](mailto:a@example.com)\n\n[Go](#contact)\n\n前文 [联系](mailto:a@example.com) 后文\n';
  const md = renderMarkdown(src, { basePath: 'README.md' });
  const h1 = byTag(md, 'h1')[0];
  assert.equal(h1.getAttribute('id'), 'md-contact', '标题锚点 ID 不得混入「复制邮箱」按钮文案');
  assert.equal(byClass(h1, 'md-copy-email').length, 1, '标题内的可见「复制邮箱」按钮仍保留');

  let scrolled = false;
  h1.scrollIntoView = () => { scrolled = true; };
  byTag(md, 'a').find(a => a.textContent === 'Go').dispatch('click');
  assert.equal(scrolled, true, '点击 #contact 应正确滚动到标题');

  const p = byTag(md, 'p').find(node => node.textContent.includes('前文'));
  const sel = fakeSelection(t, p);
  sel.select(p, 0, p.textContent.length);
  assert.equal(clippedRichSelection(p)?.text, '前文 联系 后文', '整句选区不得混入「复制邮箱」');

  const afterStart = p.textContent.indexOf('后文');
  sel.select(p, afterStart, afterStart + 2);
  assert.equal(clippedRichSelection(p)?.text, '后文', '按钮之后的选区字符偏移必须准确');

  const btnStart = p.textContent.indexOf('复制邮箱');
  sel.select(p, btnStart, btnStart + 4);
  assert.equal(clippedRichSelection(p), null, '只选中按钮文案时不应产出正文选区');

  // 经 preview 真实右键菜单验证复制/添加到聊天收到的正文不含按钮文案
  const el = new Element('div');
  const added = [], copied = [];
  const chat = createChat({
    link: { generation: 1, size: () => 10, call: async (_type, fields) => { added.push(fields); return {}; } },
    copy: text => { copied.push(text); },
    hint: { show: () => {} },
  });
  let menuItems = null;
  const preview = mountPreview(el, {
    read: async () => ({ kind: 'text', data: Buffer.from(src).toString('base64'), offset: 0, size: Buffer.byteLength(src), mtimeMs: 100, eof: true }),
    copy: () => {},
    selectionMenu: (_event, selection) => { menuItems = chat.selectionItems(selection); },
  });
  await preview.open('README.md');
  await flush();
  const mdEl = byClass(el, 'md')[0];
  const fullSel = fakeSelection(t, el);
  const start = mdEl.textContent.indexOf('前文');
  const end = mdEl.textContent.indexOf('后文') + 2;
  fullSel.select(mdEl, start, end);
  mdEl.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  assert.deepEqual(menuItems?.map(i => i.label), ['添加到聊天（内容）', '复制']);
  await menuItems[0].run();
  menuItems[1].run();
  assert.deepEqual(added, [{ text: '前文 联系 后文', block: true }], '添加到聊天不得混入「复制邮箱」');
  assert.deepEqual(copied, ['前文 联系 后文'], '右键复制不得混入「复制邮箱」');
});

// ---- 0.9.7 解析与渲染修正 ----

// 渲染并返回耗时（毫秒）。
function timed(src) {
  const start = performance.now();
  const md = renderMarkdown(src, { basePath: 'README.md' });
  return { md, ms: performance.now() - start };
}

test('性能：嵌套列表后接大量无缩进续行时整体接近线性（10 层 × 1000 行、单层 × 8000 行各 < 200 ms）', async t => {
  await withDom(t);
  const nest = (depth, rows) => [
    ...Array.from({ length: depth }, (_, k) => `${'  '.repeat(k)}- 第${k}层`),
    ...Array.from({ length: rows }, (_, k) => `续行 ${k}`),
  ].join('\n');

  // 先跑一个小规模的哨兵：旧解析在这里要 1.4 秒，回退时在此处断言失败，而不是在大规模用例上卡住
  const canary = timed(nest(2, 500));
  assert.ok(canary.ms < 200, `2 层嵌套 + 500 行续行应在 200 ms 内，实际 ${canary.ms.toFixed(0)} ms`);

  const deep = timed(nest(10, 1000));
  assert.ok(deep.ms < 200, `10 层嵌套 + 1000 行续行应在 200 ms 内，实际 ${deep.ms.toFixed(0)} ms`);
  assert.equal(byTag(deep.md, 'ul').length, 10, '10 层列表结构不变');
  const innermost = byTag(deep.md, 'li').at(-1);
  assert.ok(innermost.textContent.startsWith('第9层\n续行 0\n') && innermost.textContent.endsWith('续行 999'), '续行全部留在最内层列表项里');

  const flat = timed(nest(1, 8000));
  assert.ok(flat.ms < 200, `单层 + 8000 行续行应在 200 ms 内，实际 ${flat.ms.toFixed(0)} ms`);
  assert.equal(byTag(flat.md, 'li').length, 1);
  assert.ok(byTag(flat.md, 'li')[0].textContent.endsWith('续行 7999'));

  // 缩进行与无缩进续行交替、列表项里带表格或围栏时，续行归属判断保持不变
  const mixed = timed(['- 项', ...Array.from({ length: 2000 }, (_, k) => `  缩进 ${k}\n续行 ${k}`)].join('\n'));
  assert.ok(mixed.ms < 400, `交替缩进与续行应保持线性，实际 ${mixed.ms.toFixed(0)} ms`);
  assert.equal(byTag(mixed.md, 'li').length, 1);

  const afterFence = renderMarkdown('- a\n  ```\n  code\n  ```\nlazy after fence', { basePath: 'README.md' });
  assert.equal(byClass(byTag(afterFence, 'li')[0], 'md-code')[0].textContent, 'code');
  assert.equal(byTag(afterFence, 'li')[0].textContent.includes('lazy'), false, '围栏结束后的无缩进行不属于列表项');
  assert.equal(afterFence.children.at(-1).textContent, 'lazy after fence');
});

test('行首 Tab 按 4 列制表位展开：Tab 缩进的嵌套列表正确嵌套，围栏里的 Tab 原样保留', async t => {
  await withDom(t);
  const md = renderMarkdown('- a\n\t- b\n\t- c\n- d', { basePath: 'README.md' });
  const outer = byTag(md, 'ul')[0];
  assert.equal(outer.children.length, 2, '外层只有 a 和 d 两项');
  const inner = byTag(outer.children[0], 'ul')[0];
  assert.deepEqual(inner.children.map(li => li.textContent), ['b', 'c'], 'b、c 嵌套在 a 下');
  assert.equal(outer.children[1].textContent, 'd');

  const mixed = renderMarkdown('1. a\n  \t- b\n    - c', { basePath: 'README.md' });
  assert.deepEqual(byTag(mixed, 'ul').map(ul => ul.children.length), [2], '2 空格 + Tab 展开到 4 列，与 4 空格缩进同级');

  const fenced = renderMarkdown('```go\nfunc main() {\n\tprintln(1)\n}\n```', { basePath: 'README.md' });
  assert.equal(byClass(fenced, 'md-code')[0].textContent, 'func main() {\n\tprintln(1)\n}', '围栏代码里的 Tab 不展开');
});

test('松散列表：条目之间的空行不拆列表，仍是同一个 ol / ul', async t => {
  await withDom(t);
  const ol = renderMarkdown('1. a\n\n1. b\n\n1. c', { basePath: 'README.md' });
  assert.equal(byTag(ol, 'ol').length, 1);
  assert.deepEqual(byTag(ol, 'li').map(li => li.textContent), ['a', 'b', 'c']);

  const ul = renderMarkdown('- a\n\n- b', { basePath: 'README.md' });
  assert.equal(byTag(ul, 'ul').length, 1);
  assert.deepEqual(byTag(ul, 'li').map(li => li.textContent), ['a', 'b']);

  const multi = renderMarkdown('- a\n\n\n- b\n  - n1\n\n  - n2\n\n- c', { basePath: 'README.md' });
  assert.equal(byTag(multi, 'ul').length, 2, '多个空行与嵌套松散列表也不拆');
  assert.deepEqual(byTag(multi, 'ul')[0].children.map(li => li.children[0]?.textContent ?? li.textContent).length, 3);

  const split = renderMarkdown('- a\n\n1. b\n\n* * *\n\n- c', { basePath: 'README.md' });
  assert.deepEqual(split.children.map(n => n.tagName), ['UL', 'OL', 'HR', 'UL'], '不同类列表、分隔线仍然各自独立');
  const rule = renderMarkdown('- a\n\n- - -\n\n- b', { basePath: 'README.md' });
  assert.deepEqual(rule.children.map(n => n.tagName), ['UL', 'HR', 'UL'], '空行后的「- - -」是分隔线而不是列表项');
});

test('缩进代码块：空行或文档开头后 4 列缩进的连续行按代码块渲染，列表项内的缩进内容不误判', async t => {
  await withDom(t);
  const md = renderMarkdown('说明：\n\n    npm install\n\n      --flag\n\n后文', { basePath: 'README.md' });
  assert.deepEqual(md.children.map(n => n.tagName), ['P', 'PRE', 'P']);
  const code = byClass(md, 'md-code')[0];
  assert.equal(code.textContent, 'npm install\n\n  --flag', '保留相对缩进与块内空行，去掉前 4 列');
  assert.equal(byTag(code, 'code').length, 1, '与围栏代码块同样的 pre.md-code > code 结构');

  const first = renderMarkdown('    first line code\n\npara', { basePath: 'README.md' });
  assert.equal(byClass(first, 'md-code')[0]?.textContent, 'first line code', '文档开头的缩进行也是代码块');

  const tab = renderMarkdown('x\n\n\tfoo\n\t\tbar', { basePath: 'README.md' });
  assert.equal(byClass(tab, 'md-code')[0]?.textContent, 'foo\n\tbar', 'Tab 缩进同样识别，去掉前 4 列后其余 Tab 原样保留');

  const para = renderMarkdown('段落\n    仍是续行', { basePath: 'README.md' });
  assert.equal(byClass(para, 'md-code').length, 0, '没有空行隔开时不是代码块');
  assert.equal(byTag(para, 'p')[0].textContent, '段落\n    仍是续行');

  const inItem = renderMarkdown('- a\n    - b\n\n- c\n\n  继续段落\n\n      列表内代码', { basePath: 'README.md' });
  assert.equal(byClass(inItem, 'md-code').length, 1, '只有列表项内相对缩进够深的才是代码');
  assert.equal(byClass(inItem, 'md-code')[0].textContent, '列表内代码');
  assert.deepEqual(byTag(inItem, 'ul')[0].children.length, 2);
  assert.deepEqual(byTag(inItem, 'ul')[1].children.map(li => li.textContent), ['b'], '嵌套列表项 b 不被当成代码');

  const fenceFirst = renderMarkdown('```\n\n    inside fence\n```', { basePath: 'README.md' });
  assert.equal(byClass(fenceFirst, 'md-code').length, 1);
  assert.equal(byClass(fenceFirst, 'md-code')[0].textContent, '\n    inside fence');
});

test('README 杂项：HTML 注释丢弃（代码里不受影响）、开头 front matter 按代码块显示、<br> 转换行', async t => {
  await withDom(t);
  const src = [
    '前文 <!-- 行内注释 --> 后文',
    '',
    '<!-- 单行注释 -->',
    '',
    '<!--',
    '跨行注释',
    '-->',
    '',
    '段落一',
    '<!-- 紧跟的注释 -->',
    '段落二',
    '',
    '```html',
    '<!-- 围栏里保留 -->',
    '```',
    '',
    '`<!-- 行内代码里保留 -->`',
  ].join('\n');
  const md = renderMarkdown(src, { basePath: 'README.md' });
  const text = md.textContent;
  assert.ok(!text.includes('行内注释') && !text.includes('单行注释') && !text.includes('跨行注释') && !text.includes('紧跟的注释'));
  assert.equal(byTag(md, 'p')[0].textContent, '前文  后文');
  assert.equal(byTag(md, 'p').filter(p => p.textContent.trim() === '').length, 0, '纯注释不留下空段落');
  assert.deepEqual(byTag(md, 'p').slice(1, 3).map(p => p.textContent), ['段落一', '段落二'], '整行注释把前后文字分成两段，注释本身不显示');
  assert.equal(byClass(md, 'md-code')[0].textContent, '<!-- 围栏里保留 -->');
  assert.equal(byClass(md, 'md-inline-code')[0].textContent, '<!-- 行内代码里保留 -->');

  const front = renderMarkdown('---\ntitle: 示例\ntags: [a, b]\n---\n# 正文', { basePath: 'README.md' });
  assert.deepEqual(front.children.map(n => n.tagName), ['PRE', 'H1']);
  assert.equal(front.children[0].textContent, 'title: 示例\ntags: [a, b]');
  assert.equal(byTag(front, 'hr').length, 0);
  const dots = renderMarkdown('---\na: 1\n...\n正文', { basePath: 'README.md' });
  assert.deepEqual(dots.children.map(n => n.tagName), ['PRE', 'P'], '以 ... 结束也认');
  const later = renderMarkdown('# 标题\n\n---\nfoo\n---', { basePath: 'README.md' });
  assert.equal(byClass(later, 'md-code').length, 0, '不在文件开头的 --- 不是 front matter');
  assert.deepEqual(later.children.map(n => n.tagName), ['H1', 'HR', 'H2']);
  const open = renderMarkdown('---\n正文没有结束行', { basePath: 'README.md' });
  assert.equal(byClass(open, 'md-code').length, 0, '没有结束行不算 front matter');
  assert.equal(byTag(open, 'hr').length, 1);

  const br = renderMarkdown('甲<br>乙<BR/>丙<br />丁\n\n<br>\n\n| 列 |\n| --- |\n| 一<br>二 |', { basePath: 'README.md' });
  const firstP = byTag(br, 'p')[0];
  assert.deepEqual(firstP.children.map(n => n.tagName ?? n.textContent), ['甲', 'BR', '乙', 'BR', '丙', 'BR', '丁'], '行内 <br> 三种写法都转成换行');
  assert.equal(byTag(byTag(br, 'p')[1], 'br').length, 1, '单独成行的 <br> 是一个换行');
  assert.equal(byTag(byTag(br, 'td')[0], 'br').length, 1, '表格单元格里的 <br> 也转换行');
  const raw = renderMarkdown('<div>仍是文本</div> <span onclick="x()">y</span>', { basePath: 'README.md' });
  assert.deepEqual(raw.children.map(n => n.tagName), ['P'], '其它原始 HTML 仍按文本显示，不生成 div/span 元素');
  assert.equal(byTag(raw, 'span').length, 0);
  assert.equal(byTag(raw, 'p')[0].textContent, '<div>仍是文本</div> <span onclick="x()">y</span>');
});

test('标题 id 加 md- 前缀，避开页面自身的 #tree / #stage / #panes，页内锚点仍能跳转，重复标题照旧加后缀', async t => {
  await withDom(t);
  const md = renderMarkdown('# Tree\n\n## Stage\n\n### Panes\n\n## Tree\n\n[到 Tree](#tree) [到第二个](#tree-1) [到 Panes](#Panes) [空](#)', { basePath: 'README.md' });
  const ids = byTag(md, 'h1').concat(byTag(md, 'h2'), byTag(md, 'h3')).map(el => el.getAttribute('id'));
  assert.deepEqual(ids.sort(), ['md-panes', 'md-stage', 'md-tree', 'md-tree-1']);
  assert.equal(ids.some(id => ['tree', 'stage', 'panes'].includes(id)), false);

  const scrolled = [];
  for (const el of byTag(md, 'h1').concat(byTag(md, 'h2'), byTag(md, 'h3'))) el.scrollIntoView = () => scrolled.push(el.getAttribute('id'));
  const click = label => byTag(md, 'a').find(a => a.textContent === label).dispatch('click');
  click('到 Tree'); click('到第二个'); click('到 Panes'); click('空');
  assert.deepEqual(scrolled, ['md-tree', 'md-tree-1', 'md-panes'], '锚点跳到对应标题，空锚点不跳');
  assert.deepEqual(safeLinkTarget('#Stage', 'README.md'), { kind: 'hash', href: '#Stage', id: 'md-stage' });
  assert.deepEqual(safeLinkTarget('#', 'README.md'), { kind: 'hash', href: '#', id: '' });
});

// ---- 评审修正 ----

test('列表内的代码保留原始 Tab：容器缩进按展开后的列宽识别，代码正文原样', async t => {
  await withDom(t);
  const fenced = renderMarkdown('- a\n  ```go\n  \tprintln(1)\n  ```', { basePath: 'README.md' });
  assert.equal(byClass(fenced, 'md-code')[0].textContent, '\tprintln(1)', '列表项内围栏里的 Tab 不展开');

  const indented = renderMarkdown('- a\n\n      \tx\n      y', { basePath: 'README.md' });
  assert.equal(byClass(indented, 'md-code')[0].textContent, '\tx\ny', '列表项内缩进代码块里的 Tab 不展开');

  const nested = renderMarkdown('- a\n\t- b\n\t  ```\n\t  \tc\n\t  ```', { basePath: 'README.md' });
  assert.deepEqual(byTag(nested, 'ul').map(ul => ul.children.length), [1, 1], 'Tab 缩进仍按 4 列识别为嵌套列表');
  assert.ok(byClass(nested, 'md-code')[0].textContent.includes('\tc'), '嵌套两层后围栏里的 Tab 仍在');

  const quoted = renderMarkdown('> ```\n> \tq\n> ```', { basePath: 'README.md' });
  assert.equal(byClass(quoted, 'md-code')[0].textContent, '\tq', '引用块内围栏里的 Tab 保留');
});

test('HTML 注释按块和行内两层识别：整行起头的注释是注释块，行内注释不跨块，代码里的 <!-- 永远是字面量', async t => {
  await withDom(t);
  const render = src => renderMarkdown(src, { basePath: 'README.md' });
  const texts = md => md.children.map(n => n.textContent.trim());

  // 注释块：跨空行、含标题行都整块隐藏，闭合行之后的正文保留
  assert.deepEqual(texts(render('<!--\n# 隐藏标题\n\n隐藏正文\n-->\n可见正文')), ['可见正文']);
  const afterClose = render('<!-- hidden\n# still hidden\n--> After');
  assert.equal(byTag(afterClose, 'h1').length, 0);
  assert.deepEqual(texts(afterClose), ['After']);
  assert.deepEqual(texts(render('<!-- a\nb --> 正文\n\n后文')), ['正文', '后文'], '闭合行后的正文作为新的一行继续解析');
  assert.deepEqual(texts(render('段一\n<!-- c -->\n段二')), ['段一', '段二'], '预期行为：行首 <!-- 本来就能打断段落（CommonMark 的 HTML 块），所以切成两段，不是一段');
  assert.deepEqual(texts(render('   <!-- 缩进 3 格 -->\n正文')), ['正文']);
  assert.deepEqual(texts(render('前\n\n<!-- 没有闭合\n# 标题\n正文')), ['前'], '没有闭合的注释块到容器末尾（CommonMark）');

  // 容器坐标：列表项、引用块里同样按块识别
  const inList = render('- 项\n  <!--\n  # x\n  -->\n  续\n- 下一项');
  assert.equal(byTag(inList, 'h1').length, 0);
  assert.deepEqual(byTag(inList, 'li').map(li => li.textContent), ['项续', '下一项'], '项内注释块整块隐藏');
  const inQuote = render('> <!--\n> # x\n> -->\n> y');
  assert.equal(byTag(inQuote, 'h1').length, 0);
  assert.equal(byTag(inQuote, 'blockquote')[0].textContent, 'y');

  // 行内注释：可跨段内软换行，不跨块（行内跨空行按 CommonMark 显示出来）
  assert.deepEqual(texts(render('a <!-- 1 --> b <!-- 2 --> c')), ['a  b  c']);
  assert.deepEqual(texts(render('a <!-- x\ny --> b')), ['a  b'], '跨软换行的行内注释去掉');
  assert.deepEqual(texts(render('Before <!-- hidden\n\nstill hidden --> After')), ['Before <!-- hidden', 'still hidden --> After'], '行内注释跨空行时不当注释，两段都显示（CommonMark）');

  // 字面量：转义、代码跨度、围栏与缩进代码块、链接目标与标题
  assert.deepEqual(texts(render('\\<!-- 转义 -->')), ['<!-- 转义 -->']);
  const literal = render('```\n<!-- a\n# b\n-->\n```\n\n    <!-- 缩进代码 -->\n\n`<!-- 行内 -->` 和 <!-- 丢弃 -->\n\n- c\n\n      <!-- 列表内缩进代码 -->');
  assert.equal(byClass(literal, 'md-code')[0].textContent, '<!-- a\n# b\n-->');
  assert.equal(byClass(literal, 'md-code')[1].textContent, '<!-- 缩进代码 -->');
  assert.equal(byClass(literal, 'md-code')[2].textContent, '<!-- 列表内缩进代码 -->');
  assert.equal(byClass(literal, 'md-inline-code')[0].textContent, '<!-- 行内 -->');
  assert.equal(byTag(literal, 'p')[0].textContent, '<!-- 行内 --> 和 ');
  const link = render('[a](./b.md "<!-- t -->") [c](./d<!--e-->.md)');
  const anchors = byTag(link, 'a');
  assert.equal(anchors[0].getAttribute('title'), '<!-- t -->', '链接标题里的注释保持字面量');
  assert.equal(anchors[1].getAttribute('data-rel-path'), 'd<!--e-->.md', '链接目标里的注释保持字面量');

  // 删除注释不把两侧拼成新语法，也不改注释以外的空白与硬换行
  const split = render('[文档]<!-- -->(guide.md)');
  assert.equal(byTag(split, 'a').length, 0, '不得拼成链接');
  assert.equal(split.textContent, '[文档](guide.md)');
  const em = render('*a <!-- * --> b*');
  assert.equal(byTag(em, 'em')[0].textContent, 'a  b', '注释里的 * 不参与强调配对');
  assert.equal(byTag(render('x<!-- c -->  \ny'), 'br').length, 1, '注释之后的行尾两个空格仍是硬换行');
  const spaces = render('x  <!-- c -->\ny');
  assert.equal(byTag(spaces, 'br').length, 0, '注释前的空格不在行尾，不是硬换行');
  assert.equal(spaces.textContent, 'x  \ny', '注释以外的空白原样保留');
});

test('列表项末尾判定与块解析一致：列表内表格后的续行、无缩进的表格分隔行、列表项开头的注释', async t => {
  await withDom(t);
  const afterTable = renderMarkdown('- 项\n  A | B\n  --- | ---\n  x | y\n无缩进行', { basePath: 'README.md' });
  assert.equal(byTag(afterTable, 'table').length, 1);
  assert.equal(byTag(byTag(afterTable, 'li')[0], 'tbody')[0].children.length, 1, '表格只有数据行 x | y');
  assert.equal(afterTable.children.at(-1).textContent, '无缩进行', '表格之后的无缩进行不并入列表项');
  assert.equal(byTag(afterTable, 'li')[0].textContent.includes('无缩进行'), false);

  const lazyDelimiter = renderMarkdown('- x\n  | a | b |\n--- | ---\n文字', { basePath: 'README.md' });
  assert.equal(byTag(lazyDelimiter, 'table').length, 0, '无缩进的分隔行不能把列表项里的段落变成表格');
  assert.equal(byTag(lazyDelimiter, 'li')[0].textContent, 'x\n| a | b |');
  assert.equal(lazyDelimiter.children.at(-1).textContent, '--- | ---\n文字');

  const leadingComment = renderMarkdown('- <!-- 备注 -->\n  正文\n续行', { basePath: 'README.md' });
  assert.equal(byTag(leadingComment, 'li').length, 1);
  assert.equal(byTag(leadingComment, 'li')[0].textContent, '正文\n续行', '列表项开头的注释不影响续行归属');

  const inlineComment = renderMarkdown('- 前 <!-- c --> 后\n续行\n\n段落', { basePath: 'README.md' });
  assert.equal(byTag(inlineComment, 'li')[0].textContent, '前  后\n续行');

  const nestedTable = renderMarkdown('- 外\n  - 内\n    x | y\n    --- | ---\n    1 | 2\n  无缩进', { basePath: 'README.md' });
  assert.equal(byTag(nestedTable, 'li').at(-1).textContent.includes('无缩进'), false, '嵌套列表项里表格之后的无缩进行不并入');
});

test('列表条目必须同标记：换了标记字符或有序分隔符就另起列表，有没有空行都一样，AST 与续行判定一致', async t => {
  await withDom(t);
  const lists = (src, tag = 'UL') => renderMarkdown(src, { basePath: 'README.md' }).children.map(n => n.children.map(li => li.textContent));
  assert.deepEqual(lists('- a\n+ b\n\n- c'), [['a'], ['b'], ['c']], '和当前所在列表（+）比较，- 另起一个列表');
  assert.deepEqual(lists('- a\n+ b\n\n+ c'), [['a'], ['b', 'c']]);
  assert.deepEqual(lists('- a\n\n- b\n\n* c\n\n+ d\n\n+ e'), [['a', 'b'], ['c'], ['d', 'e']]);
  assert.deepEqual(lists('- a\n* b\n- c'), [['a'], ['b'], ['c']], '相邻也不例外');

  const ordered = renderMarkdown('1. a\n2) b\n\n3) c\n\n4. d', { basePath: 'README.md' });
  assert.deepEqual(ordered.children.map(n => [n.tagName, n.getAttribute('start'), n.children.map(li => li.textContent)]), [
    ['OL', null, ['a']], ['OL', '2', ['b', 'c']], ['OL', '4', ['d']],
  ]);

  const nested = renderMarkdown('- a\n  - x\n\n  * y\n\n  - z', { basePath: 'README.md' });
  assert.deepEqual(byTag(nested, 'ul').slice(1).map(ul => ul.children.map(li => li.textContent)), [['x'], ['y'], ['z']], '嵌套列表同样按标记分开');

  // 续行判定与列表归属共用同一套判定：无缩进的续行并入最后一个（换过标记的）列表项，而不是被丢出列表
  const lazy = renderMarkdown('- a\n  - x\n  + y\n续行', { basePath: 'README.md' });
  assert.deepEqual(byTag(lazy, 'ul').slice(1).map(ul => ul.children.map(li => li.textContent)), [['x'], ['y\n续行']]);
  assert.equal(lazy.children.length, 1);
});

test('部分 Tab：容器剥掉 Tab 的一部分后，剩下的列补成空格，制表位按累计列偏移计算', async t => {
  await withDom(t);
  const code = src => byClass(renderMarkdown(src, { basePath: 'README.md' }), 'md-code').map(el => el.textContent);
  assert.deepEqual(code('- a\n\n\t\tvalue'), ['  value'], '列表项剥 2 列后，两个 Tab 剩 2 个空格加 value');
  assert.deepEqual(code('> \t\tcode'), ['  code'], '引用块里同样按累计列偏移（> 加空格占 2 列）');
  assert.deepEqual(code('x\n\n\t\tbar'), ['\tbar'], '顶层缩进代码块只吃掉第一个 Tab，其余原样');
  assert.deepEqual(code('- a\n  ```\n  \tkeep\n  ```'), ['\tkeep'], '没被剥到的 Tab 原样保留');
  assert.deepEqual(code('- a\n  - b\n\n\t\t\tdeep'), ['\tdeep'], '两层容器累计偏移：三个 Tab 共 12 列，容器剥 2+2、代码剥 4，剩下第三个 Tab 原样');
});

test('注释之后还有 --> 时，链接、强调、删除线里的转义与代码跨度仍先于注释识别', async t => {
  await withDom(t);
  const render = src => renderMarkdown(src, { basePath: 'README.md' });

  const link = render('[a `<!--` b](./c.md) 后文 -->');
  assert.equal(byTag(link, 'a')[0]?.getAttribute('data-rel-path'), 'c.md', '链接文字里的代码跨度含 <!-- 不影响 ] 的配对');
  assert.equal(byTag(link, 'a')[0].textContent, 'a <!-- b');
  assert.equal(byClass(link, 'md-inline-code')[0].textContent, '<!--');
  assert.equal(link.textContent.includes('后文 -->'), true, '链接之后的 --> 照常显示');

  const strong = render('**a `<!--` b** 后文 -->');
  assert.equal(byTag(strong, 'strong')[0]?.textContent, 'a <!-- b', '粗体闭合不被代码跨度里的 <!-- 吞掉');
  assert.equal(strong.textContent.includes('后文 -->'), true);

  const del = render('~~a `<!--` b~~ 后文 -->');
  assert.equal(byTag(del, 'del')[0]?.textContent, 'a <!-- b', '删除线闭合不被代码跨度里的 <!-- 吞掉');
  assert.equal(del.textContent.includes('后文 -->'), true);

  const escaped = render('*a \\<!-- b* 后文 -->');
  assert.equal(byTag(escaped, 'em')[0]?.textContent, 'a <!-- b', '转义的 \\<!-- 不是注释起点');

  const image = render('![a `<!--` b](./c.png) 后文 -->');
  assert.equal(byTag(image, 'img').length + byClass(image, 'md-img-fallback').length, 1, '图片的 ] 配对同样不受影响');
});

test('引用块里围栏闭合后，后面的注释照常丢掉，围栏代码保留', async t => {
  await withDom(t);
  const md = renderMarkdown('> ```\n> <!-- 围栏里保留 -->\n> ```\n> <!-- 围栏后的注释块 -->\n> 正文 <!-- 行内注释 --> 尾', { basePath: 'README.md' });
  const quote = byTag(md, 'blockquote')[0];
  assert.equal(byClass(quote, 'md-code')[0].textContent, '<!-- 围栏里保留 -->');
  assert.equal(quote.textContent.includes('围栏后的注释块'), false);
  assert.equal(quote.textContent.includes('行内注释'), false);
  assert.equal(byTag(quote, 'p')[0].textContent, '正文  尾');
});

test('转义的 \\<!-- 保留字面量，也不生成换行', async t => {
  await withDom(t);
  const md = renderMarkdown('\\<!-- literal -->\nNext', { basePath: 'README.md' });
  assert.equal(byTag(md, 'p')[0].textContent, '<!-- literal -->\nNext');
  assert.equal(byTag(md, 'br').length, 0);
});

test('反引号只和等长序列配对，不匹配时整段按字面量，闭合扫描也一样', async t => {
  await withDom(t);
  const render = text => renderMarkdown(text, { basePath: 'README.md' });
  const link = render('[Use `](guide.md) and ``code``');
  assert.equal(byTag(link, 'a').length, 1, '链接不被长度不同的反引号吞掉');
  assert.equal(byTag(link, 'a')[0].getAttribute('data-rel-path'), 'guide.md');
  assert.deepEqual(byClass(link, 'md-inline-code').map(c => c.textContent), ['code']);

  const image = render('![A `](logo.png) and ``code``');
  assert.equal(byTag(image, 'img').length + byClass(image, 'md-img-fallback').length, 1, '图片不被吞掉');
  assert.deepEqual(byClass(image, 'md-inline-code').map(c => c.textContent), ['code']);

  const strong = render('**Use `** and ``code``');
  assert.equal(byTag(strong, 'strong')[0]?.textContent, 'Use `');
  assert.deepEqual(byClass(strong, 'md-inline-code').map(c => c.textContent), ['code']);

  const del = render('~~Use `~~ and ``code``');
  assert.equal(byTag(del, 'del')[0]?.textContent, 'Use `');
  assert.deepEqual(byClass(del, 'md-inline-code').map(c => c.textContent), ['code']);

  // 无等长闭合：整段反引号是字面量，不从中间重新配对
  const lone = render('``a` b');
  assert.equal(byClass(lone, 'md-inline-code').length, 0);
  assert.equal(lone.textContent, '``a` b');

  // 正向：等长配对仍是代码跨度，内部可含更短的反引号
  const pair = render('``a`b`` 和 `c`');
  assert.deepEqual(byClass(pair, 'md-inline-code').map(c => c.textContent), ['a`b', 'c']);
  const closed = render('[x ``a`b`` y](guide.md)');
  assert.equal(byTag(closed, 'a').length, 1, '等长代码跨度内的反引号不影响链接配对');
});
