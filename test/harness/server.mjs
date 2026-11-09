// 开发用：假 window.coda 把真实页面接到真实模块和真实目录。
// 用法：node test/harness/server.mjs <会话A的目录> [会话B的目录] [端口] [会话W的目录] [会话W的项目名]，浏览器打开打印出的地址。
// 会话 W（给了第四个参数才有）：worktree 会话，checkout 带 projectId，`agents` 的回答里有它的项目名（第五个参数，缺省 demo），用来看 0.8.1 的根目录标题（页面收到的 root 消息里带 project，名字由模块从项目列表取）。
// 平台与安全区：?platform=ios 时 <html> 带 coda-ios、字号 17px；?safe=上,右,下,左 模拟 env(safe-area-inset-*)（点数，如 0,59,21,59）。
// 单独打开页面地址（/view/index.html?platform=ios）时，coda.open 跳到文件页、coda.close 返回，可直接用手机尺寸截图。
// 文件视图：地址后加 ?view=file&session=A&path=相对路径，页面启动值同 coda.open({ view: 'file', args })。
// 主题消息 { harness: 'theme', kind, fontSize? }：fontSize 缺省用平台默认值，页面底色随 --coda-background。
// 原生返回：页面声明 coda.back(标题数组) 时记在 window.__backs 里并告诉控制页；控制页的「返回」按钮、或往页面发 { harness: 'back' }，触发 on('back', { steps: 1 })。
// 地址加 ?back=0 模拟没有 coda.back 的旧客户端。写输入框的草稿存在内存里（每个会话一份，不碰任何真实会话）。
// 控制页可切深浅色、切会话、触发一轮结束、重新载入页面。不是产品代码，不随插件使用。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activate } from '../../main.mjs';
import { draftSession } from '../../lib/draft.mjs';

const viewDir = fileURLToPath(new URL('../../view/', import.meta.url));
const [dirA, dirB = dirA, port = '0', dirW = null, nameW = 'demo'] = process.argv.slice(2);
if (!dirA) { console.error('用法：node test/harness/server.mjs <目录A> [目录B] [端口]'); process.exit(1); }

