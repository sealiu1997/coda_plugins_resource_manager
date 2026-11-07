// 资源管理器的页面入口：消息收发、状态保留、工具栏和「更多」菜单、图标视图的进入和返回。状态在 model.mjs，渲染在 tree.mjs、grid.mjs、preview.mjs 和 info.mjs，菜单和提示在 menu.mjs 和 hint.mjs，滚动位置的恢复在 restore.mjs。
import { EXIT, paintBar } from './bar.mjs';
import { createChat } from './chat.mjs';
import { connect } from './connection.mjs';
import { infoText, sortName } from './format.mjs';
import { mountGrid } from './grid.mjs';
import { mountHint } from './hint.mjs';
import { mountInfo } from './info.mjs';
import { mountMenu } from './menu.mjs';
import { Model, STATE_LIMIT, View, noticeText, parseState, putSession, trimState } from './model.mjs';
import { showNotice } from './notice.mjs';
import { mountPreview } from './preview.mjs';
import { mountPress, onMotionChange, reducedMotion } from './press.mjs';
import { EntryKind, RootState, SortKey, Type } from './protocol.mjs';
import { createRestore, createTrail } from './restore.mjs';
import { browseAction, previewAction } from './keys.mjs';
import { mountTree, rootName } from './tree.mjs';

const coda = window.coda;
const $ = id => document.getElementById(id);
const quiet = fn => { try { return fn(); } catch { return undefined; } };
const hasToolbar = typeof coda.toolbar === 'function' && coda.platform === 'mac';
// 两端都在资源页里打开文件、切到预览（第 16 节）：iPhone 轻点打开、系统返回关掉，Mac 照 Finder 单击选中、双击打开，键盘接在目录树和图标视图的滚动容器上。
const isIOS = coda.platform === 'ios';

let persisted = parseState(quiet(() => coda.getState()));
// 恢复出来的预览滚动位置，等内容到了再用一次；path 是它属于的文件，opened 不是它了就作废。目录树和图标视图的在 restore 里。
let pending = { preview: null, path: null };

const conn = connect(coda, { handlers: { session: onSession, root: onRoot, changed: onChanged }, onStatus: () => schedule() });
const model = new Model({ link: conn.link, onChange: () => schedule(), onLost: () => hint.show('文件夹已不存在', { warn: false }) });
model.showHidden = persisted.hidden;
model.sort = persisted.sort;
model.view = persisted.view;
const hint = mountHint($('hint'));
const menu = mountMenu($('menu'), $('submenu'), { flyout: !isIOS, animate: isIOS }); // Mac 的二级菜单在左边弹出，iPhone 在菜单里切到下一层，菜单出现时有动画
// 按下反馈：页面里只有一份（press.mjs）；菜单开着时点外面的那一下已被菜单消费，不加反馈、不选中。
const press = mountPress({ identity: () => `${model.session}\n${model.scope}`, consumed: menu.consumed });
const chat = createChat({ link: conn.link, copy: text => coda.copy(text), hint });
// 属性页和图标视图的上一层：iPhone 用原生返回（coda.back）；Mac 的客户端会替声明了返回的页面画一个带小箭头的导航，
// 和侧栏标题重复，所以 Mac 和没有 coda.back 的环境一样，头部最左边自己放返回。
const nativeBack = isIOS && typeof coda.back === 'function';
const tree = mountTree($('tree'), model, {
  open: openFile,
  toggle: path => model.toggle(path),
  more: path => model.loadMore(path),
  retry: path => model.retry(path),
  menu: (event, row) => pathMenu(event, row),
  select: isIOS ? null : path => mouseSelect(path),
}, { draggable: !isIOS, longPress: isIOS, keyboard: !isIOS, press, consumed: menu.consumed });
const grid = mountGrid($('grid'), model, {
  open: openFile,
  enter: path => enterDir(path),
  more: path => model.loadMore(path),
  retry: path => model.retry(path),
  menu: (event, cell) => pathMenu(event, cell),
  back: nativeBack ? null : () => leaveDir(),
  select: isIOS ? null : path => mouseSelect(path),
}, { draggable: !isIOS, longPress: isIOS, keyboard: !isIOS, press, consumed: menu.consumed });
const restore = createRestore(model, { tree, grid });
const trail = createTrail();
const preview = mountPreview($('preview'), {
  read: (path, offset) => conn.link.call('read', { path, offset }), copy: text => coda.copy(text),
  // iPhone 预览头部右边的 ⋯（刷新、复制路径）：顶部工具条在预览时只有「返回」，只留头部一行标题
  actions: isIOS ? [{ label: '更多', icon: 'ellipsis', run: (_, button) => toggleMore(button) }] : [{ label: '窗口', icon: 'window', run: openInView }], copyInHead: !isIOS,
  back: isIOS ? null : closePreview,
  // 选中文字的右键菜单只有 Mac：iPhone 用系统的选区菜单。
  selectionMenu: isIOS ? null : (event, selection) => menu.open(event, { items: chat.selectionItems(selection) }),
});
// 属性页：页内一层。
let infoOpen = false;
let dataRound = 0; // 数据轮次：每收到一次 changed 加一，属性页用它判断文件夹的统计结果是不是上一轮的
const info = mountInfo($('info'), {
  stat: path => conn.link.call(Type.STAT, { path }),
  size: (path, signal) => conn.link.call(Type.DIR_SIZE, { path }, { signal, cancel: Type.DIR_SIZE_CANCEL }),
  rootPath: () => model.root?.path ?? '',
  round: () => dataRound,
  back: nativeBack ? null : () => { backPressed = true; closeInfo(); },
});

