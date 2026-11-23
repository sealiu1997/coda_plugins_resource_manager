#!/bin/sh
# 编译并运行 WebKit 探针（只在 macOS 上手动跑，不进 CI）。产物和临时文件放在系统临时目录里，跑完删掉。
# 宿主 CSP 和 svg 的 CSP 直接从 test/harness/html-preview.mjs、lib/media.mjs 里取，不另抄一份：
# 宿主 CSP 只把 img-src 里 harness 换掉的测试服务路径换回 coda-view:，其余逐条照搬。
set -eu
root=$(cd "$(dirname "$0")/../../.." && pwd)
host=$(sed -n 's/^const hostCsp = origin => `\(.*\)`;$/\1/p' "$root/test/harness/html-preview.mjs" | sed 's|\${origin}/img/legit/|coda-view:|')
svg=$(sed -n "s/^const SVG_CSP = \"\(.*\)\";\$/\1/p" "$root/lib/media.mjs")
case "$host" in *"img-src coda-view: data: blob:"*) ;; *) echo "取不到宿主 CSP（html-preview.mjs 的 hostCsp 变了？）" >&2; exit 1 ;; esac
[ -n "$svg" ] || { echo "取不到 svg 的 CSP（lib/media.mjs 的 SVG_CSP 变了？）" >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/webkit-probe.XXXXXX")
trap 'rm -rf "$work"' EXIT
# -swift-version 5：处理器和计数器是单线程（主线程）的，不用 Swift 6 的严格并发检查
swiftc -O -swift-version 5 -suppress-warnings -o "$work/probe" "$root/test/harness/webkit-probe/probe.swift"
"$work/probe" "$root" "$host" "$svg"
