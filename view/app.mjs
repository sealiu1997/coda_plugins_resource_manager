// 资源管理器的页面入口：消息收发、状态保留、工具栏和「更多」菜单、图标视图的进入和返回、搜索。状态在 model.mjs，渲染在 tree.mjs、grid.mjs、preview.mjs 和 info.mjs，菜单和提示在 menu.mjs 和 hint.mjs，滚动位置的恢复在 restore.mjs，
// 文件名搜索的状态在 search.mjs、搜索框在 searchbar.mjs、「在目录中显示」在 locate.mjs。
import { EXIT, paintBar, refitBar } from './bar.mjs';
import { createChat } from './chat.mjs';
import { connect } from './connection.mjs';
import { infoText, sortName } from './format.mjs';
import { h } from './dom.mjs';
import { mountGrid } from './grid.mjs';
import { mountHint } from './hint.mjs';
import { mountInfo } from './info.mjs';
import { createLocator } from './locate.mjs';
import { mountMenu } from './menu.mjs';
import { Model, STATE_LIMIT, View, noticeText, parseState, putSession, trimState } from './model.mjs';
import { showNotice } from './notice.mjs';
import { mountPreview } from './preview.mjs';
import { mountPress, onMotionChange, reducedMotion } from './press.mjs';
import { EntryKind, RootState, SortKey, Type } from './protocol.mjs';
import { createRestore, createTrail } from './restore.mjs';
import { createSearch } from './search.mjs';
import { mountSearchbar } from './searchbar.mjs';
import { browseAction, previewAction } from './keys.mjs';
import { rootLabel } from './rootname.mjs';
import { mountTree } from './tree.mjs';

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
let menuFrom = null; // 现在开着的菜单从哪里打开的：'browse'（目录树、图标视图的行）、'result'（搜索结果的行）、null（别的）；changed 时按它决定关不关
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

// ---- 文件名搜索（第 18 节）：搜索框常驻在 #browse 顶上，有字时结果换掉目录树和图标视图 ----
// 搜索的身份是会话和根目录（model.scope）：回答回来时对不上就作废。
const search = createSearch({
  call: (fields, signal) => conn.link.call(Type.SEARCH, fields, { signal, cancel: Type.SEARCH_CANCEL }),
  hidden: () => model.showHidden,
  identity: () => `${model.session}\n${model.scope}`,
  // 结果整体没了（搜索词清空、reset、根目录不可用 suspend 都走这里）：结果行的菜单一并作废——它的操作指着旧结果。
  // 非空重搜时旧结果留着（shown 不为空或在搜索中），菜单照旧留着，操作按打开菜单时的路径做。
  onChange: () => {
    if (menuFrom === 'result' && (!search.active || (search.shown === null && search.status === 'idle'))) { menu.hide(); menuFrom = null; }
    schedule();
  },
});
const searchbar = mountSearchbar($('searchbar'), { onInput: searchInput, onClear: () => { clearSearch(); searchbar.focus(); }, onKey: searchBoxKey, onEnter: () => { if (isIOS) searchbar.blur(); } });
const hitStatus = h('span', { class: 'sstatus-text' }), hitRetry = h('button', { class: 'link', onclick: () => search.research() }, '重试'), hitsEl = h('div', { class: 'shits', role: 'listbox' });
hitRetry.hidden = true;
$('search').replaceChildren(h('div', { class: 'sstatus secondary', role: 'status' }, hitStatus, hitRetry), hitsEl);
// 结果自己的选中（不改 model.selected）和键盘焦点；单击只切 .sel，不重画行（双击要落在还在容器里的节点上）。
const hits = mountTree(hitsEl, model, {
  open: path => openResult(path),
  toggle: path => revealResult(path, true), // 结果里的文件夹：同「在目录中显示」，然后展开它或进入它
  more() {}, retry() {},
  menu: (event, row) => resultMenu(event, row),
  select: isIOS ? null : path => { if (search.select(path)) hits.select(); },
}, { draggable: !isIOS, longPress: isIOS, keyboard: !isIOS, press, consumed: menu.consumed, rows: () => search.rows(), selected: () => search.selected, view: 'search', title: false });

