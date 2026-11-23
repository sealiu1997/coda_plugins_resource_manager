// 假 DOMParser（Node 没有）：只够预览的接线测试，不是 HTML 解析器。
// 认 <title>、<img src alt>、<script>…</script>、<pre>…</pre>、<td>…</td>（放进 table > tr，里面只有文字）；其余标签剥掉，剩下的文字放进 body 里的一个 <p>。真实解析在 harness 里用 Chrome 测。
const HTML = 'http://www.w3.org/1999/xhtml';
const node = (localName, attrs, ...kids) => ({ nodeType: 1, namespaceURI: HTML, localName, getAttribute: name => (attrs && Object.hasOwn(attrs, name) ? attrs[name] : null), childNodes: kids });
const text = data => ({ nodeType: 3, data });
const attrOf = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

export function parseFake(source) {
  const title = /<title>([^<]*)<\/title>/.exec(source)?.[1];
  const kids = [];
  let skipping = false, cell = null; // cell：正在收文字的 pre 或 td
  const add = child => (cell?.kids ?? kids).push(child);
  for (const token of source.replace(/<title>[^<]*<\/title>/, '').split(/(<[^>]*>)/)) {
    if (skipping) { skipping = !token.startsWith('</script'); continue; }
    const open = /^<(pre|td)>$/.exec(token);
    if (open) cell = { tag: open[1], kids: [] };
    else if (cell && token === `</${cell.tag}>`) {
      const el = node(cell.tag, null, ...cell.kids);
      kids.push(cell.tag === 'td' ? node('table', null, node('tr', null, el)) : el);
      cell = null;
    } else if (token.startsWith('<script')) { add(node('script')); skipping = true; } else if (token.startsWith('<img')) add(node('img', { src: attrOf(token, 'src'), alt: attrOf(token, 'alt') }));
    else if (!token.startsWith('<') && token !== '') add(text(token));
  }
  const head = node('head', null, ...(title === undefined ? [] : [node('title', null, text(title))]));
  return { nodeType: 9, childNodes: [node('html', null, head, node('body', null, node('p', null, ...kids)))] };
}

// 装上假 DOMParser；fail 为真时解析就抛错；poison 为真时解析正常返回，但清洗读到正文里的 <p> 的子节点时抛错（模拟清洗中途出错）。
export function installParser(t, { fail = false, poison = false } = {}) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  globalThis.DOMParser = class { parseFromString(source) { if (fail) throw new Error('解析出错'); const doc = parseFake(source); if (poison) Object.defineProperty(doc.childNodes[0].childNodes[1].childNodes[0], 'childNodes', { get() { throw new Error('清洗出错'); } }); return doc; } };
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'DOMParser', saved); else delete globalThis.DOMParser; });
}
