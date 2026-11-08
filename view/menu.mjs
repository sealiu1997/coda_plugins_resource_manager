// 菜单：Mac 右键、iPhone 长按的行菜单，Mac 选中文字的右键菜单，iPhone 的 ⋯ 和 Mac 原生「更多」弹出的菜单都用它，树页和文件页各挂一个。
// 菜单开着时点菜单外只关菜单、紧接着的那次点击不交给页面；Escape、窗口失焦、旋转（窗口尺寸变化）关闭；页面里别的滚动区域滚动时由页面调 hide。
// 菜单可以有一层二级菜单（项里写 submenu）。「整次菜单」（current）和「当前层」（layer、fly）分开记：
// 在面板里切到下一层、退回来，整次菜单还是同一次，但上一层的按钮不再响应。第二个面板（sub）也算菜单里面，点它不是点外面。
import { icon } from './icons.mjs';
import { onMotionChange, reducedMotion } from './press.mjs';

const CLOSE_MS = 150; // 鼠标移到别的项之后，侧面板收起前等多久：斜着移过去不会误关
const GAP = 2; // 侧面板和根面板之间留的空隙
const APPEAR_MS = 150; // iPhone 菜单出现：透明度 0→1，根层同时缩放 0.96→1；换层只淡入

// el：页面里的 #menu。sub：侧面板（#submenu），没有就不能弹出，二级菜单总是在 el 里切到下一层。
// flyout：true 时（Mac）鼠标移上去或点击「显示」这类项，侧面板在根面板左边弹出；放不下就退成切到下一层（iPhone 总是这样）。
// open 之后的位置按安全区夹住（横屏时客户端不替页面留）；offsetWidth 在显示后才量得到。
// 高度有上限（style.css 的 .menu）：内容多时在菜单里滚动，不超出安全区。
// animate：iPhone 的出现动画（Mac 的原生菜单立刻出现，不做）；关闭不做动画。减弱动态效果时也不做。
export function mountMenu(el, sub = null, { flyout = false, animate = false } = {}) {
  let opener = null; // 打开菜单的按钮；用点打开的没有
  let current = null; // 这一次打开的标记：关闭之后留在手里的按钮不再响应
  let layer = 0; // el 里现在是哪一层：每次换层（进下一层、退回、重新打开、关闭）加一，旧层的按钮据此作废
  let fly = 0; // 侧面板的第几次展开：收起、重开都加一
  let spec = null, anchor = null; // 根层的内容和锚点：退回根层、换层后重新定位要用
  let flyButton = null; // 展开着侧面板的那个项
  let closeTimer = null;
  let playing = null; // 正在播的出现动画

  // 出现动画：scale 为真是根层（从锚点那一侧缩放），否则只淡入。开着的动画先停在终点，免得叠在一起。
  function appear(scale) {
    settle();
    if (!animate || reducedMotion() || typeof el.animate !== 'function') return;
    const frames = scale ? [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'scale(1)' }] : [{ opacity: 0 }, { opacity: 1 }];
    if (scale) {
      // 缩放原点按夹进安全区之后的最终位置定：菜单在锚点下方从上沿缩放，在上方从下沿；横向贴着锚点的右边或点的位置。
      const box = el.getBoundingClientRect(), at = anchor.getBoundingClientRect?.();
      const below = box.top >= (at ? at.bottom : anchor.clientY) - 1;
      el.style.transformOrigin = `${at ? 'right' : `${Math.max(0, Math.min(box.width, anchor.clientX - box.left))}px`} ${below ? 'top' : 'bottom'}`;
    }
    const mine = playing = el.animate(frames, { duration: APPEAR_MS, easing: 'ease-out' });
    mine.onfinish = mine.oncancel = () => { if (playing === mine) playing = null; };
  }
  // 停止开着的动画：没有 fill，取消就是停在终点；根层的出现动画还没播完就换层、或关闭时调用。
  function settle() { const mine = playing; playing = null; mine?.cancel(); }
  onMotionChange(settle); // 设置在动画进行中变成减弱：结束到终点

  // items：[{ label, run, checked?, radio? } | { label, submenu: { items } } | { separator: true } | { heading }]，checked 不是 undefined 的带对勾（radio 的是单选，其余是开关）；
  // 分隔线和小标题不是菜单项，不可点。hover：这一层的项在鼠标移上去时管侧面板（只有根层，且 flyout）。
  // alive：这一层还有没有效，点击时先问它。
  function build(items, alive, hover) {
    const checkable = items.some(item => item.checked !== undefined); // 有开关项时，每一项都留出对勾的位置，文字才对齐
    return items.map(item => {
      const { label, run, checked, radio, separator, heading, submenu } = item;
      if (separator) return Object.assign(document.createElement('hr'), { className: 'menu-sep' });
      if (heading !== undefined) {
        // 小标题和选项走同一套布局：这一层有对勾列时，小标题前也放一个同宽的空位，文字才和选项的文字左边对齐。
        const head = Object.assign(document.createElement('p'), { className: 'menu-head secondary caption' });
        if (checkable) head.append(Object.assign(document.createElement('span'), { className: 'check' }));
        head.append(Object.assign(document.createElement('span'), { textContent: heading }));
        return head;
      }
      const button = document.createElement('button'), name = document.createElement('span');
      name.textContent = label;
      if (checkable) {
        const mark = document.createElement('span');
        mark.className = 'check';
        if (checked) mark.append(icon('check', 14));
        button.append(mark);
      }
      button.append(name);
      if (submenu) {
        const arrow = document.createElement('span');
        arrow.className = 'sub-arrow';
        arrow.append(icon('chevron', 14));
        button.append(arrow);
        button.setAttribute('role', 'menuitem');
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        // 进下一层不是叶子项：不关菜单，也不执行什么。
        button.addEventListener('click', () => { if (alive()) show(button, item, true); });
      } else {
        button.setAttribute('role', checked === undefined ? 'menuitem' : radio ? 'menuitemradio' : 'menuitemcheckbox');
        if (checked !== undefined) button.setAttribute('aria-checked', String(checked));
        button.addEventListener('click', () => {
          if (!alive()) return; // 菜单已经关了（换成了别的、退回了上一层）：留在手里的按钮不再响应
          hide(true);
          run();
        });
      }
      if (hover) button.addEventListener('pointerenter', event => {
        if (!alive() || event.pointerType === 'touch') return;
        if (submenu) show(button, item, false); else later();
      });
      return button;
    });
  }

  // 根层：路径标题、信息行，和项。
  function paintRoot() {
    const { title, detail, items } = spec, mine = current, mineLayer = ++layer;
    const head = [];
    if (title !== undefined) head.push(Object.assign(document.createElement('p'), { className: 'menu-path secondary', textContent: title }));
    if (detail !== undefined) head.push(Object.assign(document.createElement('p'), { className: 'menu-info secondary caption', textContent: detail }));
    el.replaceChildren(...head, ...build(items, () => current === mine && layer === mineLayer, flyout && sub !== null));
    el.scrollTop = 0;
  }

  // 贴在锚点下面、右对齐（锚点是按钮元素或同样有 getBoundingClientRect 的假锚点），或放在点上；每次换层内容宽度变了都要重来。
  function place() {
    const box = anchor.getBoundingClientRect?.();
    const x = box ? box.right - el.offsetWidth : anchor.clientX, y = box ? box.bottom + 4 : anchor.clientY;
    el.style.left = `max(var(--safe-left), min(${x}px, calc(100vw - var(--safe-right) - ${el.offsetWidth + 4}px)))`;
    el.style.top = `max(var(--safe-top), min(${y}px, calc(100vh - var(--safe-bottom) - ${el.offsetHeight + 4}px)))`;
  }

  // anchor：按钮元素或同样有 getBoundingClientRect 的假锚点（原生按钮：只代表根层，子菜单贴的是真实的项）或 { clientX, clientY } 的点。
  // title 写在菜单顶上：iPhone 没有 title 悬停，长文件名在行里被截断，这里看全；detail 是它下面的一行小字。
  function open(at, content) {
    hide();
    current = {};
    spec = content;
    anchor = at;
    paintRoot();
    el.hidden = false;
    place();
    appear(true);
    if (at.getBoundingClientRect) { opener = at; opener.setAttribute?.('aria-expanded', 'true'); }
  }

  // 二级菜单：click 是点击（键盘激活也是）；鼠标移上去只在放得下时弹出，放不下什么都不做，免得内容在鼠标底下突然换掉。
  function show(button, item, click) {
    keep();
    if (flyout && sub !== null) {
      if (flyButton === button) return; // 已经开着
      collapse();
      const mine = current, mineFly = ++fly;
      const nodes = build(item.submenu.items, () => current === mine && fly === mineFly, false);
      sub.replaceChildren(...nodes);
      sub.hidden = false;
      sub.style.visibility = 'hidden'; // 先量尺寸再决定放不放得下，量的时候别让人看到
      sub.scrollTop = 0;
      const { offsetWidth, offsetHeight } = sub, root = el.getBoundingClientRect(), at = button.getBoundingClientRect();
      const x = root.left - offsetWidth - GAP;
      if (x >= safeLeft()) {
        sub.style.left = `${x}px`;
        sub.style.top = `max(var(--safe-top), min(${at.top - 5}px, calc(100vh - var(--safe-bottom) - ${offsetHeight + 4}px)))`; // 第一项和「显示」对齐：减去面板的边框和内边距
        sub.style.visibility = '';
        flyButton = button;
        button.setAttribute('aria-expanded', 'true');
        if (click) nodes.find(node => node.tagName === 'BUTTON')?.focus?.(); // 键盘激活：焦点进侧面板
        return;
      }
      collapse(); // 放不下：和 iPhone 一样切到下一层
    }
    if (click) enter(item);
  }

  // 在 el 里切到下一层：顶上一行返回；点返回回到根层，下一层的按钮此后不再响应。
  function enter(item) {
    const mine = current, mineLayer = ++layer, alive = () => current === mine && layer === mineLayer;
    const back = document.createElement('button'), mark = document.createElement('span'), name = document.createElement('span');
    mark.className = 'check back';
    mark.append(icon('back', 14));
    name.textContent = '返回';
    back.className = 'menu-back';
    back.append(mark, name);
    back.setAttribute('role', 'menuitem');
    back.addEventListener('click', () => {
      if (!alive()) return;
      paintRoot();
      place();
      appear(false);
    });
    el.replaceChildren(back, Object.assign(document.createElement('hr'), { className: 'menu-sep' }), ...build(item.submenu.items, alive, false));
    el.scrollTop = 0;
    place();
    appear(false);
  }

  // 鼠标回到「显示」或侧面板：取消正在等的收起。
  function keep() { clearTimeout(closeTimer); closeTimer = null; }
  // 鼠标移到别的项：等一会儿再收起侧面板。
  function later() {
    if (flyButton === null || closeTimer !== null) return;
    const mine = current;
    closeTimer = setTimeout(() => { closeTimer = null; if (current === mine) collapse(); }, CLOSE_MS);
  }
  function collapse() {
    keep();
    fly++; // 侧面板里的旧按钮不再响应
    if (sub) sub.hidden = true;
    flyButton?.setAttribute('aria-expanded', 'false');
    flyButton = null;
  }
  // 安全区的左边：body 的左内边距就是它（style.css），算出来的是像素。读不到按 0。
  const safeLeft = () => { const px = parseFloat(globalThis.getComputedStyle?.(document.body)?.paddingLeft); return Number.isFinite(px) ? px : 0; };

  // restore：关菜单后把焦点交回打开它的按钮（Esc 关、选了一项之后）。点菜单外、滚动、旋转关的不交：点到哪里焦点就在哪里。
  // 选项的操作在交回焦点之后才执行，操作自己要移焦点（如「查找」聚焦查找条）时以操作为准。没有按钮的菜单（右键、原生按钮的假锚点）焦点不动。
  function hide(restore = false) {
    settle();
    current = null;
    layer++;
    collapse();
    el.hidden = true;
    const back = opener;
    opener?.setAttribute?.('aria-expanded', 'false');
    opener = null;
    if (restore === true) back?.focus?.(); // 严格比较：hide 也被直接当事件回调用（滚动、resize、blur），Event 对象是真值
  }

  // 两个面板都算菜单里面。菜单开着时点菜单外：只关菜单，紧接着的那次点击不交给页面。
  const inside = target => el.contains(target) || (sub !== null && sub.contains(target));
  // 关菜单的那一下按下标成「已消费」：按下反馈和 Mac 的按下即选中都先看它（consumed），消费过的不加反馈、不选中。
  let dismissed = false;
  const eaten = new WeakSet();
  document.addEventListener('pointerdown', event => {
    dismissed = !el.hidden && !inside(event.target);
    if (dismissed) eaten.add(event);
    if (!inside(event.target)) hide();
  }, true);
  document.addEventListener('click', event => {
    if (dismissed) { dismissed = false; event.stopPropagation(); }
  }, true);
  // Esc 关菜单时同样标成「已消费」：同一次按键上的搜索框、结果列表、查找条不再清搜索、关查找条或移焦点（第 18.5 节）。
  // 挂在 document 的捕获阶段：捕获先于目标和冒泡经过的所有元素，「已消费」的标记一定在它们的监听执行之前加上（冒泡阶段就晚了：预览元素的监听先执行）。
  // 关菜单和交还焦点之后，同一个事件还会派发到原目标，原目标上的监听看到 consumed 为真，什么都不做。
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!el.hidden) eaten.add(event);
    hide(true);
  }, true);
  window.addEventListener('blur', () => hide());
  window.addEventListener('resize', () => hide()); // 旋转、拖窄侧栏：位置对不上了
  sub?.addEventListener('pointerenter', keep);

  return {
    open, hide,
    get hidden() { return el.hidden; },
    consumed: event => eaten.has(event),
    // 谁打开的菜单：同一个按钮再次激活就关闭（键盘激活没有 pointerdown，上面那条规则管不到）。
    get opener() { return opener; },
  };
}
