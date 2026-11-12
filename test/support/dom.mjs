// 最小的假 DOM，只够加载真实的 view/app.mjs：元素树、事件冒泡、classList、textContent，没有布局和选择器引擎。
class Text {
  parent = null;
  constructor(data) { this.data = data; }
  get textContent() { return this.data; }
}

class Emitter {
  #listeners = new Map();
  // 第三个参数同浏览器：true 或 { capture: true } 是捕获阶段的监听。
  addEventListener(type, fn, options) {
    const capture = options === true || options?.capture === true;
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), { fn, capture }]);
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || options?.capture === true;
    this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter(other => other.fn !== fn || other.capture !== capture));
  }
  // 直接发给这个节点上的监听（测试直接 document.emit 用）；phase 只发捕获或冒泡阶段的，缺省全发（按注册顺序）。
  emit(event, phase = 'all') {
    for (const { fn, capture } of [...(this.#listeners.get(event.type) ?? [])]) if (phase === 'all' || (phase === 'capture') === capture) fn(event);
  }
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
  removeAttribute(name) { this.attributes.delete(name); }
  // 音视频和图片的 src：同浏览器，属性和属性值是同一个。
  get src() { return this.attributes.get('src') ?? ''; }
  set src(value) { this.attributes.set('src', String(value)); }

  // 焦点：和浏览器一样，聚焦的元素被摘掉后 activeElement 回到没有。
  focus() { if (!this.inert) globalThis.document.activeElement = this; }
  blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
  select() { this.selected = true; }
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
  prepend(...nodes) {
    const old = this.children;
    this.children = [];
    for (const child of old) child.parent = null;
    this.append(...nodes, ...old);
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
  // 事件传播顺序同真浏览器：document 捕获 → 沿路径从外到里的捕获 → 目标（先捕获后冒泡）→ 沿路径往外冒泡 → document 冒泡。stopPropagation 之后后面的节点收不到。
  dispatch(type, init = {}) {
    let stopped = false;
    const event = { type, target: this, preventDefault() {}, stopPropagation() { stopped = true; }, ...init };
    const path = [];
    for (let at = this; at instanceof Element; at = at.parent) path.push(at);
    const doc = globalThis.document;
    const run = (node, phase) => { if (!stopped) node?.emit?.(event, phase); };
    run(doc, 'capture');
    for (let i = path.length - 1; i > 0; i--) run(path[i], 'capture');
    run(path[0], 'capture');
    run(path[0], 'bubble');
    for (let i = 1; i < path.length; i++) run(path[i], 'bubble');
    run(doc, 'bubble');
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
export async function loadApp(t, coda, { entry = 'app.mjs', ids = ['bar', 'browse', 'searchbar', 'tree', 'grid', 'search', 'preview', 'notice', 'menu', 'submenu', 'hint', 'info'], motion = null } = {}) {
  const elements = Object.fromEntries(ids.map(id => [id, new Element('div')]));
  // 和 index.html 一样：#browse 里是搜索框和三个面板（树页以外的页面没有这些 id）。
  if (elements.browse) elements.browse.append(...['searchbar', 'tree', 'grid', 'search'].map(id => elements[id]));
  elements.bar.hidden = true;
  for (const id of ['menu', 'submenu', 'hint']) if (elements[id]) elements[id].hidden = true;
  const windowEmitter = new Emitter(), documentEmitter = new Emitter(), resizers = [];
  const dom = {
    window: Object.assign(windowEmitter, { coda, innerWidth: 320, innerHeight: 600 }),
    document: Object.assign(documentEmitter, { documentElement: new Element('html'), getElementById: id => elements[id], createElement: tag => new Element(tag), createRange: () => globalThis.fakeRange?.(), createElementNS: (_ns, tag) => new Element(tag),
      // 页面是否持有焦点：测试里把 document.windowBlurred 设成 true 模拟窗口失焦。
      hasFocus: () => !globalThis.document.windowBlurred }),
    innerWidth: 320,
    innerHeight: 600,
    // 观察到的尺寸变化：测试改了 clientWidth 之后调用返回的 resize()。
    ResizeObserver: class { constructor(fn) { resizers.push(fn); } observe() {} disconnect() {} },
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
