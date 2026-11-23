// 富文本预览（Markdown、之后的 HTML）里查找、选区、锚点共用的三样东西，不放别的。
// 块标签和单元格标签：块的边界对应换行，单元格的边界对应制表符，选区提取要分得开；查找里两种边界一样，都是匹配不能跨过的地方。
export const BLOCK_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'HR', 'DIV', 'DETAILS', 'SUMMARY']);
export const CELL_TAGS = new Set(['TD', 'TH']);

// 标记富文本预览中不属于正文的操作控件（如「复制邮箱」按钮）：提取正文（标题锚点、选区复制/添加到聊天）和查找建索引时共用此区分。
export const RICH_UI_ATTR = 'data-rich-ui';

const parentOf = node => node.parentNode ?? node.parent ?? null;
const isElement = node => typeof node.tagName === 'string';
// <details> 的可见摘要：第一个 summary 子元素，不要求它是第一个子节点。
const visibleSummary = details => {
  for (const child of details.childNodes ?? details.children ?? []) if (isElement(child) && child.tagName.toUpperCase() === 'SUMMARY') return child;
  return null;
};

// 遮住 node 的 <details>（收起着，node 又不在它的可见摘要里）；有几层取最外层，没有返回 null。
// 外层收起时，里层的摘要也看不见，所以只要沿途有一层遮住就算被遮住。
export function hiddenByDetails(node) {
  let outermost = null;
  for (let child = node, parent = parentOf(node); parent; child = parent, parent = parentOf(parent)) {
    if (isElement(parent) && parent.tagName.toUpperCase() === 'DETAILS' && parent.getAttribute('open') === null && visibleSummary(parent) !== child) outermost = parent;
  }
  return outermost;
}
