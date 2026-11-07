// 图标视图：一次看一层（model.cwd）。visibleCells 把模型压成扁平的单元格（纯逻辑），layoutOf 生成布局映射，mountGrid 只画可见的一段，上万条也不卡。
// 设计见 docs/design/phase-3.md 第 14 节。进入、返回、恢复滚动在页面（app.mjs）。
import { h } from './dom.mjs';
import { infoText } from './format.mjs';
import { mountGestures } from './gestures.mjs';
import { icon, iconFor } from './icons.mjs';
import { isHidden, joinPath } from './model.mjs';
import { EntryKind } from './protocol.mjs';
import { TITLES, rootName } from './tree.mjs';

const OVERSCAN = 2; // 上下多画几行

// 单元格：{ type: 'entry', path, name, kind, link, size, mtimeMs } 是条目；{ type: 'status' | 'more', path, text, retry? } 是说明项，独占一行。
// 说明的文字和 tree.mjs 的 visibleRows 一致，只是没有层级。
export function visibleCells(model) {
  const dir = model.cwd, state = model.dirs.get(dir), cells = [];
  const note = (text, retry) => ({ type: 'status', path: dir, text, ...(retry ? { retry } : {}) });
  if (!state || (!state.loaded && !state.error)) return [note('正在读取…')];
  if (!state.loaded) return [note(`读取失败：${state.error.message}`, true)];
  if (state.error) cells.push(note(`更新失败：${state.error.message}`, true)); // 刷新失败：旧条目保留，点它重试
  if (state.sortFallback) cells.push(note('条目太多，只能按名称排列'));
  const before = cells.length;
  for (const entry of state.entries) {
    if (!model.showHidden && isHidden(entry.name)) continue;
    cells.push({ type: 'entry', path: joinPath(dir, entry.name), name: entry.name, kind: entry.kind, link: entry.link === true, size: entry.size, mtimeMs: entry.mtimeMs });
  }
  if (state.next) cells.push({ type: 'more', path: dir, text: state.loading ? '正在读取…' : '再显示' });
  else if (cells.length === before) cells.push(note(state.entries.length ? '只有隐藏项' : '空目录'));
  return cells;
}

// 布局映射：一次生成，总高度、可见窗口、点击都用它。连续的条目各段占 ceil(n / 列数) 行，每个说明项独占一行；列数至少为 1。
// spans：{ from, count, row, rows, note } 按行从上到下。
export function layoutOf(cells, columns) {
  const cols = Math.max(1, Math.floor(columns) || 1), spans = [];
  let rows = 0;
  for (let at = 0; at < cells.length;) {
    if (cells[at].type !== 'entry') { spans.push({ from: at, count: 1, row: rows, rows: 1, note: true }); rows++; at++; continue; }
    let end = at;
    while (end < cells.length && cells[end].type === 'entry') end++;
    const span = { from: at, count: end - at, row: rows, rows: Math.ceil((end - at) / cols), note: false };
    spans.push(span);
    rows += span.rows;
    at = end;
  }
  return { cols, rows, spans };
}

