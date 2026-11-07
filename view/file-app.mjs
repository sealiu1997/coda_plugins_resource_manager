// 文件视图的页面入口：读一个文件。会话和路径来自 coda.args（启动值），之后的变化走 context 事件；
// 连接在 connection.mjs，预览在 preview.mjs，这里不创建目录树。设计见 docs/design/phase-2.md 第 7 节。
// Mac 的独立窗口里选中文字右键可以添加到聊天（第 13.7 节）；iPhone 不接，用系统的选区菜单。
// iPhone 点文件在资源页里预览（第 16 节），不再进这个视图；别的入口仍可能在 iPhone 上打开它：没有工具条，靠系统返回离开。
import { paintBar } from './bar.mjs';
import { createChat } from './chat.mjs';
import { connect } from './connection.mjs';
import { mountHint } from './hint.mjs';
import { mountMenu } from './menu.mjs';
import { noticeText } from './model.mjs';
import { showNotice } from './notice.mjs';
import { mountPreview } from './preview.mjs';
import { mountPress } from './press.mjs';
import { RootState } from './protocol.mjs';

const coda = window.coda;
const $ = id => document.getElementById(id);
const quiet = fn => { try { return fn(); } catch { return undefined; } };
const hasToolbar = typeof coda.toolbar === 'function' && coda.platform === 'mac';
const isIOS = coda.platform === 'ios';

// 参数里的会话和路径，形状不对按没有处理。
const argsOf = args => ({
  session: typeof args?.session === 'string' && args.session !== '' ? args.session : null,
  path: typeof args?.path === 'string' && args.path !== '' ? args.path : null,
});
const num = n => (Number.isFinite(n) && n >= 0 ? n : 0);
// 读回来的值可能是别的版本或坏的，只认自己的形状。
const parseScroll = raw => (raw?.v === 1 ? { top: num(raw.top), left: num(raw.left) } : null);

let want = argsOf(coda.args); // 这个视图要看的会话和文件
let session; // 模块现在跟随的会话；undefined 表示还没收到 session
let root = null;
// 等内容到了再用一次的滚动位置。预览收起时也存在这里，恢复后接着用。
let restore = parseScroll(quiet(() => coda.getState()));

const conn = connect(coda, { handlers: { session: onSession, root: onRoot, changed: onChanged }, onStatus: () => schedule() });
const hint = mountHint($('hint'));
const menu = mountMenu($('menu'));
mountPress({ consumed: menu.consumed }); // 按下反馈：刷新、复制、重试等按钮同资源页（第 17.3 节）
const chat = createChat({ link: conn.link, copy: text => coda.copy(text), hint });
const preview = mountPreview($('preview'), {
  read: (path, offset) => conn.link.call('read', { path, offset }), copy: text => coda.copy(text),
  selectionMenu: isIOS ? null : (event, selection) => menu.open(event, { items: chat.selectionItems(selection) }),
});

// 模块跟随的会话和启动参数里的不是同一个时（换会话的两条消息没有先后保证），不能读，等对上。
const ready = () => want.path !== null && session === want.session && root?.state === RootState.READY;

// ---- 渲染：同一批变化合并成一次 ----
let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; render(); });
}

function render() {
  const open = ready();
  $('preview').classList.toggle('off', !open);
  $('preview').inert = !open;
  $('notice').classList.toggle('off', open);
  $('notice').inert = open;
  if (open) {
    if (preview.path !== want.path) openPreview();
  } else {
    park();
    preview.close();
    paintNotice();
  }
}

function openPreview() {
  const { path } = want, scroll = restore;
  // 没有要恢复的位置就明确从头开始，不靠清空正文后滚动条自己归零。
  // 位置真正用上才清；读取被刷新、重载作废时，预览自己让接替的那次读取接着用。
  preview.open(path, scroll ?? { top: 0, left: 0 }).then(used => { if (used && preview.path === path && restore === scroll) restore = null; });
}

// 预览收起前记下滚动位置，恢复后接着用；内容还没到时 restore 还没用掉，不覆盖。
function park() {
  if (preview.path !== null && restore === null) restore = preview.scroll();
}

// 说明区只在内容变了才重画，免得重试按钮在点击中途被换掉。
let noticeKey = null;
function paintNotice() {
  const failed = conn.failure !== null && !root;
  const key = want.path === null ? '没有指定要打开的文件。'
    : failed ? `hello:${conn.failure}`
      : noticeText(session === want.session ? root : null, session);
  if (key === noticeKey) return;
  noticeKey = key;
  showNotice($('notice'), failed && want.path !== null ? { failure: conn.failure, retry: conn.hello } : { text: key, glyph: 'doc' });
}

// ---- 模块的消息（代次和握手由 connection 处理）----
function onSession(data) {
  park();
  preview.close();
  menu.hide();
  hint.hide();
  session = data.session ?? null;
  root = null;
  schedule();
}

function onRoot(data) {
  const before = root;
  if (data.state !== before?.state || data.path !== before?.path) menu.hide(); // 选区和行号是旧内容上的
  root = { state: data.state, path: data.path };
  if (data.state === RootState.READY) {
    if (before?.path !== data.path) preview.reload(); else preview.refresh();
  }
  schedule();
}

function onChanged() {
  if (root?.state !== RootState.READY) return;
  menu.hide(); // 内容可能变了，开着的选区菜单里的选区和行号作废
  preview.refresh();
}

// ---- 参数变了：换文件或换会话，旧文件的滚动位置不带过去 ----
quiet(() => coda.on('context', ({ args }) => {
  const next = argsOf(args);
  if (next.path !== want.path || next.session !== want.session) { restore = null; preview.close(); menu.hide(); hint.hide(); }
  want = next;
  schedule();
}));

// ---- 工具条：Mac 用 coda.toolbar；iPhone 没有；其他（harness）退成页内一条 ----
const refresh = () => { conn.refresh(); preview.refresh(); };
const items = [{ id: 'refresh', label: '刷新', icon: 'arrow.clockwise', kind: 'button' }];
if (hasToolbar) {
  quiet(() => coda.toolbar(items));
  quiet(() => coda.on('toolbar', ({ id }) => { if (id === 'refresh') refresh(); }));
} else if (!isIOS) paintBar($('bar'), items, refresh);

// ---- 阅读位置：setState 按视图和 args 隔离，每个文件自然分开 ----
let saveTimer = null;
function queueSave() {
  if (saveTimer === null) saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const at = restore ?? (preview.path !== null ? preview.scroll() : null);
  if (at) quiet(() => coda.setState({ v: 1, top: at.top, left: at.left }));
}
// visibility: false 之后只保证同步事件处理完，所以同步保存。
quiet(() => coda.on('visibility', visible => { if (!visible) saveNow(); }));
preview.onScroll(queueSave);
preview.onScroll(menu.hide);

render();
conn.hello();
