// 页面的纯状态：目录树、状态保留。不碰 DOM，请求与代次在 connection.mjs，设计见 docs/design/phase-1.md 第 6、7 节。
import { DEFAULT_SORT, ErrorCode, RootState, Type, parseSort, splitRelative } from './protocol.mjs';

export const STATE_LIMIT = 96 * 1024;
export const MAX_PARALLEL = 8;
export const MAX_LOADED = 100_000; // 读回保存的条数时认的上界（view 侧校验用），与服务端的条目上限各自独立
// 恢复时每个目录最多取够这么多条（约 10 页）：#reload 串行取够才显示，条数太大返回后会等很久。
// 只管「按保存的条数恢复」，用户已经翻出来的条数不受限；也和 lib/tree.mjs 的目录上限无关。
export const RESTORE_LIMIT = 20_000;
const MAX_LOADED_DIRS = 500;
export const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
export const parentOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);

// 两种视图：列表（目录树，可以展开多层）和图标（一次看一层，看的那一层是 cwd）。全局一份，和排序一样。
export const View = Object.freeze({ LIST: 'list', ICONS: 'icons' });
export const parseView = raw => (raw === View.ICONS ? View.ICONS : View.LIST);

async function pool(items, limit, fn) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await fn(items[index++]);
  }));
}

// 根目录不可用时，树页和文件页显示的说明。root 为 null 表示还没收到。
export function noticeText(root, session) {
  if (!root) return '正在读取…';
  if (!session) return '没有打开的会话。';
  return {
    [RootState.NONE]: '这个会话没有可浏览的工作目录。',
    [RootState.PREPARING]: '工作树还在准备，好了会自动显示。',
    [RootState.GONE]: '工作目录已不存在，可能已随归档收回。再发消息会重建，之后自动恢复。',
  }[root.state] ?? '';
}

export class Model {
  session = null;
  root = null; // 收到 root 之前是 null
  dirs = new Map(); // path → { entries, next, loaded, loading, error, token }
  expanded = new Set(); // 不变量：展开的目录，它的每一级上层也展开
  wanted = new Map(); // 恢复状态时各目录要取够的条数，第一次取用后删掉
  selected = null; // 选中的条目（高亮和键盘移动用，文件夹、不能打开的条目都可以）
  opened = null; // 页内预览中的文件（两端一样）；null 是在看目录
  showHidden = false;
  sort = DEFAULT_SORT; // 全局一份，由页面存进 persisted
  view = View.LIST; // 全局一份，由页面存进 persisted
  cwd = ''; // 图标视图正在看的目录，'' 是根目录；每个会话一份，连同当时的根目录存进会话状态
  scope = 0; // 根目录的身份：这个会话认定「换了根目录」时加一，依赖根目录的东西（待恢复的滚动）据此作废
  #round = 0; // refresh 的轮次：新一轮开始后，旧一轮不再派发排队的目录
  #nav = 0; // 导航上下文：进入、返回、换会话、回到根目录、回退各加一；一次请求只有发出时的上下文还在，才能改 cwd
  #savedRoot = null; // 会话状态里存的根目录；收到这个会话第一条就绪的 root 之前，是否「同一个根目录」靠它比
  #resolved = false; // 这个会话已经收到过就绪的 root
  #rootPath = null; // 就绪的根目录路径，之后的变化靠它比
  #quiet = false; // cwd 是从保存的状态里恢复的，还没确认过：它没了不提示
  #noticed = -1; // 提示过「文件夹已不存在」的轮次，一轮只提示一次

  // onLost(path)：cwd 没了、已经退到上一层时调用一次（恢复时不调用）。
  constructor({ link, onChange = () => {}, onLost = () => {} }) { Object.assign(this, { link, onChange, onLost }); }