// ---- 在独立视图里打开：Mac 预览头部的「窗口」 ----
// 会话 ID 放进 args：被打开的视图 context.session 是 null。失败（含同步抛出）在原地提示。
// epoch 每换一次会话加一：旧会话的 open 结果回来时已经作废，不碰新会话的提示。
let epoch = 0;
function openInView(path) {
  const mine = epoch;
  return Promise.resolve().then(() => coda.open({ view: 'file', args: { session: model.session, path } }))
    .then(() => { if (mine === epoch) hint.hide(); }, error => {
      if (mine === epoch) hint.show(`打不开文件：${error?.message ?? '未知原因'}`);
    });
}
// 两端都在页内打开：model.openFile 设 selected 和 opened，经 onChange 切到预览。iPhone 触屏没有键盘焦点，不交焦点；
// 快速两次轻点：第一次已切到预览，目录树 .off 不接指针事件，第二次落不到条目上。
function openFile(path) {
  openPressed = !isIOS; // 用户在 Mac 上打开的：render 把焦点交给预览面板
  note({ kind: 'push', from: mode(), to: 'preview' });
  model.openFile(path);
}

// ---- 渲染：同一批变化合并成一次 ----
let queued = false;
function schedule() {
  queueSave();
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; render(); });
}

// 选中：页面里唯一的入口（单击、取消选中、键盘移动、回上一层）。只改 model.selected 和现有节点上的 .sel，不重画，也不经 onChange；保存自己排。
function selectEntry(path) {
  if (!model.select(path)) return;
  (model.view === View.ICONS ? grid : tree).select();
  queueSave();
}
const browser = () => (model.view === View.ICONS ? grid : tree);
// Mac 在按下时选中（选中条目或在空白处取消）：和键盘一样算用户接管，这个视图还在等的滚动恢复作废，免得恢复到达时把刚选中的条目滚走。
function mouseSelect(path) {
  restore.drop(model.view === View.ICONS ? 'grid' : 'tree');
  selectEntry(path);
}

// 预览头部的返回和预览里的 ⌘↑ 是同一个动作：opened 清掉，selected 留着。
function closePreview() {
  backPressed = true;
  model.closeFile();
}
// 用户点了预览头部的返回：render 据此决定焦点要不要交给浏览区，别的模式变化不动焦点。
let backPressed = false;
let openPressed = false; // 用户打开了文件：同返回对称，页面持有焦点时 render 把焦点交给预览面板
const mode = () => (infoOpen ? 'info' : !model.ready ? 'notice' : model.opened !== null ? 'preview' : model.view === View.ICONS ? 'grid' : 'tree');

// 说明区只在内容变了才重画，免得重试按钮在点击中途被换掉。
let noticeKey = null;
function paintNotice() {
  const failed = conn.failure !== null && !model.root;
  const key = failed ? `hello:${conn.failure}` : noticeText(model.root, model.session);
  if (key === noticeKey) return;
  noticeKey = key;
  showNotice($('notice'), failed ? { failure: conn.failure, retry: conn.hello } : { text: key });
}

