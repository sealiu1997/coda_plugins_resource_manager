// 根目录的名字，四处共用：Mac 目录树标题、iPhone 页内工具条的标题、图标视图头部、系统返回的路径（设计见 docs/design/phase-3.md 第 19 节）。
// 普通目录是路径的最后一段；worktree 会话（模块反查到了 project，原仓库的文件夹名）写成 `<项目名>-wt-<编号>`，
// 编号是 worktree 目录名为 UUID 时的前 4 位，否则整个目录名。Coda 的 worktree 目录以 UUID 命名，只显示目录名认不出项目。
export const WT = '-wt-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELLIPSIS = '…';
const MIN_PROJECT = 2; // 项目名从中间省略时至少留的字数（字素簇）

export const baseName = path => path.split('/').filter(Boolean).pop() ?? path;
export const tagOf = name => (UUID.test(name) ? name.slice(0, 4) : name);

// 完整写法：系统返回的文字由客户端排版，直接用它，不省略。
export const rootLabel = root => (root.project ? `${root.project}${WT}${tagOf(baseName(root.path))}` : baseName(root.path));

// 按字素簇切（Intl.Segmenter），不能按 UTF-16 切：emoji、非 BMP 的汉字、组合字符会被切坏；没有 Segmenter 时退回按码点。
const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export const glyphs = text => (segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text));

// 项目名从中间省略（同 Finder，保留首尾），留 keep 个字；多出来的一个字给前面。
const middle = (chars, keep) => `${chars.slice(0, Math.ceil(keep / 2)).join('')}${ELLIPSIS}${chars.slice(chars.length - Math.floor(keep / 2)).join('')}`;

// 放不下时按顺序省略，前一步放得下就停（measure(text) 是文字的宽度，width 是可用宽度，单位自定，两者一致即可）：
// 1 完整；2 项目名从中间省略，至少留 2 个字，`-wt-<编号>` 不动；3 整段从尾部省略（在第 2 步的最短形式上）。字都按字素簇数。
// 返回 { text, step }；step 0 是没有项目名的普通目录：不在这里省略，交给 CSS 的 text-overflow（和从前一样）。
export function fitRootLabel(root, width, measure) {
  if (!root.project) return { text: rootLabel(root), step: 0 };
  const { project } = root, tail = `${WT}${tagOf(baseName(root.path))}`, full = `${project}${tail}`, chars = glyphs(project);
  if (measure(full) <= width) return { text: full, step: 1 };
  for (let keep = chars.length - 1; keep >= MIN_PROJECT; keep--) {
    const text = `${middle(chars, keep)}${tail}`;
    if (measure(text) <= width) return { text, step: 2 };
  }
  const shortest = glyphs(`${chars.length > MIN_PROJECT ? middle(chars, MIN_PROJECT) : project}${tail}`);
  const cut = length => { const head = shortest.slice(0, Math.max(1, length)); return head.at(-1) === ELLIPSIS ? head.join('') : `${head.join('')}${ELLIPSIS}`; }; // 截在项目名中间的省略号上时不再叠一个
  let lo = 0, hi = shortest.length - 1; // 最长的放得下的前缀（至少留一个字）；宽度对前缀长度单调
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(cut(mid)) <= width) lo = mid; else hi = mid - 1;
  }
  return { text: cut(lo), step: 3 };
}

// 页面里量文字：用元素自己的字体（.section 和工具条标题字号不同）在 canvas 上量。没有 canvas（测试的假 DOM）时一个字算 1。
let canvas = null;
export function measurerOf(el) {
  let context = null;
  try { context = (canvas ??= globalThis.document.createElement('canvas')).getContext?.('2d') ?? null; } catch { /* 没有 canvas */ }
  const style = globalThis.getComputedStyle?.(el);
  if (!context || !style) return text => text.length;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return text => context.measureText(text).width;
}

// 元素里能放文字的宽度：内容宽，再留 2 个像素给量字的误差。没排版（隐藏、display: none）时是 0，不省略。
export function widthOf(el) {
  if (!el.clientWidth) return 0;
  const style = globalThis.getComputedStyle?.(el), pad = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 0;
  return el.clientWidth - pad - (style ? 2 : 0);
}

// 把根目录名写进元素：worktree 按元素现在的宽度省略；放不下的步骤和宽度的比较在 fitRootLabel。宽度变了再调一次。
// 元素还没有宽度（隐藏）时写完整写法，显示出来、有了宽度之后再调。返回写进去的 { text, step }。
export function paintRootName(el, root, measure = null) {
  const width = widthOf(el), result = width > 0 ? fitRootLabel(root, width, measure ?? measurerOf(el)) : { text: rootLabel(root), step: root.project ? 1 : 0 };
  if (el.textContent !== result.text) el.textContent = result.text;
  return result;
}
