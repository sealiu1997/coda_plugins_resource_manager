// 属性页：一个文件、文件夹或链接的属性。只管显示：属性和文件夹大小由页面经 stat、size 取，这里不知道聊天和目录树。
// 设计见 docs/design/phase-3.md 第 13.8 节。进入、返回和原生返回的声明在页面（app.mjs）。
import { h } from './dom.mjs';
import { dirSizeText, fileSizeText, formatFullDate, modeText } from './format.mjs';
import { icon, kindOf } from './icons.mjs';
import { EntryKind } from './protocol.mjs';

// el：#info 面板。选项：
// stat(path) → Promise<statted 回答>；size(path, signal) → Promise<sized 回答>，signal 中止后请求静默作废（连接层同时通知模块停止统计）；
// rootPath()：根目录的绝对路径，拼完整路径用；round()：页面的数据轮次，每次 changed 加一；
// back：给了就在头部最左边放「返回」（Mac，和没有原生返回的环境）。
export function mountInfo(el, { stat, size, rootPath, round, back = null }) {
  const head = h('div', { class: 'phead' }), body = h('div', { class: 'pbody ibody selectable' });
  el.replaceChildren(head, body);

  let path = null, seed = null;
  let reply = null, failure = null; // 属性的回答；取属性失败的原因
  let sizing = null; // 文件夹大小这一次统计：{ abort, round, phase: 'running' | 'done' | 'failed', result, message }
  let token = 0; // 取属性的序号：新的取代旧的，旧的回答不再用
  let opens = 0, stoppedAt = -1; // 同预览：释放只在停止之后没有再打开过时才做

  const entry = () => reply ?? seed;
  // 指向工作目录内的链接按目标显示：种类和图标看目标的名字（链接自己叫什么不管），没有目标的（外链接）看自己。
  const shownKind = () => {
    const { kind, name } = entry(), target = reply?.target;
    return kindOf({ kind, name: target ? target.slice(target.lastIndexOf('/') + 1) : name });
  };
  const kindText = () => {
    const base = shownKind().label;
    if (entry().kind === EntryKind.LINK) return `${base}（指向工作目录外或已失效）`;
    return reply?.link ? `${base}（链接）` : base;
  };

  const row = (label, value) => h('div', { class: 'irow' }, h('span', { class: 'ilabel secondary' }, label), h('div', { class: 'ivalue' }, value));
  const link = (label, run) => h('button', { class: 'link', onclick: run }, label);
  const note = (title, detail, action) => h('div', { class: 'empty' }, h('p', {}, title), detail ? h('p', { class: 'secondary' }, detail) : null, action ? link(action.label, action.run) : null);

  // 文件夹大小这一行：计算中、结果（上一轮的标「上次统计」）、失败。结果可能不全（没统计完），也可能是上一轮的，这两种都放「重新统计」。
  function sizeRow() {
    if (sizing.phase === 'running') return row('大小', '计算中…');
    if (sizing.phase === 'failed') return row('大小', [h('span', { class: 'warn' }, `统计失败：${sizing.message}`), ' ', link('重新统计', startSize)]);
    const old = sizing.round !== round();
    return row('大小', [dirSizeText(sizing.result), old ? ' · 上次统计' : '', ...(old || !sizing.result.complete ? [' ', link('重新统计', startSize)] : [])]);
  }

  function paint() {
    const focused = body.contains(document.activeElement);
    const { name, kind } = entry(), where = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '工作目录';
    head.replaceChildren(...(back ? [h('button', { class: 'icon', 'aria-label': '返回', title: '返回', onclick: back }, icon('back', 18))] : []),
      h('span', { class: 'pico', 'aria-hidden': 'true' }, icon(shownKind().glyph, 22)),
      h('div', { class: 'grow' }, h('div', { class: 'pname truncate', title: path }, name), h('div', { class: 'pmeta caption secondary truncate' }, '属性')));
    if (failure !== null) body.replaceChildren(note('读不到属性', failure, { label: '重试', run: () => load() }));
    else if (reply === null) body.replaceChildren(h('div', { class: 'empty secondary' }, h('p', {}, '读取中…')));
    else {
      const { size: bytes, target, mtimeMs, birthtimeMs, mode } = reply;
      body.replaceChildren(
        row('种类', kindText()),
        ...(kind === EntryKind.DIR && sizing ? [sizeRow()] : Number.isInteger(bytes) ? [row('大小', fileSizeText(bytes))] : []),
        ...(target !== undefined ? [row('链接到', target)] : []),
        row('位置', where),
        row('完整路径', `${rootPath()}/${path}`),
        ...(Number.isInteger(mtimeMs) ? [row('修改时间', formatFullDate(mtimeMs))] : []),
        ...(Number.isInteger(birthtimeMs) ? [row('创建时间', formatFullDate(birthtimeMs))] : []),
        ...(Number.isInteger(mode) ? [row('权限', modeText(mode))] : []),
      );
    }
    if (focused) { body.tabIndex = -1; body.focus(); } // 重画换掉了聚焦的按钮：焦点留在属性页里
  }

  // 取属性。文件夹第一次取到时开始统计；之后（changed 重取）不自动重新统计，只把已有的结果标成上次统计。
  async function load() {
    const mine = ++token, asked = path;
    failure = null;
    if (reply === null) paint();
    try {
      const next = await stat(asked);
      if (mine !== token) return;
      reply = next;
      if (next.kind === EntryKind.DIR && sizing === null) startSize();
    } catch (error) {
      if (error.stale || mine !== token) return;
      failure = error.message;
    }
    paint();
  }

  // 统计文件夹：新的开始时旧的先中止（连接层告诉模块停）。关闭、换会话、根目录变化时也走中止，等待不会拖到超时。
  function startSize() {
    sizing?.abort.abort();
    const abort = new AbortController(), mine = sizing = { abort, round: round(), phase: 'running' }, asked = path;
    paint();
    size(asked, abort.signal).then(result => Object.assign(mine, { phase: 'done', result }), error => {
      if (error.stale) return null; // 取消、换会话：静默
      return Object.assign(mine, { phase: 'failed', message: error.message });
    }).then(done => { if (done && sizing === mine) paint(); });
  }

  return {
    // seed：目录树里这一行（名字、种类），属性回来之前先画头部。
    open(next, row) {
      this.close();
      opens++;
      path = next;
      seed = { name: row.name, kind: row.kind };
      load();
    },
    // 一轮结束：重取属性，不自动重新统计；已有的统计结果马上标成上次统计（页面的数据轮次变了）。
    refresh() { if (path !== null) { if (reply !== null) paint(); load(); } },
    // 停止（逻辑关闭，立即）：取消统计、作废在途的回答；画面留着，由 release 在退场结束时清掉。
    stop() {
      sizing?.abort.abort();
      sizing = null;
      token++;
      path = seed = reply = failure = null;
      stoppedAt = opens;
    },
    release() {
      if (stoppedAt !== opens) return;
      head.replaceChildren();
      body.replaceChildren();
    },
    close() { this.stop(); this.release(); },
    get path() { return path; },
  };
}