// ---- iPhone 层级切换的过渡（第 17.6 节）----
// 只在用户操作引起时做：入口（openFile、openInfo、goBack、enterDir、leaveDir）在改模型之前记一个一次性的「过渡意图」，render 消费它：
// 前后对得上就播，对不上就丢掉。换会话、换根目录、恢复、notice、changed 的刷新都没有意图，不播。意图由最外层的入口记，goBack 内部调用的 closeInfo、leaveDir 不记。
// 层级的深浅：浏览区（tree、grid）浅，预览和属性页深。深的一层永远在上：打开时滑入盖住浅层，返回时滑出、露出浅层。
const PANES = ['tree', 'grid', 'preview', 'notice', 'info'];
const DEEP = new Set(['preview', 'info']);
const SLIDE_MS = 280, FADE_IN_MS = 150;
let intent = null; // { kind: 'push' | 'pop' | 'fade', from?, to }：from、to 是模式；fade 的 to 是目标 cwd
let lastMode = null; // 上一次画出的模式
let running = null; // 正在播的过渡：{ leaving, after, end }
const note = next => { if (isIOS) intent = next; };

// 结束正在播的过渡到终点，立刻。结束和自然播完走同一个函数，幂等：强制结束之后迟到的 finish 事件什么都不做。
function endRunning() { running?.end(); }
function begin(anims, { ids = [], leaving = null, after = [] } = {}) {
  let ended = false, pending = anims.length;
  const slides = ids.length > 0; // 滑动期间整页不响应点按（同 iOS 原生的导航切换）；目录淡入不算
  if (slides) document.documentElement?.classList.add('moving');
  const mine = running = { leaving, after, end() {
    if (ended) return;
    ended = true;
    if (slides) document.documentElement?.classList.remove('moving');
    for (const anim of anims) anim.cancel();
    for (const id of ids) $(id).classList.remove('layer');
    if (running === mine) running = null;
    for (const fn of mine.after) fn();
    applyPanes(mode());
  } };
  // 浏览器自己取消一条动画时只触发 cancel、不触发 finish：任一动画取消都结束整次过渡（end 幂等，它自己 cancel 引出的 oncancel 回来什么都不做）。
  for (const anim of anims) { anim.onfinish = () => { if (--pending === 0) mine.end(); }; anim.oncancel = () => mine.end(); }
  return mine;
}

// 面板的可见和可操作：只有当前的一层能操作；离开的那一层在退场期间还看得见，但 inert 且不接指针。
function applyPanes(current) {
  const leaving = running?.leaving ?? null;
  for (const id of PANES) {
    $(id).classList.toggle('off', current !== id && leaving !== id);
    $(id).classList.toggle('leaving', leaving === id);
    $(id).inert = current !== id;
  }
}

// 这次 render 要不要播层级切换：消费意图。fade 要等内容到了，不在这里。
function takeSlide(current) {
  const taken = intent;
  if (!taken || taken.kind === 'fade') return null;
  intent = null;
  if (!isIOS || reducedMotion() || taken.from !== lastMode || taken.to !== current || lastMode === current) return null;
  if (DEEP.has(taken.from) === DEEP.has(taken.to) || typeof $(current).animate !== 'function') return null;
  return taken;
}

function slide({ kind, from, to }, after) {
  const leaving = $(from), entering = $(to), deep = kind === 'push' ? entering : leaving, shallow = kind === 'push' ? leaving : entering;
  const options = { duration: SLIDE_MS, easing: 'cubic-bezier(.2,.8,.2,1)' };
  const shift = kind === 'push' ? ['translateX(0)', 'translateX(-25%)'] : ['translateX(-25%)', 'translateX(0)'];
  const dim = kind === 'push' ? ['brightness(1)', 'brightness(.9)'] : ['brightness(.9)', 'brightness(1)'];
  const away = ['translateX(100%)', 'translateX(0)'];
  // 参与过渡的两层都要不透明，否则透出对面（只在过渡期间）；变暗不加遮罩元素，不挡指针。
  leaving.classList.add('layer');
  entering.classList.add('layer');
  begin([
    deep.animate({ transform: kind === 'push' ? away : [...away].reverse() }, options),
    shallow.animate({ transform: shift, filter: dim }, options),
  ], { ids: [from, to], leaving: from, after });
}

