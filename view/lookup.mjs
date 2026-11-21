// 按文件名查表与共享的文件名/后缀识别规则（无 UI 依赖，协议、图标和语言表共用同一事实来源）。
// 整个文件名（小写）优先，再是 special（各表自己的规则，如 .env.*），最后是扩展名（小写）；扩展名取最后一个点之后，点在开头的名字没有扩展名。
export const GIT_NAMES = ['.gitignore', '.gitattributes', '.gitmodules', '.gitconfig', '.gitkeep', '.mailmap'];
export const ENV_NAMES = ['.env', '.envrc'];
export const LICENSE_NAMES = ['license', 'licence', 'copying', 'unlicense'];
export const RUBY_NAMES = ['gemfile', 'rakefile', 'podfile'];
export const MAKEFILE_NAMES = ['makefile', 'gnumakefile'];
export const DOCKERFILE_NAMES = ['dockerfile', 'containerfile'];
export const MARKDOWN_EXTS = ['md', 'markdown', 'mdx'];

export const isEnvName = lower => lower.startsWith('.env.');
export const basenameLower = name => {
  const s = String(name);
  return s.slice(s.lastIndexOf('/') + 1).toLowerCase();
};

export const invert = table => new Map(Object.entries(table).flatMap(([id, keys]) => keys.map(key => [key, id])));

export function lookupByName(name, byName, byExtension, special = () => undefined) {
  const lower = String(name).toLowerCase(), dot = lower.lastIndexOf('.');
  return byName.get(lower) ?? special(lower) ?? (dot > 0 ? byExtension.get(lower.slice(dot + 1)) : undefined);
}