  get ready() { return this.root?.state === RootState.READY; }
  // 刷新的轮次：换会话和每次 refresh（含换排序、换视图、changed）都加一。定位操作拿它判断「期间有没有刷新过」。
  get round() { return this.#round; }

  // 模块来的消息统一从这里进。session 带上这个会话保存的状态；返回值同各个处理方法。
  receive(message, saved = null) {
    switch (message.type) {
      case Type.SESSION: return this.onSession(message, saved);
      case Type.ROOT: return this.onRoot(message);
      case Type.CHANGED: return this.onChanged(message);
      case Type.LISTED: case Type.CHUNK: return this.link.receive(message);
    }
  }

  // 换会话：清空一切，展开状态换成这个会话保存的。
  onSession({ generation, session }, saved = null) {
    this.link.reset(generation);
    this.#round++;
    this.session = session ?? null;
    this.root = null;
    this.dirs = new Map();
    this.#nav++;
    this.#resolved = false;
    this.#rootPath = null;
    this.#savedRoot = typeof saved?.root === 'string' ? saved.root : null;
    this.cwd = typeof saved?.cwd === 'string' ? saved.cwd : '';
    this.#quiet = this.cwd !== '';
    this.wanted = new Map(Object.entries(saved?.loaded ?? {}).map(([path, count]) => [path, Math.min(count, RESTORE_LIMIT)]));
    const paths = (saved?.expanded ?? []).filter(path => path !== '');
    this.expanded = new Set(paths.filter(path => !path.includes('/') || paths.includes(path.slice(0, path.lastIndexOf('/')))));
    this.selected = saved?.selected ?? null;
    this.opened = saved?.opened ?? null;
    this.onChange();
  }

  // 只换根目录状态，不动会话状态；ready 时重新取全部。
  // project：worktree 的原仓库文件夹名（根目录标题用），不是根目录的身份。
  onRoot({ generation, state, path, project = null }) {
    if (generation !== this.link.generation) return null;
    if (state === RootState.READY) this.#identify(path);
    this.root = { state, path, project: typeof project === 'string' && project ? project : null };
    this.onChange();
    return state === RootState.READY ? this.refresh() : Promise.resolve();
  }

  // 根目录有没有换：重建页面后 model.root 是 null，不能靠「路径变了」，否则每次重建都算换了。
  // 这个会话第一条就绪的 root 和保存的根目录比（没存根目录的旧状态当作没换），之后的 root 和上一次比。换了就全部回到根目录。
  #identify(path) {
    const changed = this.#resolved ? this.#rootPath !== path : this.#savedRoot !== null && this.#savedRoot !== path;
    this.#resolved = true;
    this.#rootPath = path;
    if (!changed) return;
    this.scope++;
    this.#nav++;
    this.cwd = '';
    this.selected = this.opened = null;
    this.#quiet = false;
    this.wanted = new Map();
  }

  onChanged({ generation }) {
    return generation === this.link.generation && this.ready ? this.refresh() : null;
  }

  // 重新取根和全部已展开的目录，并行不超过 8 个。cap：这一轮每个目录最多取够这么多条（换排序时用）。
  // 每一轮带递增的轮次：只查 current() 不够，旧一轮的池子还会启动排队中的目录，递增它们的 token，作废较新的加载。
  refresh({ cap = Infinity } = {}) {
    if (!this.ready) return Promise.resolve();
    const { generation } = this.link, round = ++this.#round;
    return pool(this.requested(), MAX_PARALLEL, path => (round === this.#round ? this.#reload(path, generation, { cap }) : undefined));
  }

  // 一轮要取的目录：列表是根和展开的，图标是根和 cwd；同一路径只取一次。
  requested() { return this.view === View.ICONS ? [...new Set(['', this.cwd])] : ['', ...this.expanded]; }

  // 换视图：马上按新的集合刷新，作废旧的排队轮次；回来之前显示已有的内容，没有就显示读取中。展开状态不动。
  setView(view) {
    const next = parseView(view);
    if (next === this.view) return Promise.resolve();
    this.view = next;
    this.onChange();
    return this.refresh();
  }

  // 图标视图进入一层：cwd 换成它并加载。返回 levels 层（缺省一层，到根为止）。
  enter(path) {
    this.cwd = path;
    return this.#go();
  }

  leave(levels = 1) {
    let next = this.cwd;
    for (let i = 0; i < levels && next !== ''; i++) next = parentOf(next);
    if (next === this.cwd) return Promise.resolve();
    this.cwd = next;
    return this.#go();
  }

  #go() {
    this.#nav++;
    this.#quiet = false;
    this.onChange();
    return this.retry(this.cwd);
  }

  // 换排序：已加载的目录按新顺序重新取，取够现在的条数，这次最多 RESTORE_LIMIT 条；每个目录一次替换。
  setSort(sort) {
    const next = parseSort(sort);
    if (!next || next === this.sort) return Promise.resolve();
    this.sort = next;
    this.onChange();
    return this.refresh({ cap: RESTORE_LIMIT });
  }

  // 取够已加载的条数，一次替换；同目录有更新的请求就作废这一个。一次加载固定一种排序。
  // more、expired：「再显示」遇到游标过期转过来时，条数要比现在多一条，而且已经算重取过一次，不再重取。
  // 返回结局（定位操作等着它）：ok（取够并提交了）、failed（失败，失败行照常显示）、void（被作废：会话换了、有更新的加载、目录没了）。
  // 正在进行的这一次记在 dir.pending 上，whenLoaded 等它。
  #reload(path, generation, { cap = Infinity, more = false, expired = false } = {}) {
    if (this.link.generation !== generation) return Promise.resolve('void'); // 排队时会话已换，旧任务不碰新会话
    let dir = this.dirs.get(path);
    if (!dir) this.dirs.set(path, dir = { entries: [], next: null, loaded: false, loading: false, error: null, token: 0, pages: 0, sortFallback: false, pending: null });
    return dir.pending = this.#load(dir, path, generation, { cap, more, expired });
  }