// 图标视图进出目录：内容到了才播，只给内容播，不给「正在读取」播。
function takeFade(current) {
  if (intent?.kind !== 'fade') return;
  if (current !== 'grid' || model.cwd !== intent.to) { intent = null; return; } // 中途换了目录、或打开了文件：作废
  const state = model.dirs.get(model.cwd);
  if (!state || !(state.loaded || state.error)) return; // 还在读取：意图留着，内容到了的那次 render 播
  intent = null;
  if (reducedMotion()) return;
  const anim = grid.fadeIn(FADE_IN_MS);
  if (anim) { endRunning(); begin([anim]); }
}

// 属性页是逻辑上关了但画面还在（退场期间）：render 决定什么时候释放。
let infoStopped = false;

function render() {
  const current = mode();
  const refocus = backPressed && document.hasFocus(), handoff = openPressed && document.hasFocus();
  backPressed = openPressed = false;
  const slideIn = takeSlide(current);
  if (current === 'notice') paintNotice();
  const browsing = current === 'tree' || current === 'grid';
  (model.view === View.ICONS ? grid : tree).render(); // 只画正在用的视图，另一个留着它的内容和滚动位置
  landed();
  restore.settle();
  // 待恢复的位置只属于它那个文件：opened 清了或换成别的文件，位置作废。
  if (pending.preview !== null && pending.path !== model.opened) pending.preview = null;
  const released = []; // 这次停止的面板：画面的释放等退场结束（有过渡时），否则马上
  if (current === 'preview' && preview.path !== model.opened) {
    // 位置要等内容到了、真的设上才清：之前离开页面或换会话，saveNow 还存它。作废的读取不清，由接替它的读取用上。
    const scroll = pending.preview;
    preview.open(model.opened, scroll).then(used => { if (used && scroll !== null && pending.preview === scroll) pending.preview = null; });
  } else if ((browsing || current === 'notice') && preview.path !== null) { preview.stop(); released.push(() => preview.release()); } // 属性页和预览一样只切可见性，不动别的面板的内容
  if (infoStopped && current !== 'info') { infoStopped = false; released.push(() => info.release()); }
  // 上一个过渡：模式变了或又有新的过渡就立刻结束到终点（它的释放比对打开次数，又打开过就不释放）。
  if (running && (slideIn || current !== lastMode)) endRunning();
  if (slideIn) slide(slideIn, slideIn.kind === 'pop' ? released.splice(0) : []); // 返回：被停止的那层到退场结束才释放
  for (const fn of released) fn();
  applyPanes(current);
  takeFade(current);
  lastMode = current;
  // 返回按钮随预览一起 inert，焦点会掉到页面外：用户刚点了返回、页面又持有焦点时交给目录树或网格。
  // 后台刷新、切会话、root 变化造成的切换不动焦点，免得抢走客户端输入框的焦点。
  if (refocus && browsing) browser().focus();
  // 打开时浏览区变 inert，焦点本来就会掉：交给预览面板，⌘↑ 才收得到。
  if (handoff && current === 'preview') $('preview').focus();
  syncToolbar();
  declareBack();
}
// 窗口尺寸变了（旋转）、系统的减弱动态效果改了：正在播的动画结束到终点。
window.addEventListener('resize', endRunning);
onMotionChange(endRunning);

// ---- 工具栏：Mac 用 coda.toolbar，没有的（iOS、harness）退成页内一条 ----
// Mac 只有一个原生按钮「更多」：原生菜单带向下的箭头，关不掉，所以按下后由页面弹菜单。返回键在预览头部，不在这里。
// 属性页上排序、刷新、显示隐藏文件都没有意义：工具栏不放任何项，退出属性页后恢复。
const toolbarItems = () => infoOpen ? [] : hasToolbar
  ? [{ id: 'more', label: '更多', icon: 'ellipsis', kind: 'button' }]
  : [
    { id: 'refresh', label: '刷新', icon: 'arrow.clockwise', kind: 'button' },
    { id: 'hidden', label: '显示隐藏文件', icon: 'eye', kind: 'toggle', on: model.showHidden },
  ];
