// 页内 HTML 预览的清洗器（view/html.mjs，设计第 27.3、27.4 节）：喂假树，不依赖浏览器的解析器。
// 假树的每个节点都套了一层 Proxy，读到 nodeType、data、namespaceURI、localName、getAttribute、childNodes 以外的任何属性都会抛错，
// 所以「清洗器只读这几样」本身被断言；元素都显式写命名空间，不给缺省值。
import assert from 'node:assert/strict';
import test from 'node:test';
import { INPUT_LIMIT, OUTPUT_LIMIT, OUTPUT_RESERVE, renderHtml, sanitizeHtml } from '../view/html.mjs';
import { dataImageSize } from '../view/rich.mjs';
import { open } from './support/filepage.mjs';

const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const MATH = 'http://www.w3.org/1998/Math/MathML';
const BODY_LIMIT = OUTPUT_LIMIT - OUTPUT_RESERVE;

const READABLE = new Set(['nodeType', 'data', 'namespaceURI', 'localName', 'getAttribute', 'childNodes']);
const strict = node => new Proxy(node, { get(target, key) { if (!READABLE.has(key)) throw new Error(`清洗器读了不该读的属性：${String(key)}`); return target[key]; } });
const attrFn = attrs => name => (attrs && Object.hasOwn(attrs, name) ? attrs[name] : null);
const kidsOf = kids => kids.flat().map(kid => (typeof kid === 'string' ? text(kid) : kid));
const text = data => strict({ nodeType: 3, data });
const elIn = (namespaceURI, localName, attrs, ...kids) => strict({ nodeType: 1, namespaceURI, localName, getAttribute: attrFn(attrs), childNodes: kidsOf(kids) });
const el = (tag, attrs, ...kids) => elIn(HTML, tag, attrs, ...kids);
const doc = (...kids) => strict({ nodeType: 9, childNodes: kidsOf(kids) });
const page = (...kids) => doc(el('html', null, el('head'), el('body', null, ...kids)));
// 大树不套 Proxy（只为快）。
const NO_ATTR = () => null;
const NO_KIDS = [];
const leaf = tag => ({ nodeType: 1, namespaceURI: HTML, localName: tag, getAttribute: NO_ATTR, childNodes: NO_KIDS });
const bigPage = kids => doc({ nodeType: 1, namespaceURI: HTML, localName: 'html', getAttribute: NO_ATTR, childNodes: [{ nodeType: 1, namespaceURI: HTML, localName: 'body', getAttribute: NO_ATTR, childNodes: kids }] });

const ready = t => open(t, { path: 'x.txt', files: {} });

// 输出树：序列化（class 排在最前，其余按设置顺序），和独立的节点计数、深度。
const ser = node => {
  if (typeof node.data === 'string') return node.data;
  const tag = node.tagName.toLowerCase();
  const attrs = [...(node.className ? [['class', node.className]] : []), ...node.attributes].map(([key, value]) => ` ${key}="${value}"`).join('');
  return `<${tag}${attrs}>${node.children.map(ser).join('')}</${tag}>`;
};
const inner = root => root.children.map(ser).join('');
const nodesOf = root => {
  const out = [], todo = [root];
  while (todo.length) { const node = todo.pop(); out.push(node); if (node.children) todo.push(...node.children); }
  return out;
};
const count = root => {
  let total = 0;
  const todo = [root];
  while (todo.length) { const node = todo.pop(); total++; if (node.children) for (const kid of node.children) todo.push(kid); }
  return total;
};
const depth = root => {
  let deepest = 0;
  const todo = [[root, 0]];
  while (todo.length) { const [node, level] = todo.pop(); deepest = Math.max(deepest, level); for (const kid of node.children ?? []) todo.push([kid, level + 1]); }
  return deepest;
};
const find = (root, predicate) => root.find(predicate);
const byClass = (root, name) => find(root, node => node.classList.contains(name));
const byTag = (root, tag) => find(root, node => node.tagName === tag.toUpperCase());
const render = (tree, options) => sanitizeHtml(tree, options);
const html = (tree, options) => inner(render(tree, options).node);
// 带 script 的短页面会多出「内容很少」的提示，只看正文时去掉它。
const FEW = '静态预览里内容很少';
const bodyOf = result => result.node.children.filter(node => !node.textContent.startsWith(FEW)).map(ser).join('');
const UI = (cls, text) => `<span class="${cls}" data-rich-ui="">${text}</span>`;
const PLACEHOLDER = text => UI('md-img-fallback secondary', text);

// ---- 节点分派 ----

test('策略表·节点分派：HTML 命名空间的 <p>正文</p> 原样保留', async t => {
  await ready(t);
  assert.equal(html(page(el('p', null, '正文'))), '<p>正文</p>');
});

test('策略表·节点分派：元素的命名空间不是 HTML（含没写、写了别的）的不进通用遍历；非元素、非文本节点丢掉', async t => {
  await ready(t);
  const unset = strict({ nodeType: 1, namespaceURI: null, localName: 'p', getAttribute: () => null, childNodes: [text('没有命名空间')] });
  const other = elIn('http://example.com/x', 'p', null, '别的命名空间');
  const svgOnly = elIn(SVG, 'g', null, el('p', null, 'svg 的 g'));
  const mathOnly = elIn(MATH, 'mi', null, '不是 math 根');
  const comment = strict({ nodeType: 8, data: '注释' });
  const instruction = strict({ nodeType: 7, data: '处理指令' });
  const doctype = strict({ nodeType: 10 });
  assert.equal(html(page(unset, other, svgOnly, mathOnly, comment, instruction, doctype, el('p', null, '留下'))), '<p>留下</p>');
});

test('策略表·节点分派：svg 的 foreignObject 下面即使有 HTML 命名空间的子元素，也永远不会被放行', async t => {
  await ready(t);
  const tree = page(elIn(SVG, 'svg', { width: '100', height: '100' }, elIn(SVG, 'foreignObject', null, el('p', null, '永远不放行'), el('script', null, 'x'))));
  const result = render(tree);
  assert.equal(inner(result.node), PLACEHOLDER('[图形]'));
  assert.equal(result.scripts, 0, 'svg 里面不走通用遍历，script 也不计');
});

// ---- 元素表 ----

const KEEP_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr', 'br', 'details', 'summary', 'figure', 'figcaption', 'strong', 'b', 'em', 'i', 's', 'del', 'strike', 'u', 'ins', 'kbd', 'samp', 'var', 'sub', 'sup', 'mark', 'small', 'abbr', 'q', 'cite', 'dfn', 'time'];
const DROPPED_ATTRS = { class: 'x', id: 'i', name: 'n', style: 'color:red', onclick: 'a()', onerror: 'b()', 'data-x': '1', srcset: 's 2x', ping: 'p', download: 'd', target: '_blank', cite: 'c', background: 'b', href: 'h', src: 's', datetime: '2020' };

test('策略表·原样保留：每个标签保留，属性表以外的属性一律丢弃', async t => {
  await ready(t);
  for (const tag of KEEP_TAGS) {
    const empty = tag === 'br' || tag === 'hr';
    assert.equal(html(page(el(tag, DROPPED_ATTRS, '内容'))), empty ? `<${tag}></${tag}>` : `<${tag}>内容</${tag}>`, tag);
  }
});

test('策略表·套 Markdown 的结构和类：table、pre、pre 外的 code', async t => {
  await ready(t);
  assert.equal(html(page(el('table', null, el('tbody', null, el('tr', null, el('td', null, '格')))))), '<div class="md-table-wrap"><table><tbody><tr><td>格</td></tr></tbody></table></div>');
  assert.equal(html(page(el('pre', null, 'a = 1'))), '<pre class="md-code"><code>a = 1</code></pre>');
  assert.equal(html(page(el('p', null, '用 ', el('code', { class: 'x' }, 'ls'), ' 看'))), '<p>用 <code class="md-inline-code">ls</code> 看</p>');
});

test('策略表·换成 div：每个标签换成 div 并保留子内容，legend 换成 p', async t => {
  await ready(t);
  for (const tag of ['div', 'section', 'article', 'main', 'header', 'footer', 'address', 'center', 'hgroup', 'search', 'form', 'fieldset']) {
    assert.equal(html(page(el(tag, { class: 'x', id: 'y' }, '内容'))), '<div>内容</div>', tag);
  }
  assert.equal(html(page(el('fieldset', null, el('legend', null, '标题'), '内容'))), '<div><p>标题</p>内容</div>');
});

const links = n => Array.from({ length: n }, (_, index) => el('a', { href: `https://example.com/${index}` }, `项${index}`));
const landmarks = root => byClass(root, 'md-landmark');
const summaryText = details => details.children[0].textContent;

test('策略表·折叠：有 4 个以上链接的 nav 重建成默认收起的 details.md-landmark，summary 写项数、带 data-rich-ui', async t => {
  await ready(t);
  const result = render(page(el('nav', null, ...links(4))));
  const [details] = landmarks(result.node);
  assert.equal(summaryText(details), '导航（4 项）');
  assert.equal(details.children[0].getAttribute('data-rich-ui'), '');
  assert.equal(details.getAttribute('open'), null, '默认收起');
  assert.equal(byTag(details, 'a').length, 4, '链接都在 details 里');
  assert.equal(render(page(el('nav', null, ...links(3)))).node.find(node => node.classList.contains('md-landmark')).length, 0, '3 个链接的 nav 只换成 div');
  assert.equal(html(page(el('nav', { id: 'n' }, '文字'))), '<div>文字</div>');
  assert.equal(render(page(el('nav', null, el('a', null, '没有 href'), el('a', null, '没有 href'), ...links(3)))).node.find(node => node.classList.contains('md-landmark')).length, 0, '没有 href 的 a 不算链接');
});

test('策略表·折叠：嵌套的 nav 里层的链接也算外层的', async t => {
  await ready(t);
  const result = render(page(el('nav', null, ...links(2), el('nav', null, ...links(2))), el('nav', null, el('nav', null, ...links(4)))));
  assert.deepEqual(landmarks(result.node).map(summaryText), ['导航（4 项）', '导航（4 项）', '导航（4 项）']);
});

test('策略表·折叠：页面有 main 或 article 时，它们之外的 aside 折叠；aside 在 main 之前也一样', async t => {
  await ready(t);
  for (const main of ['main', 'article']) {
    const result = render(page(el('aside', null, '侧栏内容'), el(main, null, el('p', null, '正文'))));
    const [details] = landmarks(result.node);
    assert.equal(summaryText(details), '侧栏', main);
    assert.equal(details.getAttribute('open'), null);
    assert.equal(details.textContent, '侧栏侧栏内容');
    assert.equal(landmarks(render(page(el(main, null, '正文'), el('aside', null, '后面的侧栏'))).node).length, 1, 'aside 在 main 之后');
  }
});

test('策略表·折叠：页面没有 main、article 时 aside 换成 div；在 main、article 里面的 aside 也换成 div', async t => {
  await ready(t);
  assert.equal(html(page(el('aside', null, '侧栏'), el('p', null, '正文'))), '<div>侧栏</div><p>正文</p>');
  assert.equal(html(page(el('main', null, el('aside', null, '里面的')))), '<div><div>里面的</div></div>');
  assert.equal(html(page(el('article', null, el('aside', null, '里面的')))), '<div><div>里面的</div></div>');
  assert.equal(landmarks(render(page(el('main', null, el('aside', null, '里面')), el('aside', null, '外面'))).node).length, 1, '只折叠 main 之外的那个');
});

const DROPPED = ['script', 'style', 'template', 'title', 'link', 'meta', 'base', 'map', 'area', 'input', 'select', 'textarea', 'option', 'optgroup', 'datalist', 'output', 'progress', 'meter', 'dialog', 'portal', 'source', 'track', 'param', 'noembed', 'noframes', 'colgroup', 'col'];

