// 最小的假 DOM，只够加载真实的 view/app.mjs：元素树、事件冒泡、classList、textContent，没有布局和选择器引擎。
class Text {
  parent = null;
  constructor(data) { this.data = data; }
  get textContent() { return this.data; }
}

class Emitter {
  #listeners = new Map();
  addEventListener(type, fn) { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]); }
  removeEventListener(type, fn) { this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter(other => other !== fn)); }
  emit(event) { for (const fn of this.#listeners.get(event.type) ?? []) fn(event); }
}

export class Element extends Emitter {
  parent = null;
  children = [];
  attributes = new Map();
  style = {};
  dataset = {};
  scrollTop = 0;
  scrollLeft = 0;
  clientHeight = 0;
  clientWidth = 0;
  offsetWidth = 100;
  offsetHeight = 100;
  offsetTop = 0;
  inert = false;

  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => ((force ?? !classes.has(name)) ? classes.add(name) : classes.delete(name), classes.has(name)),
      values: () => [...classes],
    };
    this.className = '';
    Object.defineProperty(this, 'className', {
      get: () => [...classes].join(' '),
      set: value => { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
    });
  }

  get hidden() { return this.attributes.has('hidden'); }
  set hidden(on) { if (on) this.attributes.set('hidden', ''); else this.attributes.delete('hidden'); }
  get title() { return this.attributes.get('title') ?? ''; }
  set title(value) { this.attributes.set('title', String(value)); }
  get textContent() { return this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(...(value === '' ? [] : [String(value)])); }

  setAttribute(name, value) { if (name === 'class') this.className = value; else this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }

  // 焦点：和浏览器一样，聚焦的元素被摘掉后 activeElement 回到没有。
  focus() { globalThis.document.activeElement = this; }
  replaceChildren(...nodes) {
    for (const child of this.children) { if (child.contains?.(globalThis.document?.activeElement)) globalThis.document.activeElement = null; child.parent = null; }
    this.children = [];
    this.append(...nodes);
  }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new Text(node) : node;
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  contains(node) { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
  // 选择器只支持逗号分隔的列表，每项是 标签名 加任意个 .类（如 .row.entry、button、.a, .b），不支持后代、伪类。
  matches(selector) {
    return selector.split(',').some(part => {
      const [, tag, classes] = /^\s*([a-z]*)((?:\.[\w-]+)*)\s*$/i.exec(part) ?? [];
      return tag !== undefined && (tag === '' || this.tagName === tag.toUpperCase()) && classes.split('.').filter(Boolean).every(name => this.classList.contains(name));
    });
  }
  closest(selector) {
    for (let at = this; at instanceof Element; at = at.parent) if (at.matches(selector)) return at;
    return null;
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 24, height: 24, width: 100 }; }
  dispatch(type, init = {}) {
    let stopped = false;
    const event = { type, target: this, preventDefault() {}, stopPropagation() { stopped = true; }, ...init };
    // document 上的监听先于元素（页面里都是捕获阶段）；stopPropagation 后元素收不到。
    globalThis.document?.emit?.(event);
    if (stopped) return event;
    for (let at = this; at instanceof Element; at = at.parent) at.emit(event);
    return event;
  }
  find(predicate) {
    const found = [];
    const walk = node => { if (node instanceof Element) { if (predicate(node)) found.push(node); node.children.forEach(walk); } };
    walk(this);
    return found;
  }
}

// 不在文档里的元素（hidden 或 off）不算可见。
export function visible(node) {
  for (let at = node; at instanceof Element; at = at.parent) if (at.hidden || at.classList.contains('off')) return false;
  return true;
}

// 装上 window、document 等全局并加载真实的页面入口（默认 view/app.mjs），每次得到全新的模块实例。
let instance = 0;
// motion：给了就装上 matchMedia（prefers-reduced-motion，motion.reduce 为真时「减弱」）和 Element.prototype.animate 的桩，页面才会播动画；
// 不给时没有 matchMedia，页面按「减弱动态效果」处理（旧测试都不受动画影响）。返回的 page.motion：{ reduce, animations, set(reduce) }，
// animations 是所有 animate 调用（{ el, frames, options, finished, canceled, finish() }），set 改设置并触发 change。
export async function loadApp(t, coda, { entry = 'app.mjs', ids = ['bar', 'tree', 'grid', 'preview', 'notice', 'menu', 'submenu', 'hint', 'info'], motion = null } = {}) {
  const elements = Object.fromEntries(ids.map(id => [id, new Element('div')]));
  elements.bar.hidden = true;
  for (const id of ['menu', 'submenu', 'hint']) if (elements[id]) elements[id].hidden = true;
  const windowEmitter = new Emitter(), documentEmitter = new Emitter(), resizers = [];
  const dom = {
    window: Object.assign(windowEmitter, { coda, innerWidth: 320, innerHeight: 600 }),
    document: Object.assign(documentEmitter, { documentElement: new Element('html'), getElementById: id => elements[id], createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag),
      // 页面是否持有焦点：测试里把 document.windowBlurred 设成 true 模拟窗口失焦。
      hasFocus: () => !globalThis.document.windowBlurred }),
    innerWidth: 320,
    innerHeight: 600,
    // 观察到的尺寸变化：测试改了 clientWidth 之后调用返回的 resize()。
    ResizeObserver: class { constructor(fn) { resizers.push(fn); } observe() {} },
  };
  let motionApi = null;
  if (motion) {
    const listeners = new Set(), animations = [];
    motionApi = { reduce: motion.reduce ?? false, animations, set(reduce) { motionApi.reduce = reduce; for (const fn of listeners) fn({ matches: reduce }); } };
    dom.matchMedia = () => ({ get matches() { return motionApi.reduce; }, addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) });
    Element.prototype.animate = function animate(frames, options) {
      const anim = { el: this, frames, options, finished: false, canceled: false,
        finish() { if (anim.finished || anim.canceled) return; anim.finished = true; anim.onfinish?.(); },
        cancel() { if (anim.finished || anim.canceled) return; anim.canceled = true; anim.oncancel?.(); } };
      animations.push(anim);
      return anim;
    };
    t.after(() => { delete Element.prototype.animate; });
  }
  const saved = Object.fromEntries(Object.keys(dom).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, dom);
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  const app = await import(`../../view/${entry}?instance=${++instance}`);
  return {
    ...elements,
    // 入口模块的导出和尺寸变化。
    app,
    motion: motionApi,
    resize: () => resizers.forEach(fn => fn()),
    // 模块发给页面的消息。
    post: data => windowEmitter.emit({ type: 'message', data }),
  };
}

export const loadFileApp = (t, coda) => loadApp(t, coda, { entry: 'file-app.mjs', ids: ['bar', 'preview', 'notice', 'menu', 'hint'] });
