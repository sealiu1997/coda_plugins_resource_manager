// 文件预览：只接收路径和读块的能力，不依赖树的状态。readFile 是纯逻辑；mountPreview 才碰 DOM。
import { h } from './dom.mjs';
import { createFind } from './find.mjs';
import { formatDuration, formatSize } from './format.mjs';
import { HIGHLIGHT_LIMIT, appendAll, hasLongLine, highlight } from './highlight.mjs';
import { decodeHtmlBytes, renderHtml } from './html.mjs';
import { icon, iconFor } from './icons.mjs';
import { languageOf } from './languages.mjs';
import { renderMarkdown } from './markdown.mjs';
import { createModes } from './modes.mjs';
import { ContentKind, EntryKind, ErrorCode, IMAGE_LIMIT, OpenCategory, TEXT_LIMIT, imageType, mediaOf, openCategoryOf, serviceUrl } from './protocol.mjs';
import { clippedRichSelection, clippedSelection, linesOf } from './selection.mjs';
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

// 渲染出的正文里有没有不折行的超长行：代码块（pre）和表格单元格（表格是 max-content 宽，格子里的字不折行）。
function hasLongCode(root) {
  const todo = [root];
  while (todo.length) {
    const node = todo.pop();
    if ((node.tagName === 'PRE' || node.tagName === 'TD' || node.tagName === 'TH') && hasLongLine(node.textContent)) return true;
    for (const kid of node.children ?? []) todo.push(kid);
  }
  return false;
}

