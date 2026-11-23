// 开发用：无头 Chrome（不是 WKWebView）量 Markdown 预览的真实布局，不是产品代码。自己起 harness 服务和临时目录，用完删掉。
// 量的是：宽窗口下 .md 的宽度等于预览正文区的宽度（Mac 窗口、Mac 侧栏、iPhone），iPhone 底部安全区只留一份，
// iPhone 上 Markdown 代码块和代码预览同一字号，不预览提示里有「在 Coda 中打开」。
// 用法：node test/harness/markdown-layout.mjs [Chrome 的路径]；任何一条不符，退出码非 0。
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const chromePath = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9335;
const wait = ms => new Promise(r => setTimeout(r, ms));
const WIDE_TABLE = `| ${Array.from({ length: 12 }, (_, i) => `列${i}`).join(' | ')} |\n| ${Array(12).fill('---').join(' | ')} |\n| ${Array.from({ length: 12 }, (_, i) => `单元格内容${i}`).join(' | ')} |\n`;
const README = ['# 标题', '', '一段正文，含 `行内代码` 和很长的一行文字。'.repeat(8), '', WIDE_TABLE, '```js', 'const answer = 42; // 注释', '```', ''].join('\n');

const base = await mkdtemp(join(tmpdir(), 'rm-md-'));
const children = [];
let ws, id = 0, failed = 0;
const waiting = new Map();
const cleanup = async () => { ws?.close(); for (const c of children) c.kill(); await wait(300); await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const send = (method, params = {}) => new Promise(resolve => { waiting.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expr => { const { result, exceptionDetails } = (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result; if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text); return result.value; };
const until = async (expr, what) => { for (let i = 0; i < 300; i++) { if (await evaluate(expr).catch(() => false)) return; await wait(50); } throw new Error(`等不到：${what}`); };
const check = (name, ok, detail) => { console.log(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`); if (!ok) failed++; };

try {
  await writeFile(join(base, 'README.md'), README);
  await writeFile(join(base, 'sample.js'), 'const answer = 42; // 注释\n');
  await writeFile(join(base, 'report.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]));
  const server = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), base, base, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(server);
  const serverUrl = await new Promise(resolve => server.stdout.on('data', data => { const m = /http:\/\/\S+/.exec(String(data)); if (m) resolve(m[0]); }));
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(base, 'profile')}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  children.push(chrome);
  let page;
  for (let i = 0; i < 100 && !page; i++) { page = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then(r => r.json()).then(list => list.find(x => x.type === 'page')).catch(() => null); if (!page) await wait(200); }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve));
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });

  const go = async (view, width, height, platform, query, safe = '0,0,0,0') => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: platform === 'ios' });
    await send('Page.navigate', { url: `${serverUrl}view/${view}.html?platform=${platform}&theme=light&safe=${safe}&${query}&t=${Date.now()}` });
    await until(`document.readyState === 'complete' && typeof coda !== 'undefined'`, '页面载入');
  };
  // 侧栏：点一行打开（Mac 双击、iPhone 轻点）。
  const openRow = async (name, platform) => {
    await until(`[...document.querySelectorAll('.row.entry')].some(r => r.textContent.includes(${JSON.stringify(name)}))`, `目录里有 ${name}`);
    await evaluate(`(() => { const el = [...document.querySelectorAll('.row.entry')].find(r => r.textContent.includes(${JSON.stringify(name)})); el.click(); if (${platform === 'mac'}) { el.click(); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); } })()`);
  };
  const widths = `(() => { const md = document.querySelector('.md'), body = document.querySelector('.pbody'), cs = getComputedStyle(body), pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const t = document.querySelector('.md-table-wrap'), table = document.querySelector('.md table');
    return { md: md.getBoundingClientRect().width, body: body.clientWidth - pad, bodyScroll: body.scrollWidth, table: table.getBoundingClientRect().width, wrap: t.getBoundingClientRect().width, code: document.querySelector('.md-code').getBoundingClientRect().width,
      left: md.getBoundingClientRect().left - body.getBoundingClientRect().left, padLeft: getComputedStyle(md).paddingLeft }; })()`;

  // 1. 宽窗口：.md 的宽度等于预览正文区的宽度
  await go('file', 1400, 800, 'mac', 'session=A&path=README.md');
  await until(`document.querySelector('.md')`, 'Markdown 预览出现');
  const win = await evaluate(widths);
  check('Mac 独立窗口 1400 宽：.md 宽度 = 预览正文区宽度', Math.abs(win.md - win.body) < 0.5 && win.md > 1300, win);
  check('Mac 独立窗口：代码块随窗口变宽，宽表格在自己的滚动区里', Math.abs(win.code - (win.md - 32)) < 1 && win.wrap <= win.md, win);
  check('Mac 独立窗口：左内边距保持 16px、正文贴左', win.padLeft === '16px' && win.left === 0, win);
  await go('file', 700, 800, 'mac', 'session=A&path=README.md');
  await until(`document.querySelector('.md')`, 'Markdown 预览出现');
  const mid = await evaluate(widths);
  check('Mac 独立窗口 700 宽：同样铺满', Math.abs(mid.md - mid.body) < 0.5, mid);

  await go('index', 280, 700, 'mac', '');
  await openRow('README.md', 'mac');
  await until(`document.querySelector('.md')`, '侧栏预览出现');
  const side = await evaluate(widths);
  check('Mac 侧栏 280 宽：.md 宽度 = 预览正文区宽度（宽表格不撑宽 .md）', Math.abs(side.md - side.body) < 0.5 && side.bodyScroll <= 280, side);

  // 2. iPhone：竖屏 420 宽、底部安全区 34
  await go('index', 420, 790, 'ios', '', '0,0,34,0');
  await openRow('README.md', 'ios');
  await until(`document.querySelector('.md')`, 'iPhone 预览出现');
  const phone = await evaluate(`(() => { const md = document.querySelector('.md'), body = document.querySelector('.pbody');
    return { ...${widths}, mdPadBottom: getComputedStyle(md).paddingBottom, bodyPadBottom: getComputedStyle(body).paddingBottom, mdCode: getComputedStyle(document.querySelector('.md-code')).fontSize,
      inline: getComputedStyle(document.querySelector('.md-inline-code')).borderRadius }; })()`);
  check('iPhone 420 宽：.md 宽度 = 预览正文区宽度', Math.abs(phone.md - phone.body) < 0.5, phone);
  check('iPhone：.md 底部 padding 24px，安全区只由 .pbody 留一份（34px）', phone.mdPadBottom === '24px' && phone.bodyPadBottom === '34px', { md: phone.mdPadBottom, body: phone.bodyPadBottom });
  check('行内代码圆角走 --coda-radius（harness 没给主题变量，取回退值 6px）', phone.inline === '6px', phone.inline);
  await go('file', 420, 790, 'ios', 'session=A&path=sample.js', '0,0,34,0');
  await until(`document.querySelector('.code .text')`, '代码预览出现');
  const codeFont = await evaluate(`getComputedStyle(document.querySelector('.code')).fontSize`);
  check('iPhone：Markdown 代码块字号 = 代码预览字号', phone.mdCode === codeFont && phone.mdCode !== undefined, { md: phone.mdCode, code: codeFont });

  // 3. 不预览提示里的按钮
  await go('file', 760, 560, 'mac', 'session=A&path=report.pdf');
  await until(`document.querySelector('.empty')`, '提示出现');
  check('Mac 独立窗口：「二进制文件，不预览」下有「在 Coda 中打开」', await evaluate(`document.querySelector('.empty').textContent.includes('二进制文件，不预览') && [...document.querySelectorAll('.empty button.link')].some(b => b.textContent === '在 Coda 中打开')`));
} catch (error) {
  console.error(error);
  failed++;
} finally {
  await cleanup();
}
process.exit(failed === 0 ? 0 : 1);
