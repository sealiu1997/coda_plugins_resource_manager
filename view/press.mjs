// 按下反馈：页面里只有一份按下状态，两端共用（设计见 docs/design/phase-3.md 第 17.3 节）。
// 不靠 :active（WebKit 对滚动区域里的触摸会延迟它）：文档上监听 pointerdown，给最近的可按元素加 .pressed，样子在 style.css。
// 虚拟列表重画会换掉节点，所以列表的行由 tree.mjs、grid.mjs 画行时问 paint() 是不是正在按下的那一行。
import { HOLD_SLOP } from './gestures.mjs';

export const SHOW_MS = 80; // 触摸按下后这么久没移动、没取消才亮：一滑动就闪不好看
export const MIN_MS = 100; // 正常抬起：从亮起算至少显示这么久
export const FADE_MS = 200; // iPhone 正常抬起后的淡出（样式在 style.css 的 .fade）

const QUERY = '(prefers-reduced-motion: reduce)';
// 系统「减弱动态效果」：按下的淡出、菜单、层级过渡、目录淡入都按它统一判断。读不到按「减弱」算，宁可不动。
export const reducedMotion = () => { const query = globalThis.matchMedia?.(QUERY); return !query || query.matches; };
// 设置在动画进行中变了：调用 fn，让正在播的动画结束到终点。
export const onMotionChange = fn => globalThis.matchMedia?.(QUERY)?.addEventListener?.('change', fn);

// 点到的可按元素：{ node, key }。key 是列表里一行的身份（视图、种类、路径），按钮没有（按节点记）。
// 可按：没有 disabled 的 button、.row.entry、.row.more、.row.retry、.cell、.gnote.more、.gnote.retry；.dead 的条目也算（它们能选中、能右键）。
function targetOf(event) {
  const node = event.target?.closest?.('.row, .cell, .gnote, button');
  if (!node) return null;
  if (node.tagName === 'BUTTON') return node.disabled || node.getAttribute('disabled') !== null ? null : { node, key: null };
  const has = name => node.classList.contains(name), path = node.dataset.path;
  const kind = has('cell') || has('entry') ? 'entry' : has('retry') ? 'retry' : has('more') ? 'more' : null;
  return kind === null || path === undefined ? null : { node, key: `${has('row') ? 'tree' : 'grid'}\n${kind}\n${path}` };
}

// identity()：会话和根目录的身份（model.session、model.scope 拼成的字符串）；换了就不是同一个按下。
// consumed(event)：这次 pointerdown 已经被别人用掉了（菜单开着时点外面只关菜单）：不加反馈。
export function mountPress({ identity = () => '', consumed = () => false, doc = document } = {}) {
  let state = null; // { id, x, y, key, base, node, shown, released, minDone, timers }
  const tagged = new Set(); // 加过 .pressed 的节点：去掉时一并清掉，不靠记住的旧节点
  const fading = new Map(); // 正在淡出的节点 → 它的定时器

  const unfade = () => { for (const [node, timer] of fading) { clearTimeout(timer); node.classList.remove('fade'); } fading.clear(); };
  const strip = () => { for (const node of tagged) node.classList.remove('pressed'); tagged.clear(); };
  const tag = node => { node.classList.add('pressed'); tagged.add(node); };
  const stop = () => { if (state) { clearTimeout(state.showTimer); clearTimeout(state.minTimer); } };

  // 作废：立即去掉，不淡出，不受最短时间限制；还没亮的之后也不会补亮。
  function clear() {
    stop();
    state = null;
    strip();
    unfade();
  }
  // 正常结束：iPhone 淡出（减弱动态效果时不淡）。
  function finish() {
    stop();
    state = null;
    const nodes = [...tagged];
    strip();
    if (reducedMotion()) return;
    for (const node of nodes) {
      node.classList.add('fade');
      fading.set(node, setTimeout(() => { node.classList.remove('fade'); fading.delete(node); }, FADE_MS));
    }
  }
  function show() {
    const mine = state;
    mine.shown = true;
    tag(mine.node);
    mine.minTimer = setTimeout(() => { mine.minDone = true; if (mine.released && state === mine) finish(); }, MIN_MS);
  }

  const on = (type, fn, target = doc, capture = true) => { target.addEventListener(type, fn, capture); return () => target.removeEventListener(type, fn, capture); };
  onMotionChange(unfade); // 设置在淡出进行中变成减弱：淡出结束到终点；仍按着的反馈保留
  const offs = [
    on('pointerdown', event => {
      if (event.isPrimary === false) return clear(); // 第二根手指
      clear();
      if (consumed(event) || (event.pointerType === 'mouse' || event.pointerType === undefined) && (event.button > 0 || event.ctrlKey)) return; // 右键、Control 左键是菜单
      const target = targetOf(event);
      if (!target) return;
      state = { id: event.pointerId, x: event.clientX, y: event.clientY, key: target.key, base: identity(), node: target.node, shown: false, released: false, minDone: false };
      if (event.pointerType === 'touch') {
        const mine = state;
        state.showTimer = setTimeout(() => { if (state === mine) show(); }, SHOW_MS);
      } else show();
    }),
    on('pointermove', event => {
      if (state && event.pointerId === state.id && Math.hypot(event.clientX - state.x, event.clientY - state.y) > HOLD_SLOP) clear();
    }),
    on('pointerup', event => {
      if (!state || event.pointerId !== state.id) return;
      if (!state.shown) { clearTimeout(state.showTimer); show(); } // 快点一下：在抬起时补上
      state.released = true;
      if (state.minDone) finish();
    }),
    on('pointercancel', clear),
    on('scroll', clear), // 滚动事件不冒泡，捕获才收得到
    on('dragstart', clear),
    on('contextmenu', clear),
    on('blur', clear, globalThis.window ?? doc, false), // 窗口失焦。不能用捕获：元素失焦（点按钮时焦点从目录树移走）的 blur 也会经过 window 的捕获阶段
    on('visibilitychange', () => { if (doc.hidden) clear(); }),
  ];

  return {
    // 画行时问：这一行是不是正在按下的（会话和根目录、视图、种类、路径都对得上），是就带上 .pressed。
    paint(node, view, kind, path) {
      if (!state || state.key !== `${view}\n${kind}\n${path}` || state.base !== identity()) return;
      state.node = node; // 还没亮（触摸等待期间）重画了：show() 要给新节点加，旧节点已经脱离
      if (state.shown) tag(node);
    },
    // 正在亮着的：{ key }，没有就是 null。测试用。
    current: () => (state?.shown ? { key: state.key } : null),
    reset: clear,
    dispose() { clear(); for (const off of offs.splice(0)) off(); },
  };
}
