// 页内工具条：没有 coda.toolbar 的平台（iPhone）用，两个页面共用，按钮由页面给。
// 「返回」只在横屏出现（导航栏隐藏时），显示与否由 style.css 的媒体查询决定，这里一律画出来。
// 项：{ id, label, kind: 'button' | 'toggle' | 'title', glyph?, iconOnly?, on?, menu?, root? }；menu 的按钮打开菜单。title 不是按钮，只显示 label。
// title 带 root（{ path, project }，worktree 的根目录）时，label 是完整写法，画出来按标题现在的宽度省略（第 19 节），宽度变了（旋转、字号）重算；不带的交给 CSS 截断。
// 有 glyph 画图标；iconOnly 的只留图标，label 当可访问名称；否则图标后面跟文字（没有 glyph 就只有文字）。
import { icon } from './icons.mjs';
import { paintRootName } from './rootname.mjs';

export const EXIT = { id: 'exit', label: '返回', kind: 'button', glyph: 'back' };

const fitted = new WeakMap(); // 工具条 → { title, root, observer }：现在画着的要省略的标题

// 按现在的宽度重新省略标题（字号变了时页面调用）；没有要省略的标题什么都不做。
export function refitBar(el) {
  const entry = fitted.get(el);
  if (entry) paintRootName(entry.title, entry.root);
}

// act(id, button)：button 是被点的元素，菜单要用它定位。
export function paintBar(el, items, act) {
  fitted.get(el)?.observer?.disconnect();
  fitted.delete(el);
  el.hidden = false;
  el.replaceChildren(...items.map(item => {
    if (item.kind === 'title') {
      const title = Object.assign(document.createElement('span'), { className: 'bar-title grow truncate', textContent: item.label });
      if (item.root) fitted.set(el, { title, root: item.root, observer: null });
      return title;
    }
    const button = document.createElement('button');
    if (item.glyph) button.append(icon(item.glyph, 20));
    if (item.iconOnly) button.setAttribute('aria-label', item.label);
    else button.append(Object.assign(document.createElement('span'), { textContent: item.label }));
    if (item.id === EXIT.id) button.classList.add('exit');
    if (item.iconOnly) button.classList.add('icon');
    if (item.kind === 'toggle') button.setAttribute('aria-pressed', String(item.on));
    if (item.menu) { button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); }
    if (item.on) button.classList.add('on');
    button.addEventListener('click', () => act(item.id, button));
    return button;
  }));
  const entry = fitted.get(el);
  if (!entry) return;
  paintRootName(entry.title, entry.root); // 标题已在页面里，有了宽度
  if (typeof ResizeObserver === 'function') (entry.observer = new ResizeObserver(() => paintRootName(entry.title, entry.root))).observe(entry.title);
}