// iPhone 树页顶部：返回（仅横屏）、根目录名、⋯。刷新、显示隐藏文件和排序都在 ⋯ 的菜单里。
// 预览时和属性页一样只留返回（竖屏整条不显示）：标题和 ⋯ 在预览头部，⋯ 里只有刷新和复制路径。
// 属性页上只留返回：竖屏有原生导航栏，整条工具条不显示；横屏导航栏隐藏，页面自己给返回（显示与否都由 style.css 的横屏媒体查询决定）。
const MORE = { id: 'more', label: '更多', kind: 'button', glyph: 'ellipsis', iconOnly: true, menu: true };
const phoneItems = () => infoOpen || mode() === 'preview' ? [EXIT] : [EXIT, { kind: 'title', label: model.ready ? dirTitle() : '' }, MORE];
// 比较键就是要画的项：根目录名变了（换会话）工具条跟着重画。
let lastItems = '';
function syncToolbar() {
  const items = isIOS ? phoneItems() : toolbarItems(), key = JSON.stringify(items);
  if (key === lastItems) return;
  lastItems = key;
  if (hasToolbar) return quiet(() => coda.toolbar(items));
  menu.hide(); // 重画会换掉 ⋯ 按钮，开着的菜单认不得新按钮
  paintBar($('bar'), items, act);
  $('bar').hidden = items.length === 0; // 没有项（Mac 属性页上的页内工具条）就整条不显示
  $('bar').classList.toggle('exit-only', items.length === 1 && items[0].id === EXIT.id); // 只有返回的工具条跟着返回走：竖屏整条不显示
}

// 原生按钮没有 DOM 元素可以当锚点：用一个固定在页面右上角的假锚点，同时也是「谁打开的菜单」的标记。
const TOOLBAR = { getBoundingClientRect: () => ({ right: window.innerWidth, bottom: 0 }) };
// 「更多」菜单的内容只写这一处，iPhone 的 ⋯ 和 Mac 的原生按钮共用：刷新、显示隐藏文件、「显示」›；「显示」里是视图和排序，当前项有对勾。
const moreMenu = () => isIOS && mode() === 'preview' ? { items: [
  { label: '刷新', run: () => act('refresh') },
  { label: '复制路径', run: () => preview.copyPath() }, // 相对路径
] } : ({ items: [
  { label: '刷新', run: () => act('refresh') },
  { label: '显示隐藏文件', checked: model.showHidden, run: () => act('hidden') },
  { label: '显示', submenu: { items: [
    { heading: '视图' },
    { label: '列表', checked: model.view === View.LIST, radio: true, run: () => changeView(View.LIST) },
    { label: '图标', checked: model.view === View.ICONS, radio: true, run: () => changeView(View.ICONS) },
    { separator: true },
    { heading: '排序' },
    ...Object.values(SortKey).map(key => ({ label: sortName(key), checked: key === model.sort, radio: true, run: () => changeSort(key) })),
  ] } },
] });

// 显示的条目或顺序变了、或者换了根目录：旧的滚动位置对不上，待恢复的和上层的记录作废，两种视图都回到顶部。换排序、显示隐藏文件、换根目录都走这里。
function invalidateScroll() {
  restore.clear();
  trail.clear();
  tree.scrollTo(0);
  grid.scrollTo(0);
}

// 换排序：全局的，存进 persisted。选当前项什么都不做。
function changeSort(sort) {
  const before = model.sort;
  model.setSort(sort);
  if (model.sort === before) return; // 同值：什么都没换
  persisted.sort = model.sort;
  invalidateScroll();
}

// 换视图：全局一份，存进 persisted；两种视图各留着自己的内容和滚动位置，换回来还在。
// 「显示」菜单调用它。
function changeView(view) {
  const before = model.view;
  model.setView(view);
  if (model.view === before) return;
  persisted.view = model.view;
  menu.hide();
  declareBack();
  schedule();
}

// 键盘激活没有 pointerdown，菜单外点击那条规则不管用：同一个按钮再次激活就关闭。
function toggleMore(button) {
  if (!menu.hidden && menu.opener === button) menu.hide();
  else menu.open(button, moreMenu());
}