// 用户接管计数：浏览区上的 pointerdown、wheel、touchstart、keydown 各加一（点已选中的条目、点空白、右键和长按的起手都算，不管选中变没变）；
// 经菜单、按钮执行的打开预览、属性页等在入口处另计一次。程序自己的展开、进入目录、滚动、选中都不经过这里。「在目录中显示」靠它判断用户有没有动过。
let takeover = 0;
for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown']) $('browse').addEventListener(type, () => { takeover++; }, true);
const taken = fn => (...args) => { takeover++; return fn(...args); };
const locator = createLocator({
  model,
  // 会话、根目录、排序、视图、隐藏开关和模型的刷新轮次：任何一个变了，定位就作废。
  identity: () => [model.session, model.scope, model.sort, model.view, model.showHidden, model.round].join('\n'),
  takeover: () => takeover,
  ops: {
    // 开始：清空搜索（搜索轮次加一）；丢掉目标视图还在等的滚动恢复；图标视图进入目标所在的目录（和 enterDir 一样记 trail、滚到顶部，但不触发 landed 的补滚动）。
    begin(parent) {
      clearSearch();
      restore.drop('tree');
      restore.drop('grid');
      if (parent === null || parent === model.cwd) return;
      trail.remember(model.cwd, grid.scroll());
      selectEntry(null);
      model.enter(parent);
      shownCwd = model.cwd;
      grid.scrollTo(0);
      declareBack();
    },
    render: () => browser().render(),
    select: path => selectEntry(path),
    center: path => browser().center(path),
    // 文件夹结果：定位到它之后，列表视图展开它，图标视图进入它（程序自己的，不算接管）。
    openFolder(path) { if (model.view === View.ICONS) enterInto(path); else if (!model.expanded.has(path)) model.toggle(path); },
    notify: text => hint.show(text, { warn: false }),
  },
});
function searchInput(value) {
  locator.cancel(); // 重新输入搜索词：定位作废
  search.input(value);
  searchbar.set(value);
}
// 清空搜索：搜索词、结果、结果的选中都清掉（定位自己开始时、Esc、清除按钮）。
function clearSearch() {
  search.reset();
  searchbar.set('');
}
const preview = mountPreview($('preview'), {
  read: (path, offset) => conn.link.call('read', { path, offset }), copy: text => coda.copy(text),
  // iPhone 预览头部右边的 ⋯（刷新、复制路径）：顶部工具条在预览时只有「返回」，只留头部一行标题
  actions: isIOS ? [{ label: '更多', icon: 'ellipsis', run: (_, button) => toggleMore(button) }] : [{ label: '窗口', icon: 'window', run: openInView }], copyInHead: !isIOS,
  back: isIOS ? null : closePreview,
  // 选中文字的右键菜单只有 Mac：iPhone 用系统的选区菜单。
  selectionMenu: isIOS ? null : (event, selection) => { menu.open(event, { items: chat.selectionItems(selection) }); menuFrom = null; },
  consumed: menu.consumed, // 菜单开着时的 Esc 归菜单：查找条不处理
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
// 打开文件的统一入口（目录树、图标视图和搜索结果）：焦点交接和过渡意图在这里记，不随调用方复制。select 为假（搜索结果）时只设预览，不改 model.selected。
function openFile(path, { select = true } = {}) {
  openPressed = !isIOS; // 用户在 Mac 上打开的：render 把焦点交给预览面板
  note({ kind: 'push', from: mode(), to: 'preview' });
  model.openFile(path, { select });
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
// 浏览区里键盘该落在哪：搜索时是结果，否则是目录树或图标视图。
const focusBrowse = () => (searching() ? hits : browser()).focus();

// 结果上面的状态行。
function paintSearch() {
  const { text, retry } = search.statusLine();
  if (hitStatus.textContent !== text) hitStatus.textContent = text;
  hitRetry.hidden = !retry;
  hits.render();
}
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
let wantFocus = false; // 清空搜索后，等重画把目录树或图标视图放出来再把焦点交给它
let openPressed = false; // 用户打开了文件：同返回对称，页面持有焦点时 render 把焦点交给预览面板
// 两级（第 18.3 节）：外层是层（browse、preview、notice、info），管过渡、inert 和离开那层的释放；内层是 #browse 里当前的面板（search、grid、tree），只管三个面板的可见性。
// 预览或属性页盖在结果上面时，内层仍是结果：搜索不改外层。
const mode = () => (infoOpen ? 'info' : !model.ready ? 'notice' : model.opened !== null ? 'preview' : 'browse');
const searching = () => model.ready && search.active;
const pane = () => (searching() ? 'search' : model.view === View.ICONS ? 'grid' : 'tree');
const INNER = ['tree', 'grid', 'search'];

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
const PANES = ['browse', 'preview', 'notice', 'info'];
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
// 内层（#browse 里的三个面板）按状态直接换，不做过渡，也不管外层在不在播过渡。
function applyPanes(current) {
  const leaving = running?.leaving ?? null;
  for (const id of PANES) {
    $(id).classList.toggle('off', current !== id && leaving !== id);
    $(id).classList.toggle('leaving', leaving === id);
    $(id).inert = current !== id;
  }
  const inner = pane();
  for (const id of INNER) {
    $(id).classList.toggle('off', inner !== id);
    $(id).inert = current !== 'browse' || inner !== id; // 外层不是浏览区（被预览、属性页盖住）时里面的面板也不能操作
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
  if (current !== 'browse' || pane() !== 'grid' || model.cwd !== intent.to) { intent = null; return; } // 中途换了目录、或打开了文件：作废
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
  const refocus = (backPressed || wantFocus) && document.hasFocus(), handoff = openPressed && document.hasFocus();
  backPressed = openPressed = wantFocus = false;
  const slideIn = takeSlide(current);
  if (current === 'notice') paintNotice();
  const browsing = current === 'browse';
  (model.view === View.ICONS ? grid : tree).render(); // 只画正在用的视图，另一个留着它的内容和滚动位置
  searchbar.set(search.text);
  if (searching()) paintSearch();
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
  if (refocus && browsing) focusBrowse();
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
const phoneItems = () => infoOpen || mode() === 'preview' ? [EXIT] : [EXIT, { kind: 'title', label: model.ready ? dirTitle() : '', ...(model.ready && titleIsRoot() && model.root.project ? { root: { path: model.root.path, project: model.root.project } } : {}) }, MORE];
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
  ...(preview.canFind ? [{ label: '查找', run: () => preview.openFind() }] : []), // 只有显示着的文本有查找
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
  else { menu.open(button, moreMenu()); menuFrom = null; }
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
    search.research(); // 隐藏开关变了：有搜索词就按新的 hidden 重搜
  }
  else if (id === 'refresh') {
    conn.refresh();
    model.refresh();
    preview.refresh();
    search.research();
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
  const open = isIOS || dead ? [] : [{ label: folder && listed ? (row.open ? '收起' : '展开') : '打开', run: taken(() => browser().activate(row)) }, { separator: true }];
  menuFrom = 'browse';
  menu.open(event, { title: row.path, detail: dead ? undefined : infoText(row) || undefined, items: [
    ...open,
    ...(dead ? [] : [{ label: '添加到聊天', run: taken(() => chat.add(row.path)) }]),
    { label: '复制相对路径', run: taken(() => coda.copy(row.path)) },
    { label: '复制绝对路径', run: taken(() => coda.copy(`${model.root.path}/${row.path}`)) },
    { separator: true },
    { label: '属性', run: taken(() => openInfo(row)) },
  ] });
}

// 结果的行菜单：同目录树（打开、添加到聊天、复制路径、属性），另加「在目录中显示」。
// 菜单是按打开菜单时那一行的路径和来源（结果）做的：菜单开着时结果被换掉，执行的操作仍按那时的路径，来源仍算结果。
// iPhone 轻点就是打开，菜单里不放「打开」。
function resultMenu(event, row) {
  press.reset();
  const dead = row.kind === EntryKind.LINK || row.kind === EntryKind.OTHER, { path } = row;
  menuFrom = 'result';
  menu.open(event, { title: path, items: [
    ...(isIOS || dead ? [] : [{ label: '打开', run: taken(() => (row.kind === EntryKind.DIR ? revealResult(path, true) : openResult(path))) }, { separator: true }]),
    ...(dead ? [] : [{ label: '添加到聊天', run: taken(() => chat.add(path)) }]),
    { label: '复制相对路径', run: taken(() => coda.copy(path)) },
    { label: '复制绝对路径', run: taken(() => coda.copy(`${model.root.path}/${path}`)) },
    { separator: true },
    { label: '在目录中显示', run: taken(() => revealResult(path)) },
    { label: '属性', run: taken(() => openInfo(row)) },
  ] });
}
// 结果里打开文件：设预览，不设 selected；结果自己的选中是刚打开的那个，返回后回到结果。
function openResult(path) {
  if (search.select(path)) hits.select();
  openFile(path, { select: false });
}
// 在目录中显示（open 为真：文件夹结果，找到之后再展开它或进入它）。
function revealResult(path, open = false) { locator.show(path, { open }); }
$('tree').addEventListener('scroll', menu.hide, { passive: true });
grid.onScroll(menu.hide);
hitsEl.addEventListener('scroll', menu.hide, { passive: true });
// iPhone：开始滚动结果时收起键盘。
hitsEl.addEventListener('scroll', () => { if (isIOS && searchbar.focused) searchbar.blur(); }, { passive: true });

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
// 搜索框和结果的键盘（第 18.5 节的分派表）：输入法组字中的按键一律不管；菜单开着时 Esc 归菜单（关菜单、消费掉这个 Esc），这里不处理。
// ⌘F 在浏览区（含结果和页面本身）聚焦搜索框并选中里面的字；预览、属性页、说明区不拦；菜单开着时先关菜单。
function searchBoxKey(event) {
  if (event.key === 'Escape' && menu.consumed(event)) event.preventDefault(); // 菜单关掉的 Esc：搜索框是 type=search，默认动作会清空它，要拦下
  if (isIOS || event.isComposing || !menu.hidden || menu.consumed(event)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    const clearing = search.text !== '';
    if (clearing) clearSearch();
    if (clearing) wantFocus = true; else focusBrowse(); // 清空之后结果让位给目录树：等重画把它放出来再交焦点
  } else if (event.key === 'ArrowDown' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && searching() && search.rows().length > 0) {
    event.preventDefault();
    hits.focus();
    const first = search.rows()[0].path; // 明确选中第一条（不是相对移动：有旧选中时 ↓ 会选到下一条）
    if (search.select(first)) hits.select();
    hits.scrollTo(0);
  }
}
hits.onKey(event => {
  if (isIOS || event.isComposing || !menu.hidden || menu.consumed(event)) return;
  if (event.key === 'Escape') { event.preventDefault(); searchbar.focus(); return; }
  const action = browseAction(event);
  if (!action) return;
  event.preventDefault();
  // ← →、⌘↑ 什么都不做：不改被遮住的目录树和图标视图的目录
  if (action === 'up' || action === 'down') hits.key(action);
  else if (action === 'open') hits.openSelected();
});
document.addEventListener('keydown', event => {
  if (isIOS || event.isComposing || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key?.toLowerCase() !== 'f') return;
  if (!menu.hidden) menu.hide();
  const layer = mode();
  if (layer === 'preview') { // 能查找的文本：打开查找条并聚焦（已开就选中输入框的字）；图片、二进制、读取中、读不到不拦
    if (preview.canFind) { event.preventDefault(); preview.openFind(); }
    return;
  }
  if (layer !== 'browse') return;
  event.preventDefault();
  searchbar.select();
});
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
const enterDir = taken(path => enterInto(path));
function enterInto(path) {
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
  takeover++; // 用户经按钮、键盘、返回退出图标视图的一层
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
// 标题是当前目录名：根目录是根目录名（worktree 是「项目名-wt-编号」，这里给完整写法，不省略：文字由客户端排版）。
// 搜索时结果盖住了图标视图的目录：标题是根目录名。
const titleIsRoot = () => model.cwd === '' || model.view !== View.ICONS || searching();
const dirTitle = () => (titleIsRoot() ? rootLabel(model.root) : model.cwd.slice(model.cwd.lastIndexOf('/') + 1));
const previewOpen = () => model.ready && model.opened !== null;
// 搜索本身不是一级：搜索模式下图标视图的目录层级不声明（搜索盖住了它们），从结果打开的预览和属性页要回到的那一页叫「搜索」（第 18.5 节的表）。
function backPath() {
  const icons = model.view === View.ICONS && model.ready && !searching();
  const upper = icons && model.cwd !== '' ? [rootLabel(model.root), ...model.cwd.split('/').slice(0, -1)] : [];
  const here = searching() ? '搜索' : icons ? dirTitle() : '资源管理器';
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
  const levels = Math.min(steps - used, model.view === View.ICONS && model.cwd !== '' && !searching() ? model.cwd.split('/').length : 0); // 搜索模式下不消耗被遮住的图标视图目录
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
  hits.reset();
  locator.cancel();
  clearSearch(); // 换会话：搜索词、结果、结果的选中、定位都清掉
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
  if (data.state !== RootState.READY) { search.suspend(); locator.cancel(); } // 根目录暂不可用：取消在途搜索，丢掉结果，搜索词留着；定位作废（再就绪也不接着做）
  const done = model.receive(data);
  if (model.scope !== scope) { invalidateScroll(); pending.preview = null; press.reset(); clearSearch(); locator.cancel(); } // 换了根目录（同根重建不算）：旧根目录的位置和记录不能给新的用，待恢复的预览位置也是；搜索词和结果清空
  else if (data.state === RootState.READY) search.resume(); // 再就绪时 scope 没变：重搜
  if (done && data.state === RootState.READY) {
    if (before?.path !== data.path) { if (model.opened !== null) preview.reload(); } else preview.refresh(); // 换了根目录，opened 已清空：旧预览随即关掉，不再读
  }
}

function onChanged(data) {
  if (!model.receive(data)) return;
  // 开着的菜单可能指着已经删除的路径：目录树、图标视图的行菜单照旧关。结果行的菜单留着（第 18.3、18.4 节：重搜替换结果时菜单留着，操作按打开菜单时的路径做）。
  if (menuFrom !== 'result') menu.hide();
  dataRound++;
  preview.refresh();
  info.refresh();
  search.research(); // 搜索期间目录模型照常刷新；有搜索词就重搜，旧结果留到新结果来
}

const remeasure = () => { tree.remeasure(); grid.remeasure(); hits.remeasure(); refitBar($('bar')); };
remeasure();
quiet(() => coda.on('theme', remeasure));
render();
conn.hello();