test('策略表·连内容一起丢：每个标签连子内容丢掉；script 先计数再丢', async t => {
  await ready(t);
  for (const tag of DROPPED) {
    const result = render(page(el(tag, null, '机密', el('b', null, '加粗')), el('p', null, '留下')));
    assert.equal(bodyOf(result), '<p>留下</p>', tag);
    assert.equal(result.scripts, tag === 'script' ? 1 : 0, tag);
  }
});

test('策略表·head：遍历它只为数 script、取标题，不输出任何内容；body 里的 title 丢掉，只取 head 里第一个', async t => {
  await ready(t);
  const tree = doc(el('html', null,
    el('head', null, el('meta', { charset: 'utf-8' }), el('title', null, ' 第一个‮\u0007 标题\n'), el('title', null, '第二个'), el('script', null, 'a()'), el('noscript', null, el('script', null, 'b()')), el('style', null, 'p{}'), '文字'),
    el('body', null, el('p', null, '正'), el('title', null, 'body 里的'), el('script', null, 'c()'))));
  const result = render(tree);
  assert.equal(bodyOf(result), '<p>正</p>');
  assert.equal(result.title, '第一个 标题', '先去掉控制字符和 BiDi 覆盖字符，再折叠空白');
  assert.equal(result.scripts, 3, 'head 里的、head 的 noscript 里的、body 里的');
  assert.equal(render(page(el('p', null, '没有 head 标题'))).title, '');
  assert.equal(render(doc(el('html', null, el('head', null, el('title', null, 'x'.repeat(600)))))).title.length, 80, '标题最多 80 字');
});

test('策略表·换成占位文字：iframe、frame、frameset、object、embed、applet、canvas，子内容不进', async t => {
  await ready(t);
  for (const tag of ['iframe', 'frame', 'frameset', 'object', 'embed', 'applet']) {
    const result = render(page(el(tag, { src: 'http://x.example/' }, '后备内容', el('p', null, '后备'))));
    assert.equal(inner(result.node), PLACEHOLDER('[嵌入内容]'), tag);
  }
  assert.equal(html(page(el('canvas', null, '后备'))), PLACEHOLDER('[画布]'));
});

test('策略表·换成占位文字：video、audio 能取到文件名时写上（去掉 ?、# 之后和控制字符，最多 60 字）', async t => {
  await ready(t);
  assert.equal(html(page(el('video'))), PLACEHOLDER('[视频]'));
  assert.equal(html(page(el('audio'))), PLACEHOLDER('[音频]'));
  assert.equal(html(page(el('video', { src: 'a/b/clip.mp4?x=1#t=3' }))), PLACEHOLDER('[视频：clip.mp4]'));
  assert.equal(html(page(el('audio', null, el('source', { src: '/m/song%20one.mp3' })))), PLACEHOLDER('[音频：song one.mp3]'), '子元素 source 的 src');
  assert.equal(html(page(el('video', { src: 'cl\u0001ip.mp4' }))), PLACEHOLDER('[视频：clip.mp4]'));
  assert.equal(html(page(el('video', { src: `${'长'.repeat(100)}.mp4` }))), PLACEHOLDER(`[视频：${'长'.repeat(60)}]`));
  assert.equal(html(page(el('video', { src: 'data:video/mp4;base64,AAAA' }))), PLACEHOLDER('[视频]'), 'data: 没有文件名');
  assert.equal(html(page(el('video', { src: 'https://cdn.example/v/a.webm?token=1' }))), PLACEHOLDER('[视频：a.webm]'));
});

test('策略表·svg：在 button 或 a 里的、没有标题且宽高都不大于 32 的静默丢掉；其余写「[图形]」，有标题写「[图形：标题]」', async t => {
  await ready(t);
  const svg = (attrs, ...kids) => elIn(SVG, 'svg', attrs, ...kids);
  assert.equal(html(page(svg({ width: '16', height: '16' }))), '', '小图标');
  assert.equal(html(page(svg({ width: '32', height: '32' }))), '', '正好 32');
  assert.equal(html(page(svg({ width: '33', height: '16' }))), PLACEHOLDER('[图形]'), '有一边大于 32');
  assert.equal(html(page(svg({ width: '16' }))), PLACEHOLDER('[图形]'), '没写高就不算小');
  assert.equal(html(page(svg(null))), PLACEHOLDER('[图形]'));
  assert.equal(html(page(svg({ width: '16', height: '16', 'aria-label': '设置' }))), PLACEHOLDER('[图形：设置]'), 'aria-label');
  assert.equal(html(page(svg({ width: '16', height: '16', title: '属性标题' }))), '<span class="md-img-fallback secondary" data-rich-ui="" title="属性标题">[图形：属性标题]</span>', 'title 属性（同一份属性策略，title 也留在占位上）');
  assert.equal(html(page(svg(null, elIn(SVG, 'g'), elIn(SVG, 'title', null, '子标题‮')))), PLACEHOLDER('[图形：子标题]'), '子元素 title');
  assert.equal(html(page(el('a', { href: 'https://example.com/' }, svg(null), '文字'))), '<a href="https://example.com/" title="https://example.com/">文字</a>', '在 a 里');
  assert.equal(html(page(el('button', null, '按钮', svg(null)))), '<span class="md-chip">按钮</span>', '在 button 里');
});

test('策略表·math：有 application/x-tex 的 annotation 就按代码显示 TeX（display="block" 块级，否则行内）；找不到取文字，跳过 annotation、annotation-xml', async t => {
  await ready(t);
  const math = (attrs, ...kids) => elIn(MATH, 'math', attrs, ...kids);
  const tex = value => elIn(MATH, 'semantics', null, elIn(MATH, 'mi', null, 'x'), elIn(MATH, 'annotation', { encoding: 'Application/X-TeX' }, value));
  assert.equal(html(page(math({ display: 'block' }, tex('x^2')))), '<pre class="md-code"><code>x^2</code></pre>');
  assert.equal(html(page(el('p', null, '当 ', math(null, tex('x^2')), ' 时'))), '<p>当 <code class="md-inline-code">x^2</code> 时</p>');
  const plain = math(null, elIn(MATH, 'mi', null, 'x'), elIn(MATH, 'mo', null, '+'), elIn(MATH, 'mn', null, '1'),
    elIn(MATH, 'annotation', { encoding: 'application/mathml+xml' }, '不是 TeX'), elIn(MATH, 'annotation-xml', { encoding: 'text/html' }, el('p', null, 'HTML 注释')));
  assert.equal(html(page(el('p', null, plain))), '<p>x+1</p>');
  assert.equal(html(page(el('p', null, math(null, elIn(MATH, 'mtext', null, '文字', el('script', null, 'bad()')))))), '<p>文字</p>', 'HTML 的丢弃元素不取');
});

test('策略表·按钮：没有文字或只有图标的 button 丢掉，有文字的建成 span.md-chip', async t => {
  await ready(t);
  assert.equal(html(page(el('button', null, '提交'))), '<span class="md-chip">提交</span>');
  assert.equal(html(page(el('button', { class: 'x', onclick: 'a()' }, el('span', null, ' 嵌套 ')))), '<span class="md-chip"> 嵌套 </span>');
  assert.equal(html(page(el('button'))), '');
  assert.equal(html(page(el('button', null, '  \n '))), '', '只有空白');
  assert.equal(html(page(el('button', null, elIn(SVG, 'svg', { width: '16', height: '16' }), el('img', { src: 'icon.png' })))), '', '只有图标');
});

test('策略表·只留文字、显示内容：label 只留文字，noscript 显示内容（里面的丢弃元素照丢）', async t => {
  await ready(t);
  assert.equal(html(page(el('p', null, el('label', { for: 'a' }, '名称', el('input', { type: 'text' }))))), '<p>名称</p>');
  assert.equal(html(page(el('noscript', null, el('p', null, '请启用脚本'), el('style', null, 'p{}')))), '<p>请启用脚本</p>');
});

test('策略表·未知 HTML 元素：去掉标签，保留子内容', async t => {
  await ready(t);
  assert.equal(html(page(el('p', null, '甲', el('span', { class: 'x' }, '乙', el('font', { color: 'red' }, '丙')), '丁'))), '<p>甲乙丙丁</p>');
  assert.equal(html(page(el('x-custom', null, el('p', null, '自定义元素')))), '<p>自定义元素</p>');
});

test('策略表·整个跳过：hidden、aria-hidden="true"、内联 style 里有 display:none 或 visibility:hidden 的（连子孙），style 不输出', async t => {
  await ready(t);
  const hiddenOnes = [{ hidden: '' }, { hidden: 'until-found' }, { 'aria-hidden': 'true' }, { 'aria-hidden': ' TRUE ' }, { style: 'display:none' }, { style: 'color:red; DISPLAY : NONE !important' }, { style: 'visibility:hidden' }, { style: '/* c */display:none;' }];
  for (const attrs of hiddenOnes) assert.equal(html(page(el('div', attrs, el('p', { id: 'k' }, '藏着'), el('script', null, 'x')), el('p', null, '留下'))), '<p>留下</p>', JSON.stringify(attrs));
  for (const attrs of [{ 'aria-hidden': 'false' }, { style: 'display:block' }, { style: 'color:red' }, { style: 'x-display:none' }]) assert.equal(html(page(el('div', attrs, '看得见'))), '<div>看得见</div>', JSON.stringify(attrs));
  const hiddenScript = render(page(el('p', { hidden: '' }, el('script', null, 'x'))));
  assert.equal(hiddenScript.scripts, 0, '被跳过的节点不访问，里面的 script 不计');
  assert.equal(html(page(elIn(SVG, 'svg', { hidden: '' }))), '', '外来命名空间的根也受影响');
});

// ---- 特殊元素 ----

test('策略表·pre：br 换成换行，丢弃和整个跳过的节点不取，其余只取文字，空白原样；class 不输出', async t => {
  await ready(t);
  const pre = el('pre', { class: 'x' }, '  a', el('br'), 'b', el('span', { class: 'y' }, ' c'), el('script', null, 'x()'), el('b', { hidden: '' }, '隐'), el('style', null, 's'), el('i', null, '\n  d'));
  const result = render(page(pre));
  assert.equal(bodyOf(result), '<pre class="md-code"><code>  a\nb c\n  d</code></pre>');
  assert.equal(result.scripts, 1);
});

test('策略表·pre：语言从 code 或 pre 的 class 里按 (?:^|\\s)(?:language|lang)-([a-z0-9_+-]+) 取，用 Markdown 围栏同一套识别和高亮', async t => {
  await ready(t);
  const code = (preAttrs, codeAttrs, body = 'let a = 1;') => render(page(el('pre', preAttrs, el('code', codeAttrs, body)))).node.children[0];
  const fromCode = code(null, { class: 'foo language-python bar' }, 'def f():\n  return 1');
  assert.equal(fromCode.children[0].className, 'language-python');
  assert.equal(fromCode.textContent, 'def f():\n  return 1');
  assert.ok(byClass(fromCode, 'hljs-keyword').length > 0, '带高亮的节点');
  assert.equal(code({ class: 'lang-js' }, null).children[0].className, 'language-js', 'pre 的 class，lang- 写法');
  assert.equal(code({ class: 'language-js' }, { class: 'language-python' }).children[0].className, 'language-python', 'code 优先');
  assert.equal(code(null, { class: 'language-zzzzz' }).children[0].className, '', '认不出的语言不上色');
  assert.equal(code(null, { class: 'nolanguage-js' }).children[0].className, '', '前面要是开头或空白');
  assert.equal(code(null, { class: 'language-JS' }).children[0].className, '', '大写不认');
});

