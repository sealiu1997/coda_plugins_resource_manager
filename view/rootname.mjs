// 根目录的名字，四处共用：Mac 目录树标题、iPhone 页内工具条的标题、图标视图头部、系统返回的路径（设计见 docs/design/phase-3.md 第 19 节）。
// 普通目录是路径的最后一段；worktree 会话（模块反查到了 project，原仓库的文件夹名）写成 `<项目名> worktree-<编号>`，中间是空格，缩写是 `<项目名> wt-<编号>`。
// 编号是 worktree 目录名为 UUID 时的前 4 位，否则整个目录名。Coda 的 worktree 目录以 UUID 命名，只显示目录名认不出项目。
// 页面里两段是两个元素：项目名（.rn-name，继承标题的粗体）和后缀（.rn-tag，常规字重、三级灰、小一号，样式在 style.css）；空格归后缀那一段。系统返回只能是纯文字（rootLabel）。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELLIPSIS = '…';
const MIN_PROJECT = 2; // 项目名从中间省略时至少留的字数（字素簇）
const ROOMY = 0.9; // 完整写法不超过可用宽度的 90% 才完整显示：宽度够时不贴边

export const baseName = path => path.split('/').filter(Boolean).pop() ?? path;
export const tagOf = name => (UUID.test(name) ? name.slice(0, 4) : name);

// 后缀（带前面的空格）：长的是 ` worktree-<编号>`，短的是 ` wt-<编号>`。
const suffixOf = (root, short) => ` ${short ? 'wt' : 'worktree'}-${tagOf(baseName(root.path))}`;

// 完整写法：系统返回的文字由客户端排版，直接用它，不省略。
export const rootLabel = root => (root.project ? `${root.project}${suffixOf(root, false)}` : baseName(root.path));

// 按字素簇切（Intl.Segmenter），不能按 UTF-16 切：emoji、非 BMP 的汉字、组合字符会被切坏；没有 Segmenter 时退回按码点。
const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export const glyphs = text => (segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text));

// 项目名从中间省略（同 Finder，保留首尾），留 keep 个字；多出来的一个字给前面。
const middle = (chars, keep) => `${chars.slice(0, Math.ceil(keep / 2)).join('')}${ELLIPSIS}${chars.slice(chars.length - Math.floor(keep / 2)).join('')}`;

// 放不下时按顺序省略，前一步放得下就停。measure(text, role) 是文字的宽度：role 是 'name'（项目名）或 'tag'（后缀，含前面的空格），两段字体不同，要各按各的量；
// width 是可用宽度，单位自定，两者一致即可。
// 1 完整写法不超过 width 的 90%：完整显示；2 后缀缩成 wt-<编号>，整行放得下（100%）就停；3 项目名从中间省略，至少留 2 个字；4 整段从尾部省略（在第 3 步的最短形式上）。
// 字都按字素簇数；wt-<编号> 在第 4 步前不省略。
// 返回 { name, tag, text, step }：name、tag 是两段文字，text 是它们连起来；step 0 是没有项目名的普通目录（name 就是文件夹名，tag 空）：不在这里省略，交给 CSS 的 text-overflow（和从前一样）。
const result = (name, tag, step) => ({ name, tag, text: `${name}${tag}`, step });
export function fitRootLabel(root, width, measure) {
  if (!root.project) return result(baseName(root.path), '', 0);
  const { project } = root, long = suffixOf(root, false), short = suffixOf(root, true), chars = glyphs(project);
  const size = (name, tag) => measure(name, 'name') + measure(tag, 'tag');
  if (size(project, long) <= width * ROOMY) return result(project, long, 1);
  if (size(project, short) <= width) return result(project, short, 2);
  for (let keep = chars.length - 1; keep >= MIN_PROJECT; keep--) {
    const name = middle(chars, keep);
    if (size(name, short) <= width) return result(name, short, 3);
  }
  const nameChars = glyphs(chars.length > MIN_PROJECT ? middle(chars, MIN_PROJECT) : project), all = [...nameChars, ...glyphs(short)];
  // 取前 length 个字，补一个省略号（截在项目名中间的省略号上时不再叠一个）；省略号跟着最后一个字所在的那段。
  const cut = length => {
    const head = all.slice(0, Math.max(1, length));
    while (head.length > 1 && head.at(-1) === ' ') head.pop(); // 空格后面不跟省略号
    const text = head.at(-1) === ELLIPSIS ? head : [...head, ELLIPSIS];
    return head.length <= nameChars.length ? { name: text.join(''), tag: '' } : { name: nameChars.join(''), tag: text.slice(nameChars.length).join('') };
  };
  const fits = length => { const { name, tag } = cut(length); return size(name, tag) <= width; };
  let lo = 0, hi = all.length - 1; // 最长的放得下的前缀（至少留一个字）；宽度对前缀长度单调
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  const { name, tag } = cut(lo);
  return result(name, tag, 4);
}

// 页面里量文字：用元素自己的字体在 canvas 上量（项目名和后缀的字号、字重不同，各量各的）。没有 canvas（测试的假 DOM）时一个字算 1。
// 每次量之前都设字体：几个量字函数共用一个 canvas 上下文。
let canvas = null;
export function measurerOf(el) {
  let context = null;
  try { context = (canvas ??= globalThis.document.createElement('canvas')).getContext?.('2d') ?? null; } catch { /* 没有 canvas */ }
  const style = globalThis.getComputedStyle?.(el);
  if (!context || !style) return text => text.length;
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return text => { context.font = font; return context.measureText(text).width; };
}

// 元素里能放文字的宽度：内容宽，再留 2 个像素给量字的误差。没排版（隐藏、display: none）时是 0，不省略。
export function widthOf(el) {
  if (!el.clientWidth) return 0;
  const style = globalThis.getComputedStyle?.(el), pad = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 0;
  return el.clientWidth - pad - (style ? 2 : 0);
}

// 元素里的两段（项目名、后缀）：元素的内容不是它们（换过别的文字）就重建。
const spans = new WeakMap();
function spansOf(el) {
  let pair = spans.get(el);
  if (!pair || !el.contains(pair.name) || !el.contains(pair.tag)) {
    const make = className => Object.assign(globalThis.document.createElement('span'), { className });
    pair = { name: make('rn-name'), tag: make('rn-tag') };
    spans.set(el, pair);
    el.replaceChildren(pair.name, pair.tag);
  }
  return pair;
}

// 把根目录名写进元素：worktree 写成两段（项目名、后缀），按元素现在的宽度省略；普通目录就是一个文本节点，交给 CSS 截断。宽度变了再调一次。
// 元素还没有宽度（隐藏）时写完整写法（第 1 步），显示出来、有了宽度之后再调。measure（可选）按 (text, role) 量，测试注入；返回写进去的 { name, tag, text, step }。
export function paintRootName(el, root, measure = null) {
  if (!root.project) {
    const plain = result(baseName(root.path), '', 0);
    if (spans.delete(el) || el.textContent !== plain.text) el.textContent = plain.text; // 从两段换回纯文字：整个换掉
    return plain;
  }
  const pair = spansOf(el), width = widthOf(el);
  let fit = result(root.project, suffixOf(root, false), 1);
  if (width > 0) {
    const names = measurerOf(pair.name), tags = measurerOf(pair.tag);
    fit = fitRootLabel(root, width, measure ?? ((text, role) => (role === 'tag' ? tags : names)(text)));
  }
  if (pair.name.textContent !== fit.name) pair.name.textContent = fit.name;
  if (pair.tag.textContent !== fit.tag) pair.tag.textContent = fit.tag;
  return fit;
}