// ---- 假的 coda 宿主（形状同 test/support/fake.mjs）----
const threads = { A: { checkout: { kind: 'worktree', state: 'ready', path: dirA } }, B: { checkout: { kind: 'worktree', state: 'ready', path: dirB } }, ...(dirW ? { W: { checkout: { kind: 'worktree', state: 'ready', path: dirW, projectId: 'project-w' } } } : {}) };
const watchers = new Set(), views = new Set(), providers = new Map();
const drafts = { A: { text: '', attachments: [], revision: 1 }, B: { text: '', attachments: [], revision: 1 }, W: { text: '', attachments: [], revision: 1 } };
activate({
  views: { register: (id, provider) => providers.set(id, provider) },
  api: async (path, body) => {
    if (path === 'agents') return { projects: dirW ? [{ id: 'project-w', name: nameW }] : [] }; // 项目列表（根目录标题的项目名从这里取）
    const session = draftSession(path);
    if (session === null) return threads[decodeURIComponent(path.replace(/^threads\//, ''))];
    const current = drafts[session];
    if (body === undefined) return structuredClone(current);
    if (body.revision !== current.revision) return { draft: structuredClone(current), conflict: true };
    Object.assign(current, { text: body.text, revision: current.revision + 1 });
    return { draft: structuredClone(current) };
  },
  watch: async (_name, fn) => { watchers.add(fn); return { dispose: () => watchers.delete(fn) }; },
});
const emit = (id, turn) => { for (const fn of watchers) fn({ type: 'MODIFIED', id, object: { id, turn } }); };
let session = 'A';

function openView(send, viewId = 'files', args = null) {
  const handlers = {};
  const view = {
    // 文件视图打开时 context.session 是 null（第 3 节实测），会话在 args 里。
    context: { session: viewId === 'file' ? null : session, args }, handlers,
    postMessage: message => send('msg', message),
    onMessage: fn => { handlers.message = fn; }, onContext: fn => { handlers.context = fn; }, onClose: fn => { handlers.close = fn; },
  };
  providers.get(viewId).open(view);
  views.add(view);
  return view;
}

// ---- 页面里的 window.coda ----
const THEMES = {
  light: { 'color-scheme': 'light', '--coda-background': '#f5f5f7', '--coda-secondary-background': '#ececf0', '--coda-foreground': '#1d1d1f', '--coda-secondary': '#6e6e73', '--coda-tertiary': '#a1a1a6', '--coda-separator': 'rgba(0,0,0,.1)', '--coda-fill': 'rgba(0,0,0,.06)', '--coda-accent': '#0a6cff', '--coda-red': '#d70015', '--coda-orange': '#c25700', '--coda-green': '#1a7f37', '--coda-card': '#fff', '--coda-outline': 'rgba(0,0,0,.12)', '--coda-hover': 'rgba(0,0,0,.05)', '--coda-selection': 'rgba(10,108,255,.16)' },
  dark: { 'color-scheme': 'dark', '--coda-background': '#1e1e20', '--coda-secondary-background': '#2a2a2d', '--coda-foreground': '#f2f2f4', '--coda-secondary': '#a0a0a8', '--coda-tertiary': '#6c6c72', '--coda-separator': 'rgba(255,255,255,.12)', '--coda-fill': 'rgba(255,255,255,.08)', '--coda-accent': '#4d9bff', '--coda-red': '#ff6b6b', '--coda-orange': '#ffa14a', '--coda-green': '#5fd07a', '--coda-card': '#2c2c2f', '--coda-outline': 'rgba(255,255,255,.14)', '--coda-hover': 'rgba(255,255,255,.07)', '--coda-selection': 'rgba(77,155,255,.28)' },
};
const shim = `
const THEMES = ${JSON.stringify(THEMES)}, listeners = {};
const query = new URLSearchParams(location.search), isIOS = query.get('platform') === 'ios';
const applyTheme = (kind, fontSize) => { const root = document.documentElement; root.className = (isIOS ? 'coda-ios' : 'coda-mac') + ' coda-' + kind;
  for (const [k, v] of Object.entries(THEMES[kind])) root.style.setProperty(k, v); root.style.setProperty('--coda-font-size', fontSize || (isIOS ? '17px' : '13px'));
  root.style.background = 'var(--coda-background)'; // 真实客户端也把这个底色垫在透明页面后面
  const safe = (query.get('safe') || '').split(',');
  ['top', 'right', 'bottom', 'left'].forEach((side, i) => { if (safe[i]) root.style.setProperty('--safe-' + side, safe[i] + 'px'); });
  root.style.setProperty('--coda-mono', 'ui-monospace, Menlo, monospace'); (listeners.theme || []).forEach(f => f({ kind })); };
const fire = (name, value) => (listeners[name] || []).forEach(f => f(value));
const isFile = location.pathname.endsWith('/file.html');
const key = 'harness-state:' + (isFile ? 'file:' : 'files') + (isFile ? query.get('session') + query.get('path') : '');
const startArgs = isFile ? { session: query.get('session') ?? undefined, path: query.get('path') ?? undefined } : null;
window.coda = { platform: query.get('platform') || 'mac', plugin: 'resource-manager', view: isFile ? 'file' : 'files', args: startArgs,
  postMessage: message => opened.then(() => fetch('/rpc?id=' + connection, { method: 'POST', body: JSON.stringify(message) })).then(() => undefined),
  getState: () => JSON.parse(sessionStorage.getItem(key) || 'null'),
  setState: value => { const text = JSON.stringify(value); if (text.length > 128 * 1024) throw new Error('状态超过 128 KiB'); sessionStorage.setItem(key, text); },
  copy: text => parent.postMessage({ harness: 'copy', text }, '*'),
  ...(query.get('back') === '0' ? {} : { back: titles => { (window.__backs ||= []).push(titles); parent.postMessage({ harness: 'back-declared', titles }, '*'); } }),
  toolbar: items => parent.postMessage({ harness: 'toolbar', items }, '*'),
  on: (name, fn) => { (listeners[name] ||= []).push(fn); },
  close: () => { if (parent === window) history.back(); else parent.postMessage({ harness: 'close' }, '*'); },
  open: target => { if (parent !== window) return parent.postMessage({ harness: 'open', target }, '*');
    const next = new URLSearchParams(location.search); next.set('session', target.args.session); next.set('path', target.args.path); location.href = '/view/file.html?' + next; } };
const connection = Math.random().toString(36).slice(2);
const events = new EventSource('/events?id=' + connection + '&view=' + (isFile ? 'file' : 'files') + '&args=' + encodeURIComponent(JSON.stringify(startArgs))), opened = new Promise(resolve => events.addEventListener('open', resolve));
const loaded = new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
applyTheme(new URLSearchParams(location.search).get('theme') || 'light');
addEventListener('message', event => { if (event.data?.harness === 'back') fire('back', { steps: 1 }); if (event.data?.harness === 'toolbar') fire('toolbar', { id: event.data.id }); if (event.data?.harness === 'theme') applyTheme(event.data.kind, event.data.fontSize); });
addEventListener('pagehide', () => fire('visibility', false));
events.addEventListener('msg', event => loaded.then(() => window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data) }))));`;

const control = src => `<!doctype html><meta charset=utf-8><title>harness</title>
<body style="font:13px system-ui;display:flex;gap:16px;margin:12px"><iframe id=f src="${src}" style="width:320px;height:789px;border:1px solid #888"></iframe>
<div><p id=bar></p><p id=back></p><p>
${['theme:light', 'theme:dark', 'session:A', 'session:B', 'turn:end', 'reload'].map(a => `<button onclick="ctl('${a}')">${a}</button>`).join(' ')}</p><pre id=log></pre></div>
<script>
const params = new URLSearchParams(location.search);
const base = params.get('view') === 'file' ? '/view/file.html' : '/view/index.html', fileSession = params.get('session');
const f = document.getElementById('f'), log = text => document.getElementById('log').textContent = text + '\\n' + document.getElementById('log').textContent;
let theme = 'light';
async function ctl(a) { if (a.startsWith('theme:')) { theme = a.slice(6); f.contentWindow.postMessage({ harness: 'theme', kind: theme }, '*'); }
  else if (a === 'reload') f.src = base + '?' + new URLSearchParams({ ...Object.fromEntries(params), theme, t: Date.now() }); else await fetch('/ctl?action=' + a + (fileSession ? '&session=' + fileSession : '')); }
addEventListener('message', e => { if (e.data?.harness === 'copy') log('copy: ' + e.data.text);
  if (e.data?.harness === 'open') log('open: ' + JSON.stringify(e.data.target)); if (e.data?.harness === 'close') log('close');
  if (e.data?.harness === 'back-declared') document.getElementById('back').replaceChildren(...(e.data.titles.length ? [Object.assign(document.createElement('button'), { textContent: '← ' + e.data.titles.at(-1),
    onclick: () => f.contentWindow.postMessage({ harness: 'back' }, '*') })] : []));
  if (e.data?.harness === 'toolbar') document.getElementById('bar').replaceChildren(...e.data.items.map(i => Object.assign(document.createElement('button'), { textContent: i.label + (i.on ? ' ✓' : ''),
    onclick: () => f.contentWindow.postMessage({ harness: 'toolbar', id: i.id }, '*') }))); });
</script>`;

const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css' }; // .js：view/vendor/ 下原样复制的 highlight.js 是 .js 文件，浏览器要求模块脚本是 JavaScript 类型
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body, type = 'text/plain') => { res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); res.end(body); };
  if (url.pathname === '/') {
    const file = url.searchParams.get('view') === 'file';
    return send(200, control(`${file ? '/view/file.html' : '/view/index.html'}${url.search}`), 'text/html');
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(': open\n\n'); // 让浏览器立刻收到响应头
    const view = openView((event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`), url.searchParams.get('view') ?? 'files', JSON.parse(url.searchParams.get('args') ?? 'null'));
    view.connection = url.searchParams.get('id');
    return req.on('close', () => { views.delete(view); view.handlers.close?.(); });
  }
  if (url.pathname === '/rpc') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const view = [...views].find(v => v.connection === url.searchParams.get('id'));
    await view?.handlers.message?.(JSON.parse(body));
    return send(200, '');
  }
  if (url.pathname === '/ctl') {
    const [kind, value] = url.searchParams.get('action').split(':');
    if (kind === 'session') { session = value; for (const view of views) view.handlers.context?.({ session, args: null }); }
    if (kind === 'turn') { const id = url.searchParams.get('session') || session; emit(id, 't'); setTimeout(() => emit(id, null), 50); }
    return send(200, '');
  }
  if (url.pathname === '/shim.js') return send(200, shim, 'text/javascript');
  if (url.pathname.startsWith('/view/')) {
    const file = normalize(url.pathname.slice('/view/'.length));
    if (file.startsWith('..')) return send(403, '');
    try {
      let body = await readFile(join(viewDir, file), 'utf8');
      if (file === 'index.html' || file === 'file.html') body = body.replace('<head>', '<head><script src="/shim.js"></script>');
      return send(200, body, types[extname(file)] ?? 'text/plain');
    } catch { return send(404, ''); }
  }
  send(404, '');
});
server.listen(Number(port), '127.0.0.1', () => console.log(`harness: http://127.0.0.1:${server.address().port}/`));
