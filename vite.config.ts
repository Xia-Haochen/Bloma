import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const projectRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(projectRoot, 'renderer'),
  base: './',
  // Never write build/test caches through a shared node_modules symlink.
  cacheDir: resolve(projectRoot, '.cache/vite'),
  build: {
    outDir: resolve(projectRoot, 'dist'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  test: {
    root: projectRoot,
    // 运行证据可能保留旧 *.test.ts 快照，不能被路径过滤误当成当前测试执行。
    exclude: [...configDefaults.exclude, '**/run-artifacts/**'],
    // 并发上限（2026-10-03）：32 逻辑核下 vitest 默认开 ~30 个 worker，全量时 CPU/磁盘双满载、
    // 前台应用几乎不可用，且真实 IO 用例在争抢下单文件耗时膨胀 3~6 倍（实测：worktree
    // 9s→50s、project-git 4.3s→36s）。限 4 个 worker：机器可用性与总墙钟反而更好。
    // 需要烧满机器跑一次时用 CLI 覆盖：npx vitest run tests/unit --maxWorkers=100%。
    maxWorkers: 4,
    // 全局单测超时 30s：用例含真实 IO（mkdtemp/写盘/子流程），并发 IO 争抢可使单用例
    // 膨胀数倍（2026-08-28 flaky 实测）。真 hang 的测试也能在 30s 内报失败。
    testTimeout: 30_000,
    // PROMA_HOME 被 teardown 写成字符串 "undefined" 时统一归位，见该文件注释
    setupFiles: [resolve(projectRoot, 'tests/support/proma-home-guard.ts')],
    // 启动时回收历史泄漏的测试临时 PROMA_HOME 目录（mkdtemp 命名模式 + 距上次修改 >30min），见该文件注释
    globalSetup: [resolve(projectRoot, 'tests/support/tmp-home-sweep.ts')],
  },
})
