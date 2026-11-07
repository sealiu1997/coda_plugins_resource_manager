// 「在目录中显示」：一次可以取消的定位操作，由页面发起、页面持有，读目录复用模型的接口（设计见 docs/design/phase-3.md 第 18.3 节）。
// 五样：
// - 持有：这个 locator，run 是定位轮次；开始时加一，又发起一次、cancel()、完成时都加一。
// - 作废：身份（会话、根目录、排序、视图、隐藏开关、模型的刷新轮次，由页面拼成一个串）变了，或用户接管计数变了，或轮次变了。
//   用户接管只看用户的输入（pointerdown、wheel、touchstart、keydown、菜单里的操作），程序自己的展开、进入目录、滚动、选中都不算。
// - 结束：找到（最后一次核对身份，选中并居中，同一个同步过程里标成完成）、读尽了没有、到上限、读失败、作废。
// - 超时：每一页读取由 link 的 30 秒兜底；失败就结束，不按 next 自动重试同一页。
// - 被替换：新的定位让旧的作废；作废后不再选中、不再滚动，已经展开的上层和已经读到的条目留着。
import { RESTORE_LIMIT, View, parentOf } from './model.mjs';

export const MESSAGES = {
  end: '找不到这一项，可能已被删除或改名',
  limit: '已打开所在的文件夹，这一项在前 2 万条之外',
};

// model；identity()：身份串；takeover()：用户接管计数；
// ops：{ begin(parent | null)：清空搜索、丢掉目标视图还在等的滚动恢复，图标视图时进入上一层（parent）；render()：同步重画正在用的视图；
//   select(path)、center(path)：选中并居中；openFolder(path)：定位到文件夹之后展开它或进入它；notify(text)：提示 }
export function createLocator({ model, identity, takeover, ops }) {
  let run = 0;

  // 这一级目录里有没有这一项：加载好，没有就取下一页，直到找到、读尽或到上限。
  async function ensure(dir, name, alive) {
    const first = await model.whenLoaded(dir);
    if (!alive()) return 'void';
    if (first !== 'ok') return first === 'failed' ? 'failed' : 'void';
    for (;;) {
      const state = model.dirs.get(dir);
      if (!state) return 'void';
      if (state.entries.some(entry => entry.name === name)) return 'found';
      if (!state.next) return 'end';
      if (state.entries.length >= RESTORE_LIMIT) return 'limit'; // 按这个目录已有的条数算：用户翻出来的留着；一页越过上限时这一页照样用完
      const outcome = await model.fetchNext(dir);
      if (!alive()) return 'void';
      if (outcome === 'failed' || outcome === 'void') return outcome;
    }
  }

  return {
    // 作废在做的定位（页面里重新输入搜索词时调用）。
    cancel() { run++; },

    // 返回结局：found、end、limit、failed、void（测试用）。open：找到的是文件夹时再展开它或进入它。
    async show(path, { open = false } = {}) {
      const mine = ++run, id = identity(), taken = takeover();
      const alive = () => run === mine && identity() === id && takeover() === taken;
      const icons = model.view === View.ICONS, segments = path.split('/');
      ops.begin(icons ? parentOf(path) : null);
      const finish = outcome => {
        if (outcome === 'end' || outcome === 'limit') ops.notify(MESSAGES[outcome]);
        return outcome;
      };
      let outcome;
      if (icons) outcome = await ensure(parentOf(path), segments[segments.length - 1], alive);
      else {
        let dir = '';
        outcome = 'found';
        for (let i = 0; i < segments.length && outcome === 'found'; i++) {
          const here = dir === '' ? segments[i] : `${dir}/${segments[i]}`;
          outcome = await ensure(dir, segments[i], alive);
          if (outcome !== 'found') break;
          if (i < segments.length - 1) { // 上层：确保已展开、并且读到了
            if (!model.expanded.has(here)) model.toggle(here);
            const loaded = await model.whenLoaded(here);
            if (!alive()) return 'void';
            if (loaded !== 'ok') outcome = loaded === 'failed' ? 'failed' : 'void';
          }
          dir = here;
        }
      }
      if (!alive()) return 'void';
      if (outcome !== 'found') return finish(outcome);
      // 找到：最后一次核对身份之后，在同一个同步过程里选中、居中，并把定位标成完成；完成之后的任何事件都和它无关。
      ops.render();
      ops.select(path);
      ops.center(path);
      run++;
      if (open) ops.openFolder(path);
      return 'found';
    },
  };
}