const formatTime = ms => new Date(ms).toLocaleString('zh-CN', { hour12: false });
export const lineCount = text => (text === '' ? 1 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

// read(path, offset) → Promise<chunk 回答>，会话换了会以 stale 错误拒绝；copy(text) 复制路径。
// actions：头部在「复制路径」旁额外加的按钮 [{ label, icon, run(path, button) }]，button 是被点的按钮（菜单用它定位），预览不知道它们做什么。
// copyInHead：false 时头部不放「复制路径」（iPhone 的复制路径在 ⋯ 菜单里），由页面调 copyPath()。
// back：给了就在头部最左边放「返回」（Mac 侧栏预览：原生工具栏项目只能在右侧）；文件页和 iPhone 不传。
// open(path, scroll) 带了要恢复的位置时，返回的 Promise 在「位置用上了」时变 true（正文到了、已设好位置；读取失败不算，位置留着等重试），
// 在「位置作废」时变 false（预览关了、改看别的文件）。读取被刷新、重载或 changed 作废时位置不丢：接替它的那次读取接着带上，用上才算完。
// 文件内查找（第 18.6 节、第 26.2 节）是预览自己的一部分，接在预览已有的生命周期上：open 换了文件、reload、stop、close 关查找；refresh 保留；release 不碰。
// 页面只负责入口：canFind（有显示着的文本才有，富文本预览也有）、openFind()（⌘F、iPhone 的「查找」菜单项）。consumed(event)：这个按键已经被菜单消费了（菜单开着时的 Esc）。
// selectionMenu(event, { path, text, startLine, endLine })：给了就接管正文里选中文字的右键（只有 Mac 传）；预览不知道菜单里是什么。
// 选区为空、或裁到正文里之后为空时不接管，走系统默认。内容和行号在这里取好，交出去之后和选区无关。
// media(path) → Promise<{ token, size, mtimeMs }>（第 20 节）：音视频和图片经模块的本机流式服务显示，token 是这个视图的口令；token 为 null 表示宿主没有流式服务。
// HTML（html、htm、xhtml）读到字节后先 decodeHtmlBytes 解码，写回 result.text，预览和源码共用；解码失败退回源码（用读取时的 UTF-8 文本）并提示。
// Markdown 和 HTML 正文先挂载，渲染结果里有本地图片才取口令，到了再给还没地址的图片补 src（第 27.2 节）；口令任务和图片回调由「正文版本」持有，换了正文或退场就作废。
// 不传 media 就一律走分块读取（直接挂载预览的测试用）。
// canOpenInCoda(path)、openInCoda(path)：「不预览」提示里的「在 Coda 中打开」按钮；canOpenInCoda 缺省为假，不放按钮，动作与行菜单的同名项一致，由页面给。
// 3D 模型（第 21 节）：mountModel 挂查看器（默认 viewer3d.mjs，测试可换）。gltf、obj、stl、ply 的内容是文本时头部有「3D / 文本」切换，文本走分块读取。
export function mountPreview(el, { read, copy, actions = [], copyInHead = true, back = null, selectionMenu = null, consumed = () => false, media = null, mountModel = mountViewer, openExternal = null, openRelative = null, copyEmail = null, canOpenInCoda = () => false, openInCoda = null }) {
  const name = h('div', { class: 'pname truncate' }), meta = h('div', { class: 'pmeta caption secondary truncate' }, ' ');
  const fileIcon = h('span', { class: 'pico', 'aria-hidden': 'true' });
  // 图标按钮：可访问名称和 Mac 的悬停提示都是 label；没有图标的退回文字。
  const action = (label, glyph, run) => h('button', { class: glyph ? 'icon' : 'link', 'aria-label': label, title: label, onclick: run }, glyph ? icon(glyph, 18) : label);
  const copyPath = () => path !== null && copy(path);
  const retryButton = h('button', { class: 'link', onclick: () => load(!changed), hidden: true }, '重试');
  const body = h('div', { class: 'pbody', tabindex: '-1' }); // 可聚焦：关查找条后焦点回正文
  const modes = createModes();
  let modeButtons = [];
  const modeBar = h('div', { class: 'pmode', role: 'group', 'aria-label': '显示方式', hidden: true });
  const inspectSlot = h('div', { class: 'pinspect-slot', hidden: true });
  let gutterEl = null;
  const find = createFind({ body, gutterWidth: () => gutterEl?.offsetWidth ?? 0, version: () => bodyVersion });
  const extra = actions.map(({ label, icon: glyph, run }) => { const button = action(label, glyph, () => path !== null && run(path, button)); return button; });
  el.replaceChildren(h('div', { class: 'phead' }, ...(back ? [action('返回', 'back', back)] : []), fileIcon, h('div', { class: 'grow' }, name, meta), inspectSlot, modeBar, retryButton,
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
  let textShown = false, pendingFind = null; // 现在显示的是不是文本（源码或富文本预览）；show() 换好的正文，等滚动位置设好再交给查找

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
  let lastResult = null, richToken = null; // 富文本模式切换时复用已读正文和流式口令
  let bodyVersion = 0; // 正文版本，只有这里持有：提交新正文（show 的 commit）和退场（revoke、stop）时加一；图片口令、图片回调、查找都引用它。读取代次是 token
  const paintMode = () => {
    const items = modes.buttons();
    if (items.length === 0) { modeBar.hidden = true; return; }
    const { group } = modes.state();
    if (modeBar.dataset.group !== group) {
      modeBar.dataset.group = group;
      modeButtons = items.map(({ value, label }) => ({
        value,
        button: h('button', { class: 'link', onclick: () => setMode(value) }, label),
      }));
      modeBar.replaceChildren(...modeButtons.map(({ button }) => button));
    }
    modeBar.hidden = false;
    for (const { value, pressed } of items) modeButtons.find(entry => entry.value === value).button.setAttribute('aria-pressed', String(pressed));
  };
  // 把 show() 换好的正文交给查找（顺序：换正文 → 设好滚动位置 → 重建查找）。keepPosition：后台刷新沿用旧位置；预览和源码之间切换取第 1 处。
  const feedFind = keepPosition => { if (pendingFind) find.setContent(pendingFind.el, pendingFind.text, { rich: pendingFind.rich, highlight: pendingFind.highlight, keepPosition }); };
  function setMode(next) {
    const before = modes.state().mode;
    if (path === null || !modes.select(next)) return;
    paintMode();
    if (modes.state().group === 'rich' && lastResult) {
      const prevStale = stale;
      try { show(lastResult, richToken); } catch (error) { modes.select(before); paintMode(); setStale(error.message); return; } // 渲染失败：模式回到和画面一致
      if (prevStale !== null) setStale(prevStale);
      body.scrollTop = 0; body.scrollLeft = 0;
      feedFind(false);
      return;
    }
    load(false);
  }
  const stopMedia = () => {
    if (!player) return;
    player.pause?.(); player.removeAttribute('src'); player.load?.();
    player = null;
  };
  // retire 为假：show 的挂载，版本等挂载成功、提交时再加；其余调用（退场、换成别的画面）立即加。
  const revoke = (retire = true) => { if (retire) bodyVersion++; stopMedia(); viewer?.dispose(); viewer = null; inspectSlot.replaceChildren(); inspectSlot.hidden = true; if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
  const codaAction = () => (canOpenInCoda(path) ? { label: '在 Coda 中打开', run: () => openInCoda(path) } : null); // 不预览的提示里给出路：交给 Coda 打开
  const notice = (title, detail, action) => body.replaceChildren(h('div', { class: 'empty' },
    h('p', {}, title), detail ? h('p', { class: 'secondary' }, detail) : null,
    action ? h('button', { class: 'link', onclick: action.run }, action.label) : null));

  // 显示一份读到的内容（第 27.2 节）：先造好、挂上，挂载没抛错才一并提交 lastResult、shown、模式和元信息。
  // 预览抛错就退回源码并提示；源码也抛错则什么都不提交，异常交给调用方（旧画面和旧元信息原样留着）。
  // mediaToken：已有口令时图片立刻带地址（预览和源码之间切换）；没有就先挂正文，之后补（supplyImages）。
  function show(result, mediaToken = null) {
    const isText = result.kind === ContentKind.TEXT;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const lines = isText ? `${lineCount(result.text)} 行` : '';
    const title = `修改于 ${formatTime(result.mtimeMs)}`;
    const commit = (note, pending = null, gutter = null, hover = '') => {
      bodyVersion++;
      lastResult = result;
      textShown = isText;
      pendingFind = pending;
      gutterEl = gutter;
      if (!isText) find.close(); // 图片、二进制不能查找；源码和富文本预览都能
      shown = { size: result.size, mtimeMs: result.mtimeMs };
      // 元信息：目录 · 行数 · 大小；根目录下的文件没有目录，非文本没有行数。修改时间放进 title。
      setMeta([dir, lines, formatSize(result.size), note].filter(Boolean).join(' · '), hover ? `${title}\n${hover}` : title);
    };
    // 有长行：上色按它判断，查找也用同一个结果（不再扫一遍正文）：长行里注册高亮会让浏览器同步重画整行（源码和富文本里不折行的代码块都一样），所以只计数、导航、滚动。
    const longLine = isText && hasLongLine(result.text);
    const truncated = result.truncated ? `只显示前 ${formatSize(TEXT_LIMIT)}` : '';
    let fellBack = isText && modes.isRichPreview() && result.decodeFailed === true;
    if (isText && modes.isRichPreview() && !fellBack) {
      try {
        const mine = bodyVersion + 1, images = []; // mine：提交时正文版本加一后就是这一份
        const resolveImage = media ? (mediaToken ? rel => serviceUrl(mediaToken, rel) : () => null) : null;
        const options = {
          basePath: path, resolveImage, onOpenExternal: openExternal, onOpenRelative: openRelative, onCopyEmail: copyEmail ?? (email => copy(email)),
          isCurrent: () => bodyVersion === mine,
        };
        let md, note = truncated, hover = '', plainOnly = longLine;
        if (openCategoryOf(path) === OpenCategory.HTML) {
          const page = renderHtml(result.text, { ...options, onViewSource: () => { if (bodyVersion === mine) setMode('source'); } });
          md = page.node;
          images.push(...page.images.filter(({ img }) => img.getAttribute('src') === null));
          note = [truncated, '静态预览'].filter(Boolean).join('，');
          hover = ['静态预览：不运行脚本，不加载外部资源，样式和布局已简化，完整内容切到「源码」看。', page.title && `标题：${page.title}`].filter(Boolean).join('\n');
          plainOnly = hasLongCode(md); // 不折行的只有代码块；HTML 源码常是压成一行的，不能按源码判断
        } else md = renderMarkdown(result.text, { ...options, onLocalImage: entry => { if (entry.img.getAttribute('src') === null) images.push(entry); } });
        if (selectionMenu) md.addEventListener('contextmenu', event => onSelect(event, md, false));
        revoke(false);
        body.replaceChildren(md);
        commit(note, { el: md, text: null, rich: true, highlight: !plainOnly }, null, hover);
        if (images.length > 0) supplyImages(mine, images);
        return;
      } catch { fellBack = true; }
    }
    if (isText) {
      // 高亮：认得出语言才试；超过上限不试，库或解析出错就退回纯文本，都在元信息里注明。认不出语言的不加说明。
      const language = languageOf(path.split('/').pop());
      // 先判大小，超过只写「不高亮」；没超再判行长。
      const skip = !language ? '' : result.bytes.length > HIGHLIGHT_LIMIT ? '不高亮' : longLine ? '行太长，不高亮' : '';
      const colored = language && !skip ? highlight(result.text, language) : null;
      const plain = !language ? '' : skip || (colored ? '' : '没能高亮');
      const gutter = h('pre', { class: 'gutter', 'aria-hidden': 'true' }, Array.from({ length: lineCount(result.text) }, (_, i) => i + 1).join('\n'));
      const text = h('pre', { class: 'text selectable' }, ...(colored ? [] : [result.text]));
      if (colored) appendAll(text, colored);
      if (selectionMenu) text.addEventListener('contextmenu', event => onSelect(event, text, true));
      revoke(false);
      body.replaceChildren(h('div', { class: 'code' }, gutter, text));
      commit([truncated, plain, fellBack ? '预览出错，改显示源码' : ''].filter(Boolean).join('，'), { el: text, text: result.text, rich: false, highlight: !longLine }, gutter);
      if (fellBack) { modes.select('source'); paintMode(); } // 按钮和显示一致；再点「预览」就是重试
    } else if (result.kind === ContentKind.IMAGE && result.bytes.length > 0) {
      const url = URL.createObjectURL(new Blob([result.bytes], { type: imageType(path) }));
      revoke(false);
      objectUrl = url;
      body.replaceChildren(h('div', { class: 'image' }, h('img', { src: url, alt: path, draggable: 'false' })));
      commit('');
    } else {
      const big = result.kind === ContentKind.IMAGE ? `图片超过 ${formatSize(IMAGE_LIMIT)}，不预览。` : '二进制文件，不预览。';
      revoke(false);
      notice(big, `${formatSize(result.size)}，修改于 ${formatTime(result.mtimeMs)}`, codaAction());
      commit('');
    }
  }

  // 图片口令（第 27.2 节第 6 步）：正文已经挂上，这时才取口令，拿到后给这一版里还没设地址的图片补 src。
  // 持有者是正文版本：换了正文、切了模式、停了，晚到的结果整个丢掉（也不记进 richToken）。
  // 失败或超时：沿用上一次的口令，没有就换成占位。宿主没有流式服务（token 为 null）也是占位。
  async function supplyImages(mine, images) {
    let granted = null, failed = false;
    try { granted = (await media(path))?.token ?? null; } catch { failed = true; }
    if (bodyVersion !== mine) return;
    if (!failed) richToken = granted;
    for (const { img, path: rel, fail } of images) {
      if (img.getAttribute('src') !== null) continue;
      if (richToken !== null) img.setAttribute('src', serviceUrl(richToken, rel)); else fail();
    }
  }

  function onSelect(event, text, withLines = true) {
    const picked = withLines ? clippedSelection(text) : clippedRichSelection(text);
    if (!picked) return;
    event.preventDefault();
    selectionMenu(event, withLines
      ? { path, text: picked.text, ...linesOf(text.textContent, picked.start, picked.start + picked.text.length) }
      : { path, text: picked.text });
  }

  function clearMarkdownState() {
    lastResult = null;
    richToken = null;
    modes.content(false);
    paintMode();
  }

  function failure(error, silent, retry) {
    if (error.stale) return;
    // 文件没了（后台刷新发现）：先释放，正文被换掉后，播放中的音视频和 3D 的画布不能继续占着。
    if (error.code === ErrorCode.NOT_FOUND) { revoke(); shown = null; clearMarkdownState(); textShown = false; find.clearContent(); setMeta(' '); return notice('文件已不存在', path); }
    if (silent && shown) return setStale(error.message); // 后台刷新失败：保留正文，提示原因
    clearMarkdownState();
    textShown = false;
    find.clearContent(); // 整页重读失败：标记清掉，计数写「—」，之后再读成功就重新找
    notice('读不到这个文件', error.message, { label: '重试', run: retry });
  }

  const mediaMeta = size => [path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', formatSize(size)];
  const line = parts => parts.filter(Boolean).join(' · ');
  const setMetaText = (text, title) => { metaText = text; metaTitle = title; paintMeta(); }; // 只换文字（时长到了），不清更新失败和文件已变化的提示
  const unplayable = (size, mtimeMs, title) => {
    stopMedia();
    notice(title, `${formatSize(size)}，修改于 ${formatTime(mtimeMs)}`, codaAction());
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
    el.src = serviceUrl(key, path, `${size}-${mtimeMs}`);
  }

  // 3D 模型：查看器自己取字节、解析、渲染（第 21 节）。
  function showModel({ token: key, size, mtimeMs }) {
    revoke();
    textShown = false; find.close(); pendingFind = null;
    shown = { size, mtimeMs };
    const parts = mediaMeta(size), title = `修改于 ${formatTime(mtimeMs)}`;
    setMeta(line(parts), title);
    const mine = viewer = mountModel({ body, head: inspectSlot, token: key, path, size, version: `${size}-${mtimeMs}`, onMeta: extra => {
      if (viewer !== mine) return;
      const full = line([...parts, ...extra]);
      setMetaText(full, extra.length > 2 && extra[2] ? `${extra[2]} · ${title}` : title);
    } });
  }

  // 媒体文件（按扩展名）：返回 true 表示已经处理（显示、提示或已作废），false 表示这个文件走分块读取（宿主没有流式服务时的图片和模型，模型选了看文本时）。
  // 刷新不打断播放：音视频和模型变了只在元信息行提示「文件已变化」，点「重载」才换；图片和提示页变了直接换。
  async function loadMedia({ kind, preview }, silent, mark) {
    if (kind === 'model' && modes.state().mode === 'text') return false;
    const granted = await media(path);
    if (!mark()) return true;
    const { token: key, size, mtimeMs } = granted;
    if (key === null && preview && (kind === 'image' || kind === 'model')) return false;
    if (silent && shown) {
      if (shown.size === size && shown.mtimeMs === mtimeMs) { changed = false; setStale(null); return true; }
      if ((player && kind !== 'image') || (viewer && kind === 'model')) { changed = true; paintMeta(); return true; }
    }
    if (kind === 'model') { // 内容是不是文本，用模块现有的判断（读第一块）；不经查看器，没有 WebGL 的设备上文本模型也能切到文本看
      const first = mayBeText(path) ? await read(path, 0) : null;
      if (!mark()) return true; // 先核对作废，再动共享状态
      modes.capability(first !== null && offersTextView(path, first.kind));
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
    if (!silent) { shown = null; modes.reload(); clearMarkdownState(); textShown = false; find.clearContent(); setMeta('读取中…'); revoke(); body.replaceChildren(); }
    try {
      const kind = media && mediaOf(path);
      if (kind && await loadMedia(kind, silent, mark)) return;
      const result = await readFile(offset => read(path, offset), {
        prev: silent ? shown : null, cancelled: () => !mark(),
        onProgress: (got, total) => { if (mark() && !silent && total > TEXT_LIMIT / 4) setMeta(`读取中 ${formatSize(got)} / ${formatSize(total)}`); },
      });
      if (!mark() || result.cancelled) return;
      if (result.same) return setStale(null);
      if (result.kind === ContentKind.TEXT && openCategoryOf(path) === OpenCategory.HTML) {
        try { result.text = decodeHtmlBytes(result.bytes, result.truncated); } catch { result.decodeFailed = true; }
      }
      // 刷新留在原位；整页重读（打开、重载、重试）没有要恢复的位置就明确从头开始，不靠清空正文后滚动条自己归零。
      const keep = carry?.scroll ?? (silent ? { top: body.scrollTop, left: body.scrollLeft } : { top: 0, left: 0 });
      modes.content(result.kind === ContentKind.TEXT);
      paintMode();
      show(result);
      body.scrollTop = keep.top; body.scrollLeft = keep.left;
      // 顺序：换正文 → 设好滚动位置 → 重建查找（刷新和换正文时查找不滚动，不盖掉恢复）
      feedFind(true);
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
      if (next !== path) { modes.open(openCategoryOf(next)); lastResult = null; richToken = null; paintMode(); } // 换了文件：重置模式与缓存
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
    stop() { settle(false); player?.pause?.(); viewer?.cancel(); token++; bodyVersion++; path = null; shown = null; lastResult = null; richToken = null; textShown = false; find.close(); stoppedAt = opens; },
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
    // 文件内查找的入口：有显示着的文本（或查找条已经开着）才有；Markdown 预览里直接在渲染后的正文里找，不切模式。
    get canFind() { return path !== null && (textShown || find.isOpen); },
    get findOpen() { return find.isOpen; },
    openFind() {
      if (!this.canFind) return false;
      find.open();
      return true;
    },
    closeFind() { find.close(); },
    find,
  };
}
