# 个性化愿望开发与迁移样本

12份普通用户请求，6类机制，每份另有一条使用后变更。request仅提供给制作方；oracle与changes分开存放，变化在首个可用候选后才输入。所有样本均已暴露给实现者，不是独立保留集；不能通过把文件换个名字声称盲测。

assets均为合成测试材料，来源和hash见assets-manifest.json：日期冲突的文字与白板、同名对象、图片、两段真实WAV及一段实际浏览器录制的合成WEBM。它们只用于触发输入/来源/处理分支，不代表真实用户素材质量或大文件性能。

`node scripts/check-personal-wish-corpus.mjs`只检查样本和素材完整性，不调用模型、不验收产品。`node scripts/prepare-personal-wish-fixtures.mjs`重新制作合成素材，可能改变图像/视频字节与hash，使用后应冻结当前版本，不在已运行试验中替换素材。

真实试验沿现有软件生成/独立验收链进行：首个候选、变更、恢复、最终状态分别留证；原10元窗口不重置。付费前需新的明确费用范围，且生成与成品自身的AI调用一并计入。体验评价需要独立评审与实际交互证据；仅检查request到oracle引用关系不能证明愿望已实现。

`node scripts/personal-wish-trial-cases.mjs interaction-doodle jobs-clips`可准备普通用户请求输入文件，模型请求为0。真实驱动通过`BLOMA_COMPLEX_TRIAL_CASES`读取该文件，使用`BLOMA_COMPLEX_TRIAL_TASK`选择任务；新窗口preflight必须同时有明确新增费用上限及`BLOMA_COMPLEX_TRIAL_AUTHORIZATION_TEXT`，不得用这几个变量冒充用户授权。manifest冻结任务内容；使用新任务输入恢复旧窗口会被拒绝。

未配置独立适配器的通用任务inspect保持unverified；当前涂鸦任务已有真实Electron音频/持久化及故障注入适配器，其余任务必须另按当前oracle操作应用，不能调用旧题专用脚本伪造通过。首批候选选择涂鸦乐器和录像切片工具，成品业务本身无需外部付费AI；涉及成品AI的后续样本须另准备产品自己的授权与计量边界。

后续经用户另行授权时，可用BLOMA_COMPLEX_TRIAL_WINDOW选择新的命名计费窗口，复用同一项目/home；旧manifest/policy/state文件保持原名原样并校验hash，不能通过换窗口自行扩大授权。请求输出按渠道上限和窗口完整输入预留后的可负担空间计算；不是重新恢复16K软上限。当前未创建或启动后续付费窗口。
