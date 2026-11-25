// HTML 字节的编码判定（设计第 27.2 节、第 28.5 节）：纯函数，不依赖 DOM。
// 页内预览的 decodeHtmlBytes（view/html.mjs）和流式服务给 .html、.htm 写 content-type 的 charset（lib/media.mjs）都用这里，规则只定义一处。

// WHATWG 里映射到 replacement 的标签：TextDecoder 对它们抛 RangeError，和「认不出」分开处理：命中就停止扫描、按 UTF-8。
const REPLACEMENT_LABELS = new Set(['iso-2022-kr', 'hz-gb-2312', 'csiso2022kr', 'iso-2022-cn', 'iso-2022-cn-ext', 'replacement']);
// 规范化后落在这几个上的，一律改按 UTF-8（UTF-16 的 meta 本身就不可信；x-user-defined 不换成 windows-1252）。
const UTF8_ONLY = new Set(['utf-16le', 'utf-16be', 'replacement', 'x-user-defined']);
export const PRESCAN_BYTES = 1024;

const isSpace = code => code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
const asciiLower = text => text.replace(/[A-Z]/g, char => char.toLowerCase());

// 标签 → 规范化后的编码名；命中 replacement 表返回 'replacement'（调用方停止扫描）；认不出返回 null（继续往后找）。
function resolveLabel(label) {
  const clean = asciiLower(label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''));
  if (REPLACEMENT_LABELS.has(clean)) return 'replacement';
  try { return new TextDecoder(clean).encoding; } catch { return null; }
}

// WHATWG「从 meta 元素提取字符编码」：在 content 里找 charset=，取引号里或到空白、分号为止的值。
function charsetOfContent(value) {
  let at = 0;
  for (;;) {
    const found = value.indexOf('charset', at);
    if (found < 0) return null;
    at = found + 7;
    while (isSpace(value.charCodeAt(at))) at++;
    if (value[at] !== '=') continue;
    at++;
    while (isSpace(value.charCodeAt(at))) at++;
    const quote = value[at];
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, at + 1);
      return close < 0 ? null : value.slice(at + 1, close);
    }
    let end = at;
    while (end < value.length && !isSpace(value.charCodeAt(end)) && value[end] !== ';') end++;
    return value.slice(at, end);
  }
}

// WHATWG「预扫字节流确定编码」：只看前 1024 字节；跳过注释，对每个标签都按属性边界吃掉属性，所以写在属性值里的假 meta 不算。
// 返回规范化后的编码名；没有声明（或声明都认不出）返回 null；命中 replacement 表返回 'replacement'。
function prescan(bytes) {
  const end = Math.min(bytes.length, PRESCAN_BYTES);
  let p = 0;
  const startsWith = (text, from = p) => {
    for (let i = 0; i < text.length; i++) {
      const byte = from + i < end ? bytes[from + i] : -1;
      if ((byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte) !== text.charCodeAt(i)) return false;
    }
    return true;
  };
  const at = index => (index < end ? bytes[index] : -1);
  const isLetter = byte => (byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x7a;
  const lower = byte => String.fromCharCode(byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);
  // 取一个属性；没有了（遇到 > 或数据到头）返回 null。
  const getAttribute = () => {
    while (p < end && (isSpace(bytes[p]) || bytes[p] === 0x2f)) p++;
    if (p >= end || bytes[p] === 0x3e) return null;
    let name = '', value = '';
    for (;;) {
      if (p >= end) return null;
      const byte = bytes[p];
      if (byte === 0x3d && name.length > 0) { p++; break; }
      if (isSpace(byte)) {
        while (p < end && isSpace(bytes[p])) p++;
        if (p >= end) return null;
        if (bytes[p] !== 0x3d) return { name, value };
        p++;
        break;
      }
      if (byte === 0x2f || byte === 0x3e) return { name, value };
      name += lower(byte);
      p++;
    }
    while (p < end && isSpace(bytes[p])) p++;
    if (p >= end) return null;
    const first = bytes[p];
    if (first === 0x22 || first === 0x27) {
      for (p++; p < end; p++) {
        if (bytes[p] === first) { p++; return { name, value }; }
        value += lower(bytes[p]);
      }
      return null;
    }
    if (first === 0x3e) return { name, value };
    for (; p < end; p++) {
      if (isSpace(bytes[p]) || bytes[p] === 0x3e) return { name, value };
      value += lower(bytes[p]);
    }
    return null;
  };
  while (p < end) {
    if (bytes[p] !== 0x3c) { p++; continue; }
    if (startsWith('<!--')) {
      let close = p + 2;
      while (close + 2 < end && !(bytes[close] === 0x2d && bytes[close + 1] === 0x2d && bytes[close + 2] === 0x3e)) close++;
      if (close + 2 >= end) return null;
      p = close + 3;
      continue;
    }
    if (startsWith('<meta') && (isSpace(at(p + 5)) || at(p + 5) === 0x2f)) {
      p += 5;
      const seen = new Set();
      let gotPragma = false, needPragma = null, charset; // charset：undefined 没设过，null 设了但认不出
      for (let attr; (attr = getAttribute());) {
        if (seen.has(attr.name)) continue;
        seen.add(attr.name);
        if (attr.name === 'http-equiv') {
          if (attr.value === 'content-type') gotPragma = true;
        } else if (attr.name === 'content') {
          const extracted = charset === undefined ? charsetOfContent(attr.value) : null;
          const resolved = extracted === null ? null : resolveLabel(extracted);
          if (resolved !== null) { charset = resolved; needPragma = true; }
        } else if (attr.name === 'charset') {
          charset = resolveLabel(attr.value);
          needPragma = false;
        }
      }
      if (needPragma !== null && (!needPragma || gotPragma) && charset) return charset;
    } else if (isLetter(at(p + 1)) || (at(p + 1) === 0x2f && isLetter(at(p + 2)))) { // 其他标签：也按属性边界吃掉属性
      while (p < end && !isSpace(bytes[p]) && bytes[p] !== 0x3e) p++;
      while (getAttribute());
    } else if (at(p + 1) === 0x21 || at(p + 1) === 0x2f || at(p + 1) === 0x3f) { // <! </ <?：跳到下一个 >
      while (p < end && bytes[p] !== 0x3e) p++;
    }
    p++;
  }
  return null;
}

// 按字节判定 HTML 的编码名（TextDecoder 规范化后的名字）：有 UTF-8 BOM 就是 utf-8；否则预扫前 1024 字节的 meta；
// 没有声明、声明认不出、或规范化后是 UTF-16、replacement、x-user-defined 的，按 utf-8。不采用标准里的两条：退到 XML 声明、把 x-user-defined 换成 windows-1252。
export function htmlEncodingOf(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  const found = prescan(bytes);
  return found && !UTF8_ONLY.has(found) ? found : 'utf-8';
}
