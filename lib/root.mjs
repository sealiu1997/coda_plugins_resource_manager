// 从会话取根目录。这是唯一读取 `threads/<id>` 返回结构（checkout）的地方，它不是文档写明的契约。
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { RootState } from '../view/protocol.mjs';

export const NO_ROOT = Object.freeze({ state: RootState.NONE, path: null, project: null });

// project 不是根目录的身份（保存、恢复、换根都只看路径），但变了页面要重画标题，所以算进来。
export const sameRoot = (a, b) => a?.state === b?.state && a?.path === b?.path && (a?.project ?? null) === (b?.project ?? null);

// worktree 的项目名：原仓库的文件夹名。Coda 的 worktree 目录以 UUID 命名，只看目录名认不出项目。
// worktree 根目录的 .git 是一个文件，写着 `gitdir: <主仓库的 .git>/worktrees/<名字>`；那个目录里的 commondir（相对它自己）指向主仓库的 git 目录。
// 只读这两个文件，不调 git。主仓库的 git 目录叫 .git 时取上一级的文件夹名，是裸仓库（foo.git）时去掉 .git 后缀。
// 任何一步读不到、格式不对都是 null（页面退回显示文件夹名），不抛。
export async function projectOf(root) {
  try {
    const link = /^gitdir:[ \t]*(.+?)[ \t]*\r?\n?$/.exec(await readFile(resolve(root, '.git'), 'utf8'));
    if (!link) return null;
    const gitdir = resolve(root, link[1]);
    const common = (await readFile(resolve(gitdir, 'commondir'), 'utf8')).trim();
    if (!common) return null;
    const main = resolve(gitdir, common);
    const name = basename(main) === '.git' ? basename(dirname(main)) : basename(main).replace(/\.git$/, '');
    return name && name !== '/' ? name : null;
  } catch {
    return null;
  }
}

// checkout.state 是 preparing、ready、failed。failed 没有可看的目录，按 none；
// ready 但目录已不在（归档后工作树被回收）是 gone。
// 查询失败（接口出错、读目录权限）直接抛出，由调用方保留上一次的结果。
export async function queryRoot(coda, session) {
  if (!session) return NO_ROOT;
  const thread = await coda.api(`threads/${encodeURIComponent(session)}`);
  const checkout = thread?.checkout;
  if (!checkout || typeof checkout !== 'object') return NO_ROOT;
  if (checkout.state === 'preparing') return { state: RootState.PREPARING, path: null, project: null };
  if (checkout.state !== 'ready' || typeof checkout.path !== 'string' || !checkout.path) return NO_ROOT;
  try {
    const real = await realpath(checkout.path);
    if ((await stat(real)).isDirectory()) return { state: RootState.READY, path: real, project: checkout.kind === 'worktree' ? await projectOf(real) : null };
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  return { state: RootState.GONE, path: checkout.path, project: null };
}