function act(id, button) {
  // 横屏时导航栏隐藏，原生返回看不到：这里的「返回」和原生返回走同一个退层逻辑，在根层才关视图。
  if (id === EXIT.id) { if (goBack(1)) backPressed = true; else quiet(() => coda.close()); }
  else if (id === 'more') {
    toggleMore(button);
  }
  else if (id === 'hidden') {
    model.setShowHidden(!model.showHidden);
    persisted.hidden = model.showHidden;
    invalidateScroll(); // 不管在哪种视图切换：显示的条目变了，两种视图的旧位置都对不上
  }
  else if (id === 'refresh') {
    conn.refresh();
    model.refresh();
    preview.refresh();
  }
}
// 原生按钮的事件是 { id }：只认 more，别的什么都不做。
quiet(() => coda.on('toolbar', event => { if (event?.id === 'more' && !infoOpen) act('more', TOOLBAR); })); // 属性页上原生按钮已撤掉，迟到的事件不弹菜单

// ---- 状态保留 ----
let saveTimer = null;
function queueSave() {
  if (model.session && saveTimer === null) saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const { session } = model;
  if (!session) return;
  const top = preview.scroll();
  putSession(persisted, session, {
    ...model.snapshot(),
    // 还没恢复的位置先存它，别存成还没滚过去的 0。
    scroll: { tree: restore.top('tree') ?? tree.scroll(), top: pending.preview?.top ?? top.top, left: pending.preview?.left ?? top.left, sort: model.sort,
      grid: restore.top('grid') ?? grid.scroll(), gridSort: model.sort },
  });
  persisted = trimState(persisted, session);
  // setState 超限会同步抛错：再收紧一次，仍失败就放弃这次，不影响界面。
  if (quiet(() => (coda.setState(persisted), true)) === undefined) quiet(() => coda.setState(trimState(persisted, session, STATE_LIMIT / 4)));
}
quiet(() => coda.on('visibility', visible => { if (!visible) { press.reset(); saveNow(); } }));
$('tree').addEventListener('scroll', queueSave, { passive: true });
$('tree').addEventListener('scroll', () => restore.scrolled('tree'), { passive: true });
grid.onScroll(queueSave);
grid.onScroll(() => restore.scrolled('grid'));
preview.onScroll(queueSave);
preview.onScroll(menu.hide);

// ---- 行菜单：Mac 右键、iPhone 长按；iPhone 的 ⋯ 和 Mac 的原生「更多」出刷新、显示隐藏文件和「显示」（视图、排序）（菜单本身在 menu.mjs）----
// 行菜单顶上是路径，下面一行 大小 · 完整修改时间（文件夹只有修改时间，读不到就没有这一行）；指向外面的链接和不能打开的条目没有元数据，不显示这一行。
// 不能打开的条目（指向外面或失效的链接、other）没有「添加到聊天」，和不能拖动一致；它们仍有复制路径和属性。
function pathMenu(event, row) {
  press.reset(); // 长按弹出菜单：按下反馈立即去掉
  const dead = row.kind === EntryKind.LINK || row.kind === EntryKind.OTHER;
  // Mac 的第一项和双击是同一个动作（右键不改选中）；文件夹在列表里写展开或收起，别的写打开。iPhone 轻点就是打开，菜单不变。
  const folder = row.kind === EntryKind.DIR, listed = model.view !== View.ICONS;
  const open = isIOS || dead ? [] : [{ label: folder && listed ? (row.open ? '收起' : '展开') : '打开', run: () => browser().activate(row) }, { separator: true }];
  menu.open(event, { title: row.path, detail: dead ? undefined : infoText(row) || undefined, items: [
    ...open,
    ...(dead ? [] : [{ label: '添加到聊天', run: () => chat.add(row.path) }]),
    { label: '复制相对路径', run: () => coda.copy(row.path) },
    { label: '复制绝对路径', run: () => coda.copy(`${model.root.path}/${row.path}`) },
    { separator: true },
    { label: '属性', run: () => openInfo(row) },
  ] });
}
$('tree').addEventListener('scroll', menu.hide, { passive: true });
grid.onScroll(menu.hide);

