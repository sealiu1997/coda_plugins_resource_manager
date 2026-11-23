// 预览的显示方式状态机：纯逻辑，不碰 DOM。状态是 { group, mode, available }：
// group 由文件类别定，mode 由用户选，available 由内容能力定（3D 能否看文本、富文本的内容是不是文本）。
// 事件驱动，不靠入参推断：同类别换文件和后台刷新的入参可能完全相同，但前者要重置、后者要保留。
import { OpenCategory } from './protocol.mjs';

const GROUPS = {
  model: { modes: [['3d', '3D'], ['text', '文本']], category: OpenCategory.MODEL },
  rich: { modes: [['preview', '预览'], ['source', '源码']], category: OpenCategory.MARKDOWN },
};
const DEFAULTS = { model: '3d', rich: 'preview' };

export function createModes() {
  let group = null, mode = null, available = false;
  const groupOf = category => Object.keys(GROUPS).find(name => GROUPS[name].category === category) ?? null;
  return {
    // 打开一个文件（含同类别换文件）：按类别定组，模式回默认，可用性等内容和能力来了再定。
    open(category) { group = groupOf(category); mode = group && DEFAULTS[group]; available = false; },
    // 后台刷新同一个文件：什么都不变。
    refresh() {},
    // 重载、重试：富文本回「预览」；模型保持当前模式。
    reload() { if (group === 'rich') mode = DEFAULTS.rich; },
    // 3D 的文本能力探测（可能迟到）：只开关模型组的可用性，不改模式。
    capability(offersText) { if (group === 'model') available = offersText; },
    // 每次读取成功之后（含后台刷新）：只开关富文本组的可用性；从不可用变回可用时模式回「预览」。
    content(isText) {
      if (group !== 'rich') return;
      if (isText && !available) mode = DEFAULTS.rich;
      available = isText;
    },
    // 用户点切换：只认当前显示着的组里的模式；返回模式有没有变。
    select(next) {
      if (!this.buttons().some(({ value }) => value === next) || mode === next) return false;
      mode = next;
      return true;
    },
    isRichPreview: () => group === 'rich' && available && mode === 'preview',
    // 头部要画的按钮；这一组不可用时为空（模式栏收起）。
    buttons: () => (group && available ? GROUPS[group].modes.map(([value, label]) => ({ value, label, pressed: mode === value })) : []),
    state: () => ({ group, mode, available }),
  };
}
