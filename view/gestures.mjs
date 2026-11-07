// 条目上的事件规则：Mac 右键和拖动、iPhone 长按、点击。目录树和图标视图共用，各自注入「点到哪一项」和激活动作。
// 长按：按住这么久、移动不超过这个距离才算。
export const HOLD_MS = 500;
export const HOLD_SLOP = 10;

// el：接事件的元素；scroller：滚动的元素（滚动事件不冒泡），缺省同 el。选项：
// hit(event) → 点到的那一项或 undefined；pressable(item)：能不能弹菜单、拖动、长按（目录树的说明行、「再显示」不能）；
// activate(item)：点击（iPhone）；Mac 给了 select 就按 Finder 的规则：单击条目只 select(item)，单击空白 select(null)，双击条目才 activate(item)；
// 说明行、「再显示」这类不能选的项单击就 activate，direct(event, item) 为真的点击（展开箭头）也直接 activate、不选中，双击它不再重复激活。
// Mac 的选中在按下时做（左键，同 Finder），不等松开：右键、按住 Control 的左键（Mac 上是右键菜单）、被菜单消费的按下（consumed(event)：菜单开着时点外面只关菜单）都不选中。
// 双击靠浏览器的 dblclick，要求派发时目标节点还在容器里，所以 select 不能重画。menu(event, item)：右键，长按到点时收到 { clientX, clientY }；dragText(item)：拖动时带的文字（元素是否可拖由调用方设 draggable）；
// longPress：触屏上按住一项打开 menu，不设 touch-action，滚动照旧，滚动接管时收到 pointercancel 作废。
// 返回 { reset, dispose }：reset 在切会话时调用，长按的等待和吞点击的标记都属于上一个会话；dispose 摘掉全部监听。
export function mountGestures(el, { hit, pressable, activate, select, direct = () => false, menu, dragText, longPress = false, consumed = () => false, scroller = el }) {
  const listeners = [];
  const on = (target, type, fn, options) => { target.addEventListener(type, fn, options); listeners.push([target, type, fn]); };

  // 长按：按下只记一个等待；移动超限、抬起、取消、滚动、第二根手指都作废。
  // 触发后吞掉紧接着的那次点击；没有点击跟来时，下一次按下清掉，不会误吞后面真正的点击。
  let hold = null, swallow = false;
  const cancelHold = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
  if (longPress) {
    on(el, 'pointerdown', event => {
      cancelHold();
      swallow = false;
      const item = hit(event);
      if (event.isPrimary === false || !item || !pressable(item) || consumed(event)) return;
      const { clientX: x, clientY: y, pointerId: id } = event;
      hold = { id, x, y, timer: setTimeout(() => {
        hold = null;
        swallow = true;
        menu({ clientX: x, clientY: y }, item);
      }, HOLD_MS) };
    });
    on(el, 'pointermove', event => {
      if (hold && event.pointerId === hold.id && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > HOLD_SLOP) cancelHold();
    });
    for (const type of ['pointerup', 'pointercancel']) on(el, type, cancelHold);
    on(scroller, 'scroll', cancelHold, { passive: true });
  }

  if (select) on(el, 'pointerdown', event => {
    if (event.button > 0 || event.ctrlKey || event.isPrimary === false || consumed(event)) return;
    const item = hit(event);
    if (!item) select(null);
    else if (pressable(item) && !direct(event, item)) select(item);
  });
  on(el, 'click', event => {
    if (swallow) { swallow = false; return; }
    const item = hit(event);
    if (item && (!select || !pressable(item) || direct(event, item))) activate(item); // 选中已在按下时做过
  });
  if (select) on(el, 'dblclick', event => {
    const item = hit(event);
    if (item && pressable(item) && !direct(event, item)) activate(item);
  });
  on(el, 'contextmenu', event => {
    const item = hit(event);
    if (item && pressable(item)) { event.preventDefault(); menu(event, item); }
  });
  on(el, 'dragstart', event => {
    const item = hit(event);
    if (!item || !pressable(item)) return event.preventDefault();
    event.dataTransfer.setData('text/plain', dragText(item)); // 相对路径
    event.dataTransfer.effectAllowed = 'copy';
  });

  return {
    reset() { cancelHold(); swallow = false; },
    dispose() {
      cancelHold();
      for (const [target, type, fn] of listeners.splice(0)) target.removeEventListener(type, fn);
    },
  };
}
