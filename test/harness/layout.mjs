// 开发用：无头 Chrome（不是 WKWebView）经 CDP 断言假 DOM 查不出的真实布局，并给 Mac 侧栏和预览、iPhone 竖屏和横屏的深浅色截图。不是产品代码。
// 自己起 harness 服务和临时目录（用完删掉），截图放在系统临时目录里，不进仓库。
// 用法：node test/harness/layout.mjs [Chrome 的路径]；失败时退出码非 0。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { HIGHLIGHT_LIMIT } from '../../view/highlight.mjs';
import { KINDS } from '../../view/icons.mjs';

const chromePath = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9334, STARTUP_MS = 60000;
const FILLER = 120; // 根目录里排在最后的一批文件，撑出第二页以后的内容
const LONG_LINES = 300; // notes.txt 的行数：文件页要滚得动，才能看最后一行是否被底部工具条挡住
const LONG_NAME = 'a-very-long-file-name-that-cannot-fit-in-a-narrow-sidebar.md'; // 名字截断时 meta 不缩
const LONG_DIR = 'long-directory-name-that-goes-on-and-on-and-on-forever', LONG_SUB = 'another-quite-long-nested-directory-name-for-the-menu';
const DEEP_FILE = 'a-file-with-a-name-that-is-long-too-so-the-path-wraps-many-lines.txt'; // docs 下的三层：行菜单的路径折很多行
const TYPED = ['app.ts', 'main.py', 'main.go', 'lib.rs', 'App.swift', 'main.c', 'Main.java', 'tool.rb', 'index.html', 'theme.css', 'data.json', 'config.yml', 'build.sh', 'notes.md', 'report.pdf',
  'photo.jpg', 'clip.mp4', 'song.mp3', 'archive.zip', 'sheet.csv', 'cache.sqlite', 'face.woff2', 'yarn.lock', 'Cargo.toml', 'query.sql', 'plain.txt', 'blob.bin']; // assets 里各种类型的文件：截图里看类型图标
const SAMPLE_JS = [ // assets/sample.js：高亮用的样本（不放在 src 里：src 的大小和项数被属性页的检查用着），关键字、字符串、模板里嵌套的表达式、正则、数字、注释、类名、装饰器都有
  '// 示例：每一行都有不同的 token',
  "import { readFile } from 'node:fs/promises';",
  'const PATTERN = /ab+c/gi;',
  'class Greeter extends Base {',
  '  greet(name = "world", times = 3) {',
  '    const message = `hello ${name.toUpperCase()}, ${times + 1}`;',
  '    if (this.count++ > 10 || name === null) return true;',
  "    return message.replace(PATTERN, 'x') + 0x1F;",
  '  }',
  '}',
  '@decorator',
  'export async function main(items) { for (const item of items) console.log(item?.value ?? undefined); }',
  '',
].join('\n');
const HIDDEN_NAME = '.DS_Store'; // 页面默认藏起来的名字之一：「显示隐藏文件」打开后它才出现，这就是选完之后该等到的样子
const ROOT_ROWS = 4 + 3 + 1 + 2 + FILLER; // 四个目录、三个文件、一个长名字、两个链接、填充；HIDDEN_NAME 默认被页面藏起来，不算
const wait = ms => new Promise(r => setTimeout(r, ms));

// 先建临时目录，之后所有资源都在 try/finally 里创建，失败时一并清理。
const base = await mkdtemp(join(tmpdir(), 'rm-ui-'));
const WT_UUID = randomUUID(), WT_PROJECT = 'coda_plugins_resource_manager'; // 0.8.1：worktree 目录名是 UUID，Coda 里的项目名取长的，四档宽度才分得开
const wtBase = join(base, 'wt'), wtDir = join(wtBase, WT_UUID);
const fixture = join(base, 'demo-project'), bulkRoot = join(base, 'bulk-project'), profile = join(base, 'profile'), shots = join(base, 'shots');
const BULK = 20000; // 图标视图的量：一个目录里这么多文件，在会话 B 里（根目录是 bulk-project）
const children = [];
let serverUrl, ws, keepShots = false;

// 起子进程：启动失败（路径不存在等）和提前退出都变成 early 的拒绝，等待启动的地方用 race 接住。
function launch(name, command, args, options) {
  const child = spawn(command, args, options);
  children.push(child);
  child.early = new Promise((_, reject) => {
    child.once('error', e => reject(new Error(`${name} 启动失败：${e.message}`)));
    child.once('exit', (code, signal) => reject(new Error(`${name} 提前退出（${signal ?? code}）`)));
  });
  child.early.catch(() => {}); // 正常收尾时的退出不算未处理的拒绝
  return child;
}
const within = (promise, ms, what) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}超时（${ms / 1000} 秒）`)), ms); })]).finally(() => clearTimeout(timer)); };
// 结束子进程并等它退出；礼貌地结束等不到就强杀。
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  if (await Promise.race([exited.then(() => true), wait(3000).then(() => false)])) return;
  child.kill('SIGKILL');
  await exited;
}
const cleanup = async () => {
  ws?.close();
  await Promise.all(children.map(stop));
  await chmod(join(fixture, 'locked'), 0o755).catch(() => {});
  // 跑完了截图才留下，中途失败时整个临时目录都删掉。
  for (const dir of keepShots ? [fixture, bulkRoot, wtBase, profile] : [base]) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};


let id = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => { waiting.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
// evaluateLive 立即求值，不等动画：过渡进行中的检查（0.7.2）要在动画中途采样。其余检查量的是终态：
// 菜单有出现动画、预览和属性页有滑入的过渡，量尺寸要等 document.getAnimations() 里的动画都播完（不靠固定睡眠），所以 evaluate 求值前先等它们。
const evaluateLive = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
const animationsDone = `Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => true)`;
const evaluate = async expr => { await evaluateLive(animationsDone).catch(() => {}); return evaluateLive(expr); };
// 页面里的脚本抛错时报出原因，不悄悄返回 undefined（高亮一节用）。
const evalStrict = async expr => { await evaluateLive(animationsDone).catch(() => {}); const { result, exceptionDetails } = (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result; if (exceptionDetails) throw new Error(`页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`); return result.value; };
// 等条件成立：按真实时间算截止，不按次数。机器忙的时候目录请求和重绘会慢，固定几秒的等待会假失败；等不到就报出在等什么。
const UNTIL_MS = 30000;
const until = async (expr, what) => {
  const deadline = Date.now() + UNTIL_MS;
  for (;;) {
    if (await evaluate(expr)) return;
    if (Date.now() >= deadline) throw new Error(`等不到：${what}（等了 ${UNTIL_MS / 1000} 秒）；页面现在：${JSON.stringify(await evaluate(`document.body.innerText.slice(0, 200)`).catch(() => null))}`);
    await wait(50);
  }
};
// 同 until，但不等动画播完：动画停在固定进度（过渡中途的检查）时，evaluate 会一直等它们播完。
const untilLive = async (expr, what) => {
  const deadline = Date.now() + UNTIL_MS;
  for (;;) {
    if (await evaluateLive(expr)) return;
    if (Date.now() >= deadline) throw new Error(`等不到：${what}（等了 ${UNTIL_MS / 1000} 秒）`);
    await wait(50);
  }
};
// 页面画完两帧：滚动事件在帧的开头派发、先于 requestAnimationFrame 的回调，所以滚动之后画两帧，滚动引起的重画和关菜单都已经发生。
const frames = () => within(evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`), 10000, '等页面画两帧');

// 改视口：等页面量到新尺寸并画完两帧。窗口的 resize 事件在帧的开头派发：不等的话它会迟到，把之后才打开的菜单关掉。所有改视口的地方都走这里。
async function setViewport(size, platform) {
  const [w, h] = SIZES[size];
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: platform === 'ios' });
  await until(`innerWidth === ${w} && innerHeight === ${h}`, `视口变成 ${size}`);
  await frames();
}

async function start() {
  // ---- 假工作目录 ----
  await mkdir(shots, { recursive: true });
  for (const dir of ['src', 'docs', 'assets', 'locked', join('docs', LONG_DIR, LONG_SUB)]) await mkdir(join(fixture, dir), { recursive: true });
  const touch = (path, text = 'x\n') => writeFile(join(fixture, path), text);
  await Promise.all([
    touch('src/app.js'), touch('assets/sample.js', SAMPLE_JS), touch('src/util.mjs'), touch('src/style.css'), touch('docs/README.md'), touch('docs/guide.txt'), touch('assets/logo.png'), touch(join('docs', LONG_DIR, LONG_SUB, DEEP_FILE)),
    ...TYPED.map(name => touch(join('assets', name))),
    touch('LICENSE'), touch('package.json', '{}\n'), touch('notes.txt', Array.from({ length: LONG_LINES }, (_, i) => `line ${i + 1}`).join('\n') + '\n'),
    touch(LONG_NAME), touch(HIDDEN_NAME), ...Array.from({ length: FILLER }, (_, i) => touch(`zz-${String(i).padStart(3, '0')}.txt`)),
  ]);
  // 修改日期有今年和往年的，今天的是刚建的：三种相对格式都能看到。
  await utimes(join(fixture, 'LICENSE'), new Date(2025, 2, 4), new Date(2025, 2, 4, 10, 0));
  await utimes(join(fixture, 'package.json'), new Date(2026, 0, 15), new Date(2026, 0, 15, 9, 30));
  await symlink('notes.txt', join(fixture, 'latest-notes'));
  await symlink('/nonexistent-target', join(fixture, 'dangling'));
  await chmod(join(fixture, 'locked'), 0);

  // 会话 W：worktree 会话，目录名是 UUID（同 Coda 给会话建的那种）；项目名不从目录里读，由 server.mjs 的 agents 替身给（第五个参数）。
  await mkdir(wtDir, { recursive: true });
  await writeFile(join(wtDir, 'README.md'), 'x\n');

  const server = launch('harness 服务', process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), fixture, bulkRoot, '0', wtDir, WT_PROJECT], { stdio: ['ignore', 'pipe', 'inherit'] });
  serverUrl = await within(Promise.race([server.early, new Promise(resolve => server.stdout.on('data', data => { const m = /http:\/\/\S+/.exec(String(data)); if (m) resolve(m[0]); }))]), STARTUP_MS, 'harness 服务启动');

  // 端口上已经有调试服务时，连上的会是别人的 Chrome，不是我们起的这个。
  if (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then(() => true, () => false)) throw new Error(`调试端口 ${DEBUG_PORT} 已被占用`);
  const chrome = launch('Chrome', chromePath, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  const connect = async () => {
    for (;;) {
      try { const page = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find(x => x.type === 'page'); if (page) return page; } catch { /* 还没起来 */ }
      await wait(200);
    }
  };
  const page = await within(Promise.race([chrome.early, connect()]), STARTUP_MS, 'Chrome 调试端口连接');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await within(new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('CDP 连接失败'))); }), STARTUP_MS, 'CDP 连接');
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id).resolve(m); waiting.delete(m.id); } });
  ws.addEventListener('close', () => { for (const { reject } of waiting.values()) reject(new Error('CDP 连接断开')); waiting.clear(); });
}

// 页面发出的请求（带 requestId 的消息）和它们的回答：记下已发出的个数和还没回答的编号，「请求都有了回答」就是目录请求和重绘都完成的信号。
// 回答的监听在捕获阶段先于页面自己的处理，但页面处理在同一个任务里完成，下一条 evaluate 到达时重绘已经发生。
// window.__open：旧检查里「打开一个条目」的写法。iPhone 是轻点（一次 click）；Mac 是一次完整的双击（浏览器的事件顺序：两次 click，再 dblclick）。0.7.0 新增的检查用真实的 CDP 鼠标和键盘，不走它。
const trackRequests = `(() => { if (window.__rpc) return; const rpc = window.__rpc = { sent: 0, open: new Set(), adds: [], copies: [], toolbars: [], log: [] }, post = coda.postMessage;
  window.__open = el => { el.click(); if (coda.platform === 'mac') { el.click(); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); } };
  coda.postMessage = message => { if (message?.requestId) { rpc.sent++; rpc.open.add(message.requestId); rpc.log.push({ type: message.type, path: message.path, offset: message.offset }); } if (message?.type === 'add_text') rpc.adds.push({ text: message.text, block: message.block }); return post(message); };
  coda.copy = text => { rpc.copies.push(text); };
  addEventListener('message', event => { if (event.data?.requestId) rpc.open.delete(event.data.requestId); if (event.data?.harness === 'toolbar' && event.data.items) rpc.toolbars.push(event.data.items); }, true); })()`;
const SIZES = { mac: [280, 700, '0,0,0,0'], window: [760, 560, '0,0,0,0'], narrow: [200, 700, '0,0,0,0'], tiny: [150, 700, '0,0,0,0'], portrait: [420, 790, '0,0,34,0'], landscape: [844, 390, '0,59,21,59'], short: [420, 220, '0,0,21,0'] };
// state：载入前写进页面的保存状态（假装上次退出时的样子，例如选中的文件）。
// extra：附在页面地址后的参数，如 '&back=0'（模拟没有 coda.back 的旧客户端）。
// ready：载入后要等到出现的元素，列表是 .row.entry，图标视图是 .gi。
async function open(size, platform, theme, { keep = false, state = null, extra = '', ready = '.row.entry' } = {}) {
  const safe = SIZES[size][2];
  await setViewport(size, platform);
  const stamp = Date.now(), url = `${serverUrl}view/index.html?platform=${platform}&theme=${theme}&safe=${safe}&t=${stamp}${extra}`;
  if (!keep) {
    await send('Page.navigate', { url: `${serverUrl}view/index.html` });
    // 等空白页（没有查询参数）载入：还停在上一页时，下面的清理会落在旧页上，新页离开时的保存又把状态写回来。
    await until(`location.pathname === '/view/index.html' && location.search === '' && document.readyState !== 'loading' && typeof coda !== 'undefined'`, '空白页载入');
    await evaluate('coda.setState = () => {}; sessionStorage.clear()');
  }
  if (state) await evaluate(`sessionStorage.setItem('harness-state:files', ${JSON.stringify(JSON.stringify(state))})`); // 空白页离开时的 pagehide 不能再把状态存回去
  await send('Page.navigate', { url });
  // navigate 返回时新页还没接手：只查行会被上一页（它的行还在）骗过去，要先等地址里的时间戳是新页的。
  await until(`new URLSearchParams(location.search).get('t') === '${stamp}'`, '新页载入');
  await until(`document.querySelectorAll('${ready}').length > 0`, '目录树出现');
  await evaluate(trackRequests);
}
// 文件页：query 是额外的参数；等正文或说明区出现。
async function openFile(size, theme, query = 'session=A&path=notes.txt', platform = 'ios') {
  const safe = SIZES[size][2];
  await setViewport(size, platform);
  const stamp = Date.now();
  await send('Page.navigate', { url: `${serverUrl}view/file.html?platform=${platform}&theme=${theme}&safe=${safe}&${query}&t=${stamp}` });
  await until(`new URLSearchParams(location.search).get('t') === '${stamp}'`, '新页载入'); // 同 open：不能让上一页的正文骗过下面的等待
  await until(`document.querySelector('.text') || document.querySelector('#notice:not(.off) p')`, '文件页出现');
}
// ⋯ 菜单：iPhone 点页内的 ⋯（同步），Mac 照控制页的方式发 { harness: 'toolbar', id: 'more' }（页面收到消息才处理）。
// 返回时消息已经处理完，菜单已经开了（或再按一次关了）。
const openMore = async platform => {
  await frames(); // 先让之前设的滚动、改的视口引出的事件都派发完：迟到的滚动、resize 事件会把刚打开的菜单关掉
  return openMoreNow(platform);
};
const openMoreNow = platform => evaluate(platform === 'ios' ? `document.querySelector('[aria-label="更多"]').click()`
  : `new Promise(resolve => { const seen = event => { if (event.data?.harness !== 'toolbar') return; removeEventListener('message', seen); resolve(); }; addEventListener('message', seen); postMessage({ harness: 'toolbar', id: 'more' }, '*'); })`);
const menuClosed = `document.getElementById('menu').hidden && document.getElementById('submenu').hidden`;
// 页面发出的请求都有了回答。
const settled = what => until(`window.__rpc.open.size === 0`, `${what}：页面发出的请求都有了回答`);
// ⋯ 菜单的第一层：刷新、显示隐藏文件、「显示」；视图和排序在「显示」里（Mac 放得下时在侧面板 #submenu，放不下和 iPhone 是菜单里的下一层）。
const ROOT_LABELS = ['刷新', '显示隐藏文件', '显示'];
// 菜单里现在看得到的按钮里找 label 并点它（JS 的 click，同步）；返回找到没有。
const clickItem = label => evaluate(`(() => { const item = [...document.querySelectorAll('#menu:not([hidden]) button, #submenu:not([hidden]) button')].find(x => x.textContent === ${JSON.stringify(label)}); item?.click(); return item !== undefined; })()`);
// 在 ⋯ 菜单里选一项，等到它真正做完：菜单（两个面板）关闭，done 成立（选完之后该看到的样子），请求都有了回答。不靠固定睡眠。
const pick = async (label, platform = 'mac', { done = null, what = '' } = {}) => {
  await openMore(platform);
  if (await evaluate(menuClosed)) throw new Error(`点「${label}」之前菜单就关了（被迟到的滚动、resize 之类的事件关掉）`);
  if (!ROOT_LABELS.includes(label) && !(await clickItem('显示'))) throw new Error('菜单里没有「显示」这一项');
  if (!(await clickItem(label))) throw new Error(`菜单里没有「${label}」这一项`);
  await until(menuClosed, `选「${label}」后菜单关闭`);
  if (done) await until(done, what);
  await settled(`选「${label}」后`);
};
// 前 12 个文件的顺序：换排序之后，目录树画完新顺序它就变了。
const fileOrder = `[...document.querySelectorAll('.row.file .name')].slice(0, 12).map(x => x.textContent).join('|')`;
// 换排序：等到文件的顺序和选之前不同（要求新排序的顺序不同于旧的）。
const pickSort = async (label, platform = 'mac') => {
  const before = await evaluate(fileOrder);
  await pick(label, platform, { done: `${fileOrder} !== ${JSON.stringify(before)}`, what: `目录树按「${label}」重画（文件的顺序变了）` });
};
// 选「显示隐藏文件」：等到隐藏文件出现在目录树里。
const pickHidden = platform => pick('显示隐藏文件', platform, { done: `[...document.querySelectorAll('.row.file .name')].some(x => x.textContent === '${HIDDEN_NAME}')`, what: `隐藏文件 ${HIDDEN_NAME} 出现在目录树里` });
const shoot = async name => { await wait(300); await writeFile(join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };

const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail}`}`); if (!ok) failures.push(name); };

// 视口里每隔一段取一个点：每一点都该落在某一行上（空白说明虚拟滚动画少了）。
const covered = `(() => { const pane = document.getElementById('tree'), r = pane.getBoundingClientRect(), miss = [];
  const head = document.querySelector('.section'), from = head && head.getClientRects().length ? Math.max(r.top, head.getBoundingClientRect().bottom) : r.top; // 标题行随内容滚走：还在视口里的那一段不算
  for (let y = from + 4; y < r.bottom - 4; y += 8) { const e = document.elementFromPoint(r.left + r.width / 2, y); if (!e?.closest('.row')) miss.push(Math.round(y)); }
  return miss; })()`;

// ---- 0.7.0 语法高亮的检查用到的页面脚本 ----
// 侧栏启动多花的时间：在同源的一个空文档里计时导入 view/highlight.mjs（含打包的库和三个额外语言的登记）。无头 Chrome 的第一个页面是冷的，之后再开的页面是热的（服务端 no-store，热只是进程里的编译缓存）。
async function measureStartup() {
  const once = async tag => {
    await send('Page.navigate', { url: `${serverUrl}view/style.css?${tag}` });
    await until(`location.search === '?${tag}' && document.readyState !== 'loading'`, '空文档载入');
    return evaluate(`(async () => { const t0 = performance.now(); const m = await import('/view/highlight.mjs?${tag}'); const t1 = performance.now();
      return { ms: t1 - t0, languages: m.hljs.listLanguages().length }; })()`);
  };
  const cold = await once('cold');
  const hot = [];
  for (const tag of ['hot1', 'hot2', 'hot3']) hot.push(await once(tag));
  return { cold: cold.ms, hot: hot.map(x => x.ms), languages: cold.languages };
}
// 每个有颜色规则的类，加上嵌套组合；颜色读的是 getComputedStyle 的最终值，底色是从 .text 往上逐层合成透明色的结果，不先四舍五入。
const HL_RULES = { keyword: 'keyword', string: 'string', comment: 'comment', number: 'number', literal: 'number', title: 'title', type: 'type', built_in: 'type', attr: 'attr', property: 'attr', attribute: 'attr',
  meta: 'meta', tag: 'tag', name: 'tag', 'selector-tag': 'tag', 'selector-class': 'tag', 'selector-id': 'tag', 'selector-pseudo': 'tag', 'selector-attr': 'tag', variable: 'variable', regexp: 'regexp',
  addition: 'addition', deletion: 'deletion', section: 'section' };
const HL_NESTED = [ // [外层类, 内层类, 内层该用哪组颜色（null：不上色，继承外层）, 外层的组]
  ['hljs-string', 'hljs-subst', null, 'string'], ['language-javascript', 'hljs-string', 'string', null], ['language-javascript', 'hljs-keyword', 'keyword', null], ['hljs-tag', 'hljs-name', 'tag', 'tag'],
  ['hljs-tag', 'hljs-attr', 'attr', 'tag'], ['hljs-meta', 'hljs-keyword', 'keyword', 'meta'], ['hljs-meta hljs-string', 'hljs-subst', null, 'meta'], ['hljs-comment', 'hljs-doctag', null, 'comment'],
  ['hljs-title class_', 'hljs-title function_', 'title', 'title'], ['hljs-string', 'hljs-comment', 'comment', 'string']];
const HL_PLAIN = ['hljs-punctuation', 'hljs-params', 'hljs-operator', 'hljs-subst', 'hljs-function', 'hljs-bullet', 'hljs-emphasis', 'hljs-strong'];
const contrastScript = `(() => {
  const rgba = css => { const v = css.match(/[\\d.]+/g).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; };
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const text = document.querySelector('.text');
  let bg = [255, 255, 255];
  const chain = []; for (let el = text; el; el = el.parentElement) chain.push(rgba(getComputedStyle(el).backgroundColor));
  for (const [r, g, b, a] of chain.reverse()) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
  const probe = document.createElement('span'); text.append(probe);
  const wanted = group => { probe.className = ''; probe.style.color = 'var(--hl-' + group + ')'; return getComputedStyle(probe).color; };
  const fg = getComputedStyle(text).color;
  const read = (outer, inner) => { const a = document.createElement('span'); a.className = outer; text.append(a); let b = a; if (inner) { b = document.createElement('span'); b.className = inner; a.append(b); }
    const color = getComputedStyle(b).color; a.remove(); return color; };
  const rows = [];
  for (const [cls, group] of Object.entries(${JSON.stringify(HL_RULES)})) rows.push({ name: 'hljs-' + cls, color: read('hljs-' + cls), want: wanted(group) });
  for (const [outer, inner, group, outerGroup] of ${JSON.stringify(HL_NESTED)}) rows.push({ name: outer + ' > ' + inner, color: read(outer, inner), want: group ? wanted(group) : outerGroup ? wanted(outerGroup) : fg });
  for (const cls of ${JSON.stringify(HL_PLAIN)}) rows.push({ name: cls + '（不上色）', color: read(cls), want: fg });
  probe.remove();
  return { bg: bg.map(Math.round).join(','), fg, rows: rows.map(r => ({ ...r, wired: r.color === r.want, ratio: ratio(rgba(r.color), bg) })) };
})()`;