  async #load(dir, path, generation, { cap, more, expired }) {
    const token = ++dir.token, { sort } = this, nav = this.#nav;
    const want = more ? dir.entries.length + 1 : Math.min(Math.max(dir.entries.length, this.wanted.get(path) ?? 0), cap);
    dir.loading = true;
    this.onChange();
    const current = () => this.link.generation === generation && this.dirs.get(path) === dir && dir.token === token;
    let outcome = 'void';
    try {
      let entries = [], next = null, pages = 0, sortFallback = false;
      do {
        let reply;
        try {
          reply = await this.link.call('list', { path, cursor: next, sort });
        } catch (error) {
          // 游标过期（快照被淘汰、释放，或根目录变了）：丢掉这一轮累积的，从第一页重取一次，再失败走失败行。
          if (error.code !== ErrorCode.CURSOR_EXPIRED || expired || !current()) throw error;
          expired = true;
          entries = []; next = null; pages = 0; sortFallback = false;
          continue;
        }
        if (!current()) return 'void'; // 回答到了、继续前会话换了或有更新的加载，不再取下一页
        if (pages === 0) sortFallback = reply.sortFallback === true;
        entries.push(...reply.entries);
        next = reply.nextCursor ?? null;
        pages++;
      } while (pages === 0 || (next && entries.length < want));
      if (!current()) return 'void';
      Object.assign(dir, { entries, next, loaded: true, error: null, pages, sortFallback, sort });
      this.wanted.delete(path); // 成功后才删：取页失败后重试还要取够保存的条数
      if (path === this.cwd) this.#quiet = false;
      outcome = 'ok';
    } catch (error) {
      if (error.stale || !current()) return 'void';
      if (error.code === ErrorCode.NOT_FOUND && path !== '') this.#lost(path, nav);
      else if (error.code !== ErrorCode.NO_ROOT) {
        dir.error = { code: error.code, message: error.message };
        if (path === this.cwd) this.#quiet = false;
        outcome = 'failed';
      }
    } finally {
      if (current()) dir.loading = false;
      this.onChange();
    }
    return outcome;
  }

  // 等这个目录正在进行的加载（或「再显示」）结束，给出同样的四种结局：ok、end（没有下一页了，只对 fetchNext）、failed、void。
  // 没在加载：已加载的是 ok，只有失败行的是 failed，没有这个目录的是 void。
  async whenLoaded(path) {
    const dir = this.dirs.get(path);
    if (!dir) return 'void';
    if (dir.loading && dir.pending) return dir.pending;
    return dir.loaded ? 'ok' : dir.error ? 'failed' : 'void';
  }

  // 目录没了（not_found）：所有列目录入口都走这里。先清掉失效的子树；cwd 在里面、而且发出请求以来没有导航过，就退到上一层。
  // 退到哪一层靠新发的请求：它再 not_found 又走到这里，所以每级只试一次；别的错误停在那一级，显示失败行和重试。
  // 清掉子树后原目录对象没了，原请求的检查必然为假，但回退不靠它：回退看的是导航上下文，每一级有自己的请求。
  #lost(path, nav) {
    const covers = nav === this.#nav && inside(this.cwd, path);
    // 迟到的上层失败（发出后用户已经进了别处）：清它的子树，但正在加载的 cwd 的条目留着，不然它的回答提交不上。
    this.#drop(path, covers ? null : this.cwd);
    if (!covers) return;
    this.#nav++;
    this.cwd = parentOf(path);
    if (!this.#quiet && this.#noticed !== this.#round && this.view === View.ICONS) {
      this.#noticed = this.#round;
      this.onLost(path);
    }
    this.onChange();
    this.retry(this.cwd);
  }

  #drop(path, keep = null) {
    for (const key of [...this.dirs.keys()]) if (key !== keep && inside(key, path)) this.dirs.delete(key);
    for (const key of [...this.expanded]) if (inside(key, path)) this.expanded.delete(key);
  }

  toggle(path) {
    if (this.expanded.has(path)) {
      for (const key of [...this.expanded]) if (inside(key, path)) this.expanded.delete(key);
      // cwd 的条目留着：图标视图还在看它
      for (const key of [...this.dirs.keys()]) if (key !== '' && key !== this.cwd && inside(key, path)) this.dirs.delete(key);
      this.onChange();
    } else {
      this.expanded.add(path);
      this.retry(path);
    }
  }

  retry(path) { return this.ready ? this.#reload(path, this.link.generation) : Promise.resolve(); }

  // 「再显示」：取下一页接在后面。
  async loadMore(path) { await this.#more(path); }

  // 取下一页接在后面，告诉调用方结局（定位操作用）：ok（接上了新条目）、end（没有下一页了）、failed（失败，失败行照常显示）、void（这次读取被作废了）。
  // 不碰 wanted，也不按 wanted 取够；目录正在加载时由调用方先 whenLoaded。
  async fetchNext(path) { return this.#more(path); }

  async #more(path) {
    const dir = this.dirs.get(path), { generation } = this.link;
    if (!dir || !this.ready || dir.loading) return 'void';
    if (!dir.next) return 'end';
    // 游标是按另一种排序取的（换排序时这个目录没重建过）：不用它，从第一页重取，条数比现在多一条。
    if (dir.sort !== this.sort) return this.#grown(path, dir, generation);
    return dir.pending = this.#page(dir, path, generation); // 本次读取登记在 dir.pending 上：whenLoaded 等的就是它（游标过期后的重取经 #reload，自己登记）
  }

  async #page(dir, path, generation) {
    const token = ++dir.token, nav = this.#nav;
    dir.loading = true;
    this.onChange();
    const current = () => this.link.generation === generation && this.dirs.get(path) === dir && dir.token === token;
    let outcome = 'void';
    try {
      const reply = await this.link.call('list', { path, cursor: dir.next, sort: this.sort });
      if (!current()) return 'void';
      dir.entries = dir.entries.concat(reply.entries);
      Object.assign(dir, { next: reply.nextCursor ?? null, error: null, pages: dir.pages + 1 });
      outcome = 'ok';
    } catch (error) {
      if (error.stale || !current()) return 'void';
      // 游标过期：从第一页重取，条数比现在多一条，所以还会接着往下取。重取自己管 loading。
      if (error.code === ErrorCode.CURSOR_EXPIRED) return this.#grown(path, dir, generation);
      if (error.code === ErrorCode.NOT_FOUND && path !== '') this.#lost(path, nav);
      else { dir.error = { code: error.code, message: error.message }; outcome = 'failed'; }
    } finally {
      if (current()) dir.loading = false;
      this.onChange();
    }
    return outcome;
  }

  // 从第一页重取、条数比现在多一条（已经算重取过一次）：结局按条数有没有增加给。
  async #grown(path, dir, generation) {
    const before = dir.entries.length;
    const outcome = await this.#reload(path, generation, { more: true, expired: true });
    return outcome === 'ok' ? (this.dirs.get(path)?.entries.length > before ? 'ok' : 'end') : outcome;
  }

  // 选中只影响高亮，不发 onChange：重画会换掉全部行节点，双击的第二下点击之后 dblclick 就丢了。页面的 selectEntry 负责切高亮和保存。返回是不是变了。
  select(path) {
    if (this.selected === path) return false;
    this.selected = path;
    return true;
  }
  // 打开文件分两步：设预览（opened）、设选中（selected），在同一次同步操作里做完，只触发一次重画。
  // 目录树里打开两步都做；从搜索结果里打开只设预览（结果有自己的选中，不改被遮住的目录树的选中）。
  // 返回（closeFile）只清 opened，选中留着。
  openFile(path, { select = true } = {}) {
    this.opened = path;
    if (select) this.selected = path;
    this.onChange();
  }
  closeFile() { this.opened = null; this.onChange(); }
  setShowHidden(on) { this.showHidden = on; this.onChange(); }
  // loaded：取过不止一页的目录已加载的条数，只存条数不存内容；第一页每次都会重新取，不用存。
  snapshot() {
    const loaded = {};
    for (const [path, dir] of this.dirs) if (dir.pages > 1 && dir.entries.length > 0) loaded[path] = dir.entries.length;
    // 还没收到这个会话就绪的 root 时，cwd 和根目录还是保存的那一份，原样存回去，不能被重建途中的一次保存冲掉。
    const root = this.#resolved ? this.#rootPath : this.#savedRoot;
    return { expanded: [...this.expanded], selected: this.selected, opened: this.opened, loaded, cwd: this.cwd, ...(root === null ? {} : { root }) };
  }
}

