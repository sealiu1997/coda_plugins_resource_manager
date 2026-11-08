// 目录树：visibleRows 把模型压成扁平行（纯逻辑）；mountTree 只画可见的那一段，上万条也不卡。
import { EntryKind, SortKey, isHidden } from './protocol.mjs';
import { dateText, infoText, sizeText, subText } from './format.mjs';
import { mountGestures } from './gestures.mjs';
import { icon, iconFor } from './icons.mjs';
import { joinPath, parentOf } from './model.mjs';

const OVERSCAN = 8;

// 行：{ type: 'entry' | 'status' | 'more', path, name, depth, kind, link, size, mtimeMs, open, busy, failed, text }；size、mtimeMs 读不到时没有
export function visibleRows(model) {
  const rows = [];
  const walk = (dir, depth) => {
    const state = model.dirs.get(dir);
    if (!state || (!state.loaded && !state.error)) return rows.push({ type: 'status', path: dir, depth, text: '正在读取…' });
    if (!state.loaded) return rows.push({ type: 'status', path: dir, depth, text: `读取失败：${state.error.message}`, retry: true });
    // 刷新失败：旧条目保留，最上方加一行原因，点它重试。这一行不算内容，空目录的判断在它之后。
    if (state.error) rows.push({ type: 'status', path: dir, depth, text: `更新失败：${state.error.message}`, retry: true });
    // 条目太多按名称排了：说明行固定行高，不算内容，不影响「空目录」的判断。
    if (state.sortFallback) rows.push({ type: 'status', path: dir, depth, text: '条目太多，只能按名称排列' });
    const before = rows.length;
    for (const entry of state.entries) {
      if (!model.showHidden && isHidden(entry.name)) continue;
      const path = joinPath(dir, entry.name), open = entry.kind === EntryKind.DIR && model.expanded.has(path);
      rows.push({
        type: 'entry', path, name: entry.name, depth, kind: entry.kind, link: entry.link === true, size: entry.size, mtimeMs: entry.mtimeMs, open,
        busy: open && model.dirs.get(path)?.loading === true, failed: open ? model.dirs.get(path)?.error?.message : undefined,
      });
      if (open) walk(path, depth + 1);
    }
    if (state.next) rows.push({ type: 'more', path: dir, depth, text: state.loading ? '正在读取…' : '再显示' });
    else if (rows.length === before) rows.push({ type: 'status', path: dir, depth, text: state.entries.length ? '只有隐藏项' : '空目录' });
  };
  walk('', 0);
  return rows;
}

// 键盘在列表里的一步（纯逻辑）：action 是 up、down、left、right。返回 { select: 序号 }（选中那一行）、{ toggle: 序号 }（展开或收起那一行）或 null。
// 选中的条目不在 rows 里（被删、被藏）按没有选中算：↓ 选第一个条目，↑ 选最后一个；说明行和「再显示」跳过。
export function stepRows(rows, selected, action) {
  const entries = [];
  rows.forEach((row, i) => { if (row.type === 'entry') entries.push(i); });
  if (entries.length === 0) return null;
  const at = selected === null ? -1 : rows.findIndex(row => row.type === 'entry' && row.path === selected);
  if (action === 'up' || action === 'down') {
    if (at < 0) return { select: action === 'down' ? entries[0] : entries[entries.length - 1] };
    const next = entries[entries.indexOf(at) + (action === 'down' ? 1 : -1)];
    return next === undefined ? null : { select: next };
  }
  if (at < 0) return null;
  const row = rows[at], folder = row.kind === EntryKind.DIR;
  if (action === 'right') return folder && !row.open ? { toggle: at } : null;
  if (folder && row.open) return { toggle: at }; // ←：展开的文件夹先收起
  const parent = parentOf(row.path); // 已收起或是文件：选中它所在的文件夹（它一定在 rows 里，不管有没有画出来）
  const up = parent === '' ? -1 : rows.findIndex(item => item.type === 'entry' && item.path === parent);
  return up < 0 ? null : { select: up };
}

// 根目录的名字：路径的最后一段，分区标题和 iPhone 的页内工具条共用。
export const rootName = path => path.split('/').filter(Boolean).pop() ?? path;

export const TITLES = { [EntryKind.LINK]: '指向工作目录外的链接，不能打开', [EntryKind.OTHER]: '不能打开的文件' };

