// 开发用：真实 Chrome（不是 WKWebView）验收富文本预览里的查找（第 26.2 节），假 DOM 量不出的几何：
// 1) 跨 strong、code、a 的匹配：Range 跨节点，Highlight 注册、有可见矩形；
// 2) 宽表格和长代码行里的横向滚动：滚动后量匹配矩形，确认真的在可视范围里；
// 3) 两层收起的 <details> 里的匹配：导航前量不到矩形，导航后展开两层、矩形可见；
// 4) 初始定位：可视区顶落在某一段里，选中的就是 DOM 顺序上第一处底边在可视区顶以下的匹配，且在可视区内。
// 页面直接 import 真实的 view/preview.mjs 和 style.css。不是产品代码；自己起静态服务、Chrome 和临时目录，用完全部清理。
// 用法：node test/harness/rich-find.mjs [Chrome 的路径]（也认 CHROME_PATH）；任何一条不符，退出码非 0。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME_CANDIDATES = [
  process.argv[2],
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
if (!chromePath) {
  console.error('找不到可用的 Chrome / Chromium，可传路径参数或设置 CHROME_PATH');
  process.exit(1);
}

const STARTUP_MS = 30000, CALL_MS = 20000, WAIT_MS = 20000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (promise, ms, what) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}超时（${ms / 1000} 秒）`)), ms); })]).finally(() => clearTimeout(timer)); };

// 文档：开头一段含跨节点的词，中间 200 个定位用的段落，后面是宽表格和长代码行。
const POS_COUNT = 200;
const WIDE_CELLS = Array.from({ length: 12 }, (_, i) => `列${i}`);
const MARKDOWN = [
  '# 标题', '',
  '前 `代码` 后，半句**加粗**后文，去 [链接](https://example.com) 吧。', '',
  ...Array.from({ length: POS_COUNT }, (_, i) => `POSITION ${i} 段：这一段的文字足够长，在窄屏里会折成两三行，让每一段都有自己的高度和间距。\n`),
  `| ${WIDE_CELLS.join(' | ')} |`, `| ${WIDE_CELLS.map(() => '---').join(' | ')} |`,
  `| ${[...WIDE_CELLS.slice(1).map((_, i) => `单元格内容很长的一格${i}`), 'FARCELL'].join(' | ')} |`, '',
  '```js', `const padding = '${'x'.repeat(300)}'; // FARCODE`, '```', '',
].join('\n');

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/view/style.css"></head>
<body class="coda-ios" style="margin:0;width:360px;height:640px;display:flex;flex-direction:column">
<div id="p" class="preview" style="flex:1;min-height:0"></div>
<script type="module">
import { mountPreview } from '/view/preview.mjs';

const errors = [];
addEventListener('error', event => errors.push(String(event.message)));
addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
const origError = console.error;
console.error = (...args) => { errors.push(args.join(' ')); origError(...args); };

const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); // 两帧：布局和滚动都已经落定
// 等条件成立，带截止时间，不靠固定睡眠。
async function waitFor(check, what, ms = 15000) {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('等不到：' + what);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const source = ${JSON.stringify(MARKDOWN)};
const bytes = new TextEncoder().encode(source);
let binary = '';
for (const byte of bytes) binary += String.fromCharCode(byte);
const preview = mountPreview(document.getElementById('p'), {
  read: async () => ({ kind: 'text', data: btoa(binary), offset: 0, size: bytes.length, mtimeMs: 1, eof: true }),
  copy: () => {},
});
await preview.open('README.md');
const body = document.querySelector('.pbody'), md = document.querySelector('.md');

// 两层收起的 <details>，直接构造 DOM（Markdown 渲染器不产生它）。
const make = (tag, attrs, ...kids) => { const node = document.createElement(tag); for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v); node.append(...kids); return node; };
const inner = make('details', null, make('summary', null, '里层摘要'), make('p', null, 'NESTEDHIT 在两层收起的里面'));
const outer = make('details', null, make('summary', null, '外层摘要'), inner);
md.append(outer);

const rectOf = range => {
  const r = range.getClientRects()[0];
  return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null;
};
const boxOf = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
const inside = (r, box) => r !== null && r.width > 0 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
const currentRange = () => [...(CSS.highlights.get('find-current') ?? [])][0] ?? null;

// 关掉查找、位置归零，再搜 term（等防抖和第一批标记）。
async function search(term) {
  preview.find.close();
  body.scrollTop = 0; body.scrollLeft = 0;
  for (const wrap of document.querySelectorAll('.md-table-wrap, .md-code')) wrap.scrollLeft = 0;
  outer.removeAttribute('open'); inner.removeAttribute('open');
  preview.openFind();
  preview.find.input.value = term;
  preview.find.input.dispatchEvent(new Event('input'));
  await waitFor(() => preview.find.count !== '', '查找计数出现（防抖之后）');
  await frames();
}
const report = () => ({ count: preview.find.count, marks: CSS.highlights.get('find')?.size ?? 0 });

window.rich = {
  errors: () => errors,
  supported: () => typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function',
  async cross(term) {
    await search(term);
    const range = currentRange(), rect = range && rectOf(range);
    return { ...report(), text: range?.toString(), crossed: range ? range.startContainer !== range.endContainer : false, visible: inside(rect, boxOf(body)), rects: range ? range.getClientRects().length : 0 };
  },
  async far(term, wrapSelector) {
    await search(term);
    const range = currentRange(), wrap = document.querySelector(wrapSelector), rect = range && rectOf(range);
    return { ...report(), overflow: wrap.scrollWidth - wrap.clientWidth, scrollLeft: wrap.scrollLeft, inWrap: inside(rect, boxOf(wrap)), inBody: inside(rect, boxOf(body)), rect, wrap: boxOf(wrap) };
  },
  async nested() {
    await search('NESTEDHIT');
    return { ...report(), outerOpen: outer.hasAttribute('open'), innerOpen: inner.hasAttribute('open'), rendered: inner.querySelector('p').checkVisibility(), visible: inside(currentRange() && rectOf(currentRange()), boxOf(body)) };
  },
  async hiddenBefore() {
    preview.find.close(); outer.removeAttribute('open'); inner.removeAttribute('open');
    const range = document.createRange();
    range.selectNodeContents(inner.querySelector('p'));
    // Chrome 对收起的内容照样能量出矩形，真正的区别是它不渲染：checkVisibility() 为假。
    return { rendered: inner.querySelector('p').checkVisibility(), open: [outer, inner].map(d => d.hasAttribute('open')) };
  },
  // 可视区顶落在第 k 个定位段落里（它的顶在可视区顶之上、底在之下）：选中的应该是这一段的匹配。
  async position(k) {
    preview.find.close();
    outer.removeAttribute('open'); inner.removeAttribute('open');
    preview.openFind(); // 先开查找条：它会把正文的顶往下挤，位置要在它开好之后再设
    await frames();
    const paragraphs = [...md.querySelectorAll('p')].filter(p => p.textContent.startsWith('POSITION'));
    const target = paragraphs[k];
    body.scrollTop = 0;
    body.scrollTop += target.getBoundingClientRect().top - boxOf(body).top + 6; // 目标的顶在可视区顶之上 6 像素
    await frames();
    const top = boxOf(body).top, scrolled = body.scrollTop;
    // 独立算一遍（搜索前，搜索会滚动）：DOM 顺序上第一个底边不小于可视区顶的段落，每段只有一处匹配
    const expected = paragraphs.findIndex(p => p.getBoundingClientRect().bottom >= top);
    preview.find.input.value = 'POSITION';
    preview.find.input.dispatchEvent(new Event('input'));
    await waitFor(() => preview.find.count !== '', '查找计数出现（防抖之后）');
    await frames();
    const range = currentRange(), rect = range && rectOf(range);
    const chosen = range ? paragraphs.findIndex(p => p.contains(range.startContainer)) : -1;
    return { ...report(), chosen, expected, k, top, targetTop: target.getBoundingClientRect().top, scrolled, scrolledAfter: body.scrollTop, visible: inside(rect, boxOf(body)) };
  },
};
window.__READY__ = true;
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pageHtml); }
  try {
    const file = path.join(repoRoot, path.normalize(url));
    if (!file.startsWith(repoRoot + path.sep)) throw new Error('越界');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': `${mime[path.extname(url)] ?? 'application/octet-stream'}; charset=utf-8` });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});

let profile = null, chrome = null, ws = null, exitCode = 1;
const thrown = []; // 页面里没接住的异常（Runtime.exceptionThrown）
const waiting = new Map();
let seq = 0;
const send = (method, params = {}) => within(new Promise((resolve, reject) => {
  if (ws?.readyState !== WebSocket.OPEN) return reject(new Error(`CDP 没有连接，不能发 ${method}`));
  const id = ++seq;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
}), CALL_MS, `CDP ${method}`);
const evaluate = async expression => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(`页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
};
const until = async (expression, what) => {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (await evaluate(expression).catch(() => false)) return;
    if (Date.now() >= deadline) throw new Error(`等不到：${what}（等了 ${WAIT_MS / 1000} 秒）${thrown.length ? `；页面异常：${thrown.join(' | ')}` : ''}；页面现在：${JSON.stringify(await evaluate(`document.body.innerText.slice(0, 200)`).catch(() => null))}`);
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
const check = (name, detail) => console.log(`✔ ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  profile = await mkdtemp(path.join(tmpdir(), 'rm-rich-find-'));
  chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-gpu', '--window-size=360,640', 'about:blank',
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
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.method === 'Runtime.exceptionThrown') thrown.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') thrown.push(`${m.params.entry.text} ${m.params.entry.url ?? ''}`); const entry = waiting.get(m.id); if (!entry) return; waiting.delete(m.id); if (m.error) entry.reject(new Error(`CDP ${m.error.message}`)); else entry.resolve(m.result); });
  ws.addEventListener('close', () => { for (const { reject } of waiting.values()) reject(new Error('CDP 连接断开')); waiting.clear(); });
  await within(new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('CDP 连接失败'))); }), STARTUP_MS, 'CDP 连接');

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
  const nav = await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  if (nav.errorText) throw new Error(`页面打不开：${nav.errorText}`);
  await until(`window.__READY__ === true`, '页面载入');
  const call = expression => evaluate(`window.rich.${expression}`);
  assert.equal(await call('supported()'), true, 'Chrome 支持 CSS Custom Highlight API');

  // 1) 跨 strong、code、a
  for (const [term, what] of [['半句加粗后文', 'strong'], ['前 代码 后', 'code'], ['去 链接 吧', 'a']]) {
    const found = await call(`cross(${JSON.stringify(term)})`);
    assert.equal(found.count, '1/1', `${what}：找到一处`);
    assert.equal(found.marks, 1, `${what}：Highlight 里注册了这一处`);
    assert.equal(found.text, term, `${what}：Range 覆盖的正是搜索词`);
    assert.equal(found.crossed, true, `${what}：Range 跨了文本节点`);
    assert.ok(found.rects >= 1 && found.visible, `${what}：矩形在可视区内 ${JSON.stringify(found)}`);
    check(`跨 ${what} 的匹配：Range 覆盖「${term}」，已注册高亮，矩形在可视区内`, { rects: found.rects });
  }

  // 2) 宽表格和长代码行里的横向滚动
  for (const [term, selector, what] of [['FARCELL', '.md-table-wrap', '宽表格'], ['FARCODE', '.md-code', '长代码行']]) {
    const far = await call(`far(${JSON.stringify(term)}, ${JSON.stringify(selector)})`);
    assert.equal(far.count, '1/1', `${what}：找到一处`);
    assert.ok(far.overflow > 100, `${what}：确实横向溢出（${far.overflow}）`);
    assert.ok(far.scrollLeft > 0, `${what}：横向滚动了（${far.scrollLeft}）`);
    assert.ok(far.inWrap && far.inBody, `${what}：滚动后匹配矩形在滚动容器和正文的可视范围里 ${JSON.stringify(far)}`);
    check(`${what}：横向滚动 ${Math.round(far.scrollLeft)}px 后，匹配矩形落在可视范围里`, far.rect);
  }

  // 3) 两层收起的 details
  const hidden = await call('hiddenBefore()');
  assert.deepEqual(hidden, { rendered: false, open: [false, false] }, '收起时里面的内容不渲染（前提）');
  const nested = await call('nested()');
  assert.equal(nested.count, '1/1');
  assert.deepEqual([nested.outerOpen, nested.innerOpen], [true, true], '外层和里层都展开了');
  assert.ok(nested.rendered && nested.visible, `展开后内容渲染出来，匹配矩形在可视区内 ${JSON.stringify(nested)}`);
  check('两层收起的 details：导航后都展开，匹配矩形在可视区内', nested);

  // 4) 初始定位
  for (const k of [0, 37, 120, 150]) {
    const pos = await call(`position(${k})`);
    assert.equal(pos.count, `${k + 1}/${POS_COUNT}`, `第 ${k} 段：计数`);
    assert.equal(pos.chosen, pos.expected, `第 ${k} 段：选中的是 DOM 顺序上第一处底边在可视区顶以下的 ${JSON.stringify(pos)}`);
    assert.equal(pos.chosen, k, `第 ${k} 段：可视区顶落在它里面，选中的就是它`);
    assert.ok(pos.visible, `第 ${k} 段：在可视区内`);
    check(`初始定位：可视区顶落在第 ${k} 段里，选中第 ${k + 1} 处且在可视区内`, { count: pos.count });
  }

  assert.deepEqual(await call('errors()'), [], '页面没有报错');
  assert.deepEqual(thrown.filter(text => !text.includes('favicon.ico')), [], '页面没有未接住的异常和资源错误');
  exitCode = 0;
  console.log('rich-find 验收通过');
} catch (error) {
  console.error(error);
} finally {
  ws?.close();
  await stop(chrome);
  if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(exitCode);
