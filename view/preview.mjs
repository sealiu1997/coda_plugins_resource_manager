// 文件预览：只接收路径和读块的能力，不依赖树的状态。readFile 是纯逻辑；mountPreview 才碰 DOM。
import { h } from './dom.mjs';
import { createFind } from './find.mjs';
import { formatDuration, formatSize } from './format.mjs';
import { HIGHLIGHT_LIMIT, appendAll, hasLongLine, highlight } from './highlight.mjs';
import { icon, iconFor } from './icons.mjs';
import { languageOf } from './languages.mjs';
import { ContentKind, EntryKind, ErrorCode, IMAGE_LIMIT, TEXT_LIMIT, imageType, mediaOf } from './protocol.mjs';
import { clippedSelection, linesOf } from './selection.mjs';
import { mayBeText, offersTextView } from './model3d.mjs';
import { mountViewer } from './viewer3d.mjs';

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
// media(path) → Promise<{ token, size, mtimeMs }>（第 20 节）：音视频和图片经模块的本机流式服务显示，token 是这个视图的口令；token 为 null 表示宿主没有流式服务。
// 不传 media 就一律走分块读取（直接挂载预览的测试用）。
// 3D 模型（第 21 节）：mountModel 挂查看器（默认 viewer3d.mjs，测试可换）。gltf、obj、stl、ply 的内容是文本时头部有「3D / 文本」切换，文本走分块读取。
export function mountPreview(el, { read, copy, actions = [], copyInHead = true, back = null, selectionMenu = null, consumed = () => false, media = null, mountModel = mountViewer }) {
  const name = h('div', { class: 'pname truncate' }), meta = h('div', { class: 'pmeta caption secondary truncate' }, ' ');
  const fileIcon = h('span', { class: 'pico', 'aria-hidden': 'true' });
  // 图标按钮：可访问名称和 Mac 的悬停提示都是 label；没有图标的退回文字。
  const action = (label, glyph, run) => h('button', { class: glyph ? 'icon' : 'link', 'aria-label': label, title: label, onclick: run }, glyph ? icon(glyph, 18) : label);
  const copyPath = () => path !== null && copy(path);
  const retryButton = h('button', { class: 'link', onclick: () => load(!changed), hidden: true }, '重试');
  const body = h('div', { class: 'pbody', tabindex: '-1' }); // 可聚焦：关查找条后焦点回正文
  const modes = [['3d', '3D'], ['text', '文本']].map(([value, label]) => ({ value, button: h('button', { class: 'link', onclick: () => setMode(value) }, label) }));
  const modeBar = h('div', { class: 'pmode', role: 'group', 'aria-label': '显示方式', hidden: true }, ...modes.map(({ button }) => button));
  let gutterEl = null;
  const find = createFind({ body, gutterWidth: () => gutterEl?.offsetWidth ?? 0 });
  const extra = actions.map(({ label, icon: glyph, run }) => { const button = action(label, glyph, () => path !== null && run(path, button)); return button; });
  el.replaceChildren(h('div', { class: 'phead' }, ...(back ? [action('返回', 'back', back)] : []), fileIcon, h('div', { class: 'grow' }, name, meta), modeBar, retryButton,
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
  let metaText = ' ', metaTitle = '', stale = null, changed = false; // stale：后台刷新失败的原因，此时正文还是上次的；changed：正在播放的文件变了，等用户点「重载」
  // 更新失败和文件已变化的提示占用元信息那一行，重试（重载）按钮在头部，所以正文不会被顶动。
  const paintMeta = () => {
    meta.textContent = stale ? `更新失败：${stale}` : changed ? '文件已变化' : metaText;
    meta.title = stale ?? (changed ? '点「重载」按新内容重新播放' : metaTitle);
    meta.classList.toggle('warn', stale !== null || changed);
    retryButton.hidden = stale === null && !changed;
    retryButton.textContent = !stale && changed ? '重载' : '重试';
  };
  const setMeta = (text, title = '') => { metaText = text; metaTitle = title; stale = null; changed = false; paintMeta(); };
  const setStale = reason => { stale = reason; paintMeta(); };
  let player = null; // 正在显示的音视频或图片元素
  let viewer = null; // 正在显示的 3D 模型视图：revoke 释放它，stop 只停加载和动画
  let mode = '3d', offersText = false; // 模型文件现在看 3D 还是文本；内容是文本的才有切换（换文件时都回到初始）
  const paintMode = () => {
    modeBar.hidden = !offersText;
    for (const { value, button } of modes) button.setAttribute('aria-pressed', String(mode === value));
  };
  function setMode(next) {
    if (path === null || mode === next) return;
    mode = next;
    paintMode();
    load(false);
  }
  const stopMedia = () => {
    if (!player) return;
    player.pause?.(); player.removeAttribute('src'); player.load?.();
    player = null;
  };
  const revoke = () => { stopMedia(); viewer?.dispose(); viewer = null; if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
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
    // 文件没了（后台刷新发现）：先释放，正文被换掉后，播放中的音视频和 3D 的画布不能继续占着。
    if (error.code === ErrorCode.NOT_FOUND) { revoke(); shown = null; textShown = false; find.clearContent(); setMeta(' '); return notice('文件已不存在', path); }
    if (silent && shown) return setStale(error.message); // 后台刷新失败：保留正文，提示原因
    textShown = false;
    find.clearContent(); // 整页重读失败：标记清掉，计数写「—」，之后再读成功就重新找
    notice('读不到这个文件', error.message, { label: '重试', run: retry });
  }

  const mediaMeta = size => [path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', formatSize(size)];
  const line = parts => parts.filter(Boolean).join(' · ');
  const setMetaText = (text, title) => { metaText = text; metaTitle = title; paintMeta(); }; // 只换文字（时长到了），不清更新失败和文件已变化的提示
  const unplayable = (size, mtimeMs, title) => {
    stopMedia();
    notice(title, `${formatSize(size)}，修改于 ${formatTime(mtimeMs)}`);
  };

  // 图片和音视频：地址指向模块的流式服务，元素自己按需取，不经分块读取（第 20 节）。
  function showMedia(kind, { token: key, size, mtimeMs }) {
    revoke();
    textShown = false; find.close(); pendingFind = null;
    shown = { size, mtimeMs };
    const parts = mediaMeta(size), title = `修改于 ${formatTime(mtimeMs)}`;
    setMeta(line(parts), title);
    const el = kind === 'image' ? h('img', { alt: path, draggable: 'false' }) : h(kind, { controls: '', playsinline: '', preload: 'metadata' });
    el.addEventListener('error', () => { if (player === el) unplayable(size, mtimeMs, '这台设备放不了这种格式'); });
    if (kind !== 'image') el.addEventListener('loadedmetadata', () => { if (player === el && Number.isFinite(el.duration)) setMetaText(line([...parts, formatDuration(el.duration)]), title); });
    player = el;
    body.replaceChildren(h('div', { class: kind === 'image' ? 'image' : 'media' }, el));
    el.src = `coda-view://service/media/${key}/${path.split('/').map(encodeURIComponent).join('/')}?v=${size}-${mtimeMs}`;
  }

  // 3D 模型：查看器自己取字节、解析、渲染（第 21 节）。
  function showModel({ token: key, size, mtimeMs }) {
    revoke();
    textShown = false; find.close(); pendingFind = null;
    shown = { size, mtimeMs };
    const parts = mediaMeta(size), title = `修改于 ${formatTime(mtimeMs)}`;
    setMeta(line(parts), title);
    const mine = viewer = mountModel({ body, token: key, path, size, version: `${size}-${mtimeMs}`, onMeta: extra => { if (viewer === mine) setMetaText(line([...parts, ...extra]), title); } });
  }

  // 媒体文件（按扩展名）：返回 true 表示已经处理（显示、提示或已作废），false 表示这个文件走分块读取（宿主没有流式服务时的图片和模型，模型选了看文本时）。
  // 刷新不打断播放：音视频和模型变了只在元信息行提示「文件已变化」，点「重载」才换；图片和提示页变了直接换。
  async function loadMedia({ kind, preview }, silent, mark) {
    if (kind === 'model' && mode === 'text') return false;
    const granted = await media(path);
    if (!mark()) return true;
    const { token: key, size, mtimeMs } = granted;
    if (key === null && preview && (kind === 'image' || kind === 'model')) return false;
    if (silent && shown) {
      if (shown.size === size && shown.mtimeMs === mtimeMs) { changed = false; setStale(null); return true; }
      if ((player && kind !== 'image') || (viewer && kind === 'model')) { changed = true; paintMeta(); return true; }
    }
    if (kind === 'model') { // 内容是不是文本，用模块现有的判断（读第一块）；不经查看器，没有 WebGL 的设备上文本模型也能切到文本看
      offersText = mayBeText(path) && offersTextView(path, (await read(path, 0)).kind);
      if (!mark()) return true;
      paintMode();
    }
    const keep = carry?.scroll ?? (silent ? { top: body.scrollTop, left: body.scrollLeft } : { top: 0, left: 0 });
    if (preview && key !== null) { if (kind === 'model') showModel(granted); else showMedia(kind, granted); } else {
      revoke();
      textShown = false; find.close(); pendingFind = null;
      shown = { size, mtimeMs };
      setMeta(line(mediaMeta(size)), `修改于 ${formatTime(mtimeMs)}`);
      unplayable(size, mtimeMs, preview ? '这个版本的 Coda 不能预览音视频' : '这种格式不能预览');
    }
    body.scrollTop = keep.top; body.scrollLeft = keep.left;
    settle(true);
    return true;
  }

  // silent：刷新。没变化不重画；变了就换内容，并尽量留在原来的滚动位置；有待恢复的位置时用它。
  async function load(silent) {
    const mine = ++token, mark = () => mine === token;
    if (!silent) { shown = null; textShown = false; find.clearContent(); setMeta('读取中…'); revoke(); body.replaceChildren(); }
    try {
      const kind = media && mediaOf(path);
      if (kind && await loadMedia(kind, silent, mark)) return;
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
      if (next !== path) { mode = '3d'; offersText = false; paintMode(); } // 换了文件：回到 3D，切换等读到内容再决定有没有
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
    stop() { settle(false); player?.pause?.(); viewer?.cancel(); token++; path = null; shown = null; textShown = false; find.close(); stoppedAt = opens; },
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