// handlers: { open(path), toggle(path), more(path), retry(path), menu(event, row), select(path | null) }；select 是 Mac 单击选中，不给就是 iPhone 的轻点打开
// 搜索结果复用这份画行和虚拟列表（设计见 docs/design/phase-3.md 第 18.3 节）：rows() 给行（缺省是目录树的 visibleRows），selected() 给选中的路径（缺省 model.selected），
// view 是按下反馈里的画面名（'tree' 或 'search'，search 的行带 .hit），title 为假时没有根目录名的分区标题。
// 结果行多三个字段：place（所在目录，Mac 在右侧、iPhone 在第二行）、bold（名字里要加粗的 [起点, 终点)）、chevron: false（没有展开箭头的位置）。
// menu 收到整行（路径、种类、大小、修改时间）。
// draggable：触屏上拖行没有用处，还会抢滚动，关掉。now：当前时间，日期的相对格式用，测试可注入。
// longPress：触屏上按住一行打开 handlers.menu（Mac 用右键）。不设 touch-action，滚动照旧，滚动接管时收到 pointercancel 作废。
// keyboard：滚动容器可以获得焦点，键盘才接得上（Mac）。
// press：按下反馈（press.mjs），画行时问它这一行是不是正在按下的；consumed(event)：菜单消费掉的按下（gestures.mjs）。
export function mountTree(el, model, handlers, {
  draggable = true, longPress = false, keyboard = false, now = Date.now, press = null, consumed = () => false,
  rows: rowsOf = () => visibleRows(model), selected = () => model.selected, view = 'tree', title: showTitle = true,
} = {}) {
  const title = document.createElement('div'), spacer = document.createElement('div'), win = document.createElement('div');
  title.className = 'section truncate'; spacer.className = 'spacer'; win.className = 'win';
  title.hidden = true;
  spacer.append(win);
  el.replaceChildren(title, spacer);
  if (keyboard) el.tabIndex = 0;
  let rows = [], rowH = 24;

  // 探针放在 spacer 里：量到的是行在真实结构里的高度。
  const measure = () => {
    const probe = document.createElement('div');
    probe.className = 'row';
    probe.style.visibility = 'hidden';
    spacer.append(probe);
    rowH = probe.getBoundingClientRect().height || rowH;
    probe.remove();
  };

  // 分区标题：根目录的名字（root.path 的最后一段），不是 ready 时不显示。iPhone 上由 CSS 隐藏。
  const paintTitle = () => {
    const text = showTitle && model.ready ? rootName(model.root.path) : '';
    if (title.textContent !== text) title.textContent = text;
    title.hidden = text === '';
  };

  // 标题在滚动容器里，把 spacer 推下去 offsetTop：行的位置按 spacer 内部算，滚动值（保存和恢复的）仍是容器的。
  function paint() {
    const top = el.scrollTop - (spacer.offsetTop || 0);
    const first = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((top + el.clientHeight) / rowH) + OVERSCAN);
    win.style.transform = `translateY(${first * rowH}px)`;
    const time = now();
    win.replaceChildren(...rows.slice(first, last).map((row, i) => rowNode(row, first + i, time)));
  }

  function rowNode(row, index, time) {
    const node = document.createElement('div');
    node.className = `row ${row.type}`;
    node.dataset.i = index;
    node.style.cssText = `--d: ${row.depth}`; // 缩进由 CSS 按 --d 算，分隔线的起点也用它
    node.dataset.path = row.path; // 按下反馈认的身份：同一路径的条目、「重试」说明行、「再显示」靠种类区分
    if (row.type !== 'entry') {
      node.textContent = row.text;
      if (row.retry) { node.classList.add('retry'); node.title = row.text; } // 长原因在行里被截断，Mac 悬停看全
      if (row.retry || row.type === 'more') press?.paint(node, view, row.retry ? 'retry' : 'more', row.path);
      return node;
    }
    press?.paint(node, view, 'entry', row.path);
    if (view === 'search') node.classList.add('hit');
    const dead = row.kind === EntryKind.LINK || row.kind === EntryKind.OTHER;
    node.classList.add(row.kind);
    if (dead) node.classList.add('dead');
    if (row.path === selected()) node.classList.add('sel');
    if (row.kind === EntryKind.DIR) node.setAttribute('aria-expanded', row.open);
    if (!dead && draggable) node.draggable = true;
    // 一份 DOM：箭头、图标、名字（iPhone 下面跟日期 · 大小）、Mac 的 meta、尾标；iPhone 的箭头用 CSS order 排到最后，两端各用 CSS 藏起另一端的那段。
    const chevron = document.createElement('span'), glyph = document.createElement('span'), main = document.createElement('span'), label = document.createElement('span'), tail = document.createElement('span');
    chevron.className = 'chev';
    if (row.busy) chevron.textContent = '…';
    else if (!dead && row.chevron !== false) chevron.append(icon('chevron', 12)); // 文件的箭头 Mac 上由 CSS 藏起来，只占位
    if (row.open) node.classList.add('open');
    glyph.className = 'ico';
    glyph.append(icon(iconFor(row)));
    main.className = 'main';
    label.className = 'name truncate';
    if (row.bold) label.append(row.name.slice(0, row.bold[0]), Object.assign(document.createElement('b'), { textContent: row.name.slice(...row.bold) }), row.name.slice(row.bold[1]));
    else label.textContent = row.name;
    main.append(label);
    const parts = row.chevron === false ? [glyph, main] : [chevron, glyph, main];
    {
      // 能打开的条目带信息；link、other 没有。文件夹没有的部分整个不画：iPhone 名字垂直居中，Mac 右侧不留空位。
      // 搜索结果的所在目录（row.place）不受 dead 影响：失效的链接和 other 也要看得出在哪。
      const subContent = row.place ?? (dead ? '' : subText(row, time)), metaContent = row.place ?? (dead ? '' : model.sort === SortKey.DATE ? dateText(row, time) : sizeText(row));
      if (subContent) {
        const sub = document.createElement('span');
        sub.className = 'sub caption secondary truncate';
        sub.textContent = subContent;
        main.append(sub);
      }
      if (metaContent) {
        const meta = document.createElement('span');
        meta.className = 'meta caption secondary';
        meta.textContent = metaContent;
        parts.push(meta);
      }
    }
    tail.className = row.failed ? 'tail warn' : 'tail';
    if (row.failed) tail.append(icon('warning', 14));
    else if (row.link) tail.append(icon('turn', 14));
    const info = row.failed || TITLES[row.kind] || row.place !== undefined ? '' : infoText(row);
    node.title = row.failed ? `${row.path}\n读取失败：${row.failed}` : TITLES[row.kind] ? `${row.path}\n${TITLES[row.kind]}` : info ? `${row.path}\n${info}` : row.path;
    node.append(...parts, tail);
    return node;
  }

  // 点击（iPhone）、双击、⌘↓ 和右键「打开」共用这一份：文件夹展开或收起，文件打开，说明行执行它的动作。
  const activate = row => {
    if (row.type === 'more') return handlers.more(row.path);
    if (row.type === 'status') return row.retry ? handlers.retry(row.path) : undefined;
    if (row.kind === EntryKind.DIR) handlers.toggle(row.path);
    else if (row.kind === EntryKind.FILE) handlers.open(row.path);
  };
  const gestures = mountGestures(el, {
    hit: event => rows[event.target.closest?.('.row')?.dataset.i],
    pressable: row => row.type === 'entry',
    activate,
    select: handlers.select && (row => handlers.select(row ? row.path : null)),
    direct: (event, row) => row.kind === EntryKind.DIR && !!event.target.closest?.('.chev'), // 展开箭头：展开或收起，选中不变
    menu: (event, row) => handlers.menu(event, row),
    dragText: row => row.path,
    longPress,
    consumed,
  });
  // 选中变了只在现有节点上切 .sel，不重建：双击的 dblclick 要落在还在容器里的节点上。
  const mark = () => { for (const node of win.children) node.classList.toggle('sel', rows[node.dataset.i]?.path === selected() && rows[node.dataset.i]?.type === 'entry'); };
  // 滚到这一行能看见，只滚最少的距离；按行号算位置，不找节点（没画出来的行也行）。
  const reveal = index => {
    const top = (spacer.offsetTop || 0) + index * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
    paint();
  };
  // 滚到这一行在可见区中间（定位操作的最后一步）；找不到返回 false。rows 要是最新的：调用前先 render()。
  const center = path => {
    const index = rows.findIndex(row => row.type === 'entry' && row.path === path);
    if (index < 0) return false;
    el.scrollTop = Math.max(0, (spacer.offsetTop || 0) + index * rowH - (el.clientHeight - rowH) / 2);
    paint();
    return true;
  };
  el.addEventListener('scroll', paint, { passive: true });
  new ResizeObserver(paint).observe(el);

  return {
    render() { rows = rowsOf(); spacer.style.height = `${rows.length * rowH}px`; paintTitle(); paint(); },
    remeasure() { measure(); this.render(); },
    scroll: () => el.scrollTop,
    scrollTo(top) { el.scrollTop = top; paint(); },
    select: mark,
    center,
    activate,
    focus() { el.focus(); },
    onKey(fn) { el.addEventListener('keydown', fn); },
    // 键盘一步：选中移动并滚到能看见，→ ← 展开收起。
    key(action) {
      const step = stepRows(rows, selected(), action);
      if (!step) return;
      if (step.toggle !== undefined) return handlers.toggle(rows[step.toggle].path);
      handlers.select(rows[step.select].path);
      reveal(step.select);
    },
    // ⌘↓：和双击同一个动作；没有选中或选中的不在了什么都不做。
    openSelected() {
      const row = selected() === null ? undefined : rows.find(item => item.type === 'entry' && item.path === selected());
      if (row) activate(row);
    },
    // 切会话时调用：长按的等待和吞点击的标记都属于上一个会话。
    reset() { gestures.reset(); },
  };
}
