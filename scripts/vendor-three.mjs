// 把 npm 包 three 的几个文件原样复制到 view/vendor/three/（设计见 docs/design/phase-3.md 第 21.2 节）。
// 用法：node scripts/vendor-three.mjs [版本]（默认 0.187.0）；需要 npm 和 tar。
// 只做两种机械改动：文件后缀 .js → .mjs（含文件之间的相对导入）；裸导入 from 'three' → 指向 vendor 里 three.module.mjs 的相对路径。其余一个字节不改。
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.argv[2] ?? '0.187.0';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'view', 'vendor', 'three');

// 包里的路径 → vendor 里的路径（后缀改成 .mjs）。build/ 和 jsm/ 两个目录，jsm 即包里的 examples/jsm。
const FILES = [
  'build/three.module.js', 'build/three.core.js',
  ...['GLTFLoader', 'STLLoader', 'OBJLoader', 'MTLLoader', 'PLYLoader', '3MFLoader'].map(name => `examples/jsm/loaders/${name}.js`),
  'examples/jsm/controls/OrbitControls.js', 'examples/jsm/environments/RoomEnvironment.js',
  'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/SkeletonUtils.js',
  'examples/jsm/libs/fflate.module.js',
];
const target = file => file.replace(/^examples\/jsm\//, 'jsm/').replace(/\.js$/, '.mjs');

const work = await mkdtemp(join(tmpdir(), 'vendor-three-'));
try {
  execFileSync('npm', ['pack', `three@${VERSION}`, '--silent'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });
  execFileSync('tar', ['xzf', `three-${VERSION}.tgz`], { cwd: work });
  const pkg = join(work, 'package');
  await rm(OUT, { recursive: true, force: true });
  for (const file of FILES) {
    const to = join(OUT, target(file));
    await mkdir(dirname(to), { recursive: true });
    let source = await readFile(join(pkg, file), 'utf8');
    // 只改真正的导入、导出语句（from '…'），注释里的 @three_import 之类不动。
    source = source.replace(/(^|\n)((?:import|export)\b[^\n]*?|\} )from '([^']+)'/g, (whole, lead, head, spec) => {
      if (spec === 'three') spec = relative(dirname(to), join(OUT, 'build', 'three.module.mjs'));
      else if (spec.startsWith('.') && spec.endsWith('.js')) spec = spec.replace(/\.js$/, '.mjs');
      else return whole;
      if (!spec.startsWith('.')) spec = `./${spec}`;
      return `${lead}${head}from '${spec}'`;
    });
    await writeFile(to, source);
  }
  await copyFile(join(pkg, 'LICENSE'), join(OUT, 'LICENSE'));
  await writeFile(join(OUT, 'VERSION'), `three@${VERSION}\n`);
  console.log(`three@${VERSION}：${FILES.length} 个文件 → ${OUT}`);
} finally { await rm(work, { recursive: true, force: true }); }
