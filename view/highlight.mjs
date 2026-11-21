// 语法高亮：调用 highlight.js，把它的输出解析成节点。文件内容不经过 HTML 解析，所以 CR、NUL 和未配对的代理项都原样保留。
// highlight.js 的输出只有 <span class="…">、</span> 和五种转义；格式之外的任何内容都算失败，调用方显示纯文本。
import hljs from './vendor/highlight/highlight.min.mjs';
import dart from './vendor/highlight/languages/dart.min.mjs';
import dockerfile from './vendor/highlight/languages/dockerfile.min.mjs';
import scala from './vendor/highlight/languages/scala.min.mjs';
import { h } from './dom.mjs';

hljs.registerLanguage('dart', dart);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('scala', scala);

// 超过这个字节数不高亮（实测依据和为什么是 128 KiB 见 docs/design/phase-3.md 第 15.4 节）。
export const HIGHLIGHT_LIMIT = 128 * 1024;
// 有一行超过这个字符数（UTF-16 长度）也不高亮：压成一行的文件上色慢，也帮不上阅读（第 15.4 节）。
export const LINE_LIMIT = 5000;

// 有没有一行超过 LINE_LIMIT：按 \n 分行（\r 留在行里），只扫一遍，不建数组。
export function hasLongLine(text) {
  for (let start = 0; start < text.length;) {
    const end = text.indexOf('\n', start);
    if ((end < 0 ? text.length : end) - start > LINE_LIMIT) return true;
    if (end < 0) break;
    start = end + 1;
  }
  return false;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };
const ENTITY = /&(?:amp|lt|gt|quot|#x27);/y;
const OPEN = /<span class="([A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*)">/y;
const CLOSE = '</span>';
const NEXT = /[<&]/g;
const CHUNK = 2000; // append(...nodes) 的参数个数有上限，节点多的时候分批

export function appendAll(parent, nodes) {
  for (let at = 0; at < nodes.length; at += CHUNK) parent.append(...nodes.slice(at, at + CHUNK));
}

// 解析 html，返回顶层节点（字符串和 span 元素）；格式不对返回 null。expected：原文的长度，文字总长不符也算格式不对。
export function parse(html, expected) {
  const stack = [{ nodes: [], cls: null }];
  let at = 0, length = 0;
  const push = text => {
    const { nodes } = stack.at(-1);
    length += text.length;
    if (typeof nodes.at(-1) === 'string') nodes[nodes.length - 1] += text; else nodes.push(text);
  };
  while (at < html.length) {
    NEXT.lastIndex = at;
    const found = NEXT.exec(html);
    const next = found ? found.index : html.length;
    if (next > at) push(html.slice(at, next));
    if (!found) break;
    at = next;
    if (html[at] === '&') {
      ENTITY.lastIndex = at;
      const entity = ENTITY.exec(html);
      if (!entity) return null;
      push(ENTITIES[entity[0]]);
      at += entity[0].length;
    } else if (html.startsWith(CLOSE, at)) {
      if (stack.length === 1) return null;
      const { nodes, cls } = stack.pop();
      const span = h('span', { class: cls });
      appendAll(span, nodes);
      stack.at(-1).nodes.push(span);
      at += CLOSE.length;
    } else {
      OPEN.lastIndex = at;
      const open = OPEN.exec(html);
      if (!open) return null;
      stack.push({ nodes: [], cls: open[1] });
      at += open[0].length;
    }
  }
  return stack.length === 1 && length === expected ? stack[0].nodes : null;
}

// text 按 language 上色，返回节点数组；没能高亮（库抛错、库自己吞掉了内部错误、输出格式不对）返回 null。
// 输出里没有 span 不算失败（空文件、只有普通标识符的文件）。
export function highlight(text, language) {
  try {
    const result = hljs.highlight(text, { language, ignoreIllegals: true });
    if (result.errorRaised) return null;
    return parse(result.value, text.length);
  } catch {
    return null;
  }
}

// 按代码围栏的语言标识解析 highlight.js 语言 id：优先匹配库已注册的语言名或别名（如 javascript、python），再退回文件名/扩展名表。
export const hasLanguage = name => Boolean(name && hljs.getLanguage(name));

// 给测试：打包的库本身。
export { hljs };
