// 开发用：真实 Chrome 验收页内 HTML 预览的清洗器（设计第 27.8 节「harness」）。Node 单测只用假树，量不出真实浏览器里的解析和资源行为：
// 1) 只解析（DOMParser，不挂载）：探针请求为 0；挂载之后：探针请求为 0，页面全局信标不触发；
// 2) 输出里只有表内的元素和属性（值也查：链接、图片地址），没有来自文件的 id、name，插件自己的元素和全局对象没有被覆盖；
// 3) 正对照：合法的本地图片必须发起请求并显示，允许的 data: 位图必须显示，<p>正文</p> 原样留着，伪造的 data-rich-ui 被丢掉、内容仍能查找；
// 4) 两种 CSP 各跑一遍：宿主等价 CSP（正常功能不受影响），不加 CSP（抓「错误地写进输出、只是被 CSP 挡住」的泄漏）；
// 5) 性能：1 MiB、约 10 万节点，从解析到首次布局不超过 500 ms；对渲染结果建查找索引、找到第一处不超过 300 ms。
// 6) 接入页（真实的 view/preview.mjs 和 style.css，不加 CSP）：宽窗口和窄窗口下正文铺满、表格和代码块不溢出；
//    GBK 页面在预览和源码里都不乱码，开着查找来回切换，两边都找得到中文，高亮落在当前显示的那份正文里。
// 被测模块（view/html.mjs、view/find.mjs 和它们的静态依赖）读出来合成一个内联模块写进测试页，不从服务器加载脚本；
// 服务器只做「流式服务」的替身：统计探针路径、合法图片路径和其余一切请求。不是产品代码；自己起服务、Chrome 和临时目录，用完全部清理。
// 用法：node test/harness/html-preview.mjs [Chrome 的路径]（也认 CHROME_PATH）；任何一条不符，退出码非 0。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const CHROME_CANDIDATES = [
  process.argv[2],
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

const STARTUP_MS = 30000, CALL_MS = 20000, EVAL_MS = 90000, WAIT_MS = 15000;
const PERF_RENDER_MS = 500, PERF_FIND_MS = 300; // 设计第 27.8 节的阈值，CI 慢也不放宽
const PERF_RUNS = 3; // 取中位数；每次的值都打印
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viewDir = path.join(repoRoot, 'view');
const BASE_PATH = 'docs/sub/page.html'; // 被预览的文件：相对路径都以 docs/sub 为基准
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (promise, ms, what) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}超时（${ms / 1000} 秒）`)), ms); })]).finally(() => clearTimeout(timer)); };

// 宿主插件页面 CSP，取自 Coda 0.3.34 之后（2026-11-23）的源码，逐条照搬；只把 img-src 里的 coda-view: 换成测试服务的图片路径。
const hostCsp = origin => `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' coda-view: blob:; style-src 'unsafe-inline' coda-view:; img-src ${origin}/img/legit/ data: blob:; media-src coda-view: data: blob:; font-src coda-view: data:; connect-src coda-view: data: blob:; worker-src coda-view: blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
const MODES = [{ name: 'host', label: '宿主等价 CSP' }, { name: 'open', label: '不加 CSP' }];

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='; // 1×1
const GIF_B64 = 'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='; // 1×1
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');

// ---- 把被测模块合成一个内联模块 ----

// 从 entries 出发沿静态 import 走一遍，每个模块包进自己的函数作用域（各模块里有同名的私有函数），依赖先于使用者。
// 只改行首的 import / export 语句；最后用 vm.Script 编译整段：还剩任何 import / export / import.meta，编译就失败。
async function bundleModules(entries) {
  const sources = new Map(), order = [], state = new Map();
  const IMPORT_RE = /^import\s*(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*'([^']+)'\s*;?[ \t]*$/gm;
  const visit = async key => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'busy') throw new Error(`循环依赖：${key}`);
    state.set(key, 'busy');
    const code = await readFile(path.join(viewDir, key), 'utf8');
    sources.set(key, code);
    for (const match of code.matchAll(IMPORT_RE)) await visit(path.posix.join(path.posix.dirname(key), match[3]));
    state.set(key, 'done');
    order.push(key);
  };
  for (const entry of entries) await visit(entry);
  const parts = ['const __fac = {}, __cache = {};', 'const __mod = key => __cache[key] ??= (() => { const e = {}; __fac[key](e); return e; })();'];
  for (const key of order) {
    const exported = [];
    let code = sources.get(key)
      .replace(IMPORT_RE, (_, def, named, spec) => {
        const dep = JSON.stringify(path.posix.join(path.posix.dirname(key), spec));
        const out = [];
        if (def) out.push(`const ${def} = __mod(${dep}).default;`);
        if (named) out.push(`const { ${named.split(',').map(item => item.trim()).filter(Boolean).map(item => item.replace(/^([\w$]+)\s+as\s+([\w$]+)$/, '$1: $2')).join(', ')} } = __mod(${dep});`);
        return out.join(' ');
      })
      .replace(/^export\s+((?:async\s+)?function\*?|const|let|var|class)\s+([\w$]+)/gm, (_, kind, name) => { exported.push(`${JSON.stringify(name)}: ${name}`); return `${kind} ${name}`; })
      .replace(/^export\s*\{([^}]*)\}\s*;?/gm, (_, list) => {
        for (const item of list.split(',').map(x => x.trim()).filter(Boolean)) {
          const [local, as = local] = item.split(/\s+as\s+/);
          exported.push(`${JSON.stringify(as)}: ${local}`);
        }
        return '';
      })
      .replace(/(^|[;}])export\s+default\s+([\w$]+)\s*;/gm, (_, lead, name) => { exported.push(`"default": ${name}`); return lead; }); // 压缩过的语言文件里它跟在分号后面
    code += `\nObject.assign(__exports, { ${exported.join(', ')} });`;
    parts.push(`__fac[${JSON.stringify(key)}] = __exports => {\n${code}\n};`);
  }
  parts.push(`const __MODULES__ = { ${entries.map(entry => `${JSON.stringify(entry.replace(/\.mjs$/, ''))}: __mod(${JSON.stringify(entry)})`).join(', ')} };`);
  const bundle = parts.join('\n');
  new vm.Script(bundle, { filename: 'html-preview-bundle' }); // 还剩 import / export 这里就抛 SyntaxError
  return bundle;
}

// 内联进 <script> 里：不能出现 </script，<!-- 也要打断（hljs 里有 /<!--/）。
const scriptSafe = code => code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

// ---- 测试页里跑的代码（Function.toString 内联进页面，所以不能引用外面的任何东西）----

