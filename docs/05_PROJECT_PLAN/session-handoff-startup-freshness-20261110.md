# 根目录CMD：按改动构建与产物新鲜度

日期：2026-11-10。用户17:13明确使用仓库根目录CMD，批准处理Task7（编译/启动优化）；基线`sprint2 / e43b7a8`。本批不是资源准入Task4–5，也不恢复产品/费用试验。

## 入口和实现

- 保留`start-bloma.cmd -> scripts/start.mjs`；`npm start`和`start:auto`统一入口，CMD从自身目录执行、保留失败退出码。双击方式无需改变。
- `scripts/build.mjs`复用生产Vite/esbuild，保留原bundle/externals/ESM-CJS输出约定。renderer、main、语音worker、preload、templates各自证明；主进程源改动不重建renderer，前端源改动不重建main，公共配置/依赖正确失效。模板先清理该构建目标，再复制，避免已删除模板残留。
- `.bloma-build/state.json`是忽略的本机构建缓存，不是项目、质量或费用账本。内容证明包括源码、配置、lock、实际bundler读取文件、安装包解析元数据及嵌套布局、工具链/调用环境和输出文件内容。增加/删除文件、同mtime改字节、输出缺失/被改都不能仅靠时间戳放行。
- 有界并发读取指纹，未把全node_modules源码逐文件纳入每次预检；读取实际载入图及包边界元数据。构建前清除受影响证明，编译后确认源/依赖未变，再原子写证明。失败不启动旧输出。
- Windows命名管道短期互斥覆盖依赖修复与构建/检查；进程退出自动释放，无常驻服务或陈旧PID锁。非Windows采用本机回环端口保守互斥，本批只验Windows。
- 正式`npm run build`仍强制完整生产构建；`build:main`保留原main+worker+preload+templates范围；`build:renderer`仅renderer。所有入口产出证明，后续正常启动可复用。
- `--skip-build`现在只验证，不绕过过期/失败构建，缺依赖也不安装；`--force-build`强制重建；`--build-only`不打开App；`--no-install`不自动修复依赖。没有“强制旧版秒起”后门。
- `last-start.json`记录依赖/构建/进程创建/首屏绘制各阶段。main只接受一次性nonce，在固定项目缓存位置报告ready-to-show；不接受任意环境文件路径。首屏不等于模型就绪、项目恢复完成或产品交付。

## 来源与适配

先参考本地Proma上游`apps/electron/package.json`和`apps/electron/scripts/dev-bundle-readiness.ts`（本地参考HEAD `bf3e98ca61dd8365eceaef876c0f7473700878a6`，未fetch）。沿用分组件/先确认产物再启动的原则；上游是Bun开发watcher首次非空检查，不提供本仓库生产内容证明，不直接复制其清旧bundle流程或整体rebase。

## 实测与验证

证据根：`C:/Users/17359/.proma/agent-workspaces/default/ce1d0954-c07d-4052-b50c-f721e6a2d9fb/startup-repair/`。Node22.22.2，Windows。基线分阶段测量与后续样本是同机顺序执行，磁盘/杀软/缓存状态会波动，不承诺固定倍数。

- 改前生产命令：renderer **25.47s**，main（含worker/preload/模板）**8.66s**，合计约**34.12s**；这是构建阶段参考，不含窗口，不冒充改前根CMD的完整端到端计时。原依赖检查只确认Electron存在。
- 修复后无改动根CMD实际样本见`final-root-warm.json`：任意外部cwd执行同一CMD，两次墙钟5.58s、6.70s，全部组件复用。另有`final-warm.log`，较冷校验7.45s。首次/公共构建变化仍需完整构建，未把首次构建宣称为秒起。
- 同批真实隔离源码副本含中文/空格路径，早期11场景通过：冷/暖、main-only、renderer-only、模板增删、shared、严格skip拒旧、真实语法编译失败不启动、失败后拒旧及恢复。见`integration-verification.json`。第一次执行整体300秒超时，未重复完成场景，按checkpoint继续完成；保留两次日志。
- 独立只读审查确认2个P1：嵌套package解析元数据漏掉造成错复用；Vite dotenv自身初始化被误报为输入变动。已加入安装包元数据/布局证明并冻结调用方env，另使skip完全不安装；原审查方定向复验确认两P1及安装副作用已消除，未发现新可复现P0/P1，见`review-resolution.md`。真实esbuild嵌套包main切换、真实Vite dotenv两独立新Node（首次构建/第二次复用）、安全npm stub回归通过。
- 最终定向**2文件35项**通过（26项新构建用例+原9项启动恢复），见`review-fix-tests.log`。大部分构建选择用例用受控builder，最后两项真实bundler及独立进程不属于替身；不与早期23/32项相加。
- 类型检查、完整生产构建通过，修复后重新生产构建见`final-production-build.log`。文档检查和最终原数据保护结果见最终回执。
- 实际根CMD启动本仓库构建的Electron：独立PROMA_HOME及userData，真实生产file页面、preload和project.list IPC、可见首屏与截图已验证；最终结果`native-verification.json`：预检约5.83s，进程创建77ms，首屏6.26s，合计约12.09s（不含测试中暂停等待截图的时间）。不是HTML mock、模型或生成产品认证。最初验收脚本错用window.api，按实际electronAPI改正；第一次CDP关闭导致测试脚本未决await告警，实际根CMD已正常收到App退出0，后修正测试清理，不修改App规避问题。
- 扩大离线组合运行600秒被工具终止，仅完成部分文件，不宣称完整19文件206项通过。其中simulated-user的两项出现浏览器操作确认/Chromium退出3221225794，保留原失败；随后原断言/原时限单worker隔离复验2/2通过，见`browser-isolated-recheck.log`。这不等于重跑整个标准组合。

## 保留边界

- 只证明构建writer互斥与启动前检查；未把正在运行App所有后续资源读取做不可变快照，也未完成真实双进程重构建/启动混版认证。校验之后的源码改动需要重新启动；不自动热换用户实例。
- 没有全面供应链/凭据安全审计，不以哈希/折叠冒充脱敏；缓存不保存环境秘密明文。
- 用户原dirty文档不编辑、不提交，blob应保持`53c7abb3aef8497d8b0522b8aab806c82b2ec164`。原运行/质量/校正/用量/限额六文件在收尾比SHA；暂停、unknown和金额授权不改变。
- 未调用真实付费供应商、未恢复原产品/校园试验、未push。隔离测试实例完成后关闭；用户常用实例不自动重启。