test('策略表·a：两个 a 之间没有任何文本节点时补一个空格，不分放不放行；有文本节点（含空白）就不多补；内层 a 不算', async t => {
  await ready(t);
  const ext = (label, extra) => el('a', { href: `https://example.com/${label}`, ...extra }, label);
  const link = label => `<a href="https://example.com/${label}" title="https://example.com/${label}">${label}</a>`;
  assert.equal(html(page(ext('A'), ext('B'))), `${link('A')} ${link('B')}`, '两个都出链接');
  assert.equal(html(page(el('a', { href: '/a' }, 'A'), el('a', { href: '/b' }, 'B'))), 'A B', '两个都只留文字（压缩过的导航栏）');
  assert.equal(html(page(ext('A'), el('a', { href: 'javascript:x' }, 'B'))), `${link('A')} B`, '链接后接只留文字');
  assert.equal(html(page(el('a', { href: '/a' }, 'A'), ext('B'))), `A ${link('B')}`, '只留文字后接链接');
  assert.equal(html(page(el('a', { name: 'x' }, 'A'), el('a', null, 'B'))), '<span class="md-anchor"></span>A B', '没有 href 的 a 也算');
  assert.equal(html(page(el('a', { href: '/a' }, 'A'), ' ', el('a', { href: '/b' }, 'B'))), 'A B', '中间已经有空白文本节点，不多补');
  assert.equal(html(page(el('a', { href: '/a' }, 'A'), '、', el('a', { href: '/b' }, 'B'))), 'A、B');
  assert.equal(html(page(el('a', { href: '/a' }, 'A'), el('b', null, '乙'), el('a', { href: '/b' }, 'B'))), 'A<b>乙</b>B', '中间有别的元素带着文字');
  assert.equal(html(page(el('a', { href: '/a' }, 'A', el('a', { href: '/in' }, '内'), el('a', { href: '/in2' }, '内二')))), 'A内内二', '内层的 a 不补');
  assert.equal(html(page(el('a', { href: '/a' }, 'A'), el('br'), el('a', { href: '/b' }, 'B'))), 'A<br></br>B', '中间有别的元素就不补');
});

test('策略表·a：URL 表的链接一列；已经在 a 里的内层 a 只展开内容；两个 a 之间没有任何文本节点时补一个空格', async t => {
  await ready(t);
  const calls = [];
  const options = { basePath: 'docs/a.html', onOpenExternal: href => calls.push(['ext', href]), onOpenRelative: path => calls.push(['rel', path]), onCopyEmail: email => calls.push(['mail', email]) };
  const result = render(page(el('p', null,
    el('a', { href: 'HTTPS://Example.com/a', title: '标题' }, '外'), ' ',
    el('a', { href: 'mailto:a@b.com?subject=x' }, '邮'), ' ',
    el('a', { href: '../b.md?x#y' }, '本'), ' ',
    el('a', { href: 'javascript:alert(1)' }, '脚'), ' ',
    el('a', { href: 'http:foo' }, '无斜杠'), ' ',
    el('a', { href: '/etc/passwd' }, '绝对'), ' ',
    el('a', { href: 'data:image/png;base64,AAAA' }, '数据'), ' ',
    el('a', { href: '//host/a' }, '省协议'))), options);
  const p = result.node.children[0];
  assert.equal(byTag(p, 'a').length, 2, '只有外链和本地的是 a');
  const external = byTag(p, 'a')[0];
  assert.equal(external.getAttribute('href'), 'https://example.com/a');
  assert.equal(external.getAttribute('title'), '标题');
  external.dispatch('click');
  assert.deepEqual(calls.splice(0), [['ext', 'https://example.com/a']]);
  const relative = byClass(p, 'md-rel-link')[0];
  assert.equal(relative.getAttribute('data-rel-path'), 'b.md');
  relative.dispatch('click');
  assert.deepEqual(calls.splice(0), [['rel', 'b.md']]);
  const mailWrap = byClass(p, 'md-mailto-wrap')[0];
  byClass(mailWrap, 'md-copy-email')[0].dispatch('click');
  assert.deepEqual(calls.splice(0), [['mail', 'a@b.com']]);
  assert.equal(byClass(mailWrap, 'md-copy-email')[0].getAttribute('data-rich-ui'), '');
  assert.match(p.textContent, /脚 无斜杠 绝对 数据 省协议$/, '其余只留文字，不套链接');
  // 内层 a 展开、相邻 a 补空格
  assert.equal(html(page(el('a', { href: 'https://example.com/' }, '外', el('a', { href: 'https://other.example/' }, '内')))), '<a href="https://example.com/" title="https://example.com/">外内</a>');
  assert.equal(html(page(el('a', { href: 'https://a.example/' }, 'A'), el('a', { href: 'https://b.example/' }, 'B'))), '<a href="https://a.example/" title="https://a.example/">A</a> <a href="https://b.example/" title="https://b.example/">B</a>');
  assert.equal(html(page(el('a', { href: 'https://a.example/' }, 'A'), '、', el('a', { href: 'https://b.example/' }, 'B'))), '<a href="https://a.example/" title="https://a.example/">A</a>、<a href="https://b.example/" title="https://b.example/">B</a>', '之间有文本节点就不补');
});

// ---- 属性表 ----

test('属性表：colspan、rowspan 取正整数（上限 50、100），其余不是正整数按 1', async t => {
  await ready(t);
  const cell = attrs => html(page(el('table', null, el('tr', null, el('td', attrs)))));
  const rows = n => Array.from({ length: n }, () => el('tr'));
  const spans = (attrs, rowCount) => html(page(el('table', null, el('tr', null, el('td', attrs)), ...rows(rowCount - 1))));
  assert.match(cell({ colspan: '3' }), /<td colspan="3"><\/td>/);
  assert.match(cell({ colspan: '999' }), /<td colspan="50"><\/td>/);
  for (const bad of ['0', '-2', 'abc', '', '1']) assert.match(cell({ colspan: bad }), /<td><\/td>/, bad);
  assert.match(spans({ rowspan: '999' }, 150), /<td rowspan="100"><\/td>/);
  assert.match(spans({ rowspan: '3' }, 5), /<td rowspan="3"><\/td>/);
});