// ---- 键盘（Mac）----
// 两个作用域各管各的，匹配的键同步 preventDefault，不匹配的不拦；菜单开着不处理，两处都不主动抢焦点。
// 浏览区：按了键就算用户自己动了，作废这个视图还在等的滚动恢复，即使这次不用滚动；⌘↑ 只有图标视图有（回上一层，同头部的返回），根目录什么都不做。
function browseKey(event) {
  if (isIOS || !menu.hidden) return;
  const action = browseAction(event), icons = model.view === View.ICONS;
  if (!action || (action === 'parent' && !icons)) return;
  event.preventDefault();
  restore.drop(icons ? 'grid' : 'tree');
  if (action === 'open') browser().openSelected();
  else if (action === 'parent') leaveDir();
  else browser().key(action);
}
tree.onKey(browseKey);
grid.onKey(browseKey);
// 侧栏预览：只有 ⌘↑，返回。焦点要在面板里才收得到（点正文、打开时交接）。
$('preview').addEventListener('keydown', event => {
  if (isIOS || infoOpen || !menu.hidden || !previewAction(event)) return;
  event.preventDefault();
  closePreview();
});

// ---- 图标视图的进入和返回 ----
// 进入子目录滚到顶部，先记下上层的位置；回上一层恢复进去之前的位置（记录在内存里，页面卸载后没有，回到顶部）。
// shownCwd：页面已经处理过的 cwd；它被模型自己换掉（目录没了退到上一层、根目录变了回到根目录）时，在 landed 里补上滚动。
let shownCwd = '';
function enterDir(path) {
  trail.remember(model.cwd, grid.scroll());
  selectEntry(null); // 进入新的一层：选中清空
  model.enter(path);
  note({ kind: 'fade', to: model.cwd });
  shownCwd = model.cwd;
  restore.drop('grid');
  grid.scrollTo(0);
  declareBack();
}
// 退 levels 层（到根为止）；已经在根目录返回 false。record 为假时不记过渡意图（goBack 里的内部调用：意图由它记）。
function leaveDir(levels = 1, record = true) {
  if (model.cwd === '') return false;
  const from = model.cwd.split('/');
  model.leave(levels);
  if (record) note({ kind: 'fade', to: model.cwd });
  land(trail.take(model.cwd) ?? 0);
  // 选中来时经过的那个文件夹（退到的那一层的直接子项）。目录被删、模型自己退回上层走 landed，不改选中。
  selectEntry(from.slice(0, model.cwd === '' ? 1 : model.cwd.split('/').length + 1).join('/'));
  declareBack();
  return true;
}
function land(top) {
  shownCwd = model.cwd;
  grid.scrollTo(0); // 先回到顶部：之后的滚动都是内容变化或用户滚的，恢复据此判断用户有没有动过
  restore.plan('grid', top);
}
// 落到哪一层就用哪一层的位置，失效目录待恢复的位置作废。
function landed() {
  if (model.cwd !== shownCwd) land(trail.take(model.cwd) ?? 0);
}

// ---- 上一层：iPhone 用原生返回，路径只在这里声明 ----
// 路径是上层的标题，由远到近，不含当前页：图标视图在 a/b 是 [根目录名, 'a']；列表视图没有。属性页、预览各多一层当前页（要回到的那一页）：列表视图是 '资源管理器'，图标视图是当前目录名。
// 预览开着是 opened 不为空、且根目录就绪；没就绪时页面是说明区，路径为空。
// 标题是当前目录名：根目录是根目录名。
const dirTitle = () => (model.cwd === '' || model.view !== View.ICONS ? rootName(model.root.path) : model.cwd.slice(model.cwd.lastIndexOf('/') + 1));
const previewOpen = () => model.ready && model.opened !== null;
function backPath() {
  const icons = model.view === View.ICONS && model.ready;
  const upper = icons && model.cwd !== '' ? [rootName(model.root.path), ...model.cwd.split('/').slice(0, -1)] : [];
  const here = icons ? dirTitle() : '资源管理器';
  return [...upper, ...(infoOpen ? [here] : []), ...(previewOpen() ? [here] : [])];
}
let declared = [];
// 路径没变不重复声明；force：客户端已经退了一层，路径没变也要重新告诉它现在在哪。
function declareBack(force = false) {
  if (!nativeBack) return;
  const path = backPath();
  if (!force && JSON.stringify(path) === JSON.stringify(declared)) return;
  declared = path;
  quiet(() => coda.back(path));
}
// 退 steps 层：先关预览，再关属性页，再退图标视图的目录；返回是不是真的退了。横屏的返回和原生返回共用。
// 没就绪时页面是说明区，看不见预览和目录层：不消耗它们（保存的 opened、cwd 不变），横屏的返回直接关视图。
// 一次返回只记一个意图，按它消耗了什么：关了预览或属性页记 pop（目标是退完之后的模式），只退了目录记 fade；内部调用的 closeInfo、leaveDir 不记。
function goBack(steps) {
  if (!model.ready) return false;
  const from = mode();
  let used = 0, layer = false;
  if (previewOpen() && steps > used) { model.closeFile(); used++; layer = true; } // 走和 Mac 一样的 closeFile：opened 清，selected 留着
  if (infoOpen && steps > used) { closeInfo(false); used++; layer = true; }
  const levels = Math.min(steps - used, model.view === View.ICONS && model.cwd !== '' ? model.cwd.split('/').length : 0);
  if (levels > 0) { leaveDir(levels, false); used += levels; }
  if (used > 0) note(layer ? { kind: 'pop', from, to: mode() } : { kind: 'fade', to: model.cwd });
  return used > 0;
}
if (nativeBack) quiet(() => coda.on('back', event => {
  if (!goBack(Number.isInteger(event?.steps) && event.steps > 0 ? event.steps : 1)) declareBack(true); // 已经在最上层：重新声明一次
}));