// ---- 状态保留：setState 没有会话维度，内部按会话分开 ----

export const byteSize = value => new TextEncoder().encode(JSON.stringify(value)).length;
const depth = path => path.split('/').length;
const strings = (value, max) => (Array.isArray(value) ? value.filter(s => typeof s === 'string' && s.length <= 1024).slice(0, max) : []);

const parseLoaded = raw => Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {})
  .filter(([path, count]) => path.length <= 1024 && Number.isSafeInteger(count) && count > 0 && count <= MAX_LOADED).slice(0, MAX_LOADED_DIRS));

// cwd 要是后端认的相对路径（规则同 lib/paths.mjs），而且写法规整：model 里的路径都是 joinPath 拼出来的，不带空段和 `.`。
const cleanRelative = path => { const { segments } = splitRelative(path); return segments !== undefined && segments.join('/') === path; };

// 读回来的值可能是别的版本或坏的，只认自己的形状。
export function parseState(raw) {
  const state = { v: 1, seq: 0, hidden: false, sort: DEFAULT_SORT, view: View.LIST, sessions: {} };
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return state;
  state.hidden = raw.hidden === true;
  state.sort = parseSort(raw.sort) ?? DEFAULT_SORT;
  state.view = parseView(raw.view);
  state.seq = Number.isSafeInteger(raw.seq) ? raw.seq : 0;
  for (const [id, item] of Object.entries(raw.sessions ?? {})) {
    if (!item || typeof item !== 'object') continue;
    const scroll = item.scroll ?? {}, num = n => (Number.isFinite(n) && n >= 0 ? n : 0);
    state.sessions[id] = {
      at: Number.isSafeInteger(item.at) ? item.at : 0, expanded: strings(item.expanded, 5000),
      selected: typeof item.selected === 'string' && item.selected.length <= 1024 ? item.selected : null,
      // 0.6.0 的状态没有 opened：selected 只当选中，不打开预览。
      opened: typeof item.opened === 'string' && item.opened.length <= 1024 ? item.opened : null,
      // 滚动位置是按当时的排序存的；旧版本没有这个字段，那时一定是默认排序。
      // 两种视图各存各的位置和当时的排序：tree 和 sort 是列表的，grid 和 gridSort 是图标的（旧版本没有后两个）。
      scroll: { tree: num(scroll.tree), top: num(scroll.top), left: num(scroll.left), sort: parseSort(scroll.sort) ?? DEFAULT_SORT,
        grid: num(scroll.grid), gridSort: parseSort(scroll.gridSort) ?? DEFAULT_SORT },
    };
    // cwd 和存它时的根目录：超长或形状不对当作没有，回到根目录。旧版本没有这两个字段。
    const path = value => (typeof value === 'string' && value.length <= 1024 ? value : undefined);
    if (path(item.cwd) !== undefined && path(item.root) !== undefined && cleanRelative(item.cwd)) Object.assign(state.sessions[id], { cwd: item.cwd, root: item.root });
    const loaded = parseLoaded(item.loaded);
    if (Object.keys(loaded).length > 0) state.sessions[id].loaded = loaded;
  }
  return state;
}

