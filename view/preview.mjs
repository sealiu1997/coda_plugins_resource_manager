// 文件预览：只接收路径和读块的能力，不依赖树的状态。readFile 是纯逻辑；mountPreview 才碰 DOM。
import { h } from './dom.mjs';
import { createFind } from './find.mjs';
import { formatSize } from './format.mjs';
import { HIGHLIGHT_LIMIT, appendAll, hasLongLine, highlight } from './highlight.mjs';
import { icon, iconFor } from './icons.mjs';
import { languageOf } from './languages.mjs';
import { ContentKind, EntryKind, ErrorCode, IMAGE_LIMIT, TEXT_LIMIT, imageType } from './protocol.mjs';
import { clippedSelection, linesOf } from './selection.mjs';

function fromBase64(data) {
  const binary = atob(data), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 一块一块读完一个文件。read(offset) 返回 chunk 回答。
// 文本把所有块拼成字节后再解码，多字节字符被块边界切开也没关系。
// 传入 prev（上次的 size、mtimeMs）时，没变就只返回 { same: true }；读的途中文件变了就重读，最多三次。
export async function readFile(read, { prev = null, onProgress = () => {}, cancelled = () => false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let chunk = await read(0);
    if (prev && chunk.size === prev.size && chunk.mtimeMs === prev.mtimeMs) return { same: true };
    const { kind, size, mtimeMs } = chunk;
    const total = kind === ContentKind.TEXT ? Math.min(size, TEXT_LIMIT) : kind === ContentKind.IMAGE && size <= IMAGE_LIMIT ? size : 0;
    const parts = [];
    let got = 0, moved = false;
    for (;;) {
      const bytes = fromBase64(chunk.data);
      parts.push(bytes);
      got += bytes.length;
      onProgress(got, total);
      if (chunk.eof || bytes.length === 0) break;
      if (cancelled()) return { cancelled: true };
      chunk = await read(got);
      if (chunk.size !== size || chunk.mtimeMs !== mtimeMs) { moved = true; break; }
    }
    if (moved) continue;
    const all = new Uint8Array(got);
    let at = 0;
    for (const part of parts) { all.set(part, at); at += part.length; }
    const result = { same: false, kind, size, mtimeMs, bytes: all, truncated: kind === ContentKind.TEXT && size > TEXT_LIMIT };
    if (kind === ContentKind.TEXT) {
      result.text = new TextDecoder().decode(all);
      if (result.truncated && result.text.endsWith('�')) result.text = result.text.slice(0, -1); // 1 MiB 处可能切在字符中间
    }
    return result;
  }
  const error = new Error('文件一直在变化，稍后再试');
  throw Object.assign(error, { code: ErrorCode.IO });
}

const formatTime = ms => new Date(ms).toLocaleString('zh-CN', { hour12: false });
export const lineCount = text => (text === '' ? 1 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

// read(path, offset) → Promise<chunk 回答>，会话换了会以 stale 错误拒绝；copy(text) 复制路径。
// actions：头部在「复制路径」旁额外加的按钮 [{ label, icon, run(path, button) }]，button 是被点的按钮（菜单用它定位），预览不知道它们做什么。
// copyInHead：false 时头部不放「复制路径」（iPhone 的复制路径在 ⋯ 菜单里），由页面调 copyPath()。
// back：给了就在头部最左边放「返回」（Mac 侧栏预览：原生工具栏项目只能在右侧）；文件页和 iPhone 不传。
// open(path, scroll) 带了要恢复的位置时，返回的 Promise 在「位置用上了」时变 true（正文到了、已设好位置；读取失败不算，位置留着等重试），
// 在「位置作废」时变 false（预览关了、改看别的文件）。读取被刷新、重载或 changed 作废时位置不丢：接替它的那次读取接着带上，用上才算完。
// 文件内查找（第 18.6 节）是预览自己的一部分，接在预览已有的生命周期上：open 换了文件、reload、stop、close 关查找；refresh 保留；release 不碰。
// 页面只负责入口：canFind（有显示着的文本才有）、openFind()（⌘F、iPhone 的「查找」菜单项）。consumed(event)：这个按键已经被菜单消费了（菜单开着时的 Esc）。
// selectionMenu(event, { path, text, startLine, endLine })：给了就接管正文里选中文字的右键（只有 Mac 传）；预览不知道菜单里是什么。
// 选区为空、或裁到正文里之后为空时不接管，走系统默认。内容和行号在这里取好，交出去之后和选区无关。
export function mountPreview(el, { read, copy, actions = [], copyInHead = true, back = null, selectionMenu = null, consumed = () => false }) {
  const name = h('div', { class: 'pname truncate' }), meta = h('div', { class: 'pmeta caption secondary truncate' }, ' ');
  const fileIcon = h('span', { class: 'pico', 'aria-hidden': 'true' });
  // 图标按钮：可访问名称和 Mac 的悬停提示都是 label；没有图标的退回文字。
  const action = (label, glyph, run) => h('button', { class: glyph ? 'icon' : 'link', 'aria-label': label, title: label, onclick: run }, glyph ? icon(glyph, 18) : label);
  const copyPath = () => path !== null && copy(path);
  const retryButton = h('button', { class: 'link', onclick: () => load(true), hidden: true }, '重试');
  const body = h('div', { class: 'pbody', tabindex: '-1' }); // 可聚焦：关查找条后焦点回正文
  let gutterEl = null;
  const find = createFind({ body, gutterWidth: () => gutterEl?.offsetWidth ?? 0 });
  const extra = actions.map(({ label, icon: glyph, run }) => { const button = action(label, glyph, () => path !== null && run(path, button)); return button; });
  el.replaceChildren(h('div', { class: 'phead' }, ...(back ? [action('返回', 'back', back)] : []), fileIcon, h('div', { class: 'grow' }, name, meta), retryButton,
    ...(copyInHead ? [action('复制路径', 'copy', copyPath)] : []), ...extra), find.el, body);
  find.done.addEventListener('click', () => { find.close(); body.focus(); });
  // 查找条的键盘：Esc 关（从查找条里关，焦点回正文；焦点在正文里，焦点留在正文）；⌘G、⇧⌘G 下一个、上一个。输入法组字中的按键不管，菜单消费掉的 Esc 不再处理。
  el.addEventListener('keydown', event => {
    if (!find.isOpen || event.isComposing) return;
    if (event.key === 'Escape' && consumed(event)) { event.preventDefault(); return; } // 菜单关掉的 Esc：查找输入框是 type=search，默认动作会清空它，要拦下
    if (event.key === 'Escape') {
      event.preventDefault();
      const fromBar = find.el.contains(document.activeElement);
      find.close();
      if (fromBar) body.focus();
    } else if (event.key?.toLowerCase() === 'g' && event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (event.shiftKey) find.prev(); else find.next();
    }
  });
  let textShown = false, pendingFind = null, longLine = false; // 现在显示的是不是文本；show() 换好的正文，等滚动位置设好再交给查找

  let path = null, token = 0, shown = null, objectUrl = null; // shown：当前显示的 { size, mtimeMs }
  let opens = 0, stoppedAt = -1; // 打开次数和上一次停止时的次数：释放只在停止之后没有再打开过时才做（返回的退场还没结束又打开了）
  let carry = null; // 待恢复的位置 { scroll, settle }：open 带进来，读取真正用上或作废后才清
  const settle = used => { const c = carry; carry = null; c?.settle(used); };
  let metaText = ' ', metaTitle = '', stale = null; // stale：后台刷新失败的原因，此时正文还是上次的
  // 更新失败的提示占用元信息那一行，重试按钮在头部，所以正文不会被顶动。
  const paintMeta = () => {
    meta.textContent = stale ? `更新失败：${stale}` : metaText;
    meta.title = stale ?? metaTitle;
    meta.classList.toggle('warn', stale !== null);
    retryButton.hidden = stale === null;
  };
  const setMeta = (text, title = '') => { metaText = text; metaTitle = title; stale = null; paintMeta(); };
  const setStale = reason => { stale = reason; paintMeta(); };
  const revoke = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
  const notice = (title, detail, action) => body.replaceChildren(h('div', { class: 'empty' },
    h('p', {}, title), detail ? h('p', { class: 'secondary' }, detail) : null,
    action ? h('button', { class: 'link', onclick: action.run }, action.label) : null));

  function show(result) {
    revoke();
    textShown = result.kind === ContentKind.TEXT;
    pendingFind = null;
    if (!textShown) find.close(); // 图片、二进制没有查找
    shown = { size: result.size, mtimeMs: result.mtimeMs };
    // 元信息：目录 · 行数 · 大小；根目录下的文件没有目录，非文本没有行数。修改时间放进 title。
    // 高亮：认得出语言才试；超过上限不试，库或解析出错就退回纯文本，都在元信息里注明。认不出语言的不加说明。
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const lines = result.kind === ContentKind.TEXT ? `${lineCount(result.text)} 行` : '';
    const language = result.kind === ContentKind.TEXT ? languageOf(path.split('/').pop()) : null;
    // 先判大小，超过只写「不高亮」；没超再判行长。
    // 有长行：上色已经按它判断，查找也用同一个结果（不再扫一遍正文）：长行里注册高亮会让浏览器同步重画整行，所以只计数、导航、滚动。
    longLine = result.kind === ContentKind.TEXT && hasLongLine(result.text);
    const skip = !language ? '' : result.bytes.length > HIGHLIGHT_LIMIT ? '不高亮' : longLine ? '行太长，不高亮' : '';
    const colored = language && !skip ? highlight(result.text, language) : null;
    const plain = !language ? '' : skip || (colored ? '' : '没能高亮');
    const note = [result.truncated ? `只显示前 ${formatSize(TEXT_LIMIT)}` : '', plain].filter(Boolean).join('，');
    setMeta([dir, lines, formatSize(result.size), note].filter(Boolean).join(' · '), `修改于 ${formatTime(result.mtimeMs)}`);
    if (result.kind === ContentKind.TEXT) {
      const gutter = h('pre', { class: 'gutter', 'aria-hidden': 'true' }, Array.from({ length: lineCount(result.text) }, (_, i) => i + 1).join('\n'));
      const text = h('pre', { class: 'text selectable' }, ...(colored ? [] : [result.text]));
      if (colored) appendAll(text, colored);
      gutterEl = gutter;
      pendingFind = { el: text, text: result.text, highlight: !longLine };
      if (selectionMenu) text.addEventListener('contextmenu', event => onSelect(event, text));
      body.replaceChildren(h('div', { class: 'code' }, gutter, text));
    } else if (result.kind === ContentKind.IMAGE && result.bytes.length > 0) {
      objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: imageType(path) }));
      body.replaceChildren(h('div', { class: 'image' }, h('img', { src: objectUrl, alt: path, draggable: 'false' })));
    } else {
      const big = result.kind === ContentKind.IMAGE ? `图片超过 ${formatSize(IMAGE_LIMIT)}，不预览。` : '二进制文件，不预览。';
      notice(big, `${formatSize(result.size)}，修改于 ${formatTime(result.mtimeMs)}`);
    }
  }

  function onSelect(event, text) {
    const picked = clippedSelection(text);
    if (!picked) return;
    event.preventDefault();
    selectionMenu(event, { path, text: picked.text, ...linesOf(text.textContent, picked.start, picked.start + picked.text.length) });
  }

  function failure(error, silent, retry) {
    if (error.stale) return;
    if (error.code === ErrorCode.NOT_FOUND) { shown = null; textShown = false; find.clearContent(); setMeta(' '); return notice('文件已不存在', path); }
    if (silent && shown) return setStale(error.message); // 后台刷新失败：保留正文，提示原因
    textShown = false;
    find.clearContent(); // 整页重读失败：标记清掉，计数写「—」，之后再读成功就重新找
    notice('读不到这个文件', error.message, { label: '重试', run: retry });
  }

  // silent：刷新。没变化不重画；变了就换内容，并尽量留在原来的滚动位置；有待恢复的位置时用它。
  async function load(silent) {
    const mine = ++token, mark = () => mine === token;
    if (!silent) { shown = null; textShown = false; find.clearContent(); setMeta('读取中…'); revoke(); body.replaceChildren(); }
    try {
      const result = await readFile(offset => read(path, offset), {
        prev: silent ? shown : null, cancelled: () => !mark(),
        onProgress: (got, total) => { if (mark() && !silent && total > TEXT_LIMIT / 4) setMeta(`读取中 ${formatSize(got)} / ${formatSize(total)}`); },
      });
      if (!mark() || result.cancelled) return;
      if (result.same) return setStale(null);
      // 刷新留在原位；整页重读（打开、重载、重试）没有要恢复的位置就明确从头开始，不靠清空正文后滚动条自己归零。
      const keep = carry?.scroll ?? (silent ? { top: body.scrollTop, left: body.scrollLeft } : { top: 0, left: 0 });
      show(result);
      body.scrollTop = keep.top; body.scrollLeft = keep.left;
      // 顺序：换正文 → 设好滚动位置 → 重建查找（刷新和换正文时查找不滚动，不盖掉恢复）
      if (pendingFind) find.setContent(pendingFind.el, pendingFind.text, { highlight: pendingFind.highlight });
      settle(true);
    } catch (error) {
      if (mark()) failure(error, silent, () => load(false)); // 失败不算用上：待恢复的位置留着，重试或之后的刷新成功才用、才清
    }
  }

  return {
    open(next, scroll = null) {
      settle(false);
      if (next !== path) find.close(); // 换了文件就关查找，不靠调用方先 stop()
      opens++;
      path = next;
      const base = next.split('/').pop();
      name.textContent = base;
      name.title = next;
      fileIcon.replaceChildren(icon(iconFor({ kind: EntryKind.FILE, name: base }), 22));
      const used = scroll ? new Promise(done => { carry = { scroll, settle: done }; }) : null;
      const read = load(false);
      return used ?? read;
    },
    copyPath,
    refresh() { return path === null ? undefined : load(true); },
    // 内容的来源变了（根目录换了位置）：旧正文不能留，也不能按元数据判断「没变」。
    reload() { find.close(); return path === null ? undefined : load(false); }, // 来源变了：查找也关
    // 停止（逻辑关闭，立即）：不再读、不再刷新，待恢复的位置结算；画面（正文、图片的 URL）留着，由 release 在退场结束时清掉。
    stop() { settle(false); token++; path = null; shown = null; textShown = false; find.close(); stoppedAt = opens; },
    // 释放（画面）：停止之后又打开过就什么都不做。
    release() {
      if (stoppedAt !== opens) return; // 停止之后又打开过（打开次数变了）：这一屏是新的，不是退场的旧页
      setMeta(' ');
      revoke();
      body.replaceChildren();
    },
    // 停止并立即释放：换会话、换根目录、Mac，以及没有过渡的所有关闭。
    close() { this.stop(); this.release(); },
    // 已停止的预览没有位置：保存状态时按 0 算，同关闭后清空正文的结果。
    scroll: () => (path === null ? { top: 0, left: 0 } : { top: body.scrollTop, left: body.scrollLeft }),
    onScroll: fn => body.addEventListener('scroll', fn, { passive: true }),
    get path() { return path; },
    // 文件内查找的入口：有显示着的文本（或查找条已经开着）才有。
    get canFind() { return path !== null && (textShown || find.isOpen); },
    get findOpen() { return find.isOpen; },
    openFind() { if (this.canFind) find.open(); return this.canFind; },
    closeFind() { find.close(); },
    find,
  };
}