test('属性表：align 属性和内联 style 的 text-align 只认 left、center、right，换成 .md-align-* 类（style 优先）', async t => {
  await ready(t);
  for (const tag of ['p', 'div', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    assert.equal(html(page(el(tag, { align: 'CENTER' }, '字'))), `<${tag === 'div' ? 'div' : tag} class="md-align-center">字</${tag}>`, tag);
  }
  assert.equal(html(page(el('p', { style: 'color:red; text-align : Right !important' }, '字'))), '<p class="md-align-right">字</p>');
  assert.equal(html(page(el('p', { align: 'left', style: 'text-align:center' }, '字'))), '<p class="md-align-center">字</p>', 'style 优先');
  assert.equal(html(page(el('p', { align: 'center', style: 'text-align:justify' }, '字'))), '<p class="md-align-center">字</p>', 'style 的值不认就用 align');
  assert.equal(html(page(el('p', { align: 'justify' }, '字'))), '<p>字</p>');
  assert.equal(html(page(el('span', { align: 'center' }, '字'))), '字', '不在列表里的标签不用');
});

test('属性表：ol 的 start 取整数（±1000000）、reversed；details 的 open；布尔属性只写空串', async t => {
  await ready(t);
  assert.equal(html(page(el('ol', { start: '5', reversed: 'reversed' }))), '<ol start="5" reversed=""></ol>');
  assert.equal(html(page(el('ol', { start: '9999999' }))), '<ol start="1000000"></ol>');
  assert.equal(html(page(el('ol', { start: '-9999999', reversed: '' }))), '<ol start="-1000000" reversed=""></ol>');
  assert.equal(html(page(el('ol', { start: 'x' }))), '<ol></ol>');
  assert.equal(html(page(el('ul', { start: '5', reversed: '' }))), '<ul></ul>', '只用在 ol');
  assert.equal(html(page(el('details', { open: 'open', name: 'g' }, el('summary', null, '摘要')))), '<details open=""><summary>摘要</summary></details>');
});

test('属性表：title 去掉控制字符和 BiDi 覆盖字符、折叠空白、最多 500 字；lang、dir 只认规定的写法', async t => {
  await ready(t);
  assert.equal(html(page(el('p', { title: ' a‮b⁦c\u0007\n d ' }, '字'))), '<p title="abc d">字</p>');
  assert.equal(html(page(el('abbr', { title: 'x'.repeat(600) }, '字'))), `<abbr title="${'x'.repeat(500)}">字</abbr>`);
  assert.equal(html(page(el('p', { title: '‮\u0007' }, '字'))), '<p>字</p>', '清完是空的不写');
  for (const lang of ['zh', 'zh-CN', 'en-US', 'zh-Hant-TW', 'zh-a1-b2-c3-d4']) assert.equal(html(page(el('p', { lang }, '字'))), `<p lang="${lang}">字</p>`, lang);
  for (const lang of ['z', 'zhhh', 'zh_CN', 'zh-', 'zh-x', 'zh-a-b-c-d-e-f', 'zh-123456789', '"><b>', 'en-US-' + 'a'.repeat(40)]) assert.equal(html(page(el('p', { lang }, '字'))), '<p>字</p>', lang);
  for (const dir of ['ltr', 'RTL', ' auto ']) assert.equal(html(page(el('p', { dir }, '字'))), `<p dir="${dir.trim().toLowerCase()}">字</p>`, dir);
  assert.equal(html(page(el('p', { dir: 'sideways' }, '字'))), '<p>字</p>');
  assert.equal(html(page(el('bdo', { dir: 'rtl' }, '字'))), '字', '不放行 bdo');
  // 输出的元素都带这三项：行内 code、按钮、pre、math、链接、表格
  assert.equal(html(page(el('code', { title: '码', lang: 'en', dir: 'ltr' }, 'x'))), '<code class="md-inline-code" title="码" lang="en" dir="ltr">x</code>');
  assert.equal(html(page(el('button', { title: '钮', lang: 'en' }, 'x'))), '<span class="md-chip" title="钮" lang="en">x</span>');
  assert.equal(html(page(el('pre', { title: '块', dir: 'rtl' }, 'x'))), '<pre class="md-code" title="块" dir="rtl"><code>x</code></pre>');
  assert.equal(html(page(el('a', { href: 'https://example.com/', title: '链', lang: 'en', dir: 'rtl' }, 'x'))), '<a href="https://example.com/" title="链" lang="en" dir="rtl">x</a>');
  assert.equal(html(page(el('table', { title: '表', lang: 'en' }))), '<div class="md-table-wrap"><table title="表" lang="en"></table></div>');
});

// ---- 锚点 ----

test('锚点：输出的 DOM 不写任何来自文件的 id 或 name；先出现的优先，后来的不覆盖', async t => {
  await ready(t);
  const result = render(page(
    el('h2', { id: 'sec', name: 'nm' }, '标题'),
    el('p', { id: 'sec' }, '重复'),
    el('a', { name: 'legacy' }, '甲'),
    el('a', { id: 'both', name: 'ignored' }),
    el('a', { name: 'sec' }),
    el('input', { name: 'coda', id: 'stage' }),
    el('form', { id: 'tree', name: 'coda' }, el('input', { name: 'x' })),
    el('p', { id: '__proto__' }, 'a'), el('p', { id: 'constructor' }, 'b'), el('p', { id: 'toString' }, 'c')));
  for (const node of nodesOf(result.node)) {
    if (!node.attributes) continue;
    assert.equal(node.attributes.has('id'), false);
    assert.equal(node.attributes.has('name'), false);
  }
  assert.equal(result.anchors.get('sec').tagName, 'H2', '先出现的优先');
  assert.equal(result.anchors.get('legacy').className, 'md-anchor', 'a 的 name');
  assert.equal(result.anchors.has('ignored'), false, '有 id 就不用 name');
  assert.ok(result.anchors.has('both'));
  assert.equal(result.anchors.get('tree').tagName, 'DIV', 'form 换成 div，登记输出的 div');
  assert.equal(result.anchors.has('coda'), false, 'input 整个丢弃，不登记');
  assert.equal(result.anchors.has('stage'), false);
  assert.equal(result.anchors.get('__proto__').textContent, 'a');
  assert.equal(result.anchors.get('constructor').textContent, 'b');
  assert.equal(result.anchors.get('toString').textContent, 'c');
  assert.equal(result.anchors instanceof Map, true);
});

test('锚点：自身不出元素的（未知标签、label、noscript）在产出的内容前面插一个空的 span.md-anchor，登记它', async t => {
  await ready(t);
  const result = render(page(el('p', null, '前', el('span', { id: 'x' }, '乙'), '后')));
  assert.equal(inner(result.node), '<p>前<span class="md-anchor"></span>乙后</p>');
  assert.equal(result.anchors.get('x').className, 'md-anchor');
  assert.equal(result.anchors.get('x').children.length, 0);
  for (const tag of ['label', 'noscript', 'font']) assert.equal(render(page(el(tag, { id: 'y' }, 'z'))).anchors.get('y').className, 'md-anchor', tag);
  assert.equal(render(page(el('span', { id: 'x' }, 'a'), el('span', { id: 'x' }, 'b'))).node.find(node => node.classList.contains('md-anchor')).length, 1, '重复的 id 不再插 span');
});

test('锚点：登记的总是元素（pre、占位、图片包装、table 的外包），被整棵丢弃或整个跳过的节点不登记', async t => {
  await ready(t);
  const result = render(page(
    el('p', { id: 'hidden1', hidden: '' }, '甲'), el('div', { id: 'hidden2', style: 'display:none' }, '乙'), el('script', { id: 'gone' }), el('title', { id: 'gone2' }),
    el('p', { id: 'hidden1' }, '丙'),
    el('pre', { id: 'code' }, 'x'), el('iframe', { id: 'frame' }), el('img', { id: 'pic', src: 'a.png' }), el('table', { id: 'tbl' }, el('tr', null, el('td', null, 'x')))), { basePath: 'a.html', resolveImage: p => p });
  assert.equal(result.anchors.get('hidden1').textContent, '丙', '隐藏的同名 id 不会抢在后面可见的目标前面');
  assert.equal(result.anchors.has('hidden2') || result.anchors.has('gone') || result.anchors.has('gone2'), false);
  assert.equal(result.anchors.get('code').tagName, 'PRE');
  assert.equal(result.anchors.get('frame').className, 'md-img-fallback secondary');
  assert.equal(result.anchors.get('pic').className, 'md-img-box');
  assert.equal(result.anchors.get('tbl').className, 'md-table-wrap');
});

test('锚点：点 #片段先取消默认导航，百分号解码后精确查 Map，查到就展开遮住它的 details 再滚过去，查不到什么也不做', async t => {
  await ready(t);
  const result = render(page(
    el('a', { href: '#sec%20a' }, '去'), el('a', { href: '#%E0%A4%A' }, '坏编码'), el('a', { href: '#nowhere' }, '没有'),
    el('h2', { id: 'sec a' }, '标题'), el('h2', { id: '%E0%A4%A' }, '坏'),
    el('details', null, el('summary', null, '摘要'), el('details', null, el('summary', null, '里'), el('p', { id: 'deep' }, '深'))), el('a', { href: '#deep' }, '深链')));
  const scrolled = [];
  for (const node of nodesOf(result.node)) if (node.tagName) node.scrollIntoView = () => scrolled.push(node.tagName === 'P' ? 'P' : node.textContent);
  const click = label => {
    const link = byTag(result.node, 'a').find(node => node.textContent === label);
    let prevented = 0;
    link.dispatch('click', { preventDefault: () => { prevented++; } });
    return prevented;
  };
  assert.equal(click('去'), 1, '取消默认导航');
  assert.deepEqual(scrolled.splice(0), ['标题'], '百分号解码后精确查');
  assert.equal(click('坏编码'), 1);
  assert.deepEqual(scrolled.splice(0), ['坏'], '解码失败用原文');
  assert.equal(click('没有'), 1, '查不到也要取消默认导航');
  assert.deepEqual(scrolled.splice(0), []);
  const [outer, innerDetails] = byTag(result.node, 'details');
  assert.equal(click('深链'), 1);
  assert.equal(outer.getAttribute('open'), '');
  assert.equal(innerDetails.getAttribute('open'), '', '一层一层展开');
  assert.deepEqual(scrolled.splice(0), ['P']);
});

// ---- 图片 ----

const b64 = bytes => Buffer.from(bytes).toString('base64');
const be32 = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = n => [n >> 8, n & 255];
const le16 = n => [n & 255, n >> 8];
const le24 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const ascii = s => [...Buffer.from(s, 'latin1')];
const png = (w, h) => b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const gif = (w, h) => b64([...ascii('GIF89a'), ...le16(w), ...le16(h), 0, 0, 0, 0x3b]);
const riff = chunk => [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...chunk];
const webpX = (w, h) => b64(riff([...ascii('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]));
const webpL = (w, h) => b64(riff([...ascii('VP8L'), 5, 0, 0, 0, 0x2f, ...[(w - 1) | ((h - 1) << 14)].flatMap(bits => [bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255])]));
const webpV = (w, h) => b64(riff([...ascii('VP8 '), 10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]));
const jpeg = (w, h, pad = 0, markerBefore = []) => b64([0xff, 0xd8, ...markerBefore, ...(pad ? [0xff, 0xe1, ...be16(pad + 2), ...new Array(pad).fill(0)] : []), 0xff, 0xc0, 0, 17, 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const dataUrl = (type, body) => `data:image/${type};base64,${body}`;
const imageNode = (...srcs) => page(...srcs.map(src => el('img', { src, alt: '图' })));
const shownImages = root => byClass(root, 'md-img');

test('图片：img 建成稳定的包装 span.md-img-box，里面放带 draggable、loading、decoding 的 img.md-img；不保留 width、height、srcset', async t => {
  await ready(t);
  const result = render(page(el('img', { src: 'a.png', alt: '图', title: '提示', width: '10', height: '5', srcset: 'b.png 2x', class: 'x', id: 'y' })), { basePath: 'doc/x.html', resolveImage: path => `svc/${path}` });
  assert.equal(inner(result.node), '<span class="md-img-box"><img class="md-img" loading="lazy" decoding="async" src="svc/doc/a.png" alt="图" title="提示" draggable="false"></img></span>');
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].path, 'doc/a.png');
  assert.equal(result.images[0].img.getAttribute('src'), 'svc/doc/a.png');
});

test('图片：URL 表的图片一列——外链、mailto、#片段、非图片扩展名、危险协议、路径校验不过的都只出占位，不发请求', async t => {
  await ready(t);
  const asked = [];
  const options = { basePath: 'doc/x.html', resolveImage: path => { asked.push(path); return `svc/${path}`; } };
  const bad = ['https://example.com/a.png', 'mailto:a@b.c', '#frag', 'a.txt', 'a.svgz.txt', 'javascript:alert(1)', 'vbscript:x', 'file:///etc/a.png', 'http:foo.png', '//host/a.png', '/abs/a.png', '../../out.png', 'a%2Fb.png', '%2e%2e/a.png', '?q', 'data:text/html;base64,PGI+', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png,AAAA', 'data:image/png;base64,AAAA', ''];
  const result = render(imageNode(...bad), options);
  assert.equal(shownImages(result.node).length, 0);
  assert.deepEqual(asked, [], '不调 resolveImage，没有请求');
  assert.equal(byClass(result.node, 'md-img-fallback').length, bad.length);
  assert.equal(result.node.children[0].textContent, '[外链图片：图]');
  assert.equal(result.node.children[0].getAttribute('title'), 'https://example.com/a.png');
  assert.equal(result.node.children[3].textContent, '[图片：图]');
  assert.equal(render(page(el('img', { src: 'https://x.example/a.png' })), options).node.children[0].textContent, '[外链图片]', '没有说明');
  assert.equal(render(page(el('img', { alt: '无 src' })), options).node.children[0].textContent, '[图片：无 src]');
  assert.equal(render(page(el('img', { src: 'ok.png' }))).node.children[0].textContent, '[图片]', '没有 resolveImage（宿主没有流式服务）');
});

test('图片：加载失败只在包装里面加占位，包装不变；旧正文（isCurrent 为假）的回调直接忽略', async t => {
  await ready(t);
  let current = true;
  const result = render(page(el('p', null, '前', el('img', { src: 'a.png', alt: '图' }), '后')), { basePath: 'x.html', resolveImage: path => path, isCurrent: () => current });
  const p = result.node.children[0];
  const box = p.children[1];
  assert.equal(box.className, 'md-img-box');
  const [entry] = result.images;
  current = false;
  entry.fail();
  assert.equal(box.children.length, 1, '旧正文的回调忽略');
  current = true;
  entry.fail();
  assert.equal(p.children[1], box, '包装还是原来那一个');
  assert.equal(ser(box), `<span class="md-img-box">${PLACEHOLDER('[图片：图]')}</span>`);
  assert.equal(p.children.length, 3, '包装外的文本节点不动');
});

test('图片：每页最多 200 张，data: 和本地图合计，超出的直接占位', async t => {
  await ready(t);
  const tiny = dataUrl('png', png(2, 2));
  const srcs = [...Array.from({ length: 100 }, (_, index) => `l${index}.png`), ...Array.from({ length: 100 }, () => tiny), 'extra.png', tiny];
  const result = render(imageNode(...srcs), { basePath: 'x.html', resolveImage: path => path });
  assert.equal(shownImages(result.node).length, 200);
  assert.equal(result.images.length, 100, '本地图片清单里只有本地的');
  assert.equal(byClass(result.node, 'md-img-fallback').length, 2);
  assert.equal(result.node.children[200].textContent, '[图片：图]');
});

test('图片：data: 位图（png、jpeg、gif、webp 的 VP8、VP8L、VP8X）读头部取宽高后显示；先去掉里面所有空白再整串校验', async t => {
  await ready(t);
  const cases = [['png', png(30, 20), 30, 20], ['jpeg', jpeg(640, 480), 640, 480], ['jpg', jpeg(5, 6), 5, 6], ['gif', gif(7, 9), 7, 9], ['webp', webpX(300, 200), 300, 200], ['webp', webpL(301, 202), 301, 202], ['webp', webpV(100, 50), 100, 50]];
  for (const [type, body, width, height] of cases) {
    assert.deepEqual(dataImageSize(body), { width, height }, `${type} ${width}x${height}`);
    const result = render(imageNode(dataUrl(type, body)));
    assert.equal(shownImages(result.node).length, 1, type);
    assert.equal(result.images.length, 0, 'data: 图不进本地图片清单');
  }
  const wrapped = ` DATA:image/PNG;base64,\n${png(3, 3).slice(0, 10)}\r\n  ${png(3, 3).slice(10)} `;
  const result = render(imageNode(wrapped));
  assert.equal(shownImages(result.node)[0].getAttribute('src'), dataUrl('PNG', png(3, 3)).replace(/^data/, 'DATA'), '输出里是去掉空白后的串');
  const big = jpeg(70, 80, 40000); // SOF 在前 64 KiB 以内
  assert.equal(shownImages(render(imageNode(dataUrl('jpeg', big))).node).length, 1);
  assert.equal(dataImageSize(jpeg(70, 80, 70000)), null, 'SOF 在 64 KiB 之后读不出');
  assert.equal(shownImages(render(imageNode(dataUrl('jpeg', jpeg(70, 80, 70000)))).node).length, 0);
  assert.equal(shownImages(render(imageNode(dataUrl('png', png(0, 5)), dataUrl('png', gif(4, 4)), dataUrl('gif', 'R0lGODlh!!!='), dataUrl('png', `${png(2, 2)}%`))).node).length, 1, '零宽、字符集不对的丢掉；声明成 png 的 gif 头仍按内容读');
});

test('图片：data: 位图的像素预算——单张超过 1600 万像素、整页累计超过 6400 万像素、读不出头部的，换成占位', async t => {
  await ready(t);
  const result = render(imageNode(dataUrl('png', png(4000, 4000)), dataUrl('png', png(4001, 4000)), dataUrl('png', png(4000, 4000)), dataUrl('png', png(4000, 4000)), dataUrl('png', png(4000, 4000)), dataUrl('png', png(1, 1)), dataUrl('png', png(1, 1))));
  const flags = result.node.children.map(node => node.className);
  assert.deepEqual(flags, ['md-img-box', 'md-img-fallback secondary', 'md-img-box', 'md-img-box', 'md-img-box', 'md-img-fallback secondary', 'md-img-fallback secondary'], '4 张 1600 万正好 6400 万；单张超限的不计入累计；之后再多一个像素都不行');
});

test('图片：失败占位的节点在建包装时就计入预算，接近上限时迟到的 error 不会让总数超限', async t => {
  await ready(t);
  const fill = BODY_LIMIT - 1 - 4; // 根 1 个，包装、图片、预留的占位 4 个，正好用满
  const kids = [...Array.from({ length: fill }, () => leaf('p')), { ...leaf('img'), getAttribute: name => (name === 'src' ? 'a.png' : null) }];
  const result = render(bigPage(kids), { basePath: 'x.html', resolveImage: path => path });
  const before = count(result.node);
  result.images[0].fail();
  const after = count(result.node);
  assert.ok(after <= before + 1, '失败后包装里多的节点没有超出预留');
  assert.ok(after - 2 <= BODY_LIMIT, `正文最多 ${BODY_LIMIT} 个（提示另算）`);
  assert.ok(after <= OUTPUT_LIMIT);
});

// ---- 空白和文字 ----

test('空白：pre 以外连续的 [\\t\\r\\n ]+ 规范成一个空格；相邻文字（跨过拆掉的标签）先拼成一个字符串再建节点', async t => {
  await ready(t);
  const p = render(page(el('p', null, ' a\n\t b ', el('span', null, '  c  '), 'd', el('font', null, el('i'), 'e')))).node.children[0];
  assert.equal(ser(p), '<p> a b c d<i></i>e</p>');
  assert.equal(p.children.length, 3, '文字、i、文字');
  const many = el('p', null, ...Array.from({ length: 1000 }, (_, index) => (index % 2 ? el('span', null, 'y') : text('x'))));
  const merged = render(page(many)).node.children[0];
  assert.equal(merged.children.length, 1, '1000 个相邻文本节点拼成一个');
  assert.equal(merged.textContent, 'xy'.repeat(500));
  const bigRun = render(bigPage([{ nodeType: 1, namespaceURI: HTML, localName: 'p', getAttribute: NO_ATTR, childNodes: Array.from({ length: 50000 }, () => ({ nodeType: 3, data: 'ab ' })) }]));
  assert.equal(bigRun.node.children[0].children.length, 1, '5 万个相邻文本节点也是一个');
  assert.equal(inner(render(page(el('pre', null, '  a  \n\n  b'))).node), '<pre class="md-code"><code>  a  \n\n  b</code></pre>', 'pre 原样');
});

test('空白：表格、列表这类只有结构的容器里，元素之间的空白不建节点', async t => {
  await ready(t);
  assert.equal(html(page(el('ul', null, '\n  ', el('li', null, 'a'), '\n  ', el('li', null, 'b'), '\n'))), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(html(page(el('table', null, '\n', el('tbody', null, '\n ', el('tr', null, '\n', el('td', null, '格'), ' ', el('td', null, ' 乙 ')), '\n'), '\n'))), '<div class="md-table-wrap"><table><tbody><tr><td>格</td><td> 乙 </td></tr></tbody></table></div>');
  assert.equal(html(page(el('div', null, '\n ', el('p', null, 'a'), ' ', el('p', null, 'b')))), '<div> <p>a</p> <p>b</p></div>', 'div 里的不动');
});

test('可见文字字数：清洗后输出的文字（不含空白、占位和插件自己的提示）', async t => {
  await ready(t);
  assert.equal(render(page(el('p', null, ' a b\n c '), el('pre', null, ' x y '), el('img', { src: 'a.png', alt: '很长的说明' }), el('iframe'), el('p', { hidden: '' }, '隐藏的文字'))).visibleChars, 5);
  assert.equal(render(page(el('p', null, '中文'))).visibleChars, 2);
});

// ---- 上限（第 27.4 节）----

const notices = root => find(root, node => node.attributes.has('data-rich-ui') && node.classList.contains('md-note'));
const TRUNCATED = '内容太多，后面没有显示，可以切到源码看';

test('上限·输入：清洗器单独喂超大的树，遍历最多 30 万个源节点，到了就停并写提示', async t => {
  await ready(t);
  const scripts = n => bigPage(Array.from({ length: n }, () => leaf('script')));
  const over = render(scripts(INPUT_LIMIT + 100_000));
  assert.equal(over.scripts, INPUT_LIMIT - 2, '30 万个节点里 html 和 body 占两个，其余都是被访问到的 script');
  assert.equal(over.capped, true);
  assert.equal(notices(over.node).filter(node => node.textContent === TRUNCATED).length, 1);
  assert.equal(render(scripts(INPUT_LIMIT - 2)).capped, true, '正好 30 万个：到上限就停，也算触到');
  const below = render(scripts(INPUT_LIMIT - 3));
  assert.equal(below.capped, false);
  assert.equal(below.scripts, INPUT_LIMIT - 3);
  assert.equal(notices(below.node).filter(node => node.textContent === TRUNCATED).length, 0, '没到上限就没有截断提示');
});

test('上限·输入：pre 取字、math 取文字、button 找文字共用同一个输入计数，不另外无界扫描', async t => {
  await ready(t);
  const texts = n => Array.from({ length: n }, () => ({ nodeType: 3, data: 'x' }));
  const node = (ns, tag, kids, attrs = null) => ({ nodeType: 1, namespaceURI: ns, localName: tag, getAttribute: attrFn(attrs), childNodes: kids });
  // html、body、pre 占 3 个，pre 里能取到 INPUT_LIMIT - 3 个文本节点
  const pre = render(bigPage([node(HTML, 'pre', texts(INPUT_LIMIT + 5000))]));
  assert.equal(pre.node.children[0].textContent.length, INPUT_LIMIT - 3);
  assert.equal(pre.capped, true);
  const math = render(bigPage([node(HTML, 'p', [node(MATH, 'math', texts(INPUT_LIMIT + 5000))])]));
  assert.equal(math.node.children[0].textContent.length, INPUT_LIMIT - 4, 'html、body、p、math 占 4 个');
  assert.equal(math.capped, true);
  const button = render(bigPage([node(HTML, 'button', Array.from({ length: INPUT_LIMIT + 5000 }, () => ({ nodeType: 3, data: ' ' })))]));
  assert.equal(button.capped, true);
  assert.equal(button.node.find(el => el.classList.contains('md-chip')).length, 0, '没找到文字就丢掉');
  const sharedWithMain = render(bigPage([node(HTML, 'pre', texts(150_000)), node(HTML, 'pre', texts(150_000))]));
  assert.equal(sharedWithMain.capped, true, '主遍历和子遍历加起来才到 30 万');
  assert.ok(sharedWithMain.node.children[0].textContent.length === 150_000 && sharedWithMain.node.children[1].textContent.length < 150_000);
});

test('上限·输出：正好用到上限、超出 1 个，提示都在，总数都不超过 10 万；输出上限里只为提示预留 16 个', async t => {
  await ready(t);
  const ps = n => bigPage(Array.from({ length: n }, () => leaf('p')));
  const exact = render(ps(BODY_LIMIT - 1)); // 根 1 个 + 这些 p 正好是预算
  assert.equal(count(exact.node) - 2, BODY_LIMIT, '去掉提示的 2 个');
  assert.equal(exact.capped, true);
  assert.equal(notices(exact.node)[0].textContent, TRUNCATED);
  const over = render(ps(BODY_LIMIT));
  assert.equal(count(over.node) - 2, BODY_LIMIT, '超出的那 1 个没有输出');
  assert.equal(over.capped, true);
  assert.equal(notices(over.node)[0].textContent, TRUNCATED);
  assert.ok(count(over.node) <= OUTPUT_LIMIT && count(exact.node) <= OUTPUT_LIMIT);
  const below = render(ps(BODY_LIMIT - 2));
  assert.equal(below.capped, false);
  assert.equal(count(below.node), BODY_LIMIT - 1);
  assert.equal(notices(below.node).length, 0);
});

test('上限·输出：超大的 pre（高亮节点放不下）退回纯文本；包装、占位、高亮产生的节点都计入预算', async t => {
  await ready(t);
  const remaining = 5;
  const code = Array.from({ length: 200 }, (_, index) => `var a${index} = ${index};`).join('\n');
  const kids = [...Array.from({ length: BODY_LIMIT - 1 - remaining }, () => leaf('p')), { ...leaf('pre'), getAttribute: name => (name === 'class' ? 'language-js' : null), childNodes: [{ nodeType: 3, data: code }] }];
  const result = render(bigPage(kids));
  const pre = byTag(result.node, 'pre')[0];
  assert.equal(count(pre), 3, '高亮要产生几百个节点，放不下，退回 pre、code、文字');
  assert.equal(pre.textContent, code);
  assert.ok(count(result.node) <= OUTPUT_LIMIT);
  assert.equal(result.capped, false, '纯文本 3 个放得下');
  const highlighted = render(page(el('pre', { class: 'language-js' }, code)));
  assert.ok(count(byTag(highlighted.node, 'pre')[0]) > 100, '预算够时高亮的节点照出');
});

test('上限·输出：「内容很少」提示从普通预算里支出，不动预留的 16 个：预算用满时不写，总数不超过 10 万', async t => {
  await ready(t);
  const full = render(bigPage([leaf('script'), ...Array.from({ length: BODY_LIMIT + 10 }, () => leaf('p'))]));
  assert.equal(full.scripts, 1);
  assert.equal(full.capped, true);
  assert.deepEqual(notices(full.node).map(node => node.textContent), [TRUNCATED], '普通预算已经用满，没有位置写「内容很少」，只有截断提示');
  assert.equal(count(full.node) - 2, BODY_LIMIT, '去掉截断提示的 2 个，普通输出正好是 99984');
  // 还剩 4 个位置时：提示写进去，仍在普通预算内
  const roomy = render(bigPage([leaf('script'), ...Array.from({ length: BODY_LIMIT - 1 - 4 }, () => leaf('p'))]));
  assert.equal(fewNotices(roomy.node).length, 1);
  assert.equal(count(roomy.node) - notices(roomy.node).filter(node => node.textContent === TRUNCATED).length * 2, BODY_LIMIT, '4 个节点算进普通预算');
  assert.ok(count(roomy.node) <= OUTPUT_LIMIT);
  const tight = render(bigPage([leaf('script'), ...Array.from({ length: BODY_LIMIT - 1 - 3 }, () => leaf('p'))]));
  assert.equal(fewNotices(tight.node).length, 0, '只剩 3 个，写不下就不写');
  assert.equal(tight.capped, true);
  assert.ok(count(tight.node) - 2 <= BODY_LIMIT);
});

// 带读取记录的大节点：每个子节点第一次被读（任何属性）时记下下标。
const probed = (n, make) => {
  const reads = new Set();
  const kids = Array.from({ length: n }, (_, index) => {
    const node = make(index);
    return new Proxy(node, { get(target, key) { reads.add(index); return target[key]; } });
  });
  return { kids, reads };
};
const farthest = reads => { let far = -1; for (const index of reads) if (index > far) far = index; return far; };
const plain = (tag, kids = NO_KIDS) => ({ nodeType: 1, namespaceURI: HTML, localName: tag, getAttribute: NO_ATTR, childNodes: kids });

test('上限·子遍历（#1）：pre、math、label、按钮、表格行组预读读每个子节点之前都先过共享的输入预算，停下之后后面的节点一个都没读到', async t => {
  await ready(t);
  const over = INPUT_LIMIT + 50_000;
  const cases = {
    pre: probed(over, () => ({ nodeType: 3, data: 'x' })),
    label: probed(over, () => ({ nodeType: 3, data: 'x' })),
    button: probed(over, () => ({ nodeType: 3, data: ' ' })),
    math: probed(over, () => ({ nodeType: 3, data: 'x' })),
    'tbody 预读': probed(over, () => plain('tr')),
    'thead 预读': probed(over, () => plain('tr')),
  };
  const tag = { pre: 'pre', label: 'label', button: 'button', 'tbody 预读': 'tbody', 'thead 预读': 'thead' };
  for (const [name, probe] of Object.entries(cases)) {
    const parent = name === 'math' ? { ...plain('p', [{ nodeType: 1, namespaceURI: MATH, localName: 'math', getAttribute: NO_ATTR, childNodes: probe.kids }]) } : plain(tag[name], probe.kids);
    const result = render(bigPage(name.endsWith('预读') ? [plain('table', [parent])] : [parent]));
    assert.equal(result.capped, true, name);
    assert.ok(farthest(probe.reads) < INPUT_LIMIT, `${name}：最远读到第 ${farthest(probe.reads)} 个，上限之后的节点不该被读`);
    assert.ok(farthest(probe.reads) >= INPUT_LIMIT - 10, `${name}：上限之前的都读了（${farthest(probe.reads)}）`);
  }
});

test('上限·子遍历（#1）：表格行组预读和主遍历共用同一个计数——预读用掉的次数，主遍历不再重复看到上限之后的行', async t => {
  await ready(t);
  const rows = probed(INPUT_LIMIT * 2, () => plain('tr', [plain('td')]));
  const result = render(bigPage([plain('table', [plain('tbody', rows.kids)])]));
  assert.equal(result.capped, true);
  assert.equal(byTag(result.node, 'tr').length, 0, '预读就把预算用完了，主遍历一行都没输出');
  assert.ok(farthest(rows.reads) < INPUT_LIMIT);
});

// ---- 计费（#2）----

test('折叠计费（#2）：容器按实际结构结算，没折叠的不占着预算；大量空 nav 后面的段落照样在，普通输出不超过 99984', async t => {
  await ready(t);
  const navs = Array.from({ length: 30_000 }, () => plain('nav'));
  const result = render(bigPage([...navs, { ...plain('p'), childNodes: [{ nodeType: 3, data: '后面的段落' }] }]));
  assert.equal(result.capped, false, '3 万个空 nav 每个只占 1 个节点');
  assert.equal(result.node.children.at(-1).textContent, '后面的段落');
  assert.equal(count(result.node), 1 + 30_000 + 2);
  const asides = Array.from({ length: 30_000 }, () => plain('aside'));
  const noMain = render(bigPage([...asides, plain('p')]));
  assert.equal(noMain.capped, false, '没有 main、article，aside 都不折叠，不预扣');
  assert.equal(noMain.node.children.length, 30_001);
});

test('折叠计费（#2）：真折叠的按实际生成的 details、summary、文字结算；预算不够折叠时停在预算内', async t => {
  await ready(t);
  const link = { ...plain('a'), getAttribute: name => (name === 'href' ? 'https://example.com/' : null) };
  const nav = () => plain('nav', [link, link, link, link]);
  const folded = render(bigPage(Array.from({ length: 2000 }, nav)));
  assert.equal(byClass(folded.node, 'md-landmark').length, 2000);
  assert.equal(count(folded.node), 1 + 2000 * (1 + 4 + 3 + 3), '每个 nav：div 1、4 个链接 4、相邻链接之间补的空格 3，details、summary、文字 3');
  const many = render(bigPage([plain('main'), ...Array.from({ length: 40_000 }, () => plain('aside'))]));
  assert.equal(many.capped, true, '4 万个 aside 折叠要 16 万个节点，放不下');
  assert.ok(count(many.node) - 2 <= BODY_LIMIT, `${count(many.node)}`);
  assert.ok(byClass(many.node, 'md-landmark').length > 19_000, '预算用完之前的照常折叠');
  const full = render(bigPage([...Array.from({ length: BODY_LIMIT - 1 - 3 }, () => plain('p')), plain('nav', [link, link, link, link])]));
  assert.ok(count(full.node) - 2 <= BODY_LIMIT);
});

// ---- 深度（#3）----

const elementDepth = root => {
  let deepest = 0;
  const todo = [[root, 0]];
  while (todo.length) {
    const [node, level] = todo.pop();
    if (typeof node.tagName === 'string') deepest = Math.max(deepest, level);
    for (const kid of node.children ?? []) todo.push([kid, level + 1]);
  }
  return deepest;
};

test('嵌套（#3）：锚点 span、占位、图片包装、代码块、行内 TeX 都按实际包装深度检查，层数用完并入第 256 层', async t => {
  await ready(t);
  const math = elIn(MATH, 'math', null, elIn(MATH, 'semantics', null, elIn(MATH, 'annotation', { encoding: 'application/x-tex' }, 'x^2')));
  const contents = () => [el('pre', { class: 'language-js' }, 'var a = 1; // 注释'), el('img', { src: 'a.png', alt: '图' }), el('span', { id: 'mark' }, '带 id'), el('iframe'), math, elIn(SVG, 'svg', null), el('video'), el('p', null, '尾')];
  for (const depthOfDiv of [250, 253, 254, 255, 256, 257, 300]) {
    let tree = el('div', null, ...contents());
    for (let i = 1; i < depthOfDiv; i++) tree = el('div', null, tree);
    const result = render(page(tree), { basePath: 'x.html', resolveImage: path => path });
    assert.ok(elementDepth(result.node) <= 256, `${depthOfDiv} 层 div：最深的元素在第 ${elementDepth(result.node)} 层`);
    assert.ok(result.node.textContent.includes('var a = 1;'), `${depthOfDiv}：代码文字还在`);
    assert.ok(result.node.textContent.includes('x^2'), `${depthOfDiv}：TeX 文字还在`);
    assert.ok(result.node.textContent.includes('带 id') && result.node.textContent.includes('尾'));
    const target = result.anchors.get('mark');
    assert.ok(target && typeof target.tagName === 'string', `${depthOfDiv}：带 id 的元素登记的总是元素`);
    assert.ok(target.contains ? result.node.contains(target) : true, `${depthOfDiv}：登记的元素在输出里`);
  }
});

test('嵌套（#3）：深度正好放得下就照常输出；放不下时按能放下的最大形式降级（图片退成占位，代码块退成纯文本）', async t => {
  await ready(t);
  const chain = (n, ...kids) => { let tree = el('div', null, ...kids); for (let i = 1; i < n; i++) tree = el('div', null, tree); return page(tree); };
  const at = (n, ...kids) => render(chain(n, ...kids), { basePath: 'x.html', resolveImage: path => path });
  assert.equal(byClass(at(254, el('img', { src: 'a.png' })).node, 'md-img-box').length, 1, '254 层里还放得下包装加图片（2 层）');
  assert.equal(byClass(at(255, el('img', { src: 'a.png' })).node, 'md-img-box').length, 0, '255 层只剩 1 层：出占位');
  assert.equal(byClass(at(255, el('img', { src: 'a.png' })).node, 'md-img-fallback').length, 1);
  assert.equal(byClass(at(256, el('img', { src: 'a.png' })).node, 'md-img-fallback').length, 0, '256 层一层也不剩：丢掉，不超层');
  const code = 'var a = 1;';
  assert.equal(byTag(at(252, el('pre', { class: 'language-js' }, code)).node, 'pre').length, 1);
  assert.ok(byClass(at(252, el('pre', { class: 'language-js' }, code)).node, 'hljs-keyword').length > 0, '放得下高亮的层数就高亮');
  const tight = at(254, el('pre', { class: 'language-js' }, code));
  assert.equal(byClass(tight.node, 'hljs-keyword').length, 0, '放不下高亮的 span，退回纯文本');
  assert.equal(byTag(tight.node, 'pre')[0].textContent, code);
  assert.equal(byTag(at(255, el('pre', null, code)).node, 'pre').length, 0, '连 pre、code 两层都放不下：并入当前这一层');
});

// ---- label 和按钮（#4）----

test('label（#4）：只取允许显示的文字，不保留子元素和图片，图片不进本地清单；自己的锚点照旧登记', async t => {
  await ready(t);
  const result = render(page(el('p', null, el('label', { id: 'lab', title: '被忽略' }, '名称 ', el('b', null, '粗'), el('img', { src: 'a.png', alt: '图' }), el('a', { href: 'https://example.com/' }, '链'), el('script', null, 'x()'), el('span', { hidden: '' }, '隐'), el('style', null, 's{}'), el('input'), ' 尾'))), { basePath: 'x.html', resolveImage: path => path });
  assert.equal(bodyOf(result), '<p><span class="md-anchor"></span>名称 粗链 尾</p>');
  assert.deepEqual(result.images, [], '图片不进本地清单');
  assert.equal(byTag(result.node, 'img').length + byTag(result.node, 'b').length + byTag(result.node, 'a').length, 0);
  assert.equal(result.anchors.get('lab').className, 'md-anchor');
  assert.equal(result.scripts, 1);
});

test('按钮（#4）：按清洗后留下的文字决定出不出，只有占位文字（嵌入内容、图片、视频、画布、被丢弃或跳过的字）的不出 chip', async t => {
  await ready(t);
  const options = { basePath: 'x.html', resolveImage: path => path };
  for (const kids of [[el('iframe', null, '后备文字')], [el('object', null, '后备')], [el('canvas', null, '画布后备')], [el('video', null, '视频后备')], [el('audio', null, '音频后备')], [el('img', { src: 'a.png', alt: '图' })], [elIn(SVG, 'svg', { width: '10', height: '10' }, elIn(SVG, 'title', null, '图标'))], [el('span', { hidden: '' }, '藏'), el('script', null, 'x'), el('style', null, 'y'), el('select', null, el('option', null, '选项'))], ['  ', el('span', null, '\n')]]) {
    const result = render(page(el('button', null, ...kids)), options);
    assert.equal(byClass(result.node, 'md-chip').length, 0, JSON.stringify(kids.map(kid => kid.localName ?? kid.data)));
    assert.equal(result.visibleChars, 0);
  }
  const result = render(page(el('button', null, el('iframe'), '确定', el('img', { src: 'a.png' }))), options);
  assert.equal(byClass(result.node, 'md-chip').length, 1, '有真正的文字才留');
  assert.equal(byClass(result.node, 'md-chip')[0].textContent, '[嵌入内容]确定');
});

// ---- 属性策略（#5）----

const ATTRS = { title: ' 标‮题 ', lang: 'en', dir: 'rtl' };
const policy = node => [node.getAttribute('title'), node.getAttribute('lang'), node.getAttribute('dir')];

test('属性策略（#5）：折叠容器、图片、占位、mailto 这些分支，在代表源元素的输出节点上套用同一份 title、lang、dir', async t => {
  await ready(t);
  const links = Array.from({ length: 4 }, (_, index) => el('a', { href: `https://example.com/${index}` }, `项${index}`));
  const expected = ['标题', 'en', 'rtl'];
  // 折叠（nav 和 aside）、不折叠的 nav
  const nav = render(page(el('nav', ATTRS, ...links)));
  assert.deepEqual(policy(byClass(nav.node, 'md-landmark')[0].parent), expected, '折叠的 nav：包着 details 的那个 div');
  const aside = render(page(el('aside', ATTRS, '侧'), el('main', null, '主')));
  assert.equal(byClass(aside.node, 'md-landmark').length, 1);
  assert.deepEqual(policy(aside.node.children[0]), expected, '折叠的 aside');
  assert.deepEqual(policy(render(page(el('nav', ATTRS, '短'))).node.children[0]), expected, '没折叠的 nav');
  // 图片：能显示的，title 在 img 上，lang、dir 在包装和 img 上；占位上是全套
  const shown = render(page(el('img', { src: 'a.png', ...ATTRS })), { basePath: 'x.html', resolveImage: path => path });
  const box = shown.node.children[0];
  const img = byTag(box, 'img')[0];
  assert.deepEqual(policy(img), expected);
  assert.deepEqual([box.getAttribute('lang'), box.getAttribute('dir')], ['en', 'rtl']);
  assert.deepEqual(policy(render(page(el('img', { src: 'a.txt', ...ATTRS }))).node.children[0]), expected, '非图片的占位');
  assert.deepEqual(policy(render(page(el('img', { src: 'data:image/png;base64,AAAA', ...ATTRS }))).node.children[0]), expected, '读不出的 data:');
  const remote = render(page(el('img', { src: 'https://example.com/a.png', ...ATTRS }))).node.children[0];
  assert.deepEqual(policy(remote), expected, '外链图片的占位：作者的 title 压过地址');
  assert.equal(render(page(el('img', { src: 'https://example.com/a.png', lang: 'en' }))).node.children[0].getAttribute('title'), 'https://example.com/a.png', '作者没写 title 时保留地址');
  // 各种占位
  for (const source of [el('iframe', ATTRS), el('canvas', ATTRS), el('video', { ...ATTRS, src: 'a.mp4' }), el('audio', ATTRS), elIn(SVG, 'svg', { width: '100', height: '100', ...ATTRS }), el('object', ATTRS), el('embed', ATTRS)]) {
    const out = render(page(source)).node.children[0];
    assert.equal(out.className, 'md-img-fallback secondary', source.localName);
    assert.deepEqual(policy(out), expected, source.localName);
  }
  // mailto：作者的 title 留在包装上，lang、dir 同
  const mail = render(page(el('a', { href: 'mailto:a@b.c', ...ATTRS }, '写信'))).node.children[0];
  assert.equal(mail.className, 'md-mailto-wrap');
  assert.deepEqual(policy(mail), expected);
  assert.equal(byClass(mail, 'md-copy-email')[0].getAttribute('title'), '复制邮箱：a@b.c', '按钮自己的提示不变');
  assert.equal(render(page(el('a', { href: 'mailto:a@b.c' }, '写信'))).node.children[0].getAttribute('title'), null, '没有 title 就没有');
});

// ---- MathML（#6）----

test('math（#6）：先判断整棵是否跳过，再选 TeX 注释；带 hidden 的注释不能拿来替换公式', async t => {
  await ready(t);
  const math = (...kids) => elIn(MATH, 'math', null, elIn(MATH, 'semantics', null, elIn(MATH, 'mi', null, 'x'), elIn(MATH, 'mo', null, '+'), elIn(MATH, 'mn', null, '1'), ...kids));
  const ann = (attrs, value) => elIn(MATH, 'annotation', { encoding: 'application/x-tex', ...attrs }, value);
  assert.equal(html(page(el('p', null, math(ann({ hidden: '' }, '被藏的 TeX'))))), '<p>x+1</p>', '只有隐藏的注释：按取文字');
  assert.equal(html(page(el('p', null, math(ann({ style: 'display:none' }, '藏一'), ann({ 'aria-hidden': 'true' }, '藏二'))))), '<p>x+1</p>');
  assert.equal(html(page(el('p', null, math(ann({ hidden: '' }, '藏'), ann(null, '可见的 TeX'))))), '<p><code class="md-inline-code">可见的 TeX</code></p>', '隐藏的跳过，取后面可见的');
  assert.equal(html(page(el('p', null, elIn(MATH, 'math', null, elIn(MATH, 'mrow', { hidden: '' }, elIn(MATH, 'semantics', null, ann(null, '在隐藏的 mrow 里')), elIn(MATH, 'mi', null, '藏')), elIn(MATH, 'mi', null, 'y'))))), '<p>y</p>', '注释在被跳过的子树里也不能用');
  assert.equal(html(page(el('p', null, elIn(MATH, 'math', { hidden: '' }, ann(null, '整个跳过'))))), '<p></p>', '整棵 math 带 hidden');
});

test('math（#6）：取文字的退路也走锚点——带 id 的 math 登记 span.md-anchor，#equation 能跳过去；TeX 路径登记输出的代码节点', async t => {
  await ready(t);
  const text = elIn(MATH, 'math', { id: 'equation' }, elIn(MATH, 'mi', null, 'x'), elIn(MATH, 'annotation', { encoding: 'application/x-tex', hidden: '' }, 'tex'));
  const tex = elIn(MATH, 'math', { id: 'tex' }, elIn(MATH, 'annotation', { encoding: 'application/x-tex' }, 'a^2'));
  const block = elIn(MATH, 'math', { id: 'blk', display: 'block' }, elIn(MATH, 'annotation', { encoding: 'application/x-tex' }, 'b^2'));
  const result = render(page(el('a', { href: '#equation' }, '去公式'), el('p', null, '前 ', text, ' 后'), el('p', null, tex), block));
  assert.equal(result.anchors.get('equation').className, 'md-anchor');
  assert.equal(result.anchors.get('tex').tagName, 'CODE');
  assert.equal(result.anchors.get('blk').tagName, 'PRE');
  const scrolled = [];
  result.anchors.get('equation').scrollIntoView = () => scrolled.push('equation');
  byTag(result.node, 'a')[0].dispatch('click');
  assert.deepEqual(scrolled, ['equation'], '点 #equation 跳到公式的位置');
  assert.equal(byTag(result.node, 'p')[0].textContent, '前 x 后');
});

test('上限·嵌套：最多 256 层，更深的并入第 256 层；迭代遍历，很深的源树不会爆栈', async t => {
  await ready(t);
  let tree = el('div', null, '深处');
  for (let i = 0; i < 299; i++) tree = el('div', null, tree);
  const result = render(page(tree));
  assert.equal(depth(result.node) - 1, 256, '最深的元素在第 256 层（文字再深一层）');
  assert.equal(result.node.textContent, '深处');
  let spans = { nodeType: 3, data: 'x' };
  for (let i = 0; i < 100_000; i++) spans = { nodeType: 1, namespaceURI: HTML, localName: 'span', getAttribute: NO_ATTR, childNodes: [spans] };
  assert.equal(render(bigPage([spans])).node.textContent, 'x');
  let blocks = { nodeType: 3, data: 'y' };
  for (let i = 0; i < 20_000; i++) blocks = { nodeType: 1, namespaceURI: HTML, localName: 'blockquote', getAttribute: NO_ATTR, childNodes: [blocks] };
  const deep = render(bigPage([blocks]));
  assert.equal(depth(deep.node) - 1, 256);
  assert.equal(deep.node.textContent, 'y');
});

// ---- 表格（第 27.4 节）----

const cellOf = (attrs, body = 'x') => el('td', attrs, body);
const row = (...cells) => el('tr', null, ...cells);
const spansOf = root => find(root, node => node.tagName === 'TD' || node.tagName === 'TH').map(node => `${node.getAttribute('colspan') ?? 1}x${node.getAttribute('rowspan') ?? 1}`);
const tableNote = root => find(root, node => node.attributes.has('data-rich-ui') && node.textContent === '表格太大，后面省略');
const cells = n => Array.from({ length: n }, () => cellOf(null));

test('表格预算·单行 101 格：第 101 格放不下，后面的单元格都不再输出，表格下方写提示（带 data-rich-ui）', async t => {
  await ready(t);
  const result = render(page(el('table', null, row(...cells(101)), row(...cells(3))), el('p', null, '表后')));
  assert.equal(byTag(result.node, 'td').length, 100);
  assert.equal(byTag(result.node, 'tr').length, 1, '后面的行也不输出');
  assert.equal(tableNote(result.node).length, 1);
  assert.equal(result.node.children[0].className, 'md-table-wrap');
  assert.equal(result.node.children[1].textContent, '表格太大，后面省略', '提示在表格外包的下面');
  assert.equal(result.node.children[2].textContent, '表后');
  assert.equal(result.capped, false);
  assert.equal(byTag(render(page(el('table', null, row(...cells(100))))).node, 'td').length, 100, '100 格正好');
});

test('表格预算·整张表已占的格数不超过 1 万：10001 个 1×1 放不下最后一个', async t => {
  await ready(t);
  const rows = Array.from({ length: 101 }, (_, index) => row(...cells(index < 100 ? 100 : 1)));
  const result = render(page(el('table', null, ...rows)));
  assert.equal(byTag(result.node, 'td').length, 10_000);
  assert.equal(tableNote(result.node).length, 1);
  const exactly = render(page(el('table', null, ...rows.slice(0, 100))));
  assert.equal(byTag(exactly.node, 'td').length, 10_000);
  assert.equal(tableNote(exactly.node).length, 0, '正好 1 万格不提示');
});

test('表格预算·大跨度先缩成 1×1 再算一次：面积超出剩余预算的缩成 1×1，缩了还是放不下才省略', async t => {
  await ready(t);
  const rows = (...first) => [row(...first), ...Array.from({ length: 99 }, () => row())];
  const full = render(page(el('table', null, ...rows(cellOf({ colspan: '50', rowspan: '100' }), cellOf({ colspan: '50', rowspan: '100' })))));
  assert.deepEqual(spansOf(full.node), ['50x100', '50x100'], '两格各 5000，正好 1 万');
  assert.equal(tableNote(full.node).length, 0);
  const third = render(page(el('table', null, ...rows(cellOf({ colspan: '50', rowspan: '100' }), cellOf({ colspan: '50', rowspan: '100' }), cellOf(null)))));
  assert.deepEqual(spansOf(third.node), ['50x100', '50x100'], '第三格放不下（这一行已经 100 列）');
  assert.equal(tableNote(third.node).length, 1);
  // 前 9999 格之后，colspan=2 的面积 2 超出剩余预算，缩成 1×1 放进去（正好 1 万）；再多一格就放不下
  const filler = [...Array.from({ length: 199 }, () => row(...cells(50))), row(...cells(49), cellOf({ colspan: '2' }))];
  const shrink = render(page(el('table', null, ...filler)));
  assert.equal(byTag(shrink.node, 'td').length, 10_000);
  assert.equal(spansOf(shrink.node).at(-1), '1x1');
  assert.equal(tableNote(shrink.node).length, 0);
  const over = render(page(el('table', null, ...filler, row(...cells(1)))));
  assert.equal(byTag(over.node, 'td').length, 10_000);
  assert.equal(tableNote(over.node).length, 1);
});

test('表格预算·rowspan 占行：下一行的单元格放在第一个空着的列', async t => {
  await ready(t);
  // 第一行：A rowspan=2 占第 0 列，B、C 占第 1～99 列；第二行：D 在第 1 列放 50 格，E 从第 51 列起放不下 50 格，缩成 1×1
  const carried = render(page(el('table', null, row(cellOf({ rowspan: '2' }), cellOf({ colspan: '50' }), cellOf({ colspan: '49' })), row(cellOf({ colspan: '50' }), cellOf({ colspan: '50' })))));
  assert.deepEqual(spansOf(carried.node), ['1x2', '50x1', '49x1', '50x1', '1x1']);
  // 对照：没有 rowspan 时第二行从第 0 列放，两个 50 格正好 100 列
  const plain = render(page(el('table', null, row(cellOf(null), cellOf({ colspan: '50' }), cellOf({ colspan: '49' })), row(cellOf({ colspan: '50' }), cellOf({ colspan: '50' })))));
  assert.deepEqual(spansOf(plain.node), ['1x1', '50x1', '49x1', '50x1', '50x1']);
});

test('表格预算·重叠：第一行第二格 rowspan=2、第二行第一格 colspan=2，压到已占的格，跨度直接改成 1×1', async t => {
  await ready(t);
  const result = render(page(el('table', null, row(cellOf(null), cellOf({ rowspan: '2' })), row(cellOf({ colspan: '2' }), cellOf(null)))));
  assert.deepEqual(spansOf(result.node), ['1x1', '1x2', '1x1', '1x1']);
  // 矩形不压到已占的格就保留：第二行 D 放第 0 列，列 0～1，不碰第 2 列的 C；它的 rowspan 被行组只剩的一行截到 1
  const free = render(page(el('table', null, row(cellOf(null), cellOf(null), cellOf({ rowspan: '2' })), row(cellOf({ colspan: '2', rowspan: '2' })))));
  assert.deepEqual(spansOf(free.node), ['1x1', '1x1', '1x2', '2x1']);
  // 三行的行组里 2×2 保留；它占的格让第三行的单元格往右放
  const grown = render(page(el('table', null, row(cellOf(null), cellOf({ colspan: '2', rowspan: '2' })), row(cellOf(null)), row(cellOf({ colspan: '50' }), cellOf({ colspan: '50' })))));
  assert.deepEqual(spansOf(grown.node), ['1x1', '2x2', '1x1', '50x1', '50x1'], '第三行的 50 格从第 0 列放，不被第二行的占用影响；两个 50 格正好 100 列');
});

test('表格预算·行组：rowspan 不延伸出所在的行组；换到下一个 thead、tbody、tfoot 时结转的占用清零', async t => {
  await ready(t);
  const result = render(page(el('table', null,
    el('thead', null, row(el('th', { rowspan: '3' }, 'H'), el('th', null, 'H2'))),
    el('tbody', null, row(cellOf({ colspan: '50' }), cellOf({ colspan: '50' })), row(cellOf({ rowspan: '5' }), cellOf(null)), row(cellOf(null))),
    el('tfoot', null, row(cellOf({ colspan: '50' }), cellOf({ colspan: '50' }))))));
  // thead 只有 1 行，rowspan=3 截到 1；tbody 第一行没有 thead 结转的占用，两个 50 格正好 100 列；rowspan=5 在 tbody 里只剩 2 行；tfoot 也从第 0 列开始
  assert.deepEqual(spansOf(result.node), ['1x1', '1x1', '50x1', '50x1', '1x2', '1x1', '1x1', '50x1', '50x1']);
});

test('表格预算·多张表同时触发：九张各 101 格的表，每张都输出 100 格并在下方写提示', async t => {
  await ready(t);
  const result = render(page(...Array.from({ length: 9 }, () => el('table', null, row(...cells(101))))));
  assert.equal(byTag(result.node, 'td').length, 900);
  assert.equal(tableNote(result.node).length, 9);
  assert.equal(result.capped, false);
});

test('表格预算·提示计入普通输出预算：预算不够写提示的那张表，直接触发全局截断', async t => {
  await ready(t);
  // 根 1 + 外包 1 + table 1 + tr 1 + 100 个 td = 104；留 1 个位置给提示的 2 个节点，放不下
  const used = 1 + 1 + 1 + 1 + 100;
  const kids = [...Array.from({ length: BODY_LIMIT - used - 1 }, () => leaf('p'))];
  const td = leaf('td');
  const table = { ...leaf('table'), childNodes: [{ ...leaf('tr'), childNodes: Array.from({ length: 101 }, () => td) }] };
  const result = render(bigPage([...kids, table]));
  assert.equal(tableNote(result.node).length, 0, '没有写提示');
  assert.equal(result.capped, true);
  assert.equal(notices(result.node)[0].textContent, TRUNCATED);
  assert.ok(count(result.node) <= OUTPUT_LIMIT);
  const roomy = render(bigPage([...kids.slice(0, kids.length - 10), table]));
  assert.equal(tableNote(roomy.node).length, 1, '预算够就写');
  assert.equal(roomy.capped, false);
});

test('嵌套表格：最多 3 层，第 4 层起整张表降级（table、thead、tbody、tfoot、tr 换成 div，caption 换成 p，td、th 换成 span，相邻两格之间补「 | 」）', async t => {
  await ready(t);
  const level4 = el('table', null, el('caption', null, '标题'), el('thead', null, row(el('th', { colspan: '2' }, '甲'), el('th', null, '乙'))), el('tbody', null, row(cellOf(null, '丙'), cellOf({ rowspan: '2' }, '丁'))), el('tfoot', null, row(cellOf(null, '戊'))));
  const level3 = el('table', null, row(el('td', null, '三层', level4)));
  const level2 = el('table', null, row(el('td', null, level3)));
  const level1 = el('table', null, row(el('td', null, level2)));
  const result = render(page(level1));
  assert.equal(byTag(result.node, 'table').length, 3, '前 3 层还是 table');
  const degraded = byTag(result.node, 'td')[2].children[1];
  assert.equal(degraded.tagName, 'DIV');
  assert.equal(ser(degraded), '<div><p>标题</p><div><div><span>甲</span> | <span>乙</span></div></div><div><div><span>丙</span> | <span>丁</span></div></div><div><div><span>戊</span></div></div></div>', '没有 colspan、rowspan，没有 table 元素');
  assert.equal(byTag(degraded, 'table').length + byTag(degraded, 'td').length + byTag(degraded, 'tr').length, 0);
  const deeper = el('table', null, row(el('td', null, el('table', null, row(el('td', null, el('table', null, row(el('td', null, el('table', null, row(el('td', null, el('table', null, row(cellOf(null, '五')))))))))))))));
  assert.equal(byTag(render(page(deeper)).node, 'table').length, 3, '第 5 层也降级');
});

test('表格：正常的表格保留 thead、tbody、tfoot、caption、th、td，跨度输出的就是计费用的那个值', async t => {
  await ready(t);
  const result = render(page(el('table', { class: 'x', style: 'width:100%', border: '1' }, el('caption', null, '表题'), el('colgroup', null, el('col')), el('thead', null, row(el('th', { scope: 'col', colspan: '2' }, '头'))), el('tbody', null, row(cellOf(null, 'a'), cellOf(null, 'b'))))));
  assert.equal(inner(result.node), '<div class="md-table-wrap"><table><caption>表题</caption><thead><tr><th colspan="2">头</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table></div>');
});

// ---- 「内容很少」----

const fewNotices = root => find(root, node => node.attributes.has('data-rich-ui') && node.textContent.startsWith('静态预览里内容很少'));
const A_LOT = 'a'.repeat(80);

test('内容很少：只有 head 里有脚本、body 是空的，提示「页面的脚本没有运行」并给「看源码」按钮，都带 data-rich-ui', async t => {
  await ready(t);
  let viewed = 0;
  const result = render(doc(el('html', null, el('head', null, el('script', null, 'x()')), el('body'))), { onViewSource: () => { viewed++; } });
  assert.equal(result.scripts, 1);
  assert.equal(result.visibleChars, 0);
  const [note] = fewNotices(result.node);
  assert.equal(note.textContent, '静态预览里内容很少，页面的脚本没有运行看源码');
  assert.equal(note, result.node.children[0], '在正文顶部');
  const [button] = byTag(note, 'button');
  assert.equal(button.textContent, '看源码');
  assert.equal(button.getAttribute('data-rich-ui'), '');
  button.dispatch('click');
  assert.equal(viewed, 1);
});

test('内容很少：短的静态页带统计脚本，文字少于 80 字也提示；刚好 80 字不提示；没有脚本不提示', async t => {
  await ready(t);
  assert.equal(fewNotices(render(page(el('p', null, '短短的一页'), el('script', null, 'ga()'))).node).length, 1);
  assert.equal(fewNotices(render(page(el('p', null, 'a'.repeat(79)), el('script'))).node).length, 1);
  assert.equal(fewNotices(render(page(el('p', null, A_LOT), el('script'))).node).length, 0, '80 字');
  assert.equal(fewNotices(render(page(el('p', null, ' a '.repeat(40)), el('script'))).node).length, 1, '空白不计，40 个 a 是 40 字');
  assert.equal(fewNotices(render(page(el('p', null, ' a '.repeat(80)), el('script'))).node).length, 0, '80 个 a 夹空白');
  assert.equal(fewNotices(render(page(el('p', null, '短短的一页'))).node).length, 0, '没有脚本，只是短，不提示');
  assert.equal(fewNotices(render(page(el('p', null, '正文'), el('noscript', null, el('script')))).node).length, 1, 'noscript 里的 script 也算');
  assert.equal(fewNotices(render(page(el('div', { hidden: '' }, el('script')), el('p', null, '短'))).node).length, 0, '被跳过的 script 不算');
});

// ---- 入口 ----

test('renderHtml：用 new DOMParser().parseFromString(text, "text/html") 解析，DOMParser 和树都可以注入', async t => {
  await ready(t);
  const calls = [];
  class FakeParser {
    parseFromString(source, type) { calls.push([source, type]); return page(el('h1', null, '标题'), el('p', null, source.slice(0, 2))); }
  }
  const result = renderHtml('正文<p>', { DOMParser: FakeParser });
  assert.deepEqual(calls, [['正文<p>', 'text/html']]);
  assert.equal(inner(result.node), '<h1>标题</h1><p>正文</p>');
  assert.equal(result.node.className, 'md selectable');
  assert.deepEqual(Object.keys(result).sort(), ['anchors', 'capped', 'images', 'node', 'scripts', 'title', 'visibleChars']);
  assert.equal(renderHtml(undefined, { DOMParser: FakeParser }).node.children.length, 2, '没有文本也能解析');
  assert.equal(inner(sanitizeHtml(el('p', null, '单个元素当根')).node), '<p>单个元素当根</p>', '树可以直接注入，不一定是文档节点');
});

test('清洗器只读 nodeType、data、namespaceURI、localName、getAttribute、childNodes（读别的属性的假树会抛错）', async t => {
  await ready(t);
  const bad = strict({ nodeType: 1, namespaceURI: HTML, localName: 'p', getAttribute: () => null, childNodes: [], textContent: 'x' });
  assert.throws(() => bad.textContent, /不该读的属性/);
  assert.equal(inner(render(page(bad, el('p', null, '正文'), el('table', null, row(el('th', { colspan: '2' }, '格'))), el('details', { open: '' }, el('summary', null, 's')), el('a', { href: '#x', id: 'x' }, 'l'), el('pre', null, el('code', { class: 'language-js' }, 'a')))).node).startsWith('<p></p><p>正文</p>'), true);
});