// ---- 属性页：所有关闭的路径（原生返回、横屏的返回、换会话、根目录变化）都重新声明回上层 ----
function openInfo(row) {
  note({ kind: 'push', from: mode(), to: 'info' });
  infoOpen = true;
  infoStopped = false;
  info.open(row.path, row);
  declareBack();
  schedule();
}
// 停止是立即的（取消统计、作废在途的读取）；画面留到退场结束，由 render 释放。换会话、换根目录要立即释放（immediate），也不记意图。
function closeInfo(record = true, immediate = false) {
  if (!infoOpen) return;
  infoOpen = false;
  if (immediate) info.close();
  else { info.stop(); infoStopped = true; } // 在统计的一并取消
  if (record) note({ kind: 'pop', from: 'info', to: mode() });
  declareBack();
  schedule();
}

// ---- 模块的消息（代次和握手由 connection 处理）----
function onSession(data) {
  saveNow(); // 先存旧会话
  intent = null;
  endRunning();
  press.reset();
  preview.close();
  closeInfo(false, true);
  menu.hide();
  tree.reset();
  grid.reset();
  epoch++;
  hint.hide();
  const saved = persisted.sessions[data.session] ?? null;
  pending = saved?.opened ? { preview: { top: saved.scroll.top, left: saved.scroll.left }, path: saved.opened } : { preview: null, path: null };
  model.receive(data, saved);
  trail.clear();
  restore.clear();
  // 两种视图的滚动位置各按当时的排序存；排序是全局的，在别的会话换过就对不上，等内容到了回到顶部。恢复绑定这个会话、根目录、排序和目录。
  tree.scrollTo(0);
  restore.plan('tree', saved && saved.scroll.sort === model.sort ? saved.scroll.tree : 0);
  shownCwd = model.cwd;
  land(saved && saved.scroll.gridSort === model.sort ? saved.scroll.grid : 0);
}

function onRoot(data) {
  const before = model.root;
  if (data.state !== before?.state || data.path !== before?.path) { menu.hide(); intent = null; endRunning(); } // 开着的菜单里的路径是旧根目录下的；换根目录不播过渡
  if (data.state !== RootState.READY || before?.path !== data.path) closeInfo(false, true); // 属性页看的是旧根目录下的路径
  const scope = model.scope;
  const done = model.receive(data);
  if (model.scope !== scope) { invalidateScroll(); pending.preview = null; press.reset(); } // 换了根目录（同根重建不算）：旧根目录的位置和记录不能给新的用，待恢复的预览位置也是
  if (done && data.state === RootState.READY) {
    if (before?.path !== data.path) { if (model.opened !== null) preview.reload(); } else preview.refresh(); // 换了根目录，opened 已清空：旧预览随即关掉，不再读
  }
}

function onChanged(data) {
  if (!model.receive(data)) return;
  menu.hide(); // 开着的菜单可能指着已经删除的路径
  dataRound++;
  preview.refresh();
  info.refresh();
}

const remeasure = () => { tree.remeasure(); grid.remeasure(); };
remeasure();
quiet(() => coda.on('theme', remeasure));
render();
conn.hello();
