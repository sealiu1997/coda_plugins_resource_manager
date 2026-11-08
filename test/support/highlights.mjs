// 文件内查找的假浏览器能力：Range（设起点终点、给一个可控的矩形）、CSS.highlights 和 Highlight（带 priority）。
// install(t, { supported })：装上全局的 document.createRange、CSS、Highlight；supported 为假时 CSS.highlights 和 Highlight 都不存在（旧的 WebView）。
export function installHighlights(t, { supported = true } = {}) {
  const had = Object.fromEntries(['CSS', 'Highlight'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const registry = new Map(), env = {};
  class FakeHighlight extends Set { priority = 0; }
  if (supported) { globalThis.CSS = { highlights: registry }; globalThis.Highlight = FakeHighlight; } else { delete globalThis.CSS; delete globalThis.Highlight; }
  const ranges = [];
  const makeRange = () => { const r = { setStart(node, offset) { r.startNode = node; r.startOffset = offset; }, setEnd(node, offset) { r.endNode = node; r.endOffset = offset; }, getBoundingClientRect: () => env.rectOf?.(r) ?? { top: 0, bottom: 20, left: 0, right: 10, height: 20, width: 10 } }; ranges.push(r); return r; };
  globalThis.fakeRange = makeRange; // loadApp 的假 document.createRange 转到这里（页面在装好之后才加载，换了 document）
  t.after(() => {
    for (const [key, d] of Object.entries(had)) { if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key]; }
    delete globalThis.fakeRange;
  });
  // 一个 Range 在整篇正文里的 [起点, 终点)：按各文本节点的累计起点换算，测试用它核对标出来的位置。
  const spanOf = (range, textEl) => {
    const nodes = []; const walk = n => { for (const c of n.children) { if (c.children === undefined) nodes.push(c); else walk(c); } }; walk(textEl);
    const at = node => { let sum = 0; for (const n of nodes) { if (n === node) return sum; sum += n.data.length; } return -1; };
    return [at(range.startNode) + range.startOffset, at(range.endNode) + range.endOffset];
  };
  return Object.assign(env, { registry, ranges, spanOf, supported, makeRange });
}