export function putSession(state, session, record) {
  state.seq++;
  state.sessions[session] = { ...record, at: state.seq };
}

// 总量不超过 limit（序列化后的 UTF-8 字节）：先淘汰最旧的会话，再从深到浅裁当前会话的展开目录，最后兜底清空。不抛。
export function trimState(state, keep, limit = STATE_LIMIT) {
  const next = { ...state, sessions: { ...state.sessions } };
  const fits = () => byteSize(next) <= limit;
  const others = Object.keys(next.sessions).filter(id => id !== keep).sort((a, b) => next.sessions[a].at - next.sessions[b].at);
  for (const id of others) { if (fits()) return next; delete next.sessions[id]; }
  let current = next.sessions[keep];
  if (fits() || !current) return fits() ? next : { ...next, sessions: {} };
  // 条数只影响返回后的滚动落点，比展开状态先舍。
  current = next.sessions[keep] = { ...current, loaded: {} };
  if (fits()) return next;
  // 按层级从浅到深排，取最长的、放得下的前缀；前缀仍然满足「上层也展开」。
  const sorted = [...current.expanded].sort((a, b) => depth(a) - depth(b));
  let low = 0, high = sorted.length;
  const withCount = count => { next.sessions[keep] = { ...current, expanded: sorted.slice(0, count) }; return fits(); };
  while (low < high) { const mid = (low + high + 1) >> 1; if (withCount(mid)) low = mid; else high = mid - 1; }
  if (withCount(low)) return next;
  return { ...next, sessions: {} };
}
