// 预览里选中的文字：裁到正文元素里面，算出覆盖的行。DOM 的部分只用 Range 的标准方法，行号是纯函数。
const START_TO_START = 0, END_TO_END = 2; // Range.START_TO_START、Range.END_TO_END

// el 是正文（一个 pre，里面是文本节点，上色后还有嵌套的 span）。选区为空或和 el 不相交返回 null；
// 否则把选区裁到 el 里，返回 { text, start }：裁剪后的文字和它在 el 文字里的起点（UTF-16 偏移）。裁剪后为空也返回 null。
// 选区的起点或终点落在 el 外面（跨出正文、从行号列开始拖）时，裁掉外面的部分。
export function clippedSelection(el, selection = globalThis.getSelection?.()) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(el)) return null;
  const whole = document.createRange();
  whole.selectNodeContents(el);
  const clipped = range.cloneRange();
  if (range.compareBoundaryPoints(START_TO_START, whole) < 0) clipped.setStart(whole.startContainer, whole.startOffset);
  if (range.compareBoundaryPoints(END_TO_END, whole) > 0) clipped.setEnd(whole.endContainer, whole.endOffset);
  const text = clipped.toString();
  if (text === '') return null;
  const before = whole.cloneRange();
  before.setEnd(clipped.startContainer, clipped.startOffset);
  return { text, start: before.toString().length };
}

const BLOCK_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'HR', 'DIV']);
const CELL_TAGS = new Set(['TD', 'TH']);

// 标记富文本预览中不属于正文的操作控件（如「复制邮箱」按钮）：提取正文（标题锚点、选区复制/添加到聊天）时共用此区分。
export const RICH_UI_ATTR = 'data-rich-ui';

export function isRichUiControl(node) {
  return Boolean(node?.getAttribute?.(RICH_UI_ATTR) != null || node?.dataset?.richUi !== undefined);
}

// 提取富文本节点的纯正文文本（跳过带 RICH_UI_ATTR 的操作控件）。
export function richTextContent(node) {
  if (!node) return '';
  if (typeof node === 'string' || typeof node.data === 'string' || node.nodeType === 3) {
    return typeof node === 'string' ? node : (node.data ?? node.textContent ?? '');
  }
  if (isRichUiControl(node)) return '';
  let out = '';
  for (const child of node.childNodes ?? node.children ?? []) out += richTextContent(child);
  return out;
}

// 富文本预览（如 Markdown）的选区提取：复用 clippedSelection 的选区裁剪，按可见块级结构与 <br> 保留换行、跨越的表格单元格（含空单元格）保留完整制表符，并跳过操作控件文字同时保持字符偏移准确。
export function clippedRichSelection(el, selection = globalThis.getSelection?.()) {
  const picked = clippedSelection(el, selection);
  if (!picked) return null;
  const selStart = picked.start, selEnd = picked.start + picked.text.length;
  let pos = 0, out = '', lastBlock = null, lastCell = null, pendingBreak = false, pendingTabs = 0;
  function walk(node, block, cell, skip = false) {
    if (typeof node === 'string' || typeof node.data === 'string' || node.nodeType === 3) {
      const str = typeof node === 'string' ? node : (node.data ?? node.textContent ?? '');
      const len = str.length;
      if (!skip) {
        const lo = Math.max(0, selStart - pos), hi = Math.min(len, selEnd - pos);
        if (hi > lo) {
          if (out !== '') {
            if (pendingBreak || (lastBlock !== null && lastBlock !== block)) out += '\n';
            else if (pendingTabs > 0) out += '\t'.repeat(pendingTabs);
            else if (lastCell !== null && lastCell !== cell) out += '\t';
          }
          out += str.slice(lo, hi);
          lastBlock = block;
          lastCell = cell;
          pendingBreak = false;
          pendingTabs = 0;
        }
      }
      pos += len;
      return;
    }
    const nextSkip = skip || isRichUiControl(node);
    const tag = node.tagName?.toUpperCase?.() ?? '';
    if (tag === 'BR') {
      if (!nextSkip && pos > selStart && pos < selEnd) pendingBreak = true;
      return;
    }
    const nextBlock = !nextSkip && node !== el && BLOCK_TAGS.has(tag) ? node : block;
    const isCell = !nextSkip && CELL_TAGS.has(tag);
    if (isCell && out !== '' && pos >= selStart && pos < selEnd && lastBlock === nextBlock && lastCell !== null && lastCell !== node) {
      pendingTabs++;
    }
    const nextCell = isCell ? node : cell;
    for (const child of node.childNodes ?? node.children ?? []) walk(child, nextBlock, nextCell, nextSkip);
  }
  walk(el, el, null, false);
  return out === '' ? null : { text: out, start: selStart };
}

const lineAt = (text, offset) => {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) line++;
  return line;
};

// 选中 text[start, end) 覆盖的行（从 1 数）。选区的结尾正好在行首时（如三击选行，选区包含那一行的换行）不算下一行。
export function linesOf(text, start, end) {
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  return { startLine: lineAt(text, start), endLine: lineAt(text, Math.max(start, last)) };
}
