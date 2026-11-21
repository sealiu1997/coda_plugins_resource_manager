// 从会话取根目录：经 coda/thread@1 的只读查询 workspace 取 { path, project: { id, name }, state }。
import { realpath, stat } from 'node:fs/promises';
import { RootState } from '../view/protocol.mjs';

export const NO_ROOT = Object.freeze({ state: RootState.NONE, path: null, project: null });

// project 不是根目录的身份（保存、恢复、换根都只看路径），但变了页面要重画标题，所以算进来。
export const sameRoot = (a, b) => a?.state === b?.state && a?.path === b?.path && (a?.project ?? null) === (b?.project ?? null);

// Coda 的 worktree 目录以 UUID 命名，只看目录名认不出项目，所以给页面带上项目名；普通目录的目录名本身就能认出，project 留 null。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_LIMIT = 256;
const baseName = path => path.split('/').filter(Boolean).pop() ?? '';

// 名字：去掉首尾空白，空的、含控制字符的不用，太长的按码点截断。
function cleanName(name) {
  if (typeof name !== 'string') return null;
  const text = name.trim();
  if (!text || /\p{Cc}/u.test(text)) return null;
  return Array.from(text).slice(0, NAME_LIMIT).join('');
}

// workspace.state 取 preparing、ready、failed、gone 之一，path 只在 ready 时有值。
// failed 没有可看的目录，按 none；ready 但目录已不在（归档后工作树被回收）按 gone。
// 查询失败（接口出错、读目录权限）直接抛出，由调用方保留上一次的结果。
export async function queryRoot(coda, session) {
  if (!session) return NO_ROOT;
  const detail = await coda.query({ kind: 'coda/thread@1', id: session }, 'workspace', {});
  if (!detail || typeof detail !== 'object') return NO_ROOT;
  if (detail.state === 'preparing') return { state: RootState.PREPARING, path: null, project: null };
  if (detail.state === 'gone') return { state: RootState.GONE, path: typeof detail.path === 'string' && detail.path ? detail.path : null, project: null };
  if (detail.state !== 'ready' || typeof detail.path !== 'string' || !detail.path) return NO_ROOT;
  try {
    const real = await realpath(detail.path);
    if ((await stat(real)).isDirectory()) {
      const project = UUID.test(baseName(real)) ? cleanName(detail.project?.name) : null;
      return { state: RootState.READY, path: real, project };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  return { state: RootState.GONE, path: detail.path, project: null };
}