function pageMain({ html, find }, config) {
  const { renderHtml } = html;
  const { buildRichIndex, findRich, rangeAt } = find;
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const observe = async () => { await frames(); await sleep(500); }; // 观察窗口：两帧 rAF 再加 500 ms
  const waitFor = async (check, what, ms) => {
    const deadline = performance.now() + ms;
    while (!check()) {
      if (performance.now() > deadline) throw new Error(`等不到：${what}`);
      await sleep(20);
    }
  };

  // 插件自己的东西：真实的 window.coda、#stage、#tree。清洗输出挂在它们前面（DOM 顺序在前的同名元素会抢走 getElementById）。
  const sentinel = Object.freeze({ open() {} });
  window.coda = sentinel;
  const stageEl = document.getElementById('stage'), treeEl = document.getElementById('tree'), casesEl = document.getElementById('cases'), perfEl = document.getElementById('perf');
  const bodyEl = document.body;
  window.__BEACON = [];
  const errors = [], cspEvents = [], opened = [], unintercepted = [];
  window.addEventListener('error', event => errors.push(String(event.message)));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  document.addEventListener('securitypolicyviolation', event => cspEvents.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
  // 点击兜底：插件自己建的链接都会自己拦下默认行为；没拦下的就是它不该产出的原始链接，记下来，并且不让它真的导航。
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (link && !event.defaultPrevented) unintercepted.push(link.getAttribute('href'));
    event.preventDefault();
  });

  const resolveImage = rel => `/img/legit/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const options = id => ({
    basePath: config.basePath, resolveImage, isCurrent: () => true, onViewSource: () => {},
    onOpenExternal: url => opened.push({ id, url }), onOpenRelative: () => {}, onCopyEmail: () => {},
  });

  // ---- 输出审计：白名单在这里独立写一份，不读 html.mjs 的表 ----
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const TAGS = new Set('h1 h2 h3 h4 h5 h6 p blockquote ul ol li dl dt dd caption thead tbody tfoot tr th td hr br details summary figure figcaption strong b em i s del strike u ins kbd samp var sub sup mark small abbr q cite dfn time table div span a img pre code button'.split(' '));
  const COMMON = new Set(['class', 'title', 'lang', 'dir', 'data-rich-ui']);
  const EXTRA = {
    a: ['href', 'data-rel-path'], img: ['src', 'alt', 'loading', 'decoding', 'draggable'], ol: ['start', 'reversed'], details: ['open'],
    td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], button: ['type', 'data-email', 'aria-label'],
  };
  const CLASS_OK = /^(md(-[a-z-]+)?|secondary|selectable|language-[a-z0-9_+-]+|hljs(-[a-z_.-]+)*|[a-z]+_)$/;
  const PLUGIN_UI = ['.md-note', '.md-note-action', '.md-img-fallback', '.md-copy-email'];
  const BAD_TITLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
  const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i;

  const audit = section => {
    const problems = [];
    for (const el of section.querySelectorAll('*')) {
      const tag = el.localName;
      if (el.namespaceURI !== XHTML) { problems.push(`非 HTML 命名空间的元素：${el.namespaceURI} ${tag}`); continue; }
      if (!TAGS.has(tag)) { problems.push(`表外的元素：${tag}`); continue; }
      const allowed = new Set([...COMMON, ...(EXTRA[tag] ?? [])]);
      for (const { name, value } of el.attributes) {
        if (!allowed.has(name)) { problems.push(`表外的属性：${tag}[${name}]`); continue; }
        if (name === 'class') { for (const token of value.split(/\s+/).filter(Boolean)) if (!CLASS_OK.test(token)) problems.push(`表外的类：${tag}.${token}`); }
        else if (name === 'title') { if (value.length > 500 || BAD_TITLE.test(value)) problems.push(`title 没清洗：${tag}`); }
        else if (name === 'lang') { if (value.length > 35 || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,4}$/.test(value)) problems.push(`lang 不合规：${value}`); }
        else if (name === 'dir') { if (!['ltr', 'rtl', 'auto'].includes(value)) problems.push(`dir 不合规：${value}`); }
        else if (name === 'href') { if (!(/^https?:\/\/[^/\s]/i.test(value) || value.startsWith('#'))) problems.push(`href 不是 http(s) 或锚点：${value.slice(0, 80)}`); }
        else if (name === 'data-rel-path') { if (/^[/\\]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value) || /(^|\/)\.\.(\/|$)/.test(value)) problems.push(`data-rel-path 越界：${value.slice(0, 80)}`); }
        else if (name === 'src') { if (!(DATA_IMAGE.test(value) || value.startsWith('/img/legit/'))) problems.push(`img src 不是允许的 data: 位图或流式服务地址：${value.slice(0, 80)}`); }
        else if (name === 'loading') { if (value !== 'lazy') problems.push(`loading=${value}`); }
        else if (name === 'decoding') { if (value !== 'async') problems.push(`decoding=${value}`); }
        else if (name === 'draggable') { if (value !== 'false') problems.push(`draggable=${value}`); }
        else if (name === 'type') { if (value !== 'button') problems.push(`button type=${value}`); }
        else if (name === 'start') { if (!/^-?\d+$/.test(value) || Math.abs(Number(value)) > 1_000_000) problems.push(`start=${value}`); }
        else if (name === 'colspan') { if (!/^\d+$/.test(value) || Number(value) > 50) problems.push(`colspan=${value}`); }
        else if (name === 'rowspan') { if (!/^\d+$/.test(value) || Number(value) > 100) problems.push(`rowspan=${value}`); }
        else if (name === 'data-rich-ui') {
          if (!PLUGIN_UI.some(selector => el.matches(selector)) && !(tag === 'summary' && el.parentElement?.classList.contains('md-landmark'))) problems.push(`伪造的 data-rich-ui：${tag}`);
        }
      }
    }
    if (section.querySelector('[id], [name]')) problems.push('输出里有 id 或 name');
    return problems;
  };

  const expectations = (c, section, result) => {
    const out = [], e = c.expect ?? {}, text = section.textContent;
    for (const s of e.text ?? []) if (!text.includes(s)) out.push(`缺文字：${s}`);
    for (const s of e.noText ?? []) if (text.includes(s)) out.push(`不该有文字：${s}`);
    for (const [selector, n] of Object.entries(e.has ?? {})) {
      const got = section.querySelectorAll(selector).length;
      if (got !== n) out.push(`${selector} 应有 ${n} 个，实有 ${got}`);
    }
    for (const selector of e.none ?? []) if (section.querySelector(selector)) out.push(`不该有 ${selector}`);
    for (const selector of e.loaded ?? []) {
      const images = [...section.querySelectorAll(selector)];
      if (!images.length || !images.every(img => img.complete && img.naturalWidth > 0)) out.push(`${selector} 没有都显示出来（${images.map(img => `${img.complete}/${img.naturalWidth}`).join(',')}）`);
    }
    if (e.find) {
      const index = buildRichIndex(result.node);
      for (const term of e.find) if (findRich(index, term, 1).list.length < 1) out.push(`查找不到：${term}`);
    }
    for (const key of e.anchors ?? []) if (!result.anchors.has(key)) out.push(`锚点表里没有：${key}`);
    for (const [key, text2] of Object.entries(e.anchorText ?? {})) if (!result.anchors.get(key)?.textContent.includes(text2)) out.push(`锚点 ${key} 没有指向含「${text2}」的节点`);
    if (e.richUi !== undefined && section.querySelectorAll('[data-rich-ui]').length !== e.richUi) out.push(`data-rich-ui 应有 ${e.richUi} 个，实有 ${section.querySelectorAll('[data-rich-ui]').length}`);
    if (e.exactHtml !== undefined && result.node.innerHTML !== e.exactHtml) out.push(`输出不是 ${e.exactHtml}：${result.node.innerHTML.slice(0, 200)}`);
    return out;
  };

  let cases = [];
  const parsed = [], results = new Map(), initial = new Map();
  const api = {
    setCases(list) { cases = list; return cases.length; },
    // 探针：页面外的图片请求，宿主 CSP 下被挡（并触发违规事件），不加 CSP 时必须到达服务器——证明计数是灵敏的。
    async canary() {
      new Image().src = `${config.origin}/probe/PROBE-canary~.png`;
      await observe();
      return { cspEvents: cspEvents.map(event => event.blocked) };
    },
    // 只解析：调用 DOMParser，不挂载。
    async parseOnly() {
      for (const c of cases) parsed.push(new DOMParser().parseFromString(c.html, 'text/html'));
      await observe();
      return parsed.length;
    },
    // 挂载：每条样例一个叠在左上角的 section（让 loading=lazy 的图片都落在可视区里），挂载后等同样的观察窗口，再等图片加载完。
    async mountAll() {
      const failed = [];
      for (const c of cases) {
        const section = document.createElement('section');
        section.dataset.case = c.id;
        casesEl.append(section);
        try {
          const result = renderHtml(c.html, options(c.id));
          section.append(result.node);
          initial.set(c.id, audit(section)); // 立刻审计初始输出：图片失败的回调会移除 img，等图片结束之后再审计会漏掉写错的 src
          results.set(c.id, result);
        } catch (error) { failed.push(`${c.id}: ${error?.stack ?? error}`); }
      }
      await observe();
      await waitFor(() => [...document.images].every(img => img.complete), '所有图片加载完（或失败）', 10000);
      await frames();
      return { mounted: results.size, failed };
    },
    // 审计：逐条查输出、点所有链接和按钮，再等一个观察窗口。
    async audit() {
      const report = { cases: {}, globals: [], beacon: [], errors, cspEvents: [], opened, unintercepted, texts: {} };
      for (const c of cases) {
        const section = casesEl.querySelector(`[data-case="${c.id}"]`), result = results.get(c.id);
        if (!result) { report.cases[c.id] = { problems: ['没有渲染结果'], html: '' }; continue; }
        for (const el of section.querySelectorAll('a, button')) el.click();
      }
      await observe();
      for (const c of cases) {
        const section = casesEl.querySelector(`[data-case="${c.id}"]`), result = results.get(c.id);
        if (!result) continue;
        const problems = [...(initial.get(c.id) ?? []).map(problem => `初始输出：${problem}`), ...audit(section), ...expectations(c, section, result)];
        if (problems.length) report.cases[c.id] = { problems, html: section.innerHTML.slice(0, 600) };
      }
      const ids = [...document.querySelectorAll('[id]')].map(el => el.id).sort().join(',');
      for (const [name, ok] of [
        ['window.coda 被替换', window.coda === sentinel],
        ['getElementById("stage") 不是插件自己的 #stage', document.getElementById('stage') === stageEl],
        ['getElementById("tree") 不是插件自己的 #tree', document.getElementById('tree') === treeEl],
        ['window.stage 不是 #stage', window.stage === stageEl],
        ['window.tree 不是 #tree', window.tree === treeEl],
        ['document.getElementById 被覆盖', typeof document.getElementById === 'function' && Function.prototype.toString.call(document.getElementById).includes('[native code]')],
        ['document.cookie 被覆盖', typeof document.cookie === 'string'],
        ['document.body 被覆盖', document.body === bodyEl],
        ['document.forms 不为空', document.forms.length === 0],
        ['document.querySelector 被覆盖', typeof document.querySelector === 'function' && Function.prototype.toString.call(document.querySelector).includes('[native code]')],
        ['页面里多了 id', ids === 'cases,perf,stage,tree'],
        ['页面里有 name', document.querySelector('[name]') === null],
        ['Object.prototype 被污染', Object.keys(Object.prototype).length === 0 && ({}).constructor === Object],
        ['__BEACON 被覆盖', Array.isArray(window.__BEACON)],
      ]) if (!ok) report.globals.push(name);
      report.beacon = [...window.__BEACON];
      report.cspEvents = [...cspEvents];
      return report;
    },
    // 性能样例：约 1 MiB、约 10 万个节点。
    async perf() {
      const COUNT = 10000, TARGET = 1_040_000;
      const item = (i, pad) => `<p>Paragraph ${i} Lorem ipsum dolor sit amet <b>consectetur</b> adipiscing elit, <i>sed do</i> ${pad}.</p>\n`;
      const pad = 'x'.repeat(Math.max(0, Math.floor((TARGET - COUNT * item(5000, '').length) / COUNT)));
      const parts = ['<!doctype html><html><head><title>perf</title></head><body>'];
      for (let i = 0; i < COUNT; i++) parts.push(item(i, i === COUNT - 1 ? `${pad} PERFNEEDLE` : pad));
      parts.push('</body></html>');
      const text = parts.join('');
      const bytes = new TextEncoder().encode(text).length;
      const countNodes = root => { const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL); let n = 0; while (walker.nextNode()) n++; return n; };
      const sourceNodes = countNodes(new DOMParser().parseFromString(text, 'text/html'));
      const runs = [];
      let info = null;
      for (let i = 0; i < 3; i++) {
        perfEl.replaceChildren();
        await frames();
        const t0 = performance.now();
        const result = renderHtml(text, options('perf'));
        perfEl.append(result.node);
        perfEl.getBoundingClientRect(); // 强制布局
        void perfEl.offsetHeight;
        const t1 = performance.now();
        const index = buildRichIndex(result.node);
        const found = findRich(index, 'PERFNEEDLE', 2);
        const range = found.list.length ? rangeAt(index, found.list[0], () => document.createRange()) : null;
        const t2 = performance.now();
        runs.push({ renderMs: t1 - t0, findMs: t2 - t1, matches: found.list.length, rangeText: range?.toString() });
        info = { bytes, sourceNodes, outputNodes: countNodes(result.node), capped: result.capped, indexNodes: index.nodes.length };
      }
      perfEl.replaceChildren();
      return { info, runs };
    },
  };
  window.__H = api;
  window.__BOOT__ = { mode: config.mode, modules: { html: Object.keys(html).sort(), find: Object.keys(find).sort() } };
  document.body.dataset.boot = 'ready'; // 启动标记：被测模块已经运行
}

const pageHtml = (bundle, css, config) => `<!doctype html><html><head><meta charset="utf-8"><title>html-preview harness</title>
<style>${css.replace(/<\/style/gi, '<\\/style')}
#cases section { position: absolute; top: 0; left: 0; width: 360px; }
#perf { position: relative; width: 800px; }</style></head>
<body><div id="cases"></div><div id="stage"></div><div id="tree"></div><div id="perf"></div>
<script type="module">
${scriptSafe(`${bundle}\n(${pageMain.toString()})(__MODULES__, ${JSON.stringify(config)});`)}
</script></body></html>`;

// ---- 接入页：真实的 preview.mjs 和 style.css ----

const layoutPageHtml = `<!doctype html><html><head><meta charset="utf-8"><title>html-preview 接入页</title><link rel="stylesheet" href="/view/style.css"></head>
<body style="margin:0;height:800px;display:flex;flex-direction:column">
<div id="p" class="preview" style="flex:1;min-height:0"></div>
<script type="module">
import { mountPreview } from '/view/preview.mjs';
let preview = null;
const q = selector => document.querySelector(selector);
window.__L = {
  async open(name, b64) {
    preview?.close();
    const size = atob(b64).length;
    preview = mountPreview(q('#p'), { read: async () => ({ kind: 'text', data: b64, offset: 0, size, mtimeMs: 1, eof: true }), copy: () => {} });
    await preview.open(name);
  },
  find(term) {
    if (!preview.findOpen) preview.openFind();
    const field = q('.finput');
    field.value = term;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  },
  mode(label) { [...document.querySelectorAll('.pmode button')].find(button => button.textContent === label).click(); },
  // 查找的高亮：数量、第一处的文字、它落在预览（.md）还是源码（.text）里。
  highlight() {
    const ranges = [...(CSS.highlights.get('find') ?? [])], first = ranges[0];
    const host = first?.startContainer.parentElement;
    return { count: ranges.length, text: first?.toString() ?? null, where: host?.closest('.md') ? 'preview' : host?.closest('.text') ? 'source' : null, counter: q('.fcount')?.textContent ?? null };
  },
  measure() {
    const body = q('.pbody'), md = q('.md'), cs = getComputedStyle(body), box = el => el.getBoundingClientRect();
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), wraps = [...document.querySelectorAll('.md-table-wrap')], code = q('.md-code');
    return {
      body: body.clientWidth - pad, bodyScroll: body.scrollWidth, bodyClient: body.clientWidth, md: box(md).width, mdRight: box(md).right,
      wraps: wraps.map(wrap => ({ right: box(wrap).right, width: wrap.clientWidth, scroll: wrap.scrollWidth, table: box(wrap.querySelector('table')).width })),
      code: { right: box(code).right, width: box(code).width, scroll: code.scrollWidth, client: code.clientWidth },
    };
  },
  text: () => q('.md')?.textContent ?? null,
  source: () => q('.text')?.textContent ?? null,
  meta: () => q('.pmeta').textContent,
};
</script></body></html>`;

const bytesOf = text => Buffer.from(text).toString('base64');
const WIDE_PAGE = bytesOf(`<h1>标题</h1><p>正文 ${'a'.repeat(300)}</p>
<table><tr><th>名称</th><th>数量</th><th>备注</th></tr><tr><td>苹果</td><td>3</td><td>新鲜</td></tr></table>
<table><tr>${Array.from({ length: 12 }, (_, i) => `<th>列${i}</th>`).join('')}</tr><tr>${Array.from({ length: 12 }, (_, i) => `<td>${'w'.repeat(40)}${i}</td>`).join('')}</tr></table>
<pre>const padding = '${'x'.repeat(400)}';</pre>`);
// 「中文」「编码」的 GBK 字节（Node 没有 GBK 编码器）。
const GBK_PAGE = Buffer.concat([Buffer.from('<meta charset="gbk"><p>'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('</p><p>'), Buffer.from([0xb1, 0xe0, 0xc2, 0xeb]), Buffer.from('</p>')]).toString('base64');

async function runLayout(port) {
  const nav = await send('Page.navigate', { url: `http://127.0.0.1:${port}/page/layout` });
  if (nav.errorText) throw new Error(`接入页打不开：${nav.errorText}`);
  await until('window.__L !== undefined', '接入页启动（真实的 preview.mjs 加载成功）');
  const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1, `${what}：${actual} 应约等于 ${expected}`);

  for (const width of [1400, 360]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.__L.open('docs/wide.html', ${JSON.stringify(WIDE_PAGE)})`);
    await until(`document.querySelector('.md') !== null`, `${width} 宽：预览出现`);
    const m = await evaluate('window.__L.measure()');
    const label = `${width} 宽`;
    near(m.md, m.body, `${label}：正文铺满预览区`);
    assert.ok(m.bodyScroll <= m.bodyClient, `${label}：页面没有横向溢出（${m.bodyScroll} > ${m.bodyClient}）`);
    for (const [i, wrap] of m.wraps.entries()) assert.ok(wrap.right <= m.mdRight + 0.5, `${label}：第 ${i + 1} 张表没有超出正文`);
    assert.ok(m.code.right <= m.mdRight + 0.5, `${label}：代码块没有超出正文`);
    assert.ok(m.code.scroll > m.code.client, `${label}：长代码行在代码块自己的滚动区里`);
    assert.ok(m.wraps[1].scroll > m.wraps[1].width, `${label}：宽表格在自己的滚动区里`);
    if (width === 1400) {
      assert.ok(m.md > 1300, `${label}：正文宽度 ${m.md}`);
      near(m.wraps[0].table, m.wraps[0].width, `${label}：窄表格铺满`);
      near(m.code.width, m.md - 32, `${label}：代码块随窗口变宽`);
    } else assert.ok(m.wraps[0].scroll <= m.wraps[0].width, `${label}：窄表格不需要滚动`);
    check(`接入页 ${label}：正文铺满、表格和代码块不溢出`, { md: fixed(m.md), body: fixed(m.body), 窄表: fixed(m.wraps[0].table), 宽表滚动: [m.wraps[1].width, m.wraps[1].scroll], 代码滚动: [m.code.client, m.code.scroll] });
  }

  // 编码联动：GBK 页面，预览和源码都不乱码；开着查找来回切换。
  await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 800, deviceScaleFactor: 1, mobile: false });
  await evaluate(`window.__L.open('docs/gbk.html', ${JSON.stringify(GBK_PAGE)})`);
  await until(`document.querySelector('.md') !== null`, 'GBK 页面预览出现');
  const shown = await evaluate('window.__L.text()');
  assert.equal(shown, '中文编码', 'GBK 页面的预览文字');
  assert.ok((await evaluate('window.__L.meta()')).endsWith('静态预览'), '元信息写「静态预览」');
  await evaluate(`window.__L.find('中文')`);
  await until(`window.__L.highlight().where === 'preview' && window.__L.highlight().counter === '1/1'`, '预览里找到中文');
  assert.equal((await evaluate('window.__L.highlight()')).text, '中文');
  await evaluate(`window.__L.mode('源码')`);
  await until(`window.__L.highlight().where === 'source' && window.__L.highlight().counter === '1/1'`, '源码里找到中文');
  const source = await evaluate('window.__L.source()');
  assert.equal(source, '<meta charset="gbk"><p>中文</p><p>编码</p>', 'GBK 页面的源码文字');
  assert.equal((await evaluate('window.__L.highlight()')).text, '中文');
  await evaluate(`window.__L.mode('预览')`);
  await until(`window.__L.highlight().where === 'preview' && window.__L.highlight().counter === '1/1'`, '切回预览又找到中文');
  assert.ok(!shown.includes('\ufffd') && !source.includes('\ufffd'), '没有乱码字符');
  check('接入页：GBK 页面预览和源码文字一致、不乱码；开着查找来回切换，两边都找到「中文」，高亮落在当前显示的正文里');
  assert.deepEqual(thrown, [], '接入页没有未接住的异常');
}

// ---- XSS 语料 ----

// 每条：{ id, group, html, expect?, legit? }。URL 里的探针标记是 PROBE-<id>~，服务器按它归到这一条；任何一次请求都算泄漏。
function makeCorpus(port) {
  const origin = `http://127.0.0.1:${port}`;
  const cases = [];
  const add = (id, group, make, expect, legit) => {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.ok(!cases.some(c => c.id === id), `重复的 id：${id}`);
    const r = `PROBE-${id}~`;
    cases.push({ id, group, html: make({ b: `__BEACON.push('${id}')`, u: `/probe/${r}`, a: `${origin}/probe/${r}`, p: `//127.0.0.1:${port}/probe/${r}`, r, id }), expect, legit });
  };
  const b64 = text => Buffer.from(text).toString('base64');
  const LEGIT = path => `/img/legit/${path}`; // 服务器记的是解码后的路径

  // 常规
  add('script-inline', '常规', ({ b, u }) => `<p>前</p><script>${b}</script><script src="${u}"></script><p>后</p>`, { text: ['前', '后'], none: ['script'] });
  add('script-head', '常规', ({ b, u }) => `<html><head><title>t</title><script>${b}</script><script src="${u}"></script></head><body><p>正文</p></body></html>`, { text: ['正文'] });
  add('on-handlers', '常规', ({ b }) => `<p onmouseover="${b}" onclick="${b}" onfocus="${b}" tabindex="0" autofocus>x</p><div onload="${b}" onpointerenter="${b}">y</div>`, { text: ['x', 'y'] });
  add('img-onerror', '常规', ({ b, u }) => `<img src="x" onerror="${b}"><img src="${u}.png" onerror="${b}"><img onerror="${b}">`, { none: ['img'] });
  add('img-onerror-broken-local', '常规', ({ b }) => `<img src="img/LEGIT-broken.png" onerror="${b}" onload="${b}" alt="b">`, { none: ['img'], has: { '.md-img-fallback': 1 } }, [LEGIT('docs/sub/img/LEGIT-broken.png')]);
  add('svg-onload', '常规', ({ b }) => `<svg width="100" height="100" onload="${b}"><circle onclick="${b}" r="5"/></svg>`, { text: ['[图形]'], none: ['svg'] });
  add('a-onclick', '常规', ({ b }) => `<a href="#x" onclick="${b}" onmouseover="${b}">l</a><span id="x">t</span>`, { has: { 'a[href="#x"]': 1 } });
  add('body-onload', '常规', ({ b }) => `<body onload="${b}" onpageshow="${b}"><p>x</p></body>`, { text: ['x'] });
  add('video-source', '常规', ({ b, u }) => `<video poster="${u}" src="${u}.mp4" onerror="${b}"><source src="${u}.webm" onerror="${b}"><track src="${u}.vtt"></video>`, { text: ['[视频'], none: ['video', 'source'] });
  add('audio-autoplay', '常规', ({ b, u }) => `<audio src="${u}.mp3" autoplay controls onplay="${b}"></audio>`, { text: ['[音频'], none: ['audio'] });
  add('iframe-srcdoc', '常规', ({ id, b, u }) => `<iframe srcdoc="&lt;script&gt;parent.__BEACON.push('${id}')&lt;/script&gt;&lt;img src=${u}&gt;"></iframe><iframe src="${u}"></iframe><iframe src="javascript:${b}"></iframe>`, { text: ['[嵌入内容]'], none: ['iframe'] });
  add('meta-refresh', '常规', ({ u }) => `<meta http-equiv="refresh" content="0;url=${u}"><meta http-equiv="Content-Security-Policy" content="default-src *"><p>m</p>`, { text: ['m'] });
  add('object-embed', '常规', ({ u }) => `<object data="${u}" type="text/html"><param name="movie" value="${u}"><embed src="${u}"></object><embed src="${u}" type="image/svg+xml"><applet code="x" archive="${u}"></applet>`, { text: ['[嵌入内容]'], none: ['object', 'embed', 'applet'] });
  add('form-action', '常规', ({ b, u }) => `<form action="${u}" method="post" onsubmit="${b}"><input type="text" name="q" value="v"><input type="image" src="${u}" formaction="${u}"><button formaction="${u}" type="submit">发送</button><input type="submit" formaction="javascript:${b}"></form>`, { has: { '.md-chip': 1 }, none: ['form', 'input'] });
  add('style-url', '常规', ({ u }) => `<style>body{background:url(${u})} @import url(${u});</style><p style="background:url(${u});display:block;text-align:center">样式</p>`, { text: ['样式'], noText: ['background'], has: { '.md-align-center': 1 }, none: ['style'] });
  add('link-resources', '常规', ({ u }) => `<link rel="stylesheet" href="${u}.css"><link rel="prefetch" href="${u}"><link rel="preload" as="image" href="${u}"><link rel="icon" href="${u}"><link rel="manifest" href="${u}"><style>@import "${u}.css";</style><p>l</p>`, { text: ['l'] });
  add('body-background', '常规', ({ u }) => `<body background="${u}"><table background="${u}"><tr><td background="${u}">t</td></tr></table></body>`, { has: { td: 1 } });
  add('image-tag', '常规', ({ b, u }) => `<image src="${u}"><image src="x.txt" onerror="${b}">`, { none: ['img'] });
  add('link-attrs', '常规', ({ u }) => `<a href="${origin}/ok~" ping="${u}" download="f" target="_blank" rel="noopener" referrerpolicy="no-referrer" class="x y" id="aid" name="aname" style="color:red" data-x="1" aria-label="a" hreflang="zh" type="text/html">外链</a><blockquote cite="${u}" class="q" id="bq">引</blockquote><q cite="${u}">q</q><ins cite="${u}" datetime="2020">i</ins>`, { has: { 'a[href^="http://"]': 1 }, text: ['外链'] });
  add('details-attrs', '常规', ({ b }) => `<details name="grp" open id="d1" class="c" ontoggle="${b}"><summary onclick="${b}">摘要</summary>正文D</details>`, { has: { 'details[open]': 1 }, text: ['摘要', '正文D'] });
  add('table-span', '常规', ({ b, u }) => `<table onclick="${b}" background="${u}"><tr><td colspan="99999999" rowspan="99999999" onclick="${b}">c</td><td colspan="-3" rowspan="0">d</td></tr></table>`, { has: { td: 2 }, text: ['c', 'd'] });
  add('ol-attrs', '常规', ({ b }) => `<ol start="-5" reversed="javascript:${b}" type="a" onclick="${b}"><li>x</li></ol>`, { has: { 'ol[start="-5"]': 1, 'ol[reversed]': 1 } });
  add('lang-dir-title', '常规', ({ b }) => `<p lang="en&quot; onclick=&quot;${b}" dir="rtl&lt;script&gt;" title="a&#x202E;b&#1;c">x</p><p lang="zh-CN" dir=" RTL " title="ok">y</p>`, { has: { 'p[lang="zh-CN"][dir="rtl"][title="ok"]': 1 } });
  add('nested-a', '常规', ({ b }) => `<a href="${origin}/ok~"><a href="javascript:${b}">内层</a>外层</a><a href="#x">a</a><a href="#y">b</a>`, { text: ['内层', '外层'], none: ['a[href^="javascript"]'] });
  add('button-attrs', '常规', ({ b }) => `<button onclick="${b}" formaction="javascript:${b}" type="submit" name="n" id="bid">按钮文字</button><button onclick="${b}"><svg width="9" height="9"></svg></button>`, { has: { '.md-chip': 1 }, text: ['按钮文字'] });
  add('mailto', '常规', ({ u }) => `<a href="mailto:a@example.com?subject=x&amp;body=${u}">邮件</a>`, { has: { '.md-copy-email': 1 }, text: ['邮件'] });
  add('hidden-skipped', '常规', ({ u }) => `<p hidden>H1</p><p aria-hidden="true">H2</p><p style="display:none;background:url(${u})">H3</p><p style="visibility:hidden">H4</p><p>SHOWN</p>`, { text: ['SHOWN'], noText: ['H1', 'H2', 'H3', 'H4'] });
  add('label-input', '常规', ({ b }) => `<label for="coda">标签<input id="coda" name="stage" autofocus onfocus="${b}" value="v"><select><option>o</option></select><textarea>ta</textarea></label>`, { text: ['标签'], noText: ['ta'], none: ['input', 'select', 'textarea', 'label'] });
  add('legacy-elements', '常规', ({ b }) => `<marquee onstart="${b}" onfinish="${b}">滚动</marquee><blink>闪</blink><font color="red" onclick="${b}">字</font><center onclick="${b}">居中</center>`, { text: ['滚动', '闪', '字', '居中'] });
  add('deep-nesting', '常规', ({ b }) => `${'<div>'.repeat(600)}<img src="x.txt" onerror="${b}">深${'</div>'.repeat(600)}`, { text: ['深'], none: ['img'] });
  add('table-foster', '常规', ({ b }) => `<table><tr><td><script>${b}</script></td></tr><img src="x.txt" onerror="${b}"><div onclick="${b}">fostered</div></table>`, { text: ['fostered'], none: ['img'] });
  add('frameset', '常规', ({ b, u }) => `<html><frameset onload="${b}"><frame src="${u}"><frame src="javascript:${b}"></frameset></html>`, { text: ['[嵌入内容]'] });
  add('external-control', '常规', () => `<a href="${origin}/ext~">EXTLINK</a><a href="https://example.com/a?b=1#c">EX2</a>`, { has: { 'a[href^="http"]': 2 }, text: ['EXTLINK', 'EX2'] });
  add('pre-code', '常规', ({ b, u }) => `<pre><code class="language-js">const a = 1; // <b>x</b>\nfunction f(){}</code></pre><pre class="lang-py">print("x")<br>print('y')<script>${b}</script><style>x</style></pre><pre><img src="${u}" onerror="${b}">PRETEXT</pre>`, { has: { 'pre.md-code': 3 }, text: ['PRETEXT'], none: ['img', 'script'] });
  add('table-nesting', '常规', ({ b }) => `<table><tr><td><table><tr><td><table><tr><td><table><tr><td onclick="${b}">DEEP</td></tr></table></td></tr></table></td></tr></table></td></tr></table>`, { text: ['DEEP'] });

  // URL 混淆
  add('js-entity', 'URL 混淆', ({ b }) => `<a href="jav&#x61;script:${b}">E1</a><a href="&#106;avascript:${b}">E2</a><a href="javascript&colon;${b}">E3</a><a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A${b}">E4</a>`, { text: ['E1', 'E2', 'E3', 'E4'], none: ['a'] });
  add('js-newline', 'URL 混淆', ({ b }) => `<a href="java&#10;script:${b}">N1</a><a href="java&#9;script:${b}">N2</a><a href="java&#13;script:${b}">N3</a><a href="jav\nascript:${b}">N4</a>`, { text: ['N1', 'N2', 'N3', 'N4'], none: ['a'] });
  add('js-leading-control', 'URL 混淆', ({ b }) => `<a href="&#1;&#2;&#3;javascript:${b}">C1</a><a href=" &#x0B;javascript:${b}">C2</a><a href="&#xA0;javascript:${b}">C3</a><a href="\u0000javascript:${b}">C4</a>`, { text: ['C1', 'C2', 'C3', 'C4'], has: { a: 1 } }); // C4：NUL 被解析器换成 U+FFFD，不是协议头，按相对路径处理（安全，点击只会走 onOpenRelative）
  add('scheme-zoo', 'URL 混淆', ({ b, a }) => `<a href="JaVaScRiPt:${b}">M1</a><a href="JAVASCRIPT:${b}">M2</a><a href="vbscript:${b}">M3</a><a href="livescript:${b}">M4</a><a href="data:text/html,&lt;script&gt;${b}&lt;/script&gt;">M5</a><a href="data:text/html;base64,${b64(`<script>${b}</script>`)}">M6</a><a href="file:///etc/passwd">M7</a><a href="blob:null/x">M8</a><a href="ftp://x/${a}">M9</a><a href="tel:123">M10</a>`, { text: ['M1', 'M10'], none: ['a'] });
  // 三种 javascript: 混淆写法（实体编码、换行和制表、前导控制字符）× 另外四个属性（href 上的在上面三条里）。
  const OBFUSCATIONS = [
    ['entity', ['jav&#x61;script:', '&#106;avascript&colon;']],
    ['newline', ['java&#10;script:', 'java&#9;script:']],
    ['control', ['&#1;&#2;&#3;javascript:', ' &#x0B;javascript:']],
  ];
  const ATTRIBUTES = {
    src: (v, b, n) => [`<img src="${v}${b}"><img src="${v}${b}">`, { none: ['img'], has: { '.md-img-fallback': 2 * n } }],
    srcset: (v, b, n) => [`<img srcset="${v}${b} 1x, ${v}${b} 2x" src="x.txt"><img srcset="${v}${b} 1x">`, { none: ['img'], has: { '.md-img-fallback': 2 * n } }],
    formaction: (v, b, n) => [`<form><button formaction="${v}${b}">F1</button><input type="submit" formaction="${v}${b}"></form><button formaction="${v}${b}">F2</button>`, { text: ['F1', 'F2'], none: ['form', 'input'] }],
    'xlink-href': (v, b, n) => [`<a xlink:href="${v}${b}">X1</a><svg width="50" height="50"><a xlink:href="${v}${b}"><text>x</text></a></svg>`, { text: ['X1', '[图形]'], none: ['a', 'svg'] }],
  };
  for (const [obf, variants] of OBFUSCATIONS) {
    for (const [attr, make] of Object.entries(ATTRIBUTES)) {
      add(`js-${obf}-${attr}`, 'URL 混淆', ({ b }) => variants.map(v => make(v, b, variants.length)[0]).join(''), make(variants[0], '', variants.length)[1]);
    }
  }
  add('js-in-src', 'URL 混淆', ({ b }) => `<img src="javascript:${b}"><img src="vbscript:${b}"><iframe src="javascript:${b}"></iframe><script src="javascript:${b}"></script><embed src="javascript:${b}"><object data="javascript:${b}"></object>`, { none: ['img', 'iframe'] });
  add('js-srcset', 'URL 混淆', ({ b, u }) => `<img srcset="${u} 1x, javascript:${b} 2x" sizes="${u}" src="x.txt"><picture><source srcset="${u}" media="all"><img src="y.txt"></picture>`, { has: { '.md-img-fallback': 2 }, none: ['img', 'source', 'picture'] });
  add('js-formaction-xlink', 'URL 混淆', ({ b }) => `<button formaction="javascript:${b}">F</button><svg><a xlink:href="javascript:${b}"><text>x</text></a></svg><svg><a href="javascript:${b}"><circle r="4"/></a></svg>`, { text: ['F'], none: ['a', 'svg'] });
  add('data-html', 'URL 混淆', ({ b }) => `<img src="data:text/html,&lt;script&gt;${b}&lt;/script&gt;"><img src="data:text/html;base64,${b64(`<script>${b}</script>`)}"><iframe src="data:text/html,&lt;script&gt;${b}&lt;/script&gt;"></iframe><object data="data:text/html;base64,${b64(`<script>${b}</script>`)}"></object>`, { none: ['img', 'iframe', 'object'] });
  add('data-svg', 'URL 混淆', ({ b, a }) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="parent.${b}"><image href="${a}"/><script>${b}</script></svg>`;
    return `<img src="data:image/svg+xml,${encodeURIComponent(svg)}"><img src="data:image/svg+xml;base64,${b64(svg)}"><img src="data:image/svg+xml;utf8,${svg.replaceAll('"', '&quot;')}">`;
  }, { none: ['img'], has: { '.md-img-fallback': 3 } });
  add('data-image-bad', 'URL 混淆', () => `<img src="data:image/png;base64,AAAA"><img src="data:image/png;base64,!!!notbase64"><img src="data:image/gif,GIF89a"><img src="data:image/png;charset=utf-8;base64,${PNG_B64}"><img src="data:image/png,${PNG_B64}"><img src="DATA:IMAGE/PNG;BASE64,${PNG_B64}x">`, { none: ['img'], has: { '.md-img-fallback': 6 } });
  add('protocol-relative', 'URL 混淆', ({ p, r }) => `<img src="${p}.png"><a href="${p}">P</a><img src="///127.0.0.1/probe/${r}.png"><a href="\\\\127.0.0.1\\x\\${r}">B</a>`, { none: ['img', 'a'], text: ['P', 'B'] });
  add('http-colon', 'URL 混淆', ({ r }) => `<img src="http:/probe/${r}.png"><img src="http:${r}.png"><a href="http:/probe/${r}">H</a><a href="https:probe/${r}">H2</a><img src="https:/probe/${r}.png">`, { none: ['img', 'a'], text: ['H', 'H2'] });
  add('percent-encoding', 'URL 混淆', ({ r }) => `<img src="..%2F..%2Fprobe%2F${r}.png"><img src="%2e%2e/${r}.png"><img src="a%2Fb.png"><img src="%5Cprobe%5C${r}.png"><img src="%2e/${r}.png"><img src="%00${r}.png"><img src="%E0%A4%A.png"><a href="..%2F${r}">x</a><a href="%2e%2e/%2e%2e/%2e%2e/${r}">y</a>`, { none: ['img', 'a'], text: ['x', 'y'] });
  add('relative-non-image', 'URL 混淆', ({ r }) => ['txt', 'html', 'js', 'json', 'pdf', 'mp4', 'glb'].map(ext => `<img src="${r}.${ext}">`).join('') + `<img src="${r}"><img src="${r}.png.txt"><img src=".htaccess">`, { none: ['img'], has: { '.md-img-fallback': 10 } });
  add('relative-escape', 'URL 混淆', ({ r }) => `<img src="../../../${r}.png"><img src="../../../../etc/${r}.png"><img src="./../../../${r}.png"><img src="a/../../../../${r}.png"><a href="../../../${r}.html">e</a>`, { none: ['img', 'a'], text: ['e'] });
  add('base-href', 'URL 混淆', ({ u, a, r }) => `<base href="${a}/"><base target="_blank"><img src="img/LEGIT-base.png" alt="b"><a href="sub/page2.html">相对</a><a href="${u}/x">绝对</a><a href="${r}.html">同级</a>`, { has: { 'img.md-img': 1, 'a.md-rel-link[data-rel-path="docs/sub/sub/page2.html"]': 1, a: 2 }, loaded: ['img.md-img'] }, [LEGIT('docs/sub/img/LEGIT-base.png')]);
  add('backslash-file', 'URL 混淆', ({ r }) => `<img src="\\${r}.png"><img src="\\\\host\\x\\${r}.png"><img src="file:///tmp/${r}.png"><a href="file:///tmp/${r}">f</a><img src="C:\\${r}.png"><img src="c:/${r}.png">`, { none: ['img', 'a'], text: ['f'] });
  add('remote-images', 'URL 混淆', ({ a }) => `<img src="${a}.png" alt="r1"><img src="  ${a}.gif  " alt="r2"><img src="HTTPS://127.0.0.1:${port}/probe/x.webp" alt="r3"><img src="<${a}.png>" alt="r4">`, { none: ['img'], text: ['[外链图片：r1]', '[外链图片：r4]'] });
  add('very-long-relative', 'URL 混淆', () => `<a href="${'a/'.repeat(70000)}x.html">long</a><img src="${'a/'.repeat(3000)}x.png">`, { none: ['a', 'img'], text: ['long'] });
  add('unicode-bidi', 'URL 混淆', () => `<a href="${origin}/ok~\u202E">bidi</a><p title="\u202Eevil">B</p>`, { has: { 'a[href^="http://"]': 1 } });

  // 命名空间
  add('svg-foreignobject', '命名空间', ({ b, u }) => `<svg width="100" height="100"><foreignObject width="100" height="100"><img src="${u}" onerror="${b}"><p onclick="${b}">FOP</p><iframe src="${u}"></iframe><script>${b}</script><div xmlns="http://www.w3.org/1999/xhtml"><a href="javascript:${b}">fa</a></div></foreignObject></svg>`, { text: ['[图形]'], noText: ['FOP', 'fa'], none: ['img', 'iframe', 'a'] });
  add('svg-desc-title', '命名空间', ({ b, u }) => `<svg width="50" height="50"><title>图标T</title><desc><img src="${u}" onerror="${b}"><style>@import url(${u})</style></desc><image href="${u}"/><use href="${u}#x"/><script>${b}</script><set attributeName="onmouseover" to="${b}"/><animate attributeName="href" values="javascript:${b}"/></svg>`, { text: ['[图形：图标T]'], none: ['img', 'svg'] });
  add('svg-style-link', '命名空间', ({ u }) => `<svg width="50" height="50" aria-label="样式SVG"><style>@import url(${u}); rect{fill:url(${u})}</style><rect width="9" height="9" style="fill:url(${u})"/><a href="${u}"><text>t</text></a></svg>`, { text: ['[图形：样式SVG]'], none: ['svg', 'a'] });
  add('svg-small-silent', '命名空间', ({ b, u }) => `<p>前<svg width="16" height="16" onload="${b}"><use href="${u}"/></svg>后</p><a href="${origin}/x~"><svg width="50" height="50"><use href="${u}"/></svg>链接内</a>`, { text: ['前后', '链接内'], noText: ['[图形'] });
  add('math-mtext', '命名空间', ({ b, u }) => `<math><mtext><img src="${u}" onerror="${b}"><script>${b}</script><style>@import url(${u})</style><p onclick="${b}">MT</p></mtext></math>`, { none: ['img', 'math', 'style'] });
  add('math-annotation-xml', '命名空间', ({ b, u }) => `<math><semantics><mrow><mi>x</mi></mrow><annotation-xml encoding="text/html"><img src="${u}" onerror="${b}"><script>${b}</script><div onclick="${b}">AX</div></annotation-xml></semantics></math>`, { none: ['img', 'math'] });
  add('math-annotation-tex', '命名空间', ({ b, u }) => `<p>公式 <math><semantics><mi>y</mi><annotation encoding="application/x-tex">y = &lt;img src=${u} onerror=${b}&gt; + x^2</annotation></semantics></math> 结束</p><math display="block"><semantics><mi>z</mi><annotation encoding="Application/X-TeX">E=mc^2 &lt;script&gt;${b}&lt;/script&gt;</annotation></semantics></math>`, { has: { 'code.md-inline-code': 1, 'pre.md-code': 1 }, none: ['img', 'script', 'math'], text: ['x^2', 'E=mc^2'] });
  add('math-annotation-tags', '命名空间', ({ b, u }) => `<math><semantics><annotation encoding="application/x-tex"><img src="${u}" onerror="${b}"> TEXTAG <b>bold</b></annotation></semantics></math>`, { none: ['img', 'math'] });
  add('math-href-xlink', '命名空间', ({ b, u }) => `<math href="javascript:${b}" onclick="${b}"><mi xlink:href="javascript:${b}">m</mi><maction actiontype="statusline#${u}"><mi>q</mi></maction></math><math><mglyph src="${u}"/><mi>g</mi></math>`, { none: ['math', 'a', 'img'] });
  add('svg-in-a-js', '命名空间', ({ b, u }) => `<a href="javascript:${b}"><svg width="50" height="50" onload="${b}" aria-label="X"><use href="${u}"/></svg>L</a>`, { text: ['L'], noText: ['[图形'], none: ['a', 'svg'] });
  add('math-in-svg', '命名空间', ({ b, u }) => `<svg><foreignObject><math><mtext><img src="${u}" onerror="${b}"></mtext></math></foreignObject></svg>`, { none: ['img', 'math'] });

  // 原始文本
  add('body-title', '原始文本', ({ b, u }) => `<p>前</p><title><img src="${u}" onerror="${b}"></title><p>后</p>`, { text: ['前', '后'], noText: ['onerror'], none: ['img'] });
  add('noembed-noframes', '原始文本', ({ b, u }) => `<noembed><img src="${u}" onerror="${b}"></noembed><noframes><img src="${u}" onerror="${b}"></noframes><p>nf</p>`, { text: ['nf'], noText: ['onerror'], none: ['img'] });
  add('xmp-plaintext', '原始文本', ({ b, u }) => `<xmp><img src="${u}" onerror="${b}"><script>${b}</script></xmp><listing><img src="${u}"></listing><plaintext><img src="${u}" onerror="${b}">`, { text: ['<img src='], none: ['img', 'script'] });
  add('noscript-style', '原始文本', ({ b, u }) => `<noscript><style>@import url(${u});</style><img src="${u}" onerror="${b}"><p>NS</p></noscript><p>after</p>`, { text: ['NS', 'after'], none: ['img', 'style'] });
  add('noscript-mxss', '原始文本', ({ b, u }) => `<noscript><p title="</noscript><img src=${u} onerror=${b}>">NSP</p></noscript>`, { text: ['NSP'], none: ['img'] });
  add('raw-text-elements', '原始文本', ({ b, u }) => `<textarea><img src="${u}" onerror="${b}"></textarea><title></title><style><img src="${u}" onerror="${b}"></style><iframe><img src="${u}" onerror="${b}"></iframe><script><img src="${u}"></script><p>raw</p>`, { text: ['raw'], none: ['img'] });
  add('comments', '原始文本', ({ b, u }) => `<!--><img src="${u}" onerror="${b}">--><!-- <img src="${u}" onerror="${b}"> --><!--[if IE]><img src="${u}"><![endif]--><![CDATA[<img src="${u}" onerror="${b}">]]><?php echo 1 ?><!DOCTYPE html><p>CM</p>`, { text: ['CM'], none: ['img'] });
  add('mxss-math-form', '原始文本', ({ b, u }) => `<form><math><mtext></form><form><mglyph><style></math><img src="${u}" onerror="${b}">`, { none: ['img', 'form', 'math'] });
  add('mxss-select-style', '原始文本', ({ b, u }) => `<select><template><style><img src="${u}" onerror="${b}"></style></template></select><svg><style><img src="${u}"></style></svg><math><style><img src="${u}" onerror="${b}"></style></math>`, { none: ['img', 'style'] });
  add('template-dialog', '原始文本', ({ b, u }) => `<template><img src="${u}" onerror="${b}"><script>${b}</script></template><dialog open><img src="${u}"><p>DLG</p></dialog><portal src="${u}"></portal><p>tp</p>`, { text: ['tp'], noText: ['DLG'], none: ['img'] });

  // DOM clobbering
  add('clobber-ids', 'DOM clobbering', () => `<p id="coda">C1</p><div id="stage">C2</div><div id="tree">C3</div><a id="__proto__" name="constructor">C4</a><span id="constructor">C5</span><i id="getElementById" name="cookie">C6</i><b id="body" name="documentElement">C7</b>`, { text: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'], anchors: ['coda', 'stage', 'tree', '__proto__', 'constructor'] });
  add('clobber-form-inputs', 'DOM clobbering', () => `<form name="coda" id="document"><input name="stage"><input name="getElementById"><input id="cookie" name="body"><input name="children"><img name="defaultView"><embed name="tree"><object name="location" id="location"></object><iframe name="coda" id="stage"></iframe></form><img name="cookie" id="forms"><embed name="images" id="all"><a name="top"></a><a href="#top">go</a>`, { text: ['go'], anchors: ['top', 'document', 'forms'], none: ['form', 'input', 'embed', 'object'] });
  add('clobber-anchor-lookup', 'DOM clobbering', () => `<a id="x1">T1</a><h2 id="sec">章节</h2><a href="#sec">跳到章节</a><a href="#%E7%AB%A0">解码失败路径</a><a href="#nonexist">无</a>`, { anchors: ['x1', 'sec'], anchorText: { sec: '章节' }, has: { 'a[href^="#"]': 3 } });
  add('duplicate-ids', 'DOM clobbering', () => `<p id="dup">D1</p><p id="dup">D2</p><a name="dup">D3</a>`, { anchorText: { dup: 'D1' } });
  add('clobber-proto-names', 'DOM clobbering', () => `<form id="__proto__"><input name="constructor"><input name="toString"><input name="hasOwnProperty"><input name="valueOf"></form><img name="__proto__" id="prototype"><a id="__defineGetter__">x</a>`, { text: ['x'], anchors: ['__proto__', 'prototype', '__defineGetter__'] });

  // 属性
  add('attr-misc', '属性', ({ u }) => `<p ping="${u}" download="f" target="_blank" cite="${u}" background="${u}" srcset="${u}" style="color:red;background:url(${u})" class="evil" id="e1" name="n1" data-x="1" aria-label="a" role="button" tabindex="1" contenteditable="true" draggable="true" accesskey="x" slot="s" is="x-y" xmlns="http://x" nonce="n" popover="auto" popovertarget="x" inert enterkeyhint="go" autocapitalize="on" translate="no" spellcheck="false" itemscope itemprop="x">ATTR</p>`, { text: ['ATTR'] });
  add('img-attrs', '属性', ({ b, u }) => `<img src="data:image/png;base64,${PNG_B64}" alt="a" width="99999" height="99999" style="position:fixed;width:100vw" class="evil" id="img1" name="img1" srcset="${u}" crossorigin="anonymous" referrerpolicy="no-referrer" ismap usemap="#m" longdesc="${u}" fetchpriority="high" onload="${b}" onerror="${b}">`, { loaded: ['img'], has: { img: 1 } });
  add('text-level', '属性', () => `<p><abbr title="t&#x202E;x">A</abbr><time datetime="2020-01-01">T</time><mark class="m">M</mark><kbd>K</kbd><dfn id="d">D</dfn><sub>1</sub><sup>2</sup></p>`, { text: ['A', 'T', 'M', 'K', 'D'], anchors: ['d'] });
  add('align', '属性', () => `<p align="  CENTER ">A</p><div style="text-align: right !important">B</div><h2 align="justify" style="text-align:end">C</h2><table><tr><td align="right">D</td></tr></table>`, { has: { '.md-align-center': 1, '.md-align-right': 2 } });
  add('forged-rich-ui', '属性', () => `<p data-rich-ui>FORGEDP 伪造正文</p><span data-rich-ui="">FORGEDSPAN</span><div data-rich-ui="x" class="md-note secondary"><p>FORGEDDIV</p></div><button class="md-note-action" data-rich-ui>FORGEDBTN</button><span class="md-img-fallback secondary" data-rich-ui>FORGEDFALLBACK</span><summary data-rich-ui>FORGEDSUM</summary><a href="mailto:z@example.com" data-rich-ui>FORGEDMAIL</a>`, { richUi: 1, find: ['FORGEDP', 'FORGEDSPAN', 'FORGEDDIV', 'FORGEDBTN', 'FORGEDFALLBACK', 'FORGEDSUM', 'FORGEDMAIL'] });

  // 正对照
  add('control-body', '正对照', () => '<p>正文</p>', { exactHtml: '<p>正文</p>', has: { p: 1 } });
  add('control-local-image', '正对照', () => `<p>本地图</p><img src="img/LEGIT-a.png" alt="本地" title="T">`, { loaded: ['img.md-img'], has: { 'img.md-img': 1 } }, [LEGIT('docs/sub/img/LEGIT-a.png')]);
  add('control-local-paths', '正对照', () => `<img src="../LEGIT-up.png" alt="u"><img src="./中/LEGIT-zh.png" alt="z"><img src="%E4%B8%AD%20x/LEGIT-sp.png" alt="s">`, { loaded: ['img.md-img'], has: { 'img.md-img': 3 } }, [LEGIT('docs/LEGIT-up.png'), LEGIT('docs/sub/中/LEGIT-zh.png'), LEGIT('docs/sub/中 x/LEGIT-sp.png')]);
  add('control-data-image', '正对照', () => `<p>数据图</p><img src="data:image/png;base64,${PNG_B64}" alt="d1"><img src="data:image/png;base64,${PNG_B64.slice(0, 40)}\n ${PNG_B64.slice(40)}" alt="d2"><img src="data:image/gif;base64,${GIF_B64}" alt="d3">`, { loaded: ['img.md-img'], has: { 'img.md-img': 3, '.md-img-fallback': 0 } });
  return cases;
}

// ---- 服务器：流式服务的替身，统计所有请求 ----

const PROBE_RE = /PROBE-([a-z0-9-]+)~/;
let stats = null;
const freshStats = () => ({ entry: 0, probes: new Map(), legit: new Map(), unexpected: [] });
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

function startServer(getPage) {
  const server = http.createServer((req, res) => {
    const raw = req.url, pathname = raw.split('?')[0];
    const send = (status, type, body, extra = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(body); };
    const page = /^\/page\/(host|open)$/.exec(pathname);
    if (page) {
      stats.entry++;
      const csp = getPage.csp(page[1]);
      return send(200, 'text/html; charset=utf-8', getPage.html(page[1]), csp ? { 'content-security-policy': csp } : {});
    }
    if (pathname === '/favicon.ico') return send(404, 'text/plain', 'no');
    if (pathname === '/page/layout') return send(200, 'text/html; charset=utf-8', getPage.layout());
    const view = /^\/view\/((?:[\w-]+\/)*[\w.-]+\.(?:mjs|js|css))$/.exec(pathname); // 接入页直接加载真实的 view/ 文件
    if (view && !view[1].includes('..')) {
      return readFile(path.join(viewDir, view[1])).then(
        body => send(200, view[1].endsWith('.css') ? 'text/css' : 'text/javascript', body),
        () => send(404, 'text/plain', 'not found'),
      );
    }
    const probe = PROBE_RE.exec(raw);
    if (probe) { bump(stats.probes, probe[1]); return send(200, 'image/png', PNG_BYTES); } // 泄漏的请求也答 200：让泄漏看得见
    if (pathname.startsWith('/img/legit/')) {
      let decoded;
      try { decoded = decodeURIComponent(pathname); } catch { decoded = pathname; }
      bump(stats.legit, decoded);
      return decoded.includes('LEGIT-broken') ? send(404, 'text/plain', 'broken') : send(200, 'image/png', PNG_BYTES);
    }
    stats.unexpected.push(raw);
    return send(404, 'text/plain', 'not found');
  });
  return server;
}

// ---- 运行 ----

let profile = null, chrome = null, ws = null, server = null, exitCode = 1;
const thrown = []; // 页面里没接住的异常（Runtime.exceptionThrown）
const waiting = new Map();
let seq = 0;
const send = (method, params = {}, ms = CALL_MS) => within(new Promise((resolve, reject) => {
  if (ws?.readyState !== WebSocket.OPEN) return reject(new Error(`CDP 没有连接，不能发 ${method}`));
  const id = ++seq;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
}), ms, `CDP ${method}`);
const evaluate = async (expression, ms = EVAL_MS) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ms);
  if (exceptionDetails) throw new Error(`页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
};
const until = async (expression, what) => {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (await evaluate(expression, CALL_MS).catch(() => false)) return;
    if (Date.now() >= deadline) throw new Error(`等不到：${what}（等了 ${WAIT_MS / 1000} 秒）${thrown.length ? `；页面异常：${thrown.join(' | ')}` : ''}`);
    await wait(50);
  }
};
// 结束子进程并等它退出；礼貌地结束等不到就强杀。
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  if (await Promise.race([exited.then(() => true), wait(3000).then(() => false)])) return;
  child.kill('SIGKILL');
  await exited;
}
const check = (name, detail) => console.log(`✔ ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
const median = values => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
const fixed = value => Math.round(value * 10) / 10;

// 一种 CSP 下跑完所有检查。
async function runMode(mode, cases, port) {
  const label = `${mode.label}`;
  stats = freshStats();
  const nav = await send('Page.navigate', { url: `http://127.0.0.1:${port}/page/${mode.name}` });
  if (nav.errorText) throw new Error(`页面打不开：${nav.errorText}`);
  // 先断言启动：被测模块已经运行（页面写出启动标记），再看任何探针计数。
  await until(`document.body?.dataset.boot === 'ready'`, `${label}：被测模块启动标记（页面没有写出启动标记，零请求不能算通过）`);
  const boot = await evaluate('window.__BOOT__');
  assert.equal(boot.mode, mode.name);
  assert.ok(boot.modules.html.includes('renderHtml') && boot.modules.html.includes('decodeHtmlBytes'), `${label}：html.mjs 的导出齐全 ${JSON.stringify(boot.modules.html)}`);
  assert.ok(boot.modules.find.includes('buildRichIndex') && boot.modules.find.includes('findRich'), `${label}：find.mjs 的导出齐全`);
  assert.equal(stats.entry, 1, `${label}：入口文件只请求一次`);
  check(`${label}：被测模块已启动`, { exports: boot.modules.html.length + boot.modules.find.length });

  const probeHits = () => [...stats.probes].filter(([id]) => id !== 'canary').map(([id, n]) => `${id} ×${n}`);
  const requests = (stage, expectedLegit) => {
    const problems = [
      ...probeHits().map(hit => `探针被请求：${hit}`),
      ...stats.unexpected.map(url => `意外的请求：${url.slice(0, 160)}`),
      ...[...stats.legit].filter(([p]) => !expectedLegit.has(p)).map(([p, n]) => `没有预期的图片请求：${p} ×${n}`),
      ...[...expectedLegit].filter(p => !stats.legit.has(p)).map(p => `合法图片没有发起请求：${p}`),
    ];
    assert.deepEqual(problems, [], `${label} / ${stage}`);
  };

  // 探针灵敏度：页面外的图片请求，宿主 CSP 下被挡，不加 CSP 时必须到达服务器。
  const canary = await evaluate('window.__H.canary()');
  if (mode.name === 'host') {
    assert.equal(stats.probes.get('canary') ?? 0, 0, `${label}：CSP 应当挡住探针请求`);
    assert.ok(canary.cspEvents.some(blocked => blocked.includes('PROBE-canary')), `${label}：CSP 违规事件应当报告探针 ${JSON.stringify(canary.cspEvents)}`);
  } else {
    assert.equal(stats.probes.get('canary'), 1, `${label}：不加 CSP 时探针请求必须到达服务器（计数是灵敏的）`);
    assert.deepEqual(canary.cspEvents, []);
  }
  check(`${label}：探针计数灵敏`, mode.name === 'host' ? '被 CSP 挡住并上报违规' : '请求到达服务器');

  assert.equal(await evaluate(`window.__H.setCases(${JSON.stringify(cases.map(({ id, html, expect }) => ({ id, html, expect })))})`), cases.length);
  const expectedLegit = new Set(cases.flatMap(c => c.legit ?? []));

  // 只解析：DOMParser，不挂载。
  assert.equal(await evaluate('window.__H.parseOnly()'), cases.length);
  requests('只解析', new Set());
  check(`${label}：只解析 ${cases.length} 条，观察窗口后探针请求 0、图片请求 0、意外请求 0`);

  // 挂载。
  const mounted = await evaluate('window.__H.mountAll()');
  assert.deepEqual(mounted.failed, [], `${label}：渲染抛错`);
  assert.equal(mounted.mounted, cases.length);
  requests('挂载', expectedLegit);
  check(`${label}：挂载 ${mounted.mounted} 条，探针请求 0；合法图片 ${expectedLegit.size} 张都发起了请求`);

  // 审计。
  const report = await evaluate('window.__H.audit()');
  requests('点击之后', expectedLegit);
  const failures = Object.entries(report.cases).map(([id, { problems, html }]) => `[${id}] ${problems.join('；')}\n    输出：${html}`);
  assert.deepEqual(failures, [], `${label}：输出审计和预期`);
  assert.deepEqual(report.globals, [], `${label}：插件自己的元素和全局对象没有被覆盖`);
  assert.deepEqual(report.beacon, [], `${label}：页面全局信标没有触发`);
  assert.deepEqual(report.unintercepted, [], `${label}：输出里的链接都被插件拦下，没有原始链接`);
  assert.deepEqual(report.errors, [], `${label}：页面没有脚本错误`);
  // 宿主策略有 base-uri 'none'：DOMParser 解析出的文档里的 <base href> 会被它拦下并上报，没有任何请求，也不进输出；其余违规一律不该有。
  assert.deepEqual(report.cspEvents.filter(event => !event.blocked.includes('PROBE-canary') && event.directive !== 'base-uri'), [], `${label}：没有 CSP 违规（清洗器根本没有写出被挡的东西）`);
  assert.ok(report.cspEvents.every(event => event.directive !== 'base-uri' || event.blocked.includes('PROBE-base-href~')), `${label}：base-uri 违规只来自 base-href 这一条`);
  assert.deepEqual(report.opened.map(entry => `${entry.id} ${entry.url}`).sort(), [
    `external-control https://example.com/a?b=1#c`, `external-control ${`http://127.0.0.1:${port}/ext~`}`,
    `link-attrs http://127.0.0.1:${port}/ok~`, `nested-a http://127.0.0.1:${port}/ok~`, `svg-small-silent http://127.0.0.1:${port}/x~`, `unicode-bidi http://127.0.0.1:${port}/ok~%E2%80%AE`,
  ].sort(), `${label}：外链点击都交给 onOpenExternal`);
  assert.equal(stats.entry, 1, `${label}：整个过程没有重新载入页面`);
  const groups = new Map();
  for (const c of cases) groups.set(c.group, (groups.get(c.group) ?? 0) + 1);
  check(`${label}：输出审计通过（表内元素和属性、值、无 id/name）、全局对象完好、信标未触发、无 CSP 违规`, Object.fromEntries(groups));

  // 性能。
  const perf = await evaluate('window.__H.perf()');
  assert.equal(perf.info.capped, false, `${label}：性能样例不该触到上限`);
  assert.ok(perf.runs.every(run => run.matches === 1 && run.rangeText === 'PERFNEEDLE'), `${label}：性能样例里找得到第一处`);
  const render = median(perf.runs.map(run => run.renderMs)), found = median(perf.runs.map(run => run.findMs));
  check(`${label}：性能样例`, { ...perf.info, renderMs: perf.runs.map(run => fixed(run.renderMs)), findMs: perf.runs.map(run => fixed(run.findMs)), 中位数: { renderMs: fixed(render), findMs: fixed(found) } });
  assert.ok(render <= PERF_RENDER_MS, `${label}：从解析到首次布局 ${fixed(render)} ms，超过 ${PERF_RENDER_MS} ms`);
  assert.ok(found <= PERF_FIND_MS, `${label}：建索引并找到第一处 ${fixed(found)} ms，超过 ${PERF_FIND_MS} ms`);
  return { mode: mode.name, cases: cases.length, render, found };
}

try {
  const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
  if (!chromePath) throw new Error('找不到可用的 Chrome / Chromium，可传路径参数或设置 CHROME_PATH');
  const css = await readFile(path.join(viewDir, 'style.css'), 'utf8');
  const bundle = await bundleModules(['html.mjs', 'find.mjs']);
  let origin = '';
  stats = freshStats();
  server = startServer({
    csp: mode => (mode === 'host' ? hostCsp(origin) : null),
    html: mode => pageHtml(bundle, css, { mode, origin, basePath: BASE_PATH }),
    layout: () => layoutPageHtml,
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  origin = `http://127.0.0.1:${port}`;
  const cases = makeCorpus(port);
  assert.ok(cases.length >= 60, `语料至少 60 条，现在 ${cases.length}`);
  const groups = new Set(cases.map(c => c.group));
  for (const group of ['常规', 'URL 混淆', '命名空间', '原始文本', 'DOM clobbering', '属性', '正对照']) assert.ok(groups.has(group), `缺类别：${group}`);

  profile = await mkdtemp(path.join(tmpdir(), 'rm-html-preview-'));
  chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-gpu', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1000,800', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await within(new Promise((resolve, reject) => {
    let stderr = '';
    chrome.stderr.on('data', chunk => { stderr += chunk; const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr); if (m) resolve(m[1]); });
    chrome.once('error', error => reject(new Error(`Chrome 启动失败：${error.message}`)));
    chrome.once('exit', code => reject(new Error(`Chrome 提前退出（${code}）：${stderr.slice(-400)}`)));
  }), STARTUP_MS, 'Chrome 启动');
  const listUrl = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '/json/list');
  const target = await within((async () => { for (;;) { const page = (await (await fetch(listUrl)).json()).find(x => x.type === 'page'); if (page) return page; await wait(100); } })(), STARTUP_MS, '找页面目标');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Runtime.exceptionThrown') thrown.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    const entry = waiting.get(m.id);
    if (!entry) return;
    waiting.delete(m.id);
    if (m.error) entry.reject(new Error(`CDP ${m.error.message}`)); else entry.resolve(m.result);
  });
  const rejectAll = reason => { for (const { reject } of waiting.values()) reject(new Error(reason)); waiting.clear(); };
  ws.addEventListener('close', () => rejectAll('CDP 连接断开'));
  ws.addEventListener('error', () => rejectAll('CDP 连接出错'));
  await within(new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('CDP 连接失败'))); }), STARTUP_MS, 'CDP 连接');
  await send('Page.enable');
  await send('Runtime.enable');

  const done = [];
  for (const mode of MODES) done.push(await runMode(mode, cases, port));
  assert.deepEqual(thrown, [], '页面没有未接住的异常');
  await runLayout(port);
  exitCode = 0;
  console.log(`html-preview 验收通过：语料 ${cases.length} 条（${[...groups].join('、')}），${done.map(d => `${d.mode}：解析到首次布局 ${fixed(d.render)} ms、查找 ${fixed(d.found)} ms`).join('；')}`);
} catch (error) {
  console.error(error);
} finally {
  ws?.close();
  await stop(chrome);
  if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(exitCode);