const spanAt = (layout, row) => layout.spans.find(span => row >= span.row && row < span.row + span.rows);
// 这一行第一个单元格的序号。
export const firstOfRow = (layout, row) => { const span = spanAt(layout, row); return span.note ? span.from : span.from + (row - span.row) * layout.cols; };
// 这个序号的单元格在第几行。
export function rowOfCell(layout, index) {
  const span = layout.spans.find(item => index >= item.from && index < item.from + item.count);
  return span.note ? span.row : span.row + Math.floor((index - span.from) / layout.cols);
}
// 行高分两种：条目行 cellH，说明行 noteH（说明行不必和单元格一样高）。布局映射按行记，高度在这里换算，总高度、可见窗口、点击都用同一份。
// 第 row 行顶边的位置；row 等于总行数时是总高度。
export function rowTop(layout, row, cellH, noteH) {
  let y = 0;
  for (const span of layout.spans) {
    const unit = span.note ? noteH : cellH;
    if (row < span.row + span.rows) return y + Math.max(0, row - span.row) * unit;
    y += span.rows * unit;
  }
  return y;
}
// y 落在第几行（向下取整）；超出内容是总行数。
export function rowAt(layout, y, cellH, noteH) {
  let top = 0;
  for (const span of layout.spans) {
    const unit = span.note ? noteH : cellH, height = span.rows * unit;
    if (y < top + height) return span.row + Math.max(0, Math.floor((y - top) / unit));
    top += height;
  }
  return layout.rows;
}
// 顶边在 y 之上的行数（向上取整）：可见窗口画到这一行之前。
export function rowsAbove(layout, y, cellH, noteH) {
  let top = 0;
  for (const span of layout.spans) {
    const unit = span.note ? noteH : cellH, height = span.rows * unit;
    if (y <= top) return span.row;
    if (y < top + height) return span.row + Math.ceil((y - top) / unit);
    top += height;
  }
  return layout.rows;
}

// 第 first 行（含）到第 last 行（不含）的单元格序号范围 [from, to)。
export function windowOf(layout, first, last) {
  if (first >= last) return { from: 0, to: 0 };
  const from = firstOfRow(layout, first), tail = spanAt(layout, last - 1);
  return { from, to: Math.min(tail.from + tail.count, tail.note ? tail.from + 1 : firstOfRow(layout, last - 1) + layout.cols) };
}

// 键盘在图标视图里的一步（纯逻辑）：action 是 up、down、left、right。返回 { select: 序号 } 或 null。
// 上下走同一列：跳过说明项独占的行，目标行不满、没有这一列时选那一行的最后一个；左右在条目之间走（行尾接下一行的第一个）。
// 选中的条目不在 cells 里按没有选中算：↓ 选第一个条目，↑ 选最后一个。
export function stepCells(cells, layout, selected, action) {
  const at = selected === null ? -1 : cells.findIndex(cell => cell.type === 'entry' && cell.path === selected);
  const first = cells.findIndex(cell => cell.type === 'entry');
  if (first < 0) return null;
  if (at < 0) {
    if (action === 'down') return { select: first };
    if (action === 'up') return { select: cells.map(cell => cell.type).lastIndexOf('entry') };
    return null;
  }
  if (action === 'left' || action === 'right') {
    const next = at + (action === 'right' ? 1 : -1);
    return cells[next]?.type === 'entry' ? { select: next } : null;
  }
  const row = rowOfCell(layout, at), column = at - firstOfRow(layout, row), step = action === 'down' ? 1 : -1;
  for (let r = row + step; r >= 0 && r < layout.rows; r += step) {
    const span = spanAt(layout, r);
    if (span.note) continue;
    return { select: Math.min(firstOfRow(layout, r) + column, span.from + span.count - 1) };
  }
  return null;
}