let exitCode = 1;
try {
  await start();
  const startup = await measureStartup();
  // ---- 断言 ----
  // 有标题（Mac）时：滚到第二页深处，状态存下来，重新载入后恢复到同一个位置，视口里没有空白。
  await open('mac', 'mac', 'light');
  check('Mac：有分区标题', await evaluate(`document.querySelector('.section')?.textContent === 'demo-project' && document.querySelector('.section').getClientRects().length > 0`));
  const target = await evaluate(`(() => { const p = document.getElementById('tree'); p.scrollTop = p.clientHeight * 1.5 + 13; p.dispatchEvent(new Event('scroll')); return p.scrollTop; })()`);
  // 滚动之后 300 毫秒的定时器才存状态：等到存下的位置就是这个值，再重新载入。
  await until(`Object.values(JSON.parse(sessionStorage.getItem('harness-state:files') || '{"sessions":{}}').sessions).some(x => x.scroll?.tree === ${target})`, '滚动位置存进保存的状态');
  await open('mac', 'mac', 'light', { keep: true });
  await until(`document.getElementById('tree').scrollTop > 0`, '恢复滚动位置');
  await frames();
  check('Mac：有标题时恢复到第二页深处', (await evaluate(`document.getElementById('tree').scrollTop`)) === target, `存了 ${target}`);
  check('Mac：恢复后视口里每一点都有行', (await evaluate(covered)).length === 0, JSON.stringify(await evaluate(covered)));

  // 标题把列表推下去 offsetTop：画出的第一行就是 floor((滚动值 − offsetTop) / 行高) − 预渲染的 8 行，位置也对得上。
  const geometry = await evaluate(`(() => { const p = document.getElementById('tree'), sp = document.querySelector('.spacer'), sec = document.querySelector('.section'),
    rows = [...document.querySelectorAll('.row')], rowH = parseFloat(sp.style.height) / ${ROOT_ROWS}, i0 = Number(rows[0].dataset.i);
    return { offset: sp.offsetTop, title: sec.offsetHeight, first: i0, expected: Math.max(0, Math.floor((p.scrollTop - sp.offsetTop) / rowH) - 8),
      placed: rows.every(r => Math.abs(r.getBoundingClientRect().top - sp.getBoundingClientRect().top - Number(r.dataset.i) * rowH) < 0.01) }; })()`);
  check('Mac：spacer 的 offsetTop 就是标题高度', geometry.offset === geometry.title && geometry.title > 0, JSON.stringify(geometry));
  check('Mac：有标题时画出的第一行按扣掉标题的滚动值算，位置对得上', geometry.first === geometry.expected && geometry.placed, JSON.stringify(geometry));


  // 标题行随内容滚走（不吸顶）：当前在第二页深处，标题已经在容器顶之上，容器顶那一点落在的真实行，序号对得上；
  // 滚回顶部以及滚过几个点时，标题的位置恰好是 −滚动值。
  const scrolled = await evaluate(`(() => { const p = document.getElementById('tree'), sp = document.querySelector('.spacer'), sec = document.querySelector('.section'),
    rowH = parseFloat(sp.style.height) / ${ROOT_ROWS}, pr = p.getBoundingClientRect(), sr = sec.getBoundingClientRect();
    const hit = document.elementFromPoint(pr.left + pr.width / 2, pr.top + 2)?.closest('.row');
    const at = n => { p.scrollTop = n; p.dispatchEvent(new Event('scroll')); return Math.round((sec.getBoundingClientRect().top - p.getBoundingClientRect().top) * 100) / 100; };
    const result = { scroll: p.scrollTop, gone: sr.bottom <= pr.top + 0.01, position: getComputedStyle(sec).position, hit: hit ? Number(hit.dataset.i) : null,
      expected: Math.floor((p.scrollTop - sp.offsetTop + 2) / rowH), buttons: sec.querySelectorAll('button').length };
    const keep = p.scrollTop;
    result.top0 = at(0); result.top7 = at(7); result.top13 = at(13);
    p.scrollTop = keep; p.dispatchEvent(new Event('scroll'));
    return result; })()`);
  check('Mac：标题行随内容滚走（不吸顶），容器顶那一点的真实行序号对得上，标题里没有按钮', scrolled.scroll > 0 && scrolled.gone && scrolled.position === 'static' && scrolled.hit === scrolled.expected
    && scrolled.top0 === 0 && scrolled.top7 === -7 && scrolled.top13 === -13 && scrolled.buttons === 0, JSON.stringify(scrolled));
  // 滚到最底：最后一行完整可见，没有空白。
  const bottom = await evaluate(`(async () => { const p = document.getElementById('tree'); p.scrollTop = p.scrollHeight; p.dispatchEvent(new Event('scroll')); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const last = [...document.querySelectorAll('.row')].at(-1).getBoundingClientRect(), pr = p.getBoundingClientRect(); return { lastBottom: last.bottom, paneBottom: pr.bottom, text: [...document.querySelectorAll('.row')].at(-1).textContent }; })()`);
  check('Mac：滚到底，最后一行完整在容器里', bottom.text.includes('zz-119') && bottom.lastBottom <= bottom.paneBottom + 0.5, JSON.stringify(bottom));

  // 主题或字号变了之后探针重新量：spacer 的高度 = 行数 × 实际行高。
  const rowCheck = async label => {
    const { actual, per } = await evaluate(`(() => { const row = document.querySelector('.row.entry').getBoundingClientRect().height;
      return { actual: row, per: parseFloat(document.querySelector('.spacer').style.height) / ${ROOT_ROWS} }; })()`);
    check(`${label}：探针量到的行高等于实际行高`, Math.abs(actual - per) < 0.01, `实际 ${actual}，探针 ${per}`);
  };
  const rowHeight = () => evaluate(`document.querySelector('.row.entry').getBoundingClientRect().height`);
  await open('mac', 'mac', 'light');
  await rowCheck('Mac 浅色');
  check('Mac：滚动位置为 0 时第一行紧挨标题，没被遮挡', await evaluate(`(() => { const sec = document.querySelector('.section').getBoundingClientRect(), row = document.querySelector('.row').getBoundingClientRect(); return row.top >= sec.bottom - 0.01 && row.top - sec.bottom < 1; })()`));
  check('Mac：13px 时实际行高 26', (await rowHeight()) === 26, String(await rowHeight()));
  await evaluate(`postMessage({ harness: 'theme', kind: 'dark', fontSize: '20px' }, '*')`);
  await until(`document.documentElement.style.getPropertyValue('--coda-font-size') === '20px'`, '字号 20px 生效'); // 主题消息处理时同步重新量行高
  check('Mac：字号改 20px 后实际行高 40（字号真的生效了）', (await rowHeight()) === 40, String(await rowHeight()));
  await rowCheck('Mac 换深色并改字号后');
  await open('portrait', 'ios', 'light');
  await rowCheck('iPhone 竖屏');
  const adjust = `(() => { const c = getComputedStyle(document.documentElement); return (c.getPropertyValue('text-size-adjust') || c.getPropertyValue('-webkit-text-size-adjust')) })()`;
  check('index.html：关掉了文字自动放大', (await evaluate(adjust)) === '100%');
  check('iPhone：行高 58', (await evaluate(`document.querySelector('.row.entry').getBoundingClientRect().height`)) === 58);
  check('iPhone：不显示分区标题', await evaluate(`getComputedStyle(document.querySelector('.section')).display === 'none'`));
  await evaluate(`postMessage({ harness: 'theme', kind: 'dark' }, '*')`);
  await until(`document.documentElement.classList.contains('coda-dark')`, '换成深色');
  await rowCheck('iPhone 换深色后');


  // iPhone 的两行列表：58 点行高由 CSS 定、探针量得到；第二行是 日期 · 大小；不能打开的条目只有名字、垂直居中；分隔线从图标之后开始。
  await open('portrait', 'ios', 'light');
  await rowCheck('iPhone 58 点');
  const two = await evaluate(`(() => { const rows = [...document.querySelectorAll('.row.entry')], q = (row, cls) => row.querySelector(cls), box = n => n.getBoundingClientRect();
    const normal = rows.find(r => r.textContent.includes('LICENSE')), dead = rows.find(r => r.classList.contains('dead')), rb = box(normal);
    const sub = q(normal, '.sub'), name = q(normal, '.name'), d = box(q(dead, '.name')), db = box(dead), dir = rows.find(r => r.classList.contains('dir'));
    const second = rows[1], third = rows[2], before = getComputedStyle(second, '::before'), first = getComputedStyle(rows[0], '::before');
    return { normalH: rb.height, sub: sub.textContent, subShown: getComputedStyle(sub).display !== 'none', subInside: box(sub).top >= box(name).bottom - 1 && box(sub).bottom <= rb.bottom && box(name).top >= rb.top,
      metaHidden: getComputedStyle(q(normal, '.meta')).display === 'none', deadSub: q(dead, '.sub') === null, deadH: db.height, deadCentered: Math.abs((d.top + d.bottom) / 2 - (db.top + db.bottom) / 2) < 0.6,
      dirSub: q(dir, '.sub').textContent, sepLeft: before.left, sepHeight: before.height, sepTop: before.top, firstSep: first.content, thirdSep: getComputedStyle(third, '::before').left,
      stepOk: Math.abs(box(third).top - box(second).top - 58) < 0.01 }; })()`);
  check('iPhone：两行列表，名字下面是 日期 · 大小（往年/今年/今天的格式），文件夹只有日期，Mac 的 meta 隐藏', two.normalH === 58 && /^2025年3月 · \d+ B$/.test(two.sub) && two.subShown && two.subInside && two.metaHidden && /^\d\d:\d\d$/.test(two.dirSub), JSON.stringify(two));
  check('iPhone：不能打开的条目只有名字，行高 58，名字垂直居中', two.deadSub && two.deadH === 58 && two.deadCentered, JSON.stringify(two));
  check('iPhone：分隔线 1 点，从图标之后开始（首行没有），行距 58', two.sepHeight === '1px' && two.sepLeft === '46px' && two.sepTop === '0px' && two.firstSep === 'none' && two.thirdSep === '46px' && two.stepOk, JSON.stringify(two));

  // 状态行和「再显示」也是 58 点：展开 locked（读取失败的目录有一行状态）。
  await evaluate(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('locked')))`);
  await until(`[...document.querySelectorAll('.row.status')].length > 0`, '状态行出现');
  check('iPhone：状态行也是 58 点', await evaluate(`[...document.querySelectorAll('.row.status')].every(r => r.getBoundingClientRect().height === 58)`));

  // 卡片末行：滚到底，最后一行完整在卡片里，卡片没有裁掉内容。
  for (const size of ['portrait', 'landscape']) {
    await open(size, 'ios', 'light');
    const end = await evaluate(`(async () => { const p = document.getElementById('tree'); p.scrollTop = p.scrollHeight; p.dispatchEvent(new Event('scroll'));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rows = [...document.querySelectorAll('.row')], last = rows.at(-1).getBoundingClientRect(), card = document.querySelector('.spacer'), c = card.getBoundingClientRect(), pane = p.getBoundingClientRect();
      return { lastText: rows.at(-1).textContent, lastH: last.height, inCard: last.bottom <= c.bottom + 0.01, cardFits: card.scrollHeight <= card.clientHeight, inPane: last.bottom <= pane.bottom + 0.01, cardBottom: c.bottom, paneBottom: pane.bottom }; })()`);
    check(`iPhone ${size}：卡片末行完整可见`, end.lastText.includes('zz-119') && end.lastH === 58 && end.inCard && end.cardFits && end.inPane, JSON.stringify(end));
  }

  // iPhone 不再进「文件」视图（设计第 16 节），但别的入口仍可能在 iPhone 上打开它：没有底部工具条，正文照常显示（资源页里的 iPhone 预览见文件末尾的一节）。
  for (const size of ['portrait', 'landscape']) {
    await openFile(size, 'light');
    check(`file.html（iPhone ${size} 参数）：关掉了文字自动放大，正文显示，没有工具条`, (await evaluate(adjust)) === '100%'
      && (await evaluate(`document.querySelector('.text')?.textContent.trim().split('\\n').length`)) === LONG_LINES
      && (await evaluate(`document.getElementById('bar').hidden && document.getElementById('bar').children.length === 0`)));
  }

  // ⋯ 菜单：第一层是 刷新、显示隐藏文件、「显示」›；视图和排序在「显示」里。两端共用一份内容，宽度随内容，完整在页面内。
  // Mac 放得下时「显示」在根面板左边的侧面板（#submenu）里弹出；放不下和 iPhone 一样，在 #menu 里切到下一层（顶上一行返回）。
  // 0.4.0 的菜单最小宽 150 点；iPhone 上 ⋯ 菜单本来就由「显示隐藏文件」撑到 158 点。
  const ROOT_NAMES = ['刷新', '显示隐藏文件', '显示'], LAYER_NAMES = ['列表', '图标', '名称', '种类', '日期', '大小'], SORTS = ['名称', '种类', '日期', '大小'];
  const OLD_WIDTH = { mac: 150, ios: 158 };
  const boxOf = id => `(() => { const m = document.getElementById('${id}'), r = m.getBoundingClientRect(), items = [...m.querySelectorAll('button')];
    const nameOf = x => [...x.children].find(c => !c.classList.contains('check') && !c.classList.contains('sub-arrow'));
    return { shown: !m.hidden, shape: [...m.children].map(x => x.tagName), heads: [...m.querySelectorAll('.menu-head')].map(x => x.textContent), headLefts: [...m.querySelectorAll('.menu-head')].map(x => Math.round([...x.children].find(c => !c.classList.contains('check')).getBoundingClientRect().left * 10) / 10),
      items: items.map(x => ({ name: x.textContent, role: x.getAttribute('role'), checked: x.getAttribute('aria-checked'), mark: x.querySelector('.check:not(.back) svg') !== null, back: x.classList.contains('menu-back'),
        arrow: x.querySelector('.sub-arrow svg') !== null, popup: x.getAttribute('aria-haspopup'), expanded: x.getAttribute('aria-expanded'), h: x.getBoundingClientRect().height, textLeft: Math.round(nameOf(x).getBoundingClientRect().left * 10) / 10 })),
      left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight, width: Math.round((r.right - r.left) * 10) / 10, scrolls: m.scrollHeight > m.clientHeight + 1 }; })()`;
  const menuBox = boxOf('menu'), subBox = boxOf('submenu');
  const inSafe = (p, { sl = 0, sr = 0, sb = 0 } = {}) => p.left >= sl && p.right <= p.w - sr && p.top >= 0 && p.bottom <= p.h - sb + 0.5;
  const aligned = p => new Set(p.items.map(x => x.textLeft)).size === 1; // 有对勾位的项，文字都从同一处开始
  // 第一层：三个项，只有「显示」带箭头和 aria-haspopup；显示隐藏文件是开关，对勾跟着 hidden。
  const rootOk = (p, { hidden = false, ...safe } = {}) => p.shown && JSON.stringify(p.shape) === '["BUTTON","BUTTON","BUTTON"]' && JSON.stringify(p.items.map(x => x.name)) === JSON.stringify(ROOT_NAMES)
    && p.items.map(x => x.role).join() === 'menuitem,menuitemcheckbox,menuitem' && JSON.stringify(p.items.map(x => x.checked)) === JSON.stringify([null, String(hidden), null])
    && JSON.stringify(p.items.map(x => x.mark)) === JSON.stringify([false, hidden, false]) && JSON.stringify(p.items.map(x => x.arrow)) === '[false,false,true]'
    && JSON.stringify(p.items.map(x => x.popup)) === '[null,null,"menu"]' && aligned(p) && inSafe(p, safe);
  // 「显示」这一层：小标题「视图」下面列表、图标，分隔线，小标题「排序」下面四项，单选，当前项有对勾。back：在 #menu 里切到下一层时顶上多一行返回和分隔线。
  const layerOk = (p, { view = 'list', sort = '名称', back = false, ...safe } = {}) => {
    const items = back ? p.items.slice(1) : p.items;
    const shape = [...(back ? ['BUTTON', 'HR'] : []), 'P', 'BUTTON', 'BUTTON', 'HR', 'P', 'BUTTON', 'BUTTON', 'BUTTON', 'BUTTON'];
    return p.shown && JSON.stringify(p.shape) === JSON.stringify(shape) && JSON.stringify(p.heads) === '["视图","排序"]'
      && (!back || (p.items[0].name === '返回' && p.items[0].back && p.items[0].role === 'menuitem')) && JSON.stringify(items.map(x => x.name)) === JSON.stringify(LAYER_NAMES) && items.every(x => x.role === 'menuitemradio' && !x.arrow)
      && JSON.stringify(items.map(x => x.checked)) === JSON.stringify(LAYER_NAMES.map(x => String(x === (view === 'icons' ? '图标' : '列表') || x === sort)))
      && JSON.stringify(items.map(x => x.mark)) === JSON.stringify(LAYER_NAMES.map(x => x === (view === 'icons' ? '图标' : '列表') || x === sort)) && aligned(p) && inSafe(p, safe);
  };
  // 小标题的文字和选项的文字左边对齐（真实布局量出来，差不超过 1 像素）；back 那一行的文字不在选项的列里，不算。
  const headGap = p => Math.max(...p.headLefts.flatMap(left => p.items.filter(x => !x.back).map(x => Math.abs(x.textLeft - left))));
  const headAligned = async (label, p) => { const gap = headGap(p); console.log(`小标题对齐：${label} 最大差 ${gap.toFixed(1)} 像素`); check(`${label}：小标题「视图」「排序」的文字和选项的文字左边对齐，差 ${gap.toFixed(1)} 像素（不超过 1）`, p.headLefts.length === 2 && gap <= 1, JSON.stringify(p)); };
  const press = key => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)} }))`);
  // 悬停：返回这一项的 aria-expanded。给了 probe 表达式就在同一次调用里、派发之后立刻求值，返回 { expanded, probe }：
  // 悬停会启动 150 毫秒的收起计时器，要读「立刻还在」就不能跨 CDP 调用，机器忙时两次调用之间可能已经过了 150 毫秒。
  const hover = (label, probe) => evaluate(`(() => { const b = [...document.querySelectorAll('#menu button')].find(x => x.textContent === ${JSON.stringify(label)}); b.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    ${probe === undefined ? `return b.getAttribute('aria-expanded');` : `return { expanded: b.getAttribute('aria-expanded'), probe: ${probe} };`} })()`);
  const viewport = setViewport;
  const gridShown = `getComputedStyle(document.getElementById('grid')).visibility === 'visible' && document.querySelector('#grid .gi') !== null`;
  const treeShown = `getComputedStyle(document.getElementById('tree')).visibility === 'visible' && document.querySelector('.row.entry') !== null`;

  // iPhone 树页顶部：返回（仅横屏）、根目录名、⋯，没有独立的排序按钮；⋯ 菜单完整在安全区内，项至少 44 点，再次激活只关闭；「显示」在菜单里切到下一层。
  for (const [size, theme] of [['portrait', 'light'], ['landscape', 'light'], ['portrait', 'dark'], ['landscape', 'dark']]) {
    await open(size, 'ios', theme);
    const [sl, sr] = size === 'landscape' ? [59, 59] : [0, 0];
    const top = await evaluate(`(() => { const b = document.getElementById('bar'), more = b.querySelector('[aria-label="更多"]'), r = more.getBoundingClientRect(), exit = b.querySelector('.exit');
      return { title: b.querySelector('.bar-title').textContent, w: r.width, h: r.height, inside: r.right <= innerWidth - ${sr}, exitShown: exit.getClientRects().length > 0,
        children: [...b.children].map(x => x.getAttribute('aria-label') ?? x.className.split(' ')[0]), sortButtons: b.querySelectorAll('[aria-label^="排序"]').length }; })()`);
    check(`iPhone ${size} ${theme}：顶部工具条只有返回、根目录名和 44 点的 ⋯，没有排序按钮，返回${size === 'landscape' ? '显示' : '隐藏'}`,
      top.title === 'demo-project' && top.w >= 44 && top.h >= 44 && top.inside && top.exitShown === (size === 'landscape') && JSON.stringify(top.children) === JSON.stringify(['exit', 'bar-title', '更多']) && top.sortButtons === 0, JSON.stringify(top));
    await openMore('ios');
    const menu = await evaluate(menuBox);
    const expanded = await evaluate(`document.querySelector('[aria-label="更多"]').getAttribute('aria-expanded')`);
    check(`iPhone ${size} ${theme}：⋯ 菜单第一层 刷新、显示隐藏文件、「显示」›，项至少 44 点，文字对齐，完整在安全区内，宽 ${menu.width}（0.4.0 是 ${OLD_WIDTH.ios}）`,
      rootOk(menu, { sl, sr }) && menu.items.every(x => x.h >= 44) && expanded === 'true' && menu.width <= OLD_WIDTH.ios, JSON.stringify(menu));
    await openMore('ios'); // 没有 pointerdown 的再次激活，同键盘
    check(`iPhone ${size} ${theme}：再次激活 ⋯ 只关闭`, await evaluate(`document.getElementById('menu').hidden && document.querySelector('[aria-label="更多"]').getAttribute('aria-expanded') === 'false'`));
    await pickHidden('ios');
    await openMore('ios');
    const hiddenOn = await evaluate(menuBox);
    check(`iPhone ${size} ${theme}：选「显示隐藏文件」后菜单关闭，再打开时对勾在，其余各项仍对齐`, rootOk(hiddenOn, { sl, sr, hidden: true }), JSON.stringify(hiddenOn));
    if (size === 'portrait') await shoot(`ios-portrait-${theme}-menu-hidden-on`);
    // 点「显示」：菜单里切到下一层，#submenu 不出现，顶上一行返回；项至少 44 点，宽度比 0.4.0 的 ⋯ 窄，完整在安全区内。
    await clickItem('显示');
    const layer = await evaluate(menuBox);
    check(`iPhone ${size} ${theme}：点「显示」在菜单里切到下一层（视图、排序，当前项有对勾），顶上一行返回，侧面板不出现，项至少 44 点，宽 ${layer.width}（0.4.0 是 ${OLD_WIDTH.ios}）`,
      layerOk(layer, { back: true, sl, sr }) && layer.items.every(x => x.h >= 44) && layer.width < OLD_WIDTH.ios && (await evaluate(`document.getElementById('submenu').hidden`)) && !(await evaluate(`document.getElementById('menu').hidden`)), JSON.stringify(layer));
    await headAligned(`iPhone ${size} ${theme} 下一层`, layer);
    await shoot(`ios-${size}-${theme}-menu-display`);
    await clickItem('返回');
    check(`iPhone ${size} ${theme}：点返回回到第一层，对勾还在`, rootOk(await evaluate(menuBox), { sl, sr, hidden: true }));
    await clickItem('显示');
    // 旋转：整个菜单关闭。
    await viewport(size === 'portrait' ? 'landscape' : 'portrait', 'ios');
    await until(menuClosed, '旋转后整个菜单关闭');
    await viewport(size, 'ios');
    await pick('图标', 'ios', { done: gridShown, what: '选「图标」后图标视图出现' });
    await openMore('ios');
    await clickItem('显示');
    const iconsLayer = await evaluate(menuBox);
    check(`iPhone ${size} ${theme}：在图标视图里，下一层的对勾是「图标」`, layerOk(iconsLayer, { view: 'icons', back: true, sl, sr }), JSON.stringify(iconsLayer));
    if (size === 'portrait') await shoot(`ios-portrait-${theme}-menu-display-icons`);
    await press('Escape');
    check(`iPhone ${size} ${theme}：下一层里按 Escape 关闭整个菜单`, await evaluate(menuClosed));
    await pick('列表', 'ios', { done: treeShown, what: '选「列表」后目录树出现' });
  }

  // Mac 的「更多」：控制页只把项目的 id 发回，这里照它的方式往页面发 { harness: 'toolbar', id }。第一层内容和 iPhone 相同，完整在页面内，贴右上角，宽度比 150 窄，再按一次关闭。
  let flySubWidth = 0; // 侧面板的实测宽度：下面判断「窄侧栏里放不下」要用
  for (const theme of ['light', 'dark']) {
    await open('mac', 'mac', theme);
    await openMore('mac');
    const mac = await evaluate(menuBox);
    check(`Mac ${theme}：「更多」菜单第一层内容和 iPhone 相同，完整在页面内，贴右上角，宽 ${mac.width}（0.4.0 是 ${OLD_WIDTH.mac}）`,
      rootOk(mac) && mac.w - mac.right <= 8 && mac.top <= 8 && mac.width < OLD_WIDTH.mac, JSON.stringify(mac));
    await shoot(`mac-sidebar-${theme}-menu`);
    await openMore('mac');
    check(`Mac ${theme}：再按一次「更多」只关闭`, await evaluate(menuClosed));
    await pickHidden('mac');
    await openMore('mac');
    const on = await evaluate(menuBox);
    check(`Mac ${theme}：选「显示隐藏文件」后菜单关闭，再打开时对勾在，其余各项仍对齐`, rootOk(on, { hidden: true }), JSON.stringify(on));
    if (theme === 'dark') await shoot('mac-sidebar-dark-menu-hidden-on');
    await press('Escape');

    // 侧栏 280 点宽：根面板左边放得下，「显示」在左边弹出（鼠标移上去）。
    await openMore('mac');
    const before = await evaluate(`document.getElementById('submenu').hidden`);
    const expandedAfterHover = await hover('显示');
    const rootBox = await evaluate(menuBox), side = await evaluate(subBox), shownTop = await evaluate(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === '显示').getBoundingClientRect().top`);
    flySubWidth = side.width;
    check(`Mac ${theme}：鼠标移到「显示」，在根面板左边弹出侧面板（视图、排序，对勾对），根面板还在，侧面板不超出页面，宽 ${side.width} 比 0.4.0 的 ⋯（${OLD_WIDTH.mac}）窄，贴着「显示」那一项，aria-expanded 展开`,
      before && layerOk(side) && side.right <= rootBox.left && side.left >= 0 && side.width < OLD_WIDTH.mac && Math.abs(side.top + 5 - shownTop) <= 2 && expandedAfterHover === 'true' && rootOk(rootBox, { hidden: true }), JSON.stringify({ side, rootBox, shownTop }));
    await shoot(`mac-sidebar-${theme}-menu-flyout`);
    // 鼠标移到别的项：之后约 150 毫秒才收起（立刻还在），斜着移过去不误关。
    const { probe: kept } = await hover('刷新', `!document.getElementById('submenu').hidden`); // 派发和读取在同一次调用里，不和 150 毫秒计时器赛跑
    await until(`document.getElementById('submenu').hidden`, '移到别的项后侧面板收起');
    check(`Mac ${theme}：鼠标移到别的项，侧面板不是立刻收起，之后收起，「显示」复位`, kept && (await evaluate(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === '显示').getAttribute('aria-expanded')`)) === 'false');
    // 点击「显示」同样弹出；点里面不算点外面。
    await clickItem('显示');
    check(`Mac ${theme}：点「显示」也在左边弹出，菜单不换层`, layerOk(await evaluate(subBox)) && rootOk(await evaluate(menuBox), { hidden: true }));
    await headAligned(`Mac ${theme} 侧面板`, await evaluate(subBox));
    await evaluate(`document.querySelector('#submenu .menu-head').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1 }))`);
    check(`Mac ${theme}：点侧面板里面不关菜单`, !(await evaluate(`document.getElementById('submenu').hidden`)) && !(await evaluate(`document.getElementById('menu').hidden`)));
    // 菜单内部的滚动不关；页面里的滚动、Escape、点外面、失焦、窗口尺寸变化都关整个菜单。
    await evaluate(`document.getElementById('submenu').dispatchEvent(new Event('scroll')); document.getElementById('menu').dispatchEvent(new Event('scroll'))`);
    await frames();
    check(`Mac ${theme}：菜单自己的滚动不关菜单`, !(await evaluate(`document.getElementById('submenu').hidden || document.getElementById('menu').hidden`)));
    await evaluate(`document.getElementById('tree').scrollTop = 30`);
    await frames(); // 原生的滚动事件在下一帧派发
    check(`Mac ${theme}：侧面板开着时滚动目录树，两个面板都关`, await evaluate(menuClosed));
    for (const [what, act] of [['按 Escape', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`], ['点菜单外', `document.querySelector('.row.entry').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1 }))`],
      ['窗口失焦', `window.dispatchEvent(new Event('blur'))`]]) {
      await openMore('mac');
      await clickItem('显示');
      await evaluate(act);
      check(`Mac ${theme}：侧面板开着时${what}，两个面板都关`, await evaluate(menuClosed));
    }
    await openMore('mac');
    await clickItem('显示');
    await viewport('narrow', 'mac'); // 拖窄侧栏：位置对不上了
    await until(menuClosed, '窗口变窄后整个菜单关闭');
    check(`Mac ${theme}：侧面板开着时窗口尺寸变化，两个面板都关`, true);
    await viewport('mac', 'mac');
    // 选侧面板里的项：整个菜单关闭，图标视图出现；再选「列表」换回。
    await pick('图标', 'mac', { done: gridShown, what: '选「图标」后图标视图出现' });
    await openMore('mac');
    await hover('显示');
    check(`Mac ${theme}：图标视图里，侧面板的对勾是「图标」`, layerOk(await evaluate(subBox), { view: 'icons' }));
    await evaluate(`document.querySelector('#grid .gbody').scrollTop = 30`);
    await frames();
    check(`Mac ${theme}：图标视图里侧面板开着时滚动网格，两个面板都关`, await evaluate(menuClosed));
    await pick('列表', 'mac', { done: treeShown, what: '选「列表」后目录树出现' });

    // 窄侧栏：200 点宽时根面板左边还有 74 点，刚好放得下 70 点宽的侧面板（贴边也不超出页面）；150 点宽放不下，悬停什么都不做，点击在菜单里切到下一层，返回回到第一层。
    await open('narrow', 'mac', theme);
    await openMore('mac');
    const tightRoot = await evaluate(menuBox);
    await hover('显示');
    const tight = await evaluate(subBox);
    check(`Mac ${theme} narrow：根面板左边 ${Math.round(tightRoot.left)} 点，放得下 ${flySubWidth} 点宽的侧面板，照样向左弹出，不超出页面`,
      tightRoot.left - flySubWidth - 2 >= 0 && layerOk(tight) && tight.left >= 0 && tight.right <= tightRoot.left && tight.width < OLD_WIDTH.mac, JSON.stringify({ tightRoot, tight }));
    await shoot(`mac-narrow-${theme}-menu-flyout`);
    await press('Escape');
    await open('tiny', 'mac', theme);
    await openMore('mac');
    const tinyRoot = await evaluate(menuBox);
    await hover('显示');
    const hoverOnly = (await evaluate(`document.getElementById('submenu').hidden`)) && rootOk(await evaluate(menuBox));
    await clickItem('显示');
    const next = await evaluate(menuBox);
    check(`Mac ${theme} tiny：根面板左边只有 ${Math.round(tinyRoot.left)} 点，放不下 ${flySubWidth} 点宽的侧面板：悬停不动，点击切到下一层（顶上一行返回），不超出页面，宽 ${next.width}（0.4.0 是 ${OLD_WIDTH.mac}）`,
      tinyRoot.left - flySubWidth - 2 < 0 && hoverOnly && layerOk(next, { back: true }) && next.width < OLD_WIDTH.mac && (await evaluate(`document.getElementById('submenu').hidden`)), JSON.stringify({ tinyRoot, next, flySubWidth }));
    await headAligned(`Mac ${theme} 放不下切到下一层`, next);
    await shoot(`mac-tiny-${theme}-menu-display`);
    await clickItem('返回');
    check(`Mac ${theme} tiny：点返回回到第一层`, rootOk(await evaluate(menuBox)));
    await clickItem('显示');
    await clickItem('图标');
    await until(`${menuClosed} && ${gridShown}`, '窄侧栏里在下一层选「图标」');
    await settled('tiny 选「图标」后');
    await pick('列表', 'mac', { done: treeShown, what: '选「列表」后目录树出现' });
  }

  // 视口很矮（只有 212 点可用）：侧面板和下一层都有高度上限，不超出页面；下一层放不下就在菜单里滚动。
  await open('short', 'mac', 'light');
  await openMore('mac');
  await hover('显示');
  const shortSide = await evaluate(subBox);
  check('Mac 视口只有 220 点高：侧面板有高度上限，不超出页面', shortSide.shown && shortSide.top >= 0 && shortSide.bottom <= shortSide.h + 0.5, JSON.stringify(shortSide));

  // Mac 的 meta：容器查询指定了查询祖先（#tree）。宽度够时显示（名字截断、meta 不缩），窄于约 220 点时隐藏。
  await open('mac', 'mac', 'light');
  const wide = await evaluate(`(() => { const rows = [...document.querySelectorAll('.row.entry')], box = n => n.getBoundingClientRect();
    const long = rows.find(r => r.textContent.includes('${LONG_NAME.slice(0, 12)}')), plain = rows.find(r => r.textContent.includes('LICENSE')), name = long.querySelector('.name'), meta = long.querySelector('.meta');
    return { shown: getComputedStyle(meta).display !== 'none', truncated: name.scrollWidth > name.clientWidth, metaW: box(meta).width, plainW: box(plain.querySelector('.meta')).width,
      inRow: box(meta).right <= box(long).right + 0.01, text: plain.querySelector('.meta').textContent, tree: document.getElementById('tree').clientWidth,
      container: getComputedStyle(document.getElementById('tree')).containerType, subHidden: getComputedStyle(long.querySelector('.sub')).display === 'none' }; })()`);
  check('Mac 宽度够：meta 显示（大小），长名字被截断而 meta 不缩，meta 在行内；iPhone 的第二行隐藏', wide.shown && wide.truncated && wide.metaW > 0 && wide.metaW === wide.plainW && wide.inRow && wide.text === '2 B' && wide.container === 'inline-size' && wide.subHidden, JSON.stringify(wide));
  // 文件夹行：名字排序时右侧没有 meta 元素，名字可以占满；文字里没有 — 和 ·。
  const dirRow = await evaluate(`(() => { const row = document.querySelector('.row.dir'), name = row.querySelector('.name'), r = row.getBoundingClientRect(), n = name.getBoundingClientRect(), tail = row.querySelector('.tail');
    return { meta: row.querySelector('.meta'), sub: row.querySelector('.sub') !== null, text: row.textContent, gap: r.right - n.right, tailShown: getComputedStyle(tail).display !== 'none' }; })()`);
  check('Mac 文件夹行：右侧没有 meta，文字里没有 — 和 ·，名字右边只剩行内边距', dirRow.meta === null && !/[—·]/.test(dirRow.text) && dirRow.gap <= 12 && !dirRow.tailShown, JSON.stringify(dirRow));
  await open('narrow', 'mac', 'light');
  const narrow = await evaluate(`(() => ({ tree: document.getElementById('tree').clientWidth, shown: [...document.querySelectorAll('.meta')].filter(m => m.getClientRects().length > 0).length, total: document.querySelectorAll('.meta').length }))()`);
  check('Mac 窄于 220 点：meta 全部隐藏', narrow.tree < 220 && narrow.total > 0 && narrow.shown === 0, JSON.stringify(narrow));

  // 换排序：选「大小」后回到顶部、按新顺序（最大的文件在前）重画；选当前项什么都不做，不滚动。
  await open('mac', 'mac', 'light');
  await evaluate(`(() => { const p = document.getElementById('tree'); p.scrollTop = 300; p.dispatchEvent(new Event('scroll')); })()`);
  // 「什么都没发生」没有完成信号可等，所以不靠睡一会儿碰运气：选之后的同步效果（滚动、请求个数、顺序）立刻看；
  // 再做一个有明确完成信号的操作（刷新，等它发出请求并全部有了回答），确认这一整段里的变化都已落地之后，位置和顺序仍然没变。
  const stateNow = `({ scroll: document.getElementById('tree').scrollTop, order: ${fileOrder}, sent: window.__rpc.sent })`;
  const before = await evaluate(stateNow);
  await pick('名称');
  const afterPick = await evaluate(stateNow);
  await pick('刷新', 'mac', { done: `window.__rpc.sent > ${afterPick.sent}`, what: '刷新发出了请求' });
  const afterRefresh = await evaluate(stateNow);
  check('Mac：选当前排序项什么都不做，滚动位置不变', before.scroll === 300 && afterPick.scroll === 300 && afterPick.sent === before.sent && afterPick.order === before.order
    && afterRefresh.scroll === 300 && afterRefresh.order === before.order, JSON.stringify({ before, afterPick, afterRefresh }));
  await pickSort('大小');
  const bySize = await evaluate(`({ top: document.getElementById('tree').scrollTop, firstFile: document.querySelector('.row.file .name')?.textContent, firstDir: document.querySelector('.row.dir .name')?.textContent })`);
  // latest-notes 是指向 notes.txt 的链接，大小相同，平手按名字，所以它在前。
  check('Mac：选「大小」回到顶部，文件夹在前，最大的文件排在文件的最前', bySize.top === 0 && bySize.firstDir === 'assets' && bySize.firstFile === 'latest-notes', JSON.stringify(bySize));

  // 根目录名很长：iPhone 截断名字，⋯ 完整。
  await open('portrait', 'ios', 'light');
  const longName = await evaluate(`(() => { const b = document.getElementById('bar'), title = b.querySelector('.bar-title'); title.textContent = 'a-project-folder-with-an-extremely-long-name-that-cannot-fit-in-the-bar-at-all';
    const more = b.querySelector('[aria-label="更多"]').getBoundingClientRect(), tr = title.getBoundingClientRect();
    return { truncated: title.scrollWidth > title.clientWidth, moreW: more.width, moreInside: more.right <= innerWidth && more.left >= tr.right - 0.5, titleInside: tr.left >= 0 }; })()`);
  check('iPhone：根目录名长时截断名字，⋯ 完整', longName.truncated && longName.moreInside && longName.titleInside && longName.moreW >= 44, JSON.stringify(longName));
  // Mac 的标题行：根目录名很长时截断，不换行。
  await open('narrow', 'mac', 'light');
  const macTitle = await evaluate(`(() => { const sec = document.querySelector('.section'); sec.textContent = 'a-project-folder-with-an-extremely-long-name-that-cannot-fit-in-a-narrow-sidebar';
    return { truncated: sec.scrollWidth > sec.clientWidth, oneLine: sec.getBoundingClientRect().height < 40, inside: sec.getBoundingClientRect().right <= innerWidth }; })()`);
  check('Mac：标题行根目录名很长时截断，一行', macTitle.truncated && macTitle.oneLine && macTitle.inside, JSON.stringify(macTitle));

  // 行菜单：路径可以折行，不超出页面；大小 · 完整修改时间不折行。Mac 在窄侧栏里右键，iPhone 长按。
  const rowMenu = `(() => { const m = document.getElementById('menu'), r = m.getBoundingClientRect(), path = m.querySelector('.menu-path'), info = m.querySelector('.menu-info'), line = parseFloat(getComputedStyle(info).lineHeight);
    return { shown: !m.hidden, path: path.textContent, pathLines: Math.round(path.getBoundingClientRect().height / parseFloat(getComputedStyle(path).lineHeight)), infoLines: Math.round(info.getBoundingClientRect().height / line),
      infoFits: info.scrollWidth <= info.clientWidth + 0.5, info: info.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight, width: Math.round(r.width) }; })()`;
  await open('narrow', 'mac', 'light');
  await evaluate(`(() => { const row = [...document.querySelectorAll('.row.entry')].find(r => r.textContent.includes('${LONG_NAME.slice(0, 12)}')); const b = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 10 })); })()`);
  const macRow = await evaluate(rowMenu);
  check('Mac 窄侧栏：行菜单路径折行，大小 · 完整修改时间不折行，菜单完整在页面内', macRow.shown && macRow.path === LONG_NAME && macRow.pathLines >= 2 && macRow.infoLines === 1 && macRow.infoFits
    && macRow.left >= 0 && macRow.right <= macRow.w && macRow.top >= 0 && macRow.bottom <= macRow.h, JSON.stringify(macRow));

  // Mac 预览头部：图标按钮 28 点，有 aria-label 和 title，元信息是 行数 · 大小。
  await open('mac', 'mac', 'light');
  // 先展开 src、把目录树滚到非零位置：返回之后这两样都要在。
  await evaluate(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('src')))`);
  await until(`[...document.querySelectorAll('.row')].some(r => r.textContent.includes('app.js'))`, 'src 展开');
  const kept = await evaluate(`(() => { const p = document.getElementById('tree'); p.scrollTop = 40; p.dispatchEvent(new Event('scroll')); return p.scrollTop; })()`);
  await evaluate(`window.__open([...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('notes.txt')))`);
  await until(`document.querySelector('.text')`, 'Mac 预览出现');
  const mac = await evaluate(`(() => { const buttons = [...document.querySelectorAll('.phead button.icon:not([aria-label="返回"])')];
    return { labels: buttons.map(x => x.getAttribute('aria-label') + '/' + x.title), sizes: buttons.map(x => x.getBoundingClientRect().width), meta: document.querySelector('.pmeta').textContent,
      headIcon: document.querySelector('.pico svg') !== null, inside: buttons.every(x => x.getBoundingClientRect().right <= innerWidth) }; })()`);
  check('Mac：预览头部有文件图标、复制路径和窗口两个图标按钮（28 点，有 aria-label 和 title）', JSON.stringify(mac.labels) === JSON.stringify(['复制路径/复制路径', '窗口/窗口']) && mac.sizes.every(x => x === 28) && mac.headIcon && mac.inside, JSON.stringify(mac));
  check('Mac：元信息是 行数 · 大小', /^300 行 · \d/.test(mac.meta), mac.meta);

  // 预览头部最左边的返回：和其他图标按钮同样 28 点，点了回到目录树，滚动位置和展开状态不变。
  const back = await evaluate(`(() => { const head = document.querySelector('.phead'), b = head.firstElementChild, r = b.getBoundingClientRect(), o = head.querySelector('button.icon:not([aria-label="返回"])').getBoundingClientRect();
    return { label: b.getAttribute('aria-label') + '/' + b.title, icon: b.classList.contains('icon') && b.querySelector('svg') !== null, w: r.width, h: r.height, ow: o.width, oh: o.height, leftmost: r.left < head.querySelector('.pico').getBoundingClientRect().left && r.left >= 0 }; })()`);
  check('Mac：预览头部最左边是「返回」图标按钮，尺寸和其他图标按钮一致', back.label === '返回/返回' && back.icon && back.leftmost && back.w === back.ow && back.h === back.oh && back.w === 28, JSON.stringify(back));
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // 无头 Chrome 的页面默认没有焦点，document.hasFocus() 为假
  await evaluate(`(() => { const b = document.querySelector('.phead').firstElementChild; b.focus(); b.click(); })()`); // 键盘激活时焦点在按钮上
  await until(`!document.getElementById('preview').matches(':not(.off)') && !document.getElementById('browse').classList.contains('off')`, '回到目录树');
  check('Mac：点返回回到目录树，焦点在目录树', await evaluate(`document.querySelectorAll('.row.entry').length > 0 && document.activeElement === document.getElementById('tree')`));
  const after = await evaluate(`({ src: document.querySelector('.row.dir[aria-expanded="true"]')?.textContent, child: [...document.querySelectorAll('.row')].some(r => r.textContent.includes('app.js')), top: document.getElementById('tree').scrollTop })`);
  check('Mac：返回后展开的目录、它的子项和滚动位置都在', kept > 0 && after.src?.includes('src') && after.child && after.top === kept, `${JSON.stringify(after)}，滚动值 ${kept}`);

  // ---- 0.5.0：行菜单、属性页、选中文字的菜单 ----
  const menuInfo = `(() => { const m = document.getElementById('menu'), r = m.getBoundingClientRect(), items = [...m.querySelectorAll('button')], last = items.at(-1)?.getBoundingClientRect();
    return { shown: !m.hidden, shape: [...m.children].map(x => x.tagName), names: items.map(x => x.textContent), heights: items.map(x => x.getBoundingClientRect().height),
      left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight, scrolls: m.scrollHeight > m.clientHeight + 1, scrollTop: m.scrollTop, lastBottom: last?.bottom, lastTop: last?.top }; })()`;
  // 打开某一行的菜单：Mac 右键，iPhone 长按（等菜单出现）。
  const showRowMenu = async (platform, text) => {
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    const at = `(() => { const row = [...document.querySelectorAll('.row.entry')].find(r => r.textContent.includes(${JSON.stringify(text)})), r = row.getBoundingClientRect(); return [r.left + 60, r.top + r.height / 2, row]; })()`;
    if (platform === 'ios') await evaluate(`(() => { const [x, y, row] = ${at}; row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1, clientX: x, clientY: y })); })()`);
    else await evaluate(`(() => { const [x, y, row] = ${at}; row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })); })()`);
    await until(`!document.getElementById('menu').hidden`, `「${text}」的行菜单出现`);
  };
  const ROW_ITEMS = ['添加到聊天', '复制相对路径', '复制绝对路径', '属性'], ROW_SHAPE = ['BUTTON', 'BUTTON', 'BUTTON', 'HR', 'BUTTON'];
  // Mac 的第一项是「打开」，后面一条分隔线；iPhone 轻点就是打开，菜单不加。
  const MAC_OPEN = ['打开', ...ROW_ITEMS], MAC_SHAPE = ['BUTTON', 'HR', 'BUTTON', 'BUTTON', 'BUTTON', 'HR', 'BUTTON'];
  for (const [size, platform, theme] of [['mac', 'mac', 'light'], ['mac', 'mac', 'dark'], ['portrait', 'ios', 'light'], ['landscape', 'ios', 'dark']]) {
    await open(size, platform, theme);
    const [sl, sr] = size === 'landscape' ? [59, 59] : [0, 0];
    await showRowMenu(platform, 'notes.txt');
    const file = await evaluate(menuInfo);
    const body = file.shape.slice(file.shape.indexOf('BUTTON'));
    const mac = platform === 'mac';
    check(`${platform} ${size} ${theme}：行菜单 ${mac ? '打开、分隔线、' : ''}添加到聊天、复制相对路径、复制绝对路径、分隔线、属性${platform === 'ios' ? '，项至少 44 点' : ''}，完整在安全区内`,
      JSON.stringify(file.names) === JSON.stringify(mac ? MAC_OPEN : ROW_ITEMS) && JSON.stringify(body) === JSON.stringify(mac ? MAC_SHAPE : ROW_SHAPE) && (platform !== 'ios' || file.heights.every(x => x >= 44))
      && file.left >= sl && file.right <= file.w - sr && file.top >= 0 && file.bottom <= file.h, JSON.stringify(file));
    await showRowMenu(platform, 'dangling');
    const dead = await evaluate(menuInfo);
    check(`${platform} ${size} ${theme}：指向外面或失效的链接没有「添加到聊天」，有复制和属性`, JSON.stringify(dead.names) === JSON.stringify(ROW_ITEMS.slice(1)), JSON.stringify(dead));
    await showRowMenu(platform, 'latest-notes');
    check(`${platform} ${size} ${theme}：指向工作目录内的链接按目标显示，有「添加到聊天」`, JSON.stringify((await evaluate(menuInfo)).names) === JSON.stringify(mac ? MAC_OPEN : ROW_ITEMS));
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  }

  // 右键添加：点「添加到聊天」，写进内存草稿，底部出现「已添加到输入框」（普通样式）；失败改复制（这里没有第二个会话可失败，用换会话后的过期代替不了，失败由单元测试覆盖）。
  await open('mac', 'mac', 'light');
  await showRowMenu('mac', 'notes.txt');
  await evaluate(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === '添加到聊天').click()`);
  await until(`!document.getElementById('hint').hidden`, '添加成功的提示');
  const added = await evaluate(`({ text: document.getElementById('hint').textContent, warn: document.getElementById('hint').classList.contains('warn'), adds: window.__rpc.adds, copies: window.__rpc.copies,
    color: getComputedStyle(document.getElementById('hint')).color, fg: getComputedStyle(document.documentElement).color, menu: document.getElementById('menu').hidden })`);
  check('Mac：添加到聊天成功：提示「已添加到输入框」、普通样式、不复制，发的是相对路径（接在后面）', added.text === '已添加到输入框' && !added.warn && added.color === added.fg && added.menu
    && JSON.stringify(added.adds) === JSON.stringify([{ text: 'notes.txt', block: false }]) && added.copies.length === 0, JSON.stringify(added));
  await shoot('mac-hint-added');

  // 长路径的行菜单：路径折很多行，菜单有高度上限，在菜单里滚动；iPhone 横屏滚到底，最后一项（属性）能点到。
  const expandDeep = async () => {
    for (const name of ['docs', LONG_DIR, LONG_SUB]) {
      const row = `[...document.querySelectorAll('.row.dir')].find(r => r.querySelector('.name').textContent === ${JSON.stringify(name)})`;
      await until(`${row} !== undefined`, `目录树里有 ${name}`); // 上一层的子项读回来才有这一行
      await evaluate(`window.__open(${row})`);
      await until(`${row}?.getAttribute('aria-expanded') === 'true'`, `展开 ${name}`);
    }
    await until(`[...document.querySelectorAll('.row')].some(r => r.textContent.includes(${JSON.stringify(DEEP_FILE)}))`, '最深的文件出现');
  };
  for (const [size, theme] of [['landscape', 'light'], ['portrait', 'dark']]) {
    await open(size, 'ios', theme);
    await expandDeep();
    await showRowMenu('ios', DEEP_FILE);
    const long = await evaluate(menuInfo);
    const [sl, sr] = size === 'landscape' ? [59, 59] : [0, 0];
    const safeBottom = size === 'landscape' ? 21 : 34;
    check(`iPhone ${size} ${theme}：长路径的行菜单完整在安全区内，高度有上限${size === 'landscape' ? '（内容放不下，在菜单里滚动）' : ''}`,
      long.left >= sl && long.right <= long.w - sr && long.top >= 0 && long.bottom <= long.h - safeBottom + 0.5 && (size !== 'landscape' || long.scrolls), JSON.stringify(long));
    // 滚到最底：最后一项完整在菜单里，点它的中心点就落在它上面，点下去是「属性」。
    const reach = await evaluate(`(() => { const m = document.getElementById('menu'); m.scrollTop = m.scrollHeight; const b = [...m.querySelectorAll('button')].at(-1), r = b.getBoundingClientRect(), mr = m.getBoundingClientRect(),
      hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { name: b.textContent, inMenu: r.top >= mr.top && r.bottom <= mr.bottom + 0.5, onScreen: r.bottom <= innerHeight - ${safeBottom} + 0.5, hit: hit?.closest('button') === b }; })()`);
    check(`iPhone ${size} ${theme}：长路径的行菜单滚到底能点到最后一项「属性」`, reach.name === '属性' && reach.inMenu && reach.onScreen && reach.hit, JSON.stringify(reach));
    await evaluate(`[...document.querySelectorAll('#menu button')].at(-1).click()`);
    await until(`!document.getElementById('info').classList.contains('off')`, '点最后一项后属性页出现');
    check(`iPhone ${size} ${theme}：点到的是「属性」：属性页打开，路径很长的完整路径折行不撑出页面`, await evaluate(`(() => { const p = document.getElementById('info'), b = p.querySelector('.pbody'); return b.scrollWidth <= b.clientWidth && getComputedStyle(document.getElementById('tree')).visibility === 'hidden'; })()`));
  }
  // 高度上限单测：视口只有 220 点高。第一层三项放得下；「显示」这一层放不下，在菜单里滚动，不超出安全区，滚到底能点到最后一项。
  await open('short', 'ios', 'light');
  await openMore('ios');
  const shortRoot = await evaluate(menuInfo);
  check('iPhone 视口只有 220 点高：⋯ 菜单第一层三项放得下，不超出安全区', !shortRoot.scrolls && shortRoot.top >= 0 && shortRoot.bottom <= shortRoot.h - 21 + 0.5, JSON.stringify(shortRoot));
  await clickItem('显示');
  const shortMenu = await evaluate(menuInfo);
  check('iPhone 视口只有 220 点高：「显示」这一层有高度上限，内容放不下就在菜单里滚动，不超出安全区', shortMenu.scrolls && shortMenu.top >= 0 && shortMenu.bottom <= shortMenu.h - 21 + 0.5, JSON.stringify(shortMenu));
  const shortReach = await evaluate(`(() => { const m = document.getElementById('menu'); m.scrollTop = m.scrollHeight; const b = [...m.querySelectorAll('button')].at(-1), r = b.getBoundingClientRect(), mr = m.getBoundingClientRect(),
    hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { name: b.textContent, inMenu: r.top >= mr.top && r.bottom <= mr.bottom + 0.5, onScreen: r.bottom <= innerHeight - 21 + 0.5, hit: hit?.closest('button') === b }; })()`);
  check('iPhone 视口只有 220 点高：「显示」这一层滚到底能点到最后一项「大小」', shortReach.name === '大小' && shortReach.inMenu && shortReach.onScreen && shortReach.hit, JSON.stringify(shortReach));

  // 属性页：两端两种外观。文件、文件夹（真实统计）、内链接、外链接；iPhone 原生返回，Mac 头部页内返回（有 coda.back 也不声明）；横屏的返回先关属性页。
  const infoRows = `(() => Object.fromEntries([...document.querySelectorAll('#info .irow')].map(r => [r.children[0].textContent, r.children[1].textContent])))()`;
  const openInfo = async (platform, text, wait) => {
    await showRowMenu(platform, text);
    await evaluate(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === '属性').click()`);
    await until(wait, `${text} 的属性出现`);
  };
  // 离开属性页：iPhone 走原生返回（客户端的 back 事件），Mac 点头部最左边的返回。
  const leaveInfo = platform => evaluate(platform === 'ios' ? `postMessage({ harness: 'back' }, '*')` : `document.querySelector('#info .phead button[aria-label="返回"]').click()`);
  const infoState = `(() => { const p = document.getElementById('info'), t = document.getElementById('tree'), b = p.querySelector('.pbody'), r = p.getBoundingClientRect();
    return { infoShown: getComputedStyle(p).visibility === 'visible', treeHidden: getComputedStyle(t).visibility === 'hidden' && [...t.querySelectorAll('.chev svg')].every(x => getComputedStyle(x).visibility === 'hidden'), treeInert: t.inert, infoInert: p.inert, noOverflow: b.scrollWidth <= b.clientWidth,
      fits: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, name: p.querySelector('.pname')?.textContent, icon: p.querySelector('.pico svg') !== null, rows: Object.keys(${infoRows}) }; })()`;
  for (const [size, platform, theme] of [['mac', 'mac', 'light'], ['mac', 'mac', 'dark'], ['portrait', 'ios', 'light'], ['landscape', 'ios', 'dark']]) {
    await open(size, platform, theme);
    await openInfo(platform, 'notes.txt', `document.querySelectorAll('#info .irow').length >= 5`);
    const file = await evaluate(infoState), rows = await evaluate(infoRows);
    check(`${platform} ${size} ${theme}：文件的属性页盖住目录树（隐藏的面板 inert），内容、名字、图标都在，不撑出页面`, file.infoShown && file.treeHidden && file.treeInert && !file.infoInert && file.noOverflow && file.fits && file.name === 'notes.txt' && file.icon
      && rows.种类 === '文本' && /^\d+(\.\d)? KiB（[\d,]+ 字节）$/.test(rows.大小) && rows.位置 === '工作目录' && rows.完整路径.endsWith('/demo-project/notes.txt') && /^rw/.test(rows.权限), JSON.stringify({ file, rows }));
    if (platform === 'ios') check(`${platform} ${size} ${theme}：进入属性页声明了原生返回一层，头部没有返回`, JSON.stringify(await evaluate(`window.__backs`)) === JSON.stringify([['资源管理器']]) && await evaluate(`document.querySelector('#info .phead button') === null`));
    else check(`${platform} ${size} ${theme}：Mac 有 coda.back 也不声明；头部最左边是 28 点的返回图标按钮`, await evaluate(`(() => { const b = document.querySelector('#info .phead').firstElementChild, r = b.getBoundingClientRect(); return !window.__backs && b.tagName === 'BUTTON' && b.getAttribute('aria-label') === '返回' && r.width === 28 && r.height === 28; })()`));
    await shoot(`${platform}-${size}-${theme}-info-file`);
    await leaveInfo(platform);
    await until(`getComputedStyle(document.getElementById('info')).visibility === 'hidden' && getComputedStyle(document.getElementById('tree')).visibility === 'visible'`, '返回后回到目录树');
    check(`${platform} ${size} ${theme}：返回回到目录树${platform === 'ios' ? '，重新声明根层' : '，没有声明过原生返回'}；目录树不重画行（行还在）`, JSON.stringify(await evaluate(`window.__backs`)) === (platform === 'ios' ? JSON.stringify([['资源管理器'], []]) : undefined) && await evaluate(`document.querySelectorAll('.row.entry').length > 0 && document.getElementById('info').inert`));

    await openInfo(platform, 'src', `(${infoRows}).大小 !== undefined && (${infoRows}).大小 !== '计算中…'`);
    const dir = await evaluate(infoRows);
    check(`${platform} ${size} ${theme}：文件夹的属性：种类、真实统计出的大小和项数`, dir.种类 === '文件夹' && dir.大小 === '6 B（3 项）', JSON.stringify(dir));
    await shoot(`${platform}-${size}-${theme}-info-dir`);
    await leaveInfo(platform);
    await until(`getComputedStyle(document.getElementById('info')).visibility === 'hidden'`, '返回');
    await openInfo(platform, 'latest-notes', `(${infoRows}).链接到 !== undefined`);
    const inner = await evaluate(infoRows);
    check(`${platform} ${size} ${theme}：内链接按目标显示：种类带「链接」，有「链接到」`, inner.种类 === '文本（链接）' && inner.链接到 === 'notes.txt', JSON.stringify(inner));
    await leaveInfo(platform);
    await until(`getComputedStyle(document.getElementById('info')).visibility === 'hidden'`, '返回');
    await openInfo(platform, 'dangling', `(${infoRows}).种类 !== undefined`);
    const outer = await evaluate(infoRows);
    check(`${platform} ${size} ${theme}：外链接和失效的链接只有自己的元数据：没有「链接到」和大小`, outer.种类 === '链接（指向工作目录外或已失效）' && !('链接到' in outer) && !('大小' in outer), JSON.stringify(outer));
    if (theme === 'light') await shoot(`${platform}-${size}-${theme}-info-link`);
    await leaveInfo(platform);
    await until(`getComputedStyle(document.getElementById('info')).visibility === 'hidden'`, '返回');
  }
  // 没有 coda.back：头部放页内返回；iPhone 横屏：工具条的「返回」先关属性页。
  await open('mac', 'mac', 'light', { extra: '&back=0' });
  await openInfo('mac', 'notes.txt', `document.querySelectorAll('#info .irow').length >= 5`);
  check('Mac 没有 coda.back：属性页头部最左边有页内返回（28 点），没有声明', await evaluate(`(() => { const b = document.querySelector('#info .phead button'); const r = b?.getBoundingClientRect();
    return b?.getAttribute('aria-label') === '返回' && r.width === 28 && !window.__backs; })()`));
  await evaluate(`document.querySelector('#info .phead button').click()`);
  await until(`getComputedStyle(document.getElementById('tree')).visibility === 'visible'`, '页内返回后回到目录树');
  await open('landscape', 'ios', 'light');
  await openInfo('ios', 'notes.txt', `document.querySelectorAll('#info .irow').length >= 5`);
  check('iPhone 横屏：属性页里工具条的「返回」显示', await evaluate(`getComputedStyle(document.querySelector('#bar .exit')).display !== 'none'`));
  await evaluate(`document.querySelector('#bar .exit').click()`);
  await until(`getComputedStyle(document.getElementById('tree')).visibility === 'visible'`, '横屏返回关属性页');
  check('iPhone 横屏：「返回」在属性页里关属性页，没有离开视图，并重新声明根层', await evaluate(`location.pathname === '/view/index.html' && JSON.stringify(window.__backs) === '[["资源管理器"],[]]'`));

  // ---- 0.5.0 第 3 步：属性页上的工具条、类型图标的颜色、Mac 的缩进线 ----
  // 属性页上没有 ⋯：Mac 的原生工具栏声明空数组，iPhone 的页内工具条只剩返回和标题；退出恢复。
  await open('mac', 'mac', 'light');
  await openInfo('mac', 'notes.txt', `document.querySelectorAll('#info .irow').length >= 5`);
  await until(`window.__rpc.toolbars.at(-1)?.length === 0`, '属性页上原生工具栏撤空');
  check('Mac：属性页上原生工具栏没有「更多」（声明了空数组）', await evaluate(`window.__rpc.toolbars.at(-1).length === 0`));
  await leaveInfo('mac');
  await until(`JSON.stringify(window.__rpc.toolbars.at(-1)?.map(x => x.id)) === '["more"]'`, '退出属性页后恢复「更多」');
  check('Mac：退出属性页后「更多」恢复', true);
  const phoneBar = `[...document.querySelectorAll('#bar > *')].map(x => x.classList.contains('exit') ? 'exit' : x.classList.contains('bar-title') ? 'title' : x.getAttribute('aria-label'))`;
  // 工具条的实际占位：整条是否显示、高度，以及可见的按钮。
  const barBox = `(() => { const b = document.getElementById('bar'), r = b.getBoundingClientRect(), shown = [...b.querySelectorAll('button')].filter(x => x.getClientRects().length > 0);
    return { display: getComputedStyle(b).display, height: r.height, top: r.top, shown: shown.map(x => x.textContent), clickable: shown.map(x => { const q = x.getBoundingClientRect(); return document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2)?.closest('button') === x; }),
      title: b.querySelector('.bar-title')?.textContent ?? null, more: b.querySelector('[aria-label="更多"]') !== null, headTop: document.querySelector('#info .phead')?.getBoundingClientRect().top }; })()`;
  // 只改视口，不重载页面：旋转屏幕。
  const rotate = size => setViewport(size, 'ios');
  const readTree = async size => {
    const names = await evaluate(phoneBar), box = await evaluate(barBox);
    check(`iPhone ${size}：目录树上工具条是 返回、根目录名、更多`, JSON.stringify(names) === '["exit","title","更多"]' && box.title === 'demo-project' && box.more && box.height >= 44, JSON.stringify({ names, box }));
  };
  const readInfo = async size => {
    const names = await evaluate(phoneBar), box = await evaluate(barBox), land = size === 'landscape';
    check(`iPhone ${size}：属性页上工具条只有返回，没有根目录名和 ⋯`, JSON.stringify(names) === '["exit"]' && box.title === null && !box.more, JSON.stringify({ names, box }));
    if (land) check('iPhone landscape：属性页上只有「返回」，可见、至少 44 点、点得到', box.display !== 'none' && JSON.stringify(box.shown) === '["返回"]' && box.clickable.every(Boolean) && box.height >= 44, JSON.stringify(box));
    else check('iPhone portrait：属性页上整条工具条不占高度，头部贴着顶', box.display === 'none' && box.height === 0 && box.headTop === 0, JSON.stringify(box));
  };
  for (const size of ['portrait', 'landscape']) {
    await open(size, 'ios', 'light');
    await readTree(size);
    await openInfo('ios', 'notes.txt', `document.querySelectorAll('#info .irow').length >= 5`);
    await until(`JSON.stringify(${phoneBar}) === '["exit"]'`, '属性页上工具条只剩返回');
    await readInfo(size);
    if (size === 'landscape') {
      await evaluate(`document.querySelector('#bar .exit').click()`);
      await until(`getComputedStyle(document.getElementById('tree')).visibility === 'visible'`, '横屏返回关属性页');
      check('iPhone landscape：点「返回」回到目录树，没有离开视图', await evaluate(`location.pathname === '/view/index.html'`));
    } else await leaveInfo('ios');
    await until(`JSON.stringify(${phoneBar}) === '["exit","title","更多"]'`, '退出属性页后根目录名和 ⋯ 恢复');
    await readTree(size);
  }
  // 旋转：属性页开着时竖到横、横到竖，工具条跟着变；退出后根目录名和 ⋯ 都在。
  for (const [from, to] of [['portrait', 'landscape'], ['landscape', 'portrait']]) {
    await open(from, 'ios', 'light');
    await openInfo('ios', 'notes.txt', `document.querySelectorAll('#info .irow').length >= 5`);
    await readInfo(from);
    await rotate(to);
    await until(`matchMedia('(orientation: ${to})').matches`, '旋转完成');
    await frames();
    await readInfo(to);
    await leaveInfo('ios');
    await until(`JSON.stringify(${phoneBar}) === '["exit","title","更多"]'`, '旋转后退出属性页');
    await readTree(to);
  }

  // 颜色：每个 --tone-* 在 --coda-background 和 --coda-card 上的对比度不低于 3:1（读真实计算值）；.tone-* 类真的把这个颜色给到图标上；不能打开的条目仍是三级文字色。
  const TONES = [...new Set(Object.values(KINDS).map(kind => kind.tone))].filter(tone => tone !== 'accent' && tone !== 'muted');
  const colors = `(() => {
    const lum = css => { const [r, g, b] = css.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const probe = document.createElement('span'); document.body.append(probe);
    const color = value => { probe.style.cssText = 'color: ' + value; return getComputedStyle(probe).color; };
    const fill = value => { probe.style.cssText = 'background-color: ' + value; return getComputedStyle(probe).backgroundColor; };
    const bg = fill('var(--coda-background)'), card = fill('var(--coda-card)');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); document.querySelector('.ico').append(svg);
    const out = ${JSON.stringify(TONES)}.map(tone => { svg.setAttribute('class', 'tone-' + tone); const own = color('var(--tone-' + tone + ')'), drawn = getComputedStyle(svg).color;
      return { tone, own, drawn, wired: own === drawn, onBackground: Number(ratio(own, bg).toFixed(2)), onCard: Number(ratio(own, card).toFixed(2)) }; });
    svg.setAttribute('class', 'tone-accent'); const accent = getComputedStyle(svg).color === color('var(--coda-accent)');
    const dead = document.querySelector('.row.dead .ico svg'), deadOk = dead && getComputedStyle(dead).color === color('var(--coda-tertiary)');
    svg.remove(); probe.remove();
    return { bg, card, out, accent, deadOk: Boolean(deadOk) }; })()`;
  for (const theme of ['light', 'dark']) {
    await open('mac', 'mac', theme);
    const c = await evaluate(colors);
    check(`${theme}：${TONES.length} 个 --tone-* 都在 ${c.bg}（背景）和 ${c.card}（卡片）上不低于 3:1`, c.out.length === TONES.length && c.out.every(x => x.onBackground >= 3 && x.onCard >= 3), JSON.stringify(c.out.filter(x => x.onBackground < 3 || x.onCard < 3)));
    check(`${theme}：.tone-* 类把 --tone-* 的颜色给到图标上（也没有两个色调同色）`, c.out.every(x => x.wired) && new Set(c.out.map(x => x.own)).size === TONES.length, JSON.stringify(c.out.filter(x => !x.wired)));
    check(`${theme}：文件夹用强调色，不能打开的条目（链接）的图标仍是三级文字色，没有色调`, c.accent && c.deadOk, JSON.stringify({ accent: c.accent, dead: c.deadOk }));
    // 目录树里真实的图标：语言类的徽标有字母，字母的字体跟页面。
    await evaluate(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('assets')))`);
    await until(`[...document.querySelectorAll('.row .name')].some(x => x.textContent === 'app.ts')`, 'assets 展开');
    const badge = await evaluate(`(() => { const row = [...document.querySelectorAll('.row')].find(r => r.querySelector('.name')?.textContent === 'app.ts'), svg = row.querySelector('.ico svg'), text = svg.querySelector('text');
      return { letters: text?.textContent, cls: svg.getAttribute('class'), family: getComputedStyle(text).fontFamily === getComputedStyle(document.body).fontFamily, w: svg.getBoundingClientRect().width }; })()`);
    check(`${theme}：app.ts 是 TS 徽标，色调 blue，字母的字体跟页面，16 点`, badge.letters === 'TS' && badge.cls === 'tone-blue' && badge.family && badge.w === 16, JSON.stringify(badge));
    await shoot(`mac-types-${theme}`);
  }
  for (const [size, theme] of [['portrait', 'light'], ['portrait', 'dark'], ['landscape', 'dark']]) {
    await open(size, 'ios', theme);
    await evaluate(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('assets')))`);
    await until(`[...document.querySelectorAll('.row .name')].some(x => x.textContent === 'app.ts')`, 'assets 展开');
    const c = await evaluate(colors);
    check(`iPhone ${size} ${theme}：22 点的类型图标，.tone-* 同样生效`, c.out.every(x => x.wired) && c.accent && await evaluate(`document.querySelector('.row.file .ico svg').getBoundingClientRect().width === 22`), JSON.stringify(c.out.filter(x => !x.wired)));
    await shoot(`ios-${size}-${theme}-types`);
  }

  // Mac 的缩进线：每一层一条，在祖先箭头的中心；选中、悬停时还在；iPhone 没有。
  await open('mac', 'mac', 'light');
  const expandRow = async (name, child) => {
    await evaluate(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.querySelector('.name').textContent === ${JSON.stringify(name)}))`);
    await until(`[...document.querySelectorAll('.row .name')].some(x => x.textContent === ${JSON.stringify(child)})`, `${name} 展开`);
  };
  await expandRow('docs', 'README.md');
  await expandRow(LONG_DIR, LONG_SUB);
  await expandRow(LONG_SUB, DEEP_FILE);
  const guides = `(() => {
    const rows = [...document.querySelectorAll('.row')], byName = name => rows.find(r => r.querySelector('.name')?.textContent === name);
    const row = byName(${JSON.stringify(DEEP_FILE)}), after = getComputedStyle(row, '::after'), box = row.getBoundingClientRect(), indent = parseFloat(getComputedStyle(row).getPropertyValue('--indent'));
    const chevs = ['docs', ${JSON.stringify(LONG_DIR)}, ${JSON.stringify(LONG_SUB)}].map(name => { const r = byName(name).querySelector('.chev').getBoundingClientRect(); return r.left + r.width / 2; });
    const lines = chevs.map((_, k) => box.left + parseFloat(after.left) + k * indent + 0.5);
    const shallow = getComputedStyle(byName('docs'), '::after');
    return { depth: row.style.cssText, image: after.backgroundImage.startsWith('repeating-linear-gradient'), position: after.position, events: after.pointerEvents, width: parseFloat(after.width), indent,
      offsets: lines.map((x, k) => Number((x - chevs[k]).toFixed(2))), top: after.top === '0px' && after.bottom === '0px', rootWidth: parseFloat(shallow.width), before: getComputedStyle(row, '::before').content }; })()`;
  const g = await evaluate(guides);
  check('Mac：深三层的行有缩进线（重复渐变），宽 3 个缩进，贯穿整行，不挡点击', g.image && g.position === 'absolute' && g.events === 'none' && g.top && g.width === 3 * g.indent, JSON.stringify(g));
  check('Mac：每一条线都在对应祖先箭头的中心（误差不超过 0.5 点）', g.offsets.length === 3 && g.offsets.every(x => Math.abs(x) <= 0.5), JSON.stringify(g.offsets));
  check('Mac：第一层的行没有缩进线（宽 0），没有占用 ::before（iPhone 的分隔线用它）', g.rootWidth === 0 && g.before === 'none', JSON.stringify(g));
  // 悬停：真实的鼠标移动。选中：点这一行（Mac 点文件会打开预览，目录树只是被盖住，行的样式照常算出）。
  const spot = await evaluate(`(() => { const r = [...document.querySelectorAll('.row')].find(x => x.querySelector('.name')?.textContent === ${JSON.stringify(DEEP_FILE)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y });
  await until(`[...document.querySelectorAll('.row')].some(x => x.querySelector('.name')?.textContent === ${JSON.stringify(DEEP_FILE)} && x.matches(':hover'))`, '鼠标悬停在这一行');
  const ruleState = `(() => { const row = [...document.querySelectorAll('.row')].find(x => x.querySelector('.name')?.textContent === ${JSON.stringify(DEEP_FILE)}), a = getComputedStyle(row, '::after'); return { image: a.backgroundImage.startsWith('repeating-linear-gradient'), width: a.width, bg: getComputedStyle(row).backgroundColor }; })()`;
  const hovered = await evaluate(ruleState);
  check('Mac：悬停的行缩进线还在，行底色变了（线画在底色上面）', hovered.image && hovered.width === g.width + 'px' && hovered.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(hovered));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await evaluate(`window.__open([...document.querySelectorAll('.row.file')].find(x => x.querySelector('.name')?.textContent === ${JSON.stringify(DEEP_FILE)}))`);
  await until(`document.querySelector('.row.sel')`, '行被选中');
  const selected = await evaluate(`(() => { const row = document.querySelector('.row.sel'), a = getComputedStyle(row, '::after'); return { name: row.querySelector('.name').textContent, image: a.backgroundImage.startsWith('repeating-linear-gradient'), width: a.width, bg: getComputedStyle(row).backgroundColor }; })()`);
  check('Mac：选中的行缩进线还在，行有选中底色', selected.name === DEEP_FILE && selected.image && selected.width === g.width + 'px' && selected.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(selected));
  await open('mac', 'mac', 'dark');
  await expandRow('docs', 'README.md');
  await expandRow(LONG_DIR, LONG_SUB);
  await shoot('mac-guides-dark');
  await open('portrait', 'ios', 'light');
  await expandRow('docs', 'README.md');
  const phone = await evaluate(`(() => { const row = [...document.querySelectorAll('.row')].find(r => r.querySelector('.name')?.textContent === 'README.md'), a = getComputedStyle(row, '::after'), b = getComputedStyle(row, '::before');
    return { depth: row.style.cssText, after: a.content, image: a.backgroundImage, before: b.content, sepHeight: b.height }; })()`);
  check('iPhone：没有缩进线（::after 不存在），分隔线（::before）照旧', phone.after === 'none' && phone.image === 'none' && phone.before !== 'none' && phone.sepHeight === '1px', JSON.stringify(phone));

  // 选中文字的右键（Mac）：用真实的选区和 Range。三击选行（Chrome 的选区结尾落在下一行行首），拖选多行，从行号列拖进正文，裁剪后为空。
  await open('mac', 'mac', 'light');
  await evaluate(`window.__open([...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('notes.txt')))`);
  await until(`document.querySelector('.text')`, 'Mac 预览出现');
  const lineBox = line => `(() => { const el = document.querySelector('.text'), node = el.firstChild, at = node.data.indexOf('line ${line}\\n'), range = document.createRange();
    range.setStart(node, at + 2); range.setEnd(node, at + 3); const r = range.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  const selectedAfter = async () => evaluate(`getSelection().toString()`);
  const { x, y } = await evaluate(lineBox(5));
  for (const clickCount of [1, 2, 3]) { await mouse('mousePressed', x, y, { clickCount, buttons: 1 }); await mouse('mouseReleased', x, y, { clickCount }); }
  const triple = await selectedAfter();
  check('三击选行：真实选区是「line 5」（可能带换行）', triple === 'line 5' || triple === 'line 5\n', JSON.stringify(triple));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  const via = await evaluate(`!document.getElementById('menu').hidden`);
  if (!via) { await evaluate(`document.querySelector('.text').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }))`); }
  const selMenu = await evaluate(menuInfo);
  check(`三击选行后右键（${via ? '真实右键' : '合成 contextmenu 事件，无头 Chrome 没有触发'}）：三项菜单，没有路径标题`, JSON.stringify(selMenu.names) === JSON.stringify(['添加到聊天（内容）', '添加到聊天（位置）', '复制']) && await evaluate(`document.querySelector('#menu .menu-path') === null`), JSON.stringify(selMenu));
  await evaluate(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === '添加到聊天（位置）').click()`);
  await until(`window.__rpc.adds.length === 1`, '位置发出');
  check('三击选行：位置是 notes.txt:5（不是 5-6），block 为 false', JSON.stringify(await evaluate(`window.__rpc.adds`)) === JSON.stringify([{ text: 'notes.txt:5', block: false }]));
  // 程序里造的选区：偏移从 .text 的文字开头数起；from 为负数时起点在行号列里。
  const select = (from, to) => evaluate(`(() => { const el = document.querySelector('.text'), node = el.firstChild, gutter = document.querySelector('.gutter').firstChild, base = ${from} < 0 ? [gutter, 0] : [node, ${from}];
    getSelection().setBaseAndExtent(base[0], base[1], node, ${to}); return getSelection().toString().length; })()`);
  const choosePosition = async label => {
    await evaluate(`document.querySelector('.text').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }))`);
    const shown = await evaluate(`!document.getElementById('menu').hidden`);
    if (shown) await evaluate(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === ${JSON.stringify(label)}).click()`);
    return shown;
  };
  const added1 = async () => (await evaluate(`window.__rpc.adds`)).at(-1);
  // line 1\nline 2\n...：偏移 7 是第二行行首；line N 的行首是 (N-1)*7（前 9 行每行 7 个字符）。
  await select(7 + 2, 7 + 5); await choosePosition('添加到聊天（位置）'); await until(`window.__rpc.adds.length === 2`, '单行');
  check('选区行号：同一行里选几个字是 notes.txt:2', (await added1()).text === 'notes.txt:2');
  await select(7 + 2, 14 + 5); await choosePosition('添加到聊天（位置）'); await until(`window.__rpc.adds.length === 3`, '多行');
  check('选区行号：跨两行（2-3）', (await added1()).text === 'notes.txt:2-3');
  await select(7, 14); await choosePosition('添加到聊天（内容）'); await until(`window.__rpc.adds.length === 4`, '整行含换行');
  check('选区行号：整行带换行（结尾在下一行行首）不算下一行；内容类的文字原样（以换行结尾）', JSON.stringify(await added1()) === JSON.stringify({ text: 'line 2\n', block: true }));
  await select(-1, 12); await choosePosition('添加到聊天（内容）'); await until(`window.__rpc.adds.length === 5`, '从行号列拖进来');
  check('从行号列拖进正文：裁掉行号列，内容从正文开头起', (await added1()).text === 'line 1\nline 2'.slice(0, 12) || (await added1()).text.startsWith('line 1\nline'), JSON.stringify(await added1()));
  // 裁剪后为空：选区只在行号列里，或擦着正文的开头——不接管，走系统默认（菜单不出现）。
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await evaluate(`(() => { const gutter = document.querySelector('.gutter').firstChild; getSelection().setBaseAndExtent(gutter, 0, gutter, 3); })()`);
  check('选区只在行号列：不接管（没有自己的菜单）', !(await choosePosition('添加到聊天（位置）')) && await evaluate(`document.getElementById('menu').hidden`));
  await evaluate(`getSelection().removeAllRanges()`);
  check('没有选区：不接管', !(await choosePosition('添加到聊天（位置）')));
  await shoot('mac-selection-menu');

  // ---- 截图 ----
  const picked = { v: 1, seq: 1, hidden: false, sessions: { A: { at: 1, expanded: [], selected: 'notes.txt', scroll: { tree: 0, top: 0, left: 0 } } } }; // iPhone 上刚打开过 notes.txt，回到树页时它是选中行
  for (const theme of ['light', 'dark']) {
    await open('mac', 'mac', theme);
    for (const name of ['src', 'locked']) await evaluate(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('${name}')))`);
    await shoot(`mac-sidebar-${theme}`);
    await evaluate(`window.__open([...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('notes.txt')))`);
    await until(`document.querySelector('.text')`, 'Mac 预览出现');
    await shoot(`mac-preview-${theme}`);
    // 按日期、按大小排序，⋯ 菜单打开的样子（Mac）。
    await open('mac', 'mac', theme);
    await evaluate(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('src')))`);
    await pickSort('日期');
    await shoot(`mac-sidebar-date-${theme}`);
    await pickSort('大小');
    await shoot(`mac-sidebar-size-${theme}`);
    await openMore('mac');
    await shoot(`mac-sidebar-size-${theme}-menu`);
    for (const size of ['portrait', 'landscape']) {
      await open(size, 'ios', theme, { state: picked });
      await evaluate(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('src')))`);
      await evaluate(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('locked')))`);
      await shoot(`ios-${size}-${theme}`);
      await evaluate(`document.querySelector('[aria-label="更多"]').click()`);
      await shoot(`ios-${size}-${theme}-menu`);
      // 长按一行：菜单里路径下面有 大小 · 完整修改时间。
      await evaluate(`document.getElementById('menu').hidden = true`);
      await evaluate(`(() => { const row = [...document.querySelectorAll('.row.entry')].find(r => r.textContent.includes('LICENSE')), r = row.getBoundingClientRect();
        row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1, clientX: r.left + 80, clientY: r.top + 20 })); })()`);
      await until(`!document.getElementById('menu').hidden`, '长按后行菜单出现');
      const held = await evaluate(`(() => { const m = document.getElementById('menu').getBoundingClientRect(); return { shown: !document.getElementById('menu').hidden, path: document.querySelector('.menu-path')?.textContent, info: document.querySelector('.menu-info')?.textContent,
          inside: m.left >= 0 && m.right <= innerWidth && m.top >= 0 && m.bottom <= innerHeight }; })()`);
      check(`iPhone ${size} ${theme}：长按菜单有信息行，完整在页面内`, held.shown && held.path === 'LICENSE' && /^2 B · 2025-03-04 10:00:00$/.test(held.info) && held.inside, JSON.stringify(held));
      await shoot(`ios-${size}-${theme}-longpress`);
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      // 长名字：路径折行，大小 · 完整修改时间不折行，菜单不超出页面。
      await evaluate(`(() => { const row = [...document.querySelectorAll('.row.entry')].find(r => r.textContent.includes('${LONG_NAME.slice(0, 12)}')), r = row.getBoundingClientRect();
        row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1, clientX: r.left + 80, clientY: r.top + 20 })); })()`);
      await until(`!document.getElementById('menu').hidden`, '长按长名字后行菜单出现');
      const longRow = await evaluate(rowMenu);
      const [sl, sr] = size === 'landscape' ? [59, 59] : [0, 0];
      check(`iPhone ${size} ${theme}：长名字的行菜单路径折行，大小 · 完整修改时间不折行，完整在安全区内`, longRow.shown && longRow.path === LONG_NAME && longRow.pathLines >= 2 && longRow.infoLines === 1 && longRow.infoFits
        && longRow.left >= sl && longRow.right <= longRow.w - sr && longRow.top >= 0 && longRow.bottom <= longRow.h, JSON.stringify(longRow));
      await shoot(`ios-${size}-${theme}-longpress-long`);
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await pickSort('日期', 'ios');
      await shoot(`ios-${size}-${theme}-date`);
      await openFile(size, theme);
      await shoot(`ios-${size}-${theme}-file`);
    }
  }

  // ================= 图标视图（0.6.0）=================
  // 起点：保存的状态里 view 是 icons（页面真实的恢复路径）；运行中切换走真实的「更多」菜单 →「显示」。
  const ICONS = { v: 1, seq: 1, hidden: false, view: 'icons', sessions: {} };
  const openGrid = (size, platform, theme, extra = {}) => open(size, platform, theme, { state: ICONS, ready: '#grid .cell', ...extra });
  const switchView = view => pick(view === 'icons' ? '图标' : '列表', 'mac', { done: view === 'icons' ? gridShown : treeShown, what: `切到${view === 'icons' ? '图标' : '列表'}视图` });
  const bodyOf = `document.querySelector('#grid .gbody')`;
  // 画出来的单元格：宽高、第一行有几个、都在容器横向范围里；列数应是 floor(容器宽 / 单元格宽)。
  const gridBox = `(() => { const body = ${bodyOf}, cells = [...document.querySelectorAll('#grid .cell')], box = body.getBoundingClientRect(), first = cells[0].getBoundingClientRect();
    const row0 = cells.filter(c => Math.abs(c.getBoundingClientRect().top - first.top) < 1);
    return { clientWidth: body.clientWidth, cellW: first.width, cellH: first.height, perRow: row0.length, cols: Math.floor(body.clientWidth / first.width), n: cells.length,
      inside: cells.every(c => { const r = c.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5; }) }; })()`;
  // 视口里每隔一段取一个点：每一点都该落在某一行单元格或说明项的纵向范围里（没有就是空白，虚拟滚动画少了）。
  // 内容上下各有 8 点的留白（.gspacer 的外边距），那一段不算内容，不查。
  const gridCovered = `(() => { const box = ${bodyOf}.getBoundingClientRect(), sp = document.querySelector('#grid .gspacer').getBoundingClientRect(), items = [...document.querySelectorAll('#grid .gi')].map(c => c.getBoundingClientRect()), miss = [];
    for (let y = Math.max(box.top, sp.top) + 4; y < Math.min(box.bottom, sp.bottom) - 4; y += 8) if (!items.some(r => r.top <= y && y < r.bottom)) miss.push(Math.round(y));
    return miss; })()`;
  // 单元格的名字不含图标里的字母（语言类图标是两个字母）：取 .gname；说明项取整段文字。
  const gridNames = `[...document.querySelectorAll('#grid .gi')].map(c => c.querySelector('.gname')?.textContent ?? c.textContent)`;
  const clickCell = name => evaluate(`window.__open([...document.querySelectorAll('#grid .cell')].find(c => c.querySelector('.gname').textContent === ${JSON.stringify(name)}))`);
  const gridScroll = () => evaluate(`${bodyOf}.scrollTop`);
  const setGridScroll = top => evaluate(`(() => { const b = ${bodyOf}; b.scrollTop = ${top}; b.dispatchEvent(new Event('scroll')); return b.scrollTop; })()`);
  const headName = `document.querySelector('#grid .gname-head')?.textContent`;

  // 两端、两种外观：单元格的尺寸、列数、不超出容器；文件夹是强调色；长名字折两行并截断，单元格高度不变。
  const GRID_SIZES = [['mac', 'mac', 72], ['narrow', 'mac', 72], ['portrait', 'ios', 88], ['landscape', 'ios', 88]];
  for (const theme of ['light', 'dark']) {
    for (const [size, platform, cellW] of GRID_SIZES) {
      await openGrid(size, platform, theme);
      const g = await evaluate(gridBox);
      const label = `图标视图 ${size} ${theme}`;
      check(`${label}：单元格宽 ${cellW} 点，列数 = floor(容器宽 / ${cellW})，第一行就是这么多个，都在容器里`, g.cellW === cellW && g.perRow === g.cols && g.cols >= 1 && g.inside, JSON.stringify(g));
      const heights = await evaluate(`(() => { const hs = [...document.querySelectorAll('#grid .cell')].map(c => c.getBoundingClientRect().height); return { min: Math.min(...hs), max: Math.max(...hs), probe: parseFloat(document.querySelector('#grid .gspacer').style.height) / Math.ceil(${ROOT_ROWS} / ${g.cols}) }; })()`);
      check(`${label}：单元格高度固定，spacer 的高度 = 行数 × 探针量到的高度`, heights.max - heights.min < 0.01 && Math.abs(heights.probe - heights.min) < 0.01, JSON.stringify(heights));
      const longName = await evaluate(`(() => { const cell = [...document.querySelectorAll('#grid .cell')].find(c => c.querySelector('.gname').textContent === '${LONG_NAME}'); if (!cell) return null;
        const name = cell.querySelector('.gname'), n = name.getBoundingClientRect(), c = cell.getBoundingClientRect(), line = parseFloat(getComputedStyle(name).lineHeight);
        return { lines: Math.round(n.height / line), clipped: name.scrollHeight > name.clientHeight, fits: n.bottom <= c.bottom + 0.5, cellH: c.height }; })()`);
      // 长名字排在第二页之后的位置：取不到就滚过去再取。
      if (longName) check(`${label}：长名字折成两行再截断，不撑高单元格`, longName.lines === 2 && longName.clipped && longName.fits, JSON.stringify(longName));
      check(`${label}：文件夹的图标是强调色，不能打开的条目不上彩色`, await evaluate(`(() => { const dir = getComputedStyle(document.querySelector('#grid .cell.dir .gico')).color, probe = document.createElement('i'); probe.style.color = 'var(--coda-accent)'; document.body.append(probe);
        const accent = getComputedStyle(probe).color; probe.remove(); const dead = document.querySelector('#grid .cell.dead'); return dir === accent && (!dead || getComputedStyle(dead.querySelector('.gico')).color !== accent); })()`));
      check(`${label}：目录树面板不可见，网格面板可见`, await evaluate(`getComputedStyle(document.getElementById('tree')).visibility === 'hidden' && getComputedStyle(document.getElementById('grid')).visibility === 'visible'`));
      if (platform === 'mac') check(`${label}：头部是根目录名，没有返回键`, (await evaluate(headName)) === 'demo-project' && (await evaluate(`document.querySelectorAll('#grid .ghead button').length`)) === 0);
      else check(`${label}：没有页内头部（原生返回），工具条标题是根目录名`, (await evaluate(`getComputedStyle(document.querySelector('#grid .ghead')).display`)) === 'none' && (await evaluate(`document.querySelector('.bar-title')?.textContent`)) === 'demo-project');
      await shoot(`grid-${size}-${theme}`);
    }
  }

  // 安全区：iPhone 横屏（左右各 59、底 21）。第一列在安全区之外，滚到底最后一行完整可见。
  await openGrid('landscape', 'ios', 'light');
  const safe = await evaluate(`(async () => { const b = ${bodyOf}; b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cells = [...document.querySelectorAll('#grid .cell')], box = b.getBoundingClientRect(), last = cells.at(-1).getBoundingClientRect();
    return { left: Math.min(...cells.map(c => c.getBoundingClientRect().left)), right: Math.max(...cells.map(c => c.getBoundingClientRect().right)), w: innerWidth, bottom: last.bottom, paneBottom: box.bottom, text: cells.at(-1).textContent }; })()`);
  check('图标视图 iPhone 横屏：左右留出安全区，滚到底最后一行完整可见（底部安全区之上）', safe.left >= 59 && safe.right <= safe.w - 59 && safe.text.includes('zz-119') && safe.bottom <= safe.paneBottom - 21 + 0.5, JSON.stringify(safe));

  // 真实交互（Mac）：单击进入、头部返回、回去恢复位置；进入时回到顶部。
  await openGrid('mac', 'mac', 'light');
  const rootTop = await setGridScroll(240);
  await clickCell('docs');
  await until(`${headName} === 'docs'`, '进入 docs');
  await settled('进入 docs');
  const entered1 = { scroll: await gridScroll(), back: await evaluate(`document.querySelectorAll('#grid .ghead button[aria-label="返回"]').length`), names: (await evaluate(gridNames)).slice(0, 4) };
  check('图标视图：单击文件夹进入这一层，头部有返回键和目录名，进入后在顶部', entered1.scroll === 0 && entered1.back === 1 && entered1.names.includes('README.md'), JSON.stringify(entered1));
  await evaluate(`document.querySelector('#grid .ghead button').click()`);
  await until(`${headName} === 'demo-project'`, '回到根目录');
  await frames();
  check('图标视图：回上一层恢复进去之前的滚动位置，视口里没有空白', (await gridScroll()) === rootTop && (await evaluate(gridCovered)).length === 0, `${await gridScroll()} / ${rootTop}`);
  await clickCell('docs');
  await until(`${headName} === 'docs'`, '再进 docs');
  await clickCell(LONG_DIR);
  await until(`${headName} === '${LONG_DIR}'`, '进入长目录名');
  check('图标视图：头部标题是当前目录名（长名字截断不撑破头部）', await evaluate(`(() => { const h = document.querySelector('#grid .ghead'), n = h.querySelector('.gname-head'); return h.scrollWidth <= h.clientWidth + 1 && n.scrollWidth >= n.clientWidth; })()`));
  await shoot('grid-mac-nested');

  // 保存和恢复（真实的 setState/getState）：根目录滚到某处、进入 docs，存下之后重新载入，回到 docs，位置在，往上一层回到顶部之外的……（内存的记录没了，回到顶部）。
  await openGrid('mac', 'mac', 'light');
  await clickCell('docs');
  await until(`${headName} === 'docs'`, '进入 docs');
  await until(`Object.values(JSON.parse(sessionStorage.getItem('harness-state:files') || '{"sessions":{}}').sessions).some(x => x.cwd === 'docs')`, 'cwd 存进保存的状态');
  await open('mac', 'mac', 'light', { keep: true, ready: '#grid .gi' });
  await until(`${headName} === 'docs' && ${gridNames}.includes('README.md')`, '重新载入后回到 docs，条目到了'); // 标题先于条目出现：要等条目
  check('图标视图：重新载入后回到保存的目录', (await evaluate(gridNames)).includes('README.md'), JSON.stringify((await evaluate(gridNames)).slice(0, 4)));
  await evaluate(`document.querySelector('#grid .ghead button').click()`);
  await until(`${headName} === 'demo-project'`, '往上一层');
  await frames();
  check('图标视图：重建后再往上一层回到顶部（上层的记录只在内存里）', (await gridScroll()) === 0);

  // 恢复的位置比内容还大（内容变少）：浏览器夹到能到的最大值，不跳回顶部也不越界。
  await openGrid('mac', 'mac', 'light');
  await clickCell('docs');
  await until(`${headName} === 'docs'`, '进入 docs');
  await until(`Object.values(JSON.parse(sessionStorage.getItem('harness-state:files') || '{"sessions":{}}').sessions).some(x => x.cwd === 'docs')`, 'cwd 存进保存的状态');
  await evaluate(`(() => { const key = 'harness-state:files', st = JSON.parse(sessionStorage.getItem(key)); for (const record of Object.values(st.sessions)) record.scroll.grid = 99999; sessionStorage.setItem(key, JSON.stringify(st)); })()`);
  await open('mac', 'mac', 'light', { keep: true, ready: '#grid .gi' });
  await until(`${headName} === 'docs' && ${gridNames}.includes('README.md')`, '重新载入后回到 docs，条目到了'); // 标题先于条目出现：要等条目
  await frames();
  const clamped = await evaluate(`(() => { const b = ${bodyOf}; return { top: b.scrollTop, max: b.scrollHeight - b.clientHeight }; })()`);
  check('图标视图：恢复的位置大于内容时用能到的最大值（不越界）', clamped.top === clamped.max && clamped.top >= 0, JSON.stringify(clamped));

  // 两种视图各自的滚动位置：列表滚到某处，切到图标再滚，换回去两边都在；展开状态在。
  await open('mac', 'mac', 'light');
  const listTop = await evaluate(`(() => { const p = document.getElementById('tree'); p.scrollTop = 300; p.dispatchEvent(new Event('scroll')); return p.scrollTop; })()`);
  await switchView('icons');
  await until(`${gridNames}.length > 0`, '图标视图出现');
  await frames();
  const gridTop = await setGridScroll(200);
  await switchView('list');
  await until(`getComputedStyle(document.getElementById('tree')).visibility === 'visible'`, '换回列表');
  await frames();
  check('图标视图：切换视图，列表的滚动位置还在', (await evaluate(`document.getElementById('tree').scrollTop`)) === listTop && (await evaluate(covered)).length === 0, String(await evaluate(`document.getElementById('tree').scrollTop`)));
  await switchView('icons');
  await until(`getComputedStyle(document.getElementById('grid')).visibility === 'visible'`, '换回图标');
  await frames();
  check('图标视图：换回图标，网格的滚动位置还在，视口里没有空白', (await gridScroll()) === gridTop && (await evaluate(gridCovered)).length === 0, `${await gridScroll()} / ${gridTop}`);

  // iPhone 原生返回：路径只声明一处，on(back) 按 steps 退层（控制页的返回按钮发 { harness: 'back' }，steps 恒为 1）。
  await openGrid('portrait', 'ios', 'light');
  await clickCell('docs');
  await until(`${gridNames}.includes('README.md')`, '进入 docs');
  await clickCell(LONG_DIR);
  await until(`${gridNames}.includes('${LONG_SUB}')`, '进入长目录');
  const backs = await evaluate(`window.__backs`);
  check('图标视图 iPhone：coda.back 声明上层的标题（由远到近，不含当前页）', JSON.stringify(backs.at(-1)) === JSON.stringify(['demo-project', 'docs']), JSON.stringify(backs));
  await evaluate(`postMessage({ harness: 'back' }, '*')`);
  await until(`document.querySelector('.bar-title').textContent === 'docs'`, '原生返回退了一层');
  check('图标视图 iPhone：原生返回退一层，工具条标题跟着变，路径重新声明', JSON.stringify((await evaluate(`window.__backs`)).at(-1)) === JSON.stringify(['demo-project']) && (await evaluate(gridNames)).includes('README.md'));
  await shoot('grid-ios-nested');
  await openGrid('landscape', 'ios', 'light');
  await clickCell('docs');
  await until(`${gridNames}.includes('README.md')`, '横屏进入 docs');
  await evaluate(`document.querySelector('.bar .exit').click()`);
  await until(`${gridNames}.includes('zz-000.txt') || ${gridNames}.includes('src')`, '横屏返回退一层');
  check('图标视图 iPhone 横屏：页内返回先退目录，不关视图', (await evaluate(`window.__backs`)).length >= 1 && !(await evaluate(gridNames)).includes('README.md'));

  // ---- 两万条：节点数、滚动、进入目录的耗时 ----
  await mkdir(join(bulkRoot, 'bulk'), { recursive: true });
  await mkdir(join(bulkRoot, 'small'), { recursive: true });
  await writeFile(join(bulkRoot, 'small', 'x.txt'), 'x');
  for (let from = 0; from < BULK; from += 500) await Promise.all(Array.from({ length: Math.min(500, BULK - from) }, (_, i) => writeFile(join(bulkRoot, 'bulk', `item-${String(from + i).padStart(5, '0')}.txt`), '')));
  await openGrid('mac', 'mac', 'light');
  await fetch(`${serverUrl}ctl?action=session:B`); // 会话 B 的根目录是 bulk-project
  await until(`${gridNames}.includes('bulk')`, '会话 B 的根目录');
  await settled('会话 B');
  const entered = await evaluate(`(async () => { const t0 = performance.now(); window.__open([...document.querySelectorAll('#grid .cell')].find(c => c.querySelector('.gname').textContent === 'bulk'));
    while (![...document.querySelectorAll('#grid .cell')].some(c => c.querySelector('.gname').textContent.startsWith('item-'))) await new Promise(r => requestAnimationFrame(r));
    return performance.now() - t0; })()`);
  // 一页（96 KiB）放不下 2 万条：翻到底。
  for (let i = 0; i < 80; i++) {
    const height = await evaluate(`parseFloat(document.querySelector('#grid .gspacer').style.height)`);
    const clicked = await evaluate(`(async () => { const b = ${bodyOf}; b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const more = document.querySelector('#grid .gnote.more'); if (!more) return false; more.click(); return true; })()`);
    if (!clicked) break;
    await until(`parseFloat(document.querySelector('#grid .gspacer').style.height) > ${height}`, '翻页后的新一页');
  }
  const total = await evaluate(`(() => { const sp = document.querySelector('#grid .gspacer'), cell = document.querySelector('#grid .cell').getBoundingClientRect().height, cols = Math.floor(${bodyOf}.clientWidth / 72);
    return { rows: Math.round(parseFloat(sp.style.height) / cell), expected: Math.ceil(${BULK} / cols), cols }; })()`);
  check(`图标视图：${BULK} 条全部翻出来，总高度就是 ceil(n / 列数) 行`, total.rows === total.expected, JSON.stringify(total));
  let maxNodes = 0, blank = [];
  for (const fraction of [0, 0.13, 0.37, 0.5, 0.71, 0.99, 1]) {
    await evaluate(`(() => { const b = ${bodyOf}; b.scrollTop = (b.scrollHeight - b.clientHeight) * ${fraction}; b.dispatchEvent(new Event('scroll')); })()`);
    await frames();
    maxNodes = Math.max(maxNodes, await evaluate(`document.querySelectorAll('#grid .gi').length`));
    blank.push(...(await evaluate(gridCovered)));
  }
  check(`图标视图：${BULK} 条滚过 7 个位置，视口里没有空白`, blank.length === 0, JSON.stringify(blank));
  check(`图标视图：${BULK} 条时画出的节点数有上限（可见的一段加上下各 2 行）`, maxNodes > 0 && maxNodes <= 3 * 40, String(maxNodes));
  console.log(`数字（本机无头 Chrome，不是 WKWebView）：${BULK} 条目录，Mac 侧栏 ${total.cols} 列，滚动时最多 ${maxNodes} 个节点，进入目录到第一屏出现 ${Math.round(entered)} 毫秒`);
  await fetch(`${serverUrl}ctl?action=session:A`);
  // ---- 0.7.0：语法高亮 ----
  // 启动：导入 view/highlight.mjs（库加三个额外语言）多花的时间。
  const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  console.log(`数字（本机无头 Chrome）：侧栏启动多花的时间：冷 ${startup.cold.toFixed(1)} 毫秒；热（同进程再开页面）${startup.hot.map(x => x.toFixed(1)).join('、')} 毫秒，中位数 ${median(startup.hot).toFixed(1)} 毫秒；登记了 ${startup.languages} 种语言`);
  check('高亮：库里有 39 种语言（内置 36 加 dockerfile、dart、scala）', startup.languages === 39, String(startup.languages));
  check('高亮：侧栏启动多花的时间，热启动不超过 30 毫秒（超过要改成打开文件时才导入）', median(startup.hot) <= 30, `热 ${startup.hot.join('、')}`);

  // 深浅两种外观 × 三个入口：Mac 侧栏预览、Mac 窗口、iPhone 文件页。每个入口都截图，并检查真实 token 的颜色。
  const openSidebarSample = async theme => {
    await open('mac', 'mac', theme);
    await evalStrict(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('assets')))`);
    await until(`[...document.querySelectorAll('.row.file')].some(r => r.textContent.includes('sample.js'))`, 'assets 展开');
    await evalStrict(`window.__open([...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('sample.js')))`);
    await until(`document.querySelector('.text .hljs-keyword')`, '侧栏预览出现上色的代码');
  };
  const openPhoneSample = async theme => { // 资源页里的 iPhone 预览：轻点（一次 click）
    await open('portrait', 'ios', theme);
    await evalStrict(`window.__open([...document.querySelectorAll('.row.dir')].find(r => r.textContent.includes('assets')))`);
    await until(`[...document.querySelectorAll('.row.file')].length > 3`, 'assets 展开');
    // 列表是虚拟化的，sample.js 在 assets 靠后：滚到那一段再点。
    await evalStrict(`(() => { const t = document.getElementById('tree'); t.scrollTop = 58 * 22; t.dispatchEvent(new Event('scroll')); })()`);
    await until(`[...document.querySelectorAll('.row.file')].some(r => r.textContent.includes('sample.js'))`, 'sample.js 滚进视口');
    await evalStrict(`window.__open([...document.querySelectorAll('.row.file')].find(r => r.textContent.includes('sample.js')))`);
    await until(`document.querySelector('.text .hljs-keyword')`, '资源页的 iPhone 预览出现上色的代码');
  };
  const entries = [
    ['Mac 侧栏', theme => openSidebarSample(theme), 'sidebar'],
    ['Mac 窗口', theme => openFile('window', theme, 'session=A&path=assets/sample.js', 'mac'), 'window'],
    ['iPhone 资源页', theme => openPhoneSample(theme), 'ios'],
  ];
  for (const [label, enter, shot] of entries) for (const theme of ['light', 'dark']) {
    await enter(theme);
    await until(`document.querySelector('.text .hljs-keyword')`, `${label} ${theme}：出现上色的代码`);
    const real = await evalStrict(`(() => { const text = document.querySelector('.text'), pick = cls => { const el = text.querySelector(cls); return el && getComputedStyle(el).color; };
      const probe = document.createElement('span'); text.append(probe); probe.style.color = 'var(--hl-keyword)'; const kw = getComputedStyle(probe).color; probe.style.color = 'var(--hl-string)'; const st = getComputedStyle(probe).color; probe.remove();
      return { keyword: pick('.hljs-keyword'), wantKeyword: kw, string: pick('.hljs-string'), wantString: st, fg: getComputedStyle(text).color, text: text.textContent,
        only: [...text.querySelectorAll('*')].every(x => x.tagName === 'SPAN'), nodes: text.querySelectorAll('span').length, meta: document.querySelector('.pmeta').textContent,
        style: [...text.querySelectorAll('span')].slice(0, 200).every(x => { const c = getComputedStyle(x); return c.fontWeight === '400' && c.fontStyle === 'normal' && c.backgroundColor === 'rgba(0, 0, 0, 0)'; }) }; })()`);
    check(`${label} ${theme}：真实的代码上了色（关键字、字符串用 --hl-*，不同于正文色），只有 span，文字等于原文，只设了颜色（字重、斜体、背景没动）`,
      real.keyword === real.wantKeyword && real.string === real.wantString && real.keyword !== real.fg && real.only && real.text === SAMPLE_JS && real.style && real.nodes > 20, JSON.stringify(real).slice(0, 400));
    const c = await evalStrict(contrastScript);
    const low = c.rows.filter(r => r.ratio < 4.5 || !r.wired);
    check(`${label} ${theme}：${c.rows.length} 种 token（含嵌套组合、不上色的类）的最终颜色都接上了 --hl-*，在代码区底色 rgb(${c.bg}) 上不低于 4.5:1`, low.length === 0, JSON.stringify(low));
    const coloredRows = c.rows.filter(r => r.color !== c.fg);
    const worst = [...coloredRows].sort((a, b) => a.ratio - b.ratio).slice(0, 3);
    console.log(`对比度（${label} ${theme}，底色 rgb(${c.bg})）最低三项：${worst.map(r => `${r.name} ${r.ratio.toFixed(2)}`).join('；')}；正文色 ${c.fg}`);
    // 行对齐：同一份文字，上色的和纯文本的每一行起点的竖直位置、总高度、总宽度都一样；行号列和正文一样高。
    const align = await evalStrict(`(() => { const code = document.querySelector('.code'), text = code.querySelector('.text'), gutter = code.querySelector('.gutter');
      const copy = code.cloneNode(false), g2 = gutter.cloneNode(true), t2 = document.createElement('pre'); t2.className = text.className; t2.textContent = text.textContent; copy.append(g2, t2); code.after(copy);
      const starts = []; const full = text.textContent; for (let i = 0; i < full.length; i++) if (i === 0 || full[i - 1] === '\\n') if (full[i] !== '\\n' && full[i] !== undefined) starts.push(i);
      const locate = (root, offset) => { const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let seen = 0; for (let n = walker.nextNode(); n; n = walker.nextNode()) { if (offset < seen + n.data.length) return [n, offset - seen]; seen += n.data.length; } return null; };
      const top = (root, offset) => { const [n, o] = locate(root, offset), r = document.createRange(); r.setStart(n, o); r.setEnd(n, o + 1); return Math.round(r.getBoundingClientRect().top * 100) / 100 - root.getBoundingClientRect().top; };
      const a = starts.map(i => top(text, i)), b = starts.map(i => top(t2, i));
      const out = { lines: starts.length, same: a.every((v, i) => Math.abs(v - b[i]) < 0.1), heights: [text.getBoundingClientRect().height, t2.getBoundingClientRect().height], widths: [text.getBoundingClientRect().width, t2.getBoundingClientRect().width],
        gutter: [gutter.getBoundingClientRect().height, text.getBoundingClientRect().height], step: Math.max(...a.slice(1).map((v, i) => v - a[i])) - Math.min(...a.slice(1).map((v, i) => v - a[i])) };
      copy.remove(); return out; })()`);
    check(`${label} ${theme}：行对齐：上色前后 ${align.lines} 行的起点位置（误差 0.1 点内）、正文高度不变，宽度差在 0.5 点内，行号列和正文一样高，行高一致`,
      align.lines >= 10 && align.same && align.heights[0] === align.heights[1] && Math.abs(align.widths[0] - align.widths[1]) < 0.5 && align.gutter[0] === align.gutter[1] && align.step < 0.1, JSON.stringify(align));
    // 上色的正文和行号同一个字号（iOS 的文字自动放大对许多 span 起作用时两列会错开；Chrome 不放大，这里确认规则生效、两列一致）。
    const sizes = await evalStrict(`(() => { const f = el => getComputedStyle(el).fontSize, text = document.querySelector('.text'); return { text: f(text), gutter: f(document.querySelector('.gutter')), span: f(text.querySelector('.hljs-keyword')), adjust: ${adjust} }; })()`);
    check(`${label} ${theme}：上色正文、上色的 span 和行号的字号相同，文字自动放大已关`, sizes.text === sizes.gutter && sizes.span === sizes.gutter && sizes.adjust === '100%', JSON.stringify(sizes));
    await shoot(`hl-${shot}-${theme}`);
  }

  // 打开耗时：三种固定样本，每种恰好是上限（HIGHLIGHT_LIMIT）字节。每种开一个新页面，首次是页面里第一次，重复是紧接着再来一次。
  // 计时从调用库开始：高亮、解析成节点、放进页面、强制排版（getBoundingClientRect），和 show() 里的步骤相同。
  const timing = name => `(async () => {
    const enc = new TextEncoder(), LIMIT = ${HIGHLIGHT_LIMIT};
    const fit = (unit, pad = ' ') => { const n = Math.floor(LIMIT / enc.encode(unit).length); let s = unit.repeat(n); s += pad.repeat(LIMIT - enc.encode(s).length); return s; };
    const samples = {
      'JS': [fit('function add(a, b) { const s = "str" + a; // note\\n  return /re+/.test(s) ? b * 2 : \`t\${a}\`; }\\nclass K extends Q { static x = 1; get v() { return this.x ?? null; } }\\n'), 'javascript'],
      'JSON（密集）': [fit('{"id":12345,"name":"abc","tags":["a","b","c"],"ok":true,"n":null,"v":1.5e3},\\n'), 'json'],
      '多字节': [fit('// 你好，世界 😀 这是一段中文注释\\nconst 名字 = "你好世界 🌍"; function 问候(用户) { return \`你好 \${用户}\`; }\\n'), 'javascript'],
    };
    const [text, language] = samples[${JSON.stringify(name)}];
    const { highlight, appendAll } = await import('/view/highlight.mjs');
    const { h } = await import('/view/dom.mjs');
    const body = document.querySelector('.pbody');
    const render = () => { const t0 = performance.now(); const nodes = highlight(text, language), t1 = performance.now();
      const gutter = h('pre', { class: 'gutter', 'aria-hidden': 'true' }, Array.from({ length: text.split('\\n').length }, (_, i) => i + 1).join('\\n'));
      const pre = h('pre', { class: 'text selectable' }); appendAll(pre, nodes); body.replaceChildren(h('div', { class: 'code' }, gutter, pre)); pre.getBoundingClientRect();
      const t2 = performance.now(); return { total: t2 - t0, library: t1 - t0, same: nodes !== null && pre.textContent === text }; };
    const first = render(), again = render();
    return { bytes: enc.encode(text).length, first, again, spans: body.querySelectorAll('span').length };
  })()`;
  // 机器负载高时单次测量会偶发偏高，所以每种样本在新开的页面上各量 RUNS 次「首次」，判断只看中位数；最大值只打印。
  const RUNS = 5, LIMIT_MS = 150;
  const times = {};
  for (const name of ['JS', 'JSON（密集）', '多字节']) {
    times[name] = [];
    for (let i = 0; i < RUNS; i++) {
      await openFile('window', 'light', 'session=A&path=assets/sample.js', 'mac');
      await until(`document.querySelector('.text .hljs-keyword')`, '计时页出现');
      times[name].push(await evalStrict(timing(name)));
    }
    const ts = times[name], totals = ts.map(t => t.first.total), libs = ts.map(t => t.first.library), last = ts[ts.length - 1];
    console.log(`数字（本机无头 Chrome）：${name} ${last.bytes} 字节，${last.spans} 个 span：首次 ${RUNS} 次中位数 ${median(totals).toFixed(0)} 毫秒（最小 ${Math.min(...totals).toFixed(0)}，最大 ${Math.max(...totals).toFixed(0)}），其中调库中位数 ${median(libs).toFixed(0)}；最后一次重复 ${last.again.total.toFixed(0)} 毫秒（其中调库 ${last.again.library.toFixed(0)}）`);
  }
  check('高亮：三种样本都恰好是上限那么多字节，上色后文字等于原文', Object.values(times).every(ts => ts.every(t => t.bytes === HIGHLIGHT_LIMIT && t.first.same && t.again.same)), JSON.stringify(times));
  const firsts = Object.fromEntries(Object.entries(times).map(([k, ts]) => [k, ts.map(t => Math.round(t.first.total))]));
  check(`高亮：三种常见样本（JS、密集 JSON、多字节）${HIGHLIGHT_LIMIT / 1024} KiB 首次打开的中位数（${RUNS} 次）都不超过 ${LIMIT_MS} 毫秒`, Object.values(times).every(ts => median(ts.map(t => t.first.total)) <= LIMIT_MS), JSON.stringify(firsts));
  // 一整行（压成一行的 JSON，恰好 HIGHLIGHT_LIMIT 字节）不上色：显示纯文本，元信息注明「行太长，不高亮」，不再量上色耗时。
  await writeFile(join(fixture, 'assets', 'oneline.json'), '[' + '{"k":"v","n":[1,2,3],"t":true},'.repeat(Math.floor((HIGHLIGHT_LIMIT - 2) / 31)).slice(0, -1).padEnd(HIGHLIGHT_LIMIT - 2, ' ') + ']');
  for (const theme of ['light', 'dark']) {
    await openFile('window', theme, 'session=A&path=assets/oneline.json', 'mac');
    await until(`document.querySelector('.pmeta')?.textContent.includes('不高亮')`, '一整行样本的说明出现');
    const one = await evalStrict(`({ meta: document.querySelector('.pmeta').textContent, spans: document.querySelectorAll('.text span').length, plain: document.querySelector('.text').childNodes.length === 1 && document.querySelector('.text').firstChild.nodeType === 3,
      length: document.querySelector('.text').textContent.length, lines: document.querySelector('.gutter').textContent.split('\\n').length })`);
    check(`高亮 ${theme}：一整行的 ${HIGHLIGHT_LIMIT / 1024} KiB 样本显示纯文本（一个文本节点、没有 span），元信息注明「行太长，不高亮」`,
      one.spans === 0 && one.plain && one.length === HIGHLIGHT_LIMIT && one.lines === 1 && one.meta.endsWith(' · 行太长，不高亮') && !one.meta.includes('没能'), JSON.stringify(one));
  }

  // 真实选区（Mac 侧栏，上色的文件）：真实的 Range 起点和终点落在不同 token、嵌套 span 里、跨行、从行号列拖进来、结尾在下一行行首。
  await openSidebarSample('light');
  await evalStrict(trackRequests);
  const nth = (needle, extra = 0) => SAMPLE_JS.indexOf(needle) + extra;
  const lineOf = offset => 1 + (SAMPLE_JS.slice(0, offset).match(/\n/g) ?? []).length;
  const positionOf = (from, to) => { const last = to > from && SAMPLE_JS[to - 1] === '\n' ? to - 1 : to, a = lineOf(from), b = lineOf(Math.max(from, last)); return a === b ? `assets/sample.js:${a}` : `assets/sample.js:${a}-${b}`; };
  const realSelect = (from, to) => evaluate(`(() => { const el = document.querySelector('.text'), gutter = document.querySelector('.gutter').firstChild;
    const locate = offset => { const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let seen = 0, last = null; for (let n = walker.nextNode(); n; n = walker.nextNode()) { last = n; if (offset < seen + n.data.length) return [n, offset - seen]; seen += n.data.length; } return [last, last.data.length]; };
    const start = ${from} < 0 ? [gutter, 0] : locate(${from}), end = locate(${to}); getSelection().setBaseAndExtent(start[0], start[1], end[0], end[1]);
    return { picked: getSelection().toString().length, crossing: end[0] !== start[0] }; })()`);
  const addFromMenu = async label => {
    const before = (await evalStrict(`window.__rpc.adds.length`));
    await evalStrict(`document.querySelector('.text').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }))`);
    if (!(await evalStrict(`!document.getElementById('menu').hidden`))) return null;
    await evalStrict(`[...document.querySelectorAll('#menu button')].find(x => x.textContent === ${JSON.stringify(label)}).click()`);
    await until(`window.__rpc.adds.length === ${before + 1}`, `${label} 发出`);
    return (await evalStrict(`window.__rpc.adds`)).at(-1);
  };
  const lineStart = SAMPLE_JS.indexOf('class Greeter'), nextLine = SAMPLE_JS.indexOf('\n', lineStart) + 1;
  const scenarios = [
    ['起点在关键字、终点在类名里（不同 token）', lineStart + 2, nth('Greeter', 4)],
    ['落在模板字符串嵌套的 ${} 里面', nth('name.toUpperCase', 2), nth('name.toUpperCase', 9)],
    ['起点在模板字符串文字、终点在嵌套的表达式里', nth('hello', 2), nth('toUpperCase', 4)],
    ['跨行（从方法名到下一个 return）', nth('greet(', 1), nth('return message', 6)],
    ['从行号列拖进来', -3, nth('class Greeter', 5)],
    ['结尾在下一行行首（整行，带换行）', lineStart, nextLine],
  ];
  for (const [what, from, to] of scenarios) {
    const clipped = Math.max(from, 0), content = SAMPLE_JS.slice(clipped, to);
    const info = await realSelect(from, to);
    const mine = await addFromMenu('添加到聊天（内容）');
    await realSelect(from, to);
    const where = await addFromMenu('添加到聊天（位置）');
    check(`上色后的真实选区：${what}：内容和行号都对`, info.picked > 0 && mine?.text === content && mine?.block === true && where?.text === positionOf(clipped, to) && where?.block === false,
      JSON.stringify({ info, mine: mine?.text, where: where?.text, want: [content, positionOf(clipped, to)] }));
  }
  // 原来的纯文本 notes.txt 用例在上面保留（0.5.0 一节），这里再确认：认不出的文件仍是一个文本节点。
  await openFile('window', 'light', 'session=A&path=notes.txt', 'mac');
  check('认不出的文件（notes.txt）仍是 pre 里一个文本节点，没有 span，说明区不加说明', await evalStrict(`(() => { const t = document.querySelector('.text'); return t.childNodes.length === 1 && t.firstChild.nodeType === 3 && !document.querySelector('.pmeta').textContent.includes('高亮'); })()`));

  { // 独立的块：这一节的变量名和前面各节的不冲突
  // ================= Mac 的打开方式（0.7.0，设计第 15.10 节）=================
  // 真实的 CDP 鼠标和键盘事件，不手工派发 dblclick：clickCount 1、2 各一组完整的 pressed / released；键盘只用 Input.dispatchKeyEvent。
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // 无头 Chrome 的页面默认没有焦点，document.hasFocus() 为假
  const rowBy = name => `[...document.querySelectorAll('.row.entry')].find(r => r.querySelector('.name').textContent === ${JSON.stringify(name)})`;
  const cellBy = name => `[...document.querySelectorAll('#grid .cell')].find(c => c.querySelector('.gname').textContent === ${JSON.stringify(name)})`;
  const centerOf = async (expr, part = '') => {
    const at = await evaluate(`(() => { const el = ${expr}; const t = ${part ? `el?.querySelector(${JSON.stringify(part)})` : 'el'}; if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!at) throw new Error(`找不到 ${expr}${part ? ' 的 ' + part : ''}`);
    return at;
  };
  const mousePress = (type, at, extra = {}) => send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  // 一次真实的点击（count 为 1）或双击（count 为 2：clickCount 1、2 各一组完整的 pressed / released）。
  async function realClick(at, count = 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    for (let n = 1; n <= count; n++) { await mousePress('mousePressed', at, { clickCount: n }); await mousePress('mouseReleased', at, { clickCount: n }); }
  }
  const KEY_CODES = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Tab: 9, Escape: 27 }, META = 4, SHIFT = 8;
  // 真实的按键：rawKeyDown 加 keyUp。⌘↑ 带上 Mac 的编辑命令（滚到文档开头）：页面没拦住默认动作时，被聚焦的滚动容器会真的滚到顶。
  async function pressKey(name, modifiers = 0) {
    const base = { key: name, code: name, windowsVirtualKeyCode: KEY_CODES[name], nativeVirtualKeyCode: KEY_CODES[name], modifiers };
    const commands = modifiers === META && name === 'ArrowUp' ? ['scrollToBeginningOfDocument'] : modifiers === META && name === 'ArrowDown' ? ['scrollToEndOfDocument'] : [];
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(commands.length ? { commands } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  const reqCount = (type, path, offset) => evaluate(`window.__rpc.log.filter(m => m.type === ${JSON.stringify(type)} && m.path === ${JSON.stringify(path)}${offset === undefined ? '' : ` && m.offset === ${offset}`}).length`);
  const where = `(() => { const q = s => [...document.querySelectorAll(s)].map(x => x.querySelector('.name, .gname').textContent), pv = document.getElementById('preview'), a = document.activeElement;
    return { sel: q('.row.sel, .cell.sel'), open: q('.row.dir[aria-expanded="true"]'), preview: !pv.classList.contains('off'), active: a?.id || a?.className || a?.tagName || null, menu: !document.getElementById('menu').hidden }; })()`;
  const spotBlank = `(() => { const r = document.querySelector('.section').getBoundingClientRect(); return { x: r.left + 6, y: r.top + r.height / 2 }; })()`; // 目录树顶上根目录名那一行：不在任何条目上
  await frames();

  await open('mac', 'mac', 'light');
  // 单击只选中（文件、文件夹、不能打开的条目）：不打开、不展开。
  for (const name of ['src', 'package.json', 'dangling']) {
    await realClick(await centerOf(rowBy(name), '.name'));
    await frames();
    const w = await evaluate(where);
    check(`Mac 真实单击 ${name}：只选中，不打开、不展开`, JSON.stringify(w.sel) === JSON.stringify([name]) && !w.preview && w.open.length === 0 && await reqCount('read', 'package.json') === 0 && await reqCount('list', 'src') === 0, JSON.stringify(w));
  }
  // 双击文件夹：点在名字上展开恰好一次；点在图标上收起；再点名字又展开。
  await realClick(await centerOf(rowBy('src'), '.name'), 2);
  await until(`${rowBy('src')}?.getAttribute('aria-expanded') === 'true'`, '双击名字展开 src');
  await settled('展开 src');
  check('Mac 真实双击文件夹（点名字）：展开恰好一次，只取了一次目录', await reqCount('list', 'src') === 1 && (await evaluate(where)).open.join() === 'src', JSON.stringify(await evaluate(where)));
  await realClick(await centerOf(rowBy('src'), '.ico'), 2);
  await until(`${rowBy('src')}?.getAttribute('aria-expanded') === 'false'`, '双击图标收起 src');
  check('Mac 真实双击文件夹（点图标）：收起恰好一次，选中的还是它', (await evaluate(where)).open.length === 0 && (await evaluate(where)).sel.join() === 'src');
  // 双击文件：点在名字上打开预览，读一次；返回后选中的仍是它。
  await realClick(await centerOf(rowBy('notes.txt'), '.name'), 2);
  await until(`document.querySelector('.text')`, '双击 notes.txt 出预览');
  await settled('打开 notes.txt');
  check('Mac 真实双击文件（点名字）：侧栏出预览，只读了一次，焦点交给预览面板', await reqCount('read', 'notes.txt', 0) === 1 && (await evaluate(where)).preview && (await evaluate(where)).active === 'preview', JSON.stringify(await evaluate(where)));
  await evaluate(`document.querySelector('.phead button[aria-label="返回"]').click()`);
  await until(`document.getElementById('preview').classList.contains('off')`, '返回目录树');
  check('Mac：返回后 notes.txt 仍是选中的', (await evaluate(where)).sel.join() === 'notes.txt', JSON.stringify(await evaluate(where)));
  // 先单击别的条目，再双击这个（点在图标上）。
  await realClick(await centerOf(rowBy('package.json'), '.name'));
  await realClick(await centerOf(rowBy('LICENSE'), '.ico'), 2);
  await until(`document.querySelector('.text')`, '双击 LICENSE 出预览');
  await settled('打开 LICENSE');
  check('Mac：先单击 package.json 再双击 LICENSE（点图标）：打开的是 LICENSE，只读了一次', await reqCount('read', 'LICENSE', 0) === 1 && await reqCount('read', 'package.json') === 0, JSON.stringify(await evaluate(where)));
  await evaluate(`document.querySelector('.phead button[aria-label="返回"]').click()`);
  await until(`document.getElementById('preview').classList.contains('off')`, '返回目录树');
  // 双击箭头：展开再收起，回到原状；选中不变。
  await realClick(await centerOf(rowBy('package.json'), '.name'));
  await realClick(await centerOf(rowBy('docs'), '.chev'), 1);
  await until(`${rowBy('docs')}?.getAttribute('aria-expanded') === 'true'`, '单击箭头展开 docs');
  check('Mac 真实单击箭头：展开，选中不变', (await evaluate(where)).sel.join() === 'package.json', JSON.stringify(await evaluate(where)));
  await realClick(await centerOf(rowBy('docs'), '.chev'), 2);
  await until(`${rowBy('docs')}?.getAttribute('aria-expanded') === 'true'`, '双击箭头后回到展开');
  await frames();
  check('Mac 真实双击箭头（收起再展开）：每次 click 切一次，dblclick 不再多切；选中不变', (await evaluate(where)).sel.join() === 'package.json' && (await evaluate(where)).open.join() === 'docs', JSON.stringify(await evaluate(where)));
  await realClick(await centerOf(rowBy('docs'), '.chev'), 1);
  await until(`${rowBy('docs')}?.getAttribute('aria-expanded') === 'false'`, '收起 docs');
  // 空白：单击取消选中；菜单开着时双击空白先关菜单，不打开东西。
  await realClick(await evaluate(spotBlank));
  await frames();
  check('Mac 真实单击空白：取消选中', (await evaluate(where)).sel.length === 0, JSON.stringify(await evaluate(where)));
  await realClick(await centerOf(rowBy('LICENSE'), '.name'));
  await openMore('mac');
  check('菜单开着（前提）', (await evaluate(where)).menu);
  const readsBefore = await evaluate(`window.__rpc.log.filter(m => m.type === 'read').length`);
  await realClick(await evaluate(spotBlank), 2);
  await frames();
  const afterBlank = await evaluate(where);
  check('Mac 菜单开着时双击空白：菜单关了，没有打开预览、没有展开，没有读文件', !afterBlank.menu && !afterBlank.preview && afterBlank.open.length === 0 && await evaluate(`window.__rpc.log.filter(m => m.type === 'read').length`) === readsBefore, JSON.stringify(afterBlank));
  // 右键：菜单第一项「打开」，不改选中；关闭后的单击只选中。
  await realClick(await centerOf(rowBy('LICENSE'), '.name'));
  const at = await centerOf(rowBy('notes.txt'), '.name');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'right', buttons: 2, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'right', buttons: 0, clickCount: 1 });
  await until(`!document.getElementById('menu').hidden`, '真实右键弹出行菜单');
  check('Mac 真实右键：第一项「打开」，右键不改选中', await evaluate(`document.querySelector('#menu button').textContent`) === '打开' && (await evaluate(where)).sel.join() === 'LICENSE', JSON.stringify(await evaluate(where)));
  await pressKey('Escape');
  await until(menuClosed, 'Escape 关菜单');
  await realClick(await centerOf(rowBy('package.json'), '.name'));
  await frames();
  check('Mac：右键菜单关闭之后的单击只选中', (await evaluate(where)).sel.join() === 'package.json' && !(await evaluate(where)).preview, JSON.stringify(await evaluate(where)));
  // 拖动结束之后的单击也只选中（真实的按下、移动、抬起；无头 Chrome 不一定真的起拖动，两种结果都不该打开东西）。
  const dragFrom = await centerOf(rowBy('LICENSE'), '.name');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragFrom.x, y: dragFrom.y });
  await mousePress('mousePressed', dragFrom);
  for (const dy of [4, 12, 30]) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragFrom.x, y: dragFrom.y + dy, button: 'left', buttons: 1 });
  await mousePress('mouseReleased', { x: dragFrom.x, y: dragFrom.y + 30 });
  await frames();
  await realClick(await centerOf(rowBy('package.json'), '.name'));
  await frames();
  check('Mac：拖动之后的单击只选中，没有打开东西', (await evaluate(where)).sel.join() === 'package.json' && !(await evaluate(where)).preview, JSON.stringify(await evaluate(where)));

  // ---- 焦点外框：点击不画，键盘操作才画 ----
  await open('mac', 'mac', 'light');
  const ring = `(() => { const t = document.getElementById('tree'), c = getComputedStyle(t), probe = document.createElement('span'); probe.style.color = 'var(--coda-accent, #0a84ff)'; document.body.append(probe); const accent = getComputedStyle(probe).color; probe.remove();
    return { active: document.activeElement === t, visible: t.matches(':focus-visible'), style: c.outlineStyle, width: c.outlineWidth, color: c.outlineColor, accent, offset: c.outlineOffset }; })()`;
  await realClick(await centerOf(rowBy('LICENSE'), '.name'));
  await frames();
  const mouseRing = await evaluate(ring);
  check('焦点外框：单击条目后焦点在目录树，但没有外框', mouseRing.active && !mouseRing.visible && mouseRing.style === 'none', JSON.stringify(mouseRing));
  await shoot('mac-selected-light');
  await pressKey('ArrowDown');
  await frames();
  const keyRing = await evaluate(ring);
  check('焦点外框：键盘操作后出现，1 点细线、内边、强调色', keyRing.visible && keyRing.style === 'solid' && keyRing.width === '1px' && keyRing.color === keyRing.accent && parseFloat(keyRing.offset) < 0, JSON.stringify(keyRing));

  // ---- 纯键盘：聚焦浏览区 → ⌘↓ 打开 → ⌘↑ 返回（中间不点击、不调 .focus()）----
  await open('mac', 'mac', 'light');
  for (let i = 0; i < 8 && (await evaluate(`document.activeElement?.id`)) !== 'tree'; i++) await pressKey('Tab');
  check('Tab 能把焦点送进目录树（不点击、不调 .focus()）', await evaluate(`document.activeElement === document.getElementById('tree')`));
  await pressKey('ArrowUp'); // 没有选中：选最后一个（在滚动容器的最底下，zz-119.txt）
  await frames();
  const bottom = await evaluate(`(() => { const t = document.getElementById('tree'), sel = document.querySelector('.row.sel'), a = t.getBoundingClientRect(), b = sel?.getBoundingClientRect(); return { name: sel?.querySelector('.name').textContent, scrollTop: t.scrollTop, inView: Boolean(b) && b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5 }; })()`);
  check('键盘 ↑（没有选中）：选最后一个条目，滚到视口里', bottom.name === `zz-${String(FILLER - 1).padStart(3, '0')}.txt` && bottom.scrollTop > 0 && bottom.inView, JSON.stringify(bottom));
  await pressKey('ArrowDown', META);
  await until(`document.querySelector('.text')`, '⌘↓ 打开预览');
  await settled('键盘打开');
  const opened = await evaluate(where);
  check('键盘 ⌘↓：打开选中的文件，焦点交给预览面板', opened.preview && opened.active === 'preview' && await reqCount('read', bottom.name, 0) === 1, JSON.stringify(opened));
  await pressKey('ArrowUp', META);
  await until(`document.getElementById('preview').classList.contains('off')`, '⌘↑ 返回');
  await frames();
  const returned = await evaluate(`(() => { const t = document.getElementById('tree'); return { active: document.activeElement === t, sel: document.querySelector('.row.sel')?.querySelector('.name').textContent, scrollTop: t.scrollTop, docScroll: document.scrollingElement.scrollTop }; })()`);
  check('键盘 ⌘↑：返回目录树，焦点回到目录树，选中的仍是那个文件，页面没滚（默认动作被拦）', returned.active && returned.sel === bottom.name && returned.scrollTop === bottom.scrollTop && returned.docScroll === 0, JSON.stringify(returned));
  check('键盘返回之后目录树的 tabIndex 还是 0（没有退出 Tab 顺序）', await evaluate(`document.getElementById('tree').tabIndex === 0`));
  // Tab 离开再 Shift+Tab 能回来。
  await pressKey('Tab');
  const away = await evaluate(`document.activeElement === document.getElementById('tree')`);
  await pressKey('Tab', SHIFT);
  check('返回之后 Tab 离开目录树，Shift+Tab 能回来', !away && await evaluate(`document.activeElement === document.getElementById('tree')`), `离开：${!away}`);

  // ---- 预览里的 ⌘↑：焦点在正文、有选区、菜单开着 ----
  const treeTop = () => evaluate(`document.getElementById('tree').scrollTop`);
  const backed = async () => { await until(`document.getElementById('preview').classList.contains('off')`, '返回目录树'); await frames(); return evaluate(`({ tree: document.activeElement === document.getElementById('tree'), top: document.getElementById('tree').scrollTop })`); };
  const reopen = async () => { await pressKey('ArrowDown', META); await until(`!document.getElementById('preview').classList.contains('off') && document.querySelector('.text')`, '⌘↓ 再打开'); await settled('再打开'); };
  const savedTop = await treeTop();
  await reopen();
  await realClick(await evaluate(`(() => { const r = document.querySelector('.text').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 }; })()`)); // 点正文：焦点进预览面板
  check('点正文：焦点进预览面板（不靠选区；正文 .pbody 可聚焦，关查找条后焦点回它，⌘↑ 照样冒泡到面板）', await evaluate(`document.getElementById('preview').contains(document.activeElement)`));
  await pressKey('ArrowUp', META);
  const a1 = await backed();
  check('预览里 ⌘↑（焦点在正文）：返回，目录树没被滚走', a1.tree && a1.top === savedTop, JSON.stringify(a1));
  await reopen();
  await realClick(await evaluate(`(() => { const r = document.querySelector('.text').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 }; })()`), 3); // 三击选一行
  const picked = await evaluate(`getSelection().toString().length > 0 && document.querySelector('.text').contains(getSelection().anchorNode)`);
  await pressKey('ArrowUp', META);
  const a2 = await backed();
  check('预览里 ⌘↑（pre 里有选区）：返回，目录树没被滚走', picked && a2.tree && a2.top === savedTop, JSON.stringify({ picked, ...a2 }));
  await reopen();
  await openMoreNow('mac');
  check('菜单开着（前提）', (await evaluate(where)).menu);
  await pressKey('ArrowUp', META);
  await frames();
  const a3 = await evaluate(where);
  check('预览里 ⌘↑（菜单开着）：不返回', a3.preview && a3.menu, JSON.stringify(a3));
  await pressKey('Escape');
  await until(menuClosed, 'Escape 关菜单');
  await pressKey('ArrowUp', META);
  await backed();

  // ---- 2 万条的目录里 ↓ 滚进视口 ----
  await open('mac', 'mac', 'light');
  await fetch(`${serverUrl}ctl?action=session:B`); // 会话 B 的根目录是 bulk-project：里面一个 bulk 目录，2 万个文件
  await until(`${rowBy('bulk')} !== undefined`, '会话 B 的根目录');
  await settled('会话 B');
  await realClick(await centerOf(rowBy('bulk'), '.name'), 2);
  await until(`[...document.querySelectorAll('.row .name')].some(x => x.textContent.startsWith('item-'))`, '展开 bulk');
  await settled('展开 bulk');
  for (let i = 0; i < 80; i++) await pressKey('ArrowDown');
  await frames();
  const far = await evaluate(`(() => { const t = document.getElementById('tree'), sel = document.querySelector('.row.sel'), a = t.getBoundingClientRect(), b = sel?.getBoundingClientRect();
    return { name: sel?.querySelector('.name').textContent, scrollTop: t.scrollTop, inView: Boolean(b) && b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5, rows: document.querySelectorAll('.row').length }; })()`);
  check('2 万条的目录里连按 ↓ 80 次：选中行（第 80 个）在视口里，滚动值变大，画出的行数有限', /^item-/.test(far.name ?? '') && far.inView && far.scrollTop > 0 && far.rows < 100, JSON.stringify(far));
  await fetch(`${serverUrl}ctl?action=session:A`); // 切回会话 A：后面的页面都用它

  // ---- 图标视图：末行不满时 ↓ ----
  await open('mac', 'mac', 'light');
  await pickHidden('mac'); // 多一个隐藏项：条目数凑成末行不满
  await switchView('icons');
  await until(`document.querySelectorAll('#grid .cell').length > 0`, '图标视图');
  // 列数：第一行单元格的个数（单元格是 1fr，比量出的 72 点宽，不能拿容器宽除）。
  const cols = await evaluate(`(() => { const cells = [...document.querySelectorAll('#grid .cell')], top = cells[0].getBoundingClientRect().top; return cells.filter(c => Math.abs(c.getBoundingClientRect().top - top) < 1).length; })()`);
  for (let i = 0; i < 8 && (await evaluate(`document.activeElement === ${bodyOf}`)) !== true; i++) await pressKey('Tab');
  check('Tab 能把焦点送进图标视图的滚动容器', await evaluate(`document.activeElement === ${bodyOf}`));
  await pressKey('ArrowUp'); // 没有选中：最后一个
  await frames();
  const gridPos = () => evaluate(`(() => { const b = ${bodyOf}, cells = [...document.querySelectorAll('#grid .cell')], sel = cells.findIndex(c => c.classList.contains('sel')), w = cells[0].getBoundingClientRect(), s = cells[sel]?.getBoundingClientRect(), a = b.getBoundingClientRect();
    return { name: cells[sel]?.querySelector('.gname').textContent, col: s ? cells.filter(c => Math.abs(c.getBoundingClientRect().top - s.top) < 1 && c.getBoundingClientRect().left < s.left - 1).length : null, inView: Boolean(s) && s.top >= a.top - 0.5 && s.bottom <= a.bottom + 0.5 }; })()`);
  const last = await gridPos();
  check('图标视图键盘 ↑（没有选中）：选最后一个，滚进视口；末行不满（前提）', last.inView && last.name !== undefined && last.col < cols - 1, JSON.stringify({ last, cols }));
  // 上一行同一列，再往右走到最右一列，再 ↓：末行没有这一列，落在末行最后一个。
  await pressKey('ArrowUp');
  for (let i = 0; i < cols && (await gridPos()).col < cols - 1; i++) await pressKey('ArrowRight');
  const rightmost = await gridPos();
  await pressKey('ArrowDown');
  await frames();
  const landed = await gridPos();
  check('图标视图 ↓：目标行不满、没有这一列时，选那一行的最后一个', rightmost.col === cols - 1 && rightmost.name !== last.name && landed.name === last.name && landed.inView, JSON.stringify({ last, rightmost, landed, cols }));
  await shoot('mac-grid-selected-light');
  // ---- 图标视图：真实双击（设计第 15.10 节）：进入文件夹、打开文件都恰好一次 ----
  const cellAt = async (name, part) => { // 网格是虚拟化的：先回顶部（src、notes.txt、LICENSE 都在前几行），再把目标滚到中间
    await evaluate(`${bodyOf}.scrollTop = 0`); await frames();
    await evaluate(`(${cellBy(name)})?.scrollIntoView({ block: 'center' })`); await frames(); return centerOf(cellBy(name), part); };
  const gridWhere = () => evaluate(`(() => { const w = ${where}; return { ...w, head: document.querySelector('#grid .gname-head')?.textContent }; })()`);
  const backGrid = async () => { await realClick(await centerOf(`document.querySelector('#grid .ghead button[aria-label="返回"]')`)); await until(`${headName} === 'demo-project'`, '返回上一层'); await settled('返回上一层'); await frames(); };
  const backPreview = async () => { await realClick(await centerOf(`document.querySelector('.phead button[aria-label="返回"]')`)); await until(`document.getElementById('preview').classList.contains('off')`, '预览返回图标视图'); await frames(); };
  for (const part of ['.gname', '.gico']) {
    const listed = await reqCount('list', 'src');
    await realClick(await cellAt('src', part), 2);
    await until(`${headName} === 'src'`, `双击 src（${part}）进入`);
    await settled('进入 src');
    const inSrc = await gridWhere();
    check(`图标视图真实双击文件夹（点 ${part}）：进入 src 恰好一次，选中清空`, await reqCount('list', 'src') === listed + 1 && inSrc.head === 'src' && inSrc.sel.length === 0, JSON.stringify({ listed, inSrc }));
    await backGrid();
    const back = await gridWhere();
    check(`图标视图（点 ${part} 进入后）头部返回：回到上一层，选中的是 src`, back.sel.join() === 'src' && back.head === 'demo-project', JSON.stringify(back));
  }
  for (const [name, part, what] of [['notes.txt', '.gico', '图标'], ['LICENSE', '.gname', '名字']]) {
    if (name === 'notes.txt') { await realClick(await cellAt('package.json', '.gname')); await frames(); }
    const baseNote = await reqCount('read', name, 0), basePkg = await reqCount('read', 'package.json');
    await realClick(await cellAt(name, part), 2);
    await until(`document.querySelector('.text')`, `双击 ${name} 出预览`);
    await settled(`打开 ${name}`);
    const pw = await gridWhere();
    check(`图标视图真实双击文件（${name}，点${what}）：侧栏出预览，只读一次${name === 'notes.txt' ? '，另一个文件没被读' : ''}，焦点交给预览面板`, await reqCount('read', name, 0) === baseNote + 1 && await reqCount('read', 'package.json') === basePkg && pw.preview && pw.active === 'preview', JSON.stringify({ baseNote, basePkg, pw }));
    await backPreview();
    const pb = await gridWhere();
    check(`图标视图（打开 ${name} 后）预览返回：回到图标视图，选中的仍是 ${name}`, pb.sel.join() === name && !pb.preview, JSON.stringify(pb));
  }
  await switchView('list');
  await until(treeShown, '回到列表');

  // ---- 0.7.1：iPhone 在资源页里打开文件（设计第 16 节）----
  const SAFE_BOTTOM = { portrait: 34, landscape: 21 };
  const noOpens = `window.__opens = []; coda.open = target => { __opens.push(target); }`;
  const previewOn = `!document.getElementById('preview').classList.contains('off')`;
  const backEvent = () => evaluate(`postMessage({ harness: 'back' }, '*')`); // 控制页的返回按钮：on('back', { steps: 1 })
  const lastBack = () => evaluate(`JSON.stringify((window.__backs ?? []).at(-1) ?? null)`);
  // 视口里完整可见的第一个条目（滚到深处之后用）。
  const firstVisible = (selector, container) => evaluate(`(() => { const c = ${container}.getBoundingClientRect(); const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(x => { const r = x.getBoundingClientRect(); return r.top >= c.top + 4 && r.bottom <= c.bottom - 4; }); return el?.querySelector('.name, .gname').textContent ?? null; })()`);

  // 竖屏、横屏：打开一个 300 行的文件。预览替代目录树，不调 coda.open，只读一次；顶部工具条、声明的路径、最后一行在安全区之上；返回回到目录树。
  for (const size of ['portrait', 'landscape']) {
    const land = size === 'landscape';
    await open(size, 'ios', 'light');
    await evaluate(noOpens);
    await evaluate(`(${rowBy('notes.txt')}).scrollIntoView({ block: 'center' })`);
    await frames();
    const reads = await reqCount('read', 'notes.txt', 0);
    await realClick(await centerOf(rowBy('notes.txt'), '.name'));
    await until(`${previewOn} && document.querySelector('#preview .text')`, `${size}：预览出现`);
    await settled(`${size}：读 notes.txt`);
    check(`iPhone ${size}：轻点文件在页内切到预览，只读一次，没有调 coda.open，页面还是资源页`, await reqCount('read', 'notes.txt', 0) === reads + 1 && (await evaluate(`__opens.length`)) === 0 && (await evaluate(`location.pathname`)) === '/view/index.html');
    check(`iPhone ${size}：资源页关掉了文字自动放大`, (await evaluate(adjust)) === '100%');
    check(`iPhone ${size}：预览时声明的路径是 ['资源管理器']`, await lastBack() === JSON.stringify(['资源管理器']), await lastBack());
    // 只有一行标题：顶部工具条在预览时只给「返回」（竖屏整条不显示，横屏只显示返回），标题和 ⋯ 在预览头部。
    const top = await evaluate(`(() => { const bar = document.getElementById('bar'), b = bar.getBoundingClientRect(), shown = [...bar.querySelectorAll('button')].filter(x => x.getClientRects().length > 0), head = document.querySelector('#preview .phead'), h = head.getBoundingClientRect();
      const more = head.querySelector('button[aria-label="更多"]'), m = more?.getBoundingClientRect();
      return { barDisplay: getComputedStyle(bar).display, barHeight: b.height, barTitle: bar.querySelector('.bar-title') !== null, shown: shown.map(x => x.getAttribute('aria-label') ?? x.textContent), shownH: shown.map(x => x.getBoundingClientRect().height),
        headTop: h.top, safeTop: parseFloat(getComputedStyle(document.body).paddingTop), name: head.querySelector('.pname').textContent, moreH: m?.height, moreW: m?.width, moreInside: !!m && m.left >= h.left && m.right <= h.right + 0.5 && m.top >= h.top - 0.5 && m.bottom <= h.bottom + 0.5, moreRight: !!m && h.right - m.right < 16,
        meta: document.querySelector('.pmeta').textContent, copyInHead: head.querySelectorAll('button[aria-label="复制路径"]').length, backInHead: head.querySelectorAll('button[aria-label="返回"]').length }; })()`);
    check(`iPhone ${size}：预览时${land ? '顶部只有「返回」一条，没有标题' : '顶部工具条整条不显示，头部贴着顶'}；页面只有预览头部一行标题（${top.name}）`,
      top.name === 'notes.txt' && !top.barTitle && (land ? JSON.stringify(top.shown) === '["返回"]' && top.shownH.every(x => x >= 44) : top.barDisplay === 'none' && top.barHeight === 0 && top.headTop === top.safeTop), JSON.stringify(top));
    check(`iPhone ${size}：预览头部右边有 44 点的 ⋯，完整在头部里；头部没有复制和返回按钮，元信息是 行数 · 大小`, top.moreH >= 44 && top.moreW >= 44 && top.moreInside && top.moreRight && top.copyInHead === 0 && top.backInHead === 0 && top.meta.startsWith(`${LONG_LINES} 行 · `), JSON.stringify(top));
    // ⋯ 菜单：只有刷新和复制路径（相对路径）。
    await openMore('ios');
    const labels = await evaluate(`[...document.querySelectorAll('#menu button')].map(x => x.textContent)`);
    check(`iPhone ${size}：预览时 ⋯ 菜单只有 刷新、查找（显示着文本时）、复制路径（没有显示隐藏文件和「显示」）`, JSON.stringify(labels) === JSON.stringify(['刷新', '查找', '复制路径']), JSON.stringify(labels));
    await evaluate(`window.__rpc.copies.length = 0`);
    await clickItem('复制路径');
    check(`iPhone ${size}：复制路径复制的是相对路径`, JSON.stringify(await evaluate(`window.__rpc.copies`)) === JSON.stringify(['notes.txt']));
    // 最后一行在安全区之上：正文滚到底，最后一行的底边不低于预览底边减去底部安全区。
    const end = await evaluate(`(async () => { const body = document.querySelector('#preview .pbody'); body.scrollTop = body.scrollHeight; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const text = document.querySelector('#preview .text').getBoundingClientRect(), pane = body.getBoundingClientRect(), pad = getComputedStyle(body).paddingBottom;
      return { textBottom: text.bottom, paneBottom: pane.bottom, pad, lines: document.querySelector('#preview .text').textContent.trim().split('\\n').length, previewPad: getComputedStyle(document.getElementById('preview')).paddingBottom }; })()`);
    check(`iPhone ${size}：滚到底，最后一行在底部安全区（${SAFE_BOTTOM[size]} 点）之上；安全区归正文，预览面板不重复留`,
      end.lines === LONG_LINES && end.pad === `${SAFE_BOTTOM[size]}px` && end.previewPad === '0px' && end.textBottom <= end.paneBottom - SAFE_BOTTOM[size] + 0.5, JSON.stringify(end));
    if (land) {
      await realClick(await centerOf(`document.querySelector('#bar .exit')`));
      await until(`!${previewOn}`, '横屏的返回关掉预览');
      check('iPhone 横屏：工具条的「返回」先关预览，没有离开资源页', (await evaluate(`location.pathname`)) === '/view/index.html' && await lastBack() === JSON.stringify([]));
    } else {
      await backEvent();
      await until(`!${previewOn}`, '系统返回关掉预览');
      check('iPhone 竖屏：系统返回关掉预览，声明的路径回到 []，刚看的文件是选中的', await lastBack() === JSON.stringify([]) && await evaluate(`${rowBy('notes.txt')}.classList.contains('sel')`));
    }
  }

  // 回来后目录树原样：会话 B（bulk 目录两万条，分页），列表里展开 bulk、点过「再显示」、滚到深处，打开里面的文件，再返回。
  await fetch(`${serverUrl}ctl?action=session:B`);
  await open('portrait', 'ios', 'light');
  await until(`${rowBy('bulk')} !== undefined`, '会话 B 的根目录');
  await evaluate(noOpens);
  await realClick(await centerOf(rowBy('bulk'), '.name'));
  await until(`[...document.querySelectorAll('.row.entry')].some(r => r.querySelector('.name').textContent.startsWith('item-'))`, '展开 bulk');
  const treeEnd = () => evaluate(`(async () => { const t = document.getElementById('tree'); t.scrollTop = t.scrollHeight; t.dispatchEvent(new Event('scroll')); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return t.scrollHeight; })()`);
  const spacerH = () => evaluate(`parseFloat(document.querySelector('.spacer').style.height)`);
  const h0 = await spacerH();
  await treeEnd();
  await until(`document.querySelector('.row.more') !== null`, '「再显示」出现');
  await realClick(await centerOf(`document.querySelector('.row.more')`));
  await until(`parseFloat(document.querySelector('.spacer').style.height) > ${h0}`, '点「再显示」后的第二页');
  await settled('第二页');
  await evaluate(`(() => { const t = document.getElementById('tree'); t.scrollTop = 3000; t.dispatchEvent(new Event('scroll')); })()`);
  await frames();
  const snapshot = () => evaluate(`(() => { const t = document.getElementById('tree'); return { top: t.scrollTop, spacer: document.querySelector('.spacer').style.height,
    names: [...document.querySelectorAll('.row.entry')].map(r => r.querySelector('.name').textContent).filter((_, i, all) => i === 0 || i === all.length - 1),
    expanded: [...document.querySelectorAll('.row.dir[aria-expanded="true"]')].length }; })()`);
  const listBefore = await snapshot();
  const pick1 = await firstVisible('.row.entry.file', `document.getElementById('tree')`);
  const reads1 = await reqCount('read', `bulk/${pick1}`, 0);
  const tapAt = await centerOf(rowBy(pick1), '.name');
  await realClick(tapAt); await realClick(tapAt); await realClick(tapAt, 2); // 快速两次轻点，再加一次双击的两组事件
  await until(previewOn, '列表：预览出现');
  await settled('列表：读文件');
  check('iPhone：快速两次轻点和一次双击（共四组 click）只打开一次：只读了一次，没有 coda.open', await reqCount('read', `bulk/${pick1}`, 0) === reads1 + 1 && (await evaluate(`__opens.length`)) === 0, `${pick1} ${await reqCount('read', `bulk/${pick1}`, 0)} 次`);
  await backEvent();
  await until(`!${previewOn} && ${treeShown}`, '列表：返回目录树');
  await frames();
  const listAfter = await snapshot();
  check('iPhone 列表：打开子目录里的文件（bulk 已展开、点过「再显示」、滚到 3000 点）再返回：滚动位置、总高度、可见的行、展开状态都和打开前一样',
    listBefore.top >= 2900 && listAfter.top === listBefore.top && listAfter.spacer === listBefore.spacer && JSON.stringify(listAfter.names) === JSON.stringify(listBefore.names) && listAfter.expanded === listBefore.expanded, JSON.stringify({ listBefore, listAfter }));

  // 图标视图：进入 bulk、翻页、滚到深处，打开文件；一次返回关预览，仍在 bulk 里、位置不变；再来一次，两次返回退到根目录。
  await openGrid('portrait', 'ios', 'light');
  await until(`${gridNames}.includes('bulk')`, '图标视图的根目录');
  await evaluate(noOpens);
  await realClick(await centerOf(cellBy('bulk')));
  await until(`${gridNames}.some(n => n.startsWith('item-'))`, '进入 bulk');
  const gridBody = `document.querySelector('#grid .gbody')`;
  const gh0 = await evaluate(`parseFloat(document.querySelector('#grid .gspacer').style.height)`);
  await evaluate(`(async () => { const b = ${gridBody}; b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
  await until(`document.querySelector('#grid .gnote.more') !== null`, '图标视图的「再显示」');
  await realClick(await centerOf(`document.querySelector('#grid .gnote.more')`));
  await until(`parseFloat(document.querySelector('#grid .gspacer').style.height) > ${gh0}`, '图标视图的第二页');
  await settled('图标视图第二页');
  await evaluate(`(() => { const b = ${gridBody}; b.scrollTop = 4000; b.dispatchEvent(new Event('scroll')); })()`);
  await frames();
  const gridSnap = () => evaluate(`(() => ({ top: ${gridBody}.scrollTop, spacer: document.querySelector('#grid .gspacer').style.height, head: document.querySelector('#grid .gname-head')?.textContent,
    first: document.querySelector('#grid .cell')?.textContent, back: JSON.stringify((window.__backs ?? []).at(-1) ?? null) }))()`);
  const gBefore = await gridSnap();
  const pick2 = await firstVisible('#grid .gi', gridBody);
  const gAt = await centerOf(cellBy(pick2));
  const gReads = await reqCount('read', `bulk/${pick2}`, 0);
  await realClick(gAt); await realClick(gAt);
  await until(previewOn, '图标视图：预览出现');
  await settled('图标视图：读文件');
  check('iPhone 图标视图：快速两次轻点只读一次；预览时声明的路径是 [根目录名, 当前目录名]', await reqCount('read', `bulk/${pick2}`, 0) === gReads + 1 && (await lastBack()) === JSON.stringify(['bulk-project', 'bulk']), await lastBack());
  await backEvent();
  await until(`!${previewOn}`, '图标视图：一次返回关预览');
  await frames();
  const gAfter = await gridSnap();
  check('iPhone 图标视图：一次返回只关预览，仍在 bulk 里，滚动位置、总高度、第一个可见单元格不变，路径回到 [根目录名]',
    gBefore.top >= 3900 && gAfter.top === gBefore.top && gAfter.spacer === gBefore.spacer && gAfter.head === 'bulk' && gAfter.first === gBefore.first && gAfter.back === JSON.stringify(['bulk-project']), JSON.stringify({ gBefore, gAfter }));
  await realClick(await centerOf(cellBy(pick2)));
  await until(previewOn, '图标视图：再次打开');
  await backEvent();
  await until(`!${previewOn}`, '图标视图：关预览');
  await backEvent();
  await until(`${gridNames}.includes('bulk')`, '图标视图：两次返回到根目录');
  check('iPhone 图标视图：再开一次文件，两次返回（关预览、退一层）到根目录，路径为空', await lastBack() === JSON.stringify([]));
  await fetch(`${serverUrl}ctl?action=session:A`);

  // 说明区（会话 ZZ 没有可浏览的目录）：顶部工具条的按钮点得到、不在 inert 里。
  await fetch(`${serverUrl}ctl?action=session:ZZ`);
  for (const size of ['portrait', 'landscape']) {
    const land = size === 'landscape';
    await open(size, 'ios', 'light', { ready: '#notice:not(.off) p' });
    const usable = await evaluate(`(() => { const buttons = [...document.querySelectorAll('#bar button')].filter(x => x.getClientRects().length > 0);
      const reach = buttons.map(x => { const r = x.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit?.closest('button') === x && !x.closest('[inert]'); });
      return { names: buttons.map(x => x.getAttribute('aria-label') ?? x.textContent), reach, notice: document.getElementById('notice').textContent, noticeShown: !document.getElementById('notice').classList.contains('off') }; })()`);
    check(`iPhone ${size}：说明区下顶部工具条的按钮都点得到（${land ? '返回、更多' : '更多'}），说明区在显示`, usable.noticeShown && usable.notice !== '' && JSON.stringify(usable.names) === JSON.stringify(land ? ['返回', '更多'] : ['更多']) && usable.reach.every(Boolean), JSON.stringify(usable));
  }
  await fetch(`${serverUrl}ctl?action=session:A`);

  // ---- 截图：Mac 两种外观，有选中行 ----
  for (const theme of ['light', 'dark']) {
    await open('mac', 'mac', theme);
    await realClick(await centerOf(rowBy('docs'), '.name'), 2);
    await until(`${rowBy('docs')}?.getAttribute('aria-expanded') === 'true'`, '展开 docs');
    await until(`${rowBy('README.md')} !== undefined`, 'docs 的子项出现');
    await realClick(await centerOf(rowBy('README.md'), '.name'));
    await frames();
    await shoot(`mac-selected-${theme}`);
    await openGrid('mac', 'mac', theme);
    await realClick(await centerOf(cellBy('docs')));
    await frames();
    await shoot(`mac-grid-selected-${theme}`);
  }

  // ================= 0.7.2：按键的质感（设计第 17 节）=================
  { // 独立的块：变量名和前面各节的不冲突
  const MIN_DIFF = 8; // 按下和平常、悬停、选中的最终颜色，任一通道至少差这么多（0～255）才算分辨得出
  const ICONS_STATE = { v: 1, seq: 1, hidden: false, view: 'icons', sessions: {} };
  const diffOf = (a, b) => Math.max(...[0, 1, 2].map(i => Math.abs(a[i] - b[i])));
  // 截图取像素：只截一个 2×2 的小块，解 PNG（只认 8 位 RGB、RGBA，Chrome 的截图就是这两种）。
  function decodePng(buf) {
    let pos = 8, width = 0, height = 0, depth = 0, kind = 0;
    const idat = [];
    while (pos < buf.length) {
      const length = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + length);
      pos += 12 + length;
      if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; kind = data[9]; }
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
    }
    const bpp = kind === 6 ? 4 : kind === 2 ? 3 : 0;
    if (depth !== 8 || !bpp) throw new Error(`不认识的 PNG：位深 ${depth}，颜色类型 ${kind}`);
    const raw = inflateSync(Buffer.concat(idat)), stride = width * bpp, out = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y > 0 ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0, v = raw[y * (stride + 1) + 1 + x];
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out[y * stride + x] = (v + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c))) & 255;
      }
    }
    return { width, height, at: (x, y) => [out[y * stride + x * bpp], out[y * stride + x * bpp + 1], out[y * stride + x * bpp + 2]] };
  }
  const pixelAt = async at => {
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.floor(at.x), y: Math.floor(at.y), width: 2, height: 2, scale: 1 } });
    return decodePng(Buffer.from(shot.result.data, 'base64')).at(0, 0);
  };
  // 元素上一个没有文字的点：edge 是左边内边距里（行、菜单项），top 是上沿中间（格子、按钮、说明行的字在中间）。
  const spotOf = (expr, mode) => evaluate(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect();
    return { x: ${mode === 'edge' ? 'r.left + 3' : 'r.left + r.width / 2'}, y: ${mode === 'edge' ? 'r.top + r.height / 2' : 'r.top + 1.5'}, w: r.width, h: r.height }; })()`);
  const sizeOf = expr => evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return [r.width, r.height].join('x'); })()`);
  const pressedNow = `document.querySelector('.pressed') !== null`;
  const away = { x: 1, y: 1 };
  const mouseMove = at => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  const touch = (type, at) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchStart' || type === 'touchMove' ? [{ x: at.x, y: at.y, id: 1 }] : [] });
  const shotKeep = async name => shoot(name);
  const numbers = [];
  const closeMenu = () => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

  // ---- 按下的最终颜色：截图取像素，深浅两种外观 ----
  // Mac：平常（鼠标在别处）、悬停、按下（鼠标按着不放）、选中（松开后鼠标移开）。selectable 的目标按下就选中，所以「按下」是选中加一层 hover。
  async function macProbe(label, theme, expr, mode, { selectable = false, press = null } = {}) {
    const at = await spotOf(expr, mode);
    if (!at) throw new Error(`${label}：找不到元素`);
    await mouseMove(away);
    await frames();
    const normal = await pixelAt(at);
    await mouseMove(at);
    await frames();
    const hover = await pixelAt(at);
    const size = await sizeOf(expr);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    await until(pressedNow, `${label}：按下后有 .pressed`);
    const pressed = await pixelAt(at);
    const sizePressed = await sizeOf(expr);
    // 松开：不能打开东西的在别处松开（不触发点击），选中的目标原地松开
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selectable ? at.x : away.x, y: selectable ? at.y : away.y, button: 'left', buttons: 0, clickCount: 1 });
    await until(`!(${pressedNow})`, `${label}：松开后 .pressed 去掉`);
    let selected = null;
    if (selectable) { await mouseMove(away); await frames(); selected = await pixelAt(at); }
    const diffs = { 按下对平常: diffOf(pressed, normal), 按下对悬停: diffOf(pressed, hover), ...(selected ? { 按下对选中: diffOf(pressed, selected), 选中对平常: diffOf(selected, normal) } : {}) };
    numbers.push(`Mac ${theme} ${label}：平常 ${normal} 悬停 ${hover} 按下 ${pressed}${selected ? ` 选中 ${selected}` : ''}；差值 ${JSON.stringify(diffs)}`);
    check(`Mac ${theme} ${label}：按下有 .pressed、尺寸不变，最终底色和平常、悬停${selected ? '、选中' : ''}都差至少 ${MIN_DIFF}`,
      size === sizePressed && Object.entries(diffs).every(([name, d]) => name === '选中对平常' || d >= MIN_DIFF), `${size} → ${sizePressed} ${JSON.stringify(diffs)}`);
  }
  // iPhone：平常、按下（触摸按着不放，按下后 80 毫秒才亮；最后 touchCancel 作废）。没有悬停。
  async function phoneProbe(label, theme, expr, mode) {
    const at = await spotOf(expr, mode);
    if (!at) throw new Error(`${label}：找不到元素`);
    const normal = await pixelAt(at);
    const size = await sizeOf(expr);
    await touch('touchStart', at);
    await until(pressedNow, `${label}：触摸 80 毫秒后有 .pressed`);
    const pressed = await pixelAt(at);
    const sizePressed = await sizeOf(expr);
    await touch('touchCancel', at);
    await until(`!(${pressedNow})`, `${label}：取消后 .pressed 立即去掉`);
    const d = diffOf(pressed, normal);
    numbers.push(`iPhone ${theme} ${label}：平常 ${normal} 按下 ${pressed}；差值 ${d}`);
    check(`iPhone ${theme} ${label}：触摸按下有 .pressed、尺寸不变，最终底色和平常差至少 ${MIN_DIFF}`, size === sizePressed && d >= MIN_DIFF, `${size} → ${sizePressed}，差 ${d}`);
  }
  // 说明区「重试」：让 hello 发不出去（页面一加载就把 coda.postMessage 换成拒绝），并且收不到模块主动推的 session（EventSource 换成空桩），说明区才会停在失败加重试
  const rejectHello = `window.EventSource = class { addEventListener() {} close() {} }; let value; Object.defineProperty(window, 'coda', { configurable: true, get: () => value, set: v => { value = v; v.postMessage = () => Promise.reject(new Error('发不出去（harness）')); } });`;

  // 触摸模拟下浏览器报告 hover: none，悬停的样式不生效：Mac 的检查关掉它，只在触摸的检查里打开。
  const touchMode = on => send('Emulation.setTouchEmulationEnabled', on ? { enabled: true, maxTouchPoints: 1 } : { enabled: false });
  await touchMode(false);
  for (const theme of ['light', 'dark']) {
    // -- Mac 列表：目录行（选中）、展开失败的重试行、菜单项、预览头部的返回
    await open('mac', 'mac', theme);
    await evaluate(`document.getElementById('tree').scrollTop = 0`);
    await macProbe('目录行', theme, rowBy('LICENSE'), 'edge', { selectable: true });
    await realClick(await centerOf(rowBy('locked'), '.chev'));
    await until(`document.querySelector('.row.retry') !== null`, 'locked 读失败，出现重试行');
    await macProbe('说明行（重试）', theme, `document.querySelector('.row.retry')`, 'edge');
    await openMore('mac');
    await macProbe('菜单项', theme, `document.querySelector('#menu button')`, 'edge');
    await closeMenu();
    await realClick(await centerOf(rowBy('LICENSE'), '.name'), 2);
    await until(`document.querySelector('#preview .text')`, '双击 LICENSE 出预览');
    await macProbe('头部按钮（返回）', theme, `document.querySelector('#preview .phead button[aria-label="返回"]')`, 'top');
    // -- Mac 图标视图：格子
    await open('mac', 'mac', theme, { state: ICONS_STATE, ready: '#grid .cell' });
    await macProbe('格子', theme, cellBy('LICENSE'), 'top', { selectable: true });
    // -- Mac 说明区的重试
    await send('Page.enable');
    const hook = (await send('Page.addScriptToEvaluateOnNewDocument', { source: rejectHello })).result.identifier;
    await open('mac', 'mac', theme, { ready: '#notice button' });
    await macProbe('说明区「重试」', theme, `document.querySelector('#notice button')`, 'top');
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hook });

    // -- iPhone
    await touchMode(true);
    await open('portrait', 'ios', theme);
    await phoneProbe('目录行', theme, rowBy('LICENSE'), 'edge');
    await phoneProbe('工具条按钮（⋯）', theme, `document.querySelector('#bar button[aria-label="更多"]')`, 'top');
    await realClick(await centerOf(rowBy('locked'), '.name'));
    await until(`document.querySelector('.row.retry') !== null`, 'iPhone：locked 读失败，出现重试行');
    await phoneProbe('说明行（重试）', theme, `document.querySelector('.row.retry')`, 'edge');
    await openMore('ios');
    await phoneProbe('菜单项', theme, `document.querySelector('#menu button')`, 'edge');
    await closeMenu();
    await realClick(await centerOf(rowBy('LICENSE'), '.name'));
    await until(`${previewOn} && document.querySelector('#preview .text')`, 'iPhone：预览出现');
    await phoneProbe('头部按钮（⋯）', theme, `document.querySelector('#preview .phead button[aria-label="更多"]')`, 'top');
    await open('portrait', 'ios', theme, { state: ICONS_STATE, ready: '#grid .cell' });
    await phoneProbe('格子', theme, cellBy('LICENSE'), 'top');
    const hook2 = (await send('Page.addScriptToEvaluateOnNewDocument', { source: rejectHello })).result.identifier;
    await open('portrait', 'ios', theme, { ready: '#notice button' });
    await phoneProbe('说明区「重试」', theme, `document.querySelector('#notice button')`, 'top');
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hook2 });
    await touchMode(false);
  }
  for (const line of numbers) console.log(`数字（按下底色的最终颜色，截图取像素）：${line}`);

  // ---- Mac 按下的截图（浅、深）：鼠标按着不放 ----
  for (const theme of ['light', 'dark']) {
    await open('mac', 'mac', theme);
    const at = await centerOf(rowBy('package.json'), '.name');
    await mouseMove(at);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    await until(pressedNow, `Mac ${theme}：按下`);
    await shotKeep(`mac-pressed-${theme}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    await until(`!(${pressedNow})`, `Mac ${theme}：松开`);
  }

  // ---- 光标：按钮是箭头 ----
  await open('mac', 'mac', 'light');
  await realClick(await centerOf(rowBy('LICENSE'), '.name'), 2);
  await until(`document.querySelector('#preview .text')`, '光标：预览出现');
  check('Mac：按钮（预览头部、菜单）的光标是箭头，不是手形', await evaluate(`(() => { const b = document.querySelector('#preview .phead button'); return getComputedStyle(b).cursor; })()`) === 'default');

  // ---- 快点和滑动（iPhone，触摸）：逐帧记录 .pressed ----
  // 逐帧记录证明画面上出现过；.pressed 实际挂了多久用 MutationObserver 记加上和去掉的时刻（不靠帧数、帧间隔，机器忙时掉帧不影响）。
  const recorder = `(() => { window.__rec = { frames: [], on: true, spans: [], since: null };
    const watch = () => { const any = document.querySelector('.pressed') !== null, now = performance.now();
      if (any && __rec.since === null) __rec.since = now; else if (!any && __rec.since !== null) { __rec.spans.push(now - __rec.since); __rec.since = null; } };
    new MutationObserver(watch).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true });
    const tick = t => { if (!__rec.on) return; __rec.frames.push({ t, pressed: document.querySelectorAll('.pressed').length, fade: document.querySelectorAll('.fade').length,
      transitions: document.getAnimations().filter(a => a instanceof CSSTransition).length }); requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`;
  const framesAfter = `(() => { __rec.on = false; return __rec.frames; })()`, spansAfter = `__rec.spans`;
  await touchMode(true);
  await open('portrait', 'ios', 'light');
  await evaluateLive(recorder);
  const tapAt = await spotOf(rowBy('docs'), 'edge');
  await touch('touchStart', tapAt);
  await touch('touchEnd', tapAt); // 快点：80 毫秒之前就抬起
  await until(`(() => { const f = __rec.frames, first = f.findIndex(x => x.pressed > 0); return first >= 0 && f.slice(first).some(x => x.pressed === 0) && f.at(-1).fade === 0 && f.at(-1).transitions === 0; })()`, '快点：.pressed 出现又去掉、淡出结束');
  const tapFrames = await evaluateLive(framesAfter);
  const lit = tapFrames.filter(f => f.pressed > 0), spans = await evaluateLive(spansAfter);
  check('iPhone 快点：.pressed 在抬起时补上，实际挂了至少 95 毫秒（MutationObserver 记的时刻），画面上出现过；去掉时有淡出（.fade、CSS transition）',
    spans.length === 1 && spans[0] >= 95 && lit.length >= 1 && tapFrames.some(f => f.fade > 0) && tapFrames.some(f => f.transitions > 0),
    JSON.stringify({ litFrames: lit.length, spans, fade: tapFrames.some(f => f.fade > 0), transitions: tapFrames.some(f => f.transitions > 0) }));
  await evaluateLive(recorder);
  const swipeAt = await spotOf(rowBy('LICENSE'), 'edge');
  await touch('touchStart', swipeAt);
  await touch('touchMove', { x: swipeAt.x, y: swipeAt.y + 40 }); // 按下后立刻滑动：80 毫秒之前
  await until(`__rec.frames.length >= 14`, '滑动：记录了足够多的帧');
  await touch('touchEnd', { x: swipeAt.x, y: swipeAt.y + 40 });
  const swipeFrames = await evaluateLive(framesAfter);
  check('iPhone 滑动：按下后立刻移动，.pressed 一帧都不出现', swipeFrames.length >= 14 && swipeFrames.every(f => f.pressed === 0), JSON.stringify(swipeFrames.filter(f => f.pressed > 0).length));
  await evaluateLive(recorder);
  const holdAt = await spotOf(rowBy('LICENSE'), 'edge');
  await touch('touchStart', holdAt);
  await until(pressedNow, '按住 80 毫秒后亮');
  await touch('touchMove', { x: holdAt.x, y: holdAt.y + 40 }); // 亮起之后才移动：作废，立即去掉、不淡出
  await until(`!(${pressedNow})`, '亮起后移动：立即去掉');
  await touch('touchEnd', { x: holdAt.x, y: holdAt.y + 40 });
  const cancelFrames = await evaluateLive(framesAfter);
  check('iPhone 亮起后移动（作废）：立即去掉，没有淡出', cancelFrames.every(f => f.fade === 0 && f.transitions === 0), JSON.stringify(cancelFrames.filter(f => f.fade > 0 || f.transitions > 0).length));
  await touchMode(false);

  // ---- Mac：按下的那一刻条目已经选中（松开之前）；真实双击打开恰好一次，期间行节点身份不变 ----
  await open('mac', 'mac', 'light');
  const pressAt = await centerOf(rowBy('notes.txt'), '.name');
  await mouseMove(pressAt);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pressAt.x, y: pressAt.y, button: 'left', buttons: 1, clickCount: 1 });
  check('Mac 按下的那一刻（松开之前）条目已经选中', await evaluate(`document.querySelector('.row.sel .name')?.textContent === 'notes.txt'`));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pressAt.x, y: pressAt.y, button: 'left', buttons: 0, clickCount: 1 });
  await evaluate(`(() => { const row = ${rowBy('LICENSE')}; row.__mark = 'same'; window.__dbl = 0; window.__dblMark = null; document.getElementById('tree').addEventListener('dblclick', event => { window.__dbl++; window.__dblMark = event.target.closest('.row')?.__mark ?? null; }); })()`);
  const readsBefore = await reqCount('read', 'LICENSE', 0);
  const dblAt = await centerOf(rowBy('LICENSE'), '.name');
  await mouseMove(dblAt);
  await mousePress('mousePressed', dblAt, { clickCount: 1 });
  const identityAfterDown = await evaluate(`${rowBy('LICENSE')}.__mark === 'same' && ${rowBy('LICENSE')}.classList.contains('sel')`);
  await mousePress('mouseReleased', dblAt, { clickCount: 1 });
  await mousePress('mousePressed', dblAt, { clickCount: 2 });
  await mousePress('mouseReleased', dblAt, { clickCount: 2 });
  await until(`document.querySelector('#preview .text')`, '真实双击出预览');
  await settled('真实双击读文件');
  check('Mac 真实双击：按下时就选中、节点身份不变（dblclick 派发时目标还是那个节点），dblclick 一次，只读了一次，预览打开',
    identityAfterDown && await evaluate(`window.__dbl`) === 1 && await evaluate(`window.__dblMark`) === 'same' && await reqCount('read', 'LICENSE', 0) === readsBefore + 1, JSON.stringify({ identityAfterDown, dbl: await evaluate(`window.__dbl`), mark: await evaluate(`window.__dblMark`) }));

  // ---- Mac 在滚动条上按下不取消选中（真实 CDP 鼠标）----
  await open('mac', 'mac', 'light');
  await realClick(await centerOf(rowBy('notes.txt'), '.name'));
  const bar = await evaluate(`(() => { const t = document.getElementById('tree'), r = t.getBoundingClientRect(); return { width: t.offsetWidth - t.clientWidth, right: r.right, y: r.top + r.height / 2 }; })()`);
  if (bar.width > 0) {
    const spot = { x: bar.right - bar.width / 2, y: bar.y };
    await mousePress('mousePressed', spot);
    await mousePress('mouseReleased', spot);
    await frames();
    check('Mac 真实鼠标按在 #tree 的竖向滚动条上：选中不变（不当作点空白）', await evaluate(`document.querySelector('.row.sel .name')?.textContent`) === 'notes.txt', JSON.stringify(bar));
  } else console.log('跳过：无头 Chrome 的滚动条是叠加式（宽度 0），点不到滚动条，滚动条上按下的检查只有单元测试');

  // ---- 菜单：阴影（两种外观）、iPhone 出现动画 ----
  for (const theme of ['light', 'dark']) {
    await open('portrait', 'ios', theme);
    await frames();
    // 同一次页面求值里同步点并取动画：分两次求值时，机器忙、CDP 排队超过 150 毫秒动画就播完消失了
    const anim = await evaluateLive(`(() => { document.querySelector('[aria-label="更多"]').click(); return document.getAnimations().filter(a => a.effect.target?.id === 'menu').map(a => ({ duration: a.effect.getTiming().duration, opacity: a.effect.getKeyframes().map(k => k.opacity), transform: a.effect.getKeyframes().map(k => k.transform), origin: getComputedStyle(a.effect.target).transformOrigin })); })()`);
    await until(`document.getAnimations().length === 0`, `iPhone ${theme}：菜单动画播完`);
    const final = await evaluate(`(() => { const m = document.getElementById('menu'), cs = getComputedStyle(m); return { opacity: cs.opacity, transform: cs.transform, shadow: cs.boxShadow }; })()`);
    check(`iPhone ${theme}：菜单出现有动画（约 150 毫秒，透明度 0→1、缩放 0.96→1），终态不透明、无缩放`,
      anim.length === 1 && anim[0].duration === 150 && anim[0].opacity.join() === '0,1' && anim[0].transform.join() === 'scale(0.96),scale(1)' && final.opacity === '1' && (final.transform === 'none' || final.transform === 'matrix(1, 0, 0, 1, 0, 0)'), JSON.stringify({ anim, final }));
    const menuBox = await evaluate(`(() => { const r = document.getElementById('menu').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom, left: r.left }; })()`);
    const near = await pixelAt({ x: menuBox.x, y: menuBox.y + 6 }), farther = await pixelAt({ x: menuBox.x, y: Math.min(780, menuBox.y + 120) });
    check(`iPhone ${theme}：菜单有阴影（computed 不是 none），菜单下沿外 6 点比远处的底色深至少 3`, final.shadow !== 'none' && farther[0] - near[0] >= 3, JSON.stringify({ shadow: final.shadow, near, farther }));
    numbers.push(`iPhone ${theme} 菜单阴影：${final.shadow}；下沿外 ${near} 远处 ${farther}`);
    await shotKeep(`ios-menu-${theme}`);
    await closeMenu();
    await open('mac', 'mac', theme);
    await openMore('mac');
    check(`Mac ${theme}：菜单有阴影，没有出现动画（立刻出现）`, await evaluate(`getComputedStyle(document.getElementById('menu')).boxShadow !== 'none' && document.getAnimations().length === 0`));
    await shotKeep(`mac-menu-${theme}`);
    await closeMenu();
  }
  const shadows = [];
  for (const theme of ['light', 'dark']) { await open('mac', 'mac', theme); await openMore('mac'); shadows.push(await evaluate(`getComputedStyle(document.getElementById('menu')).boxShadow`)); await closeMenu(); }
  const alpha = text => Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(text)?.[1] ?? 1);
  check('菜单阴影深色比浅色重（第一层的透明度更大）', alpha(shadows[1]) > alpha(shadows[0]), JSON.stringify(shadows));

  // ---- iPhone 层级过渡：打开和返回的中途（动画停在固定进度，不靠猜时长）----
  const holdAnims = fraction => evaluateLive(`(() => { window.__animate ??= Element.prototype.animate; window.__hold = ${fraction};
    Element.prototype.animate = function (...args) { const anim = window.__animate.apply(this, args); if (window.__hold !== null) { anim.pause(); anim.currentTime = anim.effect.getTiming().duration * window.__hold; } return anim; }; })()`);
  const release = () => evaluateLive(`(() => { window.__hold = null; document.getAnimations().forEach(a => a.finish()); return true; })()`);
  const probePanes = `(() => { const q = id => document.getElementById(id), cls = id => [...q(id).classList].join(' ');
    const off = id => q(id).classList.contains('off'), r = id => q(id).getBoundingClientRect();
    return { tree: { off: off('browse'), inert: q('browse').inert, cls: cls('browse'), left: r('browse').left, filter: getComputedStyle(q('browse')).filter, bg: getComputedStyle(q('browse')).backgroundColor, rows: q('tree').querySelectorAll('.row').length }, // 浅层是 #browse（第 18.3 节两级层），树是它里面的面板
      preview: { off: off('preview'), inert: q('preview').inert, cls: cls('preview'), left: r('preview').left, width: r('preview').width, z: Number(getComputedStyle(q('preview')).zIndex) || 0, treeZ: Number(getComputedStyle(q('browse')).zIndex) || 0, bg: getComputedStyle(q('preview')).backgroundColor, text: q('preview').querySelector('.text')?.textContent.length ?? 0, name: q('preview').querySelector('.pname')?.textContent ?? null },
      anims: document.getAnimations().length }; })()`;
  // 滑动期间整页不响应点按：真实触摸点这几个位置，什么都不触发（不发请求、不换预览、不选中、没有 .pressed、没开菜单）。
  const swipeSnap = `({ log: window.__rpc.log.length, name: document.querySelector('#preview .pname')?.textContent ?? null, sel: document.querySelectorAll('.row.sel').length, menu: !document.getElementById('menu').hidden, moving: document.documentElement.classList.contains('moving') })`;
  async function tapsIgnored(label, points) {
    await untilLive(`!(${pressedNow})`, `${label}：打开那一下轻点的按下反馈已经结束（它不算点按期间的）`);
    const before = await evaluateLive(swipeSnap);
    await evaluateLive(recorder);
    for (const at of points) { await touch('touchStart', at); await touch('touchEnd', at); }
    await untilLive(`__rec.frames.length >= 14`, `${label}：记录了足够多的帧`);
    await evaluateLive(framesAfter);
    const after = await evaluateLive(swipeSnap), spans = await evaluateLive(spansAfter), pressedNowLive = await evaluateLive(pressedNow);
    check(`${label}：滑动期间（html.moving）整页不响应点按——不发请求、不换预览、不选中、没有 .pressed、没开菜单`,
      before.moving && after.moving && after.log === before.log && after.name === before.name && after.sel === before.sel && !after.menu && spans.length === 0 && !pressedNowLive, JSON.stringify({ before, after, spans }));
  }
  const opaque = bg => /^rgb\(/.test(bg); // rgb(...) 不带透明度，rgba(0, 0, 0, 0) 才是透明
  await open('portrait', 'ios', 'light');
  await evaluate(noOpens);
  await holdAnims(0.3);
  const openAt = await spotOf(rowBy('notes.txt'), 'edge');
  await touch('touchStart', openAt);
  await touch('touchEnd', openAt);
  await untilLive(`document.getElementById('preview').querySelector('.pname')?.textContent === 'notes.txt'`, '打开文件：预览头部出现');
  let mid = await evaluateLive(probePanes);
  const yMid = 400;
  check('iPhone 打开的中途：两层都在、都不透底（背景不透明）、浅层向左移并变暗、深层（预览）从右边滑入盖在上面，旧页内容还在',
    !mid.tree.off && !mid.preview.off && opaque(mid.tree.bg) && opaque(mid.preview.bg) && mid.tree.left < 0 && mid.tree.filter !== 'none' && mid.preview.left > 0 && mid.preview.left < mid.preview.width && mid.tree.rows > 0 && /layer/.test(mid.tree.cls) && /layer/.test(mid.preview.cls), JSON.stringify(mid));
  await tapsIgnored('iPhone 打开的中途', [{ x: mid.preview.left + 12, y: yMid }, ...(mid.preview.left > 24 ? [{ x: mid.preview.left - 12, y: yMid }] : [])]);
  check('iPhone 打开的中途：离开的目录树 inert 且 .leaving', mid.tree.inert && /leaving/.test(mid.tree.cls), JSON.stringify({ tree: mid.tree.inert }));
  await shotKeep('ios-open-mid');
  await release();
  await until(`document.getElementById('browse').classList.contains('off')`, '打开：过渡结束（finish 事件是异步的，等页面处理完它）');
  let done = await evaluate(probePanes);
  const moreAt = await spotOf(`document.querySelector('#preview .phead button[aria-label="更多"]')`, 'top');
  await touch('touchStart', moreAt);
  await touch('touchEnd', moreAt);
  await until(`!document.getElementById('menu').hidden`, '打开结束后：目标页（预览）能点：头部 ⋯ 打开菜单');
  check('iPhone 打开结束后（html.moving 已去掉）：目标页能点，同一位置的点按生效', await evaluate(`!document.documentElement.classList.contains('moving')`));
  await closeMenu();
  check('iPhone 打开结束后：只有预览一层可见，目录树 .off 且 inert，没有 layer、leaving 残留，没有动画', done.tree.off && done.tree.inert && !done.preview.off && !done.preview.inert && !/layer|leaving/.test(done.tree.cls + done.preview.cls) && done.anims === 0, JSON.stringify(done));
  await evaluateLive(`window.__hold = 0.3`);
  await backEvent();
  await untilLive(`document.getAnimations().length > 0`, '返回：过渡开始');
  mid = await evaluateLive(probePanes);
  await tapsIgnored('iPhone 返回的中途', [{ x: mid.preview.left + 12, y: yMid }, ...(mid.preview.left > 24 ? [{ x: mid.preview.left - 12, y: yMid }] : [])]);
  check('iPhone 返回的中途：预览在上面（层叠更高、背景不透明、盖住重叠的部分）、内容还在不是空白，预览 inert 且 .leaving',
    !mid.tree.off && !mid.preview.off && opaque(mid.tree.bg) && opaque(mid.preview.bg) && mid.preview.z > mid.preview.treeZ && mid.preview.left < mid.preview.width && mid.preview.text > 0 && mid.preview.name === 'notes.txt' && mid.tree.rows > 0
    && mid.preview.inert && /leaving/.test(mid.preview.cls), JSON.stringify({ mid }));
  await shotKeep('ios-back-mid');
  await release();
  await until(`document.getElementById('preview').classList.contains('off')`, '返回：过渡结束（finish 事件是异步的，等页面处理完它）');
  done = await evaluate(probePanes);
  check('iPhone 返回结束后：只有目录树可见，预览 .off 且 inert、内容在退场结束时释放，没有 layer、leaving 残留', !done.tree.off && !done.tree.inert && done.preview.off && done.preview.inert && done.preview.text === 0 && !/layer|leaving/.test(done.tree.cls + done.preview.cls) && done.anims === 0, JSON.stringify(done));
  await evaluateLive(`window.__hold = null`);
  const rowAt = await spotOf(rowBy('notes.txt'), 'edge');
  await touch('touchStart', rowAt);
  await touch('touchEnd', rowAt);
  await until(previewOn, '返回结束后：目录树能点：轻点条目打开预览');
  check('iPhone 返回结束后（html.moving 已去掉）：目录树能点，同一位置的点按生效', true);
  await backEvent();
  await until(`document.getElementById('preview').classList.contains('off')`, '返回结束后：再返回');

  // ---- 减弱动态效果：没有动画和过渡，按下反馈照常；动画进行中改设置：结束到终点 ----
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await open('portrait', 'ios', 'light');
  await evaluate(noOpens);
  await evaluateLive(`(() => { window.__calls = 0; const orig = Element.prototype.animate; Element.prototype.animate = function (...a) { window.__calls++; return orig.apply(this, a); }; })()`);
  await evaluateLive(`document.querySelector('[aria-label="更多"]').click()`);
  check('减弱动态效果：iPhone 菜单出现没有动画', await evaluateLive(`__calls === 0 && document.getAnimations().length === 0 && !document.getElementById('menu').hidden`));
  await closeMenu();
  await realClick(await centerOf(rowBy('notes.txt'), '.name'));
  await until(`document.getElementById('preview').querySelector('.text')`, '减弱：预览出现');
  let reduced = await evaluateLive(probePanes);
  check('减弱动态效果：打开文件没有过渡，面板直接切换', await evaluateLive(`__calls === 0`) && reduced.anims === 0 && reduced.tree.off && !reduced.preview.off && !/layer/.test(reduced.preview.cls));
  await backEvent();
  await until(`document.getElementById('preview').classList.contains('off')`, '减弱：返回');
  reduced = await evaluateLive(probePanes);
  check('减弱动态效果：返回没有过渡，预览立即释放', await evaluateLive(`__calls === 0`) && reduced.anims === 0 && !reduced.tree.off && reduced.preview.text === 0);
  const pressSpot = await spotOf(rowBy('LICENSE'), 'edge');
  await touch('touchStart', pressSpot);
  await until(pressedNow, '减弱：按下反馈照常');
  const fadeOnCancel = await evaluateLive(`document.querySelector('.pressed') !== null`);
  await touch('touchEnd', pressSpot);
  await until(`!(${pressedNow})`, '减弱：抬起');
  check('减弱动态效果：按下反馈仍在，抬起后没有淡出', fadeOnCancel && await evaluate(`document.querySelectorAll('.fade').length === 0 && document.getAnimations().length === 0`));
  // 设置中途改变：先在正常设置下让过渡停在中途，再切到减弱
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await open('portrait', 'ios', 'light');
  await evaluate(noOpens);
  await holdAnims(0.3);
  await realClick(await centerOf(rowBy('notes.txt'), '.name'));
  await untilLive(`document.getAnimations().length > 0`, '设置中途改变：过渡进行中');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await untilLive(`document.getAnimations().length === 0`, '设置改成减弱：动画结束到终点');
  done = await evaluateLive(probePanes);
  check('减弱动态效果在动画进行中打开：正在播的动画结束到终点，只剩预览一层', done.tree.off && !done.preview.off && !/layer|leaving/.test(done.tree.cls + done.preview.cls), JSON.stringify(done));
  await send('Emulation.setEmulatedMedia', { features: [] });
  await evaluateLive(`window.__hold = null`);
  }
  }

  { // ================= 文件名搜索（0.8.0，设计第 18.3、18.8 节）：真实 Chrome 里的搜索框、结果、清空后的浏览状态，两端、深浅色 =================
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const q = `document.getElementById('q')`;
  const centerAt = expr => evaluate(`(() => { const el = ${expr}; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async at => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const cdpKey = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const rowOf = name => `[...document.querySelectorAll('#tree .row.entry')].find(r => r.querySelector('.name').textContent === ${JSON.stringify(name)})`;
  const browseState = `({ top: document.getElementById('tree').scrollTop, open: [...document.querySelectorAll('#tree .row.dir[aria-expanded="true"] .name')].map(x => x.textContent).join('|'), sel: [...document.querySelectorAll('#tree .row.sel .name')].map(x => x.textContent).join('|') })`;
  const hitPaths = `[...document.querySelectorAll('#search .row.entry')].map(r => r.dataset.path)`;
  const statusText = `document.querySelector('#search .sstatus-text').textContent`;
  // 输入搜索词，等到对应这个词的结果画出来：等「状态行不是正在搜索」且第一条结果的路径含 first（词不同，结果的路径也不同，所以不会被上一轮的结果骗过去）。
  async function typeQuery(text, first) {
    await evaluate(`${q}.focus(); ${q}.select()`);
    await send('Input.insertText', { text });
    await until(`document.getElementById('search') && !document.getElementById('search').classList.contains('off') && ${statusText} !== '正在搜索…' && ${hitPaths}.some(p => p.includes(${JSON.stringify(first)}))`, `搜「${text}」的结果画出来`);
  }

  for (const [size, platform] of [['mac', 'mac'], ['portrait', 'ios']]) {
    const side = platform === 'mac' ? 'Mac' : 'iPhone';
    await open(size, platform, 'light');
    // 搜索之前的浏览状态：展开 src、选中 package.json、滚到 40。
    await evaluate(`window.__open(${rowOf('src')})`);
    await until(`${rowOf('app.js')} !== undefined`, 'src 展开');
    if (platform === 'mac') { await click(await centerAt(rowOf('package.json'))); await until(`document.querySelector('#tree .row.sel .name')?.textContent === 'package.json'`, '选中 package.json'); }
    await evaluate(`(() => { const t = document.getElementById('tree'); t.scrollTop = 40; t.dispatchEvent(new Event('scroll')); })()`);
    await frames();
    const before = await evaluate(browseState);
    const barTop = await evaluate(`document.getElementById('searchbar').getBoundingClientRect().top`);

    if (platform === 'mac') {
      await evaluate(`document.activeElement.blur()`);
      await cdpKey('f', 'KeyF', 70, 4); // ⌘F
      await until(`document.activeElement === ${q}`, `${side}：⌘F 聚焦搜索框`);
      check(`搜索 ${side}：⌘F 聚焦搜索框并选中里面的字，浏览区不跟着滚`, await evaluate(`document.activeElement === ${q}`));
    }
    await typeQuery('app', 'app.');
    const results = await evaluate(`({ paths: ${hitPaths}, status: ${statusText}, bold: [...document.querySelectorAll('#search .row.entry .name b')].map(b => b.textContent), places: [...document.querySelectorAll('#search .row.entry')].map(r => (r.querySelector('${platform === 'mac' ? '.meta' : '.sub'}')?.textContent ?? '')) })`);
    check(`搜索 ${side}：结果有 src/app.js 和 assets/app.ts，匹配的部分加粗，每行带所在目录，状态行「共 N 个」`,
      results.paths.includes('src/app.js') && results.paths.includes('assets/app.ts') && results.bold.length === results.paths.length && results.bold.every(b => b.toLowerCase() === 'app') && results.places.includes('src') && /^共 \d+ 个( · \d+ 项读不到)?$/.test(results.status), JSON.stringify(results)); // 夹具里有一个读不到的目录（locked），所以状态行会带「1 项读不到」
    // 搜索框和状态行不随结果滚动
    const fixed = await evaluate(`(() => { const list = document.querySelector('#search .shits'), bar = document.getElementById('searchbar'), st = document.querySelector('#search .sstatus'), a = bar.getBoundingClientRect().top, b = st.getBoundingClientRect().top;
      list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll')); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r({ bar: bar.getBoundingClientRect().top === a, status: st.getBoundingClientRect().top === b })))); })()`);
    check(`搜索 ${side}：搜索框和状态行不随结果滚动`, fixed.bar && fixed.status, JSON.stringify(fixed));
    const sizes = await evaluate(`({ input: parseFloat(getComputedStyle(${q}).fontSize), body: parseFloat(getComputedStyle(document.documentElement).fontSize) })`);
    check(platform === 'ios' ? `搜索 ${side}：搜索框字号不小于 16 点（iPhone 聚焦时页面不放大）` : `搜索 ${side}：搜索框字号等于正文字号（跟 --coda-font-size）`, platform === 'ios' ? sizes.input >= 16 : sizes.input === sizes.body, JSON.stringify(sizes));
    check(`搜索 ${side}：搜索框在顶上、面板在它下面占满剩余高度`, await evaluate(`(() => { const bar = document.getElementById('searchbar').getBoundingClientRect(), pane = document.getElementById('search').getBoundingClientRect(), stage = document.getElementById('stage').getBoundingClientRect();
      return Math.abs(bar.top - stage.top) < 1 && Math.abs(pane.top - bar.bottom) < 1 && Math.abs(pane.bottom - stage.bottom) < 1; })()`));
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') { await send('Emulation.setEmulatedMedia', { features: [] }); await evaluate(`window.postMessage({ harness: 'theme', kind: 'dark' }, '*')`); await frames(); }
      // 聚焦和不聚焦各一张；聚焦前后搜索框和下面面板的位置不变（边框是平时就留着的 1 点透明边，不跳动）
      const layout = `(() => { const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return [b.top, b.left, b.width, b.height].join(','); }; return [r('searchbar'), r('search')].join('|'); })()`;
      const pill = await evaluate(`(() => { const f = document.querySelector('.sfield'), c = getComputedStyle(f), h = f.getBoundingClientRect().height, probe = document.createElement('span'); probe.style.color = 'var(--coda-tertiary)'; document.body.append(probe);
        const tertiary = getComputedStyle(probe).color; probe.remove(); return { radius: parseFloat(c.borderTopLeftRadius), height: h, placeholder: getComputedStyle(${q}, '::placeholder').color, tertiary, icon: getComputedStyle(document.querySelector('.sico')).color, clear: getComputedStyle(document.querySelector('.sclear')).color, border: c.borderTopColor, width: c.borderTopWidth }; })()`);
      await evaluate(`${q}.blur()`);
      await frames();
      await shoot(`search-${platform}-${theme}-idle`);
      const idle = await evaluate(layout), idleBorder = await evaluate(`getComputedStyle(document.querySelector('.sfield')).borderTopColor`), idleBg = await evaluate(`getComputedStyle(document.querySelector('.sfield')).backgroundColor`);
      await evaluate(`${q}.focus()`);
      await frames();
      const focused = await evaluate(layout), focusBorder = await evaluate(`getComputedStyle(document.querySelector('.sfield')).borderTopColor`), focusBg = await evaluate(`getComputedStyle(document.querySelector('.sfield')).backgroundColor`), glow = await evaluate(`getComputedStyle(document.querySelector('.sfield')).boxShadow`);
      await shoot(`search-${platform}-${theme}-focus`);
      check(`搜索 ${side} ${theme}：搜索框是胶囊形（border-radius ${pill.radius} 不小于高度 ${pill.height} 的一半），平时有 1 点边框（透明）`, pill.radius >= pill.height / 2 && pill.width === '1px', JSON.stringify(pill));
      check(`搜索 ${side} ${theme}：placeholder、放大镜和清除按钮的颜色等于三级文字色 ${pill.tertiary}`, pill.placeholder === pill.tertiary && pill.icon === pill.tertiary && pill.clear === pill.tertiary, JSON.stringify(pill));
      check(`搜索 ${side} ${theme}：聚焦前后搜索框和下面面板的位置、尺寸不变（不跳动）；聚焦时底色、边框色变了，有光晕，没有 outline`, idle === focused && idleBorder !== focusBorder && idleBg !== focusBg && glow !== 'none',
        JSON.stringify({ idle, focused, idleBorder, focusBorder, idleBg, focusBg, glow }));
    }
    await evaluate(`window.postMessage({ harness: 'theme', kind: 'light' }, '*')`);
    // 清空：回到搜索之前的样子（展开、滚动、选中都一样）
    await evaluate(`(() => { ${q}.focus(); return true; })()`);
    if (platform === 'mac') { await cdpKey('Escape', 'Escape', 27); }
    else await click(await centerAt(`document.querySelector('.sclear')`));
    await until(`document.getElementById('search').classList.contains('off') && ${q}.value === ''`, `${side}：清空后回到目录树`);
    await frames();
    const after = await evaluate(browseState);
    check(`搜索 ${side}：清空后目录树的 scrollTop、展开、选中都和搜索之前一样`, after.top === before.top && after.open === before.open && after.sel === before.sel, JSON.stringify({ before, after }));
    check(`搜索 ${side}：搜索框的位置不因搜索而变`, (await evaluate(`document.getElementById('searchbar').getBoundingClientRect().top`)) === barTop);
  }

  // 2 万条的 bulk 目录加几层子目录：搜一个名字，等对应轮次的结果画出来
  await mkdir(join(bulkRoot, 'small', 'deeper', 'deepest'), { recursive: true });
  await writeFile(join(bulkRoot, 'small', 'deeper', 'deepest', 'needle-final.txt'), 'x');
  await fetch(`${serverUrl}ctl?action=session:B`);
  await open('mac', 'mac', 'light', { ready: '.row.entry' });
  await until(`document.querySelector('#tree .section')?.textContent === 'bulk-project'`, '会话 B 的根目录');
  const started = Date.now();
  await typeQuery('item-19999', 'item-19999');
  const elapsed = Date.now() - started;
  check(`搜索 bulk（${BULK} 条的目录）：搜 item-19999，结果就一条 bulk/item-19999.txt，状态行「共 1 个」`, await evaluate(`JSON.stringify(${hitPaths}) === '["bulk/item-19999.txt"]' && ${statusText} === '共 1 个'`), await evaluate(`JSON.stringify({ p: ${hitPaths}, s: ${statusText} })`));
  console.log(`数字（本机无头 Chrome）：${BULK} 条目录里搜名字，从输入到结果画出来 ${elapsed} 毫秒（含 0.3 秒防抖）`);
  await typeQuery('needle-final', 'needle-final');
  check('搜索 bulk：几层子目录里的文件也找得到', await evaluate(`JSON.stringify(${hitPaths}) === '["small/deeper/deepest/needle-final.txt"]'`), await evaluate(`JSON.stringify(${hitPaths})`));
  await typeQuery('item-0', 'item-0');
  const total500 = `Math.round(parseFloat(document.querySelector('#search .spacer').style.height) / document.querySelector('#search .row.entry').getBoundingClientRect().height)`;
  check('搜索 bulk：匹配很多时最多 500 条（列表总高度是 500 行），状态行写明', await evaluate(`${total500} === 500 && ${statusText}.startsWith('结果太多，只显示先找到的 500 个')`), await evaluate(`JSON.stringify({ n: ${total500}, s: ${statusText} })`));
  check('搜索 bulk：500 条画出的节点数有上限（虚拟列表）', await evaluate(`document.querySelectorAll('#search .row.entry').length <= 60`), await evaluate(`document.querySelectorAll('#search .row.entry').length`));
  await fetch(`${serverUrl}ctl?action=session:A`);
  }

  { // ================= 文件内查找（0.8.0，设计第 18.6、18.8 节）：高亮范围数、当前这处在可见区、颜色门槛、性能、查找条的布局和截图 =================
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const fq = `document.querySelector('.finput')`;
  const kb = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const pngDecode = buf => { // 同 0.7.2 的取像素：只认 8 位 RGB、RGBA；返回 { width, height, at(x, y) }
    let pos = 8, width = 0, height = 0, depth = 0, kind = 0;
    const idat = [];
    while (pos < buf.length) { const length = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + length); pos += 12 + length;
      if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; kind = data[9]; } else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break; }
    const bpp = kind === 6 ? 4 : kind === 2 ? 3 : 0;
    if (depth !== 8 || !bpp) throw new Error(`不认识的 PNG：位深 ${depth}，颜色类型 ${kind}`);
    const raw = inflateSync(Buffer.concat(idat)), stride = width * bpp, out = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) { const filter = raw[y * (stride + 1)];
      for (let x = 0; x < stride; x++) { const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y > 0 ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0, v = raw[y * (stride + 1) + 1 + x];
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        out[y * stride + x] = (v + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c))) & 255; } }
    return { width, height, at: (x, y) => [out[y * stride + x * bpp], out[y * stride + x * bpp + 1], out[y * stride + x * bpp + 2]] };
  };
  const pngAt = buf => pngDecode(buf).at(0, 0);
  const pixel = async at => pngAt(Buffer.from((await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.floor(at.x), y: Math.floor(at.y), width: 2, height: 2, scale: 1 } })).result.data, 'base64'));
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratioOf = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const diffMax = (a, b) => Math.max(...[0, 1, 2].map(i => Math.abs(a[i] - b[i])));
  const rgbOf = css => css.match(/[\d.]+/g).slice(0, 3).map(Number);
  const marked = `(CSS.highlights.get('find')?.size ?? 0)`;
  // 输入 text 并等到这个词的标记画完（find-done 在这次输入之后出现，不靠固定等待）。
  async function findFor(text, { done = true } = {}) {
    await evaluate(`${fq}.focus(); ${fq}.select(); window.__t0 = performance.now(); performance.clearMarks('find-done'); performance.clearMeasures('find-batch'); performance.clearMeasures('find-run')`);
    await send('Input.insertText', { text });
    if (done) await until(`performance.getEntriesByName('find-done').length > 0 || (${marked} > 0 && ${marked} === document.querySelector('.fcount') && false) || (document.querySelector('.fcount').textContent === '0')`, `查找「${text.slice(0, 12)}」标完`);
  }
  const clearFind = async () => { await evaluate(`${fq}.value = ''; ${fq}.dispatchEvent(new Event('input'))`); await until(`CSS.highlights.size === 0`, '清掉查找词后标记删除'); };

  // ---- 夹具：上色的、纯文本的、长行的、密集 token 的、带一串串空格的 ----
  const denseLine = `${'x=1;y="a";'.repeat(8)}\n`, dense = denseLine.repeat(Math.floor((HIGHLIGHT_LIMIT - 1000) / denseLine.length)); // 每行 81 个字符，没有长行：上色
  const plain = Array.from({ length: 20000 }, (_, i) => `line ${i} needle ${'z'.repeat(20)}`).join('\n').slice(0, 1_000_000);
  const longLine = 'ab cd '.repeat(90000);
  const spaces = ['// 空格样本', 'const a = 1;', ...Array.from({ length: 40 }, () => `${' '.repeat(24)}return 1;`)].join('\n');
  await Promise.all([writeFile(join(fixture, 'perf-dense.js'), dense), writeFile(join(fixture, 'perf-plain.txt'), plain), writeFile(join(fixture, 'perf-long.txt'), longLine), writeFile(join(fixture, 'spaces.js'), spaces)]);

  // ---- 高亮：在上色的文件里搜一个跨 token 的词，范围数对，当前这处在可见区内 ----
  await openFile('window', 'light', 'session=A&path=assets/sample.js', 'mac');
  await frames();
  await kb('f', 'KeyF', 70, 4);
  await until(`document.activeElement === ${fq}`, '窗口：⌘F 聚焦查找条');
  await findFor('name = "world", times');
  const hl = await evalStrict(`(() => { const text = document.querySelector('.text').textContent, term = 'name = "world", times', want = text.split(term).length - 1;
    const all = CSS.highlights.get('find'), now = CSS.highlights.get('find-current'), range = [...now][0], r = range.getBoundingClientRect(), b = document.querySelector('.pbody').getBoundingClientRect();
    const spans = new Set([...all].map(x => x.startContainer)).size;
    return { want, all: all.size, now: now.size, priority: [all.priority, now.priority], inView: r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.left >= b.left - 1, crosses: range.startContainer !== range.endContainer, count: document.querySelector('.fcount').textContent, spans }; })()`);
  check('查找 窗口：在上色的文件里搜跨 token 的词，find 里的范围数和原文里的出现次数一致，当前这处只有一个、priority 更高、在可见区内，匹配跨了文本节点', hl.want > 0 && hl.all === hl.want && hl.now === 1 && hl.priority[1] > hl.priority[0] && hl.inView && hl.crosses, JSON.stringify(hl));
  await findFor('o');
  await until(`${marked} > 5`, '搜 o：多处匹配');
  const nav = await evaluate(`(() => { const before = document.querySelector('.fcount').textContent; document.querySelector('.fnext').click(); return { before, after: document.querySelector('.fcount').textContent }; })()`);
  check('查找 窗口：下一个把计数从 1/N 变成 2/N', /^1\//.test(nav.before) && /^2\//.test(nav.after), JSON.stringify(nav));
  // 菜单开着时按 Esc（第 18.5 节）：真实 Chrome 的传播顺序（document 捕获 → 目标 → 冒泡经过预览 → document 冒泡）里，菜单先处理，关菜单并消费掉这个 Esc，查找条不关。
  // 查找条开着、选中正文里的字、真实右键打开菜单，焦点分别在正文和查找输入框里各按一次 Esc。
  for (const focusAt of ['正文', '查找输入框']) {
    const spot = await evalStrict(`(() => { const text = document.querySelector('.text'), n = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode(), range = document.createRange();
      range.setStart(n, 0); range.setEnd(n, Math.min(5, n.data.length)); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); const r = range.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'right', buttons: 2, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'right', buttons: 0, clickCount: 1 });
    await until(`!document.getElementById('menu').hidden`, `${focusAt}：右键打开菜单`);
    if (focusAt === '查找输入框') await evaluate(`${fq}.focus()`);
    const focusedNow = await evaluate(`document.activeElement === ${fq} ? '查找输入框' : document.getElementById('preview').contains(document.activeElement) ? '正文' : '别处'`);
    await kb('Escape', 'Escape', 27);
    const state = await evaluate(`({ menu: document.getElementById('menu').hidden, bar: !document.querySelector('.fbar').hidden, value: ${fq}.value, marks: CSS.highlights.get('find')?.size ?? 0 })`);
    check(`查找 菜单开着按 Esc（焦点在${focusAt}）：只关菜单，查找条、搜索词、标记都还在`, focusedNow === focusAt && state.menu && state.bar && state.value === 'o' && state.marks > 0, JSON.stringify({ focusedNow, state }));
  }
  await kb('Escape', 'Escape', 27);
  await until(`CSS.highlights.size === 0 && document.querySelector('.fbar').hidden`, 'Esc 关查找条并清掉标记');
  check('查找 窗口：Esc 关查找条之后 .pbody 没有 finding 类（::highlight 规则只在查找开着时生效）；样式表里的 ::highlight(find…) 规则选择器都带 .pbody.finding', await evaluate(`!document.querySelector('.pbody').classList.contains('finding') && [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => /::highlight\\(find/.test(rule.cssText)).every(rule => /\\.pbody\\.finding/.test(rule.selectorText))`));
  check('查找 窗口：Esc 关查找条，标记全部删除，焦点回正文', await evaluate(`document.activeElement === document.querySelector('.pbody')`));

  // ---- 颜色门槛（固定主题、固定 DPR 2）：用一串空格作搜索词，在匹配的底色上取样，避开字形 ----
  for (const theme of ['light', 'dark']) {
    await openFile('window', theme, 'session=A&path=spaces.js', 'mac');
    await frames();
    await kb('f', 'KeyF', 70, 4);
    await findFor(' '.repeat(8));
    await frames();
    const probe = await evalStrict(`(() => { const body = document.querySelector('.pbody'), b = body.getBoundingClientRect(), now = [...CSS.highlights.get('find-current')][0], nr = now.getBoundingClientRect();
      const pick = [...CSS.highlights.get('find')].map(r => r.getBoundingClientRect()).find(r => r.top >= b.top && r.bottom <= b.bottom && Math.abs(r.top - nr.top) > 2);
      const fg = getComputedStyle(document.querySelector('.text')).color, root = getComputedStyle(document.documentElement);
      const tokens = [...document.styleSheets].flatMap(s => [...s.cssRules]).filter(r => r.selectorText === ':root' || r.selectorText === ':root.coda-dark').length;
      const probeEl = document.createElement('span'); document.querySelector('.text').append(probeEl);
      const colors = {}; for (const name of ['keyword', 'string', 'comment', 'number', 'title', 'type', 'attr', 'meta', 'tag', 'variable', 'regexp', 'addition', 'deletion', 'section']) { probeEl.style.color = 'var(--hl-' + name + ')'; colors[name] = getComputedStyle(probeEl).color; }
      probeEl.remove();
      return { now: { x: nr.left + nr.width / 2, y: nr.top + nr.height / 2 }, plain: pick ? { x: pick.left + pick.width / 2, y: pick.top + pick.height / 2 } : null, fg, colors, tokens }; })()`);
    const pNow = await pixel(probe.now), pPlain = await pixel(probe.plain);
    const fg = rgbOf(probe.fg), worst = Object.entries(probe.colors).map(([name, css]) => [name, ratioOf(rgbOf(css), pPlain)]).sort((a, b) => a[1] - b[1]);
    const diff = diffMax(pPlain, pNow), fgRatios = [ratioOf(fg, pPlain), ratioOf(fg, pNow)];
    console.log(`数字（查找颜色，${theme}，DPR 2，截图取像素）：普通底色 rgb(${pPlain}) 当前底色 rgb(${pNow})；正文色 rgb(${fg}) 对比 ${fgRatios.map(x => x.toFixed(2)).join(' / ')}；token（只对普通匹配的底色）最低三项 ${worst.slice(0, 3).map(([n, r]) => `${n} ${r.toFixed(2)}`).join('，')}；两种底色像素差 ${diff}`);
    check(`查找 颜色 ${theme}：正文色对普通、当前两种合成底色的对比度都不低于 4.5:1`, fgRatios.every(r => r >= 4.5), JSON.stringify(fgRatios));
    check(`查找 颜色 ${theme}：各个上色 token 的颜色（共 ${worst.length} 个）对普通匹配的合成底色不低于 3:1（当前这处不显示代码着色，只验正文色）`, worst[0][1] >= 3, JSON.stringify(worst.slice(0, 4)));
    check(`查找 颜色 ${theme}：普通和当前两种合成底色按按下底色同一种像素差算，不小于 20`, diff >= 20, `差 ${diff}`);
    await kb('Escape', 'Escape', 27);
    // 当前这处里的 token 字形：::highlight(find-current) 的文字色盖过 token span 的颜色，字形是正文色（量计算值，再取截图里字形核心的像素）
    await openFile('window', theme, 'session=A&path=assets/sample.js', 'mac');
    await frames();
    await kb('f', 'KeyF', 70, 4);
    await findFor('const');
    await frames();
    const g = await evalStrict(`(() => { const now = [...CSS.highlights.get('find-current')][0], el = now.startContainer.parentElement, r = now.getBoundingClientRect(), root = getComputedStyle(document.querySelector('.text'));
      const probe = document.createElement('span'); probe.style.color = 'var(--hl-keyword)'; document.querySelector('.text').append(probe); const kw = getComputedStyle(probe).color; probe.remove();
      return { cls: el.className, own: getComputedStyle(el).color, shown: getComputedStyle(el, '::highlight(find-current)').color, fg: root.color, kw, rect: { x: r.left, y: r.top, width: r.width, height: r.height } }; })()`);
    const shot = pngDecode(Buffer.from((await send('Page.captureScreenshot', { format: 'png', clip: { ...g.rect, scale: 4 } })).result.data, 'base64'));
    const corner = shot.at(0, 0); let core = corner, far = -1; // 字形核心：离底色最远的像素
    for (let y = 0; y < shot.height; y++) for (let x = 0; x < shot.width; x++) { const px = shot.at(x, y), d = diffMax(px, corner); if (d > far) { far = d; core = px; } }
    const toFg = diffMax(core, rgbOf(g.fg)), toKw = diffMax(core, rgbOf(g.kw));
    console.log(`数字（当前这处里的 token 字形，${theme}）：token 类 ${g.cls || '（无）'}，span 自己的颜色 ${g.own}，::highlight 的计算颜色 ${g.shown}，正文色 ${g.fg}，关键字色 ${g.kw}；字形核心像素 rgb(${core})，离正文色 ${toFg}、离关键字色 ${toKw}`);
    check(`查找 颜色 ${theme}：当前这处里的 token（${g.cls}）：span 自己是 token 色，::highlight 的文字色是正文色，截图里的字形核心离正文色比离 token 色近`, g.own !== g.fg && g.shown === g.fg && toFg < toKw, JSON.stringify({ ...g, core, toFg, toKw }));
    await kb('Escape', 'Escape', 27);
  }

  // ---- 性能：每个样本取 5 次的中位数；总时间 ≤ 1 秒，最长一批同步计算 ≤ 100 毫秒 ----
  const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const samples = [['1 MiB 普通文本，满 10000 处匹配', 'perf-plain.txt', 'needle'], ['高亮上限内、token 最密的上色文件，匹配跨 token', 'perf-dense.js', '1;y=']];
  // 诊断（不是门槛）：密集 token 的文件里直接注册 N 个跨 token 的 Range，量两帧绘制的时间，看慢在哪、随 N 怎么长。
  await openFile('window', 'light', 'session=A&path=perf-dense.js', 'mac');
  await frames();
  const grow = await evalStrict(`(async () => { const text = document.querySelector('.text'), nodes = []; const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT); for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    const out = []; for (const count of [250, 500, 1000, 2000]) { const hl = new Highlight(); for (let i = 0; i < count; i++) { const k = (i * 3) % (nodes.length - 4), r = document.createRange(); r.setStart(nodes[k], 0); r.setEnd(nodes[k + 3], 1); hl.add(r); }
      const t0 = performance.now(); CSS.highlights.set('find', hl); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); out.push([count, Math.round(performance.now() - t0)]); CSS.highlights.delete('find'); }
    return { nodes: nodes.length, out }; })()`);
  console.log(`数字（诊断：${grow.nodes} 个文本节点的上色文件里直接注册 N 个跨 token 的 Range，到画完两帧）：${grow.out.map(([n, ms]) => `${n} 个 ${ms} 毫秒`).join('，')}`);
  const FIND_BATCH_SIZE = 2000; // find.mjs 的 FIND_BATCH
  const COUNT_BUDGET_MS = 1000, GAP_BUDGET_MS = 100; // 长行：输入到计数出来（实测 165）；输入到完成期间最大帧间隔（实测 17，一帧）：各留 6 倍左右余量
  const FRAME_BUDGET_MS = 200; // 长行不卡的门槛：实测画两帧 25～33 毫秒，留 6 倍以上余量（页面卡死时是十几秒以上）
  const SLOW_MS = 20000; // 一次超过这么久就不再重复，直接记下数字（页面卡在绘制上，重复只是白等）
  async function perfSample([label, file, term]) {
    await openFile('window', 'light', `session=A&path=${file}`, 'mac');
    await frames();
    await kb('f', 'KeyF', 70, 4);
    const totals = [], batches = [], dones = [], layouts = [], notes = [];
    let slow = false;
    for (let i = 0; i < 5 && !slow; i++) {
      await evaluate(`${fq}.focus(); ${fq}.select(); window.__t0 = performance.now(); performance.clearMarks('find-done'); performance.clearMeasures('find-batch'); performance.clearMeasures('find-run')`);
      await send('Input.insertText', { text: term });
      const began = Date.now();
      let finished = false;
      while (Date.now() - began < SLOW_MS && !(finished = await evaluateLive(`performance.getEntriesByName('find-done').length > 0`))) await wait(100);
      if (!finished) { slow = true; totals.push(Infinity); notes.push(`超过 ${SLOW_MS / 1000} 秒还没标完`); batches.push(NaN); break; }
      const run = await evaluateLive(`(() => { const a = performance.now(); document.body.offsetHeight; const b = performance.now(); const times = [...performance.getEntriesByName('find-batch'), ...performance.getEntriesByName('find-run')].map(e => e.duration);
        return { total: b - window.__t0, doneAt: performance.getEntriesByName('find-done')[0].startTime - window.__t0, layout: b - a, longest: Math.max(...times, 0), marks: ${marked}, count: document.querySelector('.fcount').textContent }; })()`);
      totals.push(run.total); batches.push(run.longest); dones.push(run.doneAt); layouts.push(run.layout); notes.push(`${run.marks} 处 ${run.count}`);
      await clearFind();
    }
    const total = median(totals), longest = median(batches);
    console.log(`数字（查找性能，${label}，无头 Chrome，${totals.length} 次${slow ? '（第一次就超时，不再重复）' : '取中位数'}）：从输入到标完（含强制排版）${total === Infinity ? `超过 ${SLOW_MS / 1000} 秒` : `${total.toFixed(0)} 毫秒`}（含 150 毫秒防抖）；其中标完的时刻 ${dones.map(x => x.toFixed(0))} 毫秒、强制排版 ${layouts.map(x => x.toFixed(0))} 毫秒；最长一批同步 ${Number.isNaN(longest) ? '—' : `${longest.toFixed(1)} 毫秒`}；${notes[0]}`);
    check(`查找 性能「${label}」：输入到标完（计算、注册、强制排版）中位数不超过 1 秒`, total <= 1000, `${totals.map(x => x.toFixed(0))}`);
    check(`查找 性能「${label}」：最长一批同步计算中位数不超过 100 毫秒`, longest <= 100, `${batches.map(x => Number(x).toFixed(1))}`);
    if (slow) await evaluateLive(`${fq}.value = ''; ${fq}.dispatchEvent(new Event('input'))`);
    await kb('Escape', 'Escape', 27);
  }
  for (const sample of samples) await perfSample(sample);

  // ---- 查找条：两端的布局（字号 ≥ 16 点，iPhone 按钮 ≥ 44 点，不随正文滚动，横屏一行放下）和截图 ----
  const findShot = async (size, platform, theme, name) => {
    await open(size, platform, theme);
    if (platform === 'mac') { await evaluate(`window.__open([...document.querySelectorAll('.row.entry')].find(r => r.querySelector('.name').textContent === 'notes.txt'))`); }
    else await evaluate(`window.__open([...document.querySelectorAll('.row.entry')].find(r => r.querySelector('.name').textContent === 'notes.txt'))`); // iPhone：一次 click 就是轻点打开
    await until(`document.querySelector('.text') && !document.getElementById('preview').classList.contains('off')`, `${platform} 预览出现`);
    await until(`!document.documentElement.classList.contains('moving')`, '过渡结束');
    if (platform === 'mac') { await evaluate(`document.getElementById('preview').focus()`); await kb('f', 'KeyF', 70, 4); }
    else { await evaluate(`document.querySelector('#preview [aria-label="更多"]').click()`); await until(`!document.getElementById('menu').hidden`, '⋯ 菜单');
      await evaluate(`[...document.querySelectorAll('#menu button')].find(b => b.textContent === '查找').click()`); }
    await until(`!document.querySelector('.fbar').hidden && document.activeElement === ${fq}`, `${platform}：查找条打开并聚焦`);
    await findFor('line 1');
    await until(`${marked} > 3`, '标出了匹配');
    await shoot(name);
    const geo = await evaluate(`(() => { const bar = document.querySelector('.fbar'), r = bar.getBoundingClientRect(), input = document.querySelector('.finput'), count = document.querySelector('.fcount'), btns = [...bar.querySelectorAll('button')].map(b => b.getBoundingClientRect()),
      body = document.querySelector('.pbody'), top = r.top; body.scrollTop = 300; body.dispatchEvent(new Event('scroll'));
      return { rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize), font: parseFloat(getComputedStyle(input).fontSize), minBtn: Math.min(...btns.map(b => Math.min(b.width, b.height))), barH: r.height, rows: new Set([input, count, ...bar.querySelectorAll('button')].map(n => { const q = n.getBoundingClientRect(); return Math.round((q.top + q.bottom) / 2 / 6); })).size, countH: count.getBoundingClientRect().height, fixed: bar.getBoundingClientRect().top === top, inside: btns.every(b => b.right <= innerWidth + 0.5), count: count.textContent }; })()`);
    return geo;
  };
  for (const theme of ['light', 'dark']) {
    const mac = await findShot('mac', 'mac', theme, `find-mac-${theme}`);
    check(`查找 Mac ${theme}：输入框字号等于正文字号，查找条不随正文滚动，按钮都在窗口内`, mac.font === mac.rootFont && mac.fixed && mac.inside, JSON.stringify(mac));
    const phone = await findShot('portrait', 'ios', theme, `find-ios-${theme}`);
    check(`查找 iPhone 竖屏 ${theme}：输入框字号不小于 16 点，按钮至少 44 点，一行放下，不随正文滚动`, phone.font >= 16 && phone.minBtn >= 44 && phone.rows <= 2 && phone.fixed && phone.inside, JSON.stringify(phone));
  }
  const land = await findShot('landscape', 'ios', 'light', 'find-ios-landscape');
  check('查找 iPhone 横屏：输入框占剩下的宽度，计数「N/M」不换行，按钮至少 44 点，查找条在一行里，都在屏幕内', land.font >= 16 && land.minBtn >= 44 && land.countH < 30 && land.inside && land.fixed, JSON.stringify(land));
  // 有长行的文件（540 KiB 单行）：不标高亮（只计数、导航、滚动），只验不卡：输入之前就开始记 rAF，统计从输入到完成这段时间里最大的帧间隔；
  // 计数出来、CSS.highlights 里没有注册；完成后「画两帧」仍很快；Esc 能关查找条。
  await openFile('window', 'light', 'session=A&path=perf-long.txt', 'mac');
  await frames();
  await kb('f', 'KeyF', 70, 4);
  await evaluate(`${fq}.focus(); performance.clearMarks('find-done'); (() => { const g = window.__frames = { stamps: [], stop: false }; const tick = t => { g.stamps.push(t); if (!g.stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
  await wait(300); // 帧已经在出
  await evaluateLive(`window.__t0 = performance.now()`);
  await send('Input.insertText', { text: 'ab cd' });
  await until(`document.querySelector('.fcount').textContent.length > 0 && performance.getEntriesByName('find-done').length > 0`, '长行：计数出来');
  await wait(300); // 完成之后再记一会儿
  const longState = await evaluateLive(`(() => { const g = window.__frames; g.stop = true; const t0 = window.__t0, done = performance.getEntriesByName('find-done')[0].startTime, st = g.stamps; let from = 0; while (from + 1 < st.length && st[from + 1] <= t0) from++;
    const gaps = []; for (let i = from + 1; i < st.length && st[i - 1] <= done + 100; i++) gaps.push(st[i] - st[i - 1]);
    return { count: document.querySelector('.fcount').textContent, find: CSS.highlights.has('find'), current: CSS.highlights.has('find-current'), counted: done - t0, maxGap: Math.max(...gaps), frames: gaps.length }; })()`);
  const frameMs = [];
  for (let i = 0; i < 5; i++) frameMs.push(await evaluateLive(`new Promise(r => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t0))); })`));
  const worstFrames = Math.max(...frameMs);
  console.log(`数字（长行样本 540 KiB 单行，搜 ab cd）：计数 ${longState.count}，输入到计数出来 ${longState.counted.toFixed(0)} 毫秒；输入到完成期间 ${longState.frames} 帧、最大帧间隔 ${longState.maxGap.toFixed(0)} 毫秒；完成后 5 次「画两帧」耗时 ${frameMs.map(x => x.toFixed(0))} 毫秒`);
  check('查找 长行（540 KiB 单行）：计数出来，CSS.highlights 里没有 find 和 find-current（有长行不标高亮）', /^1\/\d+\+?$/.test(longState.count) && !longState.find && !longState.current, JSON.stringify(longState));
  check(`查找 长行：输入到计数出来不超过 ${COUNT_BUDGET_MS} 毫秒（实测 ${longState.counted.toFixed(0)}）`, longState.counted <= COUNT_BUDGET_MS, JSON.stringify(longState));
  check(`查找 长行：从输入到完成这段时间里页面一直在出帧——最大帧间隔不超过 ${GAP_BUDGET_MS} 毫秒（实测 ${longState.maxGap.toFixed(0)}，${longState.frames} 帧）`, longState.maxGap <= GAP_BUDGET_MS && longState.frames >= 5, JSON.stringify(longState));
  check(`查找 长行：完成之后 5 次「画两帧」每次不超过 ${FRAME_BUDGET_MS} 毫秒（实测最长 ${worstFrames.toFixed(0)} 毫秒，补充）`, worstFrames <= FRAME_BUDGET_MS, JSON.stringify(frameMs));
  await kb('Escape', 'Escape', 27);
  await until(`document.querySelector('.fbar').hidden`, '长行：Esc 关查找条');
  check('查找 长行：Esc 能关查找条', true);
  // 查找没完成时按 Esc：取消。不碰机器速度：页面里把批间的 setTimeout(0) 攥在手里（只放行我们要的），第一批注册之后下一批排在手里时按 Esc（真实键盘入口），
  // 再放行手里剩下的回调，用确定的信号判断：手里排着的批次被取消了（clearTimeout），放行后没有再注册、也没有 find-done。HARNESS_SLOW_MS 给每一步 CDP 调用之间加延迟，结果不变。
  const slowMs = Number(process.env.HARNESS_SLOW_MS ?? 0);
  const slow = () => (slowMs ? wait(slowMs) : undefined);
  await openFile('window', 'light', 'session=A&path=perf-dense.js', 'mac');
  await frames();
  await kb('f', 'KeyF', 70, 4);
  await evaluate(`${fq}.focus(); performance.clearMarks('find-done');
    window.__held = new Map(); let n = 0; const realSet = window.setTimeout, realClear = window.clearTimeout;
    window.setTimeout = (fn, ms, ...args) => (ms === 0 ? (window.__held.set(--n, fn), n) : realSet(fn, ms, ...args));
    window.clearTimeout = handle => { if (!window.__held.delete(handle)) realClear(handle); };`);
  await send('Input.insertText', { text: '1;y=' });
  await slow();
  await untilLive(`(CSS.highlights.get('find')?.size ?? 0) === ${FIND_BATCH_SIZE} && window.__held.size === 1`, '分批：第一批已注册，下一批排在手里');
  await slow();
  const gated = await evaluateLive(`({ registered: CSS.highlights.get('find').size, held: window.__held.size, done: performance.getEntriesByName('find-done').length })`);
  await kb('Escape', 'Escape', 27);
  await slow();
  await until(`document.querySelector('.fbar').hidden && CSS.highlights.size === 0`, '查找中途 Esc：查找条关、标记删光');
  const cancelled = await evaluateLive(`window.__held.size`); // 排着的批次已经被 clearTimeout 取消
  const released = await evaluateLive(`(() => { const queued = [...window.__held.values()]; window.__held.clear(); for (const fn of queued) { try { fn(); } catch { /* 取消的批次若被放行，也不许注册 */ } } return queued.length; })()`);
  await frames();
  const after = await evaluateLive(`({ size: CSS.highlights.size, done: performance.getEntriesByName('find-done').length, hidden: document.querySelector('.fbar').hidden, held: window.__held.size })`);
  check(`查找：没完成时按 Esc 取消——Esc 前第一批（${FIND_BATCH_SIZE} 个）已注册、下一批排在手里、find-done 还没有；Esc 后查找条关、标记删光、手里排着的批次已被取消（${cancelled} 个剩下），即使放行（${released} 个）也不再注册、没有 find-done`,
    gated.registered === FIND_BATCH_SIZE && gated.held === 1 && gated.done === 0 && cancelled === 0 && after.size === 0 && after.done === 0 && after.hidden, JSON.stringify({ gated, cancelled, released, after }));
  }

  // ---- 0.8.1 worktree 的根目录名（会话 W：worktree 会话，目录名 UUID，Coda 里的项目名 coda_plugins_resource_manager）----
  // 写法「项目名 worktree-编号」，两段两个元素（.rn-name 粗体、.rn-tag 常规字重三级灰小一号），四步省略（设计第 19.6 节）：
  // 1 完整写法不超过可用宽度的 90%；2 后缀缩成 wt-编号，整行放得下；3 项目名从中间省略；4 整段尾部省略。
  // 真实的 queryRoot 从 checkout.projectId 和 agents 的项目列表（server.mjs 的替身）取项目名，页面收到的 root 消息带 project。四档宽度不凭感觉定：先在宽的视口里用页面里的隐藏元素（各带项目名、后缀自己的字体，布局引擎的量法，不是实现里用的 canvas）
  // 量出完整、短写法、项目名只剩 2 个字的宽度，再按量到的算视口：每档取在对应步骤的区间正中，窄档窄到项目名只剩 2 个字也放不下。判断落在第几步看标题的文字，不看宽度。
  {
    await fetch(`${serverUrl}ctl?action=session:W`);
    const tag = WT_UUID.slice(0, 4), P = WT_PROJECT, full = `${P} worktree-${tag}`, short = `${P} wt-${tag}`, realWt = await realpath(wtDir);
    const stepFn = `(text => text === ${JSON.stringify(full)} ? 1 : text === ${JSON.stringify(short)} ? 2 : text.endsWith('…') ? 4 : text.endsWith(${JSON.stringify(` wt-${tag}`)}) && text.includes('…') && text.startsWith(${JSON.stringify(P[0])}) ? 3 : 0)`;
    const stepOf = text => (text === full ? 1 : text === short ? 2 : text.endsWith('…') ? 4 : text.endsWith(` wt-${tag}`) && text.includes('…') && text.startsWith(P[0]) ? 3 : 0);
    // 页面里量文字的宽度：隐藏的 span 带上那个元素的字体（项目名的粗体、后缀的小字号常规字重各量各的）。
    const textWidth = (selector, text) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}), style = getComputedStyle(el), span = document.createElement('span');
      Object.assign(span.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap', font: style.font }); span.textContent = ${JSON.stringify(text)}; document.body.append(span); const w = span.getBoundingClientRect().width; span.remove(); return w; })()`);
    const pad = selector => evaluate(`(() => { const style = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return parseFloat(style.paddingLeft) + parseFloat(style.paddingRight); })()`);
    const shown = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? { text: el.textContent, title: el.title, overflow: el.scrollWidth - el.clientWidth, page: document.documentElement.scrollWidth - innerWidth, client: el.clientWidth, parts: [...el.children].map(c => c.className) } : null; })()`);
    const waitStep = (selector, step, what) => until(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el !== null && ${stepFn}(el.textContent) === ${step}; })()`, what);
    // 视口宽：现在是 baseW 宽时标题的 clientWidth 是 client，要让它变成 target。
    const widthFor = async (selector, baseW, target) => Math.round(baseW - ((await shown(selector)).client - target));
    // 两段的计算样式：字号、字重、颜色（三级灰要和 --coda-tertiary 解出来的颜色一致）。
    const styles = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}), name = el.querySelector('.rn-name'), tag = el.querySelector('.rn-tag'); if (!name || !tag) return null;
      const probe = document.createElement('i'); probe.style.color = 'var(--coda-tertiary)'; document.body.append(probe); const tertiary = getComputedStyle(probe).color; probe.remove();
      const n = getComputedStyle(name), t = getComputedStyle(tag), root = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return { nameSize: parseFloat(n.fontSize), tagSize: parseFloat(t.fontSize), nameWeight: Number(n.fontWeight), tagWeight: Number(t.fontWeight), tagColor: t.color, tertiary, nameColor: n.color, root }; })()`);

    for (const [platform, container, baseSize, label] of [['mac', '#tree .section', 'window', 'Mac 侧栏'], ['ios', '.bar-title', 'portrait', 'iPhone 工具条']]) {
      await open(baseSize, platform, 'light');
      const nameSel = `${container} .rn-name`, tagSel = `${container} .rn-tag`, padding = await pad(container);
      const wName = await textWidth(nameSel, P), wMin = await textWidth(nameSel, `${P[0]}…${P.at(-1)}`);
      const wTagLong = await textWidth(tagSel, ` worktree-${tag}`), wTagShort = await textWidth(tagSel, ` wt-${tag}`);
      const wFull = wName + wTagLong, wShort = wName + wTagShort, wMinimal = wMin + wTagShort;
      // 可用宽度 = clientWidth - padding - 2（量字的误差）；各档的可用宽度取在区间正中。
      const avail = { wide: wFull / 0.9 + 12, medium: (wShort + wFull / 0.9) / 2, small: (wMinimal + wShort) / 2, narrow: wMinimal - 30 };
      const baseW = SIZES[baseSize][0], widths = {};
      for (const [name, a] of Object.entries(avail)) { widths[name] = await widthFor(container, baseW, a + padding + 2); SIZES[`wt-${platform}-${name}`] = [widths[name], SIZES[baseSize][1], SIZES[baseSize][2]]; }
      console.log(`${label}：完整 ${wFull.toFixed(1)}（90% 线 ${(wFull / 0.9).toFixed(1)}）、短写法 ${wShort.toFixed(1)}、项目名只剩 2 个字 ${wMinimal.toFixed(1)} 点；视口宽 宽 ${widths.wide} / 中 ${widths.medium} / 小 ${widths.small} / 窄 ${widths.narrow}`);
      check(`${label}：四档视口宽依次变窄，窄档不小于 60；步骤之间的区间都有宽度（短写法 < 90% 线）`, widths.wide > widths.medium && widths.medium > widths.small && widths.small > widths.narrow && widths.narrow >= 60 && wShort < wFull / 0.9, JSON.stringify({ widths, wFull, wShort, wMinimal }));

      // 同一个页面不重载：宽 → 中 → 小 → 窄 → 宽，每次变视口都重新算（拖窄侧栏、转屏）。
      await open(`wt-${platform}-wide`, platform, 'light');
      let now = await shown(container);
      check(`${label} 宽：完整写法「${full}」（第 1 步），两个元素（项目名、后缀），标题不横向溢出，页面不出横向滚动条`, stepOf(now.text) === 1 && now.parts.join() === 'rn-name,rn-tag' && now.overflow <= 0 && now.page <= 0, JSON.stringify(now));
      if (platform === 'mac') check(`${label}：标题悬停是完整路径`, now.title === realWt, JSON.stringify(now));
      // 字体层级：后缀常规字重、三级灰、比项目名小；项目名粗体、不是三级灰。
      const st = await styles(container);
      check(`${label}：后缀是常规字重（400）、三级灰（${st?.tertiary}）、字号 ${st?.tagSize} 比项目名 ${st?.nameSize} 小；项目名是粗体（${st?.nameWeight}）且不是三级灰`,
        st && st.tagWeight === 400 && st.tagColor === st.tertiary && st.tagSize < st.nameSize && st.nameWeight >= 600 && st.nameColor !== st.tertiary, JSON.stringify(st));
      // 字号用相对单位跟着 --coda-font-size：Mac 项目名约 .92em（比 0.8.1 之前的 .85em 大），后缀约 .85em（原来标题的字号）；iPhone 项目名不变（1em），后缀约 .88em。
      if (platform === 'mac') check(`Mac 标题：项目名字号 ${st.nameSize} 约 .92 × ${st.root}，比 0.8.1 之前的 .85 × ${st.root} = ${(0.85 * st.root).toFixed(2)} 大；后缀 ${st.tagSize.toFixed(2)} 约等于原来的字号`,
        Math.abs(st.nameSize - 0.92 * st.root) < 0.3 && st.nameSize > 0.85 * st.root + 0.5 && Math.abs(st.tagSize - 0.85 * st.root) < 0.3, JSON.stringify(st));
      else check(`iPhone 标题：项目名字号不变（${st.nameSize} = 正文 ${st.root}），后缀小一号（${st.tagSize.toFixed(2)} ≈ .88 × ${st.root}）`, Math.abs(st.nameSize - st.root) < 0.3 && Math.abs(st.tagSize - 0.88 * st.root) < 0.3, JSON.stringify(st));
      if (platform === 'mac') await shoot('rm-0.8.1b-mac-light-wide');
      for (const [name, step] of [['medium', 2], ['small', 3], ['narrow', 4], ['wide', 1]]) {
        await setViewport(`wt-${platform}-${name}`, platform);
        await waitStep(container, step, `${label}：同一个页面里视口变成「${name}」后标题落到第 ${step} 步`);
        now = await shown(container);
        const extra = { 2: '，后缀缩成 wt-编号', 3: '，wt-编号完整、项目名留了首尾', 4: '，整段尾部省略' }[step] ?? '';
        check(`${label} ${name}：落在第 ${step} 步（${now.text}），标题不横向溢出，页面不出横向滚动条${extra}`, stepOf(now.text) === step && now.overflow <= 0 && now.page <= 0, JSON.stringify(now));
        if (step > 1 && step < 4) { // 省略以后两段的样式不变
          const again = await styles(container);
          check(`${label} ${name}：省略后后缀仍是常规字重、三级灰、比项目名小`, again && again.tagWeight === 400 && again.tagColor === again.tertiary && again.tagSize < again.nameSize, JSON.stringify(again));
        }
        if (platform === 'mac' && step === 3) await shoot('rm-0.8.1b-mac-light-narrow');
      }
    }
    // Mac 浅色之外的截图：Mac 深色宽（第 1 步）、iPhone 深色竖屏。
    await open('wt-mac-wide', 'mac', 'dark');
    await waitStep('#tree .section', 1, 'Mac 深色 宽');
    await shoot('rm-0.8.1b-mac-dark-wide');
    await open('portrait', 'ios', 'dark'); // 真实的 iPhone 竖屏宽度（420 点）
    await waitStep('.bar-title', 2, 'iPhone 深色 竖屏：这么长的项目名在 420 点里是第 2 步');
    await shoot('rm-0.8.1b-ios-dark');

    // 普通文件夹名（会话 A，不是 worktree）：Mac 标题同样大一号（.92em），是纯文本，没有两段；iPhone 工具条标题字号不变。
    await fetch(`${serverUrl}ctl?action=session:A`);
    await open('window', 'mac', 'light');
    const plainMac = await evaluate(`(() => { const el = document.querySelector('#tree .section'), s = getComputedStyle(el), root = parseFloat(getComputedStyle(document.documentElement).fontSize); return { text: el.textContent, parts: el.children.length, size: parseFloat(s.fontSize), root, weight: Number(s.fontWeight) }; })()`);
    check(`Mac 普通文件夹名标题：纯文本「${plainMac.text}」（没有两段），字号 ${plainMac.size} 约 .92 × ${plainMac.root}（同样大一号），粗体`, plainMac.text === 'demo-project' && plainMac.parts === 0 && Math.abs(plainMac.size - 0.92 * plainMac.root) < 0.3 && plainMac.weight >= 600, JSON.stringify(plainMac));
    await fetch(`${serverUrl}ctl?action=session:W`);

    // Mac 图标视图头部：项目名不变、后缀小一号；窄档落在第 4 步，宽档完整；头部标题不溢出、悬停是完整路径。
    const headSel = '#grid .gname-head';
    await openGrid('window', 'mac', 'light');
    const headBase = SIZES.window[0], hName = await textWidth(`${headSel} .rn-name`, P), hMin = await textWidth(`${headSel} .rn-name`, `${P[0]}…${P.at(-1)}`);
    const hLong = await textWidth(`${headSel} .rn-tag`, ` worktree-${tag}`), hShort = await textWidth(`${headSel} .rn-tag`, ` wt-${tag}`);
    SIZES['wt-grid-wide'] = [await widthFor(headSel, headBase, (hName + hLong) / 0.9 + 12), SIZES.window[1], SIZES.window[2]];
    SIZES['wt-grid-narrow'] = [await widthFor(headSel, headBase, hMin + hShort - 30 + 2), SIZES.window[1], SIZES.window[2]];
    for (const [name, step] of [['wide', 1], ['narrow', 4]]) {
      await openGrid(`wt-grid-${name}`, 'mac', 'light');
      await waitStep(headSel, step, `图标视图头部 ${name}`);
      const head = await shown(headSel), gs = await styles(headSel);
      check(`Mac 图标视图头部 ${name}：落在第 ${step} 步（${head.text}），不溢出，悬停是完整路径`, head.overflow <= 0 && head.title === realWt, JSON.stringify(head));
      if (step === 1) check(`Mac 图标视图头部：项目名字号不变（${gs.nameSize} = 正文 ${gs.root}），后缀小一号、常规字重、三级灰`, Math.abs(gs.nameSize - gs.root) < 0.3 && gs.tagSize < gs.nameSize && gs.tagWeight === 400 && gs.tagColor === gs.tertiary, JSON.stringify(gs));
    }
    // iPhone 图标视图：工具条标题是同一套写法；系统返回的完整写法由 test/root-title.test.mjs 断言（harness 里 coda.back 只记录标题数组）。
    await openGrid('wt-ios-wide', 'ios', 'light');
    check('iPhone 图标视图根目录：工具条标题完整写法', (await evaluate(`document.querySelector('.bar-title')?.textContent`)) === full);
    await fetch(`${serverUrl}ctl?action=session:A`);
  }

  exitCode = failures.length ? 1 : 0;
  keepShots = true;
  console.log(`截图：${shots}`);
  console.log(failures.length ? `失败 ${failures.length} 项` : '全部通过');
} catch (error) {
  console.error(`错误：${error.message}`);
} finally {
  await cleanup();
}
process.exit(exitCode);
