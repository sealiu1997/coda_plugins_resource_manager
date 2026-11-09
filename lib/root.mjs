// 从会话取根目录。这是唯一读取 `threads/<id>` 返回结构（checkout）和 `agents` 返回结构（projects）的地方，它们都不是文档写明的契约。
import { realpath, stat } from 'node:fs/promises';
import { RootState } from '../view/protocol.mjs';

export const NO_ROOT = Object.freeze({ state: RootState.NONE, path: null, project: null });

// project 不是根目录的身份（保存、恢复、换根都只看路径），但变了页面要重画标题，所以算进来。
export const sameRoot = (a, b) => a?.state === b?.state && a?.path === b?.path && (a?.project ?? null) === (b?.project ?? null);

// worktree 的项目名：Coda 里这个会话所属项目的名字。Coda 的 worktree 目录以 UUID 命名，只看目录名认不出项目。
// 项目 id 是会话 checkout 里的 projectId（缺了看 thread.projectId），名字查 `agents` 回答里的 projects（[{ id, name }]）。
// 项目名默认是原仓库的文件夹名；在 Coda 里改过名字时显示改后的。不读任何文件：项目名不来自工作目录之外的东西（设计第 19.7 节）。
// 取不到（没有 id、接口失败、列表里没有这个 id、名字为空）都是 null，页面退回显示文件夹名；这里从不抛：
// queryRoot 抛出的意思是「保留上一次的根目录」，项目名取不到不该触发它。
// 项目列表按机器缓存（WeakMap：一个 coda 一份），很少变：超过 MAX_AGE 或查不到这个 id 时重取，两次请求之间至少隔 MISS_AGE（接口失败也算一次），不会反复请求；同时发起的查询共用一次请求。
const MAX_AGE = 60_000, MISS_AGE = 5_000, NAME_LIMIT = 256;
const caches = new WeakMap(); // coda → { names: Map(id → name) | null, at: 上次请求的时间, pending: 在途的请求 | null }

// 名字：去掉首尾空白，空的、含控制字符的不用，太长的按码点截断。
function cleanName(name) {
  if (typeof name !== 'string') return null;
  const text = name.trim();
  if (!text || /\p{Cc}/u.test(text)) return null;
  return Array.from(text).slice(0, NAME_LIMIT).join('');
}

async function fetchNames(coda, cache, now) {
  cache.at = now();
  try {
    const reply = await coda.api('agents');
    const names = new Map();
    for (const project of Array.isArray(reply?.projects) ? reply.projects : []) {
      if (typeof project?.id === 'string' && project.id) names.set(project.id, cleanName(project.name));
    }
    cache.names = names;
  } catch { /* 取不到：保留上一次的列表，名字退回文件夹名 */ }
}

async function projectNameOf(coda, projectId, now) {
  if (typeof projectId !== 'string' || !projectId) return null;
  try {
    let cache = caches.get(coda);
    if (!cache) caches.set(coda, cache = { names: null, at: -Infinity, pending: null });
    const age = now() - cache.at, stale = !cache.names || age >= MAX_AGE || (!cache.names.has(projectId) && age >= MISS_AGE);
    if (stale) await (cache.pending ??= fetchNames(coda, cache, now).finally(() => { cache.pending = null; }));
    else if (cache.pending) await cache.pending;
    return cache.names?.get(projectId) ?? null;
  } catch {
    return null;
  }
}

// checkout.state 是 preparing、ready、failed。failed 没有可看的目录，按 none；
// ready 但目录已不在（归档后工作树被回收）是 gone。
// 查询失败（接口出错、读目录权限）直接抛出，由调用方保留上一次的结果。
export async function queryRoot(coda, session, { now = Date.now } = {}) {
  if (!session) return NO_ROOT;
  const thread = await coda.api(`threads/${encodeURIComponent(session)}`);
  const checkout = thread?.checkout;
  if (!checkout || typeof checkout !== 'object') return NO_ROOT;
  if (checkout.state === 'preparing') return { state: RootState.PREPARING, path: null, project: null };
  if (checkout.state !== 'ready' || typeof checkout.path !== 'string' || !checkout.path) return NO_ROOT;
  try {
    const real = await realpath(checkout.path);
    if ((await stat(real)).isDirectory()) return { state: RootState.READY, path: real, project: checkout.kind === 'worktree' ? await projectNameOf(coda, checkout.projectId ?? thread.projectId, now) : null };
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  return { state: RootState.GONE, path: checkout.path, project: null };
}