// handlers: { open(path), enter(path), more(path), retry(path), menu(event, cell), back?, select?(path | null) }
// select 是 Mac 单击选中，不给就是 iPhone 的轻点打开。
// back 给了就在头部最左边放「返回」（Mac，和没有原生返回的环境）；不给就没有头部，iPhone 用原生返回，标题在工具条上。
// draggable、longPress、press、consumed 同 mountTree。
// keyboard：滚动容器（.gbody）可以获得焦点，键盘才接得上（Mac）。
export function mountGrid(el, model, handlers, { draggable = true, longPress = false, keyboard = false, press = null, consumed = () => false } = {}) {
  const head = h('div', { class: 'ghead' }), body = h('div', { class: 'gbody' }), spacer = h('div', { class: 'gspacer' }), win = h('div', { class: 'gwin' });
  head.hidden = true;
  if (keyboard) body.tabIndex = 0;
  spacer.append(win);
  body.append(spacer);
  el.replaceChildren(head, body);
  let cells = [], layout = layoutOf([], 1), cellW = 72, cellH = 76, noteH = 32, measuredWidth = -1, headKey = null;

  // 探针放在 win 里：量到的是单元格和说明行在真实结构里的尺寸，两种行高不同。
  const measure = () => {
    const probe = h('div', { class: 'gi cell' }), note = h('div', { class: 'gi gnote' });
    probe.style.visibility = note.style.visibility = 'hidden';
    win.append(probe, note);
    const box = probe.getBoundingClientRect();
    cellW = box.width || cellW;
    cellH = box.height || cellH;
    noteH = note.getBoundingClientRect().height || noteH;
    probe.remove();
    note.remove();
  };
  const columns = () => Math.max(1, Math.floor(body.clientWidth / cellW));

  // 头部：返回、当前目录名。在根目录时没有返回键，标题是根目录名。
  function paintHead() {
    const name = model.cwd === '' ? (model.ready ? rootName(model.root.path) : '') : model.cwd.slice(model.cwd.lastIndexOf('/') + 1);
    const key = `${model.cwd}\n${name}`;
    head.hidden = !handlers.back || name === '';
    if (key === headKey) return;
    headKey = key;
    head.replaceChildren(...(handlers.back && model.cwd !== '' ? [h('button', { class: 'icon', 'aria-label': '返回', title: '返回', onclick: handlers.back }, icon('back', 18))] : []),
      h('span', { class: 'ghico', 'aria-hidden': 'true' }, icon('folder', 22)),
      h('div', { class: 'grow' }, h('div', { class: 'gname-head truncate', title: model.cwd || name }, name)));
  }

  function paint() {
    const top = body.scrollTop - (spacer.offsetTop || 0);
    const first = Math.max(0, rowAt(layout, Math.max(0, top), cellH, noteH) - OVERSCAN);
    const last = Math.min(layout.rows, rowsAbove(layout, top + body.clientHeight, cellH, noteH) + OVERSCAN);
    const { from, to } = windowOf(layout, first, last);
    win.style.transform = `translateY(${from === to ? 0 : rowTop(layout, rowOfCell(layout, from), cellH, noteH)}px)`;
    win.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(0, 1fr))`;
    win.replaceChildren(...cells.slice(from, to).map((cell, i) => cellNode(cell, from + i)));
  }

  function cellNode(cell, index) {
    const node = h('div', { class: 'gi' });
    node.dataset.i = index;
    node.dataset.path = cell.path; // 按下反馈认的身份
    if (cell.type !== 'entry') {
      node.className = `gi gnote ${cell.type}`;
      node.textContent = cell.text;
      if (cell.retry) { node.classList.add('retry'); node.title = cell.text; } // 长原因在行里被截断，Mac 悬停看全
      if (cell.retry || cell.type === 'more') press?.paint(node, 'grid', cell.retry ? 'retry' : 'more', cell.path);
      return node;
    }
    const dead = cell.kind === EntryKind.LINK || cell.kind === EntryKind.OTHER;
    node.className = `gi cell ${cell.kind}${dead ? ' dead' : ''}${cell.path === model.selected ? ' sel' : ''}`;
    press?.paint(node, 'grid', 'entry', cell.path);
    if (!dead && draggable) node.draggable = true;
    // 扩展名前给一个优先断点：package.json 折成 package / .json，不在字母中间断；没有点（或点在最前面）、太长时 overflow-wrap 才在任意位置断。
    const dot = cell.name.lastIndexOf('.');
    const glyph = h('span', { class: 'gico' }, icon(iconFor(cell), 32)), name = h('span', { class: 'gname' }, ...(dot > 0 ? [cell.name.slice(0, dot), h('wbr'), cell.name.slice(dot)] : [cell.name]));
    const info = TITLES[cell.kind] ? '' : infoText(cell);
    node.title = TITLES[cell.kind] ? `${cell.path}\n${TITLES[cell.kind]}` : info ? `${cell.path}\n${info}` : cell.path;
    node.append(glyph, name);
    return node;
  }

  // 按现在的单元格和列数重新生成布局映射。列数变了（拖窄、旋转）：保持第一个可见的单元格还在顶部，不保持像素。
  function rebuild() {
    const cols = columns(), top = Math.max(0, body.scrollTop - (spacer.offsetTop || 0));
    const anchor = cols !== layout.cols && layout.rows && top > 0 ? firstOfRow(layout, Math.min(layout.rows - 1, rowAt(layout, top, cellH, noteH))) : null;
    layout = layoutOf(cells, cols);
    spacer.style.height = `${rowTop(layout, layout.rows, cellH, noteH)}px`;
    if (anchor !== null && anchor < cells.length) body.scrollTop = (spacer.offsetTop || 0) + rowTop(layout, rowOfCell(layout, anchor), cellH, noteH);
  }
  function relayout() {
    if (columns() !== layout.cols) rebuild();
    paint();
  }

  // 点击（iPhone）、双击、⌘↓ 和右键「打开」共用这一份。
  const activate = cell => {
    if (cell.type === 'more') return handlers.more(cell.path);
    if (cell.type === 'status') return cell.retry ? handlers.retry(cell.path) : undefined;
    if (cell.kind === EntryKind.DIR) handlers.enter(cell.path);
    else if (cell.kind === EntryKind.FILE) handlers.open(cell.path);
  };
  // 事件挂在 body 上：头部的返回键点击不算「点空白」。
  const gestures = mountGestures(body, {
    hit: event => cells[event.target.closest?.('.gi')?.dataset.i],
    pressable: cell => cell.type === 'entry',
    activate,
    select: handlers.select && (cell => handlers.select(cell ? cell.path : null)),
    menu: (event, cell) => handlers.menu(event, cell),
    dragText: cell => cell.path,
    longPress,
    consumed,
    scroller: body,
  });
  // 选中变了只在现有节点上切 .sel，不重建：双击的 dblclick 要落在还在容器里的节点上。
  const mark = () => { for (const node of win.children) node.classList.toggle('sel', cells[node.dataset.i]?.type === 'entry' && cells[node.dataset.i].path === model.selected); };
  // 滚到这个单元格能看见，只滚最少的距离。
  const reveal = index => {
    const top = (spacer.offsetTop || 0) + rowTop(layout, rowOfCell(layout, index), cellH, noteH);
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + cellH > body.scrollTop + body.clientHeight) body.scrollTop = top + cellH - body.clientHeight;
    paint();
  };
  body.addEventListener('scroll', paint, { passive: true });
  new ResizeObserver(relayout).observe(body);

  return {
    // 隐藏过的网格显示后宽度变了：重量单元格，再算列数。
    render() {
      if (body.clientWidth !== measuredWidth) { measuredWidth = body.clientWidth; measure(); }
      cells = visibleCells(model);
      rebuild();
      paintHead();
      paint();
    },
    remeasure() { measuredWidth = body.clientWidth; measure(); this.render(); },
    scroll: () => body.scrollTop,
    // 进出目录的淡入：只给内容（win），头部和滚动条不动；返回动画，由页面记着并在需要时结束。
    fadeIn(duration) { return typeof win.animate === 'function' ? win.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease-out' }) : null; },
    scrollTo(top) { body.scrollTop = top; paint(); }, // 浏览器的滚动事件随后还会画一次；这里先画，位置才马上对
    onScroll(fn) { body.addEventListener('scroll', fn, { passive: true }); },
    get layout() { return layout; },
    select: mark,
    activate,
    focus() { body.focus(); },
    onKey(fn) { body.addEventListener('keydown', fn); },
    key(action) {
      const step = stepCells(cells, layout, model.selected, action);
      if (!step) return;
      handlers.select(cells[step.select].path);
      reveal(step.select);
    },
    openSelected() {
      const cell = model.selected === null ? undefined : cells.find(item => item.type === 'entry' && item.path === model.selected);
      if (cell) activate(cell);
    },
    // 切会话时调用：长按的等待和吞点击的标记都属于上一个会话。
    reset() { gestures.reset(); },
    dispose() { gestures.dispose(); },
  };
}
